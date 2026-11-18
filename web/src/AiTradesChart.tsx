import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CandlestickSeries, createChart, createSeriesMarkers, HistogramSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi,
  type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts'
import { api, fmtP, fmtUsd } from './api'
import type { Bar } from './indicators'
import { useSettings } from './store'
import { ErrorText, Panel, cx } from './ui'

type T = { entry_time: number; exit_time: number; dir: string; entry: number; exit: number; pnl: number; strategy: string }
type AiTrades = { bars: Bar[]; trades: T[]; setups: { dir: string; entry: number; stop: number; target: number; strategy: string; touched: boolean }[]
  wins: number; losses: number; net_pnl: number; provider: { label: string } }
type Action = { buy: boolean; price: number; note: string }

const TFS = ['1m', '5m', '15m', '30m', '1H', '4H']
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

/** Where the AI's strategies bought and sold: green arrow on every buy, red arrow on every sell. Styled like the Charts tab. */
export function AiTradesChart({ mkt, setMkt, className }: { mkt: { symbol: string; tf: string }; setMkt: (m: { symbol: string; tf: string }) => void; className?: string }) {
  const theme = useSettings((s) => s.theme)
  const q = useQuery({ queryKey: ['ai-trades', mkt.symbol, mkt.tf], queryFn: () => api<AiTrades>(`/api/ai-trades?symbol=${mkt.symbol}&tf=${mkt.tf}`), refetchInterval: 60_000 })
  const box = useRef<HTMLDivElement>(null), chart = useRef<IChartApi>()
  const candles = useRef<ISeriesApi<'Candlestick'>>(), vol = useRef<ISeriesApi<'Histogram'>>()
  const markers = useRef<ISeriesMarkersPluginApi<Time>>(), lines = useRef<IPriceLine[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const d = q.data

  // Every buy and every sell, keyed by candle time (a long buys then sells; a short sells then buys back).
  const actions = useMemo(() => {
    const m = new Map<number, Action[]>()
    const add = (t: number, a: Action) => m.set(t, [...(m.get(t) ?? []), a])
    for (const t of d?.trades ?? []) {
      const long = t.dir === 'long', won = t.pnl > 0
      add(t.entry_time, { buy: long, price: t.entry, note: long ? 'opened long' : 'opened short' })
      add(t.exit_time, { buy: !long, price: t.exit, note: `closed ${long ? 'long' : 'short'}, ${won ? 'won' : 'lost'} ${fmtUsd(Math.abs(t.pnl))}` })
    }
    return m
  }, [d])

  useEffect(() => {
    const c = createChart(box.current!, { autoSize: true, timeScale: { timeVisible: true, rightOffset: 6 } })
    candles.current = c.addSeries(CandlestickSeries, { borderVisible: false })
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    markers.current = createSeriesMarkers(candles.current, [])
    c.subscribeCrosshairMove((p) => setHover(typeof p.time === 'number' ? p.time : null))
    chart.current = c
    return () => c.remove()
  }, [])

  useEffect(() => { // same look as the Charts tab
    const [bg, text, line, bull, bear] = ['--panel', '--text-2', '--border', '--bull', '--bear'].map(css)
    chart.current!.applyOptions({ layout: { background: { color: bg }, textColor: text, fontFamily: 'Inter' },
      grid: { vertLines: { color: line + '66' }, horzLines: { color: line + '66' } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line } })
    candles.current!.applyOptions({ upColor: bull, downColor: bear, wickUpColor: bull, wickDownColor: bear })
  }, [theme])

  useEffect(() => {
    if (!d) return
    const [bull, bear, accent] = ['--bull', '--bear', '--accent'].map(css)
    const s = candles.current!
    s.setData(d.bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })))
    vol.current!.setData(d.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: (b.close >= b.open ? bull : bear) + '55' })))
    const m: SeriesMarker<Time>[] = []
    for (const [time, list] of actions) for (const a of list)
      m.push(a.buy ? { time: time as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: bull, size: 1.3 }
        : { time: time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: bear, size: 1.3 })
    markers.current!.setMarkers(m.sort((a, b) => (a.time as number) - (b.time as number)))
    lines.current.forEach((l) => s.removePriceLine(l)); lines.current = []
    for (const p of d.setups) for (const [price, color, title] of [[p.entry, accent, p.touched ? (p.dir === 'long' ? 'AI bought' : 'AI sold') : (p.dir === 'long' ? 'AI buys here' : 'AI sells here')],
      [p.stop, bear, 'Stop'], [p.target, bull, 'Target']] as const)
      lines.current.push(s.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }))
    chart.current!.timeScale().fitContent()
  }, [d, actions, theme])

  const bars = d?.bars ?? []
  const bar = (hover != null ? bars.find((b) => b.time === hover) : undefined) ?? bars.at(-1)
  const here = bar ? actions.get(bar.time) ?? [] : []
  return (
    <Panel className={className} bodyClass="flex min-h-0 flex-col"
      title={<span className="flex items-center gap-2">Where the AI buys and sells <span className="font-mono text-text-2">{mkt.symbol}</span></span>}
      right={<div className="flex items-center gap-3">
        <div className="flex items-center">{TFS.map((t) => <button key={t} onClick={() => setMkt({ ...mkt, tf: t })}
          className={cx('h-6 rounded px-1.5 font-mono text-[11px]', mkt.tf === t ? 'font-medium text-accent' : 'text-text-2 hover:text-text')}>{t}</button>)}</div>
        {d && <span className="text-[12px] text-text-2">{d.trades.length ? <>{d.wins} won · {d.losses} lost · <span className={d.net_pnl >= 0 ? 'text-bull' : 'text-bear'}>{fmtUsd(d.net_pnl)}</span></> : 'No trades in view'}</span>}
      </div>}>
      <div className="flex h-8 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-b border-line px-3 font-mono text-[12px]">
        {bar ? <>
          <span>O {fmtP(bar.open)} H {fmtP(bar.high)} L {fmtP(bar.low)} C {fmtP(bar.close)}</span>
          {here.map((a, i) => <span key={i} className={a.buy ? 'text-bull' : 'text-bear'}>{a.buy ? '▲ AI bought' : '▼ AI sold'} {fmtP(a.price)} <span className="text-text-2">({a.note})</span></span>)}
        </> : <span className="text-text-2">{q.isPending ? 'Loading…' : ''}</span>}
      </div>
      <div className="relative min-h-0 flex-1"><div ref={box} className="absolute inset-0" /></div>
      <ErrorText error={q.error} />
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-text-2">
        <span><span className="text-bull">▲</span> AI bought</span><span><span className="text-bear">▼</span> AI sold</span>
        <span>- - current setup (entry, stop, target)</span><span className="ml-auto">Simulated trades · {d?.provider.label}</span>
      </div>
    </Panel>
  )
}
