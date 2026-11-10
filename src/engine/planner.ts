/**
 * Forecast-aware work/rest planner — ARCHITECTURE.md §1.1 ("the planner may reschedule work, but it never removes rest
 * that a protective rule requires"), §1.6 (regulatory floor), §5 (environment and regulation channels), §9 (supervisor
 * break and rotation planner, water logistics).
 *
 * For one site-day it takes the hourly heat forecast (WBGT in sun and shade, TWL), the crews with their tasks and
 * members, and the shift, and returns per crew an ordered list of blocks with the work/rest cycle of every hour, the
 * water to provide and notes, plus a comparison with a naive plan (listed order from the shift start, midday ban only).
 *
 * Rules (stricter always wins; nothing here can lower protection below the risk engine's):
 * - binding worker per crew [ENG]: NIOSH RAL if any member is unacclimatised, acclimatising or in conservative mode,
 *   else REL; the worst member clothing adjustment (task PPE overrides the member's clothing, +1 °C for a hood); the
 *   highest member metabolic rate (body-mass scaling). Reasons are never disclosed per worker;
 * - rest term: the site's rest area (Site.restArea) — an air-conditioned cabin at risk.ts COOLED_REST (ADOSH-SF CoP
 *   11.0 v4.0 §3.2(c)) or, where only shade exists, the hourly shade WBGT; an explicit `restAreaWbgtC` overrides it;
 *   a rest area is never taken as hotter than the shade [ENG];
 * - allowed work per hour = min(NIOSH/ACGIH 1-h TWA allowed fraction (limits.allowedWorkFraction), the rule pack's
 *   TWL-zone cycle (regulation.regulatoryFloor; the next-stricter tier in conservative mode via
 *   regulation.stricterWorkRest, shared with risk.ts, ARCHITECTURE §5)), floored to whole 5-min steps; an hour whose
 *   allowance is below the ARCHITECTURE §5 stop band (f < 0.25) gets no work at all, so the plan never schedules work
 *   the risk engine would stop;
 * - fixed tasks first at their earliest start; flexible tasks (heaviest in-sun first) at the start inside their window
 *   (earliestStart/latestEnd ∩ shift) that completes the most work in the fewest crew-minutes, i.e. maximises the
 *   allowed work fraction (ties → earlier);
 * - ISO 7933 screen ({@link PHS_SCREEN}): the planned day is simulated for the crew's reference worker with the risk
 *   engine's own PHS inputs, and each task-hour is cut to the work the engine's projection allows (end-of-bout
 *   projection ≥ 15 min, no limit during the following rest), so following the plan never triggers a projection stop
 *   for that worker at the planned conditions; the schedule is re-placed with the lowered allowances;
 * - outdoor-in-sun work never overlaps the midday break (MoHRE MR 44/2022 via the rule pack);
 * - water per crew-hour from limits.recommendWaterMlPerHour with the pack's zone minimum; ADOSH-unacclimatised members
 *   (TG v4.0 Table 1 note b: new, or > 14 days off, first 7 days back — as in risk.ts) are flagged in hours whose TWL
 *   zone excludes them ("no unacclimatised person to work") with a reassignment hint.
 *
 * Hour conditions: the hourly forecast is interpolated linearly in time; each local hour uses the time-average WBGT
 * (the 1-h TWA basis of NIOSH/ACGIH) and the minimum TWL within the hour (zone thresholds are instantaneous; protective
 * [ENG]). Hours the forecast does not cover take the day's worst values (fail-safe, ARCHITECTURE §1.3).
 */

import type { AcclimatizationStatus, ClothingId, Crew, Site, Task, WorkClass, WorkerProfile } from './types'
import {
  CLOTHING,
  DEFAULT_BODY_MASS_KG,
  DEFAULT_CLOTHING,
  DEFAULT_HEIGHT_CM,
  LIMITS_BASIS,
  REST_METABOLIC_W,
  US_QUART_L,
  allowedWorkFraction,
  assessAcclimatization,
  clothingAdjustmentC,
  exposureLimitC,
  recommendWaterMlPerHour,
  selectExposureLimit,
  taskMetabolicW,
} from './limits'
import type { ExposureLimitId } from './limits'
import { DEFAULT_RULE_PACK, middayBreakWindow, regulatoryFloor, stricterWorkRest, twlWorkCategory, twlZone } from './regulation'
import type { RulePack, RulePackId, TwlZone, TwlZoneId } from './regulation'
import { conservativeMode } from './clinical'
import { COOLED_REST, ENGINE_PHS_OPTIONS, RISK_THRESHOLDS, buildPhsInput, type PhsClimate, type PhsInputs, type WorkerLocation } from './risk'
import { minutesToLimit, phsInitialState, phsStep, type PhsState } from './phs'
import { HOUR_MS, MINUTE_MS, epochFromLocal, hhmmToMinutes, minutesToHhmm } from './time'

// ─────────────────────────────── Constants ───────────────────────────────

/** Planning resolution, minutes [ENG]: fine enough for 45/15 and 20/40 cycles, coarse enough to stay fast. */
export const PLAN_SLOT_MIN = 5

/** Default minimum block length, minutes [ENG]: shorter fragments add transitions and are not used unless they finish a task. */
export const DEFAULT_MIN_BLOCK_MIN = 30

/** Work minutes per hour are floored to this step [ENG, protective: never rounds up; matches the ADOSH 45/15, 20/40 cycles]. */
export const WORK_MIN_GRANULARITY = 5

/**
 * Below this allowed work fraction no work is planned: ARCHITECTURE §5 environment channel "f < 0.25 → stop (heavy
 * outdoor work deferred; light tasks only)" — the same threshold as risk.ts RISK_THRESHOLDS.environment.highMinWorkFraction.
 */
export const STOP_BAND_WORK_FRACTION = 0.25

/** Forecast values are held for at most 60 min beyond the first/last entry [ENG]. */
export const FORECAST_HOLD_MIN = 60

/** Linear interpolation is allowed across gaps of at most 3 h; longer gaps take the day's worst values [ENG, fail-safe]. */
export const FORECAST_MAX_GAP_MIN = 180

/**
 * Water cooler capacity, litres [ENG]: a 5-US-gallon (20 qt = 18.9 L) cooler or bottle, the common site dispenser size.
 * Basis for sizing only; ADOSH-SF CoP 11.0 §3.2(b)(v) requires "potable drinking water close to the worksite".
 */
export const COOLER_CAPACITY_L = 20 * US_QUART_L

/**
 * Coolers are sized to cover the crew's peak demand for 2 h between refills [ENG], aligned with ADOSH-SF CoP 11.0
 * §2(d)(ii) "at least 2 litres every 2–3 hours" (the short end, protective).
 */
export const COOLER_REFILL_INTERVAL_H = 2

/** Default shift-start candidates for {@link suggestShiftStart} (task brief). */
export const SHIFT_START_CANDIDATES: readonly string[] = ['05:00', '06:00', '07:00']

/**
 * {@link suggestShiftStart}: options completing at least (1 − 5 %) of the best option's work are ranked by heat exposure
 * first [ENG] — protection before productivity among plans that get the work done (ARCHITECTURE §1.1).
 */
export const SHIFT_WORK_TIE_TOLERANCE = 0.05

/**
 * ISO 7933 (PHS) screen of the planned day for the crew's reference worker [ENG]: 75 kg / 1.75 m, the task's clothing
 * (else the crew's worst-CAV clothing), acclimatised unless a known member is not, drinking allowed with the ISO 5 %
 * water-loss criterion (no logged intake at plan time). The planned day is simulated block-hour by block-hour from the
 * shift start with the engine's own PHS inputs (risk.ts buildPhsInput, ENGINE_PHS_OPTIONS): in each block-hour the
 * work bout (its planned work, whole minutes, at the task's location) comes first, then rest at the site's rest area
 * (COOLED_REST for a cooled cabin, else shade). Each task-hour keeps the largest W' ≤ W (5-min steps) for which the
 * projection at the task at the end of the bout is ≥ highFromMin (15 min), the resting projection right after it is too,
 * and no limit is reached during the rest that follows until the next planned bout (or the shift end) plus 15 min — so
 * the device never projects < 15 min at rest either; W' below minBoutMin means no work that hour ('phs_not_feasible'). The schedule is then re-placed with
 * the lowered task-hour allowances (at most maxPasses times; allowances only go down) and the last pass's cuts are
 * kept, so following the plan exactly never triggers a projection stop for the reference worker at the planned
 * conditions (plan and monitor agree). Basis: ISO 7933:2023; engine/risk.ts RISK_THRESHOLDS.projection and .resume.
 */
export const PHS_SCREEN = {
  referenceMassKg: DEFAULT_BODY_MASS_KG,
  referenceHeightCm: DEFAULT_HEIGHT_CM,
  highFromMin: RISK_THRESHOLDS.projection.highFromMin,
  minBoutMin: RISK_THRESHOLDS.resume.minBoutMin,
  /** Placement passes with the lowered allowances [ENG]: enough for the cuts to settle in practice; always ends cut-consistent. */
  maxPasses: 4,
  basis:
    'ISO 7933:2023 projection (engine/risk.ts buildPhsInput, ENGINE_PHS_OPTIONS); RISK_THRESHOLDS.projection.highFromMin (stop < 15 min) and RISK_THRESHOLDS.resume.minBoutMin (10 min); [ENG] reference worker 75 kg / 1.75 m, task clothing, least-acclimatised known member, drinking allowed (ISO 5 %), one work bout per block-hour followed by rest in the site rest area',
} as const

const STOP_BAND_BASIS = 'ARCHITECTURE.md §5 environment channel: allowed work fraction < 0.25 → stop (heavy outdoor work deferred)'
const PLANNER_BASIS = 'ARCHITECTURE.md §1.1 (never removes required rest), §5; [ENG] binding-worker and placement rules (engine/planner.ts)'
const EPS = 1e-9

// ─────────────────────────────── Types ───────────────────────────────

