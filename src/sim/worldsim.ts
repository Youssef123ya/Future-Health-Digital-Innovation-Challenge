/**
 * World simulation — one site-day at 1-minute resolution, closed loop (docs/SIMULATION.md §3–§4). Implements the
 * sim/types.ts `WorldSimApi` contract (checked below with `satisfies`).
 *
 * Each minute [t, t+1) of the shift:
 *   A. (at t) scripted events and UI injections (incl. consent changes on the worker's own device), disruption windows,
 *      due acknowledgements, per-worker timers (first aid, sign-offs, check-in prompts), then each worker's activity:
 *      crew schedule → policy overrides (instructions followed with probability behaviour.compliance ×
 *      traits.complianceFactor, supervisor reassignment carried out with probability behaviour.supervisorFollowThrough,
 *      first aid).
 *   B. (at t+1) site heat once for the TRUTH (IFS analysis; the truth model computes its own human MRT with hot ground)
 *      and once for the ENGINE (the forecast that was available, or a site meter = truth WBGT + meter noise, through
 *      data/weather.ts resolveEnvironment so every fallback is the engine's own fail-safe chain); per worker the
 *      ground-truth step (sim/truth.ts), wearable samples → physio minute (zill_full, consent + band), drinking
 *      (truth.drinkDecision: a followed reminder replaces that minute's spontaneous drink; reminders only under Zill
 *      policies, none while fasting), the engine step
 *      (risk.stepWorkerEngine with the site rest area); then the alert engine (alerts.processAssessments with
 *      deescalationDwellMin 0 — the dwell is applied once, in risk.ts — or alerts.tick when nobody is assessed).
 *
 * Policies (docs/SIMULATION.md §4): ban_only = crew task list in listed order + MoHRE midday break + statutory break +
 * self-pacing (inside the truth model); site_index = ban_only + ADOSH TWL-zone work/rest cycles applied crew-wide from
 * the hourly forecast as an hourly dose carried across task changes (and the zone's exclusion of ADOSH-unacclimatised
 * workers); zill_env / zill_full = planner day plan
 * (planner.planDay on the forecast at shift start, with its ISO 7933 screen, executed in the plan's block-hour layout) +
 * acting on the engine's output (the device knows the assignment: WorkerContext.resumeTask and plannedWorkMinPerHour; a
 * rest episode ends when the device no longer asks for rest — the engine's projection hold owns that decision — and no
 * regulation/environment rule stops the resume task; device work/rest cycles are aligned with plan block-hours); shadow =
 * ban_only behaviour while the engine still runs and alerts and nobody acts on it.
 *
 * Mutability: `stepWorld` MUTATES the world in place and returns the same reference; `worldView` returns a fresh
 * snapshot object (safe to hand to React/zustand); `finishWorld` steps to the end of the shift if needed and returns a
 * cached SiteDayResult. A World holds RNG closures and is not JSON-serialisable.
 *
 * Evidence class: SIMULATED COHORT projections (docs/SIMULATION.md) — never measured health outcomes. Ground truth
 * (core temperature, true HR, hydration) appears only in Lab/evidence outputs (WorkerView.truth, WorkerMinute).
 * Randomness: sim/rng.ts only, forked per worker and purpose; the truth, drinking and first-aid streams do not depend on
 * the policy, so policies share random numbers (common random numbers). No Math.random / Date.now; performance.now()
 * is used only to report `timingMs`.
 */
import {
  RISK_ORDER,
  type ActionId,
  type Checkin,
  type ChannelId,
  type ConsentState,
  type Crew,
  type FluidIntake,
  type RiskAssessment,
  type RiskLevel,
  type Role,
  type Site,
  type SymptomId,
  type Task,
  type WorkerProfile,
} from '../engine/types'
import { HOUR_MS, MINUTE_MS, epochFromLocal } from '../engine/time'
import { computeSiteHeat, type SiteHeat } from '../engine/indices'
import { wbgtComponents } from '../engine/wbgt'
import {
  COOLED_REST,
  RISK_THRESHOLDS,
  assessSnapshot,
  createWorkerEngine,
  stepWorkerEngine,
  type CaseResolution,
  type WorkerContext,
  type WorkerEngineOptions,
  type WorkerEngineState,
  type WorkerInputs,
  type WorkerLocation,
  type WorkerStepDetail,
} from '../engine/risk'
import {
  ACK_ROLES,
  alertStats,
  createAlertEngine,
  processAssessments,
  acknowledge as ackAlert,
  resolve as resolveAlert,
  tick as tickAlerts,
  type AlertEngineState,
  type AlertPolicy,
  type EngineAlert,
  type Notification,
  type RosterEntry,
} from '../engine/alerts'
import { WORK_MIN_GRANULARITY, planDay, type CrewPlan, type DayPlan, type PlannerHour } from '../engine/planner'
import { getRulePack, isMiddayBreak, regulatoryFloor, twlZone, type RulePack } from '../engine/regulation'
import { assessAcclimatization, taskMetabolicW, wbgtEffectiveC } from '../engine/limits'
import { FLUID, SYMPTOM_RULES, TRIAGE_TIMING, fluidStatus, promptTimeout } from '../engine/clinical'
import { minuteSqi, type MinuteSqi } from '../engine/physio'
import {
  conservativeDefaultSample,
  createEnvSampler,
  noaaCosZenith,
  resolveEnvironment,
  type InstantEnvSample,
  type ResolvedEnvironment,
  type SensorReading,
  type WeatherSeries,
} from '../data/weather'
import { createRng, hashSeed, type Rng } from './rng'
import {
  activeSymptomIds,
  createWearableChain,
  drinkDecision,
  initTruth,
  respondToCheckin,
  sampleDailyCondition,
  sampleHiddenTraits,
  stepTruth,
  trueHeartRate,
  trueMetabolicW,
  truthRestMetabolicW,
  wearableSamples,
  withTruthParams,
  type DeepPartial,
  type HiddenTraits,
  type TruthInputs,
  type TruthParams,
  type TruthState,
  type WearableChainState,
} from './truth'
import type {
  ScriptedEvent,
  ShiftOutcome,
  SimBehaviour,
  SimConfig,
  SimData,
  SimDisruptions,
  SimEvent,
  SimWeather,
  SiteDayResult,
  SiteHour,
  TruthEventKind,
  WorkerMinute,
  WorkerSubgroup,
  WorkerView,
  WorldInjection,
  WorldSimApi,
  WorldView,
} from './types'

// ═════════════════════════════════════ Defaults and parameters ═════════════════════════════════════

/**
 * Version of this module's mechanics, part of every result stamp. 1.2.0: engine-owned resume (projection hold), the day
 * plan's ISO 7933 screen (forecast climate passed to the planner), plan block-hour execution layout, device work/rest
 * cycles aligned with plan block-hours, WorkerContext.resumeTask / plannedWorkMinPerHour.
 */
export const WORLDSIM_VERSION = '1.2.0'

/**
 * Default behaviour — every value is an [ASSUMPTION] swept in the sensitivity analysis (docs/SIMULATION.md §5):
 * compliance 0.7 (middle of the 0.5/0.7/0.9 sweep); median acknowledgement delays worker 1 min, buddy 2, supervisor 3,
 * first aider 2, occupational health 10; first aider on scene 4 min after acknowledging; the supervisor's direct
 * reassignment on a STOP is always carried out (supervisorFollowThrough 1 — the v0.1 behaviour; a value < 1 tests the
 * assumption that matters most for the compliance sweep, because the reassignment overrides a non-complying worker).
 */
export const DEFAULT_SIM_BEHAVIOUR: Readonly<SimBehaviour> = Object.freeze({
  compliance: 0.7,
  selfReportScale: 1,
  respondScale: 1,
  ackDelayMin: Object.freeze({ worker: 1, buddy: 2, supervisor: 3, first_aider: 2, occ_health: 10 }),
  firstAiderArrivalMin: 4,
  supervisorFollowThrough: 1,
})

/** No disruption (docs/SIMULATION.md §5 robustness baseline). */
export const DEFAULT_SIM_DISRUPTIONS: Readonly<SimDisruptions> = Object.freeze({ wearableDropout: 0, ppgNoiseMultiplier: 1 })

/** Default shift 05:00–17:00 local: early start used by UAE summer sites (and the planner tests) [ENG]. */
export const DEFAULT_SHIFT: Readonly<{ start: string; end: string }> = Object.freeze({ start: '05:00', end: '17:00' })

/** Mechanics constants of the world simulation; each value is cited or tagged. */
export const WORLD_PARAMS = Object.freeze({
  /** Site WBGT meter error, SD °C [ASSUMPTION; ISO 7243:2017 asks for ±0.5 °C sensor accuracy on Tg and Tnwb]. */
  meterNoiseSdC: 0.3,
  /** Log-normal spread of acknowledgement and summon delays around the role median [ASSUMPTION]. */
  ackDelaySigmaLn: 0.6,
  /** Minimum gap between check-in prompts: the first triage re-check interval (clinical.TRIAGE_TIMING). */
  promptMinGapMin: TRIAGE_TIMING.RECHECK_FIRST_MIN,
  /** An unanswered prompt closes after this long [ENG]; the buddy is sent at clinical.PROMPT_TIMEOUT (5 min). */
  promptExpireMin: 15,
  /** Ambulance team takes over this long after the first aider starts cooling [ASSUMPTION]. */
  emsHandoverMin: 20,
  /** First-aid cooling for an emergency, identical in every policy [ASSUMPTION: clinical.COOLING_PROTOCOL step 3, TACO/immersion]. */
  firstAidCooling: 'immersion' as 'towels' | 'immersion',
  /** Statutory break: at most 5 h of consecutive work, then ≥ 1 h rest (UAE Federal Decree-Law 33/2021 Art. 17 [UNVERIFIED clause]). */
  statutoryMaxWorkMin: 300,
  statutoryBreakMin: 60,
  /** A pause of at least this long interrupts "consecutive" work [ENG]. */
  breakResetMin: 15,
  /** The forecast on the device was fetched this long before the shift [ENG]; it refreshes hourly while online. */
  forecastFetchLeadMin: 60,
  /** Drink reminders: 250 mL every 20 min (clinical.FLUID; ARCHITECTURE.md §5) … */
  reminderEveryMin: FLUID.REMINDER_EVERY_MIN,
  reminderMl: FLUID.REMINDER_L * 1000,
  /** … sent while the worker is exposed: hot work within the last 30 min [ENG: reminders accompany heat exposure]. */
  reminderAfterHotWorkMin: 30,
  /** truth.drinkDecision's "on a break" boost applies in the first 15 min of a rest bout, not to hours of rest [ENG]. */
  breakDrinkWindowMin: 15,
  /** Fasting hours from dawn (sun 18.2° below the horizon) to sunset (−0.833°) [ASSUMPTION: Fajr angle]. */
  fajrCosZenith: -0.3123,
  sunsetCosZenith: -0.0145,
  /** Bounded lists in WorldView. */
  viewNotifications: 50,
  viewEvents: 200,
  basis:
    'docs/SIMULATION.md §3–§5; ARCHITECTURE.md §5–§6; clinical.TRIAGE_TIMING / PROMPT_TIMEOUT / FLUID / COOLING_PROTOCOL; values tagged [ASSUMPTION] are swept or documented in docs/SIMULATION.md',
})

/** Alert policy override: the de-escalation dwell is applied once, in risk.ts (ARCHITECTURE.md §6). */
const ALERT_OPTS: Partial<AlertPolicy> = Object.freeze({ deescalationDwellMin: 0 })

/** Input of {@link makeSimConfig}: site and date required, every other field optional (nested fields merged). */
export type SimConfigInput = Partial<Omit<SimConfig, 'behaviour' | 'disruptions' | 'engine'>> &
  Pick<SimConfig, 'siteId' | 'date'> & {
    behaviour?: Partial<Omit<SimBehaviour, 'ackDelayMin'>> & { ackDelayMin?: Partial<SimBehaviour['ackDelayMin']> }
    disruptions?: Partial<SimDisruptions>
    engine?: Partial<SimConfig['engine']>
  }

/**
 * A complete SimConfig from a partial one: seed 'zill-sim', policy zill_full, not shadow, {@link DEFAULT_SHIFT}, the
 * Abu Dhabi rule pack, {@link DEFAULT_SIM_BEHAVIOUR} (incl. supervisorFollowThrough 1), {@link DEFAULT_SIM_DISRUPTIONS},
 * PHS projection every 5 min (risk.RISK_THRESHOLDS), trace 'none'. Basis: sim/types.ts SimConfig.
 */
