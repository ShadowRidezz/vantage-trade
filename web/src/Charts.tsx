import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp } from 'lightweight-charts'
import { Activity, ArrowLeftRight, Maximize2, Minimize2, Search, SlidersHorizontal, Sparkles } from 'lucide-react'
import { kindToCat, useNav, useSettings, type Indicators } from './store'
import { DetectionLayer, useVision, VisionPanel } from './Vision'
import { PaperTicket, useOpenTrades, useTradeLines } from './Ticket'
import { sma, ema, rsi, macd, vwap, sessionKey, type Bar } from './indicators'
import { DrawingLayer, DrawingToolbar, type Tool } from './Drawings'

const TFS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']
const INTRADAY = new Set(TFS.slice(0, 7))
const FUTURES = ['MNQ', 'MES', 'NQ', 'ES']
const COL = { sma: '#F59E0B', ema: '#3B82F6', vwap: '#06B6D4', macd: '#3B82F6', signal: '#F59E0B' }
type Resp = { symbol: string; continuous: boolean; spec: { name: string; tick_size: number; tick_value: number; exchange: string } | null
  contract: { code: string; expiry: string } | null; provider: { status: string; label: string }; bars: Bar[] }

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

export function Charts() {
  const { symbol, tf, theme, ind, prefs, set } = useSettings()
  const box = useRef<HTMLDivElement>(null), wrap = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi>(), candles = useRef<ISeriesApi<'Candlestick'>>(), vol = useRef<ISeriesApi<'Histogram'>>()
  const extra = useRef<ISeriesApi<SeriesType>[]>([])
  const [ready, setReady] = useState(false)
  const [data, setData] = useState<Resp>(), [err, setErr] = useState(''), [loading, setLoading] = useState(false)
  const [query, setQuery] = useState(''), [full, setFull] = useState(false), [hover, setHover] = useState<number | null>(null)
  const [menu, setMenu] = useState<'ind' | 'prefs' | null>(null), [tool, setTool] = useState<Tool>('cursor')
  const { visionOpen, visionWidth, visionCats } = useSettings()
  const vision = useVision(symbol, tf, visionOpen)
  const nav = useNav()
  const [selDet, setSelDet] = useState<string | null>(null), [ticket, setTicket] = useState(false)
  const times = useMemo(() => (data?.bars ?? []).map((b) => b.time), [data])
  const live = vision.result && vision.result.symbol === symbol && vision.result.tf === tf ? vision.result : undefined
  const shownDets = useMemo(() => (live?.detections ?? []).filter((d) => visionCats[kindToCat[d.kind]]), [live, visionCats])
  const overlayDets = useMemo(() => { // readability: the 15 most recent of each kind on the chart; the panel lists all
    const per: Record<string, number> = {}
    return [...shownDets].sort((a, b) => b.confirmed_at - a.confirmed_at).filter((d) => d.id === selDet || (per[d.kind] = (per[d.kind] ?? 0) + 1) <= 15)
  }, [shownDets, selDet])
  const openTrades = useOpenTrades(symbol)
  useTradeLines(ready ? candles.current : undefined, openTrades.data, theme)
  useEffect(() => { setSelDet(null) }, [symbol, tf])

  const selectDet = (id: string | null) => {
    setSelDet(id)
    const d = live?.detections.find((x) => x.id === id), ts = chart.current?.timeScale(), r = ts?.getVisibleLogicalRange()
    if (!d || !ts || !r) return
    const i0 = times.findIndex((t) => t >= d.t0), i1 = times.findIndex((t) => t >= d.t1)
    if (i0 < 0 || (i0 >= r.from && i1 <= r.to)) return
    const span = r.to - r.from, mid = (i0 + Math.max(i0, i1)) / 2
    ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 })
  }
  // Scanner -> chart: switch market, open AI Vision, then reveal the detection once its analysis arrives.
  useEffect(() => { if (nav.focus) set({ symbol: nav.focus.symbol, tf: nav.focus.tf, visionOpen: true, page: 'charts' }) }, [nav.focus]) // eslint-disable-line
  useEffect(() => {
    const f = nav.focus
    if (!f || !live || live.symbol !== f.symbol || live.tf !== f.tf || !data || data.symbol !== f.symbol) return
    const d = live.detections.find((x) => x.id === f.detId)
    if (d) { set({ visionCats: { ...visionCats, [kindToCat[d.kind]]: true } }); requestAnimationFrame(() => selectDet(d.id)) }
    nav.set({ focus: null })
  }, [live, nav.focus, data]) // eslint-disable-line

  useEffect(() => {
    const c = createChart(box.current!, { autoSize: true, timeScale: { timeVisible: true }, layout: { panes: { separatorColor: css('--border') } } })
    candles.current = c.addSeries(CandlestickSeries, { borderVisible: false })
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    c.subscribeCrosshairMove((p) => setHover(p.logical ?? null))
    chart.current = c; setReady(true)
    const onFs = () => setFull(document.fullscreenElement === wrap.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => { document.removeEventListener('fullscreenchange', onFs); extra.current = []; c.remove() }
  }, [])

  useEffect(() => { // theme + chart prefs
    const [bg, text, line, bull, bear] = ['--panel', '--text-2', '--border', '--bull', '--bear'].map(css)
    const gridColor = prefs.grid ? line + '66' : 'transparent'
    chart.current!.applyOptions({ layout: { background: { color: bg }, textColor: text, fontFamily: 'Inter', panes: { separatorColor: line } },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      crosshair: { mode: prefs.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal },
      rightPriceScale: { borderColor: line, mode: prefs.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }, timeScale: { borderColor: line } })
    candles.current!.applyOptions({ upColor: bull, downColor: bear, wickUpColor: bull, wickDownColor: bear })
  }, [theme, prefs])

  useEffect(() => {
    const ctl = new AbortController()
    setLoading(true); setErr('')
    fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal: ctl.signal })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.detail || r.statusText); return j as Resp })
      .then((j) => {
        candles.current!.setData(j.bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })))
        candles.current!.applyOptions({ priceFormat: { type: 'price', minMove: j.spec?.tick_size ?? 0.01, precision: 2 } })
        chart.current!.timeScale().fitContent(); setData(j)
      })
      .catch((e) => { if (!ctl.signal.aborted) { setErr(e.message); setData(undefined); candles.current!.setData([]); vol.current!.setData([]) } })
      .finally(() => !ctl.signal.aborted && setLoading(false))
    return () => ctl.abort()
  }, [symbol, tf])

  const calc = useMemo(() => {
    if (!data) return null
    const c = data.bars.map((b) => b.close), m = ind.macd
    return {
      sma: ind.sma.on ? sma(c, ind.sma.period) : null, ema: ind.ema.on ? ema(c, ind.ema.period) : null,
      vwap: ind.vwap.on && INTRADAY.has(tf) ? vwap(data.bars) : null, rsi: ind.rsi.on ? rsi(c, ind.rsi.period) : null,
      macd: m.on && m.fast < m.slow ? macd(c, m.fast, m.slow, m.signal) : null,
    }
  }, [data, ind, tf])

  useEffect(() => { // (re)build indicator series
    const c = chart.current!, T = data?.bars.map((b) => b.time) ?? []
    extra.current.forEach((s) => c.removeSeries(s)); extra.current = []
    const [bull, bear, accent, line] = ['--bull', '--bear', '--accent', '--border'].map(css)
    vol.current!.applyOptions({ visible: ind.volume.on })
    vol.current!.setData(data ? data.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: (b.close >= b.open ? bull : bear) + '55' })) : [])
    if (!calc) return
    const pts = (v: (number | null)[]) => v.flatMap((x, i) => (x === null ? [] : [{ time: T[i] as UTCTimestamp, value: x }]))
    const add = (v: (number | null)[], color: string, pane = 0, hist = false) => {
      const s = hist ? c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane)
        : c.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false }, pane)
      if (hist) s.setData(v.flatMap((x, i) => (x === null ? [] : [{ time: T[i] as UTCTimestamp, value: x, color: (x >= 0 ? bull : bear) + '99' }])))
      else s.setData(pts(v))
      extra.current.push(s); return s
    }
    if (calc.sma) add(calc.sma, COL.sma)
    if (calc.ema) add(calc.ema, COL.ema)
    if (calc.vwap) { // whitespace at each session's first bar so sessions aren't joined by a vertical jump
      const v = add(calc.vwap, COL.vwap), keys = data!.bars.map((b) => sessionKey(b.time))
      v.setData(calc.vwap.map((x, i) => (x === null || (i > 0 && keys[i] !== keys[i - 1]) ? { time: T[i] as UTCTimestamp } : { time: T[i] as UTCTimestamp, value: x })))
    }
    let pane = 1
    if (calc.rsi) {
      const s = add(calc.rsi, accent, pane++)
      for (const price of [70, 30]) s.createPriceLine({ price, color: line, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' })
    }
    if (calc.macd) { add(calc.macd.hist, '', pane, true); add(calc.macd.line, COL.macd, pane); add(calc.macd.signal, COL.signal, pane++) }
    c.panes().forEach((p, i) => p.setStretchFactor(i ? 1 : 4)) // price pane 4x each indicator pane
  }, [calc, theme, ind.volume.on, data])

  const bars = data?.bars ?? []
  const idx = hover === null ? bars.length - 1 : Math.max(0, Math.min(bars.length - 1, Math.round(hover)))
  const bar = bars[idx], prevBar = bars[idx - 1]
  const chg = bar && prevBar ? bar.close - prevBar.close : 0
  const fmt = (n: number | null | undefined, d = 2) => (n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
  const btn = 'h-7 rounded px-2 text-[12px] transition-colors duration-100'
  const legend: [string, string, number | null | undefined][] = calc ? [
    ...(calc.sma ? [[`SMA ${ind.sma.period}`, COL.sma, calc.sma[idx]] as [string, string, number | null]] : []),
    ...(calc.ema ? [[`EMA ${ind.ema.period}`, COL.ema, calc.ema[idx]] as [string, string, number | null]] : []),
    ...(calc.vwap ? [['VWAP', COL.vwap, calc.vwap[idx]] as [string, string, number | null]] : []),
  ] : []
  const sub: [string, string][] = calc ? [
    ...(calc.rsi ? [[`RSI ${ind.rsi.period}`, fmt(calc.rsi[idx])] as [string, string]] : []),
    ...(calc.macd ? [[`MACD ${ind.macd.fast} ${ind.macd.slow} ${ind.macd.signal}`, `${fmt(calc.macd.line[idx])} / ${fmt(calc.macd.signal[idx])} / ${fmt(calc.macd.hist[idx])}`] as [string, string]] : []),
  ] : []

  return (
    <div ref={wrap} className="flex h-full flex-col bg-bg">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <form onSubmit={(e) => { e.preventDefault(); const q = query.trim().toUpperCase(); if (/^[A-Z0-9.\-^]{1,12}$/.test(q)) { set({ symbol: q }); setQuery('') } }}
          className="flex h-7 items-center gap-1.5 rounded border border-line bg-bg px-2">
          <Search size={13} className="text-text-2" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={symbol} aria-label="Symbol search"
            className="w-20 bg-transparent font-medium outline-none placeholder:text-text" />
        </form>
        {FUTURES.map((s) => <button key={s} onClick={() => set({ symbol: s })} className={`${btn} ${symbol === s ? 'bg-elevated text-text font-medium' : 'text-text-2 hover:text-text'}`}>{s}</button>)}
        <div className="mx-1.5 h-5 w-px bg-line" />
        {TFS.map((t) => <button key={t} onClick={() => set({ tf: t })} className={`${btn} font-mono ${tf === t ? 'text-accent font-medium' : 'text-text-2 hover:text-text'}`}>{t}</button>)}
        <div className="mx-1.5 h-5 w-px bg-line" />
        <div className="relative flex">
          <button onClick={() => setMenu(menu === 'ind' ? null : 'ind')} aria-expanded={menu === 'ind'} className={`${btn} flex items-center gap-1.5 ${menu === 'ind' ? 'bg-elevated text-text' : 'text-text-2 hover:text-text'}`}>
            <Activity size={14} /> Indicators</button>
          <button onClick={() => setMenu(menu === 'prefs' ? null : 'prefs')} aria-expanded={menu === 'prefs'} title="Chart settings" aria-label="Chart settings"
            className={`${btn} ${menu === 'prefs' ? 'bg-elevated text-text' : 'text-text-2 hover:text-text'}`}><SlidersHorizontal size={14} /></button>
          {menu && <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} />
            <div className="absolute left-0 top-9 z-30 w-72 rounded-md border border-line bg-panel p-1.5 shadow-lg shadow-black/20">
              {menu === 'ind' ? <IndicatorMenu ind={ind} intraday={INTRADAY.has(tf)} onChange={(i) => set({ ind: i })} /> : <>
                <Check label="Logarithmic price scale" on={prefs.log} toggle={() => set({ prefs: { ...prefs, log: !prefs.log } })} />
                <Check label="Grid lines" on={prefs.grid} toggle={() => set({ prefs: { ...prefs, grid: !prefs.grid } })} />
                <Check label="Magnet crosshair (snap to OHLC)" on={prefs.magnet} toggle={() => set({ prefs: { ...prefs, magnet: !prefs.magnet } })} />
              </>}
            </div>
          </>}
        </div>
        <button onClick={() => set({ visionOpen: !visionOpen })} aria-pressed={visionOpen}
          className={`${btn} flex items-center gap-1.5 ${visionOpen ? 'bg-accent/12 text-accent' : 'text-text-2 hover:text-text'}`}><Sparkles size={14} /> AI Vision</button>
        <div className="relative flex">
          <button onClick={() => setTicket(!ticket)} aria-expanded={ticket} className={`${btn} flex items-center gap-1.5 ${ticket ? 'bg-elevated text-text' : 'text-text-2 hover:text-text'}`}>
            <ArrowLeftRight size={14} /> Paper trade</button>
          {ticket && <PaperTicket symbol={symbol} tf={tf} bars={data?.bars ?? []} onClose={() => setTicket(false)} />}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-text-2" title="Data source status">
            <span className={`size-1.5 rounded-full ${data.provider.status === 'live' ? 'bg-bull' : 'bg-warn'}`} />{data.provider.label}</span>}
          <button onClick={() => full ? document.exitFullscreen() : wrap.current!.requestFullscreen()} title="Fullscreen" aria-label="Fullscreen" className={`${btn} text-text-2 hover:text-text`}>
            {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-b border-line bg-panel px-3 text-[12px]">
        <span className="font-semibold">{symbol}</span>
        {data?.spec && <span className="truncate text-text-2">{data.spec.name} · {data.spec.exchange} · continuous series{data.contract ? ` (front month ≈ ${data.contract.code}, expires ${data.contract.expiry})` : ''} · tick {data.spec.tick_size} = ${data.spec.tick_value.toFixed(2)}</span>}
        {bar && <span className="font-mono">O {fmt(bar.open)} H {fmt(bar.high)} L {fmt(bar.low)} C {fmt(bar.close)}
          <span className={`ml-2 ${chg >= 0 ? 'text-bull' : 'text-bear'}`}>{chg >= 0 ? '+' : ''}{fmt(chg)}</span>
          {ind.volume.on && <span className="ml-3 text-text-2">Vol {fmt(bar.volume, 0)}</span>}</span>}
        {loading && <span className="text-text-2">Loading…</span>}
        {err && <span className="text-bear">{err}</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar tool={tool} setTool={setTool} symbol={symbol} />
        <div className="relative min-w-0 flex-1">
          <div ref={box} className="absolute inset-0" />
          {(legend.length > 0 || sub.length > 0) && <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-col gap-0.5 font-mono text-[11px]">
            {legend.map(([k, c, v]) => <span key={k}><span style={{ color: c }}>{k}</span> <span className="text-text">{fmt(v)}</span></span>)}
            {sub.map(([k, v]) => <span key={k} className="text-text-2">{k} <span className="text-text">{v}</span></span>)}
          </div>}
          {ready && visionOpen && <DetectionLayer chart={chart.current!} series={candles.current!} times={times} dets={overlayDets}
            selected={selDet} onSelect={selectDet} layoutKey={`${calc?.rsi ? 1 : 0}${calc?.macd ? 1 : 0}${prefs.log}${visionWidth}`} />}
          {ready && <DrawingLayer chart={chart.current!} series={candles.current!} times={times} symbol={symbol}
            tool={tool} setTool={setTool} layoutKey={`${calc?.rsi ? 1 : 0}${calc?.macd ? 1 : 0}${prefs.log}${visionOpen}${visionWidth}`} />}
        </div>
        {visionOpen && <VisionPanel symbol={symbol} tf={tf} st={vision} dets={shownDets} selected={selDet} onSelect={selectDet}
          cats={visionCats} setCats={(c) => set({ visionCats: c })} width={visionWidth} setWidth={(w) => set({ visionWidth: w })}
          onClose={() => set({ visionOpen: false })} />}
      </div>
    </div>
  )
}

