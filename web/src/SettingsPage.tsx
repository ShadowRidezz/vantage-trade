import { useSettings, type Theme } from './store'
import { AiStatus } from './AiStatus'

export function Settings() {
  const { theme, set } = useSettings()
  return (
    <div className="max-w-xl p-6">
      <h1 className="text-base font-semibold">Settings</h1>
      <section className="mt-5 rounded-md border border-line bg-panel p-4">
        <div className="text-xs font-medium text-text-2">Appearance</div>
        <div className="mt-3 flex items-center justify-between">
          <span>Theme</span>
          <div role="radiogroup" className="flex rounded-md border border-line p-0.5">
            {(['dark', 'light'] as Theme[]).map((t) => (
              <button key={t} role="radio" aria-checked={theme === t} onClick={() => set({ theme: t })}
                className={`rounded px-3 py-1 capitalize ${theme === t ? 'bg-elevated font-medium' : 'text-text-2 hover:text-text'}`}>{t}</button>
            ))}
          </div>
        </div>
      </section>
      <section className="mt-3 rounded-md border border-line bg-panel p-4">
        <div className="text-xs font-medium text-text-2">AI explanations</div>
        <div className="mt-3 flex items-center justify-between gap-3"><span>Claude (via Claude Code on this PC)</span><AiStatus /></div>
        <p className="mt-2 text-[12px] text-text-2">Pattern detection, backtests and reviews are deterministic and work without it. Claude only writes explanations and chat answers from the stored facts. No API key is stored.</p>
      </section>
      <section className="mt-3 rounded-md border border-line bg-panel p-4 text-[12px]">
        <div className="text-xs font-medium text-text-2">Market data</div>
        <p className="mt-2">Yahoo Finance · <span className="text-warn">delayed</span>. Futures are continuous front-month series; the contract code shown is an estimate from the CME quarterly roll calendar.</p>
        <p className="mt-1 text-text-2">Paper trading only. VANTAGE TRADE never routes real orders.</p>
      </section>
    </div>
  )
}
