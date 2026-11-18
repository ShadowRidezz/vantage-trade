import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, RefreshCw, Send, X } from 'lucide-react'
import { api, fmtT } from './api'
import { useNav, useSettings } from './store'
import { AiStatus } from './AiStatus'
import { AiTradesChart } from './AiTradesChart'
import { Badge, Btn, Empty, ErrorText, Panel, cx, dirTone, inputCls } from './ui'

export const TFS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D']
const SUGGEST = ['What is the current market structure?', 'Why did you identify the most recent FVG?', 'What liquidity levels are nearby?',
  'What changed during the last five candles?', 'How have similar setups performed historically?']

type ScanRow = { symbol: string; tf: string; status: string; error?: string; bias?: string; zone?: string; close?: number; last_closed?: number; ran_at?: number
  patterns?: { id: string; kind: string; label: string; dir: string | null; time: number }[] }

export function Analyst() {
  const { symbol, tf } = useSettings()
  const [mkt, setMkt] = useState({ symbol, tf })
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,0.75fr)_minmax(0,1.25fr)] xl:overflow-hidden">
      <Scanner onPick={(s, t) => setMkt({ symbol: s, tf: t })} />
      <AiTradesChart mkt={mkt} setMkt={setMkt} className="min-h-[520px] xl:col-start-1 xl:row-start-2 xl:min-h-0" />
      <Chat mkt={mkt} className="min-h-[560px] xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:min-h-0" />
    </div>
  )
}

