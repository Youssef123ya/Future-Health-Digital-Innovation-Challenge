/**
 * Thermal Work Limit (TWL) — Brake & Bates (2002), the heat-stress index of Abu Dhabi's ADOSH-SF CoP 11.0
 * *Safety in the Heat* v4.0 and its Technical Guideline (ADPHC, 15 July 2024, TG §2.1(a)).
 *
 * TWL is "the limiting (or maximum) sustainable metabolic rate that euhydrated, acclimatized individuals can maintain in
 * a specific thermal environment, within a safe deep body core temperature (< 38.20°C) and sweat rate (< 1.2 kg/hr)"
 * (Brake DJ, Bates GP. Appl Occup Environ Hyg 2002;17(3):176–186, abstract). It is a steady-state heat balance solved for
 * mean skin temperature (paper Appendix 1, "Derivation of TWL"). This module transcribes
 * docs/research/twl_and_regulation.md §1.2–§1.7 and reproduces the repository oracle (scripts/oracles/twl_oracle.py →
 * fixtures/twl.json).
 *
 * Scope (§1.10): the model assumes self-paced, educated, hydrated, ACCLIMATISED workers in permeable clothing.
 * Unacclimatised workers are handled by the jurisdiction zone rules in ./regulation.ts, not by this algorithm. It is not
 * valid for encapsulating or impermeable clothing, nor where the dew point is at or above skin temperature. TWL is an
 * environmental work-limit index for occupational-safety decision support, not a physiological measurement.
 *
 * Pure TypeScript: no DOM, no clock, no randomness. The psychrometric and globe helpers are deliberately local: the
 * TWL fit to the published tables (§1.8) depends on these exact choices (Tetens psat, A = 0.000644 with P in kPa).
 */

// ─────────────────────────────── Constants ───────────────────────────────

/**
 * Constants of the standard TWL formulation. Basis: Brake & Bates 2002 Appendix 1 unless stated; transcribed from
 * docs/research/twl_and_regulation.md §1.3 (identical to fixtures/twl.json `constants`).
 */
export const TWL_CONSTANTS = Object.freeze({
  /** Limiting deep-body core temperature, °C: "The limiting deep body core temperature in the standard TWL formulation is 38.2°C" (B&B 2002 App. 1). */
  tcoreLimitC: 38.2,
  /** Maximum sweat rate, kg m⁻² h⁻¹: "restricted to 0.67 kg/m⁻²/hr⁻¹ (1.2 liters per hour for a standard person)" (B&B 2002 App. 1). */
  srMaxKgPerM2PerH: 0.67,
  /** Latent heat of sweat, kJ/kg: "λ = 2430 kJ/kg @ 30°C [ASHRAE Eq. 14]" (B&B 2002 App. 1). */
  lambdaKjPerKg: 2430,
  /** λ·Sr conversion: 2430 kJ/kg ÷ 3.6 → 675 W m⁻² per kg m⁻² h⁻¹ (§1.3). */
  lambdaSrWm2PerKgM2H: 675,
  /** Radiation posture factor, standing: "typically 0.73 for a standing person" (B&B 2002 App. 1; ASHRAE). */
  postureFactor: 0.73,
  /** Lewis ratio, K/kPa (ASHRAE 1997 Fundamentals ch. 8 eq. 27, cited in B&B 2002 App. 1). */
  lewisRatioKPerKpa: 16.5,
  /** Minimum air speed over the skin, m/s: "wind speed has a minimum value of 0.2 m/s" (B&B 2002). */
  windMinMs: 0.2,
  /** Maximum air speed over the skin, m/s: "Under TWL, wind speed is also limited to 4 m/s" (B&B 2002). */
  windMaxMs: 4.0,
  /** Standard TWL clothing insulation Icl, clo (B&B 2002 worked example; Brake & Bates, Ann Occup Hyg 2002;46(2):165). */
  defaultIclClo: 0.35,
  /** Standard TWL clothing vapour permeation efficiency icl (same sources; "cannot exceed 1.0"). */
  defaultVapourPermeation: 0.45,
  /** Lower end of the valid TWL range, W/m²: "The valid range for TWL is from resting (60 W/m²) to 380 W/m²". */
  validMinWm2: 60,
  /** Upper end of the valid TWL range, W/m² (same sentence). */
  validMaxWm2: 380,
  /** Aspirated-psychrometer coefficient A, 1/K with P in kPa. Spec choice (§1.3/§1.8), not printed in the paper. */
  psychrometerCoeffPerK: 0.000644,
  /** Tetens/Magnus saturation vapour pressure coefficients (kPa, –, °C). Spec choice (§1.3/§1.8), not printed in the paper. */
  tetens: Object.freeze({ aKpa: 0.6105, b: 17.27, cC: 237.3 }),
  /** "Standard person" body surface area, m² (70 kg, 1.8 m²; B&B 2002 App. 1), used only for L/h conversions. */
  standardPersonAreaM2: 1.8,
  /** Root scan step, K, scanning down from tcore (§1.5 solver). */
  scanStepK: 0.05,
  /** Lowest skin temperature scanned, °C (§1.5 solver). */
  scanFloorC: 20,
  /** Bisection bracket width at convergence, K (§1.5 solver). */
  bisectionTolK: 1e-10,
  /** Maximum bisection iterations (§1.5 solver). */
  bisectionMaxIter: 200,
} as const)

