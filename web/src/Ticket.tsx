import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LineStyle, type IPriceLine, type ISeriesApi } from 'lightweight-charts'
import { api, fmtP, type StrategyRow, type Trade } from './api'
import { useSettings } from './store'
import { Btn, ErrorText, Field, inputCls, cx } from './ui'
import type { Bar } from './indicators'

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

export function useOpenTrades(symbol: string) {
  return useQuery({ queryKey: ['trades', 'open', symbol], queryFn: () => api<Trade[]>(`/api/trades?status=open&symbol=${encodeURIComponent(symbol)}`), refetchInterval: 30_000 })
}

/** Entry / stop / target lines for open paper trades on this symbol. */
export function useTradeLines(series: ISeriesApi<'Candlestick'> | undefined, trades: Trade[] | undefined, theme: string) {
  useEffect(() => {
    if (!series || !trades) return
    const lines: IPriceLine[] = []
    for (const t of trades) {
      const mk = (price: number, color: string, title: string) => lines.push(series.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }))
      mk(t.entry_price, css('--text-2'), `#${t.id} ${t.direction} entry`)
      mk(t.stop, css('--bear'), `#${t.id} stop`)
      mk(t.target, css('--bull'), `#${t.id} target`)
    }
    return () => { try { lines.forEach((l) => series.removePriceLine(l)) } catch { /* chart already removed on unmount */ } }
  }, [series, trades, theme])
}

export function PaperTicket({ symbol, tf, bars, onClose }: { symbol: string; tf: string; bars: Bar[]; onClose: () => void }) {
  const qc = useQueryClient()
  const set = useSettings((s) => s.set)
  const last = bars.at(-1)
  const atr = bars.length > 15 ? bars.slice(-14).reduce((a, b, i, arr) => a + Math.max(b.high - b.low, i ? Math.abs(b.high - arr[i - 1].close) : 0, i ? Math.abs(b.low - arr[i - 1].close) : 0), 0) / 14 : 0
  const [dir, setDir] = useState<'long' | 'short'>('long')
  const [qty, setQty] = useState(1)
  const r = (n: number) => Math.round(n * 4) / 4
  const [stop, setStop] = useState(''), [target, setTarget] = useState(''), [notes, setNotes] = useState(''), [vid, setVid] = useState('')
  useEffect(() => { if (last) { setStop(String(r(last.close - (dir === 'long' ? 1 : -1) * atr))); setTarget(String(r(last.close + (dir === 'long' ? 2 : -2) * atr))) } }, [dir, symbol]) // eslint-disable-line
  const strat = useQuery({ queryKey: ['strategies'], queryFn: () => api<{ strategies: StrategyRow[] }>('/api/strategies') })
  const m = useMutation({
    mutationFn: () => api<Trade>('/api/trades', { symbol, tf, direction: dir, qty, stop: Number(stop), target: Number(target), notes, version_id: vid ? Number(vid) : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trades'] }),
  })
  return (
    <div className="absolute right-0 top-9 z-30 w-72 rounded-md border border-line bg-panel p-3 shadow-lg shadow-black/20">
      <div className="mb-2 flex items-center justify-between"><span className="text-[12px] font-semibold">Paper trade · {symbol}</span>
        <span className="text-[10px] text-text-2">simulated, delayed price</span></div>
      {m.data ? <div className="flex flex-col gap-2 text-[12px]">
        <p>Opened #{m.data.id}: {m.data.direction} {m.data.qty} {m.data.symbol} at <span className="font-mono">{fmtP(m.data.entry_price)}</span>.</p>
        <p className="text-text-2">{m.data.contract}</p>
        <div className="flex gap-2"><Btn kind="primary" onClick={() => set({ page: 'journal' })}>Open journal</Btn><Btn onClick={onClose}>Close</Btn></div>
      </div> : <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
        <div className="grid grid-cols-2 gap-1 rounded border border-line p-0.5">
          {(['long', 'short'] as const).map((d) => <button type="button" key={d} onClick={() => setDir(d)} aria-pressed={dir === d}
            className={cx('h-7 rounded text-[12px] font-medium capitalize', dir === d ? (d === 'long' ? 'bg-bull text-white' : 'bg-bear text-white') : 'text-text-2')}>{d === 'long' ? 'Buy / Long' : 'Sell / Short'}</button>)}
        </div>
        <p className="text-[11px] text-text-2">Market entry at the latest delayed price (last {fmtP(last?.close)}).</p>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Qty"><input type="number" min={1} max={1000} value={qty} onChange={(e) => setQty(Math.max(1, Math.round(Number(e.target.value))))} className={inputCls} /></Field>
          <Field label="Stop"><input required type="number" step="any" value={stop} onChange={(e) => setStop(e.target.value)} className={inputCls} /></Field>
          <Field label="Target"><input required type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls} /></Field>
        </div>
        <Field label="Strategy (optional)">
          <select value={vid} onChange={(e) => setVid(e.target.value)} className={inputCls}>
            <option value="">None — discretionary</option>
            {strat.data?.strategies.flatMap((s) => s.versions.filter((v) => v.status === 'active').map((v) => <option key={v.id} value={v.id}>{s.name} v{v.version}</option>))}
          </select>
        </Field>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} className={cx(inputCls, 'h-auto py-1')} /></Field>
        <ErrorText error={m.error} />
        <div className="flex gap-2"><Btn type="submit" kind="primary" disabled={m.isPending}>{m.isPending ? 'Opening…' : 'Open paper trade'}</Btn><Btn onClick={onClose}>Cancel</Btn></div>
      </form>}
    </div>
  )
}
