/**
 * Small building blocks of the medic view: the role switch (a radio group), the 998 call link, condition and symptom
 * tags. Risk and state are always colour + pictogram + text (WCAG 2.2 SC 1.4.1); logical properties only (RTL-ready).
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import {
  BriefcaseMedical,
  CircleCheck,
  CircleDashed,
  House,
  PhoneCall,
  Smartphone,
  Square,
  Stethoscope,
  Sun,
  Umbrella,
  type LucideIcon,
} from 'lucide-react'
import { UAE_EMERGENCY } from '../../../engine/clinical'
import type { SymptomId } from '../../../engine/types'
import { buttonClasses, cx, type ButtonSize, type ButtonVariant } from '../../components'
import { SYMPTOM_TIER_TEXT, symptomLabel, symptomTier, type ConditionState, type MedicRole, type Place } from './medicModel'

// ─────────────────────────────── Role switch ───────────────────────────────

const ROLE_OPTIONS: ReadonlyArray<{ id: MedicRole; label: string; short: string; icon: LucideIcon }> = [
  { id: 'first_aider', label: 'First aider', short: 'First aider', icon: BriefcaseMedical },
  { id: 'occ_health', label: 'Occupational health nurse', short: 'OH nurse', icon: Stethoscope },
]

/** Segmented radio group (arrow keys move and select, one tab stop). */
export function RoleSwitch({ value, onChange, labelId }: { value: MedicRole; onChange: (role: MedicRole) => void; labelId: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
    if (!forward && !back && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const rtl = typeof document !== 'undefined' && document.dir === 'rtl' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')
    const step = (forward ? 1 : -1) * (rtl ? -1 : 1)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ROLE_OPTIONS.length - 1 : (index + step + ROLE_OPTIONS.length) % ROLE_OPTIONS.length
    const opt = ROLE_OPTIONS[next]
    if (!opt) return
    onChange(opt.id)
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="inline-flex w-full rounded-xl border border-line bg-surface p-1 shadow-xs sm:w-auto">
      {ROLE_OPTIONS.map((o, i) => {
        const checked = o.id === value
        const Icon = o.icon
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors sm:flex-none sm:px-4',
              checked ? 'bg-ink text-white shadow-sm' : 'text-muted hover:bg-canvas hover:text-ink',
            )}
          >
            <Icon aria-hidden size={18} />
            <span className="hidden sm:inline">{o.label}</span>
            <span className="sm:hidden">{o.short}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────── Emergency call ───────────────────────────────

/** A real `tel:` link to the UAE ambulance number (engine/clinical.ts UAE_EMERGENCY). */
export function Call998Link({
  variant = 'emergency',
  size = 'md',
  label,
  className,
  fullWidth,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  label?: ReactNode
  className?: string
  fullWidth?: boolean
}) {
  return (
    <a href={`tel:${UAE_EMERGENCY.AMBULANCE}`} className={cx(buttonClasses({ variant, size, fullWidth }), className)}>
      <PhoneCall aria-hidden size={size === 'xl' || size === 'lg' ? 22 : 18} />
      {label ?? `Call ${UAE_EMERGENCY.AMBULANCE}`}
    </a>
  )
}

// ─────────────────────────────── Condition state ───────────────────────────────

const CONDITION_META: Readonly<Record<ConditionState, { icon: LucideIcon; label: string; className: string }>> = {
  met: { icon: CircleCheck, label: 'Met', className: 'bg-safe-bg text-safe' },
  pending: { icon: CircleDashed, label: 'Pending', className: 'bg-caution-bg text-caution' },
  device: { icon: Smartphone, label: 'On the device', className: 'bg-shade-bg text-shade-dark' },
  confirm: { icon: Square, label: 'Confirm', className: 'bg-slate-100 text-muted' },
}

export function ConditionTag({ state }: { state: ConditionState }) {
  const m = CONDITION_META[state]
  const Icon = m.icon
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold', m.className)}>
      <Icon aria-hidden size={14} strokeWidth={2.25} />
      {m.label}
    </span>
  )
}

export function ConditionIcon({ state, className }: { state: ConditionState; className?: string }) {
  const m = CONDITION_META[state]
  const Icon = m.icon
  return (
    <span aria-hidden className={cx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', m.className, className)}>
      <Icon size={16} strokeWidth={2.25} />
    </span>
  )
}

// ─────────────────────────────── Symptoms ───────────────────────────────

const TIER_CLASS: Readonly<Record<0 | 1 | 2 | 3, string>> = {
  3: 'border-emergency-fill/40 bg-emergency-bg text-emergency',
  2: 'border-stop-fill/40 bg-stop-bg text-stop',
  1: 'border-high-fill/40 bg-high-bg text-high',
  0: 'border-line bg-canvas text-muted',
}

/** A symptom with its triage tier in words (never colour alone). */
export function SymptomChip({ symptom, seenAt }: { symptom: SymptomId; seenAt?: string }) {
  const tier = symptomTier(symptom)
  return (
    <li className={cx('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm', TIER_CLASS[tier])}>
      <span className="font-medium text-ink">{symptomLabel(symptom)}</span>
      <span className="text-xs font-semibold">· {SYMPTOM_TIER_TEXT[tier]}</span>
      {seenAt && <span className="text-xs text-muted tabular-nums">· {seenAt}</span>}
    </li>
  )
}

// ─────────────────────────────── Place ───────────────────────────────

const PLACE_META: Readonly<Record<Place, { icon: LucideIcon; label: string }>> = {
  sun: { icon: Sun, label: 'In the sun' },
  shade: { icon: Umbrella, label: 'In shade' },
  indoor_cool: { icon: House, label: 'Cooled rest area' },
}

export function PlaceTag({ place }: { place: Place | null }) {
  if (!place) return <span className="text-sm text-muted">Place not readable</span>
  const m = PLACE_META[place]
  const Icon = m.icon
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
      <Icon aria-hidden size={16} className={place === 'sun' ? 'text-high' : 'text-shade'} />
      {m.label}
    </span>
  )
}

/** Inline label/value row used in small panels. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  )
}
