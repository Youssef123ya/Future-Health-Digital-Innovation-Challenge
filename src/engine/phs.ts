/**
 * ISO 7933 Predicted Heat Strain (PHS): the modelled rectal temperature, sweat rate and water loss of an *average*
 * worker under a given climate, metabolic rate and clothing, and the allowable exposure times D_lim (ISO 7933 Annex B).
 *
 * This is a port of the pythermalcomfort 4.8.1 kernel (`pythermalcomfort.models.phs._phs_optimized_scalar`), which
 * transcribes the ISO 7933 Annex E reference program, with documented switches for the places where the ISO code
 * transcriptions differ from pythermalcomfort. Sources are in docs/research/phs_iso7933.md: §4 (pseudocode), §5 (2004
 * vs 2023), §6 (deviations), §11 (piecewise simulation). Agreement with `fixtures/phs.json` is checked in phs.test.ts.
 *
 * Claims discipline: PHS is occupational-safety decision support. It models an average person; D_lim is set to protect
 * 95 % of the exposed population (ISO 7933:2023 Scope). It does not measure anyone's core temperature and does not
 * diagnose heat illness. Zill uses it only to schedule protective action.
 *
 * DISPLAY RULE: never display a trajectory after the first D_lim as meaningful. The model has no physiological
 * ceiling (t_re reaches 44 to 49 °C in fixture vectors AD03 and AD23). The ISO 7933:2023 clause 5 WARNING also says it
 * "does not enable users to determine validly the duration of time needed for an average person whose rectal
 * temperature has risen to 38 °C or more to recover". For that reason limits latch: once reached they stay reached
 * for the rest of the exposure, and rest periods never "earn back" exposure time (phs_iso7933.md §11.4).
 *
 * Time base: 1-minute steps (ISO 7933 Annex E). All D_lim values are absolute minutes since the exposure started
 * (state.elapsedMin = 0). They are `null` when the limit is not reached, never the run duration (pythermalcomfort
 * returns the duration, phs_iso7933.md §0 item 5).
 *
 * Pure TypeScript: no clock, no randomness, no I/O.
 */

// ─────────────────────────────── Public types ───────────────────────────────

/**
 * ISO 7933 edition.
 * - `'7933-2023'` (default): ISO 7933:2023. Its foreword lists one technical change: SW_max (B.4) "is no longer
 *   adjusted for metabolic rate". It also adds the clause 5 WARNING on unsteady conditions. pythermalcomfort's 2023
 *   path also changes f_cl, h_c, the reflective-clothing formula, the minute-1 skin temperature and D_max
 *   (phs_iso7933.md §5, items 1 to 14).
 * - `'7933-2004'`: ISO 7933:2004, kept for regression against its normative Annex F (10 cases).
 */
export type PhsModel = '7933-2023' | '7933-2004'

/**
 * Rule for the convective heat-transfer coefficient h_c,dyn (W·m⁻²·K⁻¹). Both rules take max(natural, z), where
 * z = 3.5 + 5.2·v_r (v_r ≤ 1 m/s) or 8.7·v_r^0.6 is the forced-convection floor (ISO 7933 Annex E):
 * - `'tclIteration'` (engine default, ISO-faithful). Under 7933-2023, 2.38·|t_cl − t_a|^0.25 is re-evaluated from the
 *   converging t_cl inside the t_cl iteration, as jsthermalcomfort does. This reproduces ISO 7933:2023 Annex F case 3
 *   (t_re 38.69 °C, D_lim,tcr 151 min; published 38.7 °C, 149 min). Under 7933-2004, whose formula is
 *   2.38·|t_sk − t_a|^0.25, h_c is re-evaluated every minute from the current t_sk, as the 2004 Annex E BASIC program
 *   does (phs_iso7933.md §5 item 5, §6.1).
 * - `'pythermalcomfort'` (oracle parity). h_c is fixed for each constant-condition segment: from t_cl = t_r + 0.1
 *   under 2023, and from the t_sk at the start of the segment under 2004. On ISO 7933:2023 Annex F case 3 this mode is
 *   −0.50 °C off in t_re and gives D_lim,tcr = 275 min against 149 min published, which is the unsafe direction
 *   (phs_iso7933.md §6.1).
 *
 * In the typical Abu Dhabi cases of phs_iso7933.md (v ≥ 0.5 m/s) h_c = z under both rules, so they agree exactly.
 * They can still differ at very high radiant loads or low air speed (fixture AD14, v = 0.2 m/s: 43.17 vs 43.19 °C).
 */
export type PhsHcMode = 'tclIteration' | 'pythermalcomfort'

/**
 * Water-loss criterion for a worker who cannot drink freely (drink = 0, e.g. while fasting). Basis:
 * phs_iso7933.md §4.4, §6.4.
 * - `'pythermalcomfort'` (default, the more conservative reading): D_lim,loss = 0.6 × (first minute at which the
 *   water loss reaches D_max), with D_max = 3 % of body mass under 2023 and 5 % under 2004. Under 2023 this applies
 *   the 3 %/5 % reduction twice, so it is conservative (fixture AD15: 71.4 min).
 * - `'threshold3PctOnly'`: D_lim,loss = first minute at which the water loss reaches 3 % of body mass, with no 0.6
 *   factor. This is the MATLAB 2023 / LTH FDIS JS reading (AD15: 119 min). Under 2004 it is the threshold equivalent
 *   of the 0.6 rule (0.6 × 5 % = 3 %).
 */
export type PhsDrink0Mode = 'pythermalcomfort' | 'threshold3PctOnly'

/**
 * Factor k in the body heat capacity per unit area and minute, c_sp = k·W_b/A_Du (W·min·m⁻²·K⁻¹)
 * (phs_iso7933.md §3 and §6.2):
 * - `'pythermalcomfort'` (default): k = 58.15, i.e. c_p,b = 3489 J/(kg·K). Used for oracle parity. The doc recommends
 *   it; the difference is ≤ 3 g and ≤ 1 min.
 * - `'basic2004'`: k = 57.83 (= 3470/60), from the ISO 7933:2004 Annex E BASIC program. With it all 10 ISO
 *   7933:2004 Annex F cases are reproduced exactly (t_re to the published 0.1 °C, every D_lim to the minute, water
 *   within 0.39 g).
 *   UNVERIFIED: the constant printed in ISO 7933:2023 could not be checked (phs_iso7933.md §6.2).
 */
export type PhsSpHeatBasis = 'pythermalcomfort' | 'basic2004'

/** Posture. Sets the radiating fraction A_r/A_Du = 0.77 / 0.70 / 0.67 (ISO 7933 Annex E; phs_iso7933.md §3). */
export type PhsPosture = 'standing' | 'sitting' | 'crouching'

/**
 * Inputs to the PHS model for one constant-condition minute or segment. Basis: ISO 7933 clause 4 / Annex E inputs;
 * phs_iso7933.md §2.1. Exactly one of `rhPct` / `paKpa` is given (see {@link PhsInput}).
 */
export interface PhsInputBase {
  /** Air temperature t_a (°C). */
  tdbC: number
  /** Mean radiant temperature t_r (°C). Use a human MRT, not a 0.15 m globe conversion (phs_iso7933.md §10). */
  trC: number
  /** Air velocity at the body v_a (m/s). This is not the 10 m wind. */
  vMs: number
  /** Metabolic rate M (W/m² of DuBois area; ISO 8996). */
  metabolicWm2: number
  /** Effective mechanical power W (W/m²). Usually 0. */
  wmeWm2: number
  /** Static (basic) clothing insulation I_cl (clo). 1 clo = 0.155 m²·K/W. */
  clo: number
  posture: PhsPosture
  /** Acclimatised: SW_max is 500 W/m² (else 400) under 2023, and w_max is 1.0 (else 0.85). */
  acclimatized: boolean
  /** 1 = the worker can drink freely, 0 = cannot (e.g. fasting). See {@link PhsDrink0Mode}. */
  drink: 0 | 1
  /** Body mass W_b (kg), 0 < W_b ≤ 1000. */
  massKg: number
  /** Body height (m), > 0. */
  heightM: number
  /** Walking speed v_w (m/s). 0 or absent means "not entered": it is then estimated as min(0.0052·(M − 58), 0.7). */
  walkSpeedMs?: number
  /**
   * Angle between the walking direction and the wind (degrees). 0 or absent means "direction not entered", which
   * gives v_r = max(v_a, v_w). Use 180 for walking into the wind.
   */
  thetaDeg?: number
  /** Static moisture permeability index i_m,st (dimensionless). Default 0.38 (ISO 7933 Annex E default). */
  iMst?: number
  /**
   * Fraction of the body covered by reflective clothing A_p. Default 0. Always 0 for ordinary work clothes,
   * coveralls and FR coveralls. Fully reflective PPE is outside the ISO 7933:2023 scope (phs_iso7933.md §0 item 4,
   * §6.3).
   */
  aP?: number
  /**
   * Reflective-material coefficient F_r. Only matters when aP > 0. Under 2004 it is the emissivity of the reflective
   * clothing; under 2023 it is a reflection coefficient, used as 1 − F_r. Default: the neutral value (2004: 0.97,
   * 2023: 0.03), which gives ε_cl = 0.97, i.e. no reflective credit [ENG, conservative].
   * UNVERIFIED: the printed ISO 7933:2023 Annex D table of F_r could not be checked (phs_iso7933.md §6.3).
   */
  fR?: number
}