/** One forecast hour (e.g. a HeatIndices subset); values are valid at `t` (epoch ms). */
export interface PlannerHour {
  t: number
  /** WBGT in direct sun, °C. */
  wbgtC: number
  /** WBGT of a shaded rest area, °C. */
  wbgtShadeC: number
  /** TWL in the sun, W/m². */
  twlWm2: number
  /** TWL in shade, W/m²; absent → the sun value (protective). */
  twlShadeWm2?: number
  /**
   * Air temperature, RH, human MRT in sun and shade and the 2 m wind at `t` (an indices.ts SiteHeat is assignable),
   * for the ISO 7933 screen ({@link PHS_SCREEN}). Interpolated linearly per minute like the other series. Without it
   * in any hour the screen is not run ('phs_screen_unavailable'); a minute it cannot cover takes the climate of the
   * hottest hour that has one (fail-safe).
   */
  climate?: PhsClimate
}

/** Input of {@link planDay}. */
export interface PlanDayInput {
  /** Local date 'YYYY-MM-DD' (Asia/Dubai). */
  date: string
  site: Site
  crews: Crew[]
  workers: WorkerProfile[]
  /** Forecast for the day, one entry per local hour (more or fewer are interpolated). */
  hourly: PlannerHour[]
  /** Local 'HH:mm' shift window (same day). */
  shift: { start: string; end: string }
  /** Jurisdiction rule pack (default Abu Dhabi). */
  pack?: RulePack
  /** Minimum block length, minutes (default {@link DEFAULT_MIN_BLOCK_MIN}). */
  minBlockMin?: number
  /**
   * WBGT of a cooled rest area, °C, measured or designed (e.g. an air-conditioned cabin: ADOSH-SF CoP 11.0 v4.0 §3.2(c)
   * "cooled and air-conditioned rest areas", §3.2(i) "a cooler area to rest during breaks"). It replaces the shade WBGT
   * as the rest term of the 1-h TWA (NIOSH 2016 §8.1). Default: from `site.restArea` — 'cooled_cabin' → risk.ts
   * COOLED_REST.wbgtC (25 °C [ENG]), 'shade' → the hourly shade WBGT (ARCHITECTURE §5). Never taken as hotter than the
   * hourly shade WBGT (shade is always available) [ENG].
   */
  restAreaWbgtC?: number
}

/** The crew's binding worker (most protective combination of its members) [ENG]. */
export interface CrewBinding {
  limit: ExposureLimitId
  /** Some member is in conservative mode (reasons are not disclosed: ARCHITECTURE §2, supervisors never see risk flags). */
  conservative: boolean
  /** The pack's next-stricter work/rest tier applies (conservative mode, ARCHITECTURE §5). */
  stricterTier: boolean
  /** Members not yet acclimatised (status 'unacclimatized' or 'acclimatizing'): they put the crew on RAL. */
  nonAcclimatizedMemberIds: string[]
  /**
   * Members ADOSH treats as unacclimatised (TG v4.0 Table 1 note b: new, or > 14 days off, during the first 7 days back;
   * limits.assessAcclimatization().adoshUnacclimatized; unknown members included, fail-safe). Only these are excluded
   * from Medium/High-zone work — the same mapping as risk.ts.
   */
  adoshUnacclimatizedMemberIds: string[]
  /** Crew members missing from `workers` (treated as unacclimatised, default size and clothing — fail-safe). */
  unknownMemberIds: string[]
  crewSize: number
  /** Non-identifying explanation for the supervisor. */
  text: string
  basis: string
}

/** Site outlook for one local hour of the shift. */
export interface HourOutlook {
  /** Local 'HH:00'. */
  hour: string
  /** Epoch ms of the hour start. */
  t: number
  /** Hour time-average WBGT in sun / shade, °C. */
  wbgtC: number
  wbgtShadeC: number
  /** Hour minimum TWL in sun / shade, W/m². */
  twlWm2: number
  twlShadeWm2: number
  /** TWL zone in the sun (rule pack). */
  zone: TwlZoneId | null
  zoneLabel: string | null
  shadeZone: TwlZoneId | null
  /** Some part of the hour falls in the midday break. */
  middayBreak: boolean
  /** Allowed work min/h by work class, in the sun, for the strictest crew binding (0 = stop band). */
  allowedWorkMinPerHour: Record<WorkClass, number>
  /** As above, for shaded work. */
  allowedWorkMinPerHourShade: Record<WorkClass, number>
  binding: { limit: ExposureLimitId; clothingAdjustmentC: number; stricterTier: boolean }
  /** The forecast did not cover this hour: the day's worst values were used (fail-safe). */
  forecastFallback: boolean
}

/** Work/rest cycle of a block (per hour). */
export interface RestCycle {
  workMin: number
  restMin: number
  /**
   * Which rule binds: NIOSH/ACGIH TWA, the rule pack's TWL-zone cycle, both equally, the ISO 7933 screen
   * ({@link PHS_SCREEN}), or none (rest block).
   */
  source: 'niosh' | 'rule_pack' | 'both' | 'phs' | 'none'
  text: string
}

/** What set a task-hour's work minutes: no limit (60 min/h), NIOSH/ACGIH TWA, the rule pack's TWL cycle, or the PHS screen. */
export type PlanLimitedBy = 'none' | 'niosh_acgih' | 'rule_pack' | 'phs'

/** The ISO 7933 screen of one task-hour ({@link PHS_SCREEN}). */
export interface PhsTaskHour {
  /** NIOSH/ACGIH and rule-pack allowance, min/h (0 in the stop band). */
  allowedMin: number
  /** The screen's allowance, min/h (null when the task was not screened in that hour: not planned there, or PHS n/a). */
  phsWorkMin: number | null
  /** min(allowedMin, phsWorkMin). */
  workMin: number
  limitedBy: PlanLimitedBy
}

/**
 * Per-hour detail of a block (traceability: unrounded inputs, so every number can be recomputed with
 * limits.allowedWorkFraction and regulation.twlZone).
 */
export interface BlockHour {
  hour: string
  wallMin: number
  workMin: number
  allowedWorkMinPerHour: number
  nioshWorkMinPerHour: number
  packWorkMinPerHour: number
  zone: TwlZoneId | null
  wbgtWorkEffC: number
  wbgtRestEffC: number
  /** TWL at the work location (sun or shade), W/m². */
  twlWm2: number
  /** Start of this block-hour (the block's part of one clock hour), epoch ms. */
  startT: number
  /**
   * Execution layout: whole minutes of work at the start of this block-hour (ceil of workMin), then rest for the rest
   * of wallMin — the layout the PHS screen simulated; following it keeps plan and monitor in agreement.
   */
  boutMin: number
  /** The ISO 7933 screen's allowance for this task-hour, min/h (null when not screened). */
  phsWorkMinPerHour: number | null
  /** What set this hour's work minutes. */
  limitedBy: PlanLimitedBy
}

/** One block of a crew's day. */
export interface PlanBlock {
  /** null = rest in the rest area (cabin or shade) with no task (midday break, deferred work or nothing left). */
  taskId: string | null
  taskName: string | null
  start: string
  end: string
  startT: number
  endT: number
  location: 'sun' | 'shade'
  workMinPerHour: number
  restMinPerHour: number
  rest: RestCycle
  /** Crew work minutes in the block. */
  workMin: number
  /** Rest minutes inside the block (wall − work). */
  restMin: number
  /** Drinking water to provide for the crew in this block, litres. */
  waterL: number
  hours: BlockHour[]
  notes: string[]
  basis: string[]
}

/** One block of the naive comparison plan. */
export interface NaiveBlock {
  taskId: string
  start: string
  end: string
  location: 'sun' | 'shade'
  workMin: number
}

/** A task the plan could not (fully) schedule. */
export interface UnscheduledTask {
  taskId: string
  requiredMin: number
  scheduledMin: number
  reason: 'deferred' | 'incomplete' | 'invalid'
  /** The hour in the task's window with the most allowed work (even if below the stop band), or null. */
  bestHour: string | null
  bestWorkMinPerHour: number
}

/** The plan of one crew. */
export interface CrewPlan {
  crewId: string
  binding: CrewBinding
  blocks: PlanBlock[]
  workMin: number
  restMin: number
  idleMin: number
  waterL: number
  coolersNeeded: number
  /** Σ max(0, WBGT_eff − Limit(M_work)) × work minutes, °C·min. */
  exposureCMin: number
  naive: { blocks: NaiveBlock[]; workMin: number; exposureCMin: number }
  /** Naive work − planned work, crew-minutes (negative = gained). */
  lostWorkMinVsNaive: number
  /** Naive exposure − planned exposure, °C·min. */
  exposureReduction: number
  unscheduled: UnscheduledTask[]
  /** Allowed work min/h for each task and hour (the planner's NIOSH/ACGIH and rule-pack matrix, before the PHS screen). */
  allowance: Array<{ hour: string; byTask: Record<string, number> }>
  /** The ISO 7933 screen per task-hour ({@link PHS_SCREEN}); null when it was not run (no climate in the forecast). */
  phsScreen: {
    reference: { massKg: number; heightCm: number; acclimatized: boolean }
    passes: number
    hours: Array<{ hour: string; byTask: Record<string, PhsTaskHour> }>
  } | null
}

/** Day totals (crew-minutes; litres; °C·min). */
export interface DayPlanTotals {
  workMin: number
  restMin: number
  idleMin: number
  naiveWorkMin: number
  lostWorkMinVsNaive: number
  exposurePlanCMin: number
  exposureNaiveCMin: number
  exposureReduction: number
  waterL: number
  coolersNeeded: number
}

/** Machine-readable warning codes. */
export type PlanWarningCode =
  | 'invalid_shift'
  | 'no_forecast'
  | 'forecast_gap'
  | 'unknown_worker'
  | 'empty_crew'
  | 'invalid_task'
  | 'task_deferred'
  | 'task_incomplete'
  | 'fixed_task_moved'
  | 'unacclimatized_reassign'
  | 'acclimatization_ramp'
  | 'rest_exceeds_limit'
  | 'phs_not_feasible'
  | 'phs_screen_unavailable'

/** A planner warning for the supervisor (non-clinical). */
export interface PlanWarning {
  code: PlanWarningCode
  text: string
  crewId?: string
  taskId?: string
  workerIds?: string[]
  hours?: string[]
}

