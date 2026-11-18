import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } })

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, body === undefined && !method ? undefined : {
    method: method ?? 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!r.ok) {
    const d = j?.detail
    throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: any) => x.msg).join('; ') : `${r.status} ${r.statusText}`)
  }
  return j as T
}

// ---- shared types
export type Cond = { name: string; met: boolean; value?: string; detail?: string }
export type Detection = {
  id: string; kind: string; label: string; dir: 'bull' | 'bear' | null; t0: number; t1: number; confirmed_at: number
  top: number; bottom: number; candles: number[]; reason: string; conditions: Cond[]
  filled_at?: number | null; touched_at?: number | null; swept_at?: number | null; invalidated_at?: number | null
  level?: number; extreme?: number; role?: string; name?: string; equilibrium?: number; zone?: string; side?: string
}
export type Step = { name: string; detail: string; ms: number; at: number }
export type Summary = {
  bias: string; close: number; time: number; atr: number; ema20: number | null; ema50: number | null
  pd: { equilibrium: number; zone: string; high: number; low: number } | null
  facts: string[]; invalidation: { price: number; text: string } | null; counts: Record<string, number>
}
export type StrategyCheck = { strategy: string; version: number; version_id: number; status: string; conditions: Cond[]; det_id?: string | null }
export type Analysis = {
  symbol: string; tf: string; provider: { status: string; label: string }; last_closed: number; summary: Summary | null
  steps: Step[]; issues: string[]; detections: Detection[]; strategies: StrategyCheck[]; run_id?: number
}
export type Metrics = {
  trades: number; wins: number; losses: number; win_rate: number | null; profit_factor: number | 'inf' | null
  max_drawdown: number; max_drawdown_pct: number; avg_win: number; avg_loss: number; avg_rr: number | null; avg_r: number | null
  expectancy: number | null; net_pnl: number; end_equity: number; start_time: number | null; end_time: number | null
}
export type Version = { id: number; strategy_id: number; version: number; params: Record<string, any>; parent_id: number | null; status: string; note: string; created_at: number }
export type StrategyRow = { id: number; key: string; name: string; description: string; versions: Version[] }
export type Trade = {
  id: number; symbol: string; contract: string; tf: string; direction: 'long' | 'short'; qty: number; entry_time: number; entry_price: number
  stop: number; target: number; exit_time: number | null; exit_price: number | null; exit_reason: string | null; status: 'open' | 'closed'
  pnl: number | null; version_id: number | null; notes: string; price_source: string; created_at: number; source?: string | null
  analysis?: { summary: Summary; steps: Step[]; detections: Detection[]; last_closed: number }
}
export type Lesson = { id: number; source: string; code: string; text: string; evidence: any; created_at: number }

export const fmtP = (n: number | null | undefined, d = 2) => (n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
export const fmtT = (t: number | null | undefined) => (t == null ? '—' : new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
export const fmtD = (t: number | null | undefined) => (t == null ? '—' : new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
