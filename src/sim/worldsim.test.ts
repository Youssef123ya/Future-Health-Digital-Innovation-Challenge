import { beforeAll, describe, expect, it } from 'vitest'
import { buildDemoCrew } from '../data/workforce'
import { MINUTE_MS, epochFromLocal } from '../engine/time'
import { isMiddayBreak } from '../engine/regulation'
import { RISK_LEVELS, RISK_ORDER, type ConsentState, type Crew, type RiskAssessment, type WorkerProfile } from '../engine/types'
import { createNodeSimDataLoader, daySamples, minuteWeather, siteRoster, PERFECT_FORECAST_NOTE } from './simdata'
import {
  DEFAULT_SIM_BEHAVIOUR,
  WORLD_PARAMS,
  createWorld,
  deviceCycleWorkMin,
  drinkReminderShown,
  finishWorld,
  idleMinutes,
  loggedDrinkMl,
  makeSimConfig,
  planWindowWorkMin,
  runSiteDay,
  shiftMinutes,
  stepWorld,
  taskWindowMs,
  worldMinutesRemaining,
  worldSim,
  worldView,
  type World,
} from './worldsim'
import { createRng, type Rng } from './rng'
import { POLICY_IDS, isZillPolicy, policyPlanBasis, policyUsesWearable, type SimConfig, type SimData, type SimEvent, type SiteDayResult, type WorldSimApi } from './types'
import { TRUTH_PARAMS } from './truth'
import { cohortSpec, truthOverridesApplied } from './backtest'

const loader = createNodeSimDataLoader()
const demo = buildDemoCrew()
const DEMO_ROSTER = { crews: [demo.crew], workers: demo.workers }
let peak: SimData
let mild: SimData

beforeAll(async () => {
  peak = await loader.load('musaffah', '2025-08-01', DEMO_ROSTER)
  mild = await loader.load('musaffah', '2025-11-26', DEMO_ROSTER)
}, 60_000)

const PEAK = '2025-08-01'
const local = (date: string, hhmm: string): number => epochFromLocal(`${date}T${hhmm}`)
const cfg = (over: Partial<Parameters<typeof makeSimConfig>[0]> = {}): SimConfig =>
  makeSimConfig({ siteId: 'musaffah', date: PEAK, seed: 'worldsim-test', policy: 'zill_full', trace: 'full', ...over })
const strip = (r: SiteDayResult): SiteDayResult => ({ ...r, timingMs: 0 })
const view = (w: World, id: string) => worldView(w).workers.find((x) => x.profile.id === id)!
/** Step until the local clock reaches hh:mm (minute start). */
const stepTo = (w: World, hhmm: string): World => stepWorld(w, Math.round((local(w.config.date, hhmm) - w.t) / MINUTE_MS))
const byKind = <K extends SimEvent['kind']>(events: readonly SimEvent[], kind: K) => events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind)

// ─────────────────────────────── simdata ───────────────────────────────

describe('simdata', () => {
  it('a demo day: IFS analysis for the truth, the archived day-1 forecast for the engine, with provenance', () => {
    expect(peak.site.id).toBe('musaffah')
    expect(peak.crews.map((c) => c.id)).toEqual([demo.crew.id])
    expect(peak.weather.analysis).toHaveLength(24)
    expect(peak.weather.forecast).toHaveLength(24)
    expect(peak.weather.forecast.map((s) => s.t)).toEqual(peak.weather.analysis.map((s) => s.t))
    // A real forecast, not a copy of the analysis.
    expect(peak.weather.forecast.some((s, i) => Math.abs(s.taC - peak.weather.analysis[i].taC) > 0.3)).toBe(true)
    const prov = peak.weather.provenance.join('\n')
    expect(prov).toMatch(/ECMWF IFS analysis/)
    expect(prov).toMatch(/day-1 forecast/)
    expect(prov).toMatch(/demo-days\.json/)
    expect(prov).toMatch(/Open-Meteo/)
  })

  it('any cached summer day from the archive + previous-runs files (Al Ain 2025-07-24)', async () => {
    const d = await loader.load('alain', '2025-07-24')
    expect(d.site.id).toBe('alain')
    expect(d.weather.analysis.length).toBeGreaterThanOrEqual(24)
    expect(d.weather.forecast.length).toBeGreaterThanOrEqual(24)
    const prov = d.weather.provenance.join('\n')
    expect(prov).toMatch(/archive\/alain_2025\.json/)
    expect(prov).toMatch(/previous-runs\/alain_2025\.json/)
    expect(prov).not.toContain(PERFECT_FORECAST_NOTE)
    const day0 = local('2025-07-24', '00:00')
    expect(d.weather.analysis.every((s) => s.t >= day0 - 2 * 3_600_000 && s.t <= day0 + 26 * 3_600_000)).toBe(true)
    // Default roster: generated Al Ain crews only (the demo crew is a Musaffah crew).
    expect(d.crews.length).toBe(3)
    expect(d.crews.every((c) => c.siteId === 'alain')).toBe(true)
    expect(new Set(d.workers.map((w) => w.crewId))).toEqual(new Set(d.crews.map((c) => c.id)))
  })

  it('default Musaffah roster includes the demo crew; explicit rosters need both crews and workers', () => {
    const r = siteRoster('musaffah')
    expect(r.crews.map((c) => c.id)).toContain(demo.crew.id)
    expect(r.crews.length).toBe(4)
    expect(() => siteRoster('musaffah', { crews: [demo.crew] })).toThrow(RangeError)
  })

  it('rejects dates without cached weather and malformed dates', async () => {
    await expect(loader.load('musaffah', '2023-01-15')).rejects.toThrow(/no cached weather/)
    await expect(loader.load('musaffah', '1 Aug 2025')).rejects.toThrow(RangeError)
  })

  it('minute interpolation over the shift (instantaneous radiation) and the day window filter', () => {
    const t0 = local(PEAK, '05:00')
    const t1 = local(PEAK, '17:00')
    const m = minuteWeather(peak.weather, 'musaffah', t0, t1)
    expect(m.analysis).toHaveLength(721)
    expect(m.forecast).toHaveLength(721)
    expect(m.analysis.every((s) => s.radiationWindowMin === 0)).toBe(true)
    expect(m.analysis[0].t).toBe(t0)
    expect(daySamples(peak.weather.analysis, PEAK)).toHaveLength(24)
    expect(daySamples(peak.weather.analysis, '2025-08-03')).toHaveLength(0)
  })
})

// ─────────────────────────────── API, config ───────────────────────────────

describe('world simulation API', () => {
  it('implements WorldSimApi and fills SimConfig defaults', () => {
    const api: WorldSimApi<World> = worldSim
    expect(Object.keys(api).sort()).toEqual(['createWorld', 'finishWorld', 'runSiteDay', 'stepWorld', 'worldView'])
    const c = makeSimConfig({ siteId: 'musaffah', date: PEAK })
    expect(c.policy).toBe('zill_full')
    expect(c.shadow).toBe(false)
    expect(c.packId).toBe('abu-dhabi')
    expect(c.engine.projectionEveryMin).toBe(5)
    expect(c.behaviour).toEqual({ ...DEFAULT_SIM_BEHAVIOUR, ackDelayMin: { ...DEFAULT_SIM_BEHAVIOUR.ackDelayMin } })
    expect(makeSimConfig({ siteId: 'musaffah', date: PEAK, behaviour: { ackDelayMin: { supervisor: 9 } } }).behaviour.ackDelayMin).toMatchObject({ supervisor: 9, worker: 1 })
    expect(shiftMinutes(c)).toBe(720)
  })

  it('rejects inconsistent inputs', () => {
    expect(() => createWorld(makeSimConfig({ siteId: 'kezad', date: PEAK }), peak)).toThrow(RangeError)
    expect(() => createWorld(cfg({ shift: { start: '17:00', end: '05:00' } }), peak)).toThrow(RangeError)
    const bad: Crew = { ...demo.crew, workerIds: [...demo.crew.workerIds, 'W-NOPE'] }
    expect(() => createWorld(cfg({ crews: [bad], workers: demo.workers }), peak)).toThrow(/unknown worker/)
    const w = createWorld(cfg(), peak)
    expect(() => stepWorld(w, -1)).toThrow(RangeError)
    expect(() => stepWorld(w, 1, [{ kind: 'task', workerId: 'W-NOPE', taskId: null, location: 'shade' }])).toThrow(/unknown worker/)
  })

  it('plans the day only for Zill policies; shadow mode keeps ban_only behaviour', () => {
    const z = createWorld(cfg({ policy: 'zill_env', trace: 'none' }), peak)
    expect(z.plan).not.toBeNull()
    expect(z.plan!.crews.map((c) => c.crewId)).toEqual([demo.crew.id])
    for (const p of ['ban_only', 'site_index'] as const) expect(createWorld(cfg({ policy: p, trace: 'none' }), peak).plan).toBeNull()
    expect(createWorld(cfg({ policy: 'zill_full', shadow: true, trace: 'none' }), peak).plan).toBeNull()
    // The site forecast strip: one entry per shift hour, midday break flagged in season.
    expect(z.hours).toHaveLength(12)
    expect(z.hours.filter((h) => h.middayBreak).map((h) => new Date(h.t + 4 * 3_600_000).toISOString().slice(11, 16))).toEqual(['12:00', '13:00', '14:00'])
  })
})

// ─────────────────────────────── Determinism ───────────────────────────────

