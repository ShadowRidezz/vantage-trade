"""Video import job: user-provided video file (+ optional YouTube link for title and timestamps) -> AI Brain knowledge.

Every progress step is marked only after its operation succeeded. If the vision model cannot look at the frames,
the job fails; it never falls back to title-only "analysis".
"""
from __future__ import annotations

import json
import os
import shutil
import time
import urllib.parse

import brain as B
import db
import llm
import video as V
from db import KnowledgeSource, TranscriptSegment, VideoAnalysis, VideoFrame

VIDEO_NOTE = """
SOURCE CONTENT is a combined timeline of a trading video: "SPEECH" lines are the transcribed audio, "SCREEN" lines are what a vision
model saw on the frame at that moment ("shown" = drawn/labelled on screen or named while shown; "AI reading" = the vision model's own
interpretation, weaker evidence; "(uncertain)" = unclear frame). Only extract concepts supported by the speech or explicitly shown on
screen. Use the timestamp of the clearest moment where explanation and visuals line up, copied exactly from a line's start (e.g. 4:32).
excerpt must be copied verbatim from one SPEECH line when possible."""


def run(jid, url, path, name):
    with B._lock:
        sid = None
        try:
            sid = _pipeline(jid, url, path, name)
        except (B.ImportError_, V.VideoError) as e:
            B._finish(jid, "failed", str(e), source_id=sid)
            _cleanup_failed(sid, path)
        except Exception as e:  # noqa: BLE001 - never leave a job "running"
            B._finish(jid, "failed", "Unexpected error: %s" % e, source_id=sid)
            _cleanup_failed(sid, path)
        finally:
            V.unload()


def _cleanup_failed(sid, path):
    try:
        if path and os.path.dirname(path) == B.UPLOAD_DIR and os.path.exists(path):
            with db.session() as s:
                if not s.query(VideoAnalysis).filter_by(file_path=path).first():
                    os.remove(path)
    except OSError:
        pass


