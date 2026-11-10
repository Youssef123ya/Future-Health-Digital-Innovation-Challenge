import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from './cx'

export interface TabItem {
  /** Stable key (no spaces), also used in element ids. */
  id: string
  label: ReactNode
  icon?: LucideIcon
  /** Trailing count or status, e.g. a Badge. */
  badge?: ReactNode
  disabled?: boolean
}

export interface TabsProps {
  items: readonly TabItem[]
  /** Accessible name of the tab list. */
  label: string
  /** Controlled selection. */
  value?: string
  /** Initial selection when uncontrolled (defaults to the first enabled tab). */
  defaultValue?: string
  onValueChange?: (id: string) => void
  variant?: 'underline' | 'pill'
  /** md 40 px tabs (consoles); lg 48 px (worker screens). */
  size?: 'md' | 'lg'
  /** Renders the panel for the active tab inside a linked `role="tabpanel"`. */
  children?: (activeId: string) => ReactNode
  className?: string
  panelClassName?: string
}

const SIZE = { md: 'h-10 px-3 text-sm', lg: 'min-h-12 px-4 text-base' } as const
const domId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Tabs following the WAI-ARIA APG Tabs pattern with automatic activation: one tab stop (roving tabindex), Left/Right
 * arrows move and select (mirrored when the computed direction is RTL), Home/End jump to the ends, and disabled tabs are
 * skipped. Works controlled (`value`) or uncontrolled (`defaultValue`).
 */
export function Tabs({
  items,
  label,
  value,
  defaultValue,
  onValueChange,
  variant = 'underline',
  size = 'md',
  children,
  className,
  panelClassName,
}: TabsProps) {
  const baseId = useId()
  const firstEnabled = items.find((t) => !t.disabled)?.id ?? ''
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? firstEnabled)
  const requested = value ?? uncontrolled
  const active = items.some((t) => t.id === requested && !t.disabled) ? requested : firstEnabled
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  const tabId = (id: string) => `${baseId}-tab-${domId(id)}`
  const panelId = `${baseId}-panel`

  const select = (id: string) => {
    if (value === undefined) setUncontrolled(id)
    if (id !== active) onValueChange?.(id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((t) => !t.disabled)
    const index = enabled.findIndex((t) => t.id === active)
    if (index < 0) return
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
    let next: number
    switch (e.key) {
      case 'ArrowRight':
        next = index + (rtl ? -1 : 1)
        break
      case 'ArrowLeft':
        next = index + (rtl ? 1 : -1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = enabled.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const target = enabled[(next + enabled.length) % enabled.length]
    select(target.id)
    tabRefs.current.get(target.id)?.focus()
  }

  return (
    <div className={cx('min-w-0', className)}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={
          variant === 'underline'
            ? 'flex gap-1 overflow-x-auto border-b border-line'
            : 'inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1'
        }
      >
        {items.map((tab) => {
          const selected = tab.id === active
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={children ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => select(tab.id)}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-40',
                SIZE[size],
                variant === 'underline'
                  ? cx(
                      '-mb-px border-b-2',
                      selected
                        ? 'border-shade text-shade-dark'
                        : 'border-transparent text-muted hover:border-line-strong hover:text-ink',
                    )
                  : cx('rounded-lg', selected ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink'),
              )}
            >
              {Icon && <Icon aria-hidden size={size === 'lg' ? 20 : 16} />}
              {tab.label}
              {tab.badge}
            </button>
          )
        })}
      </div>
      {children && (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(active)}
          tabIndex={0}
          className={cx('mt-4', panelClassName)}
        >
          {children(active)}
        </div>
      )}
    </div>
  )
}
