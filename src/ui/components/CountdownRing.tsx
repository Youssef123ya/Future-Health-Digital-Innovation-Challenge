import type { ReactNode } from 'react'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { formatClock, formatMinutes, NO_DATA } from './format'
import { LEVEL_STYLES } from './levels'

export interface CountdownRingProps {
  /** Minutes remaining (fractional allowed); null when unknown. */
  remainingMin: number | null
  /** Length of the whole interval in minutes (the full ring). */
  totalMin: number
  /** What the countdown is for, e.g. "until your next shade break". */
  label: string
  /** Colours the ring by level; brand teal when omitted. */
  level?: RiskLevel
  /** Diameter in px. */
  size?: number
  strokeWidth?: number
  /** `clock` shows m:ss; `minutes` shows "12 min". */
  format?: 'clock' | 'minutes'
  /** Custom (e.g. localised) time text; replaces `format`. */
  formatTime?: (remainingMin: number) => string
  /** Small text under the time. */
  caption?: ReactNode
  /** Localised accessible name; defaults to an English sentence built from the time and `label`. */
  ariaLabel?: string
  className?: string
}

function spokenDuration(minutes: number): string {
  const totalS = Math.max(0, Math.floor(minutes * 60 + 1e-6))
  const m = Math.floor(totalS / 60)
  const s = totalS % 60
  const parts = [m ? `${m} minute${m === 1 ? '' : 's'}` : '', s ? `${s} second${s === 1 ? '' : 's'}` : '']
  return parts.filter(Boolean).join(' ') || '0 seconds'
}

/**
 * Ring countdown to the next required break or limit (ARCHITECTURE.md §9 worker view: "countdown"). Time is floored, so
 * the ring never shows more time than remains ([ENG], protective rounding). It uses ARIA `role="timer"` with live
 * announcements off (WCAG 2.2 SC 2.2.4 Interruptions; level changes are announced by the LevelCard instead). The arc
 * starts at 12 o'clock and its track is a lighter step of the same ramp; the transition stops under
 * prefers-reduced-motion (SC 2.3.3).
 */
export function CountdownRing({
  remainingMin,
  totalMin,
  label,
  level,
  size = 168,
  strokeWidth,
  format = 'clock',
  formatTime,
  caption,
  ariaLabel,
  className,
}: CountdownRingProps) {
  const sw = strokeWidth ?? Math.max(6, Math.round(size / 14))
  const radius = (size - sw) / 2
  const circumference = 2 * Math.PI * radius
  const has = remainingMin !== null && Number.isFinite(remainingMin) && totalMin > 0
  const fraction = has ? Math.min(1, Math.max(0, remainingMin / totalMin)) : 0
  const style = level ? LEVEL_STYLES[level] : undefined
  const text = !has
    ? NO_DATA
    : formatTime
      ? formatTime(remainingMin)
      : format === 'clock'
        ? formatClock(remainingMin)
        : formatMinutes(remainingMin)
  const name = ariaLabel ?? (has ? `${spokenDuration(remainingMin)} remaining ${label}` : `${label}: not available`)
  const c = size / 2

  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={name}
      className={cx('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle
          cx={c}
          cy={c}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={sw}
          className={has ? (style ? style.track : 'text-shade-tint') : 'text-line'}
          strokeDasharray={has ? undefined : '4 6'}
        />
        {has && fraction > 0 && (
          <circle
            cx={c}
            cy={c}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className={cx(style ? style.mark : 'text-shade', 'transition-[stroke-dashoffset] duration-1000 ease-linear')}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div className="px-3">
          <div className="leading-none font-semibold text-ink tabular-nums" style={{ fontSize: Math.round(size * 0.2) }}>
            {text}
          </div>
          {caption && <div className="mt-1 text-xs leading-tight text-muted">{caption}</div>}
        </div>
      </div>
    </div>
  )
}
