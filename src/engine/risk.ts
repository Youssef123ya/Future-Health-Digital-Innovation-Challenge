/**
 * Per-worker risk engine — the heart of Zill (ARCHITECTURE.md §5 risk channels and fusion, §6 dwell and latch rules).
 *
 * Six channels, each `{ level, available, drivers }`, built from the wave-1 science modules:
 *   environment (NIOSH/ACGIH WBGT_eff vs REL/RAL, 1-h TWA work–rest) · regulation (MoHRE midday break, ADOSH TWL zones)
 *   · projection (ISO 7933:2023 PHS minutes to limit) · physiology (ECTemp/PSI floors) · symptoms (triage) · hydration.
 * The level is the maximum over available channels. An unavailable channel or a missing input never lowers it
 * (ARCHITECTURE §1.3): unavailable channels sit at 'safe' and are never read as reassurance.
 *
 * Stateful rules (one {@link WorkerEngineState} per worker, stepped about once a minute):
 * - latch: a symptom-, physiology- or hydration-driven stop/emergency persists until a first aider, supervisor or
 *   occupational-health nurse resolves the case AND a later check-in shows no T2+ symptoms; after T2/T3 the worker does
 *   no more hot work that local day;
 * - dwell: the displayed level drops only after the computed level has stayed lower for 10 min; escalation is instant;
 * - PHS: one continuous ISO 7933 state per shift, stepped through work and rest. A reached limit holds the projection
 *   channel at stop until a human-reviewed recovery (rest in a cooled area or shade, a clear check-in, sign-off by a
 *   first aider, supervisor or occupational-health nurse), after which PHS restarts from a conservative post-rest
 *   state (phs_iso7933.md §11.4: rest never "earns back" exposure unless clinically reviewed);
 * - water-loss limit with logged drinking: the ISO 7933 drink-allowed D_max (5 % of body mass of sweat, which implies
 *   ≈ 40 % replacement) becomes min(7.5 %, max(5 %, 3 % + credited logged intake)), never below ISO and never above
 *   the ISO 7933:2004 mean D_max; a reached water-loss limit restarts after the reviewed recovery once the net loss is
 *   ≤ 2 % of body mass ({@link RISK_THRESHOLDS}.hydrationCredit); a drink logged in a step never releases a hold or
 *   skips the reviewed recovery in that step;
 * - projection hold: a projection-driven stop (< 15 min to a limit) stays until the engine's resume check projects
 *   ≥ 25 min for the task the worker returns to (15 + a 10-min minimum bout: an ANSI/ISA-18.2 deadband), with a rest
 *   estimate and a "task not feasible now" flag ({@link RISK_THRESHOLDS}.resume); the release skips the dwell; a task to
 *   resume outside the model's scope is never released by the check (the normal dwell applies);
 * - task hold: a stop that the current task drives through the regulation channel (ADOSH TWL-zone exclusion or
 *   withdrawal, a WBGT stop limit, the midday break) or the environment channel (table stop, acclimatisation budget) —
 *   or that the task to resume meets while a resting worker's device already shows stop — stays while the worker rests,
 *   until the task to resume, assessed at the current conditions, is free of those stops and passes the ISO 7933 resume
 *   check (the engine owns every resume decision; the midday break releases at its end; an exhausted budget not this
 *   shift; a failing resume check hands over to the projection hold) ({@link RISK_THRESHOLDS}.taskHold);
 * - monitored mode (WorkerContext.planBasis 'monitored', occupational-health sign-off): for an acclimatised worker in
 *   standard mode with valid wearable monitoring and an applicable ISO 7933 model, the WBGT tables are a screen (ISO
 *   7243:2017; ACGIH TLV decision flow; NIOSH 2016): the environment level is capped at caution and the projection
 *   and physiology channels enforce; any lapse falls back to the tables in the same step ({@link RISK_THRESHOLDS}.monitoring);
 * - drink reminders follow heat exposure: hot work (and 30 min after it), or rest/idle outside a cooled area at
 *   WBGT_eff ≥ 25.6 °C (clinical.FLUID; TB MED 507 heat category 1);
 * - acclimatisation exposure budget: hot-work minutes today against maxExposureFraction × 480 min [ENG].
 *
 * Rest areas (ARCHITECTURE.md §5): the rest term of the 1-h TWA is the site's rest area — an air-conditioned cabin
 * ({@link COOLED_REST}, ADOSH-SF CoP 11.0 v4.0 §3.2(c)) or, where only shade exists, the modelled shade WBGT.
 *
 * Privacy (ARCHITECTURE.md §1.5, §5): driver texts outside the physiology, symptoms and hydration channels never name
 * the exposure-limit type (REL/RAL), the stricter personal mode, risk flags, medication, fasting, illness or pregnancy.
 *
 * Claims discipline (ARCHITECTURE.md §1.8): occupational-safety decision support only — no clinical judgement, no
 * heat-illness forecast, no body-temperature reading (the ECTemp band is an estimated strain indicator).
 * Pure TypeScript: time and inputs are passed in; no DOM, clock or randomness.
 */
import type {
  ActionId,
  Checkin,
  ChannelId,
  ChannelResult,
  ClinicalTier,
  ClothingId,
  DataQuality,
  EnvSource,
  FluidIntake,
  RiskAssessment,
  RiskDriver,
  RiskLevel,
  SignalQuality,
  Site,
  Task,
  WorkClass,
  WorkerProfile,
} from './types'
import { RISK_ORDER, TIER_TO_LEVEL, maxLevel } from './types'
import type { SiteHeat } from './indices'
import { SITE_HEAT_DRIVER_IDS } from './indices'
import { computeTwl } from './twl'
import {
  CLOTHING,
  DEFAULT_BODY_MASS_KG,
  DEFAULT_CLOTHING,
  DEFAULT_HEIGHT_CM,
  LIMITS_BASIS,
  REST_METABOLIC_W,
  allowedWorkFraction,
  assessAcclimatization,
  clothingAdjustmentC,
  duBoisAreaM2,
  recommendWaterMlPerHour,
  selectExposureLimit,
  taskMetabolicW,
  wbgtEffectiveC,
  type AcclimatizationAssessment,
  type AllowedWorkResult,
} from './limits'
import {
  DEFAULT_RULE_PACK,
  middayBreakWindow,
  regulatoryFloor,
  stricterWorkRest,
  twlWorkCategory,
  type RegulatoryFloor,
  type RulePack,
} from './regulation'
import {
  PHS_DEFAULT_OPTIONS,
  PHS_D_MAX_BODY_MASS_FRACTION,
  PHS_VALIDITY_LIMITS,
  minutesToLimit,
  phsDuBoisAreaM2,
  phsInitialState,
  phsStep,
  phsValidity,
  type PhsInput,
  type PhsOptions,
  type PhsProjectionOptions,
  type PhsState,
  type PhsValidityField,
} from './phs'
import {
  physioMonitorInit,
  physioMonitorStep,
  physiologyLevel,
  type EctempBand,
  type PhysioMinuteInput,
  type PhysioMonitorState,
} from './physio'
import {
  FLUID,
  SYMPTOM_RULES,
  conservativeMode,
  drinkReminderExposure,
  hydrationChannel,
  physioDisabled,
  symptomsChannel,
  type ConservativeModeResult,
  type DrinkReminder,
  type HeatExposure,
} from './clinical'
import { DAY_MS, DUBAI_OFFSET_MS, HOUR_MS, MINUTE_MS } from './time'
// Type-only (erased at runtime: planner.ts imports this module).
import type { PlanBasis } from './planner'

// ═════════════════════════════════════ Public types ═════════════════════════════════════

/**
 * Where the worker is right now: in direct sun, in (engineered) shade, or in a cooled indoor space ('indoor_cool' =
 * an air-conditioned cabin or room, assessed at the {@link COOLED_REST} design conditions — there is no indoor sensor).
 */
export type WorkerLocation = 'sun' | 'shade' | 'indoor_cool'

/** Environmental data status, normally `data/weather.ts` ResolvedEnvironment (assignable as is). */
export interface WorkerEnvStatus {
  source: EnvSource
  ageMin: number | null
  stale: boolean
  confidence: 'high' | 'medium' | 'low'
  /** Fail-safe WBGT margin (°C) added to every WBGT_eff (+1 °C for data older than 24 h). */
  wbgtMarginC: number
  /** Data-quality drivers (channel 'environment'), merged into the assessment. */
  drivers: RiskDriver[]
}

/**
 * Basis of the day plan and of the environment channel (planner.ts PlanBasis, re-exported): 'tables' (default) — the
 * NIOSH/ACGIH WBGT work/rest tables enforce; 'monitored' — a site opt-in with occupational-health sign-off where, for a
 * worker whose monitoring is valid ({@link RISK_THRESHOLDS}.monitoring), the tables are a screen and the worker's own
 * ISO 7933 projection and the physiological strain criteria enforce (ISO 7243:2017 clause 1 / Annex A: above the
 * reference value, reduce the stress or analyse in detail with ISO 7933; ACGIH TLV decision flow: detailed analysis
 * and/or physiological monitoring above the screen; NIOSH 2016 §8: physiological monitoring above the REL).
 */
export type { PlanBasis }

/**
 * Why monitored mode is not in force for a worker planned under it (worker device only: it can reveal consent or
 * health status): 'status' — not acclimatised or in the stricter personal mode; 'consent' — no wearable consent, no
 * wearable, or heart-rate rules off for this worker; 'model' — ISO 7933 not applicable, clothing values unverified or
 * inputs outside its validity range; 'data' — the wearable signal is not valid (warm-up, or too few valid minutes).
 */
export type MonitoringFallbackReason = 'consent' | 'data' | 'model' | 'status'

/** Everything the engine needs about the worker's situation at `now`. */
export interface WorkerContext {
  /** Epoch ms of this evaluation. */
  now: number
  profile: WorkerProfile
  /** Current task; null = resting. */
  task: Task | null
  location: WorkerLocation
  /** Site heat at `now` (`indices.computeSiteHeat`). */
  heat: SiteHeat
  env?: WorkerEnvStatus
  /** Jurisdiction rule pack (default Abu Dhabi). */
  pack?: RulePack
  network: 'online' | 'offline'
  /** Inside fasting hours: PHS drink = 0, no drink reminders, waterMlPerHour = 0 (level logic unchanged). */
  fastingNow?: boolean
  /** False when the worker has no buddy assigned (conservative mode and ADOSH Medium/High zones require one). */
  buddyAssigned?: boolean
  /**
   * The site's rest area (`Site.restArea`, data/sites.ts). 'cooled_cabin' → the rest term of the work/rest TWA uses
   * {@link COOLED_REST} (never hotter than the shade); 'shade' or absent → the modelled shade WBGT (absent = protective
   * default, ARCHITECTURE.md §1.3).
   */
  restArea?: Site['restArea']
  /**
   * The task the worker returns to after rest (the device knows the assignment), used by the resume checks of a
   * projection hold ({@link RISK_THRESHOLDS}.resume) and of a task hold (regulation/environment stops). Absent or null →
   * the current task, else the last task seen this shift (kept in {@link WorkerEngineState.lastTask}) [protective]. Its
   * location is the current one when it is the current task, the last one seen for the last task, else sun/shade from
   * `Task.inSun`.
   */
  resumeTask?: Task | null
  /**
   * The day plan's basis ({@link PlanBasis}); absent → 'tables' (bit-identical to the engine before monitored mode).
   * 'monitored' takes effect per worker and per step only while the monitoring conditions hold
   * ({@link RISK_THRESHOLDS}.monitoring); otherwise the tables apply in the same step.
   */
  planBasis?: PlanBasis
  /**
   * Work minutes per hour the day plan allows for the current task this hour (planner.ts PlanBlock.workMinPerHour,
   * which includes the planner's ISO 7933 screen). When present, assessment.workMinPerHour = min(own allowance,
   * planned) [protective], so the device and the plan show the same work/rest numbers.
   */
  plannedWorkMinPerHour?: number
}

/** A case resolution recorded by a first aider, supervisor or occupational-health nurse. */
export interface CaseResolution {
  by: 'first_aider' | 'supervisor' | 'occ_health'
  t: number
}

/** New inputs for this step (each optional). */
export interface WorkerInputs {
  /** One minute of heart-rate quality/mean (`physio.minuteSqi` or simulator fields); null = a missing minute. */
  physioMinute?: PhysioMinuteInput | null
  checkin?: Checkin
  intake?: FluidIntake
  resolution?: CaseResolution
}

/** The last ISO 7933 projection. */
export interface ProjectionRecord {
  t: number
  /** Minutes to the first limit at `t` (0 = reached, null = beyond the horizon). */
  minutes: number | null
  binding: 'rectal' | 'dehydration' | null
  /** Conditions key (task, location, clothing, hood, drink): a change forces a fresh projection. */
  key: string
  withinLimits: boolean
  failing: PhsValidityField[]
}

/** A clinical latch (symptom-, physiology- or hydration-driven stop/emergency). */
export interface ClinicalLatch {
  /** Highest tier seen while latched (2 → stop, 3 → emergency). */
  tier: ClinicalTier
  channel: ChannelId
  /** When the latch engaged. */
  since: number
  /** Time of the latest triggering evidence (check-in time, or the minute physiology was at T2). */
  lastTriggerT: number
  /** End of the local day of a T2/T3 event: no hot work until then. Survives the clearing of the latch. */
  noHotWorkUntil?: number
  /** Latest valid resolution (≥ lastTriggerT counts). */
  resolvedAt?: number
  resolvedBy?: CaseResolution['by']
  /** Set when resolution + clean re-check cleared the latch; the record is kept for the no-hot-work rule. */
  clearedAt?: number
}

/**
 * An ISO 7933 limit reached this shift and awaiting a human-reviewed recovery (phs_iso7933.md §11.4: no automatic
 * earn-back after t_re ≥ 38 °C "unless clinically reviewed"). Plain data, part of {@link WorkerEngineState}.
 */
export interface PhsRecoveryState {
  /** When the projection first showed the limit as reached. */
  limitT: number
  /** The limit that was reached. */
  binding: 'rectal' | 'dehydration' | null
  /** Start of the current continuous rest bout (null while working or in the sun) [ENG: work or sun restarts it]. */
  boutStartT: number | null
  /** Minutes rested in a cooled indoor space ('indoor_cool') in the current bout. */
  restCooledMin: number
  /** Minutes rested in shade in the current bout. */
  restShadeMin: number
  /** When the current bout first met the rest requirement (null until then). */
  restMetT: number | null
  /** Sign-off by a first aider, supervisor or occupational-health nurse recorded at or after `restMetT`. */
  signoff: CaseResolution | null
}

/**
 * Progress of a pending ISO 7933 recovery review, for the worker screen and the simulator
 * ({@link WorkerStepDetail.phsRecovery}). `needs.*` is true while that requirement is still outstanding.
 */
export interface PhsRecoveryDetail {
  limitT: number
  binding: 'rectal' | 'dehydration' | null
  /** Minutes of the current continuous rest bout since the limit (cooled + shade). */
  restMinSinceLimit: number
  restCooledMin: number
  restShadeMin: number
  /** Share of the rest requirement met: cooled minutes / 30 + shade minutes / 45, capped at 1 [ENG]. */
  restProgress: number
  needs: { rest: boolean; checkin: boolean; signoff: boolean }
  /** False while the restarted model would still be at a limit (see {@link PhsRecoveryDetail.blockedBy}). */
  restartable: boolean
  /**
   * Why a restart would fail now: 'rectal' — the model's own t_re is still ≥ 38 °C (rest continues; the review can
   * complete once it falls); 'dehydration' — the water-loss limit is not yet restored: with drinking allowed, the net
   * loss (sweat − max(credited intake, 0.4 × sweat)) is still above 2 % of body mass, so the worker drinks and rests
   * (logged drinks count, RISK_THRESHOLDS.hydrationCredit); while drinking is restricted (fasting), the ISO 7933
   * no-drink limit is not restored within the shift (the cumulative sweat loss is kept [ENG]), so heat work stays
   * stopped for the rest of the shift; null — restartable.
   */
  blockedBy: 'rectal' | 'dehydration' | null
}

/**
 * A projection-driven stop held until the engine's resume check passes (RISK_THRESHOLDS.resume): set when the
 * projection channel computes stop from minutes < 15 (not a reached limit, which is the recovery review). Plain data,
 * part of {@link WorkerEngineState}.
 */
export interface ProjectionHold {
  /** When the hold engaged. */
  since: number
  /** The task worked when the stop engaged (null = resting). */
  taskId: string | null
  /** Time of the last resume check (null before the first). */
  checkedT: number | null
  /** The task the last resume check projected (null = rest, no task this shift). */
  checkedTaskId: string | null
  /** Minutes to the first limit at the checked task from the current state (null = beyond the 25-min check horizon). */
  resumeMin: number | null
  /** First 5-min rest increment (≤ 60 min) after which the check would pass; null when even 60 min would not. */
  estRestMin: number | null
  /** Even 60 min of rest would not pass the check: a lighter or cooler task is needed. */
  infeasibleNow: boolean
  /** When the rest estimate was last computed in full (it counts down in between; RISK_THRESHOLDS.resume.estimateEveryMin). */
  estT: number | null
  /** Activity key (ProjectionRecord.key) at the last check: the countdown is valid only while it is unchanged. */
  checkKey: string | null
}

/** A channel whose task-dependent stop holds the worker at rest (see {@link TaskHold}). */
export type TaskHoldChannel = 'regulation' | 'environment'

/**
 * What a task hold waits for (driver text and release rule): 'midday_break' — the calendar ban on outdoor work in the
 * sun (release at its end); 'heat_zone' — an ADOSH TWL-zone rule (unacclimatised exclusion, or no ordinary work in the
 * zone); 'wbgt_stop' — a pack's WBGT stop-work limit; 'exposure_limit' — the WBGT table stop (allowed work fraction
 * < 0.25); 'exposure_budget' — today's acclimatisation exposure budget is used up (no release this shift).
 */
export type TaskHoldCause = 'midday_break' | 'heat_zone' | 'wbgt_stop' | 'exposure_limit' | 'exposure_budget'

/**
 * A regulation- or environment-channel stop driven by the current task (or met by the task to resume of a resting
 * worker whose device already shows stop), held while the worker rests until the task to resume — assessed at the
 * current conditions, its location and clothing — is free of those stops and passes the ISO 7933 resume check (the
 * engine owns the resume decision; it replaces the simulator's resumeTaskAllowed of worldsim 1.2.0). While the worker is
 * at a task the hold follows that task's live stops and forces nothing; at a task free of them it ends (normal dwell).
 * Plain data, part of {@link WorkerEngineState}.
 */
export interface TaskHold {
  /** When the hold engaged. */
  since: number
  /** The task worked when the stop engaged. */
  taskId: string | null
  /** Channels that stop the task to resume at the last check (the channels held at stop). */
  heldBy: TaskHoldChannel[]
  /** What the hold waits for, at the last check. */
  causes: TaskHoldCause[]
  /** Time of the last check (null before the first). */
  checkedT: number | null
  /** The task the last check assessed (null = no task to resume). */
  checkedTaskId: string | null
  /** Earliest time a release can happen: the midday-break end, the next step, or null (no release this shift). */
  nextCheckT: number | null
  /** No release this shift for the task to resume (acclimatisation budget used up): a non-hot task is needed. */
  infeasible: boolean
}

