import type { ReactNode } from 'react'
import { cx } from './cx'

export interface PhoneFrameProps {
  children: ReactNode
  /**
   * true (default): full-bleed below the md breakpoint (the page is the phone) and inside device chrome from md up.
   * false: always framed, for embedding a worker preview inside a console.
   */
  responsive?: boolean
  /** Caption under the frame (desktop only), e.g. "Worker phone view · simulated device". */
  caption?: ReactNode
  /** Accessible name of the phone screen region. */
  label?: string
  className?: string
}

// Class strings are written out in full (no runtime prefixing) so Tailwind's source scanner generates every variant.
const FRAMED = {
  figure: 'flex flex-col items-center gap-3',
  bezel: 'max-w-full rounded-[3rem] bg-ink p-3 shadow-2xl ring-1 ring-black/10',
  screen:
    'flex h-[min(844px,calc(100dvh_-_12rem))] min-h-[560px] w-[390px] max-w-full flex-col overflow-hidden rounded-[2.4rem] bg-canvas [transform:translateZ(0)]',
  island: 'flex',
  scroller: 'min-h-0 flex-1 overflow-y-auto overscroll-contain',
  caption: '',
}
const RESPONSIVE = {
  figure: 'md:flex md:flex-col md:items-center md:gap-3',
  bezel: 'md:rounded-[3rem] md:bg-ink md:p-3 md:shadow-2xl md:ring-1 md:ring-black/10',
  screen:
    'bg-canvas md:flex md:h-[min(844px,calc(100dvh_-_12rem))] md:min-h-[560px] md:w-[390px] md:flex-col md:overflow-hidden md:rounded-[2.4rem] md:[transform:translateZ(0)]',
  island: 'hidden md:flex',
  scroller: 'md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain',
  caption: 'hidden md:block',
}

/**
 * Device frame for the worker phone UI. The screen is 390 CSS px wide (a common phone viewport) and at most 844 px tall,
 * shrinking to fit the browser window. The screen is its own scroll container and carries a transform, so `fixed` and
 * `sticky` controls inside the worker view (an SOS bar, say) stay within the frame on desktop. [ENG] presentation only.
 */
export function PhoneFrame({ children, responsive = true, caption, label = 'Phone screen', className }: PhoneFrameProps) {
  const c = responsive ? RESPONSIVE : FRAMED
  return (
    <figure className={cx(c.figure, className)}>
      <div className={c.bezel}>
        <div className={c.screen}>
          <div aria-hidden className={cx('h-9 shrink-0 items-center justify-center', c.island)}>
            <span className="h-[22px] w-24 rounded-full bg-ink" />
          </div>
          <div role="region" aria-label={label} className={c.scroller}>
            {children}
          </div>
        </div>
      </div>
      {caption && <figcaption className={cx('text-xs text-muted', c.caption)}>{caption}</figcaption>}
    </figure>
  )
}
