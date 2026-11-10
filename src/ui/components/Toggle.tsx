import { useId, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cx } from './cx'

export interface ToggleProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible label; clicking it toggles the switch. */
  label: ReactNode
  /** Help text, linked with `aria-describedby` (e.g. what a consent scope shares and with whom). */
  description?: ReactNode
  disabled?: boolean
  /** md for consoles; lg gives a >= 48 px row for worker screens. */
  size?: 'md' | 'lg'
  /** Keep the label for screen readers only. */
  hideLabel?: boolean
  id?: string
  className?: string
}

/**
 * On/off switch (WAI-ARIA APG Switch pattern: `role="switch"` + `aria-checked`). Used for the opt-in, revocable consent
 * scopes of ARCHITECTURE.md §7. State is shown by thumb position, track colour and a check mark, never colour alone
 * (WCAG 2.2 SC 1.4.1); the off track (slate-500) keeps 4.8:1 against white (SC 1.4.11 Non-text Contrast). The thumb
 * travels toward the inline end, so it mirrors in RTL.
 */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  size = 'md',
  hideLabel = false,
  id,
  className,
}: ToggleProps) {
  const autoId = useId()
  const switchId = id ?? `${autoId}-switch`
  const labelId = `${switchId}-label`
  const descriptionId = description ? `${switchId}-description` : undefined
  const lg = size === 'lg'

  return (
    <div className={cx('flex items-start gap-3', lg && 'min-h-12 py-1', className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cx(
          'relative inline-flex shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
          lg ? 'mt-1 h-8 w-14' : 'h-6 w-11',
          checked ? 'bg-shade' : 'bg-slate-500',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'pointer-events-none grid place-items-center rounded-full bg-white text-shade shadow-sm transition-transform duration-150',
            lg ? 'size-7' : 'size-5',
            checked ? (lg ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-5 rtl:-translate-x-5') : 'translate-x-0',
          )}
        >
          {checked && <Check size={lg ? 16 : 12} strokeWidth={3} />}
        </span>
      </button>
      <div className={cx('min-w-0', hideLabel && 'sr-only')}>
        <label
          id={labelId}
          htmlFor={switchId}
          className={cx('block font-medium text-ink', lg ? 'pt-1.5 text-base' : 'text-sm', !disabled && 'cursor-pointer')}
        >
          {label}
        </label>
        {description && (
          <div id={descriptionId} className="mt-0.5 text-sm text-muted">
            {description}
          </div>
        )}
      </div>
    </div>
  )
}
