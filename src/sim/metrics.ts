/**
 * Back-test and pilot metrics (docs/SIMULATION.md §4–§5; docs/PILOT.md §5.4 endpoints). Pure functions: no clock, no
 * I/O, and the only randomness is the seeded cluster bootstrap (sim/rng.ts).
 *
 * Two layers:
 * 1. **Record builders** turn one site-day ({@link SiteDayResult}) into one compact {@link WorkerShiftRecord} per
 *    worker-shift. Apart from the `truth` block and the outcome totals, every field is computed from the event log
 *    (`alert`, `ack`, `checkin`, `instruction`, `task`, `shift` events — the sim/types.ts {@link SimEvent} schema), so a
 *    pilot can run the same functions on its app log (PILOT.md §5.3: "computed with the same pure functions the
 *    simulation uses"). The `truth` block is simulation-only ground truth (sim/truth.ts); in a pilot the log-derived
 *    `symptomaticT` (first T2+ check-in or first-aid case) takes its place as the detection target.
 * 2. **Aggregators** over records: rates per 1,000 worker-shifts, shadow-mode detection, the challenge's safety and
 *    productivity measures, paired policy comparisons and fairness breakdowns, with a seeded cluster bootstrap over
 *    site-days (workers on the same site-day share the weather, so they are not independent).
 *
 * Evidence class: SIMULATED COHORT. Every number is a projection under stated assumptions (SIMULATION.md §6), never a
 * measured health outcome.
 */
import type { BasisCounts } from '../engine/alerts'
import { triage } from '../engine/clinical'
import { getRulePack, middayBreakWindow, regulatoryFloor, type RulePack } from '../engine/regulation'
import { epochFromLocal, MINUTE_MS } from '../engine/time'
import { RISK_ORDER, type AlertBasis, type Crew, type RiskLevel, type Role, type Task } from '../engine/types'
import { createRng } from './rng'
import type { PolicyId, SimConfig, SimEvent, SiteDayResult, SiteHour, TruthEventKind, WorkerMinute, WorkerSubgroup } from './types'

// ─────────────────────────────── Constants ───────────────────────────────

/**
 * Version of the metric definitions; part of every cohort report. 1.1.0: alarms split by Alert.basis — headline
 * detection on INDIVIDUAL alarms at ≥ high and ≥ stop, exposure advisories reported separately, alert burden by basis
 * and role (the all-alarm fields of 1.0.0 are kept for comparison).
 */
export const METRICS_VERSION = '1.1.0'

/** Ground-truth event kinds in report order (sim/types.ts TruthEventKind; definitions SIMULATION.md §2.4). */
export const TRUTH_EVENT_KINDS: readonly TruthEventKind[] = ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'symptom_onset']

/**
 * What a warning should precede: a ground-truth event (simulation only; `heat_symptoms` = the first heat-exhaustion,
 * cramps or CNS symptom onset, thirst excluded) or `symptomatic` — the first T2+ check-in or first-aid case of the
 * shift, computed from the event log only (PILOT.md §5.4 (a), so a pilot can use it).
 */
export type DetectionTarget = Exclude<TruthEventKind, 'symptom_onset'> | 'heat_symptoms' | 'symptomatic'

/** Detection targets in report order. */
export const DETECTION_TARGETS: readonly DetectionTarget[] = ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'heat_symptoms', 'symptomatic']

/** Ground-truth symptom clusters that are not heat-illness symptoms (sim/truth.ts SymptomCluster 'thirst', triage T0). */
export const NON_HEAT_SYMPTOM_CLUSTERS: readonly string[] = ['thirst']

/** Subgroup dimensions of the fairness breakdown (SIMULATION.md §5 "Fairness"). */
export const FAIRNESS_DIMENSIONS: readonly (keyof WorkerSubgroup)[] = ['acclimatization', 'ageBand', 'clothing', 'bmiBand', 'language', 'wearable']

/**
 * Metric parameters. Each is cited or tagged:
 * - `alarmMinLevel` 'high' — PILOT.md §5.4 (a) "the first Zill alert at HIGH or above for a worker or crew".
 * - `confirmHorizonMin` 120 — an alarm is "confirmed" when the target's onset lies within ±120 min of it [ENG].
 * - `leadTimeEdgesMin` — lead-time histogram edges, minutes [ENG].
 * - `calibrationEdgesMin` 15/45/90 — the projection channel's bands (ARCHITECTURE.md §5: < 15 stop, 15–45 high,
 *   45–90 caution, > 90 safe).
 * - `calibrationSampleEveryMin` 5 — the PHS projection cadence (SimConfig.engine.projectionEveryMin default).
 * - `limitCoreC` 38.0 — the ISO 7933:2023 rectal-temperature limit the projection counts down to, applied to the
 *   ground-truth core temperature; `limitDehydrationPct` 3 — the ground-truth dehydration event (SIMULATION.md §2.4)
 *   used as the dehydration-limit analogue [ENG].
 * - `zoneToleranceMin` 1 — rounding tolerance on the ADOSH work/rest allowance per clock hour [ENG].
 * - `bootstrapReplicates` 1000 — percentile bootstrap (Efron & Tibshirani 1993); same count as the real-data
 *   validation (data_and_validation.md §10 B.4).
 * - `ruleOfThree` 3 — one-sided 95 % upper bound 3/n for a zero count (Hanley & Lippman-Hand 1983, JAMA 249:1743).
 */
export const METRIC_PARAMS = Object.freeze({
  alarmMinLevel: 'high' as RiskLevel,
  confirmHorizonMin: 120,
  leadTimeEdgesMin: Object.freeze([0, 15, 30, 60, 120]) as readonly number[],
  calibrationEdgesMin: Object.freeze([15, 45, 90]) as readonly number[],
  calibrationSampleEveryMin: 5,
  limitCoreC: 38.0,
  limitDehydrationPct: 3,
  zoneToleranceMin: 1,
  bootstrapReplicates: 1000,
  ruleOfThree: 3,
})

// ─────────────────────────────── Records ───────────────────────────────

/** ADOSH zone-control check of one worker-shift (sun work only; see {@link workerShiftRecords}). */
export interface ZoneCheck {
  /** Worker-hours with sun work in a clock hour whose forecast TWL zone is Medium or High (controls apply). */
  workerHours: number
  /** Of those, worker-hours within the zone's work/rest allowance (dose ≤ 1, + tolerance) and without an excluded worker. */
  compliantHours: number
  /** Minutes above the allowance: (dose − 1) × the most restrictive allowance of the hour (= sun minutes − allowance
   *  for a single task), summed over the worker-hours. */
  excessMin: number
  /** Worker-hours in which an ADOSH-unacclimatised worker did more than the tolerance of sun work in a zone that
   *  excludes them. */
  unacclimatizedHours: number
}

/** One worker-shift, reduced to what the aggregators need. Times are epoch ms. */
export interface WorkerShiftRecord {
  /** Bootstrap cluster: `${siteId}|${date}` (workers of one site-day share the weather). */
  cluster: string
  siteId: string
  date: string
  workerId: string
  policy: PolicyId
  shadow: boolean
  /** The engine ran (any Zill policy, or shadow mode); otherwise alarms and engine fields are empty by design. */
  engineRan: boolean
  subgroup: WorkerSubgroup
  /** Scheduled shift length, minutes. */
  shiftMin: number
  workMin: number
  restMin: number
  hotWorkMin: number
  waterMl: number
  maxCoreC: number
  minutesCoreAbove385: number
  maxDehydrationPct: number
  /** Ground truth (simulation only): number of events and FIRST onset time per kind (ShiftOutcome.events; symptom_onset
   *  includes thirst). */
  truth: Record<TruthEventKind, { count: number; onsetT: number | null }>
  /** Ground truth (simulation only): heat-symptom episodes — `truth` symptom_onset events whose cluster (the structured
   *  `cluster` field; for logs from worldsim < 1.1.0 the `detail` prefix "<cluster>: …") is heat exhaustion, cramps or
   *  CNS — and the first one's onset (`onsetT`, else the event time). */
  heatSymptomEpisodes: number
  heatSymptomOnsetT: number | null
  /** First symptomatic event from the log: a check-in triaged T2+ (engine/clinical.ts triage) or a first-aid case. */
  symptomaticT: number | null
  /** Check-ins (any reporter) whose triage tier is ≥ 1 — "heat-symptom check-ins" (PILOT.md §5.4). */
  symptomReports: number
  /** Distinct alerts at ≥ the alarm level covering this worker (worker alert, or crew/site alert listing them), each at
   *  the first logged time it covered the worker at that level; sorted. */
  alarmTimes: number[]
  /**
   * Distinct alerts covering this worker whose basis at ≥ high / ≥ stop is INDIVIDUAL (Alert.basis; a missing basis
   * counts as individual), each at the first logged non-resolved version at that level that was individual — an
   * exposure alert re-labelled individual counts from the re-label; sorted ({@link alarmTimesByBasis}). The headline
   * detection metrics use these.
   */
  individualAlarmTimes: { high: number[]; stop: number[] }
  /**
   * Exposure advisories on the worker's device: distinct worker-scope alerts at ≥ high whose every version at ≥ high
   * was 'exposure' (a site or crew condition; crew alerts that bundle them are not counted again).
   */
  exposureAdvisories: number
  /** Engine minutes at ≥ high and ≥ stop (ShiftOutcome.engine.minutesByLevel), and the first emergency time. */
  minutesHighPlus: number
  minutesStopPlus: number
  engineEmergencyT: number | null
  /** Instructions shown to the worker and how many were followed (`instruction` events). */
  instructions: number
  followed: number
  checkinsPrompted: number
  checkinsAnswered: number
  selfReported: number
  /** Distinct alerts escalated by an acknowledgement timer for this worker (ShiftOutcome.escalations). */
  escalations: number
  /** First-aid case that ended the shift early (`shift` end before the scheduled end), else null. */
  evacuatedT: number | null
  /** Scheduled shift minutes lost after an evacuation. */
  lostMin: number
  /** Sun-work minutes inside the midday-break window (MoHRE MR 44/2022; target 0). */
  middayViolationMin: number
  zone: ZoneCheck
}