export function makeSimConfig(input: SimConfigInput): SimConfig {
  const b = input.behaviour ?? {}
  const config: SimConfig = {
    seed: input.seed ?? 'zill-sim',
    siteId: input.siteId,
    date: input.date,
    policy: input.policy ?? 'zill_full',
    shadow: input.shadow ?? false,
    shift: input.shift ? { ...input.shift } : { ...DEFAULT_SHIFT },
    packId: input.packId ?? 'abu-dhabi',
    behaviour: {
      compliance: b.compliance ?? DEFAULT_SIM_BEHAVIOUR.compliance,
      selfReportScale: b.selfReportScale ?? DEFAULT_SIM_BEHAVIOUR.selfReportScale,
      respondScale: b.respondScale ?? DEFAULT_SIM_BEHAVIOUR.respondScale,
      ackDelayMin: { ...DEFAULT_SIM_BEHAVIOUR.ackDelayMin, ...(b.ackDelayMin ?? {}) },
      firstAiderArrivalMin: b.firstAiderArrivalMin ?? DEFAULT_SIM_BEHAVIOUR.firstAiderArrivalMin,
      supervisorFollowThrough: b.supervisorFollowThrough ?? DEFAULT_SIM_BEHAVIOUR.supervisorFollowThrough,
    },
    disruptions: { ...DEFAULT_SIM_DISRUPTIONS, ...(input.disruptions ?? {}) },
    engine: { projectionEveryMin: input.engine?.projectionEveryMin ?? RISK_THRESHOLDS.projection.everyMin },
    trace: input.trace ?? 'none',
  }
  if (input.crews) config.crews = input.crews
  if (input.workers) config.workers = input.workers
  return config
}

/** Shift length in minutes (one simulated step per minute). Basis: docs/SIMULATION.md §3. */
export function shiftMinutes(config: Pick<SimConfig, 'date' | 'shift'>): number {
  const t0 = epochFromLocal(`${config.date}T${config.shift.start}`)
  const t1 = epochFromLocal(`${config.date}T${config.shift.end}`)
  return Math.max(0, Math.round((t1 - t0) / MINUTE_MS))
}

/**
 * Idle minutes of an outcome (no task assigned and no protective reason): shift − work − rest. Kept for compatibility:
 * outcomes from worldsim ≥ 1.1.0 carry the same number as ShiftOutcome.idleMin (work + rest + idle = shift minutes by
 * construction). Basis: sim/types.ts ShiftOutcome; docs/SIMULATION.md §5.
 */
export function idleMinutes(outcome: Pick<ShiftOutcome, 'workMin' | 'restMin'>, config: Pick<SimConfig, 'date' | 'shift'>): number {
  return shiftMinutes(config) - outcome.workMin - outcome.restMin
}

// ═════════════════════════════════════ Internal types ═════════════════════════════════════

/** Why a scheduled minute is not work (0 = work). */
const R_WORK = 0
const R_CYCLE = 1
const R_MIDDAY = 2
const R_STATUTORY = 3
const R_NO_TASK = 4
const R_ZONE = 5
const R_MANUAL = 6

type AckRole = keyof SimBehaviour['ackDelayMin']
const ACK_ROLE_SET: ReadonlySet<Role> = new Set<Role>(ACK_ROLES)
const isAckRole = (r: Role): r is AckRole => ACK_ROLE_SET.has(r)

/** Per-crew state: tasks and the baseline minute schedule of the policy. */
interface CrewSim {
  crew: Crew
  tasks: Task[]
  taskIndex: Map<string, number>
  supervisorId: string
  /** Per shift minute: task index (−1 none), scheduled work (1/0), reason (R_*), work location in the sun (1/0). */
  planTask: Int16Array
  planWork: Uint8Array
  planReason: Uint8Array
  planSun: Uint8Array
  /**
   * Per shift minute: the task the worker returns to after rest — this minute's task, else the next scheduled one
   * (WorkerContext.resumeTask; −1 none).
   */
  planNext: Int16Array
  /** Day-plan schedules only, per shift minute: the plan block's work min/h (PLAN_RATE_NONE outside task blocks). */
  planRate: Uint8Array
  /** Day-plan schedules only, per shift minute: the minute index where its plan block-hour starts (−1 none) and its wall minutes. */
  planBhStart: Int16Array
  planBhWall: Uint8Array
}

/** {@link CrewSim}.planRate outside a day-plan task block. */
const PLAN_RATE_NONE = 255

/** An engine rest episode (one compliance draw); it ends when the device no longer asks for rest (engine-owned resume). */
interface RestEpisode {
  since: number
  followed: boolean
  enforced: boolean
}

interface CycleEpisode {
  since: number
  followed: boolean
  workMinPerHour: number
  taskId: string
}

interface FirstAidCase {
  kind: 'emergency' | 'clinical'
  arrivalT: number
  startedT: number | null
  handoverT: number | null
}

interface Accumulators {
  workMin: number
  restMin: number
  idleMin: number
  hotWorkMin: number
  minutesCoreAbove385: number
  minutesByLevel: Record<RiskLevel, number>
  firstHighT: number | null
  firstStopT: number | null
  firstEmergencyT: number | null
  instructions: number
  followed: number
  prompted: number
  answered: number
  selfReported: number
  truth: Record<TruthEventKind, { count: number; firstT: number | null }>
  escalatedAlertIds: Set<string>
}

/** Per-worker simulation state (internal; exposed through {@link World} for inspection only). */
export interface WorkerSim {
  readonly index: number
  readonly id: string
  /** The profile as rostered at shift start (truth traits, subgroup and the worker's real behaviour use this one). */
  readonly rosterProfile: WorkerProfile
  /**
   * The profile the on-device engine sees: the roster profile with the worker's current consent (a 'consent' injection
   * replaces it; risk flags only while consent.healthFlags, engine/types.ts WorkerProfile.riskFlags contract).
   */
  profile: WorkerProfile
  readonly crew: CrewSim
  readonly traits: HiddenTraits
  readonly rng: { truth: Rng; drink: Rng; wear: Rng; checkin: Rng; behaviour: Rng; firstAid: Rng; supervisor: Rng }
  readonly chain: WearableChainState
  /** Wearable minutes reach the engine (zill_full, a paired wearable and consent.wearable). */
  physioActive: boolean
  readonly adoshUnacc: boolean
  /** The worker fasts (truth: no drinking in fasting hours, whatever the device knows). */
  readonly fastingFlag: boolean
  /** consent.checkins: prompted self check-ins; without it only in-person checks reach the engine. */
  checkinsConsented: boolean
  readonly restLocation: WorkerLocation
  truth: TruthState
  hrTrue: number
  engine: WorkerEngineState | null
  assessment: RiskAssessment | null
  detail: WorkerStepDetail | null
  level: RiskLevel
  task: Task | null
  location: WorkerLocation
  working: boolean
  status: 'work' | 'rest' | 'idle'
  cooling: 'none' | 'towels' | 'immersion'
  lastTaskId: string | null | undefined
  lastLocation: WorkerLocation | null
  manual: { task: Task | null; location: WorkerLocation } | null
  /** The scheduled task to return to after rest, passed as WorkerContext.resumeTask (null: the engine's own fallback). */
  resumeTask: Task | null
  /** The day plan's work min/h for this minute's task block, passed as WorkerContext.plannedWorkMinPerHour (null: none). */
  plannedRate: number | null
  rest: RestEpisode | null
  cycle: CycleEpisode | null
  /** A reassignment to rest waiting for the rest episode to start (first aider in person beats supervisor). */
  pendingEnforce: 'supervisor' | 'first_aider' | null
  pendingDrinkMl: number
  checkinQueue: Checkin[]
  intakeQueue: FluidIntake[]
  pendingResolution: CaseResolution | null
  scheduledResolution: { t: number; by: 'first_aider' | 'supervisor'; kind: 'latch' | 'phs' } | null
  inPersonCheckT: number | null
  prompt: { t: number; answered: boolean; buddyChecked: boolean } | null
  lastPromptT: number
  checkinSeq: number
  lastCheckin: Checkin | null
  firstAid: FirstAidCase | null
  attended: boolean
  evacuated: boolean
  lastHrBpm: number | null
  ectempC: number | null
  /** Start of the current non-work bout (null while working) and the last minute of hot work. */
  restBoutStartT: number | null
  lastHotWorkT: number
  acc: Accumulators
}

interface AckItem {
  t: number
  seq: number
  alertId: string
  role: AckRole
}

interface ScriptItem {
  t: number
  event: ScriptedEvent
}

interface SiteIndexFloor {
  workMinPerHour: number
  excludeUnacclimatized: boolean
}

type TruthWeather = Omit<TruthInputs, 'activity' | 'drankMl' | 'cooling' | 'radiantBoostC'>

/**
 * A simulated site-day. Treat as opaque: fields are internal and may change; read it through {@link worldView} and
 * {@link finishWorld}. `stepWorld` mutates it in place.
 */
export interface World {
  readonly kind: 'zill-world'
  readonly config: SimConfig
  readonly site: Site
  readonly pack: RulePack
  readonly weather: SimWeather
  readonly t0: number
  readonly tEnd: number
  readonly nMinutes: number
  readonly dayStart: number
  /** Start of the next minute to simulate (epoch ms). */
  t: number
  minuteIndex: number
  finished: boolean
  readonly engineOn: boolean
  readonly actsOnZill: boolean
  readonly schedule: 'listed' | 'site_index' | 'plan'
  readonly truthParams: TruthParams
  readonly engineOpts: WorkerEngineOptions
  readonly crews: CrewSim[]
  readonly workers: WorkerSim[]
  readonly workerById: Map<string, WorkerSim>
  readonly hours: SiteHour[]
  readonly plan: DayPlan | null
  readonly floors: Map<string, SiteIndexFloor>
  readonly anSampler: (t: number) => InstantEnvSample | null
  readonly forecastSeries: WeatherSeries
  forecastObtainedAt: number
  readonly forecastFixed: boolean
  readonly rosterOnline: Record<string, RosterEntry>
  readonly rosterOffline: Record<string, RosterEntry>
  /** Configured disruption windows [from, to) in epoch ms (SimDisruptions). */
  readonly windows: { sensor: readonly [number, number] | null; network: readonly [number, number] | null }
  manualSensorFail: boolean
  manualNetworkDown: boolean
  sensorFailed: boolean
  networkDown: boolean
  fastingNow: boolean
  heat: SiteHeat | null
  env: ResolvedEnvironment | null
  truthIn: TruthWeather | null
  alerts: AlertEngineState
  readonly alertLog: Map<string, EngineAlert>
  readonly notifications: Notification[]
  readonly events: SimEvent[]
  readonly minutes: WorkerMinute[] | null
  readonly agenda: AckItem[]
  agendaSeq: number
  /** Supervisor-side messages held by a network outage: undelivered notifications, or acknowledgements not yet sent. */
  readonly heldAcks: Array<{ alertId: string; role: AckRole; delivered: boolean }>
  readonly ackKeys: Set<string>
  readonly script: ScriptItem[]
  scriptPos: number
  readonly rngAck: Rng
  readonly rngMeter: Rng
  readonly stamp: string
  elapsedMs: number
  result: SiteDayResult | null
}

/** Options of {@link createWorld} / {@link runSiteDay}. */
export interface CreateWorldOptions {
  /** Scripted events (sim/scenarios.ts), applied at the start of the minute whose local time equals `at`. */
  script?: readonly ScriptedEvent[]
  /**
   * Ground-truth parameter overrides (sim/truth.ts TRUTH_PARAMS, deep-merged), e.g. the back-test's metabolic-spread
   * and symptom-hazard sweeps. The leaves the config already sets win over these: behaviour.reminderCompliance
   * (= config.behaviour.compliance), wearable.minuteLossProb (= disruptions.wearableDropout) and
   * wearable.noiseMultiplier (= disruptions.ppgNoiseMultiplier). Part of the result stamp.
   */
  truthParams?: DeepPartial<TruthParams>
}

// ═════════════════════════════════════ Small helpers ═════════════════════════════════════

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const round1 = (x: number): number => Math.round(x * 10) / 10
const round2 = (x: number): number => Math.round(x * 100) / 100
const atLeast = (l: RiskLevel, ref: RiskLevel): boolean => RISK_ORDER[l] >= RISK_ORDER[ref]
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const LOCATIONS: readonly WorkerLocation[] = ['sun', 'shade', 'indoor_cool']
const TRUTH_KINDS: readonly TruthEventKind[] = ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'symptom_onset']
const REST_ACTIONS: readonly ActionId[] = ['stop_work', 'rest_shade_now', 'midday_break']
/** Channel shown on a level event when several are at the fused level (most specific first) [ENG]. */
const CHANNEL_PRIORITY: readonly ChannelId[] = ['symptoms', 'physiology', 'projection', 'regulation', 'environment', 'hydration']

function log(w: World, ev: SimEvent): void {
  w.events.push(ev)
}