describe('determinism', () => {
  it('same seed and inputs → identical result; chunked stepping = one call', () => {
    const a = runSiteDay(cfg(), peak)
    const b = runSiteDay(cfg(), peak)
    expect(strip(b)).toEqual(strip(a))
    const w = createWorld(cfg(), peak)
    const chunks = [1, 7, 60, 3, 120, 1, 45]
    let k = 0
    while (worldMinutesRemaining(w) > 0) stepWorld(w, chunks[k++ % chunks.length])
    expect(strip(finishWorld(w))).toEqual(strip(a))
    expect(finishWorld(w)).toBe(finishWorld(w))
  })

  it('a different seed changes the stochastic outcome; the stamp records the config', () => {
    const a = runSiteDay(cfg({ trace: 'none' }), peak)
    const b = runSiteDay(cfg({ trace: 'none', seed: 'another-seed' }), peak)
    expect(b.stamp).not.toBe(a.stamp)
    expect(a.stamp).toMatch(/^zill-worldsim@/)
    expect(JSON.stringify(b.outcomes)).not.toBe(JSON.stringify(a.outcomes))
  })
})

// ─────────────────────────────── Outcomes and the event log ───────────────────────────────

describe('outcomes and event log', () => {
  const runs: Array<{ name: string; config: SimConfig; result: SiteDayResult }> = []
  beforeAll(() => {
    for (const policy of POLICY_IDS) runs.push({ name: policy, config: cfg({ policy }), result: runSiteDay(cfg({ policy }), peak) })
    const sh = cfg({ policy: 'zill_full', shadow: true })
    runs.push({ name: 'shadow', config: sh, result: runSiteDay(sh, peak) })
  }, 120_000)

  it('work + rest + idle = shift minutes for every worker and policy', () => {
    for (const { config, result } of runs) {
      expect(result.outcomes).toHaveLength(demo.workers.length)
      for (const o of result.outcomes) {
        const idle = idleMinutes(o, config)
        expect(idle).toBeGreaterThanOrEqual(0)
        expect(o.workMin + o.restMin + idle).toBe(shiftMinutes(config))
        expect(o.hotWorkMin).toBeLessThanOrEqual(o.workMin)
        const assessed = RISK_LEVELS.reduce((s, l) => s + o.engine.minutesByLevel[l], 0)
        expect(assessed).toBeLessThanOrEqual(shiftMinutes(config))
        expect(o.adherence.followed).toBeLessThanOrEqual(o.adherence.instructions)
        expect(o.checkins.answered).toBeLessThanOrEqual(o.checkins.prompted)
        expect(o.policy).toBe(config.policy)
      }
    }
  })

  it('the event log is ordered and complete', () => {
    for (const { name, config, result } of runs) {
      const ev = result.events
      for (let i = 1; i < ev.length; i++) expect(ev[i].t, `${name} event ${i}`).toBeGreaterThanOrEqual(ev[i - 1].t)
      const t0 = local(PEAK, config.shift.start)
      const t1 = local(PEAK, config.shift.end)
      for (const w of demo.workers) {
        const shifts = byKind(ev, 'shift').filter((e) => e.workerId === w.id)
        expect(shifts.map((e) => e.what)).toEqual(['start', 'end'])
        expect(shifts[0].t).toBe(t0)
        expect(shifts[1].t).toBeLessThanOrEqual(t1)
        expect(byKind(ev, 'task').some((e) => e.workerId === w.id && e.t === t0)).toBe(true)
        // Level events chain per worker.
        const lv = byKind(ev, 'level').filter((e) => e.workerId === w.id)
        lv.forEach((e, i) => {
          expect(e.from).not.toBe(e.to)
          if (i > 0) expect(e.from).toBe(lv[i - 1].to)
        })
      }
      // Every alert and notification is in the log; every ack refers to a logged alert.
      const alertIds = new Set(byKind(ev, 'alert').map((e) => e.alert.id))
      expect(alertIds.size).toBe(result.alertStats.alerts)
      expect(byKind(ev, 'notification')).toHaveLength(result.alertStats.notifications)
      for (const a of byKind(ev, 'ack')) expect(alertIds.has(a.alertId)).toBe(true)
      // Trace: one row per worker-minute until the shift ends (or the worker is taken off site).
      const rows = result.minutes ?? []
      for (const w of demo.workers) {
        const n = rows.filter((r) => r.workerId === w.id).length
        const end = byKind(ev, 'shift').find((e) => e.workerId === w.id && e.what === 'end')!
        expect(n).toBe(Math.round((end.t - t0) / MINUTE_MS))
      }
    }
  })

  it('engine output exists only where the engine runs; nobody acts in ban_only, site_index or shadow mode', () => {
    for (const { name, result } of runs) {
      const acts = byKind(result.events, 'instruction').length + byKind(result.events, 'ack').length
      if (name === 'ban_only' || name === 'site_index') {
        expect(result.alertStats.alerts).toBe(0)
        expect(acts).toBe(0)
      } else if (name === 'shadow') {
        expect(result.alertStats.alerts).toBeGreaterThan(0)
        expect(acts).toBe(0)
        expect(result.outcomes.every((o) => o.checkins.prompted === 0)).toBe(true)
      } else {
        expect(result.alertStats.alerts).toBeGreaterThan(0)
        expect(byKind(result.events, 'instruction').length).toBeGreaterThan(0)
      }
    }
  })

  it('no scheduled work in the sun during the midday break, under any policy', () => {
    for (const { result } of runs) {
      const bad = (result.minutes ?? []).filter((m) => m.working && m.location === 'sun' && isMiddayBreak(m.t - MINUTE_MS))
      expect(bad).toHaveLength(0)
    }
  })

  it('site_index applies ADOSH zone work/rest cycles crew-wide and keeps ADOSH-unacclimatised workers out of excluded zones', () => {
    const si = createWorld(cfg({ policy: 'site_index', trace: 'full' }), peak)
    const bo = createWorld(cfg({ policy: 'ban_only', trace: 'full' }), peak)
    expect(si.crews[0].planReason.includes(1)).toBe(true) // R_CYCLE
    expect(bo.crews[0].planReason.includes(1)).toBe(false)
    const res = finishWorld(si)
    const unacc = 'W-D2A1' // day-2 arrival
    const zoneAt = (t: number) => si.hours.find((h) => t - MINUTE_MS >= h.t && t - MINUTE_MS < h.t + 3_600_000)?.twlZone
    const worked = (res.minutes ?? []).filter((m) => m.workerId === unacc && m.working)
    for (const m of worked) expect(['low', 'none']).toContain(zoneAt(m.t))
  })
})

// ─────────────────────────────── Shadow mode ───────────────────────────────

describe('shadow mode', () => {
  it('runs the engine and alerts but never acts on it: ground truth and behaviour equal ban_only', () => {
    const base = runSiteDay(cfg({ policy: 'ban_only' }), peak)
    const shadow = runSiteDay(cfg({ policy: 'zill_full', shadow: true }), peak)
    expect(shadow.alertStats.alerts).toBeGreaterThan(0)
    const pick = (r: SiteDayResult) =>
      r.outcomes.map((o) => ({ id: o.workerId, work: o.workMin, rest: o.restMin, hot: o.hotWorkMin, water: o.waterMl, core: o.maxCoreC, m385: o.minutesCoreAbove385, dehyd: o.maxDehydrationPct, ev: o.events }))
    expect(pick(shadow)).toEqual(pick(base))
    const truthTrace = (r: SiteDayResult) => (r.minutes ?? []).map((m) => [m.t, m.workerId, m.working, m.location, m.coreTrueC, m.dehydrationPct])
    expect(truthTrace(shadow)).toEqual(truthTrace(base))
    const tasks = (r: SiteDayResult) => byKind(r.events, 'task').map((e) => [e.t, e.workerId, e.taskId, e.location])
    expect(tasks(shadow)).toEqual(tasks(base))
    expect(shadow.outcomes.some((o) => o.engine.firstHighT !== null)).toBe(true)
  })
})

// ─────────────────────────────── Injections ───────────────────────────────