/** Options of {@link workerShiftRecords}. */
export interface RecordOptions {
  /** Crews with their task lists (task → work class for the zone check); default result.config.crews. */
  crews?: readonly Crew[]
  /** Workers who are ADOSH-unacclimatised (limits.assessAcclimatization().adoshUnacclimatized); default: every worker
   *  whose subgroup status is not 'acclimatized' (protective). */
  adoshUnacclimatized?: ReadonlySet<string>
  /** Alarm level (default {@link METRIC_PARAMS}.alarmMinLevel). */
  minLevel?: RiskLevel
}

/** True when the engine runs under this configuration (Zill policies or shadow mode; worldsim.ts createWorld). */
export function engineRuns(config: Pick<SimConfig, 'policy' | 'shadow'>): boolean {
  return config.shadow || config.policy === 'zill_env' || config.policy === 'zill_full'
}

/** Scheduled shift window [startT, endT) of a configuration (Asia/Dubai local times; engine/time.ts). */
export function shiftWindow(config: Pick<SimConfig, 'date' | 'shift'>): { startT: number; endT: number } {
  return { startT: epochFromLocal(`${config.date}T${config.shift.start}`), endT: epochFromLocal(`${config.date}T${config.shift.end}`) }
}

/**
 * Alarm times per worker from the event log: every distinct alert id whose level is ≥ `minLevel` and that is not
 * resolved, at the first logged time it covered the worker at that level (worker scope → `workerId`; crew/site scope →
 * `memberIds`). Basis: PILOT.md §5.4 (a) "first Zill alert at HIGH or above for a worker or crew".
 */
export function alarmTimesByWorker(events: readonly SimEvent[], minLevel: RiskLevel = METRIC_PARAMS.alarmMinLevel): Map<string, number[]> {
  const first = new Map<string, Map<string, number>>()
  for (const e of events) {
    if (e.kind !== 'alert') continue
    const a = e.alert
    if (a.status === 'resolved' || RISK_ORDER[a.level] < RISK_ORDER[minLevel]) continue
    const ids = a.scope === 'worker' ? (a.workerId ? [a.workerId] : []) : (a.memberIds ?? [])
    for (const w of ids) {
      let m = first.get(w)
      if (!m) first.set(w, (m = new Map()))
      const prev = m.get(a.id)
      if (prev === undefined || e.t < prev) m.set(a.id, e.t)
    }
  }
  const out = new Map<string, number[]>()
  for (const [w, m] of first) out.set(w, [...m.values()].sort((x, y) => x - y))
  return out
}

/** Alarm times per worker split by basis ({@link alarmTimesByBasis}). */
export interface AlarmTimesByBasis {
  /** Per worker: sorted first times of the alerts that were individual at ≥ the level (any scope). */
  individual: Map<string, number[]>
  /** Per worker: sorted first times of the worker-scope alerts that were exposure at every version at ≥ the level. */
  exposure: Map<string, number[]>
}

/**
 * Alarm times per worker from the event log, split by Alert.basis (engine/alerts.ts; a missing basis counts as
 * 'individual', engine/types.ts Alert.basis): for every distinct alert covering the worker (worker scope → `workerId`;
 * crew/site scope → `memberIds`), its non-resolved versions at ≥ `minLevel` are read in log order. It is an individual
 * alarm at the first such version whose basis is individual — an open exposure alert re-labelled individual (sticky
 * individual) counts from the re-label — and an exposure advisory when every such version was exposure; exposure
 * advisories count worker-scope alerts only (the crew alert that bundles them is the same condition).
 * Basis: PILOT.md §5.4 (a); wave 2c task brief (detection on individual alarms; exposure advisories separately).
 */
export function alarmTimesByBasis(events: readonly SimEvent[], minLevel: RiskLevel = METRIC_PARAMS.alarmMinLevel): AlarmTimesByBasis {
  const ind = new Map<string, Map<string, number>>()
  const exp = new Map<string, Map<string, number>>()
  const put = (m: Map<string, Map<string, number>>, w: string, id: string, t: number): void => {
    let x = m.get(w)
    if (!x) m.set(w, (x = new Map()))
    const prev = x.get(id)
    if (prev === undefined || t < prev) x.set(id, t)
  }
  for (const e of events) {
    if (e.kind !== 'alert') continue
    const a = e.alert
    if (a.status === 'resolved' || RISK_ORDER[a.level] < RISK_ORDER[minLevel]) continue
    const ids = a.scope === 'worker' ? (a.workerId ? [a.workerId] : []) : (a.memberIds ?? [])
    const individual = (a.basis ?? 'individual') === 'individual'
    for (const w of ids) {
      if (individual) put(ind, w, a.id, e.t)
      else if (a.scope === 'worker') put(exp, w, a.id, e.t)
    }
  }
  const out: AlarmTimesByBasis = { individual: new Map(), exposure: new Map() }
  for (const [w, m] of ind) out.individual.set(w, [...m.values()].sort((x, y) => x - y))
  for (const [w, m] of exp) {
    // An alert that later became individual at ≥ the level is an individual alarm, not an exposure advisory.
    const indIds = ind.get(w)
    const times = [...m.entries()].filter(([id]) => !indIds?.has(id)).map(([, t]) => t)
    if (times.length) out.exposure.set(w, times.sort((x, y) => x - y))
  }
  return out
}

interface Segment {
  a: number
  b: number
  taskId: string
}

interface WorkerLog {
  tasks: { t: number; taskId: string | null; location: string }[]
  endT: number | null
  symptomaticT: number | null
  symptomReports: number
  heatEpisodes: number
  heatOnsetT: number | null
}

const overlapMin = (a: number, b: number, lo: number, hi: number): number => Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / MINUTE_MS

/** Sun-work segments [a, b) of one worker from its `task` events, cut at its own shift end. */
function sunSegments(log: WorkerLog, stopT: number): Segment[] {
  const ts = [...log.tasks].sort((x, y) => x.t - y.t)
  const out: Segment[] = []
  for (let i = 0; i < ts.length; i++) {
    const s = ts[i]
    if (s.taskId === null || s.location !== 'sun') continue
    const b = Math.min(i + 1 < ts.length ? ts[i + 1].t : stopT, stopT)
    if (b > s.t) out.push({ a: s.t, b, taskId: s.taskId })
  }
  return out
}

/** Zone check of one worker over the site-day's forecast hours (see {@link ZoneCheck}). */
function zoneCheck(
  segs: readonly Segment[],
  hours: readonly SiteHour[],
  taskById: ReadonlyMap<string, Task>,
  unacclimatized: boolean,
  pack: RulePack,
): ZoneCheck {
  const z: ZoneCheck = { workerHours: 0, compliantHours: 0, excessMin: 0, unacclimatizedHours: 0 }
  if (segs.length === 0) return z
  const tol = METRIC_PARAMS.zoneToleranceMin
  for (const h of hours) {
    if (h.twlZone !== 'medium' && h.twlZone !== 'high') continue
    const hEnd = h.t + 60 * MINUTE_MS
    let sunMin = 0
    let dose = 0
    let minAllowed = 60
    let excluded = false
    for (const s of segs) {
      const m = overlapMin(s.a, s.b, h.t, hEnd)
      if (m <= 0) continue
      sunMin += m
      const task = taskById.get(s.taskId)
      if (!task) continue
      const floor = regulatoryFloor({ t: h.t, twlWm2: h.twlWm2, outdoorInSun: true, acclimatization: unacclimatized ? 'unacclimatized' : 'acclimatized', workClass: task.workClass, pack })
      if (floor.unacclimatizedExcluded) excluded = true
      const allowed = floor.workRest ? floor.workRest.workMinPerHour : 60
      if (allowed > 0) dose += m / allowed
      minAllowed = Math.min(minAllowed, allowed)
    }
    if (sunMin <= 0) continue
    z.workerHours += 1
    const excess = Math.max(0, dose - 1) * minAllowed
    z.excessMin += excess
    const excl = excluded && sunMin > tol
    if (excl) z.unacclimatizedHours += 1
    if (!excl && excess <= tol) z.compliantHours += 1
  }
  return z
}

/**
 * Symptom cluster of a ground-truth `truth` event: the structured `cluster` field (worldsim ≥ 1.1.0), else — for older
 * logs only — the `detail` prefix "<cluster>: …" that worldsim 1.0.0 wrote; '' when neither is present.
 * Basis: sim/types.ts SimEvent ('truth').
 */
export function truthEventCluster(e: Extract<SimEvent, { kind: 'truth' }>): string {
  return e.cluster ?? (e.detail ?? '').split(':')[0].trim()
}