/** Output of {@link planDay}. */
export interface DayPlan {
  date: string
  siteId: Site['id']
  packId: RulePackId
  shift: { start: string; end: string }
  hours: HourOutlook[]
  crews: CrewPlan[]
  totals: DayPlanTotals
  warnings: PlanWarning[]
  basis: string[]
}

/** One ranked option of {@link suggestShiftStart}. */
export interface ShiftOption {
  rank: number
  start: string
  end: string
  totals: DayPlanTotals
  unscheduledWorkMin: number
  warnings: number
  reason: string
}

// ─────────────────────────────── Internals ───────────────────────────────

interface HourCond {
  hourOfDay: number
  t: number
  wbgtC: number
  wbgtShadeC: number
  twlWm2: number
  twlShadeWm2: number
  fallback: boolean
}

interface Allowance {
  allowedMin: number
  /** min(NIOSH, pack) before the stop band and flooring. */
  rawMin: number
  nioshMin: number
  packMin: number
  source: RestCycle['source']
  restExceedsLimit: boolean
  zone: TwlZone | null
  twlWm2: number
  wbgtWorkEffC: number
  wbgtRestEffC: number
  waterMinLph: number | null
  basis: string[]
}

interface Member {
  id: string
  known: boolean
  status: AcclimatizationStatus
  adoshUnacclimatized: boolean
  conservative: boolean
  massKg?: number
  clothing?: ClothingId
  maxExposureFraction: number
  dayOfRamp: number | null
}

