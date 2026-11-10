import type { ButtonHTMLAttributes, Ref } from 'react'
import { LoaderCircle, type LucideIcon } from 'lucide-react'
import { cx } from './cx'

/** Visual role of a button. `danger` and `emergency` are reserved for stop- and 998-level actions. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'emergency' | 'inverse'

/** Button height: sm 32 px, md 40 px (consoles), lg 48 px and xl 56 px (worker screens). */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

/** Options shared by {@link Button} and {@link buttonClasses}. */
export interface ButtonStyleOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Square button holding only an icon; give it an `aria-label`. */
  iconOnly?: boolean
}

const BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

// Contrast: white on teal-700 5.5:1, on red-600 4.8:1, on purple-700 7.0:1; ink on white 18.7:1 (WCAG 2.2 SC 1.4.3).
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-shade text-white shadow-xs hover:bg-shade-dark active:bg-shade-dark',
  secondary: 'border border-line-strong bg-surface text-ink shadow-xs hover:bg-canvas active:bg-slate-100',
  ghost: 'text-muted hover:bg-slate-100 hover:text-ink active:bg-slate-200',
  danger: 'bg-stop-fill text-white shadow-xs hover:bg-stop active:bg-stop',
  emergency: 'bg-emergency-fill text-white shadow-xs hover:bg-emergency active:bg-emergency',
  inverse: 'bg-white/10 text-white hover:bg-white/20 active:bg-white/25 focus-visible:outline-shade-light',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'min-h-12 px-5 text-base',
  xl: 'min-h-14 px-6 text-lg',
}

const ICON_ONLY: Record<ButtonSize, string> = { sm: 'size-8', md: 'size-10', lg: 'size-12', xl: 'size-14' }
const ICON_PX: Record<ButtonSize, number> = { sm: 16, md: 16, lg: 20, xl: 24 }

/**
 * Class string for a button-styled element, for anchors that must look like buttons
 * (e.g. `<a href={toHref('/')} className={buttonClasses({ variant: 'primary' })}>`). Sizes lg/xl give the >= 48 px
 * touch targets required on worker screens (exceeds WCAG 2.2 SC 2.5.5 Target Size, 44 px; [ENG] 48 px for gloved hands).
 */
export function buttonClasses({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  iconOnly = false,
}: ButtonStyleOptions = {}): string {
  return cx(BASE, VARIANTS[variant], iconOnly ? ICON_ONLY[size] : SIZES[size], fullWidth && 'w-full')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** Leading icon (decorative; the text label names the action). */
  icon?: LucideIcon
  /** Trailing icon. */
  iconEnd?: LucideIcon
  /** Shows a spinner, sets `aria-busy` and disables the button. */
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

/**
 * Button with variants and sizes. Defaults to `type="button"` so it never submits a form by accident. Focus is shown by
 * the global focus ring (WCAG 2.2 SC 2.4.7); the spinner stops under prefers-reduced-motion (SC 2.3.3).
 */
export function Button({
  variant,
  size = 'md',
  fullWidth,
  iconOnly,
  icon: Icon,
  iconEnd: IconEnd,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const px = ICON_PX[size]
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClasses({ variant, size, fullWidth, iconOnly }), className)}
      {...rest}
    >
      {loading ? (
        <LoaderCircle aria-hidden size={px} className="animate-spin" />
      ) : (
        Icon && <Icon aria-hidden size={px} />
      )}
      {children}
      {IconEnd && <IconEnd aria-hidden size={px} />}
    </button>
  )
}
