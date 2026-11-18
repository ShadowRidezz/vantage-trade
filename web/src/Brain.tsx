import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ForceGraph2D from 'react-force-graph-2d'
import ForceGraph3D from 'react-force-graph-3d'
import { Maximize, RefreshCw, Search } from 'lucide-react'
import { api, fmtT, fmtUsd } from './api'
import { useSettings } from './store'
import { Badge, Btn, Empty, ErrorText, cx, inputCls } from './ui'

type GNode = { id: string; type: string; label: string; data: any; x?: number; y?: number; z?: number }
type GLink = { source: string | GNode; target: string | GNode; rel: string }
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

const TYPES: [string, string, string][] = [
  ['strategy', 'Strategies', '--accent'], ['version', 'Strategy versions', '#C084FC'], ['pattern', 'Patterns', '--info'], ['trade', 'Simulated trades', '--cyan'],
  ['condition', 'Market conditions', '#94A3B8'], ['backtest', 'Backtest results', '--warn'], ['evaluation', 'Evaluations', '#F97316'],
  ['failed', 'Failed evaluations', '--bear'], ['lesson', 'Lessons learned', '--bull'],
]
const colorVar = Object.fromEntries(TYPES.map(([t, , c]) => [t, c]))
const idOf = (x: string | GNode) => (typeof x === 'string' ? x : x.id)

