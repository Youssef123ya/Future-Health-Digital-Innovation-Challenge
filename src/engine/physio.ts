/**
 * Zill on-device physiology (engine/physio.ts).
 *
 * Heart rate (HR) from a consented wearable is processed on the worker's device only:
 *  1. Minute signal-quality index (SQI) from raw samples (physio_and_clinical.md §10.4).
 *  2. ECTemp, an *estimated* core-temperature strain indicator, from 1-min mean HR: the Buller et al. 2013 Kalman
 *     filter with the USARIEM estimateTcore.js constants (§10.1–10.2), an optional sigmoid observation model (Looney
 *     2018; US 12,426,839 B2 eq. 10), and the gap, re-initialisation and warm-up rules of §10.2.
 *  3. Physiological Strain Index (Moran 1998) and adaptive PSI (US 11,564,579 B2) (§10.3).
 *  4. The physiology risk channel: escalation floors sustained over 5 valid minutes (§10.5; ARCHITECTURE.md §5).
 *
 * Claims discipline: ECTemp is an estimate, shown only as a ±0.6 °C band (Buller 2013 limits of agreement ±0.63 °C).
 * Zill does not measure core temperature, does not diagnose and does not predict heat illness. The physiology channel
 * can raise the level but never lowers it, never produces T3 and never triggers a 998 call by itself, because a core-
 * temperature estimate cannot detect central-nervous-system dysfunction (§4.3 items 1, 2 and 5; Buller 2025).
 *
 * Intellectual property: ECTemp is covered by US 10,702,165 B2 (US Army; est. expiry 2033-12-16) and its sigmoid
 * refinement by US 12,426,839 B2 (est. expiry 2042-02-04); aPSI by US 11,564,579 B2 (adjusted expiry 2038-02-25).
 * USARIEM states that commercial use requires a licence. Legal review is required before any commercial deployment
 * (physio_and_clinical.md §2.1).
 */
import { MINUTE_MS } from './time'
import {
  TIER_TO_LEVEL,
  type ActionId,
  type ChannelResult,
  type ClinicalTier,
  type EctempState,
  type RiskDriver,
  type SignalQuality,
} from './types'

// ─────────────────────────────── ECTemp constants ───────────────────────────────

/**
 * ECTemp Kalman-filter constants — Buller MJ et al., "Estimation of human core temperature from sequential heart rate
 * observations", Physiol Meas 2013;34:781–798, with the values verbatim from the USARIEM reference implementation
 * estimateTcore.js (physio_and_clinical.md §10.1). Patented: US 10,702,165 B2 — commercial use needs a licence.
 *
 * GAMMA2 and SIGMA2 are computed as `0.022 ** 2` and `18.88 ** 2` (the official JS uses `Math.pow`), never typed as
 * literals, so the port stays bit-identical to the official code and the fixtures (§10.1 floating-point note).
 */
export const ECTEMP = {
  /** State transition (random walk), dimensionless. */
  A: 1.0,
  /** Process-noise standard deviation, °C per 1-min step. */
  GAMMA_SD: 0.022,
  /** Process-noise variance, °C² per step (JS variable "gamma"). */
  GAMMA2: 0.022 ** 2,
  /** Quadratic observation model HR = B2·CT² + B1·CT + B0 (HR in bpm, CT in °C). */
  B0: -7887.1,
  B1: 384.4286,
  B2: -4.5714,
  /** Observation-noise standard deviation, bpm. */
  SIGMA_SD: 18.88,
  /** Observation-noise variance, bpm² (JS variable "sigma"). */
  SIGMA2: 18.88 ** 2,
  /** Initial estimate, °C (official app default). */
  CT0_DEFAULT: 37.1,
  /** Initial variance, °C². */
  V0_DEFAULT: 0.0,
  /** Filter step, minutes: the filter MUST run on 1-min mean HR. */
  STEP_MIN: 1,
  /** Vertex of the quadratic, −B1/(2·B2), °C. Beyond it dHR/dCT ≤ 0 and the measurement update is skipped. */
  VERTEX_CT: 42.0471,
  /** HR at the vertex, bpm. */
  VERTEX_HR: 194.962,
} as const

/**
 * Optional sigmoid observation model HR = A + (K − A)/(1 + Q·e^(−B·(CT − M)))^(1/NU) — US 12,426,839 B2 eq. 10/11;
 * Looney DP et al., J Meas Phys Behav 2018;1:79 (physio_and_clinical.md §10.1). Uses the same GAMMA2/SIGMA2 as
 * {@link ECTEMP}. Patented (US 12,426,839 B2) — commercial use needs a licence.
 */
export const ECTEMP_SIGMOID = { A: 41, K: 193, Q: 0.06, B: 0.89, M: 37.84, NU: 0.07 } as const

/**
 * ECTemp data-handling rules (physio_and_clinical.md §10.2 rules 2–3). All three values are [ENG] defaults that need
 * prospective validation in Gulf outdoor workers (§10.13 item 10).
 */
export const ECTEMP_RULES = {
  /** Gaps of up to 5 missing minutes are filled by linear HR interpolation [ENG][US 10,702,165 B2]. */
  INTERPOLATE_MAX_GAP_MIN: 5,
  /** Gaps longer than 30 min (or a device swap / new shift) re-initialise the filter [ENG][Egbert 2022]. */
  REINIT_GAP_MIN: 30,
  /** After (re)initialisation the estimate is not used or shown for 30 min [ENG][Egbert 2022]. */
  WARMUP_MIN: 30,
} as const

/**
 * ECTemp display rules (physio_and_clinical.md §10.2 rule 4): a band of ±0.6 °C, approximating the Buller 2013 limits
 * of agreement (±0.63 °C), with the displayed value clamped to [35.5, 42.0] °C.
 */
export const ECTEMP_DISPLAY = { HALF_WIDTH_C: 0.6, LOA_C: 0.63, MIN_C: 35.5, MAX_C: 42.0 } as const

/** Observation model used by the ECTemp filter: Buller 2013 quadratic (default) or Looney 2018 sigmoid. */
export type EctempModel = 'quadratic' | 'sigmoid'

/** Expected HR at a given CT and the local slope dHR/dCT of the observation model. */
export interface EctempObservation {
  hrBpm: number
  slopeBpmPerC: number
}

/**
 * Observation model h(CT) and its slope c = dh/dCT — Buller 2013 quadratic (§10.1) or the sigmoid of US 12,426,839 B2
 * eq. 10 with derivative per §10.2 (c = (K−A)·Q·B/NU · e · (1+Q·e)^(−1/NU−1)). Arithmetic order matches the official
 * JS and the fixtures.
 */