/**
 * One {@link WorkerShiftRecord} per worker-shift of a site-day. The outcome totals and the `truth` block come from
 * `result.outcomes`; alarms, symptomatic events, evacuations, midday-break and zone-control checks come from
 * `result.events` (pilot-computable). The zone check uses the site-day's forecast TWL zone at the start of each clock
 * hour (`result.hours`, sun TWL), so it covers sun work only. Each task's allowance is regulation.ts regulatoryFloor's
 * zone work/rest schedule for its work class (ADOSH-SF TG v4.0 Table 1); tasks sharing an hour are combined as a dose
 * Σ minutes/allowance ≤ 1, the sum-of-fractions rule used for mixed exposures (ACGIH TLV mixtures; ISO 9612 noise dose)
 * [ENG].
 */
export function workerShiftRecords(result: SiteDayResult, opts: RecordOptions = {}): WorkerShiftRecord[] {
  const cfg = result.config
  const { startT, endT } = shiftWindow(cfg)
  const shiftMin = Math.round((endT - startT) / MINUTE_MS)
  const pack = getRulePack(cfg.packId)
  const ran = engineRuns(cfg)
  const alarms = alarmTimesByWorker(result.events, opts.minLevel ?? METRIC_PARAMS.alarmMinLevel)
  const basisHigh = alarmTimesByBasis(result.events, 'high')
  const basisStop = alarmTimesByBasis(result.events, 'stop')
  const crews = opts.crews ?? cfg.crews ?? []
  const crewOf = new Map<string, Crew>()
  for (const c of crews) for (const id of c.workerIds) crewOf.set(id, c)

  const logs = new Map<string, WorkerLog>()
  const logOf = (id: string): WorkerLog => {
    let l = logs.get(id)
    if (!l) logs.set(id, (l = { tasks: [], endT: null, symptomaticT: null, symptomReports: 0, heatEpisodes: 0, heatOnsetT: null }))
    return l
  }
  const symptomatic = (l: WorkerLog, t: number): void => {
    if (l.symptomaticT === null || t < l.symptomaticT) l.symptomaticT = t
  }
  for (const e of result.events) {
    if (e.kind === 'task') logOf(e.workerId).tasks.push({ t: e.t, taskId: e.taskId, location: e.location })
    else if (e.kind === 'checkin' && e.checkin.symptoms.length > 0) {
      const tier = triage(e.checkin).tier
      const l = logOf(e.checkin.workerId)
      if (tier >= 1) l.symptomReports += 1
      if (tier >= 2) symptomatic(l, e.t)
    } else if (e.kind === 'shift' && e.what === 'end') {
      const l = logOf(e.workerId)
      if (l.endT === null || e.t < l.endT) l.endT = e.t
    } else if (e.kind === 'truth' && e.event === 'symptom_onset') {
      if (NON_HEAT_SYMPTOM_CLUSTERS.includes(truthEventCluster(e))) continue
      const l = logOf(e.workerId)
      const onsetT = e.onsetT ?? e.t
      l.heatEpisodes += 1
      if (l.heatOnsetT === null || onsetT < l.heatOnsetT) l.heatOnsetT = onsetT
    }
  }
  const window = middayBreakWindow(startT, pack)
  const cluster = `${cfg.siteId}|${cfg.date}`

  return result.outcomes.map((o) => {
    const log = logOf(o.workerId)
    const evacuatedT = log.endT !== null && log.endT < endT ? log.endT : null
    if (evacuatedT !== null) symptomatic(log, evacuatedT)
    const segs = sunSegments(log, evacuatedT ?? endT)
    let midday = 0
    if (window) for (const s of segs) midday += overlapMin(s.a, s.b, window.startT, window.endT)
    const crew = crewOf.get(o.workerId)
    const taskById = new Map<string, Task>((crew?.tasks ?? []).map((t) => [t.id, t]))
    const unaccl = opts.adoshUnacclimatized ? opts.adoshUnacclimatized.has(o.workerId) : o.subgroup.acclimatization !== 'acclimatized'
    const truth = {} as WorkerShiftRecord['truth']
    for (const k of TRUTH_EVENT_KINDS) truth[k] = { count: o.events[k].count, onsetT: o.events[k].firstT }
    const lv = o.engine.minutesByLevel
    return {
      cluster,
      siteId: cfg.siteId,
      date: cfg.date,
      workerId: o.workerId,
      policy: o.policy,
      shadow: o.shadow,
      engineRan: ran,
      subgroup: o.subgroup,
      shiftMin,
      workMin: o.workMin,
      restMin: o.restMin,
      hotWorkMin: o.hotWorkMin,
      waterMl: o.waterMl,
      maxCoreC: o.maxCoreC,
      minutesCoreAbove385: o.minutesCoreAbove385,
      maxDehydrationPct: o.maxDehydrationPct,
      truth,
      heatSymptomEpisodes: log.heatEpisodes,
      heatSymptomOnsetT: log.heatOnsetT,
      symptomaticT: log.symptomaticT,
      symptomReports: log.symptomReports,
      alarmTimes: ran ? (alarms.get(o.workerId) ?? []) : [],
      individualAlarmTimes: ran ? { high: basisHigh.individual.get(o.workerId) ?? [], stop: basisStop.individual.get(o.workerId) ?? [] } : { high: [], stop: [] },
      exposureAdvisories: ran ? (basisHigh.exposure.get(o.workerId)?.length ?? 0) : 0,
      minutesHighPlus: ran ? lv.high + lv.stop + lv.emergency : 0,
      minutesStopPlus: ran ? lv.stop + lv.emergency : 0,
      engineEmergencyT: ran ? o.engine.firstEmergencyT : null,
      instructions: o.adherence.instructions,
      followed: o.adherence.followed,
      checkinsPrompted: o.checkins.prompted,
      checkinsAnswered: o.checkins.answered,
      selfReported: o.checkins.selfReported,
      escalations: o.escalations,
      evacuatedT,
      lostMin: evacuatedT === null ? 0 : Math.round((endT - evacuatedT) / MINUTE_MS),
      middayViolationMin: Math.round(midday),
      zone: zoneCheck(segs, result.hours, taskById, unaccl, pack),
    }
  })
}

/** Alert-handling summary of one site-day (event log + result.alertStats). */
export interface RunAlertSummary {
  /** Distinct alerts raised (any level). */
  alerts: number
  /** Distinct alerts that reached the alarm level. */
  alarms: number
  /** Alerts that asked someone to acknowledge (acknowledged + never acknowledged; engine/alerts.ts alertStats). */
  requiringAck: number
  acknowledged: number
  /** Minutes from the first logged version of each alert to its first `ack` event. */
  ackDelaysMin: number[]
  /** Distinct alerts escalated by an acknowledgement timer. */
  escalatedAlerts: number
  notifications: number
  suppressed: number
  crewBundledWorkerAlerts: number
  /** Worker-shifts and crew-shifts of the site-day (denominators of the burden and per-crew-shift counts). */
  workerShifts: number
  crewShifts: number
  /**
   * Exposure advisories that reached a supervisor: distinct alerts at ≥ the alarm level notified to a supervisor with
   * basis 'exposure' (crew alerts, plus exposure worker alerts not bundled into one).
   */
  exposureAdvisoriesToSupervisor: number
  /** Notifications sent and those requiring an acknowledgement, by basis (at sending) and recipient role. */
  notificationsByBasisRole: BasisRoleCounts
  /** engine/alerts.ts AlertStats.byBasis (alerts by their latest basis; notifications by their basis at sending). */
  byBasis: Record<AlertBasis, BasisCounts>
}

/** Notification counts by basis and recipient role ({@link RunAlertSummary}.notificationsByBasisRole). */
export type BasisRoleCounts = Record<AlertBasis, Partial<Record<Role, { sent: number; requiringAck: number }>>>

/** Bases in report order. */
export const ALERT_BASES: readonly AlertBasis[] = ['individual', 'exposure']

const emptyBasisCounts = (): BasisCounts => ({ alerts: 0, notifications: 0, notificationsRequiringAck: 0, unacknowledged: 0 })

/**
 * {@link RunAlertSummary} of one site-day. Basis: engine/alerts.ts alertStats (counts) + the `ack` events (delays) +
 * the `notification` events (burden by basis and role; a missing basis counts as individual). `opts.crews` (default
 * result.config.crews) gives the crew-shift count: crews with at least one worker in the outcomes.
 */