export function Brain() {
  const theme = useSettings((s) => s.theme)
  const q = useQuery({ queryKey: ['brain'], queryFn: () => api<{ nodes: GNode[]; links: GLink[] }>('/api/brain') })
  const [mode, setMode] = useState<'3d' | '2d'>('3d')
  const [hidden, setHidden] = useState<Record<string, boolean>>({}), [search, setSearch] = useState('')
  const [sel, setSel] = useState<string | null>(null), [hover, setHover] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null), fg = useRef<any>()
  const [size, setSize] = useState({ w: 800, h: 600 })
  useEffect(() => { const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height })); ro.observe(box.current!); return () => ro.disconnect() }, [])
  const colors = useMemo(() => Object.fromEntries(TYPES.map(([t, , c]) => [t, c.startsWith('--') ? css(c) : c])), [theme]) // eslint-disable-line

  const graph = useMemo(() => {
    if (!q.data) return { nodes: [] as GNode[], links: [] as GLink[] }
    const nodes = q.data.nodes.filter((n) => !hidden[n.type]).map((n) => ({ ...n }))
    const ids = new Set(nodes.map((n) => n.id))
    return { nodes, links: q.data.links.filter((l) => ids.has(idOf(l.source)) && ids.has(idOf(l.target))).map((l) => ({ ...l })) }
  }, [q.data, hidden])
  const adj = useMemo(() => {
    const m = new Map<string, { id: string; rel: string; out: boolean }[]>()
    for (const l of q.data?.links ?? []) {
      const s = idOf(l.source), t = idOf(l.target)
      m.set(s, [...(m.get(s) ?? []), { id: t, rel: l.rel, out: true }]); m.set(t, [...(m.get(t) ?? []), { id: s, rel: l.rel, out: false }])
    }
    return m
  }, [q.data])
  const byId = useMemo(() => new Map((q.data?.nodes ?? []).map((n) => [n.id, n])), [q.data])
  const focusId = hover ?? sel
  const near = useMemo(() => new Set(focusId ? [focusId, ...(adj.get(focusId) ?? []).map((x) => x.id)] : []), [focusId, adj])
  const matches = useMemo(() => search.trim() ? new Set((q.data?.nodes ?? []).filter((n) => (n.label + ' ' + JSON.stringify(n.data)).toLowerCase().includes(search.toLowerCase())).map((n) => n.id)) : null, [search, q.data])

  const fly = (id: string) => {
    setSel(id)
    const n = graph.nodes.find((x) => x.id === id) as GNode | undefined
    if (!n || n.x == null || !fg.current) return
    if (mode === '3d') { const d = 160, r = 1 + d / Math.hypot(n.x, n.y ?? 0, n.z ?? 0); fg.current.cameraPosition({ x: n.x * r, y: (n.y ?? 0) * r, z: (n.z ?? 0) * r }, n, 800) }
    else { fg.current.centerAt(n.x, n.y, 600); fg.current.zoom(3, 600) }
  }
  const nodeColor = (n: GNode) => {
    const c = colors[n.type] ?? '#888'
    if (matches) return matches.has(n.id) ? c : css('--border')
    return !focusId || near.has(n.id) ? c : css('--border')
  }
  const linkColor = (l: GLink) => (focusId && (idOf(l.source) === focusId || idOf(l.target) === focusId) ? css('--accent') : css('--text-2') + (theme === 'dark' ? '40' : '55'))
  const counts = Object.fromEntries(TYPES.map(([t]) => [t, q.data?.nodes.filter((n) => n.type === t).length ?? 0]))
  const selN = sel ? byId.get(sel) : undefined
  const common = {
    width: size.w, height: size.h, graphData: graph, nodeId: 'id', nodeLabel: (n: any) => `${n.label} (${n.type})`,
    nodeVal: (n: any) => (n.type === 'strategy' ? 8 : n.type === 'version' ? 4 : n.type === 'lesson' || n.type === 'failed' || n.type === 'evaluation' ? 3 : 1.5),
    nodeColor, linkColor, onNodeClick: (n: any) => fly(n.id), onNodeHover: (n: any) => setHover(n?.id ?? null), onBackgroundClick: () => setSel(null),
    backgroundColor: css('--bg'), cooldownTicks: 120,
  }
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <form onSubmit={(e) => { e.preventDefault(); const first = matches && [...matches][0]; if (first) fly(first) }} className="flex h-7 items-center gap-1.5 rounded border border-line bg-panel px-2">
            <Search size={13} className="text-text-2" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search memories" aria-label="Search memories" className="w-40 bg-transparent text-[12px] outline-none" />
            {matches && <span className="text-[11px] text-text-2">{matches.size}</span>}
          </form>
          <div className="flex rounded border border-line bg-panel p-0.5">{(['3d', '2d'] as const).map((m) => <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
            className={cx('h-6 rounded px-2 text-[11px] uppercase', mode === m ? 'bg-elevated font-medium' : 'text-text-2')}>{m}</button>)}</div>
          <Btn onClick={() => { setSel(null); setSearch(''); fg.current?.zoomToFit(600, 40) }}><Maximize size={12} />Reset view</Btn>
          <Btn kind="ghost" onClick={() => q.refetch()}><RefreshCw size={12} className={q.isFetching ? 'animate-spin' : ''} />Refresh</Btn>
        </div>
        <div className="absolute bottom-3 left-3 z-10 flex max-w-[70%] flex-wrap gap-1">
          {TYPES.map(([t, label]) => <button key={t} onClick={() => setHidden({ ...hidden, [t]: !hidden[t] })} aria-pressed={!hidden[t]}
            className={cx('flex h-6 items-center gap-1.5 rounded border border-line bg-panel px-2 text-[11px]', hidden[t] && 'opacity-45')}>
            <span className="size-2 rounded-full" style={{ background: colors[t] }} />{label} <span className="text-text-2">{counts[t]}</span></button>)}
        </div>
        <div ref={box} className="absolute inset-0">
          <ErrorText error={q.error} />
          {q.data && !q.data.nodes.length && <Empty>No memories yet.</Empty>}
          {q.data && q.data.nodes.length > 0 && (mode === '3d'
            ? <ForceGraph3D ref={fg} {...common} nodeOpacity={0.95} nodeResolution={12} linkOpacity={0.5} linkWidth={(l: any) => (focusId && (idOf(l.source) === focusId || idOf(l.target) === focusId) ? 0.5 : 0)} />
            : <ForceGraph2D ref={fg} {...common} linkWidth={(l: any) => (focusId && (idOf(l.source) === focusId || idOf(l.target) === focusId) ? 1.5 : 0.6)}
                nodeCanvasObjectMode={() => 'after'} nodeCanvasObject={(n: any, ctx, scale) => {
                  if (scale < 2.2 && !near.has(n.id)) return
                  ctx.font = `${10 / scale}px Inter`; ctx.fillStyle = css('--text-2'); ctx.textAlign = 'center'; ctx.fillText(n.label, n.x, n.y + 8 / scale + 4)
                }} />)}
        </div>
      </div>
      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-[12px]">
        {!selN ? <div className="p-3 text-text-2">
          <p className="mb-2 font-medium text-text">AI Brain</p>
          <p>Every node is a stored record: strategies and their versions, simulated trades, the patterns those trades were based on, the market conditions at entry, backtests, hypothesis evaluations and the lessons drawn from them. Links are the real references between those records.</p>
          <p className="mt-2">Nothing here is generated for display. Run a backtest, record a paper trade, review it, or evaluate a hypothesis to add memories.</p>
        </div> : <NodeDetail n={selN} links={adj.get(selN.id) ?? []} byId={byId} color={colors[selN.type]} onGo={fly} />}
      </aside>
    </div>
  )
}

