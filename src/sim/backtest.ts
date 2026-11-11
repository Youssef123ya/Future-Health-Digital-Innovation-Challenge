/**
 * Closed-loop back-test cohort runner (docs/SIMULATION.md §4–§5).
 *
 * Cohort: summer 2025 (Jun–Sep) site-days at the five Abu Dhabi sites, stratified by heat — each site's days are ranked
 * by the shift-mean outdoor WBGT of the ECMWF IFS analysis and split into hot / median / mild terciles, and
 * `daysPerStratum` days are taken from each tercile at evenly spaced ranks (stratified systematic sampling) — with the
 * synthetic crews of data/workforce.ts. Every site-day is run once per policy arm (the four closed-loop policies plus
 * the engine in shadow mode) and once per sensitivity / robustness variant, through sim/worldsim.ts runSiteDay.
 *
 * Integrity: all arms and variants of a site-day share one seed, and the world simulation forks every random stream
 * by seed|date|worker, so policies are compared on common random numbers (a shadow run reproduces ban_only's ground
 * truth exactly). No parameter is tuned here; sweep values are fixed in {@link cohortVariants} before any run. Each
 * run records its seed, its reproducible configuration ({@link simConfigFor} + the variant overrides) and the
 * worldsim stamp (module version + hash of the full configuration).
 *
 * Evidence class: SIMULATED COHORT — projections under stated assumptions (SIMULATION.md §6), never measured outcomes.
 */
import { computeSiteHeat } from '../engine/indices'
import { assessAcclimatization } from '../engine/limits'
import { epochFromLocal } from '../engine/time'
import type { EnvSample, Site } from '../engine/types'
import { getSite, SITE_IDS, type SiteId } from '../data/sites'
import {
  calibrationCounts,
  calibrationTable,
  challengeMeasures,
  detectionSummary,
  DETECTION_TARGETS,
  engineRuns,
  fairnessBreakdown,
  mergeCalibration,
  METRICS_VERSION,
  METRIC_PARAMS,
  pairedComparison,
  policyRates,
  runAlertSummary,
  shiftWindow,
  workerShiftRecords,
  type AggregateOptions,
  type CalibrationCounts,
  type CalibrationRow,
  type ChallengeMeasures,
  type DetectionSummary,
  type Estimate,
  type FairnessCell,
  type PairedComparison,
  type PolicyRates,
  type RateEstimate,
  type RunAlertSummary,
  type WorkerShiftRecord,
} from './metrics'
import type { SimDataLoader } from './simdata'
import { TRUTH_MODEL_VERSION, type DeepPartial, type TruthParams } from './truth'
import { createWorld, DEFAULT_SHIFT, makeSimConfig, runSiteDay, WORLDSIM_VERSION, type CreateWorldOptions } from './worldsim'
import type { DrinkLogging, PolicyId, SimBehaviour, SimConfig, SimData, SimDisruptions } from './types'

/**
 * Version of the cohort design and report schema. 1.2.0 (wave 2d): arms from one table ({@link ARM_TABLE}); variants
 * habitualDrinkFraction 1.0 / 0.4 (the v0.1 / v0.2 drinking floors around the calibrated 0.87) and drink-logging
 * fidelity 50 % / ×1.5; VariantArmSummary.baseVsBanOnly (the base case's paired difference on the variant's site-days);
 * report versions.truth (sim/truth.ts TRUTH_MODEL_VERSION). 1.3.0 (wave 2d, integration): arms zill_monitored (zill_full on
 * the monitored plan basis) and shadow_zill_monitored (its detection without anybody acting on it); headline suppressed
 * advisories (metrics 1.2.0) and supervisor acknowledgements per worker-shift.
 */
export const BACKTEST_VERSION = '1.3.0'

// ─────────────────────────────── Arms ───────────────────────────────

/**
 * Every arm in report order — the one list the arm sets below and the variants derive from, so adding an arm (for
 * example a new Zill policy) is one row here. kind: 'baseline' = a policy without Zill, 'zill' = closed loop acting
 * on Zill, 'shadow' = the engine runs and alerts but nobody acts on it; wearable: the engine receives wearable
 * physiology. SIMULATION.md §4. zill_monitored (wave 2d) = zill_full on a site that opted in to the monitored plan basis
 * (sim/types.ts PolicyId). Its shadow arm is meaningful and kept: monitored mode changes which limits enforce for an
 * eligible worker (the worker's own ISO 7933 projection and physiological strain criteria instead of the WBGT tables),
 * and whether that device still warns before the ground-truth strain events can only be measured where nobody acts on
 * it — acting on an alarm censors the event it predicts (metrics.ts detection) — so shadow_zill_monitored is the
 * detection evidence for monitored mode (the base case only; variants keep their shadow arms).
 */
const ARM_TABLE = [
  { id: 'ban_only', policy: 'ban_only', kind: 'baseline', wearable: false },
  { id: 'site_index', policy: 'site_index', kind: 'baseline', wearable: false },
  { id: 'zill_env', policy: 'zill_env', kind: 'zill', wearable: false },
  { id: 'zill_full', policy: 'zill_full', kind: 'zill', wearable: true },
  { id: 'zill_monitored', policy: 'zill_monitored', kind: 'zill', wearable: true },
  { id: 'shadow_zill_env', policy: 'zill_env', kind: 'shadow', wearable: false },
  { id: 'shadow_zill_full', policy: 'zill_full', kind: 'shadow', wearable: true },
  { id: 'shadow_zill_monitored', policy: 'zill_monitored', kind: 'shadow', wearable: true },
] as const satisfies readonly { id: string; policy: PolicyId; kind: 'baseline' | 'zill' | 'shadow'; wearable: boolean }[]

/** A back-test arm: a policy, acted on (closed loop) or in shadow mode (engine runs, nobody acts on it). */
export type ArmId = (typeof ARM_TABLE)[number]['id']

/** Definition of an arm (SIMULATION.md §4). */
export interface BacktestArm {
  id: ArmId
  policy: PolicyId
  kind: 'baseline' | 'zill' | 'shadow'
  /** kind === 'shadow'. */
  shadow: boolean
  wearable: boolean
}