function Check({ label, on, toggle, disabled, children }: { label: string; on: boolean; toggle: () => void; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <label className={`flex h-8 items-center gap-2 rounded px-2 ${disabled ? 'opacity-50' : 'hover:bg-elevated'}`}>
      <input type="checkbox" checked={on} onChange={toggle} disabled={disabled} className="accent-[var(--accent)]" />
      <span className="flex-1">{label}</span>{children}
    </label>
  )
}

function Num({ value, onChange, label, max = 500 }: { value: number; onChange: (n: number) => void; label: string; max?: number }) {
  return <input type="number" min={1} max={max} value={value} aria-label={label}
    onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= max) onChange(n) }}
    className="h-6 w-12 rounded border border-line bg-bg px-1 text-right font-mono text-[12px] outline-none focus:border-accent" />
}

function IndicatorMenu({ ind, intraday, onChange }: { ind: Indicators; intraday: boolean; onChange: (i: Indicators) => void }) {
  const up = <K extends keyof Indicators>(k: K, v: Partial<Indicators[K]>) => onChange({ ...ind, [k]: { ...ind[k], ...v } })
  return <>
    <Check label="Volume" on={ind.volume.on} toggle={() => up('volume', { on: !ind.volume.on })} />
    <Check label="SMA" on={ind.sma.on} toggle={() => up('sma', { on: !ind.sma.on })}><Num label="SMA period" value={ind.sma.period} onChange={(period) => up('sma', { period })} /></Check>
    <Check label="EMA" on={ind.ema.on} toggle={() => up('ema', { on: !ind.ema.on })}><Num label="EMA period" value={ind.ema.period} onChange={(period) => up('ema', { period })} /></Check>
    <Check label={intraday ? 'VWAP (session)' : 'VWAP — intraday only'} on={ind.vwap.on} disabled={!intraday} toggle={() => up('vwap', { on: !ind.vwap.on })} />
    <Check label="RSI" on={ind.rsi.on} toggle={() => up('rsi', { on: !ind.rsi.on })}><Num label="RSI period" value={ind.rsi.period} onChange={(period) => up('rsi', { period })} /></Check>
    <Check label="MACD" on={ind.macd.on} toggle={() => up('macd', { on: !ind.macd.on })}>
      <span className="flex gap-1"><Num label="MACD fast" value={ind.macd.fast} onChange={(fast) => up('macd', { fast })} />
        <Num label="MACD slow" value={ind.macd.slow} onChange={(slow) => up('macd', { slow })} />
        <Num label="MACD signal" value={ind.macd.signal} onChange={(signal) => up('macd', { signal })} /></span>
    </Check>
    {ind.macd.on && ind.macd.fast >= ind.macd.slow && <p className="px-2 pb-1 text-[11px] text-bear">MACD fast period must be shorter than slow.</p>}
  </>
}
