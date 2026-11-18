import { useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts'
import { Check, Circle, Loader2, X } from 'lucide-react'
import type { Analysis, Detection, Step } from './api'
import { fmtP, fmtT } from './api'
import { CATS, kindToCat } from './store'
import { useProjection } from './projection'
import { Badge, Conditions, cx, dirTone } from './ui'

// ---------------------------------------------------------------- live pipeline over WebSocket

export type VisionState = { phase: 'off' | 'connecting' | 'running' | 'waiting' | 'error'; steps: Step[]; result?: Analysis
  next?: number | null; checked?: number; error?: string; candle?: number }

export function useVision(symbol: string, tf: string, enabled: boolean): VisionState {
  const [st, setSt] = useState<VisionState>({ phase: 'off', steps: [] })
  useEffect(() => {
    if (!enabled) { setSt({ phase: 'off', steps: [] }); return }
    let ws: WebSocket | null = null, closed = false, retry = 0
    const connect = () => {
      setSt({ phase: 'connecting', steps: [] })
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/vision?symbol=${encodeURIComponent(symbol)}&tf=${tf}`)
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        setSt((s) => {
          if (m.type === 'start') return { ...s, phase: 'running', steps: [], candle: m.candle, error: undefined }
          if (m.type === 'step') return { ...s, steps: [...s.steps, m as Step] }
          if (m.type === 'result') return { ...s, result: m as Analysis }
          if (m.type === 'waiting') return { ...s, phase: 'waiting', next: m.next_close, checked: m.checked_at }
          if (m.type === 'error') return { ...s, phase: 'error', error: m.message }
          return s
        })
      }
      ws.onclose = () => {
        if (closed) return
        setSt((s) => ({ ...s, phase: 'error', error: 'Connection to the analysis server lost. Reconnecting…' }))
        retry = window.setTimeout(connect, 5000)
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retry); ws?.close() }
  }, [symbol, tf, enabled])
  return st
}

// ---------------------------------------------------------------- chart overlay

const ABBR: Record<string, string> = { fvg: 'FVG', order_block: 'OB', supply_demand: 'S/D', ote: 'OTE', liquidity: 'LIQ', premium_discount: 'P/D',
  bos: 'BOS', choch: 'CHoCH', mss: 'MSS', sr: 'S/R', sweep: 'Sweep', important: '', swing: '' }
const ZONES = new Set(['fvg', 'order_block', 'supply_demand', 'ote', 'liquidity'])
const colorOf = (d: Detection) => (d.dir === 'bull' ? 'var(--bull)' : d.dir === 'bear' ? 'var(--bear)' : 'var(--accent)')
export const endOf = (d: Detection) => d.filled_at ?? d.invalidated_at ?? d.swept_at ?? null

export function DetectionLayer({ chart, series, times, dets, selected, onSelect, layoutKey, now }: {
  chart: IChartApi; series: ISeriesApi<SeriesType>; times: number[]; dets: Detection[]; selected: string | null
  onSelect: (id: string) => void; layoutKey: string; now?: number
}) {
  const { w, h, xOf, yOf, barW } = useProjection(chart, series, times, layoutKey)
  const sel = dets.find((d) => d.id === selected)
  // During replay, outcomes after `now` are not known yet.
  const end = (d: Detection) => { const e = endOf(d); return e != null && (now == null || e <= now) ? e : null }
  const chip = (d: Detection, x: number, y: number, text: string) => (
    <g key={d.id + 'chip'} style={{ pointerEvents: 'all', cursor: 'pointer' }} onClick={() => onSelect(d.id)}>
      <rect x={x} y={y - 13} width={text.length * 6 + 8} height={13} rx={2} fill="var(--panel)" stroke={colorOf(d)} strokeWidth={d.id === selected ? 1.5 : 0.75} />
      <text x={x + 4} y={y - 3.5} fontSize={9.5} fontFamily="JetBrains Mono, monospace" fill={colorOf(d)}>{text}</text>
    </g>
  )
  return (
    <svg width={w} height={h} className="pointer-events-none absolute left-0 top-0 z-[4] overflow-hidden">
      {sel && sel.candles.map((t) => <rect key={t} x={xOf(t) - barW / 2} y={0} width={barW} height={h} fill="var(--accent)" opacity={0.13} />)}
      {dets.map((d) => {
        const x0 = xOf(d.t0), e = end(d), x1 = ZONES.has(d.kind) ? (e != null ? xOf(e) : w) : xOf(d.t1)
        if (Math.max(x0, x1) < -50 || Math.min(x0, x1) > w + 50) return null
        const c = colorOf(d), s = d.id === selected, yt = yOf(d.top), yb = yOf(d.bottom)
        if (ZONES.has(d.kind) && d.top !== d.bottom) return <g key={d.id}>
          <rect x={x0} y={Math.min(yt, yb)} width={Math.max(2, x1 - x0)} height={Math.max(1, Math.abs(yb - yt))} fill={c}
            fillOpacity={s ? 0.22 : d.kind === 'ote' ? 0.06 : 0.1} stroke={c} strokeOpacity={s ? 1 : 0.45} strokeWidth={1} strokeDasharray={d.kind === 'ote' ? '4 3' : undefined} />
          {chip(d, x0 + 1, Math.min(yt, yb), ABBR[d.kind])}
        </g>
        if (d.kind === 'premium_discount') { const ye = yOf(d.equilibrium ?? (d.top + d.bottom) / 2); return <g key={d.id}>
          <line x1={x0} x2={w} y1={ye} y2={ye} stroke="var(--accent)" strokeDasharray="6 4" strokeOpacity={s ? 1 : 0.6} />
          <line x1={x0} x2={w} y1={yt} y2={yt} stroke="var(--accent)" strokeOpacity={0.25} />
          <line x1={x0} x2={w} y1={yb} y2={yb} stroke="var(--accent)" strokeOpacity={0.25} />
          {chip(d, Math.max(4, w - 120), ye, 'EQ ' + fmtP(d.equilibrium))}
        </g> }
        if (d.kind === 'sr') return <g key={d.id}>
          <line x1={0} x2={w} y1={yt} y2={yt} stroke={c} strokeDasharray="2 3" strokeOpacity={s ? 1 : 0.55} strokeWidth={s ? 1.5 : 1} />
          {chip(d, Math.max(4, w - 70), yt, `${d.role === 'support' ? 'S' : 'R'} x${(d as any).touches}`)}
        </g>
        if (['bos', 'choch', 'mss'].includes(d.kind)) return <g key={d.id}>
          <line x1={x0} x2={x1} y1={yt} y2={yt} stroke={c} strokeWidth={s ? 2 : 1} strokeDasharray={d.kind === 'bos' ? undefined : '5 3'} />
          {chip(d, (x0 + x1) / 2 - 14, d.dir === 'bull' ? yt : yt + 15, ABBR[d.kind])}
        </g>
        if (d.kind === 'sweep') { const ye = yOf(d.extreme ?? d.top); return <g key={d.id}>
          <line x1={x0} x2={x1} y1={yOf(d.level ?? d.top)} y2={yOf(d.level ?? d.top)} stroke={c} strokeDasharray="1 3" />
          <path d={`M${x1 - 4},${ye - 4}L${x1 + 4},${ye + 4}M${x1 + 4},${ye - 4}L${x1 - 4},${ye + 4}`} stroke={c} strokeWidth={1.5} />
          {chip(d, x1 + 6, d.dir === 'bull' ? ye + 14 : ye, 'Sweep')}
        </g> }
        if (d.kind === 'liquidity') return <g key={d.id}>
          <line x1={x0} x2={x1} y1={yt} y2={yt} stroke="var(--info)" strokeWidth={s ? 2 : 1.25} />{chip(d, x0, yt, d.dir === 'bear' ? 'EQH' : 'EQL')}
        </g>
        if (d.kind === 'important') { const y = d.dir === 'bull' ? yOf(d.bottom) + 7 : yOf(d.top) - 7
          return <circle key={d.id} cx={xOf(d.t1)} cy={y} r={s ? 4 : 2.5} fill={c} style={{ pointerEvents: 'all', cursor: 'pointer' }} onClick={() => onSelect(d.id)} /> }
        if (d.kind === 'swing') { const y = yOf(d.top), up = d.side === 'low'
          return <path key={d.id} d={up ? `M${x0 - 4},${y + 9}L${x0 + 4},${y + 9}L${x0},${y + 3}Z` : `M${x0 - 4},${y - 9}L${x0 + 4},${y - 9}L${x0},${y - 3}Z`}
            fill={c} opacity={s ? 1 : 0.6} style={{ pointerEvents: 'all', cursor: 'pointer' }} onClick={() => onSelect(d.id)} /> }
        return null
      })}
    </svg>
  )
}

// ---------------------------------------------------------------- side panel

export function DetectionDetail({ d, now }: { d: Detection; now?: number }) {
  const known = (t?: number | null) => t != null && (now == null || t <= now)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2"><span className="font-semibold">{d.label}</span>{d.dir && <Badge tone={dirTone(d.dir)}>{d.dir === 'bull' ? 'Bullish' : 'Bearish'}</Badge>}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        <dt className="text-text-2">Detected</dt><dd className="font-mono">{fmtT(d.confirmed_at)}</dd>
        <dt className="text-text-2">Candles</dt><dd className="font-mono">{fmtT(d.t0)} → {fmtT(d.t1)}</dd>
        <dt className="text-text-2">Price</dt><dd className="font-mono">{d.top === d.bottom ? fmtP(d.top) : `${fmtP(d.bottom)} – ${fmtP(d.top)}`}</dd>
        {known(d.touched_at) && <><dt className="text-text-2">Retested</dt><dd className="font-mono">{fmtT(d.touched_at)}</dd></>}
        {known(d.filled_at) && <><dt className="text-text-2">Filled</dt><dd className="font-mono">{fmtT(d.filled_at)}</dd></>}
        {known(d.swept_at) && <><dt className="text-text-2">Swept</dt><dd className="font-mono">{fmtT(d.swept_at)}</dd></>}
        {known(d.invalidated_at) && <><dt className="text-text-2">Invalidated</dt><dd className="font-mono">{fmtT(d.invalidated_at)}</dd></>}
      </dl>
      <p className="text-[12px] leading-relaxed">{d.reason}</p>
      <div><div className="mb-1 text-[11px] font-medium text-text-2">Rule conditions</div><Conditions items={d.conditions} /></div>
    </div>
  )
}

export function VisionPanel({ symbol, tf, st, dets, selected, onSelect, cats, setCats, width, setWidth, onClose }: {
  symbol: string; tf: string; st: VisionState; dets: Detection[]; selected: string | null; onSelect: (id: string | null) => void
  cats: Record<string, boolean>; setCats: (c: Record<string, boolean>) => void; width: number; setWidth: (w: number) => void; onClose: () => void
}) {
  const sel = dets.find((d) => d.id === selected)
  const all = st.result?.detections ?? []
  const counts = Object.fromEntries(CATS.map(([k]) => [k, all.filter((d) => kindToCat[d.kind] === k).length]))
  const list = [...dets].sort((a, b) => b.confirmed_at - a.confirmed_at).slice(0, 150)
  const drag = useRef<number | null>(null)
  const sum = st.result?.summary
  const title = st.phase === 'error' ? 'AI VISION — ERROR' : st.phase === 'connecting' ? 'AI VISION — CONNECTING' : 'AI VISION — ACTIVE'
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div role="separator" aria-orientation="vertical" aria-label="Resize AI Vision panel" tabIndex={0}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/30"
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') setWidth(Math.min(640, width + 20)); if (e.key === 'ArrowRight') setWidth(Math.max(280, width - 20)) }}
        onPointerDown={(e) => {
          drag.current = e.clientX + width
          const mv = (ev: PointerEvent) => drag.current != null && setWidth(Math.min(640, Math.max(280, drag.current - ev.clientX)))
          const up = () => { drag.current = null; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
        }} />
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className={cx('text-[11px] font-semibold tracking-[0.08em]', st.phase === 'error' ? 'text-bear' : 'text-accent')}>{title}</span>
        <button onClick={onClose} aria-label="Close AI Vision" className="grid size-6 place-items-center rounded text-text-2 hover:bg-elevated hover:text-text"><X size={14} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-line px-3 py-2.5 font-mono text-[11.5px]">
          <div className="text-text-2">Market: <span className="text-text">{symbol}</span>  Timeframe: <span className="text-text">{tf}</span></div>
          {st.result && <div className="text-text-2">Data: {st.result.provider.label} · last closed {fmtT(st.result.last_closed)}</div>}
          <ul className="mt-2 flex flex-col gap-1">
            {st.steps.map((s) => <li key={s.name} className="flex items-start gap-2"><Check size={13} className="mt-px shrink-0 text-bull" />
              <span className="flex-1">{s.name}<span className="text-text-2"> · {s.detail}</span></span><span className="text-text-2">{s.ms}ms</span></li>)}
            {st.phase === 'running' && <li className="flex items-center gap-2 text-text-2"><Loader2 size={13} className="animate-spin" />Analysing…</li>}
            {st.phase === 'connecting' && <li className="flex items-center gap-2 text-text-2"><Loader2 size={13} className="animate-spin" />Connecting to analysis engine…</li>}
          </ul>
          {st.phase === 'waiting' && <p className="mt-2 text-text-2">Waiting for next candle{st.next ? ` (checked ${fmtT(st.checked)})` : ''}…</p>}
          {st.error && <p className="mt-2 text-bear">{st.error}</p>}
        </section>
        <section className="border-b border-line px-3 py-2.5">
          <div className="mb-1.5 text-[11px] font-medium text-text-2">Overlays</div>
          <div className="flex flex-wrap gap-1">
            {CATS.map(([k, label]) => <button key={k} aria-pressed={cats[k]} onClick={() => setCats({ ...cats, [k]: !cats[k] })}
              className={cx('h-6 rounded border px-1.5 text-[11px]', cats[k] ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-text-2 hover:text-text')}>
              {label} <span className="text-text-2">{counts[k] ?? 0}</span></button>)}
          </div>
        </section>
        {sel && <section className="border-b border-line bg-elevated/40 px-3 py-2.5"><DetectionDetail d={sel} /></section>}
        {sum && <section className="border-b border-line px-3 py-2.5 text-[12px]">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-text-2">Observed facts <Badge tone={dirTone(sum.bias)}>Bias: {sum.bias}</Badge></div>
          <ul className="flex flex-col gap-0.5">{sum.facts.map((f) => <li key={f} className="flex gap-1.5"><Circle size={4} className="mt-1.5 shrink-0 fill-current text-text-2" />{f}</li>)}</ul>
          {sum.invalidation && <p className="mt-1.5 text-text-2"><span className="text-text">Invalidation:</span> {sum.invalidation.text}</p>}
          {st.result!.strategies.map((s) => <div key={s.version_id} className="mt-2.5">
            <div className="mb-1 text-[11px] font-medium text-text-2">{s.strategy} v{s.version} — <span className="text-text">{s.status}</span></div>
            <Conditions items={s.conditions} />
          </div>)}
        </section>}
        <section className="px-1.5 py-1.5">
          <div className="px-1.5 pb-1 text-[11px] font-medium text-text-2">Detections ({dets.length}{dets.length > 150 ? ', newest 150' : ''})</div>
          {list.map((d) => <button key={d.id} onClick={() => onSelect(d.id === selected ? null : d.id)}
            className={cx('flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px]', d.id === selected ? 'bg-accent/12' : 'hover:bg-elevated')}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: colorOf(d) }} />
            <span className="flex-1 truncate">{d.label}</span>
            <span className="font-mono text-[11px] text-text-2">{fmtT(d.confirmed_at)}</span>
          </button>)}
          {!list.length && st.result && <p className="px-1.5 py-2 text-[12px] text-text-2">No detections in the enabled categories.</p>}
        </section>
      </div>
    </aside>
  )
}