/**
 * PHS inputs. Humidity is given either as relative humidity `rhPct` (converted with the edition's wrapper formula,
 * {@link phsVapourPressureKpa}) or directly as the water-vapour partial pressure `paKpa`, which the ISO programs take.
 */
export type PhsInput = PhsInputBase &
  ({ rhPct: number; paKpa?: undefined } | { paKpa: number; rhPct?: undefined })

/** Model options. Defaults: {@link PHS_DEFAULT_OPTIONS}. Pass the same options to every call on one state. */
export interface PhsOptions {
  model?: PhsModel
  hcMode?: PhsHcMode
  drink0Mode?: PhsDrink0Mode
  spHeatBasis?: PhsSpHeatBasis
}

/** Options of {@link phsRun}. */
export interface PhsRunOptions extends PhsOptions {
  /** Number of 1-minute steps (integer ≥ 0). Default 480, one 8-h shift, as in ISO 7933 Annex F. */
  durationMin?: number
  /** Record one {@link PhsTracePoint} per minute. */
  trace?: boolean
}

/**
 * The full continuous PHS state carried minute to minute: plain, serialisable data. The seven physiological variables
 * are the pythermalcomfort state kwargs (phs_iso7933.md §11.2). The rest is bookkeeping that pythermalcomfort does
 * not carry and the engine must: elapsed minutes, the "exposure has started" flag and the first minutes at which each
 * limit was reached.
 */
export interface PhsState {
  model: PhsModel
  /** Mean skin temperature t_sk (°C). */
  tSkC: number
  /** Core temperature t_cr (°C). */
  tCrC: number
  /** Rectal temperature t_re (°C), as modelled for an average person (not a measurement). */
  tReC: number
  /** Core temperature as a function of the metabolic rate, t_cr,eq (°C), after its 10-min exponential lag. */
  tCrEqC: number
  /** α: fraction of body mass at skin temperature (pythermalcomfort `t_sk_t_cr_wg`), in [0.1, 0.3] once stepped. */
  skinCoreWeight: number
  /** Predicted sweat rate SW_p (W/m²), which carries the 10-min sweating lag. */
  sweatRateWm2: number
  /** Cumulative evaporative load ΣSW_p + E_res (W·min/m²). Water loss (g) is derived from it. */
  evapLoadWm2Min: number
  /** Minutes of exposure simulated since the exposure started. */
  elapsedMin: number
  /**
   * True once minute 1 of the exposure has been simulated. The 2023 minute-1 override (t_sk = t_sk,eq) applies only
   * while this is false, so chunked stepping equals one continuous run (phs_iso7933.md §6.5, §11.2 pitfall 2).
   */
  exposureStarted: boolean
  /**
   * True once any minute has been simulated with drink = 0. The no-drink water-loss criterion then applies for the
   * rest of the exposure [ENG, conservative: water not replaced while unable to drink is not "earned back"].
   */
  drinkRestricted: boolean
  /** First minute (since exposure start) with t_re ≥ 38 °C, or null. */
  tReLimitMin: number | null
  /** First minute at which the cumulative water loss reached 3 % of body mass, or null. */
  waterLoss3PctMin: number | null
  /** First minute at which the cumulative water loss reached 5 % of body mass, or null. */
  waterLoss5PctMin: number | null
  /** First minute at which the cumulative water loss reached 7.5 % of body mass (2004 D_max50), or null. */
  waterLoss7p5PctMin: number | null
  /**
   * Only for 7933-2004 with hcMode 'pythermalcomfort': the h_c (W·m⁻²·K⁻¹) fixed at the start of the current
   * constant-condition segment, keyed by those conditions. A pythermalcomfort call is one such segment. Otherwise null.
   */
  hcSegment: { key: string; hcWm2K: number } | null
}

/**
 * One simulated minute. Points after the first D_lim must not be displayed as meaningful (see the module doc).
 */
export interface PhsTracePoint {
  /** Minute since exposure start (the end of this 1-minute step). */
  minute: number
  tReC: number
  tSkC: number
  tCrC: number
  sweatRateWm2: number
  waterLossG: number
}

/** Allowable exposure times, in minutes since exposure start. null = not reached. Basis: ISO 7933 Table 1, Annex B. */
export interface PhsLimitMinutes {
  /** D_lim,tre (2004) / D_lim,tcr (2023): first minute with t_re ≥ 38 °C. */
  tReMin: number | null
  /**
   * The binding water-loss limit: D_lim,loss (2023) or D_lim,loss95 (2004), with the drink = 0 rule applied. It can be
   * fractional under the 0.6 rule (e.g. 119 × 0.6 = 71.4).
   */
  lossMin: number | null
  /** Only under 7933-2004: D_lim,loss50 (7.5 % of body mass, mean subject). Absent under 2023, which has a single D_lim,loss. */
  loss50Min?: number | null
}

/** Result of {@link phsRun}. Temperatures and rates are the values at the last minute. */
export interface PhsResult {
  model: PhsModel
  durationMin: number
  tReC: number
  tSkC: number
  tCrC: number
  tCrEqC: number
  skinCoreWeight: number
  /** Predicted sweat rate SW_p at the last minute (W/m²). */
  sweatRateWm2: number
  /** The same sweat rate in g/h: SW_p·2.67·A_Du/1.8 (ISO 7933:2004 NOTE: 2.67 g/h per W/m² for a 1.8 m² person). */
  sweatRateGPerH: number
  evapLoadWm2Min: number
  /** Cumulative whole-body water loss (sweat + respiratory evaporation), including any carried-over load (g). */
  waterLossG: number
  /** D_lim,tre / D_lim,tcr in minutes since exposure start, or null if not reached. */
  dLimTReMin: number | null
  /**
   * D_lim,loss (2023) or D_lim,loss95 (2004), with the drink = 0 rule applied, in minutes since exposure start, or
   * null. Under the 0.6 rule the limit can fall inside the run even though the water-loss threshold is crossed only
   * after it (pythermalcomfort then reports "not reached", e.g. fixture E10). Because the inputs are constant, the
   * run is extended internally to resolve that case [ENG, conservative]. The returned state is still the state at
   * `durationMin`.
   */
  dLimLossMin: number | null
  /** Only under 7933-2004: D_lim,loss50 (7.5 % of body mass), or null. */
  dLimLoss50Min?: number | null
  /** ISO 7933 Annex A Table A.1 check of the inputs. Results outside it are extrapolations. */
  validity: PhsValidity
  /** Final state, for chaining with {@link phsStep} / {@link minutesToLimit}. */
  state: PhsState
  /** Per-minute trajectory when `trace` was requested. Points after the first D_lim must not be displayed as meaningful. */
  trace?: PhsTracePoint[]
}

/**
 * Projection-only options of {@link minutesToLimit}. They never change a state, so they are kept apart from the model
 * options ({@link PhsOptions}), which must be the same for every call on one state.
 */
export interface PhsProjectionOptions {
  /**
   * Drink-allowed water-loss threshold, in g of cumulative water loss, used in place of the edition's drink-allowed
   * D_max (5 % of body mass). Example: a threshold raised by logged drinking (engine/risk.ts
   * RISK_THRESHOLDS.hydrationCredit). It is clamped to at least the edition's drink-allowed D_max, so it can never make
   * the projection less protective than ISO 7933. It is ignored while drinking is restricted (drink = 0 now or earlier
   * in the exposure), where the ISO no-drink criterion applies unchanged. Both the "already reached" check and the
   * crossing detection use it. A non-finite value, or one at or below the ISO value, gives exactly the ISO 7933
   * result (bit for bit).
   */
  lossThresholdG?: number
}

/** Minutes until the first ISO 7933 limit at constant conditions, and which limit binds. */
export interface PhsLimitProjection {
  /**
   * Minutes from now (state.elapsedMin) until the first limit. 0 means a limit has already been reached (limits
   * latch). null means none is reached within the horizon. The value can be fractional under the drink = 0 0.6 rule.
   */
  minutes: number | null
  /** 'rectal' = t_re ≥ 38 °C (heat storage); 'dehydration' = the water-loss limit; null when minutes is null. */
  binding: 'rectal' | 'dehydration' | null
}