export function ectempObservation(ctC: number, model: EctempModel = 'quadratic'): EctempObservation {
  if (model === 'quadratic') {
    return {
      hrBpm: ECTEMP.B2 * ctC ** 2 + ECTEMP.B1 * ctC + ECTEMP.B0,
      slopeBpmPerC: 2 * ECTEMP.B2 * ctC + ECTEMP.B1,
    }
  }
  const s = ECTEMP_SIGMOID
  const e = Math.exp(-s.B * (ctC - s.M))
  return {
    hrBpm: s.A + (s.K - s.A) / (1 + s.Q * e) ** (1 / s.NU),
    slopeBpmPerC: ((s.K - s.A) * s.Q * s.B) / s.NU * e * (1 + s.Q * e) ** (-(1 / s.NU) - 1),
  }
}

/**
 * One 1-min ECTemp Kalman step — Buller 2013 / USARIEM estimateTcore.js, transcribed with the identical arithmetic
 * order (physio_and_clinical.md §10.2).
 * - `hrBpm === null` (missing minute) or a non-finite `rScale` (invalid minute, §10.4) → time update only: CT held,
 *   variance + GAMMA2.
 * - Slope c ≤ 0 (beyond the quadratic vertex) → time update only [ENG guard].
 * - `rScale` multiplies SIGMA2 for minutes of reduced signal quality (Li, Mark & Clifford 2009 eq. 13).
 * Returns an *estimated* strain indicator, not a measured core temperature.
 */
export function ectempStep(
  ctPrevC: number,
  vPrev: number,
  hrBpm: number | null,
  rScale = 1,
  model: EctempModel = 'quadratic',
): { ctC: number; variance: number } {
  const ctPred = ECTEMP.A * ctPrevC
  const vPred = ECTEMP.A ** 2 * vPrev + ECTEMP.GAMMA2
  if (hrBpm === null || !Number.isFinite(hrBpm) || !Number.isFinite(rScale) || !(rScale > 0)) {
    return { ctC: ctPred, variance: vPred }
  }
  const { hrBpm: h, slopeBpmPerC: c } = ectempObservation(ctPred, model)
  if (c <= 0) return { ctC: ctPred, variance: vPred }
  const k = (vPred * c) / (c ** 2 * vPred + ECTEMP.SIGMA2 * rScale)
  return { ctC: ctPred + k * (hrBpm - h), variance: (1 - k * c) * vPred }
}

/** Options for {@link ectempRun}. `rScale` is one value for every minute or one value per minute. */
export interface EctempRunOptions {
  ct0C?: number
  v0?: number
  rScale?: number | readonly number[]
  model?: EctempModel
}

/**
 * Runs {@link ectempStep} over a series of 1-min mean HR values (null = missing minute, time update only) — the batch
 * form used by the reference fixtures (physio_and_clinical.md §10.2 rule 1, §10.11). No gap rules are applied here;
 * use {@link ectempUpdate} for streaming data.
 */
export function ectempRun(
  hrBpm: readonly (number | null)[],
  opts: EctempRunOptions = {},
): { ctC: number[]; variance: number[] } {
  const model = opts.model ?? 'quadratic'
  let ct = opts.ct0C ?? ECTEMP.CT0_DEFAULT
  let v = opts.v0 ?? ECTEMP.V0_DEFAULT
  const ctOut: number[] = []
  const vOut: number[] = []
  hrBpm.forEach((hr, i) => {
    const rs = typeof opts.rScale === 'number' ? opts.rScale : (opts.rScale?.[i] ?? 1)
    const next = ectempStep(ct, v, hr, rs, model)
    ct = next.ctC
    v = next.variance
    ctOut.push(ct)
    vOut.push(v)
  })
  return { ctC: ctOut, variance: vOut }
}

/**
 * Steady-state ECTemp for a constant HR: the inverse of the observation model (lower, physiological root of the
 * quadratic; sigmoid inverse). Null when the HR is beyond the model's range (quadratic above its vertex, sigmoid outside
 * (A, K)). Basis: Buller 2013 observation model; physio_and_clinical.md §10.12 steady-state oracle.
 */
export function ectempSteadyStateC(hrBpm: number, model: EctempModel = 'quadratic'): number | null {
  if (model === 'quadratic') {
    const disc = ECTEMP.B1 ** 2 - 4 * ECTEMP.B2 * (ECTEMP.B0 - hrBpm)
    if (disc < 0) return null
    return (-ECTEMP.B1 + Math.sqrt(disc)) / (2 * ECTEMP.B2)
  }
  const s = ECTEMP_SIGMOID
  if (!(hrBpm > s.A && hrBpm < s.K)) return null
  const u = ((s.K - s.A) / (hrBpm - s.A)) ** s.NU - 1
  if (u <= 0) return null
  return s.M - Math.log(u / s.Q) / s.B
}

// ─────────────────────────────── ECTemp streaming tracker ───────────────────────────────

/** Filter state at the last minute that carried a usable HR, kept while a gap of ≤ 5 minutes may still be interpolated. */
export interface EctempAnchor {
  ctC: number
  variance: number
  hrBpm: number
  rScale: number
}

/**
 * Streaming ECTemp state: the shared {@link EctempState} plus what the §10.2 gap and warm-up rules need.
 * `ctC`/`variance` always describe minute `t`; during an open gap they follow the null-minute path (CT held, variance
 * growing by GAMMA2 per minute) until the gap is interpolated or closed.
 */
export interface EctempTrack extends EctempState {
  model: EctempModel
  /** Epoch ms of the (re)initialisation; the 30-min warm-up runs from here. */
  initT: number
  /** Consecutive minutes without a usable reading (explicit nulls, invalid minutes or skipped timestamps). */
  missingRunMin: number
  /** Interpolation anchor while the current gap is ≤ 5 minutes; null otherwise. */
  anchor: EctempAnchor | null
}

/**
 * Initialises (or re-initialises) ECTemp at the start of the first minute `t` — default CT0 37.1 °C and variance 0
 * (USARIEM estimateTcore.js; physio_and_clinical.md §10.1). Call it for a new shift or a device swap (§10.2 rule 3);
 * the 30-min warm-up restarts from `t`. Then call {@link ectempUpdate} at t + 1 min, t + 2 min, ….
 * `v0` defaults to V0_DEFAULT (0 °C²); published variants use other values (de Korte 2022: 37.0 °C / 0.02 °C²).
 */
export function ectempInit(
  t: number,
  ct0C: number = ECTEMP.CT0_DEFAULT,
  model: EctempModel = 'quadratic',
  v0: number = ECTEMP.V0_DEFAULT,
): EctempTrack {
  return { ctC: ct0C, variance: v0, t, model, initT: t, missingRunMin: 0, anchor: null }
}

