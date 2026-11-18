import { useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { AlignVerticalSpaceAround, Minus, MousePointer2, MoveUpRight, SeparatorVertical, Slash, Square, Trash2, Type } from 'lucide-react'
import { useDrawings, type Drawing, type DrawingType, type Pt } from './store'
import { logicalToTime, timeToLogical } from './timeIndex'
import { useProjection } from './projection'

export type Tool = 'cursor' | DrawingType
const TOOLS: [Tool, string, typeof Minus][] = [
  ['cursor', 'Cursor (Esc)', MousePointer2], ['hline', 'Horizontal line', Minus], ['vline', 'Vertical line', SeparatorVertical],
  ['trend', 'Trend line', Slash], ['ray', 'Ray', MoveUpRight], ['rect', 'Rectangle', Square], ['text', 'Text', Type],
  ['fib', 'Fibonacci retracement', AlignVerticalSpaceAround],
]
const ONE_POINT = new Set<Tool>(['hline', 'vline', 'text'])
const COLORS = ['#3B82F6', '#8B5CF6', '#F59E0B', '#22C55E', '#EF4444', '#94A3B8']
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const EMPTY: Drawing[] = []

export function DrawingToolbar({ tool, setTool, symbol }: { tool: Tool; setTool: (t: Tool) => void; symbol: string }) {
  const { clear, bySymbol } = useDrawings()
  const n = bySymbol[symbol]?.length ?? 0
  return (
    <div role="toolbar" aria-label="Drawing tools" aria-orientation="vertical" className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-panel py-1.5">
      {TOOLS.map(([id, label, Icon]) => (
        <button key={id} onClick={() => setTool(id)} title={label} aria-label={label} aria-pressed={tool === id}
          className={`grid size-8 place-items-center rounded transition-colors duration-100 ${tool === id ? 'bg-accent/15 text-accent' : 'text-text-2 hover:bg-elevated hover:text-text'}`}>
          <Icon size={16} strokeWidth={1.75} />
        </button>
      ))}
      <div className="my-1 h-px w-5 bg-line" />
      <button disabled={!n} onClick={() => confirm(`Delete all ${n} drawing${n === 1 ? '' : 's'} on ${symbol}?`) && clear(symbol)}
        title="Delete all drawings" aria-label="Delete all drawings" className="grid size-8 place-items-center rounded text-text-2 hover:bg-elevated hover:text-bear disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2">
        <Trash2 size={16} strokeWidth={1.75} />
      </button>
    </div>
  )
}

type Props = { chart: IChartApi; series: ISeriesApi<'Candlestick'>; times: number[]; symbol: string; tool: Tool; setTool: (t: Tool) => void; layoutKey: string }
type Draft = { a: Pt; b: Pt; x: number; y: number }
type Drag = { id: string; handle: number; start: Pt & { l: number }; orig: Pt[] }

export function DrawingLayer({ chart, series, times, symbol, tool, setTool, layoutKey }: Props) {
  const drawings = useDrawings((s) => s.bySymbol[symbol] ?? EMPTY)
  const { put, remove } = useDrawings()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraftState] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null) // events can arrive faster than React re-renders
  const setDraft = (d: Draft | null) => { draftRef.current = d; setDraftState(d) }
  const [editing, setEditing] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const { ts, w, h, xOf, yOf } = useProjection(chart, series, times, layoutKey)
  useEffect(() => {
    const click = () => setSelected(null)
    chart.subscribeClick(click)
    return () => chart.unsubscribeClick(click)
  }, [chart])
  useEffect(() => { setSelected(null); setDraft(null); setEditing(null) }, [symbol])
  useEffect(() => { setDraft(null) }, [tool])

  const X = (pt: Pt) => xOf(pt.t)
  const Y = (pt: Pt) => yOf(pt.p)
  const fmt = (p: number) => series.priceFormatter().format(p)
  const at = (e: { clientX: number; clientY: number }): (Pt & { l: number }) | null => {
    const r = svg.current!.getBoundingClientRect(), l = ts.coordinateToLogical(e.clientX - r.left), p = series.coordinateToPrice(e.clientY - r.top)
    return l === null || p === null || times.length < 2 ? null : { t: logicalToTime(l, times), p, l }
  }

  const create = (type: DrawingType, pts: Pt[]) => {
    const d: Drawing = { id: crypto.randomUUID(), type, pts: pts.map(({ t, p }) => ({ t, p })), color: COLORS[0], ...(type === 'text' ? { text: 'Note' } : {}) }
    put(symbol, d); setSelected(d.id); setTool('cursor'); if (type === 'text') setEditing(d.id)
  }

  // Delete / Escape
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      if (e.key === 'Escape') { setDraft(null); setTool('cursor'); setSelected(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { remove(symbol, selected); setSelected(null) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [selected, symbol, remove, setTool])

  // Moving a whole drawing or one of its points.
  const startDrag = (e: React.PointerEvent, d: Drawing, handle: number) => {
    if (tool !== 'cursor') return
    e.stopPropagation(); setSelected(d.id)
    const start = at(e); if (!start) return
    drag.current = { id: d.id, handle, start, orig: d.pts }
    const move = (ev: PointerEvent) => {
      const g = drag.current, cur = at(ev); if (!g || !cur) return
      const d0 = useDrawings.getState().bySymbol[symbol]?.find((x) => x.id === g.id); if (!d0) return
      const pts = g.handle >= 0 ? g.orig.map((p, i) => (i === g.handle ? { t: cur.t, p: cur.p } : p))
        : g.orig.map((p) => ({ t: logicalToTime(timeToLogical(p.t, times) + cur.l - g.start.l, times), p: p.p + cur.p - g.start.p }))
      put(symbol, { ...d0, pts })
    }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const onDown = (e: React.PointerEvent) => {
    const pt = at(e), draft = draftRef.current; if (!pt || tool === 'cursor') return
    e.preventDefault() // keep focus on the text editor we may open
    if (ONE_POINT.has(tool)) return create(tool as DrawingType, [pt])
    if (!draft) { setDraft({ a: pt, b: pt, x: e.clientX, y: e.clientY }); svg.current!.setPointerCapture(e.pointerId) }
    else { create(tool as DrawingType, [draft.a, pt]); setDraft(null) }
  }
  const onMove = (e: React.PointerEvent) => { const draft = draftRef.current; if (draft) { const pt = at(e); if (pt) setDraft({ ...draft, b: pt }) } }
  const onUp = (e: React.PointerEvent) => { // click-drag finishes on release; click-click finishes on the second click
    const draft = draftRef.current
    if (draft && Math.hypot(e.clientX - draft.x, e.clientY - draft.y) > 5) { const pt = at(e); if (pt) create(tool as DrawingType, [draft.a, pt]); setDraft(null) }
  }

  const render = (d: Drawing, preview = false) => {
    const sel = !preview && selected === d.id, sw = sel ? 2 : 1.5
    const hit = { stroke: 'transparent', strokeWidth: 10, style: { pointerEvents: preview ? 'none' : 'stroke', cursor: tool === 'cursor' ? 'move' : undefined } as React.CSSProperties,
      onPointerDown: (e: React.PointerEvent) => startDrag(e, d, -1) }
    const seg = (x1: number, y1: number, x2: number, y2: number, k?: string | number, dash?: string) => <g key={k}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={d.color} strokeWidth={sw} strokeDasharray={dash} />
      <line x1={x1} y1={y1} x2={x2} y2={y2} {...hit} />
    </g>
    const [a, b] = d.pts, xa = X(a), ya = Y(a), xb = b ? X(b) : 0, yb = b ? Y(b) : 0
    const label = (x: number, y: number, s: string, anchor: 'start' | 'end' = 'end') =>
      <text x={x} y={y - 4} textAnchor={anchor} fill={d.color} fontSize={10} fontFamily="JetBrains Mono, monospace" style={{ pointerEvents: 'none' }}>{s}</text>
    let body: React.ReactNode
    switch (d.type) {
      case 'hline': body = <>{seg(0, ya, w, ya)}{label(w - 4, ya, fmt(a.p))}</>; break
      case 'vline': body = seg(xa, 0, xa, h); break
      case 'trend': body = seg(xa, ya, xb, yb); break
      case 'ray': { const len = Math.hypot(xb - xa, yb - ya) || 1, k = (2 * (w + h)) / len; body = seg(xa, ya, xa + (xb - xa) * k, ya + (yb - ya) * k); break }
      case 'rect': body = <rect x={Math.min(xa, xb)} y={Math.min(ya, yb)} width={Math.abs(xb - xa)} height={Math.abs(yb - ya)} fill={d.color + '22'}
        stroke={d.color} strokeWidth={sw} style={{ pointerEvents: preview ? 'none' : 'visiblePainted', cursor: tool === 'cursor' ? 'move' : undefined }} onPointerDown={(e) => startDrag(e, d, -1)} />; break
      case 'fib': { const x1 = Math.min(xa, xb), x2 = Math.max(xa, xb)
        // Level 0 at the end point, 1 at the start point (TradingView convention).
        body = FIB.map((lv) => { const p = b.p + (a.p - b.p) * lv, y = series.priceToCoordinate(p) ?? -1e4
          return <g key={lv}>{seg(x1, y, x2, y, lv)}{label(x1 + 2, y, `${lv} (${fmt(p)})`, 'start')}</g> })
        body = <>{body}{seg(xa, ya, xb, yb, 'diag', '3 3')}</>; break }
      case 'text': body = <text x={xa} y={ya} fill={d.color} fontSize={13} fontWeight={sel ? 600 : 500} dominantBaseline="middle"
        style={{ pointerEvents: preview ? 'none' : 'all', cursor: 'move', userSelect: 'none' }}
        onPointerDown={(e) => startDrag(e, d, -1)} onDoubleClick={() => setEditing(d.id)}>{d.text}</text>; break
    }
    const handles = sel && !ONE_POINT.has(d.type) ? d.pts.map((p, i) => <circle key={i} cx={X(p)} cy={Y(p)} r={4} fill="var(--panel)" stroke={d.color} strokeWidth={1.5}
      style={{ pointerEvents: 'all', cursor: 'grab' }} onPointerDown={(e) => startDrag(e, d, i)} />) : null
    return <g key={d.id} opacity={preview ? 0.7 : 1}>{body}{handles}</g>
  }

  const sel = drawings.find((d) => d.id === selected), ed = drawings.find((d) => d.id === editing)
  return <>
    <svg ref={svg} width={w} height={h} className="absolute left-0 top-0 z-[5] overflow-hidden"
      style={{ pointerEvents: tool === 'cursor' ? 'none' : 'auto', cursor: tool === 'cursor' ? undefined : 'crosshair' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {drawings.map((d) => render(d))}
      {draft && render({ id: 'draft', type: tool as DrawingType, pts: [draft.a, draft.b], color: COLORS[0] }, true)}
    </svg>
    {sel && tool === 'cursor' && <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-line bg-panel p-1 shadow-md shadow-black/20">
      {COLORS.map((c) => <button key={c} onClick={() => put(symbol, { ...sel, color: c })} aria-label={`Color ${c}`} title="Color"
        className={`size-5 rounded-sm border ${sel.color === c ? 'border-text' : 'border-transparent'}`} style={{ background: c }} />)}
      {sel.type === 'text' && <button onClick={() => setEditing(sel.id)} className="ml-1 rounded px-1.5 py-0.5 text-[12px] text-text-2 hover:bg-elevated hover:text-text">Edit</button>}
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button onClick={() => { remove(symbol, sel.id); setSelected(null) }} title="Delete (Del)" aria-label="Delete drawing"
        className="grid size-6 place-items-center rounded text-text-2 hover:bg-elevated hover:text-bear"><Trash2 size={14} /></button>
    </div>}
    {ed && <input autoFocus defaultValue={ed.text} maxLength={200} aria-label="Edit text"
      className="absolute z-20 rounded border border-accent bg-panel px-1.5 py-0.5 text-[13px] outline-none"
      style={{ left: X(ed.pts[0]) - 6, top: Y(ed.pts[0]) - 13 }}
      onBlur={(e) => { const t = e.target.value.trim(); if (t) put(symbol, { ...ed, text: t }); else remove(symbol, ed.id); setEditing(null) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} />}
  </>
}
