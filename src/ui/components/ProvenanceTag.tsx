import type { ReactNode } from 'react'
import { Archive, BadgeCheck, CloudSun, FlaskConical, TrendingUp, Wrench, type LucideIcon } from 'lucide-react'
import { cx } from './cx'
import { Tooltip } from './Tooltip'

/**
 * Where a number comes from (ARCHITECTURE.md §1 principle 7, "Honest evidence: every metric states its data source: a
 * reference implementation, real weather, archived forecasts, or a simulated cohort. Model projections are labelled as
 * projections"). `engineering_default` marks values that no standard fixes (the [ENG] tag of §1 principle 2).
 */
export type ProvenanceKind =
  | 'reference'
  | 'real_weather'
  | 'archived_forecast'
  | 'simulated'
  | 'projection'
  | 'engineering_default'

/** English provenance labels (ARCHITECTURE.md §1 principle 7, §8 "Real-data evidence"). */
export const PROVENANCE_LABELS: Readonly<Record<ProvenanceKind, string>> = {
  reference: 'Reference-validated',
  real_weather: 'Real weather',
  archived_forecast: 'Archived forecast',
  simulated: 'Simulated cohort',
  projection: 'Model projection',
  engineering_default: 'Engineering default',
}

/** Pictogram per provenance kind, so the tag is never told apart by colour alone (WCAG 2.2 SC 1.4.1). [ENG] */
export const PROVENANCE_ICONS: Readonly<Record<ProvenanceKind, LucideIcon>> = {
  reference: BadgeCheck,
  real_weather: CloudSun,
  archived_forecast: Archive,
  simulated: FlaskConical,
  projection: TrendingUp,
  engineering_default: Wrench,
}

// Hues avoid the five risk colours. A model projection gets a dashed outline: it is an estimate, not an observation.
const STYLES: Record<ProvenanceKind, string> = {
  reference: 'border-shade-tint bg-shade-bg text-shade-dark',
  real_weather: 'border-sky-200 bg-sky-50 text-sky-800',
  archived_forecast: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  simulated: 'border-slate-300 bg-slate-50 text-slate-700',
  projection: 'border-dashed border-slate-400 bg-surface text-slate-700',
  engineering_default: 'border-stone-300 bg-stone-50 text-stone-700',
}

export interface ProvenanceTagProps {
  kind: ProvenanceKind
  /** Source detail shown on hover/focus, e.g. "pythermalcomfort 2.10 · 1,200 cases · max |Δ| 0.02 °C". */
  detail?: ReactNode
  /** Localised label; defaults to {@link PROVENANCE_LABELS}. */
  label?: string
  size?: 'sm' | 'md'
  className?: string
}

/** Data-provenance tag for a metric, chart or table (ARCHITECTURE.md §1 principle 7). */
export function ProvenanceTag({ kind, detail, label, size = 'sm', className }: ProvenanceTagProps) {
  const Icon = PROVENANCE_ICONS[kind]
  const tag = (
    <span
      tabIndex={detail ? 0 : undefined}
      data-provenance={kind}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-1.5 text-xs' : 'h-6 px-2 text-sm',
        detail !== undefined && 'cursor-help',
        STYLES[kind],
        className,
      )}
    >
      <Icon aria-hidden size={size === 'sm' ? 12 : 14} />
      {label ?? PROVENANCE_LABELS[kind]}
    </span>
  )
  return detail ? <Tooltip content={detail}>{tag}</Tooltip> : tag
}