describe('injections take effect', () => {
  it('a buddy check-in with confusion → emergency, 998 actions, first aider on scene, cooling, hand-over', () => {
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '08:00')
    const id = 'W-D2F6'
    stepWorld(w, 0, [{ kind: 'checkin', checkin: { t: w.t, workerId: id, by: 'buddy', symptoms: ['confusion'] } }])
    expect(byKind(w.events, 'checkin').some((e) => e.checkin.workerId === id && e.checkin.symptoms.includes('confusion'))).toBe(true)
    stepWorld(w, 1)
    const v = view(w, id)
    expect(v.assessment?.level).toBe('emergency')
    expect(v.assessment?.actions[0]).toBe('call_998')
    const em = byKind(w.events, 'alert').find((e) => e.alert.workerId === id && e.alert.level === 'emergency')
    expect(em).toBeDefined()
    stepWorld(w, 15)
    expect(byKind(w.events, 'ack').some((e) => e.alertId === em!.alert.id && e.role === 'first_aider')).toBe(true)
    stepWorld(w, 40)
    expect(byKind(w.events, 'resolution').some((e) => e.workerId === id && e.by === 'first_aider')).toBe(true)
    expect(byKind(w.events, 'shift').some((e) => e.workerId === id && e.what === 'end')).toBe(true)
  })

  it('an injected acknowledgement updates the alert and is logged', () => {
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '08:00')
    stepWorld(w, 0, [{ kind: 'checkin', checkin: { t: w.t, workerId: 'W-D307', by: 'buddy', symptoms: ['collapsed_unresponsive'] } }])
    stepWorld(w, 1)
    const al = worldView(w).alerts.find((a) => a.workerId === 'W-D307' && a.level === 'emergency')!
    expect(al.status).toBe('active')
    stepWorld(w, 0, [{ kind: 'ack', alertId: al.id, role: 'supervisor' }])
    const after = worldView(w).alerts.find((a) => a.id === al.id)!
    expect(after.status).toBe('acknowledged')
    expect(after.ack?.role).toBe('supervisor')
    expect(byKind(w.events, 'ack').some((e) => e.alertId === al.id && e.role === 'supervisor' && e.t === w.t)).toBe(true)
  })

  it('resolve: a symptom latch clears after a clean re-check and a sign-off (shadow mode: no automatic actions)', () => {
    const w = createWorld(cfg({ policy: 'zill_full', shadow: true, trace: 'none' }), peak)
    stepTo(w, '06:30')
    const id = 'W-D307'
    stepWorld(w, 0, [{ kind: 'checkin', checkin: { t: w.t, workerId: id, by: 'self', symptoms: ['dizziness'] } }])
    stepWorld(w, 2)
    expect(view(w, id).assessment?.level).toBe('stop')
    expect(view(w, id).detail?.latch?.clearedAt).toBeUndefined()
    const alertId = w.alerts.workers[id].openAlertId
    expect(alertId).not.toBeNull()
    stepWorld(w, 5)
    stepWorld(w, 0, [
      { kind: 'checkin', checkin: { t: w.t, workerId: id, by: 'supervisor', symptoms: [] } },
      { kind: 'resolve', workerId: id, by: 'supervisor' },
    ])
    stepWorld(w, 2)
    expect(view(w, id).detail?.latch?.clearedAt).toBeDefined()
    expect(worldView(w).alerts.find((a) => a.id === alertId)?.status).toBe('resolved')
    expect(byKind(w.events, 'resolution').some((e) => e.workerId === id && e.by === 'supervisor')).toBe(true)
  })

  it('a task change moves the worker until the next change; an intake reaches the truth and the engine', () => {
    const w = createWorld(cfg({ policy: 'ban_only', trace: 'full' }), peak)
    // 07:00: the crew is at work (since worldsim 1.3.0 the listed order starts each task when its window opens, 06:00).
    stepTo(w, '07:00')
    const id = 'W-D2B2'
    const water0 = w.workerById.get(id)!.truth.intakeMl
    stepWorld(w, 0, [
      { kind: 'task', workerId: id, taskId: null, location: 'indoor_cool' },
      { kind: 'intake', intake: { t: w.t, workerId: id, ml: 500 } },
    ])
    stepWorld(w, 1)
    let v = view(w, id)
    expect(v.task).toBeNull()
    expect(v.location).toBe('indoor_cool')
    expect(byKind(w.events, 'task').some((e) => e.workerId === id && e.location === 'indoor_cool' && e.t === local(PEAK, '07:00'))).toBe(true)
    expect(w.workerById.get(id)!.truth.intakeMl - water0).toBeGreaterThanOrEqual(500)
    expect(byKind(w.events, 'intake').some((e) => e.intake.workerId === id && e.intake.ml === 500)).toBe(true)
    stepWorld(w, 30)
    expect(view(w, id).location).toBe('indoor_cool')
    stepWorld(w, 0, [{ kind: 'task', workerId: id, taskId: 'musaffah-demo:inspection_rounds', location: 'shade' }])
    stepWorld(w, 1)
    v = view(w, id)
    expect(v.task?.id).toBe('musaffah-demo:inspection_rounds')
    expect(v.location).toBe('shade')
    // The engine receives logged intakes where it runs.
    const z = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(z, '06:00')
    stepWorld(z, 1, [{ kind: 'intake', intake: { t: z.t, workerId: id, ml: 400 } }])
    stepWorld(z, 2)
    expect(z.workerById.get(id)!.engine!.intakes.some((x) => x.ml === 400)).toBe(true)
  })

  it('system injections: environment feed failure falls back to the cached forecast; network state is reported', () => {
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '07:00')
    expect(worldView(w).env?.source).toBe('forecast')
    expect(worldView(w).sensor).toBe('none')
    stepWorld(w, 0, [{ kind: 'system', what: 'sensor_fail' }, { kind: 'system', what: 'network_down' }])
    expect(worldView(w).sensor).toBe('failed')
    expect(worldView(w).network).toBe('offline')
    stepWorld(w, 1)
    expect(worldView(w).env?.source).toBe('cached_forecast')
    stepWorld(w, 0, [{ kind: 'system', what: 'sensor_ok' }, { kind: 'system', what: 'network_up' }])
    stepWorld(w, 1)
    expect(worldView(w).env?.source).toBe('forecast')
    const sys = byKind(w.events, 'system').map((e) => e.what)
    expect(sys).toEqual(['sensor_fail', 'network_down', 'sensor_ok', 'network_up'])
  })
})

// ─────────────────────────────── Scripted events, disruptions ───────────────────────────────

describe('scripted events and disruptions', () => {
  it('scripted events fire when the clock reaches them', () => {
    const r = runSiteDay(cfg({ trace: 'none' }), peak, {
      script: [
        { at: '06:30', injection: { kind: 'system', what: 'sensor_fail' }, note: 'feed fails' },
        { at: '07:00', injection: { kind: 'system', what: 'sensor_ok' }, note: 'feed back' },
        { at: '08:15', injection: { kind: 'checkin', checkin: { t: local(PEAK, '08:15'), workerId: 'W-D2F6', by: 'buddy', symptoms: ['confusion'] } }, note: 'buddy report' },
      ],
    })
    const sys = byKind(r.events, 'system')
    expect(sys.map((e) => [e.what, e.t])).toEqual([
      ['sensor_fail', local(PEAK, '06:30')],
      ['sensor_ok', local(PEAK, '07:00')],
    ])
    expect(byKind(r.events, 'checkin').find((e) => e.checkin.symptoms.includes('confusion'))?.t).toBe(local(PEAK, '08:15'))
    const lv = byKind(r.events, 'level').find((e) => e.workerId === 'W-D2F6' && e.to === 'emergency')
    expect(lv?.t).toBe(local(PEAK, '08:16'))
  })

  it('configured disruption windows; supervisor-side acknowledgements wait for the network', () => {
    const r = runSiteDay(cfg({ trace: 'none', disruptions: { networkOutage: { from: '06:00', to: '09:00' }, envSensorFailure: { from: '10:00', to: '10:20' } } }), peak)
    const sys = byKind(r.events, 'system').map((e) => [e.what, e.t])
    expect(sys).toEqual([
      ['network_down', local(PEAK, '06:00')],
      ['network_up', local(PEAK, '09:00')],
      ['sensor_fail', local(PEAK, '10:00')],
      ['sensor_ok', local(PEAK, '10:20')],
    ])
    const inside = byKind(r.events, 'ack').filter((e) => e.role !== 'worker' && e.t > local(PEAK, '06:00') && e.t < local(PEAK, '09:00'))
    expect(inside).toHaveLength(0)
    // Devices fell back to SMS for supervisors while offline (alert engine policy).
    expect(byKind(r.events, 'notification').some((e) => e.notification.channel === 'sms' && e.t >= local(PEAK, '06:00') && e.t < local(PEAK, '09:00'))).toBe(true)
  })

  it('stale forecast: logged once and the engine applies the fail-safe margin', () => {
    const w = createWorld(cfg({ trace: 'none', disruptions: { forecastAgeH: 30 } }), peak)
    expect(byKind(w.events, 'system').map((e) => e.what)).toEqual(['forecast_stale'])
    stepWorld(w, 10)
    expect(worldView(w).env?.wbgtMarginC).toBe(1)
    expect(worldView(w).env?.stale).toBe(true)
  })

  it('statutory break: never more than 5 h of uninterrupted work (mild day, no midday break)', () => {
    const r = runSiteDay(makeSimConfig({ siteId: 'musaffah', date: '2025-11-26', policy: 'ban_only', seed: 'stat', trace: 'full' }), mild)
    for (const w of demo.workers) {
      let run = 0
      let max = 0
      for (const m of (r.minutes ?? []).filter((x) => x.workerId === w.id)) {
        run = m.working ? run + 1 : 0
        max = Math.max(max, run)
      }
      expect(max).toBeLessThanOrEqual(300)
    }
    expect(r.hours.some((h) => h.middayBreak)).toBe(false)
  })
})

// ─────────────────────────────── Performance ───────────────────────────────

// ─────────────────────────────── Wave 2c mechanics ───────────────────────────────

const TRUTH_KIND_LIST = ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'symptom_onset'] as const

describe('truth overrides, structured truth events, idle minutes', () => {
  it('CreateWorldOptions.truthParams is deep-merged into the world (config-driven leaves win) and joins the stamp', () => {
    const c = cfg({ policy: 'ban_only', trace: 'none' })
    const base = createWorld(c, peak)
    const over = createWorld(c, peak, { truthParams: { traits: { metabolicSigmaLn: 0.25 }, symptoms: { hazardScale: 2 }, behaviour: { reminderCompliance: 0.1 } } })
    expect(over.truthParams.traits.metabolicSigmaLn).toBe(0.25)
    expect(over.truthParams.symptoms.hazardScale).toBe(2)
    expect(over.truthParams.behaviour.reminderCompliance).toBe(c.behaviour.compliance) // the config is the single source
    expect(over.workers[0].truth.params.symptoms.hazardScale).toBe(2)
    expect(base.truthParams.traits.metabolicSigmaLn).toBe(TRUTH_PARAMS.traits.metabolicSigmaLn)
    expect(TRUTH_PARAMS.symptoms.hazardScale).toBe(1) // defaults untouched
    // Same seed and z-scores, wider spread → different hidden metabolic multipliers.
    expect(over.workers.map((x) => x.traits.metabolicMultiplier)).not.toEqual(base.workers.map((x) => x.traits.metabolicMultiplier))
    expect(over.stamp).not.toBe(base.stamp)
    expect(createWorld(c, peak, {}).stamp).toBe(base.stamp)
    // The back-test's probe now sees its sweeps applied (they were reported as not run before).
    expect(truthOverridesApplied(cohortSpec('quick'), peak, PEAK, { symptoms: { hazardScale: 2 } })).toBe(true)
    expect(truthOverridesApplied(cohortSpec('quick'), peak, PEAK, { traits: { metabolicSigmaLn: 0.1 } })).toBe(true)
  })

  it('truth events carry onsetT and the symptom cluster; outcomes carry idleMin (= shift − work − rest)', () => {
    const c = cfg({ policy: 'ban_only', trace: 'none' })
    const r = runSiteDay(c, peak)
    const truth = byKind(r.events, 'truth')
    expect(truth.some((e) => e.event === 'symptom_onset')).toBe(true)
    expect(truth.some((e) => e.event !== 'symptom_onset')).toBe(true)
    for (const e of truth) {
      expect(typeof e.onsetT).toBe('number')
      expect(e.onsetT as number).toBeLessThanOrEqual(e.t)
      if (e.event === 'symptom_onset') {
        expect(['heat_exhaustion', 'cramps', 'cns', 'thirst']).toContain(e.cluster)
        expect(e.onsetT).toBe(e.t)
        expect(e.detail?.startsWith(`${e.cluster}:`)).toBe(true)
      } else expect(e.cluster).toBeUndefined()
    }
    for (const o of r.outcomes) {
      for (const k of TRUTH_KIND_LIST) {
        const first = truth.find((e) => e.workerId === o.workerId && e.event === k)
        expect(o.events[k].firstT).toBe(first ? first.onsetT : null)
      }
      expect(o.idleMin).toBe(idleMinutes(o, c))
      expect(o.workMin + o.restMin + o.idleMin).toBe(shiftMinutes(c))
    }
  })
})

