/**
 * Shared contracts for the world simulation (sim/worldsim.ts), scenarios (sim/scenarios.ts), the back-test
 * (sim/backtest.ts), the metrics (sim/metrics.ts) and the app state (src/state/*). Design: docs/SIMULATION.md.
 *
 * Evidence class: everything produced from these types is a SIMULATED COHORT projection (docs/SIMULATION.md), never a
 * measured health outcome. The metrics functions are written over the event log so the same code can score real pilot logs.
 */
import type {
  AcclimatizationStatus,
  ActionId,
  Alert,
  ChannelId,
  Checkin,
  ClothingId,
  ConsentState,
  Crew,
  EnvSample,
  FluidIntake,
  LangCode,
  RiskAssessment,
  RiskLevel,
  Role,
  Site,
  Task,
  WorkerProfile,
} from '../engine/types'
import type { SiteHeat } from '../engine/indices'
import type { WorkerEnvStatus, WorkerLocation, WorkerStepDetail } from '../engine/risk'
import type { AlertStats, Notification } from '../engine/alerts'
import type { DayPlan } from '../engine/planner'
import type { RulePackId } from '../engine/regulation'

// ─────────────────────────────── Configuration ───────────────────────────────

/** The four protection policies compared in the closed-loop back-test (docs/SIMULATION.md §4). */
export type PolicyId = 'ban_only' | 'site_index' | 'zill_env' | 'zill_full'
export const POLICY_IDS: readonly PolicyId[] = ['ban_only', 'site_index', 'zill_env', 'zill_full'] as const

/** Behavioural parameters. Every value is an [ASSUMPTION] and is swept in the sensitivity analysis. */
export interface SimBehaviour {
  /** Probability that a worker follows a rest/stop/drink instruction when it is issued (scaled by traits.complianceFactor). */
  compliance: number
  /** Multiplier on traits.selfReportFactor (unprompted symptom reports). */
  selfReportScale: number
  /** Multiplier on traits.respondFactor (answers to prompted check-ins). */
  respondScale: number
  /** Median minutes before each role acknowledges a notification that requires it. */
  ackDelayMin: { worker: number; buddy: number; supervisor: number; first_aider: number; occ_health: number }
  /** Minutes for a first aider to reach a worker after being paged. */
  firstAiderArrivalMin: number
  /**
   * Probability (0–1) that the supervisor's direct reassignment on a STOP (supervisor acknowledges a stop/emergency
   * alert) is actually carried out, one draw per reassignment. 1 = always carried out (the v0.1 assumption).
   */
  supervisorFollowThrough: number
}

/** Disruptions for the robustness analysis (docs/SIMULATION.md §5). */
export interface SimDisruptions {
  /** Extra fraction of wearable minutes lost, on top of the PPG dropout model (0–1). */
  wearableDropout: number
  /** Multiplier on PPG noise (1 = model default). */
  ppgNoiseMultiplier: number
  /** Site WBGT meter (or the environment feed) fails in this local window; the engine falls back down the chain. */
  envSensorFailure?: { from: string; to: string }
  /** The engine only has a forecast this many hours old (stale-data rules apply). */
  forecastAgeH?: number
  /** Network outage window (local HH:mm): worker devices keep working; supervisor-side delivery is delayed. */
  networkOutage?: { from: string; to: string }
}

export interface SimConfig {
  /** Seed for every random stream (forked per worker and per purpose). */
  seed: string
  siteId: Site['id']
  /** Local date 'YYYY-MM-DD' (Asia/Dubai). */
  date: string
  policy: PolicyId
  /** Shadow mode: the engine runs and alerts, but nobody acts on Zill output (ban_only behaviour) — detection metrics. */
  shadow: boolean
  /** Local shift window 'HH:mm'. */
  shift: { start: string; end: string }
  packId: RulePackId
  behaviour: SimBehaviour
  disruptions: SimDisruptions
  engine: { projectionEveryMin: number }
  /** 'full' keeps per-minute WorkerMinute traces (Lab view, a few crews); 'none' for large cohorts. */
  trace: 'none' | 'full'
  /** Optional explicit roster; default = the synthetic workforce for the site (data/workforce.ts). */
  crews?: Crew[]
  workers?: WorkerProfile[]
}

