import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CandlestickSeries, createChart, createSeriesMarkers, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts'
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react'
import { api, fmtP, fmtT, fmtUsd, type Detection, type Trade } from './api'
import type { Bar } from './indicators'
import { useSettings } from './store'
import { DetectionDetail, DetectionLayer } from './Vision'
import { Badge, Btn, Empty, ErrorText, Simulated, cx, dirTone } from './ui'

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
type R = { trade: Trade; bars: Bar[]; detections: Detection[]; provider: { label: string } }

export function Replay({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['replay', id], queryFn: () => api<R>(`/api/trades/${id}/replay`), staleTime: Infinity })
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-label={`Replay trade ${id}`}>
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
        <span className="flex items-center gap-2 text-[13px] font-semibold">AI Replay · trade #{id} <Simulated /></span>
        <Btn kind="ghost" onClick={onClose}><X size={14} />Close</Btn>
      </header>
      {q.error ? <div className="p-4"><ErrorText error={q.error} /></div> : !q.data ? <Empty>Loading historical candles…</Empty> : <Player r={q.data} />}
    </div>
  )
}

function Player({ r }: { r: R }) {
  const { trade: t, bars, detections } = r
  const theme = useSettings((s) => s.theme)
  const entryIdx = Math.max(0, bars.findLastIndex((b) => b.time <= t.entry_time))
  const [idx, setIdx] = useState(Math.max(0, entryIdx - 60))
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(4), [sel, setSel] = useState<string | null>(null)
  const el = useRef<HTMLDivElement>(null), chart = useRef<IChartApi>(), series = useRef<ISeriesApi<'Candlestick'>>()
  const markers = useRef<ISeriesMarkersPluginApi<Time>>(), lines = useRef<IPriceLine[]>([])
  const [ready, setReady] = useState(false)
  const now = bars[idx].time
  const entered = now >= bars[entryIdx].time, exited = t.exit_time != null && now >= t.exit_time

  useEffect(() => {
    const c = createChart(el.current!, { autoSize: true, timeScale: { timeVisible: true, rightOffset: 8 } })
    series.current = c.addSeries(CandlestickSeries, { borderVisible: false })
    markers.current = createSeriesMarkers(series.current, [])
    chart.current = c; setReady(true)
    return () => c.remove()
  }, [])
  useEffect(() => {
    const [bg, text, line, bull, bear] = ['--panel', '--text-2', '--border', '--bull', '--bear'].map(css)
    chart.current!.applyOptions({ layout: { background: { color: bg }, textColor: text, fontFamily: 'Inter' }, grid: { vertLines: { color: line + '55' }, horzLines: { color: line + '55' } } })
    series.current!.applyOptions({ upColor: bull, downColor: bear, wickUpColor: bull, wickDownColor: bear })
  }, [theme])
  // Only candles up to `now` exist on this chart: nothing later can leak into view.
  useEffect(() => {
    const s = series.current!
    s.setData(bars.slice(0, idx + 1).map((b) => ({ ...b, time: b.time as UTCTimestamp })))
    const m: SeriesMarker<Time>[] = []
    if (entered) m.push({ time: bars[entryIdx].time as UTCTimestamp, position: t.direction === 'long' ? 'belowBar' : 'aboveBar', color: css('--accent'),
      shape: t.direction === 'long' ? 'arrowUp' : 'arrowDown', text: `Entry ${fmtP(t.entry_price)}` })
    if (exited) { const xi = bars.findLastIndex((b) => b.time <= t.exit_time!); m.push({ time: bars[xi].time as UTCTimestamp, position: 'aboveBar', color: (t.pnl ?? 0) >= 0 ? css('--bull') : css('--bear'), shape: 'circle', text: `Exit ${fmtP(t.exit_price)} (${t.exit_reason})` }) }
    markers.current!.setMarkers(m)
    lines.current.forEach((l) => s.removePriceLine(l)); lines.current = []
    if (entered && !exited) for (const [p, c, title] of [[t.stop, css('--bear'), 'stop'], [t.target, css('--bull'), 'target']] as const)
      lines.current.push(s.createPriceLine({ price: p, color: c, title, lineStyle: LineStyle.Dashed, lineWidth: 1 }))
    if (playing) chart.current!.timeScale().scrollToRealTime()
  }, [idx, theme]) // eslint-disable-line
  useEffect(() => {
    if (!playing) return
    const i = setInterval(() => setIdx((x) => { if (x >= bars.length - 1) { setPlaying(false); return x } return x + 1 }), 1000 / speed)
    return () => clearInterval(i)
  }, [playing, speed, bars.length])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input, select')) return
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p) }
      if (e.key === 'ArrowRight') setIdx((x) => Math.min(bars.length - 1, x + 1))
      if (e.key === 'ArrowLeft') setIdx((x) => Math.max(0, x - 1)) }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [bars.length])

  const known = useMemo(() => detections.filter((d) => d.confirmed_at <= now && d.kind !== 'swing' && d.kind !== 'important'), [detections, now])
  const times = useMemo(() => bars.slice(0, idx + 1).map((b) => b.time), [bars, idx])
  const recent = [...known].sort((a, b) => b.confirmed_at - a.confirmed_at).slice(0, 40)
  const selD = known.find((d) => d.id === sel)
  const snap = t.analysis
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={el} className="absolute inset-0" />
          {ready && <DetectionLayer chart={chart.current!} series={series.current!} times={times} dets={known.filter((d) => d.confirmed_at >= bars[Math.max(0, idx - 200)].time)}
            selected={sel} onSelect={setSel} layoutKey={String(idx)} now={now} />}
        </div>
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
          <Btn kind="ghost" onClick={() => setIdx(Math.max(0, idx - 1))} title="Step backward (←)"><ChevronLeft size={14} /></Btn>
          <Btn kind="primary" onClick={() => setPlaying(!playing)} title="Play / pause (space)">{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? 'Pause' : 'Play'}</Btn>
          <Btn kind="ghost" onClick={() => setIdx(Math.min(bars.length - 1, idx + 1))} title="Step forward (→)"><ChevronRight size={14} /></Btn>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" className="h-7 rounded border border-line bg-bg px-1 text-[12px]">
            {[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s} candles/s</option>)}</select>
          <input type="range" min={0} max={bars.length - 1} value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Timeline" className="mx-2 flex-1 accent-[var(--accent)]" />
          <span className="w-36 text-right font-mono text-[11px] text-text-2">{fmtT(now)} · {idx + 1}/{bars.length}</span>
        </div>
      </div>
      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-[12px]">
        <section className="border-b border-line p-3">
          <div className="flex items-center gap-2"><span className="font-semibold">{t.symbol} {t.tf}</span><Badge tone={dirTone(t.direction)}>{t.direction}</Badge><span className="text-text-2">{t.qty} × {t.contract.split(' ')[0]}</span></div>
          <ol className="mt-2 flex flex-col gap-1 font-mono text-[11.5px]">
            <li className={entered ? '' : 'text-text-2'}>{entered ? '●' : '○'} Entry {entered ? `${fmtP(t.entry_price)} at ${fmtT(t.entry_time)}` : 'not reached yet'}</li>
            {entered && <li>  Stop {fmtP(t.stop)} · Target {fmtP(t.target)}</li>}
            <li className={exited ? '' : 'text-text-2'}>{exited ? '●' : '○'} Exit {exited ? `${fmtP(t.exit_price)} (${t.exit_reason}) at ${fmtT(t.exit_time)}` : t.status === 'open' ? 'trade still open' : 'not reached yet'}</li>
          </ol>
          {exited && <p className={cx('mt-2 font-mono text-[14px] font-medium', (t.pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>Result {fmtUsd(t.pnl)}</p>}
        </section>
        {entered && snap && <section className="border-b border-line p-3">
          <div className="mb-1 text-[11px] font-medium text-text-2">Recorded analysis at entry</div>
          <p className="mb-1"><Badge tone={dirTone(snap.summary?.bias)}>Bias: {snap.summary?.bias}</Badge></p>
          <ul className="list-disc pl-4">{snap.summary?.facts.map((f) => <li key={f}>{f}</li>)}</ul>
          {snap.detections.map((d) => <p key={d.id} className="mt-1 text-text-2"><span className="text-text">{d.label}:</span> {d.reason}</p>)}
        </section>}
        {selD && <section className="border-b border-line bg-elevated/40 p-3"><DetectionDetail d={selD} now={now} /></section>}
        <section className="p-1.5">
          <div className="px-1.5 pb-1 text-[11px] font-medium text-text-2">Detections available at this time ({known.length})</div>
          {recent.map((d) => <button key={d.id} onClick={() => setSel(d.id)} className={cx('flex w-full justify-between rounded px-1.5 py-1 text-left', sel === d.id ? 'bg-accent/12' : 'hover:bg-elevated')}>
            <span>{d.label} <span className="text-text-2">{d.dir}</span></span><span className="font-mono text-[11px] text-text-2">{fmtT(d.confirmed_at)}</span></button>)}
        </section>
        <p className="p-3 text-[11px] text-text-2">Candles and detections appear only when they would have been known. Data: {r.provider.label}.</p>
      </aside>
    </div>
  )
}
