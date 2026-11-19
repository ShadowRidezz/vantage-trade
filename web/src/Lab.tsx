import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Play, Radio } from 'lucide-react'
import { api, fmtT } from './api'
import { useSettings } from './store'
import { Badge, Btn, Empty, ErrorText, Field, Panel, cx, inputCls } from './ui'

type M = { trades: number; win_rate: number | null; avg_r: number | null; profit_factor: number | null; t: number | null; net_pnl: number }
type Row = { key: string; name: string; params: Record<string, any> | null; older: M | null; newer: M | null; approved: boolean; reasons: string[] }
type Run = { id: number; symbol: string; tf: string; bars: number; split_time: number; seconds: number; results: Row[]; created_at: number }
type Lab = {
  state: { running: boolean; done: number; total: number; step: string; error: string | null; markets?: number; market_no?: number; symbol: string | null; tf: string | null }
  gate: Record<string, number>; grid: Record<string, any[]>; split: number
  overview: { id: number; symbol: string; tf: string; created_at: number; seconds: number; approved: { name: string; newer: M }[] }[]
  run: Run | null
}
type Status = { symbol: string; tf: string; enabled: boolean }

const TFS = ['5m', '15m', '1H']
const ALL = ['MNQ', 'MES', 'NQ', 'ES'].flatMap((s) => TFS.map((t) => [s, t]))
const r2 = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`)
const settingsText = (p: Record<string, any>) => [`${p.rr}R target`, p.htf_filter ? 'with 1H trend' : 'any 1H trend',
  p.session === 'rth' ? 'NY session' : 'any time', p.at_level ? 'at support/resistance' : null].filter(Boolean).join(' · ')

export function AiLab() {
  const qc = useQueryClient()
  const g = useSettings()
  const st = useQuery({ queryKey: ['ai-status'], queryFn: () => api<Status>('/api/ai-trader/status'), refetchInterval: 5000 })
  const [sel, setSel] = useState<{ symbol: string; tf: string }>({ symbol: g.symbol, tf: TFS.includes(g.tf) ? g.tf : '5m' })
  useEffect(() => { if (st.data && sel.symbol === g.symbol) setSel({ symbol: st.data.symbol, tf: st.data.tf }) }, [st.data?.symbol, st.data?.tf]) // eslint-disable-line
  const lab = useQuery({ queryKey: ['lab', sel.symbol, sel.tf], queryFn: () => api<Lab>(`/api/lab?symbol=${encodeURIComponent(sel.symbol)}&tf=${sel.tf}`),
    refetchInterval: (q) => (q.state.data?.state.running ? 700 : 15000) })
  const start = useMutation({ mutationFn: (targets: string[][]) => api('/api/lab/run', { targets }), onSuccess: () => qc.invalidateQueries({ queryKey: ['lab'] }) })
  const useLive = useMutation({ mutationFn: (m: { symbol: string; tf: string }) => api('/api/ai-trader', m, 'PUT'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-status'] }); qc.invalidateQueries({ queryKey: ['ai-trader'] }) } })
  const s = lab.data?.state, run = lab.data?.run
  const wasRunning = useState({ v: false })[0]
  useEffect(() => { if (wasRunning.v && s && !s.running) qc.invalidateQueries({ queryKey: ['ai-status'] }); wasRunning.v = !!s?.running }, [s?.running]) // eslint-disable-line
  const live = st.data && `${st.data.symbol} ${st.data.tf}`
  const variants = lab.data ? Object.values(lab.data.grid).reduce((n, v) => n * v.length, 1) : 0
  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="AI Lab">
          <p className="mb-2 text-[12px] text-text-2">The AI backtests every strategy with {variants || 'many'} settings each in a few seconds. It tunes on the older {Math.round((lab.data?.split ?? 0.6) * 100)}% of the candles and then checks the winner on the newer part it never saw. The live AI only trades strategies that pass.</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Market"><input value={sel.symbol} onChange={(e) => setSel({ ...sel, symbol: e.target.value.toUpperCase() })} className={inputCls} /></Field>
            <Field label="Timeframe"><select value={sel.tf} onChange={(e) => setSel({ ...sel, tf: e.target.value })} className={inputCls}>{TFS.map((t) => <option key={t}>{t}</option>)}</select></Field>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            <Btn kind="primary" onClick={() => start.mutate([[sel.symbol, sel.tf]])} disabled={!!s?.running || start.isPending}><Play size={12} />Test {sel.symbol} {sel.tf}</Btn>
            <Btn onClick={() => start.mutate(ALL)} disabled={!!s?.running || start.isPending}><FlaskConical size={12} />Test every market (MNQ, MES, NQ, ES × 5m, 15m, 1H)</Btn>
          </div>
          {s?.running && <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded bg-elevated"><div className="h-full bg-accent transition-[width]" style={{ width: `${s.total ? (100 * s.done) / s.total : 3}%` }} /></div>
            <p className="mt-1 text-[11px] text-text-2">{s.markets && s.markets > 1 ? `Market ${s.market_no} of ${s.markets} · ` : ''}{s.symbol} {s.tf} · {s.step}</p>
          </div>}
          {s?.error && !s.running && <p className="mt-2 text-[11px] text-bear">{s.error}</p>}
          <ErrorText error={start.error ?? useLive.error} />
        </Panel>
        <Panel title="Markets tested" className="min-h-0 flex-1" bodyClass="overflow-auto">
          {lab.data?.overview.map((o) => { const here = live === `${o.symbol} ${o.tf}`; return (
            <div key={o.id} className={cx('flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-elevated', sel.symbol === o.symbol && sel.tf === o.tf && 'bg-accent/10')}>
              <button className="min-w-0 flex-1 text-left" onClick={() => setSel({ symbol: o.symbol, tf: o.tf })}>
                <span className="font-medium">{o.symbol} {o.tf}</span>{here && <span className="ml-1.5 text-[10px] text-bull">● live AI</span>}
                <span className={cx('block truncate text-[11px]', o.approved.length ? 'text-bull' : 'text-text-2')}>
                  {o.approved.length ? `${o.approved.length} approved: ${o.approved.map((a) => a.name).join(', ')}` : 'Nothing approved'}</span>
              </button>
              {!here && o.approved.length > 0 && <Btn onClick={() => useLive.mutate({ symbol: o.symbol, tf: o.tf })} disabled={useLive.isPending} title="Move the live AI to this market"><Radio size={12} />Trade live</Btn>}
            </div>) })}
          {lab.data && !lab.data.overview.length && <Empty>No markets tested yet.</Empty>}
        </Panel>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        {!run ? <Panel><Empty>{lab.isLoading ? 'Loading…' : `${sel.symbol} ${sel.tf} has not been tested yet. Press Test.`}</Empty></Panel> : <>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="font-semibold">{run.symbol} {run.tf}</span>
            <span className="text-text-2">{run.results.length} strategies × {variants} settings on {run.bars.toLocaleString()} candles in {run.seconds}s · tuned on candles before {fmtT(run.split_time)}, checked after · tested {fmtT(run.created_at)}</span>
            {live === `${run.symbol} ${run.tf}` ? <Badge tone={run.results.some((r) => r.approved) ? 'bull' : 'muted'}>{run.results.some((r) => r.approved) ? 'Live AI trades the approved ones' : 'Live AI market: nothing approved, no trades'}</Badge>
              : run.results.some((r) => r.approved) && <Btn onClick={() => useLive.mutate({ symbol: run.symbol, tf: run.tf })} disabled={useLive.isPending}><Radio size={12} />Trade these live</Btn>}
          </div>
          <Panel title="Results (simulated)" bodyClass="overflow-auto p-0">
            <table className="w-full text-[12px]">
              <thead className="text-left text-[11px] text-text-2"><tr className="border-b border-line">
                <th className="px-3 py-2">Strategy</th><th className="px-2">Verdict</th><th className="px-2">Best settings (picked on older data)</th>
                <th className="px-2 text-right">Older data</th><th className="px-2 text-right">Unseen data</th><th className="px-2 text-right">Win %</th>
                <th className="px-2 text-right">Profit factor</th><th className="px-3">Why</th></tr></thead>
              <tbody>{run.results.map((r) => <tr key={r.key} className="border-b border-line/50 align-top">
                <td className="px-3 py-1.5 font-medium">{r.name}</td>
                <td className="px-2 py-1.5"><Badge tone={r.approved ? 'bull' : 'muted'}>{r.approved ? 'Approved' : 'Rejected'}</Badge></td>
                <td className="px-2 py-1.5 text-text-2">{r.params ? settingsText(r.params) : '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono">{r.older ? `${r.older.trades} · ${r2(r.older.avg_r)}` : '—'}</td>
                <td className={cx('px-2 py-1.5 text-right font-mono', (r.newer?.avg_r ?? 0) > 0 ? 'text-bull' : r.newer?.trades ? 'text-bear' : '')}>{r.newer ? `${r.newer.trades} · ${r2(r.newer.avg_r)}` : '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono">{r.newer?.win_rate == null ? '—' : `${Math.round(r.newer.win_rate)}%`}</td>
                <td className="px-2 py-1.5 text-right font-mono">{r.newer?.profit_factor == null ? '—' : r.newer.profit_factor.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-[11px] text-text-2">{r.reasons.join(' ')}</td></tr>)}</tbody>
            </table>
          </Panel>
          {lab.data && <p className="text-[11px] text-text-2">
            Approved means: on the older data at least {lab.data.gate.is_trades} trades averaging at least {r2(lab.data.gate.is_avg_r)}; on the unseen data at least {lab.data.gate.oos_trades} trades,
            at least {r2(lab.data.gate.oos_avg_r)} per trade, a profit factor of {lab.data.gate.oos_pf}+ and an average at least {lab.data.gate.oos_t} standard error above zero.
            R = the amount risked on a trade. This filters out setups with no evidence; it cannot make any trade certain. The live AI re-tests its market every 3 hours.</p>}
        </>}
      </div>
    </div>
  )
}