/** Inputs checked against ISO 7933 Annex A Table A.1. */
export type PhsValidityField = 'tdbC' | 'trMinusTdbC' | 'vMs' | 'paKpa' | 'metabolicWm2' | 'clo'

/** Inclusive range. */
export interface PhsRange {
  min: number
  max: number
}

/** One input outside its Table A.1 range. */
export interface PhsValidityIssue extends PhsRange {
  field: PhsValidityField
  value: number
}

/** Result of {@link phsValidity}. */
export interface PhsValidity {
  withinLimits: boolean
  failing: PhsValidityIssue[]
}

/**
 * Per-segment quantities that depend only on the inputs (phs_iso7933.md §4.2), exposed so that the pre-loop block can
 * be unit-tested against `fixtures/phs.json` `derived`. Units: M2KW = m²·K/W, M2KpaW = m²·kPa/W, Wm2K = W·m⁻²·K⁻¹.
 */
export interface PhsConstants {
  readonly model: PhsModel
  readonly tdbC: number
  readonly trC: number
  /** Water-vapour partial pressure p_a actually used (kPa). */
  readonly paKpa: number
  readonly vMs: number
  readonly metabolicWm2: number
  readonly wmeWm2: number
  readonly clo: number
  /** DuBois area A_Du = 0.202·W_b^0.425·H^0.725 (m²). */
  readonly aDuM2: number
  /** Body heat capacity per unit area and minute c_sp (W·min·m⁻²·K⁻¹). */
  readonly spHeatWMinM2K: number
  /** 3 % / 5 % / 7.5 % of body mass (g): the D_max candidates of both editions. */
  readonly dMax3PctG: number
  readonly dMax5PctG: number
  readonly dMax7p5PctG: number
  /** Maximum sweat rate SW_max (W/m²). */
  readonly swMaxWm2: number
  /** Maximum skin wettedness w_max. */
  readonly wMax: number
  /** Clothing area factor f_cl. */
  readonly fcl: number
  readonly iClStM2KW: number
  readonly iTotStM2KW: number
  /** Relative air velocity v_r (m/s). */
  readonly vRMs: number
  /** Walking speed actually used (entered, or estimated from M) (m/s). */
  readonly walkSpeedMs: number
  readonly corrCl: number
  readonly corrIa: number
  readonly corrTot: number
  readonly iTotDynM2KW: number
  readonly iADynM2KW: number
  readonly iClDynM2KW: number
  readonly corrE: number
  readonly imDyn: number
  /** Dynamic evaporative resistance R_t,dyn (m²·kPa/W). */
  readonly rTDynM2KpaW: number
  /** Expired-air temperature t_ex (°C). */
  readonly tExpC: number
  /** Respiratory convective / evaporative heat flows C_res, E_res (W/m²). */
  readonly cResWm2: number
  readonly eResWm2: number
  /** Forced-convection floor z (W·m⁻²·K⁻¹). */
  readonly zWm2K: number
  /** pythermalcomfort's fixed h_c for a segment starting at the given t_sk (2004), or from t_r + 0.1 (2023). */
  readonly hcInitialWm2K: number
  /** σ·A_r/A_Du (W·m⁻²·K⁻⁴). */
  readonly auxRWm2K4: number
  /** Clothing emissivity including reflective parts ε_cl,r. */
  readonly fClR: number
  /** Steady-state t_cr,eq as a function of M (°C). */
  readonly tCrEqMC: number
  readonly tSkEqClBase: number
  readonly tSkEqNuBase: number
  /** (t_r + 273)^4 (K⁴). */
  readonly trK4: number
}

// ─────────────────────────────── Public constants ───────────────────────────────

/**
 * Default options. hcMode 'tclIteration' is the ISO-annex-faithful rule recommended in phs_iso7933.md §0 item 7 and
 * §6.1. drink0Mode 'pythermalcomfort' is the more conservative no-drink reading. spHeatBasis 'pythermalcomfort' (58.15)
 * is recommended for parity (§6.2).
 */
export const PHS_DEFAULT_OPTIONS: Readonly<Required<PhsOptions>> = {
  model: '7933-2023',
  hcMode: 'tclIteration',
  drink0Mode: 'pythermalcomfort',
  spHeatBasis: 'pythermalcomfort',
}

/** Rectal-temperature limit for D_lim,tre / D_lim,tcr: t_re ≥ 38.0 °C (ISO 7933 Annex B; phs_iso7933.md §3). */
export const PHS_T_RE_LIMIT_C = 38

/**
 * Iteration cap for the two damped fixed-point loops (t_cl and t_cr). pythermalcomfort has none (issue #524),
 * jsthermalcomfort uses 1000, and at most 17 / 13 iterations were observed over all fixture vectors
 * (phs_iso7933.md §4.7).
 */
export const PHS_MAX_ITERATIONS = 1000

/** Default exposure duration: 480 min, one 8-h shift (ISO 7933 Annex F examples; pythermalcomfort default). */
export const PHS_DEFAULT_DURATION_MIN = 480

/**
 * drink = 0 time factor: D_lim,loss × 0.6 (= 3 %/5 %), from the ISO 7933:2004 Annex E program (`DRINK = 0` line).
 * Applied once, after the loop, as pythermalcomfort 4.8.1 does. The 2004 BASIC re-applies it every minute inside the
 * loop (phs_iso7933.md §4.4, §6.4).
 */
export const PHS_DRINK0_TIME_FACTOR = 0.6

/**
 * Maximum water loss D_max as a fraction of body mass (phs_iso7933.md §3 and §5 item 2): 2023 uses a single D_max of
 * 5 % (drink = 1) or 3 % (drink = 0), output as D_lim,loss for 95 % of the working population (2023 Table 1). 2004
 * uses D_max95 = 5 % and D_max50 = 7.5 % (2004 Table 1).
 */
export const PHS_D_MAX_BODY_MASS_FRACTION = {
  drinkRestricted: 0.03,
  percentile95: 0.05,
  mean2004: 0.075,
} as const

/**
 * Initial state at the start of an exposure: t_sk 34.1 °C, t_cr = t_re = t_cr,eq = 36.8 °C, α = 0.3. These are the
 * ISO 7933 Annex E program initial values (pythermalcomfort 4.8.1 defaults; for 2004 t_re = t_cr,eq = t_cr = 36.8).
 * Basis: phs_iso7933.md §2.1.
 */
export const PHS_INITIAL_CONDITIONS = {
  tSkC: 34.1,
  tCrC: 36.8,
  tReC: 36.8,
  tCrEqC: 36.8,
  skinCoreWeight: 0.3,
} as const

/** Default static moisture permeability index i_m,st = 0.38 (ISO 7933 Annex E default; phs_iso7933.md §2.1). */
export const PHS_DEFAULT_I_MST = 0.38

/**
 * Applicability limits, ISO 7933 Annex A Table A.1, as implemented by pythermalcomfort 4.8.1 (inclusive bounds;
 * phs_iso7933.md §0 item 8, §4.6). t_r is checked as t_r − t_a, and v as the air speed (not v_r). Outside these ranges
 * Zill still computes, flags the result as extrapolated and degrades to conservative advice. It never silently
 * returns NaN (§4.6).
 * UNVERIFIED: the M range. pythermalcomfort derives 56–250 W/m² (2023) from "100–450 W" ÷ 1.8 m²; jsthermalcomfort
 * checks M·A_Du against 100–450 W; the printed tables could not be checked (§4.6).
 */
export const PHS_VALIDITY_LIMITS: Readonly<Record<PhsModel, Readonly<Record<PhsValidityField, PhsRange>>>> = {
  '7933-2023': {
    tdbC: { min: 15, max: 50 },
    trMinusTdbC: { min: 0, max: 60 },
    vMs: { min: 0, max: 3 },
    paKpa: { min: 0.5, max: 4.5 },
    // UNVERIFIED: 56–250 W/m² is pythermalcomfort's reading of the 2023 table (phs_iso7933.md §4.6).
    metabolicWm2: { min: 56, max: 250 },
    clo: { min: 0.1, max: 1.0 },
  },
  '7933-2004': {
    tdbC: { min: 15, max: 50 },
    trMinusTdbC: { min: 0, max: 60 },
    vMs: { min: 0, max: 3 },
    paKpa: { min: 0, max: 4.5 },
    // UNVERIFIED: the unit of the 2004 "100–450" (W/m² here, as pythermalcomfort; W in jsthermalcomfort) (§4.6).
    metabolicWm2: { min: 100, max: 450 },
    clo: { min: 0.1, max: 1.0 },
  },
}

