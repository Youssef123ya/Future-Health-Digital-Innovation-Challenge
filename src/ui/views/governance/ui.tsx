/**
 * Small presentational pieces shared by the governance centre panels: field chips coloured by governance class (always
 * with icon and text), decision badges, hash text, the subject-worker picker and a scroll helper for in-page links
 * (the app uses hash routing, so in-page anchors cannot use `#id` hrefs).
 */
import { useEffect, useRef, useState } from 'react'
import { Activity, Ban, CircleCheck, CircleMinus, HeartPulse, MapPin, UserRound, type LucideIcon } from 'lucide-react'
import type { ActionId, DataField, RiskLevel } from '../../../engine/types'
import { FIELD_INFO, type FieldClass } from '../../../engine/privacy'
import { t, type MessageKey } from '../../../i18n'
import { useSim } from '../../../state/hooks'
import { cx } from '../../components'
import type { RequestOutcome } from './model'

/**
 * English level name from the message catalog ("Low risk", never "Safe": GOVERNANCE §9 claims framing). The design
 * system's LevelPill default label for the lowest level is "Safe", so the governance centre passes this one.
 */
export function levelName(level: RiskLevel): string {
  return t('en', `level.${level}.name` as MessageKey)
}

/** English label of an action from the message catalog. */
export function actionLabel(id: ActionId): string {
  return t('en', `action.${id}` as MessageKey)
}

/** Native select styled like the design system's inputs. */
export const SELECT_CLASS =
  'h-10 w-full min-w-0 rounded-lg border border-line-strong bg-surface ps-3 pe-8 text-sm text-ink shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade'

export const INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink shadow-xs placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade'

/** Style of each governance field class (privacy.ts FieldClass). Clinical fields are never shown on consoles. */
export const FIELD_CLASS_STYLE: Readonly<Record<FieldClass, { label: string; icon: LucideIcon; chip: string }>> = {
  identity: { label: 'Identity', icon: UserRound, chip: 'border-slate-300 bg-slate-50 text-slate-700' },
  operational: { label: 'Operational', icon: Activity, chip: 'border-shade-tint bg-shade-bg text-shade-dark' },
  personal: { label: 'Personal', icon: MapPin, chip: 'border-sky-200 bg-sky-50 text-sky-800' },
  clinical: { label: 'Clinical', icon: HeartPulse, chip: 'border-rose-200 bg-rose-50 text-rose-800' },
}

export const FIELD_CLASS_ORDER: readonly FieldClass[] = ['operational', 'identity', 'personal', 'clinical']

/** A data field as a chip: class colour + icon + label; `withheld` strikes it through. */
export function FieldChip({ field, withheld = false, className }: { field: DataField; withheld?: boolean; className?: string }) {
  const info = FIELD_INFO[field]
  const style = FIELD_CLASS_STYLE[info.class]
  const Icon = style.icon
  return (
    <span
      title={`${info.label} (${style.label.toLowerCase()}): ${info.description}`}
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        withheld ? 'border-dashed border-line-strong bg-surface text-muted line-through decoration-slate-400' : style.chip,
        className,
      )}
    >
      <Icon aria-hidden size={12} className="shrink-0" />
      <span className="truncate">{info.label}</span>
      <span className="sr-only">
        {' '}
        ({style.label.toLowerCase()} field{withheld ? ', withheld' : ''})
      </span>
    </span>
  )
}

/** Legend chip of a field class. */
export function FieldClassLegend({ cls }: { cls: FieldClass }) {
  const style = FIELD_CLASS_STYLE[cls]
  const Icon = style.icon
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium', style.chip)}>
      <Icon aria-hidden size={12} />
      {style.label}
    </span>
  )
}

const OUTCOME_STYLE: Readonly<Record<RequestOutcome, { label: string; icon: LucideIcon; cls: string }>> = {
  refused: { label: 'Refused', icon: Ban, cls: 'border-rose-200 bg-rose-50 text-rose-800' },
  partial: { label: 'Partly released', icon: CircleMinus, cls: 'border-slate-300 bg-slate-100 text-slate-800' },
  allowed: { label: 'Allowed', icon: CircleCheck, cls: 'border-shade-tint bg-shade-bg text-shade-dark' },
}

/** Decision of an access request or audit entry: icon + text + colour. */
export function OutcomeBadge({ outcome, size = 'sm' }: { outcome: RequestOutcome; size?: 'sm' | 'lg' }) {
  const s = OUTCOME_STYLE[outcome]
  const Icon = s.icon
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-semibold whitespace-nowrap',
        size === 'lg' ? 'h-9 px-3.5 text-base' : 'h-6 px-2 text-xs',
        s.cls,
      )}
    >
      <Icon aria-hidden size={size === 'lg' ? 18 : 13} />
      {s.label}
    </span>
  )
}

/** Audit decision badge ('denied' reads "Refused"). */
export function DecisionBadge({ decision }: { decision: 'allowed' | 'denied' }) {
  return <OutcomeBadge outcome={decision === 'denied' ? 'refused' : 'allowed'} />
}

/** A hash prefix in monospace; the full hash is in the title and for screen readers. */
export function HashText({ hash, n = 10, className }: { hash: string; n?: number; className?: string }) {
  return (
    <code title={hash} className={cx('font-mono text-xs text-muted tabular-nums', className)}>
      <span aria-hidden>{hash.slice(0, n)}…</span>
      <span className="sr-only">hash {hash}</span>
    </code>
  )
}

/** Scrolls to an element by id and moves focus to its first heading (in-page navigation without changing the hash). */
export function scrollToId(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const heading = el.matches('h2, h3, tr') ? el : el.querySelector<HTMLElement>('h2, h3')
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
  }
}

/** True for `ms` after `key` changes (not on first render): drives the highlight on a sync or a consent change. */
export function useFlash(key: unknown, ms = 1600): boolean {
  const [on, setOn] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setOn(true)
    const id = setTimeout(() => setOn(false), ms)
    return () => clearTimeout(id)
  }, [key, ms])
  return on
}

/** The worker the panels inspect, by pseudonymous id, grouped by crew. */
export function SubjectSelect({
  value,
  onChange,
  id,
  label = 'Worker',
  className,
}: {
  value: string | null
  onChange: (id: string) => void
  id: string
  label?: string
  className?: string
}) {
  const crews = useSim((s) => s.crews)
  return (
    <div className={cx('flex min-w-0 items-center gap-2', className)}>
      <label htmlFor={id} className="shrink-0 text-sm font-medium text-muted">
        {label}
      </label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={cx(SELECT_CLASS, 'w-auto min-w-36 font-mono')} disabled={crews.length === 0}>
        {crews.length === 0 && <option value="">Loading…</option>}
        {crews.map((c) => (
          <optgroup key={c.id} label={c.name}>
            {c.workerIds.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