describe('supervisor follow-through', () => {
  it('a supervisor reassignment on STOP is carried out with probability supervisorFollowThrough (default 1; 0 = never, logged as not followed)', () => {
    expect(DEFAULT_SIM_BEHAVIOUR.supervisorFollowThrough).toBe(1)
    expect(makeSimConfig({ siteId: 'musaffah', date: PEAK }).behaviour.supervisorFollowThrough).toBe(1)
    expect(makeSimConfig({ siteId: 'musaffah', date: PEAK, behaviour: { supervisorFollowThrough: 0.4 } }).behaviour.supervisorFollowThrough).toBe(0.4)
    // No worker complies and nobody acknowledges on their own, so a stopped worker keeps working until the (injected)
    // supervisor acknowledgement reassigns them.
    const never = 1e9
    const behaviour = { compliance: 0, ackDelayMin: { worker: never, buddy: never, supervisor: never, first_aider: never, occ_health: never } }
    const probe = createWorld(cfg({ trace: 'none', behaviour }), peak)
    let target: { minute: number; workerId: string; alertId: string } | null = null
    while (!target && !probe.finished) {
      stepWorld(probe, 1)
      for (const ws of probe.workers) {
        const open = probe.alerts.workers[ws.id]?.openAlertId
        const al = open ? probe.alerts.alerts[open]?.alert : undefined
        if (ws.rest && !ws.rest.followed && !ws.rest.enforced && ws.assessment && RISK_ORDER[ws.assessment.level] >= RISK_ORDER.stop && al && RISK_ORDER[al.level] >= RISK_ORDER.stop) {
          target = { minute: probe.minuteIndex, workerId: ws.id, alertId: al.id }
          break
        }
      }
    }
    expect(target).not.toBeNull()
    const tg = target as { minute: number; workerId: string; alertId: string }
    for (const ft of [1, 0]) {
      const w = createWorld(cfg({ trace: 'none', behaviour: { ...behaviour, supervisorFollowThrough: ft } }), peak)
      stepWorld(w, tg.minute)
      const before = byKind(w.events, 'instruction').length
      stepWorld(w, 0, [{ kind: 'ack', alertId: tg.alertId, role: 'supervisor' }])
      expect(byKind(w.events, 'instruction').slice(before)).toEqual([{ kind: 'instruction', t: w.t, workerId: tg.workerId, action: 'stop_work', followed: ft === 1 }])
      expect(w.workerById.get(tg.workerId)?.rest?.enforced).toBe(ft === 1)
    }
  })
})

describe('consent changes reach the device world', () => {
  const RAMESH = 'W-D2F6' // all consents, wearable
  const consentOf = (w: World, id: string): ConsentState => {
    const ws = w.workerById.get(id)
    if (!ws) throw new Error(`no worker ${id}`)
    return { ...ws.profile.consent }
  }

  it('wearable revoked: the PPG stream stops and no physiology minute reaches the engine; a re-grant restores both', () => {
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '08:00')
    const ws = w.workerById.get(RAMESH)!
    expect(ws.physioActive).toBe(true)
    stepWorld(w, 0, [{ kind: 'consent', workerId: RAMESH, consent: { ...consentOf(w, RAMESH), wearable: false, updatedAt: w.t } }])
    expect(ws.physioActive).toBe(false)
    expect(ws.profile.consent.wearable).toBe(false)
    expect(ws.rosterProfile.consent.wearable).toBe(true)
    const physio0 = JSON.stringify(ws.engine!.physio)
    stepWorld(w, 30)
    expect(view(w, RAMESH).lastHrBpm).toBeNull()
    expect(view(w, RAMESH).profile.consent.wearable).toBe(false)
    expect(ws.assessment!.dataQuality.physiology).toBe('absent')
    expect(JSON.stringify(ws.engine!.physio)).toBe(physio0)
    stepWorld(w, 0, [{ kind: 'consent', workerId: RAMESH, consent: { ...consentOf(w, RAMESH), wearable: true, updatedAt: w.t } }])
    stepWorld(w, 10)
    expect(ws.physioActive).toBe(true)
    expect(JSON.stringify(ws.engine!.physio)).not.toBe(physio0)
    // The fairness subgroup keeps the roster attributes.
    expect(finishWorld(w).outcomes.find((o) => o.workerId === RAMESH)?.subgroup.wearable).toBe(true)
  })

  it('check-ins revoked: no prompted check-in from that minute (in-person checks only)', () => {
    const control = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(control, '09:00')
    const prompted0 = new Map(control.workers.map((x) => [x.id, x.acc.prompted]))
    finishWorld(control)
    const subject = control.workers.find((x) => x.rosterProfile.consent.checkins && x.acc.prompted > (prompted0.get(x.id) ?? 0))
    expect(subject).toBeDefined() // the control run prompts this worker after 09:00
    const id = (subject as { id: string }).id
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '09:00')
    const ws = w.workerById.get(id)!
    const n0 = ws.acc.prompted
    stepWorld(w, 0, [{ kind: 'consent', workerId: id, consent: { ...consentOf(w, id), checkins: false, updatedAt: w.t } }])
    const t0 = w.t
    finishWorld(w)
    expect(ws.checkinsConsented).toBe(false)
    expect(ws.acc.prompted).toBe(n0)
    expect(byKind(w.events, 'checkin').filter((e) => e.checkin.workerId === id && e.t >= t0 && e.prompted)).toEqual([])
  })

  it('health flags revoked: the engine no longer sees the self-declared flags; the worker still fasts (truth unchanged)', () => {
    const JAHANGIR = 'W-D2D4' // declared 'fasting'
    const w = createWorld(cfg({ trace: 'none' }), peak)
    stepTo(w, '07:00')
    const ws = w.workerById.get(JAHANGIR)!
    expect(ws.profile.riskFlags).toEqual(['fasting'])
    stepWorld(w, 0, [{ kind: 'consent', workerId: JAHANGIR, consent: { ...consentOf(w, JAHANGIR), healthFlags: false, updatedAt: w.t } }])
    expect(ws.profile.riskFlags).toEqual([])
    expect(ws.rosterProfile.riskFlags).toEqual(['fasting'])
    const t0 = w.t
    finishWorld(w)
    expect(byKind(w.events, 'intake').filter((e) => e.intake.workerId === JAHANGIR && e.t > t0)).toEqual([])
  })

  it('rejects a consent change for an unknown worker or with a non-boolean scope', () => {
    const w = createWorld(cfg({ trace: 'none' }), peak)
    const ok = consentOf(w, RAMESH)
    expect(() => stepWorld(w, 0, [{ kind: 'consent', workerId: 'W-NOPE', consent: ok }])).toThrow(RangeError)
    expect(() => stepWorld(w, 0, [{ kind: 'consent', workerId: RAMESH, consent: { ...ok, wearable: 'yes' as never } }])).toThrow(/consent\.wearable/)
    expect(w.workerById.get(RAMESH)?.physioActive).toBe(true)
  })
})

