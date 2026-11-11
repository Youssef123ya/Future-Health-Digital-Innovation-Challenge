/**
 * Forecast-aware work/rest planner — ARCHITECTURE.md §1.1 ("the planner may reschedule work, but it never removes rest
 * that a protective rule requires"), §1.6 (regulatory floor), §5 (environment and regulation channels), §9 (supervisor
 * break and rotation planner, water logistics).
 *
 * For one site-day it takes the hourly heat forecast (WBGT in sun and shade, TWL), the crews with their tasks and
 * members, and the shift, and returns per crew an ordered list of blocks with the work/rest cycle of every hour, the
 * water to provide and notes, per-member caps for members on an acclimatisation schedule, plus a comparison with a naive
 * plan (listed order within the task windows, midday ban only).
 *
 * Rules (stricter always wins; nothing here can lower protection below the risk engine's):
 * - per person where the standards differ per person (wave 2d): the crew rate is planned for the crew's acclimatised
 *   members — NIOSH REL (limits.selectExposureLimit('acclimatized', false)), the pack's base work/rest tier, their
 *   worst clothing adjustment (task PPE overrides the member's clothing, +1 °C for a hood) and their highest metabolic
 *   rate (body-mass scaling). Members on an acclimatisation schedule (status 'unacclimatized' or 'acclimatizing'; crew
 *   members missing from `workers`, fail-safe) get personal caps per block-hour ({@link MemberCapHour}): NIOSH RAL with
 *   their own size and clothing and the pack's next-stricter work/rest tier (both applied by their devices), the ADOSH
 *   TG v4.0 Table 1 note b exclusion, the acclimatisation exposure ramp and an ISO 7933 screen with an unacclimatised
 *   reference worker; a cap never exceeds the crew rate. The supervisor sees the schedule and the cap (an employer
 *   duty: ADOSH-SF CoP 11.0 v4.0 §3.2(b)(i)), never the history or the reason. With no acclimatised member (or no
 *   known member) the crew rate is that acclimatisation-schedule rate (RAL, next-stricter tier, unacclimatised screen).
 *   Conservative mode and fasting are private and are not planner inputs: the device applies them (risk.ts), and the
 *   plan carries one neutral note that devices may direct extra rest ({@link DEVICE_REST_NOTE});
 * - rest term: the site's rest area (Site.restArea) — an air-conditioned cabin at risk.ts COOLED_REST (ADOSH-SF CoP
 *   11.0 v4.0 §3.2(c)) or, where only shade exists, the hourly shade WBGT; an explicit `restAreaWbgtC` overrides it;
 *   a rest area is never taken as hotter than the shade [ENG];
 * - allowed work per hour = min(NIOSH/ACGIH 1-h TWA allowed fraction (limits.allowedWorkFraction), the rule pack's
 *   TWL-zone cycle (regulation.regulatoryFloor)), floored to whole 5-min steps; an hour whose allowance is below the
 *   ARCHITECTURE §5 stop band (f < 0.25) gets no work at all, so the plan never schedules work the risk engine would
 *   stop. Plan basis 'monitored' ({@link PlanBasis}, occupational-health sign-off): for a crew rate planned for
 *   acclimatised members the WBGT tables are a screen (ISO 7243:2017, ACGIH TLV decision flow, NIOSH 2016) and the
 *   rate is set by the rule pack (always enforced) and the ISO 7933 screen, in the task-hours where every device can
 *   confirm monitoring (not the hour of the device warm-up at the shift start, verified ISO 7933 clothing values,
 *   inputs within the model's validity range; BlockHour.monitored); personal caps keep the tables;
 * - fixed tasks first at their earliest start; flexible tasks (heaviest in-sun first) at the start inside their window
 *   (earliestStart/latestEnd ∩ shift) that completes the most work in the fewest crew-minutes, i.e. maximises the
 *   allowed work fraction (ties → earlier);
 * - ISO 7933 screen ({@link PHS_SCREEN}): the planned day is simulated minute by minute for the reference worker as
 *   the device steps it (risk.ts buildPhsInput, ENGINE_PHS_OPTIONS, no PHS minute at the shift-start step, projections
 *   at every activity change and every 5 min, counted down in between); work bouts, the rest after them and idle
 *   stretches must keep the projection ≥ highFromMin + 1 min. Task-hours are cut and the day re-placed until nothing
 *   is cut, then a verification pass checks the final layout. When rest alone reaches a limit within the shift no
 *   plan can be followed without a device stop: no work is planned and 'phs_rest_limit' says why;
 * - outdoor-in-sun work never overlaps the midday break (MoHRE MR 44/2022 via the rule pack);
 * - water per crew-hour from limits.recommendWaterMlPerHour with the pack's zone minimum (the crew's highest metabolic
 *   rate); ADOSH-unacclimatised members (TG v4.0 Table 1 note b: new, or > 14 days off, first 7 days back — as in
 *   risk.ts) get a personal cap of 0 in hours whose TWL zone excludes them ("no unacclimatised person to work") and a
 *   reassignment hint.
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
import { COOLED_REST, ENGINE_PHS_OPTIONS, RISK_THRESHOLDS, buildPhsInput, type PhsClimate, type PhsInputs, type WorkerLocation } from './risk'
import { minutesToLimit, phsInitialState, phsStep, phsValidity, type PhsState } from './phs'
import { ECTEMP_RULES } from './physio'
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
 * ISO 7933 (PHS) screen of the planned day [ENG]. Reference worker 75 kg / 1.75 m: acclimatised for a crew rate planned
 * for acclimatised members, unacclimatised for the personal caps of members on an acclimatisation schedule (and for a
 * crew with no acclimatised member); the task's clothing, else the worst-CAV clothing of the members planned for;
 * drinking allowed with the ISO 5 % water-loss criterion (no logged intake at plan time: logged drinking only raises the
 * device's limit). Fasting is private and not screened (the neutral {@link DEVICE_REST_NOTE} covers device-directed
 * rest). The planned day is stepped minute by minute as the device steps it (risk.ts stepWorkerEngine with the
 * engine's own PHS inputs, buildPhsInput and ENGINE_PHS_OPTIONS): the state starts from the minute-0 activity with no PHS
 * minute stepped at the shift-start step, and minute T steps the activity and climate of minute T. In each block-hour
 * the work bout (whole minutes, floored, at the task's location) comes first, then rest at the site's rest area
 * (COOLED_REST for a cooled cabin, else shade); idle stretches are rest too. The device's projection is emulated as it
 * is made: fresh at every change of the activity key and every RISK_THRESHOLDS.projection.everyMin minutes (5), counted
 * down in between; at every minute of work, of the rest after it and of idle stretches the countdown must stay
 * ≥ highFromMin + endMarginMin (16 min), so the device (stop below 15) never stops or holds the reference worker.
 * Each task-hour keeps the largest W' ≤ W (5-min steps) whose bout and following rest (through the next planned bout
 * or the shift end) pass; W' below minBoutMin means no work that hour ('phs_not_feasible'). The day is re-placed with
 * the lowered task-hour allowances until a pass cuts nothing (allowances only go down on a finite lattice, so this
 * terminates; maxPasses is a safety net), then a verification pass steps the final layout and zeroes any block-hour
 * still failing (with a warning). When rest alone from the shift start fails within the shift no work can avoid a
 * device stop (work only adds heat and sweat): no work is planned and 'phs_rest_limit' gives the time and mitigations.
 * Tested (planner.test.ts, planner.wave2d.test.ts), at constant conditions: following the plan minute by minute through
 * createWorkerEngine / stepWorkerEngine gives no projection stop and no hold for a worker of the reference size — the
 * acclimatised reference on the crew layout (cooled cabin and shade rest, the safety review's counter-examples, a
 * monitored plan with valid monitoring) and a member on an acclimatisation schedule on its personal caps; when rest
 * alone reaches a limit, the warning time is one minute before the device's first stop. Not shown: forecast error
 * (varying conditions), other body sizes, and a member following the crew layout instead of its caps (that does stop).
 * Basis: ISO 7933:2023; engine/risk.ts RISK_THRESHOLDS.projection and .resume.
 */
