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
 *   ≈ 40 % replacement) becomes max(5 %, 3 % + credited logged intake), never below ISO; a reached water-loss limit
 *   restarts after the reviewed recovery once the net loss is ≤ 2 % of body mass ({@link RISK_THRESHOLDS}.hydrationCredit);
 * - projection hold: a projection-driven stop (< 15 min to a limit) stays until the engine's resume check projects
 *   ≥ 25 min for the task the worker returns to (15 + a 10-min minimum bout: an ANSI/ISA-18.2 deadband), with a rest
 *   estimate and a "task not feasible now" flag ({@link RISK_THRESHOLDS}.resume); the release skips the dwell;
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
  hydrationChannel,
  physioDisabled,
  symptomsChannel,
  type ConservativeModeResult,
} from './clinical'
import { DAY_MS, DUBAI_OFFSET_MS, HOUR_MS, MINUTE_MS } from './time'

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
   * The task the worker returns to after rest (the device knows the assignment), used by the resume check of a
   * projection hold ({@link RISK_THRESHOLDS}.resume). Absent or null → the current task, else the last task seen this
   * shift (kept in {@link WorkerEngineState.lastTask}) [protective]. Its location is the current one when it is the
   * current task, the last one seen for the last task, else sun/shade from `Task.inSun`.
   */
  resumeTask?: Task | null
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

/**
 * Resume state for the worker's own screen ({@link WorkerStepDetail.resume}); null when there is no hold, no release
 * this step and no bout countdown.
 */