// ─────────────────────────────── Internal constants (ISO 7933 Annex E; phs_iso7933.md §3) ───────────────────────────────

/** Factor k in c_sp = k·W_b/A_Du (see PhsSpHeatBasis). */
// UNVERIFIED: the constant printed in ISO 7933:2023 (58.15 kept for parity; MATLAB-2023 uses 3490/60) (§6.2).
const SP_HEAT_FACTOR: Readonly<Record<PhsSpHeatBasis, number>> = { pythermalcomfort: 58.15, basic2004: 57.83 }
/** Exponential-averaging constants per 1-min step: t_cr,eq (τ = 10 min), t_sk (τ = 3 min), SW_p (τ = 10 min). */
const C_TEQ = Math.exp(-1 / 10)
const C_TSK = Math.exp(-1 / 3)
const C_SW = Math.exp(-1 / 10)
/** A_r/A_Du by posture. */
const A_R_DU: Readonly<Record<PhsPosture, number>> = { standing: 0.77, sitting: 0.7, crouching: 0.67 }
/** Static boundary-layer insulation I_a,st (m²·K/W). */
const I_A_ST = 0.111
/** clo → m²·K/W. */
const CLO_TO_M2KW = 0.155
/** π as the literal 3.14159 used in every transcription (θ = 90° gives v_r = 0.4999987, fixture AD08). */
const PI_ISO = 3.14159
/** Kelvin offset in h_r: the literal 273, not 273.15. */
const KELVIN_ISO = 273
/** Stefan–Boltzmann constant as written in the program (W·m⁻²·K⁻⁴). */
const STEFAN_BOLTZMANN = 5.67e-8
/** Emissivity of non-reflective clothing ε_cl. */
const EMISSIVITY_CLOTHING = 0.97
/** Convergence tolerance of the t_cl and t_cr damped fixed points (°C). */
const CONVERGENCE_C = 0.001
/** Water-loss conversion: g = ΣSW·2.67·A_Du/1.8/60 (2004 NOTE: 2.67 g/h per W/m² for a 1.8 m² person). */
const G_PER_H_PER_WM2_AT_1_8M2 = 2.67
/** Neutral F_r per edition: 2004 ε = (1−A_p)·0.97 + A_p·F_r; 2023 ε = (1−A_p)·0.97 + A_p·(1−F_r). */
// UNVERIFIED: the 2023 (1 − F_r) form and the meaning of F_r (MATLAB #217 / pythermalcomfort; printed Annex D
// table unchecked, §6.3). The neutral default gives no reflective credit either way [ENG, conservative].
const NEUTRAL_F_R: Readonly<Record<PhsModel, number>> = { '7933-2004': 0.97, '7933-2023': 0.03 }

const MODELS: readonly PhsModel[] = ['7933-2023', '7933-2004']
const HC_MODES: readonly PhsHcMode[] = ['tclIteration', 'pythermalcomfort']
const DRINK0_MODES: readonly PhsDrink0Mode[] = ['pythermalcomfort', 'threshold3PctOnly']
const SP_HEAT_BASES: readonly PhsSpHeatBasis[] = ['pythermalcomfort', 'basic2004']
const VALIDITY_FIELDS: readonly PhsValidityField[] = ['tdbC', 'trMinusTdbC', 'vMs', 'paKpa', 'metabolicWm2', 'clo']

// ─────────────────────────────── Helpers ───────────────────────────────

/**
 * DuBois body surface area A_Du = 0.202·W_b^0.425·H^0.725 (m²). Gives 1.937871486 m² for 75 kg / 1.8 m.
 * Basis: DuBois & DuBois 1916, as used in ISO 7933 Annex E (phs_iso7933.md §3).
 */
export function phsDuBoisAreaM2(massKg: number, heightM: number): number {
  return 0.202 * massKg ** 0.425 * heightM ** 0.725
}

/**
 * Water-vapour partial pressure p_a (kPa) from relative humidity, using pythermalcomfort's `phs()` wrapper conversion
 * for each edition (phs_iso7933.md §2.1, §4.1). The ISO programs themselves take p_a in kPa.
 * - 2023: Magnus form of ISO 7933 Annex E, 0.6105·exp(17.27·t/(t + 237.3))·RH/100.
 * - 2004: Hyland–Wexler (ASHRAE) saturation pressure over liquid water, p_sat(t)/1000·RH/100, with T = t + 273.15.
 *   The over-ice branch (t < 0 °C) is not implemented: below 0 °C this extrapolates the liquid-water branch, far
 *   outside PHS validity (t_a ≥ 15 °C).
 */
export function phsVapourPressureKpa(tdbC: number, rhPct: number, model: PhsModel): number {
  if (model === '7933-2023') return (0.6105 * Math.exp((17.27 * tdbC) / (tdbC + 237.3)) * rhPct) / 100
  const tK = tdbC + 273.15
  const pSatPa = Math.exp(
    -5800.2206 / tK +
      1.3914993 +
      tK * (-0.048640239 + tK * (0.41764768e-4 + tK * -0.14452093e-7)) +
      6.5459673 * Math.log(tK),
  )
  return ((pSatPa / 1000) * rhPct) / 100
}

/**
 * Checks the inputs against the ISO 7933 Annex A Table A.1 applicability limits ({@link PHS_VALIDITY_LIMITS}),
 * inclusive, in pythermalcomfort's check order. Fields that are not finite numbers are also reported. Results for
 * inputs outside the limits are extrapolations: show them with lowered confidence and conservative advice, never
 * silently (phs_iso7933.md §4.6). Basis: ISO 7933 Annex A Table A.1.
 */
export function phsValidity(input: PhsInput, model: PhsModel = PHS_DEFAULT_OPTIONS.model): PhsValidity {
  const limits = PHS_VALIDITY_LIMITS[model]
  const paKpa = input.paKpa ?? (input.rhPct === undefined ? Number.NaN : phsVapourPressureKpa(input.tdbC, input.rhPct, model))
  const values: Record<PhsValidityField, number> = {
    tdbC: input.tdbC,
    trMinusTdbC: input.trC - input.tdbC,
    vMs: input.vMs,
    paKpa,
    metabolicWm2: input.metabolicWm2,
    clo: input.clo,
  }
  const failing: PhsValidityIssue[] = []
  for (const field of VALIDITY_FIELDS) {
    const value = values[field]
    const { min, max } = limits[field]
    if (!(value >= min && value <= max)) failing.push({ field, value, min, max })
  }
  return { withinLimits: failing.length === 0, failing }
}

/**
 * Computes the per-segment quantities that depend only on the inputs (phs_iso7933.md §4.2; ISO 7933 Annex E). These
 * are the clothing dynamic corrections (Corr_cl, Corr_Ia, Corr_tot, Corr_E), R_t,dyn, respiratory exchanges, the
 * convection floor z, SW_max, w_max and D_max. `tSkInitialC` only affects `hcInitialWm2K` under 2004
 * (pythermalcomfort's h_c fixed from the initial t_sk). Throws RangeError on invalid inputs.
 */