def _meta_from_url(url):
    """Title/channel from YouTube's public oEmbed endpoint (metadata only; no video access)."""
    u = B.check_url(url)
    curl = B.canonical(u)
    meta = {"url": curl, "platform": B.platform_of(u), "title": None, "author": None}
    if meta["platform"] == "youtube":
        try:
            _, _, body = B.fetch("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(curl, safe=""), accept="application/json")
            o = json.loads(body)
            meta.update(title=o.get("title"), author=o.get("author_name"))
        except (B.ImportError_, ValueError):
            meta["note"] = "YouTube did not return this video's details (it may be private or deleted); the uploaded file was still analysed."
    return meta


def _pipeline(jid, url, path, name):
    # 1. identify
    meta = _meta_from_url(url) if url else {"url": None, "platform": "video", "title": None, "author": None}
    info = V.probe(path)
    title = meta.get("title") or os.path.splitext(V.safe_name(name))[0]
    B._step(jid, 0, "%s: %s (%s)" % ("YouTube" if meta["platform"] == "youtube" else "Video file", title, V.mmss(info["duration"])))

    # 2. accessed (user-provided file), duplicate check by content
    digest = V.file_hash(path)
    with db.session() as s:
        dup = s.query(VideoAnalysis).filter_by(file_hash=digest).first()
        if dup:
            src = s.get(KnowledgeSource, dup.source_id)
            raise B.ImportError_("This exact video was already analysed (\"%s\"). Open it from Sources to review it." % (src.title if src else "earlier import"))
    size_mb = os.path.getsize(path) / 1_048_576
    B._step(jid, 1, "User-provided file %s, %dx%d, %.0f MB" % (V.safe_name(name), info["width"], info["height"], size_mb))

    with db.session() as s:
        src_url = meta["url"] or "upload:%s" % digest[:16]
        src = s.query(KnowledgeSource).filter_by(url=src_url).first() if meta["url"] else None
        if src is None:
            src = KnowledgeSource(url=src_url)
            s.add(src)
        src.platform = "youtube" if meta["platform"] == "youtube" else "video"
        src.title, src.author, src.status, src.complete, src.note = title[:300], meta.get("author"), "processing", False, meta.get("note")
        src.content_kind = "video"
        src.content_hash, src.imported_at = digest, time.time()
        s.commit()
        sid = src.id
        va = VideoAnalysis(source_id=sid, file_name=V.safe_name(name), file_hash=digest, duration=info["duration"], width=info["width"],
                           height=info["height"], has_audio=info["has_audio"], info={"sampling": V.SAMPLING})
        s.add(va)
        s.commit()
        aid = va.id
    work = os.path.join(B.VIDEO_DIR, str(aid))
    os.makedirs(work, exist_ok=True)

    # 3-4. audio + transcript
    segments, tinfo = [], {}
    if info["has_audio"]:
        wav = os.path.join(work, "audio.wav")
        V.extract_audio(path, wav)
        B._step(jid, 2, "Mono 16 kHz audio, %s" % V.mmss(info["duration"]))
        try:
            segments, tinfo = V.transcribe(wav)
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass
        cov = V.coverage(segments, info["duration"])
        B._step(jid, 3, "%d timestamped segments, speech covers %.0f%% of the video (Whisper on %s)" % (len(segments), cov, tinfo.get("device")) if segments
                else "No speech detected in the audio")
    else:
        cov = 0.0
        B._step(jid, 2, "This video has no audio track", skipped=True)
        B._step(jid, 3, "No audio to transcribe: visual analysis only", skipped=True)

    # 5. frames
    picks = V.choose_frames(path, info["duration"], speech=[(a, b) for a, b, _ in segments])
    frames = []
    step = 1.0 / V.SAMPLING["probe_fps"]
    for t, reason in picks:
        # a change is detected somewhere inside the probe window that starts at t: grab at the window's end so the new
        # drawing is actually on the frame (the first frame and speech moments are taken as-is)
        t = round(min(max(0.0, info["duration"] - 0.1), t + step), 2) if "changed" in reason or reason == "scene change" else t
        jpg = os.path.join(work, "%07.2f.jpg" % t)
        V.grab(path, t, jpg)
        frames.append((t, jpg, reason))
    kinds = {}
    for _, _, r in frames:
        kinds[r] = kinds.get(r, 0) + 1
    B._step(jid, 4, "%d frames (%s)" % (len(frames), ", ".join("%d %s" % (n, k) for k, n in kinds.items())))

    # 6. vision (must succeed: no vision, no video analysis)
    obs = V.analyse_frames([(t, p) for t, p, _ in frames], segments, title)
    seen = [o for o in obs if not o["interpretation"].startswith("Not analysed")]
    if not seen:
        raise V.VideoError("The vision model returned no results for any frame, so the video was not analysed.")
    charts = sum(o["shows_chart"] for o in seen)
    B._step(jid, 5, "%d of %d frames analysed by the vision model, %d show a chart" % (len(seen), len(obs), charts))

    reason_by_t = {t: r for t, _, r in frames}
    with db.session() as s:
        for a, b, text in segments:
            s.add(TranscriptSegment(analysis_id=aid, start=a, end=b, text=text))
        for o in obs:
            s.add(VideoFrame(analysis_id=aid, t=o["t"], reason=reason_by_t.get(o["t"], ""), image_path=o["path"], shows_chart=o["shows_chart"],
                             symbol=o["symbol"], timeframe=o["timeframe"], on_screen=o["on_screen"], concepts=o["concepts"],
                             interpretation=o["interpretation"], uncertain=o["uncertain"]))
        va = s.get(VideoAnalysis, aid)
        va.frames_analyzed, va.transcript_coverage, va.info = len(seen), cov, {"sampling": V.SAMPLING, "transcription": tinfo}
        s.commit()

    # 7. knowledge extraction over the combined timeline (chunked for long videos)
    text = V.timeline_text(segments, obs)
    try:
        data = B.extract(text, {"title": title, "author": meta.get("author"), "platform": "video"}, VIDEO_NOTE)
    except B.ImportError_ as e:
        raise V.VideoError("Knowledge extraction failed: %s" % str(e).replace("The AI could not analyse this source: ", ""))
    by_cat = {}
    for c in data["concepts"]:
        by_cat[c["category"]] = by_cat.get(c["category"], 0) + 1
    B._step(jid, 6, "%d concepts: %s" % (len(data["concepts"]), ", ".join(c["title"] for c in data["concepts"])) if data["concepts"] else "No trading concepts found")

    # 8. connections (reuses the article merge: duplicate prevention, revisions, source links with timestamps)
    with db.session() as s:
        s.get(KnowledgeSource, sid).content_chars = len(text)
        s.commit()
    res = B.merge(sid, meta, data, jid, steps=(None, 7)) if data["concepts"] else {"new_concepts": 0, "updated_concepts": 0, "new_connections": 0}
    if not data["concepts"]:
        B._step(jid, 7, "No concepts to connect")

    # 9. saved: keep the file for in-app playback in the review
    os.makedirs(B.UPLOAD_DIR, exist_ok=True)
    with db.session() as s:
        src = s.get(KnowledgeSource, sid)
        src.status, src.complete, src.main_topic = "complete", True, data["main_topic"] or src.main_topic
        if data["claims"]:
            src.claims = data["claims"][:15]
        s.get(VideoAnalysis, aid).file_path = path
        s.commit()
    if not data["concepts"]:
        with db.session() as s:
            B._node(s, "source:%d" % sid, title=title[:120], category="source", summary=data["main_topic"] or title, detail="Video", verification="imported")
            s.commit()
    B._step(jid, 8, "Video analysis #%d stored" % aid)
    res["video"] = {"analysis_id": aid, "title": title, "duration": info["duration"], "frames_analyzed": len(seen), "frames_with_chart": charts,
                    "transcript_coverage": cov, "has_audio": info["has_audio"], "patterns": by_cat.get("pattern", 0),
                    "strategies": by_cat.get("strategy", 0), "skills": by_cat.get("skill", 0), "conditions": by_cat.get("condition", 0)}
    B._finish(jid, "done", None, res, sid)
    return sid


# ---------------------------------------------------------------- review and corrections

def review(aid):
    with db.session() as s:
        va = s.get(VideoAnalysis, aid)
        if not va:
            raise B.ImportError_("Video analysis not found.")
        src = s.get(KnowledgeSource, va.source_id)
        frames = []
        for f in s.query(VideoFrame).filter_by(analysis_id=aid).order_by(VideoFrame.t):
            r = db.row(f)
            r.pop("image_path")
            r["revisions"] = [db.row(x) for x in s.query(db.FrameRevision).filter_by(frame_id=f.id).order_by(db.FrameRevision.created_at.desc())]
            frames.append(r)
        segs = [db.row(x) for x in s.query(TranscriptSegment).filter_by(analysis_id=aid).order_by(TranscriptSegment.start)]
        learned = []
        for l in s.query(db.SourceKnowledgeLink).filter_by(source_id=va.source_id):
            n = s.get(B.KnowledgeNode, l.node_id)
            if n:
                learned.append({"node_id": n.id, "title": n.title, "category": n.category, "summary": n.summary, "verification": n.verification,
                                "timestamp": l.timestamp_ref, "excerpt": l.excerpt, "rules": n.rules if n.category == "strategy" else None})
        sn = s.query(B.KnowledgeNode).filter_by(origin="source:%d" % va.source_id).first()
        a = db.row(va)
        a["has_file"] = bool(va.file_path and os.path.exists(va.file_path))
        a.pop("file_path")
        return {"analysis": a, "source": db.row(src) if src else None, "source_node_id": sn.id if sn else None,
                "frames": frames, "segments": segs, "learned": learned}


def correct_frame(fid, interpretation, concepts, uncertain, note):
    """A user correction: saved with the previous version, never overwriting history."""
    with db.session() as s:
        f = s.get(VideoFrame, fid)
        if not f:
            raise B.ImportError_("Frame not found.")
        prev = {"interpretation": f.interpretation, "concepts": f.concepts, "uncertain": f.uncertain}
        clean = [{"name": str(c.get("name", ""))[:80], "category": c.get("category") if c.get("category") in V.CATS else "pattern",
                  "shown_explicitly": bool(c.get("shown_explicitly", True)), "confidence": "high"} for c in concepts[:10] if str(c.get("name", "")).strip()]
        new = {"interpretation": interpretation[:800], "concepts": clean, "uncertain": bool(uncertain)}
        s.add(db.FrameRevision(frame_id=fid, previous=prev, updated=new, reason=("User correction: " + note[:300]) if note.strip() else "User correction"))
        f.interpretation, f.concepts, f.uncertain, f.corrected = new["interpretation"], clean, new["uncertain"], True
        s.commit()
        return db.row(f)


def frame_image(fid):
    with db.session() as s:
        f = s.get(VideoFrame, fid)
        if not f or not f.image_path:
            raise B.ImportError_("Frame not found.")
        p = os.path.abspath(f.image_path)
    if not p.startswith(os.path.abspath(B.VIDEO_DIR) + os.sep) or not os.path.exists(p):
        raise B.ImportError_("Frame image missing.")
    return p


def video_file(aid):
    with db.session() as s:
        va = s.get(VideoAnalysis, aid)
        p = os.path.abspath(va.file_path) if va and va.file_path else None
    if not p or not p.startswith(os.path.abspath(B.UPLOAD_DIR) + os.sep) or not os.path.exists(p):
        raise B.ImportError_("The video file is not stored.")
    return p


def delete_for_source(s, sid):
    for va in s.query(VideoAnalysis).filter_by(source_id=sid):
        for f in s.query(VideoFrame).filter_by(analysis_id=va.id):
            s.query(db.FrameRevision).filter_by(frame_id=f.id).delete()
        s.query(VideoFrame).filter_by(analysis_id=va.id).delete()
        s.query(TranscriptSegment).filter_by(analysis_id=va.id).delete()
        shutil.rmtree(os.path.join(B.VIDEO_DIR, str(va.id)), ignore_errors=True)
        if va.file_path and os.path.dirname(os.path.abspath(va.file_path)) == os.path.abspath(B.UPLOAD_DIR):
            try:
                os.remove(va.file_path)
            except OSError:
                pass
        s.delete(va)
