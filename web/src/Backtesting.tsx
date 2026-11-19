import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AreaSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { FlaskConical, Play } from 'lucide-react'
import { api, fmtD, fmtP, fmtT, fmtUsd, type Metrics, type StrategyRow, type Version } from './api'
import { useSettings } from './store'
import { AiLab } from './Lab'
import { Badge, Btn, Empty, ErrorText, Field, Metric, Panel, Simulated, Tabs, cx, inputCls } from './ui'

const TFS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D']
type BtTrade = { entry_time: number; exit_time: number; dir: string; entry: number; exit: number; stop: number; target: number; pnl: number; r: number
  exit_reason: string; bars_held: number; reason: string; mfe_r: number }
type Bt = { id: number; version_id: number; symbol: string; tf: string; segment: string; start: number; end: number; metrics: Metrics
  equity: { time: number; value: number }[]; trades: BtTrade[]; settings: any; experiment_id: number | null; created_at: number
  diagnostics?: { code: string; text: string; change: Record<string, any> }[]; data_range?: { first: number; last: number } }
type Exp = { id: number; base_version_id: number; candidate_version_id: number | null; symbol: string; tf: string; change: Record<string, any>
  rationale: string; status: string; verdict: { accepted: boolean; reasons: string[]; split_time: number; metrics: Record<string, Metrics> } | null; created_at: number }

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
const pf = (m: Metrics) => (m.profit_factor === 'inf' ? '∞' : m.profit_factor == null ? '—' : m.profit_factor.toFixed(2))
const useStrategies = () => useQuery({ queryKey: ['strategies'], queryFn: () => api<{ strategies: StrategyRow[]; param_docs: Record<string, string> }>('/api/strategies') })
const vname = (ss: StrategyRow[] | undefined, id: number | null) => { for (const s of ss ?? []) for (const v of s.versions) if (v.id === id) return `${s.name} v${v.version}`; return `#${id}` }

export function Backtesting() {
  const [tab, setTab] = useState<'lab' | 'run' | 'versions' | 'research'>('lab')
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <Tabs value={tab} onChange={setTab} items={[['lab', 'AI Lab'], ['run', 'Run backtest'], ['versions', 'Strategies & versions'], ['research', 'Research']]} />
        <p className="text-[11px] text-text-2">Historical simulation on delayed/historical data. Results are simulated and do not predict future performance.</p>
      </div>
      <div className="min-h-0 flex-1">{tab === 'lab' ? <AiLab /> : tab === 'run' ? <Run /> : tab === 'versions' ? <Versions /> : <Research />}</div>
    </div>
  )
}

function EquityChart({ points }: { points: { time: number; value: number }[] }) {
  const el = useRef<HTMLDivElement>(null), ch = useRef<IChartApi>(), ser = useRef<ISeriesApi<'Area'>>()
  const theme = useSettings((s) => s.theme)
  useEffect(() => {
    const c = createChart(el.current!, { autoSize: true, timeScale: { timeVisible: true }, rightPriceScale: { borderVisible: false }, handleScroll: false, handleScale: false })
    ch.current = c
    return () => c.remove()
  }, [])
  useEffect(() => {
    const c = ch.current!
    c.applyOptions({ layout: { background: { color: css('--panel') }, textColor: css('--text-2'), fontFamily: 'Inter' },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--border') + '66' } }, timeScale: { borderColor: css('--border') } })
    if (ser.current) c.removeSeries(ser.current) // replaced here, not in a cleanup: on unmount the chart is already gone
    const s = ser.current = c.addSeries(AreaSeries, { lineColor: css('--accent'), topColor: css('--accent') + '40', bottomColor: css('--accent') + '05', lineWidth: 2, priceLineVisible: false })
    // equity points can share a timestamp; keep the last value per second
    const m = new Map<number, number>(); points.forEach((p) => m.set(p.time, p.value))
    s.setData([...m].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value })))
    c.timeScale().fitContent()
  }, [points, theme])
  return <div ref={el} className="h-full w-full" />
}

