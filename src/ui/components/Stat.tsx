import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { formatNumber, formatSigned, NO_DATA } from './format'
import { LevelPill } from './LevelPill'
import { ProvenanceTag, type ProvenanceKind } from './ProvenanceTag'
import { Sparkline } from './Sparkline'
import { InfoTip } from './Tooltip'

/** Change against a named comparison period. */
export interface StatDelta {
  value: number
  /** The comparison, always named, e.g. "vs 2020–2024 mean" or "vs yesterday, same hour". */
  label: string
  /** Which direction is better for workers: up, down, or neither (shown neutral). */
  good: 'up' | 'down' | 'none'
  unit?: string
  precision?: number
}

export interface StatProps {
  /** Sentence-case label without a trailing colon. */
  label: string
  /** Number (formatted with `precision`), preformatted string, or null for "no data". */
  value: number | string | null
  unit?: string
  precision?: number
  delta?: StatDelta
  /** Data source (ARCHITECTURE.md §1 principle 7). */
  provenance?: ProvenanceKind
  provenanceDetail?: ReactNode
  /** Risk level of the value, shown as pictogram + text. */
  level?: RiskLevel
  levelLabel?: string
  /** Basis of the number (standard, table, equation), shown in an info tooltip (ARCHITECTURE.md §1 principle 2). */
  info?: ReactNode
  /** Secondary line under the value. */
  hint?: ReactNode
  /** Recent history for an inline sparkline (oldest first). */
  trend?: ReadonlyArray<number | null>
  size?: 'sm' | 'md' | 'lg'
  /** Draw as a standalone tile with card chrome. */
  framed?: boolean
  className?: string
}

const VALUE_SIZE = { sm: 'text-xl', md: 'text-2xl', lg: 'text-4xl' } as const

function Delta({ delta }: { delta: StatDelta }) {
  const precision = delta.precision ?? 0
  const shown = Number(delta.value.toFixed(precision))
  const direction = shown > 0 ? 'up' : shown < 0 ? 'down' : 'flat'
  const tone =
    direction === 'flat' || delta.good === 'none' ? 'text-muted' : direction === delta.good ? 'text-safe' : 'text-stop'
  const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus
  return (
    <p className={cx('flex flex-wrap items-center gap-x-1 text-xs font-medium', tone)}>
      <Icon aria-hidden size={14} strokeWidth={2.5} />
      <span className="tabular-nums">
        {formatSigned(delta.value, precision)}
        {delta.unit ? ` ${delta.unit}` : ''}
      </span>
      <span className="font-normal text-muted">{delta.label}</span>
    </p>
  )
}

/**
 * Single metric tile: label, value + unit, optional signed delta against a named period, sparkline, level and
 * provenance. A missing value prints an em dash with "No data" for screen readers and is never shown as zero
 * (ARCHITECTURE.md §1 principle 3). Delta colour encodes direction × whether that direction is better for workers, and an
 * arrow and sign always accompany it (WCAG 2.2 SC 1.4.1). Values use tabular figures because they update live during a
 * simulation and must not jitter.
 */
export function Stat({
  label,
  value,
  unit,
  precision = 0,
  delta,
  provenance,
  provenanceDetail,
  level,
  levelLabel,
  info,
  hint,
  trend,
  size = 'md',
  framed = false,
  className,
}: StatProps) {
  const missing = value === null || (typeof value === 'number' && !Number.isFinite(value))
  const display = typeof value === 'number' ? formatNumber(value, precision) : (value ?? NO_DATA)
  return (
    <div
      className={cx(
        'flex min-w-0 flex-col gap-1.5',
        framed && 'rounded-xl border border-line bg-surface p-4 shadow-xs',
        className,
      )}
    >
      <div className="flex min-h-6 items-center gap-1">
        <span className="truncate text-xs font-medium text-muted">{label}</span>
        {info && <InfoTip content={info} label={`Basis: ${label}`} />}
        {level && <LevelPill level={level} label={levelLabel} size="sm" className="ms-auto" />}
      </div>
      <div className="flex items-baseline gap-1">
        <span className={cx('leading-none font-semibold tabular-nums', VALUE_SIZE[size], missing ? 'text-subtle' : 'text-ink')}>
          {display}
        </span>
        {missing ? <span className="sr-only">No data</span> : unit && <span className="text-sm text-muted">{unit}</span>}
      </div>
      {delta && <Delta delta={delta} />}
      {trend && trend.length > 1 && (
        <Sparkline values={trend} label={`${label}, recent trend`} unit={unit} level={level} fluid height={28} />
      )}
      {(provenance || hint) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {provenance && <ProvenanceTag kind={provenance} detail={provenanceDetail} />}
          {hint}
        </div>
      )}
    </div>
  )
}