function asTrack(state: EctempState | EctempTrack): EctempTrack {
  if ('initT' in state) return state
  // A bare EctempState carries no warm-up history: restart the warm-up from now (fail-safe) [ENG].
  return { ...state, model: 'quadratic', initT: state.t, missingRunMin: 0, anchor: null }
}

function missingMinute(s: EctempTrack): EctempTrack {
  const p = ectempStep(s.ctC, s.variance, null, 1, s.model)
  const missingRunMin = s.missingRunMin + 1
  const anchor = missingRunMin > ECTEMP_RULES.INTERPOLATE_MAX_GAP_MIN ? null : s.anchor
  return { ...s, ctC: p.ctC, variance: p.variance, missingRunMin, anchor }
}

function commitMinute(s: EctempTrack, hrBpm: number, rScale: number, t: number): EctempTrack {
  const p = ectempStep(s.ctC, s.variance, hrBpm, rScale, s.model)
  return {
    ...s,
    ctC: p.ctC,
    variance: p.variance,
    t,
    missingRunMin: 0,
    anchor: { ctC: p.ctC, variance: p.variance, hrBpm, rScale },
  }
}

/**
 * Feeds one 1-min mean HR (null = no usable reading) stamped `t` into the ECTemp tracker, applying the §10.2 rules
 * (physio_and_clinical.md):
 * - rule 1: one Kalman step per minute in order; skipped minutes become null minutes;
 * - rule 2: a gap of ≤ 5 missing minutes is filled by linear interpolation between the last usable HR and this one
 *   once this reading arrives [ENG][US 10,702,165 B2]. Interpolated minutes use the larger of the two neighbouring
 *   `rScale` values, because they are not observations [ENG];
 * - rule 3: after a gap of more than 30 missing minutes the filter re-initialises (CT0_DEFAULT, V0_DEFAULT) and the
 *   30-min warm-up restarts [ENG][Egbert 2022].
 * A non-finite `rScale` (invalid minute per §10.4) counts as missing. Duplicate or out-of-order timestamps are ignored
 * [ENG]. Output is an estimated strain indicator, not a measured core temperature.
 */
export function ectempUpdate(state: EctempState | EctempTrack, hrBpm: number | null, t: number, rScale = 1): EctempTrack {
  let s = asTrack(state)
  const steps = Math.round((t - s.t) / MINUTE_MS)
  if (!(steps >= 1)) return s
  const skipped = steps - 1
  if (skipped > ECTEMP_RULES.REINIT_GAP_MIN) {
    // Closed form of `skipped` time-only updates (A = 1): CT held, variance + n·GAMMA2. Re-init follows on the next reading.
    s = { ...s, variance: s.variance + skipped * ECTEMP.GAMMA2, missingRunMin: s.missingRunMin + skipped, anchor: null }
  } else {
    for (let i = 0; i < skipped; i++) s = missingMinute(s)
  }
  if (hrBpm === null || !Number.isFinite(hrBpm) || !Number.isFinite(rScale) || !(rScale > 0)) {
    return { ...missingMinute(s), t }
  }
  if (s.missingRunMin > ECTEMP_RULES.REINIT_GAP_MIN) {
    return commitMinute(ectempInit(t - MINUTE_MS, ECTEMP.CT0_DEFAULT, s.model), hrBpm, rScale, t)
  }
  if (s.anchor !== null && s.missingRunMin > 0) {
    const a = s.anchor
    const n = s.missingRunMin
    const rs = Math.max(a.rScale, rScale)
    let ct = a.ctC
    let v = a.variance
    for (let j = 1; j <= n; j++) {
      const p = ectempStep(ct, v, a.hrBpm + ((hrBpm - a.hrBpm) * j) / (n + 1), rs, s.model)
      ct = p.ctC
      v = p.variance
    }
    return commitMinute({ ...s, ctC: ct, variance: v }, hrBpm, rScale, t)
  }
  return commitMinute(s, hrBpm, rScale, t)
}

/** True once 30 min have passed since the filter was (re)initialised — physio_and_clinical.md §10.2 rule 3 [ENG][Egbert 2022]. */
export function ectempWarmupDone(track: Pick<EctempTrack, 'initT'>, t: number): boolean {
  return t - track.initT >= ECTEMP_RULES.WARMUP_MIN * MINUTE_MS
}

/** ECTemp band for the worker's own screen, e.g. text "≈38.2 ± 0.6". */
export interface EctempBand {
  centreC: number
  halfWidthC: number
  lowC: number
  highC: number
  text: string
}

/**
 * ECTemp display band — physio_and_clinical.md §10.2 rule 4: "about 38.2 (±0.6)", ±0.6 °C ≈ Buller 2013 LoA ±0.63 °C,
 * value clamped to [35.5, 42.0] °C and rounded to 0.1 °C. Hidden (null) during warm-up, while the channel is invalid,
 * or when the worker has the HR-suppressing-medication flag. Shown only to the worker (and to occupational health after
 * a consented escalation); it is an estimate, never a measured core temperature.
 */
export function ectempDisplayBand(
  ctC: number | null,
  visibility: { channelValid: boolean; warmupDone?: boolean; hrSuppressingMedication?: boolean },
): EctempBand | null {
  if (!visibility.channelValid || visibility.warmupDone === false || visibility.hrSuppressingMedication === true) return null
  if (ctC === null || !Number.isFinite(ctC)) return null
  const clamped = Math.min(ECTEMP_DISPLAY.MAX_C, Math.max(ECTEMP_DISPLAY.MIN_C, ctC))
  const centreC = Math.round(clamped * 10) / 10
  const halfWidthC = ECTEMP_DISPLAY.HALF_WIDTH_C
  return {
    centreC,
    halfWidthC,
    lowC: Math.round((centreC - halfWidthC) * 10) / 10,
    highC: Math.round((centreC + halfWidthC) * 10) / 10,
    text: `≈${centreC.toFixed(1)} ± ${halfWidthC.toFixed(1)}`,
  }
}

// ─────────────────────────────── PSI and aPSI ───────────────────────────────

/**
 * Physiological Strain Index constants — Moran DS, Shitzer A, Pandolf KB, Am J Physiol 1998;275:R129–R134
 * (physio_and_clinical.md §10.3): limits 39.5 °C and 180 bpm, weight 5 per term, display clamped to 0–10.
 */
export const PSI_CONST = { CT_MAX_C: 39.5, HR_MAX_BPM: 180, WEIGHT: 5, DISPLAY_MIN: 0, DISPLAY_MAX: 10 } as const

