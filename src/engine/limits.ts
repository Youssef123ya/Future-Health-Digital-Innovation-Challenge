/**
 * Zill — occupational heat exposure limits, work–rest, acclimatisation, heat index and hydration.
 *
 * Pure TypeScript (no DOM, no clock, no randomness). Every constant is transcribed from
 * docs/research/limits_and_workrest.md (§ numbers below; §11 "port-ready constants" is authoritative), with the
 * fact-check corrections applied. Engineering choices that no standard fixes are tagged [ENG] and resolve in the
 * worker-protective direction.
 *
 * What lives here:
 *  - NIOSH 2016 REL/RAL (= ACGIH TLV/Action Limit = ISO 7243:2017 Annex A) and the 1-h TWA allowed work fraction.
 *    NIOSH 2016 REMOVED the old ceiling limits; there is deliberately no "ceiling" here (see NIOSH_HAS_CEILING_LIMIT).
 *  - ISO 8996:2004 metabolic classes, ACGIH Table 3 watts with body-mass scaling, typical task classes.
 *  - ACGIH clothing adjustment values (CAV), hood addition, PHS clothing inputs per ensemble.
 *  - ACGIH Table 2 screening criteria (reproduced exactly from the equations).
 *  - Acclimatisation status and exposure ramps (ADOSH-SF CoP 11.0 TG v4.0, NIOSH 2016, ACGIH).
 *  - NWS heat index (full algorithm), NWS/OSHA/Dubai Municipality heat-index levels (risk communication only — never a
 *    substitute for WBGT limits).
 *  - TB MED 507 (2022) heat categories, work/rest and water tables; ILO 2024 Table 8 water; hydration caps; NIOSH Heat
 *    Alert trigger; OSHA NPRM (proposed) triggers; Bröde 2018 work-capacity reference curves.
 *
 * Claims discipline: these are occupational-safety exposure criteria. Nothing here diagnoses, "predicts heat stroke" or
 * measures core temperature.
 */

import type { AcclimatizationStatus, ClothingId, WorkClass } from './types'

// ═════════════════════════════════════ Basis strings ═════════════════════════════════════

/**
 * Citation strings for `RiskDriver.basis` and UI provenance (limits_and_workrest.md; twl_and_regulation.md §2;
 * phs_iso7933.md §9; context_and_commercial.md §1.2, §3.2).
 */
export const LIMITS_BASIS = {
  rel: 'NIOSH 2016-106 §8.1 REL = 56.7 − 11.5·log10 M[W] (= ACGIH TLV = ISO 7243:2017 Annex A, acclimatised)',
  ral: 'NIOSH 2016-106 §8.1 RAL = 59.9 − 14.1·log10 M[W] (= ACGIH Action Limit = ISO 7243:2017 Annex A, unacclimatised)',
  twa: 'ISO 7243:2017 §9.2 Formula (4); NIOSH 2016 §1 and ACGIH TLV 1-h time-weighted averages',
  allowedWork:
    'NIOSH 2016 §8.1 + ACGIH TLV Heat Stress: 1-h TWA of WBGT_eff and M against REL/RAL(M_TWA), rest at 115 W (ACGIH Table 2 basis)',
  clothing: 'ACGIH TLV 2026 Table 1 clothing adjustment values (via CCOHS); ISO 7243:2017 Formula (3) WBGT_eff = WBGT + CAV',
  screening: 'ACGIH TLV Heat Stress Table 2 screening criteria (TWA metabolic rate, rest 115 W, nearest 0.5 °C)',
  metabolic: 'ACGIH TLV Table 3 / OSHA Heat Hazard Recognition workload table (70 kg worker); ISO 8996:2004 Table A.2',
  acclimatization:
    'ADOSH-SF CoP 11.0 TG v4.0 Table 1 note b (unacclimatised = new or > 14 days off) and §3 table (NSC) = NIOSH 2016 Table 4-1',
  heatIndex: 'NWS/WPC Heat Index Equation (Rothfusz 1990 SR 90-23 + NWS adjustments + Steadman simple formula)',
  oshaHeatIndex: 'NIOSH 2016-106 Appendix C Table C-1 (adapted from OSHA 2012)',
  dubaiHeatIndex: 'Dubai Municipality DM-HSD-GU38-MHSW2 V2.0 (8 Oct 2019) heat-index risk levels',
  tbmed507: 'US Army TB MED 507 (12 Apr 2022) Figure 3-3, Tables 3-2 and 3-3',
  hydration: 'NIOSH 2016 §1.7.3(g); NIOSH 2017-126 Hydration fact sheet; TB MED 507 (2022) Table 3-2 notes and Table 3-6',
  ilo2024Water: 'ILO (2024) Heat at work: implications for safety and health, Table 8 (FAME Lab PHS simulation)',
  heatAlert: 'NIOSH 2016-106 §6.2.6(1)(d) Heat Alert declaration criteria',
  oshaNprm: 'OSHA NPRM 89 FR 70698 (30 Aug 2024), proposed 29 CFR 1910.148 — proposed, NOT in force',
  workCapacity: 'Bröde et al. 2018 Int J Biometeorol 62:331 (pythermalcomfort 4.8.1) — productivity estimate, not an exposure limit',
} as const

// ═════════════════════════════════════ Input guards ═════════════════════════════════════