describe('schedules: ADOSH dose in site_index, plan fidelity', () => {
  it('site_index carries the hourly ADOSH dose across task changes: Σ minutes/allowance ≤ 1 in every crew clock hour', () => {
    // Short first tasks, so the listed order changes task inside clock hours that have a work/rest cycle.
    const durations = [50, 35, 25, 300]
    const crew: Crew = { ...demo.crew, tasks: demo.crew.tasks.map((t, j) => ({ ...t, durationMin: durations[j] ?? t.durationMin })) }
    const w = createWorld(cfg({ policy: 'site_index', trace: 'none', crews: [crew], workers: demo.workers }), peak)
    const cs = w.crews[0]
    const hours = new Map<number, { dose: number; tasks: Set<string>; limited: boolean }>()
    for (let i = 0; i < w.nMinutes; i++) {
      if (cs.planWork[i] !== 1) continue
      const t = w.t0 + i * MINUTE_MS
      const h = w.dayStart + Math.floor((t - w.dayStart) / 3_600_000) * 3_600_000
      const task = cs.tasks[cs.planTask[i]]
      const W = w.floors.get(`${h}|${task.id}`)?.workMinPerHour ?? 60
      const e = hours.get(h) ?? { dose: 0, tasks: new Set<string>(), limited: false }
      e.dose += 1 / W
      e.tasks.add(task.id)
      e.limited ||= W < 60
      hours.set(h, e)
    }
    for (const e of hours.values()) expect(e.dose).toBeLessThanOrEqual(1 + 1e-9)
    // At least one cycled hour mixes two tasks (the case the per-task cycle used to get wrong).
    expect([...hours.values()].some((e) => e.tasks.size > 1 && e.limited)).toBe(true)
    // ban_only: no cycle at all (W = 60 everywhere), so the dose never binds.
    const bo = createWorld(cfg({ policy: 'ban_only', trace: 'none', crews: [crew], workers: demo.workers }), peak)
    expect(bo.crews[0].planReason.includes(1)).toBe(false)
  })

  it('planWindowWorkMin: W per full 60-min window, floor(W·r/60) in the last partial window of a block (known answers)', () => {
    expect(planWindowWorkMin(30, 40, 0)).toBe(20) // 40-min block at 30/h: 20, not 30
    expect(planWindowWorkMin(45, 20, 5)).toBe(15)
    expect(planWindowWorkMin(40, 50, 49)).toBe(33) // 33.3 rounded down
    expect(planWindowWorkMin(30, 70, 10)).toBe(30) // first, full window
    expect(planWindowWorkMin(30, 70, 65)).toBe(5) // last 10 min
    expect(planWindowWorkMin(45, 320, 300)).toBe(15)
    expect(planWindowWorkMin(60, 25, 0)).toBe(25)
    expect(planWindowWorkMin(0, 60, 0)).toBe(0)
  })

  it('plan schedule: each plan block-hour works its first boutMin minutes, then rests (the planner layout its ISO 7933 screen simulated)', () => {
    // The schedule follows the plan's own execution layout (worldsim 1.2.0). Since wave 2d the planner floors
    // BlockHour.boutMin (it was ceil), so the executed work of a block never exceeds its planned work (tightened below);
    // planWindowWorkMin is only the fallback for a block without block-hours.
    const R_MIDDAY = 2
    const R_STATUTORY = 3
    for (const [date, data] of [['2025-11-26', mild], [PEAK, peak]] as const) {
      const w = createWorld(cfg({ date, trace: 'none' }), data)
      let bouts = 0
      for (const cs of w.crews) {
        const cp = w.plan?.crews.find((p) => p.crewId === cs.crew.id)
        for (const b of cp?.blocks ?? []) {
          if (!b.taskId) continue
          let blockWork = 0
          for (const h of b.hours) {
            for (let m = 0; m < h.wallMin; m++) {
              const t = h.startT + m * MINUTE_MS
              if (t < w.t0 || t >= w.tEnd) continue
              const i = Math.round((t - w.t0) / MINUTE_MS)
              blockWork += cs.planWork[i]
              if (m >= h.boutMin) expect(cs.planWork[i], `${date} ${b.start} +${m}`).toBe(0)
              else if (cs.planWork[i] === 0) expect([R_MIDDAY, R_STATUTORY]).toContain(cs.planReason[i])
              else bouts += 1
            }
          }
          expect(blockWork).toBeLessThanOrEqual(b.hours.reduce((s, h) => s + h.boutMin, 0))
          expect(blockWork).toBeLessThanOrEqual(b.hours.reduce((s, h) => s + h.workMin, 0) + 1e-9)
          for (const h of b.hours) expect(h.boutMin).toBeLessThanOrEqual(h.workMin + 1e-9)
        }
      }
      expect(bouts).toBeGreaterThan(0)
    }
  })
})

describe('engine-owned resume and the day plan on the device (worldsim 1.2.0)', () => {
  const REST_IDS = ['stop_work', 'rest_shade_now', 'midday_break']
  const asksRest = (a: RiskAssessment | null): boolean => a !== null && (RISK_ORDER[a.level] >= RISK_ORDER.stop || a.actions.some((x) => REST_IDS.includes(x)))

  it('deviceCycleWorkMin: no cut when the device allows at least the plan rate, else floor(W × wall / 60) (known answers)', () => {
    expect(deviceCycleWorkMin(45, 45, 60)).toBeNull()
    expect(deviceCycleWorkMin(50, 45, 25)).toBeNull()
    expect(deviceCycleWorkMin(30, 45, 60)).toBe(30)
    expect(deviceCycleWorkMin(30, 45, 25)).toBe(12) // 12.5 rounded down
    expect(deviceCycleWorkMin(20, null, 40)).toBe(13) // 13.3 rounded down
    expect(deviceCycleWorkMin(0, 45, 60)).toBe(0)
    expect(deviceCycleWorkMin(75, null, 60)).toBe(60)
    expect('resumeMinMinutesToLimit' in WORLD_PARAMS).toBe(false)
  })

  it('the planner runs its ISO 7933 screen on the forecast climate (plan and monitor agree)', () => {
    for (const [date, data] of [['2025-11-26', mild], [PEAK, peak]] as const) {
      const w = createWorld(cfg({ date, trace: 'none' }), data)
      expect(w.plan?.crews.every((c) => c.phsScreen !== null)).toBe(true)
      expect(w.plan?.warnings.some((x) => x.code === 'phs_screen_unavailable')).toBe(false)
    }
  })

  it('the device gets the assignment: resumeTask = the scheduled task, else the next one; plannedWorkMinPerHour = the plan block rate (a member on an acclimatisation schedule: their own cap), never exceeded', () => {
    for (const [date, data] of [['2025-11-26', mild], [PEAK, peak]] as const) {
      const w = createWorld(cfg({ date, trace: 'none' }), data)
      const blocks = w.plan?.crews[0].blocks ?? []
      const caps = w.plan?.crews[0].memberCaps ?? {}
      expect(Object.keys(caps).length).toBeGreaterThan(0) // the demo crew has a member on a schedule
      // The member's cap of the block-hour that contains t (0 where the plan gave no cap: no work, protective).
      const capAt = (id: string, t: number): number => {
        const h = blocks.flatMap((b) => b.hours).find((x) => t >= x.startT && t < x.startT + x.wallMin * MINUTE_MS)
        return h ? (caps[id].find((c) => c.startT === h.startT)?.workMinPerHour ?? 0) : 0
      }
      let checked = 0
      let capped = 0
      while (worldMinutesRemaining(w) > 0) {
        stepWorld(w, 1)
        const t = w.t - MINUTE_MS // the minute just decided
        const k = blocks.findIndex((b) => t >= b.startT && t < b.endT)
        const cur = k >= 0 ? blocks[k] : undefined
        const next = cur?.taskId ? cur : blocks.slice(Math.max(0, k)).find((b) => b.taskId !== null && b.startT > t)
        for (const ws of w.workers) {
          if (ws.manual || ws.evacuated) continue
          expect(ws.resumeTask?.id ?? null, `${date} ${ws.id}`).toBe(next?.taskId ?? null)
          expect(ws.plannedRate, `${date} ${ws.id}`).toBe(cur?.taskId ? (caps[ws.id] ? capAt(ws.id, t) : cur.workMinPerHour) : null)
          checked += 1
          if (ws.plannedRate !== null && ws.assessment) {
            expect(ws.assessment.workMinPerHour).toBeLessThanOrEqual(ws.plannedRate + 1e-9)
            if (ws.detail?.plannedCapApplied) capped += 1
          }
        }
      }
      expect(checked).toBeGreaterThan(0)
      expect(capped).toBeGreaterThan(0)
    }
  })

  it('the engine owns every resume decision: a rest episode ends exactly when the device neither asks for rest nor holds; projection and task holds keep the worker resting until the engine releases them', () => {
    // Expectation changed in worldsim 1.4.0 (wave 2d): the simulator's own check of the resume task
    // (resumeTaskAllowed, counted here as heldByRule > 0) is gone — the engine's task hold now owns the regulation and
    // environment stops (risk.ts TaskHold) — so a worker whose device neither asks for rest nor holds always resumes.
    const n = { resting: 0, resumed: 0, taskHeldResting: 0, heldResting: 0, checks: 0, infeasible: 0 }
    for (const [date, data] of [['2025-11-26', mild], [PEAK, peak]] as const) {
      const w = createWorld(cfg({ date, trace: 'none' }), data)
      while (worldMinutesRemaining(w) > 0) {
        const i = w.minuteIndex
        const before = new Map(w.workers.map((ws) => [ws.id, { a: ws.assessment, rest: ws.rest, held: ws.detail?.resume?.held === true, aid: ws.firstAid !== null && ws.firstAid.startedT !== null && ws.firstAid.kind === 'emergency', out: ws.evacuated }]))
        stepWorld(w, 1)
        for (const ws of w.workers) {
          const p = before.get(ws.id)!
          if (p.rest && !p.aid && !p.out && p.a && !ws.manual) {
            // The decision this minute used the device's assessment `p.a` and hold flag: keep resting while it asks for
            // rest or holds, resume as soon as it does neither (no simulator rule in between).
            if (asksRest(p.a) || p.held) {
              expect(ws.rest).not.toBeNull()
              n.resting += 1
            } else {
              expect(ws.rest, `${date} ${ws.id} at minute ${i}`).toBeNull()
              n.resumed += 1
            }
          }
          // A task hold (regulation / environment stop of the task to resume) keeps a complying worker off the task.
          if (ws.rest?.followed && ws.detail?.resume?.heldBy.some((h) => h === 'regulation' || h === 'environment')) {
            expect(ws.working).toBe(false)
            expect(RISK_ORDER[ws.assessment!.level]).toBeGreaterThanOrEqual(RISK_ORDER.stop)
            n.taskHeldResting += 1
          }
          const hold = ws.engine?.projectionHold
          if (hold && ws.rest?.followed) {
            expect(ws.working).toBe(false)
            n.heldResting += 1
          }
          // The engine's resume check projects the scheduled task the simulator passed.
          if (hold && hold.checkedT === ws.engine?.lastT && ws.resumeTask) {
            expect(hold.checkedTaskId).toBe(ws.resumeTask.id)
            n.checks += 1
          }
          // [ASSUMPTION] not feasible now: the device stays at stop with rotate_task; the worker keeps resting (no reassignment modelled).
          if (ws.detail?.resume?.infeasibleNow) {
            expect(RISK_ORDER[ws.assessment!.level]).toBeGreaterThanOrEqual(RISK_ORDER.stop)
            expect(ws.assessment!.actions).toContain('rotate_task')
            n.infeasible += 1
          }
        }
      }
    }
    for (const [k, v] of Object.entries(n)) expect(v, k).toBeGreaterThan(0)
  })
})

