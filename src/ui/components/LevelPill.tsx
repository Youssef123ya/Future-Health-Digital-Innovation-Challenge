import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { DEFAULT_LEVEL_LABELS, LEVEL_STYLES } from './levels'

export interface LevelPillProps {
  level: RiskLevel
  /** Localised level name; defaults to {@link DEFAULT_LEVEL_LABELS}. */
  label?: string
  size?: 'sm' | 'md' | 'lg'
  /** `tint` for dense tables and boards; `solid` for maximum salience. */
  variant?: 'tint' | 'solid'
  className?: string
}

const SIZES = {
  sm: 'h-6 gap-1 px-2 text-xs',
  md: 'h-7 gap-1.5 px-2.5 text-sm',
  lg: 'h-9 gap-2 px-3.5 text-base',
} as const
const ICON_PX = { sm: 14, md: 16, lg: 20 } as const

/**
 * Compact risk-level indicator: pictogram + colour + text, never colour alone (WCAG 2.2 SC 1.4.1; ARCHITECTURE.md §9).
 * The solid variant keeps a transparent border so the pill stays outlined in forced-colours (high-contrast) mode.
 */
export function LevelPill({ level, label, size = 'md', variant = 'tint', className }: LevelPillProps) {
  const style = LEVEL_STYLES[level]
  const Icon = style.icon
  return (
    <span
      data-level={level}
      className={cx(
        'inline-flex items-center rounded-full border font-semibold whitespace-nowrap',
        SIZES[size],
        variant === 'solid'
          ? cx(style.solid, style.onSolid, 'border-transparent')
          : cx(style.tint, style.text, style.softBorder),
        className,
      )}
    >
      <Icon aria-hidden size={ICON_PX[size]} strokeWidth={2.25} />
      {label ?? DEFAULT_LEVEL_LABELS[level]}
    </span>
  )
}