/**
 * Brake & Bates (2002) withdrawal backstops, °C. Basis: B&B 2002 Table II and Miller & Bates 2007 Table 6 —
 * "Workers are also withdrawn (or subject to a permit system) whenever the dry bulb temperature exceeds 44°C,
 * irrespective of the TWL" (close to the skin temperature at which exposed-skin discomfort or burning begins) and
 * "when the wet bulb temperature exceeds 32°C" (a backstop against ±20 W/m² measurement error). NOT part of ADOSH-SF
 * TG v4.0 Table 1 (twl_and_regulation.md §2.4); used only for flags and the advisory {@link bb2002WithdrawalBackstop}.
 */
export const BB2002_BACKSTOP = Object.freeze({
  /** Dry bulb above which B&B 2002 withdraws workers regardless of TWL, °C (strictly greater: "exceeds"). */
  dryBulbAboveC: 44,
  /** Psychrometric wet bulb above which B&B 2002 withdraws workers regardless of TWL, °C (strictly greater). */
  wetBulbAboveC: 32,
} as const)

/** Stefan–Boltzmann constant used by ISO 7726:1998 Annex B, W m⁻² K⁻⁴ (5.67e-8, as in the spec §1.7). */
const SIGMA_W_M2_K4 = 5.67e-8

// ─────────────────────────────── Types ───────────────────────────────

/**
 * Reading of the zone-B sweat-efficiency equation (§1.6, the paper's one real ambiguity).
 * - `'physical'` (default): E = λSr·exp[−0.4127(x − 0.46)^1.168], x = λSr/Emax. Continuous, matches the paper's text
 *   for Fig. 3 and the authors' public calculator, and gives lower (more protective) TWL in dry, windy conditions.
 * - `'alt_1p8'`: the printed 1.8 factor applied to the zone tests and the exponent; reproduces Table I within ±1.9 W/m²
 *   but reads up to ~63 W/m² higher in dry, windy Abu Dhabi conditions. Kept for comparison with commercial meters.
 */
export type TwlVariant = 'physical' | 'alt_1p8'

/** Diagnostic flags (§1.5). Order of appearance matches the reference oracle. */
export type TwlFlag =
  | 'WIND_CLAMPED_TO_0.2'
  | 'WIND_CLAMPED_TO_4.0'
  | 'NO_ROOT_NET_HEAT_GAIN'
  | 'NO_ROOT_ABOVE_20C_SKIN'
  | 'DEWPOINT_AT_OR_ABOVE_SKIN_TEMP_INVALID'
  | 'BELOW_VALID_RANGE_60'
  | 'ABOVE_VALID_RANGE_380'
  | 'BACKSTOP_DB_GT_44C'
  | 'BACKSTOP_WB_GT_32C'
  /** Zill addition (not in the oracle): a required numeric input was missing or non-finite; TWL is NaN. */
  | 'INVALID_INPUT'