export function runAlertSummary(result: SiteDayResult, minLevel: RiskLevel = METRIC_PARAMS.alarmMinLevel, opts: { crews?: readonly Crew[] } = {}): RunAlertSummary {
  const raised = new Map<string, number>()
  const alarmIds = new Set<string>()
  const acked = new Map<string, number>()
  for (const e of result.events) {
    if (e.kind === 'alert') {
      const prev = raised.get(e.alert.id)
      if (prev === undefined || e.t < prev) raised.set(e.alert.id, e.t)
      if (RISK_ORDER[e.alert.level] >= RISK_ORDER[minLevel]) alarmIds.add(e.alert.id)
    } else if (e.kind === 'ack') {
      const prev = acked.get(e.alertId)
      if (prev === undefined || e.t < prev) acked.set(e.alertId, e.t)
    }
  }
  const byRole: BasisRoleCounts = { individual: {}, exposure: {} }
  const toSupervisor = new Set<string>()
  for (const e of result.events) {
    if (e.kind !== 'notification') continue
    const n = e.notification
    const basis: AlertBasis = n.basis ?? 'individual'
    const cell = byRole[basis][n.to.role] ?? (byRole[basis][n.to.role] = { sent: 0, requiringAck: 0 })
    cell.sent += 1
    if (n.requiresAck) cell.requiringAck += 1
    if (basis === 'exposure' && n.to.role === 'supervisor' && RISK_ORDER[n.level] >= RISK_ORDER[minLevel]) toSupervisor.add(n.alertId)
  }
  const workerIds = new Set(result.outcomes.map((o) => o.workerId))
  const crews = opts.crews ?? result.config.crews ?? []
  const delays: number[] = []
  for (const [id, t] of acked) {
    const r = raised.get(id)
    if (r !== undefined && t >= r) delays.push(Math.round(((t - r) / MINUTE_MS) * 10) / 10)
  }
  const s = result.alertStats
  return {
    alerts: raised.size,
    alarms: alarmIds.size,
    requiringAck: s.acknowledged + s.unacknowledged,
    acknowledged: s.acknowledged,
    ackDelaysMin: delays.sort((a, b) => a - b),
    escalatedAlerts: s.escalations.alertsEscalated,
    notifications: s.notifications,
    suppressed: s.suppressed,
    crewBundledWorkerAlerts: s.crewBundledWorkerAlerts,
    workerShifts: result.outcomes.length,
    crewShifts: crews.filter((c) => c.workerIds.some((id) => workerIds.has(id))).length,
    exposureAdvisoriesToSupervisor: toSupervisor.size,
    notificationsByBasisRole: byRole,
    byBasis: { individual: { ...emptyBasisCounts(), ...(s.byBasis?.individual ?? {}) }, exposure: { ...emptyBasisCounts(), ...(s.byBasis?.exposure ?? {}) } },
  }
}

// ─────────────────────────────── Calibration of minutes-to-limit ───────────────────────────────

/** Mergeable counts for one predicted-minutes bin. */
export interface CalibrationBin {
  /** True for the bin of predictions equal to 0: the ISO 7933 limit is already reached in the projection, which then
   *  stays at stop until a reviewed recovery (risk.ts projection latch). */
  latched: boolean
  fromMin: number
  /** Exclusive upper edge; null = the last bin (≥ last edge, or beyond the projection horizon). */
  toMin: number | null
  /** Follow-up horizon used for this bin: its upper edge, or the last edge for the open bin. */
  horizonMin: number
  /** Samples with complete follow-up (the horizon fits in the shift, or the limit was reached before). */
  samples: number
  /** Samples whose ground truth reached the limit within the horizon. */
  reached: number
  /** Σ predicted minutes over samples with a finite prediction (for the mean). */
  sumPredictedMin: number
  /** Samples whose prediction was null (beyond the projection horizon). */
  nullPredictions: number
}

/** Mergeable calibration counts (see {@link calibrationCounts}). */
export interface CalibrationCounts {
  bins: CalibrationBin[]
}

/** Empty {@link CalibrationCounts} for the given edges. */
export function emptyCalibration(edges: readonly number[] = METRIC_PARAMS.calibrationEdgesMin): CalibrationCounts {
  const zero = { samples: 0, reached: 0, sumPredictedMin: 0, nullPredictions: 0 }
  const bins: CalibrationBin[] = [{ latched: true, fromMin: 0, toMin: 0, horizonMin: edges.length ? edges[0] : 15, ...zero }]
  let lo = 0
  for (const e of edges) {
    bins.push({ latched: false, fromMin: lo, toMin: e, horizonMin: e, ...zero })
    lo = e
  }
  bins.push({ latched: false, fromMin: lo, toMin: null, horizonMin: lo, ...zero })
  return { bins }
}

/**
 * Calibration counts of the engine's minutes-to-limit against the ground truth, from per-minute traces (trace 'full')
 * of a run in which the engine ran — meaningful in shadow mode only, because acting on the projection censors the
 * outcome. Definition: every `calibrationSampleEveryMin`-th minute of each worker's trace (from the first row) at which
 * the worker is working and the ground-truth limit is not exceeded at that minute is a sample. The ground-truth limit is
 * core ≥ `limitCoreC` (ISO 7933:2023 rectal limit) or dehydration ≥ `limitDehydrationPct`. The sample goes to the bin
 * of its predicted minutes (0 → the latched bin, whose horizon is the first edge; null → the open bin); it counts as
 * `reached` when the truth limit occurs within the bin's
 * horizon, and is kept only if that horizon fits before `endT` or the limit occurred earlier (no censoring by the shift
 * end). A calibrated projection reaches the limit within 15 min in most of the < 15 bin and rarely in the open bin;
 * the projection assumes the current activity continues, so breaks and task changes after the sample make it look
 * conservative.
 */
export function calibrationCounts(minutes: readonly WorkerMinute[], endT: number, edges: readonly number[] = METRIC_PARAMS.calibrationEdgesMin): CalibrationCounts {
  const out = emptyCalibration(edges)
  const byWorker = new Map<string, WorkerMinute[]>()
  for (const m of minutes) {
    let a = byWorker.get(m.workerId)
    if (!a) byWorker.set(m.workerId, (a = []))
    a.push(m)
  }
  const every = METRIC_PARAMS.calibrationSampleEveryMin
  for (const rows of byWorker.values()) {
    rows.sort((x, y) => x.t - y.t)
    const n = rows.length
    const nextReach = new Float64Array(n + 1)
    nextReach[n] = Number.POSITIVE_INFINITY
    for (let i = n - 1; i >= 0; i--) {
      const r = rows[i]
      nextReach[i] = r.coreTrueC >= METRIC_PARAMS.limitCoreC || r.dehydrationPct >= METRIC_PARAMS.limitDehydrationPct ? r.t : nextReach[i + 1]
    }
    for (let i = 0; i < n; i += every) {
      const r = rows[i]
      if (!r.working || nextReach[i] === r.t) continue
      const pred = r.minutesToLimit
      const bin = pred === null ? out.bins[out.bins.length - 1] : pred <= 0 ? out.bins[0] : (out.bins.find((b) => !b.latched && (b.toMin === null || pred < b.toMin)) as CalibrationBin)
      const observedMin = (nextReach[i] - r.t) / MINUTE_MS
      const reached = observedMin <= bin.horizonMin
      if (!reached && r.t + bin.horizonMin * MINUTE_MS > endT) continue
      bin.samples += 1
      if (reached) bin.reached += 1
      if (pred === null) bin.nullPredictions += 1
      else bin.sumPredictedMin += pred
    }
  }
  return out
}

/** Sum of two {@link CalibrationCounts} with the same edges (pure). */
export function mergeCalibration(a: CalibrationCounts, b: CalibrationCounts): CalibrationCounts {
  if (a.bins.length !== b.bins.length) throw new RangeError('mergeCalibration: different bin edges')
  return {
    bins: a.bins.map((x, i) => {
      const y = b.bins[i]
      return { ...x, samples: x.samples + y.samples, reached: x.reached + y.reached, sumPredictedMin: x.sumPredictedMin + y.sumPredictedMin, nullPredictions: x.nullPredictions + y.nullPredictions }
    }),
  }
}

/** One row of the calibration table. */
export interface CalibrationRow {
  label: string
  fromMin: number
  toMin: number | null
  horizonMin: number
  samples: number
  /** Mean predicted minutes over finite predictions (null when none). */
  meanPredictedMin: number | null
  nullPredictions: number
  /** Share of samples whose ground truth reached the limit within the horizon (null when no samples). */
  observedShare: number | null
}

/** Calibration table from counts (see {@link calibrationCounts} for the definition). */
export function calibrationTable(c: CalibrationCounts): CalibrationRow[] {
  return c.bins.map((b) => {
    const finite = b.samples - b.nullPredictions
    return {
      label: b.latched ? '0 (limit reached in the projection)' : b.toMin === null ? `≥ ${b.fromMin} min or beyond horizon` : b.fromMin === 0 ? `> 0–${b.toMin} min` : `${b.fromMin}–${b.toMin} min`,
      fromMin: b.fromMin,
      toMin: b.toMin,
      horizonMin: b.horizonMin,
      samples: b.samples,
      meanPredictedMin: finite > 0 ? round(b.sumPredictedMin / finite, 1) : null,
      nullPredictions: b.nullPredictions,
      observedShare: b.samples > 0 ? round(b.reached / b.samples, 3) : null,
    }
  })
}

// ─────────────────────────────── Estimates and the bootstrap ───────────────────────────────

/** A point estimate with a 95 % cluster-bootstrap percentile interval. `n` is the denominator (e.g. worker-shifts). */
export interface Estimate {
  /** Null when the denominator is 0. */
  value: number | null
  /** Null with fewer than 2 clusters or no valid replicate. */
  ci95: [number, number] | null
  n: number
}

/** A rate (per 1,000 worker-shifts unless stated) with its raw count and, for a zero count, the rule-of-three bound. */
export interface RateEstimate extends Estimate {
  count: number
  /** One-sided 95 % upper bound when `count` is 0 (3/n, scaled); null otherwise. */
  upper95: number | null
}

/** Aggregation options: the bootstrap seed (each estimate forks it with its own key) and replicate count. */
export interface AggregateOptions {
  seed: string
  replicates?: number
}