/** The task released by the last resume check (bout countdown on the worker screen). */
export interface ResumeBout {
  taskId: string | null
  releasedT: number
}

/** A de-escalation dwell track: the displayed level and the pending lower level (ARCHITECTURE.md §6). */
export interface DwellTrack {
  displayed: { level: RiskLevel; since: number }
  pending: { level: RiskLevel; since: number } | null
}

/** A channel that holds the worker at rest until its resume check passes. */
export type ResumeHolder = 'projection' | TaskHoldChannel

/**
 * Resume state for the worker's own screen and the simulator ({@link WorkerStepDetail.resume}); null when there is no
 * hold, no release this step and no bout countdown. The engine owns every resume decision: a resting worker may resume
 * when `held` is false (the displayed level then follows the other channels).
 */
export interface ResumeDetail {
  /** A projection or task hold is active after this step (heldBy is not empty). */
  held: boolean
  /** The holds active after this step: 'projection' (ISO 7933 resume check), 'regulation' and/or 'environment' (task hold). */
  heldBy: ResumeHolder[]
  /** The task the resume checks assess (a hold) or the task released (the countdown); null = no task. */
  taskId: string | null
  /** True when the resume checks passed (the release step and the countdown that follows). */
  ready: boolean
  /** "About N min of work left before the next rest": floor(minutes to the limit − 15) while 15–45 min after a release. */
  boutMin: number | null
  /** Estimated rest before the projection check passes (5-min increments up to 60 min; 0 at the release); null when unknown. */
  estRestMin: number | null
  /** No release now for the task to resume: even 60 min of rest would not pass the projection check, or today's acclimatisation budget is used up. */
  infeasibleNow: boolean
  /**
   * Earliest time of the next check that could release the holds (the later of the active holds): the next projection
   * cycle, the midday-break end, or the next step; null when no release is possible this shift for the task to resume.
   */
  nextCheckT: number | null
}

/**
 * The environment channel's basis for the worker's own screen, the UI and the simulator ({@link WorkerStepDetail.environment}).
 * `enforced` says whether the NIOSH/ACGIH table work/rest cycle limits work minutes this step.
 */
export interface EnvironmentDetail {
  /** The plan basis in the context ('tables' when absent). */
  basis: PlanBasis
  /** Monitored mode is in force this step (basis 'monitored' and every monitoring condition holds). */
  monitored: boolean
  /** The table work/rest cycle is enforced (always under 'tables'; under 'monitored' while monitoring is not valid). */
  enforced: boolean
  /** The table cycle's work minutes per hour when the tables limit work (allowed fraction < 1), else null. Shown as a guide while monitored. */
  workMinPerHour: number | null
  /** Why monitored mode is not in force for a worker planned under it (worker device only); null otherwise. */
  fallbackReason: MonitoringFallbackReason | null
}

/**
 * Drink reminders this step ({@link WorkerStepDetail.drink}): reminders follow heat exposure (clinical.drinkReminderExposure).
 * The simulator's reminder is `reminder === 'drink'`.
 */
export interface DrinkReminderDetail {
  /** Heat exposure for reminders: hot work (or within 30 min after it), or rest/idle outside a cooled area at WBGT_eff ≥ 25.6 °C. */
  exposed: boolean
  exposure: HeatExposure
  /** 'drink': a 250 mL reminder is due now; 'shade': fasting while exposed — rest-in-shade guidance instead; null: none. */
  reminder: DrinkReminder
  /** When the next 250 mL reminder is due while exposed (≤ now = due now); null while reminders are suppressed. */
  nextReminderAtMs: number | null
  /** WBGT_eff at the worker's location in their resting clothing (+ data margin), °C — the rest/idle exposure input. */
  locationWbgtEffC: number
}

/**
 * Water balance behind the water-loss limit, for the worker's own screen only (clinical: never projected to a
 * supervisor). Volumes in litres (1 g of water ≈ 1 mL [ENG]).
 */
export interface PhsWaterDetail {
  /** Cumulative ISO 7933 water loss this exposure (sweat and respiration). */
  sweatLossL: number
  /** Credited logged intake since the shift start (0.8 × Σ per-hour min(logged, hourly cap)); 0 without consent. */
  creditedIntakeL: number
  /** Net loss as % of body mass: sweat − max(credit, 0.4 × sweat) with drinking allowed; sweat − credit when restricted. */
  netLossPctBM: number
  /**
   * The water-loss threshold applied: min(7.5 %, max(5 %, 3 % + credit)) of body mass, or the ISO 3 % while drinking is
   * restricted.
   */
  thresholdL: number
  /** Drinking restricted (fasting now or earlier this exposure): the ISO 7933 drink = 0 criterion applies unchanged. */
  restricted: boolean
  /** The credit raises the threshold above the ISO 7933 5 % (electrolytes are then recommended). */
  extended: boolean
  /** The threshold is at the 7.5 % ceiling (ISO 7933:2004 mean D_max): more logged drinking no longer extends it. */
  capped: boolean
}

/** Plain, serialisable per-worker state. */
export interface WorkerEngineState {
  workerId: string
  /** Start of the current shift / exposure (PHS reset point). */
  shiftStartT: number
  /** Time of the last step. */
  lastT: number
  /** Time the PHS state corresponds to (advanced in whole minutes). */
  phsT: number
  /** ISO 7933 state; null until the first step of the shift. */
  phs: PhsState | null
  projection: ProjectionRecord | null
  physio: PhysioMonitorState
  /** Check-ins of the last 12 h, oldest first. */
  checkins: Checkin[]
  /** Fluid intakes of the last 24 h, oldest first. */
  intakes: FluidIntake[]
  latch: ClinicalLatch | null
  /** Hot-work minutes (working, not in a cooled space) in the local day starting at `dayStartT`. */
  hotWorkMinToday: number
  dayStartT: number
  /** First hot-work minute today (electrolyte advice after 2 h of sweating). */
  sweatingSinceT: number | null
  displayed: { level: RiskLevel; since: number }
  pending: { level: RiskLevel; since: number } | null
  lastAssessment: RiskAssessment | null
  /** A reached ISO 7933 limit awaiting a reviewed recovery; null otherwise (reset at a new shift). */
  phsRecovery: PhsRecoveryState | null
  /** When PHS last restarted from the post-rest state after a reviewed recovery (null if never this shift). */
  phsRestartedAt: number | null
  /** A projection-driven stop held until the resume check passes (null otherwise; reset at a new shift). */
  projectionHold: ProjectionHold | null
  /** The last task seen this shift and where it was done (the resume task when none is given; reset at a new shift). */
  lastTask: { task: Task; location: WorkerLocation } | null
  /** The task released by the last resume check, for the bout countdown (null otherwise). */
  resumeBout: ResumeBout | null
  /**
   * Dwell track of the fused level without the projection channel and without a task hold's forced stop (the live
   * regulation and environment levels): a resume release (projection or task hold) drops to it at once.
   */
  dwellExProjection: DwellTrack
  /**
   * Dwell track of the fused level without a task hold's forced stop (the live regulation and environment levels; the
   * projection channel included): a task-hold release drops to it at once, so the projection's and the other channels'
   * own dwell still applies. Missing in older states (then the fused track: protective).
   */
  dwellExTaskHold: DwellTrack
  /** A regulation/environment stop driven by the task, held until its resume check passes (null otherwise; reset at a new shift). */
  taskHold: TaskHold | null
  /** Last step at which monitored mode was in force this shift (null if never): a later lapse shows the fallback driver. */
  monitorValidT: number | null
  /** Last hot-work minute this shift (drink reminders continue 30 min after it; null if none). */
  lastHotWorkT: number | null
}

/** Engine options (defaults in {@link RISK_THRESHOLDS}). */
export interface WorkerEngineOptions {
  /** Minutes between PHS projections (default 5). Task/location/clothing changes force one immediately. */
  projectionEveryMin?: number
  /** PHS projection horizon (default 120 min). */
  horizonMin?: number
  /** De-escalation dwell (default 10 min). */
  dwellMin?: number
  /** Longest gap simulated by PHS in one step (default 60 min) [ENG]. */
  maxCatchUpMin?: number
  /** A gap at least this long starts a new shift: PHS and the heart-rate monitor restart (default 360 min) [ENG]. */
  newShiftGapMin?: number
}

/** Options of {@link createWorkerEngine}. */
export interface CreateWorkerEngineOptions {
  /** Seated pre-work HR baseline for PSI (physio.psiHrBaseline); else the first 5 usable minutes. */
  seatedHr0Bpm?: number | null
  /** Initial ECTemp (default 37.1 °C). */
  ct0C?: number
}

/** Extra detail for the worker's own screen and the simulator (not for supervisors: it holds clinical items). */
export interface WorkerStepDetail {
  /** Fused level before the dwell rule. */
  computedLevel: RiskLevel
  /** True while the dwell rule holds the displayed level above the computed one. */
  held: boolean
  acclimatization: AcclimatizationAssessment
  conservative: ConservativeModeResult
  allowedWork: AllowedWorkResult
  regulation: RegulatoryFloor
  projection: ProjectionRecord | null
  phsApplicable: boolean
  phsWithinLimits: boolean
  /** ECTemp band for the worker's own screen (null when hidden). */
  physioDisplay: EctempBand | null
  hotWorkMinToday: number
  hotWorkBudgetMin: number | null
  latch: ClinicalLatch | null
  workW: number
  wbgtWorkEffC: number
  wbgtRestEffC: number
  /** Rest area used for the rest term (absent context value → 'shade'). */
  restArea: Site['restArea']
  /** Rest-area WBGT before the clothing adjustment and the data margin, °C. */
  restWbgtC: number
  /** Conservative mode's next-stricter work/rest tier lowered the regulation minutes (ARCHITECTURE.md §5). */
  stricterTierApplied: boolean
  /** Pending ISO 7933 recovery review (null when no limit is pending). */
  phsRecovery: PhsRecoveryDetail | null
  /** When PHS last restarted after a reviewed recovery (null if never this shift). */
  phsRestartedAt: number | null
  /** Water balance behind the water-loss limit (worker device only; null before the first PHS state). */
  water: PhsWaterDetail | null
  /** Projection and task holds, resume checks and bout countdown (null when none of them applies). */
  resume: ResumeDetail | null
  /** The day plan's work minutes per hour lowered the work minutes (WorkerContext.plannedWorkMinPerHour). */
  plannedCapApplied: boolean
  /** The environment channel's basis: tables or monitored mode, whether the table cycle is enforced, and why not monitored. */
  environment: EnvironmentDetail
  /** Heat exposure and drink reminders this step. */
  drink: DrinkReminderDetail
}

/** Result of one engine step. */
export interface WorkerStepResult {
  state: WorkerEngineState
  assessment: RiskAssessment
  detail: WorkerStepDetail
}

// ═════════════════════════════════════ Thresholds and ids ═════════════════════════════════════

/** Every threshold the engine applies itself, with its basis (the science modules carry their own). */
export const RISK_THRESHOLDS = {
  environment: {
    /** f ≥ 1 with at least this margin (°C) below the limit → safe; less → caution. */
    safeMarginC: 1,
    cautionMinWorkFraction: 0.75,
    highMinWorkFraction: 0.25,
    restMetabolicW: REST_METABOLIC_W,
    /** Exposure budget = maxExposureFraction × 480 min [ENG]. */
    budgetShiftMin: 480,
    basis: 'ARCHITECTURE.md §5 environment channel; NIOSH 2016 §8.1; ACGIH TLV Heat Stress; ISO 7243:2017',
  },
  projection: {
    horizonMin: 120,
    everyMin: 5,
    /** > 90 min → safe; 45–90 → caution; 15–45 → high; < 15 or reached → stop. Boundaries resolve to the more
     * protective level [ENG]: exactly 90 → caution, exactly 45 or 15 → high. */
    safeAboveMin: 90,
    cautionAboveMin: 45,
    highFromMin: 15,
    /** PHS air speed is clamped to the ISO 7933:2023 validity range (0–3 m/s). */
    maxAirSpeedMs: PHS_VALIDITY_LIMITS['7933-2023'].vMs.max,
    basis: 'ISO 7933:2023 Annex B limits (t_re 38 °C, dehydration); ARCHITECTURE.md §5 projection channel',
  },
  dwell: { dwellMin: 10, basis: 'ARCHITECTURE.md §6: escalate immediately; de-escalate after a 10-min dwell [ENG]' },
  steps: {
    maxCatchUpMin: 60,
    newShiftGapMin: 360,
    checkinHistoryH: 12,
    intakeHistoryH: 24,
    conservativeCheckinEveryMin: 30,
    basis: '[ENG] engine bookkeeping; conservative check-ins every 30 min from caution (physio_and_clinical.md §10.9)',
  },
  recovery: {
    /** Continuous rest in a cooled indoor space before a reached ISO 7933 limit may be reviewed [ENG]. */
    cooledRestMin: 30,
    /** The same in shade (slower heat loss) [ENG]; mixed bouts count cooled/30 + shade/45. */
    shadeRestMin: 45,
    /** Core temperatures (t_re, t_cr, t_cr,eq) of the restarted PHS state, °C — never below the model's own [ENG]. */
    restartCoreC: 37.5,
    /** How long the 'phs_restarted_after_review' notice stays on the projection channel [ENG]. */
    restartedNoticeMin: 60,
    basis:
      'phs_iso7933.md §11.4 (no earn-back after t_re ≥ 38 °C unless clinically reviewed); ISO 7933:2023 clause 5 WARNING; [ENG] ≥ 30 min rest in a cooled area or ≥ 45 min in shade — passive cooling ≈ 0.04 °C/min (physio_and_clinical.md §5.3: Lu16, Ho17) gives ≈ 1.2 °C in 30 min; restart from t_re = t_cr = t_cr,eq = 37.5 °C',
  },
  hydrationCredit: {
    /** Share of the logged intake credited [ENG: self-reported intake may over-state what was drunk]. */
    creditFactor: 0.8,
    /** Per local clock hour, logged intake counts up to the hourly fluid cap (1.5 US qt ≈ 1.42 L; TB MED 507). */
    hourlyCapL: FLUID.HOURLY_CAP_L,
    /** ISO 7933 drink-allowed D_max: cumulative water loss of 5 % of body mass. The threshold never drops below it. */
    isoLossFraction: PHS_D_MAX_BODY_MASS_FRACTION.percentile95,
    /**
     * Net-loss criterion once logged drinking exceeds the ISO-implied replacement: 3 % of body mass of loss not
     * replaced by credited intake (the ISO 7933 drink-restricted D_max applied to the net loss; ACSM 2007).
     */
    netLossFraction: PHS_D_MAX_BODY_MASS_FRACTION.drinkRestricted,
    /** Replacement the ISO drink-allowed D_max implies: 5 % of sweat ≈ 3 % net, i.e. 1 − 3/5 = 0.4 of the sweat. */
    isoImpliedReplacement: 0.4,
    /** A reached water-loss limit may restart (after the reviewed recovery) once the net loss is ≤ 2 % of body mass [ENG]. */
    restartNetLossFraction: 0.02,
    /**
     * Ceiling of the credited threshold: 7.5 % of body mass, the ISO 7933:2004 mean-subject D_max (D_max50)
     * [ASSUMPTION, protective: beyond it the sodium losses and the 8-h validity of the D_max values are not covered].
     */
    maxLossFraction: PHS_D_MAX_BODY_MASS_FRACTION.mean2004,
    /** Only drinks logged within 15 min of the drink time (either side) count toward the credit [ENG: no back-dated or pre-logged credit]. */
    maxLogDelayMin: 15,
    basis:
      'ISO 7933:2023 Annex B (D_max 5 % of body mass with drinking, 3 % without); the 5 % drink-allowed limit implies ≈ 40 % replacement (5 % sweat ≈ 3 % net); ACSM 2007 fluid replacement position stand (avoid > 2 % body-mass loss; 3 % net as the limit here); TB MED 507 (2022) hourly cap 1.5 qt; ISO 7933:2004 D_max50 7.5 % of body mass as the ceiling [ASSUMPTION, protective: sodium losses and the 8-h D_max validity are not covered beyond it]; [ENG] credit 0.8 × Σ_hours min(logged, hourly cap) since the shift start over drinks logged within 15 min of the drink time — self-report may over-state intake; threshold min(7.5 %, max(5 %, 3 % + credit)), never below ISO; electrolytes recommended while the credit extends it beyond 5 %; no further intake assumed in projections; a drink logged in a step counts from the next step for releases and the limit check; restart at net loss ≤ 2 % (1 % deadband below the 3 % criterion)',
  },
  resume: {
    /**
     * Shortest useful work bout after a projection stop [ENG]: the hold releases when the task to resume projects at
     * least highFromMin + minBoutMin = 25 min to the limit (ANSI/ISA-18.2 alarm deadband), so a rested worker is not
     * stopped again within 10 min at constant conditions.
     */
    minBoutMin: 10,
    /** Rest estimate: rest simulated at the rest location in 5-min increments [ENG]. */
    restStepMin: 5,
    /** ... up to 60 min; beyond that the task is "not feasible now" [ENG]. */
    restMaxMin: 60,
    /**
     * The full rest estimate is recomputed at most this often while the worker keeps resting at the same place for the
     * same task; in between it counts down with the rest taken (exact at constant conditions) [ENG: performance — the
     * release check itself runs every projection cycle].
     */
    estimateEveryMin: 15,
    basis:
      'ANSI/ISA-18.2 alarm management (deadband between alarm set and clear); ARCHITECTURE.md §6 (de-escalate after a dwell plus a hysteresis margin); ISO 7933:2023 projection at the task to resume; [ENG] minimum work bout 10 min, rest estimate in 5-min steps up to 60 min, the resume check replaces the dwell for the projection channel',
    /** The resume check never passes for a task outside the ISO 7933 scope (vapour barrier): the hold ends without the release shortcut (normal dwell). */
    outOfScopeBasis: 'Safety review 2c (LOW): never released without a passing projection or the dwell [ENG, protective]; ISO 7933:2023 scope',
  },
  taskHold: {
    /**
     * The task hold's resume check runs every step against the task to resume at the current conditions (no margin on
     * the regulation/environment stops: they are deterministic at constant conditions, so a release cannot flap; the
     * ISO 7933 resume check of the release adds the minimum work bout) [ENG].
     */
    checkEveryStep: true,
    basis:
      'Engine-owned resume (wave 2d; replaces the simulator check of worldsim 1.2.0): a regulation-channel stop (ADOSH-SF TG v4.0 Table 1 TWL-zone exclusion of unacclimatised workers or no ordinary work, a pack WBGT stop limit, the MoHRE midday break) or an environment-channel stop (WBGT table stop: allowed work fraction < 0.25; acclimatisation exposure budget) driven by the current task — or met by the task to resume of a resting worker whose device already shows stop — is held while the worker rests, until the task to resume, at the current conditions, its location and clothing, is free of those stops and passes the ISO 7933 resume check (RISK_THRESHOLDS.resume: ≥ 25 min; a failing check hands over to a projection hold); midday break → released at its end; budget used up → no release this shift (rotate task); the release is the hysteresis of that hold (ANSI/ISA-18.2) and skips only its own dwell (held channels count at most HIGH in the other tracks), the other channels keep their 10-min dwell (ARCHITECTURE.md §6); at a task the hold follows the live stops of that task and ends without the shortcut (the normal dwell is the anti-chatter deadband) [ENG]',
  },
  monitoring: {
    /** Recent-data window for valid monitoring: at least minValidInWindow SQI-valid minutes in the last recentWindowMin [ENG]. */
    recentWindowMin: 5,
    minValidInWindow: 4,
    basis:
      'ISO 7243:2017 (WBGT reference values are a screen: above them reduce the stress or carry out a detailed analysis with ISO 7933); ACGIH TLV Heat Stress decision flow (detailed analysis and/or physiological monitoring above the screen); NIOSH 2016 §8 (physiological monitoring above the REL); [ENG] monitoring valid only while: plan basis monitored (occupational-health sign-off); acclimatised and not in the stricter personal mode; wearable consented, worn and heart-rate rules on; the physiology channel valid (30-min warm-up, ≥ 10 of 15 valid minutes) and ≥ 4 of the last 5 minutes SQI-valid; ISO 7933 applicable, verified clothing values and inputs within its validity range; then the environment level is capped at caution and the table cycle is a guide; any lapse restores the table level in the same step',
  },
} as const