export function phsConstants(
  input: PhsInput,
  opts?: PhsOptions,
  tSkInitialC: number = PHS_INITIAL_CONDITIONS.tSkC,
): PhsConstants {
  const o = resolveOptions(opts)
  assertValidInput(input)
  const model = o.model
  const is2023 = model === '7933-2023'
  const { tdbC: tdb, trC: tr, vMs: v, metabolicWm2: met, wmeWm2: wme, clo, massKg: weight, heightM: height } = input
  const pa = resolvePaKpa(input, model)
  const iMst = input.iMst ?? PHS_DEFAULT_I_MST
  const aP = input.aP ?? 0
  const fR = input.fR ?? NEUTRAL_F_R[model]
  const theta = input.thetaDeg ?? 0
  let walk = input.walkSpeedMs ?? 0

  const aDu = phsDuBoisAreaM2(weight, height)
  const spHeat = (SP_HEAT_FACTOR[o.spHeatBasis] * weight) / aDu
  const dMax3 = PHS_D_MAX_BODY_MASS_FRACTION.drinkRestricted * weight * 1000
  const dMax5 = PHS_D_MAX_BODY_MASS_FRACTION.percentile95 * weight * 1000
  const dMax7p5 = PHS_D_MAX_BODY_MASS_FRACTION.mean2004 * weight * 1000

  // SW_max (W/m²). 2023 (B.4 corrected): 400 not acclimatised / 500 acclimatised. 2004: (M − 32)·A_Du clamped to
  // [250, 400], × 1.25 if acclimatised (transcribed as in the ISO program, units and all).
  let swMax: number
  if (is2023) {
    swMax = input.acclimatized ? 500 : 400
  } else {
    swMax = (met - 32) * aDu
    swMax = Math.min(swMax, 400)
    swMax = Math.max(swMax, 250)
    if (input.acclimatized) swMax = swMax * 1.25
  }
  const wMax = input.acclimatized ? 1 : 0.85

  const iClSt = clo * CLO_TO_M2KW
  // UNVERIFIED: f_cl = 1 + 0.28·I_cl in the printed 2023 text (pythermalcomfort and MATLAB #217; the ISO/FDIS-based
  // LTH JS still uses 0.3) (phs_iso7933.md §3, §5 item 7).
  const fcl = is2023 ? 1 + 0.28 * clo : 1 + 0.3 * clo
  const iTotSt = iClSt + I_A_ST / fcl

  // Relative air velocity and walking speed.
  let vR: number
  if (walk !== 0) {
    if (theta !== 0) vR = Math.abs(v - walk * Math.cos((PI_ISO * theta) / 180)) // unidirectional
    else if (v < walk) vR = walk // omnidirectional
    else vR = v
  } else {
    walk = 0.0052 * (met - 58) // estimate; negative for M < 58, harmless (min(…, 1) caps below) (§4.7)
    walk = Math.min(walk, 0.7)
    vR = v
  }
  const vUx = vR > 3 ? 3 : vR
  const wAUx = walk > 1.5 ? 1.5 : walk
  let corrCl = 1.044 * Math.exp((0.066 * vUx - 0.398) * vUx + (0.094 * wAUx - 0.378) * wAUx)
  corrCl = Math.min(corrCl, 1)
  // Corr_Ia uses the uncapped v_r (§3).
  let corrIa = Math.exp((0.047 * vR - 0.472) * vR + (0.117 * wAUx - 0.342) * wAUx)
  corrIa = Math.min(corrIa, 1)
  let corrTot = corrCl
  if (clo <= 0.6) corrTot = ((0.6 - clo) * corrIa + clo * corrCl) / 0.6
  const iTotDyn = iTotSt * corrTot
  const iADyn = corrIa * I_A_ST
  const iClDyn = iTotDyn - iADyn / fcl
  const corrE = (2.6 * corrTot - 6.5) * corrTot + 4.9
  const imDyn = Math.min(iMst * corrE, 0.9)
  const rTDyn = iTotDyn / imDyn / 16.7

  // Respiratory exchanges (W/m²).
  const tExp = 28.56 + 0.115 * tdb + 0.641 * pa
  const cRes = 0.001516 * met * (tExp - tdb)
  const eRes = 0.00127 * met * (59.34 + 0.53 * tdb - 11.63 * pa)

  // Forced-convection floor and pythermalcomfort's segment-fixed h_c.
  let z = 3.5 + 5.2 * vR
  if (vR > 1) z = 8.7 * vR ** 0.6
  const hcInitial = is2023 ? hcNatural(tr + 0.1 - tdb, z) : hcNatural(tSkInitialC - tdb, z)

  const auxR = STEFAN_BOLTZMANN * A_R_DU[input.posture]
  const fClR = is2023
    ? (1 - aP) * EMISSIVITY_CLOTHING + aP * (1 - fR)
    : (1 - aP) * EMISSIVITY_CLOTHING + aP * fR
  // pythermalcomfort form. The MATLAB 2023 transcription uses 0.0036·(M − 55) + 36.8 (difference 0.002 °C) (§4.2).
  const tCrEqM = 0.0036 * met + 36.6
  // Skin-temperature regressions use the air velocity v, not v_r (§4.2).
  const tSkEqClBase = 12.165 + 0.02017 * tdb + 0.04361 * tr + 0.19354 * pa - 0.25315 * v + 0.005346 * met
  const tSkEqNuBase = 7.191 + 0.064 * tdb + 0.061 * tr + 0.198 * pa - 0.348 * v

  if (!(iClDyn > 0) || !(rTDyn > 0)) {
    throw new RangeError(`PHS: inputs give a non-positive clothing resistance (i_cl,dyn = ${iClDyn}, R_t,dyn = ${rTDyn})`)
  }

  return {
    model,
    tdbC: tdb,
    trC: tr,
    paKpa: pa,
    vMs: v,
    metabolicWm2: met,
    wmeWm2: wme,
    clo,
    aDuM2: aDu,
    spHeatWMinM2K: spHeat,
    dMax3PctG: dMax3,
    dMax5PctG: dMax5,
    dMax7p5PctG: dMax7p5,
    swMaxWm2: swMax,
    wMax,
    fcl,
    iClStM2KW: iClSt,
    iTotStM2KW: iTotSt,
    vRMs: vR,
    walkSpeedMs: walk,
    corrCl,
    corrIa,
    corrTot,
    iTotDynM2KW: iTotDyn,
    iADynM2KW: iADyn,
    iClDynM2KW: iClDyn,
    corrE,
    imDyn,
    rTDynM2KpaW: rTDyn,
    tExpC: tExp,
    cResWm2: cRes,
    eResWm2: eRes,
    zWm2K: z,
    hcInitialWm2K: hcInitial,
    auxRWm2K4: auxR,
    fClR,
    tCrEqMC: tCrEqM,
    tSkEqClBase,
    tSkEqNuBase,
    trK4: (tr + KELVIN_ISO) ** 4,
  }
}

/**
 * The state at the start of an exposure ({@link PHS_INITIAL_CONDITIONS}, nothing elapsed, no limit reached, minute-1
 * override pending). Validates the inputs and options (throws RangeError). Basis: ISO 7933 Annex E initial values;
 * phs_iso7933.md §11.4.
 */
export function phsInitialState(input: PhsInput, opts?: PhsOptions): PhsState {
  const o = resolveOptions(opts)
  assertValidInput(input)
  return {
    model: o.model,
    tSkC: PHS_INITIAL_CONDITIONS.tSkC,
    tCrC: PHS_INITIAL_CONDITIONS.tCrC,
    tReC: PHS_INITIAL_CONDITIONS.tReC,
    tCrEqC: PHS_INITIAL_CONDITIONS.tCrEqC,
    skinCoreWeight: PHS_INITIAL_CONDITIONS.skinCoreWeight,
    sweatRateWm2: 0,
    evapLoadWm2Min: 0,
    elapsedMin: 0,
    exposureStarted: false,
    drinkRestricted: false,
    tReLimitMin: null,
    waterLoss3PctMin: null,
    waterLoss5PctMin: null,
    waterLoss7p5PctMin: null,
    hcSegment: null,
  }
}

/**
 * Advances the continuous PHS state by `minutes` whole minutes at constant `input`. This is the piecewise-shift
 * stepper of phs_iso7933.md §11.4 (the ISO 7933 Annex E minute loop with a continuous state). Under constant inputs,
 * any chunking gives exactly the same state as one continuous run: the 2023 minute-1 override applies only at
 * exposure start, limits are tracked in absolute minutes, and the 2004 pythermalcomfort h_c is anchored per
 * constant-condition segment. Returns a new state and never mutates `state`. Throws RangeError on invalid arguments.
 */
export function phsStep(state: PhsState, input: PhsInput, minutes: number, opts?: PhsOptions): PhsState {
  const o = resolveOptions(opts, state.model)
  assertValidState(state)
  assertWholeMinutes(minutes, 'minutes')
  const K = phsConstants(input, o)
  const w: PhsState = { ...state }
  advance(w, K, input, o, minutes)
  return w
}

/**
 * Runs the PHS model for `durationMin` minutes at constant conditions, from `init` (default
 * {@link phsInitialState}). It is equivalent to one pythermalcomfort 4.8.1 `phs(..., round_output=False,
 * limit_inputs=False)` call, except that D_lim values are minutes since exposure start, or null when not reached.
 * Basis: ISO 7933 Annex E program and Annex B criteria; phs_iso7933.md §4.
 */
