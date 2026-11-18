"""Video analysis: real FFmpeg on generated clips; speech-to-text and vision are faked so tests run offline and fast."""
import os
import subprocess
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

import brain as B
import llm
import main
import video as V

FF = V.ffmpeg()
TMP = tempfile.mkdtemp(prefix="vt-vid-")


def make_clip(name, audio=True, seconds=12, color_change=True):
    """Coloured scenes (a scene change every 4 s) with an optional tone track."""
    out = os.path.join(TMP, name)
    if os.path.exists(out):
        return out
    parts = "color=c=0x101418:s=640x360:d=4[a];color=c=0x204060:s=640x360:d=4[b];color=c=0x602040:s=640x360:d=%d[c];[a][b][c]concat=n=3:v=1:a=0[v]" % (seconds - 8) \
        if color_change else "color=c=0x101418:s=640x360:d=%d[v]" % seconds
    cmd = [FF, "-v", "error", "-y", "-filter_complex", parts]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=%d" % seconds]
    cmd += ["-map", "[v]"] + (["-map", "0:a"] if audio else []) + ["-c:v", "libx264", "-pix_fmt", "yuv420p"] + (["-c:a", "aac", "-shortest"] if audio else []) + [out]
    subprocess.run(cmd, check=True)
    return out


def test_probe_and_frame_choice_find_scene_changes_and_skip_identical_frames():
    p = make_clip("scenes.mp4")
    info = V.probe(p)
    assert 11 < info["duration"] < 13 and info["has_audio"] and info["width"] == 640
    picks = V.choose_frames(p, info["duration"])
    times = [t for t, _ in picks]
    assert times[0] == 0 and any(3.5 <= t <= 4.6 for t in times) and any(7.5 <= t <= 8.6 for t in times)
    still = make_clip("still.mp4", color_change=False, seconds=30)
    assert len(V.choose_frames(still, 30)) == 1  # nothing ever changes: one frame, no repeats
    jpg = os.path.join(TMP, "f.jpg")
    V.grab(p, 5.0, jpg)
    assert os.path.getsize(jpg) > 500


def test_speech_moments_get_frames_and_timeline_is_ordered():
    p = make_clip("still2.mp4", color_change=False, seconds=20)
    picks = V.choose_frames(p, 20, speech=[(6.0, 9.0)])
    assert len(picks) == 1  # screen never changes, so a speech moment adds no duplicate picture
    tl = V.timeline_text([(1.0, 3.0, "a fair value gap forms"), (70.0, 72.0, "later")],
                         [{"t": 2.0, "symbol": "MNQ", "timeframe": "5m", "on_screen": "box", "uncertain": True, "interpretation": "FVG shown",
                           "concepts": [{"name": "Fair Value Gap", "shown_explicitly": True, "confidence": "high"}]}])
    lines = tl.splitlines()
    assert lines[0].startswith("0:01 SPEECH") and lines[1].startswith("0:02 SCREEN (uncertain)") and lines[2].startswith("1:10 SPEECH")
    assert V.coverage([(0, 6, "x")], 12) == 50.0


def test_not_a_video_is_rejected():
    bad = os.path.join(TMP, "bad.mp4")
    with open(bad, "wb") as f:
        f.write(b"not a video" * 200)
    with pytest.raises(V.VideoError):
        V.probe(bad)


# ---------------------------------------------------------------- full job through the API

SEGMENTS = [(0.5, 3.5, "Here a liquidity sweep takes the stops above the highs."), (4.5, 7.5, "Then the fair value gap is my entry.")]


def fake_transcribe(wav, on_segment=None):
    assert os.path.getsize(wav) > 1000
    return list(SEGMENTS), {"language": "en", "device": "test"}


def fake_ai_factory(fail_vision=False):
    calls = {"vision": 0, "extract": 0}

    def fake(task, data, schema, timeout=0, images=None):
        if images:
            calls["vision"] += 1
            if fail_vision:
                return False, "model unavailable"
            assert all(mt == "image/jpeg" and len(b64) > 100 for mt, b64 in images)
            return True, {"frames": [{"t": f["t"], "shows_chart": True, "symbol": "MNQ", "timeframe": "5m", "on_screen": "candles and a box",
                                      "concepts": [{"name": "Fair Value Gap", "category": "pattern", "shown_explicitly": True, "confidence": "high"}],
                                      "interpretation": "A fair value gap is shown while it is explained.", "uncertain": False} for f in data["frames"]]}
        calls["extract"] += 1
        content = data["SOURCE CONTENT"]
        assert "SCREEN" in content  # one combined timeline (SPEECH lines too whenever there is audio)
        calls["had_speech"] = "SPEECH" in content
        return True, {"main_topic": "Sweep then FVG", "claims_to_verify": [], "concepts": [
            {"title": "Liquidity Sweep", "category": "pattern", "summary": "s", "detail": "d", "excerpt": "a liquidity sweep takes the stops",
             "timestamp": "0:00", "existing_match": "", "new_information": "", "contradiction": "", "rules": {k: "" for k in ("entry", "exit", "stop", "target", "filters")}},
            {"title": "Sweep FVG Model", "category": "strategy", "summary": "s", "detail": "d", "excerpt": "", "timestamp": "0:04",
             "existing_match": "", "new_information": "", "contradiction": "", "rules": {"entry": "FVG", "exit": "", "stop": "", "target": "", "filters": ""}}],
            "relationships": [{"from": "Sweep FVG Model", "to": "Liquidity Sweep", "type": "REQUIRES", "explanation": "Starts after a sweep."}]}
    return fake, calls


