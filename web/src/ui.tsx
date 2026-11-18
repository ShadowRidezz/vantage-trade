import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import type { Cond } from './api'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function Btn({ children, onClick, kind = 'default', disabled, title, type = 'button', className }: {
  children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string
}) {
  return <button type={type} onClick={onClick} disabled={disabled} title={title} className={cx(
    'inline-flex h-7 items-center justify-center gap-1.5 rounded px-2.5 text-[12px] font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50',
    kind === 'primary' && 'bg-accent text-white hover:brightness-110',
    kind === 'default' && 'border border-line bg-panel hover:bg-elevated',
    kind === 'ghost' && 'text-text-2 hover:bg-elevated hover:text-text',
    kind === 'danger' && 'border border-line text-bear hover:bg-bear/10', className)}>{children}</button>
}

export function Panel({ title, right, children, className, bodyClass }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('flex min-h-0 flex-col rounded-md border border-line bg-panel', className)}>
      {title && <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="text-[12px] font-semibold">{title}</h2>{right}
      </header>}
      <div className={cx('min-h-0 flex-1', bodyClass ?? 'p-3')}>{children}</div>
    </section>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'bull' | 'bear' | 'accent' | 'warn' }) {
  return <span className={cx('inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium whitespace-nowrap',
    tone === 'muted' && 'bg-elevated text-text-2', tone === 'bull' && 'bg-bull/12 text-bull', tone === 'bear' && 'bg-bear/12 text-bear',
    tone === 'accent' && 'bg-accent/12 text-accent', tone === 'warn' && 'bg-warn/15 text-warn')}>{children}</span>
}

export const dirTone = (d: string | null | undefined) => (d === 'bull' || d === 'long' ? 'bull' : d === 'bear' || d === 'short' ? 'bear' : 'muted') as 'bull' | 'bear' | 'muted'

export function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bull' | 'bear' }) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2">
      <div className="text-[11px] text-text-2">{label}</div>
      <div className={cx('mt-0.5 font-mono text-[15px] font-medium', tone === 'bull' && 'text-bull', tone === 'bear' && 'text-bear')}>{value}</div>
    </div>
  )
}

export function Conditions({ items }: { items: Cond[] }) {
  return <ul className="flex flex-col gap-1">
    {items.map((c, i) => <li key={i} className="flex items-start gap-2 text-[12px]">
      {c.met ? <Check size={14} className="mt-px shrink-0 text-bull" /> : <X size={14} className="mt-px shrink-0 text-bear" />}
      <span className="flex-1">{c.name}</span>
      {(c.value ?? c.detail) && <span className="shrink-0 font-mono text-[11px] text-text-2">{c.value ?? c.detail}</span>}
    </li>)}
  </ul>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="grid h-full min-h-24 place-items-center px-4 text-center text-[12px] text-text-2">{children}</div>
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex flex-col gap-1 text-[11px] text-text-2">{label}{children}{hint && <span className="text-[10px]">{hint}</span>}</label>
}

export const inputCls = 'h-7 rounded border border-line bg-bg px-2 text-[12px] text-text outline-none focus:border-accent'

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="text-[12px] text-bear">{error instanceof Error ? error.message : String(error)}</p>
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string][] }) {
  return <div role="tablist" className="flex gap-0.5 rounded-md border border-line bg-panel p-0.5">
    {items.map(([v, l]) => <button type="button" key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)}
      className={cx('h-7 rounded px-3 text-[12px]', value === v ? 'bg-elevated font-medium' : 'text-text-2 hover:text-text')}>{l}</button>)}
  </div>
}

/** A small "Simulated" label so results can't be mistaken for live performance. */
export const Simulated = () => <Badge tone="warn">Simulated</Badge>
