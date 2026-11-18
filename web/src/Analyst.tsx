import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CandlestickSeries, createChart, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { Pause, Play } from 'lucide-react'
import { api, fmtP, fmtT, fmtUsd } from './api'
import type { Bar } from './indicators'
import { useProjection } from './projection'
import { useSettings } from './store'
import { Badge, ErrorText, cx } from './ui'

type AiTrade = { id: number; direction: 'long' | 'short'; qty: number; entry_time: number; entry_price: number; stop: number; target: number
  exit_time: number | null; exit_price: number | null; exit_reason: string | null; status: 'open' | 'closed'; pnl: number | null; strategy: string
  now_r?: number; unrealized?: number }
type View = {
  config: { symbol: string; tf: string; enabled: boolean; started_at: number }; provider: { label: string }
  spec: { tick_size: number; tick_value: number; name: string }; bars: Bar[]; last_closed: number | null; price: number; market_quiet: boolean
  trades: AiTrade[]; pending: { dir: string; entry: number; stop: number; target: number; strategy: string }[]
  stats: { trades: number; wins: number; losses: number; win_rate: number | null; net_pnl: number; profit_factor: number | 'inf' | null
    avg_r: number | null; max_drawdown: number; streak: { kind: string; count: number } | null; today: number }
  status: { running: boolean; last_run: number | null; last_error: string | null; interval: number }
}