export function phsRun(input: PhsInput, opts?: PhsRunOptions, init?: PhsState): PhsResult {
  const o = resolveOptions(opts, init?.model)
  const durationMin = opts?.durationMin ?? PHS_DEFAULT_DURATION_MIN
  assertWholeMinutes(durationMin, 'durationMin')
  if (init) assertValidState(init)
  const K = phsConstants(input, o)
  const w: PhsState = { ...(init ?? phsInitialState(input, o)) }
  const trace: PhsTracePoint[] | undefined = opts?.trace ? [] : undefined
  advance(w, K, input, o, durationMin, trace)

  const limits = phsLimitMinutes(w, o)
  let dLimLossMin = limits.lossMin
  let dLimLoss50Min = limits.loss50Min
  if (dLimLossMin === null && usesDrink0Factor(w.drinkRestricted, o)) {
    const ahead = scaledLossLimitAhead({ ...w }, K, input, o, w.elapsedMin)
    if (ahead !== null) {
      dLimLossMin = ahead
      if (o.model === '7933-2004') dLimLoss50Min = ahead
    }
  }

  const result: PhsResult = {
    model: o.model,
    durationMin,
    tReC: w.tReC,
    tSkC: w.tSkC,
    tCrC: w.tCrC,
    tCrEqC: w.tCrEqC,
    skinCoreWeight: w.skinCoreWeight,
    sweatRateWm2: w.sweatRateWm2,
    sweatRateGPerH: (w.sweatRateWm2 * G_PER_H_PER_WM2_AT_1_8M2 * K.aDuM2) / 1.8,
    evapLoadWm2Min: w.evapLoadWm2Min,
    waterLossG: waterLossG(w.evapLoadWm2Min, K.aDuM2),
    dLimTReMin: limits.tReMin,
    dLimLossMin,
    validity: phsValidity(input, o.model),
    state: w,
  }
  if (o.model === '7933-2004') result.dLimLoss50Min = dLimLoss50Min ?? null
  if (trace) result.trace = trace
  return result
}

/**
 * The allowable exposure times implied by a state's recorded threshold crossings, in minutes since exposure start,
 * with the edition's D_max and the drink = 0 rule (ISO 7933 Table 1, Annex B; phs_iso7933.md §4.4, §6.4). There is
 * no look-ahead: under the 0.6 rule a limit can already have passed before its threshold is crossed. Use
 * {@link minutesToLimit} to resolve that case by projection.
 */
export function phsLimitMinutes(state: PhsState, opts?: Pick<PhsOptions, 'drink0Mode'>): PhsLimitMinutes {
  const drink0Mode = opts?.drink0Mode ?? PHS_DEFAULT_OPTIONS.drink0Mode
  const scale = (minute: number | null): number | null => (minute === null ? null : minute * PHS_DRINK0_TIME_FACTOR)
  if (state.model === '7933-2023') {
    let lossMin: number | null
    if (!state.drinkRestricted) lossMin = state.waterLoss5PctMin
    else if (drink0Mode === 'threshold3PctOnly') lossMin = state.waterLoss3PctMin
    else lossMin = scale(state.waterLoss3PctMin)
    return { tReMin: state.tReLimitMin, lossMin }
  }
  if (!state.drinkRestricted) {
    return { tReMin: state.tReLimitMin, lossMin: state.waterLoss5PctMin, loss50Min: state.waterLoss7p5PctMin }
  }
  const restricted = drink0Mode === 'threshold3PctOnly' ? state.waterLoss3PctMin : scale(state.waterLoss5PctMin)
  return { tReMin: state.tReLimitMin, lossMin: restricted, loss50Min: restricted }
}

/**
 * Minutes from now until the first ISO 7933 limit (t_re ≥ 38 °C, or the dehydration limit D_lim,loss /
 * D_lim,loss95) if the current activity and conditions continue unchanged. It projects `state` forward at constant
 * `input` for up to `horizonMin` minutes. A limit already reached returns 0, because limits latch (ISO 7933:2023
 * clause 5 WARNING: recovery after t_re ≥ 38 °C cannot be validly modelled). Under the drink = 0 0.6 rule the
 * projection runs past the horizon, to minute (elapsed + horizon)/0.6, to find the threshold crossing that sets the
 * limit. Equal minutes resolve to 'rectal' [ENG]. Never mutates `state`. Basis: ISO 7933:2023 Annex B; the Zill
 * projection channel (ARCHITECTURE.md §5).
 *
 * `projection.lossThresholdG` (optional, {@link PhsProjectionOptions}) replaces the drink-allowed water-loss threshold
 * with a higher one, never a lower one. The state's recorded 5 % crossing then no longer marks the limit, so the
 * threshold is compared with the cumulative water loss itself; when both limits are already reached, 'rectal' is
 * reported (the crossing minute of a custom threshold is not recorded) [ENG].
 */
export function minutesToLimit(
  state: PhsState,
  input: PhsInput,
  horizonMin: number,
  opts?: PhsOptions,
  projection?: PhsProjectionOptions,
): PhsLimitProjection {
  const o = resolveOptions(opts, state.model)
  assertValidState(state)
  if (!(horizonMin >= 0) || !Number.isFinite(horizonMin)) {
    throw new RangeError(`PHS: horizonMin must be a finite number ≥ 0 (got ${horizonMin})`)
  }
  const horizon = Math.floor(horizonMin)
  const K = phsConstants(input, o)
  const start = state.elapsedMin
  const restricted = state.drinkRestricted || input.drink === 0
  const scaled = usesDrink0Factor(restricted, o)
  const lossKey = bindingLossKey(o.model, restricted, o.drink0Mode)
  // A custom drink-allowed threshold applies only above the edition's own drink-allowed D_max (never less protective).
  const customG = projection?.lossThresholdG
  const custom = !restricted && customG !== undefined && Number.isFinite(customG) && customG > K.dMax5PctG
  const lossThresholdG = custom ? (customG as number) : lossKey === 'waterLoss3PctMin' ? K.dMax3PctG : K.dMax5PctG

  // Limits already reached (latched). An externally built state may lack the recorded minute, so also check values.
  const rectalNow = state.tReLimitMin !== null || state.tReC >= PHS_T_RE_LIMIT_C
  const dehydrationNow = custom
    ? waterLossG(state.evapLoadWm2Min, K.aDuM2) >= lossThresholdG
    : state[lossKey] !== null || waterLossG(state.evapLoadWm2Min, K.aDuM2) >= lossThresholdG
  if (rectalNow || dehydrationNow) {
    const rectalAt = state.tReLimitMin ?? -Infinity
    const lossAt = custom ? Infinity : (state[lossKey] ?? -Infinity)
    const binding = rectalNow && (!dehydrationNow || rectalAt <= lossAt) ? 'rectal' : 'dehydration'
    return { minutes: 0, binding }
  }
  if (horizon === 0) return { minutes: null, binding: null }

  const w: PhsState = { ...state }
  const hc = planHc(w, K, input, o)
  if (input.drink === 0) w.drinkRestricted = true
  let rectalMin: number | null = null
  let lossMin: number | null = null
  let lastMinute = scaled ? lastMinuteWithinScaled(start + horizon) : start + horizon
  while (w.elapsedMin < lastMinute) {
    stepMinute(w, K, hc)
    const m = w.elapsedMin - start
    if (rectalMin === null && w.tReLimitMin !== null) {
      rectalMin = m
      const target = Math.min(horizon, m)
      lastMinute = scaled ? lastMinuteWithinScaled(start + target) : start + target
    }
    if (custom) {
      // Custom threshold (drink allowed, so never the 0.6 rule): the limit is the minute the loss reaches it.
      if (waterLossG(w.evapLoadWm2Min, K.aDuM2) >= lossThresholdG) {
        lossMin = m
        break
      }
      continue
    }
    const crossedAt = w[lossKey]
    if (crossedAt !== null) {
      // Direct threshold: the limit is this minute. 0.6 rule: the limit is 0.6 × the crossing minute (absolute), which
      // is always earlier than the crossing itself, so nothing later can bind first.
      lossMin = scaled ? Math.max(0, crossedAt * PHS_DRINK0_TIME_FACTOR - start) : m
      break
    }
  }
  const rectal = rectalMin !== null && rectalMin <= horizon ? rectalMin : null
  const loss = lossMin !== null && lossMin <= horizon ? lossMin : null
  if (rectal === null && loss === null) return { minutes: null, binding: null }
  if (loss === null || (rectal !== null && rectal <= loss)) return { minutes: rectal, binding: 'rectal' }
  return { minutes: loss, binding: 'dehydration' }
}

// ─────────────────────────────── Internals ───────────────────────────────

type HcPlan = { kind: 'fixed'; value: number } | { kind: 'tclIteration' } | { kind: 'tskEachMinute' }

/** max(2.38·|Δt|^0.25, z): natural convection with the forced-convection floor (ISO 7933 Annex E). */
function hcNatural(deltaC: number, zWm2K: number): number {
  return Math.max(2.38 * Math.abs(deltaC) ** 0.25, zWm2K)
}