/** Inputs shared by every TWL call (§1.2, §6.1). */
export interface TwlBaseInput {
  /** Dry-bulb air temperature, °C. */
  tdbC: number
  /** Air speed over the worker, m/s. Clamped to [0.2, 4.0] inside the model (flagged). */
  windMs: number
  /** Barometric pressure, kPa (enters hc, he and the psychrometric equation). */
  pKpa: number
  /** Intrinsic clothing insulation Icl, clo. Default 0.35. */
  iclClo?: number
  /** Clothing vapour permeation efficiency icl, 0–1. Default 0.45. */
  vapourPermeation?: number
  /** Limiting core temperature, °C ("adjustable"). Default 38.2. */
  tcoreLimitC?: number
  /** Maximum sweat rate, kg m⁻² h⁻¹ ("adjustable"). Default 0.67. */
  srMaxKgPerM2PerH?: number
  /** Zone-B sweat-efficiency reading. Default `'physical'`. */
  variant?: TwlVariant
}

/**
 * Humidity: exactly one of PSYCHROMETRIC (aspirated) wet bulb, relative humidity, or vapour pressure (§1.2).
 * Never pass the natural (unaspirated) wet bulb from the WBGT model.
 */
export type TwlHumidityInput =
  | { twbPsychrometricC: number; rhPct?: never; paKpa?: never }
  | { rhPct: number; twbPsychrometricC?: never; paKpa?: never }
  | { paKpa: number; twbPsychrometricC?: never; rhPct?: never }

/**
 * Radiant input: mean radiant temperature, or a globe reading converted with ISO 7726:1998 Annex B (§1.7).
 * `globeDiameterM` defaults to 0.15 m. Kestrel 5400 output is already a 150 mm-equivalent globe temperature, so feed it
 * with D = 0.15 m; use 0.0508 m for the Liljegren-model globe.
 */
export type TwlRadiantInput =
  | { mrtC: number; tgC?: never; globeDiameterM?: never; globeEmissivity?: never }
  | { tgC: number; globeDiameterM?: number; globeEmissivity?: number; mrtC?: never }

/** Full TWL input: base + one humidity form + one radiant form. */
export type TwlInput = TwlBaseInput & TwlHumidityInput & TwlRadiantInput

/** TWL and the heat-balance terms at the solution (§1.4 eqs 1–15; §6.1 OUTPUT). */
export interface TwlResult {
  /** Thermal Work Limit, W/m². 0 when the skin gains heat even at core temperature (no sustainable work). */
  twlWm2: number
  /** Mean skin temperature at the heat-balance limit, °C. */
  tskC: number
  /** Ambient vapour pressure used, kPa. */
  paKpa: number
  /** Psychrometric wet bulb (given, or obtained by inverting eq. 1), °C. */
  twbPsychrometricC: number
  /** Dew point from pa (inverse Tetens), °C; −Infinity when pa = 0. */
  dewPointC: number
  /** Mean radiant temperature used, °C. */
  mrtC: number
  /** Air speed after clamping to [0.2, 4.0], m/s. */
  windUsedMs: number
  /** Core-to-skin heat flow H = Kcs·(tcore − tsk), W/m² (eq. 4). */
  coreToSkinWm2: number
  /** Dry heat loss C + R through clothing, W/m² (eq. 9). */
  dryHeatLossWm2: number
  /** Actual evaporative heat loss E, W/m² (eq. 12). */
  evapHeatLossWm2: number
  /** Maximum evaporative capacity Emax (fully wet skin), W/m² (eq. 11). */
  emaxWm2: number
  /** Respiratory heat loss B at M = TWL, W/m² (eq. 14). */
  respiratoryWm2: number
  /** Predicted sweat rate at the limit, kg m⁻² h⁻¹ (eq. 5, capped at srMax). */
  sweatRateKgPerM2PerH: number
  /** Predicted sweat rate for the 1.8 m² standard person, L/h. */
  sweatRateLph: number
  /** x = λSr/Emax (Fig. 3 abscissa); Infinity when Emax ≤ 0. */
  sweatToEmaxRatio: number
  /** Skin wettedness w = E/Emax; null when Emax ≤ 0. */
  skinWettedness: number | null
  /** Convective coefficient hc, W m⁻² K⁻¹ (eq. 6). */
  hcWm2K: number
  /** Radiative coefficient hr (before the posture factor), W m⁻² K⁻¹ (eq. 7). */
  hrWm2K: number
  /** Evaporative coefficient he, W m⁻² kPa⁻¹ (eq. 10). */
  heWm2Kpa: number
  /** Operative temperature to, °C (eq. 8). */
  operativeTempC: number
  /** Clothing sensible-heat efficiency Fcle (eq. 9). */
  fcle: number
  /** Clothing permeation efficiency Fpcl (eq. 11). */
  fpcl: number
  /** True when 60 ≤ TWL ≤ 380 W/m² (the model's stated valid range). */
  inValidRange: boolean
  variant: TwlVariant
  flags: TwlFlag[]
}