function emptyAcc(): Accumulators {
  const truth = {} as Record<TruthEventKind, { count: number; firstT: number | null }>
  for (const k of TRUTH_KINDS) truth[k] = { count: 0, firstT: null }
  return {
    workMin: 0,
    restMin: 0,
    idleMin: 0,
    hotWorkMin: 0,
    minutesCoreAbove385: 0,
    minutesByLevel: { safe: 0, caution: 0, high: 0, stop: 0, emergency: 0 },
    firstHighT: null,
    firstStopT: null,
    firstEmergencyT: null,
    instructions: 0,
    followed: 0,
    prompted: 0,
    answered: 0,
    selfReported: 0,
    truth,
    escalatedAlertIds: new Set(),
  }
}

/** The engine asks the worker to stop / rest now (level ≥ stop, or a rest action at a lower level). */
function needsRest(a: RiskAssessment): boolean {
  return atLeast(a.level, 'stop') || a.actions.some((x) => REST_ACTIONS.includes(x))
}

function restAction(a: RiskAssessment): ActionId {
  return REST_ACTIONS.find((x) => a.actions.includes(x)) ?? 'stop_work'
}

function drivingChannel(a: RiskAssessment): ChannelId | null {
  if (a.level === 'safe') return null
  const at = a.channels.filter((c) => c.level === a.level).map((c) => c.channel)
  return CHANNEL_PRIORITY.find((c) => at.includes(c)) ?? at[0] ?? null
}

function hourStart(w: Pick<World, 'dayStart'>, t: number): number {
  return w.dayStart + Math.floor((t - w.dayStart) / HOUR_MS) * HOUR_MS
}

function windowOf(date: string, win: { from: string; to: string } | undefined): readonly [number, number] | null {
  if (!win) return null
  if (!HHMM_RE.test(win.from) || !HHMM_RE.test(win.to)) throw new RangeError(`createWorld: disruption window ${win.from}–${win.to} must be HH:mm`)
  return [epochFromLocal(`${date}T${win.from}`), epochFromLocal(`${date}T${win.to}`)]
}

const inWindow = (win: readonly [number, number] | null, t: number): boolean => win !== null && t >= win[0] && t < win[1]

function delayMin(rng: Rng, median: number): number {
  if (!(median > 0)) return 0
  return Math.max(0, Math.ceil(rng.lognormal(median, WORLD_PARAMS.ackDelaySigmaLn)))
}

function isClean(c: Checkin): boolean {
  return c.symptoms.every((s) => (SYMPTOM_RULES[s]?.tier ?? 3) < 2)
}

/** The device knows the worker is fasting now: a consented 'fasting' risk flag in its profile, inside fasting hours. */
function deviceFasting(w: World, ws: WorkerSim): boolean {
  return w.fastingNow && ws.profile.riskFlags.includes('fasting')
}

const CONSENT_SCOPES = ['wearable', 'healthFlags', 'checkins', 'shareWithMedicOnEscalation', 'aggregateStatistics'] as const

/**
 * A consent change on the worker's own device ('consent' injection), effective from this minute: the engine sees the
 * roster profile with the new consent, and the self-declared risk flags only while consent.healthFlags (engine/types.ts
 * WorkerProfile.riskFlags contract; a re-grant restores the rostered flags — the worker re-declares the same factors
 * [ASSUMPTION]). Wearable off → the PPG stream stops and no physiology minute reaches the engine (risk.ts then reports
 * the physiology channel as not consented); check-ins off → no prompted check-ins (an open prompt is withdrawn) and
 * in-person checks only (see scheduleCaseSteps). The worker's real behaviour (truth, fasting, drinking) is unchanged.
 * Basis: ARCHITECTURE.md §1.5 and §7 (consent opt-in per scope, revocable at any time; raw data stays on the device).
 * @throws RangeError when a consent scope is not a boolean.
 */
function applyConsent(w: World, ws: WorkerSim, consent: ConsentState): void {
  if (consent === null || typeof consent !== 'object') throw new RangeError('stepWorld: consent must be a ConsentState object')
  for (const k of CONSENT_SCOPES) if (typeof consent[k] !== 'boolean') throw new RangeError(`stepWorld: consent.${k} must be a boolean`)
  const roster = ws.rosterProfile
  ws.profile = { ...roster, consent: { ...consent }, riskFlags: consent.healthFlags ? [...roster.riskFlags] : [] }
  ws.physioActive = w.engineOn && w.config.policy === 'zill_full' && roster.hasWearable && consent.wearable
  if (!ws.physioActive) {
    ws.lastHrBpm = null
    ws.ectempC = null
  }
  ws.checkinsConsented = consent.checkins
  if (!consent.checkins) ws.prompt = null
}

// ═════════════════════════════════════ Schedules ═════════════════════════════════════

function newCrewSim(crew: Crew, n: number): CrewSim {
  const tasks = crew.tasks.map((t) => ({ ...t }))
  return {
    crew,
    tasks,
    taskIndex: new Map(tasks.map((t, i) => [t.id, i])),
    supervisorId: `${crew.id}:supervisor`,
    planTask: new Int16Array(n).fill(-1),
    planWork: new Uint8Array(n),
    planReason: new Uint8Array(n).fill(R_NO_TASK),
    planSun: new Uint8Array(n),
    planNext: new Int16Array(n).fill(-1),
    planRate: new Uint8Array(n).fill(PLAN_RATE_NONE),
    planBhStart: new Int16Array(n).fill(-1),
    planBhWall: new Uint8Array(n),
  }
}

/** Fill {@link CrewSim}.planNext from the finished schedule: this minute's task, else the next scheduled one (one backward pass). */
function fillPlanNext(cs: CrewSim): void {
  let next = -1
  for (let i = cs.planTask.length - 1; i >= 0; i--) {
    if (cs.planTask[i] >= 0) next = cs.planTask[i]
    cs.planNext[i] = next
  }
}

/** Tolerance of the hourly ADOSH dose test (floating-point sums of 1/W) [ENG]. */
const DOSE_EPS = 1e-9

/**
 * Listed-order crew schedule (ban_only, shadow, site_index): tasks in roster order from the shift start, each needing
 * `durationMin` crew work minutes; sun tasks pause during the midday break (MoHRE MR 44/2022); site_index adds the TWL
 * zone cycle — work first, rest the rest of each clock hour [ENG layout] — as an hourly DOSE carried across task
 * changes: a minute of work on a task allowed W min/h adds 1/W, and work stops for the rest of the clock hour once the
 * next minute would take the dose above 1 (Σ minutes/allowance ≤ 1, the sum-of-fractions rule for mixed exposures that
 * sim/metrics.ts scores zone compliance with [ENG]); a single-task hour therefore keeps the W-minute work-first layout.
 * With W = 60 everywhere (ban_only, shadow) the dose never binds. A statutory break follows 5 h of consecutive work.
 * Mirrors planner.ts's naive comparison plan, plus the statutory break.
 */
function listedOrderSchedule(w: World, cs: CrewSim, cycleW: (hourT: number, task: Task) => number): void {
  const P = WORLD_PARAMS
  let k = 0
  let remaining = cs.tasks.length > 0 ? Math.max(0, Math.round(cs.tasks[0].durationMin)) : 0
  let consec = 0
  let off = 0
  let statLeft = 0
  let doseHour = Number.NaN
  let dose = 0
  for (let i = 0; i < w.nMinutes; i++) {
    const t = w.t0 + i * MINUTE_MS
    const h = hourStart(w, t)
    if (h !== doseHour) {
      doseHour = h
      dose = 0
    }
    while (k < cs.tasks.length && remaining <= 0) {
      k += 1
      remaining = k < cs.tasks.length ? Math.max(0, Math.round(cs.tasks[k].durationMin)) : 0
    }
    if (k >= cs.tasks.length) {
      cs.planReason[i] = R_NO_TASK
      statLeft = 0
      off += 1
      if (off >= P.breakResetMin) consec = 0
      continue
    }
    const task = cs.tasks[k]
    cs.planTask[i] = k
    cs.planSun[i] = task.inSun ? 1 : 0
    let reason = R_WORK
    let W = 60
    if (statLeft > 0) {
      reason = R_STATUTORY
      statLeft -= 1
    } else if (task.inSun && isMiddayBreak(t, w.pack)) {
      reason = R_MIDDAY
    } else {
      W = cycleW(h, task)
      if (!(W > 0) || dose + 1 / W > 1 + DOSE_EPS) reason = R_CYCLE
    }
    if (reason === R_WORK) {
      dose += 1 / W
      cs.planWork[i] = 1
      remaining -= 1
      consec += 1
      off = 0
      if (consec >= P.statutoryMaxWorkMin) {
        statLeft = P.statutoryBreakMin
        consec = 0
      }
    } else {
      off += 1
      if (off >= P.breakResetMin) consec = 0
    }
    cs.planReason[i] = reason
  }
}

/**
 * Work minutes of the 60-min layout window (counted from the block start) that contains minute `minuteInBlock` of a
 * plan block of `blockMin` minutes at `workMinPerHour`: W for a full window, floor(W·r/60) for the block's last, partial
 * window of r minutes — so a block never gets more work than the plan's wall × W/60 [ENG; rounded down, protective].
 * Since worldsim 1.2.0 the plan schedule follows the plan's block-hours (planner.ts BlockHour.startT/boutMin); this rule
 * is the fallback for a block without block-hours. Basis: planner.ts PlanBlock.workMin / RestCycle (work min per hour).
 */
export function planWindowWorkMin(workMinPerHour: number, blockMin: number, minuteInBlock: number): number {
  const W = Math.max(0, Math.min(60, workMinPerHour))
  const windowStart = minuteInBlock - (minuteInBlock % 60)
  const len = Math.max(0, Math.min(60, blockMin - windowStart))
  return len >= 60 ? W : Math.floor((W * len) / 60)
}

/**
 * Crew schedule from the planner's day plan (zill_env / zill_full): each block's task, location and work/rest layout.
 * The layout is the plan's own execution layout, per block-hour (planner.ts BlockHour: the block's part of one clock
 * hour): work during [startT, startT + boutMin), then rest in the rest area until startT + wallMin — the layout the
 * planner's ISO 7933 screen simulated, so following the plan keeps plan and monitor in agreement (engine-risk
 * integration note 2). A block without block-hours (none in practice) falls back to 60-min windows from the block start
 * with {@link planWindowWorkMin} [ENG]. No sun work in the midday break; then the statutory break (work lost, not
 * shifted, since plan blocks are time-bound). Also records, per minute, the block's work min/h (plannedWorkMinPerHour)
 * and its block-hour (device work/rest cycles are aligned with it).
 */
function planSchedule(w: World, cs: CrewSim, cp: CrewPlan | undefined): void {
  const idx = (t: number): number => Math.round((t - w.t0) / MINUTE_MS)
  for (const b of cp?.blocks ?? []) {
    const k = b.taskId === null ? -1 : (cs.taskIndex.get(b.taskId) ?? -1)
    const W = Math.max(0, Math.min(60, b.workMinPerHour))
    const from = Math.max(b.startT, w.t0)
    const to = Math.min(b.endT, w.tEnd)
    if (k < 0) {
      for (let t = from; t < to; t += MINUTE_MS) {
        const i = idx(t)
        if (i < 0 || i >= w.nMinutes) continue
        cs.planTask[i] = -1
        cs.planWork[i] = 0
        cs.planReason[i] = isMiddayBreak(t, w.pack) ? R_MIDDAY : R_NO_TASK
      }
      continue
    }
    const blockMin = Math.round((b.endT - b.startT) / MINUTE_MS)
    // Block-hours of this block (the planner's layout); a minute outside every block-hour uses the fallback windows.
    const hours = b.hours.filter((h) => h.wallMin > 0).map((h) => ({ a: h.startT, z: h.startT + h.wallMin * MINUTE_MS, bout: Math.max(0, Math.min(h.wallMin, h.boutMin)), wall: h.wallMin }))
    let hi = 0
    for (let t = from; t < to; t += MINUTE_MS) {
      const i = idx(t)
      if (i < 0 || i >= w.nMinutes) continue
      cs.planTask[i] = k
      cs.planSun[i] = b.location === 'sun' ? 1 : 0
      cs.planRate[i] = W
      while (hi < hours.length && t >= hours[hi].z) hi += 1
      const bh = hi < hours.length && t >= hours[hi].a ? hours[hi] : null
      let isWork: boolean
      if (bh) {
        cs.planBhStart[i] = idx(bh.a)
        cs.planBhWall[i] = bh.wall
        isWork = (t - bh.a) / MINUTE_MS < bh.bout
      } else {
        const sinceStart = Math.floor((t - b.startT) / MINUTE_MS)
        isWork = sinceStart % 60 < planWindowWorkMin(W, blockMin, sinceStart)
      }
      if (b.location === 'sun' && isMiddayBreak(t, w.pack)) {
        cs.planWork[i] = 0
        cs.planReason[i] = R_MIDDAY
      } else if (isWork) {
        cs.planWork[i] = 1
        cs.planReason[i] = R_WORK
      } else {
        cs.planWork[i] = 0
        cs.planReason[i] = R_CYCLE
      }
    }
  }
  const P = WORLD_PARAMS
  let consec = 0
  let off = 0
  let left = 0
  for (let i = 0; i < w.nMinutes; i++) {
    if (left > 0) {
      if (cs.planWork[i] === 1 || cs.planReason[i] === R_CYCLE) {
        cs.planWork[i] = 0
        cs.planReason[i] = R_STATUTORY
      }
      left -= 1
      off += 1
      continue
    }
    if (cs.planWork[i] === 1) {
      consec += 1
      off = 0
      if (consec >= P.statutoryMaxWorkMin) {
        left = P.statutoryBreakMin
        consec = 0
      }
    } else {
      off += 1
      if (off >= P.breakResetMin) consec = 0
    }
  }
}

