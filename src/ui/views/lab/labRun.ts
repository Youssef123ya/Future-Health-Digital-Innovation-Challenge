/**
 * Pure helpers behind one lab experiment run (used by labWorker.ts, tested in labModel.test.ts): spec → SimConfig and
 * script, SiteDayResult → compact summary, per-worker rows, event log and column-packed traces.
 *
 * Evidence class: SIMULATED COHORT (docs/SIMULATION.md). The outputs carry ground truth (core temperature, true heart
 * rate, dehydration): Lab view only.
 */
import { RISK_ORDER, type Crew, type RiskLevel, type WorkerProfile } from '../../../engine/types'
import { MINUTE_MS, epochFromLocal } from '../../../engine/time'
import { actionText } from '../../../i18n'
import { runAlertSummary, workerShiftRecords } from '../../../sim/metrics'
import { SCENARIO_SHIFT, getScenario, scenarioConfig, scenarioRoster, type Scenario, type ScenarioId } from '../../../sim/scenarios'
import type { PolicyId, ScriptedEvent, SimConfig, SimEvent, SiteDayResult, TruthEventKind, WorkerMinute } from '../../../sim/types'
import { DEFAULT_SIM_BEHAVIOUR, makeSimConfig, type SimConfigInput } from '../../../sim/worldsim'
import type { SiteId } from '../../../data/sites'
import type {
  ExperimentSpec,
  LabBehaviour,
  LabDisruptions,
  LabEventMarker,
  LabRunWorker,
  PackedTraces,
  PolicyRunResult,
  PolicySummary,
  TimeWindow,
} from './labTypes'

/** Location codes of {@link PackedTraces.location}. */
export const LOCATION_CODES = { sun: 0, shade: 1, indoor_cool: 2 } as const

/** Missing value of the Uint8 code channels. */
export const NO_CODE = 255

const sameWindow = (a: TimeWindow | null, b: TimeWindow | null): boolean =>
  a === null || b === null ? a === b : a.from === b.from && a.to === b.to

/** Default behaviour assumptions (sim/worldsim.ts DEFAULT_SIM_BEHAVIOUR; every value an [ASSUMPTION]). */
export const DEFAULT_LAB_BEHAVIOUR: Readonly<LabBehaviour> = Object.freeze({
  compliance: DEFAULT_SIM_BEHAVIOUR.compliance,
  selfReportScale: DEFAULT_SIM_BEHAVIOUR.selfReportScale,
  respondScale: DEFAULT_SIM_BEHAVIOUR.respondScale,
})

/** No disruption (sim/worldsim.ts DEFAULT_SIM_DISRUPTIONS). */
export const NO_DISRUPTIONS: Readonly<LabDisruptions> = Object.freeze({ wearableDropout: 0, ppgNoiseMultiplier: 1, envSensorFailure: null, networkOutage: null })

/** The scenario's own seed, behaviour and disruptions: the form's starting values (sim/scenarios.ts SCENARIOS). */
export function scenarioDefaults(id: ScenarioId): { seed: string; behaviour: LabBehaviour; disruptions: LabDisruptions } {
  const s = getScenario(id)
  const d = s.config.disruptions ?? {}
  const b = s.config.behaviour ?? {}
  return {
    seed: s.config.seed ?? 'zill-sim',
    behaviour: {
      compliance: b.compliance ?? DEFAULT_LAB_BEHAVIOUR.compliance,
      selfReportScale: b.selfReportScale ?? DEFAULT_LAB_BEHAVIOUR.selfReportScale,
      respondScale: b.respondScale ?? DEFAULT_LAB_BEHAVIOUR.respondScale,
    },
    disruptions: {
      wearableDropout: d.wearableDropout ?? 0,
      ppgNoiseMultiplier: d.ppgNoiseMultiplier ?? 1,
      envSensorFailure: d.envSensorFailure ? { ...d.envSensorFailure } : null,
      networkOutage: d.networkOutage ? { ...d.networkOutage } : null,
    },
  }
}

/** Seed of a site-day (deterministic, shown in the lab). */
export function siteDaySeed(siteId: SiteId, date: string): string {
  return `zill-lab-${siteId}-${date}`
}

/**
 * Roster of a site-day: the Musaffah demo crew plus one generated crew at Musaffah (as the peak-day scenario), two
 * generated crews elsewhere (as saadiyat-peak / shade-only). Basis: sim/scenarios.ts scenarioRoster.
 */
export function siteDayRoster(siteId: SiteId): { crews: Crew[]; workers: WorkerProfile[] } {
  return siteId === 'musaffah' ? scenarioRoster('musaffah', 1, true) : scenarioRoster(siteId, 2, false)
}