/**
 * Conservative design conditions of an air-conditioned rest cabin [ENG] (ADOSH-SF CoP 11.0 v4.0 §3.2(c) "cooled and
 * air-conditioned rest areas"; §3.2(b)(vii) cooled shelter during the midday break). A room at 26 °C / 55 % RH with
 * walls near air temperature is ≈ 21–22 °C WBGT (0.7·T_nwb + 0.3·T_g with T_nwb ≈ 20 °C, T_g ≈ 26 °C); 25 °C allows
 * for door openings and crowding. Used (a) as the rest WBGT of the 1-h TWA when `WorkerContext.restArea` is
 * 'cooled_cabin' — never above the outdoor shade WBGT, since shade is always available [ENG] — and (b) as the
 * conditions of an 'indoor_cool' location (environment WBGT, ISO 7933 PHS inputs, TWL zone). There is no indoor
 * sensor: a measured cabin value would replace these design values.
 */
export const COOLED_REST = {
  wbgtC: 25,
  taC: 26,
  rhPct: 55,
  trC: 26,
  vMs: 0.2,
  basis:
    'ADOSH-SF CoP 11.0 v4.0 §3.2(c) cooled and air-conditioned rest areas; §3.2(b)(vii) cooled shelter in the midday break; [ENG] conservative cabin design: 26 °C / 55 % RH ≈ 21–22 °C WBGT, 25 °C allows for door openings and crowding',
} as const

const LATCH_BASIS =
  'ARCHITECTURE.md §1.4 and §6 (symptom- and physiology-driven levels latch until a first aider or supervisor resolves the case after a symptom-free re-check); physio_and_clinical.md §10.7; ACSM 2023'
const NO_HOT_WORK_BASIS =
  'ARCHITECTURE.md §1.4 (after T2/T3 no more hot work that day); TB MED 507 (2022); "in the sun" reading [ENG]'
const PHS_BASIS = 'ISO 7933:2023 Predicted Heat Strain (t_re 38 °C or dehydration limit); ARCHITECTURE.md §5'

/** Driver ids created by this module (stable, for i18n). */
export const RISK_DRIVER_IDS = [
  // environment
  'wbgt_over_limit',
  'wbgt_near_limit',
  'wbgt_within_limit',
  'work_rest_cycle',
  'clothing_adjustment',
  'limit_ral_unacclimatized',
  'limit_ral_acclimatizing',
  'limit_stricter_personal',
  'acclimatization_budget',
  'acclimatization_budget_exhausted',
  'metabolic_rate_extrapolated',
  'wbgt_method_not_applicable',
  'rest_area_cooled',
  'rest_area_shade_only',
  'wbgt_screen_monitored',
  'monitoring_fallback_tables',
  'resume_hold_environment',
  // regulation (engine-applied)
  'stricter_work_rest',
  'resume_hold_regulation',
  // projection
  'phs_minutes_to_limit',
  'phs_limit_reached',
  'phs_beyond_horizon',
  'phs_out_of_validity',
  'phs_clothing_unverified',
  'phs_not_applicable',
  'phs_recovery_not_modelled',
  'phs_recovery_review_required',
  'phs_restarted_after_review',
  'phs_resume_hold',
  'task_not_feasible_now',
  'phs_work_bout',
  // hydration (engine-applied; worker device only)
  'phs_no_drinking',
  'phs_water_credit',
  'phs_drink_to_restart',
  'phs_no_drink_no_restart',
  // plan (engine-applied)
  'work_rest_planned',
  // stateful and fusion
  'clinical_latch',
  'no_hot_work_today',
  'level_held_dwell',
  'step_gap_capped',
  'conservative_checkin_due',
  'buddy_required',
  'lone_work_not_allowed',
  'water_paused_fasting',
  'water_restricted',
  'meter_check_advised',
] as const

/** A driver id created by this module. */
export type RiskDriverId = (typeof RISK_DRIVER_IDS)[number]

const ENV_SOURCES: readonly EnvSource[] = ['site_sensor', 'forecast', 'archive', 'cached_forecast', 'conservative_default']

/** Driver ids produced by wave-1 modules that flow through into assessments (regulation, physio, clinical, data). */
const PASSTHROUGH_DRIVER_IDS: readonly string[] = [
  // regulation.ts
  'twl_zone_high',
  'twl_zone_medium',
  'twl_zone_low',
  'twl_zone_unrestricted',
  'twl_unavailable',
  'ordinary_work_prohibited',
  'permit_to_work',
  'unacclimatized_excluded',
  'unacclimatized_not_alone',
  'acclimatization_programme',
  'midday_break',
  'midday_break_window',
  'wbgt_unavailable',
  'wbgt_stop_limit',
  // physio.ts
  'physio_unavailable_not_consented',
  'physio_unavailable_hr_suppressing_medication',
  'physio_unavailable_no_signal',
  'physio_unavailable_signal_unusable',
  'physio_unavailable_warmup',
  'hr_implausible_high',
  'ectemp_ge_39_0',
  'ectemp_ge_38_4',
  'ectemp_ge_38_0_conservative',
  'ectemp_ge_38_0_advisory',
  'psi_very_high',
  'psi_high',
  'psi_moderate_advisory',
  'hr_over_180_minus_age',
  'hr_limit_age_unknown',
  'physio_no_warning',
  // clinical.ts
  'no_checkin_today',
  'no_symptoms',
  'suspected_hyponatraemia',
  'symptoms_worsening',
  'symptoms_not_improving_30min',
  ...Object.keys(SYMPTOM_RULES).map((s) => `symptom_${s}`),
  'urine_drink_more',
  'urine_dark',
  'urine_dark_persistent',
  'urine_very_dark',
  'urine_ok',
  'fluid_over_daily_cap',
  'fluid_over_hourly_cap',
  'fasting_no_drink_reminders',
  // data/weather.ts resolveEnvironment
  'env_conservative_default',
  'env_data_stale',
  'env_sensor_unavailable',
  'env_series_wrong_site',
  'env_source_no_coverage',
  'env_stale_margin',
  ...ENV_SOURCES.map((s) => `env_source_${s}`),
]

/**
 * Stable list of every driver id an assessment can carry (this module, `indices.ts` and the wave-1 modules whose
 * drivers flow through), for i18n keys. Order is stable; ids are unique.
 */
export const DRIVER_IDS: readonly string[] = [...new Set<string>([...RISK_DRIVER_IDS, ...SITE_HEAT_DRIVER_IDS, ...PASSTHROUGH_DRIVER_IDS])]

/**
 * Action priority for the fused list: emergency first (call 998, cool first, stay with the worker), then stopping
 * (stop work, rest in shade, cool down, first aider, no hot work today), then mitigations (ARCHITECTURE.md §5).
 */
export const ACTION_PRIORITY: readonly ActionId[] = [
  'call_998',
  'cool_first',
  'stay_with_worker',
  'stop_work',
  'rest_shade_now',
  'cool_down',
  'first_aider_check',
  'no_hot_work_today',
  'midday_break',
  'restrict_fluids',
  'medical_evaluation',
  'acclimatization_plan',
  'rotate_task',
  'shade_breaks',
  'reduce_intensity',
  'no_lone_work',
  'buddy_check',
  'symptom_checkin',
  'drink_water',
  'electrolytes',
  'occ_health_review',
  'check_sensor',
]

// ═════════════════════════════════════ Small helpers ═════════════════════════════════════

/** ISO 7933 model options of the engine's PHS state; shared with the planner's PHS screen so both agree exactly. */
export const ENGINE_PHS_OPTIONS: Readonly<PhsOptions> = Object.freeze({ model: PHS_DEFAULT_OPTIONS.model, hcMode: 'tclIteration' as const })
const PHS_OPTS: PhsOptions = ENGINE_PHS_OPTIONS
const MISSING_MINUTE: PhysioMinuteInput = { hrMeanBpm: null, minuteValid: false, rScale: Infinity }
const CHANNEL_ORDER: readonly ChannelId[] = ['environment', 'regulation', 'projection', 'physiology', 'symptoms', 'hydration']
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const
const RANK_TO_CONFIDENCE = ['low', 'medium', 'high'] as const

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const atLeast = (a: RiskLevel, b: RiskLevel): boolean => RISK_ORDER[a] >= RISK_ORDER[b]

/** Epoch ms of the Abu Dhabi local midnight at or before `t` (fixed UTC+4, no DST: exact arithmetic). */
function localDayStart(t: number): number {
  return Math.floor((t + DUBAI_OFFSET_MS) / DAY_MS) * DAY_MS - DUBAI_OFFSET_MS
}

function makeDriver(
  id: RiskDriverId,
  channel: ChannelId,
  text: string,
  direction: RiskDriver['direction'],
  basis: string,
  value?: number,
  unit?: string,
): RiskDriver {
  const d: RiskDriver = { id, channel, text, direction, basis }
  if (value !== undefined && Number.isFinite(value)) d.value = value
  if (unit !== undefined) d.unit = unit
  return d
}

function plainChannel(r: ChannelResult): ChannelResult {
  return { channel: r.channel, level: r.level, available: r.available, drivers: [...r.drivers] }
}

/**
 * One step of the de-escalation dwell (ARCHITECTURE.md §6): escalate at once; drop only after the computed level has
 * stayed lower for `dwellMs`, to the highest level computed in that window.
 */
function dwellStep(track: DwellTrack, computed: RiskLevel, now: number, dwellMs: number): DwellTrack {
  let displayed = track.displayed
  let pending = track.pending
  if (atLeast(computed, displayed.level)) {
    if (computed !== displayed.level) displayed = { level: computed, since: now }
    pending = null
  } else {
    pending = pending === null ? { level: computed, since: now } : { level: maxLevel(pending.level, computed), since: pending.since }
    if (now - pending.since >= dwellMs) {
      displayed = { level: pending.level, since: now }
      pending = atLeast(computed, displayed.level) ? null : { level: computed, since: now }
    }
  }
  return { displayed, pending }
}

/**
 * A resume release on a dwell track: the displayed level drops at once to max(computed, the reference track's displayed
 * level) — the reference track never saw the released hold's stop — carrying its pending dwell when the computed level
 * is lower still. Never raises the level. Pure.
 */
function releaseTrack(track: DwellTrack, computed: RiskLevel, ref: DwellTrack, now: number): DwellTrack {
  const target = maxLevel(computed, ref.displayed.level)
  if (RISK_ORDER[target] >= RISK_ORDER[track.displayed.level]) return track
  return {
    displayed: { level: target, since: now },
    pending: RISK_ORDER[computed] < RISK_ORDER[target] && ref.pending !== null ? { level: maxLevel(ref.pending.level, computed), since: ref.pending.since } : null,
  }
}

/**
 * Credited fluid intake, litres (RISK_THRESHOLDS.hydrationCredit): 0.8 × Σ over local clock hours of
 * min(logged that hour, FLUID.HOURLY_CAP_L), over intakes with fromT ≤ t ≤ toT (and of `workerId` when given) that were
 * logged within 15 min of the drink time (|loggedAt − t| ≤ maxLogDelayMin: neither back-dated nor logged ahead; absent
 * loggedAt = logged at t; a non-finite loggedAt is not credited). Non-positive or non-finite volumes are ignored. Pure.
 */
export function creditedIntakeL(intakes: readonly FluidIntake[], fromT: number, toT: number, workerId?: string): number {
  const H = RISK_THRESHOLDS.hydrationCredit
  const maxDelayMs = H.maxLogDelayMin * MINUTE_MS
  const perHour = new Map<number, number>()
  for (const x of intakes) {
    if (workerId !== undefined && x.workerId !== workerId) continue
    if (!(x.t >= fromT && x.t <= toT) || !(x.ml > 0) || !Number.isFinite(x.ml)) continue
    if (x.loggedAt !== undefined && !(Math.abs(x.loggedAt - x.t) <= maxDelayMs)) continue
    const hour = Math.floor((x.t + DUBAI_OFFSET_MS) / HOUR_MS)
    perHour.set(hour, (perHour.get(hour) ?? 0) + x.ml / 1000)
  }
  let sum = 0
  for (const litres of perHour.values()) sum += Math.min(litres, H.hourlyCapL)
  return H.creditFactor * sum
}

/** The water-loss limit of one step (RISK_THRESHOLDS.hydrationCredit); grams of water (1 g ≈ 1 mL [ENG]). */
interface WaterStatus {
  restricted: boolean
  massKg: number
  /** Cumulative ISO 7933 water loss, computed exactly as phs.ts does. */
  sweatG: number
  creditL: number
  /** ISO 7933 drink-allowed D_max (5 % of body mass), the same expression as phs.ts. */
  isoG: number
  thresholdG: number
  netG: number
  restartMaxNetG: number
  /** The credit raises the threshold above ISO (drinking allowed). */
  extended: boolean
  /** The credited threshold is at the 7.5 % ceiling. */
  capped: boolean
  /** Passed to minutesToLimit when the threshold is above ISO (drinking allowed); undefined = exactly ISO 7933. */
  lossOpts: PhsProjectionOptions | undefined
}

/**
 * Water-loss threshold and net loss for a PHS state (RISK_THRESHOLDS.hydrationCredit): drinking allowed → threshold
 * min(7.5 % BM, max(5 % BM, 3 % BM + credit)), net = loss − max(credit, 0.4 × loss); drinking restricted (drink = 0 now
 * or earlier this exposure) → the ISO 3 % threshold, net = loss − credit. With no credit the threshold is exactly ISO 7933.
 */
function waterStatus(phs: PhsState, input: PhsInput, creditL: number): WaterStatus {
  const H = RISK_THRESHOLDS.hydrationCredit
  const massKg = input.massKg
  const restricted = phs.drinkRestricted || input.drink === 0
  // phs.ts waterLossG: ΣSW·2.67·A_Du/1.8/60 (ISO 7933:2004 NOTE), same operand order so thresholds agree exactly.
  const sweatG = (phs.evapLoadWm2Min * 2.67 * phsDuBoisAreaM2(massKg, input.heightM)) / 1.8 / 60
  const isoG = PHS_D_MAX_BODY_MASS_FRACTION.percentile95 * massKg * 1000
  const capG = H.maxLossFraction * massKg * 1000
  const creditG = creditL * 1000
  const creditedG = H.netLossFraction * massKg * 1000 + creditG
  const thresholdG = restricted ? PHS_D_MAX_BODY_MASS_FRACTION.drinkRestricted * massKg * 1000 : Math.min(capG, Math.max(isoG, creditedG))
  const netG = sweatG - (restricted ? creditG : Math.max(creditG, H.isoImpliedReplacement * sweatG))
  const extended = !restricted && thresholdG > isoG
  return {
    restricted,
    massKg,
    sweatG,
    creditL,
    isoG,
    thresholdG,
    netG,
    restartMaxNetG: H.restartNetLossFraction * massKg * 1000,
    extended,
    capped: !restricted && creditedG >= capG,
    lossOpts: extended ? { lossThresholdG: thresholdG } : undefined,
  }
}

/** Environment level from the allowed work fraction and the continuous-work margin (ARCHITECTURE.md §5). */
export function environmentLevel(f: number, marginC: number): RiskLevel {
  const T = RISK_THRESHOLDS.environment
  if (!isNum(f) || !isNum(marginC)) return 'stop' // fail-safe [ENG]: cannot happen with finite inputs
  if (f >= 1) return marginC >= T.safeMarginC ? 'safe' : 'caution'
  if (f >= T.cautionMinWorkFraction) return 'caution'
  if (f >= T.highMinWorkFraction) return 'high'
  return 'stop'
}

/** Projection level from minutes to the first ISO 7933 limit (null = beyond the horizon) (ARCHITECTURE.md §5). */
export function projectionLevel(minutes: number | null): RiskLevel {
  const T = RISK_THRESHOLDS.projection
  if (minutes === null || minutes > T.safeAboveMin) return 'safe'
  if (minutes > T.cautionAboveMin) return 'caution'
  if (minutes >= T.highFromMin) return 'high'
  return 'stop'
}

/** Orders and de-duplicates actions by {@link ACTION_PRIORITY}. */
export function orderActions(actions: Iterable<ActionId>): ActionId[] {
  const rank = (a: ActionId): number => {
    const i = ACTION_PRIORITY.indexOf(a)
    return i === -1 ? ACTION_PRIORITY.length : i
  }
  return [...new Set(actions)].sort((a, b) => rank(a) - rank(b))
}

/**
 * Sorts drivers: 'raises' first, then 'info', then 'lowers'; within a direction by the level of the channel that
 * produced the driver (most severe first), then by |value| (larger first; drivers with a value before those without),
 * then by original order. Duplicate (channel, id) pairs keep their first occurrence.
 */
export function sortDrivers(drivers: readonly RiskDriver[], channelLevels: Partial<Record<ChannelId, RiskLevel>>): RiskDriver[] {
  const dirRank = { raises: 0, info: 1, lowers: 2 } as const
  const seen = new Set<string>()
  const unique: { d: RiskDriver; i: number }[] = []
  drivers.forEach((d, i) => {
    const key = `${d.channel}:${d.id}`
    if (seen.has(key)) return
    seen.add(key)
    unique.push({ d, i })
  })
  return unique
    .sort((a, b) => {
      const dr = dirRank[a.d.direction] - dirRank[b.d.direction]
      if (dr !== 0) return dr
      const sev = RISK_ORDER[channelLevels[b.d.channel] ?? 'safe'] - RISK_ORDER[channelLevels[a.d.channel] ?? 'safe']
      if (sev !== 0) return sev
      const av = a.d.value
      const bv = b.d.value
      if (av !== undefined && bv !== undefined && Math.abs(bv) !== Math.abs(av)) return Math.abs(bv) - Math.abs(av)
      if (av !== undefined && bv === undefined) return -1
      if (av === undefined && bv !== undefined) return 1
      return a.i - b.i
    })
    .map((x) => x.d)
}

// ═════════════════════════════════════ Engine construction ═════════════════════════════════════

/**
 * Fresh per-worker state at the start of a shift: no PHS state yet (created at the first step with that minute's
 * conditions, ISO 7933 Annex E initial values), heart-rate monitor initialised at `shiftStartT`, nothing latched,
 * displayed level 'safe'.
 */
