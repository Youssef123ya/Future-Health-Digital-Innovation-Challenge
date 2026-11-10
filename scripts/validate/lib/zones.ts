/**
 * Exposure bands used by the real-data evidence (hours in zone, forecast skill). Every edge is computed from the engine's
 * own implementation of a published limit, never typed in:
 *
 * WBGT (°C, outdoor Liljegren WBGT in sun, cloth work clothes so WBGT_eff = WBGT, CAV 0):
 *   < REL(300 W) ≈ 28.2 · REL(300 W)–RAL(115 W) · RAL(115 W) ≈ 30.8 – 32.1 (Qatar stop) · 32.1 – REL(115 W) ≈ 33.0 · ≥ REL(115 W)
 *   - REL(300 W): NIOSH 2016 §8.1 REL for moderate (ACGIH 300 W) continuous work by an acclimatised worker.
 *   - RAL(115 W): NIOSH RAL at rest — from here even an unacclimatised worker at rest exceeds the RAL.
 *   - 32.1 °C: Qatar Ministerial Decision 17/2021 Art. 4(9) stop-work WBGT (regulation.ts QATAR_RULE_PACK.wbgtStopC).
 *   - REL(115 W): NIOSH REL at rest — from here even an acclimatised worker at rest exceeds the REL.
 * ADOSH TWL zones (W/m²): regulation.ts twlZone with the Abu Dhabi pack (ADOSH-SF TG v4.0 Table 1): High ≤ 115 <
 * Medium ≤ 140 < Low (boundaries resolve to the more protective zone [ENG]).
 * Midday break: regulation.ts isMiddayBreak (MoHRE MR 44/2022: 15 Jun–15 Sep inclusive, 12:30 ≤ local time < 15:00).
 */
import { ralC, relC } from '../../../src/engine/limits'
import { ABU_DHABI_RULE_PACK, QATAR_RULE_PACK, isMiddayBreak, middayBreakWindow, twlZone } from '../../../src/engine/regulation'
import type { TwlZoneId } from '../../../src/engine/regulation'
import * as riskModule from '../../../src/engine/risk'

/** ACGIH representative whole-body metabolic rates used for the band edges (limits.ts ACGIH_METABOLIC_W). */
export const BAND_METABOLIC_W = { rest: 115, moderate: 300, heavy: 415 } as const

const qatarStop = QATAR_RULE_PACK.wbgtStopC
if (qatarStop === undefined) throw new Error('regulation.ts QATAR_RULE_PACK.wbgtStopC is missing')

/** WBGT thresholds (°C) computed from the engine's limit functions. */
export const WBGT_THRESHOLDS = {
  /** REL(300 W) = 56.7 − 11.5·log10(300) ≈ 28.21 °C (NIOSH 2016 §8.1). */
  rel300: relC(BAND_METABOLIC_W.moderate),
  /** RAL(115 W) = 59.9 − 14.1·log10(115) ≈ 30.84 °C (NIOSH 2016 §8.1). */
  ral115: ralC(BAND_METABOLIC_W.rest),
  /** Qatar MD 17/2021 Art. 4(9) stop-work WBGT, 32.1 °C. */
  qatarStop,
  /** REL(115 W) = 56.7 − 11.5·log10(115) ≈ 33.00 °C (NIOSH 2016 §8.1). */
  rel115: relC(BAND_METABOLIC_W.rest),
} as const

/** One WBGT band: lower edge inclusive, upper edge exclusive [ENG: equality has measure zero for modelled values]. */
export interface WbgtBand {
  id: 'below_rel300' | 'rel300_to_ral115' | 'ral115_to_qatar' | 'qatar_to_rel115' | 'above_rel115'
  label: string
  fromC: number | null
  toC: number | null
  meaning: string
  basis: string
}

const fmt = (x: number): string => x.toFixed(1)

/** The five WBGT bands, ascending. */
export const WBGT_BANDS: readonly WbgtBand[] = [
  {
    id: 'below_rel300',
    label: `< ${fmt(WBGT_THRESHOLDS.rel300)}`,
    fromC: null,
    toC: WBGT_THRESHOLDS.rel300,
    meaning: 'below the REL for continuous moderate (300 W) work by an acclimatised worker',
    basis: 'NIOSH 2016-106 §8.1 REL = 56.7 − 11.5·log10 M, M = 300 W (ACGIH moderate)',
  },
  {
    id: 'rel300_to_ral115',
    label: `${fmt(WBGT_THRESHOLDS.rel300)}–${fmt(WBGT_THRESHOLDS.ral115)}`,
    fromC: WBGT_THRESHOLDS.rel300,
    toC: WBGT_THRESHOLDS.ral115,
    meaning: 'moderate work needs a work/rest cycle; resting is still within the RAL',
    basis: 'NIOSH 2016-106 §8.1 REL(300 W) to RAL(115 W)',
  },
  {
    id: 'ral115_to_qatar',
    label: `${fmt(WBGT_THRESHOLDS.ral115)}–${fmt(WBGT_THRESHOLDS.qatarStop)}`,
    fromC: WBGT_THRESHOLDS.ral115,
    toC: WBGT_THRESHOLDS.qatarStop,
    meaning: 'resting in the same conditions exceeds the RAL (unacclimatised workers); cooled rest needed',
    basis: 'NIOSH 2016-106 §8.1 RAL = 59.9 − 14.1·log10 M at M = 115 W',
  },
  {
    id: 'qatar_to_rel115',
    label: `${fmt(WBGT_THRESHOLDS.qatarStop)}–${fmt(WBGT_THRESHOLDS.rel115)}`,
    fromC: WBGT_THRESHOLDS.qatarStop,
    toC: WBGT_THRESHOLDS.rel115,
    meaning: 'above the Qatar stop-work WBGT (comparison only; not an Abu Dhabi rule)',
    basis: 'Qatar Ministerial Decision 17/2021 Art. 4(9) (regulation.ts QATAR_RULE_PACK.wbgtStopC)',
  },
  {
    id: 'above_rel115',
    label: `≥ ${fmt(WBGT_THRESHOLDS.rel115)}`,
    fromC: WBGT_THRESHOLDS.rel115,
    toC: null,
    meaning: 'resting in the same conditions exceeds even the REL (acclimatised workers)',
    basis: 'NIOSH 2016-106 §8.1 REL at M = 115 W',
  },
]

