import { lazy, Suspense } from 'react'
import { useSettings } from './store'
import { Sidebar } from './Sidebar'
import { Charts } from './Charts'
import { Settings } from './SettingsPage'
import { Analyst } from './Analyst'
import { Backtesting } from './Backtesting'
import { Journal } from './Journal'
import { Empty } from './ui'

const Brain = lazy(() => import('./Brain').then((m) => ({ default: m.Brain }))) // three.js only loads when opened

export function App() {
  const page = useSettings((s) => s.page)
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-hidden">
        {page === 'charts' ? <Charts /> : page === 'analyst' ? <Analyst /> : page === 'backtesting' ? <Backtesting /> : page === 'journal' ? <Journal />
          : page === 'brain' ? <Suspense fallback={<Empty>Loading AI Brain…</Empty>}><Brain /></Suspense> : <Settings />}
      </main>
    </div>
  )
}