export const PHS_SCREEN = {
  referenceMassKg: DEFAULT_BODY_MASS_KG,
  referenceHeightCm: DEFAULT_HEIGHT_CM,
  highFromMin: RISK_THRESHOLDS.projection.highFromMin,
  /** Protective margin on every screened projection [ENG]: one minute absorbs sub-minute timing differences from the device. */
  endMarginMin: 1,
  /** The device projects at every activity change and every this many minutes (risk.ts RISK_THRESHOLDS.projection.everyMin). */
  projectionEveryMin: RISK_THRESHOLDS.projection.everyMin,
  minBoutMin: RISK_THRESHOLDS.resume.minBoutMin,
  /** Safety net on the re-placement passes [ENG]: they stop when a pass cuts nothing; a verification pass always follows. */
  maxPasses: 32,
  basis:
    'ISO 7933:2023 projection (engine/risk.ts buildPhsInput, ENGINE_PHS_OPTIONS, stepWorkerEngine minute convention); RISK_THRESHOLDS.projection.highFromMin (stop < 15 min), .everyMin (5) and RISK_THRESHOLDS.resume.minBoutMin (10 min); [ENG] reference worker 75 kg / 1.75 m, task clothing, acclimatised for the crew rate and unacclimatised for acclimatisation-schedule caps, drinking allowed (ISO 5 %), one work bout per block-hour followed by rest in the site rest area, projection ≥ 15 + 1 min at every minute of work, rest and idle time',
} as const

/** Plan basis (wave 2d): the WBGT tables enforce the crew rate ('tables', default) or screen it ('monitored'). */
export type PlanBasis = 'tables' | 'monitored'

/**
 * Basis 'monitored' [ENG design, decided with occupational-health sign-off per site]: WBGT tables are a screening method;
 * above the screen the standards call for a detailed analysis or physiological monitoring. The crew rate planned for
 * acclimatised members then omits the NIOSH/ACGIH TWA cap in the task-hours where every device can confirm monitoring
 * (monitoredHour: not the hour of the device warm-up, verified ISO 7933 clothing values, inputs within the model's
 * validity range); the rule pack and the ISO 7933 screen still bind, and personal caps keep the tables. The planner
 * never learns who wears a device or has consented: a worker whose device cannot confirm monitoring follows the table
 * limits on the device.
 */
export const MONITORED_PLAN = {
  note: 'Monitored plan: WBGT tables are used as a screen. A worker whose device cannot confirm monitoring follows the table limits on the device.',
  basis: [
    'ISO 7243:2017 (WBGT is a screening method; when the reference value is exceeded, reduce the stress or carry out a detailed analysis with ISO 7933)',
    'ACGIH TLV Heat Stress decision flow (above the screening criteria: detailed analysis and/or physiological monitoring)',
    'NIOSH 2016-106 (physiological monitoring above the REL)',
  ],
} as const

/**
 * Neutral crew note (privacy, ARCHITECTURE §1.5 and §7): conservative mode, fasting and consent state are enforced on
 * the worker's device and never planned, so the plan only says that devices may direct extra rest.
 */
export const DEVICE_REST_NOTE = 'Workers’ devices may direct extra rest for some members; the reasons stay on the device.'

const STOP_BAND_BASIS = 'ARCHITECTURE.md §5 environment channel: allowed work fraction < 0.25 → stop (heavy outdoor work deferred)'
const PLANNER_BASIS = 'ARCHITECTURE.md §1.1 (never removes required rest), §5; [ENG] per-member caps and placement rules (engine/planner.ts)'
/** Fallback citation of the employer's acclimatisation-schedule duty when a rule pack carries none. */
const ACCLIMATIZATION_DUTY_BASIS = 'ADOSH-SF TG v4.0 Table 1 note b; CoP 11.0 v4.0 §3.2(b)(i) (5–7 days before starting hard work in a hot environment)'
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
  /**
   * Plan basis (default 'tables'). 'monitored' needs the site's occupational-health sign-off: the crew rate planned for
   * acclimatised members omits the NIOSH/ACGIH TWA cap ({@link MONITORED_PLAN}); personal caps keep the tables.
   */
  planBasis?: PlanBasis
}

/**
 * Who the crew rate is planned for (wave 2d: per person where the standards differ per person). Non-identifying: it
 * names members on an acclimatisation schedule (an operational duty) and never a history or a private reason.
 */