export function createWorkerEngine(profile: WorkerProfile, shiftStartT: number, opts: CreateWorkerEngineOptions = {}): WorkerEngineState {
  const monitorOpts: { ct0C?: number; seatedHr0Bpm?: number | null } = {}
  if (opts.ct0C !== undefined) monitorOpts.ct0C = opts.ct0C
  if (opts.seatedHr0Bpm !== undefined) monitorOpts.seatedHr0Bpm = opts.seatedHr0Bpm
  return {
    workerId: profile.id,
    shiftStartT,
    lastT: shiftStartT,
    phsT: shiftStartT,
    phs: null,
    projection: null,
    physio: physioMonitorInit(shiftStartT, monitorOpts),
    checkins: [],
    intakes: [],
    latch: null,
    hotWorkMinToday: 0,
    dayStartT: localDayStart(shiftStartT),
    sweatingSinceT: null,
    displayed: { level: 'safe', since: shiftStartT },
    pending: null,
    lastAssessment: null,
    phsRecovery: null,
    phsRestartedAt: null,
    projectionHold: null,
    lastTask: null,
    resumeBout: null,
    dwellExProjection: { displayed: { level: 'safe', since: shiftStartT }, pending: null },
    dwellExTaskHold: { displayed: { level: 'safe', since: shiftStartT }, pending: null },
    taskHold: null,
    monitorValidT: null,
    lastHotWorkT: null,
  }
}

// ═════════════════════════════════════ Channels ═════════════════════════════════════

interface EnvironmentEval {
  result: ChannelResult
  actions: ActionId[]
  allowed: AllowedWorkResult
  /** The table level (before the monitored-mode cap; the acclimatisation budget stop is in `result.level` only). */
  tableLevel: RiskLevel
  /** Monitored mode capped the table level at caution this step. */
  capped: boolean
  /** Today's acclimatisation budget is used up for this (hot) task. */
  budgetExhausted: boolean
  workW: number
  workClass: WorkClass
  wbgtWorkEffC: number
  wbgtRestEffC: number
  restArea: Site['restArea']
  restWbgtC: number
  budgetMin: number | null
}

/** The rest area from the context; absent → 'shade' (protective default, ARCHITECTURE.md §1.3). */
function resolveRestArea(ctx: WorkerContext): Site['restArea'] {
  return ctx.restArea === 'cooled_cabin' ? 'cooled_cabin' : 'shade'
}

/** WBGT of a cooled space (°C): the cabin design value, or the outdoor shade when that is cooler [ENG]. */
function cooledWbgtC(heat: SiteHeat): number {
  return isNum(heat.wbgtShadeC) ? Math.min(COOLED_REST.wbgtC, heat.wbgtShadeC) : COOLED_REST.wbgtC
}

/**
 * Rest-area WBGT before clothing and margin (ARCHITECTURE.md §5): an air-conditioned cabin (site rest area, or the
 * cooled space the worker is already in) → {@link cooledWbgtC}; otherwise the modelled shade WBGT.
 */
function restWbgtOf(ctx: WorkerContext): { cooled: boolean; wbgtC: number } {
  const cooled = resolveRestArea(ctx) === 'cooled_cabin' || ctx.location === 'indoor_cool'
  return { cooled, wbgtC: cooled ? cooledWbgtC(ctx.heat) : ctx.heat.wbgtShadeC }
}

/** WBGT at the worker's location: sun → outdoor WBGT; shade → shade WBGT; cooled indoor space → {@link cooledWbgtC}. */
function locationWbgtC(heat: SiteHeat, location: WorkerLocation): number {
  if (location === 'sun') return heat.wbgtC
  if (location === 'shade') return heat.wbgtShadeC
  return cooledWbgtC(heat)
}

/** Memo of {@link cooledTwlWm2} by the site pressure in whole Pa (the cabin climate itself is fixed). */
const COOLED_TWL_MEMO = new Map<number, number>()
const COOLED_TWL_MEMO_MAX = 4096

/**
 * TWL (W/m²) of the {@link COOLED_REST} cabin — `twl.computeTwl` at 26 °C / 55 % RH, MRT 26 °C, 0.2 m/s and the site
 * pressure (≈ 255 W/m², ADOSH Low zone). Used for the regulation channel while the worker is in an 'indoor_cool'
 * location [ENG: no indoor sensor]. Memoised: the pressure is rounded to whole Pa (0.01 hPa) and the TWL computed at
 * that rounded pressure, so a result never depends on call order [ENG: the cabin TWL changes by far less than
 * 0.01 W/m² per Pa, while the ADOSH zone thresholds are 115/140 W/m²].
 */
export function cooledCabinTwlWm2(pHpa: number | null | undefined): number {
  const pKpa = isNum(pHpa) && pHpa > 0 ? pHpa / 10 : 101.325
  const pPa = Math.round(pKpa * 1000)
  const hit = COOLED_TWL_MEMO.get(pPa)
  if (hit !== undefined) return hit
  const v = computeTwl({ tdbC: COOLED_REST.taC, rhPct: COOLED_REST.rhPct, mrtC: COOLED_REST.trC, windMs: COOLED_REST.vMs, pKpa: pPa / 1000 }).twlWm2
  if (COOLED_TWL_MEMO.size >= COOLED_TWL_MEMO_MAX) COOLED_TWL_MEMO.clear()
  COOLED_TWL_MEMO.set(pPa, v)
  return v
}

const cooledTwlWm2 = (heat: SiteHeat): number => cooledCabinTwlWm2(heat.pHpa)

function envMarginC(ctx: WorkerContext): number {
  const m = ctx.env?.wbgtMarginC
  return isNum(m) && m > 0 ? m : 0
}

/** Clothing for a task (null = resting): task PPE, else the worker's clothing, else the default (cloth coveralls). */
function clothingFor(task: Task | null, profile: WorkerProfile): ClothingId {
  const id = task?.clothing ?? profile.clothing
  return id !== undefined && id in CLOTHING ? id : DEFAULT_CLOTHING
}

function resolveClothing(ctx: WorkerContext): ClothingId {
  return clothingFor(ctx.task, ctx.profile)
}

/** Hot work for the acclimatisation budget: a task performed outside a cooled space [ENG]. */
function isHotWork(ctx: WorkerContext): boolean {
  return ctx.task !== null && ctx.location !== 'indoor_cool'
}

/** Work in the sun for the no-hot-work-today rule and the midday break. */
function isSunWork(ctx: WorkerContext): boolean {
  return ctx.task !== null && ctx.location === 'sun'
}

/**
 * Environment channel (ARCHITECTURE.md §5; NIOSH 2016 §8.1; ACGIH TLV):
 * work rate `taskMetabolicW(task, massKg)` (rest = the 115 W class, mass-scaled); WBGT at the location: sun →
 * `heat.wbgtC`, shade → `heat.wbgtShadeC`, a cooled indoor space → {@link COOLED_REST} (or the shade when cooler);
 * WBGT_eff = wbgtEffectiveC(WBGT, task clothing ?? worker clothing, hood) + the data margin.
 * Rest term: the site's rest area — 'cooled_cabin' (or already in a cooled space) → min(COOLED_REST.wbgtC, shade WBGT),
 * otherwise the shade WBGT — plus the clothing CAV (PPE kept on during rest [ENG], hood off) and the data margin.
 * Limit = REL only when acclimatised and not in conservative mode, else RAL; allowed work fraction f → f ≥ 1 with
 * ≥ 1 °C margin safe; f ≥ 1 within 1 °C or f ≥ 0.75 caution; 0.25–0.75 high; < 0.25 stop.
 * Acclimatisation budget: hot-work minutes today ≥ maxExposureFraction × 480 min (only while a ramp limits the day,
 * fraction < 1) → stop for hot work with 'acclimatization_plan' + 'rotate_task' [ENG].
 * Monitored mode (`monitored`, see {@link RISK_THRESHOLDS}.monitoring): the table result is still computed and shown,
 * but above the table limit (f < 1) the level is capped at caution with 'wbgt_screen_monitored' and the work/rest
 * cycle is an 'info' guide without 'shade_breaks'; the acclimatisation budget stop is unchanged.
 * Driver texts never name REL/RAL or the reason for a stricter personal limit (privacy, ARCHITECTURE.md §5).
 */
function evaluateEnvironment(
  ctx: WorkerContext,
  clothing: ClothingId,
  acclim: AcclimatizationAssessment,
  cons: ConservativeModeResult,
  hotWorkMinToday: number,
  monitored = false,
): EnvironmentEval {
  const task = ctx.task
  const heat = ctx.heat
  const hood = task !== null && task.hood === true
  const workClass: WorkClass = task?.workClass ?? 'rest'
  const workW = taskMetabolicW(task ?? { workClass: 'rest' }, ctx.profile.massKg)
  const marginC = envMarginC(ctx)
  const restArea = resolveRestArea(ctx)
  const rest = restWbgtOf(ctx)
  const atWorkC = locationWbgtC(heat, ctx.location)
  const wbgtWorkEffC = wbgtEffectiveC(atWorkC, clothing, hood) + marginC
  const wbgtRestEffC = wbgtEffectiveC(rest.wbgtC, clothing, false) + marginC
  const limit = selectExposureLimit(acclim.status, cons.conservative)
  const allowed = allowedWorkFraction({ workW, restW: REST_METABOLIC_W, wbgtWorkEffC, wbgtRestEffC, limit })
  const tableLevel = environmentLevel(allowed.f, allowed.marginC)
  // Monitored mode: above the table limit the tables are a screen (ISO 7243:2017; ACGIH TLV; NIOSH 2016) [ENG cap].
  const capped = monitored && allowed.f < 1 && RISK_ORDER[tableLevel] > RISK_ORDER.caution
  let level: RiskLevel = capped ? 'caution' : tableLevel
  const drivers: RiskDriver[] = []
  const actions: ActionId[] = []
  // Both limits are cited so the basis does not reveal which one applies (privacy, ARCHITECTURE.md §5).
  const limitBasis = `${LIMITS_BASIS.rel}; ${LIMITS_BASIS.ral}`
  const what = task ? `${task.name} (${Math.round(workW)} W)` : `rest (${Math.round(workW)} W)`
  const restWhere = rest.cooled ? 'in the air-conditioned rest area' : 'in shade'

  if (allowed.marginC < 0) {
    drivers.push(
      makeDriver('wbgt_over_limit', 'environment', `Effective WBGT ${wbgtWorkEffC.toFixed(1)} °C is ${(-allowed.marginC).toFixed(1)} °C over the personal exposure limit for ${what}`, 'raises', limitBasis, wbgtWorkEffC, '°C'),
    )
  } else if (allowed.marginC < RISK_THRESHOLDS.environment.safeMarginC) {
    drivers.push(
      makeDriver('wbgt_near_limit', 'environment', `Effective WBGT ${wbgtWorkEffC.toFixed(1)} °C is within 1 °C of the personal exposure limit for ${what}`, 'raises', limitBasis, wbgtWorkEffC, '°C'),
    )
  } else {
    drivers.push(
      makeDriver('wbgt_within_limit', 'environment', `Effective WBGT ${wbgtWorkEffC.toFixed(1)} °C is ${allowed.marginC.toFixed(1)} °C under the personal exposure limit for ${what}`, 'info', limitBasis, wbgtWorkEffC, '°C'),
    )
  }
  const screened = monitored && allowed.f < 1
  if (screened) {
    // The table cycle is a guide while monitoring is valid; the projection and physiology channels enforce.
    drivers.push(
      makeDriver('wbgt_screen_monitored', 'environment', 'WBGT is above the table limit: your own heat-strain projection (ISO 7933) and wearable monitoring are in use', 'raises', RISK_THRESHOLDS.monitoring.basis),
      makeDriver('work_rest_cycle', 'environment', `Work/rest guide: about ${Math.floor(allowed.workMinPerHour)} min work per hour, rest ${restWhere} the remainder`, 'info', `${LIMITS_BASIS.allowedWork}; ${RISK_THRESHOLDS.monitoring.basis}`, allowed.workMinPerHour, 'min/h'),
    )
  } else if (allowed.f < 1) {
    drivers.push(
      makeDriver('work_rest_cycle', 'environment', `Work at most ${Math.floor(allowed.workMinPerHour)} min per hour, rest ${restWhere} the remainder`, 'raises', LIMITS_BASIS.allowedWork, allowed.workMinPerHour, 'min/h'),
    )
  }
  if (rest.cooled) {
    drivers.push(
      makeDriver('rest_area_cooled', 'environment', `Rest breaks in the air-conditioned rest area (WBGT ${rest.wbgtC.toFixed(1)} °C)`, 'info', COOLED_REST.basis, rest.wbgtC, '°C'),
    )
  } else {
    const unset = ctx.restArea === undefined ? '; rest area not configured' : ''
    const tooHot = allowed.binding === 'rest_exceeds_limit' ? ': even resting there exceeds the exposure limit, move to a cooler place' : ''
    drivers.push(
      makeDriver('rest_area_shade_only', 'environment', `Rest breaks in shade only (WBGT ${rest.wbgtC.toFixed(1)} °C${unset})${tooHot}`, 'info', `${LIMITS_BASIS.allowedWork}; ARCHITECTURE.md §5 (rest term = the site's rest area)`, rest.wbgtC, '°C'),
    )
  }
  const cav = clothingAdjustmentC(clothing, hood)
  if (cav > 0) {
    drivers.push(
      makeDriver('clothing_adjustment', 'environment', `${CLOTHING[clothing].label}${hood ? ' with hood' : ''}: +${cav} °C to WBGT`, 'raises', `${LIMITS_BASIS.clothing}; ${CLOTHING[clothing].basis}`, cav, '°C'),
    )
  }
  if (limit === 'RAL') {
    if (acclim.status === 'unacclimatized') {
      drivers.push(makeDriver('limit_ral_unacclimatized', 'environment', 'Not acclimatised: the stricter personal exposure limit applies', 'raises', `${LIMITS_BASIS.acclimatization}; ${acclim.basis}`))
    } else if (acclim.status === 'acclimatizing') {
      drivers.push(makeDriver('limit_ral_acclimatizing', 'environment', 'Still acclimatising: the stricter personal exposure limit applies', 'raises', `${LIMITS_BASIS.acclimatization}; ${acclim.basis}`))
    } else {
      drivers.push(
        makeDriver('limit_stricter_personal', 'environment', 'The stricter personal exposure limit applies', 'raises', `${limitBasis}; ARCHITECTURE.md §5 (stricter personal limit; reason kept on the worker's device)`),
      )
    }
  }
  if (allowed.extrapolated) {
    drivers.push(makeDriver('metabolic_rate_extrapolated', 'environment', 'Work rate above 600 W: limit equation extrapolated', 'info', LIMITS_BASIS.allowedWork, workW, 'W'))
  }
  if (CLOTHING[clothing].physiologicalMonitoringAdvised) {
    drivers.push(
      makeDriver('wbgt_method_not_applicable', 'environment', `${CLOTHING[clothing].label}: WBGT limits are only a screen; physiological monitoring advised`, 'raises', CLOTHING[clothing].basis),
    )
  }

  let budgetMin: number | null = null
  let budgetExhausted = false
  if (acclim.maxExposureFraction < 1) {
    budgetMin = acclim.maxExposureFraction * RISK_THRESHOLDS.environment.budgetShiftMin
    const budgetBasis = `${acclim.basis}; budget = maxExposureFraction × 480 min [ENG]`
    if (isHotWork(ctx) && hotWorkMinToday >= budgetMin) {
      budgetExhausted = true
      level = maxLevel(level, 'stop')
      drivers.push(
        makeDriver('acclimatization_budget_exhausted', 'environment', `Today's heat-exposure allowance (${Math.round(budgetMin)} min) is used up: no more hot work today`, 'raises', budgetBasis, hotWorkMinToday, 'min'),
      )
      actions.push('acclimatization_plan', 'rotate_task')
    } else {
      drivers.push(
        makeDriver('acclimatization_budget', 'environment', `Acclimatisation plan: ${Math.max(0, Math.round(budgetMin - hotWorkMinToday))} min of hot work left today`, 'info', budgetBasis, Math.max(0, budgetMin - hotWorkMinToday), 'min'),
      )
    }
  }

  if (level === 'caution') {
    actions.push('drink_water')
    if (allowed.f < 1 && !screened) actions.push('shade_breaks')
  } else if (level === 'high') {
    actions.push('shade_breaks', 'drink_water', 'rotate_task')
  } else if (atLeast(level, 'stop')) {
    actions.push('rest_shade_now', 'rotate_task', 'reduce_intensity', 'drink_water')
  }

  return {
    result: { channel: 'environment', level, available: true, drivers },
    actions,
    allowed,
    tableLevel,
    capped,
    budgetExhausted,
    workW,
    workClass,
    wbgtWorkEffC,
    wbgtRestEffC,
    restArea,
    restWbgtC: rest.wbgtC,
    budgetMin,
  }
}

/** The climate fields PHS reads from a site-heat sample ({@link SiteHeat} is assignable). */
export type PhsClimate = Pick<SiteHeat, 'taC' | 'rhPct' | 'mrtC' | 'mrtHumanShadeC' | 'wind2Ms'>

/** What {@link buildPhsInput} needs: the minute's climate, where the person is, what they do and wear, and who they are. */
export interface PhsInputSpec {
  climate: PhsClimate
  location: WorkerLocation
  /** null = resting (the 115 W rest class, mass-scaled). */
  task: Task | null
  clothing: ClothingId
  /** Body mass, kg; missing or invalid → 75 kg (ARCHITECTURE.md §5). */
  massKg?: number
  /** Height, cm; missing or invalid → 175 cm. */
  heightCm?: number
  acclimatized: boolean
  /** Inside fasting hours: drink = 0. */
  fasting?: boolean
}

/** ISO 7933 inputs of one minute as the engine builds them, with the model's applicability for the clothing. */
export interface PhsInputs {
  input: PhsInput
  /** False for clothing outside the model's scope (vapour barrier): stepped with a surrogate, channel unavailable. */
  applicable: boolean
  verified: boolean
  /** Conditions key (task, location, clothing, hood, drink): a change forces a fresh projection. */
  key: string
}

/**
 * Air temperature, humidity, t_r and air speed seen by PHS at a location: sun → site air, human MRT in sun
 * (`mrtC`) and the 2 m wind; shade → site air, `mrtHumanShadeC` and the 2 m wind; a cooled indoor space → the
 * {@link COOLED_REST} cabin (26 °C, 55 % RH, t_r 26 °C, 0.2 m/s) [ENG: no indoor sensor].
 */
function locationClimate(heat: PhsClimate, location: WorkerLocation): { taC: number; rhPct: number; trC: number; vMs: number } {
  if (location === 'indoor_cool') return { taC: COOLED_REST.taC, rhPct: COOLED_REST.rhPct, trC: COOLED_REST.trC, vMs: COOLED_REST.vMs }
  return { taC: heat.taC, rhPct: heat.rhPct, trC: location === 'sun' ? heat.mrtC : heat.mrtHumanShadeC, vMs: heat.wind2Ms }
}

/**
 * ISO 7933 inputs for one minute — the engine's builder, exported so the planner's PHS screen uses exactly the same
 * inputs: t_a, RH, t_r and v_a for the location ({@link locationClimate}); v_a clamped to 0–3 m/s (2023 validity);
 * M = taskMetabolicW / DuBois area (task, or the 115 W rest class); clo and i_m,st from `limits.CLOTHING`; drink = 0
 * while fasting; A_p = 0; standing. Missing body size → 75 kg, 175 cm (ARCHITECTURE §5). Vapour-barrier clothing (PHS
 * not applicable) is stepped with the 1.0 clo / 0.38 surrogate only to keep the state continuous [ENG].
 */
