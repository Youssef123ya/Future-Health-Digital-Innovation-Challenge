import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { CheckCircle2, ChevronDown, Flag, XCircle } from 'lucide-react'
import { cx } from '../../components'
import { pct } from './format'

/**
 * Small shared pieces for the Evidence view: headline tiles, pass/fail badges, a tolerance meter, a segmented control
 * (radio group) and the world-change flag. Risk-level colours are not used here: pass/fail carries an icon and a word.
 */

// ─── Headline tiles ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface KpiProps {
  label: string
  value: ReactNode
  unit?: string
  hint?: ReactNode
  icon?: ReactNode
  className?: string
}

/** One headline number. Proportional figures at display size (tabular only in columns). */
export function Kpi({ label, value, unit, hint, icon, className }: KpiProps) {
  return (
    <div className={cx('min-w-0 rounded-xl border border-line bg-surface px-4 py-3', className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">
        {value}
        {unit && <span className="ms-1 text-sm font-medium text-muted">{unit}</span>}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  )
}

export function KpiRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
}

// ─── Pass / fail ────────────────────────────────────────────────────────────────────────────────────────────────────

export function PassBadge({ pass, label }: { pass: boolean; label?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        pass ? 'border-shade-tint bg-shade-bg text-shade-dark' : 'border-stop/30 bg-stop-bg text-stop',
      )}
    >
      {pass ? <CheckCircle2 aria-hidden size={13} /> : <XCircle aria-hidden size={13} />}
      {label ?? (pass ? 'Pass' : 'Fail')}
    </span>
  )
}

/**
 * Share of a tolerance used, as a thin meter with the figure beside it. The track is a lighter step of the fill's ramp;
 * a check at its tolerance fills the track (published values printed rounded sit there by construction).
 */
export function UseMeter({ use, text }: { use: number | null; text: string }) {
  const width = use === null ? 0 : Math.min(1, Math.max(use, use > 0 ? 0.02 : 0))
  return (
    <span className="inline-flex min-w-[7.5rem] items-center justify-end gap-2">
      <span aria-hidden className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[#cde2fb]">
        <span className="absolute inset-y-0 start-0 rounded-full bg-[#2a78d6]" style={{ width: `${width * 100}%` }} />
      </span>
      <span className="w-14 text-end tabular-nums">{text}</span>
    </span>
  )
}

/** A thin share bar for table cells (0–1), the figure beside it. */
export function ShareBar({ share, precision = 0 }: { share: number | null | undefined; precision?: number }) {
  const w = typeof share === 'number' && Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[#cde2fb]">
        <span className="absolute inset-y-0 start-0 rounded-full bg-[#2a78d6]" style={{ width: `${w * 100}%` }} />
      </span>
      <span className="w-12 text-end tabular-nums">{pct(share, precision)}</span>
    </span>
  )
}

// ─── Segmented control ──────────────────────────────────────────────────────────────────────────────────────────────

export interface SegmentOption {
  id: string
  label: ReactNode
}

/**
 * A single-choice toggle (WAI-ARIA radio group: one tab stop, arrow keys move and select). Used for chart variables and
 * views where tabs would imply separate panels.
 */
export function Segmented({ label, value, options, onChange, className }: { label: string; value: string; options: readonly SegmentOption[]; onChange: (id: string) => void; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const labelId = useId()
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
    const next = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (i + next + options.length) % options.length
    onChange(options[j].id)
    refs.current[j]?.focus()
  }
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span id={labelId} className="text-xs font-medium text-muted">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-line-strong bg-canvas p-0.5">
        {options.map((o, i) => {
          const on = o.id === value
          return (
            <button
              key={o.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx(
                'h-8 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                on ? 'bg-surface text-ink shadow-xs ring-1 ring-line-strong' : 'text-muted hover:text-ink',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Disclosure ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function DisclosureButton({ open, onToggle, controls, children, className }: { open: boolean; onToggle: () => void; controls?: string; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cx('inline-flex items-center gap-1.5 rounded-md text-start font-medium text-ink hover:text-shade-dark', className)}
    >
      <ChevronDown aria-hidden size={16} className={cx('shrink-0 text-subtle transition-transform motion-reduce:transition-none', open ? 'rotate-0' : '-rotate-90 rtl:rotate-90')} />
      {children}
    </button>
  )
}

// ─── World-change flag ──────────────────────────────────────────────────────────────────────────────────────────────

/** Marks a baseline value that moved between cohort versions: the simulated world changed, not Zill. */
export function WorldFlag({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1 text-[0.7rem] font-semibold whitespace-nowrap text-amber-900">
      <Flag aria-hidden size={11} />
      {compact ? 'world' : 'simulated world'}
      <span className="sr-only">: this baseline value changed because the simulated world changed, not Zill</span>
    </span>
  )
}

/** Sub-heading inside a section (h3), with an optional trailing control. */
export function SubHead({ children, id, aside }: { children: ReactNode; id?: string; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <h3 id={id} className="text-base font-semibold text-ink">
        {children}
      </h3>
      {aside}
    </div>
  )
}

/** Wraps a wide table so it scrolls inside its own frame on phones (no horizontal page scroll). */
export function TableFrame({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role={label ? 'region' : undefined} aria-label={label} tabIndex={label ? 0 : undefined} className={cx('overflow-x-auto rounded-xl border border-line bg-surface', className)}>
      {children}
    </div>
  )
}

export const TH = 'border-b border-line bg-slate-50 px-3 py-2 text-xs font-semibold text-muted'
export const TD = 'border-b border-line px-3 py-2 align-top'
