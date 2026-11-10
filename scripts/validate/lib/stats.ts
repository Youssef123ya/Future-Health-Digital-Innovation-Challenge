/**
 * Verification statistics for the validation scripts: continuous error scores, 2×2 contingency scores, quantiles,
 * rounding, and a day-block bootstrap.
 *
 * Basis: Wilks, *Statistical Methods in the Atmospheric Sciences* (3rd ed. 2011) §8.2 (2×2 verification: POD, FAR,
 * CSI, frequency bias, Peirce and Heidke skill scores) and §8.3 (bias, MAE, RMSE, MSE skill score); Jolliffe &
 * Stephenson, *Forecast Verification* (2nd ed. 2012) ch. 3. Day-block bootstrap: Künsch 1989 (moving/blocked bootstrap
 * for autocorrelated series), as recommended in docs/research/data_and_validation.md §10 B.4.
 */
import { createRng } from '../../../src/sim/rng'

/** Continuous error scores of estimate − reference. */
export interface ContinuousScores {
  n: number
  /** Mean error (estimate − reference). */
  bias: number
  mae: number
  rmse: number
  /** Pearson correlation of estimate and reference; null when undefined (n < 2 or zero variance). */
  r: number | null
  /** Largest |estimate − reference|. */
  maxAbs: number
}

/** Streaming accumulator of {@link ContinuousScores} (single pass, numerically adequate for |values| < 10⁴). */
export class ErrorAccumulator {
  n = 0
  private sumD = 0
  private sumAbs = 0
  private sumSq = 0
  private maxAbs = 0
  private sx = 0
  private sy = 0
  private sxx = 0
  private syy = 0
  private sxy = 0

  /** Add one pair; non-finite pairs are ignored. */
  add(estimate: number, reference: number): void {
    if (!Number.isFinite(estimate) || !Number.isFinite(reference)) return
    const d = estimate - reference
    this.n++
    this.sumD += d
    this.sumAbs += Math.abs(d)
    this.sumSq += d * d
    if (Math.abs(d) > this.maxAbs) this.maxAbs = Math.abs(d)
    this.sx += estimate
    this.sy += reference
    this.sxx += estimate * estimate
    this.syy += reference * reference
    this.sxy += estimate * reference
  }

  /** Mean squared error (NaN when empty). */
  mse(): number {
    return this.n > 0 ? this.sumSq / this.n : Number.NaN
  }

  scores(): ContinuousScores {
    const n = this.n
    if (n === 0) return { n: 0, bias: Number.NaN, mae: Number.NaN, rmse: Number.NaN, r: null, maxAbs: Number.NaN }
    const cov = this.sxy - (this.sx * this.sy) / n
    const vx = this.sxx - (this.sx * this.sx) / n
    const vy = this.syy - (this.sy * this.sy) / n
    const r = n > 1 && vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null
    return { n, bias: this.sumD / n, mae: this.sumAbs / n, rmse: Math.sqrt(this.sumSq / n), r, maxAbs: this.maxAbs }
  }
}

/** 2×2 contingency counts for a yes/no event (forecast vs verifying value). */
export interface Contingency {
  hits: number
  misses: number
  falseAlarms: number
  correctNegatives: number
}

/** Categorical scores of a {@link Contingency}; a score is null when its denominator is zero. */
export interface CategoricalScores extends Contingency {
  n: number
  /** Observed event frequency (H + M) / n. */
  baseRate: number | null
  /** Probability of detection H / (H + M). */
  pod: number | null
  /** False-alarm ratio F / (H + F). */
  far: number | null
  /** Critical success index H / (H + F + M). */
  csi: number | null
  /** Frequency bias (H + F) / (H + M). */
  freqBias: number | null
  /** Peirce skill score POD − POFD (true skill statistic). */
  peirce: number | null
  /** Heidke skill score. */
  heidke: number | null
}

/** Streaming 2×2 contingency table. */
export class ContingencyAccumulator implements Contingency {
  hits = 0
  misses = 0
  falseAlarms = 0
  correctNegatives = 0

