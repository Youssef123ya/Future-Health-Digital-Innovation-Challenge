import type { HTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { LEVEL_STYLES } from './levels'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Semantic element; use `section`/`article` when the card has its own heading. */
  as?: 'div' | 'section' | 'article' | 'aside' | 'li'
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /**
   * Adds a 4 px accent on the inline-start edge in the level colour. The stripe is supplementary: the card must still
   * show the level's pictogram and label (e.g. a LevelPill) somewhere inside (WCAG 2.2 SC 1.4.1).
   */
  level?: RiskLevel
}

const PADDING = { none: '', sm: 'p-3', md: 'p-4 sm:p-5', lg: 'p-5 sm:p-6' } as const

/** Surface container for console content. [ENG] UI primitive. */
export function Card({ as: Tag = 'div', padding = 'md', level, className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(
        'rounded-xl border border-line bg-surface shadow-xs',
        level && cx('border-s-4', LEVEL_STYLES[level].border),
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Decorative icon in a brand-tinted tile. */
  icon?: LucideIcon
  /** Controls aligned to the inline end (buttons, tabs, a provenance tag). */
  actions?: ReactNode
  /** Heading element; h3 by default because cards usually sit inside an h2 Section (WCAG 2.2 SC 1.3.1). */
  as?: 'h2' | 'h3' | 'h4'
  /** Id for the heading, so a parent can reference it with `aria-labelledby`. */
  id?: string
  className?: string
}

/** Card title row: optional icon, heading, description and inline-end actions. [ENG] UI primitive. */
export function CardHeader({ title, description, icon: Icon, actions, as: Heading = 'h3', id, className }: CardHeaderProps) {
  return (
    <div className={cx('mb-4 flex items-start gap-3', className)}>
      {Icon && (
        <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-shade-bg text-shade">
          <Icon size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <Heading id={id} className="text-sm font-semibold text-ink">
          {title}
        </Heading>
        {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