function requireFinite(fn: string, name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${fn}: ${name} must be a finite number (got ${value})`)
}

const cToF = (c: number): number => 1.8 * c + 32
const fToC = (f: number): number => (f - 32) / 1.8

// ═════════════════════════════════════ NIOSH REL / RAL ═════════════════════════════════════

/**
 * NIOSH 2016-106 §8.1 (p. 93) coefficients: WBGT_eff limit [°C] = a − b·log10(M [W]).
 * Identical to the ACGIH Action Limit/TLV (ASSP Professional Safety, Aug 2022) and the ISO 7243:2017 Annex A reference
 * equations; regenerates every published ACGIH Table 2 cell (limits_and_workrest.md §3.5). Standard worker 70 kg,
 * 1.8 m², conventional one-layer work clothes (NIOSH §1.1.1).
 */
export const NIOSH_LIMITS = {
  /** Recommended Alert Limit — unacclimatised workers (= ACGIH Action Limit). */
  ral: { a: 59.9, b: 14.1 },
  /** Recommended Exposure Limit — acclimatised workers (= ACGIH TLV). */
  rel: { a: 56.7, b: 11.5 },
} as const

/** Metabolic rate during rest [W]: the ACGIH Table 2 basis ("the metabolic rate for rest is taken as 115 W"). */
export const REST_METABOLIC_W = 115

/**
 * Lower clamp for the limit equations [W]: M_eff = max(M, 115 W) (limits_and_workrest.md §1.1 [D]; the NIOSH figures
 * start at 116 W). The high end is NOT clamped: the equations keep decreasing, so extrapolation stays conservative.
 */
export const MIN_METABOLIC_W = 115

/** End of the plotted metabolic range [W] (ACGIH Figure 2 x-axis; NIOSH figures end at 580 W). Beyond it = extrapolated. */
export const MAX_PLOTTED_METABOLIC_W = 600

/**
 * NIOSH ceiling limits do not exist any more. NIOSH 2016-106 Executive Summary (p. vii) and §8.1: "Further consideration of
 * the scientific data led to the decision to remove the ceiling limit recommendations from the document." Zill therefore
 * implements no ceiling; upper protective actions come from ISO 7933 PHS, the ACGIH heat-strain limits (Table 4) and
 * symptoms (limits_and_workrest.md §0 decision 8).
 */
export const NIOSH_HAS_CEILING_LIMIT = false

/** Which NIOSH limit applies: REL (acclimatised; = ACGIH TLV) or RAL (unacclimatised; = ACGIH Action Limit). */
export type ExposureLimitId = 'REL' | 'RAL'

/**
 * NIOSH Recommended Alert Limit, °C-WBGT_eff, pure equation (unclamped): RAL = 59.9 − 14.1·log10 M (M in W).
 * Basis: NIOSH 2016-106 §8.1; = ACGIH Action Limit; = ISO 7243:2017 Annex A (unacclimatised).
 */
export function ralC(mW: number): number {
  return NIOSH_LIMITS.ral.a - NIOSH_LIMITS.ral.b * Math.log10(mW)
}

/**
 * NIOSH Recommended Exposure Limit, °C-WBGT_eff, pure equation (unclamped): REL = 56.7 − 11.5·log10 M (M in W).
 * Basis: NIOSH 2016-106 §8.1; = ACGIH TLV; = ISO 7243:2017 Annex A (acclimatised).
 */
export function relC(mW: number): number {
  return NIOSH_LIMITS.rel.a - NIOSH_LIMITS.rel.b * Math.log10(mW)
}

/**
 * Engine policy limit, °C-WBGT_eff: the NIOSH equation evaluated at M_eff = max(M, 115 W). No ceiling (removed in NIOSH
 * 2016) and no upper clamp on M. Basis: NIOSH 2016-106 §8.1; limits_and_workrest.md §1.1 domain rule [D].
 * @throws RangeError when `mW` is not finite (the caller applies its fail-safe default).
 */
export function exposureLimitC(mW: number, limit: ExposureLimitId): number {
  requireFinite('exposureLimitC', 'mW', mW)
  const m = Math.max(mW, MIN_METABOLIC_W)
  return limit === 'REL' ? relC(m) : ralC(m)
}

/**
 * Choose the limit: REL only for an `acclimatized` worker outside conservative mode; RAL for unacclimatised,
 * acclimatising, unknown status, or conservative mode (any risk flag / first 14 days). Basis: limits_and_workrest.md §0
 * decision 2; ARCHITECTURE §5 conservative mode and fail-safe "unknown acclimatisation → unacclimatised".
 */
export function selectExposureLimit(status: AcclimatizationStatus | undefined, conservativeMode = false): ExposureLimitId {
  return status === 'acclimatized' && !conservativeMode ? 'REL' : 'RAL'
}

// ═════════════════════════════════════ Metabolic rate ═════════════════════════════════════

/**
 * ACGIH TLV Table 3 representative metabolic rates [W] for a 70 kg worker (identical in the OSHA Heat Hazard Recognition
 * workload table and ISO 7243:2017 Table A.1). ACGIH built Table 2 with 300 W for Moderate (not ISO's 295 W): use these
 * wherever results must match ACGIH/NIOSH/ISO 7243 (limits_and_workrest.md §3.7, §5.2).
 */
export const ACGIH_METABOLIC_W: Readonly<Record<WorkClass, number>> = {
  rest: 115,
  light: 180,
  moderate: 300,
  heavy: 415,
  very_heavy: 520,
}

/** Reference body mass of the ACGIH/NIOSH metabolic rates [kg] (ACGIH Table 3 footnote; OSHA workload table footnote). */
export const ACGIH_REFERENCE_MASS_KG = 70

/** Fail-safe body mass when unknown [kg] (ARCHITECTURE §5 fail-safe defaults: "Unknown body size → 75 kg, 1.75 m"). */
export const DEFAULT_BODY_MASS_KG = 75

/** Fail-safe height when unknown [cm] (ARCHITECTURE §5 fail-safe defaults). */
export const DEFAULT_HEIGHT_CM = 175

/** ISO 8996:2004 introduction: "average" man 30 y, 70 kg, 1.75 m → 1.8 m²; woman 30 y, 60 kg, 1.70 m → 1.6 m². */
export const STANDARD_BSA_M2 = { male70kg175cm: 1.8, female60kg170cm: 1.6 } as const

/** 1 kcal(IT)/h = 4186.8 J / 3600 s = 1.163 W (NIOSH worked example 300 kcal/h = 348.9 W; NIOSH text rounds to 1.16). */
export const KCAL_PER_H_TO_W = 1.163

/** One ISO 8996:2004 Table A.2 metabolic-rate class mapped onto Zill's `WorkClass`. */
export interface Iso8996Class {
  workClass: WorkClass
  isoClass: 0 | 1 | 2 | 3 | 4
  isoName: 'resting' | 'low' | 'moderate' | 'high' | 'very_high'
  /** Class mean, W/m². */
  meanWm2: number
  /** Class range, W/m² (upper bound Infinity for class 4). */
  rangeWm2: readonly [number, number]
  /** Tabulated whole-body mean for 1.8 m², W (copied as printed; not a strict ×1.8 — fact-check correction 5). */
  meanW: number
  rangeW: readonly [number, number]
  /** Condensed ISO 8996:2004 examples. */
  examples: string
}

/**
 * ISO 8996:2004 Table A.2, classification by kind of activity (secondary reproduction: Foster et al., Front Physiol
 * 2020;11:541483). W column copied as tabulated (limits_and_workrest.md §5.2, fact-check corrected). The same class means
 * (65/100/165/230/290 W/m²) are the PHS workload inputs (phs_iso7933.md §9.1). ISO 8996:2021 numeric ranges: UNVERIFIED.
 */
export const ISO8996_2004_CLASSES: Readonly<Record<WorkClass, Iso8996Class>> = {
  rest: {
    workClass: 'rest', isoClass: 0, isoName: 'resting', meanWm2: 65, rangeWm2: [55, 70], meanW: 115, rangeW: [100, 125],
    examples: 'resting, sitting at ease',
  },
  light: {
    workClass: 'light', isoClass: 1, isoName: 'low', meanWm2: 100, rangeWm2: [70, 130], meanW: 180, rangeW: [125, 235],
    examples: 'light manual or bench work (writing, assembly, inspection); driving in normal conditions; walking ≤ 2.5 km/h',
  },
  moderate: {
    workClass: 'moderate', isoClass: 2, isoName: 'moderate', meanWm2: 165, rangeWm2: [130, 200], meanW: 295, rangeW: [235, 360],
    examples:
      'sustained hand/arm work (hammering nails, filing); off-road operation of lorries, tractors or construction equipment; pushing light carts or wheelbarrows; walking 2.5–5.5 km/h',
  },
  heavy: {
    workClass: 'heavy', isoClass: 3, isoName: 'high', meanWm2: 230, rangeWm2: [200, 260], meanW: 415, rangeW: [360, 465],
    examples: 'intense arm and trunk work; carrying heavy material; shovelling; sawing; digging; pushing heavily loaded carts; walking 5.5–7 km/h',
  },
  very_heavy: {
    workClass: 'very_heavy', isoClass: 4, isoName: 'very_high', meanWm2: 290, rangeWm2: [260, Number.POSITIVE_INFINITY], meanW: 520,
    rangeW: [465, Number.POSITIVE_INFINITY],
    examples: 'very intense activity at fast to maximum pace; axe work; intense shovelling or digging; climbing stairs, ramps or ladders; running',
  },
}

/** A typical Zill task and the metabolic class it is planned at. */
export interface TypicalTask {
  id: string
  label: string
  workClass: WorkClass
  basis: string
}

/**
 * Typical construction / industry / logistics tasks by class, from the OSHA Heat Hazard Recognition workload list
 * (limits_and_workrest.md §1.4, §5.2). Fact-check correction 6: forklift / mobile-equipment operation is MODERATE (OSHA
 * "driving or operating mobile equipment"; ISO 8996 off-road equipment operation), not Light. Where the OSHA list and
 * ISO 8996 disagree the higher class is used (ISO 7243:2017 §9.3: when in doubt and estimation is impossible, use the
 * higher metabolic rate).
 */
export const TYPICAL_TASKS: readonly TypicalTask[] = [
  { id: 'rest_shade', label: 'Resting, sitting in shade', workClass: 'rest', basis: 'ACGIH Table 3 Rest (sitting); OSHA list: sitting' },
  { id: 'driving_vehicle', label: 'Driving a car or van', workClass: 'light', basis: 'OSHA list Light: driving a car' },
  { id: 'inspection', label: 'Inspection, standing watch', workClass: 'light', basis: 'OSHA list Light: standing watch; ISO 8996 class 1: inspection' },
  {
    id: 'forklift_mobile_equipment', label: 'Forklift or other mobile-equipment operation', workClass: 'moderate',
    basis: 'OSHA list Moderate: driving or operating mobile equipment; ISO 8996 class 2: off-road equipment (fact-check correction 6)',
  },
  { id: 'general_carpentry', label: 'General carpentry, using hand tools', workClass: 'moderate', basis: 'OSHA list Moderate: general carpentry, using hand tools' },
  { id: 'packaging', label: 'Packaging, laboratory work', workClass: 'moderate', basis: 'OSHA list Moderate: packaging, laboratory work' },
  { id: 'painting_plastering', label: 'Scraping, painting or plastering', workClass: 'moderate', basis: 'OSHA list Moderate: scraping, painting or plastering' },
  { id: 'machining_drilling', label: 'Tapping and drilling, machining', workClass: 'moderate', basis: 'OSHA list Moderate: tapping and drilling, machining' },
  { id: 'walking_light_carts', label: 'Continuous normal walking, pushing light carts', workClass: 'moderate', basis: 'OSHA list Moderate: continuous normal walking, pushing/pulling light carts' },
  { id: 'carrying_loads', label: 'Carrying loads, manual lifting and lowering', workClass: 'heavy', basis: 'OSHA list Heavy: carrying loads, manual raising/lowering loads' },
  { id: 'rebar_concrete', label: 'Rebar or concrete work (mixing cement, drilling concrete)', workClass: 'heavy', basis: 'OSHA list Heavy: mixing cement, drilling rock or concrete' },
  { id: 'roofing', label: 'Roofing', workClass: 'heavy', basis: 'OSHA list Heavy: roofing' },
  { id: 'welding', label: 'Welding, grinding and cutting', workClass: 'heavy', basis: 'OSHA list Heavy: welding, grinding and cutting (ISO 8996: not listed)' },
  { id: 'shovelling_sawing', label: 'Shovelling, sawing or heavy carpentry', workClass: 'heavy', basis: 'OSHA list Heavy: shoveling, sawing or heavy carpentry' },
  { id: 'vehicle_repair', label: 'Truck and automobile repair', workClass: 'heavy', basis: 'OSHA list Heavy: truck and automobile repair' },
  { id: 'masonry', label: 'Brick or stone masonry, stacking concrete', workClass: 'very_heavy', basis: 'OSHA list Very heavy: brick or stone masonry, stacking concrete' },
  { id: 'intense_digging', label: 'Intense shovelling or digging', workClass: 'very_heavy', basis: 'OSHA list Very heavy; ISO 8996 class 4' },
  { id: 'ladder_climbing', label: 'Climbing stairs, ladders or ramps', workClass: 'very_heavy', basis: 'OSHA list Very heavy; ISO 8996 class 4' },
  { id: 'sledgehammer', label: 'Sledgehammer use', workClass: 'very_heavy', basis: 'OSHA list Very heavy (ISO 8996: High) — higher class per ISO 7243:2017 §9.3' },
]

/** Convert kcal/h to W (×1.163). Basis: 1 kcal(IT)/h = 4186.8/3600 W; NIOSH 2016 worked example 300 kcal/h = 348.9 W. */
export function kcalPerHourToW(kcalPerH: number): number {
  return kcalPerH * KCAL_PER_H_TO_W
}

/**
 * ACGIH Table 3 footnote: "The effect of body weight on the estimated metabolic rate can be accounted for by multiplying
 * the estimated rate by the ratio of actual body weight divided by 70 kg (154 lb)." Pure transcription (ASSP 2022 worked
 * answers: 180 W × 110/70 = 282.86 W; 415 W × 87/70 = 515.79 W).
 */
export function scaleMetabolicRateByMass(mW: number, massKg: number): number {
  return (mW * massKg) / ACGIH_REFERENCE_MASS_KG
}

/** DuBois body surface area [m²]: A = 0.202·m^0.425·h^0.725 (m kg, h m) — ISO 8996 / pythermalcomfort default (1.844 m² for 70 kg, 1.75 m). */
export function duBoisAreaM2(massKg: number, heightCm: number): number {
  return 0.202 * massKg ** 0.425 * (heightCm / 100) ** 0.725
}

/**
 * ISO 8996:2004 Table A.2 class for a metabolic rate in W/m². A value on a shared range boundary (70/130/200/260) resolves
 * to the HIGHER class [ENG], following ISO 7243:2017 §9.3 ("the reference value … corresponding to the higher metabolic
 * rate"). Values below the resting range map to `rest`.
 */
export function workClassForWm2(mWm2: number): WorkClass {
  requireFinite('workClassForWm2', 'mWm2', mWm2)
  const c = ISO8996_2004_CLASSES
  if (mWm2 >= c.very_heavy.rangeWm2[0]) return 'very_heavy'
  if (mWm2 >= c.heavy.rangeWm2[0]) return 'heavy'
  if (mWm2 >= c.moderate.rangeWm2[0]) return 'moderate'
  if (mWm2 >= c.light.rangeWm2[0]) return 'light'
  return 'rest'
}

/**
 * Whole-body metabolic rate [W] to compare with REL/RAL for a task done by a given worker.
 * - Base: the task's `metabolicWm2` override × 1.8 m² (ISO 8996:2004 standard worker), else ACGIH Table 3 W for the class.
 * - Body mass: ACGIH Table 3 footnote scaling (mass/70), never below the 70 kg reference [ENG: a lighter worker carrying
 *   the same load is not credited with a lower rate]. Unknown mass → 75 kg (ARCHITECTURE fail-safe default).
 */
export function taskMetabolicW(task: { workClass: WorkClass; metabolicWm2?: number }, massKg?: number): number {
  const override = task.metabolicWm2
  const baseW =
    override !== undefined && Number.isFinite(override) && override > 0
      ? override * STANDARD_BSA_M2.male70kg175cm
      : ACGIH_METABOLIC_W[task.workClass]
  const mass = massKg !== undefined && Number.isFinite(massKg) && massKg > 0 ? massKg : DEFAULT_BODY_MASS_KG
  return baseW * Math.max(1, mass / ACGIH_REFERENCE_MASS_KG)
}

// ═════════════════════════════════════ Clothing ═════════════════════════════════════

/** Ensemble rows of the ACGIH clothing adjustment table (ids match fixtures/limits.json `constants.acgih_cav_C`). */
export type AcgihEnsembleId =
  | 'short_sleeves_and_pants_woven'
  | 'work_clothes_long_sleeve_shirt_and_pants'
  | 'cloth_woven_coveralls'
  | 'sms_polypropylene_coveralls'
  | 'polyolefin_coveralls'
  | 'double_layer_woven_clothing'
  | 'limited_use_vapour_barrier_coveralls'

/**
 * ACGIH TLV 2026 Table 1 (p. 239, via CCOHS) clothing adjustment values [°C] added to WBGT to estimate WBGT_eff
 * (limits_and_workrest.md §3.4). Notes: not for completely encapsulating (Level A) suits; CAVs are NOT additive for
 * multiple layers; coveralls assume only undergarments underneath. Primary research: Bernard et al. 2005/2008;
 * Ashley & Bernard 2008. The −1 °C short-sleeve row is 2026-only and secondary; Zill never applies it [ENG].
 */
export const ACGIH_CAV_C: Readonly<Record<AcgihEnsembleId, number>> = {
  short_sleeves_and_pants_woven: -1,
  work_clothes_long_sleeve_shirt_and_pants: 0,
  cloth_woven_coveralls: 0,
  sms_polypropylene_coveralls: 0.5,
  polyolefin_coveralls: 1,
  double_layer_woven_clothing: 3,
  limited_use_vapour_barrier_coveralls: 11,
}

/** Hood (full head and neck covering, not face) adds +1 °C to WBGT_eff (ACGIH 2026 Table 1; Ashley & Bernard 2008 JOEH 5:59–62). */
export const HOOD_ADDITION_C = 1

/**
 * NIOSH 2016 §3.3 alternative to CAVs (documented, not used by the engine; not additive with CAVs): lower the RAL/REL by
 * 2 °C for a two-layer ensemble and by 4 °C for partially air/vapour-impermeable ensembles or reflective/protective
 * aprons, leggings, gauntlets. NIOSH calls these "scientific judgments that have not been substantiated".
 */
export const NIOSH_LIMIT_CORRECTION_C = { twoLayer: -2, partiallyImpermeableOrAprons: -4 } as const

/** ISO 7933 PHS clothing inputs for one ensemble (static values; the dynamic corrections are internal to PHS). */
export interface PhsClothingInputs {
  /** Static clothing insulation I_cl, clo. */
  clo: number
  /** Static moisture permeability index i_mst. */
  imst: number
  /** False when ISO 7933 must not be run for this ensemble. */
  applicable: boolean
  /** False when the values are not verified for this ensemble (lower the projection confidence). */
  verified: boolean
  /** True at the 1.0 clo upper validity bound of ISO 7933 (flag the run). */
  atValidityLimit: boolean
  note: string
}

/** Everything the engine needs about one clothing ensemble. */
export interface ClothingSpec {
  id: ClothingId
  label: string
  /** ACGIH Table 1 row the ensemble is assessed as. */
  acgihEnsemble: AcgihEnsembleId
  /** Clothing adjustment value applied by the engine [°C] (never negative [ENG]). */
  cavC: number
  /** WBGT_eff screening applies (ACGIH: not for Level A / unlisted vapour-barrier ensembles). */
  wbgtMethodApplicable: boolean
  /** ACGIH TLV Figure 1: clothing that blocks air/vapour movement → physiological monitoring. */
  physiologicalMonitoringAdvised: boolean
  phs: PhsClothingInputs
  basis: string
}

/**
 * Clothing ensembles: ACGIH CAV (limits_and_workrest.md §3.4) and ISO 7933 PHS inputs (phs_iso7933.md §9.2; ISO 7243:2017
 * reference clothing 0.6 clo, i_m 0.38). CAVs are not additive; the short-sleeve −1 °C credit is never applied [ENG].
 */
export const CLOTHING: Readonly<Record<ClothingId, ClothingSpec>> = {
  work_clothes: {
    id: 'work_clothes', label: 'Work clothes (long-sleeve shirt and trousers)', acgihEnsemble: 'work_clothes_long_sleeve_shirt_and_pants',
    cavC: 0, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    phs: { clo: 0.6, imst: 0.38, applicable: true, verified: true, atValidityLimit: false, note: 'ASHRAE 55 ensemble 0.57–0.61 clo (pythermalcomfort); ISO 7243 reference 0.6 clo / 0.38' },
    basis: 'ACGIH 2026 Table 1: work clothes 0 °C (NIOSH 2016 Table 3-2 baseline)',
  },
  cloth_coveralls: {
    id: 'cloth_coveralls', label: 'Cloth (woven) coveralls', acgihEnsemble: 'cloth_woven_coveralls',
    cavC: 0, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    phs: { clo: 0.6, imst: 0.38, applicable: true, verified: true, atValidityLimit: false, note: 'coveralls 0.49 + underwear/socks/shoes ≈ 0.6 clo (ASHRAE summation via pythermalcomfort)' },
    basis: 'ACGIH 2026 Table 1: cloth (woven) coveralls 0 °C; Bernard et al. 2005 cotton coveralls 0',
  },
  fr_coveralls: {
    id: 'fr_coveralls', label: 'Flame-retardant coveralls (FR cotton, aramid)', acgihEnsemble: 'cloth_woven_coveralls',
    cavC: 0, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    // UNVERIFIED: no verified ISO 9920 clo / i_m for FR fabrics (phs_iso7933.md §9.2 gives 0.6–1.0 clo depending on what is
    // worn underneath, i_mst 0.38 unless measured). [ENG] the protective end (1.0 clo) because the under-layer is unknown.
    phs: { clo: 1.0, imst: 0.38, applicable: true, verified: false, atValidityLimit: true, note: 'UNVERIFIED FR values; prefer manikin data (ASTM F1291 / F2370)' },
    basis: 'Ashley & Bernard 2008 (JOEH 5:59–62): FR coveralls (INDURA cotton, Nomex) = 0 °C',
  },
  double_layer: {
    id: 'double_layer', label: 'Double-layer woven clothing (coveralls over work clothes)', acgihEnsemble: 'double_layer_woven_clothing',
    cavC: 3, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    phs: { clo: 1.0, imst: 0.38, applicable: true, verified: true, atValidityLimit: true, note: 'summation ≈ 1.1 clo exceeds the 1.0 clo validity bound: use 1.0 and flag (phs_iso7933.md §9.2)' },
    basis: 'ACGIH 2026 Table 1: double-layer woven clothing +3 °C',
  },
  sms_coveralls: {
    id: 'sms_coveralls', label: 'SMS polypropylene coveralls', acgihEnsemble: 'sms_polypropylene_coveralls',
    cavC: 0.5, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    // UNVERIFIED: no PHS inputs are documented for nonwoven coveralls; borrowed from "coveralls over work clothes". Their
    // true i_m is likely lower, so PHS may under-estimate strain — the WBGT channel (CAV +0.5 °C) stays authoritative.
    phs: { clo: 1.0, imst: 0.38, applicable: true, verified: false, atValidityLimit: true, note: 'UNVERIFIED: borrowed coverall values' },
    basis: 'ACGIH 2026 Table 1: SMS polypropylene coveralls +0.5 °C',
  },
  polyolefin_coveralls: {
    id: 'polyolefin_coveralls', label: 'Polyolefin coveralls', acgihEnsemble: 'polyolefin_coveralls',
    cavC: 1, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: false,
    // UNVERIFIED: as for SMS — borrowed coverall values; the WBGT channel (CAV +1 °C) stays authoritative.
    phs: { clo: 1.0, imst: 0.38, applicable: true, verified: false, atValidityLimit: true, note: 'UNVERIFIED: borrowed coverall values' },
    basis: 'ACGIH 2026 Table 1: polyolefin coveralls +1 °C (Bernard et al. 2005: Tyvek 1424 +1)',
  },
  vapour_barrier: {
    id: 'vapour_barrier', label: 'Limited-use vapour-barrier coveralls', acgihEnsemble: 'limited_use_vapour_barrier_coveralls',
    cavC: 11, wbgtMethodApplicable: true, physiologicalMonitoringAdvised: true,
    phs: { clo: 1.0, imst: 0.38, applicable: false, verified: false, atValidityLimit: true, note: 'ISO 7933 out of scope for impermeable coveralls: do not run PHS' },
    basis: 'ACGIH 2026 Table 1: limited-use vapour-barrier coveralls +11 °C; not for Level A encapsulating suits',
  },
}

/** Fail-safe clothing when unknown: cloth coveralls, CAV 0 (ARCHITECTURE §5; limits_and_workrest.md §3.4 Engine). */
export const DEFAULT_CLOTHING: ClothingId = 'cloth_coveralls'

/**
 * Raw ACGIH arithmetic: CAV of an ACGIH Table 1 row plus the +1 °C hood addition (for reference vectors; includes the
 * −1 °C short-sleeve row that the engine never applies). Basis: ACGIH 2026 Table 1 (via CCOHS).
 */
export function acgihCavC(ensemble: AcgihEnsembleId, hood = false): number {
  return ACGIH_CAV_C[ensemble] + (hood ? HOOD_ADDITION_C : 0)
}

/**
 * Engine clothing adjustment [°C] for a Zill ensemble: CAV(ensemble) + 1 °C if hooded. CAVs are not additive, never
 * negative [ENG], and unknown clothing → cloth coveralls (CAV 0). Basis: ACGIH 2026 Table 1; ISO 7243:2017 Formula (3).
 */
export function clothingAdjustmentC(clothing: ClothingId | undefined, hood = false): number {
  const spec = CLOTHING[clothing ?? DEFAULT_CLOTHING]
  return Math.max(0, spec.cavC) + (hood ? HOOD_ADDITION_C : 0)
}

/**
 * WBGT_eff = WBGT + CAV (+1 °C hood). Basis: ISO 7243:2017 Formula (3); ACGIH TLV 2026 Table 1.
 * @throws RangeError when `wbgtC` is not finite.
 */
export function wbgtEffectiveC(wbgtC: number, clothing: ClothingId | undefined, hood = false): number {
  requireFinite('wbgtEffectiveC', 'wbgtC', wbgtC)
  return wbgtC + clothingAdjustmentC(clothing, hood)
}

// ═════════════════════════════════════ ACGIH Table 2 screening ═════════════════════════════════════

/** Allocation of work in a cycle of work and recovery (ACGIH Table 2 rows). */
export type AcgihAllocation = '75-100' | '50-75' | '25-50' | '0-25'

/** ACGIH Table 2 work categories (Rest has no column). */
export type AcgihScreeningCategory = Exclude<WorkClass, 'rest'>

/**
 * Table 2 rows top to bottom with the time base used to build them: "the proportion of work at the upper limit of the
 * percent work range (e.g., 50% for the range of 25 to 50%)" (ACGIH Table 2 notes).
 */
export const ACGIH_SCREENING_ROWS: readonly { allocation: AcgihAllocation; workFraction: number }[] = [
  { allocation: '75-100', workFraction: 1.0 },
  { allocation: '50-75', workFraction: 0.75 },
  { allocation: '25-50', workFraction: 0.5 },
  { allocation: '0-25', workFraction: 0.25 },
]

/** One block of ACGIH Table 2 [°C WBGT_eff]; null = blank cell ("not recommended" → detailed analysis / monitoring). */
export type AcgihScreeningTable = Readonly<Record<AcgihAllocation, Readonly<Record<AcgihScreeningCategory, number | null>>>>

/**
 * ACGIH TLV Heat Stress Table 2 screening criteria [°C WBGT_eff] as published (Cal/OSHA-hosted text = CCOHS 2026 = LBNL
 * 2016). TLV = acclimatised, Action Limit = unacclimatised. Screening/display only: ACGIH says the table is "not intended
 * to prescribe work and recovery periods" (limits_and_workrest.md §3.5).
 */
export const ACGIH_SCREENING_C: Readonly<{ tlv: AcgihScreeningTable; actionLimit: AcgihScreeningTable }> = {
  tlv: {
    '75-100': { light: 31.0, moderate: 28.0, heavy: null, very_heavy: null },
    '50-75': { light: 31.0, moderate: 29.0, heavy: 27.5, very_heavy: null },
    '25-50': { light: 32.0, moderate: 30.0, heavy: 29.0, very_heavy: 28.0 },
    '0-25': { light: 32.5, moderate: 31.5, heavy: 30.5, very_heavy: 30.0 },
  },
  actionLimit: {
    '75-100': { light: 28.0, moderate: 25.0, heavy: null, very_heavy: null },
    '50-75': { light: 28.5, moderate: 26.0, heavy: 24.0, very_heavy: null },
    '25-50': { light: 29.5, moderate: 27.0, heavy: 25.5, very_heavy: 24.5 },
    '0-25': { light: 30.0, moderate: 29.0, heavy: 28.0, very_heavy: 27.0 },
  },
}

/** Round to the nearest 0.5, half-up: floor(2x + 0.5)/2 ("WBGT values are expressed to the nearest 0.5°C", ACGIH Table 2). */
export function roundHalfUpToHalf(x: number): number {
  return Math.floor(x * 2 + 0.5) / 2
}

/** A Table 2 cell rebuilt from the equations, next to the published value. */
export interface AcgihScreeningCell {
  category: AcgihScreeningCategory
  allocation: AcgihAllocation
  workFraction: number
  /** M_TWA = f·M_category + (1 − f)·115 W. */
  mTwaW: number
  tlvRawC: number
  alRawC: number
  tlvRoundedC: number
  alRoundedC: number
  publishedTlvC: number | null
  publishedAlC: number | null
  /** False for the blank cells: screening "not recommended" — the computed number must not be used. */
  screeningAvailable: boolean
}

/**
 * Rebuild one ACGIH Table 2 cell: M_TWA = f·M_cat + (1 − f)·115 W with f at the upper limit of the range, TLV = REL(M_TWA),
 * AL = RAL(M_TWA), rounded half-up to 0.5 °C. Reproduces every published cell (limits_and_workrest.md §3.5 [D] proof).
 */
export function acgihScreeningCell(category: AcgihScreeningCategory, allocation: AcgihAllocation): AcgihScreeningCell {
  const row = ACGIH_SCREENING_ROWS.find((r) => r.allocation === allocation)
  if (!row) throw new RangeError(`acgihScreeningCell: unknown allocation ${String(allocation)}`)
  const f = row.workFraction
  const mTwaW = f * ACGIH_METABOLIC_W[category] + (1 - f) * REST_METABOLIC_W
  const tlvRawC = relC(mTwaW)
  const alRawC = ralC(mTwaW)
  const publishedTlvC = ACGIH_SCREENING_C.tlv[allocation][category]
  const publishedAlC = ACGIH_SCREENING_C.actionLimit[allocation][category]
  return {
    category,
    allocation,
    workFraction: f,
    mTwaW,
    tlvRawC,
    alRawC,
    tlvRoundedC: roundHalfUpToHalf(tlvRawC),
    alRoundedC: roundHalfUpToHalf(alRawC),
    publishedTlvC,
    publishedAlC,
    screeningAvailable: publishedTlvC !== null && publishedAlC !== null,
  }
}

/**
 * ACGIH screening lookup: the first Table 2 row from the top whose cell is published and ≥ WBGT_eff; null when even the
 * 0–25 % cell is exceeded ("exceeds all screening criteria → detailed analysis / physiological monitoring").
 * Matches the CCOHS worked examples (limits_and_workrest.md §3.5 lookup rule [D]). REL ↔ TLV, RAL ↔ Action Limit.
 */
export function acgihScreeningAllocation(
  wbgtEffC: number,
  category: AcgihScreeningCategory,
  limit: ExposureLimitId,
): AcgihAllocation | null {
  requireFinite('acgihScreeningAllocation', 'wbgtEffC', wbgtEffC)
  const table = limit === 'REL' ? ACGIH_SCREENING_C.tlv : ACGIH_SCREENING_C.actionLimit
  for (const { allocation } of ACGIH_SCREENING_ROWS) {
    const cell = table[allocation][category]
    if (cell !== null && cell >= wbgtEffC) return allocation
  }
  return null
}

// ═════════════════════════════════════ TWA and allowed work fraction ═════════════════════════════════════

/**
 * Time-weighted average Σ p_i·t_i / Σ t_i over a period of about 1 h. Basis: ISO 7243:2017 §9.2 Formulae (4)–(5);
 * NIOSH 2016 §1 / ACGIH 1-h TWAs of WBGT_eff and metabolic rate.
 * @throws RangeError when lengths differ, a value or duration is not finite, a duration is negative, or Σt ≤ 0.
 */
export function twa(values: readonly number[], minutes: readonly number[]): number {
  if (values.length !== minutes.length) throw new RangeError('twa: values and minutes must have the same length')
  let weighted = 0
  let total = 0
  for (let i = 0; i < values.length; i++) {
    requireFinite('twa', `values[${i}]`, values[i])
    requireFinite('twa', `minutes[${i}]`, minutes[i])
    if (minutes[i] < 0) throw new RangeError(`twa: minutes[${i}] must be ≥ 0`)
    weighted += values[i] * minutes[i]
    total += minutes[i]
  }
  if (!(total > 0)) throw new RangeError('twa: total duration must be > 0')
  return weighted / total
}

/** Inputs of the 1-h work–rest solver. All WBGT values are effective (clothing-adjusted). */
export interface AllowedWorkInput {
  /** Whole-body metabolic rate while working, W (clamped to ≥ 115 W). */
  workW: number
  /** Whole-body metabolic rate while resting, W. Default 115 W (ACGIH Table 2 basis; clamped to ≥ 115 W). */
  restW?: number
  /** WBGT_eff where the work is done (sun or shade), °C. */
  wbgtWorkEffC: number
  /** WBGT_eff where the worker rests (shade / cooled rest area), °C. */
  wbgtRestEffC: number
  /** REL for acclimatised workers, RAL otherwise (see selectExposureLimit). */
  limit: ExposureLimitId
}

/** Which constraint decided the allowed work fraction. */
export type AllowedWorkBinding =
  /** Limit(M_work) ≥ WBGT_work: continuous work is within the limit. */
  | 'continuous_ok'
  /** A work–rest cycle is needed: f is the root of the TWA constraint. */
  | 'work_rest'
  /** Even resting all hour exceeds the limit: f = 0 (no work in these conditions). */
  | 'rest_exceeds_limit'

/** Result of the 1-h work–rest solver. */
export interface AllowedWorkResult {
  /** Largest allowed work fraction of each hour, 0–1. */
  f: number
  /** 60·f. */
  workMinPerHour: number
  /** 60·(1 − f). */
  restMinPerHour: number
  binding: AllowedWorkBinding
  /** Limit(M_work) − WBGT_work,eff at continuous work, °C: ≥ 0 → continuous OK (the margin); < 0 → shortfall. */
  marginC: number
  /** Limit at the solution's TWA metabolic rate, °C (equals wbgtTwaEffC on the `work_rest` branch). */
  limitC: number
  /** Limit at the working metabolic rate (continuous work), °C. */
  limitAtFullWorkC: number
  /** TWA metabolic rate at f, W. */
  mTwaW: number
  /** TWA WBGT_eff at f, °C. */
  wbgtTwaEffC: number
  limit: ExposureLimitId
  /** Working rate above 600 W, beyond the plotted ACGIH/NIOSH range (equation extrapolated; stays conservative). */
  extrapolated: boolean
  basis: string
}

/**
 * Allowed work fraction per hour: the largest f ∈ [0, 1] with
 *   Limit(f·M_work + (1−f)·M_rest) ≥ f·WBGT_work,eff + (1−f)·WBGT_rest,eff.
 * g(f) = LHS − RHS is convex (a − b·log10 M is convex and M_TWA is linear in f), so with g(0) ≥ 0 > g(1) the root is
 * unique; it is bracketed by bisection keeping g(lo) ≥ 0 > g(hi) and the feasible side `lo` is returned.
 * Rates are clamped to ≥ 115 W before averaging, which keeps g convex and is protective.
 * Basis: NIOSH 2016 §8.1 + ACGIH TLV 1-h TWA (limits_and_workrest.md §3.6). Example: moderate 300 W, RAL, sun 30 °C /
 * shade 28 °C → f = 0.2808 (16.8 min/h).
 * @throws RangeError on non-finite input (the caller applies its fail-safe default).
 */
export function allowedWorkFraction(input: AllowedWorkInput): AllowedWorkResult {
  const fn = 'allowedWorkFraction'
  const restIn = input.restW ?? REST_METABOLIC_W
  requireFinite(fn, 'workW', input.workW)
  requireFinite(fn, 'restW', restIn)
  requireFinite(fn, 'wbgtWorkEffC', input.wbgtWorkEffC)
  requireFinite(fn, 'wbgtRestEffC', input.wbgtRestEffC)
  const { wbgtWorkEffC, wbgtRestEffC, limit } = input
  const workW = Math.max(input.workW, MIN_METABOLIC_W)
  const restW = Math.max(restIn, MIN_METABOLIC_W)

  const mTwa = (f: number): number => f * workW + (1 - f) * restW
  const wbgtTwa = (f: number): number => f * wbgtWorkEffC + (1 - f) * wbgtRestEffC
  const g = (f: number): number => exposureLimitC(mTwa(f), limit) - wbgtTwa(f)

  const g1 = g(1)
  let f: number
  let binding: AllowedWorkBinding
  if (g1 >= 0) {
    f = 1
    binding = 'continuous_ok'
  } else if (g(0) < 0) {
    f = 0
    binding = 'rest_exceeds_limit'
  } else {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 100 && hi - lo > 1e-13; i++) {
      const mid = (lo + hi) / 2
      if (g(mid) >= 0) lo = mid
      else hi = mid
    }
    f = lo
    binding = 'work_rest'
  }

  const mTwaW = mTwa(f)
  return {
    f,
    workMinPerHour: 60 * f,
    restMinPerHour: 60 * (1 - f),
    binding,
    marginC: g1,
    limitC: exposureLimitC(mTwaW, limit),
    limitAtFullWorkC: exposureLimitC(workW, limit),
    mTwaW,
    wbgtTwaEffC: wbgtTwa(f),
    limit,
    extrapolated: workW > MAX_PLOTTED_METABOLIC_W,
    basis: `${LIMITS_BASIS.allowedWork}; ${limit === 'REL' ? LIMITS_BASIS.rel : LIMITS_BASIS.ral}`,
  }
}

// ═════════════════════════════════════ Acclimatisation ═════════════════════════════════════

/** Published exposure ramps (ids match fixtures/limits.json `constants.acclimatization_schedules`, plus the ADOSH TG columns). */
export type AcclimatizationScheduleId =
  | 'niosh_new_worker'
  | 'niosh_experienced_worker'
  | 'msha_new_miner'
  | 'msha_returning_after_9_days'
  | 'osha_nprm_new_employee'
  | 'osha_nprm_returning_gt_14_days'
  | 'adosh_tg_new_employee'
  | 'adosh_tg_experienced_employee'

/**
 * Maximum fraction of the usual exposure duration in the heat, by day (index 0 = day 1); beyond the end → 1.0.
 * - NIOSH 2016 Table 4-1 / §6.2.3: new workers ≤ 20 % on day 1 and ≤ +20 %/day; experienced 50/60/80/100 %.
 * - MSHA via NIOSH Table 8-2: new miner 50–100 % over 6 days; returning from ≥ 9 days' leave 50/60/90/100 %.
 * - OSHA NPRM 1910.148(e)(7)(i)(B), (ii)(B) (proposed): new 20 %…; returning after > 14 days 50/60/80/100 %.
 * - ADOSH-SF CoP 11.0 TG v4.0 §3 table "courtesy of the National Safety Council": new 20/40/60/80/100 %, experienced
 *   50/60/80/100/100 % (twl_and_regulation.md §2.6).
 */
export const ACCLIMATIZATION_SCHEDULES: Readonly<Record<AcclimatizationScheduleId, readonly number[]>> = {
  niosh_new_worker: [0.2, 0.4, 0.6, 0.8, 1.0],
  niosh_experienced_worker: [0.5, 0.6, 0.8, 1.0],
  msha_new_miner: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  msha_returning_after_9_days: [0.5, 0.6, 0.9, 1.0],
  osha_nprm_new_employee: [0.2, 0.4, 0.6, 0.8, 1.0],
  osha_nprm_returning_gt_14_days: [0.5, 0.6, 0.8, 1.0],
  adosh_tg_new_employee: [0.2, 0.4, 0.6, 0.8, 1.0],
  adosh_tg_experienced_employee: [0.5, 0.6, 0.8, 1.0, 1.0],
}

/**
 * Maximum exposure fraction on a 1-based ramp day; beyond the schedule → 1.0. A day < 1 or non-finite is read as day 1
 * (the strictest day) and fractional days round down [ENG]. Basis: ACCLIMATIZATION_SCHEDULES sources.
 */
export function acclimatizationFraction(schedule: AcclimatizationScheduleId, day: number): number {
  const ramp = ACCLIMATIZATION_SCHEDULES[schedule]
  const d = Number.isFinite(day) ? Math.max(1, Math.floor(day)) : 1
  return d > ramp.length ? 1 : ramp[d - 1]
}

/**
 * Day thresholds of the acclimatisation status rule:
 * - adoshUnacclimatizedAbsenceDays 14 — ADOSH TG v4.0 Table 1 note b: unacclimatised = "new workers or those who have
 *   been off work for more than 14 days due to illness or on vacation leave (in a cool climate area)".
 * - unacclimatizedWindowDays 7 — [ENG] upper end of the ADOSH CoP / TG App. 1 "5–7 days" acclimatisation allowance before
 *   hard work; Brake & Bates 2002: "the first 7 calendar days back at work after being away for more than 14 days".
 * - lossBeginsAbsenceDays 4 — ACGIH TLV: "a noticeable loss occurs after four days"; ADOSH TG re-acclimatisation table
 *   (< 4 days → 100 %); NIOSH Table 4-1 "can be maintained for a few days of non-heat exposure".
 * - completeLossAbsenceDays 21 — ACGIH TLV: "may be completely lost in three to four weeks" (lower end; spec §1.6 [D]).
 * - newWorkerAcclimatizingDays 14 — NIOSH Table 4-1 "over a period of 7 to 14 days" (upper end); ADOSH TG §5.1 "It
 *   takes over two weeks to become fully acclimatized"; ARCHITECTURE conservative mode for the first 14 days.
 * - minDailyHeatExposureH 2 — NIOSH §4.1.5 minimum daily exposure for acclimatisation (may be split into 1-h exposures).
 */
export const ACCLIMATIZATION_RULES = {
  adoshUnacclimatizedAbsenceDays: 14,
  unacclimatizedWindowDays: 7,
  lossBeginsAbsenceDays: 4,
  completeLossAbsenceDays: 21,
  newWorkerAcclimatizingDays: 14,
  minDailyHeatExposureH: 2,
} as const

/** One row of the ADOSH TG re-acclimatisation table; `reduced_expectations` = "R/E (reduced expectations)". */
export interface AdoshReacclimatizationRow {
  /** Absence range in days as printed (null upper = open). */
  absenceDays: readonly [number, number | null]
  /** Equivalent illness range in days as printed (null for the first row). */
  illnessDays: readonly [number, number | null] | null
  sequence: readonly (number | 'reduced_expectations')[]
}

/**
 * ADOSH-SF CoP 11.0 TG v4.0 §3 re-acclimatisation table (twl_and_regulation.md §2.6; overlapping "6–12"/"12–20" rows as
 * printed). Kept as data for audit: the engine applies the stricter spec decay rule (≥ 4 days away → 50/60/80/100 %;
 * ≥ 21 days → new-worker 20/40/60/80/100 %), which is never less protective than this table (unit-tested).
 */
export const ADOSH_TG_REACCLIMATIZATION: readonly AdoshReacclimatizationRow[] = [
  { absenceDays: [0, 3], illnessDays: null, sequence: [1.0] },
  { absenceDays: [4, 5], illnessDays: [1, 3], sequence: ['reduced_expectations', 1.0] },
  { absenceDays: [6, 12], illnessDays: [4, 5], sequence: [0.8, 1.0] },
  { absenceDays: [12, 20], illnessDays: [6, 8], sequence: [0.6, 0.8, 1.0] },
  { absenceDays: [21, null], illnessDays: [9, null], sequence: [0.5, 0.6, 0.8, 1.0] },
]

/**
 * Inputs of the acclimatisation assessment (WorkerProfile fields).
 * - `daysOnSite`: days worked in the heat in the current stretch — since starting, or since returning from the most recent
 *   absence of ≥ 4 days; the assessed day counts, so 1 = first day (0 or unknown → day 1, protective).
 * - `daysAwayRecent`: length in days of that most recent absence from heat exposure. Values above 14 are meaningful
 *   (ADOSH "> 14 days" rule); negative / non-finite = unknown history → treated as a long absence (fail-safe).
 * - `experiencedInHeat`: completed a previous hot season (NIOSH experienced-worker schedule).
 */
export interface AcclimatizationInput {
  daysOnSite: number
  daysAwayRecent: number
  experiencedInHeat: boolean
}

/** Why the assessment came out as it did (stable id for drivers / UI). */
export type AcclimatizationReason =
  | 'retained'
  | 'completed'
  | 'new_worker'
  | 'returning_after_absence'
  | 'long_absence'
  | 'unknown_history'

/** Acclimatisation status, current ramp day and exposure cap for one worker. */
export interface AcclimatizationAssessment {
  status: AcclimatizationStatus
  /** 1-based day of the active ramp; null when no ramp applies or the ramp is complete. */
  dayOfRamp: number | null
  /** Maximum fraction of the usual hot-work duration allowed today (1 = full assignment). */
  maxExposureFraction: number
  schedule: AcclimatizationScheduleId | null
  reason: AcclimatizationReason
  /** ADOSH TG Table 1 note b status: excluded from Medium and High TWL zones ("No unacclimatised person to work"). */
  adoshUnacclimatized: boolean
  /** REL only when acclimatised; RAL while unacclimatised or acclimatising (limits_and_workrest.md §0 decision 7). */
  limit: ExposureLimitId
  basis: string
}

/**
 * Acclimatisation status from the worker profile.
 * 1. Ramp: new worker (no previous hot season), absence ≥ 21 days, or unknown history → new-worker ramp 20/40/60/80/100 %;
 *    experienced and absence 4–20 days → experienced ramp 50/60/80/100/100 %; experienced and absence < 4 days → none
 *    (acclimatisation retained). Spec decay rule limits_and_workrest.md §1.6 [D] (stricter than the ADOSH TG table).
 * 2. Status: `unacclimatized` (ADOSH: new, or off work > 14 days) during the first 7 days of the stretch [ENG]; otherwise
 *    `acclimatizing` while the ramp runs (new-worker ramp: through day 14); then `acclimatized`.
 * 3. Limit: REL only when `acclimatized` ("treat as unacclimatised until the schedule completes"; RAL meanwhile).
 * Basis: ADOSH-SF CoP 11.0 TG v4.0 Table 1 note b and §3; NIOSH 2016 Table 4-1; ACGIH TLV acclimatisation (§3.3).
 */
export function assessAcclimatization(input: AcclimatizationInput): AcclimatizationAssessment {
  const R = ACCLIMATIZATION_RULES
  const day = Number.isFinite(input.daysOnSite) ? Math.max(1, Math.floor(input.daysOnSite)) : 1
  const awayKnown = Number.isFinite(input.daysAwayRecent) && input.daysAwayRecent >= 0
  const away = awayKnown ? input.daysAwayRecent : Number.POSITIVE_INFINITY
  const experienced = input.experiencedInHeat === true

  let reason: AcclimatizationReason
  let schedule: AcclimatizationScheduleId | null
  if (!awayKnown) {
    reason = 'unknown_history'
    schedule = 'adosh_tg_new_employee'
  } else if (!experienced) {
    reason = 'new_worker'
    schedule = 'adosh_tg_new_employee'
  } else if (away >= R.completeLossAbsenceDays) {
    reason = 'long_absence'
    schedule = 'adosh_tg_new_employee'
  } else if (away >= R.lossBeginsAbsenceDays) {
    reason = 'returning_after_absence'
    schedule = 'adosh_tg_experienced_employee'
  } else {
    reason = 'retained'
    schedule = null
  }

  const adoshNewOrLongAbsence = !awayKnown || !experienced || away > R.adoshUnacclimatizedAbsenceDays
  const adoshUnacclimatized = adoshNewOrLongAbsence && day <= R.unacclimatizedWindowDays
  const rampLength = schedule === null ? 0 : ACCLIMATIZATION_SCHEDULES[schedule].length
  const acclimatizingThroughDay = schedule === 'adosh_tg_new_employee' ? R.newWorkerAcclimatizingDays : rampLength
  const status: AcclimatizationStatus = adoshUnacclimatized
    ? 'unacclimatized'
    : schedule !== null && day <= acclimatizingThroughDay
      ? 'acclimatizing'
      : 'acclimatized'
  if (status === 'acclimatized' && schedule !== null) reason = 'completed'

  const basisParts: string[] = []
  if (adoshUnacclimatized) basisParts.push('ADOSH-SF CoP 11.0 TG v4.0 Table 1 note b: new worker or > 14 days off work = unacclimatised (5–7-day allowance)')
  if (schedule === 'adosh_tg_new_employee') basisParts.push('ADOSH TG v4.0 §3 new-employee ramp 20/40/60/80/100 % = NIOSH 2016 Table 4-1 (7–14 days)')
  if (schedule === 'adosh_tg_experienced_employee') basisParts.push('ADOSH TG v4.0 §3 experienced-employee ramp 50/60/80/100/100 % = NIOSH 2016 Table 4-1')
  if (reason === 'long_absence' || reason === 'returning_after_absence' || reason === 'retained') {
    basisParts.push('decay rule (limits_and_workrest.md §1.6 [D]): ACGIH loss noticeable after 4 days, complete in 3–4 weeks')
  }
  if (reason === 'unknown_history') basisParts.push('fail-safe: unknown acclimatisation history → new-worker schedule (ARCHITECTURE §5)')
  if (status === 'acclimatized') basisParts.push('acclimatised: REL applies (NIOSH 2016 §8.1)')

  return {
    status,
    dayOfRamp: schedule !== null && day <= rampLength ? day : null,
    maxExposureFraction: schedule === null ? 1 : acclimatizationFraction(schedule, day),
    schedule,
    reason,
    adoshUnacclimatized,
    limit: selectExposureLimit(status),
    basis: basisParts.join('; '),
  }
}

// ═════════════════════════════════════ NWS heat index ═════════════════════════════════════

/**
 * NWS heat index constants (°F, %RH) — WPC "The Heat Index Equation" (2022-05-12):
 * simple HI_s = 0.5·{T + 61.0 + (T − 68.0)·1.2 + RH·0.094} (the 0.5 IS the averaging — do not average twice);
 * Rothfusz regression when HI_s ≥ 80 °F (equation-page text rule; the WPC JavaScript uses > 79);
 * low-RH adjustment (RH < 13 %, 80 ≤ T ≤ 112 °F) and high-RH adjustment (RH > 85 %, 80 ≤ T ≤ 87 °F);
 * NWS classes Caution 80, Extreme Caution 90, Danger 103, Extreme Danger 125 °F; full sun can add up to 15 °F (statement,
 * not part of the formula). limits_and_workrest.md §8.
 */
export const NWS_HI = {
  simple: { c: 0.5, t0: 61.0, tRef: 68.0, tGain: 1.2, rh: 0.094 },
  regressionThresholdF: 80,
  /** Coefficients of 1, T, RH, T·RH, T², RH², T²·RH, T·RH², T²·RH². */
  rothfusz: [-42.379, 2.04901523, 10.14333127, -0.22475541, -0.00683783, -0.05481717, 0.00122874, 0.00085282, -0.00000199],
  lowRh: { rhBelow: 13, tMinF: 80, tMaxF: 112 },
  highRh: { rhAbove: 85, tMinF: 80, tMaxF: 87 },
  categoriesF: { caution: 80, extremeCaution: 90, danger: 103, extremeDanger: 125 },
  fullSunAddUpToF: 15,
} as const

/** Which part of the NWS algorithm produced the value. */
export type HeatIndexBranch = 'simple' | 'rothfusz' | 'rothfusz_low_rh_adj' | 'rothfusz_high_rh_adj'

/** NWS heat index with its intermediate terms. */
export interface HeatIndexDetail {
  hiF: number
  hiC: number
  branch: HeatIndexBranch
  /** Steadman simple-formula value, °F (always computed first). */
  simpleF: number
  /** NWS adjustment added to the regression, °F (0 when none). */
  adjustmentF: number
}

/**
 * Bare Rothfusz (1990, NWS SR 90-23) regression, °F, with no NWS adjustments and no simple-formula branch (reference
 * only — use heatIndexNwsF). Rounds to the NOAA chart in NIOSH 2016 App. C within ±1 °F in all 135 cells.
 */
export function rothfuszF(tF: number, rhPct: number): number {
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = NWS_HI.rothfusz
  const t = tF
  const r = rhPct
  return c1 + c2 * t + c3 * r + c4 * t * r + c5 * t * t + c6 * r * r + c7 * t * t * r + c8 * t * r * r + c9 * t * t * r * r
}

/**
 * Full NWS heat index (simple formula → Rothfusz at ≥ 80 °F → low/high-RH adjustments), °F in, with detail. RH is clamped
 * to 0–100 % [ENG: sensor noise]. Not pythermalcomfort's `heat_index_rothfusz` (no adjustments, NaN below 27 °C).
 * Basis: NWS/WPC Heat Index Equation; limits_and_workrest.md §0 decision 5 and §8.
 * @throws RangeError on non-finite input.
 */
export function heatIndexNwsDetail(tF: number, rhPct: number): HeatIndexDetail {
  requireFinite('heatIndexNwsDetail', 'tF', tF)
  requireFinite('heatIndexNwsDetail', 'rhPct', rhPct)
  const rh = Math.min(100, Math.max(0, rhPct))
  const s = NWS_HI.simple
  const simpleF = s.c * (tF + s.t0 + (tF - s.tRef) * s.tGain + rh * s.rh)
  if (simpleF < NWS_HI.regressionThresholdF) {
    return { hiF: simpleF, hiC: fToC(simpleF), branch: 'simple', simpleF, adjustmentF: 0 }
  }
  let adjustmentF = 0
  let branch: HeatIndexBranch = 'rothfusz'
  const lo = NWS_HI.lowRh
  const hi = NWS_HI.highRh
  if (rh < lo.rhBelow && tF >= lo.tMinF && tF <= lo.tMaxF) {
    // 0 − x keeps +0 at T = 112 °F where the square root vanishes.
    adjustmentF = 0 - ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tF - 95)) / 17)
    branch = 'rothfusz_low_rh_adj'
  } else if (rh > hi.rhAbove && tF >= hi.tMinF && tF <= hi.tMaxF) {
    adjustmentF = ((rh - 85) / 10) * ((87 - tF) / 5)
    branch = 'rothfusz_high_rh_adj'
  }
  const hiF = rothfuszF(tF, rh) + adjustmentF
  return { hiF, hiC: fToC(hiF), branch, simpleF, adjustmentF }
}

/** NWS heat index, °F in and out. Basis: NWS/WPC Heat Index Equation (see heatIndexNwsDetail). */
export function heatIndexNwsF(tF: number, rhPct: number): number {
  return heatIndexNwsDetail(tF, rhPct).hiF
}

/**
 * NWS heat index, °C in and out (exact conversion T_F = 1.8·T_C + 32; no intermediate rounding; the WPC calculator's °C
 * path bug is not copied). Abu Dhabi examples: 45 °C / 15 % → 44.45 °C; 40 °C / 45 % → 51.34 °C. Risk communication only —
 * never a substitute for WBGT limits (limits_and_workrest.md §0 decision 5).
 */
export function heatIndexNwsC(tC: number, rhPct: number): number {
  requireFinite('heatIndexNwsC', 'tC', tC)
  return heatIndexNwsDetail(cToF(tC), rhPct).hiC
}

/** NWS heat-index class. */
export type NwsHeatIndexCategory = 'none' | 'caution' | 'extreme_caution' | 'danger' | 'extreme_danger'

/**
 * NWS classification (weather.gov): Caution 80–90 °F, Extreme Caution 90–103, Danger 103–124, Extreme Danger ≥ 125; a value
 * on a boundary takes the higher class. Basis: NWS heat index classification (limits_and_workrest.md §8).
 */
export function nwsHeatIndexCategory(hiF: number): NwsHeatIndexCategory {
  const c = NWS_HI.categoriesF
  if (hiF >= c.extremeDanger) return 'extreme_danger'
  if (hiF >= c.danger) return 'danger'
  if (hiF >= c.extremeCaution) return 'extreme_caution'
  if (hiF >= c.caution) return 'caution'
  return 'none'
}

/** OSHA heat-index risk level (OSHA-NIOSH Heat Safety Tool basis). */
export type OshaHeatIndexRisk = 'lower_caution' | 'moderate' | 'high' | 'very_high_to_extreme'

/**
 * NIOSH 2016 Appendix C Table C-1 (adapted from OSHA 2012) boundaries, °F: < 91 lower (caution); [91, 103) moderate;
 * [103, 115] high (103 listed twice → resolved upward; "greater than 115" excludes 115); > 115 very high to extreme.
 * Note: the "lower" band is not safe (Tustin et al., MMWR 2018: HI < 91 °F in 12 of 25 cases).
 */
export const OSHA_HI_RISK_F = { moderateFrom: 91, highFrom: 103, veryHighAbove: 115 } as const

/** OSHA heat-index risk level for a heat index in °F. Basis: NIOSH 2016-106 App. C Table C-1 (see OSHA_HI_RISK_F). */
export function oshaHeatIndexRiskLevel(hiF: number): OshaHeatIndexRisk {
  const b = OSHA_HI_RISK_F
  if (hiF > b.veryHighAbove) return 'very_high_to_extreme'
  if (hiF >= b.highFrom) return 'high'
  if (hiF >= b.moderateFrom) return 'moderate'
  return 'lower_caution'
}

/** Dubai Municipality heat-index risk level. */
export type DubaiHeatIndexLevel = 'low_caution' | 'moderate' | 'high' | 'very_high'

/** One Dubai Municipality heat-index level with its printed wording and site flag colour. */
export interface DubaiHeatIndexBand {
  level: DubaiHeatIndexLevel
  printed: string
  /** Level applies when HI_C > aboveC (null = no lower bound). */
  aboveC: number | null
  flag: 'green' | 'yellow' | 'amber' | 'red'
}

/**
 * Dubai Municipality DM-HSD-GU38-MHSW2 Technical Guidelines for Management of Heat Stress at Work V2.0 (8 Oct 2019) heat-
 * index risk levels and flags (context_and_commercial.md §3.2). The printed bands leave gaps (34–35, 39–40, 45–46 °C);
 * a value in a gap resolves to the higher level [ENG], as in the jurisdiction rule pack (hi_c_gt 34 / 39 / 45).
 * V3.0 (May 2024) thresholds: UNVERIFIED (URL redirects).
 */
export const DUBAI_MUNICIPALITY_HI_LEVELS: readonly DubaiHeatIndexBand[] = [
  { level: 'low_caution', printed: 'Up to 34 ºC: Low risk (caution)', aboveC: null, flag: 'green' },
  { level: 'moderate', printed: '35 to 39 ºC: Moderate', aboveC: 34, flag: 'yellow' },
  { level: 'high', printed: '40 to 45 ºC: High', aboveC: 39, flag: 'amber' },
  { level: 'very_high', printed: '46 ºC and above: Very high', aboveC: 45, flag: 'red' },
]

/** Dubai Municipality V2.0 (2019) heat-index level for a heat index in °C (gaps resolved upward [ENG]). */
export function dubaiHeatIndexLevel(hiC: number): DubaiHeatIndexLevel {
  for (let i = DUBAI_MUNICIPALITY_HI_LEVELS.length - 1; i >= 0; i--) {
    const band = DUBAI_MUNICIPALITY_HI_LEVELS[i]
    if (band.aboveC === null || hiC > band.aboveC) return band.level
  }
  return 'low_caution'
}

// ═════════════════════════════════════ TB MED 507 (2022) ═════════════════════════════════════

/** TB MED 507 heat category (0 = below CAT 1). */
export type TbMed507Category = 0 | 1 | 2 | 3 | 4 | 5

/** TB MED 507 work intensity columns. */
export type TbMed507Work = 'easy' | 'moderate' | 'heavy' | 'very_heavy'

/**
 * TB MED 507 (12 Apr 2022) Figure 3-3 category lower bounds, °F, as half-open intervals [78,82) [82,85) [85,88) [88,90)
 * ≥ 90 (the printed bands "78–81.9 … > 90" leave gaps; convert °C → °F exactly first). limits_and_workrest.md §5.3.
 */
export const TBMED507_CAT_LOWER_F = { 1: 78, 2: 82, 3: 85, 4: 88, 5: 90 } as const

/** TB MED 507 Figure 3-3 flag colours by category. */
export const TBMED507_FLAG = { 1: 'white', 2: 'green', 3: 'yellow', 4: 'red', 5: 'black' } as const

/** TB MED 507 (2022) Table 3-2 work intensities [W]: easy 250, moderate 425, heavy 600, very heavy 800. */
export const TBMED507_WORK_W: Readonly<Record<TbMed507Work, number>> = { easy: 250, moderate: 425, heavy: 600, very_heavy: 800 }

/** A Table 3-2 cell: [work, rest] minutes per hour (null = "NL", no limit up to 4 continuous hours) and water qt/h. */
export interface TbMed507WorkRestCell {
  workRest: readonly [number, number] | null
  waterQtPerH: number
}

/** A Table 3-3 cell: continuous work limit in minutes (null = "NL") and water qt/h. */
export interface TbMed507ContinuousCell {
  continuousWorkMin: number | null
  waterQtPerH: number
}

/**
 * TB MED 507 (2022) Table 3-2, fluid replacement and work/rest for heat-acclimatised soldiers in OCP uniform (2022 values,
 * which supersede the DOD 2003/2007 table reproduced in NIOSH 2016 Table 8-1). limits_and_workrest.md §5.4, §5.6.
 */
export const TBMED507_TABLE_3_2: Readonly<Record<1 | 2 | 3 | 4 | 5, Readonly<Record<TbMed507Work, TbMed507WorkRestCell>>>> = {
  1: {
    easy: { workRest: null, waterQtPerH: 0.5 },
    moderate: { workRest: null, waterQtPerH: 0.75 },
    heavy: { workRest: [40, 20], waterQtPerH: 0.75 },
    very_heavy: { workRest: [20, 40], waterQtPerH: 1 },
  },
  2: {
    easy: { workRest: null, waterQtPerH: 0.5 },
    moderate: { workRest: null, waterQtPerH: 0.75 },
    heavy: { workRest: [30, 30], waterQtPerH: 1 },
    very_heavy: { workRest: [15, 45], waterQtPerH: 1 },
  },
  3: {
    easy: { workRest: null, waterQtPerH: 0.75 },
    moderate: { workRest: null, waterQtPerH: 0.75 },
    heavy: { workRest: [30, 30], waterQtPerH: 1 },
    very_heavy: { workRest: [10, 50], waterQtPerH: 1 },
  },
  4: {
    easy: { workRest: null, waterQtPerH: 0.75 },
    moderate: { workRest: [50, 10], waterQtPerH: 0.75 },
    heavy: { workRest: [20, 40], waterQtPerH: 1 },
    very_heavy: { workRest: [10, 50], waterQtPerH: 1 },
  },
  5: {
    easy: { workRest: null, waterQtPerH: 1 },
    moderate: { workRest: [20, 40], waterQtPerH: 1 },
    heavy: { workRest: [15, 45], waterQtPerH: 1 },
    very_heavy: { workRest: [10, 50], waterQtPerH: 1 },
  },
}

/** TB MED 507 (2022) Table 3-3, continuous work duration and water (limits_and_workrest.md §5.4). */
export const TBMED507_TABLE_3_3: Readonly<Record<1 | 2 | 3 | 4 | 5, Readonly<Record<TbMed507Work, TbMed507ContinuousCell>>>> = {
  1: {
    easy: { continuousWorkMin: null, waterQtPerH: 0.5 },
    moderate: { continuousWorkMin: null, waterQtPerH: 0.75 },
    heavy: { continuousWorkMin: 110, waterQtPerH: 0.75 },
    very_heavy: { continuousWorkMin: 45, waterQtPerH: 0.75 },
  },
  2: {
    easy: { continuousWorkMin: null, waterQtPerH: 0.5 },
    moderate: { continuousWorkMin: null, waterQtPerH: 1 },
    heavy: { continuousWorkMin: 70, waterQtPerH: 1 },
    very_heavy: { continuousWorkMin: 40, waterQtPerH: 1 },
  },
  3: {
    easy: { continuousWorkMin: null, waterQtPerH: 0.75 },
    moderate: { continuousWorkMin: null, waterQtPerH: 1 },
    heavy: { continuousWorkMin: 60, waterQtPerH: 1 },
    very_heavy: { continuousWorkMin: 25, waterQtPerH: 1 },
  },
  4: {
    easy: { continuousWorkMin: null, waterQtPerH: 0.75 },
    moderate: { continuousWorkMin: 180, waterQtPerH: 1.25 },
    heavy: { continuousWorkMin: 50, waterQtPerH: 1.25 },
    very_heavy: { continuousWorkMin: 20, waterQtPerH: 1.25 },
  },
  5: {
    easy: { continuousWorkMin: null, waterQtPerH: 1 },
    moderate: { continuousWorkMin: 70, waterQtPerH: 1.5 },
    heavy: { continuousWorkMin: 45, waterQtPerH: 1.5 },
    very_heavy: { continuousWorkMin: 20, waterQtPerH: 1.5 },
  },
}

/** TB MED 507 Table 3-2 note: heavy protective clothing (CBRN, JSLIST) adds 10 °F to WBGT for easy work, 20 °F for moderate and heavy. */
export const TBMED507_PROTECTIVE_CLOTHING_ADD_F = { easy: 10, moderateOrHeavy: 20 } as const

/** TB MED 507 Table 3-2 note: fluid needs vary ± ¼ qt/h between individuals and ± ¼ qt/h between full sun and full shade. */
export const TBMED507_WATER_VARIATION_QT_PER_H = 0.25

/** TB MED 507 heat category for WBGT in °F (half-open intervals, TBMED507_CAT_LOWER_F). */
export function tbmed507CategoryF(wbgtF: number): TbMed507Category {
  const b = TBMED507_CAT_LOWER_F
  if (wbgtF >= b[5]) return 5
  if (wbgtF >= b[4]) return 4
  if (wbgtF >= b[3]) return 3
  if (wbgtF >= b[2]) return 2
  if (wbgtF >= b[1]) return 1
  return 0
}

/** TB MED 507 heat category for WBGT in °C (exact °F = 1.8·°C + 32 first; limits_and_workrest.md §5.3). */
export function tbmed507Category(wbgtC: number): TbMed507Category {
  return tbmed507CategoryF(cToF(wbgtC))
}

/**
 * TB MED 507 work column for a whole-body metabolic rate: the lowest column whose rate is ≥ M (≤ 250 W easy, ≤ 425
 * moderate, ≤ 600 heavy, else very heavy) — rounding up is [ENG] protective (e.g. ACGIH Moderate 300 W → TB MED moderate).
 */
export function tbmed507WorkLevel(mW: number): TbMed507Work {
  const w = TBMED507_WORK_W
  if (mW <= w.easy) return 'easy'
  if (mW <= w.moderate) return 'moderate'
  if (mW <= w.heavy) return 'heavy'
  return 'very_heavy'
}

/** TB MED 507 guidance for one category and work column (water also in litres). */
export interface TbMed507Guidance {
  category: 1 | 2 | 3 | 4 | 5
  flag: 'white' | 'green' | 'yellow' | 'red' | 'black'
  work: TbMed507Work
  workW: number
  /** [work, rest] minutes per hour; null = "NL" (no limit to work per hour, up to 4 continuous hours). */
  workRest: readonly [number, number] | null
  /** "40/20" or "NL". */
  workRestLabel: string
  workMinPerHour: number
  waterQtPerH: number
  waterLPerH: number
  /** Table 3-3 continuous work limit, minutes; null = "NL". */
  continuousWorkMin: number | null
  continuousWaterQtPerH: number
  continuousWaterLPerH: number
  basis: string
}

/**
 * TB MED 507 (2022) Tables 3-2 and 3-3 for a category and work column; null for category 0 (below the tables). Water must
 * still respect the caps of ≤ 1½ qt/h and ≤ 12 qt/day (Table 3-2 CAUTION notes) — see HYDRATION.
 */
export function tbmed507Guidance(category: TbMed507Category, work: TbMed507Work): TbMed507Guidance | null {
  if (category === 0) return null
  const wr = TBMED507_TABLE_3_2[category][work]
  const cont = TBMED507_TABLE_3_3[category][work]
  return {
    category,
    flag: TBMED507_FLAG[category],
    work,
    workW: TBMED507_WORK_W[work],
    workRest: wr.workRest,
    workRestLabel: wr.workRest === null ? 'NL' : `${wr.workRest[0]}/${wr.workRest[1]}`,
    workMinPerHour: wr.workRest === null ? 60 : wr.workRest[0],
    waterQtPerH: wr.waterQtPerH,
    waterLPerH: wr.waterQtPerH * US_QUART_L,
    continuousWorkMin: cont.continuousWorkMin,
    continuousWaterQtPerH: cont.waterQtPerH,
    continuousWaterLPerH: cont.waterQtPerH * US_QUART_L,
    basis: LIMITS_BASIS.tbmed507,
  }
}

// ═════════════════════════════════════ Hydration ═════════════════════════════════════

/** US liquid quart in litres (exact definition 0.946352946 L). */
export const US_QUART_L = 0.946352946

/** US fluid ounce in millilitres (exact definition 29.5735295625 mL). */
export const US_FL_OZ_ML = 29.5735295625

/**
 * Hydration facts (limits_and_workrest.md §1.7, §5.5):
 * - cupMl / cupIntervalMin: NIOSH 2017-126 "drink 1 cup (8 ounces) of water every 15–20 minutes";
 * - typicalLPerH: "¾–1 quart (24–32 ounces) per hour" (NIOSH 2017-126);
 * - maxLPerH: "Do not drink more than 48 oz (1½ quarts) per hour!" (NIOSH 2017-126) = TB MED 507 Table 3-2 CAUTION and
 *   Table 3-6; NIOSH 2016 Table 8-1 footnote;
 * - maxLPerDay: "Daily fluid intake should not exceed 12 qt" (TB MED 507 2022 Table 3-2; NIOSH Table 8-1 footnote);
 * - waterMaxTempC: NIOSH §1.7.3(g) cool water < 15 °C (59 °F);
 * - electrolyteDrinkAfterH / electrolyteMaxPct: NIOSH §1.7.3(g) sweating > 2 h → sports drink ≤ 8 % electrolytes /
 *   carbohydrate; NIOSH does not recommend salt tablets;
 * - hyponatremiaSodiumMmolL: serum Na⁺ < 135 mmol/L (NIOSH §4.1.4; TB MED 507 para 3-7h);
 * - oshaNprmWaterLPerEmployeeH: 1 qt per employee per hour (proposed 1910.148(e)(2); not in force).
 */
export const HYDRATION = {
  cupMl: 8 * US_FL_OZ_ML,
  cupIntervalMin: [15, 20],
  typicalLPerH: [0.75 * US_QUART_L, 1 * US_QUART_L],
  maxLPerH: 1.5 * US_QUART_L,
  maxLPerDay: 12 * US_QUART_L,
  waterMaxTempC: 15,
  electrolyteDrinkAfterH: 2,
  electrolyteMaxPct: 8,
  hyponatremiaSodiumMmolL: 135,
  oshaNprmWaterLPerEmployeeH: US_QUART_L,
} as const

/** Hard hourly fluid cap ≈ 1,419.5 mL/h (1½ US qt; TB MED 507 2022 Table 3-2 CAUTION; NIOSH 2017-126 "48 oz"). */
export const FLUID_MAX_ML_PER_HOUR = HYDRATION.maxLPerH * 1000

/** Daily fluid cap ≈ 11,356 mL/day (12 US qt; TB MED 507 2022 Table 3-2 CAUTION / Table 3-6). */
export const FLUID_MAX_ML_PER_DAY = HYDRATION.maxLPerDay * 1000

/** ILO 2024 Table 8 work-intensity columns (ISO 7243:2017 Table 1 classes). */
export type IloWorkIntensity = 'low' | 'moderate' | 'high'

/** One WBGT band of ILO 2024 Table 8. */
export interface IloWaterRow {
  /** Band as printed, °C. */
  printedRangeC: string
  /** Band applies from this WBGT, °C … */
  fromC: number
  /** … inclusive (≥) or exclusive (>) — gaps and overlaps resolved to the higher band [ENG]. */
  fromInclusive: boolean
  lPerH: Readonly<Record<IloWorkIntensity, number>>
}

/**
 * ILO (2024) Heat at work, Table 8 hydration (L/h) by WBGT and intensity, simulated with the FAME Lab PHS model for a
 * 170 cm / 70 kg worker in hat, short-sleeve shirt and denim overalls (context_and_commercial.md §1.2). The printed edges
 * overlap at 28.0 and leave gaps 29.4–29.5, 30.9–31.0, 32.4–32.5: boundary and gap values go to the higher band [ENG].
 */
export const ILO_2024_TABLE8_WATER: readonly IloWaterRow[] = [
  { printedRangeC: '25.0–28.0', fromC: 25.0, fromInclusive: true, lPerH: { low: 0.35, moderate: 0.55, high: 0.65 } },
  { printedRangeC: '28.0–29.4', fromC: 28.0, fromInclusive: true, lPerH: { low: 0.4, moderate: 0.55, high: 0.7 } },
  { printedRangeC: '29.5–30.9', fromC: 29.4, fromInclusive: false, lPerH: { low: 0.4, moderate: 0.6, high: 0.75 } },
  { printedRangeC: '31.0–32.4', fromC: 30.9, fromInclusive: false, lPerH: { low: 0.45, moderate: 0.65, high: 0.8 } },
  { printedRangeC: '≥32.5', fromC: 32.4, fromInclusive: false, lPerH: { low: 0.5, moderate: 0.7, high: 0.85 } },
]

/** ILO 2024 Table 8 intensity column for a Zill work class (ISO 7243 classes: 0–1 low, 2 moderate, 3–4 high). */
export function iloIntensityForWorkClass(workClass: WorkClass): IloWorkIntensity {
  if (workClass === 'rest' || workClass === 'light') return 'low'
  if (workClass === 'moderate') return 'moderate'
  return 'high'
}

/** ILO 2024 Table 8 water intake (L/h) for WBGT (°C) and intensity; null below 25 °C (no row). */
export function iloWaterLPerH(wbgtC: number, intensity: IloWorkIntensity): number | null {
  for (let i = ILO_2024_TABLE8_WATER.length - 1; i >= 0; i--) {
    const row = ILO_2024_TABLE8_WATER[i]
    if (row.fromInclusive ? wbgtC >= row.fromC : wbgtC > row.fromC) return row.lPerH[intensity]
  }
  return null
}

/** Inputs of the hourly water recommendation. */
export interface WaterRecommendationInput {
  /** Whole-body metabolic rate of the task, W (selects the TB MED 507 column). */
  workW: number
  /** Work class of the task (selects the ILO 2024 Table 8 column). */
  workClass: WorkClass
  /** WBGT where the work is done, °C (unknown → the NIOSH cadence floor still applies). */
  wbgtC?: number
  /** Predicted sweat rate, e.g. from ISO 7933 PHS, mL/h (replaced up to the cap). */
  sweatRateMlPerHour?: number
  /** Regulatory minimum from the jurisdiction rule pack (e.g. ADOSH TWL-zone guidance), mL/h. */
  regulatoryMinMlPerHour?: number
  /** Fluid already drunk today, mL (bounds the recommendation by the daily cap). */
  intakeTodayMl?: number
  /** Hours of sustained sweating so far (electrolyte drink advice after 2 h). */
  hoursSweating?: number
}

/** Which term set the recommendation. */
export type WaterBinding =
  | 'niosh_cadence'
  | 'tbmed507'
  | 'ilo_2024'
  | 'sweat_replacement'
  | 'regulatory_minimum'
  | 'hourly_cap'
  | 'daily_cap'

/** Recommended drinking volume with its components. */
export interface WaterRecommendation {
  /** Recommended intake, mL/h, after the caps. */
  mlPerHour: number
  binding: WaterBinding
  components: {
    nioshCadenceMl: number
    tbmed507Ml: number | null
    ilo2024Ml: number | null
    sweatReplacementMl: number | null
    regulatoryMinMl: number | null
  }
  hourlyCapMl: number
  /** Remaining allowance under the daily cap, mL (null when today's intake is unknown). */
  dailyRemainingMl: number | null
  /** True when a cap reduced the volume the other terms asked for. */
  capped: boolean
  /** Sports drink with balanced electrolytes (≤ 8 %), no salt tablets (NIOSH §1.7.3(g)). */
  electrolytesAdvised: boolean
  basis: string
}

/**
 * Recommended drinking volume, mL/h = min(hourly cap, daily allowance, max(terms)), where the terms are
 * - NIOSH cadence floor: 1 cup (8 oz) every 20 min = ¾ qt/h ≈ 710 mL/h (NIOSH 2017-126 "1 cup every 15–20 minutes");
 * - TB MED 507 (2022) Table 3-2 water for the WBGT category and work column;
 * - ILO 2024 Table 8 water for WBGT and intensity;
 * - predicted sweat rate (ISO 7933 PHS) when supplied; regulatory minimum when supplied (e.g. ADOSH zone guidance).
 * The hourly cap 1½ qt ≈ 1.42 L/h and the daily cap 12 qt ≈ 11.36 L (TB MED 507 2022; NIOSH 2017-126) always win: drinking
 * beyond them risks hyponatraemia (TB MED 507 para 3-7h) — this includes a regulatory figure above 1.42 L/h.
 */
export function recommendWaterMlPerHour(input: WaterRecommendationInput): WaterRecommendation {
  requireFinite('recommendWaterMlPerHour', 'workW', input.workW)
  const nioshCadenceMl = HYDRATION.typicalLPerH[0] * 1000
  const wbgtC = input.wbgtC

  let tbmed507Ml: number | null = null
  let ilo2024Ml: number | null = null
  if (wbgtC !== undefined && Number.isFinite(wbgtC)) {
    const guidance = tbmed507Guidance(tbmed507Category(wbgtC), tbmed507WorkLevel(input.workW))
    tbmed507Ml = guidance === null ? null : guidance.waterLPerH * 1000
    const ilo = iloWaterLPerH(wbgtC, iloIntensityForWorkClass(input.workClass))
    ilo2024Ml = ilo === null ? null : ilo * 1000
  }
  const positive = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) && v > 0 ? v : null)
  const sweatReplacementMl = positive(input.sweatRateMlPerHour)
  const regulatoryMinMl = positive(input.regulatoryMinMlPerHour)

  const terms: [WaterBinding, number | null][] = [
    ['niosh_cadence', nioshCadenceMl],
    ['tbmed507', tbmed507Ml],
    ['ilo_2024', ilo2024Ml],
    ['sweat_replacement', sweatReplacementMl],
    ['regulatory_minimum', regulatoryMinMl],
  ]
  let need = 0
  let binding: WaterBinding = 'niosh_cadence'
  for (const [id, value] of terms) {
    if (value !== null && value > need) {
      need = value
      binding = id
    }
  }

  const intake = input.intakeTodayMl
  const dailyRemainingMl = intake !== undefined && Number.isFinite(intake) ? Math.max(0, FLUID_MAX_ML_PER_DAY - Math.max(0, intake)) : null
  let mlPerHour = need
  if (mlPerHour > FLUID_MAX_ML_PER_HOUR) {
    mlPerHour = FLUID_MAX_ML_PER_HOUR
    binding = 'hourly_cap'
  }
  if (dailyRemainingMl !== null && mlPerHour > dailyRemainingMl) {
    mlPerHour = dailyRemainingMl
    binding = 'daily_cap'
  }

  return {
    mlPerHour,
    binding,
    components: { nioshCadenceMl, tbmed507Ml, ilo2024Ml, sweatReplacementMl, regulatoryMinMl },
    hourlyCapMl: FLUID_MAX_ML_PER_HOUR,
    dailyRemainingMl,
    capped: mlPerHour < need,
    electrolytesAdvised: (input.hoursSweating ?? 0) > HYDRATION.electrolyteDrinkAfterH,
    basis: `${LIMITS_BASIS.hydration}; ${LIMITS_BASIS.tbmed507}; ${LIMITS_BASIS.ilo2024Water}`,
  }
}

// ═════════════════════════════════════ NIOSH Heat Alert ═════════════════════════════════════

/**
 * NIOSH 2016-106 §6.2.6(1)(d): "a Heat Alert would be declared if the area weather forecast for the next day predicts a
 * maximum air temperature of at least 35°C (95°F) or if a maximum temperature of 32°C (90°F) is predicted and is 5°C (9°F)
 * higher than the temperature reached on any of the preceding three days" (§6.2.6 wording preferred over §1.7.4).
 */
export const HEAT_ALERT = { forecastMaxC: 35, altForecastMaxC: 32, altRiseOverPrecedingC: 5, precedingDays: 3 } as const

/** NIOSH Heat Alert decision. */
export interface HeatAlertResult {
  alert: boolean
  trigger: 'forecast_max_35' | 'rise_over_preceding' | null
  /** Number of preceding daily maxima used for the rise test (0–3). */
  precedingDaysUsed: number
  basis: string
}

/**
 * NIOSH Heat Alert trigger: forecast daily maximum ≥ 35 °C, or ≥ 32 °C and at least 5 °C above the maximum of each of the
 * preceding 3 days (§1.7.4: "5°C … or more above the maximum reached on the preceding days").
 * `precedingDaysMaxC` is ordered oldest → newest; the last three finite values are used. A rise within 1e-9 °C of 5 °C
 * counts as met [ENG: floating-point ties resolve protectively]. Basis: NIOSH 2016-106 §6.2.6(1)(d).
 */
export function nioshHeatAlert(forecastMaxC: number, precedingDaysMaxC: readonly number[]): HeatAlertResult {
  requireFinite('nioshHeatAlert', 'forecastMaxC', forecastMaxC)
  const H = HEAT_ALERT
  const preceding = precedingDaysMaxC.filter((v) => Number.isFinite(v)).slice(-H.precedingDays)
  let trigger: HeatAlertResult['trigger'] = null
  if (forecastMaxC >= H.forecastMaxC) trigger = 'forecast_max_35'
  else if (forecastMaxC >= H.altForecastMaxC && preceding.length > 0) {
    const rise = forecastMaxC - Math.max(...preceding)
    if (rise >= H.altRiseOverPrecedingC - 1e-9) trigger = 'rise_over_preceding'
  }
  return { alert: trigger !== null, trigger, precedingDaysUsed: preceding.length, basis: LIMITS_BASIS.heatAlert }
}

// ═════════════════════════════════════ OSHA NPRM (proposed) ═════════════════════════════════════

/** OSHA proposed heat rule trigger tier. */
export type OshaNprmTrigger = 'none' | 'initial' | 'high'

/**
 * OSHA NPRM 89 FR 70698 (30 Aug 2024), proposed 29 CFR 1910.148(b),(e),(f) — PROPOSED, NOT IN FORCE (reference only):
 * initial heat trigger at HI ≥ 80 °F or WBGT ≥ RAL(M); high heat trigger at HI ≥ 90 °F or WBGT ≥ REL(M) ("at or above").
 */
export const OSHA_NPRM = { initialTriggerHiF: 80, highTriggerHiF: 90, returningAbsenceDays: 14 } as const

/** OSHA NPRM trigger tier from the heat index (°F). Basis: OSHA_NPRM (proposed, not in force). */
export function oshaNprmTriggerHi(hiF: number): OshaNprmTrigger {
  if (hiF >= OSHA_NPRM.highTriggerHiF) return 'high'
  if (hiF >= OSHA_NPRM.initialTriggerHiF) return 'initial'
  return 'none'
}

/** OSHA NPRM trigger tier from WBGT (°C) at metabolic rate M (W): ≥ REL(M) high, ≥ RAL(M) initial. Basis: OSHA_NPRM (proposed). */
export function oshaNprmTriggerWbgt(wbgtC: number, mW: number): OshaNprmTrigger {
  if (wbgtC >= exposureLimitC(mW, 'REL')) return 'high'
  if (wbgtC >= exposureLimitC(mW, 'RAL')) return 'initial'
  return 'none'
}

// ═════════════════════════════════════ Work capacity (reference only) ═════════════════════════════════════

/** Rest metabolic rate used by the Bröde 2018 / pythermalcomfort work-capacity curves [W] (not the ACGIH 115 W). */
export const BRODE_REST_METABOLIC_W = 117

function capacityPct(limitAtRestC: number, limitAtWorkC: number, wbgtC: number): number {
  if (!(limitAtRestC > limitAtWorkC)) return wbgtC <= limitAtRestC ? 100 : 0
  const pct = ((limitAtRestC - wbgtC) / (limitAtRestC - limitAtWorkC)) * 100
  return Math.min(100, Math.max(0, pct))
}

/**
 * Work capacity % (productivity estimate, NOT an exposure limit): linear between REL(M) → 100 % and REL(117 W) → 0 %,
 * clipped to 0–100. Basis: Bröde et al. 2018 (Int J Biometeorol 62:331) as in pythermalcomfort 4.8.1 `work_capacity_niosh`.
 */
export function workCapacityNioshPct(wbgtC: number, mW: number): number {
  return capacityPct(relC(BRODE_REST_METABOLIC_W), relC(mW), wbgtC)
}

/**
 * Work capacity % (productivity estimate, NOT an exposure limit) with Bröde's linear limit 34.9 − M/46 — not an ISO 7243
 * equation (roughly the 1989 acclimatised "no air movement" column). Basis: Bröde et al. 2018; pythermalcomfort 4.8.1
 * `work_capacity_iso` (limits_and_workrest.md §4).
 */
export function workCapacityIsoBrodePct(wbgtC: number, mW: number): number {
  const lim = (m: number): number => 34.9 - m / 46
  return capacityPct(lim(BRODE_REST_METABOLIC_W), lim(mW), wbgtC)
}

// ═════════════════════════════════════ ACGIH Table 4 heat-strain limits ═════════════════════════════════════

/**
 * ACGIH TLV Table 4 "Guidelines for Limiting Heat Strain" — discontinue exposure when any is met (limits_and_workrest.md
 * §3.8): sustained (several minutes) HR > 180 − age (normal cardiac performance); body core temperature > 38.5 °C (medically
 * selected, acclimatised) or > 38.0 °C (unselected, unacclimatised); recovery HR > 120 bpm one minute after peak effort;
 * sudden severe fatigue, nausea, dizziness or lightheadedness. Greater risk: shift weight loss > 1.5 %, 24-h urinary
 * sodium < 50 mmol. Heat stroke core > 40 °C; first-trimester sustained core > 39 °C. TLV goal: within +1 °C of 37 °C.
 * The core-temperature criteria refer to MEASURED core temperature; Zill only has an estimated strain indicator (ECTemp).
 */
export const ACGIH_HEAT_STRAIN_LIMITS = {
  sustainedHrBaseBpm: 180,
  coreTempSelectedAcclimatizedC: 38.5,
  coreTempUnselectedUnacclimatizedC: 38.0,
  recoveryHr1MinBpm: 120,
  shiftWeightLossPct: 1.5,
  urinarySodium24hMmol: 50,
  heatStrokeCoreC: 40.0,
  pregnancyFirstTrimesterSustainedCoreC: 39.0,
  tlvGoalCoreRiseC: 1.0,
} as const

/** Sustained heart-rate limit 180 − age (bpm), ACGIH TLV Table 4, for individuals with assessed normal cardiac performance. */
export function sustainedHrLimitBpm(ageYears: number): number {
  return ACGIH_HEAT_STRAIN_LIMITS.sustainedHrBaseBpm - ageYears
}