/** Moran 1998 Table 1 PSI bands (names as in the reference fixtures). */
export type PsiBand = 'no_little' | 'low' | 'moderate' | 'high' | 'very_high'

/**
 * PSI = 5·(CT − CT0)/(39.5 − CT0) + 5·(HR − HR0)/(180 − HR0) — Moran 1998 (physio_and_clinical.md §10.3). Null when
 * CT0 ≥ 39.5 °C or HR0 ≥ 180 bpm. CT0 is ECTemp at shift start; HR0 per {@link psiHrBaseline}. Compute only while the
 * physiology channel is valid; log the raw value and clamp the display with {@link psiDisplay}.
 */
export function psiMoran(ctC: number, hrBpm: number, ct0C: number, hr0Bpm: number): number | null {
  if (ct0C >= PSI_CONST.CT_MAX_C || hr0Bpm >= PSI_CONST.HR_MAX_BPM) return null
  return (
    (PSI_CONST.WEIGHT * (ctC - ct0C)) / (PSI_CONST.CT_MAX_C - ct0C) +
    (PSI_CONST.WEIGHT * (hrBpm - hr0Bpm)) / (PSI_CONST.HR_MAX_BPM - hr0Bpm)
  )
}

/**
 * Moran 1998 Table 1 band of a continuous PSI, mapped conservatively with ceil() after rounding to 1e-9 [ENG]
 * (physio_and_clinical.md §10.3): ≤ 2 no/little · ≤ 4 low · ≤ 6 moderate · ≤ 8 high · > 8 very high.
 */
// UNVERIFIED: the Moran 1998 band table was verified only through its reproduction in US 11,564,579 B2 (§10.13 item 3).
export function psiBand(psi: number): PsiBand {
  const n = Math.ceil(Math.round(Math.max(0, psi) * 1e9) / 1e9)
  if (n <= 2) return 'no_little'
  if (n <= 4) return 'low'
  if (n <= 6) return 'moderate'
  if (n <= 8) return 'high'
  return 'very_high'
}

/** PSI clamped to 0–10 for display (the raw value is logged) — physio_and_clinical.md §10.3. */
export function psiDisplay(psi: number): number {
  return Math.min(PSI_CONST.DISPLAY_MAX, Math.max(PSI_CONST.DISPLAY_MIN, psi))
}

/**
 * aPSI critical values — US 11,564,579 B2 (physio_and_clinical.md §10.3): HRcrit = 0.90·(220 − age);
 * CTcrit = 39.5 °C without a chest skin temperature, else 39.5 + ((CT − Tsk) − 4)/4. Patented — licence needed.
 */
export function apsiCritical(
  ctC: number,
  ageYears: number,
  tskChestC: number | null = null,
): { hrCritBpm: number; ctCritC: number } {
  return {
    hrCritBpm: 0.9 * (220 - ageYears),
    ctCritC: tskChestC === null ? PSI_CONST.CT_MAX_C : PSI_CONST.CT_MAX_C + (ctC - tskChestC - 4) / 4,
  }
}

/**
 * Adaptive PSI = 5·(CT − CTrest)/(CTcrit − CTrest) + 5·(HR − HRrest)/(HRcrit − HRrest) — US 11,564,579 B2
 * (physio_and_clinical.md §10.3). Null when CTcrit ≤ CTrest or HRcrit ≤ HRrest. Use only with a validated chest
 * skin-temperature sensor; otherwise use {@link psiMoran}. Patented — commercial use needs a licence.
 */
export function apsi(
  ctC: number,
  hrBpm: number,
  ctRestC: number,
  hrRestBpm: number,
  ageYears: number,
  tskChestC: number | null = null,
): number | null {
  const { hrCritBpm, ctCritC } = apsiCritical(ctC, ageYears, tskChestC)
  if (ctCritC <= ctRestC || hrCritBpm <= hrRestBpm) return null
  return (5 * (ctC - ctRestC)) / (ctCritC - ctRestC) + (5 * (hrBpm - hrRestBpm)) / (hrCritBpm - hrRestBpm)
}

const isNum = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x)
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * PSI resting-HR baseline HR0 — physio_and_clinical.md §10.3 [ENG][Egbert 2022]: the lowest 5-min mean of seated 1-min
 * HR before work; if no complete 5-min seated window exists, the mean of the first 5 usable minutes of the shift.
 * Null when neither is available (PSI then stays unavailable — never reassurance).
 */
export function psiHrBaseline(
  seatedPreWorkHrBpm: readonly (number | null)[],
  shiftHrBpm: readonly (number | null)[] = [],
): number | null {
  const W = 5
  let best: number | null = null
  for (let i = 0; i + W <= seatedPreWorkHrBpm.length; i++) {
    const win = seatedPreWorkHrBpm.slice(i, i + W)
    if (win.every(isNum)) {
      const m = mean(win as number[])
      if (best === null || m < best) best = m
    }
  }
  if (best !== null) return best
  const first = shiftHrBpm.filter(isNum).slice(0, W)
  return first.length === W ? mean(first) : null
}

// ─────────────────────────────── Minute signal-quality index ───────────────────────────────

/**
 * Minute HR signal-quality rules — physio_and_clinical.md §10.4: plausible range 40–200 bpm (Egbert 2022 worker-study
 * exclusion rule), 10-s segments with a max/min ratio ≥ 2.2 rejected (Orphanidou 2015), flatline = ≥ 10 identical
 * values, minute valid at ψ ≥ 0.80 (Peltola 2012 analogue) [ENG].
 */
export const SQI = {
  HR_MIN: 40,
  HR_MAX: 200,
  SEG_S: 10,
  // UNVERIFIED: the Orphanidou rule values (ratio 2.2) were verified only through secondary sources (§10.13 item 4).
  RATIO_MAX: 2.2,
  FLAT_MIN_SAMPLES: 10,
  /** [ENG] psi_t 0.80 — needs prospective validation (§10.13 item 10). */
  PSI_MIN: 0.8,
} as const

/** One raw wearable HR sample inside a minute (input of {@link minuteSqi}). */
export interface HrRawSample {
  /**
   * Seconds from the start of the minute, normally in [0, 60) — the time base of the 10-s SQI segments. Absolute
   * seconds (e.g. minuteIndex·60 + s) are also accepted: {@link minuteSqi} first shifts every sample by
   * 60·floor(min(tSec)/60), so the earliest sample's minute starts at 0 [ENG].
   */
  tSec: number
  /** Reading in bpm; null when the device gave no reading. */
  bpm: number | null
  /** Skin contact reported by the device. A false value raises the 'contact_lost' flag even when `bpm` is null. */
  contactOk: boolean
}

