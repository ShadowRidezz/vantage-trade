import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { api } from './api'
import { CATS, type Cat, type Graph, useColors } from './brainShared'
import { useSettings } from './store'

type GN = { id: string; kind: 'ai' | 'hub' | 'node'; cat: Cat | 'ai'; label: string; nid?: number; x?: number; y?: number; fx?: number; fy?: number }
type GL = { source: string | GN; target: string | GN; member: boolean; rel?: string; cross?: boolean }
export type GraphHandle = { focus: (key: string) => void; fit: () => void; zoomBy: (f: number) => void }

// Category hubs sit on a ring around the AI node, in the same places as the reference design.
const RING: Record<Cat, number> = { strategy: -90, pattern: -28, skill: 28, research: 90, source: 152, condition: 208 }
const R_HUB = 250, R_CHILD = 118
const idOf = (x: string | GN) => (typeof x === 'string' ? x : x.id)
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number) {
  const words = text.split(/\s+/), lines: string[] = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (ctx.measureText(t).width <= maxW || !cur) cur = t
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…') }
  return lines
}

export const BrainGraph = forwardRef<GraphHandle, {
  data: Graph; filter: Cat | 'all'; selected: string | null; onSelect: (key: string | null) => void; search: string; showAll: boolean
  onZoom: (k: number) => void; width: number; height: number
}>(function BrainGraph({ data, filter, selected, onSelect, search, showAll, onZoom, width, height }, ref) {
  const fg = useRef<any>()
  const theme = useSettings((s) => s.theme)
  const C = useColors()
  const cache = useRef(new Map<string, GN>())
  const [hover, setHover] = useState<string | null>(null)
  const fitted = useRef(false)

  const gd = useMemo(() => {
    const keep = (c: Cat) => filter === 'all' || filter === c
    const get = (id: string, init: () => GN) => { const g = cache.current.get(id) ?? init(); cache.current.set(id, g); return g }
    const pos = (key: string, x: number, y: number, fixed: boolean) => {
      const s = data.layout[key]
      return s ? { x: s.x, y: s.y, fx: s.x, fy: s.y } : fixed ? { x, y, fx: x, fy: y } : { x, y }
    }
    const rad = (d: number) => (d * Math.PI) / 180
    const nodes: GN[] = [get('ai', () => ({ id: 'ai', kind: 'ai', cat: 'ai', label: 'AI', ...pos('ai', 0, 0, true) }))]
    const links: GL[] = []
    for (const [c, label] of CATS) {
      if (!keep(c)) continue
      const a = rad(RING[c])
      const hub = get('cat:' + c, () => ({ id: 'cat:' + c, kind: 'hub', cat: c, label, ...pos('cat:' + c, Math.cos(a) * R_HUB, Math.sin(a) * R_HUB, true) }))
      hub.label = label
      nodes.push(hub)
      links.push({ source: 'ai', target: hub.id, member: true })
      const kids = data.nodes.filter((n) => n.category === c)
      kids.forEach((n, i) => {
        const spread = Math.min(150, 26 * kids.length), ang = a + rad(-spread / 2 + (kids.length > 1 ? (spread * i) / (kids.length - 1) : 0))
        const r = R_HUB + R_CHILD + (i % 2) * 34
        const g = get('n:' + n.id, () => ({ id: 'n:' + n.id, kind: 'node', cat: c, label: n.title, nid: n.id, ...pos('n:' + n.id, Math.cos(ang) * r, Math.sin(ang) * r, false) }))
        g.label = n.title
        nodes.push(g)
        links.push({ source: hub.id, target: g.id, member: true })
      })
    }
    const ids = new Set(nodes.map((n) => n.id)), catOf = new Map(data.nodes.map((n) => [n.id, n.category]))
    for (const e of data.edges) {
      const s = 'n:' + e.src, t = 'n:' + e.dst
      if (ids.has(s) && ids.has(t)) links.push({ source: s, target: t, member: false, rel: e.rel, cross: catOf.get(e.src) !== catOf.get(e.dst) })
    }
    return { nodes, links }
  }, [data, filter])

  // Crowded graphs show cross-links only around the selection unless the user asks for all of them.
  const crowded = gd.links.filter((l) => !l.member).length > 260
  const focus = hover ?? selected
  const near = useMemo(() => {
    if (!focus) return null
    const s = new Set([focus])
    for (const l of gd.links) { const a = idOf(l.source), b = idOf(l.target); if (a === focus) s.add(b); if (b === focus) s.add(a) }
    return s
  }, [focus, gd])
  const q = search.trim().toLowerCase()
  const match = (n: GN) => q !== '' && n.label.toLowerCase().includes(q)

  useEffect(() => {
    const f = fg.current
    if (!f) return
    f.d3Force('center', null)
    f.d3Force('charge').strength((n: GN) => (n.kind === 'node' ? -90 : -400)).distanceMax(320)
    f.d3Force('link').distance((l: GL) => (l.member ? (idOf(l.source) === 'ai' ? R_HUB : R_CHILD) : 200)).strength((l: GL) => (l.member ? 0.5 : 0.02))
    f.d3ReheatSimulation()
  }, [gd])

  useImperativeHandle(ref, () => ({
    focus: (key) => {
      const n = gd.nodes.find((x) => x.id === key)
      if (n && n.x != null && fg.current) { fg.current.centerAt(n.x, n.y, 600); fg.current.zoom(Math.max(1.6, fg.current.zoom()), 600) }
    },
    fit: () => fg.current?.zoomToFit(500, 50),
    zoomBy: (f) => fg.current && fg.current.zoom(fg.current.zoom() * f, 250),
  }), [gd])

  const ink = theme === 'dark' ? '#F2F4F8' : '#111827', muted = theme === 'dark' ? '#9AA4B5' : '#64748B'
  const panel = theme === 'dark' ? '#0B0E16' : '#FFFFFF'

  const draw = (n: GN, ctx: CanvasRenderingContext2D, scale: number) => {
    const color = C[n.cat], dim = (near && !near.has(n.id)) || (q !== '' && !match(n) && n.kind === 'node')
    ctx.save()
    ctx.globalAlpha = dim ? 0.22 : 1
    const r = n.kind === 'ai' ? 52 : n.kind === 'hub' ? 33 : 17
    ctx.beginPath(); ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI)
    ctx.shadowColor = color; ctx.shadowBlur = (n.kind === 'ai' ? 60 : n.kind === 'hub' ? 30 : 12) * (theme === 'dark' ? 1 : 0.45)
    if (n.kind === 'ai') {
      const g = ctx.createRadialGradient(n.x!, n.y! - 10, 4, n.x!, n.y!, r)
      g.addColorStop(0, theme === 'dark' ? '#3B1670' : '#F3E8FF'); g.addColorStop(1, theme === 'dark' ? '#140A26' : '#FFFFFF')
      ctx.fillStyle = g
    } else ctx.fillStyle = panel
    ctx.fill()
    ctx.shadowBlur = 0
    if (n.kind !== 'ai') { ctx.fillStyle = color + (theme === 'dark' ? '26' : '1A'); ctx.fill() }
    ctx.lineWidth = n.id === selected ? 3.2 : n.kind === 'node' ? 1.4 : 2.4
    ctx.strokeStyle = n.id === selected || match(n) ? (theme === 'dark' ? '#FFFFFF' : '#111827') : color
    ctx.stroke()
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    if (n.kind === 'ai') {
      ctx.font = '700 30px Inter, sans-serif'; ctx.fillText('AI', n.x!, n.y! - 4)
      ctx.font = '600 6px Inter, sans-serif'; ctx.fillStyle = muted
      ctx.fillText('V A N T A G E   T R A D E', n.x!, n.y! + 20)
    } else {
      const fs = n.kind === 'hub' ? 8.5 : 4.6
      ctx.font = `${n.kind === 'hub' ? 700 : 600} ${fs}px Inter, sans-serif`
      const lines = wrap(ctx, n.label, r * 1.6, n.kind === 'hub' ? 2 : 3)
      lines.forEach((ln, i) => ctx.fillText(ln, n.x!, n.y! + (i - (lines.length - 1) / 2) * fs * 1.15))
    }
    ctx.restore()
    void scale
  }

  const drawLink = (l: GL, ctx: CanvasRenderingContext2D) => {
    const s = l.source as GN, t = l.target as GN
    if (s.x == null || t.x == null) return
    const hot = focus != null && (s.id === focus || t.id === focus)
    if (!l.member && crowded && !showAll && !hot) return
    const dx = t.x - s.x!, dy = t.y! - s.y!, cx = (s.x! + t.x) / 2 - dy * 0.14, cy = (s.y! + t.y!) / 2 + dx * 0.14
    ctx.save()
    ctx.globalAlpha = near && !hot ? 0.12 : 1
    const cs = C[s.cat], ct = C[t.cat]
    let stroke: string | CanvasGradient
    if (l.member) stroke = ct + (hot ? 'EE' : '88')
    else { const g = ctx.createLinearGradient(s.x!, s.y!, t.x, t.y!); g.addColorStop(0, cs + (hot ? 'EE' : '66')); g.addColorStop(1, ct + (hot ? 'EE' : '66')); stroke = g }
    ctx.strokeStyle = stroke; ctx.lineWidth = hot ? 1.6 : l.member ? 1 : 0.7
    if (theme === 'dark') { ctx.shadowColor = ct; ctx.shadowBlur = hot ? 10 : 4 }
    ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.quadraticCurveTo(cx, cy, t.x, t.y!); ctx.stroke()
    if (!l.member) { // small junction point on cross-category links
      ctx.shadowBlur = 0; ctx.fillStyle = theme === 'dark' ? '#E5E7EB' : '#64748B'
      const mx = 0.25 * s.x! + 0.5 * cx + 0.25 * t.x, my = 0.25 * s.y! + 0.5 * cy + 0.25 * t.y!
      ctx.beginPath(); ctx.arc(mx, my, hot ? 1.6 : 1.1, 0, 2 * Math.PI); ctx.fill()
    }
    ctx.restore()
  }

  const save = (n: GN) => {
    n.fx = n.x; n.fy = n.y
    void api('/api/brain/layout', [{ key: n.id, x: n.x, y: n.y }], 'PUT')
  }

  return <ForceGraph2D ref={fg} width={width} height={height} graphData={gd} backgroundColor="rgba(0,0,0,0)"
    nodeId="id" nodeRelSize={1} nodeVal={(n: any) => (n.kind === 'ai' ? 2700 : n.kind === 'hub' ? 1100 : 290)}
    nodeCanvasObject={draw as any} nodeCanvasObjectMode={() => 'replace'}
    nodePointerAreaPaint={(n: any, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, n.kind === 'ai' ? 52 : n.kind === 'hub' ? 33 : 17, 0, 2 * Math.PI); ctx.fill() }}
    nodeLabel={(n: any) => (n.kind === 'node' ? `<div style="font:12px Inter;padding:2px 4px">${esc(n.label)}</div>` : '')}
    linkCanvasObject={drawLink as any} linkCanvasObjectMode={() => 'replace'}
    onNodeClick={(n: any) => onSelect(n.id)} onBackgroundClick={() => onSelect(null)}
    onNodeHover={(n: any) => setHover(n?.id ?? null)} onNodeDragEnd={(n: any) => save(n)}
    onZoom={({ k }) => onZoom(k)} cooldownTicks={160} d3VelocityDecay={0.35}
    onEngineStop={() => { if (!fitted.current) { fitted.current = true; fg.current?.zoomToFit(400, 40) } }} />
})
