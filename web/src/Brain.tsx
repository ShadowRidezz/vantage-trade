import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BarChart3, Brain as BrainIcon, Check, ChevronDown, ChevronRight, Circle, Clock, ExternalLink, Film, FlaskConical, Filter, Paperclip,
  History as HistoryIcon, Layers, Library as LibraryIcon, Link2, List, Loader2, Maximize, Minus, Network, Plus, RotateCcw, Search, Sparkles,
  Target, Trash2, X } from 'lucide-react'
import { api, fmtT } from './api'
import { BrainGraph, type GraphHandle } from './BrainGraph'
import { CATS, VERIFY, ago, catIcon, catLabel, platformColor, platformIcon, useColors, useGraph, useSources, withTime, type Cat, type Job, type Source } from './brainShared'
import { useSettings } from './store'
import { VideoReview } from './VideoReview'
import { Badge, Btn, Empty, ErrorText, cx, inputCls } from './ui'

type Tab = 'graph' | 'library' | 'learning' | 'lab' | 'sources' | 'history'
const TABS: [Tab, string, typeof Network][] = [['graph', 'Knowledge Graph', Network], ['library', 'Library', LibraryIcon], ['learning', 'Learning', FlaskConical],
  ['lab', 'Strategy Lab', BarChart3], ['sources', 'Sources', Link2], ['history', 'History', HistoryIcon]]

