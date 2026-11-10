import { useId, type ReactNode } from 'react'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { DEFAULT_LEVEL_LABELS, LEVEL_STYLES } from './levels'

export interface LevelCardProps {
  level: RiskLevel
  /** Localised level name; defaults to {@link DEFAULT_LEVEL_LABELS}. */
  label?: string
  /** The one instruction that matters now, e.g. "Rest in the shade now". */
  headline: ReactNode
  /** Short non-clinical reason, e.g. "Heat is high for heavy work at this hour." */
  reason?: ReactNode
  /** Extra content under the message: action chips, a countdown, buttons. */
  children?: ReactNode
  size?: 'md' | 'lg'
  /** Heading element for the headline (default h2). */
  headingLevel?: 2 | 3
  /**
   * Screen-reader announcement when the level or message changes. Defaults to assertive for stop/emergency and polite
   * otherwise (WCAG 2.2 SC 4.1.3 Status Messages).
   */
  live?: 'off' | 'polite' | 'assertive'
  className?: string
}

const URGENT: ReadonlySet<RiskLevel> = new Set<RiskLevel>(['stop', 'emergency'])

/**
 * The worker's level card: large pictogram, level name and one instruction, conveyed by pictogram + colour + text
 * (ARCHITECTURE.md §9 worker view; WCAG 2.2 SC 1.4.1). Salience rises with severity [ENG]: safe, caution and high use a
 * tinted card with a solid pictogram disc; stop and emergency switch to a saturated card with white text, and emergency
 * adds a slow halo around the pictogram (stopped under prefers-reduced-motion, WCAG 2.2 SC 2.3.3). Wording is decision
 * support only: the card never claims to diagnose (ARCHITECTURE.md §1 principle 8).
 */
export function LevelCard({
  level,
  label,
  headline,
  reason,
  children,
  size = 'lg',
  headingLevel = 2,
  live,
  className,
}: LevelCardProps) {
  const headingId = useId()
  const style = LEVEL_STYLES[level]
  const Icon = style.icon
  const urgent = URGENT.has(level)
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const lg = size === 'lg'

  return (
    <section
      aria-labelledby={headingId}
      data-level={level}
      className={cx(
        'rounded-2xl border-2',
        lg ? 'p-5 sm:p-6' : 'p-4',
        urgent ? cx(style.solid, style.onSolid, 'border-transparent shadow-lg') : cx(style.tint, style.border, 'text-ink'),
        className,
      )}
    >
      <div className={cx('flex items-start', lg ? 'gap-4' : 'gap-3')}>
        <span aria-hidden className={cx('relative grid shrink-0 place-items-center', lg ? 'size-16' : 'size-12')}>
          {level === 'emergency' && (
            <span className="absolute inset-0 rounded-full bg-white/60 motion-safe:animate-zill-pulse" />
          )}
          <span
            className={cx(
              'relative grid size-full place-items-center rounded-full',
              urgent ? 'bg-white/15 ring-2 ring-white/80' : cx(style.solid, style.onSolid),
            )}
          >
            <Icon size={lg ? 36 : 26} strokeWidth={2.25} />
          </span>
        </span>
        <div aria-live={live ?? (urgent ? 'assertive' : 'polite')} aria-atomic="true" className="min-w-0 flex-1">
          <p className={cx('font-bold uppercase', lg ? 'text-sm' : 'text-xs', urgent ? 'text-current' : style.text)}>
            {label ?? DEFAULT_LEVEL_LABELS[level]}
          </p>
          <Heading
            id={headingId}
            className={cx('mt-1 font-bold leading-tight text-balance', lg ? 'text-2xl sm:text-3xl' : 'text-xl')}
          >
            {headline}
          </Heading>
          {reason && (
            <div className={cx('mt-2', lg ? 'text-base' : 'text-sm', urgent ? 'text-current' : 'text-muted')}>{reason}</div>
          )}
        </div>
      </div>
      {children && <div className={lg ? 'mt-5' : 'mt-4'}>{children}</div>}
    </section>
  )
}