export interface CrewBinding {
  /** The crew rate's exposure limit: REL when the crew has a known acclimatised member, else RAL (fail-safe). */
  limit: ExposureLimitId
  /**
   * Members on an acclimatisation schedule (status 'unacclimatized' or 'acclimatizing', and crew members missing from
   * `workers`, fail-safe): they get personal caps ({@link CrewPlan.memberCaps}) instead of setting the crew rate.
   */
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
  /**
   * Allowed work min/h by work class, in the sun, for the strictest crew rate (0 = stop band): RAL and the pack's
   * next-stricter tier when some crew has no acclimatised member, else REL and the base tier; the heaviest member and
   * the worst clothing of the site. Personal caps of members on an acclimatisation schedule can be lower.
   */
  allowedWorkMinPerHour: Record<WorkClass, number>
  /** As above, for shaded work. */
  allowedWorkMinPerHourShade: Record<WorkClass, number>
  /**
   * The strictest crew rate's limit (RAL when some crew has no acclimatised member) and the worst clothing adjustment.
   * The outlook always uses the WBGT tables: in a monitored plan it is the fallback a device applies when it cannot
   * confirm monitoring.
   */
  binding: { limit: ExposureLimitId; clothingAdjustmentC: number }
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
  /**
   * The pre-screen allowance the plan enforces, min/h: min(NIOSH/ACGIH, rule pack), or the rule pack alone in a
   * monitored block-hour ({@link BlockHour.monitored}; nioshWorkMinPerHour is still reported: the device's table fallback).
   */
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
   * Execution layout: whole minutes of work at the start of this block-hour (floor of workMin: never above the
   * allowance, protective), then rest for the rest of wallMin — the layout the PHS screen stepped; following it keeps
   * plan and monitor in agreement.
   */
  boutMin: number
  /** The ISO 7933 screen's allowance for this task-hour, min/h (null when not screened). */
  phsWorkMinPerHour: number | null
  /** What set this hour's work minutes. */
  limitedBy: PlanLimitedBy
  /**
   * The crew rate in this block-hour is a monitored rate (plan basis 'monitored'): the NIOSH/ACGIH TWA cap is omitted and
   * the rule pack and the ISO 7933 screen set it. False under 'tables' and in monitored plans where devices cannot
   * confirm monitoring (warm-up hour, clothing or work outside the model; see monitoredHour).
   */
  monitored: boolean
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

/**
 * What set a member's personal cap in a block-hour: the crew's own layout ('crew'), the acclimatisation schedule (NIOSH
 * RAL, the ADOSH note b exclusion or the exposure ramp — not told apart: the supervisor needs the cap, not the reason),
 * or the ISO 7933 screen with an unacclimatised reference worker ('phs').
 */
export type MemberCapLimitedBy = 'crew' | 'acclimatization' | 'phs'

/** A personal cap of one member on an acclimatisation schedule in one crew block-hour ({@link BlockHour}). */
export interface MemberCapHour {
  /** BlockHour.startT of the crew block-hour it applies to, epoch ms. */
  startT: number
  /** Local 'HH:00'. */
  hour: string
  taskId: string
  /** Wall minutes of the block-hour (as the crew's). */
  wallMin: number
  /** The member's work rate, min/h: ≤ the crew's rate in this block-hour; 0 or ≥ PHS_SCREEN.minBoutMin. */
  workMinPerHour: number
  /**
   * Whole minutes of work at the start of the block-hour (floor; ≤ the crew's boutMin and ≤ workMinPerHour × wallMin /
   * 60); rest for the rest of wallMin. Also within the day's exposure allowance in time order (Σ boutMin < the ramp's
   * maxExposureFraction × 480 min, the count at which the device stops hot work), so it can be lower than the rate gives.
   */
  boutMin: number
  limitedBy: MemberCapLimitedBy
}

/** The plan of one crew. */
export interface CrewPlan {
  crewId: string
  binding: CrewBinding
  /** The basis of this crew's rate: 'monitored' only when the day's basis is and the rate is for acclimatised members. */
  planBasis: PlanBasis
  /** Crew-level notes for the supervisor (non-clinical; always {@link DEVICE_REST_NOTE}). */
  notes: string[]
  /**
   * Personal caps of members on an acclimatisation schedule, per worker id, one entry per crew task block-hour in
   * block order (BlockHour.startT). Members without an entry follow the crew layout.
   */
  memberCaps: Record<string, MemberCapHour[]>
  /** Scheduled work per member, minutes: Σ boutMin of the crew layout, or of the member's caps where lower. */
  memberWorkMin: Record<string, number>
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
    /** The crew rate's reference worker (acclimatised when the crew has an acclimatised member). */
    reference: { massKg: number; heightCm: number; acclimatized: boolean }
    /** Screen passes with re-placement (≤ PHS_SCREEN.maxPasses); 0 when rest alone already fails. */
    passes: number
    /** Block-hours the final verification pass had to zero (0 when the passes converged). */
    verificationCuts: number
    /** First minute (epoch ms) at which rest alone from the shift start fails the screen, or null ('phs_rest_limit'). */
    restLimitT: number | null
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
  | 'phs_rest_limit'

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
  /** The plan basis requested ({@link PlanBasis}; default 'tables'). */
  planBasis: PlanBasis
  /** Plan-level notes (the {@link MONITORED_PLAN} note in a monitored plan). */
  notes: string[]
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
  massKg?: number
  heightCm?: number
  clothing?: ClothingId
  maxExposureFraction: number
}

interface TaskCtx {
  task: Task
  index: number
  valid: boolean
  need: number
  /** Highest metabolic rate of the members the crew rate is planned for (body-mass scaling), W. */
  workW: number
  /** Highest metabolic rate of all members, W (water provision for the whole crew). */
  waterW: number
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

/**
 * One task-hour's pre-screen allowance. `useTables` false (a monitored crew rate, {@link MONITORED_PLAN}): the
 * NIOSH/ACGIH value is computed and reported but does not cap the rate; the rule pack always does. The crew rate uses
 * the pack's base work/rest tier (the next-stricter tier of a private conservative mode is the device's: risk.ts,
 * regulation.stricterWorkRest); `stricterTier` (acclimatisation-schedule caps only) adds the next-stricter tier.
 */
function computeAllowance(
  workClass: WorkClass,
  inSun: boolean,
  workW: number,
  cavC: number,
  limit: ExposureLimitId,
  useTables: boolean,
  hour: HourCond,
  pack: RulePack,
  restSetting: number | null,
  stricterTier = false,
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
  const rawMin = useTables ? Math.min(nioshMin, packMin) : packMin
  const stopBand = rawMin < 60 * STOP_BAND_WORK_FRACTION
  const allowedMin = stopBand ? 0 : Math.floor(rawMin / WORK_MIN_GRANULARITY + EPS) * WORK_MIN_GRANULARITY
  const source: RestCycle['source'] = !useTables ? 'rule_pack' : Math.abs(nioshMin - packMin) < EPS ? 'both' : nioshMin < packMin ? 'niosh' : 'rule_pack'
  const basis: string[] = useTables ? [aw.basis] : [...MONITORED_PLAN.basis]
  if (floor.zone) basis.push(floor.zone.basis)
  if (stopBand) basis.push(STOP_BAND_BASIS)
  return {
    allowedMin,
    rawMin,
    nioshMin,
    packMin,
    source,
    restExceedsLimit: useTables && aw.binding === 'rest_exceeds_limit',
    zone: floor.zone,
    twlWm2: twl,
    wbgtWorkEffC: wbgtWork + cavC,
    wbgtRestEffC: wbgtRest + cavC,
    waterMinLph: floor.waterLph ? floor.waterLph.minLph : null,
    basis,
  }
}

/**
 * A crew member missing from `workers`: limits.assessAcclimatization's own fail-safe path for an unknown history (new
 * worker, day 1 of the ADOSH TG new-employee ramp: unacclimatised, ADOSH note b, 20 % exposure) [fail-safe,
 * ARCHITECTURE §1.3]; default size and clothing.
 */
const UNKNOWN_MEMBER_ACCLIMATIZATION = assessAcclimatization({ daysOnSite: Number.NaN, daysAwayRecent: Number.NaN, experiencedInHeat: false })

function membersOf(crew: Crew, byId: ReadonlyMap<string, WorkerProfile>): Member[] {
  return crew.workerIds.map((id) => {
    const p = byId.get(id)
    if (!p) {
      const u = UNKNOWN_MEMBER_ACCLIMATIZATION
      return { id, known: false, status: u.status, adoshUnacclimatized: u.adoshUnacclimatized, maxExposureFraction: u.maxExposureFraction }
    }
    const acc = assessAcclimatization(p)
    return {
      id,
      known: true,
      status: acc.status,
      adoshUnacclimatized: acc.adoshUnacclimatized,
      ...(p.massKg !== undefined ? { massKg: p.massKg } : {}),
      ...(p.heightCm !== undefined ? { heightCm: p.heightCm } : {}),
      clothing: p.clothing,
      maxExposureFraction: acc.maxExposureFraction,
    }
  })
}

/** A known member whose acclimatisation status is 'acclimatized' (limits.assessAcclimatization). */
const isAcclimatizedMember = (m: Member): boolean => m.known && m.status === 'acclimatized'

/** The worst-CAV clothing among members (unknown or invalid → the default clothing). */
function worstClothing(members: readonly Member[]): ClothingId {
  let best: ClothingId = DEFAULT_CLOTHING
  let bestCav = -Infinity
  for (const m of members) {
    const id = m.clothing !== undefined && m.clothing in CLOTHING ? m.clothing : DEFAULT_CLOTHING
    const cav = clothingAdjustmentC(id, false)
    if (cav > bestCav) {
      best = id
      bestCav = cav
    }
  }
  return best
}

/** Local 'HH:mm' of an epoch-ms instant on the plan day. */
const localHhmm = (t: number, dayStartT: number): string => minutesToHhmm(Math.round((t - dayStartT) / MINUTE_MS))

/**
 * Who the crew rate is planned for: its known acclimatised members (NIOSH REL), else every member (NIOSH RAL,
 * fail-safe; also for an empty crew or one with no known member). Members on an acclimatisation schedule and unknown
 * members get personal caps instead of setting the crew rate. Texts name the schedule (an employer duty), never a
 * history or a private reason.
 */
function bindingOf(members: readonly Member[], dutyBasis: string): CrewBinding {
  const acclimatized = members.filter(isAcclimatizedMember)
  const limit: ExposureLimitId = acclimatized.length > 0 ? selectExposureLimit('acclimatized', false) : selectExposureLimit('unacclimatized', false)
  const nonAcc = members.filter((m) => !isAcclimatizedMember(m)).map((m) => m.id)
  const adoshUnacc = members.filter((m) => m.adoshUnacclimatized).map((m) => m.id)
  const unknown = members.filter((m) => !m.known).map((m) => m.id)
  const text =
    members.length === 0
      ? 'The crew has no members: the stricter exposure limit (NIOSH RAL) applies.'
      : members.every((m) => !m.known)
        ? 'The crew has no known members: the stricter exposure limit (NIOSH RAL) applies (fail-safe).'
        : acclimatized.length === 0
          ? 'No member is acclimatised yet: the crew plan uses the stricter exposure limit (NIOSH RAL) and the acclimatisation schedule.'
          : nonAcc.length === 0
            ? 'All members are acclimatised: NIOSH REL applies.'
            : `Crew rate for the acclimatised members (NIOSH REL); members on an acclimatisation schedule (${nonAcc.join(', ')}) have personal caps.`
  return {
    limit,
    nonAcclimatizedMemberIds: nonAcc,
    adoshUnacclimatizedMemberIds: adoshUnacc,
    unknownMemberIds: unknown,
    crewSize: Math.max(1, members.length),
    text,
    basis: `${limit === 'REL' ? LIMITS_BASIS.rel : LIMITS_BASIS.ral}${limit === 'REL' && nonAcc.length > 0 ? `; personal caps: ${LIMITS_BASIS.ral}` : ''}; ${LIMITS_BASIS.acclimatization}; ${dutyBasis}; ${PLANNER_BASIS}`,
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

/**
 * Whether every device of an acclimatised member can confirm monitored mode for a task-hour, as far as a plan can know
 * it (risk.ts RISK_THRESHOLDS.monitoring and phsModelOk, checked by the device per step, with the tables back in the
 * same step otherwise): the hour does not overlap the monitoring warm-up at the shift start (the ECTemp filter
 * re-initialises at a new shift and is not used for physio.ts ECTEMP_RULES.WARMUP_MIN = 30 min, so no device can
 * confirm monitoring then; the whole overlapping hour keeps the tables [ENG, protective: the allowance matrix is
 * hourly]); ISO 7933 applies to the clothing and its values are verified (limits.CLOTHING phs.applicable
 * and phs.verified: not for FR, SMS or polyolefin coveralls or a vapour barrier); and the work inputs stay within the
 * ISO 7933 validity range (phs.phsValidity with the engine's model, e.g. metabolic rate ≤ 250 W/m², vapour pressure
 * ≤ 4.5 kPa) for the reference worker and every acclimatised member at every 5-min point of the hour, ends included.
 * Consent, wearable and signal validity are private and per worker: a device that cannot confirm them applies the
 * tables ({@link MONITORED_PLAN} note). Basis: ISO 7933:2023 Annex A Table A.1; engine/risk.ts monitoring conditions.
 */
function monitoredHour(
  task: Task,
  location: 'sun' | 'shade',
  clothing: ClothingId,
  hour: { hourOfDay: number; t: number },
  shiftStartMin: number,
  sizes: ReadonlyArray<{ massKg?: number; heightCm?: number }>,
  climateAt: (t: number) => PhsClimate,
): boolean {
  if (hour.hourOfDay * 60 < shiftStartMin + ECTEMP_RULES.WARMUP_MIN) return false
  const cs = CLOTHING[clothing].phs
  if (!cs.applicable || !cs.verified) return false
  for (let j = 0; j <= 60 / PLAN_SLOT_MIN; j++) {
    const climate = climateAt(hour.t + j * PLAN_SLOT_MIN * MINUTE_MS)
    for (const s of sizes) {
      const p = buildPhsInput({ climate, location, task, clothing, massKg: s.massKg, heightCm: s.heightCm, acclimatized: true })
      if (!phsValidity(p.input, ENGINE_PHS_OPTIONS.model).withinLimits) return false
    }
  }
  return true
}

/** One screened task: its location and clothing as the device sees them. */
interface ScreenSpec {
  task: Task
  location: 'sun' | 'shade'
  clothing: ClothingId
}

/** One screened segment: a block-hour (a block's part of one clock hour) or an idle stretch within one clock hour. */
interface ScreenSeg {
  /** First minute from the shift start. */
  m0: number
  wall: number
  /** Task index, or −1 for rest. */
  ti: number
  /** Hour index. */
  hi: number
  /** Work minutes the placement planned in the segment (Σ slot work). */
  planned: number
}

/** A crew screen segment with its plan slots k0..k1 (inclusive). */
interface CrewSeg extends ScreenSeg {
  k0: number
  k1: number
}

/** Per-minute PHS inputs of one screened worker (cached) and the activity keys the device's projection follows. */
interface ScreenModel {
  M: number
  input: (m: number, si: number) => PhsInputs
  key: (si: number) => string
}

/**
 * The device's PHS state and projection bookkeeping (risk.ts stepWorkerEngine), emulated minute by minute: the
 * projection made at minute pT (null: no limit within {@link SCREEN_HORIZON_MIN}) counts down until the next one.
 */
interface Track {
  s: PhsState | null
  key: string
  pT: number
  mP: number | null
}

/** What every screened projection must keep, countdown included: highFromMin + endMarginMin minutes. */
const SCREEN_NEED_MIN = PHS_SCREEN.highFromMin + PHS_SCREEN.endMarginMin
/** Screen projection horizon: enough to know the countdown stays ≥ SCREEN_NEED_MIN until the device's next projection. */
const SCREEN_HORIZON_MIN = SCREEN_NEED_MIN + PHS_SCREEN.projectionEveryMin - 1

/** The screened worker's per-minute PHS inputs (reference size; task clothing and location; rest at the rest area). */
function screenModel(o: {
  M: number
  startT: number
  climateAt: (t: number) => PhsClimate
  specs: readonly ScreenSpec[]
  restLocation: WorkerLocation
  restClothing: ClothingId
  acclimatized: boolean
}): ScreenModel {
  const climate: (PhsClimate | undefined)[] = new Array<PhsClimate | undefined>(o.M)
  const cache: (PhsInputs | undefined)[][] = Array.from({ length: o.specs.length + 1 }, () => new Array<PhsInputs | undefined>(o.M))
  const input = (minute: number, si: number): PhsInputs => {
    const m = Math.min(Math.max(0, minute), o.M - 1)
    const row = cache[si + 1]
    const hit = row[m]
    if (hit) return hit
    const c = climate[m] ?? (climate[m] = o.climateAt(o.startT + m * MINUTE_MS))
    const spec = si >= 0 ? o.specs[si] : null
    const v = buildPhsInput({
      climate: c,
      location: spec ? spec.location : o.restLocation,
      task: spec ? spec.task : null,
      clothing: spec ? spec.clothing : o.restClothing,
      massKg: PHS_SCREEN.referenceMassKg,
      heightCm: PHS_SCREEN.referenceHeightCm,
      acclimatized: o.acclimatized,
    })
    row[m] = v
    return v
  }
  const keys = new Map<number, string>()
  const key = (si: number): string => {
    let k = keys.get(si)
    if (k === undefined) {
      k = input(0, si).key
      keys.set(si, k)
    }
    return k
  }
  return { M: o.M, input, key }
}

const newTrack = (): Track => ({ s: null, key: '', pT: 0, mP: null })

/**
 * Steps the emulated device one minute: minute 0 only initialises the state from its activity (risk.ts steps no PHS
 * minute at the shift-start step); minute m > 0 steps the activity and climate of minute m. A projection is made as the
 * device makes it — at a change of the activity key, every projectionEveryMin minutes and when a limit is latched — and
 * counted down in between. True while the countdown stays ≥ SCREEN_NEED_MIN. Outside the model's scope (vapour
 * barrier) the device neither projects nor holds: stepped with the surrogate for continuity, not checked.
 */
function stepTrack(md: ScreenModel, tr: Track, m: number, si: number): boolean {
  const inp = md.input(m, si)
  tr.s = tr.s === null ? phsInitialState(inp.input, ENGINE_PHS_OPTIONS) : phsStep(tr.s, inp.input, 1, ENGINE_PHS_OPTIONS)
  const key = md.key(si)
  if (!inp.applicable) {
    tr.key = key
    tr.pT = m
    tr.mP = null
    return true
  }
  const latched = tr.s.tReLimitMin !== null || tr.s.waterLoss5PctMin !== null
  if (key !== tr.key || m - tr.pT >= PHS_SCREEN.projectionEveryMin || latched) {
    tr.key = key
    tr.pT = m
    tr.mP = minutesToLimit(tr.s, inp.input, SCREEN_HORIZON_MIN, ENGINE_PHS_OPTIONS).minutes
  }
  return tr.mP === null || tr.mP - (m - tr.pT) >= SCREEN_NEED_MIN
}

/** Whole minutes of work at the start of a segment at `rate` min/h: floor (protective), within the budget left. */
function boutOf(seg: ScreenSeg, rate: number, left: number): number {
  return Math.max(0, Math.min(seg.wall, Math.floor(Math.min(seg.planned, (rate * seg.wall) / 60) + 1e-6), Math.floor(left + 1e-6)))
}

/**
 * True when `bout` minutes of work, the rest of the segment and the rest that follows until `restEnd` (the next planned
 * bout or the shift end) all pass. `t` is left at the segment end.
 */
function segmentPasses(md: ScreenModel, t: Track, seg: ScreenSeg, bout: number, restEnd: number): boolean {
  const end = seg.m0 + seg.wall
  for (let m = seg.m0; m < seg.m0 + bout; m++) if (!stepTrack(md, t, m, seg.ti)) return false
  for (let m = seg.m0 + bout; m < end; m++) if (!stepTrack(md, t, m, -1)) return false
  if (restEnd > end) {
    const c: Track = { ...t }
    for (let m = end; m < restEnd; m++) if (!stepTrack(md, c, m, -1)) return false
  }
  return true
}

/** Result of one {@link screenPass}. */
interface PassOut {
  /** Chosen rate per segment, min/h: its cap when not cut, 0 for rest segments. */
  rate: number[]
  /** Chosen bout per segment, minutes. */
  bout: number[]
  /** The segment's rate was cut below its cap. */
  cut: boolean[]
  /** First minute a rest stretch failed whatever the segment's own work (earlier work, or rest alone), or null. */
  restFailT: number | null
}

/**
 * One screen pass over a layout in time order: each task segment keeps the largest rate W' ≤ its cap (5-min steps;
 * below minBoutMin → 0) whose bout, the rest after it and the rest that follows until the next planned bout (or the
 * shift end) keep every emulated projection ≥ SCREEN_NEED_MIN. `budget` (whole minutes; Infinity for none) caps the sum
 * of bouts in time order (the acclimatisation exposure ramp). Later segments are taken as planned before the pass: a
 * later cut to zero lengthens an earlier rest, so the caller repeats passes until nothing is cut.
 */
function screenPass(md: ScreenModel, segs: readonly ScreenSeg[], capOf: (seg: ScreenSeg, i: number) => number, budget: number): PassOut {
  const M = md.M
  const out: PassOut = { rate: [], bout: [], cut: [], restFailT: null }
  // The layout before the pass: where the planned work bouts are.
  const work = new Uint8Array(M)
  let left = budget
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.ti < 0) continue
    const b = boutOf(seg, capOf(seg, i), left)
    left -= b
    work.fill(1, seg.m0, Math.min(M, seg.m0 + b))
  }
  const nextWork = new Int32Array(M + 1)
  nextWork[M] = M
  for (let m = M - 1; m >= 0; m--) nextWork[m] = work[m] === 1 ? m : nextWork[m + 1]
  const tr = newTrack()
  const restThrough = (seg: ScreenSeg): void => {
    for (let m = seg.m0; m < seg.m0 + seg.wall; m++) if (!stepTrack(md, tr, m, -1) && out.restFailT === null) out.restFailT = m
  }
  left = budget
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const W = seg.ti >= 0 ? capOf(seg, i) : 0
    if (seg.ti < 0 || !(W > 0) || boutOf(seg, W, left) === 0) {
      restThrough(seg)
      out.rate.push(seg.ti >= 0 && W > 0 ? W : 0)
      out.bout.push(0)
      out.cut.push(false)
      continue
    }
    const restEnd = nextWork[Math.min(M, seg.m0 + seg.wall)]
    let chosen: { w: number; b: number; t: Track } | null = null
    const tried = new Set<number>()
    for (let w = W; ; w -= WORK_MIN_GRANULARITY) {
      const wc = w >= PHS_SCREEN.minBoutMin - EPS ? w : 0
      const b = boutOf(seg, wc, left)
      if (!tried.has(b)) {
        // The same bout at a lower rate steps the same minutes: tried once.
        tried.add(b)
        const t: Track = { ...tr }
        if (segmentPasses(md, t, seg, b, restEnd)) {
          chosen = { w: wc, b, t }
          break
        }
      }
      if (wc === 0) break
    }
    if (chosen === null) {
      restThrough(seg) // even rest fails from this state: no work here; earlier work is cut by the next pass
      out.rate.push(0)
      out.bout.push(0)
    } else {
      Object.assign(tr, chosen.t)
      out.rate.push(chosen.w)
      out.bout.push(chosen.b)
    }
    left -= out.bout[i]
    out.cut.push(out.rate[i] < W)
  }
  return out
}

/**
 * Steps a final layout (one bout per segment) through the emulated device. Returns the first failing minute and the
 * segment to zero for it — the one being worked, else the last one worked before the failing rest (null: rest alone
 * fails) — or null when the whole layout passes.
 */
function verifyLayout(md: ScreenModel, segs: readonly ScreenSeg[], bouts: readonly number[]): { m: number; zero: number | null } | null {
  const tr = newTrack()
  let lastWorked: number | null = null
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const b = seg.ti >= 0 ? bouts[i] : 0
    if (b > 0) lastWorked = i
    for (let m = seg.m0; m < seg.m0 + seg.wall; m++) {
      const working = m < seg.m0 + b
      if (!stepTrack(md, tr, m, working ? seg.ti : -1)) return { m, zero: working ? i : lastWorked }
    }
  }
  return null
}