// ═════════════════════════════════════ createWorld ═════════════════════════════════════

function forecastHeat(site: Site, sampler: (t: number) => InstantEnvSample | null, t: number): SiteHeat {
  return computeSiteHeat(sampler(t) ?? conservativeDefaultSample(site.id, t), site)
}

/**
 * Build a world for one site-day at the start of the shift (no minute simulated yet). Roster: `config.crews/workers`
 * when given, else `data.crews/workers`. Per worker: hidden traits (sim/truth.ts sampleHiddenTraits, stream seeded by
 * seed + worker id only, so the same worker has the same traits on every day and under every policy), the day's latent
 * condition, the truth state, a fresh engine (when the policy runs it). Per crew: the policy's baseline schedule
 * (listed order / site_index cycles / planner.planDay on the forecast). Basis: docs/SIMULATION.md §2–§4.
 * @throws RangeError on an invalid date/shift, a site mismatch, or a roster that references unknown workers.
 */
export function createWorld(config: SimConfig, data: SimData, opts: CreateWorldOptions = {}): World {
  if (data.site.id !== config.siteId) throw new RangeError(`createWorld: data is for ${data.site.id}, config for ${config.siteId}`)
  if (!HHMM_RE.test(config.shift.start) || !HHMM_RE.test(config.shift.end)) throw new RangeError('createWorld: shift times must be HH:mm')
  const site = data.site
  const pack = getRulePack(config.packId)
  const t0 = epochFromLocal(`${config.date}T${config.shift.start}`)
  const tEnd = epochFromLocal(`${config.date}T${config.shift.end}`)
  if (!(tEnd > t0)) throw new RangeError('createWorld: the shift must end after it starts (same local day)')
  const nMinutes = Math.round((tEnd - t0) / MINUTE_MS)
  const dayStart = epochFromLocal(`${config.date}T00:00`)
  const crews = config.crews ?? data.crews
  const profiles = config.workers ?? data.workers
  const byId = new Map(profiles.map((p) => [p.id, p]))

  const zill = config.policy === 'zill_env' || config.policy === 'zill_full'
  const engineOn = config.shadow || zill
  const actsOnZill = zill && !config.shadow
  const schedule: World['schedule'] = config.shadow || config.policy === 'ban_only' ? 'listed' : config.policy === 'site_index' ? 'site_index' : 'plan'
  const physioPolicy = engineOn && config.policy === 'zill_full'

  // Overrides first, then the config-driven leaves (the config is the single source for compliance and wearable loss).
  const truthParams = withTruthParams(
    {
      behaviour: { reminderCompliance: clamp01(config.behaviour.compliance) },
      wearable: { minuteLossProb: clamp01(config.disruptions.wearableDropout), noiseMultiplier: config.disruptions.ppgNoiseMultiplier },
    },
    withTruthParams(opts.truthParams ?? {}),
  )
  const base = createRng(config.seed)
  const loc = { lat: site.lat, lon: site.lon }
  const fcSampler = createEnvSampler(data.weather.forecast, loc)

  // Forecast heat per hour (site forecast strip, planner input, site_index floors).
  const heatByHour = new Map<number, SiteHeat>()
  const h0 = dayStart + Math.floor((t0 - dayStart) / HOUR_MS) * HOUR_MS
  for (let h = h0 - HOUR_MS; h <= tEnd + HOUR_MS; h += HOUR_MS) heatByHour.set(h, forecastHeat(site, fcSampler, h))
  const hours: SiteHour[] = []
  for (let h = h0; h < tEnd; h += HOUR_MS) {
    const hh = heatByHour.get(h) as SiteHeat
    hours.push({
      t: h,
      wbgtC: round1(hh.wbgtC),
      wbgtShadeC: round1(hh.wbgtShadeC),
      twlWm2: Math.round(hh.twlWm2),
      twlZone: twlZone(hh.twlWm2, pack)?.id ?? 'none',
      middayBreak: isMiddayBreak(h, pack) || isMiddayBreak(h + 59 * MINUTE_MS, pack),
    })
  }

  // Roster checks.
  const seen = new Set<string>()
  for (const c of crews) {
    if (c.siteId !== site.id) throw new RangeError(`createWorld: crew ${c.id} belongs to ${c.siteId}, not ${site.id}`)
    for (const id of c.workerIds) {
      if (!byId.has(id)) throw new RangeError(`createWorld: crew ${c.id} references unknown worker ${id}`)
      if (seen.has(id)) throw new RangeError(`createWorld: worker ${id} is in more than one crew`)
      seen.add(id)
    }
  }
  const rosterWorkers = crews.flatMap((c) => c.workerIds.map((id) => byId.get(id) as WorkerProfile))

  let plan: DayPlan | null = null
  if (schedule === 'plan') {
    // The forecast hour's SiteHeat is also the climate of the planner's ISO 7933 screen (PlannerHour.climate), so the
    // plan never schedules more work than the device's projection allows for the reference worker (plan and monitor agree).
    const hourly: PlannerHour[] = [...heatByHour.entries()].map(([t, hh]) => ({ t, wbgtC: hh.wbgtC, wbgtShadeC: hh.wbgtShadeC, twlWm2: hh.twlWm2, twlShadeWm2: hh.twlShadeWm2, climate: hh }))
    plan = planDay({ date: config.date, site, crews, workers: rosterWorkers, hourly, shift: { ...config.shift }, pack })
  }

  const forecastFixed = config.disruptions.forecastAgeH !== undefined
  const forecastObtainedAt = forecastFixed ? t0 - (config.disruptions.forecastAgeH as number) * HOUR_MS : t0 - WORLD_PARAMS.forecastFetchLeadMin * MINUTE_MS

  const w: World = {
    kind: 'zill-world',
    config,
    site,
    pack,
    weather: data.weather,
    t0,
    tEnd,
    nMinutes,
    dayStart,
    t: t0,
    minuteIndex: 0,
    finished: nMinutes === 0,
    engineOn,
    actsOnZill,
    schedule,
    truthParams,
    engineOpts: { projectionEveryMin: config.engine.projectionEveryMin },
    crews: [],
    workers: [],
    workerById: new Map(),
    hours,
    plan,
    floors: new Map(),
    anSampler: createEnvSampler(data.weather.analysis, loc),
    forecastSeries: { locationId: site.id, source: 'forecast', model: 'ecmwf_ifs025', grid: null, samples: data.weather.forecast, droppedHours: 0 },
    forecastObtainedAt,
    forecastFixed,
    rosterOnline: {},
    rosterOffline: {},
    windows: { sensor: windowOf(config.date, config.disruptions.envSensorFailure), network: windowOf(config.date, config.disruptions.networkOutage) },
    manualSensorFail: false,
    manualNetworkDown: false,
    sensorFailed: false,
    networkDown: false,
    fastingNow: false,
    heat: null,
    env: null,
    truthIn: null,
    alerts: createAlertEngine(),
    alertLog: new Map(),
    notifications: [],
    events: [],
    minutes: config.trace === 'full' ? [] : null,
    agenda: [],
    agendaSeq: 0,
    heldAcks: [],
    ackKeys: new Set(),
    script: (opts.script ?? [])
      .map((event) => {
        if (!HHMM_RE.test(event.at)) throw new RangeError(`createWorld: scripted event time '${event.at}' must be HH:mm`)
        return { t: epochFromLocal(`${config.date}T${event.at}`), event }
      })
      .sort((a, b) => a.t - b.t),
    scriptPos: 0,
    rngAck: base.fork(`ack|${config.date}`),
    rngMeter: base.fork(`meter|${config.date}|${site.id}`),
    // Truth overrides join the hash only when given, so runs without them keep the same stamp input as before.
    stamp: `zill-worldsim@${WORLDSIM_VERSION}+${hashSeed(JSON.stringify(opts.truthParams ? { config, script: opts.script ?? [], truthParams: opts.truthParams } : { config, script: opts.script ?? [] })).toString(16)}`,
    elapsedMs: 0,
    result: null,
  }

  // site_index floors per (hour, task): the zone cycle for the task's work category; unacclimatised exclusion.
  if (schedule === 'site_index') {
    for (const c of crews) {
      for (const task of c.tasks) {
        for (const [h, hh] of heatByHour) {
          const input = { t: h, twlWm2: task.inSun ? hh.twlWm2 : hh.twlShadeWm2, outdoorInSun: task.inSun, workClass: task.workClass, pack }
          const acc = regulatoryFloor({ ...input, acclimatization: 'acclimatized' })
          const unacc = regulatoryFloor({ ...input, acclimatization: 'unacclimatized' })
          w.floors.set(`${h}|${task.id}`, { workMinPerHour: acc.workRest?.workMinPerHour ?? 60, excludeUnacclimatized: unacc.unacclimatizedExcluded })
        }
      }
    }
  }

  // Crews and their baseline schedules.
  for (const c of crews) {
    const cs = newCrewSim(c, nMinutes)
    if (schedule === 'plan') planSchedule(w, cs, plan?.crews.find((p) => p.crewId === c.id))
    else if (schedule === 'site_index') listedOrderSchedule(w, cs, (h, task) => w.floors.get(`${h}|${task.id}`)?.workMinPerHour ?? 60)
    else listedOrderSchedule(w, cs, () => 60)
    fillPlanNext(cs)
    w.crews.push(cs)
  }

  // Workers.
  const restLocation: WorkerLocation = site.restArea === 'cooled_cabin' ? 'indoor_cool' : 'shade'
  let index = 0
  for (const cs of w.crews) {
    const ids = cs.crew.workerIds
    ids.forEach((id, j) => {
      const profile = byId.get(id) as WorkerProfile
      const buddyId = ids.length < 2 ? undefined : j % 2 === 0 ? (ids[j + 1] ?? ids[j - 1]) : ids[j - 1]
      const entry: RosterEntry = { crewId: cs.crew.id, siteId: site.id, displayName: profile.displayName, supervisorId: cs.supervisorId, network: 'online', ...(buddyId ? { buddyId } : {}) }
      w.rosterOnline[id] = entry
      w.rosterOffline[id] = { ...entry, network: 'offline' }
      const sampled = sampleHiddenTraits(profile, base.fork(`traits|${id}`), truthParams)
      const traits: HiddenTraits = {
        ...sampled,
        selfReportFactor: sampled.selfReportFactor * config.behaviour.selfReportScale,
        respondFactor: sampled.respondFactor * config.behaviour.respondScale,
      }
      const day = sampleDailyCondition(traits, base.fork(`day|${config.date}|${id}`), truthParams)
      const truth = initTruth(profile, traits, t0, { day, params: truthParams })
      const ws: WorkerSim = {
        index,
        id,
        rosterProfile: profile,
        profile,
        crew: cs,
        traits,
        rng: {
          truth: base.fork(`truth|${config.date}|${id}`),
          drink: base.fork(`drink|${config.date}|${id}`),
          wear: base.fork(`wear|${config.date}|${id}`),
          checkin: base.fork(`checkin|${config.date}|${id}`),
          behaviour: base.fork(`behaviour|${config.date}|${id}`),
          firstAid: base.fork(`firstaid|${config.date}|${id}`),
          supervisor: base.fork(`supervisor|${config.date}|${id}`),
        },
        chain: createWearableChain(),
        physioActive: physioPolicy && profile.hasWearable && profile.consent.wearable,
        adoshUnacc: assessAcclimatization(profile).adoshUnacclimatized,
        fastingFlag: profile.riskFlags.includes('fasting'),
        checkinsConsented: profile.consent.checkins,
        restLocation,
        truth,
        hrTrue: trueHeartRate(truth, traits),
        engine: engineOn ? createWorkerEngine(profile, t0) : null,
        assessment: null,
        detail: null,
        level: 'safe',
        task: null,
        location: restLocation,
        working: false,
        status: 'idle',
        cooling: 'none',
        lastTaskId: undefined,
        lastLocation: null,
        manual: null,
        resumeTask: null,
        plannedRate: null,
        rest: null,
        cycle: null,
        pendingEnforce: null,
        pendingDrinkMl: 0,
        checkinQueue: [],
        intakeQueue: [],
        pendingResolution: null,
        scheduledResolution: null,
        inPersonCheckT: null,
        prompt: null,
        lastPromptT: -Infinity,
        checkinSeq: 0,
        lastCheckin: null,
        firstAid: null,
        attended: false,
        evacuated: false,
        lastHrBpm: null,
        ectempC: null,
        restBoutStartT: null,
        lastHotWorkT: -Infinity,
        acc: emptyAcc(),
      }
      w.workers.push(ws)
      w.workerById.set(id, ws)
      index += 1
    })
  }

  for (const ws of w.workers) log(w, { kind: 'shift', t: t0, workerId: ws.id, what: 'start' })
  if (forecastFixed && (config.disruptions.forecastAgeH as number) * 60 >= 360) log(w, { kind: 'system', t: t0, what: 'forecast_stale' })
  computeEnvironment(w, t0)
  return w
}