/**
 * The scenario's scripted events for a run. Scripted sensor/network failures duplicate the scenario's configured
 * disruption windows, so they are kept only while the form leaves that window unchanged; the person-made events (a
 * buddy's report) always stay.
 */
export function scenarioScript(s: Scenario, disruptions: LabDisruptions): ScriptedEvent[] {
  const def = scenarioDefaults(s.id).disruptions
  const keepSensor = sameWindow(def.envSensorFailure, disruptions.envSensorFailure)
  const keepNetwork = sameWindow(def.networkOutage, disruptions.networkOutage)
  return s.events.filter((e) => {
    if (e.injection.kind !== 'system') return true
    const what = e.injection.what
    return what === 'sensor_fail' || what === 'sensor_ok' ? keepSensor : keepNetwork
  })
}

/** Config overrides of one policy run (trace 'full' for the per-worker charts). */
export function runOverrides(spec: ExperimentSpec, policy: PolicyId): Partial<SimConfigInput> {
  return {
    policy,
    seed: spec.seed,
    shadow: false,
    trace: 'full',
    behaviour: { compliance: spec.behaviour.compliance, selfReportScale: spec.behaviour.selfReportScale, respondScale: spec.behaviour.respondScale },
    disruptions: {
      wearableDropout: spec.disruptions.wearableDropout,
      ppgNoiseMultiplier: spec.disruptions.ppgNoiseMultiplier,
      envSensorFailure: spec.disruptions.envSensorFailure ? { ...spec.disruptions.envSensorFailure } : undefined,
      networkOutage: spec.disruptions.networkOutage ? { ...spec.disruptions.networkOutage } : undefined,
    },
  }
}

/** SimConfig and scripted events of one policy run. */
export function runSetup(spec: ExperimentSpec, policy: PolicyId): { config: SimConfig; script: ScriptedEvent[] } {
  const overrides = runOverrides(spec, policy)
  if (spec.source.kind === 'scenario') {
    const s = getScenario(spec.source.scenarioId)
    return { config: scenarioConfig(s.id, overrides), script: scenarioScript(s, spec.disruptions) }
  }
  const { siteId, date } = spec.source
  const roster = siteDayRoster(siteId)
  const config = makeSimConfig({ ...overrides, siteId, date, shift: { ...SCENARIO_SHIFT }, crews: roster.crews, workers: roster.workers })
  return { config, script: [] }
}

/** Validation message for a disruption window inside the shift, or null when valid (or absent). */
export function windowError(w: TimeWindow | null, shift: { start: string; end: string } = SCENARIO_SHIFT): string | null {
  if (!w) return null
  const re = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!re.test(w.from) || !re.test(w.to)) return 'Use HH:mm times.'
  if (w.from >= w.to) return 'The window must end after it starts.'
  if (w.from < shift.start || w.to > shift.end) return `Keep the window inside the shift (${shift.start}–${shift.end}).`
  return null
}

const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0)

/**
 * Outcome summary of one run: ground-truth harms, work/rest/water delivered, alert burden and adherence. Basis:
 * sim/metrics.ts workerShiftRecords (truth counts, heat-symptom episodes, evacuations) and runAlertSummary (alerts).
 */
export function summariseRun(result: SiteDayResult, crews?: readonly Crew[]): PolicySummary {
  const recs = workerShiftRecords(result, crews ? { crews } : {})
  const al = runAlertSummary(result, undefined, crews ? { crews } : {})
  const harm = (k: TruthEventKind) => ({ events: sum(recs, (r) => r.truth[k].count), workers: recs.filter((r) => r.truth[k].count > 0).length })
  return {
    workers: recs.length,
    shiftMin: sum(recs, (r) => r.shiftMin),
    excessive: harm('excessive_strain'),
    severe: harm('severe_strain'),
    critical: harm('critical'),
    dehydration: harm('dehydration_3pct'),
    heatSymptomEpisodes: sum(recs, (r) => r.heatSymptomEpisodes),
    evacuations: recs.filter((r) => r.evacuatedT !== null).length,
    peakCoreC: recs.length ? Math.max(...recs.map((r) => r.maxCoreC)) : Number.NaN,
    peakDehydrationPct: recs.length ? Math.max(...recs.map((r) => r.maxDehydrationPct)) : Number.NaN,
    minutesCoreAbove385: sum(recs, (r) => r.minutesCoreAbove385),
    workMin: sum(recs, (r) => r.workMin),
    hotWorkMin: sum(recs, (r) => r.hotWorkMin),
    restMin: sum(recs, (r) => r.restMin),
    idleMin: sum(result.outcomes, (o) => o.idleMin),
    waterMl: sum(recs, (r) => r.waterMl),
    alerts: {
      raised: al.alerts,
      alarms: al.alarms,
      notifications: al.notifications,
      suppressed: al.designedSuppression.alerts,
      exposureToSupervisor: al.exposureAdvisoriesToSupervisor,
    },
    adherence: { instructions: sum(recs, (r) => r.instructions), followed: sum(recs, (r) => r.followed) },
    middayViolationMin: sum(recs, (r) => r.middayViolationMin),
  }
}