export interface ResumeDetail {
  /** A projection hold is active after this step. */
  held: boolean
  /** The task the resume check projects (the hold) or the task released (the countdown); null = no task. */
  taskId: string | null
  /** True when the resume check passed (the release step and the countdown that follows). */
  ready: boolean
  /** "About N min of work left before the next rest": floor(minutes to the limit − 15) while 15–45 min after a release. */
  boutMin: number | null
  /** Estimated rest before the check passes (5-min increments up to 60 min; 0 at the release); null when unknown. */
  estRestMin: number | null
  /** Even 60 min of rest would not pass the check: a lighter or cooler task is needed. */
  infeasibleNow: boolean
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
  /** The water-loss threshold applied: max(5 %, 3 % + credit) of body mass, or the ISO 3 % while drinking is restricted. */
  thresholdL: number
  /** Drinking restricted (fasting now or earlier this exposure): the ISO 7933 drink = 0 criterion applies unchanged. */
  restricted: boolean
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
  /** Dwell track of the fused level without the projection channel: a resume release drops to it at once. */
  dwellExProjection: DwellTrack
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
  /** Projection hold, resume check and bout countdown (null when none of them applies). */
  resume: ResumeDetail | null
  /** The day plan's work minutes per hour lowered the work minutes (WorkerContext.plannedWorkMinPerHour). */
  plannedCapApplied: boolean
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
    basis:
      'ISO 7933:2023 Annex B (D_max 5 % of body mass with drinking, 3 % without); the 5 % drink-allowed limit implies ≈ 40 % replacement (5 % sweat ≈ 3 % net); ACSM 2007 fluid replacement position stand (avoid > 2 % body-mass loss; 3 % net as the limit here); TB MED 507 (2022) hourly cap 1.5 qt; [ENG] credit 0.8 × Σ_hours min(logged, hourly cap) since the shift start — self-report may over-state intake; threshold max(5 %, 3 % + credit), never below ISO; no further intake assumed in projections; restart at net loss ≤ 2 % (1 % deadband below the 3 % criterion)',
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
  // regulation (engine-applied)
  'stricter_work_rest',
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
 * Credited fluid intake, litres (RISK_THRESHOLDS.hydrationCredit): 0.8 × Σ over local clock hours of
 * min(logged that hour, FLUID.HOURLY_CAP_L), over intakes with fromT ≤ t ≤ toT (and of `workerId` when given).
 * Non-positive or non-finite volumes are ignored. Pure.
 */
export function creditedIntakeL(intakes: readonly FluidIntake[], fromT: number, toT: number, workerId?: string): number {
  const H = RISK_THRESHOLDS.hydrationCredit
  const perHour = new Map<number, number>()
  for (const x of intakes) {
    if (workerId !== undefined && x.workerId !== workerId) continue
    if (!(x.t >= fromT && x.t <= toT) || !(x.ml > 0) || !Number.isFinite(x.ml)) continue
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
  /** Passed to minutesToLimit when the threshold is above ISO (drinking allowed); undefined = exactly ISO 7933. */
  lossOpts: PhsProjectionOptions | undefined
}

/**
 * Water-loss threshold and net loss for a PHS state (RISK_THRESHOLDS.hydrationCredit): drinking allowed → threshold
 * max(5 % BM, 3 % BM + credit), net = loss − max(credit, 0.4 × loss); drinking restricted (drink = 0 now or earlier
 * this exposure) → the ISO 3 % threshold, net = loss − credit. With no credit the threshold is exactly ISO 7933.
 */
function waterStatus(phs: PhsState, input: PhsInput, creditL: number): WaterStatus {
  const H = RISK_THRESHOLDS.hydrationCredit
  const massKg = input.massKg
  const restricted = phs.drinkRestricted || input.drink === 0
  // phs.ts waterLossG: ΣSW·2.67·A_Du/1.8/60 (ISO 7933:2004 NOTE), same operand order so thresholds agree exactly.
  const sweatG = (phs.evapLoadWm2Min * 2.67 * phsDuBoisAreaM2(massKg, input.heightM)) / 1.8 / 60
  const isoG = PHS_D_MAX_BODY_MASS_FRACTION.percentile95 * massKg * 1000
  const creditG = creditL * 1000
  const thresholdG = restricted
    ? PHS_D_MAX_BODY_MASS_FRACTION.drinkRestricted * massKg * 1000
    : Math.max(isoG, H.netLossFraction * massKg * 1000 + creditG)
  const netG = sweatG - (restricted ? creditG : Math.max(creditG, H.isoImpliedReplacement * sweatG))
  return {
    restricted,
    massKg,
    sweatG,
    creditL,
    isoG,
    thresholdG,
    netG,
    restartMaxNetG: H.restartNetLossFraction * massKg * 1000,
    lossOpts: !restricted && thresholdG > isoG ? { lossThresholdG: thresholdG } : undefined,
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
  }
}

// ═════════════════════════════════════ Channels ═════════════════════════════════════

interface EnvironmentEval {
  result: ChannelResult
  actions: ActionId[]
  allowed: AllowedWorkResult
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
 * Driver texts never name REL/RAL or the reason for a stricter personal limit (privacy, ARCHITECTURE.md §5).
 */
function evaluateEnvironment(
  ctx: WorkerContext,
  clothing: ClothingId,
  acclim: AcclimatizationAssessment,
  cons: ConservativeModeResult,
  hotWorkMinToday: number,
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
  let level = environmentLevel(allowed.f, allowed.marginC)
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
  if (allowed.f < 1) {
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
  if (acclim.maxExposureFraction < 1) {
    budgetMin = acclim.maxExposureFraction * RISK_THRESHOLDS.environment.budgetShiftMin
    const budgetBasis = `${acclim.basis}; budget = maxExposureFraction × 480 min [ENG]`
    if (isHotWork(ctx) && hotWorkMinToday >= budgetMin) {
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
    if (allowed.f < 1) actions.push('shade_breaks')
  } else if (level === 'high') {
    actions.push('shade_breaks', 'drink_water', 'rotate_task')
  } else if (atLeast(level, 'stop')) {
    actions.push('rest_shade_now', 'rotate_task', 'reduce_intensity', 'drink_water')
  }

  return {
    result: { channel: 'environment', level, available: true, drivers },
    actions,
    allowed,
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
 * barrier) cannot be checked and passes [ENG — the projection channel is unavailable for that clothing and the
 * environment channel's monitoring advice applies].
 */
function resumePasses(s: PhsState, target: PhsInputs, lossOpts: PhsProjectionOptions | undefined): { ok: boolean; minutes: number | null } {
  if (!target.applicable) return { ok: true, minutes: null }
  const need = RISK_THRESHOLDS.projection.highFromMin + RISK_THRESHOLDS.resume.minBoutMin
  const p = minutesToLimit(s, target.input, need, PHS_OPTS, lossOpts)
  return { ok: p.minutes === null || p.minutes >= need, minutes: p.minutes }
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
  const gapMin = (now - state.lastT) / MINUTE_MS
  if (gapMin >= o.newShiftGapMin) {
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
  }
  // The task to resume after a projection hold is resolved before this step's task becomes the last one seen.
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
  if (inputs.intake) intakes = [...intakes, inputs.intake].sort((a, b) => a.t - b.t)
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
  if (isHotWork(ctx)) {
    hotWorkMinToday += Math.min(stepMin, (now - dayStartT) / MINUTE_MS)
    if (sweatingSinceT === null) sweatingSinceT = now
  }
  const hyd = hydrationChannel({
    now,
    checkins,
    intakes,
    consented: checkinsConsented,
    fastingNow: fasting,
    sweatingSinceMs: sweatingSinceT,
    workerId: profile.id,
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

  // Reviewed recovery of a limit reached in an earlier step (RISK_THRESHOLDS.recovery; phs_iso7933.md §11.4).
  // A logged drink that raises the water-loss threshold forces a fresh projection (the countdown would be stale).
  let forceProjection = inputs.intake !== undefined && lossOpts !== undefined
  let recoveryNeeds = { rest: true, checkin: true, signoff: true }
  let restartBlock: 'rectal' | 'dehydration' | null = null
  // Would the post-rest state still be blocked? (horizon 0: only an already-reached limit is reported.) Rectal: the
  // model's own t_re ≥ 38 °C. Water, drinking restricted: the ISO no-drink limit is never restored this shift — also
  // when the 0.6 rule set it before the 3 % mark itself is crossed, which a horizon-0 check cannot see. Water, drinking
  // allowed: once the water-loss limit is or was involved, restart only at a net loss ≤ 2 % of body mass.
  const blockOf = (restarted: PhsState, reached: 'rectal' | 'dehydration' | null): 'rectal' | 'dehydration' | null => {
    const p = minutesToLimit(restarted, phsIn.input, 0, PHS_OPTS, lossOpts)
    if (p.minutes === 0 && (p.binding ?? 'rectal') === 'rectal') return 'rectal'
    if (water.restricted) return p.minutes === 0 || reached === 'dehydration' ? 'dehydration' : null
    return (reached === 'dehydration' || p.minutes === 0) && water.netG > water.restartMaxNetG ? 'dehydration' : null
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
  // part uses the threshold in force: with drinking allowed max(5 %, 3 % + credit) (exactly the 5 % mark without
  // credit), while restricted the ISO no-drink marks.
  const waterAtLimit = water.restricted ? phs.waterLoss5PctMin !== null || phs.waterLoss3PctMin !== null : water.sweatG >= water.thresholdG
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
  // A reached limit (while the model applies) starts a recovery review.
  if (recovery === null && phsIn.applicable && minutesNow === 0) {
    recovery = { limitT: now, binding: proj.binding, boutStartT: null, restCooledMin: 0, restShadeMin: 0, restMetT: null, signoff: null }
    recoveryNeeds = { rest: true, checkin: true, signoff: true }
    restartBlock = blockOf(postReviewPhsState(phs), proj.binding)
  }
  if (recovery !== null) minutesNow = 0

  // Projection hold and the engine-owned resume check (RISK_THRESHOLDS.resume). A reached limit is the recovery
  // review instead; a model that does not apply cannot hold.
  const PT = RISK_THRESHOLDS.projection
  const resumeNeedMin = PT.highFromMin + RISK_THRESHOLDS.resume.minBoutMin
  let releasedNow = false
  if (recovery !== null || !phsIn.applicable) {
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
      const chk = resumePasses(phs, targetIn, lossOpts)
      // The current activity itself must be out of the stop band too (a worker still at the task cannot be released).
      if (chk.ok && (minutesNow === null || minutesNow >= PT.highFromMin)) {
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
          est = restEstimateMin(phs, targetIn, restIn, lossOpts)
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
  const env = evaluateEnvironment(ctx, clothing, acclim, cons, hotWorkMinToday)

  const floor = regulatoryFloor({
    t: now,
    twlWm2: ctx.location === 'sun' ? ctx.heat.twlWm2 : ctx.location === 'shade' ? ctx.heat.twlShadeWm2 : cooledTwlWm2(ctx.heat),
    outdoorInSun: isSunWork(ctx),
    // ADOSH-SF TG v4.0 Table 1 note b exactly (new, or > 14 days off, during the first 7 days back). The stricter RAL
    // and the acclimatisation ramp of an 'acclimatizing' worker stay in the environment channel.
    acclimatization: acclim.adoshUnacclimatized ? 'unacclimatized' : 'acclimatized',
    workClass: env.workClass,
    wbgtC: locationWbgtC(ctx.heat, ctx.location),
    pack,
  })
  const regulation: ChannelResult = { channel: 'regulation', level: floor.level, available: true, drivers: [...floor.drivers] }

  // Projection channel.
  const projDrivers: RiskDriver[] = []
  const projActions: ActionId[] = []
  let projLevel: RiskLevel = 'safe'
  let projAvailable = true
  if (recovery !== null) {
    // A reached limit holds stop until the reviewed recovery (also if the clothing later leaves the model's scope).
    const R = RISK_THRESHOLDS.recovery
    projLevel = 'stop'
    projDrivers.push(
      makeDriver(
        'phs_limit_reached',
        'projection',
        recovery.binding === 'dehydration'
          ? water.restricted
            ? 'Heat-strain model: the water-loss limit for this shift is reached'
            : 'Heat-strain model: the water-loss limit is reached'
          : 'Heat-strain model: the body-heat limit for this shift is reached',
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
    ]
      .filter((x): x is string => x !== null)
      .join('; ')
    const review = `work resumes only after ${R.cooledRestMin} min rest in a cooled area (${R.shadeRestMin} min in shade), a clear check-in and sign-off by a first aider or supervisor`
    projDrivers.push(
      makeDriver(
        'phs_recovery_review_required',
        'projection',
        restartBlock !== 'dehydration'
          ? `Heat-strain limit reached: ${review}${outstanding ? ` (${outstanding})` : ''}`
          : water.restricted
            ? 'Heat-strain limit reached: the shift water-loss allowance is used up and rest does not restore it, so no more heat work this shift'
            : `Heat-strain limit reached: drink and rest: the water-loss limit is not yet restored; ${review}${outstanding ? ` (${outstanding})` : ''}`,
        'raises',
        restartBlock === 'dehydration' && !water.restricted ? `${R.basis}; ${RISK_THRESHOLDS.hydrationCredit.basis}` : R.basis,
        restMin,
        'min',
      ),
    )
    if (restartBlock === 'dehydration' && !water.restricted) {
      // Worker device only (hydration channel): the water figures stay off supervisor screens (privacy).
      extraDrivers.push(
        makeDriver(
          'phs_drink_to_restart',
          'hydration',
          `Drink water and rest: logged drinks count toward restarting heat work (net water loss ${((100 * water.netG) / (water.massKg * 1000)).toFixed(1)} % of body mass; restart at ${RISK_THRESHOLDS.hydrationCredit.restartNetLossFraction * 100} % or less)`,
          'info',
          RISK_THRESHOLDS.hydrationCredit.basis,
          (100 * water.netG) / (water.massKg * 1000),
          '% body mass',
        ),
      )
      projActions.push('drink_water')
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
  if (!water.restricted && water.creditL > 0 && phsIn.applicable) {
    // Worker device only (hydration channel): logged drinking extends the water-loss limit, never below ISO 7933.
    extraDrivers.push(
      makeDriver(
        'phs_water_credit',
        'hydration',
        `Logged drinks counted: water-loss limit ${(water.thresholdG / 1000).toFixed(1)} L (net loss ${((100 * water.netG) / (water.massKg * 1000)).toFixed(1)} % of body mass)`,
        'info',
        RISK_THRESHOLDS.hydrationCredit.basis,
        water.creditL,
        'L',
      ),
    )
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

  // Physiology channel.
  const phy = physiologyLevel({
    t: now,
    minutes: physio.minutes,
    initT: physio.track.initT,
    consented: physioConsented,
    physioDisabled: hrDisabled,
    conservativeMode: cons.conservative,
    ...(isNum(profile.ageYears) ? { ageYears: profile.ageYears } : {}),
  })
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
  const actionSet: ActionId[] = [...env.actions, ...floor.actions, ...projActions, ...phyActions, ...sym.actions, ...hyd.actions]

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
  const computedOthers = channelList.reduce<RiskLevel>((acc, ch) => (ch.available && ch.channel !== 'projection' ? maxLevel(acc, ch.level) : acc), 'safe')
  const dwellMs = o.dwellMin * MINUTE_MS
  let { displayed, pending } = dwellStep({ displayed: state.displayed, pending: state.pending }, computed, now, dwellMs)
  dwellOthers = dwellStep(dwellOthers, computedOthers, now, dwellMs)
  if (releasedNow) {
    // The resume check is the projection channel's hysteresis: its release is not delayed by the dwell, while the other
    // channels keep theirs (their own track, which never saw the projection's stop).
    const target = maxLevel(computed, dwellOthers.displayed.level)
    if (RISK_ORDER[target] < RISK_ORDER[displayed.level]) {
      displayed = { level: target, since: now }
      pending =
        RISK_ORDER[computed] < RISK_ORDER[target] && dwellOthers.pending !== null
          ? { level: maxLevel(dwellOthers.pending.level, computed), since: dwellOthers.pending.since }
          : null
    }
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
  let workMinPerHour = atLeast(level, 'stop') ? 0 : Math.max(0, Math.min(60, env.allowed.workMinPerHour, regWorkMin))
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
  if (held && !releasedNow && state.lastAssessment !== null && !atLeast(level, 'stop')) workMinPerHour = Math.min(workMinPerHour, state.lastAssessment.workMinPerHour)

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
  }
  const resumeDetail: ResumeDetail | null =
    hold !== null
      ? { held: true, taskId: hold.checkedTaskId ?? hold.taskId, ready: false, boutMin: null, estRestMin: hold.estRestMin, infeasibleNow: hold.infeasibleNow }
      : releasedNow || boutMin !== null
        ? { held: false, taskId: resumeBout?.taskId ?? null, ready: true, boutMin, estRestMin: releasedNow ? 0 : null, infeasibleNow: false }
        : null
  const waterDetail: PhsWaterDetail = {
    sweatLossL: water.sweatG / 1000,
    creditedIntakeL: water.creditL,
    netLossPctBM: (100 * water.netG) / (water.massKg * 1000),
    thresholdL: water.thresholdG / 1000,
    restricted: water.restricted,
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
  }
  return stepWorkerEngine(state, ctx, {}, { dwellMin: 0 }).assessment
}
