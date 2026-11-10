import type { HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from './cx'

/**
 * Badge tone. No tone reuses a risk colour (green/amber/orange/red/purple): risk is shown with LevelPill, which always
 * carries its pictogram and label (WCAG 2.2 SC 1.4.1). `inverse` is for the dark top bar.
 */
export type BadgeTone = 'neutral' | 'brand' | 'info' | 'outline' | 'inverse'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  size?: 'sm' | 'md'
  /** Leading decorative icon. */
  icon?: LucideIcon
}

// Text on tone backgrounds: slate-700/slate-100 9.4:1, teal-800/teal-50 7.3:1, sky-800/sky-50 7.0:1 (WCAG 2.2 SC 1.4.3).
const TONES: Record<BadgeTone, string> = {
  neutral: 'border-transparent bg-slate-100 text-slate-700',
  brand: 'border-shade-tint bg-shade-bg text-shade-dark',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
  outline: 'border-line-strong bg-surface text-muted',
  inverse: 'border-white/15 bg-white/10 text-white',
}

const SIZES = { sm: 'h-5 gap-1 px-1.5 text-xs', md: 'h-6 gap-1.5 px-2 text-xs' } as const

/** Small status/metadata label (counts, modes, tags). [ENG] UI primitive. */
export function Badge({ tone = 'neutral', size = 'md', icon: Icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border font-medium whitespace-nowrap',
        TONES[tone],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon aria-hidden size={size === 'sm' ? 12 : 14} />}
      {children}
    </span>
  )
}