interface TaskCtx {
  task: Task
  index: number
  valid: boolean
  need: number
  workW: number
  cavC: number
  limitC: number
  location: 'sun' | 'shade'
  windowStart: number
  windowEnd: number
  allow: Allowance[]
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WORK_CLASSES: readonly WorkClass[] = ['rest', 'light', 'moderate', 'heavy', 'very_heavy']
const round1 = (x: number): number => Math.round(x * 10) / 10
const round2 = (x: number): number => Math.round(x * 100) / 100
const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`

interface Series {
  t: number
  v: number
}

function makeSeries(hourly: readonly PlannerHour[], get: (h: PlannerHour) => number | undefined): Series[] {
  const out: Series[] = []
  for (const h of hourly) {
    const v = get(h)
    if (Number.isFinite(h.t) && v !== undefined && Number.isFinite(v)) out.push({ t: h.t, v })
  }
  return out.sort((a, b) => a.t - b.t)
}

function valueAt(series: readonly Series[], t: number): number | null {
  if (series.length === 0) return null
  const first = series[0]
  const last = series[series.length - 1]
  if (t <= first.t) return first.t - t <= FORECAST_HOLD_MIN * MINUTE_MS ? first.v : null
  if (t >= last.t) return t - last.t <= FORECAST_HOLD_MIN * MINUTE_MS ? last.v : null
  let lo = 0
  let hi = series.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (series[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = series[lo]
  const b = series[hi]
  if (t === a.t) return a.v
  if (t === b.t) return b.v
  if (b.t - a.t > FORECAST_MAX_GAP_MIN * MINUTE_MS) return null
  return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
}

function buildHourConds(hourly: readonly PlannerHour[], dayStartT: number, firstHour: number, lastHour: number): { hours: HourCond[]; fallbackHours: string[] } | null {
  const sW = makeSeries(hourly, (h) => h.wbgtC)
  const sWS = makeSeries(hourly, (h) => h.wbgtShadeC)
  const sT = makeSeries(hourly, (h) => h.twlWm2)
  const sTS = makeSeries(hourly, (h) => (h.twlShadeWm2 !== undefined && Number.isFinite(h.twlShadeWm2) ? h.twlShadeWm2 : h.twlWm2))
  if (sW.length === 0 || sWS.length === 0 || sT.length === 0 || sTS.length === 0) return null
  const worst = {
    wbgtC: Math.max(...sW.map((p) => p.v)),
    wbgtShadeC: Math.max(...sWS.map((p) => p.v)),
    twlWm2: Math.min(...sT.map((p) => p.v)),
    twlShadeWm2: Math.min(...sTS.map((p) => p.v)),
  }
  const hours: HourCond[] = []
  const fallbackHours: string[] = []
  const steps = 60 / PLAN_SLOT_MIN
  for (let h = firstHour; h <= lastHour; h++) {
    const t0 = dayStartT + h * HOUR_MS
    const pts = Array.from({ length: steps + 1 }, (_, j) => t0 + j * PLAN_SLOT_MIN * MINUTE_MS)
    const read = (s: Series[]): number[] | null => {
      const vs = pts.map((t) => valueAt(s, t))
      return vs.every((v): v is number => v !== null) ? vs : null
    }
    const w = read(sW)
    const ws = read(sWS)
    const tw = read(sT)
    const tws = read(sTS)
    if (!w || !ws || !tw || !tws) {
      hours.push({ hourOfDay: h, t: t0, ...worst, fallback: true })
      fallbackHours.push(hourLabel(h))
      continue
    }
    const avg = (vs: number[]): number => (vs[0] / 2 + vs.slice(1, -1).reduce((a, b) => a + b, 0) + vs[vs.length - 1] / 2) / (vs.length - 1)
    hours.push({ hourOfDay: h, t: t0, wbgtC: avg(w), wbgtShadeC: avg(ws), twlWm2: Math.min(...tw), twlShadeWm2: Math.min(...tws), fallback: false })
  }
  return { hours, fallbackHours }
}

/**
 * The rest-area WBGT setting of a plan (°C, before clothing): an explicit `restAreaWbgtC`, else risk.ts
 * COOLED_REST.wbgtC for a 'cooled_cabin' site, else null (= the hourly shade WBGT). See {@link restWbgtFor}.
 */
function restAreaSetting(input: PlanDayInput): number | null {
  if (input.restAreaWbgtC !== undefined && Number.isFinite(input.restAreaWbgtC)) return input.restAreaWbgtC
  return input.site.restArea === 'cooled_cabin' ? COOLED_REST.wbgtC : null
}

/** Rest WBGT for one hour: the rest-area setting, never hotter than the hour's shade WBGT (shade is always there) [ENG]. */
function restWbgtFor(setting: number | null, hour: HourCond): number {
  return setting === null ? hour.wbgtShadeC : Math.min(setting, hour.wbgtShadeC)
}

function computeAllowance(
  workClass: WorkClass,
  inSun: boolean,
  workW: number,
  cavC: number,
  limit: ExposureLimitId,
  stricterTier: boolean,
  hour: HourCond,
  pack: RulePack,
  restSetting: number | null,
): Allowance {
  const wbgtWork = inSun ? hour.wbgtC : hour.wbgtShadeC
  const wbgtRest = restWbgtFor(restSetting, hour)
  const aw = allowedWorkFraction({ workW, wbgtWorkEffC: wbgtWork + cavC, wbgtRestEffC: wbgtRest + cavC, limit })
  const twl = inSun ? hour.twlWm2 : hour.twlShadeWm2
  // outdoorInSun: false — the midday break is applied per 5-min slot (it covers only part of some hours).
  const floor = regulatoryFloor({ t: hour.t + 30 * MINUTE_MS, twlWm2: twl, outdoorInSun: false, acclimatization: 'acclimatized', workClass, wbgtC: wbgtWork, pack })
  let packMin = floor.workMinPerHour
  if (stricterTier && floor.zone && packMin > 0) packMin = Math.min(packMin, stricterWorkRest(floor.zone, twlWorkCategory(workClass), pack).workMinPerHour)
  const nioshMin = aw.workMinPerHour
  const rawMin = Math.min(nioshMin, packMin)
  const stopBand = rawMin < 60 * STOP_BAND_WORK_FRACTION
  const allowedMin = stopBand ? 0 : Math.floor(rawMin / WORK_MIN_GRANULARITY + EPS) * WORK_MIN_GRANULARITY
  const source: RestCycle['source'] = Math.abs(nioshMin - packMin) < EPS ? 'both' : nioshMin < packMin ? 'niosh' : 'rule_pack'
  const basis = [aw.basis]
  if (floor.zone) basis.push(floor.zone.basis)
  if (stopBand) basis.push(STOP_BAND_BASIS)
  return {
    allowedMin,
    rawMin,
    nioshMin,
    packMin,
    source,
    restExceedsLimit: aw.binding === 'rest_exceeds_limit',
    zone: floor.zone,
    twlWm2: twl,
    wbgtWorkEffC: wbgtWork + cavC,
    wbgtRestEffC: wbgtRest + cavC,
    waterMinLph: floor.waterLph ? floor.waterLph.minLph : null,
    basis,
  }
}

function membersOf(crew: Crew, byId: ReadonlyMap<string, WorkerProfile>): Member[] {
  return crew.workerIds.map((id) => {
    const p = byId.get(id)
    if (!p) {
      return { id, known: false, status: 'unacclimatized' as const, adoshUnacclimatized: true, conservative: false, maxExposureFraction: 1, dayOfRamp: null }
    }
    const acc = assessAcclimatization(p)
    const cons = conservativeMode(p)
    return {
      id,
      known: true,
      status: acc.status,
      adoshUnacclimatized: acc.adoshUnacclimatized,
      conservative: cons.conservative,
      ...(p.massKg !== undefined ? { massKg: p.massKg } : {}),
      clothing: p.clothing,
      maxExposureFraction: acc.maxExposureFraction,
      dayOfRamp: acc.dayOfRamp,
    }
  })
}

function bindingOf(members: readonly Member[]): CrewBinding {
  const ral = members.length === 0 || members.some((m) => selectExposureLimit(m.status, m.conservative) === 'RAL')
  const conservative = members.some((m) => m.conservative)
  const nonAcc = members.filter((m) => m.status !== 'acclimatized').map((m) => m.id)
  const adoshUnacc = members.filter((m) => m.adoshUnacclimatized).map((m) => m.id)
  const unknown = members.filter((m) => !m.known).map((m) => m.id)
  const limit: ExposureLimitId = ral ? 'RAL' : 'REL'
  // Non-identifying: no reason is given (a stricter personal limit can come from a declared health flag).
  const text = ral
    ? `Crew plan uses the stricter exposure limit (NIOSH RAL): ${members.length === 0 ? 'the crew has no known members' : 'at least one member needs a stricter personal limit'}${conservative ? '; the next-stricter work/rest tier applies' : ''}.`
    : 'All members are acclimatised: NIOSH REL applies.'
  return {
    limit,
    conservative,
    stricterTier: conservative,
    nonAcclimatizedMemberIds: nonAcc,
    adoshUnacclimatizedMemberIds: adoshUnacc,
    unknownMemberIds: unknown,
    crewSize: Math.max(1, members.length),
    text,
    basis: `${limit === 'REL' ? LIMITS_BASIS.rel : LIMITS_BASIS.ral}; ${LIMITS_BASIS.acclimatization}; ARCHITECTURE.md §5 conservative mode; ${PLANNER_BASIS}`,
  }
}

const validHhmm = (s: string | undefined): s is string => typeof s === 'string' && HHMM_RE.test(s)

// ─────────────────────────────── ISO 7933 screen (PHS_SCREEN) ───────────────────────────────

const CLIMATE_FIELDS = ['taC', 'rhPct', 'mrtC', 'mrtHumanShadeC', 'wind2Ms'] as const

/**
 * Per-minute PHS climate from the forecast hours (linear interpolation, the same hold and gap rules as the other
 * series); a minute it cannot cover takes the climate of the hottest hour (highest sun WBGT) that has one (fail-safe).
 * Null when no hour carries a complete climate.
 */
function climateAccessor(hourly: readonly PlannerHour[]): ((t: number) => PhsClimate) | null {
  const complete = hourly.filter((h) => h.climate !== undefined && CLIMATE_FIELDS.every((f) => Number.isFinite(h.climate?.[f])) && Number.isFinite(h.t))
  if (complete.length === 0) return null
  const hottest = complete.reduce((a, b) => ((Number.isFinite(b.wbgtC) ? b.wbgtC : -Infinity) > (Number.isFinite(a.wbgtC) ? a.wbgtC : -Infinity) ? b : a))
  const fallback = { ...(hottest.climate as PhsClimate) }
  const series = CLIMATE_FIELDS.map((f) => makeSeries(complete, (h) => h.climate?.[f]))
  return (t: number): PhsClimate => {
    const v = series.map((s) => valueAt(s, t))
    if (v.some((x) => x === null)) return fallback
    const [taC, rhPct, mrtC, mrtHumanShadeC, wind2Ms] = v as number[]
    return { taC, rhPct, mrtC, mrtHumanShadeC, wind2Ms }
  }
}

/** One planned activity of the screen: a task (with its location and clothing) or rest (null). */
interface ScreenSpec {
  task: Task
  location: 'sun' | 'shade'
  clothing: ClothingId
}

interface ScreenArgs {
  N: number
  /** Epoch ms of slot 0. */
  startT: number
  hourOfSlot: (k: number) => number
  /** Mutated: a task-hour cut to 0 min/h is unassigned (rest). */
  slotTask: number[]
  /** Mutated: work minutes per slot after the cut. */
  slotWork: number[]
  /** Mutated: the slot's work rate, min/h, after the cut. */
  slotRate: number[]
  specs: readonly ScreenSpec[]
  climateAt: (t: number) => PhsClimate
  restLocation: WorkerLocation
  restClothing: ClothingId
  acclimatized: boolean
}

interface ScreenOutcome {
  /** Screened allowance, min/h, per task-hour key `${taskIndex}|${hourIndex}` (task-hours with planned work only). */
  phsMin: Map<string, number>
  /** Task-hours whose planned rate was lowered, with the new rate. */
  reduced: Array<{ ti: number; hi: number; capMin: number }>
  /** Task-hours where even minBoutMin min/h failed: no work. */
  notFeasible: Array<{ ti: number; hi: number }>
}

/**
 * Simulates the planned day for the reference worker ({@link PHS_SCREEN}) and cuts each task-hour to the largest
 * W' ≤ W that keeps the end-of-bout projections (at the task and at rest) ≥ 15 min and reaches no limit during the rest
 * that follows until the next planned bout + 15 min.
 * Minute convention as in the engine: the activity at minute T uses the climate at T. The arrays in `a` are mutated.
 */
function screenPlannedDay(a: ScreenArgs): ScreenOutcome {
  const S = PHS_SCREEN
  const out: ScreenOutcome = { phsMin: new Map(), reduced: [], notFeasible: [] }
  const minutes = a.N * PLAN_SLOT_MIN
  const climate: (PhsClimate | undefined)[] = new Array<PhsClimate | undefined>(minutes)
  const cache: (PhsInputs | undefined)[][] = Array.from({ length: a.specs.length + 1 }, () => new Array<PhsInputs | undefined>(minutes))
  const inputAt = (minute: number, si: number): PhsInputs => {
    const m = Math.min(Math.max(0, minute), minutes - 1)
    const row = cache[si + 1]
    const hit = row[m]
    if (hit) return hit
    const c = climate[m] ?? (climate[m] = a.climateAt(a.startT + m * MINUTE_MS))
    const spec = si >= 0 ? a.specs[si] : null
    const v = buildPhsInput({
      climate: c,
      location: spec ? spec.location : a.restLocation,
      task: spec ? spec.task : null,
      clothing: spec ? spec.clothing : a.restClothing,
      massKg: S.referenceMassKg,
      heightCm: S.referenceHeightCm,
      acclimatized: a.acclimatized,
    })
    row[m] = v
    return v
  }
  /** `n` minutes of one activity from minute `m0`, starting from `s` (null = exposure start). */
  const run = (s: PhsState | null, m0: number, n: number, si: number): PhsState => {
    let st = s ?? phsInitialState(inputAt(m0, si).input, ENGINE_PHS_OPTIONS)
    for (let i = 0; i < n; i++) st = phsStep(st, inputAt(m0 + i, si).input, 1, ENGINE_PHS_OPTIONS)
    return st
  }
  const boutOf = (work: number, wall: number): number => Math.min(wall, Math.max(0, Math.ceil(work - 1e-6)))

  /** True when the resting projection from `s` at minute `m` stays ≥ `need` min (no limit within `need` min of rest). */
  const restClear = (s: PhsState, m: number, need: number): boolean => {
    const p = minutesToLimit(s, inputAt(m, -1).input, need, ENGINE_PHS_OPTIONS)
    return p.minutes === null || p.minutes >= need
  }
  /** Minutes from the end of slot k1 to the next slot with planned work (or the shift end). */
  const restAfter = (k1: number): number => {
    let j = k1 + 1
    while (j < a.N && !(a.slotTask[j] >= 0 && a.slotWork[j] > EPS)) j += 1
    return (j - k1 - 1) * PLAN_SLOT_MIN
  }

  let state: PhsState | null = null
  let k = 0
  while (k < a.N) {
    const hi = a.hourOfSlot(k)
    const ti = a.slotTask[k]
    let k1 = k
    while (k1 + 1 < a.N && a.hourOfSlot(k1 + 1) === hi && a.slotTask[k1 + 1] === ti) k1 += 1
    const m0 = k * PLAN_SLOT_MIN
    const wall = (k1 - k + 1) * PLAN_SLOT_MIN
    const W = ti >= 0 ? a.slotRate[k] : 0
    if (ti < 0 || !(W > 0)) {
      state = run(state, m0, wall, -1)
      k = k1 + 1
      continue
    }
    let planned = 0
    for (let j = k; j <= k1; j++) planned += a.slotWork[j]
    if (!inputAt(m0, ti).applicable) {
      // Outside the model's scope (vapour barrier): stepped with the surrogate for continuity, not screened.
      const bout = boutOf(planned, wall)
      state = run(run(state, m0, bout, ti), m0 + bout, wall - bout, -1)
      k = k1 + 1
      continue
    }
    const candidates: number[] = []
    for (let w = W; w >= S.minBoutMin - EPS; w -= WORK_MIN_GRANULARITY) candidates.push(w)
    candidates.push(0)
    // The rest after this segment lasts until the next planned bout (or the shift end): the device projects at rest
    // then, so no limit may come within that rest + 15 min (at the segment-end climate) [ENG, monotone rest].
    const restAhead = Math.min(restAfter(k1), 12 * 60) + S.highFromMin
    let chosen: { wp: number; s: PhsState } | null = null
    for (const wp of candidates) {
      const work = wp >= W ? planned : Math.min(planned, (wp * wall) / 60)
      const bout = boutOf(work, wall)
      let s: PhsState | null = state
      if (bout > 0) {
        s = run(s, m0, bout, ti)
        // End of the bout: the projection at the task (the device's last work minute) and at rest (the first rest minute).
        const p = minutesToLimit(s, inputAt(m0 + bout - 1, ti).input, S.highFromMin, ENGINE_PHS_OPTIONS)
        if (!(p.minutes === null || p.minutes >= S.highFromMin)) continue
        if (bout < wall && !restClear(s, m0 + bout, S.highFromMin)) continue
      }
      const seg = run(s, m0 + bout, wall - bout, -1)
      if (seg.tReLimitMin !== null || seg.waterLoss5PctMin !== null) continue
      if (!restClear(seg, Math.min(m0 + wall, minutes - 1), restAhead)) continue
      chosen = { wp, s: seg }
      break
    }
    if (chosen === null) chosen = { wp: 0, s: run(state, m0, wall, -1) } // even rest reaches a limit this hour
    const key = `${ti}|${hi}`
    out.phsMin.set(key, Math.min(out.phsMin.get(key) ?? Infinity, chosen.wp))
    if (chosen.wp < W) {
      out.reduced.push({ ti, hi, capMin: chosen.wp })
      if (chosen.wp < S.minBoutMin) out.notFeasible.push({ ti, hi })
      const perSlot = (chosen.wp / 60) * PLAN_SLOT_MIN
      for (let j = k; j <= k1; j++) {
        a.slotWork[j] = Math.min(a.slotWork[j], perSlot)
        a.slotRate[j] = chosen.wp
        if (chosen.wp <= 0) {
          a.slotTask[j] = -1
          a.slotWork[j] = 0
        }
      }
    }
    state = chosen.s
    k = k1 + 1
  }
  return out
}

// ─────────────────────────────── planDay ───────────────────────────────

/**
 * Plan one site-day: per crew an ordered list of blocks (task, start, end, location, work/rest cycle per hour, water,
 * notes, basis) that never schedules more work in an hour than the stricter of the NIOSH/ACGIH TWA allowance (rest in
 * the site rest area: air-conditioned cabin or shade) and the rule pack's TWL-zone cycle, never in the stop band, and never outdoors in the sun during the midday
 * break; plus the naive comparison plan (listed order from the shift start, midday ban only), totals (work, rest, lost
 * work vs naive, exposure reduction Σ max(0, WBGT_eff − Limit)·min, water, coolers) and warnings.
 *
 * Basis: NIOSH 2016-106 §8.1 / ACGIH TLV 1-h TWA (limits.allowedWorkFraction); ADOSH-SF TG v4.0 Table 1 and MoHRE MR
 * 44/2022 (regulation.ts rule pack); TB MED 507 / NIOSH / ILO 2024 water with the ADOSH zone minimum
 * (limits.recommendWaterMlPerHour); ARCHITECTURE.md §1.1, §5; [ENG] binding-worker, placement and rounding rules.
 */
export function planDay(input: PlanDayInput): DayPlan {
  const pack = input.pack ?? DEFAULT_RULE_PACK
  const warnings: PlanWarning[] = []
  const minBlockMin = input.minBlockMin !== undefined && Number.isFinite(input.minBlockMin) && input.minBlockMin >= 0 ? input.minBlockMin : DEFAULT_MIN_BLOCK_MIN
  const minBlockSlots = Math.max(1, Math.ceil(minBlockMin / PLAN_SLOT_MIN))
  const restSetting = restAreaSetting(input)
  const explicitRest = input.restAreaWbgtC !== undefined && Number.isFinite(input.restAreaWbgtC)
  const restLabel = restSetting === null ? 'shade' : explicitRest ? 'the cooled rest area' : 'the air-conditioned rest area'
  const basis = [
    LIMITS_BASIS.allowedWork,
    LIMITS_BASIS.rel,
    LIMITS_BASIS.ral,
    `${pack.name}: ${pack.basis}`,
    ...(pack.middayBreak ? [pack.middayBreak.basis] : []),
    STOP_BAND_BASIS,
    LIMITS_BASIS.hydration,
    ...(restSetting !== null && !explicitRest ? [`Rest area: ${COOLED_REST.basis}`] : []),
    PLANNER_BASIS,
  ]
  const emptyTotals = (): DayPlanTotals => ({
    workMin: 0,
    restMin: 0,
    idleMin: 0,
    naiveWorkMin: 0,
    lostWorkMinVsNaive: 0,
    exposurePlanCMin: 0,
    exposureNaiveCMin: 0,
    exposureReduction: 0,
    waterL: 0,
    coolersNeeded: 0,
  })
  const base = { date: input.date, siteId: input.site.id, packId: pack.id, shift: { ...input.shift }, basis }

  const startOk = validHhmm(input.shift.start) && validHhmm(input.shift.end) && DATE_RE.test(input.date)
  const rawStart = startOk ? hhmmToMinutes(input.shift.start) : 0
  const rawEnd = startOk ? hhmmToMinutes(input.shift.end) : 0
  const startMin = Math.ceil(rawStart / PLAN_SLOT_MIN) * PLAN_SLOT_MIN
  const endMin = Math.floor(rawEnd / PLAN_SLOT_MIN) * PLAN_SLOT_MIN
  if (!startOk || endMin - startMin < PLAN_SLOT_MIN) {
    warnings.push({ code: 'invalid_shift', text: `Invalid date or shift ${input.date} ${input.shift.start}–${input.shift.end}: a same-day shift 'HH:mm'–'HH:mm' is required; nothing was planned.` })
    return { ...base, hours: [], crews: [], totals: emptyTotals(), warnings }
  }
  const dayStartT = epochFromLocal(`${input.date}T00:00`)
  const firstHour = Math.floor(startMin / 60)
  const lastHour = Math.ceil(endMin / 60) - 1
  const conds = buildHourConds(input.hourly, dayStartT, firstHour, lastHour)
  if (conds === null) {
    warnings.push({ code: 'no_forecast', text: 'No usable forecast: nothing was planned (fail-safe — no plan without heat data).' })
    return { ...base, hours: [], crews: [], totals: emptyTotals(), warnings }
  }
  const hours = conds.hours
  if (conds.fallbackHours.length > 0) {
    warnings.push({ code: 'forecast_gap', text: `Forecast missing for ${conds.fallbackHours.join(', ')}: the day's worst values were used (fail-safe).`, hours: conds.fallbackHours })
  }

  const N = (endMin - startMin) / PLAN_SLOT_MIN
  const slotStartMin = (k: number): number => startMin + k * PLAN_SLOT_MIN
  const slotT = (k: number): number => dayStartT + slotStartMin(k) * MINUTE_MS
  const hourIdx = (k: number): number => Math.floor(slotStartMin(k) / 60) - firstHour
  const mb = pack.middayBreak ? middayBreakWindow(dayStartT + 12 * HOUR_MS, pack) : null
  const midday: boolean[] = Array.from({ length: N }, (_, k) => mb !== null && slotT(k) < mb.endT && slotT(k) + PLAN_SLOT_MIN * MINUTE_MS > mb.startT)
  const byId = new Map(input.workers.map((w) => [w.id, w]))
  // ISO 7933 screen inputs: the forecast climate and where the crew rests (a cooled cabin → COOLED_REST conditions).
  const climateAt = climateAccessor(input.hourly)
  const phsRestLocation: WorkerLocation = input.site.restArea === 'cooled_cabin' ? 'indoor_cool' : 'shade'
  if (climateAt === null && input.crews.length > 0) {
    warnings.push({
      code: 'phs_screen_unavailable',
      text: 'The forecast has no air temperature, humidity, radiant and wind values: the heat-strain (ISO 7933) screen of the plan was not run. Workers’ devices still project their own heat strain.',
    })
  }
  if (climateAt !== null) basis.push(PHS_SCREEN.basis)

  const crewPlans: CrewPlan[] = []
  for (const crew of input.crews) {
    const members = membersOf(crew, byId)
    const binding = bindingOf(members)
    if (members.length === 0) warnings.push({ code: 'empty_crew', crewId: crew.id, text: `Crew ${crew.id} has no members: the most protective limit (RAL) is used.` })
    if (binding.unknownMemberIds.length > 0) {
      warnings.push({
        code: 'unknown_worker',
        crewId: crew.id,
        workerIds: binding.unknownMemberIds,
        text: `Crew ${crew.id}: ${binding.unknownMemberIds.join(', ')} not found — treated as unacclimatised with default size and clothing (fail-safe).`,
      })
    }
    const crewDefaultCav = members.length === 0 ? clothingAdjustmentC(undefined) : Math.max(...members.map((m) => clothingAdjustmentC(m.clothing, false)))

    // ── Task contexts and the allowance matrix ──
    const tasks: TaskCtx[] = crew.tasks.map((task, index) => {
      const need = Number.isFinite(task.durationMin) && task.durationMin > 0 ? task.durationMin : 0
      const workW = members.length === 0 ? taskMetabolicW(task) : Math.max(...members.map((m) => taskMetabolicW(task, m.massKg)))
      const cavC = members.length === 0 ? clothingAdjustmentC(task.clothing, task.hood === true) : Math.max(...members.map((m) => clothingAdjustmentC(task.clothing ?? m.clothing, task.hood === true)))
      const es = validHhmm(task.earliestStart) ? hhmmToMinutes(task.earliestStart) : startMin
      const le = validHhmm(task.latestEnd) ? hhmmToMinutes(task.latestEnd) : endMin
      const windowStart = Math.max(0, Math.ceil((Math.max(es, startMin) - startMin) / PLAN_SLOT_MIN))
      const windowEnd = Math.min(N, Math.floor((Math.min(le, endMin) - startMin) / PLAN_SLOT_MIN))
      const allow = hours.map((h) => computeAllowance(task.workClass, task.inSun, workW, cavC, binding.limit, binding.stricterTier, h, pack, restSetting))
      return {
        task,
        index,
        valid: need > 0,
        need,
        workW,
        cavC,
        limitC: exposureLimitC(workW, binding.limit),
        location: task.inSun ? 'sun' : 'shade',
        windowStart,
        windowEnd,
        allow,
      }
    })

    const slotTask: number[] = new Array<number>(N).fill(-1)
    const slotWork: number[] = new Array<number>(N).fill(0)
    /** The slot's work rate, min/h (the task-hour allowance after the PHS screen); 0 for idle slots. */
    const slotRate: number[] = new Array<number>(N).fill(0)
    /** Task-hour allowances lowered by the PHS screen (Infinity = not lowered); they only go down. */
    const phsCap: number[][] = tasks.map(() => hours.map(() => Infinity))
    const capMin = (tc: TaskCtx, hi: number): number => Math.min(tc.allow[hi].allowedMin, phsCap[tc.index][hi])
    const rate = (tc: TaskCtx, k: number): number => capMin(tc, hourIdx(k)) / 60
    const feasible = (tc: TaskCtx, k: number): boolean => slotTask[k] === -1 && rate(tc, k) > 0 && !(tc.task.inSun && midday[k])

    const fill = (tc: TaskCtx, start: number, requireStart: boolean): { used: number[]; work: number[]; done: number } | null => {
      let remaining = tc.need
      let k = start
      let first = true
      const used: number[] = []
      const work: number[] = []
      while (k < tc.windowEnd && remaining > EPS) {
        if (!feasible(tc, k)) {
          if (first && requireStart) return null
          k += 1
          continue
        }
        let runEnd = k
        let cap = 0
        while (runEnd < tc.windowEnd && feasible(tc, runEnd)) {
          cap += rate(tc, runEnd) * PLAN_SLOT_MIN
          runEnd += 1
        }
        if (runEnd - k < minBlockSlots && cap < remaining - EPS) {
          if (first && requireStart) return null
          k = runEnd
          continue
        }
        for (let j = k; j < runEnd && remaining > EPS; j++) {
          const w = Math.min(rate(tc, j) * PLAN_SLOT_MIN, remaining)
          used.push(j)
          work.push(w)
          remaining -= w
        }
        first = false
        k = runEnd
      }
      return { used, work, done: tc.need - Math.max(0, remaining) }
    }
    const commit = (tc: TaskCtx, r: { used: number[]; work: number[] }): void => {
      r.used.forEach((k, i) => {
        slotTask[k] = tc.index
        slotWork[k] = r.work[i]
        slotRate[k] = capMin(tc, hourIdx(k))
      })
    }

    const scheduled: number[] = tasks.map(() => 0)
    for (const tc of tasks) {
      if (!tc.valid) warnings.push({ code: 'invalid_task', crewId: crew.id, taskId: tc.task.id, text: `Task ${tc.task.name} has no valid duration: not scheduled.` })
    }
    /** Places every task with the current allowances (PHS caps included); returns the placement warnings. */
    const placeAll = (): PlanWarning[] => {
      slotTask.fill(-1)
      slotWork.fill(0)
      slotRate.fill(0)
      scheduled.fill(0)
      const placed: PlanWarning[] = []
      // 1. Fixed tasks at their earliest start (they cannot move).
      for (const tc of tasks.filter((x) => x.valid && !x.task.flexible)) {
        const r = fill(tc, tc.windowStart, false)
        if (r) {
          commit(tc, r)
          scheduled[tc.index] = r.done
          if (r.used.length > 0 && r.used[0] > tc.windowStart) {
            placed.push({
              code: 'fixed_task_moved',
              crewId: crew.id,
              taskId: tc.task.id,
              text: `Fixed task ${tc.task.name} cannot start at ${minutesToHhmm(slotStartMin(tc.windowStart))}: heat limits, the midday break or another fixed task hold it until ${minutesToHhmm(slotStartMin(r.used[0]))}.`,
            })
          }
        }
      }
      // 2. Flexible tasks: heaviest in-sun work first, then the narrowest window, then listed order [ENG].
      const flexible = tasks
        .filter((x) => x.valid && x.task.flexible)
        .sort((a, b) => Number(b.task.inSun) - Number(a.task.inSun) || b.workW - a.workW || a.windowEnd - a.windowStart - (b.windowEnd - b.windowStart) || a.index - b.index)
      for (const tc of flexible) {
        let best: { used: number[]; work: number[]; done: number; occ: number } | null = null
        for (let s = tc.windowStart; s < tc.windowEnd; s++) {
          if (!feasible(tc, s)) continue
          const r = fill(tc, s, true)
          if (!r || r.done <= EPS) continue
          const occ = r.used.length
          if (best === null || r.done > best.done + 1e-6 || (Math.abs(r.done - best.done) <= 1e-6 && occ < best.occ)) best = { ...r, occ }
        }
        if (best) {
          commit(tc, best)
          scheduled[tc.index] = best.done
        }
      }
      return placed
    }

    // ── Placement, then the ISO 7933 screen of the planned day (PHS_SCREEN) with re-placement passes ──
    const refAcclimatized = members.filter((m) => m.known).every((m) => m.status === 'acclimatized')
    let crewClothing: ClothingId = DEFAULT_CLOTHING
    let crewClothingCav = -Infinity
    for (const m of members) {
      const id = m.clothing !== undefined && m.clothing in CLOTHING ? m.clothing : DEFAULT_CLOTHING
      const cav = clothingAdjustmentC(id, false)
      if (cav > crewClothingCav) {
        crewClothing = id
        crewClothingCav = cav
      }
    }
    const specs: ScreenSpec[] = tasks.map((tc) => ({
      task: tc.task,
      location: tc.location,
      clothing: tc.task.clothing !== undefined && tc.task.clothing in CLOTHING ? tc.task.clothing : crewClothing,
    }))
    let placementWarnings = placeAll()
    let screen: ScreenOutcome | null = null
    let passes = 0
    const notFeasible = new Map<number, Set<number>>()
    if (climateAt !== null) {
      for (;;) {
        screen = screenPlannedDay({
          N,
          startT: slotT(0),
          hourOfSlot: hourIdx,
          slotTask,
          slotWork,
          slotRate,
          specs,
          climateAt,
          restLocation: phsRestLocation,
          restClothing: crewClothing,
          acclimatized: refAcclimatized,
        })
        passes += 1
        for (const nf of screen.notFeasible) {
          const set = notFeasible.get(nf.ti) ?? new Set<number>()
          set.add(nf.hi)
          notFeasible.set(nf.ti, set)
        }
        let lowered = false
        for (const r of screen.reduced) {
          if (r.capMin < phsCap[r.ti][r.hi]) {
            phsCap[r.ti][r.hi] = r.capMin
            lowered = true
          }
        }
        if (!lowered || passes >= PHS_SCREEN.maxPasses) break
        placementWarnings = placeAll() // re-place with the lowered allowances; the next pass screens and cuts it again
      }
      // What the cut schedule actually completes.
      scheduled.fill(0)
      for (let k = 0; k < N; k++) if (slotTask[k] >= 0) scheduled[slotTask[k]] += slotWork[k]
    }
    warnings.push(...placementWarnings)
    const phsMinOf = (ti: number, hi: number): number | null => {
      const v = Math.min(screen?.phsMin.get(`${ti}|${hi}`) ?? Infinity, phsCap[ti][hi])
      return Number.isFinite(v) ? v : null
    }
    const limitedByOf = (tc: TaskCtx, hi: number): PlanLimitedBy => {
      const a = tc.allow[hi]
      const phs = phsMinOf(tc.index, hi)
      if (phs !== null && phs < a.allowedMin) return 'phs'
      if (a.rawMin >= 60 - EPS) return 'none'
      return a.source === 'rule_pack' ? 'rule_pack' : 'niosh_acgih'
    }
    for (const [ti, hs] of notFeasible) {
      const tc = tasks[ti]
      const list = [...hs].sort((x, y) => x - y).map((hi) => hourLabel(hours[hi].hourOfDay))
      warnings.push({
        code: 'phs_not_feasible',
        crewId: crew.id,
        taskId: tc.task.id,
        hours: list,
        text: `${tc.task.name}: the heat-strain screen (ISO 7933, reference worker) allows less than ${PHS_SCREEN.minBoutMin} min of work per hour at ${list.join(', ')} after the planned work before it; use a lighter task or rotation, a cooling garment, or move the work to a cooler hour.`,
      })
    }

    // ── Unscheduled work ──
    const unscheduled: UnscheduledTask[] = []
    for (const tc of tasks) {
      const done = scheduled[tc.index]
      if (tc.valid && done >= tc.need - 0.5) continue
      let bestHour: string | null = null
      let bestRaw = 0
      for (let hi = 0; hi < hours.length; hi++) {
        const hStart = (hours[hi].hourOfDay * 60 - startMin) / PLAN_SLOT_MIN
        const inWindow = hStart + 60 / PLAN_SLOT_MIN > tc.windowStart && hStart < tc.windowEnd
        const fullyMidday = tc.task.inSun && Array.from({ length: 60 / PLAN_SLOT_MIN }, (_, j) => hStart + j).filter((k) => k >= 0 && k < N).every((k) => midday[k])
        if (!inWindow || fullyMidday) continue
        if (tc.allow[hi].rawMin > bestRaw + EPS) {
          bestRaw = tc.allow[hi].rawMin
          bestHour = hourLabel(hours[hi].hourOfDay)
        }
      }
      const reason: UnscheduledTask['reason'] = !tc.valid ? 'invalid' : done <= EPS ? 'deferred' : 'incomplete'
      const entry: UnscheduledTask = { taskId: tc.task.id, requiredMin: tc.need, scheduledMin: round1(done), reason, bestHour, bestWorkMinPerHour: Math.floor(bestRaw) }
      unscheduled.push(entry)
      if (reason === 'invalid') continue
      const best = bestHour === null ? 'no hour in its window' : `best hour ${bestHour} allows ${Math.floor(bestRaw)} min/h`
      const outside = tc.windowEnd <= tc.windowStart
      warnings.push({
        code: reason === 'deferred' ? 'task_deferred' : 'task_incomplete',
        crewId: crew.id,
        taskId: tc.task.id,
        text: outside
          ? `${tc.task.name}: its time window (${tc.task.earliestStart ?? 'shift start'}–${tc.task.latestEnd ?? 'shift end'}) lies outside the shift; not scheduled.`
          : reason === 'deferred'
            ? `${tc.task.name} deferred: no hour in its window allows at least ${60 * STOP_BAND_WORK_FRACTION} min/h of work under the required work/rest cycle (${best}). Reschedule to a cooler day or add engineering controls (cooler rest area, shade).`
            : `${tc.task.name}: only ${Math.round(done)} of ${tc.need} min fit in its window under the required work/rest cycle (${best}).`,
      })
    }

    // ── Unacclimatised members (ADOSH: no unacclimatised person to work in Medium/High) ──
    // ADOSH exclusion: only TG v4.0 Table 1 note b members (as risk.ts); acclimatising members stay on RAL and the ramp.
    const nonAcc = binding.adoshUnacclimatizedMemberIds
    const excludedCache = new Map<string, { excluded: boolean; shadeOk: boolean; label: string }>()
    const exclusion = (tc: TaskCtx, hi: number): { excluded: boolean; shadeOk: boolean; label: string } => {
      const key = `${tc.index}|${hi}`
      const hit = excludedCache.get(key)
      if (hit) return hit
      const h = hours[hi]
      const f = regulatoryFloor({ t: h.t, twlWm2: tc.allow[hi].twlWm2, outdoorInSun: false, acclimatization: 'unacclimatized', workClass: tc.task.workClass, pack })
      const sh = regulatoryFloor({ t: h.t, twlWm2: h.twlShadeWm2, outdoorInSun: false, acclimatization: 'unacclimatized', workClass: 'light', pack })
      const v = { excluded: f.unacclimatizedExcluded, shadeOk: !sh.unacclimatizedExcluded, label: f.zone?.label ?? 'current zone' }
      excludedCache.set(key, v)
      return v
    }
    const reassignHours = new Set<string>()

    // ── Water ──
    const waterCache = new Map<string, number>()
    const taskWaterMlH = (tc: TaskCtx, hi: number): number => {
      const key = `${tc.index}|${hi}`
      const hit = waterCache.get(key)
      if (hit !== undefined) return hit
      const a = tc.allow[hi]
      const ml = recommendWaterMlPerHour({
        workW: tc.workW,
        workClass: tc.task.workClass,
        wbgtC: a.wbgtWorkEffC,
        ...(a.waterMinLph !== null ? { regulatoryMinMlPerHour: a.waterMinLph * 1000 } : {}),
      }).mlPerHour
      waterCache.set(key, ml)
      return ml
    }
    const idleWaterMlH = hours.map((h) => {
      const rest = restWbgtFor(restSetting, h)
      return recommendWaterMlPerHour({ workW: REST_METABOLIC_W, workClass: 'rest', wbgtC: rest + crewDefaultCav }).mlPerHour
    })
    const slotWaterL = (k: number): number => {
      const ti = slotTask[k]
      const ml = ti >= 0 ? taskWaterMlH(tasks[ti], hourIdx(k)) : idleWaterMlH[hourIdx(k)]
      return (ml * (PLAN_SLOT_MIN / 60) * binding.crewSize) / 1000
    }

    // ── Blocks ──
    const blocks: PlanBlock[] = []
    let k0 = 0
    const keyOf = (k: number): string => {
      const ti = slotTask[k]
      return ti >= 0 ? `t${ti}|${slotRate[k]}` : `idle|${midday[k] ? 1 : 0}`
    }
    while (k0 < N) {
      let k1 = k0
      while (k1 + 1 < N && keyOf(k1 + 1) === keyOf(k0)) k1 += 1
      const ti = slotTask[k0]
      const tc = ti >= 0 ? tasks[ti] : null
      const startT = slotT(k0)
      const endT = slotT(k1) + PLAN_SLOT_MIN * MINUTE_MS
      const wall = (k1 - k0 + 1) * PLAN_SLOT_MIN
      let workMin = 0
      let waterL = 0
      const perHour = new Map<number, BlockHour>()
      const notes: string[] = []
      const bset = new Set<string>()
      for (let k = k0; k <= k1; k++) {
        workMin += slotWork[k]
        waterL += slotWaterL(k)
        const hi = hourIdx(k)
        const h = hours[hi]
        if (tc) {
          const a = tc.allow[hi]
          const bh: BlockHour = perHour.get(hi) ?? {
            hour: hourLabel(h.hourOfDay),
            wallMin: 0,
            workMin: 0,
            allowedWorkMinPerHour: a.allowedMin,
            nioshWorkMinPerHour: a.nioshMin,
            packWorkMinPerHour: a.packMin,
            zone: a.zone?.id ?? null,
            wbgtWorkEffC: a.wbgtWorkEffC,
            wbgtRestEffC: a.wbgtRestEffC,
            twlWm2: a.twlWm2,
            startT: slotT(k),
            boutMin: 0,
            phsWorkMinPerHour: phsMinOf(tc.index, hi),
            limitedBy: limitedByOf(tc, hi),
          }
          bh.wallMin += PLAN_SLOT_MIN
          bh.workMin += slotWork[k]
          perHour.set(hi, bh)
          for (const b of a.basis) bset.add(b)
          if (nonAcc.length > 0) {
            const ex = exclusion(tc, hi)
            if (ex.excluded) reassignHours.add(hourLabel(h.hourOfDay))
          }
        }
      }
      const hoursDetail = [...perHour.values()].map((bh) => ({ ...bh, workMin: round2(bh.workMin), boutMin: Math.min(bh.wallMin, Math.max(0, Math.ceil(bh.workMin - 1e-6))) }))
      if (tc) {
        const a = tc.allow[hourIdx(k0)]
        const allowed = slotRate[k0]
        const phsLimited = allowed < a.allowedMin
        if (nonAcc.length > 0) {
          const exHours = [...perHour.keys()].filter((hi) => exclusion(tc, hi).excluded)
          if (exHours.length > 0) {
            const ex = exclusion(tc, exHours[0])
            notes.push(
              `Not yet acclimatised (${nonAcc.join(', ')}): may not work in the ${ex.label} — ${ex.shadeOk ? 'reassign to shaded light work' : 'no heat-exposed work; follow the acclimatisation plan'}.`,
            )
          }
        }
        if (allowed < 60) notes.push(`Rest in ${restLabel} ${60 - allowed} min every hour.`)
        if (phsLimited) {
          notes.push(`Heat-strain screen (ISO 7933, reference worker): at most ${allowed} min of work per hour here, worked as one bout at the start of each hour.`)
          bset.add(PHS_SCREEN.basis)
        }
        if (tc.task.inSun && mb !== null && pack.middayBreak) {
          const offsetNote = pack.utcOffsetMinutes !== 240 ? ' (rule-pack local time)' : ''
          notes.push(`No work in direct sun ${pack.middayBreak.startHhmm}–${pack.middayBreak.endHhmm}${offsetNote} (midday break).`)
        }
        if ((slotStartMin(k1) - startMin) / 60 > 2) notes.push('Electrolyte drinks after 2 h of sweating (no salt tablets).')
        const zoneNoLone = [...perHour.keys()].some((hi) => tc.allow[hi].zone?.loneWorkAllowed === false)
        if (zoneNoLone) notes.push('No lone work (TWL zone control).')
        else if (binding.nonAcclimatizedMemberIds.length > 0 || binding.conservative) notes.push('Buddy system: no lone work for members on a stricter personal limit.')
        bset.add(LIMITS_BASIS.hydration)
        const source: RestCycle['source'] = phsLimited ? 'phs' : a.source
        blocks.push({
          taskId: tc.task.id,
          taskName: tc.task.name,
          start: minutesToHhmm(slotStartMin(k0)),
          end: minutesToHhmm(slotStartMin(k1) + PLAN_SLOT_MIN),
          startT,
          endT,
          location: tc.location,
          workMinPerHour: allowed,
          restMinPerHour: 60 - allowed,
          rest: {
            workMin: allowed,
            restMin: 60 - allowed,
            source,
            text:
              allowed >= 60
                ? 'Continuous self-paced work, water and shade available'
                : `${allowed} min work / ${60 - allowed} min rest per hour (${source === 'phs' ? 'ISO 7933 heat-strain screen' : source === 'niosh' ? `NIOSH ${binding.limit} 1-h TWA` : source === 'rule_pack' ? `${pack.id} TWL zone cycle` : `NIOSH ${binding.limit} and ${pack.id} TWL zone`})`,
          },
          workMin: round2(workMin),
          restMin: round2(wall - workMin),
          waterL: round2(waterL),
          hours: hoursDetail,
          notes,
          basis: [...bset],
        })
      } else {
        const inMidday = midday[k0]
        if (inMidday && pack.middayBreak) notes.push(`Midday break ${pack.middayBreak.startHhmm}–${pack.middayBreak.endHhmm}: no work in direct sun; rest in ${restLabel}.`)
        else notes.push(`No task scheduled: rest in ${restLabel} (deferred or completed work).`)
        const restHours = new Set<string>()
        for (let k = k0; k <= k1; k++) {
          const hi = hourIdx(k)
          if (tasks.some((t) => t.allow[hi].restExceedsLimit)) restHours.add(hourLabel(hours[hi].hourOfDay))
        }
        if (restHours.size > 0) notes.push(`Even rest in ${restLabel} exceeds the crew's exposure limit at ${[...restHours].join(', ')}: use a cooler rest area.`)
        blocks.push({
          taskId: null,
          taskName: null,
          start: minutesToHhmm(slotStartMin(k0)),
          end: minutesToHhmm(slotStartMin(k1) + PLAN_SLOT_MIN),
          startT,
          endT,
          location: 'shade',
          workMinPerHour: 0,
          restMinPerHour: 60,
          rest: { workMin: 0, restMin: 60, source: 'none', text: `Rest in ${restLabel}` },
          workMin: 0,
          restMin: wall,
          waterL: round2(waterL),
          hours: [],
          notes,
          basis: [...(inMidday && pack.middayBreak ? [pack.middayBreak.basis] : []), LIMITS_BASIS.hydration],
        })
      }
      k0 = k1 + 1
    }
    if (reassignHours.size > 0) {
      warnings.push({
        code: 'unacclimatized_reassign',
        crewId: crew.id,
        workerIds: [...nonAcc],
        hours: [...reassignHours].sort(),
        text: `Crew ${crew.id}: ${nonAcc.join(', ')} not yet acclimatised — may not work in the ADOSH Medium/High zone at ${[...reassignHours].sort().join(', ')}; reassign to shaded light work (${pack.twlZones[0]?.basis ?? pack.basis}).`,
      })
    }
    for (const m of members.filter((x) => x.known && x.maxExposureFraction < 1)) {
      warnings.push({
        code: 'acclimatization_ramp',
        crewId: crew.id,
        workerIds: [m.id],
        text: `${m.id}: acclimatisation day ${m.dayOfRamp ?? 1} — limit heat exposure to ${Math.round(m.maxExposureFraction * 100)} % of a full shift (${LIMITS_BASIS.acclimatization}).`,
      })
    }
    const restExceed = hours.filter((_, hi) => tasks.some((t) => t.allow[hi].restExceedsLimit)).map((h) => hourLabel(h.hourOfDay))
    if (restExceed.length > 0) {
      warnings.push({
        code: 'rest_exceeds_limit',
        crewId: crew.id,
        hours: restExceed,
        text: `Crew ${crew.id}: even rest in ${restLabel} exceeds the crew's exposure limit at ${restExceed.join(', ')} — no heat work is possible then; provide a cooler rest area (ADOSH-SF CoP 11.0 §3.2(i)).`,
      })
    }

    // ── Totals, exposure, naive comparison ──
    let workTotal = 0
    let exposure = 0
    let idleSlots = 0
    const hourWaterL = new Map<number, number>()
    for (let k = 0; k < N; k++) {
      const ti = slotTask[k]
      hourWaterL.set(hourIdx(k), (hourWaterL.get(hourIdx(k)) ?? 0) + slotWaterL(k))
      if (ti < 0) {
        idleSlots += 1
        continue
      }
      const tc = tasks[ti]
      workTotal += slotWork[k]
      exposure += Math.max(0, tc.allow[hourIdx(k)].wbgtWorkEffC - tc.limitC) * slotWork[k]
    }
    const taskSlots = N - idleSlots
    const naive = naivePlan(tasks, N, midday, hourIdx, slotStartMin)
    const waterTotal = blocks.reduce((s, b) => s + b.waterL, 0)
    const peakLph = Math.max(0, ...hourWaterL.values())
    const coolers = N > 0 ? Math.max(1, Math.ceil((peakLph * COOLER_REFILL_INTERVAL_H) / COOLER_CAPACITY_L - EPS)) : 0
    crewPlans.push({
      crewId: crew.id,
      binding,
      blocks,
      workMin: round1(workTotal),
      restMin: round1(taskSlots * PLAN_SLOT_MIN - workTotal),
      idleMin: idleSlots * PLAN_SLOT_MIN,
      waterL: round1(waterTotal),
      coolersNeeded: coolers,
      exposureCMin: round1(exposure),
      naive: { blocks: naive.blocks, workMin: round1(naive.workMin), exposureCMin: round1(naive.exposure) },
      lostWorkMinVsNaive: round1(naive.workMin - workTotal),
      exposureReduction: round1(naive.exposure - exposure),
      unscheduled,
      allowance: hours.map((h, hi) => ({ hour: hourLabel(h.hourOfDay), byTask: Object.fromEntries(tasks.map((t) => [t.task.id, t.allow[hi].allowedMin])) })),
      phsScreen:
        climateAt === null
          ? null
          : {
              reference: { massKg: PHS_SCREEN.referenceMassKg, heightCm: PHS_SCREEN.referenceHeightCm, acclimatized: refAcclimatized },
              passes,
              hours: hours.map((h, hi) => ({
                hour: hourLabel(h.hourOfDay),
                byTask: Object.fromEntries(
                  tasks.map((t) => {
                    const phs = phsMinOf(t.index, hi)
                    const allowedMin = t.allow[hi].allowedMin
                    return [t.task.id, { allowedMin, phsWorkMin: phs, workMin: phs === null ? allowedMin : Math.min(allowedMin, phs), limitedBy: limitedByOf(t, hi) }]
                  }),
                ),
              })),
            },
    })
  }

  // ── Site hour outlook for the strictest crew binding ──
  const allMembers = input.crews.flatMap((c) => membersOf(c, byId))
  const strictLimit: ExposureLimitId = crewPlans.length === 0 || crewPlans.some((c) => c.binding.limit === 'RAL') ? 'RAL' : 'REL'
  const strictTier = crewPlans.some((c) => c.binding.stricterTier)
  const strictCav = allMembers.length === 0 ? clothingAdjustmentC(undefined) : Math.max(...allMembers.map((m) => clothingAdjustmentC(m.clothing, false)))
  const masses = allMembers.map((m) => m.massKg).filter((v): v is number => v !== undefined && Number.isFinite(v))
  const maxMass = masses.length > 0 ? Math.max(...masses) : undefined
  const outlook: HourOutlook[] = hours.map((h) => {
    const byClass = (inSun: boolean): Record<WorkClass, number> =>
      Object.fromEntries(
        WORK_CLASSES.map((wc) => [wc, computeAllowance(wc, inSun, taskMetabolicW({ workClass: wc }, maxMass), strictCav, strictLimit, strictTier, h, pack, restSetting).allowedMin]),
      ) as Record<WorkClass, number>
    const zone = twlZone(h.twlWm2, pack)
    const hourStart = h.t
    const hourEnd = h.t + HOUR_MS
    return {
      hour: hourLabel(h.hourOfDay),
      t: h.t,
      wbgtC: round2(h.wbgtC),
      wbgtShadeC: round2(h.wbgtShadeC),
      twlWm2: Math.round(h.twlWm2),
      twlShadeWm2: Math.round(h.twlShadeWm2),
      zone: zone?.id ?? null,
      zoneLabel: zone?.label ?? null,
      shadeZone: twlZone(h.twlShadeWm2, pack)?.id ?? null,
      middayBreak: mb !== null && hourStart < mb.endT && hourEnd > mb.startT,
      allowedWorkMinPerHour: byClass(true),
      allowedWorkMinPerHourShade: byClass(false),
      binding: { limit: strictLimit, clothingAdjustmentC: strictCav, stricterTier: strictTier },
      forecastFallback: h.fallback,
    }
  })

  const totals = emptyTotals()
  for (const c of crewPlans) {
    totals.workMin += c.workMin
    totals.restMin += c.restMin
    totals.idleMin += c.idleMin
    totals.naiveWorkMin += c.naive.workMin
    totals.exposurePlanCMin += c.exposureCMin
    totals.exposureNaiveCMin += c.naive.exposureCMin
    totals.waterL += c.waterL
    totals.coolersNeeded += c.coolersNeeded
  }
  totals.workMin = round1(totals.workMin)
  totals.restMin = round1(totals.restMin)
  totals.naiveWorkMin = round1(totals.naiveWorkMin)
  totals.lostWorkMinVsNaive = round1(totals.naiveWorkMin - totals.workMin)
  totals.exposurePlanCMin = round1(totals.exposurePlanCMin)
  totals.exposureNaiveCMin = round1(totals.exposureNaiveCMin)
  totals.exposureReduction = round1(totals.exposureNaiveCMin - totals.exposurePlanCMin)
  totals.waterL = round1(totals.waterL)
  return { ...base, hours: outlook, crews: crewPlans, totals, warnings }
}

