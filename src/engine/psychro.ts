/**
 * Psychrometric helpers.
 *
 * Two saturation-vapour-pressure formulas live here on purpose, and they must not be mixed:
 *  - the **Liljegren** form (Buck 1981 with a 1.004 enhancement factor), in hPa with T in kelvin, used by the outdoor
 *    WBGT model (wbgt.ts) and to turn an Open-Meteo dew point into RH (docs/research/wbgt_liljegren.md §5, §13.2);
 *  - the **Tetens** form 0.6105·exp(17.27·t/(t+237.3)) in kPa with t in °C, used by ISO 7933:2023 PHS and by the
 *    Thermal Work Limit (docs/research/phs_iso7933.md §2.1, §4.1; docs/research/twl_and_regulation.md §1.3).
 * Each model is validated against its own oracle with its own formula, so each module calls the one named here.
 *
 * The psychrometric (aspirated) wet bulb needs the Liljegren wick energy balance and is therefore exported from
 * wbgt.ts (`psychrometricWetBulb`), not from this module.
 */

import { KELVIN_OFFSET } from './units'

/** Lower and upper RH bounds accepted by the Liljegren model: RH = 0 makes ln(e) = −∞ in the dew point (D8, §13.2). */
export const RH_MIN_PCT = 1
/** Upper RH bound: saturation (Liljegren decision D8, wbgt_liljegren.md §13.2). */
export const RH_MAX_PCT = 100

/**
 * Clamp a relative humidity to [1, 100] %. Liljegren decision D8 (wbgt_liljegren.md §0 and §13.2): RH = 0 gives NaN,
 * and super-saturation is not physical for the model.
 */
export function clampRhPct(rhPct: number): number {
  return Math.max(RH_MIN_PCT, Math.min(RH_MAX_PCT, rhPct))
}

/**
 * Saturation vapour pressure over liquid water, Liljegren et al. (2008) / wbgt.c `esat` (phase 0):
 * e_sat = 1.004 · 6.1121 · exp(17.502·(T − 273.15)/(T − 32.18))  [hPa], T in K.
 * Buck (1981) with the 1.004 enhancement factor (wbgt_liljegren.md §5). Spot value: 42.6048337558 hPa at 303.15 K.
 * Operation order follows the oracle transliteration so the WBGT port stays at machine precision.
 */
export function liljegrenEsatHpa(tK: number): number {
  const y = (tK - 273.15) / (tK - 32.18)
  return 1.004 * (6.1121 * Math.exp(17.502 * y))
}

/**
 * Dew point (K) of a vapour pressure e (hPa): the exact inverse of `liljegrenEsatHpa`,
 * T_d = 273.15 + 240.97·z/(17.502 − z), z = ln(e/(6.1121·1.004)) (wbgt.c `dew_point`; wbgt_liljegren.md §5).
 */
export function liljegrenDewPointK(eHpa: number): number {
  const z = Math.log(eHpa / (6.1121 * 1.004))
  return 273.15 + (240.97 * z) / (17.502 - z)
}

/**
 * Ambient vapour pressure e_a = RH/100 · e_sat(T_a) [hPa] with the Liljegren saturation curve (the model's `eair`,
 * wbgt_liljegren.md §8). RH is clamped to [1, 100] % (D8).
 */
export function vapourPressureHpa(taC: number, rhPct: number): number {
  return (clampRhPct(rhPct) / 100) * liljegrenEsatHpa(taC + KELVIN_OFFSET)
}

/**
 * Relative humidity from a dew point with the Liljegren esat: RH = 100·e_sat(T_d)/e_sat(T_a), clamped to [1, 100] %
 * (wbgt_liljegren.md §13.2, decision D8). The 1.004 enhancement factor cancels. This is the preferred humidity input
 * for Open-Meteo data (`dew_point_2m` has 0.1 °C resolution, `relative_humidity_2m` is an integer); the model's
 * `dew_point(eair)` then returns T_d exactly.
 */
export function rhFromDewPointPct(taC: number, tdC: number): number {
  return clampRhPct((100 * liljegrenEsatHpa(tdC + KELVIN_OFFSET)) / liljegrenEsatHpa(taC + KELVIN_OFFSET))
}

/** Dew point (°C) from air temperature and RH, via the Liljegren esat and its exact inverse (wbgt_liljegren.md §5). */
export function dewPointC(taC: number, rhPct: number): number {
  return liljegrenDewPointK(vapourPressureHpa(taC, rhPct)) - KELVIN_OFFSET
}

/**
 * Saturation vapour pressure, Tetens form used by ISO 7933:2023 PHS and by the Thermal Work Limit:
 * p_sat = 0.6105 · exp(17.27·t/(t + 237.3))  [kPa], t in °C.
 * Basis: ISO 7933:2023 pre-processing as implemented in pythermalcomfort (phs_iso7933.md §2.1, §4.1 —
 * "2023: 0.6105·exp(17.27·tdb/(tdb+237.3))·rh/100"); TWL helper choice "fits Table I better than Hyland-Wexler or
 * Buck" (twl_and_regulation.md §1.3, §1.8). Not to be mixed with `liljegrenEsatHpa`.
 */
export function psatTetensKpa(tC: number): number {
  return 0.6105 * Math.exp((17.27 * tC) / (tC + 237.3))
}

/**
 * Partial water-vapour pressure for PHS / TWL: p_a = p_sat,Tetens(t_a) · RH/100 [kPa]
 * (ISO 7933:2023 pre-processing, phs_iso7933.md §4.1). RH is used as given (PHS validity checks are the caller's job).
 */
export function vapourPressureTetensKpa(taC: number, rhPct: number): number {
  return (psatTetensKpa(taC) * rhPct) / 100
}