function resolveOptions(opts: PhsOptions | undefined, stateModel?: PhsModel): Required<PhsOptions> {
  const model = opts?.model ?? stateModel ?? PHS_DEFAULT_OPTIONS.model
  const hcMode = opts?.hcMode ?? PHS_DEFAULT_OPTIONS.hcMode
  const drink0Mode = opts?.drink0Mode ?? PHS_DEFAULT_OPTIONS.drink0Mode
  const spHeatBasis = opts?.spHeatBasis ?? PHS_DEFAULT_OPTIONS.spHeatBasis
  if (!MODELS.includes(model)) throw new RangeError(`PHS: unknown model ${String(model)}`)
  if (stateModel !== undefined && model !== stateModel) {
    throw new RangeError(`PHS: options.model ${model} does not match the state's model ${stateModel}`)
  }
  if (!HC_MODES.includes(hcMode)) throw new RangeError(`PHS: unknown hcMode ${String(hcMode)}`)
  if (!DRINK0_MODES.includes(drink0Mode)) throw new RangeError(`PHS: unknown drink0Mode ${String(drink0Mode)}`)
  if (!SP_HEAT_BASES.includes(spHeatBasis)) throw new RangeError(`PHS: unknown spHeatBasis ${String(spHeatBasis)}`)
  return { model, hcMode, drink0Mode, spHeatBasis }
}

function resolvePaKpa(input: PhsInput, model: PhsModel): number {
  if (input.paKpa !== undefined) return input.paKpa
  if (input.rhPct !== undefined) return phsVapourPressureKpa(input.tdbC, input.rhPct, model)
  throw new RangeError('PHS: provide rhPct or paKpa')
}

function assertFinite(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`PHS: ${name} must be a finite number (got ${String(value)})`)
  }
}

/** Rejects inputs that would make the model meaningless or divide by zero (phs_iso7933.md §4.7). */
function assertValidInput(input: PhsInput): void {
  assertFinite('tdbC', input.tdbC)
  assertFinite('trC', input.trC)
  assertFinite('vMs', input.vMs)
  assertFinite('metabolicWm2', input.metabolicWm2)
  assertFinite('wmeWm2', input.wmeWm2)
  assertFinite('clo', input.clo)
  assertFinite('massKg', input.massKg)
  assertFinite('heightM', input.heightM)
  const hasRh = input.rhPct !== undefined
  const hasPa = input.paKpa !== undefined
  if (hasRh === hasPa) throw new RangeError('PHS: provide exactly one of rhPct or paKpa')
  if (hasRh) {
    assertFinite('rhPct', input.rhPct)
    if ((input.rhPct as number) < 0 || (input.rhPct as number) > 100) throw new RangeError('PHS: rhPct must be in [0, 100]')
  } else {
    assertFinite('paKpa', input.paKpa)
    if ((input.paKpa as number) < 0) throw new RangeError('PHS: paKpa must be ≥ 0')
  }
  if (input.vMs < 0) throw new RangeError('PHS: vMs must be ≥ 0')
  if (input.metabolicWm2 < 0) throw new RangeError('PHS: metabolicWm2 must be ≥ 0')
  if (input.clo <= 0) throw new RangeError('PHS: clo must be > 0 (i_cl,dyn = 0 at 0 clo)')
  if (!(input.massKg > 0 && input.massKg <= 1000)) throw new RangeError('PHS: massKg must be in (0, 1000]')
  if (!(input.heightM > 0)) throw new RangeError('PHS: heightM must be > 0')
  if (!(input.posture in A_R_DU)) throw new RangeError(`PHS: unknown posture ${String(input.posture)}`)
  if (input.drink !== 0 && input.drink !== 1) throw new RangeError('PHS: drink must be 0 or 1')
  if (typeof input.acclimatized !== 'boolean') throw new RangeError('PHS: acclimatized must be a boolean')
  if (input.walkSpeedMs !== undefined) {
    assertFinite('walkSpeedMs', input.walkSpeedMs)
    if (input.walkSpeedMs < 0) throw new RangeError('PHS: walkSpeedMs must be ≥ 0')
  }
  if (input.thetaDeg !== undefined) assertFinite('thetaDeg', input.thetaDeg)
  if (input.iMst !== undefined) {
    assertFinite('iMst', input.iMst)
    if (input.iMst <= 0) throw new RangeError('PHS: iMst must be > 0')
  }
  if (input.aP !== undefined) {
    assertFinite('aP', input.aP)
    if (input.aP < 0 || input.aP > 1) throw new RangeError('PHS: aP must be in [0, 1]')
  }
  if (input.fR !== undefined) {
    assertFinite('fR', input.fR)
    if (input.fR < 0 || input.fR > 1) throw new RangeError('PHS: fR must be in [0, 1]')
  }
}

function assertValidState(state: PhsState): void {
  if (!MODELS.includes(state.model)) throw new RangeError(`PHS: unknown state model ${String(state.model)}`)
  assertFinite('state.tSkC', state.tSkC)
  assertFinite('state.tCrC', state.tCrC)
  assertFinite('state.tReC', state.tReC)
  assertFinite('state.tCrEqC', state.tCrEqC)
  assertFinite('state.skinCoreWeight', state.skinCoreWeight)
  assertFinite('state.sweatRateWm2', state.sweatRateWm2)
  assertFinite('state.evapLoadWm2Min', state.evapLoadWm2Min)
  if (state.skinCoreWeight < 0 || state.skinCoreWeight > 1) throw new RangeError('PHS: state.skinCoreWeight must be in [0, 1]')
  if (state.sweatRateWm2 < 0) throw new RangeError('PHS: state.sweatRateWm2 must be ≥ 0')
  if (state.evapLoadWm2Min < 0) throw new RangeError('PHS: state.evapLoadWm2Min must be ≥ 0')
  assertWholeMinutes(state.elapsedMin, 'state.elapsedMin')
}

function assertWholeMinutes(minutes: number, name: string): void {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`PHS: ${name} must be a whole number ≥ 0 (got ${minutes})`)
}

/** Cumulative water loss (g) = ΣSW·2.67·A_Du/1.8/60 (ISO 7933:2004 NOTE; phs_iso7933.md §3). */
function waterLossG(evapLoadWm2Min: number, aDuM2: number): number {
  return (((evapLoadWm2Min * G_PER_H_PER_WM2_AT_1_8M2 * aDuM2) / 1.8) / 60)
}

/** True when the dehydration limit is 0.6 × a threshold-crossing minute. */
function usesDrink0Factor(restricted: boolean, o: Required<PhsOptions>): boolean {
  return restricted && o.drink0Mode === 'pythermalcomfort'
}

/** Which recorded threshold crossing sets the binding water-loss limit (D_lim,loss / D_lim,loss95). */
function bindingLossKey(
  model: PhsModel,
  restricted: boolean,
  drink0Mode: PhsDrink0Mode,
): 'waterLoss3PctMin' | 'waterLoss5PctMin' {
  if (!restricted) return 'waterLoss5PctMin'
  if (model === '7933-2023') return 'waterLoss3PctMin'
  return drink0Mode === 'threshold3PctOnly' ? 'waterLoss3PctMin' : 'waterLoss5PctMin'
}

/** Largest whole minute t with t × 0.6 ≤ limitMin (exactly as the 0.6 product is evaluated). */
function lastMinuteWithinScaled(limitMin: number): number {
  let t = Math.floor(limitMin / PHS_DRINK0_TIME_FACTOR)
  while ((t + 1) * PHS_DRINK0_TIME_FACTOR <= limitMin) t++
  while (t > 0 && t * PHS_DRINK0_TIME_FACTOR > limitMin) t--
  return t
}

/**
 * Under the 0.6 rule, extends a constant-condition run (on a scratch copy) until the water-loss threshold is crossed
 * or the crossing could no longer give 0.6 × t ≤ endMin. Returns the limit, or null if it is not reached by endMin.
 */
function scaledLossLimitAhead(
  w: PhsState,
  K: PhsConstants,
  input: PhsInput,
  o: Required<PhsOptions>,
  endMin: number,
): number | null {
  const key = bindingLossKey(o.model, true, o.drink0Mode)
  const lastMinute = lastMinuteWithinScaled(endMin)
  const hc = planHc(w, K, input, o)
  while (w[key] === null && w.elapsedMin < lastMinute) stepMinute(w, K, hc)
  const crossedAt = w[key]
  if (crossedAt === null) return null
  const limit = crossedAt * PHS_DRINK0_TIME_FACTOR
  return limit <= endMin ? limit : null
}

/** Segment key for the 2004 pythermalcomfort h_c anchor: every input that would start a new pythermalcomfort call. */
function segmentKey(input: PhsInput, K: PhsConstants, o: Required<PhsOptions>): string {
  return [
    o.model,
    o.spHeatBasis,
    K.tdbC,
    K.trC,
    K.paKpa,
    K.vMs,
    K.metabolicWm2,
    K.wmeWm2,
    K.clo,
    input.posture,
    input.acclimatized,
    input.drink,
    input.massKg,
    input.heightM,
    input.walkSpeedMs ?? 0,
    input.thetaDeg ?? 0,
    input.iMst ?? PHS_DEFAULT_I_MST,
    input.aP ?? 0,
    K.fClR,
  ].join('|')
}