// ─────────────────────────────── Psychrometric and radiant helpers ───────────────────────────────

/**
 * Saturation vapour pressure over water, kPa: Tetens 0.6105·exp(17.27·t/(t + 237.3)).
 * Basis: twl_and_regulation.md §1.3 — the paper says only "standard psychrometric equations"; Tetens is the spec's
 * choice because it fits Brake & Bates 2002 Table I better than Hyland–Wexler or Buck (§1.8).
 */
export function psatTetensKpa(tC: number): number {
  const { aKpa, b, cC } = TWL_CONSTANTS.tetens
  return aKpa * Math.exp((b * tC) / (tC + cC))
}

/**
 * Ambient vapour pressure from dry bulb and PSYCHROMETRIC (aspirated) wet bulb, kPa:
 * pa = psat(twb) − 0.000644·P·(tdb − twb), floored at 0.
 * Basis: twl_and_regulation.md §1.4 eq. 1 (mine-ventilation psychrometer convention, P in kPa; spec choice §1.3).
 */
export function vapourPressureFromWetBulbKpa(tdbC: number, twbC: number, pKpa: number): number {
  return Math.max(psatTetensKpa(twbC) - TWL_CONSTANTS.psychrometerCoeffPerK * pKpa * (tdbC - twbC), 0)
}

/**
 * Ambient vapour pressure from relative humidity, kPa: pa = RH/100 · psat(tdb).
 * Basis: twl_and_regulation.md §1.2 ("the engine may pass RH or dew point instead").
 */
export function vapourPressureFromRhKpa(tdbC: number, rhPct: number): number {
  return (Math.max(rhPct, 0) / 100) * psatTetensKpa(tdbC)
}

/**
 * Psychrometric wet bulb consistent with {@link vapourPressureFromWetBulbKpa}, °C, by bisection of eq. 1 on [−40, tdb]
 * (200 iterations). Basis: twl_and_regulation.md §1.7 ("compute psychrometric WB by inverting eq. 1 only for the
 * WB > 32 °C backstop"); identical to the oracle's `wet_bulb_from_pa`.
 */
export function psychrometricWetBulbC(tdbC: number, paKpa: number, pKpa: number): number {
  let lo = -40
  let hi = tdbC
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi)
    if (vapourPressureFromWetBulbKpa(tdbC, mid, pKpa) > paKpa) hi = mid
    else lo = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * Dew point from vapour pressure (inverse Tetens), °C; −Infinity for pa ≤ 0.
 * Basis: twl_and_regulation.md §1.3 validity limit — "TWL is not valid where the dew point temperature of the ambient air
 * is above the skin or clothing temperature".
 */
export function dewPointFromVapourPressureC(paKpa: number): number {
  if (!(paKpa > 0)) return -Infinity
  const { aKpa, b, cC } = TWL_CONSTANTS.tetens
  const g = Math.log(paKpa / aKpa)
  return (cC * g) / (b - g)
}