/** Weather inputs for one site-day. Truth uses the analysis; the engine sees what was actually available. */
export interface SimWeather {
  /** Hourly analysis samples (ECMWF IFS archive) — the "actual" weather the virtual workers experience. */
  analysis: EnvSample[]
  /** Hourly forecast samples available to the engine (archived d1 forecast when present, else analysis + documented error). */
  forecast: EnvSample[]
  /** Provenance strings shown in the UI (model, lead, file). */
  provenance: string[]
}

export interface SimData {
  site: Site
  crews: Crew[]
  workers: WorkerProfile[]
  weather: SimWeather
}

// ─────────────────────────────── Interactive injections (UI → world) ───────────────────────────────

export type WorldInjection =
  | { kind: 'checkin'; checkin: Checkin }
  | { kind: 'intake'; intake: FluidIntake }
  | { kind: 'ack'; alertId: string; role: Role; actorId?: string }
  | { kind: 'resolve'; workerId: string; alertId?: string; by: 'first_aider' | 'supervisor' | 'occ_health' }
  | { kind: 'task'; workerId: string; taskId: string | null; location: WorkerLocation }
  | { kind: 'system'; what: 'sensor_fail' | 'sensor_ok' | 'network_down' | 'network_up' }
  /**
   * The worker's consent changed on their own device (state/governanceStore grant/revoke): from this minute the
   * on-device engine uses `consent` (wearable off → no physiology minutes and no PPG stream; check-ins off → no
   * prompted check-ins, in-person checks only; health flags off → the self-declared risk flags are not used).
   * Device side only: never forwarded over the sync bus.
   */
  | { kind: 'consent'; workerId: string; consent: ConsentState }

/** A scripted event in a named scenario (sim/scenarios.ts), applied when the clock reaches `at` (local HH:mm). */
export interface ScriptedEvent {
  at: string
  injection: WorldInjection
  /** Narration line for the demo timeline. */
  note: string
}

// ─────────────────────────────── Event log ───────────────────────────────

export type TruthEventKind = 'excessive_strain' | 'severe_strain' | 'critical' | 'dehydration_3pct' | 'symptom_onset'

/** Ground-truth symptom clusters (sim/truth.ts SymptomCluster; 'thirst' is the T0 hydration cue, not a heat-illness sign). */
export type TruthSymptomCluster = 'heat_exhaustion' | 'cramps' | 'cns' | 'thirst'

export type SimEvent =
  | { kind: 'shift'; t: number; workerId: string; what: 'start' | 'end' }
  | { kind: 'task'; t: number; workerId: string; taskId: string | null; location: WorkerLocation }
  | { kind: 'level'; t: number; workerId: string; from: RiskLevel; to: RiskLevel; channel: ChannelId | null }
  | { kind: 'alert'; t: number; alert: Alert }
  | { kind: 'notification'; t: number; notification: Notification }
  | { kind: 'ack'; t: number; alertId: string; role: Role }
  | { kind: 'instruction'; t: number; workerId: string; action: ActionId; followed: boolean }
  | { kind: 'checkin'; t: number; checkin: Checkin; prompted: boolean }
  | { kind: 'intake'; t: number; intake: FluidIntake }
  /**
   * Ground truth (simulation only). `t` is when the event is confirmed (for excessive strain, onset + the sustained
   * 10 min); `onsetT` is when the condition started (= `t` for symptom onsets); `cluster` is set on symptom_onset only.
   * `detail` is human-readable text (logs written before worldsim 1.1.0 carry the cluster only as its "<cluster>: …" prefix).
   */
  | { kind: 'truth'; t: number; workerId: string; event: TruthEventKind; detail?: string; onsetT?: number; cluster?: TruthSymptomCluster }
  | { kind: 'resolution'; t: number; workerId: string; by: Role }
  | { kind: 'system'; t: number; what: 'sensor_fail' | 'sensor_ok' | 'network_down' | 'network_up' | 'forecast_stale' }