function round(x: number, digits: number): number {
  const p = 10 ** digits
  return Math.round(x * p) / p
}

/** Linear-interpolation quantile of a sorted array (type 7). NaN when empty. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  const h = (n - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(h)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

function percentileCi(values: number[], replicates: number): [number, number] | null {
  if (values.length < Math.max(1, replicates / 2)) return null
  values.sort((a, b) => a - b)
  return [quantileSorted(values, 0.025), quantileSorted(values, 0.975)]
}

/**
 * 95 % percentile interval of Σnum/Σden × scale by a cluster bootstrap: the k clusters are resampled with replacement,
 * `replicates` times, with the seeded generator of sim/rng.ts (deterministic). Replicates with Σden = 0 are dropped;
 * null when k < 2 or fewer than half the replicates are valid. Basis: Efron & Tibshirani 1993 (percentile interval);
 * cluster resampling because outcomes within a site-day are correlated (Field & Welsh 2007).
 */
export function bootstrapRatio(num: readonly number[], den: readonly number[], seed: string, replicates: number = METRIC_PARAMS.bootstrapReplicates, scale = 1): [number, number] | null {
  const k = num.length
  if (k < 2 || den.length !== k) return null
  const rng = createRng(seed)
  const out: number[] = []
  for (let r = 0; r < replicates; r++) {
    let sn = 0
    let sd = 0
    for (let i = 0; i < k; i++) {
      const j = rng.int(0, k - 1)
      sn += num[j]
      sd += den[j]
    }
    if (sd > 0) out.push((scale * sn) / sd)
  }
  return percentileCi(out, replicates)
}

/**
 * Paired version of {@link bootstrapRatio}: the same cluster draws for A and B, statistic ΣnumA/ΣdenA − ΣnumB/ΣdenB
 * (× scale). Arrays are aligned by cluster. Basis as {@link bootstrapRatio}; pairing exploits the common random numbers.
 */
export function bootstrapRatioDiff(
  numA: readonly number[],
  denA: readonly number[],
  numB: readonly number[],
  denB: readonly number[],
  seed: string,
  replicates: number = METRIC_PARAMS.bootstrapReplicates,
  scale = 1,
): [number, number] | null {
  const k = numA.length
  if (k < 2 || denA.length !== k || numB.length !== k || denB.length !== k) return null
  const rng = createRng(seed)
  const out: number[] = []
  for (let r = 0; r < replicates; r++) {
    let a = 0
    let da = 0
    let b = 0
    let db = 0
    for (let i = 0; i < k; i++) {
      const j = rng.int(0, k - 1)
      a += numA[j]
      da += denA[j]
      b += numB[j]
      db += denB[j]
    }
    if (da > 0 && db > 0) out.push(scale * (a / da - b / db))
  }
  return percentileCi(out, replicates)
}

/** 95 % percentile interval of a quantile of pooled values, resampling clusters (null when k < 2). */
export function bootstrapQuantile(valuesByCluster: readonly (readonly number[])[], p: number, seed: string, replicates: number = METRIC_PARAMS.bootstrapReplicates): [number, number] | null {
  const k = valuesByCluster.length
  if (k < 2) return null
  const rng = createRng(seed)
  const out: number[] = []
  for (let r = 0; r < replicates; r++) {
    const pool: number[] = []
    for (let i = 0; i < k; i++) for (const v of valuesByCluster[rng.int(0, k - 1)]) pool.push(v)
    if (pool.length === 0) continue
    pool.sort((a, b) => a - b)
    out.push(quantileSorted(pool, p))
  }
  return percentileCi(out, replicates)
}

/** Records grouped by bootstrap cluster, clusters in sorted key order (deterministic). */
export function groupByCluster<T extends { cluster: string }>(records: readonly T[]): T[][] {
  const m = new Map<string, T[]>()
  for (const r of records) {
    let a = m.get(r.cluster)
    if (!a) m.set(r.cluster, (a = []))
    a.push(r)
  }
  return [...m.keys()].sort().map((k) => m.get(k) as T[])
}

type Clusters = readonly (readonly WorkerShiftRecord[])[]

function sums(clusters: Clusters, f: (r: WorkerShiftRecord) => number): number[] {
  return clusters.map((c) => c.reduce((s, r) => s + f(r), 0))
}

const total = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0)

function ratioEstimate(clusters: Clusters, num: (r: WorkerShiftRecord) => number, den: (r: WorkerShiftRecord) => number, key: string, o: AggregateOptions, scale = 1, digits = 3): Estimate {
  const nums = sums(clusters, num)
  const dens = sums(clusters, den)
  const N = total(dens)
  const ci = N > 0 ? bootstrapRatio(nums, dens, `${o.seed}|${key}`, o.replicates ?? METRIC_PARAMS.bootstrapReplicates, scale) : null
  return { value: N > 0 ? round((scale * total(nums)) / N, digits) : null, ci95: ci ? [round(ci[0], digits), round(ci[1], digits)] : null, n: N }
}

function rateEstimate(clusters: Clusters, count: (r: WorkerShiftRecord) => number, key: string, o: AggregateOptions): RateEstimate {
  const e = ratioEstimate(clusters, count, () => 1, key, o, 1000, 1)
  const c = total(sums(clusters, count))
  return { ...e, count: c, upper95: c === 0 && e.n > 0 ? round((1000 * METRIC_PARAMS.ruleOfThree) / e.n, 1) : null }
}

const any = (n: number): number => (n > 0 ? 1 : 0)

// ─────────────────────────────── Rates per 1,000 worker-shifts ───────────────────────────────

/** Per-policy outcome rates (SIMULATION.md §5 first bullet). */
export interface PolicyRates {
  workerShifts: number
  clusters: number
  /** Worker-shifts with ≥ 1 event of the kind, per 1,000 worker-shifts (heat-symptom episodes: episodes, not shifts). */
  per1000: {
    excessive: RateEstimate
    severe: RateEstimate
    critical: RateEstimate
    dehydration: RateEstimate
    /** Heat-symptom episodes (heat exhaustion, cramps, CNS; thirst excluded) per 1,000 worker-shifts. */
    symptomaticEpisodes: RateEstimate
    /** First-aid cases that ended the shift (evacuations) per 1,000 worker-shifts. */
    evacuations: RateEstimate
    /** Worker-shifts that reached EMERGENCY on the engine (engine arms only). */
    engineEmergency: RateEstimate
  }
  /** Ground-truth events of each kind per 1,000 worker-shifts (counts every event, point estimate). */
  eventsPer1000: Record<TruthEventKind, number>
  /** Means per worker-shift. */
  perShift: {
    workMin: Estimate
    restMin: Estimate
    hotWorkMin: Estimate
    waterMl: Estimate
    minutesCoreAbove385: Estimate
  }
}

/**
 * Outcome rates of one policy arm over worker-shift records (SIMULATION.md §5: excessive / severe / critical events,
 * dehydration, symptomatic episodes, emergencies, work minutes delivered, rest minutes, water) with cluster-bootstrap
 * 95 % intervals. Event rates count worker-shifts with ≥ 1 event; zero counts carry the rule-of-three upper bound.
 */
export function policyRates(records: readonly WorkerShiftRecord[], o: AggregateOptions): PolicyRates {
  const cl = groupByCluster(records)
  const n = records.length
  const eventsPer1000 = {} as Record<TruthEventKind, number>
  for (const k of TRUTH_EVENT_KINDS) eventsPer1000[k] = n > 0 ? round((1000 * total(records.map((r) => r.truth[k].count))) / n, 1) : 0
  const mean = (f: (r: WorkerShiftRecord) => number, key: string): Estimate => ratioEstimate(cl, f, () => 1, key, o, 1, 1)
  return {
    workerShifts: n,
    clusters: cl.length,
    per1000: {
      excessive: rateEstimate(cl, (r) => any(r.truth.excessive_strain.count), 'excessive', o),
      severe: rateEstimate(cl, (r) => any(r.truth.severe_strain.count), 'severe', o),
      critical: rateEstimate(cl, (r) => any(r.truth.critical.count), 'critical', o),
      dehydration: rateEstimate(cl, (r) => any(r.truth.dehydration_3pct.count), 'dehydration', o),
      symptomaticEpisodes: rateEstimate(cl, (r) => r.heatSymptomEpisodes, 'symptomatic', o),
      evacuations: rateEstimate(cl, (r) => (r.evacuatedT === null ? 0 : 1), 'evacuations', o),
      engineEmergency: rateEstimate(cl, (r) => (r.engineEmergencyT === null ? 0 : 1), 'engineEmergency', o),
    },
    eventsPer1000,
    perShift: {
      workMin: mean((r) => r.workMin, 'workMin'),
      restMin: mean((r) => r.restMin, 'restMin'),
      hotWorkMin: mean((r) => r.hotWorkMin, 'hotWorkMin'),
      waterMl: mean((r) => r.waterMl, 'waterMl'),
      minutesCoreAbove385: mean((r) => r.minutesCoreAbove385, 'core385'),
    },
  }
}

// ─────────────────────────────── Detection (shadow mode) ───────────────────────────────