/** Reasons a minute's samples were rejected (names as in the reference fixtures). */
export type SqiFlag = 'out_of_range' | 'contact_lost' | 'ratio_jump' | 'flatline' | 'low_coverage'

/** Result of {@link minuteSqi}. `sqi` is the coverage index ψ of Li, Mark & Clifford 2009 (not the strain index PSI). */
export interface MinuteSqi {
  sqi: number
  minuteValid: boolean
  /** Mean of the valid samples (reported even when the minute is invalid; null when no sample is valid). */
  hrMeanBpm: number | null
  /** Measurement-noise scale for {@link ectempStep}: exp(ψ⁻² − 1) when valid, Infinity when invalid. */
  rScale: number
  nValid: number
  nExpected: number
  flags: SqiFlag[]
  /** ≥ 80 % of the expected samples read > 200 bpm with good skin contact (input to the §4.3 item 3 rule). */
  implausibleHighHr: boolean
}

/**
 * Kalman measurement-noise scale from the coverage index ψ: exp(ψ⁻² − 1) — Li Q, Mark RG, Clifford GD, BioMed Eng
 * Online 2009;8:13 eq. 13 (physio_and_clinical.md §10.4). Infinity (no measurement update) when ψ < 0.80.
 */
export function sqiRScale(sqi: number): number {
  return sqi >= SQI.PSI_MIN ? Math.exp(sqi ** -2 - 1) : Infinity
}

/**
 * Minute SQI from raw samples — physio_and_clinical.md §10.4, transcribed from the reference oracle:
 * valid_i = contactOk ∧ 40 ≤ bpm ≤ 200; a fixed 10-s segment whose max/min ≥ 2.2 is rejected whole; ≥ 10 identical
 * values reject the minute (flatline); ψ = min(1, nValid / round(60 / expectedIntervalS)); minuteValid = ψ ≥ 0.80;
 * rScale = exp(ψ⁻² − 1) when valid, else Infinity.
 *
 * Two robustness rules on top of the oracle [ENG], neither of which changes any reference vector (all are stamped
 * 0–59 s with contact lost only on readings):
 * - 'contact_lost' is raised when any sample reports contactOk false, including samples with no reading (bpm null);
 * - segments use minute-relative seconds tSec − 60·floor(min(tSec)/60) (finite tSec only), so samples stamped with
 *   absolute seconds still get the ratio-jump check. A sample at ≥ 60 s relative (a window that crosses a minute
 *   boundary) falls in a further 10-s segment instead of skipping the check (fail-safe).
 */
export function minuteSqi(samples: readonly HrRawSample[], expectedIntervalS: number): MinuteSqi {
  const nExpected = Math.max(1, Math.round(60 / expectedIntervalS))
  const pts = samples.filter((s): s is HrRawSample & { bpm: number } => isNum(s.bpm))
  const valid = pts.map((p) => p.contactOk && p.bpm >= SQI.HR_MIN && p.bpm <= SQI.HR_MAX)
  const flags: SqiFlag[] = []
  if (pts.some((p) => p.bpm < SQI.HR_MIN || p.bpm > SQI.HR_MAX)) flags.push('out_of_range')
  if (samples.some((s) => !s.contactOk)) flags.push('contact_lost')
  let tMin = Infinity
  for (const s of samples) if (Number.isFinite(s.tSec) && s.tSec < tMin) tMin = s.tSec
  const minuteStartS = Number.isFinite(tMin) ? 60 * Math.floor(tMin / 60) : 0
  const segments = new Map<number, number[]>()
  pts.forEach((p, j) => {
    const seg = Math.floor((p.tSec - minuteStartS) / SQI.SEG_S)
    if (!Number.isFinite(seg) || !(p.bpm > 0)) return
    const idx = segments.get(seg)
    if (idx) idx.push(j)
    else segments.set(seg, [j])
  })
  for (const idx of segments.values()) {
    if (idx.length < 2) continue
    const vals = idx.map((j) => pts[j].bpm)
    if (Math.max(...vals) / Math.min(...vals) >= SQI.RATIO_MAX) {
      for (const j of idx) valid[j] = false
      if (!flags.includes('ratio_jump')) flags.push('ratio_jump')
    }
  }
  if (pts.length >= SQI.FLAT_MIN_SAMPLES && pts.every((p) => p.bpm === pts[0].bpm)) {
    valid.fill(false)
    flags.push('flatline')
  }
  const validBpm = pts.filter((_, j) => valid[j]).map((p) => p.bpm)
  const nValid = validBpm.length
  const sqi = Math.min(1, nValid / nExpected)
  const hrMeanBpm = nValid > 0 ? mean(validBpm) : null
  const minuteValid = sqi >= SQI.PSI_MIN && hrMeanBpm !== null
  if (sqi < SQI.PSI_MIN) flags.push('low_coverage')
  const highWithContact = pts.filter((p) => p.contactOk && p.bpm > SQI.HR_MAX).length
  return {
    sqi,
    minuteValid,
    hrMeanBpm,
    rScale: minuteValid ? Math.exp(sqi ** -2 - 1) : Infinity,
    nValid,
    nExpected,
    flags,
    implausibleHighHr: highWithContact >= SQI.PSI_MIN * nExpected,
  }
}

// ─────────────────────────────── Physiology channel ───────────────────────────────

/**
 * Physiology-channel validity and sustain rules — physio_and_clinical.md §10.4–10.5, §4.3 item 3: channel valid with
 * ≥ 10 of the last 15 minutes valid; floors must hold for 5 valid minutes [ENG]; a > 200 bpm reading with good contact
 * for ≥ 2 min prompts a check-in and a buddy check [ENG].
 */
export const PHYSIO_CHANNEL = { WINDOW_MIN: 15, MIN_VALID_MIN: 10, SUSTAIN_MIN: 5, IMPLAUSIBLE_HR_MIN: 2 } as const

/**
 * Physiology escalation thresholds — physio_and_clinical.md §10.5 [ENG thresholds anchored on cited data]:
 * ECTemp ≥ 38.0 °C advisory (WHO/NIOSH 2016 38 °C limit); ≥ 38.4 °C T1 (Hunt 2019 limit; 38.0 °C in conservative
 * mode, §10.9); ≥ 39.0 °C T2 (ECTemp under-reads at high core temperature, Hunt 2019, de Korte 2022; NIOSH 2016
 * hyperthermia classes). PSI > 4 advisory, > 6 T1, > 8 T2 (Moran 1998). Sustained HR > 180 − age T1 (NIOSH 2016).
 * Unknown age → 50 years, the NIOSH 2016 age boundary for extra medical evaluation [ENG, protective].
 */