/** Every arm: the closed-loop policies of SIMULATION.md §4 and shadow mode with and without wearables. */
export const BACKTEST_ARMS: Readonly<Record<ArmId, BacktestArm>> = Object.freeze(
  Object.fromEntries(ARM_TABLE.map((a) => [a.id, Object.freeze({ ...a, shadow: a.kind === 'shadow' })])) as Record<ArmId, BacktestArm>,
)

/** All arms in report order. */
export const ARM_IDS: readonly ArmId[] = Object.freeze(ARM_TABLE.map((a) => a.id))
/** Closed-loop arms (outcome comparison): baselines and Zill arms. */
export const CLOSED_LOOP_ARMS: readonly ArmId[] = Object.freeze(ARM_IDS.filter((a) => BACKTEST_ARMS[a].kind !== 'shadow'))
/** Closed-loop Zill arms (the policies that act on the engine's output). */
export const ZILL_ARMS: readonly ArmId[] = Object.freeze(ARM_IDS.filter((a) => BACKTEST_ARMS[a].kind === 'zill'))
/** Shadow arms (detection metrics; their ground truth equals ban_only's by construction). */
export const SHADOW_ARMS: readonly ArmId[] = Object.freeze(ARM_IDS.filter((a) => BACKTEST_ARMS[a].kind === 'shadow'))

// ─────────────────────────────── Heat stratification ───────────────────────────────

/** Heat terciles of a site's season. */
export type HeatStratum = 'hot' | 'median' | 'mild'
/** Strata in report order. */
export const HEAT_STRATA: readonly HeatStratum[] = ['hot', 'median', 'mild']

/** Heat of one site-day from the IFS analysis over the shift hours. */
export interface DayHeat {
  siteId: SiteId
  date: string
  /** Mean outdoor (sun) WBGT over the hourly samples ending within the shift, °C (engine/indices.ts computeSiteHeat). */
  shiftMeanWbgtC: number
  shiftMaxWbgtC: number
  shiftMinTwlWm2: number
  hours: number
}