/** Per-worker rows of a run, in roster order. */
export function runWorkers(result: SiteDayResult, profiles: readonly WorkerProfile[]): LabRunWorker[] {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  return result.outcomes.map((o) => {
    const p = byId.get(o.workerId)
    return {
      id: o.workerId,
      name: p?.displayName ?? o.workerId,
      crewId: p?.crewId ?? '',
      acclimatization: o.subgroup.acclimatization,
      ageBand: o.subgroup.ageBand,
      clothing: o.subgroup.clothing,
      wearable: o.subgroup.wearable,
      workMin: o.workMin,
      restMin: o.restMin,
      waterMl: o.waterMl,
      maxCoreC: o.maxCoreC,
      maxDehydrationPct: o.maxDehydrationPct,
      events: {
        excessive_strain: o.events.excessive_strain.count,
        severe_strain: o.events.severe_strain.count,
        critical: o.events.critical.count,
        dehydration_3pct: o.events.dehydration_3pct.count,
        symptom_onset: o.events.symptom_onset.count,
      },
      minutesByLevel: { ...o.engine.minutesByLevel },
      firstHighT: o.engine.firstHighT,
      firstStopT: o.engine.firstStopT,
    }
  })
}

const CLUSTER_LABEL: Readonly<Record<string, string>> = {
  heat_exhaustion: 'heat-exhaustion signs',
  cramps: 'cramps',
  cns: 'CNS signs',
  thirst: 'thirst',
}

/** Level names as the consoles print them (components/levels.ts DEFAULT_LEVEL_LABELS; kept here so the worker bundle stays UI-free). */
export const LEVEL_TEXT: Readonly<Record<RiskLevel, string>> = { safe: 'Safe', caution: 'Caution', high: 'High risk', stop: 'Stop work', emergency: 'Emergency' }

const ROLE_LABEL: Readonly<Record<string, string>> = {
  self: 'the worker',
  worker: 'the worker',
  buddy: 'a buddy',
  supervisor: 'the supervisor',
  first_aider: 'the first aider',
  occ_health: 'occupational health',
}

/** "weakness_fatigue" → "weakness fatigue". */
export function idText(id: string): string {
  return id.replace(/_/g, ' ')
}

/** Label of a ground-truth event (SIMULATION.md §2.4 definitions). */
export function truthEventLabel(e: Extract<SimEvent, { kind: 'truth' }>): string {
  switch (e.event) {
    case 'excessive_strain':
      return 'Excessive heat strain began (core ≥ 38.5 °C, 38.0 °C if unacclimatised, for 10 min)'
    case 'severe_strain':
      return 'Severe strain: core reached 39.5 °C'
    case 'critical':
      return 'Critical: core reached 40.0 °C or CNS signs'
    case 'dehydration_3pct':
      return 'Dehydration: body-mass loss passed 3 %'
    case 'symptom_onset': {
      const cluster = e.cluster ?? (e.detail?.split(':')[0] ?? '').trim()
      const symptoms = e.detail?.includes(':') ? e.detail.slice(e.detail.indexOf(':') + 1).trim() : ''
      return `Symptom onset: ${CLUSTER_LABEL[cluster] ?? idText(cluster || 'symptoms')}${symptoms ? ` (${symptoms.replace(/_/g, ' ')})` : ''}`
    }
  }
}

/**
 * Per-worker event log: ground-truth events (at their onset), displayed-level changes, instructions and whether they
 * were followed, check-ins, resolutions and early shift ends. Sorted by time.
 */