/** Per-minute trace row (trace === 'full' only). Contains ground truth: Lab/evidence views only, never a worker UI. */
export interface WorkerMinute {
  t: number
  workerId: string
  taskId: string | null
  location: WorkerLocation
  working: boolean
  level: RiskLevel
  computedLevel: RiskLevel
  workMinPerHour: number
  minutesToLimit: number | null
  wbgtEffC: number
  coreTrueC: number
  hrTrueBpm: number
  hrMeasuredBpm: number | null
  ectempC: number | null
  dehydrationPct: number
}

// ─────────────────────────────── Results ───────────────────────────────

export interface WorkerSubgroup {
  acclimatization: AcclimatizationStatus
  ageBand: '<30' | '30-44' | '45+'
  clothing: ClothingId
  bmiBand: '<25' | '25-30' | '30+'
  language: LangCode
  wearable: boolean
}

export interface ShiftOutcome {
  workerId: string
  policy: PolicyId
  shadow: boolean
  subgroup: WorkerSubgroup
  workMin: number
  /** Protective or scheduled rest: cycle rest, midday/statutory break, instructed/enforced rest, first aid, after evacuation. */
  restMin: number
  /** No task assigned (crew job not started or finished, work deferred by the plan): workMin + restMin + idleMin = shift minutes. */
  idleMin: number
  hotWorkMin: number
  waterMl: number
  maxCoreC: number
  minutesCoreAbove385: number
  maxDehydrationPct: number
  /** Ground-truth events (first onset time, count). */
  events: Record<TruthEventKind, { count: number; firstT: number | null }>
  /** Engine output for this worker. */
  engine: {
    minutesByLevel: Record<RiskLevel, number>
    firstHighT: number | null
    firstStopT: number | null
    firstEmergencyT: number | null
  }
  adherence: { instructions: number; followed: number }
  checkins: { prompted: number; answered: number; selfReported: number }
  escalations: number
}

export interface SiteHour {
  t: number
  wbgtC: number
  wbgtShadeC: number
  twlWm2: number
  twlZone: string
  middayBreak: boolean
}

export interface SiteDayResult {
  config: SimConfig
  /** Code/config stamp for reproducibility (e.g. package version + git-free content hash of the config). */
  stamp: string
  hours: SiteHour[]
  outcomes: ShiftOutcome[]
  events: SimEvent[]
  minutes?: WorkerMinute[]
  alertStats: AlertStats
  plan: DayPlan | null
  timingMs: number
}

// ─────────────────────────────── Live view (world → UI) ───────────────────────────────

export interface WorkerView {
  profile: WorkerProfile
  task: Task | null
  location: WorkerLocation
  assessment: RiskAssessment | null
  /** Contains clinical items (ECTemp band, flags-derived settings): worker device and consented clinical views only. */
  detail: WorkerStepDetail | null
  /** Last measured heart rate (worker device only). */
  lastHrBpm: number | null
  checkinDue: boolean
  /** Ground truth (Lab view only — never shown in operational views). */
  truth: { coreC: number; hrBpm: number; dehydrationPct: number; symptoms: string[] } | null
}

export interface WorldView {
  t: number
  config: SimConfig
  site: Site
  heat: SiteHeat | null
  env: WorkerEnvStatus | null
  plan: DayPlan | null
  hours: SiteHour[]
  workers: WorkerView[]
  alerts: Alert[]
  /** Most recent notifications (bounded). */
  notifications: Notification[]
  /** Most recent events (bounded). */
  events: SimEvent[]
  network: 'online' | 'offline'
  sensor: 'ok' | 'failed' | 'none'
  finished: boolean
}

/**
 * The API sim/worldsim.ts must export (checked at compile time in worldsim.ts with `satisfies WorldSimApi`).
 * `World` is opaque to callers; stepWorld may mutate and return the same object (document which).
 */
export interface WorldSimApi<World = unknown> {
  createWorld(config: SimConfig, data: SimData): World
  stepWorld(world: World, minutes: number, injections?: readonly WorldInjection[]): World
  worldView(world: World): WorldView
  finishWorld(world: World): SiteDayResult
  runSiteDay(config: SimConfig, data: SimData): SiteDayResult
}