export const PHYSIO_FLOORS = {
  ECTEMP_ADVISORY_C: 38.0,
  ECTEMP_T1_C: 38.4,
  ECTEMP_T1_CONSERVATIVE_C: 38.0,
  ECTEMP_T2_C: 39.0,
  // UNVERIFIED: Moran 1998 band table verified only via US 11,564,579 B2 (§10.13 item 3).
  PSI_ADVISORY: 4,
  PSI_T1: 6,
  PSI_T2: 8,
  HR_LIMIT_BASE_BPM: 180,
  UNKNOWN_AGE_YEARS: 50,
} as const

/** One evaluated minute of the physiology stream (from {@link minuteSqi} + {@link ectempUpdate} + {@link psiMoran}). */
export interface PhysioMinute {
  /** Epoch ms of the minute. */
  t: number
  /** SQI verdict for the minute (minuteValid). */
  valid: boolean
  /** 1-min mean HR when valid, else null. */
  hrBpm: number | null
  /** ECTemp estimate after this minute's update. */
  ctC: number | null
  /** PSI at this minute; null without a baseline. */
  psi: number | null
  /** Implausible > 200 bpm with good contact this minute (§4.3 item 3). */
  implausibleHighHr?: boolean
}

/** Why the physiology channel is unavailable (never treated as reassurance). */
export type PhysioUnavailableReason = 'not_consented' | 'hr_suppressing_medication' | 'no_signal' | 'signal_unusable' | 'warmup'

/** Inputs for {@link physioChannelStatus}. */
export interface PhysioChannelStatusInput {
  /** Evaluation time (epoch ms), normally the latest minute. */
  t: number
  /** Recent minutes (any order); only (t − 15 min, t] is used. */
  minutes: readonly PhysioMinute[]
  /** ECTemp (re)initialisation time; the 30-min warm-up runs from here. */
  initT: number
  /** consent.wearable and a paired wearable. */
  consented: boolean
  /** `hr_suppressing_medication` flag (see clinical.physioDisabled). */
  physioDisabled: boolean
}

/** Result of {@link physioChannelStatus}. */
export interface PhysioChannelStatus {
  channelValid: boolean
  reason: PhysioUnavailableReason | null
  validMinutesInWindow: number
  warmupDone: boolean
  signalQuality: SignalQuality
}

function minuteKey(t: number): number {
  return Math.round(t / MINUTE_MS)
}

/** Minutes in (t − windowMin, t], one record per minute (the last given wins), oldest first. */
function windowMinutes(minutes: readonly PhysioMinute[], t: number, windowMin: number): PhysioMinute[] {
  const hi = minuteKey(t)
  const byKey = new Map<number, PhysioMinute>()
  for (const m of minutes) {
    const k = minuteKey(m.t)
    if (k > hi - windowMin && k <= hi) byKey.set(k, m)
  }
  return [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m)
}

/**
 * Physiology channel validity — physio_and_clinical.md §10.4: channelValid = consented ∧ no HR-suppressing medication
 * ∧ ≥ 10 of the last 15 minutes valid ∧ 30-min warm-up done. Signal quality [ENG]: absent (no consent or no minutes),
 * unusable (< 10/15 valid), degraded (10–14/15), good (15/15).
 *
 * Reason precedence: not_consented → hr_suppressing_medication → warmup → no_signal → signal_unusable. The warm-up
 * (§10.2 rule 3, {@link ectempWarmupDone}) is tested before signal sufficiency because fewer than 10 minutes can exist
 * in the first 10 minutes after (re)initialisation; a start-up is therefore reported as 'warmup' and never as a sensor
 * fault ('check_sensor') [ENG]. A dropout longer than 30 min keeps the old initT until the next reading arrives
 * ({@link ectempUpdate} rule 3), so the gap itself is still reported as no_signal / signal_unusable.
 */
export function physioChannelStatus(input: PhysioChannelStatusInput): PhysioChannelStatus {
  const inWindow = windowMinutes(input.minutes, input.t, PHYSIO_CHANNEL.WINDOW_MIN)
  const validMinutesInWindow = inWindow.filter((m) => m.valid).length
  const warmupDone = ectempWarmupDone(input, input.t)
  const signalQuality: SignalQuality =
    !input.consented || inWindow.length === 0
      ? 'absent'
      : validMinutesInWindow < PHYSIO_CHANNEL.MIN_VALID_MIN
        ? 'unusable'
        : validMinutesInWindow < PHYSIO_CHANNEL.WINDOW_MIN
          ? 'degraded'
          : 'good'
  let reason: PhysioUnavailableReason | null = null
  if (!input.consented) reason = 'not_consented'
  else if (input.physioDisabled) reason = 'hr_suppressing_medication'
  else if (!warmupDone) reason = 'warmup'
  else if (inWindow.length === 0) reason = 'no_signal'
  else if (validMinutesInWindow < PHYSIO_CHANNEL.MIN_VALID_MIN) reason = 'signal_unusable'
  return { channelValid: reason === null, reason, validMinutesInWindow, warmupDone, signalQuality }
}

/** Inputs for {@link physiologyLevel}. */
export interface PhysiologyInput extends PhysioChannelStatusInput {
  ageYears?: number
  /** Conservative mode (clinical.conservativeMode): ECTemp T1 at 38.0 °C. */
  conservativeMode: boolean
}

/** Physiology channel result: a {@link ChannelResult} plus the tier, actions, validity status and display band. */
export interface PhysiologyChannelResult extends ChannelResult {
  channel: 'physiology'
  /** 0–2; physiology alone never produces T3. */
  tier: ClinicalTier
  actions: ActionId[]
  status: PhysioChannelStatus
  /** ECTemp band for the worker's screen; null when hidden. */
  display: EctempBand | null
}

const UNAVAILABLE_TEXT: Record<PhysioUnavailableReason, string> = {
  not_consented: 'Body signals unavailable (wearable not consented) - using weather and work',
  hr_suppressing_medication: 'Body signals not used for this worker (health setting) - using weather and work',
  no_signal: 'Body signals unavailable (no heart-rate data) - using weather and work',
  signal_unusable: 'Body signals unavailable (poor heart-rate signal) - using weather and work',
  warmup: 'Body signals warming up (first 30 min) - using weather and work',
}

const FAILSAFE_BASIS = 'physio_and_clinical.md §4.3 fail-safe architecture; §10.4 channel validity [ENG]'

