/**
 * Contracts of the Simulation lab: the experiment spec the form produces, the messages exchanged with the lab Web Worker
 * (labWorker.ts) and the compact per-policy result it returns. Everything here is SIMULATED COHORT data (virtual
 * workers on real weather, docs/SIMULATION.md) and may carry ground truth: Lab view only, never an operational view.
 */
import type { SiteId } from '../../../data/sites'
import type { AcclimatizationStatus, ClothingId, RiskLevel } from '../../../engine/types'
import type { ScenarioId } from '../../../sim/scenarios'
import type { PolicyId, SiteHour, TruthEventKind } from '../../../sim/types'

/** Local 'HH:mm' window. */
export interface TimeWindow {
  from: string
  to: string
}

/**
 * Which day to simulate: a named scenario (roster + scripted events), or a site-day on real weather (a cached demo day or
 * any archived summer day) with the lab's generated crews.
 */
export type DaySource = { kind: 'scenario'; scenarioId: ScenarioId } | { kind: 'site-day'; siteId: SiteId; date: string }

/** Behaviour assumptions exposed in the lab (sim/types.ts SimBehaviour; every value an [ASSUMPTION]). */
export interface LabBehaviour {
  compliance: number
  selfReportScale: number
  respondScale: number
}

/** Disruptions exposed in the lab (sim/types.ts SimDisruptions). */
export interface LabDisruptions {
  wearableDropout: number
  ppgNoiseMultiplier: number
  envSensorFailure: TimeWindow | null
  networkOutage: TimeWindow | null
}

/** One experiment: the same day, seed and assumptions run once per policy, each in its own world. */
export interface ExperimentSpec {
  source: DaySource
  policies: PolicyId[]
  seed: string
  behaviour: LabBehaviour
  disruptions: LabDisruptions
}

/** Ground-truth harm counts of one run (SIMULATED COHORT; lower is better). */
export interface HarmCount {
  /** Events (a worker can have several). */
  events: number
  /** Workers with at least one. */
  workers: number
}

/** Outcome summary of one policy run (worker-shifts of one site-day). */
export interface PolicySummary {
  workers: number
  shiftMin: number
  excessive: HarmCount
  severe: HarmCount
  critical: HarmCount
  /** Workers whose body-mass loss passed 3 % (ground truth). */
  dehydration: HarmCount
  heatSymptomEpisodes: number
  /** Workers whose shift ended early with a first-aid case. */
  evacuations: number
  peakCoreC: number
  peakDehydrationPct: number
  minutesCoreAbove385: number
  workMin: number
  hotWorkMin: number
  restMin: number
  idleMin: number
  waterMl: number
  alerts: { raised: number; alarms: number; notifications: number; suppressed: number; exposureToSupervisor: number }
  adherence: { instructions: number; followed: number }
  /** Sun-work minutes inside the midday-break window (target 0). */
  middayViolationMin: number
}

/** One virtual worker of a run (Lab only: includes hidden outcome numbers). */
export interface LabRunWorker {
  id: string
  name: string
  crewId: string
  acclimatization: AcclimatizationStatus
  ageBand: string
  clothing: ClothingId
  /** Band paired and wearable consent given. */
  wearable: boolean
  workMin: number
  restMin: number
  waterMl: number
  maxCoreC: number
  maxDehydrationPct: number
  events: Record<TruthEventKind, number>
  minutesByLevel: Record<RiskLevel, number>
  firstHighT: number | null
  firstStopT: number | null
}

/** Source of an event row in the lab's per-worker log. */
export type LabEventSource = 'truth' | 'engine' | 'worker' | 'response'

/** One row of the per-worker event log. */
export interface LabEventMarker {
  t: number
  workerId: string
  source: LabEventSource
  label: string
  /** Set on ground-truth events (chart markers). */
  truth?: TruthEventKind
}

/**
 * Per-minute traces of every worker, column-packed (one typed array per channel, worker-major: index = w·nMinutes + m).
 * NaN (floats) or 255 (codes) = no row (before/after the worker's shift, or a missing value such as no valid wearable
 * minute). Transferred from the worker without copying.
 */
export interface PackedTraces {
  t0: number
  nMinutes: number
  workerIds: string[]
  coreTrueC: Float32Array
  ectempC: Float32Array
  hrTrueBpm: Float32Array
  hrMeasuredBpm: Float32Array
  dehydrationPct: Float32Array
  wbgtEffC: Float32Array
  /** Displayed level code (RISK_LEVELS index). */
  level: Uint8Array
  /** 0 resting/idle, 1 working. */
  working: Uint8Array
  /** 0 sun, 1 shade, 2 indoor (cooled). */
  location: Uint8Array
}

/** Everything the lab keeps from one policy run. */
export interface PolicyRunResult {
  policy: PolicyId
  seed: string
  stamp: string
  /** Wall time of the run in the worker, ms. */
  runMs: number
  siteId: SiteId
  date: string
  shift: { start: string; end: string }
  /** Weather provenance of the day (sim/types.ts SimWeather.provenance): analysis file, forecast file or fallback note. */
  weatherProvenance: string[]
  summary: PolicySummary
  workers: LabRunWorker[]
  events: LabEventMarker[]
  hours: SiteHour[]
  traces: PackedTraces
}

/** Main thread → lab worker. */
export type LabRequest = { type: 'run'; runId: number; dataBaseUrl: string; spec: ExperimentSpec }

/** Lab worker → main thread. */
export type LabResponse =
  | { type: 'progress'; runId: number; phase: 'loading' | 'running'; policyIndex: number; policyCount: number; fraction: number }
  | { type: 'policy'; runId: number; policyIndex: number; result: PolicyRunResult }
  | { type: 'done'; runId: number; elapsedMs: number }
  | { type: 'error'; runId: number; message: string }
