import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Page = 'charts' | 'analyst' | 'backtesting' | 'journal' | 'brain' | 'settings'
export type Theme = 'dark' | 'light'

export type Indicators = {
  sma: { on: boolean; period: number }; ema: { on: boolean; period: number }; vwap: { on: boolean }
  volume: { on: boolean }; rsi: { on: boolean; period: number }; macd: { on: boolean; fast: number; slow: number; signal: number }
}
export type ChartPrefs = { log: boolean; grid: boolean; magnet: boolean }

type Settings = {
  theme: Theme; collapsed: boolean; page: Page; symbol: string; tf: string
  ind: Indicators; prefs: ChartPrefs
  visionOpen: boolean; visionWidth: number; visionCats: Record<string, boolean>; watchlist: string[]; scanTfs: string[]
  set: (p: Partial<Omit<Settings, 'set'>>) => void
}

export const DEFAULT_IND: Indicators = {
  sma: { on: false, period: 20 }, ema: { on: false, period: 50 }, vwap: { on: false },
  volume: { on: true }, rsi: { on: false, period: 14 }, macd: { on: false, fast: 12, slow: 26, signal: 9 },
}

// AI Vision categories -> detection kinds
export const CATS: [string, string, string[]][] = [
  ['fvg', 'Fair Value Gaps', ['fvg']], ['ob', 'Order Blocks', ['order_block']], ['liq', 'Liquidity Zones', ['liquidity']],
  ['sweep', 'Liquidity Sweeps', ['sweep']], ['bos', 'Breaks of Structure', ['bos', 'choch']], ['mss', 'Market Structure Shifts', ['mss']],
  ['sr', 'Support & Resistance', ['sr']], ['sd', 'Supply & Demand', ['supply_demand']], ['imp', 'Important Candles', ['important']],
  ['pd', 'Premium / Discount & OTE', ['premium_discount', 'ote']], ['swing', 'Swing Points', ['swing']],
]
export const DEFAULT_CATS: Record<string, boolean> = Object.fromEntries(CATS.map(([k]) => [k, !['sd', 'imp', 'swing'].includes(k)]))
export const kindToCat = Object.fromEntries(CATS.flatMap(([k, , kinds]) => kinds.map((x) => [x, k])))

export const useSettings = create<Settings>()(persist(
  (set) => ({ theme: 'dark', collapsed: false, page: 'charts', symbol: 'MNQ', tf: '5m',
    ind: DEFAULT_IND, prefs: { log: false, grid: true, magnet: false },
    visionOpen: false, visionWidth: 340, visionCats: DEFAULT_CATS, watchlist: ['MNQ', 'MES', 'NQ', 'ES'], scanTfs: ['5m', '15m'],
    set: (p) => set(p) }),
  { name: 'vt-settings', partialize: ({ set: _s, ...rest }) => rest,
    merge: (saved, cur) => ({ ...cur, ...(saved as object), ind: { ...DEFAULT_IND, ...(saved as Partial<Settings>)?.ind } }) },
))

useSettings.subscribe((s) => { document.documentElement.dataset.theme = s.theme })

/** Session-only navigation state: a detection to reveal on the chart, and the analyst chat. */
type Nav = {
  focus: { symbol: string; tf: string; detId: string } | null
  chat: { role: 'user' | 'assistant'; content: string; error?: boolean }[]
  set: (p: Partial<Omit<Nav, 'set'>>) => void
}
export const useNav = create<Nav>()((set) => ({ focus: null, chat: [], set: (p) => set(p) }))

// Drawings are stored per symbol with real timestamps, so they survive timeframe changes.
// shortcut: browser storage only; move to the backend when user accounts land.
export type Pt = { t: number; p: number }
export type DrawingType = 'hline' | 'vline' | 'trend' | 'ray' | 'rect' | 'text' | 'fib'
export type Drawing = { id: string; type: DrawingType; pts: Pt[]; color: string; text?: string }

type DrawStore = {
  bySymbol: Record<string, Drawing[]>
  put: (sym: string, d: Drawing) => void
  remove: (sym: string, id: string) => void
  clear: (sym: string) => void
}

export const useDrawings = create<DrawStore>()(persist((set) => ({
  bySymbol: {},
  put: (sym, d) => set((s) => {
    const list = s.bySymbol[sym] ?? [], i = list.findIndex((x) => x.id === d.id)
    return { bySymbol: { ...s.bySymbol, [sym]: i < 0 ? [...list, d] : list.map((x) => (x.id === d.id ? d : x)) } }
  }),
  remove: (sym, id) => set((s) => ({ bySymbol: { ...s.bySymbol, [sym]: (s.bySymbol[sym] ?? []).filter((x) => x.id !== id) } })),
  clear: (sym) => set((s) => ({ bySymbol: { ...s.bySymbol, [sym]: [] } })),
}), { name: 'vt-drawings', partialize: (s) => ({ bySymbol: s.bySymbol }) }))