/** First minute at which resting from the shift start through the shift fails the screen, or null. */
function restOnlyFailure(md: ScreenModel): number | null {
  const tr = newTrack()
  for (let m = 0; m < md.M; m++) if (!stepTrack(md, tr, m, -1)) return m
  return null
}

// ─────────────────────────────── planDay ───────────────────────────────

/**
 * Plan one site-day: per crew an ordered list of blocks (task, start, end, location, work/rest cycle per hour, water,
 * notes, basis) that never schedules more work in an hour than the rule pack's TWL-zone cycle and, under the 'tables'
 * basis (and always for personal caps), the NIOSH/ACGIH TWA allowance (rest in the site rest area: air-conditioned
 * cabin or shade); never in the stop band, never outdoors in the sun during the midday break, and never more than the
 * ISO 7933 screen allows when the forecast carries the climate ({@link PHS_SCREEN}); per-member caps and scheduled work
 * for members on an acclimatisation schedule; plus the naive comparison plan (listed order within the task windows,
 * midday ban only), totals (work, rest, lost work vs naive, exposure reduction Σ max(0, WBGT_eff − Limit)·min, water,
 * coolers) and warnings.
 *
 * Basis: NIOSH 2016-106 §8.1 / ACGIH TLV 1-h TWA (limits.allowedWorkFraction); ADOSH-SF TG v4.0 Table 1 and MoHRE MR
 * 44/2022 (regulation.ts rule pack); TB MED 507 / NIOSH / ILO 2024 water with the ADOSH zone minimum
 * (limits.recommendWaterMlPerHour); ISO 7933:2023 (screen); ARCHITECTURE.md §1.1, §5; [ENG] per-member caps, placement
 * and rounding rules.
 */