/**
 * Mean radiant temperature from a black-globe reading, °C — ISO 7726:1998 Annex B:
 * tr = [(tg + 273.15)⁴ + hcg/(ε·σ)·(tg − ta)]^0.25 − 273.15, with hcg = max(1.4·(|tg − ta|/D)^0.25 [natural],
 * 6.3·v^0.6/D^0.4 [forced]), σ = 5.67e-8. Verified in the spec to < 1e-6 °C against pythermalcomfort
 * `mean_radiant_tmp(..., standard="ISO")` (§1.7).
 *
 * Pass the ACTUAL globe diameter: 0.15 m standard globe (default); 0.0508 m Liljegren-model globe. Kestrel 5400 output is
 * already converted to a 150 mm-equivalent globe temperature (fact-check, §1.7), so it takes D = 0.15 m — applying a
 * small-globe correction again would double-correct (82.6 °C instead of 67.1 °C in fixture GLOBE-150MM/GLOBE-25MM).
 *
 * @param windMs actual air speed at the globe (not clamped; negative values are treated as 0).
 */
export function globeToMrtIso7726(
  tgC: number,
  taC: number,
  windMs: number,
  diameterM = 0.15,
  emissivity = 0.95,
): number {
  const hNatural = 1.4 * (Math.abs(tgC - taC) / diameterM) ** 0.25
  const hForced = (6.3 * Math.max(windMs, 0) ** 0.6) / diameterM ** 0.4
  const hcg = Math.max(hNatural, hForced)
  return ((tgC + 273.15) ** 4 + (hcg / (emissivity * SIGMA_W_M2_K4)) * (tgC - taC)) ** 0.25 - 273.15
}

// ─────────────────────────────── TWL core ───────────────────────────────

/** Environment and clothing resolved for the solver. */
interface SolverEnv {
  taC: number
  trC: number
  vMs: number
  pKpa: number
  paKpa: number
  iclClo: number
  perm: number
  tcoreC: number
  srMax: number
  variant: TwlVariant
}

/** All Appendix-1 terms for a trial mean skin temperature (§1.4 eqs 2–13). */
interface HeatTerms {
  coreToSkin: number
  sr: number
  hc: number
  hr: number
  tOp: number
  fcle: number
  dry: number
  he: number
  fpcl: number
  emax: number
  x: number
  evap: number
  loss: number
}

function heatTerms(tsk: number, env: SolverEnv): HeatTerms {
  const { taC, trC, vMs, pKpa, paKpa, iclClo, perm, tcoreC, srMax, variant } = env
  // eq. 2 thermoregulatory signal (Cabanac); eq. 3 core-to-skin conductance (Wyndham, Fig. 1); eq. 4 core-to-skin flow
  const tSigma = 0.1 * tsk + 0.9 * tcoreC
  const kcs = 84 + 72 * Math.tanh(1.3 * (tSigma - 37.9))
  const coreToSkin = kcs * (tcoreC - tsk)
  // eq. 5 sweat rate (Fig. 2), clamped to [0, srMax]
  const sr = Math.min(Math.max(0.42 + 0.44 * Math.tanh(1.16 * (tSigma - 37.4)), 0), srMax)
  const lsr = TWL_CONSTANTS.lambdaSrWm2PerKgM2H * sr
  // eqs 6–8 convection [EESAM eq. 13], radiation [EESAM eq. 9] with posture factor, operative temperature [ASHRAE 8, 9]
  const hc = 0.608 * pKpa ** 0.6 * vMs ** 0.6
  const hr = 4.61 * (1 + (trC + tsk) / 546) ** 3
  const hrEff = TWL_CONSTANTS.postureFactor * hr
  const h = hrEff + hc
  const tOp = (hrEff * trC + hc * taC) / h
  // eq. 9 clothing, sensible heat [ASHRAE eq. 47; Table II]
  const fcl = 1 + 0.3 * iclClo
  const rcl = 0.155 * iclClo
  const fcle = fcl / (1 + fcl * h * rcl)
  const dry = fcle * h * (tsk - tOp)
  // eqs 10–11 evaporative coefficient [EESAM eq. 17] and clothing permeation [ASHRAE Table II]
  const he = (1587 * hc * pKpa) / (pKpa - paKpa) ** 2
  const recl = iclClo > 0 ? rcl / (TWL_CONSTANTS.lewisRatioKPerKpa * perm) : 0
  const fpcl = 1 / (1 + fcl * he * recl)
  const emax = fpcl * fcl * he * (psatTetensKpa(tsk) - paKpa)
  // eq. 12 actual evaporation (Fig. 3, Kerslake / Galimidi & Stewart); alt_1p8 per fact-check finding 3
  let x: number
  let evap: number
  if (emax <= 0) {
    x = Infinity
    evap = 0
  } else {
    x = lsr / emax
    const xx = variant === 'physical' ? x : 1.8 * x
    const s = variant === 'physical' ? lsr : 1.8 * lsr
    if (xx < 0.46) evap = s // zone A: no dripping, 100 % efficient
    else if (xx <= 1.7) evap = s * Math.exp(-0.4127 * (xx - 0.46) ** 1.168) // zone B: dripping, skin not fully wet
    else evap = emax // zone C: fully wet, dripping
    evap = Math.min(evap, emax)
  }
  return { coreToSkin, sr, hc, hr, tOp, fcle, dry, he, fpcl, emax, x, evap, loss: dry + evap }
}