/** Distribution of lead times (minutes, positive = warned before the onset). */
export interface LeadTimeSummary {
  n: number
  medianMin: number | null
  p25Min: number | null
  p75Min: number | null
  minMin: number | null
  maxMin: number | null
  /** Cluster-bootstrap 95 % interval of the median. */
  medianCi95: [number, number] | null
  /** Histogram over {@link METRIC_PARAMS}.leadTimeEdgesMin (last bin open). */
  bins: { fromMin: number; toMin: number | null; n: number }[]
}

/** Shadow-mode detection metrics for one target (SIMULATION.md §4; ARCHITECTURE.md §8). */
export interface DetectionSummary {
  target: DetectionTarget
  /** Which alarms count: 'individual' (Alert.basis individual; the headline) or 'all' (every alert covering the worker, metrics 1.0.0). */
  alarmSet: AlarmSet
  minLevel: RiskLevel
  horizonMin: number
  workerShifts: number
  /** Worker-shifts with the target event (onset known). */
  positives: number
  /** Worker-shifts with ≥ 1 alarm. */
  warnedShifts: number
  /** P(first alarm at or before the onset | positive). */
  sensitivityBeforeOnset: Estimate
  /** P(any alarm in the shift | positive). */
  sensitivityInShift: Estimate
  /** P(no alarm | negative). */
  specificity: Estimate
  /** P(positive | ≥ 1 alarm), per worker-shift. */
  ppvShift: Estimate
  alarms: number
  /** Share of alarms with the worker's target onset within ±horizon. */
  ppvAlarm: Estimate
  /** Alarms without the target onset within ±horizon, per worker-shift. */
  falseAlarmsPerShift: Estimate
  /** onset − first alarm, over positives warned at or before the onset. */
  leadTime: LeadTimeSummary
}

/** Which alarms a detection summary counts ({@link DetectionSummary}.alarmSet). */
export type AlarmSet = 'individual' | 'all'

/**
 * Alarm times of a record for a detection summary: individual alarms at ≥ high or ≥ stop, or every alarm
 * (`alarmTimes`, at the record's alarm level). @throws RangeError for individual alarms at another level.
 */
export function recordAlarmTimes(r: WorkerShiftRecord, set: AlarmSet, minLevel: RiskLevel): number[] {
  if (set === 'all') return r.alarmTimes
  if (minLevel === 'high') return r.individualAlarmTimes.high
  if (minLevel === 'stop') return r.individualAlarmTimes.stop
  throw new RangeError(`recordAlarmTimes: individual alarms are recorded at 'high' and 'stop', not '${minLevel}'`)
}

/** The onset of `target` in a record (first ground-truth onset, or the log-derived symptomatic event). */
export function targetOnset(r: WorkerShiftRecord, target: DetectionTarget): number | null {
  return target === 'symptomatic' ? r.symptomaticT : target === 'heat_symptoms' ? r.heatSymptomOnsetT : r.truth[target].onsetT
}

/** Lead-time summary of values grouped by cluster (minutes). */
export function leadTimeSummary(valuesByCluster: readonly (readonly number[])[], seed: string, replicates: number = METRIC_PARAMS.bootstrapReplicates): LeadTimeSummary {
  const all = valuesByCluster.flat().sort((a, b) => a - b)
  const edges = METRIC_PARAMS.leadTimeEdgesMin
  const bins = edges.map((e, i) => ({ fromMin: e, toMin: i + 1 < edges.length ? edges[i + 1] : null, n: 0 }))
  for (const v of all) {
    const b = bins.find((x) => v >= x.fromMin && (x.toMin === null || v < x.toMin))
    if (b) b.n += 1
  }
  const q = (p: number): number | null => (all.length ? round(quantileSorted(all, p), 1) : null)
  const ci = all.length ? bootstrapQuantile(valuesByCluster, 0.5, seed, replicates) : null
  return {
    n: all.length,
    medianMin: q(0.5),
    p25Min: q(0.25),
    p75Min: q(0.75),
    minMin: all.length ? round(all[0], 1) : null,
    maxMin: all.length ? round(all[all.length - 1], 1) : null,
    medianCi95: ci ? [round(ci[0], 1), round(ci[1], 1)] : null,
    bins,
  }
}

/**
 * Detection metrics of the engine's alarms against one target, per worker-shift (meaningful for records in which the
 * engine ran without anybody acting on it — shadow mode — because acting on an alarm changes the outcome):
 * - alarm = by default an INDIVIDUAL alarm at ≥ `minLevel` ('high' or 'stop'; {@link alarmTimesByBasis}) — exposure
 *   advisories describe site conditions and are reported separately; `alarmSet` 'all' counts every distinct alert
 *   covering the worker at the record's alarm level ({@link alarmTimesByWorker}, metrics 1.0.0);
 * - positive = the worker-shift has the target (first onset `targetOnset`);
 * - sensitivity before onset = positives whose first alarm is at or before the onset ÷ positives; in shift = positives
 *   with any alarm ÷ positives; specificity = negatives without alarm ÷ negatives; PPV (shift) = positives among warned
 *   shifts;
 * - an alarm is confirmed when the target onset lies within ±`horizonMin` of it; PPV (alarm) = confirmed ÷ alarms;
 *   false alarms per worker-shift = unconfirmed alarms ÷ worker-shifts;
 * - lead time = onset − first alarm (minutes) over positives warned at or before the onset (SIMULATION.md §4 "alert
 *   time minus event onset", sign chosen so that earlier warnings are positive).
 * All ratios carry a cluster-bootstrap 95 % interval. With target 'symptomatic' every input is log-derived, which is
 * the PILOT.md §5.4 (a) event lead time.
 */
export function detectionSummary(
  records: readonly WorkerShiftRecord[],
  target: DetectionTarget,
  o: AggregateOptions,
  minLevel: RiskLevel = METRIC_PARAMS.alarmMinLevel,
  horizonMin: number = METRIC_PARAMS.confirmHorizonMin,
  alarmSet: AlarmSet = 'individual',
): DetectionSummary {
  const cl = groupByCluster(records)
  const H = horizonMin * MINUTE_MS
  const times = (r: WorkerShiftRecord): number[] => recordAlarmTimes(r, alarmSet, minLevel)
  const onset = (r: WorkerShiftRecord): number | null => targetOnset(r, target)
  const pos = (r: WorkerShiftRecord): number => (onset(r) === null ? 0 : 1)
  const warned = (r: WorkerShiftRecord): number => (times(r).length > 0 ? 1 : 0)
  const early = (r: WorkerShiftRecord): number => {
    const t = onset(r)
    const a = times(r)
    return t !== null && a.length > 0 && a[0] <= t ? 1 : 0
  }
  const confirmed = (r: WorkerShiftRecord): number => {
    const t = onset(r)
    return t === null ? 0 : times(r).filter((a) => t >= a - H && t <= a + H).length
  }
  // Bootstrap keys of the 1.0.0 all-alarm summary are kept, so its numbers are unchanged.
  const key = alarmSet === 'all' ? `${target}|${minLevel}` : `${target}|${minLevel}|${alarmSet}`
  const leads = cl.map((c) =>
    c.flatMap((r) => {
      const t = onset(r)
      const a = times(r)
      return t !== null && a.length > 0 && a[0] <= t ? [(t - a[0]) / MINUTE_MS] : []
    }),
  )
  return {
    target,
    alarmSet,
    minLevel,
    horizonMin,
    workerShifts: records.length,
    positives: total(sums(cl, pos)),
    warnedShifts: total(sums(cl, warned)),
    sensitivityBeforeOnset: ratioEstimate(cl, early, pos, `${key}|sensB`, o),
    sensitivityInShift: ratioEstimate(cl, (r) => pos(r) * warned(r), pos, `${key}|sensS`, o),
    specificity: ratioEstimate(cl, (r) => (1 - pos(r)) * (1 - warned(r)), (r) => 1 - pos(r), `${key}|spec`, o),
    ppvShift: ratioEstimate(cl, (r) => pos(r) * warned(r), warned, `${key}|ppvS`, o),
    alarms: total(sums(cl, (r) => times(r).length)),
    ppvAlarm: ratioEstimate(cl, confirmed, (r) => times(r).length, `${key}|ppvA`, o),
    falseAlarmsPerShift: ratioEstimate(cl, (r) => times(r).length - confirmed(r), () => 1, `${key}|fa`, o),
    leadTime: leadTimeSummary(leads, `${o.seed}|${key}|lead`, o.replicates),
  }
}

// ─────────────────────────────── Challenge measures ───────────────────────────────

/** Acknowledgement summary over runs (from {@link RunAlertSummary}). */
export interface AckSummary {
  alerts: number
  alarms: number
  requiringAck: number
  acknowledged: number
  /** acknowledged ÷ requiringAck (null when none required). */
  acknowledgedShare: number | null
  medianDelayMin: number | null
  p90DelayMin: number | null
  escalatedAlerts: number
  notifications: number
  suppressed: number
  crewBundledWorkerAlerts: number
  workerShifts: number
  crewShifts: number
  exposureAdvisoriesToSupervisor: number
  notificationsByBasisRole: BasisRoleCounts
  byBasis: Record<AlertBasis, BasisCounts>
}

