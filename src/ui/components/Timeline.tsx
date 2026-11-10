import type { ReactNode } from 'react'
import { Circle, type LucideIcon } from 'lucide-react'
import { formatLocalHhmm } from '../../engine/time'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { EmptyState } from './EmptyState'
import { DEFAULT_LEVEL_LABELS, LEVEL_STYLES } from './levels'

export interface TimelineItem {
  id: string
  /** Event time, epoch ms UTC; shown as Abu Dhabi local "HH:mm" (engine/time.ts, UTC+4, no DST). */
  t?: number
  /** Preformatted time text; overrides `t` for display. */
  time?: string
  title: ReactNode
  description?: ReactNode
  /** Level reached at this event: marker pictogram + colour, plus the level name as text. */
  level?: RiskLevel
  levelLabel?: string
  /** Marker icon when there is no level (e.g. an acknowledgement). */
  icon?: LucideIcon
  /** Extra inline metadata after the time (who acknowledged, a provenance tag). */
  meta?: ReactNode
}

export interface TimelineProps {
  /** Events in display order (usually newest first for alert feeds). */
  items: readonly TimelineItem[]
  /** Accessible name of the list. */
  label?: string
  dense?: boolean
  /** Shown when there are no events. */
  empty?: ReactNode
  className?: string
}

/**
 * Vertical event list (`<ol>`) for alert feeds, incident logs and audit trails. Times are Abu Dhabi local time
 * (ARCHITECTURE.md §4 conventions). A level is shown by marker colour + pictogram + level name (WCAG 2.2 SC 1.4.1); each
 * marker has a surface ring that separates it from the rail.
 */
export function Timeline({ items, label, dense = false, empty, className }: TimelineProps) {
  if (items.length === 0) return <>{empty ?? <EmptyState size="sm" title="No events yet" />}</>
  return (
    <ol aria-label={label} className={cx('relative', className)}>
      {items.map((item, index) => {
        const style = item.level ? LEVEL_STYLES[item.level] : undefined
        const Icon = item.icon ?? style?.icon ?? Circle
        const last = index === items.length - 1
        const timeText = item.time ?? (item.t !== undefined ? formatLocalHhmm(item.t) : undefined)
        return (
          <li key={item.id} className={cx('relative flex gap-3', !last && (dense ? 'pb-3' : 'pb-5'))}>
            {!last && <span aria-hidden className="absolute start-3.5 top-7 bottom-0 w-px bg-line" />}
            <span
              aria-hidden
              className={cx(
                'relative grid size-7 shrink-0 place-items-center rounded-full ring-4 ring-surface',
                style ? cx(style.solid, style.onSolid) : 'bg-slate-100 text-muted',
              )}
            >
              <Icon size={14} strokeWidth={2.25} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted">
                {timeText && (
                  <time
                    dateTime={item.t !== undefined ? new Date(item.t).toISOString() : undefined}
                    className="font-medium text-ink tabular-nums"
                  >
                    {timeText}
                  </time>
                )}
                {item.level && style && (
                  <span className={cx('font-semibold', style.text)}>
                    {item.levelLabel ?? DEFAULT_LEVEL_LABELS[item.level]}
                  </span>
                )}
                {item.meta}
              </div>
              <div className="mt-0.5 text-sm font-medium text-ink">{item.title}</div>
              {item.description && <div className="mt-0.5 text-sm text-muted">{item.description}</div>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