export function planDay(input: PlanDayInput): DayPlan {
  const pack = input.pack ?? DEFAULT_RULE_PACK
  const warnings: PlanWarning[] = []
  const minBlockMin = input.minBlockMin !== undefined && Number.isFinite(input.minBlockMin) && input.minBlockMin >= 0 ? input.minBlockMin : DEFAULT_MIN_BLOCK_MIN
  const minBlockSlots = Math.max(1, Math.ceil(minBlockMin / PLAN_SLOT_MIN))
  const restSetting = restAreaSetting(input)
  const explicitRest = input.restAreaWbgtC !== undefined && Number.isFinite(input.restAreaWbgtC)
  const restLabel = restSetting === null ? 'shade' : explicitRest ? 'the cooled rest area' : 'the air-conditioned rest area'
  const planBasis: PlanBasis = input.planBasis === 'monitored' ? 'monitored' : 'tables'
  const dutyBasis = pack.acclimatization?.basis ?? ACCLIMATIZATION_DUTY_BASIS
  const basis = [
    LIMITS_BASIS.allowedWork,
    LIMITS_BASIS.rel,
    LIMITS_BASIS.ral,
    `${pack.name}: ${pack.basis}`,
    ...(pack.middayBreak ? [pack.middayBreak.basis] : []),
    STOP_BAND_BASIS,
    LIMITS_BASIS.hydration,
    ...(restSetting !== null && !explicitRest ? [`Rest area: ${COOLED_REST.basis}`] : []),
    `Acclimatisation schedule (personal caps): ${dutyBasis}`,
    ...(planBasis === 'monitored' ? MONITORED_PLAN.basis : []),
    PLANNER_BASIS,
  ]
  const planNotes: string[] = planBasis === 'monitored' ? [MONITORED_PLAN.note] : []
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
  const base = { date: input.date, siteId: input.site.id, packId: pack.id, planBasis, notes: planNotes, shift: { ...input.shift }, basis }

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
    const binding = bindingOf(members, dutyBasis)
    if (members.length === 0) warnings.push({ code: 'empty_crew', crewId: crew.id, text: `Crew ${crew.id} has no members: the most protective limit (RAL) is used.` })
    if (binding.unknownMemberIds.length > 0) {
      warnings.push({
        code: 'unknown_worker',
        crewId: crew.id,
        workerIds: binding.unknownMemberIds,
        text: `Crew ${crew.id}: ${binding.unknownMemberIds.join(', ')} not found — treated as new and unacclimatised (first day of the acclimatisation schedule) with default size and clothing (fail-safe).`,
      })
    }
    const crewDefaultCav = members.length === 0 ? clothingAdjustmentC(undefined) : Math.max(...members.map((m) => clothingAdjustmentC(m.clothing, false)))
    // The crew rate is planned for the acclimatised members; with none (or no known member), for everyone (fail-safe).
    const accMembers = members.filter(isAcclimatizedMember)
    const rateMembers = accMembers.length > 0 ? accMembers : members
    const crewClothing = worstClothing(rateMembers)
    const screenClothingOf = (task: Task): ClothingId => (task.clothing !== undefined && task.clothing in CLOTHING ? task.clothing : crewClothing)
    // Monitored basis: only for a crew rate planned for acclimatised members and only where the ISO 7933 screen can
    // run (without climate data the tables apply: never less protective than ISO 7933 or the rule pack when data is
    // absent); then per task-hour only where every device can confirm monitoring ({@link monitoredHour}).
    const crewMonitored = planBasis === 'monitored' && accMembers.length > 0 && climateAt !== null
    const monitorSizes = [{ massKg: PHS_SCREEN.referenceMassKg, heightCm: PHS_SCREEN.referenceHeightCm }, ...accMembers.map((m) => ({ massKg: m.massKg, heightCm: m.heightCm }))]
    const tablesFor = (task: Task, hi: number): boolean =>
      !crewMonitored || climateAt === null || !monitoredHour(task, task.inSun ? 'sun' : 'shade', screenClothingOf(task), hours[hi], startMin, monitorSizes, climateAt)
    const tablesUsed = new Set<string>()

    // ── Task contexts and the allowance matrix ──
    const tasks: TaskCtx[] = crew.tasks.map((task, index) => {
      const need = Number.isFinite(task.durationMin) && task.durationMin > 0 ? task.durationMin : 0
      const workW = rateMembers.length === 0 ? taskMetabolicW(task) : Math.max(...rateMembers.map((m) => taskMetabolicW(task, m.massKg)))
      const waterW = members.length === 0 ? taskMetabolicW(task) : Math.max(...members.map((m) => taskMetabolicW(task, m.massKg)))
      const cavC = rateMembers.length === 0 ? clothingAdjustmentC(task.clothing, task.hood === true) : Math.max(...rateMembers.map((m) => clothingAdjustmentC(task.clothing ?? m.clothing, task.hood === true)))
      const es = validHhmm(task.earliestStart) ? hhmmToMinutes(task.earliestStart) : startMin
      const le = validHhmm(task.latestEnd) ? hhmmToMinutes(task.latestEnd) : endMin
      const windowStart = Math.max(0, Math.ceil((Math.max(es, startMin) - startMin) / PLAN_SLOT_MIN))
      const windowEnd = Math.min(N, Math.floor((Math.min(le, endMin) - startMin) / PLAN_SLOT_MIN))
      // With no acclimatised member the crew rate is the acclimatisation-schedule rate: RAL and the next-stricter tier.
      const allow = hours.map((h, hi) => {
        const useTables = tablesFor(task, hi)
        if (useTables && crewMonitored) tablesUsed.add(`${index}|${hi}`)
        return computeAllowance(task.workClass, task.inSun, workW, cavC, binding.limit, useTables, h, pack, restSetting, accMembers.length === 0)
      })
      return {
        task,
        index,
        valid: need > 0,
        need,
        workW,
        waterW,
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

    // ── Placement, then the ISO 7933 screen of the planned day (PHS_SCREEN): passes with re-placement, verification ──
    const refAcclimatized = accMembers.length > 0
    const specsFor = (clothing: ClothingId): ScreenSpec[] =>
      tasks.map((tc) => ({ task: tc.task, location: tc.location, clothing: tc.task.clothing !== undefined && tc.task.clothing in CLOTHING ? tc.task.clothing : clothing }))
    /** The crew layout as screen segments: each block's part of one clock hour (= BlockHour), idle stretches per hour. */
    const segmentsOfSlots = (): CrewSeg[] => {
      const segs: CrewSeg[] = []
      let k = 0
      while (k < N) {
        const hi = hourIdx(k)
        const ti = slotTask[k]
        let k1 = k
        while (k1 + 1 < N && hourIdx(k1 + 1) === hi && slotTask[k1 + 1] === ti) k1 += 1
        let planned = 0
        if (ti >= 0) for (let j = k; j <= k1; j++) planned += slotWork[j]
        segs.push({ m0: k * PLAN_SLOT_MIN, wall: (k1 - k + 1) * PLAN_SLOT_MIN, ti, hi, planned, k0: k, k1 })
        k = k1 + 1
      }
      return segs
    }
    /** Applies a screened rate to a segment's slots (0 → the slots become idle). */
    const applyRate = (seg: CrewSeg, r: number): void => {
      const perSlot = (r / 60) * PLAN_SLOT_MIN
      for (let j = seg.k0; j <= seg.k1; j++) {
        slotRate[j] = r
        slotWork[j] = Math.min(slotWork[j], perSlot)
        if (r <= 0) {
          slotTask[j] = -1
          slotWork[j] = 0
          slotRate[j] = 0
        }
      }
    }
    const notFeasible = new Map<number, Set<number>>()
    const addNotFeasible = (ti: number, hi: number): void => {
      const set = notFeasible.get(ti) ?? new Set<number>()
      set.add(hi)
      notFeasible.set(ti, set)
    }
    let placementWarnings = placeAll()
    let passes = 0
    let verificationCuts = 0
    let restLimitT: number | null = null
    /** The last pass's screened rate per task-hour `${ti}|${hi}` (min over its segments). */
    const lastRate = new Map<string, number>()
    if (climateAt !== null) {
      const crewSpecs = specsFor(crewClothing)
      // A task outside the model's scope (vapour barrier) is not screened itself (the device neither projects nor holds
      // during it); the rest after it is, from the surrogate-stepped state, as on the device.
      const inScope = (ti: number): boolean => CLOTHING[crewSpecs[ti].clothing].phs.applicable
      const md = screenModel({ M: N * PLAN_SLOT_MIN, startT: slotT(0), climateAt, specs: crewSpecs, restLocation: phsRestLocation, restClothing: crewClothing, acclimatized: refAcclimatized })
      const restFail = restOnlyFailure(md)
      if (restFail !== null) {
        // Rest alone fails within the shift: work only adds heat and sweat, so no plan avoids a device stop — no work.
        restLimitT = slotT(0) + restFail * MINUTE_MS
        for (const row of phsCap) row.fill(0)
        placementWarnings = placeAll()
      } else {
        for (;;) {
          const segs = segmentsOfSlots()
          const res = screenPass(md, segs, (seg) => slotRate[(seg as CrewSeg).k0], Infinity)
          passes += 1
          lastRate.clear()
          let lowered = false
          segs.forEach((seg, i) => {
            if (seg.ti < 0) return
            const key = `${seg.ti}|${seg.hi}`
            if (inScope(seg.ti)) lastRate.set(key, Math.min(lastRate.get(key) ?? Infinity, res.rate[i]))
            if (!res.cut[i]) return
            const r = res.rate[i]
            if (r < phsCap[seg.ti][seg.hi]) {
              phsCap[seg.ti][seg.hi] = r
              lowered = true
            }
            if (r < PHS_SCREEN.minBoutMin) addNotFeasible(seg.ti, seg.hi)
            applyRate(seg, r)
          })
          if (!lowered || passes >= PHS_SCREEN.maxPasses) break
          placementWarnings = placeAll() // re-place with the lowered allowances; the next pass screens it again
        }
        // Verification of the final layout: nothing to do when the passes converged (a safety net otherwise).
        for (;;) {
          const segs = segmentsOfSlots()
          const v = verifyLayout(md, segs, segs.map((s) => (s.ti >= 0 ? Math.min(s.wall, Math.floor(s.planned + 1e-6)) : 0)))
          if (v === null) break
          if (v.zero === null) {
            // Rest alone fails (not expected after restOnlyFailure): no work at all (fail-safe).
            restLimitT = slotT(0) + v.m * MINUTE_MS
            for (const row of phsCap) row.fill(0)
            placementWarnings = placeAll()
            break
          }
          const seg = segs[v.zero]
          phsCap[seg.ti][seg.hi] = 0
          addNotFeasible(seg.ti, seg.hi)
          applyRate(seg, 0)
          verificationCuts += 1
        }
      }
      // What the screened schedule actually completes.
      scheduled.fill(0)
      for (let k = 0; k < N; k++) if (slotTask[k] >= 0) scheduled[slotTask[k]] += slotWork[k]
    }
    warnings.push(...placementWarnings)
    const phsMinOf = (ti: number, hi: number): number | null => {
      if (climateAt === null) return null
      const v = Math.min(lastRate.get(`${ti}|${hi}`) ?? Infinity, phsCap[ti][hi])
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
    if (restLimitT !== null) {
      warnings.push({
        code: 'phs_rest_limit',
        crewId: crew.id,
        hours: [hourLabel(Math.floor((restLimitT - dayStartT) / HOUR_MS))],
        text: `Crew ${crew.id}: even resting in ${restLabel}, the heat-strain screen (ISO 7933, reference worker, no logged drinking) reaches its limit margin at ${localHhmm(restLimitT, dayStartT)}: devices would stop resting workers then, and any work would bring that earlier, so no heat work is planned for this shift. Provide a cooled rest area (ADOSH-SF CoP 11.0 §3.2(c)), have workers log their drinks on the device (logged intake raises the water-loss limit), or shorten the shift to end before ${localHhmm(restLimitT, dayStartT)}.`,
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
          : restLimitT !== null
            ? `${tc.task.name} not scheduled: even resting, the heat-strain screen reaches its limit margin at ${localHhmm(restLimitT, dayStartT)}, so no heat work is planned for this shift (see the rest-limit warning).`
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

    // ── Personal caps of members on an acclimatisation schedule (MemberCapHour) ──
    // Each follows the crew layout with at most: the crew rate; NIOSH RAL with their own size and clothing (task PPE
    // overrides) and the pack's next-stricter work/rest tier (the device applies both to workers new to the site or
    // back from an absence — clinical.conservativeMode reasons new_worker_14d / returning_after_absence, which members
    // on a schedule meet except on day 14 of the new-employee schedule, where the cap is stricter than the device;
    // status-based here, no private input [ENG, protective]); no work where the
    // ADOSH TWL zone excludes unacclimatised persons (TG v4.0 Table 1 note b members); the exposure ramp; and the ISO
    // 7933 screen with an unacclimatised reference worker (passes until nothing is cut, then verification). The plan
    // shows the cap, never the history or the reason.
    const crewSegs = segmentsOfSlots()
    const segOfSlot = new Int32Array(N)
    crewSegs.forEach((s, i) => segOfSlot.fill(i, s.k0, s.k1 + 1))
    const crewBouts = crewSegs.map((s) => (s.ti >= 0 ? Math.min(s.wall, Math.floor(s.planned + 1e-6)) : 0))
    const crewBoutTotal = crewBouts.reduce((s, b) => s + b, 0)
    const memberCaps: Record<string, MemberCapHour[]> = {}
    const memberWorkMin: Record<string, number> = {}
    const memberSegBouts = new Map<string, number[]>()
    const capWarnings: PlanWarning[] = []
    for (const m of members) {
      if (isAcclimatizedMember(m)) {
        memberWorkMin[m.id] = crewBoutTotal
        continue
      }
      const ralCache = new Map<string, Allowance>()
      const ralOf = (ti: number, hi: number): Allowance => {
        const key = `${ti}|${hi}`
        const hit = ralCache.get(key)
        if (hit !== undefined) return hit
        const task = tasks[ti].task
        const v = computeAllowance(task.workClass, task.inSun, taskMetabolicW(task, m.massKg), clothingAdjustmentC(task.clothing ?? m.clothing, task.hood === true), 'RAL', true, hours[hi], pack, restSetting, true)
        ralCache.set(key, v)
        return v
      }
      const ralCap = (ti: number, hi: number): number => ralOf(ti, hi).allowedMin
      // Rest itself above this member's limit (NIOSH RAL at rest in the rest area, own size and clothing): the device
      // stops the member even at rest (risk.ts environment channel), so the supervisor is told where the crew-level
      // warning does not already say so — the schedule and the hours, never the reason.
      const restOver = hours.map((_, hi) => hi).filter((hi) => !tasks.some((t) => t.allow[hi].restExceedsLimit) && tasks.some((t) => t.valid && ralOf(t.index, hi).restExceedsLimit))
      if (restOver.length > 0) {
        const labels = restOver.map((hi) => hourLabel(hours[hi].hourOfDay))
        capWarnings.push({
          code: 'rest_exceeds_limit',
          crewId: crew.id,
          workerIds: [m.id],
          hours: labels,
          text: `${m.id} (acclimatisation schedule): even rest in ${restLabel} exceeds this member's exposure limit at ${labels.join(', ')} — no heat work for this member then, and the device asks for a cooler place to rest; provide a cooler rest area (ADOSH-SF CoP 11.0 §3.2(i)).`,
        })
      }
      const preCap = crewSegs.map((s) => (s.ti < 0 ? 0 : Math.min(slotRate[s.k0], ralCap(s.ti, s.hi), m.adoshUnacclimatized && exclusion(tasks[s.ti], s.hi).excluded ? 0 : Infinity)))
      // Exposure ramp: risk.ts stops hot work once today's hot-work minutes reach maxExposureFraction × 480, so the
      // planned bouts stay strictly below that (whole minutes).
      const budget = m.maxExposureFraction < 1 ? Math.max(0, Math.ceil(m.maxExposureFraction * RISK_THRESHOLDS.environment.budgetShiftMin - 1e-9) - 1) : Infinity
      const phsSegCap = new Map<number, number>()
      const capOf = (_s: ScreenSeg, i: number): number => Math.min(preCap[i], phsSegCap.get(i) ?? Infinity)
      const boutsNow = (): number[] => {
        let left = budget
        return crewSegs.map((s, i) => {
          if (s.ti < 0) return 0
          const b = boutOf(s, capOf(s, i), left)
          left -= b
          return b
        })
      }
      if (climateAt !== null && crewBoutTotal > 0) {
        const mClothing = worstClothing([m])
        const mmd = screenModel({ M: N * PLAN_SLOT_MIN, startT: slotT(0), climateAt, specs: specsFor(mClothing), restLocation: phsRestLocation, restClothing: mClothing, acclimatized: false })
        const restFail = restOnlyFailure(mmd)
        if (restFail !== null) {
          crewSegs.forEach((_, i) => phsSegCap.set(i, 0))
          const at = localHhmm(slotT(0) + restFail * MINUTE_MS, dayStartT)
          capWarnings.push({
            code: 'phs_rest_limit',
            crewId: crew.id,
            workerIds: [m.id],
            hours: [hourLabel(Math.floor((slotT(0) + restFail * MINUTE_MS - dayStartT) / HOUR_MS))],
            text: `${m.id} (acclimatisation schedule): even resting in ${restLabel}, the heat-strain screen (ISO 7933, unacclimatised reference worker, no logged drinking) reaches its limit margin at ${at}, so no heat work is planned for this member this shift. Provide a cooled rest area or end this member's shift before ${at}.`,
          })
        } else {
          for (let p = 0; p < PHS_SCREEN.maxPasses; p++) {
            const res = screenPass(mmd, crewSegs, capOf, budget)
            let cut = false
            res.cut.forEach((c, i) => {
              if (!c) return
              phsSegCap.set(i, Math.min(phsSegCap.get(i) ?? Infinity, res.rate[i]))
              cut = true
            })
            if (!cut) break
          }
          for (;;) {
            const v = verifyLayout(mmd, crewSegs, boutsNow())
            if (v === null) break
            if (v.zero === null) {
              crewSegs.forEach((_, i) => phsSegCap.set(i, 0))
              break
            }
            phsSegCap.set(v.zero, 0)
          }
        }
      }
      const bouts = boutsNow()
      memberSegBouts.set(m.id, bouts)
      memberWorkMin[m.id] = bouts.reduce((s, b) => s + b, 0)
      memberCaps[m.id] = crewSegs.flatMap((s, i): MemberCapHour[] =>
        s.ti < 0
          ? []
          : [
              {
                startT: slotT(s.k0),
                hour: hourLabel(hours[s.hi].hourOfDay),
                taskId: tasks[s.ti].task.id,
                wallMin: s.wall,
                workMinPerHour: capOf(s, i),
                boutMin: bouts[i],
                limitedBy: bouts[i] >= crewBouts[i] ? 'crew' : (phsSegCap.get(i) ?? Infinity) < preCap[i] ? 'phs' : 'acclimatization',
              },
            ],
      )
    }

    // ── Water ──
    const waterCache = new Map<string, number>()
    const taskWaterMlH = (tc: TaskCtx, hi: number): number => {
      const key = `${tc.index}|${hi}`
      const hit = waterCache.get(key)
      if (hit !== undefined) return hit
      const a = tc.allow[hi]
      const ml = recommendWaterMlPerHour({
        workW: tc.waterW,
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
            monitored: crewMonitored && !tablesUsed.has(`${tc.index}|${hi}`),
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
      const hoursDetail = [...perHour.values()].map((bh) => ({ ...bh, workMin: round2(bh.workMin), boutMin: Math.min(bh.wallMin, Math.max(0, Math.floor(bh.workMin + 1e-6))) }))
      if (tc) {
        const a = tc.allow[hourIdx(k0)]
        const allowed = slotRate[k0]
        const phsLimited = allowed < a.allowedMin
        if (nonAcc.length > 0) {
          const exHours = [...perHour.keys()].filter((hi) => exclusion(tc, hi).excluded)
          if (exHours.length > 0) {
            const ex = exclusion(tc, exHours[0])
            notes.push(
              `Not yet acclimatised (${nonAcc.join(', ')}): no work in the ${ex.label} (personal cap) — ${ex.shadeOk ? 'reassign to shaded light work' : 'no heat-exposed work; follow the acclimatisation plan'}.`,
            )
          }
        }
        // Personal caps in this block (acclimatisation schedule): the cap, never the history or the reason.
        const capParts: string[] = []
        for (const [id, mb] of memberSegBouts) {
          let mine = 0
          let crewSum = 0
          for (let si = segOfSlot[k0]; si <= segOfSlot[k1]; si++) {
            mine += mb[si]
            crewSum += crewBouts[si]
          }
          if (mine < crewSum) capParts.push(mine === 0 ? `${id} no work` : `${id} ${mine} of ${crewSum} min`)
        }
        if (capParts.length > 0) notes.push(`Acclimatisation schedule (personal caps): ${capParts.join('; ')}.`)
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
        else if (binding.nonAcclimatizedMemberIds.length > 0) notes.push('Buddy system: no lone work for members on an acclimatisation schedule.')
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
    // The schedule and the cap, never the day of the ramp or the exposure fraction (they reveal the history).
    for (const m of members.filter((x) => x.known && x.maxExposureFraction < 1)) {
      warnings.push({
        code: 'acclimatization_ramp',
        crewId: crew.id,
        workerIds: [m.id],
        text: `${m.id}: on an acclimatisation schedule — today's heat work is limited; the plan's personal caps for this member stay within the limit (${dutyBasis}).`,
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
    warnings.push(...capWarnings)
    const crewNotes = [DEVICE_REST_NOTE]
    if (crewMonitored) crewNotes.push(MONITORED_PLAN.note)
    if (planBasis === 'monitored' && accMembers.length > 0 && climateAt === null) {
      crewNotes.push('Monitored plan requested, but the heat-strain screen (ISO 7933) cannot run without air temperature, humidity, radiant and wind values: the WBGT tables apply.')
    }
    if (planBasis === 'monitored' && accMembers.length === 0 && members.length > 0) {
      crewNotes.push('Monitored plan requested, but no member is acclimatised yet: the crew rate follows the WBGT tables and the acclimatisation schedule.')
    }
    if (crewMonitored && tablesUsed.size > 0) {
      crewNotes.push(
        `Hours in which devices cannot confirm monitoring keep the WBGT table limits in this monitored plan: the first ${ECTEMP_RULES.WARMUP_MIN} min of the shift (device warm-up), clothing outside the heat-strain model or without verified values, and work rates or conditions outside its validity range.`,
      )
    }
    if (binding.nonAcclimatizedMemberIds.length > 0) {
      crewNotes.push(`Members on an acclimatisation schedule (${binding.nonAcclimatizedMemberIds.join(', ')}) follow personal caps in this plan (${dutyBasis}).`)
    }
    crewPlans.push({
      crewId: crew.id,
      binding,
      planBasis: crewMonitored ? 'monitored' : 'tables',
      notes: crewNotes,
      memberCaps,
      memberWorkMin,
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
              verificationCuts,
              restLimitT,
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

  // ── Site hour outlook for the strictest crew rate, by the WBGT tables (a monitored plan's device fallback) ──
  const allMembers = input.crews.flatMap((c) => membersOf(c, byId))
  const strictLimit: ExposureLimitId = crewPlans.length === 0 || crewPlans.some((c) => c.binding.limit === 'RAL') ? 'RAL' : 'REL'
  // A crew with no acclimatised member is planned at the acclimatisation-schedule rate (RAL and the next-stricter tier).
  const strictTier = crewPlans.some((c) => c.binding.limit === 'RAL')
  const strictCav = allMembers.length === 0 ? clothingAdjustmentC(undefined) : Math.max(...allMembers.map((m) => clothingAdjustmentC(m.clothing, false)))
  const masses = allMembers.map((m) => m.massKg).filter((v): v is number => v !== undefined && Number.isFinite(v))
  const maxMass = masses.length > 0 ? Math.max(...masses) : undefined
  const outlook: HourOutlook[] = hours.map((h) => {
    const byClass = (inSun: boolean): Record<WorkClass, number> =>
      Object.fromEntries(
        WORK_CLASSES.map((wc) => [wc, computeAllowance(wc, inSun, taskMetabolicW({ workClass: wc }, maxMass), strictCav, strictLimit, true, h, pack, restSetting, strictTier).allowedMin]),
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
      binding: { limit: strictLimit, clothingAdjustmentC: strictCav },
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

/**
 * Naive plan: listed order, continuous work, midday ban only — within the same task windows as every policy (wave 2d:
 * same constraints for every policy; the work-conserving listed order of sim/worldsim.ts listedOrderSchedule). Each
 * 5-min slot the crew works on the first listed task that has work left and whose window (earliestStart/latestEnd ∩
 * shift, as for the planner) is open; a sun task in the midday break pauses (the crew waits, it does not switch task);
 * no open task = idle; work left when a task's window closes is not done.
 */
function naivePlan(
  tasks: readonly TaskCtx[],
  N: number,
  midday: readonly boolean[],
  hourIdx: (k: number) => number,
  slotStartMin: (k: number) => number,
): { blocks: NaiveBlock[]; workMin: number; exposure: number } {
  const blocks: NaiveBlock[] = []
  const remaining = tasks.map((tc) => (tc.valid ? tc.need : 0))
  let workMin = 0
  let exposure = 0
  let open: NaiveBlock | null = null
  let openTask = -1
  let lastK = -2
  for (let k = 0; k < N; k++) {
    const tc = tasks.find((x) => remaining[x.index] > EPS && k >= x.windowStart && k < x.windowEnd)
    if (tc === undefined || (tc.task.inSun && midday[k])) continue
    const w = Math.min(PLAN_SLOT_MIN, remaining[tc.index])
    remaining[tc.index] -= w
    workMin += w
    exposure += Math.max(0, tc.allow[hourIdx(k)].wbgtWorkEffC - tc.limitC) * w
    if (open && openTask === tc.index && lastK === k - 1) {
      open.end = minutesToHhmm(slotStartMin(k) + PLAN_SLOT_MIN)
      open.workMin += w
    } else {
      open = { taskId: tc.task.id, start: minutesToHhmm(slotStartMin(k)), end: minutesToHhmm(slotStartMin(k) + PLAN_SLOT_MIN), location: tc.location, workMin: w }
      openTask = tc.index
      blocks.push(open)
    }
    lastK = k
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
