import { useId, type ReactNode } from 'react'
import { RISK_ORDER, type RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { formatNumber, NO_DATA } from './format'
import { LevelPill } from './LevelPill'
import { DEFAULT_LEVEL_LABELS, LEVEL_STYLES } from './levels'

/** A band edge: the level that applies at and beyond `value` (in the meter's direction). */
export interface MeterThreshold {
  value: number
  level: RiskLevel
  /** Tick label, e.g. "115 · High zone". Defaults to the formatted value. */
  label?: string
}

/** Whether larger values are worse (WBGT, heart rate) or better (TWL, allowed work minutes). */
export type MeterDirection = 'higher-is-worse' | 'higher-is-better'

/**
 * Level for a value against band thresholds. 'higher-is-worse': a threshold applies when value >= threshold;
 * 'higher-is-better': when value <= threshold. The most severe applicable level wins, and boundaries are inclusive, so a
 * value exactly on a threshold takes the more protective level ([ENG], the same rule as ARCHITECTURE.md §5: "A TWL
 * exactly on 115 or 140 resolves to the more protective zone"). A non-finite value returns the most severe threshold
 * level: a missing input can only make the result more conservative (§1 principle 3).
 */
export function levelForValue(
  value: number,
  thresholds: readonly MeterThreshold[],
  direction: MeterDirection = 'higher-is-worse',
  baseLevel: RiskLevel = 'safe',
): RiskLevel {
  let level = baseLevel
  for (const t of thresholds) {
    const applies = !Number.isFinite(value) || (direction === 'higher-is-worse' ? value >= t.value : value <= t.value)
    if (applies && RISK_ORDER[t.level] > RISK_ORDER[level]) level = t.level
  }
  return level
}

export interface MeterProps {
  /** Current value; null renders "No data" (never an empty, reassuring bar). */
  value: number | null
  label: string
  min?: number
  max?: number
  unit?: string
  precision?: number
  thresholds?: readonly MeterThreshold[]
  direction?: MeterDirection
  /** Level below the first threshold. */
  baseLevel?: RiskLevel
  /** `level`: fill by the computed level (default when thresholds exist). `brand`: neutral teal progress. */
  tone?: 'level' | 'brand'
  /** Show the computed level as a pill (pictogram + text) next to the value. */
  showLevel?: boolean
  levelLabels?: Partial<Record<RiskLevel, string>>
  showThresholdLabels?: boolean
  hideLabel?: boolean
  /** Basis or explanation, rendered after the label (e.g. an InfoTip). */
  info?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Linear meter for one value against its limits (ARIA 1.2 `role="meter"`). The fill carries severity and the unfilled
 * track is a lighter step of the same ramp; threshold ticks mark the band edges. The value is always printed and, when
 * thresholds are given, so is the level as pictogram + text, so the bar is never the only carrier (WCAG 2.2 SC 1.4.1).
 */
export function Meter({
  value,
  label,
  min = 0,
  max = 100,
  unit,
  precision = 0,
  thresholds = [],
  direction = 'higher-is-worse',
  baseLevel = 'safe',
  tone,
  showLevel,
  levelLabels,
  showThresholdLabels = false,
  hideLabel = false,
  info,
  size = 'md',
  className,
}: MeterProps) {
  const labelId = useId()
  const noDataId = `${labelId}-nodata`
  const span = max - min > 0 ? max - min : 1
  const pctOf = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100))
  const has = value !== null && Number.isFinite(value)
  const effectiveTone = tone ?? (thresholds.length ? 'level' : 'brand')
  const level = has && thresholds.length ? levelForValue(value, thresholds, direction, baseLevel) : null
  const style = level && effectiveTone === 'level' ? LEVEL_STYLES[level] : null
  const levelName = level ? (levelLabels?.[level] ?? DEFAULT_LEVEL_LABELS[level]) : null
  const display = has ? formatNumber(value, precision) : NO_DATA
  const valueText = has ? `${display}${unit ? ` ${unit}` : ''}${levelName ? `, ${levelName}` : ''}` : 'No data'
  const pillVisible = (showLevel ?? thresholds.length > 0) && level !== null

  return (
    <div className={cx('min-w-0', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className={cx('flex min-w-0 items-center gap-1 text-xs font-medium text-muted', hideLabel && 'sr-only')}>
          <span id={labelId}>{label}</span>
          {info}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-semibold text-ink tabular-nums">
            {display}
            {has && unit && <span className="ms-1 font-normal text-muted">{unit}</span>}
            {!has && (
              <span id={noDataId} className="sr-only">
                No data
              </span>
            )}
          </span>
          {pillVisible && level && <LevelPill level={level} label={levelName ?? undefined} size="sm" />}
        </span>
      </div>
      <div
        role={has ? 'meter' : 'img'}
        aria-labelledby={labelId}
        aria-valuemin={has ? min : undefined}
        aria-valuemax={has ? max : undefined}
        aria-valuenow={has ? Math.min(max, Math.max(min, value)) : undefined}
        aria-valuetext={has ? valueText : undefined}
        aria-describedby={has ? undefined : noDataId}
        className={cx(
          'relative w-full rounded-full',
          size === 'sm' ? 'h-1.5' : 'h-2.5',
          !has ? 'border border-dashed border-line-strong bg-canvas' : style ? style.tint : 'bg-shade-tint',
        )}
      >
        {has && (
          <div
            className={cx('absolute inset-y-0 start-0 rounded-full', style ? style.solid : 'bg-shade')}
            style={{ width: `${pctOf(value)}%` }}
          />
        )}
        {thresholds.map((t, k) => (
          <span
            key={k}
            aria-hidden
            className="absolute -inset-y-1 w-0.5 rounded-full bg-ink/40"
            style={{ insetInlineStart: `calc(${pctOf(t.value)}% - 1px)` }}
          />
        ))}
      </div>
      {showThresholdLabels && thresholds.length > 0 && (
        <div aria-hidden className="relative mt-1.5 h-4 text-[11px] text-subtle tabular-nums">
          {thresholds.map((t, k) => {
            const p = pctOf(t.value)
            return (
              <span
                key={k}
                className={cx(
                  'absolute top-0 whitespace-nowrap',
                  p < 8 ? '' : p > 92 ? '-translate-x-full rtl:translate-x-full' : '-translate-x-1/2 rtl:translate-x-1/2',
                )}
                style={{ insetInlineStart: `${p}%` }}
              >
                {t.label ?? formatNumber(t.value, precision)}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
