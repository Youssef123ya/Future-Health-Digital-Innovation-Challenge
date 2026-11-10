/**
 * Unit conversions shared by the Zill engine.
 *
 * Every factor here is either an exact SI / US-customary definition or a value transcribed from the research notes
 * (docs/research/*.md), which name the standard that fixes it. Units are encoded in parameter names
 * (C, K, F, Ms, Kmh, Hpa, Kpa, Kg, Cm, M2, Wm2, W, Met, Kcalh, L, Ml).
 */

/**
 * 0 °C expressed in kelvin. Exact by the SI definition of the Celsius scale (ISO 80000-5). Also the offset used by
 * Liljegren's wbgt.c and thermofeel (`tk = Ta + 273.15`; wbgt_liljegren.md §3).
 */
export const KELVIN_OFFSET = 273.15

/** °C → K (SI definition, ISO 80000-5). */
export function cToK(tC: number): number {
  return tC + KELVIN_OFFSET
}

/** K → °C (SI definition, ISO 80000-5). */
export function kToC(tK: number): number {
  return tK - KELVIN_OFFSET
}

/** °C → °F, t_F = 1.8·t_C + 32 (exact definition of the Fahrenheit scale; used for NIOSH 2016 values quoted in °F). */
export function cToF(tC: number): number {
  return tC * 1.8 + 32
}

/** °F → °C, t_C = (t_F − 32)/1.8 (exact definition of the Fahrenheit scale). */
export function fToC(tF: number): number {
  return (tF - 32) / 1.8
}

/** Temperature *difference* in °C (= K) → °F-degrees (factor 1.8, no offset), e.g. a 1 °C hood adjustment = 1.8 °F. */
export function deltaCToF(deltaC: number): number {
  return deltaC * 1.8
}

/** Temperature *difference* in °F-degrees → °C (= K) (factor 1/1.8, no offset). */
export function deltaFToC(deltaF: number): number {
  return deltaF / 1.8
}

/** km/h → m/s (1 km/h = 1000 m / 3600 s, exact). Open-Meteo serves km/h unless `wind_speed_unit=ms` (wbgt_liljegren.md §13.1). */
export function kmhToMs(kmh: number): number {
  return kmh / 3.6
}

/** m/s → km/h (exact, ×3.6). */
export function msToKmh(ms: number): number {
  return ms * 3.6
}

/** hPa → kPa (1 kPa = 10 hPa, exact). PHS and TWL take vapour pressures in kPa (phs_iso7933.md §2.1). */
export function hpaToKpa(hpa: number): number {
  return hpa / 10
}

/** kPa → hPa (exact, ×10). Liljegren's model takes pressures in hPa (wbgt_liljegren.md §3). */
export function kpaToHpa(kpa: number): number {
  return kpa * 10
}

/**
 * DuBois & DuBois (1916) body surface area, A_Du = 0.202 · W^0.425 · H^0.725 [m²] with W in kg and H in metres, as
 * used by ISO 7933 (PHS) and every transcription of it (phs_iso7933.md §3 constants table, §4.2). Gives 1.937871486 m²
 * for 75 kg / 180 cm. Height is taken in centimetres (Zill's `heightCm`) and converted to metres here.
 */
export function duboisBsaM2(massKg: number, heightCm: number): number {
  return 0.202 * Math.pow(massKg, 0.425) * Math.pow(heightCm / 100, 0.725)
}

/** Area-specific power (W/m²) → whole-body power (W) for a body surface area (ISO 8996 / ISO 7933 convention: M per m² of A_Du). */
export function wm2ToW(wm2: number, bsaM2: number): number {
  return wm2 * bsaM2
}

/** Whole-body power (W) → area-specific power (W/m²) for a body surface area (ISO 8996 / ISO 7933 convention). */
export function wToWm2(w: number, bsaM2: number): number {
  return w / bsaM2
}

/**
 * 1 met in W/m², the factor used by pythermalcomfort `met_to_w_m2` for ISO 7933 PHS (phs_iso7933.md §2.1 and §3:
 * "M [W/m²] = met × 58.15").
 */
export const W_M2_PER_MET = 58.15

/** met → W/m² (× 58.15; phs_iso7933.md §3). */
export function metToWm2(met: number): number {
  return met * W_M2_PER_MET
}

/** W/m² → met (÷ 58.15; phs_iso7933.md §3). */
export function wm2ToMet(wm2: number): number {
  return wm2 / W_M2_PER_MET
}

/**
 * Watts per kcal/h: 4186.8 J / 3600 s = 1.163 W (International Table calorie). NIOSH 2016 §1.1.3 prints the rounded
 * "1 kcal·h⁻¹ = 1.16 W"; the research fact-check corrected it to the exact 1.163, which NIOSH's own worked example
 * (300 kcal/h = 348.9 W) uses (limits_and_workrest.md §1.3).
 */
export const W_PER_KCAL_H = 1.163

/** kcal/h → W (× 1.163; NIOSH 2016 §1.1.3, corrected to the exact IT-calorie factor). */
export function kcalhToW(kcalh: number): number {
  return kcalh * W_PER_KCAL_H
}

/** W → kcal/h (÷ 1.163; NIOSH 2016 §1.1.3, corrected to the exact IT-calorie factor). */
export function wToKcalh(w: number): number {
  return w / W_PER_KCAL_H
}

/**
 * One US liquid quart in litres: exactly 0.946352946 L (US gallon = 231 in³, in = 2.54 cm; NIST Handbook 44 App. C).
 * TB MED 507 (2022) Table 3-6 fluid caps are in quarts: 1.5 qt/h = 1.42 L/h and 12 qt/day = 11.36 L/day
 * (physio_and_clinical.md §8).
 */
export const L_PER_US_QUART = 0.946352946

/** One US fluid ounce in millilitres: exactly 29.5735295625 mL (1/128 US gallon; NIST Handbook 44 App. C). 8 fl oz = 1 cup (NIOSH 2016). */
export const ML_PER_US_FL_OZ = 29.5735295625

/** US quarts → litres (exact definition; TB MED 507 fluid caps). */
export function usQuartToL(quarts: number): number {
  return quarts * L_PER_US_QUART
}

/** Litres → US quarts (exact definition). */
export function lToUsQuart(litres: number): number {
  return litres / L_PER_US_QUART
}

/** US fluid ounces → millilitres (exact definition; NIOSH 2016 "1 cup = 8 oz" cadence). */
export function usFlOzToMl(flOz: number): number {
  return flOz * ML_PER_US_FL_OZ
}

/** Millilitres → US fluid ounces (exact definition). */
export function mlToUsFlOz(ml: number): number {
  return ml / ML_PER_US_FL_OZ
}

/** Litres → millilitres (SI, ×1000). */
export function lToMl(litres: number): number {
  return litres * 1000
}

/** Millilitres → litres (SI, ÷1000). */
export function mlToL(ml: number): number {
  return ml / 1000
}