describe('per-member plans and monitored mode (worldsim 1.4.0, wave 2d)', () => {
  const R_MIDDAY = 2
  const R_STATUTORY = 3

  it('policy helpers: zill_monitored is a Zill policy with a wearable that plans on the monitored basis (known answers)', () => {
    expect(POLICY_IDS).toContain('zill_monitored')
    expect(POLICY_IDS.filter(isZillPolicy)).toEqual(['zill_env', 'zill_full', 'zill_monitored'])
    expect(POLICY_IDS.filter(policyUsesWearable)).toEqual(['zill_full', 'zill_monitored'])
    expect(POLICY_IDS.map(policyPlanBasis)).toEqual(['tables', 'tables', 'tables', 'tables', 'monitored'])
  })

  it('a member on an acclimatisation schedule follows their own caps (bout per block-hour, cap as the plan rate); acclimatised members follow the crew layout', () => {
    for (const [date, data] of [['2025-11-26', mild], [PEAK, peak]] as const) {
      const w = createWorld(cfg({ date, trace: 'none' }), data)
      const cs = w.crews[0]
      const cp = w.plan!.crews[0]
      const ids = Object.keys(cp.memberCaps)
      expect(ids.length).toBeGreaterThan(0)
      expect([...cs.memberPlans.keys()].sort()).toEqual([...ids].sort())
      for (const ws of w.workers) {
        if (!ids.includes(ws.id)) {
          // The crew layout itself (same arrays), not a copy.
          expect(ws.layout.work).toBe(cs.planWork)
          expect(ws.layout.rate).toBe(cs.planRate)
          continue
        }
        const lay = cs.memberPlans.get(ws.id)!
        expect(ws.layout).toBe(lay)
        let work = 0
        for (const b of cp.blocks) {
          if (!b.taskId) continue
          for (const h of b.hours) {
            const cap = cp.memberCaps[ws.id].find((c) => c.startT === h.startT)!
            expect(cap.taskId).toBe(b.taskId)
            for (let m = 0; m < h.wallMin; m++) {
              const t = h.startT + m * MINUTE_MS
              if (t < w.t0 || t >= w.tEnd) continue
              const i = Math.round((t - w.t0) / MINUTE_MS)
              expect(lay.rate[i], `${date} ${ws.id} ${h.hour} +${m}`).toBe(Math.trunc(cap.workMinPerHour))
              if (m >= cap.boutMin) expect(lay.work[i]).toBe(0)
              else if (lay.work[i] === 0) expect([R_MIDDAY, R_STATUTORY]).toContain(lay.reason[i])
              // Never more work than the crew layout gives in the same block-hour minute (caps ≤ the crew rate).
              if (lay.work[i] === 1) expect(m).toBeLessThan(h.boutMin)
              work += lay.work[i]
            }
          }
        }
        // The member's scheduled work is the planner's own count for them (no midday or statutory cut on these days).
        expect(work, `${date} ${ws.id}`).toBe(cp.memberWorkMin[ws.id])
      }
    }
  })

  it('known answer (demo crew, mild day): the newcomer is scheduled 191 min against the crew layout’s more, and works only inside their own layout', () => {
    const w = createWorld(cfg({ date: '2025-11-26', trace: 'none' }), mild)
    const id = 'W-D2A1'
    const cp = w.plan!.crews[0]
    expect(cp.memberWorkMin[id]).toBe(191)
    const crewSched = w.crews[0].planWork.reduce((s, x) => s + x, 0)
    expect(crewSched).toBeGreaterThan(191)
    const ws = w.workers.find((x) => x.id === id)!
    expect(ws.layout.work.reduce((s, x) => s + x, 0)).toBe(191)
    let worked = 0
    while (worldMinutesRemaining(w) > 0) {
      const i = w.minuteIndex
      stepWorld(w, 1)
      if (ws.working && !ws.manual) {
        expect(ws.layout.work[i], `minute ${i}`).toBe(1)
        worked += 1
      }
    }
    expect(worked).toBeGreaterThan(0)
    expect(worked).toBeLessThanOrEqual(191)
  })

  it('zill_monitored: the planner plans on the monitored basis and every device gets its crew plan’s basis; where the device confirms monitoring the table cycle is not enforced and the simulator applies no table cut of its own', async () => {
    const data = await loader.load('kezad', '2025-09-20', { workforceSeed: 'zill-workforce-v1', crewsPerSite: 2, includeDemoCrew: false })
    const n = { steps: 0, monitored: 0, liftedWorking: 0, tablesSteps: 0 }
    for (const policy of ['zill_monitored', 'zill_full'] as const) {
      const w = createWorld(makeSimConfig({ siteId: 'kezad', date: '2025-09-20', seed: 'worldsim-test', policy }), data)
      expect(w.plan!.planBasis).toBe(policy === 'zill_monitored' ? 'monitored' : 'tables')
      for (const cs of w.crews) expect(cs.planBasis).toBe(w.plan!.crews.find((p) => p.crewId === cs.crew.id)!.planBasis)
      if (policy === 'zill_monitored') expect(w.plan!.crews.some((p) => p.blocks.some((b) => b.hours.some((h) => h.monitored)))).toBe(true)
      while (worldMinutesRemaining(w) > 0) {
        stepWorld(w, 1)
        for (const ws of w.workers) {
          const d = ws.detail
          if (!d) continue
          expect(d.environment.basis).toBe(ws.crew.planBasis)
          if (policy === 'zill_full') {
            expect(d.environment.enforced).toBe(true)
            n.tablesSteps += 1
            continue
          }
          n.steps += 1
          if (!d.environment.monitored) continue
          n.monitored += 1
          expect(d.environment.enforced).toBe(false)
          // Monitored: the table limit is a guide. A worker scheduled above it works on (the device's own work minutes
          // decide; the simulator's cycle follows the device, never a table of its own).
          const tableW = d.environment.workMinPerHour
          if (tableW !== null && ws.plannedRate !== null && tableW < ws.plannedRate && ws.working) {
            n.liftedWorking += 1
          }
        }
      }
    }
    expect(n.monitored).toBeGreaterThan(0)
    expect(n.liftedWorking).toBeGreaterThan(0)
    expect(n.tablesSteps).toBeGreaterThan(0)
  })

  it('shadow zill_monitored runs the device on the monitored basis without a plan (detection of monitored mode); physiology reaches the engine as in zill_full', () => {
    const w = createWorld(cfg({ policy: 'zill_monitored', shadow: true, trace: 'none' }), peak)
    expect(w.plan).toBeNull()
    expect(w.crews.every((c) => c.planBasis === 'monitored')).toBe(true)
    let monitored = 0
    while (worldMinutesRemaining(w) > 0) {
      stepWorld(w, 1)
      expect(w.workers.every((ws) => ws.detail?.environment.basis === 'monitored')).toBe(true)
      monitored += w.workers.filter((ws) => ws.detail?.environment.monitored).length
      // Nobody acts on it: the listed-order schedule, no instruction episodes.
      expect(w.workers.every((ws) => ws.rest === null && ws.cycle === null)).toBe(true)
    }
    expect(monitored).toBeGreaterThan(0)
    const withBand = w.workers.filter((ws) => ws.rosterProfile.hasWearable && ws.profile.consent.wearable)
    expect(withBand.length).toBeGreaterThan(0)
    expect(withBand.every((ws) => ws.physioActive)).toBe(true)
  })
})

/**
 * Target (docs/SIMULATION.md §3): a 30-worker site-day in under 3 s. The measured time is printed; the assertion allows
 * 1.5× for loaded runners and hybrid CPUs where the OS may schedule the test worker on an efficiency core [ENG].
 */
const PERF_TARGET_MS = 3000
const PERF_TOLERANCE = 1.5

describe('performance', () => {
  it('30 workers × a full shift (05:00–17:00), zill_full: within the 3 s target (best of 3; tolerance for slow cores)', async () => {
    const data = await loader.load('musaffah', PEAK)
    const ids = new Set(data.workers.slice(0, 30).map((w) => w.id))
    const crews = data.crews.map((c) => ({ ...c, workerIds: c.workerIds.filter((x) => ids.has(x)) })).filter((c) => c.workerIds.length > 0)
    const workers: WorkerProfile[] = data.workers.filter((w) => ids.has(w.id))
    expect(workers).toHaveLength(30)
    const times: number[] = []
    for (let k = 0; k < 3; k++) {
      const r = runSiteDay(makeSimConfig({ siteId: 'musaffah', date: PEAK, policy: 'zill_full', seed: `perf-${k}`, crews, workers }), data)
      expect(r.outcomes).toHaveLength(30)
      times.push(r.timingMs)
    }
    const best = Math.min(...times)
    console.info(
      `[worldsim perf] 30 workers × 720 min, zill_full: ${times.map((t) => t.toFixed(0)).join(' / ')} ms (best ${best.toFixed(0)} ms; target ${PERF_TARGET_MS} ms ${best < PERF_TARGET_MS ? 'met' : 'NOT met on this core'})`,
    )
    expect(best).toBeLessThan(PERF_TARGET_MS * PERF_TOLERANCE)
  }, 120_000)
})

// ─────────────────────────────── Wave 2d (sim-truth): task windows, drink logging, reminders ───────────────────────────────

