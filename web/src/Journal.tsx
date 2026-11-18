import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CandlestickChart, History, Trash2 } from 'lucide-react'
import { api, fmtP, fmtT, fmtUsd, type Lesson, type StrategyRow, type Trade } from './api'
import { useSettings } from './store'
import { AiStatus } from './AiStatus'
import { Replay } from './Replay'
import { Badge, Btn, Empty, ErrorText, Metric, Panel, Simulated, cx, dirTone, inputCls } from './ui'

type Detail = { trade: Trade; review: { facts: any; narrative: string | null; created_at: number } | null; lessons: Lesson[] }

export function Journal() {
  const [q, setQ] = useState(''), [status, setStatus] = useState(''), [sym, setSym] = useState(''), [by, setBy] = useState('')
  const [sel, setSel] = useState<number | null>(null), [replay, setReplay] = useState<number | null>(null)
  const trades = useQuery({ queryKey: ['trades', 'list', q, status, sym], queryFn: () => api<Trade[]>(`/api/trades?q=${encodeURIComponent(q)}&status=${status}&symbol=${sym}`), refetchInterval: 30_000 })
  const all = useQuery({ queryKey: ['trades', 'all'], queryFn: () => api<Trade[]>('/api/trades'), refetchInterval: 30_000 })
  const st = useQuery({ queryKey: ['strategies'], queryFn: () => api<{ strategies: StrategyRow[] }>('/api/strategies') })
  const vname = (id: number | null) => { if (id == null) return 'Discretionary'; for (const s of st.data?.strategies ?? []) for (const v of s.versions) if (v.id === id) return `${s.name} v${v.version}`; return `#${id}` }
  const closed = (all.data ?? []).filter((t) => t.status === 'closed')
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length
  const net = closed.reduce((a, t) => a + (t.pnl ?? 0), 0)
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Simulated trades" value={all.data?.length ?? '—'} />
        <Metric label="Open" value={(all.data ?? []).filter((t) => t.status === 'open').length} />
        <Metric label="Win rate (closed)" value={closed.length ? `${((wins / closed.length) * 100).toFixed(1)}%` : '—'} />
        <Metric label="Simulated net P&L" value={fmtUsd(net)} tone={net >= 0 ? 'bull' : 'bear'} />
      </div>
      <div className={cx('grid min-h-0 flex-1 gap-3', sel ? 'grid-cols-[minmax(0,1fr)_420px]' : 'grid-cols-1')}>
        <Panel title={<span className="flex items-center gap-2">Paper-trading journal <Simulated /></span>} bodyClass="flex min-h-0 flex-col"
          right={<div className="flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search trades" aria-label="Search trades" className={cx(inputCls, 'w-40')} />
            <select value={by} onChange={(e) => setBy(e.target.value)} aria-label="Placed by" className={inputCls}><option value="">You + AI</option><option value="user">Placed by you</option><option value="ai">Placed by the AI</option></select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter" className={inputCls}><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option></select>
            <select value={sym} onChange={(e) => setSym(e.target.value)} aria-label="Market filter" className={inputCls}><option value="">All markets</option>
              {[...new Set((all.data ?? []).map((t) => t.symbol))].map((s) => <option key={s}>{s}</option>)}</select>
          </div>}>
          <div className="min-h-0 flex-1 overflow-auto">
            <ErrorText error={trades.error} />
            {trades.data && !trades.data.length ? <Empty>{all.data?.length ? 'No trades match the filters.' : 'No simulated trades yet. Open one from the chart toolbar with “Paper trade”, or let the AI trade live on the AI Analyst page.'}</Empty> :
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-text-2"><tr className="border-b border-line">
                  {['#', 'Date', 'Market', 'Contract', 'Side', 'Size', 'Entry', 'Exit', 'Stop', 'Target', 'P&L', 'Strategy', 'Status'].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                <tbody>{trades.data?.filter((t) => !by || (by === 'ai') === (t.source === 'ai')).map((t) => <tr key={t.id} onClick={() => setSel(t.id)} className={cx('cursor-pointer border-b border-line/50', sel === t.id ? 'bg-accent/10' : 'hover:bg-elevated/60')}>
                  <td className="px-2 py-1.5 text-text-2">{t.id}{t.source === 'ai' && <span className="ml-1"><Badge tone="accent">AI</Badge></span>}</td><td className="whitespace-nowrap px-2">{fmtT(t.entry_time)}</td><td className="px-2 font-semibold">{t.symbol} <span className="font-normal text-text-2">{t.tf}</span></td>
                  <td className="px-2 font-mono text-[11px]">{t.contract.split(' ')[0]}</td><td className="px-2"><Badge tone={dirTone(t.direction)}>{t.direction}</Badge></td><td className="px-2">{t.qty}</td>
                  <td className="px-2 font-mono">{fmtP(t.entry_price)}</td><td className="px-2 font-mono">{fmtP(t.exit_price)}</td><td className="px-2 font-mono">{fmtP(t.stop)}</td><td className="px-2 font-mono">{fmtP(t.target)}</td>
                  <td className={cx('px-2 font-mono', (t.pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{fmtUsd(t.pnl)}</td><td className="whitespace-nowrap px-2 text-text-2">{vname(t.version_id)}</td>
                  <td className="px-2">{t.status === 'open' ? <Badge tone="accent">open</Badge> : <span className="text-text-2">{t.exit_reason}</span>}</td>
                </tr>)}</tbody>
              </table>}
          </div>
        </Panel>
        {sel && <TradeDetail id={sel} vname={vname} onReplay={setReplay} onGone={() => setSel(null)} />}
      </div>
      {replay && <Replay id={replay} onClose={() => setReplay(null)} />}
    </div>
  )
}

function TradeDetail({ id, vname, onReplay, onGone }: { id: number; vname: (id: number | null) => string; onReplay: (id: number) => void; onGone: () => void }) {
  const qc = useQueryClient()
  const set = useSettings((s) => s.set)
  const d = useQuery({ queryKey: ['trade', id], queryFn: () => api<Detail>(`/api/trades/${id}`) })
  const [notes, setNotes] = useState('')
  useEffect(() => { if (d.data) setNotes(d.data.trade.notes) }, [d.data?.trade.id]) // eslint-disable-line
  const refresh = () => { qc.invalidateQueries({ queryKey: ['trade', id] }); qc.invalidateQueries({ queryKey: ['trades'] }) }
  const close = useMutation({ mutationFn: () => api(`/api/trades/${id}/close`, {}), onSuccess: refresh })
  const review = useMutation({ mutationFn: () => api(`/api/trades/${id}/review`, {}), onSuccess: refresh })
  const narr = useMutation({ mutationFn: () => api<{ ok: boolean; text: string }>(`/api/trades/${id}/narrative`, {}), onSuccess: refresh })
  const save = useMutation({ mutationFn: () => api(`/api/trades/${id}`, { notes }, 'PATCH'), onSuccess: refresh })
  const del = useMutation({ mutationFn: () => api(`/api/trades/${id}`, undefined, 'DELETE'), onSuccess: () => { refresh(); onGone() } })
  if (!d.data) return <Panel><Empty>{d.isPending ? 'Loading…' : <ErrorText error={d.error} />}</Empty></Panel>
  const { trade: t, review: rv, lessons } = d.data
  const f = rv?.facts
  return (
    <Panel title={<span className="flex items-center gap-2">Trade #{t.id} <Badge tone={dirTone(t.direction)}>{t.direction}</Badge> {t.status === 'open' ? <Badge tone="accent">open</Badge> : <Badge>{t.exit_reason}</Badge>}</span>}
      right={<Btn kind="ghost" onClick={onGone}>Close panel</Btn>} bodyClass="overflow-y-auto p-3">
      <div className="flex flex-col gap-3 text-[12px]">
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={() => set({ symbol: t.symbol, tf: t.tf, page: 'charts' })}><CandlestickChart size={12} />Open chart</Btn>
          <Btn onClick={() => onReplay(t.id)}><History size={12} />Replay</Btn>
          {t.status === 'open' && <Btn onClick={() => close.mutate()} disabled={close.isPending}>Close at market</Btn>}
          {t.status === 'closed' && <Btn kind="primary" onClick={() => review.mutate()} disabled={review.isPending}>{review.isPending ? 'Reviewing…' : rv ? 'Re-run AI review' : 'AI trade review'}</Btn>}
          <Btn kind="danger" onClick={() => confirm(`Delete trade #${t.id} and its review? This cannot be undone.`) && del.mutate()}><Trash2 size={12} /></Btn>
        </div>
        <ErrorText error={close.error || review.error || del.error} />
        <dl className="grid grid-cols-[110px_1fr] gap-y-1">
          {([['Market', `${t.symbol} · ${t.tf}`], ['Contract', t.contract], ['Strategy', vname(t.version_id)], ['Size', t.qty], ['Entry', `${fmtP(t.entry_price)} at ${fmtT(t.entry_time)}`],
            ['Stop / Target', `${fmtP(t.stop)} / ${fmtP(t.target)}`], ['Exit', t.exit_price ? `${fmtP(t.exit_price)} at ${fmtT(t.exit_time)}` : '—'], ['Simulated P&L', fmtUsd(t.pnl)], ['Price source', t.price_source]] as [string, any][]).map(([k, v]) =>
            <div key={k} className="contents"><dt className="text-text-2">{k}</dt><dd className="font-mono">{v}</dd></div>)}
        </dl>
        <div><div className="mb-1 text-[11px] font-medium text-text-2">Notes</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} className={cx(inputCls, 'h-auto w-full py-1')} />
          {notes !== t.notes && <Btn className="mt-1" onClick={() => save.mutate()}>Save notes</Btn>}</div>
        {t.analysis && <section><div className="mb-1 text-[11px] font-medium text-text-2">AI analysis recorded at entry</div>
          <p className="mb-1"><Badge tone={dirTone(t.analysis.summary?.bias)}>Bias: {t.analysis.summary?.bias}</Badge></p>
          <ul className="list-disc pl-4">{t.analysis.summary?.facts.map((x) => <li key={x}>{x}</li>)}</ul>
          {t.analysis.detections.map((x) => <p key={x.id} className="mt-1"><span className="font-medium">{x.label}</span> <span className="text-text-2">{x.reason}</span></p>)}
        </section>}
        {f && <section className="rounded-md border border-line p-2.5"><div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-text-2">AI trade review (rule-based facts)<span>{fmtT(rv!.created_at)}</span></div>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1">
            <dt className="text-text-2">Setup</dt><dd>Bias {f.setup.bias_at_entry ?? '—'}, {f.setup.zone_at_entry ?? '—'}; {f.setup.patterns.length} recorded pattern(s)</dd>
            <dt className="text-text-2">Expected</dt><dd>{f.expected.direction} to {fmtP(f.expected.target)}, risk to {fmtP(f.expected.stop)} (planned {f.expected.planned_rr}R)</dd>
            <dt className="text-text-2">Actual outcome</dt><dd>{f.outcome.exit_reason} at {fmtP(f.outcome.exit)}, {f.outcome.r}R, {fmtUsd(f.outcome.pnl)} after {f.outcome.candles_held} candle(s)</dd>
            <dt className="text-text-2">Path</dt><dd>Best {f.path.mfe_r ?? '—'}R ({fmtP(f.path.mfe_points)} pts), worst {fmtP(f.path.mae_points)} pts against</dd>
            <dt className="text-text-2">After exit</dt><dd>{f.after_exit.target_reached_after_exit ? 'Target was reached after the exit' : `Target not reached in the next ${f.after_exit.candles_checked} candles`}</dd>
            <dt className="text-text-2">Invalidated</dt><dd>{f.invalidated.length ? f.invalidated.map((x: any) => x.label).join(', ') : 'No opposing structure shift during the trade'}</dd>
          </dl>
          {f.note && <p className="mt-1 text-text-2">{f.note}</p>}
          <div className="mt-2 text-[11px] font-medium text-text-2">Possible lessons (saved to the AI Brain)</div>
          {lessons.length ? <ul className="list-disc pl-4">{lessons.map((l) => <li key={l.id}><span className="font-mono text-[11px]">{l.code}</span> — {l.text}</li>)}</ul> : <p className="text-text-2">No rule-based lesson applied to this trade.</p>}
          <div className="mt-2 flex items-center justify-between"><span className="text-[11px] font-medium text-text-2">Written summary (Claude)</span><AiStatus /></div>
          {rv!.narrative ? <p className="mt-1 whitespace-pre-wrap leading-relaxed">{rv!.narrative}</p> : <Btn className="mt-1" onClick={() => narr.mutate()} disabled={narr.isPending}>{narr.isPending ? 'Writing…' : 'Write summary'}</Btn>}
          {narr.data && !narr.data.ok && <p className="mt-1 text-bear">{narr.data.text}</p>}<ErrorText error={narr.error} />
        </section>}
      </div>
    </Panel>
  )
}