// ═════════════════════════════════════ Environment ═════════════════════════════════════

/**
 * Site heat at `now`: TRUTH from the analysis (computeSiteHeat for the meter reading, solar geometry and 2-m wind; the
 * truth model computes its own human MRT); ENGINE through data/weather.ts resolveEnvironment — the device's forecast
 * (refreshed hourly while online; aged by outages, feed failures or `forecastAgeH`) plus, at sites with a WBGT meter, a
 * reading = truth WBGT + N(0, meterNoiseSdC). Basis: docs/SIMULATION.md §3; ARCHITECTURE.md §5 fail-safe chain.
 */
function computeEnvironment(w: World, now: number): void {
  const site = w.site
  const an = w.anSampler(now) ?? conservativeDefaultSample(site.id, now)
  // Liljegren components only (what computeSiteHeat starts from, incl. the site radiant allowance): the true sun WBGT
  // for a meter, the solar geometry and the 2-m wind; the truth model computes its own human MRT.
  const truthHeat = wbgtComponents(an.radiantBoostC === undefined && site.radiantBoostC > 0 ? { ...an, radiantBoostC: site.radiantBoostC } : an, site.lat, site.lon, { engineeredShade: true })
  const ghi = Math.max(0, an.ghiWm2)
  const fdir = ghi > 0 ? (an.directWm2 !== undefined ? clamp01(an.directWm2 / ghi) : truthHeat.fdir) : 0
  w.truthIn = { taC: an.taC, rhPct: an.rhPct, wind2Ms: truthHeat.wind2Ms, ghiWm2: ghi, fdir, cosZenith: truthHeat.cosZenith, pHpa: an.pHpa }

  const feedDown = w.sensorFailed && !site.hasWbgtMeter
  const online = !w.networkDown && !feedDown && !w.forecastFixed
  if (online && (now - w.dayStart) % HOUR_MS === 0) w.forecastObtainedAt = now
  const series: WeatherSeries = { ...w.forecastSeries, obtainedAt: w.forecastObtainedAt }
  let sensor: SensorReading | null = null
  if (site.hasWbgtMeter) {
    const noise = w.rngMeter.normal(0, WORLD_PARAMS.meterNoiseSdC)
    if (!w.sensorFailed) sensor = { t: now, measuredWbgtC: round2(truthHeat.wbgtC + noise), taC: round1(an.taC), rhPct: Math.round(an.rhPct) }
  }
  const env = resolveEnvironment({ siteId: site.id, now, sensor, liveForecast: online ? series : null, cachedForecast: online ? null : series })
  w.env = env
  w.heat = computeSiteHeat(env.sample, site)
  const cz = noaaCosZenith(now, site.lat, site.lon)
  w.fastingNow = now - w.dayStart >= 12 * HOUR_MS ? cz > WORLD_PARAMS.sunsetCosZenith : cz >= WORLD_PARAMS.fajrCosZenith
}

// ═════════════════════════════════════ Alerts, acks, cases ═════════════════════════════════════

function recordAlerts(w: World, t: number, alerts: readonly EngineAlert[]): void {
  for (const a of alerts) {
    w.alertLog.set(a.id, a)
    log(w, { kind: 'alert', t, alert: a })
  }
}

function pushAgenda(w: World, from: number, alertId: string, role: AckRole, immediate = false): void {
  const t = from + (immediate ? 0 : delayMin(w.rngAck, w.config.behaviour.ackDelayMin[role])) * MINUTE_MS
  const item: AckItem = { t, seq: w.agendaSeq++, alertId, role }
  let i = w.agenda.length
  while (i > 0 && (w.agenda[i - 1].t > t || (w.agenda[i - 1].t === t && w.agenda[i - 1].seq > item.seq))) i -= 1
  w.agenda.splice(i, 0, item)
}

function scheduleAck(w: World, n: Notification, now: number): void {
  const role = n.to.role
  if (!isAckRole(role)) return
  const key = `${n.alertId}|${role}`
  if (w.ackKeys.has(key)) return
  w.ackKeys.add(key)
  if (role !== 'worker' && w.networkDown) w.heldAcks.push({ alertId: n.alertId, role, delivered: false })
  else pushAgenda(w, now, n.alertId, role)
}

function logInstruction(w: World, ws: WorkerSim, t: number, action: ActionId, followed: boolean): void {
  ws.acc.instructions += 1
  if (followed) ws.acc.followed += 1
  log(w, { kind: 'instruction', t, workerId: ws.id, action, followed })
}

/**
 * Whether a direct reassignment to rest is carried out: always by an attending first aider (in person); by the
 * supervisor with probability behaviour.supervisorFollowThrough [ASSUMPTION; default 1], one draw from the worker's own
 * supervisor stream (forked like the other streams, so the draw never shifts the truth, drinking or behaviour streams).
 */
function reassignmentCarried(w: World, ws: WorkerSim, by: 'supervisor' | 'first_aider'): boolean {
  if (by === 'first_aider') return true
  return ws.rng.supervisor.next() < clamp01(w.config.behaviour.supervisorFollowThrough)
}

/**
 * Reassignment to rest on a stop (supervisor acknowledging a stop/emergency alert, or the first aider on arrival). It
 * matters only for a worker who is not already resting: the draw ({@link reassignmentCarried}) happens then, and the
 * outcome is logged as a 'stop_work' instruction (followed = carried out). Before the rest episode starts it waits in
 * `pendingEnforce`. Basis: ARCHITECTURE.md §6 (supervisor acknowledges and reassigns); SimBehaviour.supervisorFollowThrough.
 */
function enforceRest(w: World, ws: WorkerSim, t: number, by: 'supervisor' | 'first_aider'): void {
  if (ws.evacuated) return
  if (ws.rest) {
    if (!ws.rest.followed && !ws.rest.enforced) {
      const carried = reassignmentCarried(w, ws, by)
      ws.rest.enforced = carried
      logInstruction(w, ws, t, 'stop_work', carried)
    }
  } else if (by === 'first_aider' || ws.pendingEnforce === null) {
    ws.pendingEnforce = by
  }
}

function dispatchFirstAider(ws: WorkerSim, arrivalT: number, kind: FirstAidCase['kind']): void {
  if (ws.evacuated) return
  const fa = ws.firstAid
  if (!fa) {
    ws.firstAid = { kind, arrivalT, startedT: null, handoverT: null }
    return
  }
  if (fa.startedT === null && arrivalT < fa.arrivalT) fa.arrivalT = arrivalT
  if (kind === 'emergency') fa.kind = 'emergency'
}

/**
 * An acknowledgement (automatic after the sampled delay, or injected by the UI) and its consequences under Zill
 * policies: a supervisor acknowledging a stop/emergency reassigns the worker(s) to rest; a first aider acknowledging a
 * worker alert goes to the worker (emergency → cooling, clinical stop → in-person check). Basis: ARCHITECTURE.md §6.
 */
function handleAck(w: World, alertId: string, role: Role, t: number, injected: boolean): void {
  const rec = w.alerts.alerts[alertId]
  if (!rec) return
  if (!injected && (rec.alert.status === 'resolved' || rec.acks.some((a) => a.role === role))) return
  const r = ackAlert(w.alerts, alertId, role, t)
  w.alerts = r.state
  if (!r.ok || !r.alert) return
  log(w, { kind: 'ack', t, alertId, role })
  recordAlerts(w, t, [r.alert])
  if (!w.actsOnZill) return
  const al = r.alert
  if (role === 'supervisor' && atLeast(al.level, 'stop')) {
    const ids = al.scope === 'worker' && al.workerId ? [al.workerId] : (al.memberIds ?? [])
    for (const id of ids) {
      const ws = w.workerById.get(id)
      if (ws && ws.assessment && atLeast(ws.assessment.level, 'stop')) enforceRest(w, ws, t, 'supervisor')
    }
  }
  if (role === 'first_aider' && al.workerId) {
    const ws = w.workerById.get(al.workerId)
    if (ws) dispatchFirstAider(ws, t + Math.max(0, w.config.behaviour.firstAiderArrivalMin) * MINUTE_MS, al.level === 'emergency' ? 'emergency' : 'clinical')
  }
}

function resolveOpenAlert(w: World, ws: WorkerSim, by: Role, t: number, alertId?: string): void {
  if (!w.engineOn) return
  const id = alertId ?? w.alerts.workers[ws.id]?.openAlertId ?? null
  if (!id) return
  const r = resolveAlert(w.alerts, id, by, t)
  w.alerts = r.state
  if (r.ok && r.alert) recordAlerts(w, t, [r.alert, ...r.updated.filter((a) => a.id !== id)])
}

function makeCheckin(ws: WorkerSim, t: number, by: Checkin['by'], symptoms: readonly SymptomId[], urineColor?: Checkin['urineColor']): Checkin {
  ws.checkinSeq += 1
  const c: Checkin = { id: `${ws.id}#C${ws.checkinSeq}`, t, workerId: ws.id, by, symptoms: [...new Set(symptoms)] }
  if (urineColor !== undefined) c.urineColor = urineColor
  const prev = ws.lastCheckin
  if (prev && prev.id && prev.symptoms.some((s) => s !== 'thirst') && t - prev.t <= TRIAGE_TIMING.EPISODE_LINK_MAX_GAP_MIN * MINUTE_MS) {
    const n = c.symptoms.filter((s) => s !== 'thirst').length
    const p = prev.symptoms.filter((s) => s !== 'thirst').length
    c.followUpOf = prev.id
    c.trend = n < p ? 'better' : n > p ? 'worse' : 'same'
  }
  ws.lastCheckin = c
  return c
}

/** An in-person check by a buddy, supervisor or first aider elicits every active symptom [ASSUMPTION]. */
function inPersonCheckin(w: World, ws: WorkerSim, t: number, by: Checkin['by'], prompted: boolean): void {
  const c = makeCheckin(ws, t, by, activeSymptomIds(ws.truth))
  log(w, { kind: 'checkin', t, checkin: c, prompted })
  if (w.engineOn) ws.checkinQueue.push(c)
}

function evacuate(w: World, ws: WorkerSim, t: number): void {
  ws.evacuated = true
  ws.firstAid = null
  ws.working = false
  ws.task = null
  ws.rest = null
  ws.cycle = null
  resolveOpenAlert(w, ws, 'first_aider', t)
  log(w, { kind: 'resolution', t, workerId: ws.id, by: 'first_aider' })
  log(w, { kind: 'shift', t, workerId: ws.id, what: 'end' })
}