describe('symmetric task windows: the listed order honours earliestStart / latestEnd (worldsim 1.3.0)', () => {
  const s0 = local(PEAK, '05:00')
  const s1 = local(PEAK, '17:00')
  /** Minutes (local HH:mm) at which the crew works each task, from the world's crew schedule. */
  const workByTask = (w: World): Map<number, number[]> => {
    const cs = w.crews[0]
    const m = new Map<number, number[]>()
    for (let i = 0; i < w.nMinutes; i++) if (cs.planWork[i] === 1) m.set(cs.planTask[i], [...(m.get(cs.planTask[i]) ?? []), w.t0 + i * MINUTE_MS])
    return m
  }
  const withTasks = (tasks: Crew['tasks']): Crew => ({ ...demo.crew, tasks })
  const [welding, maintenance] = demo.crew.tasks

  it('taskWindowMs: the task window clipped to the shift; missing or malformed bounds mean the shift bounds (known answers)', () => {
    expect(taskWindowMs({ earliestStart: '06:00', latestEnd: '10:00' }, PEAK, s0, s1)).toEqual([local(PEAK, '06:00'), local(PEAK, '10:00')])
    expect(taskWindowMs({}, PEAK, s0, s1)).toEqual([s0, s1])
    expect(taskWindowMs({ earliestStart: '04:30', latestEnd: '18:00' }, PEAK, s0, s1)).toEqual([s0, s1])
    expect(taskWindowMs({ earliestStart: '6:00', latestEnd: '25:00' }, PEAK, s0, s1)).toEqual([s0, s1])
    const [a, b] = taskWindowMs({ earliestStart: '12:00', latestEnd: '11:00' }, PEAK, s0, s1)
    expect(b).toBeLessThanOrEqual(a)
  })

  it('ban_only, site_index and shadow never schedule work outside a task window; the demo crew starts at 06:00, not 05:00', () => {
    for (const over of [{ policy: 'ban_only' as const }, { policy: 'site_index' as const }, { policy: 'zill_full' as const, shadow: true }]) {
      const w = createWorld(cfg({ ...over, trace: 'none' }), peak)
      const cs = w.crews[0]
      let first = Infinity
      for (let i = 0; i < w.nMinutes; i++) {
        if (cs.planWork[i] !== 1) continue
        const t = w.t0 + i * MINUTE_MS
        const [from, to] = taskWindowMs(cs.tasks[cs.planTask[i]], PEAK, w.t0, w.tEnd)
        expect(t).toBeGreaterThanOrEqual(from)
        expect(t).toBeLessThan(to)
        first = Math.min(first, t)
      }
      expect(first).toBe(local(PEAK, '06:00'))
      // 05:00–06:00: no task (idle), whatever the policy.
      expect(cs.planTask.slice(0, 60).every((k) => k === -1)).toBe(true)
    }
  })

  it('work-conserving listed order: an open later task fills the wait, the earlier task takes over when its window opens (known answers)', () => {
    // A: 240 min, 07:00–11:00 (time-bound); B: 120 min, 06:00–17:00.
    const A = { ...welding, durationMin: 240, earliestStart: '07:00', latestEnd: '11:00' }
    const B = { ...maintenance, durationMin: 120, earliestStart: '06:00', latestEnd: '17:00' }
    const w = createWorld(cfg({ policy: 'ban_only', trace: 'none', crews: [withTasks([A, B])], workers: demo.workers }), peak)
    const work = workByTask(w)
    const a = work.get(0) ?? []
    const b = work.get(1) ?? []
    expect(a).toHaveLength(240)
    expect(a[0]).toBe(local(PEAK, '07:00'))
    expect(a[a.length - 1]).toBe(local(PEAK, '10:59'))
    expect(b).toHaveLength(120)
    expect(b[0]).toBe(local(PEAK, '06:00'))
    expect(b.filter((t) => t < local(PEAK, '07:00'))).toHaveLength(60)
    // After 5 h of consecutive work (06:00–11:00) the statutory hour follows; B resumes at 12:00, pauses for the
    // midday break (sun task) and finishes at 15:30.
    expect(b.filter((t) => t >= local(PEAK, '11:00') && t < local(PEAK, '12:00'))).toHaveLength(0)
    expect(b[60]).toBe(local(PEAK, '12:00'))
    expect(b[b.length - 1]).toBe(local(PEAK, '15:29'))
    expect(b.some((t) => isMiddayBreak(t))).toBe(false)
  })

  it('work left when a task window closes is not done (deferred, as the planner defers it)', () => {
    const A = { ...welding, durationMin: 240, earliestStart: '06:00', latestEnd: '08:00' }
    const B = { ...maintenance, durationMin: 120, earliestStart: '06:00', latestEnd: '17:00' }
    const w = createWorld(cfg({ policy: 'ban_only', trace: 'none', crews: [withTasks([A, B])], workers: demo.workers }), peak)
    const work = workByTask(w)
    expect(work.get(0)).toHaveLength(120)
    expect(work.get(0)?.at(-1)).toBe(local(PEAK, '07:59'))
    expect(work.get(1)?.[0]).toBe(local(PEAK, '08:00'))
    expect(work.get(1)).toHaveLength(120)
  })

  it('idle minutes between task windows count toward a pending statutory break, never cancel it (known answers)', () => {
    // A: 300 min 06:00–11:00 → 5 h of consecutive work, the statutory hour is due at 11:00. B (shade, no midday pause)
    // opens at 11:10: 10 idle minutes are part of the break, B starts at 12:00, not at 11:10.
    const A = { ...maintenance, inSun: false, durationMin: 300, earliestStart: '06:00', latestEnd: '11:00' }
    const B = { ...maintenance, inSun: false, durationMin: 60, earliestStart: '11:10', latestEnd: '17:00' }
    const w = createWorld(cfg({ policy: 'ban_only', trace: 'none', crews: [withTasks([A, B])], workers: demo.workers }), peak)
    const work = workByTask(w)
    expect(work.get(0)).toHaveLength(300)
    expect(work.get(0)?.at(-1)).toBe(local(PEAK, '10:59'))
    expect(work.get(1)?.[0]).toBe(local(PEAK, '12:00'))
    expect(work.get(1)).toHaveLength(60)
    const cs = w.crews[0]
    const at = (hhmm: string): number => Math.round((local(PEAK, hhmm) - w.t0) / MINUTE_MS)
    expect(cs.planTask[at('11:05')]).toBe(-1)
    expect(cs.planWork[at('11:30')]).toBe(0)
  })

  it('without task windows the listed order is the pre-1.3.0 definition: tasks in order from the shift start', () => {
    const tasks = demo.crew.tasks.map(({ earliestStart: _e, latestEnd: _l, ...t }) => t)
    const w = createWorld(cfg({ policy: 'ban_only', trace: 'none', crews: [withTasks(tasks)], workers: demo.workers }), peak)
    const work = workByTask(w)
    // Welding (240 min) runs 05:00–09:00 without a break, then the next listed task starts at once.
    expect(work.get(0)?.[0]).toBe(local(PEAK, '05:00'))
    expect(work.get(0)?.at(-1)).toBe(local(PEAK, '08:59'))
    expect(work.get(1)?.[0]).toBe(local(PEAK, '09:00'))
  })
})

describe('drink-logging fidelity (behaviour.drinkLogging, worldsim 1.3.0)', () => {
  const throwing = { next: () => { throw new Error('no draw expected') } } as unknown as Rng
  const fixed = (u: number): Rng => ({ next: () => u }) as unknown as Rng

  it('loggedDrinkMl: logged with probability loggedFraction, recorded × overReportFactor; no draw at loggedFraction 1 (known answers)', () => {
    expect(loggedDrinkMl(250, { loggedFraction: 1, overReportFactor: 1 }, throwing)).toBe(250)
    expect(loggedDrinkMl(250, { loggedFraction: 1, overReportFactor: 1.5 }, throwing)).toBe(375)
    expect(loggedDrinkMl(250, { loggedFraction: 1, overReportFactor: 0.333 }, throwing)).toBe(83)
    expect(loggedDrinkMl(250, { loggedFraction: 0, overReportFactor: 1 }, throwing)).toBeNull()
    expect(loggedDrinkMl(0, { loggedFraction: 1, overReportFactor: 1 }, throwing)).toBeNull()
    expect(loggedDrinkMl(250, { loggedFraction: 0.5, overReportFactor: 1 }, fixed(0.49))).toBe(250)
    expect(loggedDrinkMl(250, { loggedFraction: 0.5, overReportFactor: 1 }, fixed(0.5))).toBeNull()
    const rng = createRng('drink-log')
    let n = 0
    for (let i = 0; i < 20_000; i++) if (loggedDrinkMl(250, { loggedFraction: 0.5, overReportFactor: 1 }, rng) !== null) n++
    expect(n / 20_000).toBeGreaterThan(0.48)
    expect(n / 20_000).toBeLessThan(0.52)
  })

  it('makeSimConfig defaults to 1 / 1 and merges a partial setting; createWorld rejects out-of-range values', () => {
    expect(makeSimConfig({ siteId: 'musaffah', date: PEAK }).behaviour.drinkLogging).toEqual({ loggedFraction: 1, overReportFactor: 1 })
    expect(DEFAULT_SIM_BEHAVIOUR.drinkLogging).toEqual({ loggedFraction: 1, overReportFactor: 1 })
    expect(cfg({ behaviour: { drinkLogging: { loggedFraction: 0.5 } } }).behaviour.drinkLogging).toEqual({ loggedFraction: 0.5, overReportFactor: 1 })
    for (const drinkLogging of [{ loggedFraction: 1.5 }, { loggedFraction: -0.1 }, { loggedFraction: Number.NaN }, { overReportFactor: 0 }, { overReportFactor: -1 }, { overReportFactor: Infinity }]) {
      expect(() => createWorld(cfg({ behaviour: { drinkLogging } }), peak)).toThrow(RangeError)
    }
  })

  it('only the device log changes: ban_only truth is identical, the logged volume is 50 % of drinks / ×1.5 per drink', () => {
    const run = (drinkLogging: { loggedFraction?: number; overReportFactor?: number }) => {
      const w = createWorld(cfg({ policy: 'ban_only', trace: 'none', behaviour: { drinkLogging } }), peak)
      stepWorld(w, w.nMinutes)
      return { w, r: finishWorld(w) }
    }
    const base = run({})
    const half = run({ loggedFraction: 0.5 })
    const over = run({ overReportFactor: 1.5 })
    const truthOf = (r: SiteDayResult) => r.outcomes.map((o) => [o.workerId, o.waterMl, o.maxDehydrationPct, o.maxCoreC, o.events])
    expect(truthOf(half.r)).toEqual(truthOf(base.r))
    expect(truthOf(over.r)).toEqual(truthOf(base.r))
    const logs = (r: SiteDayResult) => byKind(r.events, 'intake')
    const baseLogs = logs(base.r)
    // Every drink logged exactly by default: the log adds up to the true intake (the last minute's drink is still pending).
    for (const ws of base.w.workers) {
      const sum = baseLogs.filter((e) => e.intake.workerId === ws.id).reduce((s, e) => s + e.intake.ml, 0)
      expect(sum).toBeCloseTo(ws.truth.intakeMl + ws.pendingDrinkMl, 6)
    }
    const share = logs(half.r).length / baseLogs.length
    expect(share).toBeGreaterThan(0.35)
    expect(share).toBeLessThan(0.65)
    expect(logs(over.r).map((e) => e.intake.ml)).toEqual(baseLogs.map((e) => Math.round(e.intake.ml * 1.5)))
  })

  it('deterministic with partial logging: same result twice, chunked stepping = one call (zill_full)', () => {
    const c = cfg({ trace: 'none', behaviour: { drinkLogging: { loggedFraction: 0.5, overReportFactor: 1.5 } } })
    const a = runSiteDay(c, peak)
    expect(strip(runSiteDay(c, peak))).toEqual(strip(a))
    const w = createWorld(c, peak)
    const chunks = [1, 13, 60, 2, 240, 7]
    let k = 0
    while (worldMinutesRemaining(w) > 0) stepWorld(w, chunks[k++ % chunks.length])
    expect(strip(finishWorld(w))).toEqual(strip(a))
    expect(a.stamp).not.toBe(runSiteDay(cfg({ trace: 'none' }), peak).stamp)
    // The device sees only what was logged: the engine's log holds the over-reported volumes.
    const z = createWorld(c, peak)
    stepTo(z, '10:00')
    const logged = z.workers.flatMap((ws) => ws.engine!.intakes)
    expect(logged.length).toBeGreaterThan(0)
    for (const x of logged) expect(x.ml).toBe(375) // every drink is 250 mL, logged as 375 mL
  })

  it('a config written before worldsim 1.3.0 (no drinkLogging) logs every drink exactly', () => {
    const c = cfg({ policy: 'ban_only', trace: 'none' })
    const { drinkLogging: _dl, ...older } = c.behaviour
    const a = runSiteDay({ ...c, behaviour: older as SimConfig['behaviour'] }, peak)
    const b = runSiteDay(c, peak)
    expect(byKind(a.events, 'intake')).toEqual(byKind(b.events, 'intake'))
  })
})