function invalidResult(variant: TwlVariant): TwlResult {
  return {
    twlWm2: NaN,
    tskC: NaN,
    paKpa: NaN,
    twbPsychrometricC: NaN,
    dewPointC: NaN,
    mrtC: NaN,
    windUsedMs: NaN,
    coreToSkinWm2: NaN,
    dryHeatLossWm2: NaN,
    evapHeatLossWm2: NaN,
    emaxWm2: NaN,
    respiratoryWm2: NaN,
    sweatRateKgPerM2PerH: NaN,
    sweatRateLph: NaN,
    sweatToEmaxRatio: NaN,
    skinWettedness: null,
    hcWm2K: NaN,
    hrWm2K: NaN,
    heWm2Kpa: NaN,
    operativeTempC: NaN,
    fcle: NaN,
    fpcl: NaN,
    inValidRange: false,
    variant,
    flags: ['INVALID_INPUT'],
  }
}

const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x))

/**
 * Thermal Work Limit, W/m² — Brake & Bates (2002) Appendix 1, solved per twl_and_regulation.md §1.4–§1.5 / §6.1.
 *
 * Heat balance at the limit (tcore = 38.2 °C, Sr ≤ 0.67 kg m⁻² h⁻¹, fully wet skin at most):
 * H(tsk) = (C + R)(tsk) + E(tsk), then TWL = H / [1 − 0.0014·(34 − ta) − 0.0173·(5.87 − pa)] (eqs 13–15).
 * Solver: scan tsk DOWN from tcore − 1e-6 in 0.05 K steps (to 20 °C) for the first tsk with H − loss ≥ 0 — the warm-skin,
 * physiologically relevant root — then bisect to 1e-10 K. If the skin gains heat even at core temperature, TWL = 0 and
 * `NO_ROOT_NET_HEAT_GAIN` is flagged (no sustainable work). Wind is clamped to [0.2, 4.0] m/s; results outside 60–380
 * W/m² are flagged. Compare the UNROUNDED value with zone thresholds; display with Math.floor (§1.8, Point Health
 * calculator truncation).
 *
 * The Brake & Bates withdrawal backstops (DB > 44 °C, WB > 32 °C) are reported as flags only; they are not part of ADOSH
 * v4.0 — see {@link bb2002WithdrawalBackstop}.
 *
 * Non-finite numeric inputs return NaN with `INVALID_INPUT` (fail-safe: ./regulation.ts maps a non-finite TWL to the
 * most protective zone). Throws only on a malformed input shape (not exactly one humidity / radiant form).
 */