/** Pool {@link RunAlertSummary} values into an {@link AckSummary}. */
export function ackSummary(runs: readonly RunAlertSummary[]): AckSummary {
  const delays = runs.flatMap((r) => r.ackDelaysMin).sort((a, b) => a - b)
  const s = (f: (r: RunAlertSummary) => number): number => runs.reduce((a, r) => a + f(r), 0)
  const req = s((r) => r.requiringAck)
  const ack = s((r) => r.acknowledged)
  return {
    alerts: s((r) => r.alerts),
    alarms: s((r) => r.alarms),
    requiringAck: req,
    acknowledged: ack,
    acknowledgedShare: req > 0 ? round(ack / req, 3) : null,
    medianDelayMin: delays.length ? round(quantileSorted(delays, 0.5), 1) : null,
    p90DelayMin: delays.length ? round(quantileSorted(delays, 0.9), 1) : null,
    escalatedAlerts: s((r) => r.escalatedAlerts),
    notifications: s((r) => r.notifications),
    suppressed: s((r) => r.suppressed),
    crewBundledWorkerAlerts: s((r) => r.crewBundledWorkerAlerts),
    workerShifts: s((r) => r.workerShifts ?? 0),
    crewShifts: s((r) => r.crewShifts ?? 0),
    exposureAdvisoriesToSupervisor: s((r) => r.exposureAdvisoriesToSupervisor ?? 0),
    notificationsByBasisRole: poolBasisRole(runs.map((r) => r.notificationsByBasisRole)),
    byBasis: Object.fromEntries(
      ALERT_BASES.map((b) => [
        b,
        runs.reduce((acc, r) => {
          const x = r.byBasis?.[b]
          return x ? { alerts: acc.alerts + x.alerts, notifications: acc.notifications + x.notifications, notificationsRequiringAck: acc.notificationsRequiringAck + x.notificationsRequiringAck, unacknowledged: acc.unacknowledged + x.unacknowledged } : acc
        }, emptyBasisCounts()),
      ]),
    ) as Record<AlertBasis, BasisCounts>,
  }
}

/** Sum {@link BasisRoleCounts} (roles in first-seen order). */
function poolBasisRole(xs: readonly (BasisRoleCounts | undefined)[]): BasisRoleCounts {
  const out: BasisRoleCounts = { individual: {}, exposure: {} }
  for (const x of xs) {
    if (!x) continue
    for (const b of ALERT_BASES) {
      for (const [role, c] of Object.entries(x[b] ?? {}) as [Role, { sent: number; requiringAck: number }][]) {
        const cell = out[b][role] ?? (out[b][role] = { sent: 0, requiringAck: 0 })
        cell.sent += c.sent
        cell.requiringAck += c.requiringAck
      }
    }
  }
  return out
}

/** The challenge's safety and productivity measures for one arm (SIMULATION.md §5 second bullet; PILOT.md §5.4). */
export interface ChallengeMeasures {
  workerShifts: number
  /** PILOT.md §5.4 (a): first alarm ≥ high → onset of a later symptomatic event (T2+ check-in or first-aid case). */
  eventLeadTime: LeadTimeSummary
  /**
   * PILOT.md §5.4 (a) with every alarm (worker, crew or site alert at ≥ high covering the worker), metrics 1.0.0;
   * `eventLeadTime` is the headline (individual alarms).
   */
  eventLeadTimeAllAlarms: LeadTimeSummary
  /** Alarm burden: distinct alarms covering the worker (any basis, crew alerts included), per worker-shift (metrics 1.0.0). */
  alarmsPerShift: Estimate
  /** Individual alarms (Alert.basis individual) at ≥ high and ≥ stop, per worker-shift: the headline alarm burden. */
  individualAlarmsPerShift: { high: Estimate; stop: Estimate }
  /** Exposure advisories (site/crew conditions) on the worker's device at ≥ high, per worker-shift. */
  exposureAdvisoriesPerWorkerShift: Estimate
  /** Exposure advisories that reached the crew's supervisor at ≥ high, per crew-shift (null without crews). */
  exposureAdvisoriesPerCrewShift: number | null
  /**
   * Alert burden: notifications per worker-shift by basis and recipient role — sent and requiring an acknowledgement
   * (plus the totals over both bases).
   */
  burdenPerWorkerShift: Record<AlertBasis | 'total', Partial<Record<Role, { sent: number; requiringAck: number }>>>
  /** Instructions followed ÷ instructions shown (worker adherence). */
  adherence: Estimate
  /** Prompted check-ins answered ÷ prompted. */
  checkinResponse: Estimate
  ack: AckSummary
  /** Heat-symptom check-ins (triage tier ≥ 1) per 1,000 worker-shifts. */
  symptomReportsPer1000: RateEstimate
  /** Worker-shifts with a symptomatic event (T2+ check-in or first-aid case) per 1,000. */
  symptomaticShiftsPer1000: RateEstimate
  /** Alerts escalated by an acknowledgement timer, per 1,000 worker-shifts. */
  escalationsPer1000: RateEstimate
  midday: {
    /** Sun-work minutes inside the midday-break window, summed (target 0). */
    violationMin: number
    shiftsWithViolation: number
    /** Worker-shifts without any violation ÷ worker-shifts. */
    compliantShare: Estimate
  }
  zone: {
    workerHours: number
    /** Compliant worker-hours ÷ checked worker-hours ({@link ZoneCheck}). */
    compliantShare: Estimate
    excessMin: number
    unacclimatizedHours: number
  }
  /** Prescribed/protective rest minutes per worker-shift (reported as a productivity cost, PILOT.md §5.4). */
  restMinPerShift: Estimate
  /** Shift minutes lost after first-aid evacuations, per 1,000 scheduled worker-hours (PILOT.md §5.4 "lost work time"). */
  heatIllnessLostMinPer1000WorkerHours: number | null
}

/**
 * Challenge measures of one arm from its records and run alert summaries (definitions on {@link ChallengeMeasures}).
 * The event lead time uses individual alarms at ≥ high (headline); `eventLeadTimeAllAlarms` keeps the all-alarm one.
 */
export function challengeMeasures(records: readonly WorkerShiftRecord[], runs: readonly RunAlertSummary[], o: AggregateOptions): ChallengeMeasures {
  const cl = groupByCluster(records)
  const leadsOf = (times: (r: WorkerShiftRecord) => readonly number[]): number[][] =>
    cl.map((c) =>
      c.flatMap((r) => {
        const a = times(r)
        return r.symptomaticT !== null && a.length > 0 && a[0] <= r.symptomaticT ? [(r.symptomaticT - a[0]) / MINUTE_MS] : []
      }),
    )
  const shiftHours = total(records.map((r) => r.shiftMin)) / 60
  const ack = ackSummary(runs)
  const n = records.length
  const burden: ChallengeMeasures['burdenPerWorkerShift'] = { individual: {}, exposure: {}, total: {} }
  for (const b of ALERT_BASES) {
    for (const [role, c] of Object.entries(ack.notificationsByBasisRole[b]) as [Role, { sent: number; requiringAck: number }][]) {
      burden[b][role] = { sent: n > 0 ? round(c.sent / n, 3) : 0, requiringAck: n > 0 ? round(c.requiringAck / n, 3) : 0 }
      const t = burden.total[role] ?? (burden.total[role] = { sent: 0, requiringAck: 0 })
      t.sent = round(t.sent + (n > 0 ? c.sent / n : 0), 3)
      t.requiringAck = round(t.requiringAck + (n > 0 ? c.requiringAck / n : 0), 3)
    }
  }
  return {
    workerShifts: n,
    eventLeadTime: leadTimeSummary(leadsOf((r) => r.individualAlarmTimes.high), `${o.seed}|eventLead|individual`, o.replicates),
    eventLeadTimeAllAlarms: leadTimeSummary(leadsOf((r) => r.alarmTimes), `${o.seed}|eventLead`, o.replicates),
    alarmsPerShift: ratioEstimate(cl, (r) => r.alarmTimes.length, () => 1, 'alarms', o, 1, 2),
    individualAlarmsPerShift: {
      high: ratioEstimate(cl, (r) => r.individualAlarmTimes.high.length, () => 1, 'alarms|individual|high', o, 1, 2),
      stop: ratioEstimate(cl, (r) => r.individualAlarmTimes.stop.length, () => 1, 'alarms|individual|stop', o, 1, 2),
    },
    exposureAdvisoriesPerWorkerShift: ratioEstimate(cl, (r) => r.exposureAdvisories, () => 1, 'advisories|worker', o, 1, 2),
    exposureAdvisoriesPerCrewShift: ack.crewShifts > 0 ? round(ack.exposureAdvisoriesToSupervisor / ack.crewShifts, 2) : null,
    burdenPerWorkerShift: burden,
    adherence: ratioEstimate(cl, (r) => r.followed, (r) => r.instructions, 'adherence', o),
    checkinResponse: ratioEstimate(cl, (r) => r.checkinsAnswered, (r) => r.checkinsPrompted, 'checkinResponse', o),
    ack,
    symptomReportsPer1000: rateEstimate(cl, (r) => r.symptomReports, 'symptomReports', o),
    symptomaticShiftsPer1000: rateEstimate(cl, (r) => (r.symptomaticT === null ? 0 : 1), 'symptomaticShifts', o),
    escalationsPer1000: rateEstimate(cl, (r) => r.escalations, 'escalations', o),
    midday: {
      violationMin: total(records.map((r) => r.middayViolationMin)),
      shiftsWithViolation: records.filter((r) => r.middayViolationMin > 0).length,
      compliantShare: ratioEstimate(cl, (r) => (r.middayViolationMin > 0 ? 0 : 1), () => 1, 'midday', o),
    },
    zone: {
      workerHours: total(records.map((r) => r.zone.workerHours)),
      compliantShare: ratioEstimate(cl, (r) => r.zone.compliantHours, (r) => r.zone.workerHours, 'zone', o),
      excessMin: round(total(records.map((r) => r.zone.excessMin)), 1),
      unacclimatizedHours: total(records.map((r) => r.zone.unacclimatizedHours)),
    },
    restMinPerShift: ratioEstimate(cl, (r) => r.restMin, () => 1, 'restMin', o, 1, 1),
    heatIllnessLostMinPer1000WorkerHours: shiftHours > 0 ? round((1000 * total(records.map((r) => r.lostMin))) / shiftHours, 1) : null,
  }
}