const MARKETS = ['MNQ', 'MES', 'NQ', 'ES']
const TFS = ['1m', '5m', '15m', '1H']
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
const rOf = (t: AiTrade) => { const risk = Math.abs(t.entry_price - t.stop) || 1; return ((t.exit_price ?? t.entry_price) - t.entry_price) * (t.direction === 'long' ? 1 : -1) / risk }
const signed = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`

export function Analyst() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['ai-trader'], queryFn: () => api<View>('/api/ai-trader'), refetchInterval: 10_000 })
  const set = useMutation({ mutationFn: (b: { symbol?: string; tf?: string; enabled?: boolean }) => api('/api/ai-trader', b, 'PUT'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-trader'] }); setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-trader'] }), 4000) } })
  const v = q.data, c = v?.config
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto"><h1 className="text-[20px] font-bold leading-tight">AI Analyst</h1>
          <p className="text-[12px] text-text-2">The AI paper-trades live on delayed data. Every trade is simulated.</p></div>
        {c && <>
          <button onClick={() => set.mutate({ enabled: !c.enabled })} title={c.enabled ? 'Pause the AI' : 'Resume: the AI trades forward from now'}
            className={cx('flex h-8 items-center gap-2 rounded-full px-3 text-[12px] font-semibold', c.enabled ? 'bg-bull/15 text-bull' : 'bg-elevated text-text-2')}>
            {c.enabled ? <><span className="size-2 animate-pulse rounded-full bg-bull" />LIVE<Pause size={13} /></> : <><Play size={13} />PAUSED</>}</button>
          <div className="flex rounded-lg border border-line bg-panel p-0.5">{MARKETS.map((m) => <button key={m} onClick={() => set.mutate({ symbol: m })}
            className={cx('h-7 rounded-md px-2.5 text-[12px]', c.symbol === m ? 'bg-elevated font-semibold' : 'text-text-2 hover:text-text')}>{m}</button>)}</div>
          <div className="flex rounded-lg border border-line bg-panel p-0.5">{TFS.map((t) => <button key={t} onClick={() => set.mutate({ tf: t })}
            className={cx('h-7 rounded-md px-2.5 font-mono text-[12px]', c.tf === t ? 'bg-elevated font-semibold text-accent' : 'text-text-2 hover:text-text')}>{t}</button>)}</div>
        </>}
      </header>
      <ErrorText error={q.error || set.error} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_370px]">
        <LiveChart v={v} />
        <Tracker v={v} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- chart with TradingView-style position boxes

function LiveChart({ v }: { v?: View }) {
  const theme = useSettings((s) => s.theme)
  const box = useRef<HTMLDivElement>(null), chart = useRef<IChartApi>(), candles = useRef<ISeriesApi<'Candlestick'>>(), vol = useRef<ISeriesApi<'Histogram'>>()
  const [ready, setReady] = useState(false), [hover, setHover] = useState<number | null>(null)
  const market = v ? `${v.config.symbol}|${v.config.tf}` : ''
  const fitted = useRef('')
  useEffect(() => {
    const c = createChart(box.current!, { autoSize: true, timeScale: { timeVisible: true, rightOffset: 18 } })
    candles.current = c.addSeries(CandlestickSeries, { borderVisible: false, priceLineVisible: false })
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    c.subscribeCrosshairMove((p) => setHover(typeof p.time === 'number' ? p.time : null))
    chart.current = c; setReady(true)
    return () => c.remove()
  }, [])
  useEffect(() => { // same look as the Charts tab
    const [bg, text, line, bull, bear] = ['--panel', '--text-2', '--border', '--bull', '--bear'].map(css)
    chart.current!.applyOptions({ layout: { background: { color: bg }, textColor: text, fontFamily: 'Inter' },
      grid: { vertLines: { color: line + '66' }, horzLines: { color: line + '66' } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line } })
    candles.current!.applyOptions({ upColor: bull, downColor: bear, wickUpColor: bull, wickDownColor: bear })
  }, [theme])
  useEffect(() => {
    if (!v) return
    const [bull, bear] = ['--bull', '--bear'].map(css)
    candles.current!.setData(v.bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })))
    candles.current!.applyOptions({ priceFormat: { type: 'price', minMove: v.spec.tick_size, precision: 2 } })
    vol.current!.setData(v.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: (b.close >= b.open ? bull : bear) + '55' })))
    if (fitted.current !== market) { // open on the last ~120 candles like TradingView; keep your zoom between live updates
      fitted.current = market
      const n = v.bars.length
      chart.current!.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 12 })
    }
  }, [v, theme, market])
  const bars = v?.bars ?? []
  const bar = (hover != null ? bars.find((b) => b.time === hover) : undefined) ?? bars.at(-1)
  return (
    <section className="flex min-h-[460px] flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-line px-3 text-[12px]">
        <span className="text-[15px] font-semibold">{v?.config.symbol} <span className="font-mono">{v?.config.tf}</span></span>
        {bar && <span className="font-mono text-text-2">O {fmtP(bar.open)} H {fmtP(bar.high)} L {fmtP(bar.low)} C {fmtP(bar.close)}</span>}
        <span className="ml-auto truncate text-text-2">{v?.spec.name} · {v?.provider.label}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" />
        {ready && v && <Positions chart={chart.current!} series={candles.current!} v={v} />}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-text-2">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-bull/60" />Profit zone (entry → target)</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-bear/60" />Risk zone (entry → stop)</span>
        <span>Bright = open trade · faded = closed</span>
      </div>
    </section>
  )
}

function Positions({ chart, series, v }: { chart: IChartApi; series: ISeriesApi<'Candlestick'>; v: View }) {
  const times = useMemo(() => v.bars.map((b) => b.time), [v.bars])
  const { w, h, xOf, yOf, barW } = useProjection(chart, series, times, String(v.bars.length))
  const usd = (pts: number, qty: number) => (pts / v.spec.tick_size) * v.spec.tick_value * qty
  const first = times[0] ?? 0
  const width = (text: string) => text.length * 6.6 + 14
  const label = (x: number, y: number, text: string, color: string, key: string, solid = false) => <g key={key}>
    <rect x={x} y={y - 11} width={width(text)} height={22} rx={5} fill={solid ? color : 'var(--panel)'} stroke={color} strokeWidth={1} />
    <text x={x + 7} y={y + 4} fontSize={12} fontWeight={600} fill={solid ? '#fff' : color} fontFamily="Inter, sans-serif">{text}</text></g>
  // closed-trade badges skip spots another badge already took; every result is still listed in the tracker
  const taken: [number, number, number, number][] = []
  const free = (x: number, y: number, wd: number) => {
    if (taken.some(([a, b, c, d]) => x < c && x + wd > a && y - 11 < d && y + 11 > b)) return false
    taken.push([x, y - 11, x + wd, y + 11]); return true
  }
  const visible = v.trades.filter((t) => (t.exit_time ?? Infinity) >= first)
  return (
    <svg width={w} height={h} className="pointer-events-none absolute left-0 top-0 z-[5] overflow-hidden">
      {[...visible].sort((a, b) => Number(a.status === 'open') - Number(b.status === 'open') || (b.exit_time ?? 0) - (a.exit_time ?? 0)).map((t) => {
        const open = t.status === 'open', long = t.direction === 'long'
        const x0 = Math.max(0, xOf(t.entry_time)), x1 = open ? w - 4 : xOf(t.exit_time!) + barW
        if (x1 < 0 || x0 > w) return null
        const ye = yOf(t.entry_price), yt = yOf(t.target), ys = yOf(t.stop)
        const a = open ? 0.3 : 0.15
        const risk = Math.abs(t.entry_price - t.stop), rr = Math.abs(t.target - t.entry_price) / (risk || 1)
        const won = (t.pnl ?? 0) > 0, up = (t.now_r ?? 0) >= 0
        const tTxt = `Target ${fmtP(t.target)}  +${fmtUsd(usd(Math.abs(t.target - t.entry_price), t.qty))}  (+${rr.toFixed(1)}R)`
        const eTxt = `Entry ${fmtP(t.entry_price)}  ${long ? 'LONG' : 'SHORT'} ${t.qty}`
        const sTxt = `Stop ${fmtP(t.stop)}  -${fmtUsd(usd(risk, t.qty))}  (-1R)`
        const right = (txt: string) => Math.max(4, w - width(txt) - 8)  // open-trade labels sit at the right edge, always fully visible
        const badge = `${won ? 'WIN' : 'LOSS'} ${signed(rOf(t))}R`, by = yOf(t.exit_price!)
        return <g key={t.id}>
          <rect x={x0} y={Math.min(ye, yt)} width={Math.max(2, x1 - x0)} height={Math.abs(yt - ye)} fill="var(--bull)" fillOpacity={a} />
          <rect x={x0} y={Math.min(ye, ys)} width={Math.max(2, x1 - x0)} height={Math.abs(ys - ye)} fill="var(--bear)" fillOpacity={a} />
          <line x1={x0} x2={x1} y1={ye} y2={ye} stroke="var(--text-2)" strokeDasharray="5 4" strokeWidth={1} />
          {open ? <>
            {label(right(tTxt), yt + (long ? 14 : -14), tTxt, 'var(--bull)', 't')}
            {label(right(eTxt), ye, eTxt, 'var(--text)', 'e')}
            {label(right(sTxt), ys + (long ? -14 : 14), sTxt, 'var(--bear)', 's')}
            {label(Math.min(x0, w - 230), (long ? Math.min(yt, ye) : Math.min(ys, ye)) - 16, `OPEN · ${signed(t.now_r ?? 0)}R · ${fmtUsd(t.unrealized ?? 0)}`, up ? 'var(--bull)' : 'var(--bear)', 'o', true)}
          </> : free(x1 + 3, by, width(badge)) && label(x1 + 3, by, badge, won ? 'var(--bull)' : 'var(--bear)', 'r', true)}
        </g>
      })}
      {v.pending.map((p, i) => { const y = yOf(p.entry); return <g key={'p' + i}>
        <line x1={0} x2={w} y1={y} y2={y} stroke="var(--accent)" strokeDasharray="2 4" strokeWidth={1} />
        {label(8, y - 13, `AI waiting: ${p.dir === 'long' ? 'buy' : 'sell'} limit ${fmtP(p.entry)}`, 'var(--accent)', 'pl' + i)}</g> })}
    </svg>
  )
}

// ---------------------------------------------------------------- tracker (right side)

function Tracker({ v }: { v?: View }) {
  const s = v?.stats
  const closed = useMemo(() => (v?.trades ?? []).filter((t) => t.status === 'closed').sort((a, b) => b.exit_time! - a.exit_time!), [v])
  const open = (v?.trades ?? []).filter((t) => t.status === 'open')
  // flash the newest result when a trade closes while you watch
  const lastSeen = useRef<number | null>(null), [flash, setFlash] = useState<number | null>(null)
  useEffect(() => {
    const newest = closed[0]?.id ?? null
    if (lastSeen.current != null && newest != null && newest !== lastSeen.current) { setFlash(newest); setTimeout(() => setFlash(null), 6000) }
    if (newest != null) lastSeen.current = newest
  }, [closed])
  const pct = s?.win_rate ?? 0, R = 70, C = 2 * Math.PI * R
  const tile = (label: string, value: string, tone?: 'bull' | 'bear') => <div className="rounded-lg bg-elevated px-3 py-2">
    <div className="text-[11px] text-text-2">{label}</div><div className={cx('font-mono text-[16px] font-semibold', tone === 'bull' && 'text-bull', tone === 'bear' && 'text-bear')}>{value}</div></div>
  const st = v?.status
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between"><h2 className="text-[16px] font-semibold">AI Trade Tracker</h2><Badge tone="warn">Simulated</Badge></div>
      <div className="relative mx-auto grid size-[170px] shrink-0 place-items-center">
        <svg viewBox="0 0 170 170" className="absolute inset-0 -rotate-90">
          <circle cx={85} cy={85} r={R} fill="none" stroke={s?.trades ? 'var(--bear)' : 'var(--border)'} strokeWidth={14} />
          {!!s?.trades && <circle cx={85} cy={85} r={R} fill="none" stroke="var(--bull)" strokeWidth={14} strokeDasharray={`${(pct / 100) * C} ${C}`} />}
        </svg>
        <div className="text-center"><div className="font-mono text-[34px] font-bold leading-none">{s?.trades ? `${Math.round(pct)}%` : '—'}</div>
          <div className="mt-1 text-[12px] text-text-2">trades right</div></div>
      </div>
      <div className="flex justify-around text-[15px] font-semibold"><span className="text-bull">{s?.wins ?? 0} right</span><span className="text-bear">{s?.losses ?? 0} wrong</span></div>
      {s && <div className="grid grid-cols-2 gap-2">
        {tile('Net P&L', fmtUsd(s.net_pnl), s.net_pnl > 0 ? 'bull' : s.net_pnl < 0 ? 'bear' : undefined)}
        {tile('Profit factor', s.profit_factor == null ? '—' : s.profit_factor === 'inf' ? '∞' : s.profit_factor.toFixed(2))}
        {tile('Avg per trade', s.avg_r == null ? '—' : `${signed(s.avg_r, 2)}R`, s.avg_r == null ? undefined : s.avg_r >= 0 ? 'bull' : 'bear')}
        {tile('Max drawdown', s.max_drawdown ? `-${fmtUsd(s.max_drawdown)}` : '$0.00', s.max_drawdown ? 'bear' : undefined)}
        {tile('Streak', s.streak ? `${s.streak.count} ${s.streak.kind === 'win' ? (s.streak.count > 1 ? 'wins' : 'win') : s.streak.count > 1 ? 'losses' : 'loss'}` : '—', s.streak?.kind === 'win' ? 'bull' : s.streak ? 'bear' : undefined)}
        {tile('Trades today', String(s.today))}
      </div>}
      <section><h3 className="mb-1.5 text-[12px] font-semibold text-text-2">Open trade{open.length > 1 ? 's' : ''}</h3>
        {!open.length && <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-text-2">
          {v?.config.enabled ? (v.pending.length ? `Setup armed: waiting for price to reach ${fmtP(v.pending[0].entry)}.` : 'No open trade. Waiting for the next setup.') : 'The AI is paused.'}</p>}
        {open.map((t) => <div key={t.id} className={cx('mb-1.5 rounded-lg border px-3 py-2', (t.now_r ?? 0) >= 0 ? 'border-bull/50 bg-bull/8' : 'border-bear/50 bg-bear/8')}>
          <div className="text-[14px] font-semibold">{t.direction.toUpperCase()} {t.qty} {v!.config.symbol} @ {fmtP(t.entry_price)}</div>
          <div className="text-[12px] text-text-2">Stop {fmtP(t.stop)} · Target {fmtP(t.target)} · now <span className={(t.now_r ?? 0) >= 0 ? 'text-bull' : 'text-bear'}>{signed(t.now_r ?? 0)}R ({fmtUsd(t.unrealized ?? 0)})</span></div>
          <div className="text-[11px] text-text-2">{t.strategy}</div></div>)}
      </section>
      <section className="min-h-0"><h3 className="mb-1.5 text-[12px] font-semibold text-text-2">Recent trades</h3>
        {!closed.length && <p className="text-[12px] text-text-2">No closed trades on {v?.config.symbol} {v?.config.tf} yet.</p>}
        <ul className="flex flex-col gap-1">{closed.slice(0, 10).map((t) => { const won = (t.pnl ?? 0) > 0; return (
          <li key={t.id} className={cx('grid grid-cols-[48px_44px_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1 text-[12px] transition-colors', flash === t.id && (won ? 'bg-bull/20' : 'bg-bear/20'))}>
            <span className={cx('rounded px-1 py-0.5 text-center text-[10px] font-bold text-white', won ? 'bg-bull' : 'bg-bear')}>{won ? 'WIN' : 'LOSS'}</span>
            <span className="capitalize">{t.direction}</span>
            <span className={cx('font-mono', won ? 'text-bull' : 'text-bear')}>{signed(rOf(t))}R  {fmtUsd(t.pnl)}</span>
            <span className="font-mono text-[11px] text-text-2">{fmtT(t.exit_time)}</span></li>) })}</ul>
      </section>
      <p className="mt-auto text-[11px] text-text-2">
        {st?.last_error ? <span className="text-bear">Last check failed: {st.last_error}</span>
          : v?.market_quiet ? 'No new candles right now: the market is closed or the data is delayed.'
          : st?.last_run ? `Checked ${fmtT(st.last_run)} · every ${st.interval}s` : 'Starting…'}
        {v && <> · Trading forward since {fmtT(v.config.started_at)}. Results appear in the Journal as AI trades.</>}
      </p>
    </aside>
  )
}
