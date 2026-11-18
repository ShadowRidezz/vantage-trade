import { CandlestickChart, Sparkles, History, BookOpen, Network, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useSettings, type Page } from './store'

const NAV: [Page, string, typeof Sparkles][] = [
  ['charts', 'Charts', CandlestickChart], ['analyst', 'AI Analyst', Sparkles], ['backtesting', 'Backtesting', History],
  ['journal', 'Journal', BookOpen], ['brain', 'AI Brain', Network],
]

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