/** Index (0–4) of the WBGT band containing `wbgtC`; a non-finite value maps to the top band (fail-safe [ENG]). */
export function wbgtBandIndex(wbgtC: number): number {
  if (!Number.isFinite(wbgtC)) return WBGT_BANDS.length - 1
  for (let i = WBGT_BANDS.length - 1; i > 0; i--) {
    const from = WBGT_BANDS[i].fromC
    if (from !== null && wbgtC >= from) return i
  }
  return 0
}

/** ADOSH zones in display order (most protective first). */
export const ADOSH_ZONES: readonly TwlZoneId[] = ['high', 'medium', 'low']

/** Zone index into {@link ADOSH_ZONES} for a TWL (regulation.ts twlZone, Abu Dhabi pack; non-finite → High). */
export function adoshZoneIndex(twlWm2: number): number {
  const z = twlZone(twlWm2, ABU_DHABI_RULE_PACK)
  const i = z === null ? 0 : ADOSH_ZONES.indexOf(z.id)
  return i < 0 ? 0 : i
}

/** ADOSH zone edges (W/m²) as transcribed in the Abu Dhabi rule pack, for reporting. */
export function adoshZoneTable(): { id: TwlZoneId; label: string; minWm2: number | null; maxWm2: number | null; basis: string }[] {
  return ABU_DHABI_RULE_PACK.twlZones.map((z) => ({ id: z.id, label: z.label, minWm2: z.minWm2, maxWm2: z.maxWm2, basis: z.basis }))
}

/** True when `t` falls inside the MoHRE midday-break window (regulation.ts isMiddayBreak, Abu Dhabi pack). */
export function inMiddayBreak(t: number): boolean {
  return isMiddayBreak(t, ABU_DHABI_RULE_PACK)
}

/** True when `t` falls on a date inside the midday-break season (regulation.ts middayBreakWindow ≠ null). */
export function inMiddayBreakSeason(t: number): boolean {
  return middayBreakWindow(t, ABU_DHABI_RULE_PACK) !== null
}

/** The midday-break rule as transcribed in the Abu Dhabi pack, for reporting. */
export function middayBreakRule(): { from: string; to: string; startHhmm: string; endHhmm: string; basis: string } | null {
  const r = ABU_DHABI_RULE_PACK.middayBreak
  return r === null ? null : { from: r.from, to: r.to, startHhmm: r.startHhmm, endHhmm: r.endHhmm, basis: r.basis }
}

/**
 * Fallback WBGT of an air-conditioned rest cabin, °C [ENG]: 25 °C, the value the planner tests and the wave-2a planner
 * notes assume for a cooled rest area (ADOSH-SF CoP 11.0 v4.0 §3.2(c) "cooled and air-conditioned rest areas",
 * §3.2(i)). Used only when risk.ts does not export COOLED_REST.
 */
export const COOLED_REST_FALLBACK_WBGT_C = 25

/** The cooled-rest WBGT used by the scripts and where it came from. */
export interface CooledRestWbgt {
  wbgtC: number
  source: string
}

/**
 * WBGT of a cooled rest area: risk.ts `COOLED_REST` when that module exports it (a number, or an object with a numeric
 * `wbgtC`, or any numeric property whose name contains "wbgt"), else {@link COOLED_REST_FALLBACK_WBGT_C} [ENG].
 * Resolved at run time so the scripts follow the engine once the constant exists (types.ts Site.restArea refers to it).
 */
export function cooledRestWbgt(): CooledRestWbgt {
  const mod = riskModule as unknown as Record<string, unknown>
  const v = mod.COOLED_REST
  if (typeof v === 'number' && Number.isFinite(v)) return { wbgtC: v, source: 'engine/risk.ts COOLED_REST' }
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const basis = typeof rec.basis === 'string' ? ` — ${rec.basis}` : ''
    if (typeof rec.wbgtC === 'number' && Number.isFinite(rec.wbgtC)) return { wbgtC: rec.wbgtC, source: `engine/risk.ts COOLED_REST.wbgtC${basis}` }
    for (const [k, x] of Object.entries(rec)) {
      if (/wbgt/i.test(k) && typeof x === 'number' && Number.isFinite(x)) return { wbgtC: x, source: `engine/risk.ts COOLED_REST.${k}${basis}` }
    }
  }
  return {
    wbgtC: COOLED_REST_FALLBACK_WBGT_C,
    source: '[ENG] 25 °C fallback (engine/risk.ts COOLED_REST not exported); ADOSH-SF CoP 11.0 v4.0 §3.2(c),(i) cooled rest areas',
  }
}