/** Naive plan: listed order from the shift start, continuous work, in-sun tasks pause for the midday break only. */
function naivePlan(
  tasks: readonly TaskCtx[],
  N: number,
  midday: readonly boolean[],
  hourIdx: (k: number) => number,
  slotStartMin: (k: number) => number,
): { blocks: NaiveBlock[]; workMin: number; exposure: number } {
  const blocks: NaiveBlock[] = []
  let k = 0
  let workMin = 0
  let exposure = 0
  for (const tc of tasks) {
    if (!tc.valid) continue
    let remaining = tc.need
    let open: NaiveBlock | null = null
    let lastK = -2
    while (remaining > EPS && k < N) {
      if (tc.task.inSun && midday[k]) {
        k += 1
        continue
      }
      const w = Math.min(PLAN_SLOT_MIN, remaining)
      remaining -= w
      workMin += w
      exposure += Math.max(0, tc.allow[hourIdx(k)].wbgtWorkEffC - tc.limitC) * w
      if (open && lastK === k - 1) {
        open.end = minutesToHhmm(slotStartMin(k) + PLAN_SLOT_MIN)
        open.workMin += w
      } else {
        open = { taskId: tc.task.id, start: minutesToHhmm(slotStartMin(k)), end: minutesToHhmm(slotStartMin(k) + PLAN_SLOT_MIN), location: tc.location, workMin: w }
        blocks.push(open)
      }
      lastK = k
      k += 1
    }
  }
  return { blocks, workMin, exposure }
}

