import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, Film, Pencil, X } from 'lucide-react'
import { api, fmtT } from './api'
import { VERIFY, catLabel, useColors, withTime, type Cat } from './brainShared'
import { Badge, Btn, Empty, ErrorText, cx, inputCls } from './ui'

type Concept = { name: string; category: Cat; shown_explicitly: boolean; confidence: string }
type Frame = { id: number; t: number; reason: string; shows_chart: boolean; symbol: string; timeframe: string; on_screen: string; concepts: Concept[]
  interpretation: string; uncertain: boolean; corrected: boolean; revisions: { id: number; previous: any; updated: any; reason: string; created_at: number }[] }
type Review = {
  analysis: { id: number; file_name: string; duration: number; width: number; height: number; has_audio: boolean; frames_analyzed: number; transcript_coverage: number
    info: any; created_at: number; has_file: boolean }
  source: { id: number; url: string; title: string; author: string | null; platform: string } | null; source_node_id: number | null
  frames: Frame[]; segments: { id: number; start: number; end: number; text: string }[]
  learned: { node_id: number; title: string; category: Cat; summary: string; verification: string; timestamp: string | null; excerpt: string | null; rules: Record<string, string> | null }[]
}

const mmss = (t: number) => { t = Math.round(t); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
const secs = (ts: string) => ts.split(':').reduce((a, x) => a * 60 + Number(x), 0)

export function VideoReview({ id, onClose, onOpenNode }: { id: number; onClose: () => void; onOpenNode: (nodeId: number) => void }) {
  const q = useQuery({ queryKey: ['brain', 'video', id], queryFn: () => api<Review>(`/api/brain/videos/${id}`) })
  const player = useRef<HTMLVideoElement>(null)
  const r = q.data
  const yt = r?.source?.url.includes('youtube.com/watch') ? r.source.url : null
  // Clicking a time seeks the stored copy; the YouTube link opens the original at the same moment.
  const seek = (t: number) => { if (player.current) { player.current.currentTime = t; void player.current.play().catch(() => undefined) } }
  const rows = useMemo(() => {
    if (!r) return []
    // each frame carries the speech from its time up to the next frame
    return r.frames.map((f, i) => ({ f, speech: r.segments.filter((s) => s.start < (r.frames[i + 1]?.t ?? Infinity) && s.end > (i === 0 ? 0 : f.t)) }))
  }, [r])
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-label="Review video analysis">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <Film size={18} className="text-accent" /><span className="text-[14px] font-semibold">Review Video Analysis</span>
        <span className="min-w-0 truncate text-[13px] text-text-2">{r?.source?.title}</span>
        <div className="ml-auto flex gap-2">{yt && <a href={yt} target="_blank" rel="noreferrer noopener"><Btn><ExternalLink size={13} />Open on YouTube</Btn></a>}
          <Btn kind="ghost" onClick={onClose}><X size={14} />Close</Btn></div>
      </header>
      {q.error ? <div className="p-4"><ErrorText error={q.error} /></div> : !r ? <Empty>Loading…</Empty> :
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-line bg-panel p-4 text-[12px]">
            {r.analysis.has_file ? <video ref={player} src={`/api/brain/videos/${id}/file`} controls muted preload="metadata" className="w-full rounded-lg bg-black" />
              : <p className="text-text-2">The video file is no longer stored; timestamps open the original link instead.</p>}
            <dl className="grid grid-cols-[130px_1fr] gap-y-1">
              {([['Duration', mmss(r.analysis.duration)], ['Resolution', `${r.analysis.width}×${r.analysis.height}`], ['Frames analysed', r.analysis.frames_analyzed],
                ['Transcript coverage', r.analysis.has_audio ? `${Math.round(r.analysis.transcript_coverage)}% of the video` : 'No audio track'],
                ['Speech model', r.analysis.info?.transcription?.device ? `Whisper (${r.analysis.info.transcription.device})` : '—'], ['Analysed', fmtT(r.analysis.created_at)]] as const).map(([k, v]) =>
                <div key={k} className="contents"><dt className="text-text-2">{k}</dt><dd className="font-mono">{v}</dd></div>)}</dl>
            <section><h3 className="mb-1.5 text-[13px] font-semibold">What the AI learned ({r.learned.length})</h3>
              {!r.learned.length && <p className="text-text-2">No trading concepts were extracted.</p>}
              {r.learned.map((l) => <Learned key={l.node_id} l={l} onSeek={(ts) => (r.analysis.has_file ? seek(secs(ts)) : yt && window.open(withTime(yt, ts), '_blank', 'noopener'))} onOpenNode={onOpenNode} />)}</section>
            <p className="text-[11px] text-text-2">"Shown" = drawn, labelled or named on screen. "AI reading" = the vision model's own interpretation. Uncertain frames are flagged. Corrections are saved with their history.</p>
          </aside>
          <main className="min-h-0 overflow-y-auto p-4">
            <ol className="flex flex-col gap-3">{rows.map(({ f, speech }) => <FrameRow key={f.id} f={f} speech={speech} aid={id} yt={yt} onSeek={seek} hasFile={r.analysis.has_file} />)}</ol>
          </main>
        </div>}
    </div>
  )
}