export function buildPhsInput(spec: PhsInputSpec): PhsInputs {
  const massKg = isNum(spec.massKg) && spec.massKg > 0 ? spec.massKg : DEFAULT_BODY_MASS_KG
  const heightCm = isNum(spec.heightCm) && spec.heightCm > 0 ? spec.heightCm : DEFAULT_HEIGHT_CM
  const bsa = duBoisAreaM2(massKg, heightCm)
  const task = spec.task
  const workW = taskMetabolicW(task ?? { workClass: 'rest' }, massKg)
  const clothing = spec.clothing in CLOTHING ? spec.clothing : DEFAULT_CLOTHING
  const cs = CLOTHING[clothing].phs
  const clo = Math.min(cs.clo, PHS_VALIDITY_LIMITS['7933-2023'].clo.max)
  const climate = locationClimate(spec.climate, spec.location)
  const drink: 0 | 1 = spec.fasting === true ? 0 : 1
  const input: PhsInput = {
    tdbC: climate.taC,
    trC: climate.trC,
    vMs: Math.min(Math.max(climate.vMs, 0), RISK_THRESHOLDS.projection.maxAirSpeedMs),
    rhPct: Math.min(Math.max(climate.rhPct, 0), 100),
    metabolicWm2: workW / bsa,
    wmeWm2: 0,
    clo,
    iMst: cs.imst,
    posture: 'standing',
    acclimatized: spec.acclimatized,
    drink,
    massKg,
    heightM: heightCm / 100,
    aP: 0,
  }
  const key = `${task?.id ?? 'rest'}|${spec.location}|${clothing}|${task?.hood === true ? 1 : 0}|${drink}`
  return { input, applicable: cs.applicable, verified: cs.verified, key }
}

/** {@link buildPhsInput} for the worker in `ctx` (acclimatised only when the status is 'acclimatized'). */
function phsInputsFor(ctx: WorkerContext, clothing: ClothingId, acclim: AcclimatizationAssessment, task: Task | null = ctx.task, location: WorkerLocation = ctx.location): PhsInputs {
  const p = ctx.profile
  return buildPhsInput({
    climate: ctx.heat,
    location,
    task,
    clothing,
    ...(p.massKg !== undefined ? { massKg: p.massKg } : {}),
    ...(p.heightCm !== undefined ? { heightCm: p.heightCm } : {}),
    acclimatized: acclim.status === 'acclimatized',
    fasting: ctx.fastingNow === true,
  })
}

/** The task to resume after a projection hold, and where it is done (see {@link WorkerContext.resumeTask}). */
function resumeTargetOf(ctx: WorkerContext, last: WorkerEngineState['lastTask']): { task: Task; location: WorkerLocation } | null {
  const explicit = ctx.resumeTask
  if (explicit) {
    const location: WorkerLocation =
      ctx.task !== null && ctx.task.id === explicit.id ? ctx.location : last !== null && last.task.id === explicit.id ? last.location : explicit.inSun ? 'sun' : 'shade'
    return { task: explicit, location }
  }
  if (ctx.task !== null) return { task: ctx.task, location: ctx.location }
  return last
}

/**
 * Resume check (RISK_THRESHOLDS.resume): project the task to resume from a PHS state at its metabolic rate, clothing
 * and location; it passes when no limit is reached within highFromMin + minBoutMin (25) min. The water-loss threshold
 * is held at its current value (no further intake assumed; protective). A target outside the model's scope (vapour
 * barrier) cannot be checked: `unchecked`, never `ok` — the hold then ends without the release shortcut, so the fused
 * level follows the normal 10-min dwell [ENG, protective: never released without a passing projection or the dwell].
 */
function resumePasses(s: PhsState, target: PhsInputs, lossOpts: PhsProjectionOptions | undefined): { ok: boolean; minutes: number | null; unchecked: boolean } {
  if (!target.applicable) return { ok: false, minutes: null, unchecked: true }
  const need = RISK_THRESHOLDS.projection.highFromMin + RISK_THRESHOLDS.resume.minBoutMin
  const p = minutesToLimit(s, target.input, need, PHS_OPTS, lossOpts)
  return { ok: p.minutes === null || p.minutes >= need, minutes: p.minutes, unchecked: false }
}

/**
 * Rest estimate (RISK_THRESHOLDS.resume): simulate rest at `restIn` in 5-min increments up to 60 min and return the first
 * increment after which {@link resumePasses} would pass; null when even 60 min would not (the task is not feasible now).
 */
function restEstimateMin(phs: PhsState, target: PhsInputs, restIn: PhsInputs, lossOpts: PhsProjectionOptions | undefined): number | null {
  const RS = RISK_THRESHOLDS.resume
  let s = phs
  for (let m = RS.restStepMin; m <= RS.restMaxMin; m += RS.restStepMin) {
    s = phsStep(s, restIn.input, RS.restStepMin, PHS_OPTS)
    if (resumePasses(s, target, lossOpts).ok) return m
  }
  return null
}

// ═════════════════════════════════════ Monitored mode and the task hold ═════════════════════════════════════

/**
 * SQI-valid physiology minutes in (now − windowMin, now], one record per minute with the last given winning (as
 * physio.ts windowMinutes); a missing minute is not valid.
 */
function recentValidMinutes(minutes: PhysioMonitorState['minutes'], now: number, windowMin: number): number {
  const hi = Math.round(now / MINUTE_MS)
  const byKey = new Map<number, boolean>()
  for (const m of minutes) {
    const k = Math.round(m.t / MINUTE_MS)
    if (k > hi - windowMin && k <= hi) byKey.set(k, m.valid)
  }
  let n = 0
  for (const v of byKey.values()) if (v) n++
  return n
}

/** Activity-independent monitored-mode failures (RISK_THRESHOLDS.monitoring); true = the condition fails. */
interface MonitoringChecks {
  /** Not acclimatised, or in the stricter personal (conservative) mode. */
  status: boolean
  /** No wearable consent, no wearable, or heart-rate rules off for this worker. */
  consent: boolean
  /** Physiology channel not valid (warm-up, < 10 of 15 valid minutes) or < 4 of the last 5 minutes SQI-valid. */
  data: boolean
}

/**
 * Monitored mode for one activity (RISK_THRESHOLDS.monitoring): null when every condition holds (monitoring valid),
 * else the first failing reason in the order status → consent → model → data. `modelOk`: ISO 7933 applicable to the
 * activity, verified clothing values and inputs within the validity range ({@link phsModelOk}).
 */
function monitoringReason(f: MonitoringChecks, modelOk: boolean): MonitoringFallbackReason | null {
  if (f.status) return 'status'
  if (f.consent) return 'consent'
  if (!modelOk) return 'model'
  if (f.data) return 'data'
  return null
}

/** ISO 7933 usable for monitored mode: in scope (not a vapour barrier), verified clothing values, inputs within validity. */
function phsModelOk(p: PhsInputs, withinLimits?: boolean): boolean {
  return p.applicable && p.verified && (withinLimits ?? phsValidity(p.input, PHS_OPTS.model).withinLimits)
}

/** Worker-device text of the monitored-mode fallback (the reason may reveal consent or health status: never for supervisors). */
const MONITORING_FALLBACK_TEXT: Record<MonitoringFallbackReason, string> = {
  status: 'Monitored mode does not apply to you now (personal heat plan): the table work/rest limits apply again',
  consent: 'Wearable monitoring is off (consent, wearable or setting): the table work/rest limits apply again',
  model: 'The heat-strain model does not cover this work or clothing: the table work/rest limits apply again',
  data: 'Wearable data is not valid (too few good minutes): the table work/rest limits apply again',
}

/** TWL at a location (W/m²): sun and shade from the site heat; a cooled indoor space at the COOLED_REST cabin. */
function twlAt(heat: SiteHeat, location: WorkerLocation): number {
  return location === 'sun' ? heat.twlWm2 : location === 'shade' ? heat.twlShadeWm2 : cooledTwlWm2(heat)
}

/**
 * Regulation channel inputs for an activity: the pack's floor at the activity's location (TWL and WBGT there), outdoor
 * in the sun only for a task in the sun, ADOSH acclimatisation per TG v4.0 Table 1 note b exactly.
 */
function floorFor(
  ctx: WorkerContext,
  task: Task | null,
  location: WorkerLocation,
  workClass: WorkClass,
  acclim: AcclimatizationAssessment,
  pack: RulePack,
): RegulatoryFloor {
  return regulatoryFloor({
    t: ctx.now,
    twlWm2: twlAt(ctx.heat, location),
    outdoorInSun: task !== null && location === 'sun',
    // ADOSH-SF TG v4.0 Table 1 note b exactly (new, or > 14 days off, during the first 7 days back). The stricter RAL
    // and the acclimatisation ramp of an 'acclimatizing' worker stay in the environment channel.
    acclimatization: acclim.adoshUnacclimatized ? 'unacclimatized' : 'acclimatized',
    workClass,
    wbgtC: locationWbgtC(ctx.heat, location),
    pack,
  })
}

/** The regulation/environment stops of one activity and what they wait for. */
interface StopCauses {
  heldBy: TaskHoldChannel[]
  causes: TaskHoldCause[]
}

/** The regulation/environment stops of one activity and what they wait for (the task hold's check). */
function stopCausesOf(env: EnvironmentEval, floor: RegulatoryFloor): StopCauses {
  const heldBy: TaskHoldChannel[] = []
  const causes: TaskHoldCause[] = []
  if (atLeast(floor.level, 'stop')) {
    heldBy.push('regulation')
    const ids = new Set(floor.drivers.map((d) => d.id))
    if (ids.has('unacclimatized_excluded') || ids.has('ordinary_work_prohibited')) causes.push('heat_zone')
    if (ids.has('wbgt_stop_limit')) causes.push('wbgt_stop')
    if (ids.has('midday_break')) causes.push('midday_break')
    // [ENG] fail-safe: a regulation stop not recognised above is held like a zone rule (released only by the check).
    if (causes.length === 0) causes.push('heat_zone')
  }
  if (atLeast(env.result.level, 'stop')) {
    heldBy.push('environment')
    if (env.budgetExhausted) causes.push('exposure_budget')
    if (!env.budgetExhausted || (atLeast(env.tableLevel, 'stop') && !env.capped)) causes.push('exposure_limit')
  }
  return { heldBy, causes }
}

/**
 * Earliest time a task hold can release (TaskHold.nextCheckT): null when today's acclimatisation budget is used up
 * (no release this shift for that task); the midday-break end while the break holds; otherwise the next step.
 */
function taskHoldNextCheckT(causes: readonly TaskHoldCause[], now: number, pack: RulePack): number | null {
  if (causes.includes('exposure_budget')) return null
  let t = now + MINUTE_MS
  if (causes.includes('midday_break')) t = Math.max(t, middayBreakWindow(now, pack)?.endT ?? t)
  return t
}

/**
 * Drivers and actions of a task hold for one held channel (the live channel computed for the current activity is below
 * stop). Texts carry no individual number (supervisor-safe: CLINICAL_TEXT_PATTERN); the budget case re-uses the
 * environment channel's 'acclimatization_budget_exhausted' driver of the task to resume.
 */
function taskHoldDrivers(hold: TaskHold, ch: TaskHoldChannel, pack: RulePack, targetEnv: EnvironmentEval | null): { drivers: RiskDriver[]; actions: ActionId[] } {
  const TH = RISK_THRESHOLDS.taskHold
  const c = hold.causes
  if (ch === 'regulation') {
    if (c.includes('heat_zone')) {
      return {
        drivers: [makeDriver('resume_hold_regulation', 'regulation', 'Rest before going back to this task: the heat-zone rules do not allow it now', 'raises', `${pack.basis}; ${TH.basis}`)],
        actions: ['rest_shade_now', 'rotate_task'],
      }
    }
    if (c.includes('wbgt_stop')) {
      return {
        drivers: [makeDriver('resume_hold_regulation', 'regulation', 'Rest before going back to this task: WBGT is above the stop-work limit', 'raises', `${pack.wbgtStopBasis ?? pack.basis}; ${TH.basis}`)],
        actions: ['rest_shade_now'],
      }
    }
    const rule = pack.middayBreak
    return {
      drivers: [makeDriver('resume_hold_regulation', 'regulation', `Midday work ban: rest until it ends at ${rule?.endHhmm ?? 'the end of the ban'}`, 'raises', `${rule?.basis ?? pack.basis}; ${TH.basis}`)],
      actions: ['midday_break', 'rest_shade_now'],
    }
  }
  const drivers: RiskDriver[] = []
  const actions: ActionId[] = ['rest_shade_now', 'rotate_task']
  if (c.includes('exposure_budget')) {
    const d = targetEnv?.result.drivers.find((x) => x.id === 'acclimatization_budget_exhausted')
    drivers.push(d ? { ...d } : makeDriver('acclimatization_budget_exhausted', 'environment', "Today's heat-exposure allowance is used up: no more hot work today", 'raises', LIMITS_BASIS.acclimatization))
    actions.push('acclimatization_plan')
  }
  if (c.includes('exposure_limit')) {
    drivers.push(makeDriver('resume_hold_environment', 'environment', 'Rest before going back to this task: the heat-exposure limit does not allow it now', 'raises', `${LIMITS_BASIS.allowedWork}; ${TH.basis}`))
  }
  return { drivers, actions }
}

// ═════════════════════════════════════ The step ═════════════════════════════════════

function resolveOptions(opts: WorkerEngineOptions): Required<WorkerEngineOptions> {
  const pos = (v: number | undefined, d: number): number => (isNum(v) && v >= 0 ? v : d)
  return {
    projectionEveryMin: pos(opts.projectionEveryMin, RISK_THRESHOLDS.projection.everyMin),
    horizonMin: pos(opts.horizonMin, RISK_THRESHOLDS.projection.horizonMin),
    dwellMin: pos(opts.dwellMin, RISK_THRESHOLDS.dwell.dwellMin),
    maxCatchUpMin: pos(opts.maxCatchUpMin, RISK_THRESHOLDS.steps.maxCatchUpMin),
    newShiftGapMin: pos(opts.newShiftGapMin, RISK_THRESHOLDS.steps.newShiftGapMin),
  }
}

function addCheckin(list: readonly Checkin[], c: Checkin): Checkin[] {
  const out = c.id !== undefined ? list.filter((x) => x.id !== c.id) : [...list]
  out.push(c)
  return out.sort((a, b) => a.t - b.t)
}

function latchActions(tier: ClinicalTier): ActionId[] {
  return tier >= 3
    ? ['call_998', 'cool_first', 'stay_with_worker', 'first_aider_check']
    : ['stop_work', 'rest_shade_now', 'cool_down', 'first_aider_check', 'symptom_checkin', 'no_hot_work_today']
}

const isCleanCheckin = (c: Checkin): boolean => c.symptoms.every((s) => (SYMPTOM_RULES[s]?.tier ?? 3) < 2)

/** Rest progress of a pending recovery: cooled minutes / 30 + shade minutes / 45, capped at 1 [ENG]. */
function recoveryProgress(r: PhsRecoveryState): number {
  const R = RISK_THRESHOLDS.recovery
  return Math.min(1, r.restCooledMin / R.cooledRestMin + r.restShadeMin / R.shadeRestMin)
}

/**
 * The conservative post-rest PHS state after a reviewed recovery [ENG] (RISK_THRESHOLDS.recovery): t_re, t_cr and
 * t_cr,eq raised to at least 37.5 °C (never below the model's own values) and the rectal-limit marker cleared so the
 * limit can be detected again. Skin temperature, sweat rate, the elapsed minutes and the cumulative sweat loss are
 * kept: rest does not restore the shift water-loss allowance (ISO 7933:2023 Annex B D_max is a per-exposure total),
 * so a water-loss limit stays reached.
 */
function postReviewPhsState(prev: PhsState): PhsState {
  const c = RISK_THRESHOLDS.recovery.restartCoreC
  return { ...prev, tReC: Math.max(c, prev.tReC), tCrC: Math.max(c, prev.tCrC), tCrEqC: Math.max(c, prev.tCrEqC), tReLimitMin: null }
}

/**
 * Advances one worker by one step (normally one minute; irregular steps are fine: the elapsed time comes from the
 * timestamps, PHS is advanced in whole minutes, and a gap longer than `maxCatchUpMin` is simulated only up to that
 * cap at the current conditions [ENG]; a gap ≥ `newShiftGapMin` starts a new shift).
 *
 * Order: store inputs → acclimatisation and conservative mode → heart-rate monitor → hot-work minutes → hydration and
 * symptoms channels → PHS step, reviewed recovery, projection → environment, regulation, projection and physiology
 * channels → latch (+ no hot work today) → fusion (max over available channels) → dwell → actions, work minutes,
 * water, confidence.
 * - Projection: PHS (ISO 7933:2023, hcMode 'tclIteration') continues during rest ('indoor_cool' at the cabin
 *   conditions). ISO 7933:2023 clause 5 warns that recovery after a limit cannot be validly modelled, so a reached
 *   limit holds the channel at stop (phs_iso7933.md §11.4). It clears only when ALL hold: continuous rest since the
 *   limit of ≥ 30 min in a cooled space or ≥ 45 min in shade (work or sun restarts the count) [ENG]; a check-in at or
 *   after the end of that rest with no T2+ symptoms; and a resolution by a first aider, supervisor or
 *   occupational-health nurse recorded at or after the end of that rest. PHS then restarts from the conservative
 *   post-rest state ({@link RISK_THRESHOLDS}.recovery). A water-loss limit restarts only once the net loss is ≤ 2 % of
 *   body mass (logged drinks count; RISK_THRESHOLDS.hydrationCredit); while drinking is restricted it cannot be
 *   restarted within the shift.
 * - Water-loss threshold: max(5 % of body mass, 3 % + 0.8 × Σ_hours min(logged intake, 1.42 L)) since the shift start
 *   with drinking allowed and check-in consent (never below ISO 7933; without logs exactly ISO); the ISO 3 % / 0.6 rule
 *   while drinking is restricted. Projections assume no further intake.
 * - Projection hold: minutes < 15 at the current activity (not a reached limit) holds the channel at stop (rest_shade_now,
 *   cool_down) until the resume check — run every projection cycle — projects ≥ 25 min for the task to resume
 *   (ctx.resumeTask, else the current task, else the last task this shift) at its location and clothing; a rest
 *   estimate (5-min steps up to 60 min) and 'task_not_feasible_now' + rotate_task when even 60 min would not pass. The
 *   release skips the dwell for the projection channel (the other channels keep theirs); a bout countdown follows
 *   while the resumed task projects 15–45 min.
 * - Day plan: ctx.plannedWorkMinPerHour caps workMinPerHour (never raises it).
 * - Regulation: ADOSH acclimatisation per TG v4.0 Table 1 note b exactly (unacclimatised = new or > 14 days off, first
 *   7 days back); conservative mode adds the pack's next-stricter work/rest tier (regulation.stricterWorkRest).
 * - Fasting: PHS drink = 0, waterMlPerHour = 0 with a hydration driver, no drink actions; levels unchanged.
 * Never throws for missing optional inputs; `ctx.heat` must come from `computeSiteHeat`.
 */