export function computeTwl(input: TwlInput): TwlResult {
  const variant: TwlVariant = input.variant ?? 'physical'
  const iclClo = input.iclClo ?? TWL_CONSTANTS.defaultIclClo
  const perm = input.vapourPermeation ?? TWL_CONSTANTS.defaultVapourPermeation
  const tcoreC = input.tcoreLimitC ?? TWL_CONSTANTS.tcoreLimitC
  const srMax = input.srMaxKgPerM2PerH ?? TWL_CONSTANTS.srMaxKgPerM2PerH
  const { tdbC, windMs, pKpa } = input

  const humidityForms = [input.twbPsychrometricC, input.rhPct, input.paKpa].filter((h) => h !== undefined).length
  if (humidityForms !== 1) throw new Error('computeTwl: give exactly one of twbPsychrometricC, rhPct, paKpa')
  if ((input.mrtC === undefined) === (input.tgC === undefined)) throw new Error('computeTwl: give exactly one of mrtC, tgC')

  const humidity = input.twbPsychrometricC ?? input.rhPct ?? input.paKpa ?? NaN
  const radiant = input.mrtC ?? input.tgC ?? NaN
  if (!finite(tdbC, windMs, pKpa, iclClo, perm, tcoreC, srMax, humidity, radiant) || !(pKpa > 0) || !(perm > 0)) {
    return invalidResult(variant)
  }

  const flags: TwlFlag[] = []

  // §6.1 PRE: humidity → pa; globe → MRT; wind clamp
  let paKpa: number
  if (input.twbPsychrometricC !== undefined) paKpa = vapourPressureFromWetBulbKpa(tdbC, input.twbPsychrometricC, pKpa)
  else if (input.rhPct !== undefined) paKpa = vapourPressureFromRhKpa(tdbC, input.rhPct)
  else paKpa = input.paKpa ?? NaN
  const twbC = input.twbPsychrometricC ?? psychrometricWetBulbC(tdbC, paKpa, pKpa)
  const mrtC =
    input.mrtC ??
    globeToMrtIso7726(input.tgC ?? NaN, tdbC, windMs, input.globeDiameterM ?? 0.15, input.globeEmissivity ?? 0.95)
  const vMs = Math.min(Math.max(windMs, TWL_CONSTANTS.windMinMs), TWL_CONSTANTS.windMaxMs)
  if (windMs < TWL_CONSTANTS.windMinMs) flags.push('WIND_CLAMPED_TO_0.2')
  if (windMs > TWL_CONSTANTS.windMaxMs) flags.push('WIND_CLAMPED_TO_4.0')

  const env: SolverEnv = { taC: tdbC, trC: mrtC, vMs, pKpa, paKpa, iclClo, perm, tcoreC, srMax, variant }
  const imbalance = (t: number) => {
    const q = heatTerms(t, env)
    return q.coreToSkin - q.loss
  }
  // eq. 15 respiratory denominator [ASHRAE eq. 26]
  const respDen = 1 - 0.0014 * (34 - tdbC) - 0.0173 * (5.87 - paKpa)

  // §1.5 solver
  const tHi = tcoreC - 1e-6
  let tskC: number
  let twlWm2: number
  let q: HeatTerms
  if (imbalance(tHi) >= 0) {
    flags.push('NO_ROOT_NET_HEAT_GAIN')
    tskC = tHi
    q = heatTerms(tHi, env)
    twlWm2 = 0
  } else {
    let bracket: [number, number] | null = null
    let t = tHi
    while (t > TWL_CONSTANTS.scanFloorC) {
      const tNext = t - TWL_CONSTANTS.scanStepK
      if (imbalance(tNext) >= 0) {
        bracket = [tNext, t]
        break
      }
      t = tNext
    }
    if (bracket === null) {
      flags.push('NO_ROOT_ABOVE_20C_SKIN')
      tskC = TWL_CONSTANTS.scanFloorC
      q = heatTerms(tskC, env)
      twlWm2 = q.coreToSkin / respDen
    } else {
      let [a, b] = bracket
      for (let i = 0; i < TWL_CONSTANTS.bisectionMaxIter; i++) {
        const m = 0.5 * (a + b)
        if (imbalance(m) >= 0) a = m
        else b = m
        if (b - a < TWL_CONSTANTS.bisectionTolK) break
      }
      tskC = 0.5 * (a + b)
      q = heatTerms(tskC, env)
      twlWm2 = q.coreToSkin / respDen
    }
  }

  const dewPointC = dewPointFromVapourPressureC(paKpa)
  if (dewPointC >= tskC) flags.push('DEWPOINT_AT_OR_ABOVE_SKIN_TEMP_INVALID')
  if (twlWm2 < TWL_CONSTANTS.validMinWm2) flags.push('BELOW_VALID_RANGE_60')
  if (twlWm2 > TWL_CONSTANTS.validMaxWm2) flags.push('ABOVE_VALID_RANGE_380')
  if (tdbC > BB2002_BACKSTOP.dryBulbAboveC) flags.push('BACKSTOP_DB_GT_44C')
  if (twbC > BB2002_BACKSTOP.wetBulbAboveC) flags.push('BACKSTOP_WB_GT_32C')

  return {
    twlWm2,
    tskC,
    paKpa,
    twbPsychrometricC: twbC,
    dewPointC,
    mrtC,
    windUsedMs: vMs,
    coreToSkinWm2: q.coreToSkin,
    dryHeatLossWm2: q.dry,
    evapHeatLossWm2: q.evap,
    emaxWm2: q.emax,
    respiratoryWm2: twlWm2 * (1 - respDen),
    sweatRateKgPerM2PerH: q.sr,
    sweatRateLph: q.sr * TWL_CONSTANTS.standardPersonAreaM2,
    sweatToEmaxRatio: q.x,
    skinWettedness: q.emax > 0 ? q.evap / q.emax : null,
    hcWm2K: q.hc,
    hrWm2K: q.hr,
    heWm2Kpa: q.he,
    operativeTempC: q.tOp,
    fcle: q.fcle,
    fpcl: q.fpcl,
    inValidRange: twlWm2 >= TWL_CONSTANTS.validMinWm2 && twlWm2 <= TWL_CONSTANTS.validMaxWm2,
    variant,
    flags,
  }
}