function Learned({ l, onSeek, onOpenNode }: { l: Review['learned'][number]; onSeek: (ts: string) => void; onOpenNode: (id: number) => void }) {
  const C = useColors()
  return <div className="mb-2 rounded-lg border border-line p-2">
    <div className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: C[l.category] }} />
      <button onClick={() => onOpenNode(l.node_id)} className="font-medium hover:text-accent">{l.title}</button>
      <span className="text-text-2">{catLabel(l.category)}</span>
      {l.timestamp && <button onClick={() => onSeek(l.timestamp!)} className="ml-auto font-mono text-accent hover:underline">{l.timestamp}</button>}</div>
    {l.excerpt && <p className="mt-1 border-l-2 border-line pl-2 italic text-text-2">"{l.excerpt}"</p>}
    {l.rules && Object.values(l.rules).some(Boolean) && <dl className="mt-1 grid grid-cols-[54px_1fr] gap-y-0.5">{['entry', 'exit', 'stop', 'target', 'filters'].map((k) =>
      <div key={k} className="contents"><dt className="capitalize text-text-2">{k}</dt><dd>{l.rules![k] || <span className="text-warn">not stated</span>}</dd></div>)}</dl>}
    <div className="mt-1 text-[11px] text-text-2">{VERIFY[l.verification]?.[0] ?? l.verification}</div>
  </div>
}

function FrameRow({ f, speech, aid, yt, onSeek, hasFile }: { f: Frame; speech: Review['segments']; aid: number; yt: string | null; onSeek: (t: number) => void; hasFile: boolean }) {
  const qc = useQueryClient(), C = useColors()
  const [edit, setEdit] = useState(false), [big, setBig] = useState(false)
  const [text, setText] = useState(f.interpretation), [names, setNames] = useState(f.concepts.map((c) => c.name).join(', ')), [unc, setUnc] = useState(f.uncertain), [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: () => api(`/api/brain/frames/${f.id}`, { interpretation: text, uncertain: unc, note,
      concepts: names.split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, category: f.concepts.find((c) => c.name === name)?.category ?? 'pattern', shown_explicitly: true })) }, 'PATCH'),
    onSuccess: () => { setEdit(false); qc.invalidateQueries({ queryKey: ['brain', 'video', aid] }) },
  })
  const jump = () => (hasFile ? onSeek(f.t) : yt && window.open(withTime(yt, mmss(f.t)), '_blank', 'noopener'))
  return (
    <li className="grid gap-3 rounded-xl border border-line bg-panel p-3 md:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <button onClick={() => setBig(!big)} className="block w-full overflow-hidden rounded-lg border border-line" title="Enlarge">
          <img src={`/api/brain/frames/${f.id}/image`} alt={`Frame at ${mmss(f.t)}`} loading="lazy" className="w-full" /></button>
        <div className="mt-1 flex items-center gap-2 text-[11px]"><button onClick={jump} className="font-mono text-[13px] font-semibold text-accent hover:underline">{mmss(f.t)}</button>
          <span className="text-text-2">{f.reason}</span></div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {f.shows_chart ? <Badge tone="accent">Chart{f.symbol ? ` · ${f.symbol}` : ''}{f.timeframe ? ` ${f.timeframe}` : ''}</Badge> : <Badge>No chart</Badge>}
          {f.uncertain && <Badge tone="warn"><AlertTriangle size={11} className="mr-1" />Uncertain</Badge>}
          {f.corrected && <Badge tone="bull">Corrected by you</Badge>}
          {f.concepts.map((c, i) => <span key={i} className="rounded-md px-1.5 py-0.5 text-[11px]" style={{ background: C[c.category] + '22', color: C[c.category] }}>
            {c.name} <span className="opacity-70">· {c.shown_explicitly ? 'shown' : 'AI reading'}</span></span>)}
          {!edit && <button onClick={() => setEdit(true)} className="ml-auto flex items-center gap-1 text-text-2 hover:text-text"><Pencil size={12} />Correct</button>}
        </div>
        {f.on_screen && <p><span className="text-text-2">On screen:</span> {f.on_screen}</p>}
        {!edit ? <p><span className="text-text-2">AI interpretation:</span> {f.interpretation}</p> : <div className="flex flex-col gap-1.5 rounded-lg border border-accent/40 p-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={800} aria-label="Interpretation" className={cx(inputCls, 'h-auto py-1')} />
          <input value={names} onChange={(e) => setNames(e.target.value)} placeholder="Concepts, comma separated" aria-label="Concepts" className={inputCls} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" maxLength={300} aria-label="Reason for correction" className={inputCls} />
          <label className="flex items-center gap-1.5 text-text-2"><input type="checkbox" checked={unc} onChange={() => setUnc(!unc)} className="accent-[var(--accent)]" />Still uncertain</label>
          <ErrorText error={save.error} />
          <div className="flex gap-2"><Btn kind="primary" onClick={() => save.mutate()} disabled={save.isPending || !text.trim()}>Save correction</Btn><Btn kind="ghost" onClick={() => setEdit(false)}>Cancel</Btn></div></div>}
        {speech.length > 0 && <div className="rounded-lg bg-elevated/50 p-2">{speech.map((s) =>
          <p key={s.id} className="leading-relaxed"><button onClick={() => (hasFile ? onSeek(s.start) : yt && window.open(withTime(yt, mmss(s.start)), '_blank', 'noopener'))}
            className="mr-1.5 font-mono text-[11px] text-accent hover:underline">{mmss(s.start)}</button>{s.text}</p>)}</div>}
        {f.revisions.length > 0 && <details className="text-[11px] text-text-2"><summary className="cursor-pointer">History ({f.revisions.length})</summary>
          {f.revisions.map((rv) => <p key={rv.id} className="mt-1">{fmtT(rv.created_at)} · {rv.reason}. Before: "{rv.previous?.interpretation}"</p>)}</details>}
      </div>
      {big && <button className="fixed inset-0 z-[60] grid place-items-center bg-black/80 p-6" onClick={() => setBig(false)} aria-label="Close enlarged frame">
        <img src={`/api/brain/frames/${f.id}/image`} alt="" className="max-h-full max-w-full rounded-lg" /></button>}
    </li>
  )
}
