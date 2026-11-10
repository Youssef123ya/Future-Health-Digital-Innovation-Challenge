import { Droplet, Hand, ShieldCheck, Siren, TriangleExclamationPoint, type LucideIcon } from 'lucide-react'
import type { RiskLevel } from '../../engine/types'

/**
 * Visual encoding of one Zill risk level. A level is always carried by three redundant channels: colour, a pictogram
 * with a distinct silhouette, and a text label. It therefore survives colour-vision deficiency, sun glare on a phone and
 * greyscale printing (WCAG 2.2 SC 1.4.1 Use of Color; ARCHITECTURE.md §9 "level card (pictogram + colour + text)").
 * All values are complete Tailwind class names so the compiler can see them.
 */
export interface LevelStyle {
  /** Pictogram: shield-check, droplet, triangle-alert, hand (stop) and siren have distinct outlines. */
  icon: LucideIcon
  /** Text colour, >= 4.5:1 on white and on {@link LevelStyle.tint} (WCAG 2.2 SC 1.4.3). */
  text: string
  /** Light background step of the level's ramp. */
  tint: string
  /** Border at 40 % of the fill colour, for tinted surfaces. */
  softBorder: string
  /** Full-strength border in the fill colour. */
  border: string
  /** Solid fill background (bars, discs, solid pills). */
  solid: string
  /** Foreground on {@link LevelStyle.solid}: ink for safe/caution/high, white for stop/emergency (all >= 4.5:1). */
  onSolid: string
  /** `currentColor` class for SVG marks on white, >= 3:1 against white and the track (WCAG 2.2 SC 1.4.11). */
  mark: string
  /** `currentColor` class for an unfilled SVG track: a lighter step of the same ramp. */
  track: string
}

/**
 * Level → visual encoding. Contrast (computed from the tokens in src/index.css; asserted in logic.test.ts): text on its
 * tint 4.6–12.7:1 and on white 5.0–15:1; ink on the safe/caution/high fills 5.3–8.7:1; white on the stop/emergency fills
 * 4.8 and 7.0:1; marks 3.0–7.0:1 on white and on their track. The caution mark uses amber-700 because the amber-500 fill
 * reaches only 2.2:1 on white. Salience rises with severity: stop and emergency switch to white text on a saturated
 * fill. [ENG]
 */
export const LEVEL_STYLES: Readonly<Record<RiskLevel, LevelStyle>> = {
  safe: {
    icon: ShieldCheck,
    text: 'text-safe',
    tint: 'bg-safe-bg',
    softBorder: 'border-safe-fill/40',
    border: 'border-safe-fill',
    solid: 'bg-safe-fill',
    onSolid: 'text-ink',
    mark: 'text-safe-fill',
    track: 'text-safe-bg',
  },
  caution: {
    icon: Droplet,
    text: 'text-caution',
    tint: 'bg-caution-bg',
    softBorder: 'border-caution-fill/40',
    border: 'border-caution-fill',
    solid: 'bg-caution-fill',
    onSolid: 'text-ink',
    mark: 'text-amber-700',
    track: 'text-caution-bg',
  },
  high: {
    icon: TriangleExclamationPoint,
    text: 'text-high',
    tint: 'bg-high-bg',
    softBorder: 'border-high-fill/40',
    border: 'border-high-fill',
    solid: 'bg-high-fill',
    onSolid: 'text-ink',
    mark: 'text-high-fill',
    track: 'text-high-bg',
  },
  stop: {
    icon: Hand,
    text: 'text-stop',
    tint: 'bg-stop-bg',
    softBorder: 'border-stop-fill/40',
    border: 'border-stop-fill',
    solid: 'bg-stop-fill',
    onSolid: 'text-white',
    mark: 'text-stop-fill',
    track: 'text-stop-bg',
  },
  emergency: {
    icon: Siren,
    text: 'text-emergency',
    tint: 'bg-emergency-bg',
    softBorder: 'border-emergency-fill/40',
    border: 'border-emergency-fill',
    solid: 'bg-emergency-fill',
    onSolid: 'text-white',
    mark: 'text-emergency-fill',
    track: 'text-emergency-bg',
  },
}

/**
 * English level names, used when a view does not pass a localised label. The order safe < caution < high < stop <
 * emergency is ARCHITECTURE.md §5; T1/T2/T3 clinical tiers map to high/stop/emergency (TIER_TO_LEVEL in engine/types.ts).
 */
export const DEFAULT_LEVEL_LABELS: Readonly<Record<RiskLevel, string>> = {
  safe: 'Safe',
  caution: 'Caution',
  high: 'High risk',
  stop: 'Stop work',
  emergency: 'Emergency',
}