export function Brain() {
  const [tab, setTab] = useState<Tab>('graph')
  const [selected, setSelected] = useState<string | null>(null)
  const [review, setReview] = useState<number | null>(null)
  const g = useGraph()
  const st = g.data?.stats
  const open = (nodeId: number) => { setSelected('n:' + nodeId); setTab('graph') }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-12 place-items-center rounded-full border border-accent/50 bg-accent/12 text-accent shadow-[0_0_24px_-6px_var(--accent)]"><BrainIcon size={24} /></div>
          <div><h1 className="text-[22px] font-bold leading-tight">AI Brain</h1>
            <p className="text-[13px] text-text-2">The AI's long-term memory, research, skills, and strategy system.</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {([[Layers, 'Knowledge', st?.knowledge], [Target, 'Strategies', st?.strategies], [BarChart3, 'Patterns', st?.patterns],
            [FlaskConical, 'Skills', st?.skills], [Link2, 'Sources', st?.sources]] as const).map(([I, l, v]) =>
            <div key={l} className="flex min-w-[118px] items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
              <I size={20} className="text-accent" /><div><div className="text-[11px] text-text-2">{l}</div><div className="font-mono text-[17px] font-semibold leading-tight">{v ?? '—'}</div></div>
            </div>)}
        </div>
      </header>
      <nav role="tablist" className="flex flex-wrap gap-1.5">
        {TABS.map(([t, l, I]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
          className={cx('flex h-10 items-center gap-2 rounded-lg border px-4 text-[13px] transition-colors', tab === t ? 'border-accent bg-accent text-white shadow-[0_0_20px_-6px_var(--accent)]' : 'border-line bg-panel text-text-2 hover:text-text')}>
          <I size={16} />{l}</button>)}
      </nav>
      <AddBar onView={(id) => { setSelected(id ? 'n:' + id : null); setTab('graph') }} onReview={setReview} />
      {review != null && <VideoReview id={review} onClose={() => setReview(null)} onOpenNode={(id) => { setReview(null); open(id) }} />}
      <ErrorText error={g.error} />
      <div className="min-h-[560px] flex-1">
        {tab === 'graph' ? <GraphTab selected={selected} setSelected={setSelected} /> : tab === 'library' ? <LibraryTab />
          : tab === 'learning' ? <LearningTab open={open} /> : tab === 'lab' ? <LabTab open={open} /> : tab === 'sources' ? <SourcesTab open={open} onReview={setReview} /> : <HistoryTab open={open} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Add to AI Brain

function uploadVideo(file: File, onProgress: (p: number) => void) {
  return new Promise<{ upload_id: string; size: number }>((ok, bad) => {
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/brain/uploads?name=${encodeURIComponent(file.name)}`)
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    x.onload = () => { let j: any = null; try { j = JSON.parse(x.responseText) } catch { /* not JSON */ } x.status < 300 ? ok(j) : bad(new Error(j?.detail ?? `Upload failed (${x.status})`)) }
    x.onerror = () => bad(new Error('Upload failed: the app could not be reached.'))
    x.send(file)
  })
}

const fmtDur = (s: number) => { s = Math.round(s); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

function AddBar({ onView, onReview }: { onView: (nodeId: number | null) => void; onReview: (analysisId: number) => void }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState(''), [kind, setKind] = useState('auto'), [notes, setNotes] = useState(''), [showNotes, setShowNotes] = useState(false)
  const [file, setFile] = useState<File | null>(null), [upPct, setUpPct] = useState<number | null>(null)
  const fileIn = useRef<HTMLInputElement>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const jobs = useQuery({ queryKey: ['brain', 'jobs'], queryFn: () => api<Job[]>('/api/brain/jobs') })
  useEffect(() => { const r = jobs.data?.find((j) => j.status === 'running'); if (r && jobId == null) setJobId(r.id) }, [jobs.data]) // eslint-disable-line
  const job = useQuery({ queryKey: ['brain', 'job', jobId], queryFn: () => api<Job>(`/api/brain/jobs/${jobId}`), enabled: jobId != null,
    refetchInterval: (q) => (q.state.data?.status === 'running' || !q.state.data ? 800 : false) })
  const j = job.data
  useEffect(() => { if (j && j.status !== 'running') qc.invalidateQueries({ queryKey: ['brain'] }) }, [j?.status]) // eslint-disable-line
  const start = useMutation({
    mutationFn: async () => {
      let up: { upload_id: string } | null = null
      if (file) { setUpPct(0); try { up = await uploadVideo(file, setUpPct) } finally { setUpPct(null) } }
      return api<{ job_id: number }>('/api/brain/import', { url: url.trim(), kind, transcript: notes, upload_id: up?.upload_id ?? null, upload_name: file?.name ?? null })
    },
    onSuccess: (r) => { setJobId(r.job_id); setShowNotes(false); setFile(null) },
  })
  const sources = useSources()
  const viewNode = () => onView(sources.data?.find((s) => s.id === j?.source_id)?.node_id ?? null)
  const isVideo = !!j && j.steps.length === 9
  const v = (j?.result as any)?.video as undefined | { analysis_id: number; title: string; duration: number; frames_analyzed: number; frames_with_chart: number
    transcript_coverage: number; has_audio: boolean; patterns: number; strategies: number; skills: number; conditions: number }
  const busy = start.isPending || j?.status === 'running'
  return (
    <section className="rounded-xl border border-accent/30 bg-panel">
      <form className="flex flex-wrap items-center gap-4 p-4" onSubmit={(e) => { e.preventDefault(); if (url.trim() || file) start.mutate() }}>
        <div className="flex items-center gap-3">
          <div className="grid size-12 place-items-center rounded-full bg-accent text-white shadow-[0_0_24px_-4px_var(--accent)]"><Plus size={24} /></div>
          <div><div className="text-[16px] font-semibold">Add to AI Brain</div><div className="text-[12px] text-text-2">Give the AI a new source to research and learn from.</div></div>
        </div>
        <label className="flex h-11 min-w-[280px] flex-1 items-center gap-2 rounded-lg border border-accent/40 bg-bg px-3 focus-within:border-accent">
          <Link2 size={16} className="text-text-2" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a URL (YouTube, TikTok, article, course, etc.)" aria-label="Source URL"
            className="h-full flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <label className="flex flex-col text-[11px] text-text-2">Content Type
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={cx(inputCls, 'mt-0.5 h-9 w-40')}>
            <option value="auto">Auto Detect</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="article">Article</option><option value="website">Website</option>
          </select></label>
        <button type="submit" disabled={(!url.trim() && !file) || busy}
          className="flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-[13px] font-semibold text-white shadow-[0_0_24px_-6px_var(--accent)] hover:brightness-110 disabled:opacity-50">
          <Sparkles size={16} />Analyze &amp; Add</button>
        <div className="flex flex-col gap-1 text-[12px]">
          <button type="button" onClick={() => fileIn.current?.click()} className="flex items-center gap-1 text-text-2 hover:text-text"><Paperclip size={14} />Attach video file</button>
          <button type="button" onClick={() => setShowNotes(!showNotes)} className="flex items-center gap-1 text-text-2 hover:text-text">
            {showNotes ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Add transcript or notes</button>
        </div>
        <input ref={fileIn} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.mkv,.webm,.m4v,.avi" hidden
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
      </form>
      {file && <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[12px]">
        <span className="flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 py-1"><Film size={14} className="text-accent" />{file.name}
          <span className="text-text-2">{(file.size / 1048576).toFixed(0)} MB</span>
          <button type="button" aria-label="Remove video" onClick={() => setFile(null)} className="text-text-2 hover:text-bear"><X size={13} /></button></span>
        {upPct != null ? <span className="text-text-2">Uploading to the analysis engine… {Math.round(upPct * 100)}%</span>
          : <span className="text-text-2">The video's frames and audio are analysed on this PC. Add its YouTube link too for the title and clickable timestamps. Only use videos you have the right to analyse.</span>}
      </div>}
      {showNotes && <div className="px-4 pb-4">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={200000}
          placeholder="Optional. A transcript or your own notes. For videos, attaching the video file gives a full visual + audio analysis instead."
          className={cx(inputCls, 'h-auto w-full py-2')} /></div>}
      <div className="px-4 pb-3 empty:hidden"><ErrorText error={start.error} /></div>
      {j && <div className="border-t border-line px-4 py-3">
        {j.status === 'running' && <div className="font-mono text-[12px]"><div className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-accent">
          {isVideo ? (j.url.includes('youtube.com') || j.url.includes('youtu.be') ? 'YOUTUBE VIDEO ANALYSIS' : 'VIDEO ANALYSIS') : 'ANALYZING SOURCE'}</div>
          <ul className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">{j.steps.map((s) => <li key={s.name} className="flex items-start gap-1.5">
            {s.done ? <Check size={14} className="mt-px shrink-0 text-bull" /> : s.skipped ? <Minus size={14} className="mt-px shrink-0 text-text-2" />
              : s.name === j.stage ? <Loader2 size={14} className="mt-px shrink-0 animate-spin text-accent" /> : <Circle size={12} className="mt-0.5 shrink-0 text-text-2" />}
            <span className={s.done ? '' : 'text-text-2'}>{s.name}{s.detail && <span className="text-text-2"> · {s.detail.slice(0, 90)}</span>}</span></li>)}</ul></div>}
        {j.status === 'done' && j.result && v && <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-[11px] font-semibold tracking-[0.1em] text-bull">VIDEO ANALYSIS COMPLETE</span>
            <span className="text-[13px] font-medium">{v.title}</span><span className="font-mono text-[12px] text-text-2">{fmtDur(v.duration)}</span></div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            <span>Visual segments analysed: <b className="font-mono">{v.frames_analyzed}</b> <span className="text-text-2">({v.frames_with_chart} with a chart)</span></span>
            <span>Transcript coverage: <b className="font-mono">{v.has_audio ? `${Math.round(v.transcript_coverage)}%` : 'no audio'}</b></span>
            <span>Patterns: <b className="font-mono">{v.patterns}</b></span><span>Strategies: <b className="font-mono">{v.strategies}</b></span><span>Skills: <b className="font-mono">{v.skills}</b></span>
            <span>New nodes: <b className="font-mono">{j.result.new_concepts}</b></span><span>Updated nodes: <b className="font-mono">{j.result.updated_concepts}</b></span>
            <span>New connections: <b className="font-mono">{j.result.new_connections}</b></span></div>
          <div className="flex gap-2"><Btn kind="primary" onClick={viewNode}>View in AI Brain</Btn><Btn onClick={() => onReview(v.analysis_id)}><Film size={13} />Review Video Analysis</Btn>
            <Btn kind="ghost" onClick={() => setJobId(null)}><X size={12} /></Btn></div></div>}
        {j.status === 'done' && j.result && !v && <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-[11px] font-semibold tracking-[0.1em] text-bull">SOURCE ANALYZED</span>
          <span className="text-[13px]">New Concepts: <b className="font-mono">{j.result.new_concepts}</b></span>
          <span className="text-[13px]">Existing Concepts Updated: <b className="font-mono">{j.result.updated_concepts}</b></span>
          <span className="text-[13px]">New Connections: <b className="font-mono">{j.result.new_connections}</b></span>
          <Btn kind="primary" onClick={viewNode}>View in Brain</Btn><Btn kind="ghost" onClick={() => setJobId(null)}><X size={12} /></Btn></div>}
        {j.status === 'incomplete' && <div className="flex items-start gap-2 text-[13px]"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex-1"><b>Not fully analysed.</b> {j.error}{' '}
            <button className="text-accent underline" onClick={() => { setUrl(j.url); fileIn.current?.click() }}>Attach the video file</button>{' · '}
            <button className="text-accent underline" onClick={() => { setShowNotes(true); setUrl(j.url) }}>Add transcript</button></div>
          <Btn kind="ghost" onClick={() => setJobId(null)}><X size={12} /></Btn></div>}
        {j.status === 'failed' && <div className="flex items-start gap-2 text-[13px] text-bear"><AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1"><b>{isVideo ? 'Video analysis failed.' : 'Import failed.'}</b> {j.error}</div><Btn kind="ghost" onClick={() => setJobId(null)}><X size={12} /></Btn></div>}
      </div>}
    </section>
  )
}

// ---------------------------------------------------------------- Knowledge Graph tab

function GraphTab({ selected, setSelected }: { selected: string | null; setSelected: (k: string | null) => void }) {
  const qc = useQueryClient()
  const g = useGraph(), sources = useSources(), C = useColors()
  const [filter, setFilter] = useState<Cat | 'all'>('all'), [search, setSearch] = useState(''), [showAll, setShowAll] = useState(false), [zoom, setZoom] = useState(1)
  const box = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), graph = useRef<GraphHandle>(null)
  const [size, setSize] = useState({ w: 600, h: 500 })
  useEffect(() => { const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height })); ro.observe(box.current!); return () => ro.disconnect() }, [])
  useEffect(() => { if (selected) requestAnimationFrame(() => graph.current?.focus(selected)) }, [selected])
  const counts = useMemo(() => Object.fromEntries(CATS.map(([c]) => [c, g.data?.nodes.filter((n) => n.category === c).length ?? 0])), [g.data])
  const matches = search.trim() ? (g.data?.nodes ?? []).filter((n) => n.title.toLowerCase().includes(search.toLowerCase())).slice(0, 8) : []
  const resetLayout = useMutation({ mutationFn: () => api('/api/brain/layout', undefined, 'DELETE'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['brain', 'graph'] }); location.reload() } })
  const empty = (sources.data?.length ?? 0) === 0
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[250px_minmax(0,1fr)_340px]">
      <aside className="hidden min-h-0 flex-col gap-3 overflow-y-auto 2xl:flex">
        <section className="rounded-xl border border-line bg-panel p-3">
          <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Filter size={16} />Knowledge Filters</h2>
          {[['all', 'All Knowledge', Layers, g.data?.stats.knowledge ?? 0] as const, ...CATS.map(([c, l, , I]) => [c, l, I, counts[c]] as const)].map(([c, l, I, n]) =>
            <button key={c} onClick={() => setFilter(c as Cat | 'all')} aria-pressed={filter === c}
              className={cx('mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px]', filter === c ? 'bg-accent/15 text-text' : 'text-text-2 hover:bg-elevated hover:text-text')}>
              <I size={16} style={{ color: c === 'all' ? undefined : C[c as Cat] }} /><span className="flex-1 text-left">{l}</span>
              <span className="rounded bg-elevated px-1.5 font-mono text-[11px]">{n}</span></button>)}
        </section>
        <section className="flex-1 rounded-xl border border-line bg-panel p-3">
          <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><Clock size={16} />Recent Additions</h2>
          {!sources.data?.length && <p className="text-[12px] text-text-2">Nothing imported yet.</p>}
          {sources.data?.slice(0, 6).map((s) => { const I = platformIcon(s.platform); return (
            <button key={s.id} onClick={() => s.node_id && setSelected('n:' + s.node_id)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-elevated">
              <I size={16} style={{ color: platformColor(s.platform) }} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[12px]">{s.title}</span><span className="shrink-0 text-[11px] text-text-2">{ago(s.imported_at)}</span>
              <StatusDot status={s.status} /></button>) })}
        </section>
      </aside>
      <section ref={panel} className="relative min-h-[520px] overflow-hidden rounded-xl border border-line bg-panel">
        <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2">
          <div className="relative w-72 max-w-full">
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-bg/90 px-3"><Search size={15} className="text-text-2" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the AI Brain…" aria-label="Search the AI Brain" className="flex-1 bg-transparent text-[13px] outline-none" /></label>
            {matches.length > 0 && <div className="absolute mt-1 w-full rounded-lg border border-line bg-panel p-1 shadow-lg">
              {matches.map((n) => <button key={n.id} onClick={() => { setSelected('n:' + n.id); setSearch('') }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-elevated">
                <span className="size-2 rounded-full" style={{ background: C[n.category] }} /><span className="flex-1 truncate">{n.title}</span><span className="text-text-2">{catLabel(n.category)}</span></button>)}
            </div>}
          </div>
          <div className="order-last flex w-full flex-wrap gap-1 2xl:hidden">{[['all', 'All', g.data?.stats.knowledge ?? 0] as const, ...CATS.map(([c, l]) => [c, l, counts[c]] as const)].map(([c, l, n]) =>
            <button key={c} onClick={() => setFilter(c as Cat | 'all')} aria-pressed={filter === c}
              className={cx('flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px]', filter === c ? 'border-accent bg-accent/15' : 'border-line bg-bg/90 text-text-2 hover:text-text')}>
              {c !== 'all' && <span className="size-2 rounded-full" style={{ background: C[c as Cat] }} />}{l}<span className="font-mono text-[11px] text-text-2">{n}</span></button>)}</div>
          <div className="flex gap-1.5">
            <IconBtn label="Graph view" active><Network size={16} /></IconBtn>
            <IconBtn label="Fullscreen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : panel.current?.requestFullscreen())}><Maximize size={16} /></IconBtn>
            <IconBtn label="Fit graph to view" onClick={() => graph.current?.fit()}><RotateCcw size={16} /></IconBtn>
          </div>
        </div>
        <div ref={box} className="absolute inset-0">
          {g.data && <BrainGraph ref={graph} data={g.data} filter={filter} selected={selected} onSelect={setSelected} search={search} showAll={showAll}
            onZoom={setZoom} width={size.w} height={size.h} />}
        </div>
        {empty && g.data && <div className="pointer-events-none absolute inset-x-0 bottom-16 text-center">
          <div className="text-[15px] font-semibold">Start Building Your AI's Knowledge</div>
          <div className="text-[12px] text-text-2">Add a YouTube video, TikTok, article, or website to begin.</div></div>}
        <div className="absolute bottom-3 left-3 flex items-center gap-3 text-[11px] text-text-2">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={showAll} onChange={() => setShowAll(!showAll)} className="accent-[var(--accent)]" />Show all connections</label>
          <button onClick={() => confirm('Reset every node to its automatic position?') && resetLayout.mutate()} className="hover:text-text">Reset layout</button>
        </div>
        <div className="absolute bottom-3 right-3 flex items-center rounded-lg border border-line bg-bg/90">
          <button aria-label="Zoom out" onClick={() => graph.current?.zoomBy(0.8)} className="grid size-8 place-items-center hover:text-accent"><Minus size={15} /></button>
          <span className="w-14 text-center font-mono text-[12px]">{Math.round(zoom * 100)}%</span>
          <button aria-label="Zoom in" onClick={() => graph.current?.zoomBy(1.25)} className="grid size-8 place-items-center hover:text-accent"><Plus size={15} /></button>
        </div>
      </section>
      <aside className="min-h-0 overflow-y-auto rounded-xl border border-line bg-panel">
        <NodePanel selected={selected} onSelect={setSelected} />
      </aside>
    </div>
  )
}

const IconBtn = ({ children, label, onClick, active }: { children: ReactNode; label: string; onClick?: () => void; active?: boolean }) =>
  <button aria-label={label} title={label} onClick={onClick} className={cx('grid size-9 place-items-center rounded-lg border', active ? 'border-accent bg-accent text-white' : 'border-line bg-bg/90 text-text-2 hover:text-text')}>{children}</button>

const StatusDot = ({ status }: { status: string }) => status === 'complete' ? <Check size={14} className="shrink-0 rounded-full bg-bull p-0.5 text-white" />
  : status === 'incomplete' ? <AlertTriangle size={14} className="shrink-0 text-warn" /> : status === 'failed' ? <X size={14} className="shrink-0 text-bear" />
  : <Loader2 size={14} className="shrink-0 animate-spin text-accent" />

// ---------------------------------------------------------------- selected-node panel

type Detail = { node: { id: number; title: string; category: Cat; summary: string; detail: string; verification: string; rules: Record<string, string> | null; created_at: number; updated_at: number; origin: string | null }
  connections: { id: number; title: string; category: Cat; rel: string; outgoing: boolean; explanation: string; created_at: number }[]
  sources: { id: number; title: string; url: string; platform: string; author: string | null; imported_at: number; excerpt: string | null; timestamp: string | null; complete: boolean; claims?: string[] | null; note?: string | null }[]
  revisions: { id: number; reason: string; created_at: number; previous: string | null; updated: string | null }[] }

const relText = (rel: string, out: boolean) => { const r = rel.replace(/_/g, ' ').toLowerCase(); return out ? r : `← ${r}` }

export function NodePanel({ selected, onSelect }: { selected: string | null; onSelect: (k: string) => void }) {
  const C = useColors(), g = useGraph()
  const [tab, setTab] = useState<'overview' | 'conn' | 'activity'>('overview')
  const nid = selected?.startsWith('n:') ? Number(selected.slice(2)) : null
  const d = useQuery({ queryKey: ['brain', 'node', nid], queryFn: () => api<Detail>(`/api/brain/nodes/${nid}`), enabled: nid != null })
  useEffect(() => setTab('overview'), [nid])
  if (!selected || selected === 'ai') return <div className="p-4 text-[13px]">
    <div className="mb-2 flex items-center gap-2 text-[16px] font-semibold"><BrainIcon size={18} className="text-accent" />VANTAGE TRADE AI</div>
    <p className="text-text-2">Every node is a stored record. Patterns and strategies marked "Built-in rule" come from this app's own engine; backtests are real simulations; everything else comes from sources you add. Click any node to see what the AI knows about it and where it came from.</p>
    <div className="mt-3 grid grid-cols-2 gap-2">{CATS.map(([c, l]) => <div key={c} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-[12px]">
      <span className="size-2.5 rounded-full" style={{ background: C[c] }} />{l}<span className="ml-auto font-mono text-text-2">{g.data?.nodes.filter((n) => n.category === c).length ?? 0}</span></div>)}</div>
  </div>
  if (selected.startsWith('cat:')) {
    const c = selected.slice(4) as Cat, I = catIcon(c), list = g.data?.nodes.filter((n) => n.category === c) ?? []
    return <div className="p-4"><div className="mb-3 flex items-center gap-3"><div className="grid size-11 place-items-center rounded-full border-2" style={{ borderColor: C[c], color: C[c] }}><I size={20} /></div>
      <div><div className="text-[17px] font-semibold">{CATS.find((x) => x[0] === c)?.[1]}</div><div className="text-[12px] text-text-2">{list.length} records</div></div></div>
      {!list.length && <p className="text-[12px] text-text-2">No {CATS.find((x) => x[0] === c)?.[1].toLowerCase()} yet. They appear when a source you add explains one.</p>}
      {list.map((n) => <button key={n.id} onClick={() => onSelect('n:' + n.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-elevated">
        <span className="size-2 rounded-full" style={{ background: C[c] }} /><span className="flex-1 truncate">{n.title}</span><ChevronRight size={14} className="text-text-2" /></button>)}</div>
  }
  if (!d.data) return <Empty>{d.isPending ? 'Loading…' : <ErrorText error={d.error} />}</Empty>
  const { node: n, connections, sources, revisions } = d.data
  const I = catIcon(n.category), own = sources.find((s) => n.origin === 'source:' + s.id)
  const [vl, vd] = VERIFY[n.verification] ?? [n.verification, '']
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-line p-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-full border-2" style={{ borderColor: C[n.category], color: C[n.category], boxShadow: `0 0 18px -6px ${C[n.category]}` }}><I size={22} /></div>
        <div className="min-w-0 flex-1"><div className="text-[18px] font-semibold leading-tight">{n.title}</div>
          <span className="mt-1 inline-block rounded-md px-2 py-0.5 text-[12px] font-medium" style={{ background: C[n.category] + '26', color: C[n.category] }}>{catLabel(n.category)}</span></div>
        {own && <a href={own.url} target="_blank" rel="noreferrer noopener" title="Open original" className="text-text-2 hover:text-text"><ExternalLink size={18} /></a>}
      </div>
      <div className="flex gap-1 border-b border-line p-2">{([['overview', 'Overview'], ['conn', `Connections (${connections.length})`], ['activity', 'Activity']] as const).map(([t, l]) =>
        <button key={t} onClick={() => setTab(t)} className={cx('h-8 flex-1 rounded-md text-[12px]', tab === t ? 'bg-accent font-medium text-white' : 'text-text-2 hover:text-text')}>{l}</button>)}</div>
      {tab === 'overview' && <div className="flex flex-col gap-4 p-4 text-[13px]">
        <section><h3 className="mb-1 font-semibold">Summary</h3><p className="leading-relaxed text-text-2">{n.summary || '—'}</p></section>
        <section className="flex items-center gap-2"><Badge tone={n.verification === 'disputed' ? 'bear' : n.verification === 'imported' ? 'warn' : 'bull'}>{vl}</Badge><span className="text-[11px] text-text-2">{vd}</span></section>
        {n.detail && <section><h3 className="mb-1 font-semibold">Details</h3><p className="whitespace-pre-wrap leading-relaxed text-text-2">{n.detail}</p></section>}
        {n.category === 'strategy' && n.rules && <section><h3 className="mb-1 font-semibold">Rules (as stated)</h3>
          <dl className="grid grid-cols-[64px_1fr] gap-y-1 text-[12px]">{['entry', 'exit', 'stop', 'target', 'filters'].map((k) =>
            <div key={k} className="contents"><dt className="capitalize text-text-2">{k}</dt><dd>{n.rules![k] || <span className="text-warn">Not specified by the source</span>}</dd></div>)}</dl></section>}
        {own?.claims && own.claims.length > 0 && <section><h3 className="mb-1 font-semibold">Claims needing verification</h3>
          <ul className="list-disc pl-4 text-[12px] text-text-2">{own.claims.map((c) => <li key={c}>{c}</li>)}</ul></section>}
        {own?.note && <p className="text-[12px] text-warn">{own.note}</p>}
        {connections.length > 0 && <section><h3 className="mb-1.5 flex items-center gap-2 font-semibold"><Network size={15} />Connected To</h3>
          {connections.slice(0, 6).map((c, i) => <ConnRow key={i} c={c} color={C[c.category]} onClick={() => onSelect('n:' + c.id)} />)}
          {connections.length > 6 && <button onClick={() => setTab('conn')} className="mt-1 text-[12px] text-accent">All {connections.length} connections</button>}</section>}
        {sources.filter((s) => s !== own).length > 0 && <section><h3 className="mb-1.5 flex items-center gap-2 font-semibold"><Link2 size={15} />Sources ({sources.filter((s) => s !== own).length})</h3>
          {sources.filter((s) => s !== own).map((s) => { const P = platformIcon(s.platform); return (
            <div key={s.id} className="mb-1.5 rounded-lg border border-line px-2.5 py-2">
              <a href={withTime(s.url, s.timestamp)} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 hover:text-accent">
                <P size={16} style={{ color: platformColor(s.platform) }} className="shrink-0" /><span className="flex-1 truncate">{s.title}</span>
                {s.timestamp && <span className="font-mono text-[11px] text-text-2">{s.timestamp}</span>}<ExternalLink size={14} className="shrink-0 text-text-2" /></a>
              {s.excerpt && <p className="mt-1 border-l-2 border-line pl-2 text-[12px] italic text-text-2">"{s.excerpt}"</p>}
              <div className="mt-0.5 text-[11px] text-text-2">Imported {fmtT(s.imported_at)}{s.author ? ` · ${s.author}` : ''}</div>
            </div>) })}</section>}
      </div>}
      {tab === 'conn' && <div className="p-3">{!connections.length && <p className="p-2 text-[12px] text-text-2">No connections yet.</p>}
        {connections.map((c, i) => <div key={i} className="mb-1"><ConnRow c={c} color={C[c.category]} onClick={() => onSelect('n:' + c.id)} />
          <p className="px-2.5 pb-1 text-[11px] text-text-2">{c.explanation}</p></div>)}</div>}
      {tab === 'activity' && <ul className="flex flex-col gap-2 p-4 text-[12px]">
        {[...revisions.map((r) => ({ t: r.created_at, text: r.reason })), ...connections.map((c) => ({ t: c.created_at, text: `Connected: ${relText(c.rel, c.outgoing)} ${c.title}` })),
          { t: n.created_at, text: 'Record created' }].sort((a, b) => b.t - a.t).map((a, i) =>
          <li key={i} className="flex gap-2"><span className="w-28 shrink-0 font-mono text-[11px] text-text-2">{fmtT(a.t)}</span><span>{a.text}</span></li>)}</ul>}
    </div>
  )
}

const ConnRow = ({ c, color, onClick }: { c: Detail['connections'][number]; color: string; onClick: () => void }) =>
  <button onClick={onClick} className="mb-1 flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[12px] hover:bg-elevated">
    <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} /><span className="flex-1 truncate">{c.title} <span className="text-text-2">({catLabel(c.category)})</span></span>
    <span className="shrink-0 font-mono text-[10px] text-text-2">{relText(c.rel, c.outgoing)}</span><ChevronRight size={14} className="shrink-0 text-text-2" /></button>

// ---------------------------------------------------------------- Library

function LibraryTab() {
  const g = useGraph(), C = useColors()
  const [q, setQ] = useState(''), [cat, setCat] = useState<Cat | 'all'>('all'), [sel, setSel] = useState<string | null>(null)
  const conn = useMemo(() => { const m = new Map<number, number>(); for (const e of g.data?.edges ?? []) { m.set(e.src, (m.get(e.src) ?? 0) + 1); m.set(e.dst, (m.get(e.dst) ?? 0) + 1) } return m }, [g.data])
  const rows = (g.data?.nodes ?? []).filter((n) => (cat === 'all' || n.category === cat) && (n.title + ' ' + n.summary).toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="flex min-h-0 flex-col rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line bg-bg px-3"><Search size={15} className="text-text-2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search knowledge" aria-label="Search knowledge" className="flex-1 bg-transparent text-[13px] outline-none" /></label>
          {[['all', 'All'] as const, ...CATS.map(([c, l]) => [c, l] as const)].map(([c, l]) => <button key={c} onClick={() => setCat(c as Cat | 'all')}
            className={cx('h-8 rounded-lg px-3 text-[12px]', cat === c ? 'bg-accent text-white' : 'text-text-2 hover:bg-elevated hover:text-text')}>{l}</button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-text-2"><tr className="border-b border-line">{['Title', 'Category', 'Verification', 'Sources', 'Connections'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((n) => <tr key={n.id} onClick={() => setSel('n:' + n.id)} className={cx('cursor-pointer border-b border-line/50', sel === 'n:' + n.id ? 'bg-accent/10' : 'hover:bg-elevated/60')}>
            <td className="px-3 py-2"><div className="font-medium">{n.title}</div><div className="max-w-xl truncate text-[12px] text-text-2">{n.summary}</div></td>
            <td className="px-3"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: C[n.category] }} />{catLabel(n.category)}</span></td>
            <td className="px-3 whitespace-nowrap">{VERIFY[n.verification]?.[0] ?? n.verification}</td><td className="px-3 font-mono">{n.sources}</td><td className="px-3 font-mono">{conn.get(n.id) ?? 0}</td></tr>)}</tbody>
        </table>{!rows.length && <Empty>No knowledge matches.</Empty>}</div>
      </section>
      <aside className="min-h-0 overflow-y-auto rounded-xl border border-line bg-panel"><NodePanel selected={sel} onSelect={setSel} /></aside>
    </div>
  )
}

// ---------------------------------------------------------------- Learning

function LearningTab({ open }: { open: (id: number) => void }) {
  const jobs = useQuery({ queryKey: ['brain', 'jobs'], queryFn: () => api<Job[]>('/api/brain/jobs'), refetchInterval: 3000 })
  const g = useGraph(), sources = useSources()
  const [exp, setExp] = useState<number | null>(null)
  const js = jobs.data ?? [], by = (s: string) => js.filter((j) => j.status === s)
  const sum = (k: 'new_concepts' | 'updated_concepts' | 'new_connections') => js.reduce((a, j) => a + (j.result?.[k] ?? 0), 0)
  const review = (g.data?.nodes ?? []).filter((n) => n.verification === 'imported' || n.verification === 'disputed')
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-h-0 flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">{([['Active', by('running').length], ['Completed', by('done').length], ['Incomplete', by('incomplete').length],
          ['Failed', by('failed').length], ['Concepts extracted', sum('new_concepts') + sum('updated_concepts')], ['Connections created', sum('new_connections')]] as const).map(([l, v]) =>
          <div key={l} className="rounded-lg border border-line bg-panel px-3 py-2"><div className="text-[11px] text-text-2">{l}</div><div className="font-mono text-[18px] font-semibold">{v}</div></div>)}</div>
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-panel p-2">
          {!js.length && <Empty>No imports yet. Add a source above to start learning.</Empty>}
          {js.map((j) => <div key={j.id} className="border-b border-line/60 last:border-0">
            <button onClick={() => setExp(exp === j.id ? null : j.id)} className="flex w-full items-center gap-3 px-2 py-2 text-left text-[13px] hover:bg-elevated/60">
              <StatusDot status={j.status === 'done' ? 'complete' : j.status === 'running' ? 'processing' : j.status} />
              <span className="min-w-0 flex-1 truncate">{sources.data?.find((s) => s.id === j.source_id)?.title ?? j.url}</span>
              {j.result && <span className="text-[12px] text-text-2">{j.result.new_concepts} new · {j.result.updated_concepts} updated · {j.result.new_connections} links</span>}
              <span className="w-20 text-right text-[11px] text-text-2">{ago(j.started_at)}</span></button>
            {exp === j.id && <div className="px-9 pb-3 text-[12px]">
              <ul className="mb-1">{j.steps.map((s) => <li key={s.name} className="flex gap-1.5">{s.done ? <Check size={13} className="text-bull" /> : <Circle size={11} className="mt-0.5 text-text-2" />}{s.name}<span className="text-text-2">{s.detail && ` · ${s.detail}`}</span></li>)}</ul>
              {j.error && <p className={j.status === 'failed' ? 'text-bear' : 'text-warn'}>{j.error}</p>}
              {j.source_id && sources.data?.find((s) => s.id === j.source_id)?.node_id && <Btn className="mt-1" onClick={() => open(sources.data!.find((s) => s.id === j.source_id)!.node_id!)}>View in Brain</Btn>}
            </div>}</div>)}
        </div>
      </section>
      <aside className="flex min-h-0 flex-col gap-3">
        <section className="rounded-xl border border-line bg-panel p-3 text-[12px]"><h2 className="mb-2 text-[14px] font-semibold">How knowledge is graded</h2>
          {Object.entries(VERIFY).map(([k, [l, d]]) => <p key={k} className="mb-1"><b>{l}:</b> <span className="text-text-2">{d}</span></p>)}
          <p className="mt-2 text-text-2">A creator's claim is never treated as verified. Strategies count as tested only after a historical simulation in this app.</p></section>
        <section className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-panel p-3"><h2 className="mb-2 text-[14px] font-semibold">Awaiting review ({review.length})</h2>
          {!review.length && <p className="text-[12px] text-text-2">Nothing waiting. Imported knowledge appears here until another source corroborates it.</p>}
          {review.map((n) => <button key={n.id} onClick={() => open(n.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-elevated">
            <span className="flex-1 truncate">{n.title}</span><Badge tone={n.verification === 'disputed' ? 'bear' : 'warn'}>{VERIFY[n.verification][0]}</Badge></button>)}</section>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- Strategy Lab

type Lab = { node: Detail['node']; rules: Record<string, string>; missing_rules: string[]; built_in: boolean; status: string
  patterns: Detail['connections']; skills: Detail['connections']; conditions: Detail['connections']; research: Detail['connections']; sources: Detail['sources'] }

function LabTab({ open }: { open: (id: number) => void }) {
  const lab = useQuery({ queryKey: ['brain', 'lab'], queryFn: () => api<Lab[]>('/api/brain/strategy-lab') })
  const set = useSettings((s) => s.set), C = useColors()
  const [sel, setSel] = useState<number | null>(null)
  const cur = lab.data?.find((x) => x.node.id === sel) ?? lab.data?.[0]
  const chips = (title: string, list: Detail['connections']) => <section><h3 className="mb-1 text-[12px] font-semibold text-text-2">{title}</h3>
    {list.length ? <div className="flex flex-wrap gap-1.5">{list.map((c, i) => <button key={i} onClick={() => open(c.id)} className="rounded-md px-2 py-1 text-[12px]"
      style={{ background: C[c.category] + '22', color: C[c.category] }}>{c.title}</button>)}</div> : <p className="text-[12px] text-text-2">None recorded.</p>}</section>
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto rounded-xl border border-line bg-panel p-2">
        {lab.data?.map((x) => <button key={x.node.id} onClick={() => setSel(x.node.id)} className={cx('mb-1 flex w-full flex-col rounded-lg px-3 py-2 text-left', cur?.node.id === x.node.id ? 'bg-accent/15' : 'hover:bg-elevated')}>
          <span className="text-[13px] font-medium">{x.node.title}</span><span className={cx('text-[11px]', x.status === 'needs clarification' ? 'text-warn' : 'text-text-2')}>{x.status}</span></button>)}
        <ErrorText error={lab.error} />
      </aside>
      {cur ? <section className="flex min-h-0 flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-[13px]">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-[18px] font-semibold">{cur.node.title}</h2>
          <Badge tone={cur.status === 'needs clarification' ? 'warn' : cur.built_in ? 'bull' : 'muted'}>{cur.status}</Badge>
          <Badge>{VERIFY[cur.node.verification]?.[0] ?? cur.node.verification}</Badge>
          {cur.built_in && <Btn kind="primary" className="ml-auto" onClick={() => set({ page: 'backtesting' })}>Open in Backtesting</Btn>}</div>
        <p className="text-text-2">{cur.node.summary}</p>
        <section><h3 className="mb-1 text-[12px] font-semibold text-text-2">Strategy rules</h3>
          <dl className="grid grid-cols-[72px_1fr] gap-y-1.5">{['entry', 'exit', 'stop', 'target', 'filters'].map((k) => <div key={k} className="contents">
            <dt className="capitalize text-text-2">{k}</dt><dd>{cur.rules?.[k] || <span className="text-warn">Not specified: needs clarification before it can be tested</span>}</dd></div>)}</dl></section>
        {!cur.built_in && <p className="rounded-lg border border-line p-3 text-[12px] text-text-2">Learning a strategy from a source doesn't make it executable. VANTAGE TRADE can only backtest strategies whose rules are coded into its engine (FVG Continuation and Liquidity Sweep Reversal today). {cur.missing_rules.length ? `This one is missing: ${cur.missing_rules.join(', ')}. Nothing has been invented to fill the gaps.` : 'Its rules are fully stated, so it is ready to be coded and tested.'}</p>}
        <div className="grid gap-4 md:grid-cols-2">{chips('Required patterns', cur.patterns)}{chips('Required skills', cur.skills)}{chips('Market conditions', cur.conditions)}{chips('Backtests and research', cur.research)}</div>
        <section><h3 className="mb-1 text-[12px] font-semibold text-text-2">Supporting sources</h3>
          {cur.sources.length ? cur.sources.map((s) => <a key={s.id} href={s.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 py-0.5 hover:text-accent"><ExternalLink size={13} />{s.title}</a>)
            : <p className="text-[12px] text-text-2">{cur.built_in ? 'Defined in VANTAGE TRADE itself.' : 'None.'}</p>}</section>
      </section> : <Empty>{lab.isPending ? 'Loading…' : 'No strategies stored.'}</Empty>}
    </div>
  )
}

// ---------------------------------------------------------------- Sources

function SourcesTab({ open, onReview }: { open: (id: number) => void; onReview: (analysisId: number) => void }) {
  const qc = useQueryClient(), src = useSources()
  const del = useMutation({ mutationFn: (id: number) => api(`/api/brain/sources/${id}`, undefined, 'DELETE'), onSuccess: () => qc.invalidateQueries({ queryKey: ['brain'] }) })
  return (
    <section className="h-full overflow-auto rounded-xl border border-line bg-panel">
      <ErrorText error={del.error} />
      {!src.data?.length ? <Empty>No sources yet. Paste a YouTube, TikTok, article or website link above.</Empty> : <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-panel text-left text-[11px] text-text-2"><tr className="border-b border-line">{['Source', 'Status', 'Content analysed', 'Concepts', 'Imported', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody>{src.data.map((s: Source) => { const P = platformIcon(s.platform); return (
          <tr key={s.id} className="border-b border-line/50 align-top">
            <td className="px-3 py-2"><a href={s.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 font-medium hover:text-accent">
              <P size={16} style={{ color: platformColor(s.platform) }} className="shrink-0" />{s.title}</a>
              <div className="pl-6 text-[11px] text-text-2">{s.platform}{s.author ? ` · ${s.author}` : ''}{s.published ? ` · ${s.published.slice(0, 10)}` : ''}</div>
              {s.note && <div className="pl-6 text-[11px] text-warn">{s.note}</div>}
              {s.claims && s.claims.length > 0 && <div className="pl-6 text-[11px] text-text-2">Claims to verify: {s.claims.join(' · ')}</div>}</td>
            <td className="px-3 py-2"><span className="flex items-center gap-1.5"><StatusDot status={s.status} />{s.status}</span></td>
            <td className="px-3 py-2 font-mono text-[12px]">{s.analysis_id ? (s.has_audio ? 'video + audio' : 'video only, no audio') : s.complete ? `${s.content_chars.toLocaleString()} chars` : 'title only'}</td>
            <td className="px-3 py-2 font-mono">{s.concepts}</td><td className="px-3 py-2 whitespace-nowrap text-text-2">{fmtT(s.imported_at)}</td>
            <td className="px-3 py-2"><div className="flex gap-1">{s.analysis_id && <Btn onClick={() => onReview(s.analysis_id!)}><Film size={12} />Review</Btn>}{s.node_id && <Btn onClick={() => open(s.node_id!)}>View</Btn>}
              <Btn kind="danger" onClick={() => confirm(`Delete "${s.title}"? Knowledge that only this source supported is removed too.`) && del.mutate(s.id)}><Trash2 size={12} /></Btn></div></td>
          </tr>) })}</tbody></table>}
    </section>
  )
}

// ---------------------------------------------------------------- History

function HistoryTab({ open }: { open: (id: number) => void }) {
  const h = useQuery({ queryKey: ['brain', 'history'], queryFn: () => api<{ time: number; kind: string; text: string; node_id?: number; node?: string; status?: string }[]>('/api/brain/history') })
  return (
    <section className="h-full overflow-auto rounded-xl border border-line bg-panel p-3">
      {!h.data?.length && <Empty>No activity yet.</Empty>}
      <ol className="flex flex-col">{h.data?.map((x, i) => <li key={i} className="flex items-start gap-3 border-b border-line/50 py-2 text-[13px] last:border-0">
        <span className="w-32 shrink-0 font-mono text-[11px] text-text-2">{fmtT(x.time)}</span>
        {x.kind === 'import' ? <Link2 size={15} className="mt-0.5 shrink-0 text-accent" /> : <List size={15} className="mt-0.5 shrink-0 text-text-2" />}
        <span className="min-w-0 flex-1">{x.node && <button onClick={() => open(x.node_id!)} className="mr-1 font-medium hover:text-accent">{x.node}:</button>}{x.text}</span></li>)}</ol>
    </section>
  )
}