// ─────────────────────────────── Brake & Bates protocol (advisory, not ADOSH v4.0) ───────────────────────────────

/** Reason codes for the B&B 2002 backstop (fixture `backstop_reasons`). */
export type Bb2002BackstopReason = 'DB>44C' | 'WB>32C'

/** Outcome of the advisory B&B 2002 withdrawal backstop. */
export interface Bb2002Backstop {
  triggered: boolean
  reasons: Bb2002BackstopReason[]
  basis: string
}

/**
 * ADVISORY Brake & Bates (2002) withdrawal backstop: DB > 44 °C or psychrometric WB > 32 °C → "withdrawal (or permit
 * system)" irrespective of TWL. Basis: B&B 2002 Table II; Miller & Bates 2007 Table 6. This rule is NOT in ADOSH-SF CoP
 * 11.0 / TG v4.0 (2024), so it never changes the Abu Dhabi regulatory floor; it is offered as a conservative overlay
 * (twl_and_regulation.md §2.4: inland Abu Dhabi summer air often exceeds 44 °C, so enabling it is a product decision).
 * A non-finite input counts as exceeding (fail-safe).
 */
export function bb2002WithdrawalBackstop(tdbC: number, twbPsychrometricC: number): Bb2002Backstop {
  const reasons: Bb2002BackstopReason[] = []
  if (!(tdbC <= BB2002_BACKSTOP.dryBulbAboveC)) reasons.push('DB>44C')
  if (!(twbPsychrometricC <= BB2002_BACKSTOP.wetBulbAboveC)) reasons.push('WB>32C')
  return {
    triggered: reasons.length > 0,
    reasons,
    basis: 'Brake & Bates 2002 Table II; Miller & Bates 2007 Table 6 (advisory — not in ADOSH-SF TG v4.0)',
  }
}

/** Zones of the original four-zone TWL protocol (B&B 2002 Table II; M&B 2007 Table 6). */
export type Bb2002ProtocolZone = 'withdrawal' | 'buffer' | 'acclimatization' | 'unrestricted'

/**
 * Original four-zone TWL protocol — "<115 Withdrawal / 115 to 140 Buffer / 140 to 220 Acclimatization / >220
 * Unrestricted" (Brake & Bates 2002 Table II; Miller & Bates 2007 Table 6). Informational: Abu Dhabi uses the three-zone
 * ADOSH table in ./regulation.ts. A value exactly on 115, 140 or 220 resolves to the more protective zone [ENG] (the
 * oracle's half-open intervals differ only at exactly 115/140/220); a non-finite TWL resolves to 'withdrawal'.
 */
export function bb2002ProtocolZone(twlWm2: number): Bb2002ProtocolZone {
  if (!Number.isFinite(twlWm2) || twlWm2 <= 115) return 'withdrawal'
  if (twlWm2 <= 140) return 'buffer'
  if (twlWm2 <= 220) return 'acclimatization'
  return 'unrestricted'
}