// ─────────────────────────────── suggestShiftStart ───────────────────────────────

/**
 * Rank shift starts (same shift length) by planning each: options completing at least 95 % of the best option's work
 * ({@link SHIFT_WORK_TIE_TOLERANCE}) rank first, ordered by heat exposure above the limit (lower first), then by work
 * (more first), then by the candidates' order. Candidates that are invalid or would cross midnight are dropped.
 * Basis: {@link planDay}; ARCHITECTURE.md §1.1 (protection before productivity).
 */
export function suggestShiftStart(input: PlanDayInput, candidates: readonly string[] = SHIFT_START_CANDIDATES): ShiftOption[] {
  if (!validHhmm(input.shift.start) || !validHhmm(input.shift.end)) return []
  const len = hhmmToMinutes(input.shift.end) - hhmmToMinutes(input.shift.start)
  if (len <= 0) return []
  const evaluated = candidates
    .map((c, order) => ({ c, order }))
    .filter(({ c }) => validHhmm(c) && hhmmToMinutes(c) + len < 1440)
    .map(({ c, order }) => {
      const end = minutesToHhmm(hhmmToMinutes(c) + len)
      const plan = planDay({ ...input, shift: { start: c, end } })
      const unscheduledWorkMin = plan.crews.reduce((s, cp) => s + cp.unscheduled.reduce((u, x) => u + Math.max(0, x.requiredMin - x.scheduledMin), 0), 0)
      return { start: c, end, order, plan, unscheduledWorkMin }
    })
  if (evaluated.length === 0) return []
  const bestWork = Math.max(...evaluated.map((e) => e.plan.totals.workMin))
  const tier = (w: number): number => (w >= (1 - SHIFT_WORK_TIE_TOLERANCE) * bestWork - EPS ? 0 : 1)
  evaluated.sort(
    (a, b) =>
      tier(a.plan.totals.workMin) - tier(b.plan.totals.workMin) ||
      a.plan.totals.exposurePlanCMin - b.plan.totals.exposurePlanCMin ||
      b.plan.totals.workMin - a.plan.totals.workMin ||
      a.order - b.order,
  )
  return evaluated.map((e, i) => ({
    rank: i + 1,
    start: e.start,
    end: e.end,
    totals: e.plan.totals,
    unscheduledWorkMin: round1(e.unscheduledWorkMin),
    warnings: e.plan.warnings.length,
    reason: `${Math.round(e.plan.totals.workMin)} crew-min of work planned (${Math.round(e.unscheduledWorkMin)} min left unscheduled); heat exposure above the limit ${Math.round(e.plan.totals.exposurePlanCMin)} °C·min.`,
  }))
}
