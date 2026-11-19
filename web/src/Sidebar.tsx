import { CandlestickChart, Sparkles, History, BookOpen, Network, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useSettings, type Page } from './store'
import { api } from './api'

const NAV: [Page, string, typeof Sparkles][] = [
  ['charts', 'Charts', CandlestickChart], ['analyst', 'AI Analyst', Sparkles], ['backtesting', 'Backtesting', History],
  ['journal', 'Journal', BookOpen], ['brain', 'AI Brain', Network],
]

type AiStatus = { enabled: boolean; symbol: string; tf: string; scanning: boolean; error: string | null; lab_running: boolean; approved: string[]; lab_done: boolean }

// Always-visible light: green and pulsing while the AI is checking the chart every 20 s.
function AiDot({ collapsed, open }: { collapsed: boolean; open: () => void }) {
  const q = useQuery({ queryKey: ['ai-status'], queryFn: () => api<AiStatus>('/api/ai-trader/status'), refetchInterval: 5000, staleTime: 0 })
  const s = q.data
  const [tone, title, sub] = !s ? ['bg-text-2', 'AI starting', ''] as const
    : !s.enabled ? ['bg-text-2', 'AI paused', 'Not scanning'] as const
    : s.error ? ['bg-bear', 'AI check failed', s.error] as const
    : !s.scanning ? ['bg-warn', 'AI starting', `${s.symbol} ${s.tf}`] as const
    : ['bg-bull', `AI scanning ${s.symbol} ${s.tf}`, s.lab_running ? 'AI Lab is testing strategies…'
      : s.approved.length ? `Trading ${s.approved.length} approved ${s.approved.length > 1 ? 'strategies' : 'strategy'}` : s.lab_done ? 'Nothing passed the Lab here: no trades' : 'Waiting for the AI Lab'] as const
  const live = s?.enabled && s.scanning && !s.error
  return (
    <button onClick={open} title={`${title}${sub ? ` · ${sub}` : ''}`} aria-label={title}
      className={`mb-3 flex items-center gap-2.5 rounded-md border border-line px-2.5 py-2 text-left hover:bg-elevated ${collapsed ? 'justify-center' : ''}`}>
      <span className="relative flex size-2.5 shrink-0">
        {live && <span className={`absolute inline-flex size-full animate-ping rounded-full ${tone} opacity-60`} />}
        <span className={`relative inline-flex size-2.5 rounded-full ${tone}`} />
      </span>
      {!collapsed && <span className="min-w-0 leading-tight"><span className="block truncate text-[12px] font-medium">{title}</span>
        {sub && <span className="block truncate text-[11px] text-text-2">{sub}</span>}</span>}
    </button>
  )
}

export function Sidebar() {
  const { collapsed, page, set } = useSettings()
  const item = ([id, label, Icon]: (typeof NAV)[number]) => (
    <button key={id} onClick={() => set({ page: id })} title={collapsed ? label : undefined} aria-current={page === id ? 'page' : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-100 ${
        page === id ? 'bg-accent/12 text-text font-medium' : 'text-text-2 hover:bg-elevated hover:text-text'} ${collapsed ? 'justify-center' : ''}`}>
      <Icon size={16} strokeWidth={1.75} className={page === id ? 'text-accent' : ''} />
      {!collapsed && label}
    </button>
  )
  return (
    <nav className={`flex shrink-0 flex-col border-r border-line bg-sidebar p-2.5 transition-[width] duration-150 ${collapsed ? 'w-[68px]' : 'w-[230px]'}`}>
      <div className={`mb-5 mt-2 select-none leading-none ${collapsed ? 'text-center' : 'px-2.5'}`}>
        {collapsed ? <div className="text-[15px] font-bold tracking-[0.08em]">VT</div> : <>
          <div className="text-[17px] font-bold tracking-[0.14em]">VANTAGE</div>
          <div className="mt-1 text-[9px] font-medium tracking-[0.62em] text-text-2">TRADE</div>
        </>}
      </div>
      <AiDot collapsed={collapsed} open={() => set({ page: 'analyst' })} />
      <div className="flex flex-col gap-0.5">{NAV.map(item)}</div>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-2">
        {item(['settings', 'Settings', Settings])}
        <button onClick={() => set({ collapsed: !collapsed })} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar"
          className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-text-2 hover:bg-elevated hover:text-text ${collapsed ? 'justify-center' : ''}`}>
          {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <><PanelLeftClose size={16} strokeWidth={1.75} /> Collapse</>}
        </button>
      </div>
    </nav>
  )
}