export function MetricsGrid({ m }: { m: Metrics }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
    <Metric label="Total trades" value={m.trades} />
    <Metric label="Win rate" value={m.win_rate == null ? '—' : `${m.win_rate.toFixed(1)}%`} />
    <Metric label="Profit factor" value={pf(m)} />
    <Metric label="Max drawdown" value={`${fmtUsd(m.max_drawdown)} (${m.max_drawdown_pct.toFixed(1)}%)`} tone={m.max_drawdown ? 'bear' : undefined} />
    <Metric label="Average win" value={fmtUsd(m.avg_win)} tone="bull" />
    <Metric label="Average loss" value={fmtUsd(m.avg_loss)} tone="bear" />
    <Metric label="Avg reward : risk" value={m.avg_rr == null ? '—' : m.avg_rr.toFixed(2)} />
    <Metric label="Simulated net P&L" value={fmtUsd(m.net_pnl)} tone={m.net_pnl >= 0 ? 'bull' : 'bear'} />
  </div>
}

function Run() {
  const qc = useQueryClient()
  const { symbol, tf } = useSettings()
  const st = useStrategies()
  const [f, setF] = useState({ symbol, tf, sid: 0, vid: 0, start: '', end: '', capital: 10000, commission: 0.62, slippage_ticks: 1, qty: 1 })
  const strat = st.data?.strategies.find((s) => s.id === f.sid) ?? st.data?.strategies[0]
  useEffect(() => { if (strat && !strat.versions.some((v) => v.id === f.vid)) setF((x) => ({ ...x, sid: strat.id, vid: (strat.versions.find((v) => v.status === 'active') ?? strat.versions[0]).id })) }, [strat, f.vid])
  useEffect(() => { setF((x) => ({ ...x, commission: ['NQ', 'ES'].includes(x.symbol) ? 2.25 : ['MNQ', 'MES'].includes(x.symbol) ? 0.62 : 0 })) }, [f.symbol])
  const [shown, setShown] = useState<number | null>(null)
  const run = useMutation({
    mutationFn: () => api<Bt>('/api/backtests', { version_id: f.vid, symbol: f.symbol, tf: f.tf, capital: f.capital, commission: f.commission, slippage_ticks: f.slippage_ticks, qty: f.qty,
      start: f.start ? Date.parse(f.start + 'T00:00:00Z') / 1000 : null, end: f.end ? Date.parse(f.end + 'T23:59:59Z') / 1000 : null }),
    onSuccess: (b) => { setShown(b.id); qc.invalidateQueries({ queryKey: ['backtests'] }) },
  })
  const hist = useQuery({ queryKey: ['backtests'], queryFn: () => api<Bt[]>('/api/backtests') })
  const detail = useQuery({ queryKey: ['backtest', shown], queryFn: () => api<Bt>(`/api/backtests/${shown}`), enabled: shown != null })
  const b = run.data && run.data.id === shown ? run.data : detail.data
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: ['symbol', 'tf', 'start', 'end'].includes(k) ? (k === 'symbol' ? e.target.value.toUpperCase() : e.target.value) : Number(e.target.value) })
  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="Configuration">
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run.mutate() }}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Market"><input value={f.symbol} onChange={set('symbol')} pattern="[A-Za-z0-9.\-^]{1,12}" required className={inputCls} /></Field>
              <Field label="Timeframe"><select value={f.tf} onChange={set('tf')} className={inputCls}>{TFS.map((t) => <option key={t}>{t}</option>)}</select></Field>
            </div>
            <Field label="Strategy"><select value={strat?.id ?? ''} onChange={(e) => setF({ ...f, sid: Number(e.target.value), vid: 0 })} className={inputCls}>
              {st.data?.strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Strategy version"><select value={f.vid} onChange={set('vid')} className={inputCls}>
              {strat?.versions.map((v) => <option key={v.id} value={v.id}>v{v.version} — {v.status}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From (UTC)"><input type="date" value={f.start} onChange={set('start')} className={inputCls} /></Field>
              <Field label="To (UTC)"><input type="date" value={f.end} onChange={set('end')} className={inputCls} /></Field>
            </div>
            <p className="text-[10px] text-text-2">Empty = all available history (intraday data covers 7–60 days; 1H/4H about 2 years).</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Simulated capital"><input type="number" min={1} value={f.capital} onChange={set('capital')} className={inputCls} /></Field>
              <Field label="Contracts / shares"><input type="number" min={1} max={1000} value={f.qty} onChange={set('qty')} className={inputCls} /></Field>
              <Field label="Commission / side ($)"><input type="number" min={0} step="0.01" value={f.commission} onChange={set('commission')} className={inputCls} /></Field>
              <Field label="Slippage (ticks/side)"><input type="number" min={0} step="0.5" value={f.slippage_ticks} onChange={set('slippage_ticks')} className={inputCls} /></Field>
            </div>
            <ErrorText error={run.error} />
            <Btn type="submit" kind="primary" disabled={run.isPending || !f.vid}><Play size={12} />{run.isPending ? 'Running…' : 'Run backtest'}</Btn>
          </form>
        </Panel>
        <Panel title="Stored backtests" className="min-h-0 flex-1" bodyClass="overflow-auto">
          {hist.data?.map((h) => <button key={h.id} onClick={() => setShown(h.id)} className={cx('flex w-full flex-col px-3 py-1.5 text-left text-[12px] hover:bg-elevated', shown === h.id && 'bg-accent/10')}>
            <span className="flex justify-between"><span>#{h.id} {h.symbol} {h.tf}</span><span className={h.metrics.net_pnl >= 0 ? 'text-bull' : 'text-bear'}>{fmtUsd(h.metrics.net_pnl)}</span></span>
            <span className="text-[11px] text-text-2">{vname(st.data?.strategies, h.version_id)} · {h.segment.replace(/_/g, ' ')} · {h.metrics.trades} trades</span>
          </button>)}
          {hist.data && !hist.data.length && <Empty>No backtests stored yet.</Empty>}
        </Panel>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        {!b ? <Panel><Empty>{detail.isFetching ? 'Loading…' : 'Configure and run a backtest. Completed runs are stored and appear in the AI Brain.'}</Empty></Panel> : <>
          <div className="flex items-center gap-2 text-[12px]"><Simulated /><span className="font-semibold">Backtest #{b.id}</span>
            <span className="text-text-2">{vname(st.data?.strategies, b.version_id)} · {b.symbol} {b.tf} · {fmtT(b.start)} → {fmtT(b.end)} · {b.settings?.data}</span></div>
          <MetricsGrid m={b.metrics} />
          <Panel title="Equity curve (simulated)" className="h-64 shrink-0" bodyClass="p-0">{b.equity.length > 1 ? <EquityChart points={b.equity} /> : <Empty>No trades in this period.</Empty>}</Panel>
          {b.diagnostics && b.diagnostics.length > 0 && <Panel title="Recurring issues found in these trades">
            <ul className="flex flex-col gap-1 text-[12px]">{b.diagnostics.map((d) => <li key={d.code}>{d.text} <span className="text-text-2">Testable change: {JSON.stringify(d.change)} (see Research)</span></li>)}</ul>
          </Panel>}
          <Panel title={`Trades (${b.trades.length}${b.trades.length > 300 ? ', first 300 shown' : ''})`} className="shrink-0" bodyClass="max-h-96 overflow-auto">
            <TradesTable trades={b.trades.slice(0, 300)} />
          </Panel>
        </>}
      </div>
    </div>
  )
}

function TradesTable({ trades }: { trades: BtTrade[] }) {
  return <table className="w-full text-[12px]">
    <thead className="sticky top-0 bg-panel text-left text-[11px] text-text-2"><tr className="border-b border-line">
      {['Entry', 'Exit', 'Side', 'Entry px', 'Exit px', 'Stop', 'Target', 'Exit', 'R', 'P&L', 'Signal'].map((h, i) => <th key={i} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
    <tbody className="font-mono">{trades.map((t, i) => <tr key={i} className="border-b border-line/50">
      <td className="px-2 py-1">{fmtT(t.entry_time)}</td><td className="px-2">{fmtT(t.exit_time)}</td>
      <td className={cx('px-2', t.dir === 'long' ? 'text-bull' : 'text-bear')}>{t.dir}</td>
      <td className="px-2">{fmtP(t.entry)}</td><td className="px-2">{fmtP(t.exit)}</td><td className="px-2">{fmtP(t.stop)}</td><td className="px-2">{fmtP(t.target)}</td>
      <td className="px-2 font-sans">{t.exit_reason}</td><td className="px-2">{t.r.toFixed(2)}</td>
      <td className={cx('px-2', t.pnl >= 0 ? 'text-bull' : 'text-bear')}>{fmtUsd(t.pnl)}</td><td className="px-2 font-sans text-text-2">{t.reason}</td>
    </tr>)}</tbody>
  </table>
}

const statusTone = (s: string) => (s === 'active' ? 'accent' : s === 'validated' ? 'bull' : s === 'rejected' ? 'bear' : s === 'candidate' ? 'warn' : 'muted') as any

function Versions() {
  const qc = useQueryClient()
  const st = useStrategies()
  const bts = useQuery({ queryKey: ['backtests'], queryFn: () => api<Bt[]>('/api/backtests') })
  const adopt = useMutation({ mutationFn: (id: number) => api(`/api/versions/${id}/adopt`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['strategies'] }) })
  const [cmp, setCmp] = useState<number[]>([])
  const latest = (vid: number) => bts.data?.filter((b) => b.version_id === vid)
  const all = st.data?.strategies.flatMap((s) => s.versions.map((v) => ({ s, v }))) ?? []
  const diff = (v: Version) => { const p = all.find((x) => x.v.id === v.parent_id)?.v.params; return p ? Object.entries(v.params).filter(([k, x]) => p[k] !== x).map(([k, x]) => `${k}: ${p[k]} → ${x}`) : [] }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      {st.data?.strategies.map((s) => <Panel key={s.id} title={s.name} className="shrink-0">
        <p className="mb-2 text-[12px] text-text-2">{s.description}</p>
        <table className="w-full text-[12px]">
          <thead className="text-left text-[11px] text-text-2"><tr className="border-b border-line">{['', 'Version', 'Status', 'Changes from parent', 'Note', 'Backtests', 'Created', ''].map((h, i) => <th key={i} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
          <tbody>{s.versions.map((v) => <tr key={v.id} className="border-b border-line/50 align-top">
            <td className="px-2 py-1.5"><input type="checkbox" aria-label={`Compare v${v.version}`} checked={cmp.includes(v.id)} onChange={() => setCmp(cmp.includes(v.id) ? cmp.filter((x) => x !== v.id) : [...cmp, v.id].slice(-2))} className="accent-[var(--accent)]" /></td>
            <td className="px-2 py-1.5 font-mono">v{v.version}</td><td className="px-2"><Badge tone={statusTone(v.status)}>{v.status}</Badge></td>
            <td className="px-2 font-mono text-[11px]">{diff(v).join(', ') || (v.parent_id ? '—' : 'original rules')}</td>
            <td className="px-2 text-text-2">{v.note}</td><td className="px-2">{latest(v.id)?.length ?? 0}</td><td className="px-2 text-text-2">{fmtD(v.created_at)}</td>
            <td className="px-2">{v.status === 'validated' && <Btn onClick={() => adopt.mutate(v.id)} disabled={adopt.isPending}>Adopt as active</Btn>}</td>
          </tr>)}</tbody>
        </table>
        <details className="mt-2 text-[12px]"><summary className="cursor-pointer text-text-2">Current parameters</summary>
          <dl className="mt-1 grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-0.5">{Object.entries((s.versions.find((v) => v.status === 'active') ?? s.versions[0]).params).map(([k, x]) =>
            <Fragment key={k}><dt className="font-mono">{k}</dt><dd className="font-mono">{String(x)}</dd><dd className="text-text-2">{st.data?.param_docs[k]}</dd></Fragment>)}</dl></details>
      </Panel>)}
      <ErrorText error={adopt.error} />
      <Panel title="Compare versions" className="shrink-0">
        {cmp.length < 2 ? <p className="text-[12px] text-text-2">Tick two versions above to compare their stored backtests on the same market, timeframe and segment.</p> : <Compare ids={cmp} bts={bts.data ?? []} names={(id) => vname(st.data?.strategies, id)} />}
      </Panel>
    </div>
  )
}

function Compare({ ids, bts, names }: { ids: number[]; bts: Bt[]; names: (id: number) => string }) {
  const keys = useMemo(() => {
    const k = (b: Bt) => `${b.symbol}|${b.tf}|${b.segment}`
    const a = new Map(bts.filter((b) => b.version_id === ids[0]).map((b) => [k(b), b]))
    const c = new Map(bts.filter((b) => b.version_id === ids[1]).map((b) => [k(b), b]))
    return [...a.keys()].filter((x) => c.has(x)).map((x) => [x, a.get(x)!, c.get(x)!] as const)
  }, [ids, bts])
  if (!keys.length) return <p className="text-[12px] text-text-2">These versions have no backtests on a common market/timeframe/segment yet.</p>
  const rows: [string, (m: Metrics) => string][] = [['Trades', (m) => String(m.trades)], ['Win rate', (m) => `${m.win_rate ?? '—'}%`], ['Profit factor', pf],
    ['Expectancy / trade', (m) => fmtUsd(m.expectancy)], ['Max drawdown', (m) => fmtUsd(m.max_drawdown)], ['Net P&L', (m) => fmtUsd(m.net_pnl)]]
  return <div className="flex flex-col gap-3">{keys.map(([k, a, c]) => <table key={k} className="text-[12px]">
    <caption className="mb-1 text-left text-[11px] text-text-2">{k.replace(/\|/g, ' · ').replace(/_/g, ' ')} <Simulated /></caption>
    <thead><tr className="border-b border-line text-left text-[11px] text-text-2"><th className="px-2 py-1 font-medium">Metric</th><th className="px-2 font-medium">{names(ids[0])}</th><th className="px-2 font-medium">{names(ids[1])}</th></tr></thead>
    <tbody className="font-mono">{rows.map(([n, f]) => <tr key={n} className="border-b border-line/50"><td className="px-2 py-1 font-sans">{n}</td><td className="px-2">{f(a.metrics)}</td><td className="px-2">{f(c.metrics)}</td></tr>)}</tbody>
  </table>)}</div>
}

function Research() {
  const qc = useQueryClient()
  const { symbol, tf } = useSettings()
  const st = useStrategies()
  const [f, setF] = useState({ vid: 0, symbol, tf })
  useEffect(() => { const v = st.data?.strategies[0]?.versions.find((x) => x.status === 'active'); if (v && !f.vid) setF((x) => ({ ...x, vid: v.id })) }, [st.data]) // eslint-disable-line
  const exps = useQuery({ queryKey: ['experiments'], queryFn: () => api<Exp[]>('/api/research/experiments') })
  const propose = useMutation({ mutationFn: () => api<{ diagnostics: any[]; created: Exp[]; backtest_id: number }>('/api/research/hypotheses', { version_id: f.vid, symbol: f.symbol, tf: f.tf }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['experiments'] }); qc.invalidateQueries({ queryKey: ['backtests'] }) } })
  const evaluate = useMutation({ mutationFn: (id: number) => api<Exp>(`/api/research/experiments/${id}/evaluate`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['experiments'] }); qc.invalidateQueries({ queryKey: ['strategies'] }); qc.invalidateQueries({ queryKey: ['backtests'] }) } })
  const adopt = useMutation({ mutationFn: (id: number) => api(`/api/versions/${id}/adopt`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['strategies'] }) })
  const versions = st.data?.strategies.flatMap((s) => s.versions.map((v) => ({ s, v }))) ?? []
  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] gap-3">
      <Panel title="Find recurring issues">
        <div className="flex flex-col gap-2 text-[12px]">
          <ol className="list-decimal space-y-0.5 pl-4 text-text-2">
            <li>Backtest the version and review journal trades that used it.</li><li>Find mistakes that recur, with the numbers behind them.</li>
            <li>Turn each into one parameter change (a hypothesis).</li><li>Test it on the first 70% of history, validate on the unseen last 30%.</li>
            <li>Keep it only if it beats the current version out of sample. Old versions are never deleted.</li>
          </ol>
          <Field label="Strategy version"><select value={f.vid} onChange={(e) => setF({ ...f, vid: Number(e.target.value) })} className={inputCls}>
            {versions.map(({ s, v }) => <option key={v.id} value={v.id}>{s.name} v{v.version} ({v.status})</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Market"><input value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} className={inputCls} /></Field>
            <Field label="Timeframe"><select value={f.tf} onChange={(e) => setF({ ...f, tf: e.target.value })} className={inputCls}>{TFS.map((t) => <option key={t}>{t}</option>)}</select></Field>
          </div>
          <Btn kind="primary" onClick={() => propose.mutate()} disabled={propose.isPending || !f.vid}><FlaskConical size={12} />{propose.isPending ? 'Analysing…' : 'Generate hypotheses'}</Btn>
          <ErrorText error={propose.error} />
          {propose.data && <div className="rounded border border-line p-2">
            <p className="mb-1">Backtest #{propose.data.backtest_id}: {propose.data.diagnostics.length ? `${propose.data.diagnostics.length} recurring issue(s).` : 'no recurring issue met the evidence thresholds.'}</p>
            <p className="text-text-2">{propose.data.created.length} new hypothesis(es) created{propose.data.diagnostics.length && !propose.data.created.length ? ' (the same changes were already proposed)' : ''}.</p>
          </div>}
        </div>
      </Panel>
      <Panel title="Hypotheses and evaluations" bodyClass="overflow-auto p-3">
        <ErrorText error={evaluate.error || adopt.error} />
        {!exps.data?.length ? <Empty>No hypotheses yet. Generate them from a strategy version's results.</Empty> : <div className="flex flex-col gap-2">
          {exps.data.map((e) => <div key={e.id} className="rounded-md border border-line p-3 text-[12px]">
            <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Hypothesis #{e.id}</span>
              <Badge tone={e.status === 'accepted' ? 'bull' : e.status === 'rejected' ? 'bear' : 'warn'}>{e.status}</Badge>
              <span className="font-mono">{JSON.stringify(e.change)}</span><span className="text-text-2">on {vname(st.data?.strategies, e.base_version_id)} · {e.symbol} {e.tf} · {fmtT(e.created_at)}</span></div>
            <p className="mt-1 text-text-2">Evidence: {e.rationale}</p>
            {e.status === 'proposed' && <Btn className="mt-2" onClick={() => evaluate.mutate(e.id)} disabled={evaluate.isPending}>{evaluate.isPending && evaluate.variables === e.id ? 'Evaluating on unseen data…' : 'Evaluate (in-sample + out-of-sample)'}</Btn>}
            {e.verdict && <div className="mt-2">
              <ul className="mb-2 list-disc pl-4">{e.verdict.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p className="mb-1 text-[11px] text-text-2">Split at {fmtT(e.verdict.split_time)}: in-sample before, out-of-sample after. <Simulated /></p>
              <table className="text-[12px]"><thead><tr className="border-b border-line text-left text-[11px] text-text-2">
                {['', 'Trades', 'Win %', 'PF', 'Expectancy', 'Net P&L'].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
                <tbody className="font-mono">{[['base_in_sample', 'Current · in-sample'], ['cand_in_sample', 'Candidate · in-sample'], ['base_out_of_sample', 'Current · out-of-sample'], ['cand_out_of_sample', 'Candidate · out-of-sample']].map(([k, l]) => {
                  const m = e.verdict!.metrics[k]; return m && <tr key={k} className="border-b border-line/50"><td className="px-2 py-1 font-sans">{l}</td><td className="px-2">{m.trades}</td><td className="px-2">{m.win_rate ?? '—'}</td>
                    <td className="px-2">{pf(m)}</td><td className="px-2">{fmtUsd(m.expectancy)}</td><td className={cx('px-2', m.net_pnl >= 0 ? 'text-bull' : 'text-bear')}>{fmtUsd(m.net_pnl)}</td></tr> })}</tbody></table>
              {e.status === 'accepted' && e.candidate_version_id && versions.find((x) => x.v.id === e.candidate_version_id)?.v.status === 'validated' &&
                <Btn className="mt-2" kind="primary" onClick={() => adopt.mutate(e.candidate_version_id!)}>Adopt {vname(st.data?.strategies, e.candidate_version_id)} as active</Btn>}
            </div>}
          </div>)}
        </div>}
      </Panel>
    </div>
  )
}
