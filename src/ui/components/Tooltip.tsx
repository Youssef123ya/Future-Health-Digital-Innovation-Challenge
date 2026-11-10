import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cx } from './cx'

export interface TooltipProps {
  /** Tooltip text: a short explanation, e.g. the `basis` string of a rule. */
  content: ReactNode
  /** One focusable element (a DOM element, or a component that forwards `aria-describedby`). */
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: 'top' | 'bottom'
  /** Horizontal alignment to the trigger (logical: start/end follow `dir`). */
  align?: 'center' | 'start' | 'end'
  /** Hover delay before opening, in ms (focus opens immediately). */
  delayMs?: number
  className?: string
}

const ALIGN = { center: 'left-1/2 -translate-x-1/2', start: 'start-0', end: 'end-0' } as const

/**
 * Accessible tooltip (WAI-ARIA APG Tooltip pattern). It meets WCAG 2.2 SC 1.4.13 Content on Hover or Focus: it opens on
 * hover and on keyboard focus, Escape dismisses it, it stays open while the pointer is over it, and it closes when focus
 * or the pointer leaves. A tap toggles it on touch screens. The text also lives in an always-present visually hidden
 * element referenced by `aria-describedby`, so screen readers get it without depending on the visual popup.
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delayMs = 300, className }: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const schedule = (next: boolean, ms: number) => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    if (ms <= 0) setOpen(next)
    else timer.current = setTimeout(() => setOpen(next), ms)
  }

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapperRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex max-w-full"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') schedule(true, delayMs)
      }}
      onPointerLeave={(e) => {
        // A short grace period lets the pointer cross the gap onto the tooltip (SC 1.4.13 "hoverable").
        if (e.pointerType === 'mouse') schedule(false, 120)
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse') setOpen((o) => !o)
      }}
      onFocus={() => schedule(true, 0)}
      onBlur={() => schedule(false, 0)}
    >
      {cloneElement(children, { 'aria-describedby': cx(children.props['aria-describedby'], id) })}
      <span id={id} className="sr-only">
        {content}
      </span>
      {open && (
        <span
          aria-hidden
          className={cx(
            'absolute z-50 w-max max-w-64 rounded-md bg-ink px-2.5 py-1.5 text-start text-xs leading-snug font-normal text-white shadow-lg motion-safe:animate-zill-fade-in',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            ALIGN[align],
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}

export interface InfoTipProps {
  content: ReactNode
  /** Accessible name of the info button. */
  label?: string
  side?: 'top' | 'bottom'
  align?: 'center' | 'start' | 'end'
  className?: string
}

/**
 * Info button with a tooltip, used to show the `basis` of a number or rule (ARCHITECTURE.md §1 principle 2: "Every rule
 * records its basis string, which the UI shows to the user"). 24 px target (WCAG 2.2 SC 2.5.8 Target Size Minimum).
 */
export function InfoTip({ content, label = 'More information', side, align, className }: InfoTipProps) {
  return (
    <Tooltip content={content} side={side} align={align}>
      <button
        type="button"
        aria-label={label}
        className={cx(
          'inline-grid size-6 shrink-0 place-items-center rounded-full text-subtle transition-colors hover:bg-slate-100 hover:text-ink',
          className,
        )}
      >
        <Info aria-hidden size={16} />
      </button>
    </Tooltip>
  )
}