export function workerEventMarkers(events: readonly SimEvent[], shiftEndT: number): LabEventMarker[] {
  const out: LabEventMarker[] = []
  for (const e of events) {
    switch (e.kind) {
      case 'truth':
        out.push({ t: e.onsetT ?? e.t, workerId: e.workerId, source: 'truth', truth: e.event, label: truthEventLabel(e) })
        break
      case 'level':
        out.push({ t: e.t, workerId: e.workerId, source: 'engine', label: `Displayed level ${LEVEL_TEXT[e.from]} → ${LEVEL_TEXT[e.to]}${e.channel ? ` (${idText(e.channel)} channel)` : ''}` })
        break
      case 'instruction':
        out.push({ t: e.t, workerId: e.workerId, source: 'worker', label: `${actionText('en', e.action)}: ${e.followed ? 'followed' : 'not followed'}` })
        break
      case 'checkin': {
        const c = e.checkin
        const who = c.by === 'self' ? (e.prompted ? 'Prompted check-in answered' : 'Self-report') : `Check-in by ${ROLE_LABEL[c.by] ?? idText(c.by)}`
        out.push({ t: e.t, workerId: c.workerId, source: 'worker', label: `${who}: ${c.symptoms.length ? c.symptoms.map(idText).join(', ') : 'no symptoms'}` })
        break
      }
      case 'resolution':
        out.push({ t: e.t, workerId: e.workerId, source: 'response', label: `Case resolved by ${ROLE_LABEL[e.by] ?? idText(e.by)}` })
        break
      case 'shift':
        if (e.what === 'end' && e.t < shiftEndT - MINUTE_MS) out.push({ t: e.t, workerId: e.workerId, source: 'response', label: 'Shift ended early (first-aid case)' })
        break
      default:
        break
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Column-packs the per-minute trace (worker-major). Missing rows stay NaN / {@link NO_CODE}. */
export function packTraces(minutes: readonly WorkerMinute[], workerIds: readonly string[], t0: number, nMinutes: number): PackedTraces {
  const n = workerIds.length * nMinutes
  const f = () => new Float32Array(n).fill(Number.NaN)
  const u = () => new Uint8Array(n).fill(NO_CODE)
  const p: PackedTraces = {
    t0,
    nMinutes,
    workerIds: [...workerIds],
    coreTrueC: f(),
    ectempC: f(),
    hrTrueBpm: f(),
    hrMeasuredBpm: f(),
    dehydrationPct: f(),
    wbgtEffC: f(),
    level: u(),
    working: u(),
    location: u(),
  }
  const index = new Map(workerIds.map((id, i) => [id, i]))
  for (const m of minutes) {
    const w = index.get(m.workerId)
    if (w === undefined) continue
    const k = Math.round((m.t - t0) / MINUTE_MS)
    if (k < 0 || k >= nMinutes) continue
    const i = w * nMinutes + k
    p.coreTrueC[i] = m.coreTrueC
    p.ectempC[i] = m.ectempC ?? Number.NaN
    p.hrTrueBpm[i] = m.hrTrueBpm
    p.hrMeasuredBpm[i] = m.hrMeasuredBpm ?? Number.NaN
    p.dehydrationPct[i] = m.dehydrationPct
    p.wbgtEffC[i] = m.wbgtEffC
    p.level[i] = RISK_ORDER[m.level]
    p.working[i] = m.working ? 1 : 0
    p.location[i] = LOCATION_CODES[m.location]
  }
  return p
}

/** Buffers to transfer with a packed trace (zero-copy postMessage). */
export function traceBuffers(p: PackedTraces): ArrayBuffer[] {
  return [p.coreTrueC, p.ectempC, p.hrTrueBpm, p.hrMeasuredBpm, p.dehydrationPct, p.wbgtEffC, p.level, p.working, p.location].map((a) => a.buffer as ArrayBuffer)
}

/** Everything the lab keeps from one finished run. */
export function buildPolicyRunResult(
  result: SiteDayResult,
  profiles: readonly WorkerProfile[],
  crews: readonly Crew[],
  runMs: number,
  weatherProvenance: readonly string[] = [],
): PolicyRunResult {
  const cfg = result.config
  const t0 = epochFromLocal(`${cfg.date}T${cfg.shift.start}`)
  const tEnd = epochFromLocal(`${cfg.date}T${cfg.shift.end}`)
  const nMinutes = Math.max(0, Math.round((tEnd - t0) / MINUTE_MS))
  const workers = runWorkers(result, profiles)
  return {
    policy: cfg.policy,
    seed: cfg.seed,
    stamp: result.stamp,
    runMs,
    siteId: cfg.siteId,
    date: cfg.date,
    shift: { ...cfg.shift },
    weatherProvenance: [...weatherProvenance],
    summary: summariseRun(result, crews),
    workers,
    events: workerEventMarkers(result.events, tEnd),
    hours: result.hours.map((h) => ({ ...h })),
    traces: packTraces(result.minutes ?? [], workers.map((w) => w.id), t0, nMinutes),
  }
}