@pytest.fixture(scope="module")
def c():
    with TestClient(main.app) as client:
        yield client


def upload(c, path, name=None):
    with open(path, "rb") as f:
        r = c.put("/api/brain/uploads", params={"name": name or os.path.basename(path)}, content=f.read())
    return r


def wait(c, jid):
    for _ in range(200):
        j = c.get("/api/brain/jobs/%d" % jid).json()
        if j["status"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_video_job_end_to_end(c, monkeypatch):
    fake, calls = fake_ai_factory()
    monkeypatch.setattr(V, "transcribe", fake_transcribe)
    monkeypatch.setattr(llm, "ask_json", fake)
    up = upload(c, make_clip("lesson.mp4")).json()
    j = wait(c, c.post("/api/brain/import", json={"upload_id": up["upload_id"], "upload_name": "lesson.mp4"}).json()["job_id"])
    assert j["status"] == "done", j
    assert [s["name"] for s in j["steps"]] == list(B.VIDEO_STEPS) and all(s["done"] for s in j["steps"])
    v = j["result"]["video"]
    assert v["frames_analyzed"] >= 3 and v["patterns"] == 1 and v["strategies"] == 1 and v["transcript_coverage"] == 50.0
    assert calls["vision"] >= 1 and calls["extract"] == 1 and calls["had_speech"]
    r = c.get("/api/brain/videos/%d" % v["analysis_id"]).json()
    assert len(r["frames"]) == v["frames_analyzed"] and len(r["segments"]) == 2 and r["analysis"]["has_file"]
    assert {x["title"] for x in r["learned"]} >= {"Liquidity Sweep", "Sweep FVG Model"}
    fid = r["frames"][0]["id"]
    assert c.get("/api/brain/frames/%d/image" % fid).headers["content-type"] == "image/jpeg"
    vid = c.get("/api/brain/videos/%d/file" % v["analysis_id"], headers={"Range": "bytes=0-99"})
    assert vid.status_code == 206 and len(vid.content) == 100
    fix = c.patch("/api/brain/frames/%d" % fid, json={"interpretation": "Actually an order block.", "concepts": [{"name": "Order Block", "category": "pattern"}],
                                                      "uncertain": False, "note": "box is an OB"}).json()
    assert fix["corrected"] and fix["concepts"][0]["name"] == "Order Block"
    r2 = c.get("/api/brain/videos/%d" % v["analysis_id"]).json()
    rev = r2["frames"][0]["revisions"][0]
    assert rev["previous"]["interpretation"].startswith("A fair value gap") and "box is an OB" in rev["reason"]
    # the same file again is a duplicate
    up2 = upload(c, make_clip("lesson.mp4")).json()
    d = wait(c, c.post("/api/brain/import", json={"upload_id": up2["upload_id"], "upload_name": "copy.mp4"}).json()["job_id"])
    assert d["status"] == "failed" and "already analysed" in d["error"]
    # deleting the source removes frames, transcript and the stored file
    src = [s for s in c.get("/api/brain/sources").json() if s["analysis_id"] == v["analysis_id"]][0]
    assert c.delete("/api/brain/sources/%d" % src["id"]).json()["ok"]
    assert c.get("/api/brain/videos/%d" % v["analysis_id"]).status_code == 400
    assert not os.path.exists(os.path.join(B.VIDEO_DIR, str(v["analysis_id"])))


def test_video_without_audio_is_visual_only(c, monkeypatch):
    fake, calls = fake_ai_factory()
    monkeypatch.setattr(llm, "ask_json", fake)
    monkeypatch.setattr(V, "transcribe", lambda *a, **k: pytest.fail("no audio: must not transcribe"))
    up = upload(c, make_clip("silent.mp4", audio=False)).json()
    j = wait(c, c.post("/api/brain/import", json={"upload_id": up["upload_id"], "upload_name": "silent.mp4"}).json()["job_id"])
    assert j["status"] == "done", j
    st = {s["name"]: s for s in j["steps"]}
    assert st["Audio extracted"]["skipped"] and st["Transcript generated"]["skipped"] and st["Visual analysis completed"]["done"]
    assert j["result"]["video"]["has_audio"] is False and j["result"]["video"]["transcript_coverage"] == 0


def test_vision_failure_fails_the_job_and_learns_nothing(c, monkeypatch):
    fake, calls = fake_ai_factory(fail_vision=True)
    monkeypatch.setattr(V, "transcribe", fake_transcribe)
    monkeypatch.setattr(llm, "ask_json", fake)
    before = c.get("/api/brain/graph").json()["stats"]["knowledge"]
    up = upload(c, make_clip("lesson2.mp4", seconds=13)).json()
    j = wait(c, c.post("/api/brain/import", json={"upload_id": up["upload_id"], "upload_name": "lesson2.mp4"}).json()["job_id"])
    assert j["status"] == "failed" and "Visual analysis failed" in j["error"]
    assert not j["steps"][5]["done"] and calls["extract"] == 0
    assert c.get("/api/brain/graph").json()["stats"]["knowledge"] == before


def test_upload_rejects_wrong_types_and_bad_files(c):
    assert c.put("/api/brain/uploads", params={"name": "x.exe"}, content=b"x" * 5000).status_code == 400
    bad = os.path.join(TMP, "fake.mp4")
    with open(bad, "wb") as f:
        f.write(b"\x00" * 5000)
    assert upload(c, bad).status_code == 400
    assert c.post("/api/brain/import", json={"upload_id": "../../etc/passwd"}).status_code == 400
    assert c.post("/api/brain/import", json={}).status_code == 400
    assert c.get("/api/brain/frames/999999/image").status_code == 400