/** Timers at the start of a minute: first aid, scheduled sign-offs and in-person checks, check-in prompts. */
function personTimers(w: World, ws: WorkerSim, ti: number): void {
  const fa = ws.firstAid
  if (fa) {
    if (fa.startedT === null && ti >= fa.arrivalT) {
      fa.startedT = ti
      ws.attended = true
      if (fa.kind === 'clinical') {
        if (w.engineOn) inPersonCheckin(w, ws, ti, 'first_aider', false)
        enforceRest(w, ws, ti, 'first_aider')
        ws.firstAid = null
      }
    }
    if (ws.firstAid && ws.firstAid.kind === 'emergency' && ws.firstAid.startedT !== null && ws.firstAid.handoverT === null) {
      ws.firstAid.handoverT = ws.firstAid.startedT + WORLD_PARAMS.emsHandoverMin * MINUTE_MS
    }
    if (ws.firstAid && ws.firstAid.handoverT !== null && ti >= ws.firstAid.handoverT) {
      evacuate(w, ws, ti)
      return
    }
  }
  if (!w.actsOnZill || !ws.engine) return
  const sr = ws.scheduledResolution
  if (sr && ti >= sr.t) {
    ws.scheduledResolution = null
    ws.pendingResolution = { by: sr.by, t: ti }
    log(w, { kind: 'resolution', t: ti, workerId: ws.id, by: sr.by })
    if (sr.kind === 'latch') resolveOpenAlert(w, ws, sr.by, ti)
  }
  if (ws.inPersonCheckT !== null && ti >= ws.inPersonCheckT) {
    ws.inPersonCheckT = null
    inPersonCheckin(w, ws, ti, ws.attended ? 'first_aider' : 'supervisor', false)
  }
  // Check-in prompts (engine action 'symptom_checkin': conservative mode, physiology advisories, triage follow-ups,
  // recovery reviews), answered through truth.respondToCheckin; an unanswered prompt sends the buddy (clinical.promptTimeout).
  if (!ws.checkinsConsented || (ws.firstAid && ws.firstAid.startedT !== null)) return
  const a = ws.assessment
  if (ws.prompt) {
    const pr = ws.prompt
    if (!pr.answered && !pr.buddyChecked) {
      const pt = promptTimeout(pr.t, ti, { answered: false, level: a?.level ?? 'safe', raisedByWarning: true })
      if (pt.notify.includes('buddy')) {
        inPersonCheckin(w, ws, ti, 'buddy', true)
        pr.buddyChecked = true
      }
    }
    if (pr.answered || pr.buddyChecked || ti - pr.t >= WORLD_PARAMS.promptExpireMin * MINUTE_MS) ws.prompt = null
  }
  if (!ws.prompt && a && a.actions.includes('symptom_checkin') && ti - ws.lastPromptT >= WORLD_PARAMS.promptMinGapMin * MINUTE_MS) {
    ws.lastPromptT = ti
    ws.acc.prompted += 1
    const resp = respondToCheckin(ws.truth, ws.traits, ws.rng.checkin)
    if (resp) {
      ws.acc.answered += 1
      const c = makeCheckin(ws, ti, 'self', resp.symptoms, resp.urineColor)
      log(w, { kind: 'checkin', t: ti, checkin: c, prompted: true })
      ws.checkinQueue.push(c)
    } else {
      ws.prompt = { t: ti, answered: false, buddyChecked: false }
    }
  }
}

/**
 * After an engine step (Zill policies): schedule the human steps the engine is waiting for — a latch resolution once a
 * clean re-check exists (clinical latch, ARCHITECTURE.md §1.4), the recovery sign-off once rest and a clean check-in are
 * done (risk.ts PHS recovery), and an in-person re-check for workers who did not consent to self check-ins. The resolver
 * is the attending first aider, else the supervisor, after that role's median delay [ASSUMPTION].
 */
function scheduleCaseSteps(w: World, ws: WorkerSim, now: number): void {
  const d = ws.detail
  const st = ws.engine
  if (!d || !st || ws.scheduledResolution) return
  const by: 'first_aider' | 'supervisor' = ws.attended ? 'first_aider' : 'supervisor'
  const due = now + Math.max(1, Math.ceil(w.config.behaviour.ackDelayMin[by])) * MINUTE_MS
  const L = d.latch
  if (L && L.clearedAt === undefined && L.tier < 3) {
    const usable = st.checkins.filter((c) => c.workerId === ws.id && c.t > L.lastTriggerT && (ws.checkinsConsented || c.by !== 'self'))
    const last = usable.length > 0 ? usable[usable.length - 1] : undefined
    if (last && isClean(last)) {
      if (!(L.resolvedAt !== undefined && L.resolvedAt >= L.lastTriggerT)) ws.scheduledResolution = { t: due, by, kind: 'latch' }
    } else if (!ws.checkinsConsented && ws.inPersonCheckT === null && (!last || now - last.t >= WORLD_PARAMS.promptMinGapMin * MINUTE_MS)) {
      ws.inPersonCheckT = due
    }
    return
  }
  const r = d.phsRecovery
  if (r && !r.needs.rest) {
    if (r.needs.checkin) {
      if (!ws.checkinsConsented && ws.inPersonCheckT === null) ws.inPersonCheckT = due
    } else if (r.needs.signoff && r.restartable) {
      ws.scheduledResolution = { t: due, by, kind: 'phs' }
    }
  }
}

// ═════════════════════════════════════ Worker activity ═════════════════════════════════════

interface Sched {
  task: Task | null
  work: boolean
  /** Where the worker is this minute under the schedule (rest area when not working). */
  location: WorkerLocation
  /** Where the scheduled task is done (sun/shade). */
  taskLocation: WorkerLocation
  reason: number
  /** The task to return to after rest (WorkerContext.resumeTask): this minute's task, else the next scheduled one. */
  resumeTask: Task | null
  /** The day plan's work min/h for this minute's task block (WorkerContext.plannedWorkMinPerHour); null outside one. */
  plannedRate: number | null
  /** Day-plan schedules: the minute index where this minute's plan block-hour starts and its wall minutes (null: none). */
  bhStart: number | null
  bhWall: number
}

function scheduled(w: World, ws: WorkerSim, i: number, t: number): Sched {
  if (ws.manual) {
    const task = ws.manual.task
    return { task, work: task !== null, location: ws.manual.location, taskLocation: ws.manual.location, reason: task ? R_WORK : R_MANUAL, resumeTask: task, plannedRate: null, bhStart: null, bhWall: 0 }
  }
  const cs = ws.crew
  const k = cs.planTask[i]
  const task = k >= 0 ? cs.tasks[k] : null
  let work = cs.planWork[i] === 1 && task !== null
  let reason = cs.planReason[i]
  if (work && task && w.schedule === 'site_index' && ws.adoshUnacc && w.floors.get(`${hourStart(w, t)}|${task.id}`)?.excludeUnacclimatized) {
    work = false
    reason = R_ZONE
  }
  const taskLocation: WorkerLocation = cs.planSun[i] === 1 ? 'sun' : 'shade'
  const next = cs.planNext[i]
  const inPlan = w.schedule === 'plan' && task !== null && cs.planRate[i] !== PLAN_RATE_NONE
  return {
    task,
    work,
    location: work ? taskLocation : ws.restLocation,
    taskLocation,
    reason,
    resumeTask: task ?? (next >= 0 ? cs.tasks[next] : null),
    plannedRate: inPlan ? cs.planRate[i] : null,
    bhStart: inPlan && cs.planBhStart[i] >= 0 ? cs.planBhStart[i] : null,
    bhWall: inPlan ? cs.planBhWall[i] : 0,
  }
}

/**
 * Instruction episodes (Zill policies, not shadow), from the worker's own device display:
 * - rest: the engine asks for a stop/rest ({@link needsRest}); the worker complies with probability
 *   compliance × traits.complianceFactor (one draw per episode). The engine owns the resume decision: the episode ends
 *   as soon as the device no longer asks for rest. A projection stop is held at stop by the engine until its resume
 *   check projects ≥ 25 min for WorkerContext.resumeTask (risk.ts ProjectionHold, RISK_THRESHOLDS.resume — the deadband
 *   that replaced the simulator's own 25-min resume margin of worldsim ≤ 1.1.0). The regulation and environment
 *   channels have no such hold yet, so the episode also waits until the device's own assessment of the resume task no
 *   longer stops it on those channels ({@link resumeTaskAllowed}; no margin).
 *   [ASSUMPTION] When the device flags the resume task as not feasible now (detail.resume.infeasibleNow: even 60 min of
 *   rest would not pass the check), the worker keeps resting and the alert engine notifies the supervisor (stop with
 *   task_not_feasible_now + rotate_task); a reassignment to another task is not modelled unless the scenario has one (a
 *   later plan block with another task, a scripted or UI task change), which then becomes the resume task.
 * - work/rest cycle: the engine allows < 60 work min/h for the task (live value read while working); a complying worker
 *   works the first W minutes of each window and rests the remainder [ENG layout]. Under a day plan the window is the
 *   plan block-hour (W pro-rated to its wall minutes, rounded down), so the device's cycle and the plan's own layout
 *   (work first, then rest) coincide instead of stacking; otherwise 60-min windows from the episode start.
 */
function updateEpisodes(w: World, ws: WorkerSim, ti: number, s: Sched): void {
  const a = ws.assessment
  if (!a || !ws.engine) return
  const need = needsRest(a)
  const p = clamp01(w.config.behaviour.compliance * ws.traits.complianceFactor)
  if (!need) ws.pendingEnforce = null
  if (ws.rest) {
    // Engine-owned resume: the device no longer asks for rest (a held projection stop has passed its resume check) and
    // its assessment of the resume task is not stopped by a regulation or environment rule. A declining worker's live
    // assessment is for the task itself.
    if (!need && (ws.working || resumeTaskAllowed(w, ws, s, ti))) ws.rest = null
  } else if (need) {
    const followed = ws.rng.behaviour.next() < p
    ws.rest = { since: ti, followed, enforced: false }
    logInstruction(w, ws, ti, restAction(a), followed)
    if (ws.pendingEnforce !== null) {
      const by = ws.pendingEnforce
      ws.pendingEnforce = null
      if (!followed) {
        const carried = reassignmentCarried(w, ws, by)
        ws.rest.enforced = carried
        logInstruction(w, ws, ti, 'stop_work', carried)
      }
    }
  }
  if (ws.cycle && (s.task === null || s.task.id !== ws.cycle.taskId)) ws.cycle = null
  if (!need && !ws.rest && ws.working && ws.task !== null) {
    // The device's "shade breaks: W min work per hour", floored to 5 min like the planner (protective) [ENG].
    const W = a.actions.includes('shade_breaks') ? Math.max(0, Math.min(60, Math.floor(a.workMinPerHour / WORK_MIN_GRANULARITY) * WORK_MIN_GRANULARITY)) : 60
    if (ws.cycle) {
      if (W >= 60) ws.cycle = null
      else ws.cycle.workMinPerHour = W
    } else if (W < 60 && s.task !== null && s.task.id === ws.task.id) {
      const followed = ws.rng.behaviour.next() < p
      ws.cycle = { since: ti, followed, workMinPerHour: W, taskId: ws.task.id }
      logInstruction(w, ws, ti, 'shade_breaks', followed)
    }
  }
}

/**
 * Whether the device's own assessment of the task to resume (risk.assessSnapshot from the worker's engine state, at the
 * task's location) is free of a regulation or environment stop. Integration fix, wave 2c [ENG, protective]: those
 * channels' task-dependent stops — the ADOSH TWL-zone exclusion of unacclimatised workers, the heat stop band (allowed
 * work fraction < 0.25), an exhausted acclimatisation budget, the midday break — have no resume hold in the engine (only
 * the projection channel has one, RISK_THRESHOLDS.resume), and the channel computed for rest drops as soon as the worker
 * rests. Without this check the worker resumed, was stopped again within a minute, and accumulated sun minutes in
 * excluded zones (medium cohort, first v0.2 run: 39 unacclimatised zone worker-hours against 7 in v0.1). The
 * projection channel is not checked (the engine's hold owns it; no margin). True when there is no task to resume.
 */
function resumeTaskAllowed(w: World, ws: WorkerSim, s: Sched, ti: number): boolean {
  const task = s.resumeTask
  if (!task || !w.heat || !ws.engine) return true
  const location: WorkerLocation = s.task !== null && s.task.id === task.id ? s.taskLocation : task.inSun ? 'sun' : 'shade'
  const snap = assessSnapshot(
    {
      now: ti,
      profile: ws.profile,
      task,
      location,
      heat: w.heat,
      env: w.env ?? undefined,
      pack: w.pack,
      network: w.networkDown ? 'offline' : 'online',
      fastingNow: deviceFasting(w, ws),
      buddyAssigned: true,
      restArea: w.site.restArea,
      resumeTask: task,
    },
    ws.engine,
  )
  return !snap.channels.some((c) => (c.channel === 'regulation' || c.channel === 'environment') && atLeast(c.level, 'stop'))
}

/**
 * Work minutes the device's work/rest cycle ("shade breaks: W min work per hour") leaves in a day-plan block-hour of
 * `bhWall` minutes whose plan rate is `plannedRate` min/h: null (no cut) when the device allows at least the plan's rate —
 * the plan's own layout (work first, then rest) already implements it, so the two never stack — else the first
 * floor(W × wall / 60) minutes (W pro-rated to the block-hour, rounded down: protective) [ENG layout].
 */
export function deviceCycleWorkMin(deviceWorkMinPerHour: number, plannedRate: number | null, bhWall: number): number | null {
  if (plannedRate !== null && deviceWorkMinPerHour >= plannedRate) return null
  return Math.max(0, Math.floor((Math.max(0, Math.min(60, deviceWorkMinPerHour)) * Math.max(0, bhWall)) / 60))
}

/**
 * Whether the device's work/rest cycle allows work at minute `ti`: under a day plan, aligned with the plan block-hour
 * ({@link deviceCycleWorkMin}); otherwise the first W minutes of each 60-min window from the episode start [ENG layout].
 */