function Scanner({ onPick }: { onPick: (s: string, tf: string) => void }) {
  const { watchlist, scanTfs, set } = useSettings()
  const nav = useNav()
  const [add, setAdd] = useState(''), [auto, setAuto] = useState(false)
  const scan = useMutation({ mutationFn: () => api<ScanRow[]>('/api/scan', { symbols: watchlist, tfs: scanTfs }) })
  useEffect(() => { scan.mutate() }, []) // eslint-disable-line
  useEffect(() => { if (!auto) return; const i = setInterval(() => scan.mutate(), 60_000); return () => clearInterval(i) }, [auto]) // eslint-disable-line
  const open = (s: string, t: string, detId?: string) => {
    if (detId) nav.set({ focus: { symbol: s, tf: t, detId } })
    set({ symbol: s, tf: t, page: 'charts', ...(detId ? { visionOpen: true } : {}) })
  }
  return (
    <Panel title="Market Scanner" className="min-h-[340px] xl:min-h-0" bodyClass="flex min-h-0 flex-col" right={<div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11px] text-text-2"><input type="checkbox" checked={auto} onChange={() => setAuto(!auto)} className="accent-[var(--accent)]" />Every 60s</label>
      <Btn onClick={() => scan.mutate()} disabled={scan.isPending}><RefreshCw size={12} className={scan.isPending ? 'animate-spin' : ''} />Scan</Btn></div>}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {watchlist.map((s) => <span key={s} className="flex h-6 items-center gap-1 rounded border border-line pl-2 pr-1 text-[12px]">{s}
          <button aria-label={`Remove ${s}`} onClick={() => set({ watchlist: watchlist.filter((x) => x !== s) })} className="text-text-2 hover:text-bear"><X size={12} /></button></span>)}
        <form className="flex" onSubmit={(e) => { e.preventDefault(); const q = add.trim().toUpperCase(); if (/^[A-Z0-9.\-^]{1,12}$/.test(q) && !watchlist.includes(q) && watchlist.length < 12) set({ watchlist: [...watchlist, q] }); setAdd('') }}>
          <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add symbol" aria-label="Add symbol" className={cx(inputCls, 'h-6 w-24')} />
          <button type="submit" aria-label="Add" className="ml-1 grid size-6 place-items-center rounded text-text-2 hover:bg-elevated"><Plus size={13} /></button>
        </form>
        <span className="mx-1 h-4 w-px bg-line" />
        {TFS.map((t) => <button key={t} aria-pressed={scanTfs.includes(t)} onClick={() => {
          const next = scanTfs.includes(t) ? scanTfs.filter((x) => x !== t) : [...scanTfs, t].slice(-4); if (next.length) set({ scanTfs: next }) }}
          className={cx('h-6 rounded px-1.5 font-mono text-[11px]', scanTfs.includes(t) ? 'bg-accent/12 text-accent' : 'text-text-2 hover:text-text')}>{t}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ErrorText error={scan.error} />
        {!scan.data && scan.isPending ? <Empty>Scanning {watchlist.length} markets…</Empty> : <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-text-2"><tr className="border-b border-line">
            {['Symbol', 'TF', 'Detected patterns (last 10 candles)', 'Bias', 'Detection time', 'Status'].map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr></thead>
          <tbody>{scan.data?.map((r) => <tr key={r.symbol + r.tf} onClick={() => onPick(r.symbol, r.tf)} className="cursor-pointer border-b border-line/60 hover:bg-elevated/60">
            <td className="px-3 py-1.5 font-semibold"><button onClick={(e) => { e.stopPropagation(); open(r.symbol, r.tf) }} className="hover:text-accent">{r.symbol}</button></td>
            <td className="px-3 font-mono">{r.tf}</td>
            <td className="px-3"><div className="flex flex-wrap gap-1 py-1">{r.patterns?.slice(0, 4).map((p) =>
              <button key={p.id} title="Open on chart" onClick={(e) => { e.stopPropagation(); open(r.symbol, r.tf, p.id) }}><Badge tone={dirTone(p.dir)}>{p.label}</Badge></button>)}
              {r.status === 'ok' && !r.patterns?.length && <span className="text-text-2">None</span>}</div></td>
            <td className="px-3">{r.bias && <Badge tone={dirTone(r.bias)}>{r.bias}</Badge>}</td>
            <td className="px-3 font-mono text-text-2">{r.patterns?.[0] ? fmtT(r.patterns[0].time) : '—'}</td>
            <td className="px-3">{r.status === 'ok' ? <span className="text-text-2">Analysed {fmtT(r.ran_at)}</span> : <span className="text-bear">{r.error}</span>}</td>
          </tr>)}</tbody>
        </table>}
      </div>
    </Panel>
  )
}

function Chat({ mkt, className }: { mkt: { symbol: string; tf: string }; className?: string }) {
  const { chat, set } = useNav()
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const send = useMutation({
    mutationFn: (msgs: typeof chat) => api<{ ok: boolean; text: string }>('/api/chat', { ...mkt, messages: msgs.filter((m) => !m.error).map(({ role, content }) => ({ role, content })) }),
    onSuccess: (r, msgs) => set({ chat: [...msgs, { role: 'assistant', content: r.text, error: !r.ok }] }),
    onError: (e, msgs) => set({ chat: [...msgs, { role: 'assistant', content: (e as Error).message, error: true }] }),
  })
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [chat.length, send.isPending])
  const ask = (q: string) => { if (!q.trim() || send.isPending) return; const msgs = [...chat, { role: 'user' as const, content: q.trim() }]; set({ chat: msgs }); setText(''); send.mutate(msgs) }
  return (
    <Panel className={className} title={<span className="flex items-center gap-2">AI Chat <span className="font-mono text-text-2">{mkt.symbol} · {mkt.tf}</span></span>}
      right={<div className="flex items-center gap-2"><AiStatus />{chat.length > 0 && <Btn kind="ghost" onClick={() => set({ chat: [] })}>Clear</Btn>}</div>} bodyClass="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!chat.length && <div className="flex flex-col gap-2 py-2 text-[12px]">
          <p className="text-text-2">Ask anything about this chart. You'll get a short, plain answer based only on this market's data.</p>
          <div className="flex flex-wrap gap-1.5">{SUGGEST.map((q) => <button key={q} onClick={() => ask(q)} className="rounded border border-line px-2 py-1 text-left hover:bg-elevated">{q}</button>)}</div>
        </div>}
        {chat.map((m, i) => <div key={i} className={cx('mb-3 max-w-[88%] rounded-lg px-3.5 py-2.5 text-[13.5px] leading-6 whitespace-pre-wrap',
          m.role === 'user' ? 'ml-auto bg-accent/12' : m.error ? 'border border-bear/40 text-bear' : 'border border-line bg-bg')}>{m.content}</div>)}
        {send.isPending && <p className="text-[12px] text-text-2">Reading the analysis…</p>}
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t border-line p-2" onSubmit={(e) => { e.preventDefault(); ask(text) }}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder={`Ask about ${mkt.symbol} ${mkt.tf}…`} aria-label="Message" className={cx(inputCls, 'h-8 flex-1')} />
        <Btn type="submit" kind="primary" disabled={!text.trim() || send.isPending} className="h-8"><Send size={13} />Send</Btn>
      </form>
    </Panel>
  )
}