  add(forecastEvent: boolean, observedEvent: boolean): void {
    if (forecastEvent && observedEvent) this.hits++
    else if (!forecastEvent && observedEvent) this.misses++
    else if (forecastEvent && !observedEvent) this.falseAlarms++
    else this.correctNegatives++
  }
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/** POD, FAR, CSI, frequency bias, Peirce and Heidke skill scores (Wilks 2011 §8.2). */
export function categoricalScores(c: Contingency): CategoricalScores {
  const { hits: h, misses: m, falseAlarms: f, correctNegatives: cn } = c
  const n = h + m + f + cn
  const pod = ratio(h, h + m)
  const pofd = ratio(f, f + cn)
  const expectedCorrect = n > 0 ? ((h + m) * (h + f) + (cn + m) * (cn + f)) / n : 0
  return {
    hits: h,
    misses: m,
    falseAlarms: f,
    correctNegatives: cn,
    n,
    baseRate: ratio(h + m, n),
    pod,
    far: ratio(f, h + f),
    csi: ratio(h, h + f + m),
    freqBias: ratio(h + f, h + m),
    peirce: pod !== null && pofd !== null ? pod - pofd : null,
    heidke: n - expectedCorrect > 0 ? (h + cn - expectedCorrect) / (n - expectedCorrect) : null,
  }
}

/** MSE skill score 1 − MSE_f / MSE_ref (Wilks 2011 §8.3.2); null when MSE_ref is not positive. */
export function mseSkillScore(mseForecast: number, mseReference: number): number | null {
  return mseReference > 0 && Number.isFinite(mseForecast) ? 1 - mseForecast / mseReference : null
}

/**
 * Quantile of an ascending-sorted sample with linear interpolation between order statistics (Hyndman & Fan 1996
 * type 7, the numpy/R default), p in [0, 1]. NaN for an empty sample.
 */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  const h = (n - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(h)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/** Summary of a set of differences (engine − reference). */
export interface DiffSummary {
  n: number
  maxAbs: number
  meanAbs: number
  /** Signed mean difference. */
  mean: number
  rms: number
}

/** Collects engine − reference differences for the reference-agreement summary. */
export class DiffSet {
  private readonly diffs: number[] = []

  add(engine: number, reference: number): void {
    this.diffs.push(engine - reference)
  }

  /** Add an already-computed difference. */
  addDiff(d: number): void {
    this.diffs.push(d)
  }

  get size(): number {
    return this.diffs.length
  }

  summary(): DiffSummary {
    const n = this.diffs.length
    if (n === 0) return { n: 0, maxAbs: Number.NaN, meanAbs: Number.NaN, mean: Number.NaN, rms: Number.NaN }
    let maxAbs = 0
    let sumAbs = 0
    let sum = 0
    let sumSq = 0
    for (const d of this.diffs) {
      const a = Math.abs(d)
      if (!(a <= maxAbs)) maxAbs = a // NaN propagates as a failure
      sumAbs += a
      sum += d
      sumSq += d * d
    }
    return { n, maxAbs, meanAbs: sumAbs / n, mean: sum / n, rms: Math.sqrt(sumSq / n) }
  }
}

/** Round to a fixed number of decimals (−0 → 0; non-finite values pass through). */
export function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const f = 10 ** digits
  const v = Math.round(x * f) / f
  return v === 0 ? 0 : v
}

/** Round to significant digits (for tiny reference differences such as 4.5e-10). */
export function sig(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x === 0 ? 0 : x
  return Number(x.toPrecision(digits))
}

/** Round a nullable score. */
export function roundOrNull(x: number | null, digits: number): number | null {
  return x === null || !Number.isFinite(x) ? null : roundTo(x, digits)
}

/** Sum of squared errors and count within one block (one site-day). */
export interface SseBlock {
  sse: number
  n: number
}

/**
 * 95 % percentile interval of the RMSE by a day-block bootstrap: whole blocks (site-days) are resampled with
 * replacement, `replicates` times, with the seeded generator of sim/rng.ts (deterministic). Basis: Künsch 1989;
 * data_and_validation.md §10 B.4 (resample whole days, 1,000 replicates, because hourly errors are autocorrelated).
 */
export function bootstrapRmseCi(blocks: readonly SseBlock[], replicates: number, seed: string): [number, number] {
  const k = blocks.length
  if (k === 0 || replicates < 1) return [Number.NaN, Number.NaN]
  const rng = createRng(seed)
  const out = new Float64Array(replicates)
  for (let r = 0; r < replicates; r++) {
    let sse = 0
    let n = 0
    for (let i = 0; i < k; i++) {
      const b = blocks[rng.int(0, k - 1)]
      sse += b.sse
      n += b.n
    }
    out[r] = n > 0 ? Math.sqrt(sse / n) : Number.NaN
  }
  out.sort()
  return [quantileSorted(out, 0.025), quantileSorted(out, 0.975)]
}

/** Continuous scores rounded for JSON (bias/MAE/RMSE/maxAbs to `digits`, r to 3 decimals). */
export interface RoundedScores {
  n: number
  bias: number
  mae: number
  rmse: number
  r: number | null
  maxAbs: number
}

/** Round {@link ContinuousScores} for compact JSON. */
export function roundScores(s: ContinuousScores, digits = 2): RoundedScores {
  return {
    n: s.n,
    bias: roundTo(s.bias, digits),
    mae: roundTo(s.mae, digits),
    rmse: roundTo(s.rmse, digits),
    r: roundOrNull(s.r, 3),
    maxAbs: roundTo(s.maxAbs, digits),
  }
}

/** Round {@link CategoricalScores} for compact JSON (counts unchanged, scores to 3 decimals). */
export function roundCategorical(s: CategoricalScores): CategoricalScores {
  return {
    ...s,
    baseRate: roundOrNull(s.baseRate, 4),
    pod: roundOrNull(s.pod, 3),
    far: roundOrNull(s.far, 3),
    csi: roundOrNull(s.csi, 3),
    freqBias: roundOrNull(s.freqBias, 3),
    peirce: roundOrNull(s.peirce, 3),
    heidke: roundOrNull(s.heidke, 3),
  }
}