function cycleAllowsWork(c: CycleEpisode, s: Sched, ti: number, w: World): boolean {
  if (s.bhStart !== null) {
    const allowed = deviceCycleWorkMin(c.workMinPerHour, s.plannedRate, s.bhWall)
    return allowed === null || Math.round((ti - w.t0) / MINUTE_MS) - s.bhStart < allowed
  }
  return Math.floor((ti - c.since) / MINUTE_MS) % 60 < c.workMinPerHour
}

function decideActivity(w: World, ws: WorkerSim, ti: number, i: number): void {
  const s = scheduled(w, ws, i, ti)
  let work = s.work
  let location = s.location
  let status: WorkerSim['status'] = work ? 'work' : s.reason === R_NO_TASK ? 'idle' : 'rest'
  ws.cooling = 'none'
  const fa = ws.firstAid
  if (fa && fa.startedT !== null && fa.kind === 'emergency') {
    work = false
    location = ws.restLocation
    status = 'rest'
    ws.cooling = WORLD_PARAMS.firstAidCooling
  } else if (w.actsOnZill && ws.engine) {
    updateEpisodes(w, ws, ti, s)
    if (ws.rest && (ws.rest.followed || ws.rest.enforced)) {
      work = false
      location = ws.restLocation
      status = 'rest'
    } else if (work && ws.cycle && ws.cycle.followed && !cycleAllowsWork(ws.cycle, s, ti, w)) {
      work = false
      location = ws.restLocation
      status = 'rest'
    }
  }
  ws.resumeTask = s.resumeTask
  ws.plannedRate = s.plannedRate
  ws.task = work ? s.task : null
  ws.location = location
  ws.working = work
  ws.status = status
  if (work) {
    ws.restBoutStartT = null
    if (location !== 'indoor_cool') ws.lastHotWorkT = ti
  } else if (ws.restBoutStartT === null) {
    ws.restBoutStartT = ti
  }
  const taskId = ws.task?.id ?? null
  if (taskId !== ws.lastTaskId || location !== ws.lastLocation) {
    log(w, { kind: 'task', t: ti, workerId: ws.id, taskId, location })
    ws.lastTaskId = taskId
    ws.lastLocation = location
  }
}

// ═════════════════════════════════════ Minute step ═════════════════════════════════════

function handleTruthEvents(w: World, ws: WorkerSim): void {
  for (const ev of ws.truth.lastEvents) {
    if (ev.type === 'outcome') {
      const kind: TruthEventKind = ev.outcome.kind === 'dehydration' ? 'dehydration_3pct' : ev.outcome.kind
      const rec = ws.acc.truth[kind]
      rec.count += 1
      if (rec.firstT === null) rec.firstT = ev.outcome.onsetT
      log(w, {
        kind: 'truth',
        t: ev.t,
        workerId: ws.id,
        event: kind,
        detail: `${round2(ev.outcome.value)}${kind === 'dehydration_3pct' ? ' %' : ' °C'} (onset ${new Date(ev.outcome.onsetT).toISOString()})`,
        onsetT: ev.outcome.onsetT,
      })
    } else if (ev.type === 'symptom_onset') {
      const rec = ws.acc.truth.symptom_onset
      rec.count += 1
      if (rec.firstT === null) rec.firstT = ev.t
      log(w, { kind: 'truth', t: ev.t, workerId: ws.id, event: 'symptom_onset', detail: `${ev.cluster}: ${ev.symptoms.join(', ')}`, onsetT: ev.t, cluster: ev.cluster })
      if (ev.selfReported) {
        ws.acc.selfReported += 1
        const c = makeCheckin(ws, ev.t, 'self', ev.symptoms)
        log(w, { kind: 'checkin', t: ev.t, checkin: c, prompted: false })
        if (w.engineOn) ws.checkinQueue.push(c)
      }
    } else if (ev.type === 'buddy_noticed') {
      const c = makeCheckin(ws, ev.t, 'buddy', ev.symptoms)
      log(w, { kind: 'checkin', t: ev.t, checkin: c, prompted: false })
      if (w.engineOn) ws.checkinQueue.push(c)
      // The buddy also calls the first aider directly — identical in every policy [ASSUMPTION, policy-neutral first aid].
      const delay = delayMin(ws.rng.firstAid, w.config.behaviour.ackDelayMin.first_aider) + Math.max(0, w.config.behaviour.firstAiderArrivalMin)
      dispatchFirstAider(ws, ev.t + delay * MINUTE_MS, 'emergency')
    }
  }
}

function stepWorkerTruthAndEngine(w: World, ws: WorkerSim, now: number, i: number): RiskAssessment | null {
  const tw = w.truthIn as TruthWeather
  const task = ws.working ? ws.task : null
  const activity = task
    ? { metabolicW: trueMetabolicW(taskMetabolicW(task, ws.traits.massKg), ws.traits), location: ws.location, clothing: task.clothing ?? ws.profile.clothing, hood: task.hood === true }
    : { metabolicW: truthRestMetabolicW(), location: ws.location, clothing: ws.profile.clothing, hood: false }
  const tin: TruthInputs = {
    taC: tw.taC,
    rhPct: tw.rhPct,
    wind2Ms: tw.wind2Ms,
    ghiWm2: tw.ghiWm2,
    fdir: tw.fdir,
    cosZenith: tw.cosZenith,
    pHpa: tw.pHpa,
    activity,
    drankMl: ws.pendingDrinkMl,
    cooling: ws.cooling,
  }
  ws.truth = stepTruth(ws.truth, tin, 1, ws.rng.truth)
  ws.pendingDrinkMl = 0
  handleTruthEvents(w, ws)
  ws.hrTrue = trueHeartRate(ws.truth, ws.traits)

  let physioMinute: MinuteSqi | undefined
  if (ws.physioActive) {
    const armWork = task !== null && task.workClass !== 'rest' && task.workClass !== 'light'
    const dust = task !== null && w.site.kind !== 'port'
    const samples = wearableSamples(ws.hrTrue, ws.traits, { minuteIndex: i, armWork, dust, chain: ws.chain, params: w.truthParams.wearable }, ws.rng.wear)
    physioMinute = minuteSqi(samples, 1)
    ws.lastHrBpm = physioMinute.minuteValid && physioMinute.hrMeanBpm !== null ? Math.round(physioMinute.hrMeanBpm) : null
  }

  // Drinking for the next minute (reminders only under Zill policies while exposed; none while fasting or over the
  // fluid cap — the engine then sets waterMlPerHour 0 or 'restrict_fluids').
  // The worker fasts in fasting hours whatever the device knows (truth: no drinking); the device knows it only from a
  // consented risk flag (reminders, engine context).
  const fasting = ws.fastingFlag && w.fastingNow
  const devFasting = deviceFasting(w, ws)
  const a0 = ws.assessment
  const ti = now - MINUTE_MS
  // The device's own rule (clinical.fluidStatus): 250 mL when nothing was logged for 20 min, none over the hourly cap or
  // while fasting; sent while exposed (hot work in the last 30 min [ENG]) and while the engine recommends water.
  let reminder = false
  if (w.actsOnZill && ws.engine && !devFasting && a0 !== null && a0.waterMlPerHour > 0 && !a0.actions.includes('restrict_fluids') && ti - ws.lastHotWorkT < WORLD_PARAMS.reminderAfterHotWorkMin * MINUTE_MS) {
    const fs = fluidStatus(ws.engine.intakes, ti, { fastingNow: devFasting, workerId: ws.id })
    reminder = fs.nextReminderAtMs !== null && fs.nextReminderAtMs <= ti
  }
  const onBreak = !ws.working && ws.status === 'rest' && ws.restBoutStartT !== null && ti - ws.restBoutStartT < WORLD_PARAMS.breakDrinkWindowMin * MINUTE_MS
  const ml = drinkDecision(ws.truth, ws.traits, { reminder, canDrink: !fasting, onBreak, reminderMl: WORLD_PARAMS.reminderMl }, ws.rng.drink)
  if (ml > 0) {
    ws.pendingDrinkMl += ml
    const intake: FluidIntake = { t: now, workerId: ws.id, ml }
    log(w, { kind: 'intake', t: now, intake })
    if (w.engineOn) ws.intakeQueue.push(intake)
  }

  if (!ws.engine) return null
  const ctx: WorkerContext = {
    now,
    profile: ws.profile,
    task,
    location: ws.location,
    heat: w.heat as SiteHeat,
    env: w.env ?? undefined,
    pack: w.pack,
    network: w.networkDown ? 'offline' : 'online',
    fastingNow: devFasting,
    buddyAssigned: true,
    restArea: w.site.restArea,
  }
  // The device knows the assignment: the task to return to after rest (the engine's resume check) and the day plan's
  // work min/h for this task block (the device never allows more than the plan).
  if (ws.resumeTask) ctx.resumeTask = ws.resumeTask
  if (ws.plannedRate !== null) ctx.plannedWorkMinPerHour = ws.plannedRate
  const inputs: WorkerInputs = {}
  if (physioMinute) inputs.physioMinute = physioMinute
  const c = ws.checkinQueue.shift()
  if (c) inputs.checkin = c
  const fi = ws.intakeQueue.shift()
  if (fi) inputs.intake = fi
  if (ws.pendingResolution) {
    inputs.resolution = ws.pendingResolution
    ws.pendingResolution = null
  }
  const res = stepWorkerEngine(ws.engine, ctx, inputs, w.engineOpts)
  ws.engine = res.state
  ws.assessment = res.assessment
  ws.detail = res.detail
  ws.ectempC = ws.physioActive ? round2(res.state.physio.track.ctC) : null
  const lvl = res.assessment.level
  if (lvl !== ws.level) {
    log(w, { kind: 'level', t: now, workerId: ws.id, from: ws.level, to: lvl, channel: drivingChannel(res.assessment) })
    ws.level = lvl
  }
  ws.acc.minutesByLevel[lvl] += 1
  if (ws.acc.firstHighT === null && atLeast(lvl, 'high')) ws.acc.firstHighT = now
  if (ws.acc.firstStopT === null && atLeast(lvl, 'stop')) ws.acc.firstStopT = now
  if (ws.acc.firstEmergencyT === null && lvl === 'emergency') ws.acc.firstEmergencyT = now
  if (w.actsOnZill) scheduleCaseSteps(w, ws, now)
  return res.assessment
}

function locationWbgtC(w: World, loc: WorkerLocation): number {
  const h = w.heat as SiteHeat
  return loc === 'sun' ? h.wbgtC : loc === 'shade' ? h.wbgtShadeC : Math.min(COOLED_REST.wbgtC, h.wbgtShadeC)
}

function traceRow(w: World, ws: WorkerSim, now: number): void {
  if (!w.minutes) return
  const task = ws.working ? ws.task : null
  w.minutes.push({
    t: now,
    workerId: ws.id,
    taskId: task?.id ?? null,
    location: ws.location,
    working: ws.working,
    level: ws.assessment?.level ?? 'safe',
    computedLevel: ws.detail?.computedLevel ?? 'safe',
    workMinPerHour: ws.assessment?.workMinPerHour ?? 60,
    minutesToLimit: ws.assessment?.minutesToLimit ?? null,
    wbgtEffC: round2(wbgtEffectiveC(locationWbgtC(w, ws.location), task?.clothing ?? ws.profile.clothing, task?.hood === true) + (w.env?.wbgtMarginC ?? 0)),
    coreTrueC: round2(ws.truth.gagge.tCoreC),
    hrTrueBpm: Math.round(ws.hrTrue),
    hrMeasuredBpm: ws.physioActive ? ws.lastHrBpm : null,
    ectempC: ws.ectempC,
    dehydrationPct: round2(ws.truth.dehydrationPct),
  })
}