function NodeDetail({ n, links, byId, color, onGo }: { n: GNode; links: { id: string; rel: string; out: boolean }[]; byId: Map<string, GNode>; color: string; onGo: (id: string) => void }) {
  const d = n.data ?? {}
  const rows: [string, any][] = []
  const add = (k: string, v: any) => v != null && v !== '' && rows.push([k, v])
  if (n.type === 'strategy') add('Description', d.description)
  if (n.type === 'version') { add('Status', d.status); add('Note', d.note); add('Parameters', Object.entries(d.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')); add('Created', fmtT(d.created_at)) }
  if (n.type === 'trade') { add('Market', `${d.symbol} ${d.tf}`); add('Contract', d.contract); add('Direction', d.direction); add('Entry', d.entry_price); add('Exit', d.exit_price ?? 'open'); add('P&L (simulated)', fmtUsd(d.pnl)); add('Opened', fmtT(d.entry_time)) }
  if (n.type === 'pattern') { add('Detected', fmtT(d.confirmed_at)); add('Price', d.top === d.bottom ? d.top : `${d.bottom} – ${d.top}`); add('Why', d.reason) }
  if (n.type === 'condition') { add('Market', `${d.symbol} ${d.tf}`); add('Structure bias', d.bias); add('Range zone', d.zone) }
  if (n.type === 'backtest') { const m = d.metrics ?? {}; add('Market', `${d.symbol} ${d.tf}`); add('Segment', d.segment); add('Trades', m.trades); add('Win rate', m.win_rate != null ? `${m.win_rate}%` : null)
    add('Profit factor', m.profit_factor); add('Net P&L (simulated)', fmtUsd(m.net_pnl)); add('Period', `${fmtT(m.start_time)} → ${fmtT(m.end_time)}`) }
  if (n.type === 'evaluation' || n.type === 'failed') { add('Status', d.status); add('Change', JSON.stringify(d.change)); add('Market', `${d.symbol} ${d.tf}`); add('Evidence', d.rationale)
    d.verdict?.reasons?.forEach((r: string, i: number) => add(i ? '' : 'Verdict', r)) }
  if (n.type === 'lesson') { add('Source', d.source); add('Finding', d.text); add('Recorded', fmtT(d.created_at)) }
  return (
    <div className="flex flex-col gap-3 p-3">
      <div><Badge><span className="mr-1 size-2 rounded-full" style={{ background: color }} />{n.type}</Badge><p className="mt-1.5 text-[13px] font-semibold">{n.label}</p></div>
      <dl className="flex flex-col gap-1.5">{rows.map(([k, v], i) => <div key={i}>{k && <dt className="text-[11px] text-text-2">{k}</dt>}<dd className="break-words">{String(v)}</dd></div>)}</dl>
      <div><div className="mb-1 text-[11px] font-medium text-text-2">Connected memories ({links.length})</div>
        {links.map((l, i) => { const o = byId.get(l.id); return o && <button key={i} onClick={() => onGo(o.id)} className="flex w-full flex-col rounded px-1.5 py-1 text-left hover:bg-elevated">
          <span>{o.label}</span><span className="text-[11px] text-text-2">{l.out ? l.rel : `← ${l.rel}`} · {o.type}</span></button> })}</div>
    </div>
  )
}
