import { cx } from './cx'

export interface ZillMarkProps {
  /** Rendered size in px (square). */
  size?: number
  /** Accessible name. Omit when the mark sits next to the visible product name (it is then decorative). */
  title?: string
  className?: string
}

/**
 * Zill brand mark, inlined from public/favicon.svg so it renders offline at any size and takes the design tokens: a teal
 * canopy (ẓill, ظل, "shade") under an amber sun on an ink tile. [ENG] brand asset, no domain basis.
 */
export function ZillMark({ size = 32, title, className }: ZillMarkProps) {
  const labelled = title !== undefined
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cx('shrink-0', className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {labelled && <title>{title}</title>}
      <rect width="64" height="64" rx="14" className="fill-ink" />
      <circle cx="40" cy="24" r="13" className="fill-sun" />
      <path d="M7 45 C 16 26, 48 26, 57 45 Z" className="fill-shade-light" />
      <rect x="30.6" y="44" width="2.8" height="13" rx="1.4" className="fill-shade-light" />
    </svg>
  )
}