/** Chooses the h_c rule for a segment and, for 2004 + pythermalcomfort, anchors h_c in the state. */
function planHc(w: PhsState, K: PhsConstants, input: PhsInput, o: Required<PhsOptions>): HcPlan {
  if (o.hcMode === 'pythermalcomfort') {
    if (o.model === '7933-2023') {
      w.hcSegment = null
      return { kind: 'fixed', value: K.hcInitialWm2K }
    }
    const key = segmentKey(input, K, o)
    if (w.hcSegment === null || w.hcSegment.key !== key) {
      w.hcSegment = { key, hcWm2K: hcNatural(w.tSkC - K.tdbC, K.zWm2K) }
    }
    return { kind: 'fixed', value: w.hcSegment.hcWm2K }
  }
  w.hcSegment = null
  return o.model === '7933-2023' ? { kind: 'tclIteration' } : { kind: 'tskEachMinute' }
}

/** Runs `minutes` steps in place on the working state `w`. */
function advance(
  w: PhsState,
  K: PhsConstants,
  input: PhsInput,
  o: Required<PhsOptions>,
  minutes: number,
  trace?: PhsTracePoint[],
): void {
  if (minutes === 0) return
  const hc = planHc(w, K, input, o)
  if (input.drink === 0) w.drinkRestricted = true
  for (let i = 0; i < minutes; i++) {
    const waterG = stepMinute(w, K, hc)
    if (trace) {
      trace.push({
        minute: w.elapsedMin,
        tReC: w.tReC,
        tSkC: w.tSkC,
        tCrC: w.tCrC,
        sweatRateWm2: w.sweatRateWm2,
        waterLossG: waterG,
      })
    }
  }
}

/**
 * One minute of the ISO 7933 Annex E loop (phs_iso7933.md §4.3), in place on `w`. Variable names follow the
 * pythermalcomfort source so that the port can be diffed against it. Returns the cumulative water loss (g).
 */
function stepMinute(w: PhsState, K: PhsConstants, hc: HcPlan): number {
  const tdb = K.tdbC
  const tr = K.trC
  const clo = K.clo
  // Values at the start of the minute.
  const tSk0 = w.tSkC
  const tRe0 = w.tReC
  const tCr0 = w.tCrC
  const tCrEq0 = w.tCrEqC
  const wg0 = w.skinCoreWeight

  // Core temperature as a function of M, and the heat stored for it.
  const tCrEq = tCrEq0 * C_TEQ + K.tCrEqMC * (1 - C_TEQ)
  const dStoredEq = K.spHeatWMinM2K * (tCrEq - tCrEq0) * (1 - wg0)

  // Steady-state skin temperature (uses t_re at the start of the minute), then its 3-min lag.
  const tSkEqCl = K.tSkEqClBase + 0.51274 * tRe0
  const tSkEqNu = K.tSkEqNuBase + 0.616 * tRe0
  let tSkEq: number
  if (clo >= 0.6) tSkEq = tSkEqCl
  else if (clo <= 0.2) tSkEq = tSkEqNu
  else tSkEq = tSkEqNu + 2.5 * (tSkEqCl - tSkEqNu) * (clo - 0.2)
  let tSk = tSk0 * C_TSK + tSkEq * (1 - C_TSK)
  // 2023 minute-1 override (absent in 2004), only at exposure start (phs_iso7933.md §5 item 6, §6.5).
  if (!w.exposureStarted && K.model === '7933-2023') tSk = tSkEq
  const pSk = 0.6105 * Math.exp((17.27 * tSk) / (tSk + 237.3))

  // Clothing surface temperature: damped fixed point. On convergence keep the old iterate and this h_r (and h_c).
  let hcDyn: number
  if (hc.kind === 'fixed') hcDyn = hc.value
  else if (hc.kind === 'tskEachMinute') hcDyn = hcNatural(tSk - tdb, K.zWm2K)
  else hcDyn = Number.NaN // set on the first iteration
  const tclIteration = hc.kind === 'tclIteration'
  let tCl = tr + 0.1
  let hR = 0
  for (let it = 1; ; it++) {
    if (it > PHS_MAX_ITERATIONS) throw new Error('PHS: clothing-temperature iteration did not converge')
    // UNVERIFIED: where the printed 2023 program evaluates h_c within the loop (§5 item 5); this placement
    // (jsthermalcomfort) reproduces Annex F case 3.
    if (tclIteration) hcDyn = hcNatural(tCl - tdb, K.zWm2K)
    hR = (K.fClR * K.auxRWm2K4 * ((tCl + KELVIN_ISO) ** 4 - K.trK4)) / (tCl - tr)
    const tClNew =
      (K.fcl * (hcDyn * tdb + hR * tr) + tSk / K.iClDynM2KW) / (K.fcl * (hcDyn + hR) + 1 / K.iClDynM2KW)
    if (Math.abs(tCl - tClNew) <= CONVERGENCE_C) break
    tCl = (tCl + tClNew) / 2
  }
  const convection = K.fcl * hcDyn * (tCl - tdb)
  const radiation = K.fcl * hR * (tCl - tr)

  // Required and maximum evaporation, required sweat rate.
  let eMax = (pSk - K.paKpa) / K.rTDynM2KpaW
  if (eMax === 0) eMax = 0.001 // pythermalcomfort guard
  let eReq = K.metabolicWm2 - dStoredEq - K.wmeWm2 - K.cResWm2 - K.eResWm2 - convection - radiation
  const wReq = eReq / eMax
  let swReq: number
  if (eReq <= 0) {
    eReq = 0
    swReq = 0
  } else if (eMax <= 0) {
    eMax = 0
    swReq = K.swMaxWm2
  } else if (wReq >= 1.7) {
    swReq = K.swMaxWm2
  } else {
    let rReq = wReq > 1 ? (2 - wReq) ** 2 / 2 : 1 - wReq ** 2 / 2
    rReq = Math.max(0.05, rReq) // pythermalcomfort floor
    swReq = Math.min(eReq / rReq, K.swMaxWm2)
  }

  // Predicted sweat rate (10-min lag) and predicted evaporation.
  let sw = w.sweatRateWm2 * C_SW + swReq * (1 - C_SW)
  let eP: number
  if (sw <= 0) {
    eP = 0
    sw = 0
  } else {
    const k = eMax / Math.max(sw, 1e-6) // pythermalcomfort epsilon
    let wP = 1
    if (k >= 0.5) wP = -k + Math.sqrt(k * k + 2)
    wP = Math.min(wP, K.wMax)
    eP = wP * eMax
  }
  const dStorage = eReq - eP + dStoredEq

  // Core temperature: implicit in α (fraction of body mass at skin temperature), damped fixed point.
  let tCrNew = tCr0
  let tCr = tCr0
  let wg = wg0
  for (let it = 1; ; it++) {
    if (it > PHS_MAX_ITERATIONS) throw new Error('PHS: core-temperature iteration did not converge')
    wg = 0.3 - 0.09 * (tCrNew - 36.8)
    wg = Math.min(wg, 0.3)
    wg = Math.max(wg, 0.1)
    tCr = dStorage / K.spHeatWMinM2K + (tSk0 * wg0) / 2 - (tSk * wg) / 2
    tCr = (tCr + tCr0 * (1 - wg0 / 2)) / (1 - wg / 2)
    if (Math.abs(tCr - tCrNew) <= CONVERGENCE_C) break
    tCrNew = (tCrNew + tCr) / 2
  }

  // Rectal temperature.
  const tRe = tRe0 + (2 * tCr - 1.962 * tRe0 - 1.31) / 9

  w.tSkC = tSk
  w.tCrC = tCr
  w.tReC = tRe
  w.tCrEqC = tCrEq
  w.skinCoreWeight = wg
  w.sweatRateWm2 = sw
  w.evapLoadWm2Min = w.evapLoadWm2Min + sw + K.eResWm2
  w.elapsedMin += 1
  w.exposureStarted = true

  // Limits, in absolute minutes since exposure start.
  if (w.tReLimitMin === null && tRe >= PHS_T_RE_LIMIT_C) w.tReLimitMin = w.elapsedMin
  const waterG = waterLossG(w.evapLoadWm2Min, K.aDuM2)
  if (w.waterLoss3PctMin === null && waterG >= K.dMax3PctG) w.waterLoss3PctMin = w.elapsedMin
  if (w.waterLoss5PctMin === null && waterG >= K.dMax5PctG) w.waterLoss5PctMin = w.elapsedMin
  if (w.waterLoss7p5PctMin === null && waterG >= K.dMax7p5PctG) w.waterLoss7p5PctMin = w.elapsedMin
  return waterG
}
