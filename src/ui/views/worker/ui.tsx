/**
 * Small building blocks shared by the worker phone screens: the phone's language context, a full-screen dialog that
 * stays inside the phone frame, read-aloud with the Hindi/Urdu spoken fallback, symptom pictograms and the big-button
 * styles (>= 56 px touch targets for gloved hands; WCAG 2.2 SC 2.5.5 asks 44 px).
 */
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import {
  Activity,
  BatteryLow,
  BedSingle,
  Brain,
  CircleQuestionMark,
  ClockExclamationPoint,
  CupSoda,
  Droplets,
  FaceExpressionless,
  FaceSlightlyFrowning,
  Flame,
  Footprints,
  GlassWater,
  Hand,
  HeartPulse,
  MessageSquareExclamationPoint,
  Repeat,
  UserRoundX,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { LangCode, SymptomId } from '../../../engine/types'
import { LANGUAGES, dirFor, type TextDirection } from '../../../i18n'
import { SPOKEN_FALLBACK, hasVoice, speak } from '../../../i18n/speech'
import { cx } from '../../components'

// ─────────────────────────────── Phone context ───────────────────────────────

export interface PhoneContextValue {
  lang: LangCode
  dir: TextDirection
}

export const PhoneContext = createContext<PhoneContextValue>({ lang: 'en', dir: 'ltr' })

/** The phone's own language and direction (the phone may differ from the console language in the #/demo split view). */
export function usePhone(): PhoneContextValue {
  return useContext(PhoneContext)
}

/** `lang`, `dir` and the script-appropriate font stack for an element in `lang` (Urdu needs Nastaliq). */
export function langProps(lang: LangCode): { lang: string; dir: TextDirection; style: { fontFamily: string } } {
  return { lang: LANGUAGES[lang].bcp47, dir: dirFor(lang), style: { fontFamily: LANGUAGES[lang].fontFamily } }
}

// ─────────────────────────────── Read aloud ───────────────────────────────

/**
 * Speaks `text` in `lang`; without a voice for it, speaks the same message in the spoken fallback language (Hindi ↔
 * Urdu, i18n/speech.ts SPOKEN_FALLBACK) when `textIn` can render it there. Returns false when nothing was spoken, so
 * the caller can say so instead of failing silently.
 */
export function speakAloud(text: string, lang: LangCode, textIn?: (alt: LangCode) => string): boolean {
  if (speak(text, lang)) return true
  const alt = SPOKEN_FALLBACK[lang]
  if (alt !== undefined && textIn && hasVoice(alt)) return speak(textIn(alt), alt)
  return false
}

// ─────────────────────────────── Pictograms ───────────────────────────────

/** One pictogram per check-in question (low-literacy support next to the text, never instead of it). */
export const SYMPTOM_ICONS: Readonly<Record<SymptomId, LucideIcon>> = {
  thirst: Droplets,
  heat_rash: Flame,
  cramps: Activity,
  cramps_persistent: ClockExclamationPoint,
  headache: Brain,
  dizziness: Repeat,
  nausea: FaceSlightlyFrowning,
  weakness_fatigue: BatteryLow,
  fainted: BedSingle,
  brown_urine: CupSoda,
  drank_a_lot: GlassWater,
  swollen_hands: Hand,
  repeated_vomiting: FaceExpressionless,
  chest_pain: HeartPulse,
  confusion: CircleQuestionMark,
  slurred_speech: MessageSquareExclamationPoint,
  unsteady_walking: Footprints,
  collapsed_unresponsive: UserRoundX,
  seizure: Zap,
}

// ─────────────────────────────── Styles ───────────────────────────────

/** Card surface used on every phone screen. */
export const TILE = 'rounded-2xl border border-line bg-surface p-4 shadow-xs'

const BIG_VARIANTS = {
  primary: 'bg-shade text-white hover:bg-shade-dark active:bg-shade-dark',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-canvas active:bg-slate-100',
  danger: 'bg-stop-fill text-white hover:bg-stop active:bg-stop',
  emergency: 'bg-emergency-fill text-white hover:bg-emergency active:bg-emergency',
  /** No colours: the caller supplies them (avoids conflicting utilities). */
  bare: '',
} as const

/** A large full-width worker button (wraps long translations instead of overflowing). */
export function bigButton(variant: keyof typeof BIG_VARIANTS = 'secondary', extra?: string): string {
  return cx(
    'flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-3 text-start text-lg leading-snug font-semibold shadow-xs transition-colors select-none',
    'disabled:cursor-not-allowed disabled:opacity-50',
    BIG_VARIANTS[variant],
    extra,
  )
}

/** Icon that points "back" in the reading direction (mirrors under RTL). */
export const MIRROR = 'rtl:-scale-x-100'

// ─────────────────────────────── Dialog ───────────────────────────────

export interface PhoneDialogProps {
  title: ReactNode
  onClose: () => void
  closeLabel: string
  children: ReactNode
  /** Visual tone of the header bar. */
  tone?: 'plain' | 'emergency'
  /** Extra content in the header, after the title (e.g. a progress bar). */
  headerExtra?: ReactNode
  className?: string
}

/**
 * Full-screen dialog inside the phone. The phone screen carries a transform, so `fixed` covers the phone screen on
 * desktop and the viewport on a real phone (components/PhoneFrame.tsx). Escape closes it, focus moves to the dialog
 * and returns to the control that opened it (WCAG 2.2 SC 2.4.3, 2.1.2).
 */
export function PhoneDialog({ title, onClose, closeLabel, children, tone = 'plain', headerExtra, className }: PhoneDialogProps) {
  const { lang } = usePhone()
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus({ preventScroll: true })
    }
  }, [])

  const urgent = tone === 'emergency'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      {...langProps(lang)}
      className={cx('fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-canvas outline-none motion-safe:animate-zill-fade-in', className)}
    >
      <div className={cx('sticky top-0 z-10 shrink-0 border-b px-4 pt-3 pb-3', urgent ? 'border-transparent bg-emergency-fill text-white' : 'border-line bg-surface')}>
        <div className="flex items-center gap-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg leading-tight font-bold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className={cx(
              'grid size-12 shrink-0 place-items-center rounded-full transition-colors',
              urgent ? 'bg-white/15 hover:bg-white/25 focus-visible:outline-white' : 'bg-canvas text-ink hover:bg-slate-100',
            )}
          >
            <X size={22} aria-hidden />
          </button>
        </div>
        {headerExtra}
      </div>
      <div className="flex-1 px-4 py-4">{children}</div>
    </div>
  )
}

/** Simple progress bar (value 0–1) with an accessible name. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className={cx('h-2 overflow-hidden rounded-full bg-shade-tint', className)}>
      <div className="h-full rounded-full bg-shade transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  )
}
