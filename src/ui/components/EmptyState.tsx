import type { ReactNode } from 'react'
import { CircleDashed, Inbox, type LucideIcon } from 'lucide-react'
import { cx } from './cx'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: ReactNode
  description?: ReactNode
  /** A next step: a button or link. */
  action?: ReactNode
  /**
   * `neutral`: nothing to show yet. `unavailable`: an input is missing or unusable. That state is shown as missing (dashed
   * outline) and never as reassurance (ARCHITECTURE.md §1 principle 3; ChannelResult.available = false).
   */
  tone?: 'neutral' | 'unavailable'
  size?: 'sm' | 'md'
  className?: string
}

/** Placeholder for an empty list, a view under construction, or an unavailable data source. [ENG] UI primitive. */
export function EmptyState({ icon, title, description, action, tone = 'neutral', size = 'md', className }: EmptyStateProps) {
  const Icon = icon ?? (tone === 'unavailable' ? CircleDashed : Inbox)
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center rounded-xl border text-center',
        tone === 'unavailable' ? 'border-dashed border-line-strong bg-canvas' : 'border-line bg-surface',
        size === 'sm' ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      <span aria-hidden className="grid size-10 place-items-center rounded-full bg-slate-100 text-subtle">
        <Icon size={20} />
      </span>
      <div className="max-w-md">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description && <div className="mt-1 text-sm text-muted">{description}</div>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