const ACTIONS_T2: readonly ActionId[] = [
  'stop_work',
  'rest_shade_now',
  'cool_down',
  'symptom_checkin',
  'buddy_check',
  'first_aider_check',
  'drink_water',
  'no_hot_work_today',
]
const ACTIONS_T1: readonly ActionId[] = ['rest_shade_now', 'cool_down', 'drink_water', 'symptom_checkin', 'buddy_check']

/**
 * Physiology channel — physio_and_clinical.md §10.5 floors, ARCHITECTURE.md §5, evaluated only while the channel is
 * valid (§10.4). Each condition must hold in each of the 5 most recent valid minutes of the 15-min window; an invalid
 * minute neither counts nor resets the run, so a dropout cannot postpone an escalation [ENG, protective].
 * - T1 (→ high): ECTemp ≥ 38.4 °C (≥ 38.0 °C in conservative mode) [Hunt 2019], PSI > 6 [Moran 1998], HR > 180 − age
 *   [NIOSH 2016].
 * - T2 (→ stop): ECTemp ≥ 39.0 °C [Hunt 2019; de Korte 2022; NIOSH 2016] or PSI > 8 [Moran 1998].
 * - Advisory only ('info' drivers + 'symptom_checkin'): ECTemp ≥ 38.0 °C [WHO/NIOSH 38 °C], PSI > 4.
 * - Any floor prompts a symptom check-in and a buddy check; T2 also alerts the first aider. Never T3, never 998 (§4.3).
 * - Unavailable (not consented, medication, no/poor signal, warm-up) → available = false at 'safe': it cannot raise
 *   or lower anything and is never reassurance.
 * - A > 200 bpm reading with good contact for 2 consecutive minutes prompts a check-in and a buddy check (§4.3 item 3).
 * Levels via TIER_TO_LEVEL.
 */
export function physiologyLevel(input: PhysiologyInput): PhysiologyChannelResult {
  const status = physioChannelStatus(input)
  const drivers: RiskDriver[] = []
  const actions = new Set<ActionId>()
  const drv = (
    id: string,
    text: string,
    direction: RiskDriver['direction'],
    basis: string,
    value?: number,
    unit?: string,
  ): void => {
    const d: RiskDriver = { id, channel: 'physiology', text, direction, basis }
    if (value !== undefined) d.value = value
    if (unit !== undefined) d.unit = unit
    drivers.push(d)
  }

  const inWindow = windowMinutes(input.minutes, input.t, PHYSIO_CHANNEL.WINDOW_MIN)
  const latest = inWindow[inWindow.length - 1] as PhysioMinute | undefined
  if (input.consented) {
    const lastTwo = inWindow.slice(-PHYSIO_CHANNEL.IMPLAUSIBLE_HR_MIN)
    const consecutive =
      lastTwo.length === PHYSIO_CHANNEL.IMPLAUSIBLE_HR_MIN &&
      minuteKey(lastTwo[1].t) - minuteKey(lastTwo[0].t) === 1 &&
      minuteKey(input.t) - minuteKey(lastTwo[1].t) <= 1
    if (consecutive && lastTwo.every((m) => m.implausibleHighHr === true)) {
      drv(
        'hr_implausible_high',
        'Heart-rate reading above 200 bpm for 2 min with good contact - not used for the estimate; check on the worker',
        'info',
        'physio_and_clinical.md §4.3 item 3 [ENG]',
      )
      actions.add('symptom_checkin')
      actions.add('buddy_check')
    }
  }

  if (!status.channelValid) {
    const reason = status.reason ?? 'no_signal'
    drv(`physio_unavailable_${reason}`, UNAVAILABLE_TEXT[reason], 'info', FAILSAFE_BASIS)
    if (reason === 'signal_unusable' || reason === 'no_signal') actions.add('check_sensor')
    return { channel: 'physiology', level: 'safe', available: false, drivers, tier: 0, actions: [...actions], status, display: null }
  }

  const recent = inWindow.filter((m) => m.valid).slice(-PHYSIO_CHANNEL.SUSTAIN_MIN)
  const sustained = (pred: (m: PhysioMinute) => boolean): boolean =>
    recent.length >= PHYSIO_CHANNEL.SUSTAIN_MIN && recent.every(pred)
  const last = recent[recent.length - 1]
  let tier = 0 as ClinicalTier // widened: raised inside the closure below
  const raise = (t: ClinicalTier): void => {
    if (t > tier) tier = t
  }
  const ctAtLeast = (thr: number) => (m: PhysioMinute) => m.ctC !== null && m.ctC >= thr
  const psiAbove = (thr: number) => (m: PhysioMinute) => m.psi !== null && m.psi > thr
  const ctNow = last?.ctC ?? undefined
  const psiNow = last?.psi ?? undefined

  const f = PHYSIO_FLOORS
  const t1C = input.conservativeMode ? f.ECTEMP_T1_CONSERVATIVE_C : f.ECTEMP_T1_C
  if (sustained(ctAtLeast(f.ECTEMP_T2_C))) {
    raise(2)
    drv(
      'ectemp_ge_39_0',
      'Estimated core temperature (ECTemp) at or above 39.0 °C for 5 valid minutes',
      'raises',
      'Hunt et al. 2019 Mil Med Res 6:20 and de Korte et al. 2022 (ECTemp under-reads at high core temperature); NIOSH 2016 hyperthermia classes; physio_and_clinical.md §10.5 [ENG]',
      ctNow,
      '°C',
    )
  } else if (sustained(ctAtLeast(t1C))) {
    raise(1)
    if (input.conservativeMode) {
      drv(
        'ectemp_ge_38_0_conservative',
        'ECTemp at or above 38.0 °C for 5 valid minutes (conservative mode)',
        'raises',
        'WHO/NIOSH 2016 38 °C core-temperature limit; conservative mode physio_and_clinical.md §10.9 [ENG]',
        ctNow,
        '°C',
      )
    } else {
      drv(
        'ectemp_ge_38_4',
        'ECTemp at or above 38.4 °C for 5 valid minutes',
        'raises',
        'Hunt et al. 2019 Mil Med Res 6:20 (38.4 °C limit); physio_and_clinical.md §10.5 [ENG]',
        ctNow,
        '°C',
      )
    }
  } else if (sustained(ctAtLeast(f.ECTEMP_ADVISORY_C))) {
    drv(
      'ectemp_ge_38_0_advisory',
      'ECTemp at or above 38.0 °C for 5 valid minutes - check-in prompted',
      'info',
      'WHO/NIOSH 2016 38 °C core-temperature limit (advisory); physio_and_clinical.md §10.5',
      ctNow,
      '°C',
    )
    actions.add('symptom_checkin')
  }

  if (sustained(psiAbove(f.PSI_T2))) {
    raise(2)
    drv('psi_very_high', 'Physiological Strain Index above 8 (very high) for 5 valid minutes', 'raises', 'Moran et al. 1998 Am J Physiol 275:R129 PSI bands; physio_and_clinical.md §10.5', psiNow)
  } else if (sustained(psiAbove(f.PSI_T1))) {
    raise(1)
    drv('psi_high', 'Physiological Strain Index above 6 (high) for 5 valid minutes', 'raises', 'Moran et al. 1998 Am J Physiol 275:R129 PSI bands; physio_and_clinical.md §10.5', psiNow)
  } else if (sustained(psiAbove(f.PSI_ADVISORY))) {
    drv(
      'psi_moderate_advisory',
      'Physiological Strain Index above 4 (moderate) for 5 valid minutes - check-in prompted',
      'info',
      'Moran et al. 1998 Am J Physiol 275:R129 PSI bands (advisory); physio_and_clinical.md §10.5',
      psiNow,
    )
    actions.add('symptom_checkin')
  }

  const ageKnown = isNum(input.ageYears)
  const age = ageKnown ? (input.ageYears as number) : f.UNKNOWN_AGE_YEARS
  const hrLimit = f.HR_LIMIT_BASE_BPM - age
  if (!ageKnown) {
    drv(
      'hr_limit_age_unknown',
      `Age unknown - heart-rate limit evaluated at ${hrLimit} bpm (age ${f.UNKNOWN_AGE_YEARS})`,
      'info',
      'NIOSH 2016 (180 − age; age-50 medical-evaluation boundary) [ENG, protective default]',
      hrLimit,
      'bpm',
    )
  }
  if (sustained((m) => m.hrBpm !== null && m.hrBpm > hrLimit)) {
    raise(1)
    drv(
      'hr_over_180_minus_age',
      `Heart rate above ${hrLimit} bpm (180 minus age) for 5 valid minutes`,
      'raises',
      'NIOSH 2016 Criteria for a Recommended Standard: sustained HR > 180 bpm minus age',
      last?.hrBpm ?? undefined,
      'bpm',
    )
  }

  if (tier >= 2) ACTIONS_T2.forEach((a) => actions.add(a))
  else if (tier === 1) ACTIONS_T1.forEach((a) => actions.add(a))
  if (tier === 0 && !drivers.some((d) => d.direction === 'info' && d.id !== 'hr_limit_age_unknown')) {
    drv('physio_no_warning', 'Body signals: no warning', 'info', 'physio_and_clinical.md §4.3 item 2 [ENG]')
  }
  const display = ectempDisplayBand(latest?.ctC ?? null, { channelValid: true })
  return {
    channel: 'physiology',
    level: TIER_TO_LEVEL[tier],
    available: true,
    drivers,
    tier,
    actions: orderActions(actions),
    status,
    display,
  }
}

