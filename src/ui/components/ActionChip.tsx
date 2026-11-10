import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ActionId, RiskLevel } from '../../engine/types'
import { ACTION_ICONS } from './actions'
import { cx } from './cx'
import { LEVEL_STYLES } from './levels'

export interface ActionChipProps {
  action: ActionId
  /** Localised action text (from i18n); the chip never invents wording. */
  label: string
  /** Second line, e.g. "250 mL every 20 min" or "45 min work · 15 min shade". */
  description?: ReactNode
  /** Tints the chip with the level that produced the action. Neutral when omitted. */
  level?: RiskLevel
  /** sm 32 px, md 40 px (consoles), lg 48 px (worker screens). */
  size?: 'sm' | 'md' | 'lg'
  /**
   * Completed or acknowledged: the icon becomes a check mark. When set on a clickable chip, the chip is a toggle button
   * (`aria-pressed`); leave it undefined for a plain action button.
   */
  done?: boolean
  /** Localised word announced for the done state of a non-interactive chip. */
  doneLabel?: string
  /** Makes the chip a button. */
  onClick?: () => void
  className?: string
}

const SIZES = {
  sm: 'min-h-8 gap-1.5 px-2 py-1 text-xs',
  md: 'min-h-10 gap-2 px-2.5 py-1.5 text-sm',
  lg: 'min-h-12 gap-3 px-3 py-2 text-base',
} as const
const ICON_BOX = { sm: 'size-5 rounded-md', md: 'size-7 rounded-lg', lg: 'size-9 rounded-lg' } as const
const ICON_PX = { sm: 13, md: 16, lg: 20 } as const

/**
 * A recommended action as pictogram + text (ARCHITECTURE.md §5 actions; WCAG 2.2 SC 1.1.1 and 1.4.1). Size lg gives the
 * >= 48 px touch target used on worker screens ([ENG], above WCAG 2.2 SC 2.5.5's 44 px, for gloved hands).
 */
export function ActionChip({
  action,
  label,
  description,
  level,
  size = 'md',
  done,
  doneLabel = 'done',
  onClick,
  className,
}: ActionChipProps) {
  const Icon = ACTION_ICONS[action]
  const style = level ? LEVEL_STYLES[level] : undefined
  const isDone = done === true
  const classes = cx(
    'inline-flex max-w-full items-center rounded-xl border text-start font-medium',
    SIZES[size],
    isDone ? 'border-line bg-canvas text-muted' : style ? cx(style.tint, style.softBorder, 'text-ink') : 'border-line bg-surface text-ink',
    onClick && 'cursor-pointer transition-colors hover:border-line-strong hover:bg-canvas active:bg-slate-100',
    className,
  )
  const body = (
    <>
      <span
        aria-hidden
        className={cx(
          'grid shrink-0 place-items-center',
          ICON_BOX[size],
          isDone ? 'bg-slate-200 text-muted' : style ? cx(style.solid, style.onSolid) : 'bg-shade-bg text-shade',
        )}
      >
        {isDone ? <Check size={ICON_PX[size]} strokeWidth={2.5} /> : <Icon size={ICON_PX[size]} />}
      </span>
      <span className="min-w-0">
        <span className="block leading-snug">{label}</span>
        {description && <span className="block text-[0.85em] leading-snug font-normal text-muted">{description}</span>}
      </span>
    </>
  )

  if (onClick) {
    return (
      <button type="button" data-action={action} aria-pressed={done} onClick={onClick} className={classes}>
        {body}
      </button>
    )
  }
  return (
    <span data-action={action} className={classes}>
      {body}
      {isDone && <span className="sr-only">, {doneLabel}</span>}
    </span>
  )
}