// ─────────────────────────────── Paired comparison ───────────────────────────────

/** Differences A − B over worker-shifts present in both arms (same cluster and worker), with paired intervals. */
export interface PairedComparison {
  pairedWorkerShifts: number
  clusters: number
  /** Per 1,000 worker-shifts (shifts with ≥ 1 event). */
  excessivePer1000: Estimate
  severePer1000: Estimate
  criticalPer1000: Estimate
  dehydrationPer1000: Estimate
  symptomaticEpisodesPer1000: Estimate
  /** Work minutes per worker-shift, A − B (negative = work lost under A). */
  workMinPerShift: Estimate
  /** ΣworkA ÷ ΣworkB − 1 (lost work time relative to B when negative). */
  workRelative: Estimate
  restMinPerShift: Estimate
  waterMlPerShift: Estimate
}

/**
 * Paired comparison of arm A against arm B (typically a Zill arm against `ban_only` on the same site-days: "lost work
 * time vs ban_only", SIMULATION.md §5). Only worker-shifts present in both arms are used; the cluster bootstrap draws
 * the same site-days for both arms, which exploits the common random numbers of the world simulation.
 */
export function pairedComparison(a: readonly WorkerShiftRecord[], b: readonly WorkerShiftRecord[], o: AggregateOptions): PairedComparison {
  const keyOf = (r: WorkerShiftRecord): string => `${r.cluster}|${r.workerId}`
  const bBy = new Map(b.map((r) => [keyOf(r), r]))
  const pairs = a.filter((r) => bBy.has(keyOf(r))).map((r) => ({ cluster: r.cluster, a: r, b: bBy.get(keyOf(r)) as WorkerShiftRecord }))
  const cl = groupByCluster(pairs)
  const reps = o.replicates ?? METRIC_PARAMS.bootstrapReplicates
  const diff = (f: (r: WorkerShiftRecord) => number, key: string, scale: number, digits: number): Estimate => {
    const na = cl.map((c) => c.reduce((s, p) => s + f(p.a), 0))
    const nb = cl.map((c) => c.reduce((s, p) => s + f(p.b), 0))
    const d = cl.map((c) => c.length)
    const N = total(d)
    const ci = N > 0 ? bootstrapRatioDiff(na, d, nb, d, `${o.seed}|pair|${key}`, reps, scale) : null
    return { value: N > 0 ? round((scale * (total(na) - total(nb))) / N, digits) : null, ci95: ci ? [round(ci[0], digits), round(ci[1], digits)] : null, n: N }
  }
  const wa = cl.map((c) => c.reduce((s, p) => s + p.a.workMin, 0))
  const wb = cl.map((c) => c.reduce((s, p) => s + p.b.workMin, 0))
  const ratioCi = total(wb) > 0 ? bootstrapRatio(wa, wb, `${o.seed}|pair|workRel`, reps) : null
  const relCi: [number, number] | null = ratioCi ? [ratioCi[0] - 1, ratioCi[1] - 1] : null
  return {
    pairedWorkerShifts: pairs.length,
    clusters: cl.length,
    excessivePer1000: diff((r) => any(r.truth.excessive_strain.count), 'excessive', 1000, 1),
    severePer1000: diff((r) => any(r.truth.severe_strain.count), 'severe', 1000, 1),
    criticalPer1000: diff((r) => any(r.truth.critical.count), 'critical', 1000, 1),
    dehydrationPer1000: diff((r) => any(r.truth.dehydration_3pct.count), 'dehydration', 1000, 1),
    symptomaticEpisodesPer1000: diff((r) => r.heatSymptomEpisodes, 'symptomatic', 1000, 1),
    workMinPerShift: diff((r) => r.workMin, 'work', 1, 1),
    workRelative: {
      value: total(wb) > 0 ? round(total(wa) / total(wb) - 1, 3) : null,
      ci95: relCi ? [round(relCi[0], 3), round(relCi[1], 3)] : null,
      n: pairs.length,
    },
    restMinPerShift: diff((r) => r.restMin, 'rest', 1, 1),
    waterMlPerShift: diff((r) => r.waterMl, 'water', 1, 0),
  }
}

// ─────────────────────────────── Fairness ───────────────────────────────

/** One subgroup cell of the fairness breakdown (point estimates; `workerShifts` is the cell size). */
export interface FairnessCell {
  dimension: keyof WorkerSubgroup
  value: string
  workerShifts: number
  excessivePer1000: number | null
  severePer1000: number | null
  dehydrationPer1000: number | null
  symptomaticEpisodesPer1000: number | null
  workMinPerShift: number | null
  restMinPerShift: number | null
  /** Followed ÷ shown instructions (null without instructions). */
  adherence: number | null
  alarmsPerShift: number | null
  /** Individual alarms at ≥ high per worker-shift (engine arms; null otherwise). */
  individualAlarmsPerShift: number | null
  /** Shadow/engine arms: positives for excessive strain and the share warned by an individual alarm (≥ high) at or before the onset. */
  positivesExcessive: number
  sensitivityExcessive: number | null
}

/**
 * Every metric broken down by acclimatisation, age band, clothing/PPE, body size, language and wearable
 * (SIMULATION.md §5 "Fairness"; PILOT.md §5.4 "Reach and equity"). Point estimates with the cell size; cells are
 * sorted by dimension then value. Small cells are reported, not suppressed (synthetic workers), and must be read
 * with their `workerShifts`.
 */
export function fairnessBreakdown(records: readonly WorkerShiftRecord[], dims: readonly (keyof WorkerSubgroup)[] = FAIRNESS_DIMENSIONS): FairnessCell[] {
  const out: FairnessCell[] = []
  for (const dim of dims) {
    const groups = new Map<string, WorkerShiftRecord[]>()
    for (const r of records) {
      const v = String(r.subgroup[dim])
      let g = groups.get(v)
      if (!g) groups.set(v, (g = []))
      g.push(r)
    }
    for (const v of [...groups.keys()].sort()) {
      const g = groups.get(v) as WorkerShiftRecord[]
      const n = g.length
      const per1000 = (f: (r: WorkerShiftRecord) => number): number | null => (n > 0 ? round((1000 * total(g.map(f))) / n, 1) : null)
      const mean = (f: (r: WorkerShiftRecord) => number, d = 1): number | null => (n > 0 ? round(total(g.map(f)) / n, d) : null)
      const instr = total(g.map((r) => r.instructions))
      const posEx = g.filter((r) => r.truth.excessive_strain.onsetT !== null)
      const warnedEx = posEx.filter((r) => r.individualAlarmTimes.high.length > 0 && r.individualAlarmTimes.high[0] <= (r.truth.excessive_strain.onsetT as number)).length
      const engine = g.some((r) => r.engineRan)
      out.push({
        dimension: dim,
        value: v,
        workerShifts: n,
        excessivePer1000: per1000((r) => any(r.truth.excessive_strain.count)),
        severePer1000: per1000((r) => any(r.truth.severe_strain.count)),
        dehydrationPer1000: per1000((r) => any(r.truth.dehydration_3pct.count)),
        symptomaticEpisodesPer1000: per1000((r) => r.heatSymptomEpisodes),
        workMinPerShift: mean((r) => r.workMin),
        restMinPerShift: mean((r) => r.restMin),
        adherence: instr > 0 ? round(total(g.map((r) => r.followed)) / instr, 3) : null,
        alarmsPerShift: engine ? mean((r) => r.alarmTimes.length, 2) : null,
        individualAlarmsPerShift: engine ? mean((r) => r.individualAlarmTimes.high.length, 2) : null,
        positivesExcessive: posEx.length,
        sensitivityExcessive: engine && posEx.length > 0 ? round(warnedEx / posEx.length, 3) : null,
      })
    }
  }
  return out
}

// ─────────────────────────────── Convenience ───────────────────────────────

/**
 * Records of many site-days (each with its own options, e.g. its crews). Convenience over {@link workerShiftRecords}.
 */
export function recordsFromResults(results: readonly SiteDayResult[], opts: RecordOptions | ((r: SiteDayResult) => RecordOptions) = {}): WorkerShiftRecord[] {
  return results.flatMap((r) => workerShiftRecords(r, typeof opts === 'function' ? opts(r) : opts))
}

/** True when `x` (recursively) contains no NaN or ±Infinity number — the JSON outputs are checked with it. */
export function allFinite(x: unknown): boolean {
  if (typeof x === 'number') return Number.isFinite(x)
  if (Array.isArray(x)) return x.every(allFinite)
  if (x && typeof x === 'object') return Object.values(x as Record<string, unknown>).every(allFinite)
  return true
}