const ACTION_ORDER: readonly ActionId[] = [
  'stop_work',
  'rest_shade_now',
  'cool_down',
  'symptom_checkin',
  'buddy_check',
  'first_aider_check',
  'drink_water',
  'no_hot_work_today',
  'check_sensor',
]

function orderActions(actions: ReadonlySet<ActionId>): ActionId[] {
  const rank = (a: ActionId): number => {
    const i = ACTION_ORDER.indexOf(a)
    return i < 0 ? ACTION_ORDER.length : i
  }
  return [...actions].sort((a, b) => rank(a) - rank(b))
}

// ─────────────────────────────── Per-worker monitor (integration helper) ───────────────────────────────

/** Per-worker physiology state for minute-by-minute processing on the device. */
export interface PhysioMonitorState {
  track: EctempTrack
  /** PSI CT0: ECTemp at shift start (physio_and_clinical.md §10.3). */
  ct0C: number
  /** PSI HR0, or null until known. */
  hr0Bpm: number | null
  /** Usable minute HRs collected for the first-5-minutes HR0 fallback. */
  hr0Pending: number[]
  /** The last 15 evaluated minutes, oldest first. */
  minutes: PhysioMinute[]
}

/** One minute of HR input: a {@link MinuteSqi} result, or the equivalent fields from a simulator. */
export interface PhysioMinuteInput {
  hrMeanBpm: number | null
  minuteValid: boolean
  rScale: number
  implausibleHighHr?: boolean
}

/**
 * Starts a shift: ECTemp initialised at `t` (§10.1–10.2), PSI CT0 = the initial estimate, HR0 from a seated pre-work
 * baseline when given ({@link psiHrBaseline}), else from the first 5 usable minutes (§10.3) [ENG][Egbert 2022].
 */
export function physioMonitorInit(
  t: number,
  opts: { ct0C?: number; seatedHr0Bpm?: number | null; model?: EctempModel } = {},
): PhysioMonitorState {
  const track = ectempInit(t, opts.ct0C ?? ECTEMP.CT0_DEFAULT, opts.model ?? 'quadratic')
  return { track, ct0C: track.ctC, hr0Bpm: opts.seatedHr0Bpm ?? null, hr0Pending: [], minutes: [] }
}

/**
 * Processes one minute: ECTemp update with the §10.2 gap rules, the PSI baseline, PSI (Moran 1998) and the rolling
 * 15-min history used by {@link physiologyLevel}. Out-of-order minutes are ignored [ENG].
 */
export function physioMonitorStep(state: PhysioMonitorState, t: number, minute: PhysioMinuteInput): PhysioMonitorState {
  if (minuteKey(t) <= minuteKey(state.track.t)) return state
  const hr = minute.minuteValid && isNum(minute.hrMeanBpm) ? minute.hrMeanBpm : null
  const track = ectempUpdate(state.track, hr, t, hr === null ? Infinity : minute.rScale)
  let hr0Bpm = state.hr0Bpm
  let hr0Pending = state.hr0Pending
  if (hr0Bpm === null && hr !== null) {
    hr0Pending = [...hr0Pending, hr]
    if (hr0Pending.length >= 5) hr0Bpm = mean(hr0Pending.slice(0, 5))
  }
  const psi = hr !== null && hr0Bpm !== null ? psiMoran(track.ctC, hr, state.ct0C, hr0Bpm) : null
  const rec: PhysioMinute = { t, valid: hr !== null, hrBpm: hr, ctC: track.ctC, psi, implausibleHighHr: minute.implausibleHighHr === true }
  const minutes = [...state.minutes, rec].filter((m) => minuteKey(m.t) > minuteKey(t) - PHYSIO_CHANNEL.WINDOW_MIN)
  return { track, ct0C: state.ct0C, hr0Bpm, hr0Pending, minutes }
}