function applyInjection(w: World, inj: WorldInjection, t: number): void {
  const worker = (id: string): WorkerSim => {
    const ws = w.workerById.get(id)
    if (!ws) throw new RangeError(`stepWorld: unknown worker '${id}'`)
    return ws
  }
  switch (inj.kind) {
    case 'checkin': {
      const ws = worker(inj.checkin.workerId)
      ws.checkinSeq += 1
      const c: Checkin = { ...inj.checkin, symptoms: [...inj.checkin.symptoms], id: inj.checkin.id ?? `${ws.id}#C${ws.checkinSeq}` }
      const prompted = ws.prompt !== null && !ws.prompt.answered
      if (prompted && ws.prompt && c.by === 'self') {
        ws.prompt.answered = true
        ws.acc.answered += 1
      }
      ws.lastCheckin = c
      log(w, { kind: 'checkin', t, checkin: c, prompted })
      if (w.engineOn) ws.checkinQueue.push(c)
      break
    }
    case 'intake': {
      const ws = worker(inj.intake.workerId)
      const intake: FluidIntake = { ...inj.intake }
      ws.pendingDrinkMl += Math.max(0, intake.ml)
      log(w, { kind: 'intake', t, intake })
      if (w.engineOn) ws.intakeQueue.push(intake)
      break
    }
    case 'ack':
      handleAck(w, inj.alertId, inj.role, t, true)
      break
    case 'resolve': {
      const ws = worker(inj.workerId)
      ws.pendingResolution = { by: inj.by, t }
      log(w, { kind: 'resolution', t, workerId: ws.id, by: inj.by })
      resolveOpenAlert(w, ws, inj.by, t, inj.alertId)
      break
    }
    case 'task': {
      const ws = worker(inj.workerId)
      if (!LOCATIONS.includes(inj.location)) throw new RangeError(`stepWorld: unknown location '${String(inj.location)}'`)
      let task: Task | null = null
      if (inj.taskId !== null) {
        const k = ws.crew.taskIndex.get(inj.taskId)
        const found = k !== undefined ? ws.crew.tasks[k] : w.crews.flatMap((c) => c.tasks).find((x) => x.id === inj.taskId)
        if (!found) throw new RangeError(`stepWorld: unknown task '${inj.taskId}'`)
        task = found
      }
      ws.manual = { task, location: inj.location }
      break
    }
    case 'consent':
      applyConsent(w, worker(inj.workerId), inj.consent)
      break
    case 'system':
      if (inj.what === 'sensor_fail') w.manualSensorFail = true
      else if (inj.what === 'sensor_ok') w.manualSensorFail = false
      else if (inj.what === 'network_down') w.manualNetworkDown = true
      else w.manualNetworkDown = false
      updateDisruptions(w, t)
      break
  }
}

/** Effective sensor/network state at `t` (manual flags OR configured windows); logs transitions. */
function updateDisruptions(w: World, t: number): void {
  const sensorFailed = w.manualSensorFail || inWindow(w.windows.sensor, t)
  if (sensorFailed !== w.sensorFailed) {
    w.sensorFailed = sensorFailed
    log(w, { kind: 'system', t, what: sensorFailed ? 'sensor_fail' : 'sensor_ok' })
  }
  const down = w.manualNetworkDown || inWindow(w.windows.network, t)
  if (down !== w.networkDown) {
    w.networkDown = down
    log(w, { kind: 'system', t, what: down ? 'network_down' : 'network_up' })
    if (!down) {
      const held = w.heldAcks.splice(0)
      for (const h of held) pushAgenda(w, t, h.alertId, h.role, h.delivered)
    }
  }
}

function stepMinute(w: World): void {
  const ti = w.t
  const now = ti + MINUTE_MS
  const i = w.minuteIndex

  // ── A. at ti ──
  while (w.scriptPos < w.script.length && w.script[w.scriptPos].t <= ti) {
    applyInjection(w, w.script[w.scriptPos].event.injection, ti)
    w.scriptPos += 1
  }
  updateDisruptions(w, ti)
  while (w.agenda.length > 0 && w.agenda[0].t <= ti) {
    const item = w.agenda.shift() as AckItem
    // During an outage only the worker's own device can acknowledge; other roles' acknowledgements wait for the network.
    if (w.networkDown && item.role !== 'worker') w.heldAcks.push({ alertId: item.alertId, role: item.role, delivered: true })
    else handleAck(w, item.alertId, item.role, ti, false)
  }
  for (const ws of w.workers) {
    if (ws.evacuated) continue
    personTimers(w, ws, ti)
    if (!ws.evacuated) decideActivity(w, ws, ti, i)
  }

  // ── B. at now ──
  computeEnvironment(w, now)
  const assessments: RiskAssessment[] = []
  for (const ws of w.workers) {
    if (ws.evacuated) {
      ws.acc.restMin += 1
      continue
    }
    const a = stepWorkerTruthAndEngine(w, ws, now, i)
    if (a) assessments.push(a)
    if (ws.working) {
      ws.acc.workMin += 1
      if (ws.location !== 'indoor_cool') ws.acc.hotWorkMin += 1
    } else if (ws.status === 'idle') ws.acc.idleMin += 1
    else ws.acc.restMin += 1
    if (ws.truth.gagge.tCoreC >= 38.5) ws.acc.minutesCoreAbove385 += 1
    traceRow(w, ws, now)
  }

  if (w.engineOn) {
    const roster = w.networkDown ? w.rosterOffline : w.rosterOnline
    let notifications: Notification[]
    if (assessments.length > 0) {
      const r = processAssessments(w.alerts, assessments, { now, roster }, ALERT_OPTS)
      w.alerts = r.state
      recordAlerts(w, now, r.raised)
      recordAlerts(w, now, r.updated)
      notifications = r.notifications
    } else {
      const r = tickAlerts(w.alerts, now, ALERT_OPTS)
      w.alerts = r.state
      recordAlerts(w, now, r.updated)
      notifications = r.notifications
    }
    for (const n of notifications) {
      w.notifications.push(n)
      log(w, { kind: 'notification', t: now, notification: n })
      const al = w.alertLog.get(n.alertId)
      if (al && al.scope === 'worker' && al.workerId && (n.kind === 'escalation' || n.kind === 'renotify' || (n.kind === 'alert' && al.level === 'emergency'))) {
        w.workerById.get(al.workerId)?.acc.escalatedAlertIds.add(al.id)
      }
      if (w.actsOnZill && n.requiresAck) scheduleAck(w, n, now)
    }
  }

  w.t = now
  w.minuteIndex += 1
  if (w.minuteIndex >= w.nMinutes) {
    w.finished = true
    for (const ws of w.workers) if (!ws.evacuated) log(w, { kind: 'shift', t: now, workerId: ws.id, what: 'end' })
  }
}

// ═════════════════════════════════════ Public API ═════════════════════════════════════

/**
 * Advance the world by `minutes` whole minutes (clamped to the end of the shift), after applying `injections` at the
 * current clock. MUTATES `world` in place and returns the same reference. Stepping in chunks (1, 15, 60 … minutes) gives
 * exactly the same result as one call. Basis: docs/SIMULATION.md §3 (per-minute loop).
 * @throws RangeError for a negative/non-integer step or an injection naming an unknown worker, task or location.
 */
export function stepWorld(world: World, minutes: number, injections: readonly WorldInjection[] = []): World {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`stepWorld: minutes must be a non-negative integer (got ${minutes})`)
  if (world.finished) return world
  const started = performance.now()
  for (const inj of injections) applyInjection(world, inj, world.t)
  const n = Math.min(minutes, world.nMinutes - world.minuteIndex)
  for (let k = 0; k < n; k++) stepMinute(world)
  world.elapsedMs += performance.now() - started
  return world
}

/** Minutes left until the end of the shift (for chunked stepping in the UI). Basis: docs/SIMULATION.md §3 (1-min steps). */
export function worldMinutesRemaining(world: World): number {
  return world.nMinutes - world.minuteIndex
}

/**
 * Snapshot for the UI: the engine-side site heat and data status (what the devices see), plan, hours (forecast strip),
 * per-worker view (WorkerView.truth is ground truth for the Lab view only), alerts (open and recently closed), the
 * latest notifications and events (bounded), network and sensor state. A fresh object on every call. Basis:
 * sim/types.ts WorldView; ARCHITECTURE.md §2 (role projection happens in the views).
 */
export function worldView(world: World): WorldView {
  const workers: WorkerView[] = world.workers.map((ws) => ({
    profile: ws.profile,
    task: ws.working ? ws.task : null,
    location: ws.location,
    assessment: ws.assessment,
    detail: ws.detail,
    lastHrBpm: ws.physioActive ? ws.lastHrBpm : null,
    checkinDue: (ws.prompt !== null && !ws.prompt.answered) || (ws.assessment?.actions.includes('symptom_checkin') ?? false),
    truth: { coreC: round2(ws.truth.gagge.tCoreC), hrBpm: Math.round(ws.hrTrue), dehydrationPct: round2(ws.truth.dehydrationPct), symptoms: activeSymptomIds(ws.truth) },
  }))
  return {
    t: world.t,
    config: world.config,
    site: world.site,
    heat: world.heat,
    env: world.env,
    plan: world.plan,
    hours: world.hours,
    workers,
    alerts: Object.values(world.alerts.alerts).map((r) => r.alert),
    notifications: world.notifications.slice(-WORLD_PARAMS.viewNotifications),
    events: world.events.slice(-WORLD_PARAMS.viewEvents),
    network: world.networkDown ? 'offline' : 'online',
    sensor: world.sensorFailed ? 'failed' : world.site.hasWbgtMeter ? 'ok' : 'none',
    finished: world.finished,
  }
}

function subgroupOf(ws: WorkerSim): WorkerSubgroup {
  // Roster attributes at shift start (a mid-shift consent change does not move the worker between fairness cells).
  const p = ws.rosterProfile
  const age = p.ageYears ?? ws.traits.ageYears
  const massKg = p.massKg ?? ws.traits.massKg
  const hM = (p.heightCm ?? ws.traits.heightCm) / 100
  const bmi = massKg / (hM * hM)
  return {
    acclimatization: assessAcclimatization(p).status,
    ageBand: age < 30 ? '<30' : age < 45 ? '30-44' : '45+',
    clothing: p.clothing,
    bmiBand: bmi < 25 ? '<25' : bmi < 30 ? '25-30' : '30+',
    language: p.language,
    wearable: p.hasWearable && p.consent.wearable,
  }
}

function outcomeOf(w: World, ws: WorkerSim): ShiftOutcome {
  const a = ws.acc
  const events = {} as ShiftOutcome['events']
  for (const k of TRUTH_KINDS) events[k] = { count: a.truth[k].count, firstT: a.truth[k].firstT }
  return {
    workerId: ws.id,
    policy: w.config.policy,
    shadow: w.config.shadow,
    subgroup: subgroupOf(ws),
    workMin: a.workMin,
    restMin: a.restMin,
    idleMin: a.idleMin,
    hotWorkMin: a.hotWorkMin,
    waterMl: Math.round(ws.truth.intakeMl),
    maxCoreC: round2(ws.truth.maxCoreC),
    minutesCoreAbove385: a.minutesCoreAbove385,
    maxDehydrationPct: round2(ws.truth.maxDehydrationPct),
    events,
    engine: { minutesByLevel: { ...a.minutesByLevel }, firstHighT: a.firstHighT, firstStopT: a.firstStopT, firstEmergencyT: a.firstEmergencyT },
    adherence: { instructions: a.instructions, followed: a.followed },
    checkins: { prompted: a.prompted, answered: a.answered, selfReported: a.selfReported },
    escalations: a.escalatedAlertIds.size,
  }
}

/**
 * Finish the site-day (steps any remaining minutes) and return the result: per-worker ShiftOutcome (work, rest, idle —
 * work + rest + idle = shift, see {@link idleMinutes} — truth outcomes, engine levels, adherence, check-ins, escalations),
 * the complete ordered event log, the per-minute trace (trace 'full'), alert statistics (alerts.alertStats over every
 * version of every alert), the plan, the reproducibility stamp and the CPU time. Cached: later calls return the same
 * object. Where the policy does not run the engine (ban_only, site_index) the engine fields are empty: no level events,
 * minutesByLevel all 0, and WorkerMinute level 'safe' / workMinPerHour 60 / minutesToLimit null as placeholders.
 * Evacuated workers (emergency hand-over to the ambulance team) end their shift early; their remaining minutes count as
 * rest and they have no trace rows after hand-over. Basis: sim/types.ts SiteDayResult; docs/SIMULATION.md §5.
 */
export function finishWorld(world: World): SiteDayResult {
  if (world.result) return world.result
  if (!world.finished) stepWorld(world, world.nMinutes - world.minuteIndex)
  const started = performance.now()
  const result: SiteDayResult = {
    config: world.config,
    stamp: world.stamp,
    hours: world.hours,
    outcomes: world.workers.map((ws) => outcomeOf(world, ws)),
    events: world.events,
    alertStats: alertStats([...world.alertLog.values()], world.notifications, world.alerts.suppressed),
    plan: world.plan,
    timingMs: 0,
  }
  if (world.minutes) result.minutes = world.minutes
  world.elapsedMs += performance.now() - started
  result.timingMs = Math.round(world.elapsedMs * 10) / 10
  world.result = result
  return result
}

/**
 * Simulate a whole site-day in one call (createWorld → stepWorld to the end → finishWorld). Options carry scripted
 * events. Basis: docs/SIMULATION.md §3. Performance target: 30 workers × a full day in under 3 s in Node.
 */
export function runSiteDay(config: SimConfig, data: SimData, opts: CreateWorldOptions = {}): SiteDayResult {
  const started = performance.now()
  const world = createWorld(config, data, opts)
  world.elapsedMs += performance.now() - started
  return finishWorld(world)
}

/** The WorldSimApi implementation (compile-time contract check against sim/types.ts). */
export const worldSim = { createWorld, stepWorld, worldView, finishWorld, runSiteDay } satisfies WorldSimApi<World>