export function stepWorkerEngine(
  state: WorkerEngineState,
  ctx: WorkerContext,
  inputs: WorkerInputs = {},
  options: WorkerEngineOptions = {},
): WorkerStepResult {
  const o = resolveOptions(options)
  const now = ctx.now
  const profile = ctx.profile
  const extraDrivers: RiskDriver[] = []
  let confidenceRank: number = CONFIDENCE_RANK.high
  const lowerConfidence = (to: keyof typeof CONFIDENCE_RANK): void => {
    confidenceRank = Math.min(confidenceRank, CONFIDENCE_RANK[to])
  }

  // ── 0. Time bookkeeping, new shift, new local day ──
  let shiftStartT = state.shiftStartT
  let phs = state.phs
  let phsT = state.phsT
  let projection = state.projection
  let physio = state.physio
  // `?? null` keeps states serialised before these fields existed usable.
  let recovery: PhsRecoveryState | null = state.phsRecovery ?? null
  let phsRestartedAt: number | null = state.phsRestartedAt ?? null
  let hold: ProjectionHold | null = state.projectionHold ?? null
  let lastTask: WorkerEngineState['lastTask'] = state.lastTask ?? null
  let resumeBout: ResumeBout | null = state.resumeBout ?? null
  // A state serialised before the track existed starts from the fused track (protective: no early drop).
  let dwellOthers: DwellTrack = state.dwellExProjection ?? { displayed: state.displayed, pending: state.pending }
  let dwellExTask: DwellTrack = state.dwellExTaskHold ?? { displayed: state.displayed, pending: state.pending }
  let taskHold: TaskHold | null = state.taskHold ?? null
  let monitorValidT: number | null = state.monitorValidT ?? null
  let lastHotWorkT: number | null = state.lastHotWorkT ?? null
  const gapMin = (now - state.lastT) / MINUTE_MS
  const newShift = gapMin >= o.newShiftGapMin
  if (newShift) {
    shiftStartT = now
    phs = null
    phsT = now
    projection = null
    physio = physioMonitorInit(now)
    recovery = null
    phsRestartedAt = null
    hold = null
    lastTask = null
    resumeBout = null
    taskHold = null
    monitorValidT = null
    lastHotWorkT = null
  }
  // The task to resume after a hold is resolved before this step's task becomes the last one seen.
  const resumeTarget = resumeTargetOf(ctx, lastTask)
  if (ctx.task !== null) lastTask = { task: ctx.task, location: ctx.location }
  const dayStartT = localDayStart(now)
  let hotWorkMinToday = state.hotWorkMinToday
  let sweatingSinceT = state.sweatingSinceT
  if (dayStartT !== state.dayStartT) {
    hotWorkMinToday = 0
    sweatingSinceT = null
  }

  // ── 1. Inputs ──
  let checkins = state.checkins
  if (inputs.checkin) checkins = addCheckin(checkins, inputs.checkin)
  checkins = checkins.filter((c) => c.t > now - RISK_THRESHOLDS.steps.checkinHistoryH * HOUR_MS)
  let intakes = state.intakes
  // A log without loggedAt is stamped with the step that receives it [ENG, protective: the engine runs on the worker's
  // device, so the receiving step is the logging time; a drink entered later with an earlier time, or ahead of time,
  // then earns no water-loss credit unless its time is within 15 min of that step: RISK_THRESHOLDS.hydrationCredit].
  const newIntake: FluidIntake | null = inputs.intake
    ? inputs.intake.loggedAt === undefined
      ? { ...inputs.intake, loggedAt: now }
      : inputs.intake
    : null
  if (newIntake) intakes = [...intakes, newIntake].sort((a, b) => a.t - b.t)
  intakes = intakes.filter((x) => x.t > now - RISK_THRESHOLDS.steps.intakeHistoryH * HOUR_MS)

  // ── 2. Worker status ──
  const acclim = assessAcclimatization(profile)
  const checkinsConsented = profile.consent.checkins
  const usableToday = checkins.filter(
    (c) => c.workerId === profile.id && c.t >= dayStartT && c.t <= now && (checkinsConsented || c.by !== 'self'),
  )
  const symptomsToday = usableToday.flatMap((c) => c.symptoms)
  const cons = conservativeMode(profile, { symptomsToday })
  const clothing = resolveClothing(ctx)
  const fasting = ctx.fastingNow === true
  const pack = ctx.pack ?? DEFAULT_RULE_PACK

  // ── 3. Heart-rate monitor (processed only with consent and when HR rules are on: data minimisation) ──
  const physioConsented = profile.consent.wearable && profile.hasWearable
  const hrDisabled = physioDisabled(profile)
  if (physioConsented && !hrDisabled && inputs.physioMinute !== undefined) {
    physio = physioMonitorStep(physio, now, inputs.physioMinute ?? MISSING_MINUTE)
  }

  // ── 4. Hot-work minutes; hydration and symptoms (independent of PHS, needed by the recovery review) ──
  const elapsedMin = Math.max(0, (now - Math.max(state.lastT, shiftStartT)) / MINUTE_MS)
  const stepMin = Math.min(elapsedMin, o.maxCatchUpMin)
  const hotWorkNow = isHotWork(ctx)
  if (hotWorkNow) {
    hotWorkMinToday += Math.min(stepMin, (now - dayStartT) / MINUTE_MS)
    if (sweatingSinceT === null) sweatingSinceT = now
    lastHotWorkT = now
  }
  // Drink reminders follow heat exposure (clinical.drinkReminderExposure): hot work and the 30 min after it, or rest/idle
  // outside a cooled area at WBGT_eff ≥ 25.6 °C at the worker's location (resting clothing, data margin: protective).
  const locationWbgtEffC = wbgtEffectiveC(locationWbgtC(ctx.heat, ctx.location), clothingFor(null, profile), false) + envMarginC(ctx)
  const exposure = drinkReminderExposure({
    hotWorkNow,
    minutesSinceHotWork: lastHotWorkT === null ? null : (now - lastHotWorkT) / MINUTE_MS,
    restingOutsideCooled: ctx.task === null && ctx.location !== 'indoor_cool',
    wbgtC: locationWbgtEffC,
  })
  const hyd = hydrationChannel({
    now,
    checkins,
    intakes,
    consented: checkinsConsented,
    fastingNow: fasting,
    sweatingSinceMs: sweatingSinceT,
    workerId: profile.id,
    exposed: exposure !== null,
  })
  const sym = symptomsChannel({
    now,
    checkins,
    consented: checkinsConsented,
    ctx: { riskFlags: profile.riskFlags, overFluidCap: hyd.fluid.flags.length > 0, fastingNow: fasting },
    workerId: profile.id,
  })
  const latestUsable = usableToday.length > 0 ? usableToday[usableToday.length - 1] : undefined

  // ── 5. PHS step, reviewed recovery, projection ──
  const phsIn = phsInputsFor(ctx, clothing, acclim)
  if (phs === null) {
    phs = phsInitialState(phsIn.input, PHS_OPTS)
    phsT = Math.min(phsT, now)
  }
  let wholeMin = Math.floor(Math.max(0, now - phsT) / MINUTE_MS)
  if (wholeMin > o.maxCatchUpMin) {
    extraDrivers.push(
      makeDriver('step_gap_capped', 'projection', `No update for ${wholeMin} min: only the last ${o.maxCatchUpMin} min were simulated at current conditions`, 'info', `${PHS_BASIS}; catch-up cap [ENG]`, wholeMin, 'min'),
    )
    lowerConfidence('medium')
    phsT = now - o.maxCatchUpMin * MINUTE_MS
    wholeMin = o.maxCatchUpMin
  }
  if (wholeMin > 0) {
    phs = phsStep(phs, phsIn.input, wholeMin, PHS_OPTS)
    phsT += wholeMin * MINUTE_MS
  }
  const validity = phsValidity(phsIn.input, PHS_OPTS.model)

  // Water-loss limit with logged drinking (RISK_THRESHOLDS.hydrationCredit). Intake logs need the check-in consent
  // (they are hydration data, as in clinical.hydrationChannel); without consent the limit is exactly ISO 7933.
  const water = waterStatus(phs, phsIn.input, checkinsConsented ? creditedIntakeL(intakes, shiftStartT, now, profile.id) : 0)
  const lossOpts = water.lossOpts
  // A drink logged in this step counts from the next step for every release decision (projection hold, reviewed restart)
  // and for the limit check, so it never releases a hold or skips the reviewed recovery in the step it is logged
  // (RISK_THRESHOLDS.hydrationCredit); the projection shown this step already uses the new credit.
  const waterGate =
    newIntake !== null && checkinsConsented
      ? waterStatus(phs, phsIn.input, creditedIntakeL(intakes.filter((x) => x !== newIntake), shiftStartT, now, profile.id))
      : water
  const gateLossOpts = waterGate.lossOpts

  // Reviewed recovery of a limit reached in an earlier step (RISK_THRESHOLDS.recovery; phs_iso7933.md §11.4).
  // A logged drink that raises the water-loss threshold forces a fresh projection (the countdown would be stale).
  let forceProjection = inputs.intake !== undefined && lossOpts !== undefined
  let recoveryNeeds = { rest: true, checkin: true, signoff: true }
  let restartBlock: 'rectal' | 'dehydration' | null = null
  // Would the post-rest state still be blocked? (horizon 0: only an already-reached limit is reported.) Rectal: the
  // model's own t_re ≥ 38 °C. Water, drinking restricted: the ISO no-drink limit is never restored this shift — also
  // when the 0.6 rule set it before the 3 % mark itself is crossed, which a horizon-0 check cannot see. Water, drinking
  // allowed: once the water-loss limit is or was involved, restart only at a net loss ≤ 2 % of body mass (credit before
  // this step's drink).
  const blockOf = (restarted: PhsState, reached: 'rectal' | 'dehydration' | null): 'rectal' | 'dehydration' | null => {
    const p = minutesToLimit(restarted, phsIn.input, 0, PHS_OPTS, gateLossOpts)
    if (p.minutes === 0 && (p.binding ?? 'rectal') === 'rectal') return 'rectal'
    if (waterGate.restricted) return p.minutes === 0 || reached === 'dehydration' ? 'dehydration' : null
    return (reached === 'dehydration' || p.minutes === 0) && waterGate.netG > waterGate.restartMaxNetG ? 'dehydration' : null
  }
  if (recovery !== null) {
    const r: PhsRecoveryState = { ...recovery, signoff: recovery.signoff ? { ...recovery.signoff } : null }
    if (ctx.task === null && ctx.location !== 'sun') {
      if (r.boutStartT === null) r.boutStartT = now - stepMin * MINUTE_MS
      if (ctx.location === 'indoor_cool') r.restCooledMin += stepMin
      else r.restShadeMin += stepMin
    } else if (r.boutStartT !== null || r.restCooledMin > 0 || r.restShadeMin > 0 || r.restMetT !== null || r.signoff !== null) {
      // Work or time in the sun restarts the rest requirement, and with it the check-in and the sign-off [ENG].
      r.boutStartT = null
      r.restCooledMin = 0
      r.restShadeMin = 0
      r.restMetT = null
      r.signoff = null
    }
    if (r.restMetT === null && recoveryProgress(r) >= 1) r.restMetT = now
    const res = inputs.resolution
    if (res && r.restMetT !== null && res.t >= r.restMetT && (r.signoff === null || res.t >= r.signoff.t)) r.signoff = { by: res.by, t: res.t }
    const checkinOk = r.restMetT !== null && latestUsable !== undefined && latestUsable.t >= r.restMetT && isCleanCheckin(latestUsable) && sym.tier < 2
    recoveryNeeds = { rest: r.restMetT === null, checkin: !checkinOk, signoff: r.signoff === null }
    const restarted = postReviewPhsState(phs)
    restartBlock = blockOf(restarted, r.binding)
    if (!recoveryNeeds.rest && !recoveryNeeds.checkin && !recoveryNeeds.signoff && restartBlock === null) {
      phs = restarted
      recovery = null
      phsRestartedAt = now
      forceProjection = true
    } else {
      recovery = r
    }
  }

  // A limit crossed inside the PHS state between projections forces a fresh projection (protective [ENG]). The water
  // part uses the threshold in force before this step's drink: with drinking allowed min(7.5 %, max(5 %, 3 % + credit))
  // (exactly the 5 % mark without credit), while restricted the ISO no-drink marks.
  const waterAtLimit = waterGate.restricted ? phs.waterLoss5PctMin !== null || phs.waterLoss3PctMin !== null : waterGate.sweatG >= waterGate.thresholdG
  const stateAtLimit = phs.tReLimitMin !== null || waterAtLimit
  const limitCrossed = stateAtLimit && projection !== null && projection.minutes !== 0
  const due =
    forceProjection ||
    projection === null ||
    limitCrossed ||
    projection.key !== phsIn.key ||
    now - projection.t >= o.projectionEveryMin * MINUTE_MS ||
    now < projection.t
  if (due) {
    const p = minutesToLimit(phs, phsIn.input, o.horizonMin, PHS_OPTS, lossOpts)
    projection = {
      t: now,
      minutes: p.minutes,
      binding: p.binding,
      key: phsIn.key,
      withinLimits: validity.withinLimits,
      failing: validity.failing.map((f) => f.field),
    }
  }
  const proj = projection as ProjectionRecord
  let minutesNow = proj.minutes === null ? null : Math.max(0, proj.minutes - (now - proj.t) / MINUTE_MS)
  // A reached limit (while the model applies) starts a recovery review — also a water-loss limit reached before a drink
  // logged in this same step (the drink does not skip the review).
  const reachedBeforeDrink = waterGate !== water && !waterGate.restricted && waterGate.sweatG >= waterGate.thresholdG
  if (recovery === null && phsIn.applicable && (minutesNow === 0 || reachedBeforeDrink)) {
    const binding = minutesNow === 0 ? proj.binding : 'dehydration'
    recovery = { limitT: now, binding, boutStartT: null, restCooledMin: 0, restShadeMin: 0, restMetT: null, signoff: null }
    recoveryNeeds = { rest: true, checkin: true, signoff: true }
    restartBlock = blockOf(postReviewPhsState(phs), binding)
  }
  if (recovery !== null) minutesNow = 0

  // Projection hold and the engine-owned resume check (RISK_THRESHOLDS.resume). A reached limit is the recovery
  // review instead; a model that does not apply cannot hold.
  const PT = RISK_THRESHOLDS.projection
  const resumeNeedMin = PT.highFromMin + RISK_THRESHOLDS.resume.minBoutMin
  let releasedNow = false
  if (recovery !== null || !phsIn.applicable) {
    // The recovery review holds stop instead; a current activity outside the model's scope ends the hold without the
    // release shortcut (releasedNow stays false), so the fused level follows the normal 10-min dwell [protective].
    hold = null
    resumeBout = null
  } else {
    if (hold === null && minutesNow !== null && minutesNow < PT.highFromMin) {
      hold = {
        since: now,
        taskId: ctx.task?.id ?? resumeTarget?.task.id ?? null,
        checkedT: null,
        checkedTaskId: null,
        resumeMin: null,
        estRestMin: null,
        infeasibleNow: false,
        estT: null,
        checkKey: null,
      }
      resumeBout = null
    }
    if (hold !== null && (due || hold.checkedT === null)) {
      // Rest at the place the worker already rests (not the sun), else at the site's rest area [ENG].
      const restLoc: WorkerLocation = ctx.task === null && ctx.location !== 'sun' ? ctx.location : resolveRestArea(ctx) === 'cooled_cabin' ? 'indoor_cool' : 'shade'
      const restIn = phsInputsFor(ctx, clothingFor(null, profile), acclim, null, restLoc)
      const targetIn = resumeTarget ? phsInputsFor(ctx, clothingFor(resumeTarget.task, profile), acclim, resumeTarget.task, resumeTarget.location) : restIn
      const targetId = resumeTarget?.task.id ?? null
      // The water-loss threshold before this step's drink: a drink never releases the hold in the step it is logged.
      const chk = resumePasses(phs, targetIn, gateLossOpts)
      if (chk.unchecked) {
        // The task to resume is outside the model's scope (vapour barrier): no projection can pass, so the hold ends
        // without the release shortcut and the fused level follows the normal 10-min dwell (safety review 2c, LOW).
        hold = null
        resumeBout = null
      } else if (chk.ok && (minutesNow === null || minutesNow >= PT.highFromMin)) {
        // The current activity itself must be out of the stop band too (a worker still at the task cannot be released).
        releasedNow = true
        resumeBout = { taskId: targetId, releasedT: now }
        hold = null
      } else {
        // Rest estimate: in full at most every estimateEveryMin while the worker keeps resting at the same place for
        // the same task (same activity key since the last check); in between it counts down with the rest taken.
        const RS = RISK_THRESHOLDS.resume
        const resting = ctx.task === null && ctx.location !== 'sun'
        const unchanged = resting && hold.checkedT !== null && hold.estT !== null && hold.checkKey === phsIn.key && hold.checkedTaskId === targetId
        const countdown = hold.estRestMin === null ? null : hold.estRestMin - Math.round((now - (hold.checkedT ?? now)) / MINUTE_MS / RS.restStepMin) * RS.restStepMin
        let est: number | null
        let estT: number
        if (chk.ok) {
          est = 0
          estT = now
        } else if (unchanged && now - (hold.estT as number) < RS.estimateEveryMin * MINUTE_MS && (countdown === null ? hold.infeasibleNow : countdown >= RS.restStepMin)) {
          est = countdown
          estT = hold.estT as number
        } else {
          est = restEstimateMin(phs, targetIn, restIn, gateLossOpts)
          estT = now
        }
        hold = { ...hold, checkedT: now, checkedTaskId: targetId, resumeMin: chk.minutes, estRestMin: est, infeasibleNow: !chk.ok && est === null, estT, checkKey: phsIn.key }
      }
    }
    if (resumeBout !== null && ctx.task !== null && ctx.task.id !== resumeBout.taskId) resumeBout = null
  }
  const boutMin =
    hold === null && resumeBout !== null && ctx.task !== null && ctx.task.id === resumeBout.taskId && minutesNow !== null && minutesNow >= PT.highFromMin && minutesNow <= PT.cautionAboveMin
      ? Math.floor(minutesNow - PT.highFromMin)
      : null

  // ── 6. Channels ──
  // Physiology first: monitored mode needs its validity.
  const phy = physiologyLevel({
    t: now,
    minutes: physio.minutes,
    initT: physio.track.initT,
    consented: physioConsented,
    physioDisabled: hrDisabled,
    conservativeMode: cons.conservative,
    ...(isNum(profile.ageYears) ? { ageYears: profile.ageYears } : {}),
  })

  // Monitored mode (RISK_THRESHOLDS.monitoring), per worker and per step; 'tables' (or absent) leaves the channel as before.
  const planBasis: PlanBasis = ctx.planBasis === 'monitored' ? 'monitored' : 'tables'
  const MON = RISK_THRESHOLDS.monitoring
  const monitorChecks: MonitoringChecks | null =
    planBasis === 'monitored'
      ? {
          status: acclim.status !== 'acclimatized' || cons.conservative,
          consent: !physioConsented || hrDisabled,
          data: !phy.status.channelValid || recentValidMinutes(physio.minutes, now, MON.recentWindowMin) < MON.minValidInWindow,
        }
      : null
  const monitorReason = monitorChecks === null ? null : monitoringReason(monitorChecks, phsModelOk(phsIn, validity.withinLimits))
  const monitored = monitorChecks !== null && monitorReason === null
  const env = evaluateEnvironment(ctx, clothing, acclim, cons, hotWorkMinToday, monitored)
  if (monitored) {
    monitorValidT = now
  } else if (monitorReason !== null && monitorValidT !== null) {
    // Monitoring lapsed this shift: the table level applies in this same step (an escalation needs no dwell). The text
    // names the reason on the worker's own device only (it can reveal consent or health status).
    env.result.drivers.push(
      makeDriver('monitoring_fallback_tables', 'environment', MONITORING_FALLBACK_TEXT[monitorReason], RISK_ORDER[env.tableLevel] > RISK_ORDER.caution ? 'raises' : 'info', MON.basis),
    )
  }

  const floor = floorFor(ctx, ctx.task, ctx.location, env.workClass, acclim, pack)
  const regulation: ChannelResult = { channel: 'regulation', level: floor.level, available: true, drivers: [...floor.drivers] }

  // Task hold (TaskHold; RISK_THRESHOLDS.taskHold): a regulation/environment stop driven by the current task — or, for a
  // resting worker whose device already shows stop, by the task to resume — is held while the worker rests, until the
  // task to resume, at the current conditions, its location and clothing, is free of those stops and its ISO 7933 resume
  // check passes (checked every step; the other channels keep their dwell). The engine owns the resume decision (this
  // replaces worldsim 1.2.0 resumeTaskAllowed). While the worker is at a task the hold follows that task's live stops.
  const envLiveLevel = env.result.level
  const regLiveLevel = regulation.level
  const liveStops = stopCausesOf(env, floor)
  const holdActions: ActionId[] = []
  let taskShortcut = false
  let taskReleasedId: string | null = null
  const restingNow = ctx.task === null
  let targetEnv: EnvironmentEval | null = null
  let targetStops: StopCauses | null = null
  const targetStopsOf = (): StopCauses => {
    if (targetStops !== null) return targetStops
    if (resumeTarget === null) {
      targetStops = { heldBy: [], causes: [] }
    } else if (ctx.task !== null && resumeTarget.task.id === ctx.task.id && resumeTarget.location === ctx.location) {
      targetEnv = env
      targetStops = liveStops
    } else {
      const tClothing = clothingFor(resumeTarget.task, profile)
      const tMonitored =
        monitorChecks !== null && monitoringReason(monitorChecks, phsModelOk(phsInputsFor(ctx, tClothing, acclim, resumeTarget.task, resumeTarget.location))) === null
      const tEnv = evaluateEnvironment({ ...ctx, task: resumeTarget.task, location: resumeTarget.location }, tClothing, acclim, cons, hotWorkMinToday, tMonitored)
      targetEnv = tEnv
      targetStops = stopCausesOf(tEnv, floorFor(ctx, resumeTarget.task, resumeTarget.location, tEnv.workClass, acclim, pack))
    }
    return targetStops
  }
  if (taskHold === null) {
    // E1: the current task drives the stop. E2: a resting worker whose device shows stop (or holds a projection stop)
    // would return to a task those channels stop now (the former simulator check, moved into the engine).
    const e1 = ctx.task !== null && liveStops.heldBy.length > 0
    const e2 = !e1 && restingNow && resumeTarget !== null && (hold !== null || (!newShift && atLeast(state.displayed.level, 'stop'))) && targetStopsOf().heldBy.length > 0
    if (e1 || e2) {
      taskHold = { since: now, taskId: e1 ? (ctx.task as Task).id : (resumeTarget as { task: Task }).task.id, heldBy: [], causes: [], checkedT: null, checkedTaskId: null, nextCheckT: null, infeasible: false }
    }
  }
  if (taskHold !== null) {
    // At a task: that task's live stops. Resting or idle: the task to resume (and the resting activity itself).
    const by: StopCauses = !restingNow ? liveStops : targetStopsOf().heldBy.length > 0 ? targetStopsOf() : liveStops
    const checkedTaskId = !restingNow ? (ctx.task as Task).id : (resumeTarget?.task.id ?? null)
    if (by.heldBy.length > 0) {
      taskHold = {
        ...taskHold,
        heldBy: by.heldBy,
        causes: by.causes,
        checkedT: now,
        checkedTaskId,
        nextCheckT: taskHoldNextCheckT(by.causes, now, pack),
        infeasible: by.causes.includes('exposure_budget'),
      }
      if (restingNow) {
        // Resting: the held channels stay at stop (a live stop of the resting activity itself is already shown).
        for (const chId of taskHold.heldBy) {
          const result = chId === 'regulation' ? regulation : env.result
          if (atLeast(result.level, 'stop')) continue
          result.level = 'stop'
          const h = taskHoldDrivers(taskHold, chId, pack, targetEnv)
          result.drivers.push(...h.drivers)
          holdActions.push(...h.actions)
        }
      }
    } else if (!restingNow || resumeTarget === null) {
      // At a task free of those stops (the task resumed, or another task), or nothing to resume: the hold ends without
      // the release shortcut, so the level follows the normal 10-min dwell (the anti-chatter deadband for a worker who is
      // not resting, as before the hold existed) [ENG, protective].
      taskHold = null
    } else if (recovery !== null || hold !== null) {
      // The regulation/environment stops are over; a reviewed recovery or a projection hold keeps the worker at stop and
      // owns the rest of the wait (its own release rules apply).
      taskHold = null
    } else {
      // The task to resume is free of those stops: its ISO 7933 resume check must pass too (≥ highFromMin + minBoutMin
      // min, the projection hold's rule), so a release gives at least a minimum work bout [ENG, ANSI/ISA-18.2 deadband].
      const targetIn = phsInputsFor(ctx, clothingFor(resumeTarget.task, profile), acclim, resumeTarget.task, resumeTarget.location)
      const chk = phsIn.applicable ? resumePasses(phs, targetIn, gateLossOpts) : { ok: false, minutes: null, unchecked: true }
      if (chk.ok) {
        taskShortcut = true
        taskReleasedId = resumeTarget.task.id
        taskHold = null
        // The bout countdown of a projection release applies too (phs_work_bout).
        resumeBout = { taskId: resumeTarget.task.id, releasedT: now }
      } else if (chk.unchecked) {
        // Outside the model's scope: the hold ends without the release shortcut (the normal 10-min dwell applies).
        taskHold = null
      } else {
        // Not enough work time before the heat-strain limit: a projection hold takes over (its rest estimate and
        // "not feasible now" flag; released by its own resume check).
        const restLoc: WorkerLocation = ctx.location !== 'sun' ? ctx.location : resolveRestArea(ctx) === 'cooled_cabin' ? 'indoor_cool' : 'shade'
        const est = restEstimateMin(phs, targetIn, phsInputsFor(ctx, clothingFor(null, profile), acclim, null, restLoc), gateLossOpts)
        hold = {
          since: now,
          taskId: resumeTarget.task.id,
          checkedT: now,
          checkedTaskId: resumeTarget.task.id,
          resumeMin: chk.minutes,
          estRestMin: est,
          infeasibleNow: est === null,
          estT: now,
          checkKey: phsIn.key,
        }
        resumeBout = null
        taskHold = null
      }
    }
  }

  // Projection channel.
  const projDrivers: RiskDriver[] = []
  const projActions: ActionId[] = []
  let projLevel: RiskLevel = 'safe'
  let projAvailable = true
  if (recovery !== null) {
    // A reached limit holds stop until the reviewed recovery (also if the clothing later leaves the model's scope).
    const R = RISK_THRESHOLDS.recovery
    projLevel = 'stop'
    // Projection texts, ids, bases and values are identical whether drinking is restricted (fasting) or not, so a
    // supervisor cannot infer a drinking restriction (safety review 2c, HIGH); the drink/no-drink detail is in the
    // worker-only hydration drivers below.
    projDrivers.push(
      makeDriver(
        'phs_limit_reached',
        'projection',
        recovery.binding === 'dehydration' ? 'Heat-strain model: the water-loss limit is reached' : 'Heat-strain model: the body-heat limit for this shift is reached',
        'raises',
        PHS_BASIS,
        0,
        'min',
      ),
    )
    const restMin = recovery.restCooledMin + recovery.restShadeMin
    const outstanding = [
      recoveryNeeds.rest ? `rest ${Math.round(recoveryProgress(recovery) * 100)} % done` : null,
      recoveryNeeds.checkin ? 'check-in pending' : null,
      recoveryNeeds.signoff ? 'sign-off pending' : null,
      restartBlock === 'rectal' ? 'the model still shows the body-heat limit' : null,
      restartBlock === 'dehydration' ? 'the water-loss limit is not yet restored' : null,
    ]
      .filter((x): x is string => x !== null)
      .join('; ')
    const review = `work resumes only after ${R.cooledRestMin} min rest in a cooled area (${R.shadeRestMin} min in shade), a clear check-in and sign-off by a first aider or supervisor`
    projDrivers.push(
      makeDriver('phs_recovery_review_required', 'projection', `Heat-strain limit reached: ${review}${outstanding ? ` (${outstanding})` : ''}`, 'raises', R.basis, restMin, 'min'),
    )
    if (restartBlock === 'dehydration' && !water.restricted) {
      // Worker device only (hydration channel): the water figures stay off supervisor screens (privacy).
      extraDrivers.push(
        makeDriver(
          'phs_drink_to_restart',
          'hydration',
          `Drink water and rest: logged drinks count toward restarting heat work (net water loss ${((100 * water.netG) / (water.massKg * 1000)).toFixed(1)} % of body mass; restart at ${RISK_THRESHOLDS.hydrationCredit.restartNetLossFraction * 100} % or less)`,
          'info',
          `${R.basis}; ${RISK_THRESHOLDS.hydrationCredit.basis}`,
          (100 * water.netG) / (water.massKg * 1000),
          '% body mass',
        ),
      )
      projActions.push('drink_water')
    } else if (restartBlock === 'dehydration') {
      // Drinking restricted (fasting): the ISO 7933 no-drink allowance is per exposure and rest does not restore it.
      // Worker device only (hydration channel), like the fasting itself.
      extraDrivers.push(
        makeDriver(
          'phs_no_drink_no_restart',
          'hydration',
          'Not drinking (fasting): the water-loss allowance without drinking is used up and rest does not restore it, so no more heat work this shift',
          'info',
          `${R.basis}; ISO 7933:2023 Annex B (drink = 0 dehydration limit; the cumulative water loss is kept for the exposure [ENG])`,
        ),
      )
    }
    if (ctx.task === null) {
      projDrivers.push(
        makeDriver('phs_recovery_not_modelled', 'projection', 'Recovery after the limit cannot be modelled reliably: rest alone does not clear it', 'info', 'ISO 7933:2023 clause 5 WARNING (recovery not validly modelled)'),
      )
    }
    projActions.push('rest_shade_now', 'cool_down')
    if (!recoveryNeeds.rest && recoveryNeeds.checkin) projActions.push('symptom_checkin')
    if (!recoveryNeeds.rest && recoveryNeeds.signoff) projActions.push('first_aider_check')
  } else if (!phsIn.applicable) {
    projAvailable = false
    projDrivers.push(
      makeDriver('phs_not_applicable', 'projection', `${CLOTHING[clothing].label}: the heat-strain model does not apply; use physiological monitoring`, 'raises', `${CLOTHING[clothing].phs.note}; ISO 7933:2023 scope`),
    )
    lowerConfidence('low')
  } else {
    const baseLevel = projectionLevel(minutesNow)
    projLevel = baseLevel
    if (minutesNow === null) {
      projDrivers.push(makeDriver('phs_beyond_horizon', 'projection', `Heat-strain model: no limit within ${o.horizonMin} min at the current activity`, 'info', PHS_BASIS))
    } else {
      projDrivers.push(
        makeDriver('phs_minutes_to_limit', 'projection', `Heat-strain model: about ${Math.floor(minutesNow)} min to the ${proj.binding === 'dehydration' ? 'water-loss' : 'body-heat'} limit at the current activity`, atLeast(baseLevel, 'caution') ? 'raises' : 'info', PHS_BASIS, minutesNow, 'min'),
      )
    }
    if (hold !== null) {
      // Held stop: rest until the resume check passes (the resting projection alone does not release it).
      const RS = RISK_THRESHOLDS.resume
      projLevel = 'stop'
      projDrivers.push(
        makeDriver(
          'phs_resume_hold',
          'projection',
          hold.infeasibleNow
            ? `Rest before going back to work: even ${RS.restMaxMin} min of rest would not give ${resumeNeedMin} min of work time before the heat-strain limit`
            : hold.estRestMin !== null && hold.estRestMin > 0
              ? `Rest before going back to work: about ${hold.estRestMin} min more rest is needed for ${resumeNeedMin} min of work time before the heat-strain limit`
              : `Rest before going back to work: the heat-strain check is repeated every ${o.projectionEveryMin} min`,
          'raises',
          RS.basis,
          hold.estRestMin ?? undefined,
          hold.estRestMin !== null ? 'min' : undefined,
        ),
      )
      projActions.push('rest_shade_now', 'cool_down')
      if (hold.infeasibleNow) {
        projDrivers.push(makeDriver('task_not_feasible_now', 'projection', 'Current task is too hot to resume now: a lighter or cooler task is needed', 'raises', RS.basis))
        projActions.push('rotate_task')
      }
    } else {
      if (projLevel === 'caution') projActions.push('drink_water')
      else if (projLevel === 'high') projActions.push('shade_breaks', 'reduce_intensity', 'drink_water')
      else if (atLeast(projLevel, 'stop')) projActions.push('rest_shade_now', 'cool_down')
      if (boutMin !== null) {
        projDrivers.push(makeDriver('phs_work_bout', 'projection', `About ${boutMin} min of work left before the next rest`, 'info', `${PHS_BASIS}; ${RISK_THRESHOLDS.resume.basis}`, boutMin, 'min'))
      }
    }
  }
  const waterActions: ActionId[] = []
  if (!water.restricted && water.creditL > 0 && phsIn.applicable) {
    // Worker device only (hydration channel): logged drinking extends the water-loss limit, never below ISO 7933 and
    // never above 7.5 % of body mass; beyond the ISO 5 % an electrolyte drink is recommended (sodium losses).
    const tail = water.capped ? ': at the 7.5 % ceiling, add an electrolyte drink' : water.extended ? ': add an electrolyte drink' : ''
    extraDrivers.push(
      makeDriver(
        'phs_water_credit',
        'hydration',
        `Logged drinks counted: water-loss limit ${(water.thresholdG / 1000).toFixed(1)} L (net loss ${((100 * water.netG) / (water.massKg * 1000)).toFixed(1)} % of body mass)${tail}`,
        'info',
        RISK_THRESHOLDS.hydrationCredit.basis,
        water.creditL,
        'L',
      ),
    )
    if (water.extended) waterActions.push('electrolytes')
  }
  if (phsIn.applicable) {
    if (!validity.withinLimits) {
      projDrivers.push(
        makeDriver('phs_out_of_validity', 'projection', `Conditions outside the model's validity range (${validity.failing.map((f) => f.field).join(', ')}): lower confidence`, 'info', 'ISO 7933:2023 Annex A Table A.1 validity ranges'),
      )
      lowerConfidence('medium')
    }
    if (!phsIn.verified) {
      projDrivers.push(makeDriver('phs_clothing_unverified', 'projection', `${CLOTHING[clothing].label}: clothing insulation values are not verified`, 'info', CLOTHING[clothing].phs.note))
      lowerConfidence('medium')
    }
    if (fasting) {
      // Hydration channel: fasting is personal and never appears in supervisor-visible channels (privacy).
      extraDrivers.push(makeDriver('phs_no_drinking', 'hydration', "Not drinking (fasting): the heat-strain model's stricter water-loss limit applies", 'raises', 'ISO 7933:2023 Annex B (drink = 0 dehydration limit)'))
    }
  }
  if (recovery === null && phsRestartedAt !== null && now - phsRestartedAt < RISK_THRESHOLDS.recovery.restartedNoticeMin * MINUTE_MS) {
    projDrivers.push(
      makeDriver('phs_restarted_after_review', 'projection', 'Heat-strain model restarted from a conservative post-rest state after a reviewed recovery', 'info', RISK_THRESHOLDS.recovery.basis),
    )
  }
  const projectionCh: ChannelResult = { channel: 'projection', level: projLevel, available: projAvailable, drivers: projDrivers }

  // Physiology channel (computed above, before the environment channel).
  // physio.ts (wave 1) reports 'signal_unusable' while fewer than 10 minutes exist, i.e. during the first 10 min of
  // the 30-min warm-up as well: treat the warm-up as start-up (no 'check_sensor', no confidence penalty) [ENG]. Once
  // physio.ts checks the warm-up first this is a no-op.
  const physioStartup = !phy.status.warmupDone
  const phyActions = physioStartup ? phy.actions.filter((a) => a !== 'check_sensor') : phy.actions
  if (physioConsented && !hrDisabled && !physioStartup && (phy.status.reason === 'no_signal' || phy.status.reason === 'signal_unusable')) {
    lowerConfidence('medium')
  }

  const channels: Record<ChannelId, ChannelResult> = {
    environment: env.result,
    regulation,
    projection: projectionCh,
    physiology: plainChannel(phy),
    symptoms: plainChannel(sym),
    hydration: plainChannel(hyd),
  }
  const actionSet: ActionId[] = [...env.actions, ...floor.actions, ...holdActions, ...projActions, ...waterActions, ...phyActions, ...sym.actions, ...hyd.actions]

  // ── 7. Latch and no-hot-work rule ──
  const latestIntakeT = intakes.length > 0 ? intakes[intakes.length - 1].t : null
  let trigger: { tier: ClinicalTier; channel: ChannelId; t: number } | null = null
  const consider = (tier: ClinicalTier, channel: ChannelId, t: number): void => {
    if (tier < 2) return
    if (trigger === null || tier > trigger.tier) trigger = { tier, channel, t: Math.max(t, trigger?.t ?? -Infinity) }
    else trigger.t = Math.max(trigger.t, t)
  }
  if (atLeast(sym.level, 'stop')) consider(Math.max(sym.tier, 2) as ClinicalTier, 'symptoms', latestUsable?.t ?? now)
  if (atLeast(phy.level, 'stop')) consider(Math.max(phy.tier, 2) as ClinicalTier, 'physiology', now)
  if (atLeast(hyd.level, 'stop')) {
    const evidenceT = Math.max(latestUsable?.t ?? -Infinity, latestIntakeT ?? -Infinity)
    consider(atLeast(hyd.level, 'emergency') ? 3 : 2, 'hydration', Number.isFinite(evidenceT) ? evidenceT : now)
  }
  const trig = trigger as { tier: ClinicalTier; channel: ChannelId; t: number } | null

  let latch: ClinicalLatch | null = state.latch ? { ...state.latch } : null
  if (latch && latch.clearedAt !== undefined && !(latch.noHotWorkUntil !== undefined && now < latch.noHotWorkUntil)) latch = null
  const endOfDay = dayStartT + DAY_MS
  if (trig) {
    if (latch === null || latch.clearedAt !== undefined) {
      const keepUntil = latch?.noHotWorkUntil
      latch = { tier: trig.tier, channel: trig.channel, since: now, lastTriggerT: trig.t, noHotWorkUntil: Math.max(endOfDay, keepUntil ?? -Infinity) }
    } else {
      if (trig.tier > latch.tier) {
        latch.tier = trig.tier
        latch.channel = trig.channel
      }
      latch.lastTriggerT = Math.max(latch.lastTriggerT, trig.t)
      latch.noHotWorkUntil = Math.max(latch.noHotWorkUntil ?? -Infinity, endOfDay)
    }
  }
  if (inputs.resolution && latch && latch.clearedAt === undefined && inputs.resolution.t >= latch.since) {
    if (latch.resolvedAt === undefined || inputs.resolution.t >= latch.resolvedAt) {
      latch.resolvedAt = inputs.resolution.t
      latch.resolvedBy = inputs.resolution.by
    }
  }
  if (latch && latch.clearedAt === undefined && trig === null) {
    const resolutionValid = latch.resolvedAt !== undefined && latch.resolvedAt >= latch.lastTriggerT
    const cleanRecheck = latestUsable !== undefined && latestUsable.t > latch.lastTriggerT && sym.tier < 2 && isCleanCheckin(latestUsable)
    if (resolutionValid && cleanRecheck) latch.clearedAt = now
  }
  if (latch && latch.clearedAt === undefined) {
    const ch = channels[latch.channel]
    const lvl = TIER_TO_LEVEL[latch.tier]
    ch.level = maxLevel(ch.level, lvl)
    ch.available = true
    const waiting =
      latch.resolvedAt !== undefined && latch.resolvedAt >= latch.lastTriggerT
        ? 'resolved; waiting for a symptom-free re-check'
        : 'waiting for a first aider or supervisor to resolve the case after a symptom-free re-check'
    ch.drivers.push(makeDriver('clinical_latch', latch.channel, `${lvl === 'emergency' ? 'Emergency' : 'Stop'} stays in force: ${waiting}`, 'raises', LATCH_BASIS))
    actionSet.push(...latchActions(latch.tier))
  }
  if (latch && latch.noHotWorkUntil !== undefined && now < latch.noHotWorkUntil) {
    const ch = channels[latch.channel]
    if (isSunWork(ctx)) {
      ch.level = maxLevel(ch.level, 'stop')
      ch.available = true
      ch.drivers.push(makeDriver('no_hot_work_today', latch.channel, 'No more hot work in the sun today after a heat-illness warning', 'raises', NO_HOT_WORK_BASIS))
      actionSet.push('stop_work', 'no_hot_work_today', 'rotate_task')
    } else {
      ch.drivers.push(makeDriver('no_hot_work_today', latch.channel, 'No more hot work in the sun today after a heat-illness warning', 'info', NO_HOT_WORK_BASIS))
      actionSet.push('no_hot_work_today')
    }
  }

  // ── 8. Fusion and dwell ──
  const channelList = CHANNEL_ORDER.map((id) => channels[id])
  const computed = channelList.reduce<RiskLevel>((acc, ch) => (ch.available ? maxLevel(acc, ch.level) : acc), 'safe')
  // Two auxiliary tracks with the live regulation/environment levels (without a task hold's forced stop): one without
  // the projection channel (a projection release drops to it), one with it (a task-hold release drops to it), so that a
  // release skips only its own hold's dwell while every other channel keeps its own.
  // A task-held channel's stop belongs to the hold (released by its resume check, not by a dwell): capped at HIGH in the
  // auxiliary tracks while the hold is active, so a release still dwells from HIGH (protective) [ENG].
  const taskHeld: readonly ChannelId[] = taskHold?.heldBy ?? []
  const liveLevelOf = (ch: ChannelResult): RiskLevel => {
    if (ch.channel !== 'environment' && ch.channel !== 'regulation') return ch.level
    const live = ch.channel === 'environment' ? envLiveLevel : regLiveLevel
    return taskHeld.includes(ch.channel) && atLeast(live, 'stop') ? 'high' : live
  }
  const computedOthers = channelList.reduce<RiskLevel>((acc, ch) => (ch.available && ch.channel !== 'projection' ? maxLevel(acc, liveLevelOf(ch)) : acc), 'safe')
  const computedExTask = channelList.reduce<RiskLevel>((acc, ch) => (ch.available ? maxLevel(acc, liveLevelOf(ch)) : acc), 'safe')
  const dwellMs = o.dwellMin * MINUTE_MS
  let { displayed, pending } = dwellStep({ displayed: state.displayed, pending: state.pending }, computed, now, dwellMs)
  dwellOthers = dwellStep(dwellOthers, computedOthers, now, dwellMs)
  dwellExTask = dwellStep(dwellExTask, computedExTask, now, dwellMs)
  // A projection release also ends the projection's stop inside the task-hold track.
  if (releasedNow) dwellExTask = releaseTrack(dwellExTask, computedExTask, dwellOthers, now)
  const anyRelease = releasedNow || taskShortcut
  if (anyRelease) {
    // A resume check (projection or task hold) is that hold's hysteresis: its release is not delayed by the dwell, while
    // the other channels keep theirs (their own track, which never saw the held stop). A hold still active elsewhere
    // keeps `computed` at stop, so nothing drops.
    ;({ displayed, pending } = releaseTrack({ displayed, pending }, computed, releasedNow ? dwellOthers : dwellExTask, now))
  }
  const level = displayed.level
  const held = RISK_ORDER[level] > RISK_ORDER[computed]
  if (held) {
    extraDrivers.push(
      makeDriver('level_held_dwell', 'environment', `Level held at ${level.toUpperCase()} for ${o.dwellMin} min after conditions ease`, 'info', RISK_THRESHOLDS.dwell.basis),
    )
    if (atLeast(level, 'stop')) actionSet.push('rest_shade_now')
    else if (level === 'high') actionSet.push('shade_breaks')
    else if (level === 'caution') actionSet.push('drink_water')
  }

  // ── 9. Work minutes (incl. the conservative next-stricter tier), conservative-mode prompts, water ──
  let regWorkMin = floor.workMinPerHour
  let stricterTierApplied = false
  if (cons.stricterEnvironment && floor.zone !== null && regWorkMin > 0) {
    const tier = stricterWorkRest(floor.zone, twlWorkCategory(env.workClass), pack)
    if (tier.workMinPerHour < regWorkMin) {
      regWorkMin = tier.workMinPerHour
      stricterTierApplied = true
      extraDrivers.push(
        makeDriver(
          'stricter_work_rest',
          'regulation',
          `Stricter personal work/rest schedule: at most ${tier.workMinPerHour} min work per hour`,
          'info',
          `${floor.zone.basis}; ARCHITECTURE.md §5 (next-stricter work/rest tier with a stricter personal limit) [ENG]`,
          tier.workMinPerHour,
          'min/h',
        ),
      )
    }
  }
  // The table cycle limits work minutes unless monitored mode is in force (then it is a guide: the projection and
  // physiology channels enforce; the regulation channel's schedule and the day plan still apply).
  const tableWorkMin = monitored ? 60 : env.allowed.workMinPerHour
  let workMinPerHour = atLeast(level, 'stop') ? 0 : Math.max(0, Math.min(60, tableWorkMin, regWorkMin))
  // The day plan's work minutes for this task and hour (which include the planner's ISO 7933 screen) [protective].
  const planned = ctx.plannedWorkMinPerHour
  let plannedCapApplied = false
  if (isNum(planned) && !atLeast(level, 'stop')) {
    const cap = Math.max(0, Math.min(60, planned))
    if (cap < workMinPerHour) {
      workMinPerHour = cap
      plannedCapApplied = true
      extraDrivers.push(
        makeDriver('work_rest_planned', 'environment', `Day plan: at most ${Math.floor(cap)} min work per hour on this task, rest the remainder`, 'info', 'engine/planner.ts day plan (NIOSH/ACGIH, rule pack and ISO 7933 screen); ARCHITECTURE.md §1.1', cap, 'min/h'),
      )
      if (cap > 0 && ctx.task !== null) actionSet.push('shade_breaks')
    }
  }
  // A dwell-held level keeps the previous work minutes, except at a resume release (the stop it held is over).
  if (held && !anyRelease && state.lastAssessment !== null && !atLeast(level, 'stop')) workMinPerHour = Math.min(workMinPerHour, state.lastAssessment.workMinPerHour)

  if (cons.conservative && atLeast(level, 'caution')) {
    const lastCheckinT = usableToday.length > 0 ? usableToday[usableToday.length - 1].t : null
    if (lastCheckinT === null || now - lastCheckinT >= RISK_THRESHOLDS.steps.conservativeCheckinEveryMin * MINUTE_MS) {
      extraDrivers.push(makeDriver('conservative_checkin_due', 'symptoms', 'Extra-care mode: a check-in is due (every 30 min from caution)', 'info', RISK_THRESHOLDS.steps.basis))
      actionSet.push('symptom_checkin')
    }
  }
  if (ctx.buddyAssigned === false) {
    if (cons.buddyMandatory) {
      extraDrivers.push(makeDriver('buddy_required', 'environment', 'Assign a buddy: this worker must not work alone', 'info', 'physio_and_clinical.md §10.9 (buddy mandatory); ARCHITECTURE.md §5'))
      actionSet.push('buddy_check')
    }
    if (floor.noLoneWork) {
      extraDrivers.push(makeDriver('lone_work_not_allowed', 'regulation', 'Lone work is not allowed in this heat zone: assign a buddy', 'info', floor.zone?.basis ?? 'ADOSH-SF CoP 11.0 v4.0'))
      actionSet.push('no_lone_work')
    }
  }
  if (ctx.heat.drivers.some((d) => d.id === 'wbgt_meter_model_mismatch')) {
    extraDrivers.push(makeDriver('meter_check_advised', 'environment', 'Check the site WBGT meter', 'info', 'Fail-safe data quality [ENG]'))
    actionSet.push('check_sensor')
  }
  if ((ctx.env?.drivers ?? []).some((d) => d.id === 'env_sensor_unavailable')) actionSet.push('check_sensor')

  let waterMlPerHour = 0
  const restrict = actionSet.includes('restrict_fluids')
  if (fasting) {
    extraDrivers.push(
      makeDriver('water_paused_fasting', 'hydration', 'Fasting: water recommendation paused (0 mL/h), no drink reminders - rest in shade and cool down', 'info', 'physio_and_clinical.md §10.9 (fasting); ARCHITECTURE.md §5 (no drink reminders during fasting hours)'),
    )
  } else if (restrict) {
    extraDrivers.push(makeDriver('water_restricted', 'hydration', 'Plain water restricted until assessed (suspected over-drinking)', 'raises', 'TB MED 507 (2022) §5-4b'))
  } else {
    const p = ctx.profile
    const massKg = isNum(p.massKg) && p.massKg > 0 ? p.massKg : DEFAULT_BODY_MASS_KG
    const heightCm = isNum(p.heightCm) && p.heightCm > 0 ? p.heightCm : DEFAULT_HEIGHT_CM
    // ISO 7933:2004 NOTE: 1 W/m² of sweat ≈ 2.67 g/h for a 1.8 m² person (phs_iso7933.md §3; phs.ts waterLossG).
    const sweatMlPerHour = (phs.sweatRateWm2 * 2.67 * duBoisAreaM2(massKg, heightCm)) / 1.8
    const minLph = floor.waterLph?.minLph
    const rec = recommendWaterMlPerHour({
      workW: env.workW,
      workClass: env.workClass,
      wbgtC: env.wbgtWorkEffC,
      sweatRateMlPerHour: sweatMlPerHour,
      ...(isNum(minLph) ? { regulatoryMinMlPerHour: minLph * 1000 } : {}),
      intakeTodayMl: hyd.fluid.todayL * 1000,
      hoursSweating: sweatingSinceT === null ? 0 : (now - sweatingSinceT) / HOUR_MS,
    })
    waterMlPerHour = rec.mlPerHour
    if (rec.electrolytesAdvised) actionSet.push('electrolytes')
  }

  // ── 10. Actions ──
  let actions = orderActions(actionSet)
  if (fasting || restrict || hyd.fluid.flags.includes('OVER_HOURLY_CAP')) actions = actions.filter((a) => a !== 'drink_water' && a !== 'electrolytes')
  if (workMinPerHour === 0) actions = actions.filter((a) => a !== 'shade_breaks')

  // ── 11. Confidence and data quality ──
  const envStatus = ctx.env
  const heatSource = ctx.heat.source
  if (envStatus) lowerConfidence(envStatus.confidence)
  if (envStatus?.stale) lowerConfidence('medium')
  if (heatSource === 'conservative_default' || envStatus?.source === 'conservative_default') lowerConfidence('low')
  else if (heatSource === 'cached_forecast') lowerConfidence('medium')
  const confidence = RANK_TO_CONFIDENCE[confidenceRank]
  const physiologyQuality: SignalQuality = physioConsented ? phy.status.signalQuality : 'absent'
  const dataQuality: DataQuality = {
    env: envStatus?.source ?? heatSource,
    physiology: physiologyQuality,
    network: ctx.network,
    stale: envStatus?.stale ?? false,
  }

  // ── 12. Drivers ──
  const channelLevels: Partial<Record<ChannelId, RiskLevel>> = {}
  for (const ch of channelList) channelLevels[ch.channel] = ch.level
  const allDrivers = [
    ...channelList.flatMap((ch) => ch.drivers),
    ...ctx.heat.drivers,
    ...(envStatus?.drivers ?? []),
    ...extraDrivers,
  ]
  const drivers = sortDrivers(allDrivers, channelLevels)

  const assessment: RiskAssessment = {
    workerId: profile.id,
    t: now,
    level,
    channels: channelList,
    drivers,
    actions,
    workMinPerHour,
    minutesToLimit: phsIn.applicable || recovery !== null ? minutesNow : null,
    waterMlPerHour,
    confidence,
    dataQuality,
  }

  const next: WorkerEngineState = {
    workerId: profile.id,
    shiftStartT,
    lastT: Math.max(state.lastT, now),
    phsT,
    phs,
    projection: proj,
    physio,
    checkins,
    intakes,
    latch,
    hotWorkMinToday,
    dayStartT,
    sweatingSinceT,
    displayed,
    pending,
    lastAssessment: assessment,
    phsRecovery: recovery,
    phsRestartedAt,
    projectionHold: hold,
    lastTask,
    resumeBout,
    dwellExProjection: dwellOthers,
    dwellExTaskHold: dwellExTask,
    taskHold,
    monitorValidT,
    lastHotWorkT,
  }
  // Resume detail: every active hold, and the earliest time the next check could release them all (null when the task
  // hold cannot release this shift).
  const heldBy: ResumeHolder[] = [...(hold !== null ? (['projection'] as const) : []), ...(taskHold?.heldBy ?? [])]
  let nextCheckT: number | null = null
  if (heldBy.length > 0 && !(taskHold !== null && taskHold.nextCheckT === null)) {
    const times = [hold !== null ? proj.t + o.projectionEveryMin * MINUTE_MS : null, taskHold?.nextCheckT ?? null].filter((x): x is number => x !== null)
    nextCheckT = times.length > 0 ? Math.max(...times) : null
  }
  const resumeDetail: ResumeDetail | null =
    heldBy.length > 0
      ? {
          held: true,
          heldBy,
          taskId: hold?.checkedTaskId ?? hold?.taskId ?? taskHold?.checkedTaskId ?? taskHold?.taskId ?? null,
          ready: false,
          boutMin: null,
          estRestMin: hold?.estRestMin ?? null,
          infeasibleNow: (hold?.infeasibleNow ?? false) || (taskHold?.infeasible ?? false),
          nextCheckT,
        }
      : anyRelease || boutMin !== null
        ? {
            held: false,
            heldBy: [],
            taskId: !releasedNow && taskShortcut ? taskReleasedId : (resumeBout?.taskId ?? null),
            ready: true,
            boutMin,
            estRestMin: anyRelease ? 0 : null,
            infeasibleNow: false,
            nextCheckT: null,
          }
        : null
  const waterDetail: PhsWaterDetail = {
    sweatLossL: water.sweatG / 1000,
    creditedIntakeL: water.creditL,
    netLossPctBM: (100 * water.netG) / (water.massKg * 1000),
    thresholdL: water.thresholdG / 1000,
    restricted: water.restricted,
    extended: water.extended,
    capped: water.capped,
  }
  const environmentDetail: EnvironmentDetail = {
    basis: planBasis,
    monitored,
    enforced: !monitored,
    workMinPerHour: env.allowed.f < 1 ? env.allowed.workMinPerHour : null,
    fallbackReason: monitorReason,
  }
  const drinkDetail: DrinkReminderDetail = {
    exposed: exposure !== null,
    exposure,
    reminder: restrict ? null : hyd.fluid.reminder,
    nextReminderAtMs: restrict ? null : hyd.fluid.nextReminderAtMs,
    locationWbgtEffC,
  }
  const recoveryDetail: PhsRecoveryDetail | null =
    recovery === null
      ? null
      : {
          limitT: recovery.limitT,
          binding: recovery.binding,
          restMinSinceLimit: recovery.restCooledMin + recovery.restShadeMin,
          restCooledMin: recovery.restCooledMin,
          restShadeMin: recovery.restShadeMin,
          restProgress: recoveryProgress(recovery),
          needs: { ...recoveryNeeds },
          restartable: restartBlock === null,
          blockedBy: restartBlock,
        }
  const detail: WorkerStepDetail = {
    computedLevel: computed,
    held,
    acclimatization: acclim,
    conservative: cons,
    allowedWork: env.allowed,
    regulation: floor,
    projection: proj,
    phsApplicable: phsIn.applicable,
    phsWithinLimits: validity.withinLimits,
    physioDisplay: phy.display,
    hotWorkMinToday,
    hotWorkBudgetMin: env.budgetMin,
    latch,
    workW: env.workW,
    wbgtWorkEffC: env.wbgtWorkEffC,
    wbgtRestEffC: env.wbgtRestEffC,
    restArea: env.restArea,
    restWbgtC: env.restWbgtC,
    stricterTierApplied,
    phsRecovery: recoveryDetail,
    phsRestartedAt,
    water: waterDetail,
    resume: resumeDetail,
    plannedCapApplied,
    environment: environmentDetail,
    drink: drinkDetail,
  }
  return { state: next, assessment, detail }
}

/**
 * Stateless what-if assessment (planner, "what if this task now?"): a fresh engine (or the given partial state)
 * evaluated at `ctx.now` with no time advance and no dwell — PHS starts from the ISO 7933 initial state unless
 * `partialState.phs` is given. Latches, pending recovery reviews, a projection hold (its resume check runs at once,
 * against `ctx.resumeTask` / `ctx.task`) and check-ins in `partialState` are honoured.
 */
export function assessSnapshot(ctx: WorkerContext, partialState: Partial<WorkerEngineState> = {}): RiskAssessment {
  const base = createWorkerEngine(ctx.profile, partialState.shiftStartT ?? ctx.now)
  const state: WorkerEngineState = {
    ...base,
    ...partialState,
    workerId: ctx.profile.id,
    lastT: ctx.now,
    phsT: ctx.now,
    projection: null,
    displayed: { level: 'safe', since: ctx.now },
    pending: null,
    dwellExProjection: { displayed: { level: 'safe', since: ctx.now }, pending: null },
    dwellExTaskHold: { displayed: { level: 'safe', since: ctx.now }, pending: null },
  }
  return stepWorkerEngine(state, ctx, {}, { dwellMin: 0 }).assessment
}