/** A selected cohort day. */
export interface CohortDay extends DayHeat {
  stratum: HeatStratum
  /** 1 = the hottest day of the site's season. */
  heatRank: number
  daysRanked: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Every local date 'YYYY-MM-DD' of the given months (1–12) of a year, in order. */
export function seasonDates(year: number, months: readonly number[]): string[] {
  const out: string[] = []
  for (const m of months) {
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate()
    for (let d = 1; d <= days; d++) out.push(`${year}-${pad2(m)}-${pad2(d)}`)
  }
  return out
}

/**
 * Heat of one site-day: computeSiteHeat (engine/indices.ts, site radiant allowance included) on every hourly analysis
 * sample whose hour ends within the shift (start < t ≤ end; Open-Meteo hourly radiation is averaged over the hour
 * ending at t). Null when no sample falls in the shift. Basis: ISO 7243 / Liljegren 2008 outdoor WBGT as the
 * stratifier [ENG]; TWL (Brake & Bates 2002) reported alongside.
 */
export function dayHeatFromAnalysis(site: Site, date: string, analysis: readonly EnvSample[], shift: { start: string; end: string } = DEFAULT_SHIFT): DayHeat | null {
  const startT = epochFromLocal(`${date}T${shift.start}`)
  const endT = epochFromLocal(`${date}T${shift.end}`)
  let n = 0
  let sum = 0
  let max = Number.NEGATIVE_INFINITY
  let minTwl = Number.POSITIVE_INFINITY
  for (const s of analysis) {
    if (!(s.t > startT && s.t <= endT)) continue
    const h = computeSiteHeat(s, site)
    if (!Number.isFinite(h.wbgtC)) continue
    n += 1
    sum += h.wbgtC
    max = Math.max(max, h.wbgtC)
    if (Number.isFinite(h.twlWm2)) minTwl = Math.min(minTwl, h.twlWm2)
  }
  if (n === 0) return null
  const r2 = (x: number): number => Math.round(x * 100) / 100
  return { siteId: site.id, date, shiftMeanWbgtC: r2(sum / n), shiftMaxWbgtC: r2(max), shiftMinTwlWm2: Number.isFinite(minTwl) ? Math.round(minTwl) : 0, hours: n }
}

/**
 * Stratified day selection, per site: days ranked by shift-mean WBGT (hottest first; ties by date), split into terciles
 * at ⌊n/3⌋ and ⌊2n/3⌋ (hot, median, mild), and `perStratum` days taken from each tercile at ranks
 * ⌊(j + ½)·L / perStratum⌋ (evenly spaced, so one day per stratum is the tercile's middle day). Pure and deterministic.
 */
export function selectCohortDays(heats: readonly DayHeat[], perStratum: number): CohortDay[] {
  const bySite = new Map<SiteId, DayHeat[]>()
  for (const h of heats) {
    let a = bySite.get(h.siteId)
    if (!a) bySite.set(h.siteId, (a = []))
    a.push(h)
  }
  const out: CohortDay[] = []
  for (const site of SITE_IDS) {
    const days = bySite.get(site)
    if (!days || days.length === 0) continue
    const ranked = [...days].sort((a, b) => b.shiftMeanWbgtC - a.shiftMeanWbgtC || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const n = ranked.length
    const cuts = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n]
    HEAT_STRATA.forEach((stratum, s) => {
      const lo = cuts[s]
      const len = cuts[s + 1] - lo
      const k = Math.min(perStratum, len)
      const picked = new Set<number>()
      for (let j = 0; j < k; j++) picked.add(lo + Math.floor(((j + 0.5) * len) / k))
      for (const i of [...picked].sort((a, b) => a - b)) out.push({ ...ranked[i], stratum, heatRank: i + 1, daysRanked: n })
    })
  }
  return out
}

/** Tercile cut points of one site (for the report). */
export interface StratumCuts {
  siteId: SiteId
  daysRanked: number
  /** Coolest shift-mean WBGT still in the hot tercile, °C. */
  hotMinC: number
  /** Hottest shift-mean WBGT in the mild tercile, °C. */
  mildMaxC: number
  maxC: number
  minC: number
}

/** Tercile cut points per site from the season's day heats (same ranking as {@link selectCohortDays}). */
export function stratumCuts(heats: readonly DayHeat[]): StratumCuts[] {
  const out: StratumCuts[] = []
  for (const site of SITE_IDS) {
    const v = heats.filter((h) => h.siteId === site).map((h) => h.shiftMeanWbgtC).sort((a, b) => b - a)
    const n = v.length
    if (n < 3) continue
    out.push({ siteId: site, daysRanked: n, hotMinC: v[Math.floor(n / 3) - 1], mildMaxC: v[Math.floor((2 * n) / 3)], maxC: v[0], minC: v[n - 1] })
  }
  return out
}

// ─────────────────────────────── Variants (sensitivity and robustness) ───────────────────────────────

/** One run configuration family: the base case or one sensitivity / robustness setting. */
export interface VariantSpec {
  id: string
  group: 'base' | 'sensitivity' | 'robustness'
  /** Swept factor, e.g. 'compliance'. */
  factor: string
  label: string
  value: number | string
  behaviour?: Partial<Omit<SimBehaviour, 'ackDelayMin' | 'drinkLogging'>> & { drinkLogging?: Partial<DrinkLogging> }
  disruptions?: Partial<SimDisruptions>
  /** Ground-truth parameter overrides (sim/truth.ts withTruthParams); need worldsim support, see {@link truthOverridesApplied}. */
  truthParams?: DeepPartial<TruthParams>
  arms: readonly ArmId[]
  strata: readonly HeatStratum[]
}

/** Network-outage window of the robustness analysis: the hottest hours, spanning the midday break [ENG]. */
export const NETWORK_OUTAGE_WINDOW = Object.freeze({ from: '10:00', to: '16:00' })
/** Forecast age of the stale-forecast robustness case, hours: beyond the 24-h rule (+1 °C WBGT margin, ARCHITECTURE.md §5). */
export const STALE_FORECAST_AGE_H = 30

/**
 * The variants of a cohort, fixed before any run (SIMULATION.md §5). Base values in brackets; all values [ASSUMPTION]
 * except where the SIMULATION.md list fixes them.
 * - Sensitivity: compliance 0.5 / 0.9 [0.7] (SIMULATION.md §5); self-report scale 0.5 / 1.5 [1]; metabolic multiplier
 *   spread σ_ln 0.10 / 0.25 [0.15]; symptom hazard scale 0.5 / 2 [1]; PPG noise ×2 [×1] (SIMULATION.md §5); supervisor
 *   follow-through 0.5 [1] (SimBehaviour.supervisorFollowThrough: the share of supervisor reassignments on a STOP that
 *   are carried out; added in backtest 1.1.0, defined before any run with it) [ASSUMPTION]; added in backtest 1.2.0,
 *   defined before any run with them: the habitual drinking floor 1.0 (the v0.1 floor) and 0.4 (the v0.2 floor)
 *   [0.87, calibrated: truth.DRINK_CALIBRATION] on the closed-loop arms, so the headline dehydration and heat-symptom
 *   deltas can be read next to the floors that bracket the calibration; drink-logging fidelity 50 % of drinks logged
 *   and ×1.5 over-reported volumes [1 / ×1] (SimBehaviour.drinkLogging) on the closed-loop Zill arms, which are the
 *   only arms whose device reads the log.
 * - Robustness: wearable dropout 20 / 50 / 100 % [0 %] (SIMULATION.md §5); environment sensor/feed failure for the
 *   whole shift; stale forecast ({@link STALE_FORECAST_AGE_H} h); network outage ({@link NETWORK_OUTAGE_WINDOW}).
 * Every variant includes `ban_only`, so Zill − ban_only is always paired within the variant. Arm sets derive from
 * {@link ARM_TABLE}: a new Zill arm joins every closed-loop, Zill, data and (if it has a wearable) wearable variant.
 */
export function cohortVariants(spec: Pick<CohortSpec, 'sweepStrata' | 'shift' | 'variants'>): VariantSpec[] {
  const base: VariantSpec = { id: 'base', group: 'base', factor: 'base', label: 'Base case', value: 'default', arms: ARM_IDS, strata: HEAT_STRATA }
  if (spec.variants === 'base') return [base]
  const st = spec.sweepStrata
  const closed = CLOSED_LOOP_ARMS
  const withShadow: ArmId[] = [...CLOSED_LOOP_ARMS, 'shadow_zill_full']
  const wearableArms: ArmId[] = ['ban_only', ...ZILL_ARMS.filter((a) => BACKTEST_ARMS[a].wearable), 'shadow_zill_full']
  const dataArms: ArmId[] = ['ban_only', ...ZILL_ARMS, 'shadow_zill_env']
  const zillLoop: ArmId[] = ['ban_only', ...ZILL_ARMS]
  const sens = (factor: string, label: string, value: number, extra: Partial<VariantSpec>, arms: readonly ArmId[]): VariantSpec => ({ id: `${factor}=${value}`, group: 'sensitivity', factor, label, value, arms, strata: st, ...extra })
  const rob = (factor: string, label: string, value: number | string, disruptions: Partial<SimDisruptions>, arms: readonly ArmId[]): VariantSpec => ({ id: `${factor}=${value}`, group: 'robustness', factor, label, value, disruptions, arms, strata: st })
  return [
    base,
    sens('compliance', 'Compliance 0.5', 0.5, { behaviour: { compliance: 0.5 } }, closed),
    sens('compliance', 'Compliance 0.9', 0.9, { behaviour: { compliance: 0.9 } }, closed),
    sens('selfReportScale', 'Self-report ×0.5', 0.5, { behaviour: { selfReportScale: 0.5 } }, withShadow),
    sens('selfReportScale', 'Self-report ×1.5', 1.5, { behaviour: { selfReportScale: 1.5 } }, withShadow),
    sens('metabolicSigmaLn', 'Metabolic spread σ 0.10', 0.1, { truthParams: { traits: { metabolicSigmaLn: 0.1 } } }, withShadow),
    sens('metabolicSigmaLn', 'Metabolic spread σ 0.25', 0.25, { truthParams: { traits: { metabolicSigmaLn: 0.25 } } }, withShadow),
    sens('hazardScale', 'Symptom hazard ×0.5', 0.5, { truthParams: { symptoms: { hazardScale: 0.5 } } }, withShadow),
    sens('hazardScale', 'Symptom hazard ×2', 2, { truthParams: { symptoms: { hazardScale: 2 } } }, withShadow),
    sens('ppgNoise', 'PPG noise ×2', 2, { disruptions: { ppgNoiseMultiplier: 2 } }, wearableArms),
    sens('supervisorFollowThrough', 'Supervisor follow-through 0.5', 0.5, { behaviour: { supervisorFollowThrough: 0.5 } }, closed),
    sens('habitualDrinkFraction', 'Drinking floor 1.0 (v0.1 floor)', 1, { id: 'habitualDrinkFraction=1.0', truthParams: { behaviour: { habitualDrinkFraction: 1 } } }, closed),
    sens('habitualDrinkFraction', 'Drinking floor 0.4 (v0.2 floor)', 0.4, { truthParams: { behaviour: { habitualDrinkFraction: 0.4 } } }, closed),
    sens('drinkLogging', 'Drink logging 50 % of drinks', 0.5, { id: 'drinkLogging=50%', behaviour: { drinkLogging: { loggedFraction: 0.5 } } }, zillLoop),
    sens('drinkLogging', 'Drink logging ×1.5 (over-reported volumes)', 1.5, { id: 'drinkLogging=x1.5', behaviour: { drinkLogging: { overReportFactor: 1.5 } } }, zillLoop),
    rob('wearableDropout', 'Wearable dropout 20 %', 0.2, { wearableDropout: 0.2 }, wearableArms),
    rob('wearableDropout', 'Wearable dropout 50 %', 0.5, { wearableDropout: 0.5 }, wearableArms),
    rob('wearableDropout', 'Wearable dropout 100 %', 1, { wearableDropout: 1 }, wearableArms),
    rob('sensorFailure', 'Environment sensor/feed failure (whole shift)', 'shift', { envSensorFailure: { from: spec.shift.start, to: spec.shift.end } }, dataArms),
    rob('forecastAgeH', `Stale forecast (${STALE_FORECAST_AGE_H} h old)`, STALE_FORECAST_AGE_H, { forecastAgeH: STALE_FORECAST_AGE_H }, dataArms),
    rob('networkOutage', `Network outage ${NETWORK_OUTAGE_WINDOW.from}–${NETWORK_OUTAGE_WINDOW.to}`, `${NETWORK_OUTAGE_WINDOW.from}-${NETWORK_OUTAGE_WINDOW.to}`, { networkOutage: { ...NETWORK_OUTAGE_WINDOW } }, dataArms),
  ]
}

// ─────────────────────────────── Cohort specification ───────────────────────────────

/** Size presets of the cohort script. */
export type CohortMode = 'quick' | 'medium' | 'full'

/** Everything that defines a cohort run (recorded in the report). */
export interface CohortSpec {
  mode: CohortMode | 'custom'
  /** Seed of every run (common random numbers across arms and variants). */
  seed: string
  /** data/workforce.ts generateWorkforce seed. */
  workforceSeed: string
  year: number
  months: number[]
  sites: SiteId[]
  daysPerStratum: number
  crewsPerSite: number
  includeDemoCrew: boolean
  shift: { start: string; end: string }
  /** Strata on which the sensitivity / robustness variants run. */
  sweepStrata: HeatStratum[]
  replicates: number
  /** Keep per-minute traces in shadow arms for the minutes-to-limit calibration. */
  calibration: boolean
  /** 'all' = base + sensitivity + robustness; 'base' = base case only. */
  variants: 'all' | 'base'
}

const PRESET_BASE: Omit<CohortSpec, 'mode' | 'daysPerStratum' | 'crewsPerSite' | 'sweepStrata'> = {
  seed: 'zill-cohort-2025',
  workforceSeed: 'zill-workforce-v1',
  year: 2025,
  months: [6, 7, 8, 9],
  sites: [...SITE_IDS],
  includeDemoCrew: false,
  shift: { ...DEFAULT_SHIFT },
  replicates: METRIC_PARAMS.bootstrapReplicates,
  calibration: true,
  variants: 'all',
}

/**
 * Size presets: quick (1 day per stratum per site, 1 crew; sweeps on hot days — runs in about a minute), medium
 * (3 days per stratum, 1 crew; sweeps on hot days) and full (6 days per stratum, 2 crews; sweeps on hot and median
 * days). Sizes are [ENG] trade-offs between run time and precision; they do not change any model parameter.
 */
export const COHORT_PRESETS: Readonly<Record<CohortMode, CohortSpec>> = Object.freeze({
  quick: { ...PRESET_BASE, mode: 'quick', daysPerStratum: 1, crewsPerSite: 1, sweepStrata: ['hot'] },
  medium: { ...PRESET_BASE, mode: 'medium', daysPerStratum: 3, crewsPerSite: 1, sweepStrata: ['hot'] },
  full: { ...PRESET_BASE, mode: 'full', daysPerStratum: 6, crewsPerSite: 2, sweepStrata: ['hot', 'median'] },
})

/** A preset, optionally overridden (the result's mode becomes 'custom' when overrides change its size or design). */
export function cohortSpec(mode: CohortMode, overrides: Partial<Omit<CohortSpec, 'mode'>> = {}): CohortSpec {
  const base = COHORT_PRESETS[mode]
  const merged: CohortSpec = { ...base, ...overrides, mode: base.mode }
  const changed = (Object.keys(overrides) as (keyof Omit<CohortSpec, 'mode'>)[]).some((k) => JSON.stringify(overrides[k]) !== JSON.stringify(base[k]))
  return { ...merged, mode: changed ? 'custom' : base.mode, months: [...merged.months], sites: [...merged.sites], sweepStrata: [...merged.sweepStrata], shift: { ...merged.shift } }
}

// ─────────────────────────────── Running ───────────────────────────────

/** The reproducible record of one runSiteDay call. */
export interface RunRecord {
  variant: string
  arm: ArmId
  siteId: SiteId
  date: string
  stratum: HeatStratum
  seed: string
  /** worldsim stamp: module version + hash of the full SimConfig (and script). */
  stamp: string
  workers: number
  /** CPU time of the run (console only; never written to the report, which stays deterministic). */
  timingMs: number
}

/** What is kept of one run (events and traces are reduced immediately and dropped). */
export interface ArmRunOutput {
  run: RunRecord
  records: WorkerShiftRecord[]
  alerts: RunAlertSummary
  calibration: CalibrationCounts | null
}

/**
 * The exact SimConfig of one run: worldsim makeSimConfig defaults + the cohort seed, site, date, shift, the arm's policy
 * and shadow flag, the variant's behaviour and disruption overrides, and trace 'full' only for shadow arms when the
 * calibration is on (the per-minute trace is needed for minutes-to-limit calibration).
 */
export function simConfigFor(spec: CohortSpec, day: Pick<CohortDay, 'siteId' | 'date'>, variant: VariantSpec, arm: ArmId): SimConfig {
  const a = BACKTEST_ARMS[arm]
  return makeSimConfig({
    seed: spec.seed,
    siteId: day.siteId,
    date: day.date,
    policy: a.policy,
    shadow: a.shadow,
    shift: { ...spec.shift },
    trace: spec.calibration && a.shadow ? 'full' : 'none',
    ...(variant.behaviour ? { behaviour: { ...variant.behaviour } } : {}),
    ...(variant.disruptions ? { disruptions: { ...variant.disruptions } } : {}),
  })
}

type WorldOptionsWithTruth = CreateWorldOptions & { truthParams?: DeepPartial<TruthParams> }

function leavesMatch(over: unknown, actual: unknown): boolean {
  if (over && typeof over === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(over as Record<string, unknown>).every(([k, v]) => leavesMatch(v, (actual as Record<string, unknown>)[k]))
  }
  return over === actual
}

/**
 * Whether the world simulation applies ground-truth parameter overrides passed as `truthParams` in its options: a world
 * is created (not stepped) and its `truthParams` compared leaf by leaf. sim/worldsim.ts ≥ 1.1.0 deep-merges
 * `CreateWorldOptions.truthParams`, so the metabolic-spread and symptom-hazard sweeps run; a world that silently ignored
 * them (worldsim 1.0.0) would mark the variant as not supported (see the report's variant notes).
 */
export function truthOverridesApplied(spec: CohortSpec, data: SimData, date: string, overrides: DeepPartial<TruthParams>): boolean {
  const config = simConfigFor(spec, { siteId: data.site.id, date }, { id: 'probe', group: 'base', factor: 'base', label: 'probe', value: 'probe', arms: ['ban_only'], strata: HEAT_STRATA }, 'ban_only')
  const opts: WorldOptionsWithTruth = { truthParams: overrides }
  const world = createWorld(config, data, opts)
  return leavesMatch(overrides, world.truthParams)
}

/**
 * Run one arm of one variant on one site-day and reduce it at once: worker-shift records (metrics.ts
 * workerShiftRecords, with the crews' task lists and the ADOSH-unacclimatised set), the alert summary and, for
 * engine runs with a per-minute trace, the calibration counts.
 */
export function runArm(spec: CohortSpec, data: SimData, day: CohortDay, variant: VariantSpec, arm: ArmId, adoshUnacclimatized: ReadonlySet<string>): ArmRunOutput {
  const config = simConfigFor(spec, day, variant, arm)
  const opts: WorldOptionsWithTruth = variant.truthParams ? { truthParams: variant.truthParams } : {}
  const result = runSiteDay(config, data, opts)
  return {
    run: { variant: variant.id, arm, siteId: day.siteId, date: day.date, stratum: day.stratum, seed: config.seed, stamp: result.stamp, workers: result.outcomes.length, timingMs: result.timingMs },
    records: workerShiftRecords(result, { crews: data.crews, adoshUnacclimatized }),
    alerts: runAlertSummary(result, METRIC_PARAMS.alarmMinLevel, { crews: data.crews }),
    calibration: result.minutes && engineRuns(config) ? calibrationCounts(result.minutes, shiftWindow(config).endT) : null,
  }
}

/** Whether a variant ran, and why not. */
export interface VariantStatus {
  spec: VariantSpec
  supported: boolean
  note: string | null
  runs: number
}

/** Everything a back-test produced (in memory; {@link summariseBacktest} turns it into the JSON report). */
export interface BacktestResult {
  spec: CohortSpec
  /** Heat of every season day that had weather (the stratification frame). */
  dayHeats: DayHeat[]
  days: CohortDay[]
  variants: VariantStatus[]
  outputs: ArmRunOutput[]
}

/** Options of {@link runBacktest}. */
export interface BacktestOptions {
  /** Default {@link cohortVariants}(spec). */
  variants?: VariantSpec[]
  /** Use these days instead of stratifying the season (tests). */
  days?: CohortDay[]
  onProgress?: (message: string) => void
}

/**
 * Run a cohort: stratify the season (unless `days` is given), load each site-day (SimDataLoader.load with the cohort's
 * workforce options), and run every variant × arm on the days of the variant's strata. Deterministic for a given spec,
 * loader data and code. Variants whose ground-truth overrides the world simulation does not apply are skipped and
 * reported, never run with silently ignored parameters.
 */
export async function runBacktest(spec: CohortSpec, loader: SimDataLoader, opts: BacktestOptions = {}): Promise<BacktestResult> {
  const progress = opts.onProgress ?? (() => undefined)
  const dayHeats: DayHeat[] = []
  let days = opts.days
  if (!days) {
    for (const siteId of spec.sites) {
      const site = getSite(siteId)
      for (const date of seasonDates(spec.year, spec.months)) {
        let analysis: EnvSample[]
        try {
          analysis = (await loader.weather(siteId, date)).analysis
        } catch {
          continue
        }
        const h = dayHeatFromAnalysis(site, date, analysis, spec.shift)
        if (h) dayHeats.push(h)
      }
    }
    days = selectCohortDays(dayHeats, spec.daysPerStratum)
    progress(`stratified ${dayHeats.length} site-days → ${days.length} cohort days`)
  }
  const variants = opts.variants ?? cohortVariants(spec)
  const status = new Map<string, VariantStatus>(variants.map((v) => [v.id, { spec: v, supported: true, note: null, runs: 0 }]))
  const checked = new Set<string>()
  const outputs: ArmRunOutput[] = []
  for (const day of days) {
    const data = await loader.load(day.siteId, day.date, { workforceSeed: spec.workforceSeed, crewsPerSite: spec.crewsPerSite, includeDemoCrew: spec.includeDemoCrew })
    const adosh = new Set(data.workers.filter((w) => assessAcclimatization(w).adoshUnacclimatized).map((w) => w.id))
    for (const v of variants) {
      if (!v.strata.includes(day.stratum)) continue
      const st = status.get(v.id) as VariantStatus
      if (v.truthParams && !checked.has(v.id)) {
        checked.add(v.id)
        if (!truthOverridesApplied(spec, data, day.date, v.truthParams)) {
          st.supported = false
          st.note = 'Not run: sim/worldsim.ts does not forward ground-truth parameter overrides (CreateWorldOptions.truthParams); the sweep runs automatically once it does.'
        }
      }
      if (!st.supported) continue
      for (const arm of v.arms) {
        outputs.push(runArm(spec, data, day, v, arm, adosh))
        st.runs += 1
      }
    }
    progress(`${day.siteId} ${day.date} (${day.stratum}) done — ${outputs.length} runs`)
  }
  return { spec, dayHeats, days, variants: [...status.values()], outputs }
}

// ─────────────────────────────── Report ───────────────────────────────

/** Detection headline for one target (individual alarms at ≥ high, metrics 1.1.0). */
export interface DetectionHeadline {
  positives: number
  sensitivityBeforeOnset: Estimate
  ppvShift: Estimate
  falseAlarmsPerShift: Estimate
  medianLeadMin: number | null
}

/** Compact per-arm metrics used for strata and variants. */
export interface Headline {
  workerShifts: number
  excessivePer1000: RateEstimate
  severePer1000: RateEstimate
  criticalPer1000: RateEstimate
  dehydrationPer1000: RateEstimate
  symptomaticEpisodesPer1000: RateEstimate
  evacuationsPer1000: RateEstimate
  workMinPerShift: Estimate
  restMinPerShift: Estimate
  waterMlPerShift: Estimate
  adherence: Estimate
  /** Every alarm covering the worker (any basis, crew alerts included), per worker-shift (metrics 1.0.0 definition). */
  alarmsPerShift: Estimate
  /** Individual alarms at ≥ high and ≥ stop per worker-shift (the headline alarm burden), and exposure advisories. */
  individualAlarmsPerShift: Estimate
  individualStopAlarmsPerShift: Estimate
  exposureAdvisoriesPerShift: Estimate
  /** Exposure advisories logged under designed suppression and never notified, per worker-shift (metrics 1.2.0). */
  suppressedAdvisoriesPerShift: Estimate
  /** Supervisor notifications that require an acknowledgement, per worker-shift (both bases; metrics.ts burdenPerWorkerShift). */
  supervisorAcksPerShift: number
  /** Shadow arms only: detection by individual alarms at ≥ high. */
  detection: { excessive: DetectionHeadline; severe: DetectionHeadline } | null
}

/** Paired differences reported for strata and variants. */
export type PairedHeadline = Pick<
  PairedComparison,
  'pairedWorkerShifts' | 'excessivePer1000' | 'severePer1000' | 'dehydrationPer1000' | 'symptomaticEpisodesPer1000' | 'workMinPerShift' | 'workRelative' | 'restMinPerShift'
>

/** Full summary of one arm of the base case. */
export interface ArmSummary {
  arm: ArmId
  policy: PolicyId
  shadow: boolean
  rates: PolicyRates
  challenge: ChallengeMeasures
  /** This arm − ban_only on the same worker-shifts (a shadow arm must show zero: it reproduces ban_only's truth). */
  vsBanOnly: PairedComparison | null
  /** Shadow arms: detection per target by INDIVIDUAL alarms at ≥ high (the headline). */
  detection: DetectionSummary[] | null
  /** Shadow arms: detection per target by individual alarms at ≥ stop. */
  detectionStop: DetectionSummary[] | null
  /** Shadow arms: detection per target by every alarm at ≥ high (metrics 1.0.0 definition, for comparison). */
  detectionAllAlarms: DetectionSummary[] | null
  /** Shadow arms with traces: calibration of minutes-to-limit. */
  calibration: CalibrationRow[] | null
}

/** One arm of a sensitivity / robustness variant. */
export interface VariantArmSummary {
  arm: ArmId
  headline: Headline
  /** This arm − ban_only of the same variant (paired). */
  vsBanOnly: PairedHeadline | null
  /** This arm − the same arm of the base case on the same site-days (paired; isolates the variant's effect). */
  vsBase: PairedHeadline | null
  /**
   * The base case's arm − base ban_only on the variant's site-days (paired; backtest ≥ 1.2.0): the base headline delta
   * to read `vsBanOnly` against, on exactly the same worker-shifts (variants run on the sweep strata only).
   */
  baseVsBanOnly: PairedHeadline | null
}

/** One sensitivity / robustness variant. */
export interface VariantSummary {
  id: string
  group: 'sensitivity' | 'robustness'
  factor: string
  label: string
  value: number | string
  supported: boolean
  note: string | null
  siteDays: number
  arms: VariantArmSummary[]
}

/** Variant definition as recorded in the report (enough to rebuild every run's SimConfig with {@link simConfigFor}). */
export interface VariantReportEntry {
  id: string
  group: VariantSpec['group']
  factor: string
  label: string
  value: number | string
  overrides: { behaviour?: VariantSpec['behaviour']; disruptions?: VariantSpec['disruptions']; truthParams?: VariantSpec['truthParams'] }
  arms: readonly ArmId[]
  strata: readonly HeatStratum[]
  supported: boolean
  note: string | null
  runs: number
}

/** The simulated-cohort report written to public/data/validation/cohort.json (plus the script's stamp/provenance). */
export interface CohortReport {
  kind: 'zill.validation.cohort/v1'
  evidenceClass: 'simulated_cohort'
  disclaimer: string
  /** Module versions; `truth` (sim/truth.ts TRUTH_MODEL_VERSION, the ground-truth defaults) since backtest 1.2.0. */
  versions: { backtest: string; metrics: string; worldsim: string; truth: string }
  spec: CohortSpec
  /** Metric parameters in force (metrics.ts METRIC_PARAMS). */
  metricParams: typeof METRIC_PARAMS
  strata: StratumCuts[]
  days: CohortDay[]
  arms: ArmId[]
  variants: VariantReportEntry[]
  /** One row per runSiteDay call; `variant`, `arm`, `day` index the arrays above. */
  runs: { columns: ['variant', 'arm', 'day', 'seed', 'stamp', 'workers']; rows: [number, number, number, string, string, number][] }
  main: {
    arms: ArmSummary[]
    byStratum: { stratum: HeatStratum; siteDays: number; arms: { arm: ArmId; headline: Headline; vsBanOnly: PairedHeadline | null }[] }[]
    fairness: { arm: ArmId; cells: FairnessCell[] }[]
  }
  sensitivity: VariantSummary[]
  robustness: VariantSummary[]
}

/** Disclaimer carried by every cohort report (SIMULATION.md §6; ARCHITECTURE.md §1.7–1.8). */
export const COHORT_DISCLAIMER =
  'Simulated cohort: projections from a virtual workforce on real 2025 weather under stated behavioural and physiological assumptions (docs/SIMULATION.md). They are not measured health outcomes, do not show that Zill reduces real heat illness (only a prospective pilot can, docs/PILOT.md), and the ground-truth model is itself a simplification.'

const pickPaired = (p: PairedComparison): PairedHeadline => ({
  pairedWorkerShifts: p.pairedWorkerShifts,
  excessivePer1000: p.excessivePer1000,
  severePer1000: p.severePer1000,
  dehydrationPer1000: p.dehydrationPer1000,
  symptomaticEpisodesPer1000: p.symptomaticEpisodesPer1000,
  workMinPerShift: p.workMinPerShift,
  workRelative: p.workRelative,
  restMinPerShift: p.restMinPerShift,
})

function detectionHeadline(records: readonly WorkerShiftRecord[], target: 'excessive_strain' | 'severe_strain', o: AggregateOptions): DetectionHeadline {
  const d = detectionSummary(records, target, o)
  return { positives: d.positives, sensitivityBeforeOnset: d.sensitivityBeforeOnset, ppvShift: d.ppvShift, falseAlarmsPerShift: d.falseAlarmsPerShift, medianLeadMin: d.leadTime.medianMin }
}

/** {@link Headline} of one arm's records (shadow arms also get detection for excessive and severe strain). */
export function headline(records: readonly WorkerShiftRecord[], runs: readonly RunAlertSummary[], arm: ArmId, o: AggregateOptions): Headline {
  const r = policyRates(records, o)
  const c = challengeMeasures(records, runs, o)
  return {
    workerShifts: r.workerShifts,
    excessivePer1000: r.per1000.excessive,
    severePer1000: r.per1000.severe,
    criticalPer1000: r.per1000.critical,
    dehydrationPer1000: r.per1000.dehydration,
    symptomaticEpisodesPer1000: r.per1000.symptomaticEpisodes,
    evacuationsPer1000: r.per1000.evacuations,
    workMinPerShift: r.perShift.workMin,
    restMinPerShift: r.perShift.restMin,
    waterMlPerShift: r.perShift.waterMl,
    adherence: c.adherence,
    alarmsPerShift: c.alarmsPerShift,
    individualAlarmsPerShift: c.individualAlarmsPerShift.high,
    individualStopAlarmsPerShift: c.individualAlarmsPerShift.stop,
    exposureAdvisoriesPerShift: c.exposureAdvisoriesPerWorkerShift,
    suppressedAdvisoriesPerShift: c.suppressedAdvisoriesPerWorkerShift,
    supervisorAcksPerShift: c.burdenPerWorkerShift.total.supervisor?.requiringAck ?? 0,
    detection: BACKTEST_ARMS[arm].shadow ? { excessive: detectionHeadline(records, 'excessive_strain', o), severe: detectionHeadline(records, 'severe_strain', o) } : null,
  }
}

interface Bucket {
  records: WorkerShiftRecord[]
  alerts: RunAlertSummary[]
  calibration: CalibrationCounts | null
  clusters: Set<string>
}

function bucketize(outputs: readonly ArmRunOutput[], filter: (o: ArmRunOutput) => boolean = () => true): Map<string, Bucket> {
  const m = new Map<string, Bucket>()
  for (const o of outputs) {
    if (!filter(o)) continue
    const key = `${o.run.variant}|${o.run.arm}`
    let b = m.get(key)
    if (!b) m.set(key, (b = { records: [], alerts: [], calibration: null, clusters: new Set() }))
    for (const r of o.records) b.records.push(r)
    b.alerts.push(o.alerts)
    b.clusters.add(`${o.run.siteId}|${o.run.date}`)
    if (o.calibration) b.calibration = b.calibration ? mergeCalibration(b.calibration, o.calibration) : o.calibration
  }
  return m
}

/**
 * Turn a {@link BacktestResult} into the deterministic, JSON-serialisable {@link CohortReport}: base-case arm summaries
 * (rates, challenge measures, paired differences vs ban_only, shadow detection and calibration), the same headline per
 * heat stratum, fairness cells per arm, and every sensitivity / robustness variant with its paired differences vs
 * ban_only and vs the base case on the same site-days. Bootstrap seeds derive from the cohort seed and the metric key.
 */
export function summariseBacktest(result: BacktestResult): CohortReport {
  const { spec } = result
  const reps = spec.replicates
  const opt = (key: string): AggregateOptions => ({ seed: `${spec.seed}|boot|${key}`, replicates: reps })
  const all = bucketize(result.outputs)
  const get = (variant: string, arm: ArmId): Bucket | undefined => all.get(`${variant}|${arm}`)

  // Base case.
  const baseBan = get('base', 'ban_only')
  const armSummaries: ArmSummary[] = []
  for (const arm of ARM_IDS) {
    const b = get('base', arm)
    if (!b) continue
    const a = BACKTEST_ARMS[arm]
    const o = opt(`base|${arm}`)
    armSummaries.push({
      arm,
      policy: a.policy,
      shadow: a.shadow,
      rates: policyRates(b.records, o),
      challenge: challengeMeasures(b.records, b.alerts, o),
      vsBanOnly: arm !== 'ban_only' && baseBan ? pairedComparison(b.records, baseBan.records, o) : null,
      detection: a.shadow ? DETECTION_TARGETS.map((t) => detectionSummary(b.records, t, o, 'high')) : null,
      detectionStop: a.shadow ? DETECTION_TARGETS.map((t) => detectionSummary(b.records, t, o, 'stop')) : null,
      detectionAllAlarms: a.shadow ? DETECTION_TARGETS.map((t) => detectionSummary(b.records, t, o, 'high', METRIC_PARAMS.confirmHorizonMin, 'all')) : null,
      calibration: a.shadow && b.calibration ? calibrationTable(b.calibration) : null,
    })
  }

  // By stratum (base case).
  const byStratum = HEAT_STRATA.map((stratum) => {
    const sb = bucketize(result.outputs, (x) => x.run.variant === 'base' && x.run.stratum === stratum)
    const ban = sb.get('base|ban_only')
    const arms = ARM_IDS.flatMap((arm) => {
      const b = sb.get(`base|${arm}`)
      if (!b) return []
      const o = opt(`stratum|${stratum}|${arm}`)
      return [{ arm, headline: headline(b.records, b.alerts, arm, o), vsBanOnly: arm !== 'ban_only' && ban ? pickPaired(pairedComparison(b.records, ban.records, o)) : null }]
    })
    return { stratum, siteDays: result.days.filter((d) => d.stratum === stratum).length, arms }
  })

  // Fairness (base case).
  const fairness = ARM_IDS.flatMap((arm) => {
    const b = get('base', arm)
    return b ? [{ arm, cells: fairnessBreakdown(b.records) }] : []
  })

  // Variants.
  const variantSummaries: VariantSummary[] = []
  for (const vs of result.variants) {
    const v = vs.spec
    if (v.group === 'base') continue
    const ban = get(v.id, 'ban_only')
    const siteDays = new Set<string>()
    const arms: VariantArmSummary[] = []
    for (const arm of v.arms) {
      const b = get(v.id, arm)
      if (!b) continue
      for (const c of b.clusters) siteDays.add(c)
      const o = opt(`${v.id}|${arm}`)
      const baseArm = get('base', arm)
      const baseSame = baseArm ? baseArm.records.filter((r) => b.clusters.has(r.cluster)) : []
      const baseBanSame = baseBan ? baseBan.records.filter((r) => b.clusters.has(r.cluster)) : []
      arms.push({
        arm,
        headline: headline(b.records, b.alerts, arm, o),
        vsBanOnly: arm !== 'ban_only' && ban ? pickPaired(pairedComparison(b.records, ban.records, o)) : null,
        vsBase: baseSame.length > 0 ? pickPaired(pairedComparison(b.records, baseSame, opt(`${v.id}|${arm}|vsBase`))) : null,
        baseVsBanOnly:
          arm !== 'ban_only' && baseSame.length > 0 && baseBanSame.length > 0 ? pickPaired(pairedComparison(baseSame, baseBanSame, opt(`${v.id}|${arm}|baseVsBanOnly`))) : null,
      })
    }
    variantSummaries.push({ id: v.id, group: v.group, factor: v.factor, label: v.label, value: v.value, supported: vs.supported, note: vs.note, siteDays: siteDays.size, arms })
  }

  // Run table.
  const variantIndex = new Map(result.variants.map((v, i) => [v.spec.id, i]))
  const dayIndex = new Map(result.days.map((d, i) => [`${d.siteId}|${d.date}`, i]))
  const rows = result.outputs.map(
    (o) => [variantIndex.get(o.run.variant) ?? -1, ARM_IDS.indexOf(o.run.arm), dayIndex.get(`${o.run.siteId}|${o.run.date}`) ?? -1, o.run.seed, o.run.stamp, o.run.workers] as [number, number, number, string, string, number],
  )

  return {
    kind: 'zill.validation.cohort/v1',
    evidenceClass: 'simulated_cohort',
    disclaimer: COHORT_DISCLAIMER,
    versions: { backtest: BACKTEST_VERSION, metrics: METRICS_VERSION, worldsim: WORLDSIM_VERSION, truth: TRUTH_MODEL_VERSION },
    spec,
    metricParams: METRIC_PARAMS,
    strata: stratumCuts(result.dayHeats),
    days: result.days,
    arms: [...ARM_IDS],
    variants: result.variants.map((vs) => ({
      id: vs.spec.id,
      group: vs.spec.group,
      factor: vs.spec.factor,
      label: vs.spec.label,
      value: vs.spec.value,
      overrides: {
        ...(vs.spec.behaviour ? { behaviour: vs.spec.behaviour } : {}),
        ...(vs.spec.disruptions ? { disruptions: vs.spec.disruptions } : {}),
        ...(vs.spec.truthParams ? { truthParams: vs.spec.truthParams } : {}),
      },
      arms: vs.spec.arms,
      strata: vs.spec.strata,
      supported: vs.supported,
      note: vs.note,
      runs: vs.runs,
    })),
    runs: { columns: ['variant', 'arm', 'day', 'seed', 'stamp', 'workers'], rows },
    main: { arms: armSummaries, byStratum, fairness },
    sensitivity: variantSummaries.filter((v) => v.group === 'sensitivity'),
    robustness: variantSummaries.filter((v) => v.group === 'robustness'),
  }
}