describe('drink reminders: the worker responds to the reminder the device shows, at work, at rest and idle (worldsim 1.3.0)', () => {
  type Drink = NonNullable<Parameters<typeof drinkReminderShown>[1]>['drink']
  const detail = (reminder: Drink['reminder'], exposure: Drink['exposure'] = 'heat_rest'): { drink: Drink } => ({
    drink: { exposed: exposure !== null, exposure, reminder, nextReminderAtMs: reminder === 'drink' ? local(PEAK, '10:00') : null, locationWbgtEffC: 30 },
  })
  /** Spontaneous drinking off (no habitual floor, no sweat replacement): every drink is a followed reminder. */
  const remindersOnly = { behaviour: { habitualDrinkFraction: 0 }, traits: { replacementMean: 0, replacementSd: 0, replacementMin: 0, replacementMax: 0 } }
  const alainData = async (): Promise<SimData> => loader.load('alain', '2025-07-24', { crews: [{ ...demo.crew, siteId: 'alain' }], workers: demo.workers })

  it('drinkReminderShown: the device step detail decides; only policies that act on Zill deliver it (known answers)', () => {
    expect(drinkReminderShown(true, detail('drink'))).toBe(true)
    expect(drinkReminderShown(true, detail('drink', 'hot_work'))).toBe(true)
    // Shadow mode and the baselines: nobody acts on the device's output.
    expect(drinkReminderShown(false, detail('drink'))).toBe(false)
    // Fasting while exposed: rest-in-shade guidance, no drink reminder; not exposed or not due: none.
    expect(drinkReminderShown(true, detail('shade'))).toBe(false)
    expect(drinkReminderShown(true, detail(null, null))).toBe(false)
    expect(drinkReminderShown(true, detail(null))).toBe(false)
    // No engine step yet.
    expect(drinkReminderShown(true, null)).toBe(false)
  })

  it('every followed reminder falls in a minute whose device showed one; reminders reach idle and resting workers too (spontaneous drinking off)', async () => {
    const data = await alainData()
    const w = createWorld(makeSimConfig({ siteId: 'alain', date: '2025-07-24', policy: 'zill_full', seed: 'reminders-shown', trace: 'none', behaviour: { compliance: 1 } }), data, { truthParams: remindersOnly })
    const n = { shownMinutes: 0, drinks: 0, work: 0, rest: 0, idle: 0 }
    let seen = 0
    while (worldMinutesRemaining(w) > 0) {
      const shown = new Map(w.workers.map((ws) => [ws.id, drinkReminderShown(true, ws.detail)]))
      for (const v of shown.values()) if (v) n.shownMinutes += 1
      stepWorld(w, 1)
      const intakes = byKind(w.events, 'intake')
      for (const e of intakes.slice(seen)) {
        expect(e.t).toBe(w.t)
        expect(shown.get(e.intake.workerId), `${e.intake.workerId} drank without a reminder at ${new Date(e.t).toISOString()}`).toBe(true)
        expect(e.intake.ml).toBe(WORLD_PARAMS.reminderMl)
        n.drinks += 1
        n[w.workerById.get(e.intake.workerId)!.status] += 1
      }
      seen = intakes.length
    }
    expect(n.drinks).toBeGreaterThan(0)
    expect(n.drinks).toBeLessThanOrEqual(n.shownMinutes)
    // Up to worldsim 1.2.0 only workers within 30 min of hot work got reminders: none while idle before the first task,
    // none after 30 min of rest. (How much of the day this crew works depends on the plan and the device, so the
    // at-work count is not asserted here; the device's own reminder rule is tested in engine/clinical.test.ts.)
    expect(n.idle).toBeGreaterThan(0)
    expect(n.rest).toBeGreaterThan(0)
  })

  it('a reminder left on screen (nothing logged) is followed at most once per 20 min, not every minute', async () => {
    const data = await alainData()
    // loggedFraction 0: the device never sees a drink, so once due its reminder stays on screen while exposed.
    const w = createWorld(
      makeSimConfig({ siteId: 'alain', date: '2025-07-24', policy: 'zill_full', seed: 'reminders-left', trace: 'none', behaviour: { compliance: 1, drinkLogging: { loggedFraction: 0 } } }),
      data,
      { truthParams: remindersOnly },
    )
    const followed = new Map<string, number[]>()
    let shownWithin = 0
    while (worldMinutesRemaining(w) > 0) {
      for (const ws of w.workers) if (drinkReminderShown(true, ws.detail) && w.t - ws.lastFollowedReminderT < 20 * MINUTE_MS) shownWithin += 1
      stepWorld(w, 1)
      for (const ws of w.workers) if (ws.lastFollowedReminderT === w.t) followed.set(ws.id, [...(followed.get(ws.id) ?? []), w.t])
    }
    expect(byKind(w.events, 'intake')).toHaveLength(0) // nothing logged
    expect(shownWithin).toBeGreaterThan(0) // the rule was exercised: the reminder stayed on screen after a followed drink
    let n = 0
    for (const [id, ts] of followed) {
      for (let k = 1; k < ts.length; k++) expect(ts[k] - ts[k - 1], id).toBeGreaterThanOrEqual(20 * MINUTE_MS)
      // Every true drink is a followed reminder (spontaneous drinking off): 250 mL each.
      const ws = w.workerById.get(id)!
      expect(ws.truth.intakeMl + ws.pendingDrinkMl).toBe(250 * ts.length)
      n += ts.length
    }
    expect(n).toBeGreaterThan(0)
  })

  it('with spontaneous drinking off, nobody drinks under ban_only or shadow mode: no device reminder reaches the worker', async () => {
    const data = await alainData()
    for (const over of [{ policy: 'ban_only' as const }, { policy: 'zill_full' as const, shadow: true }]) {
      const w = createWorld(makeSimConfig({ siteId: 'alain', date: '2025-07-24', seed: 'reminders-shown', trace: 'none', behaviour: { compliance: 1 }, ...over }), data, { truthParams: remindersOnly })
      stepWorld(w, w.nMinutes)
      expect(byKind(w.events, 'intake')).toHaveLength(0)
    }
  })

  it('idle workers in a shade rest area get reminders and drink more than under ban_only (same random numbers)', async () => {
    // Al Ain has a shade rest area; the demo crew's task windows open at 06:00, so 05:00–06:00 is idle in hot shade.
    const crew: Crew = { ...demo.crew, siteId: 'alain' }
    const data = await loader.load('alain', '2025-07-24', { crews: [crew], workers: demo.workers })
    const drinksBefore6 = (policy: 'ban_only' | 'zill_full'): number => {
      const w = createWorld(makeSimConfig({ siteId: 'alain', date: '2025-07-24', policy, seed: 'reminders-idle', trace: 'none' }), data)
      stepTo(w, '06:00')
      expect(w.workers.every((ws) => ws.status === 'idle' && ws.location === 'shade')).toBe(true)
      return byKind(w.events, 'intake').length
    }
    expect(drinksBefore6('zill_full')).toBeGreaterThan(drinksBefore6('ban_only'))
  })
})
