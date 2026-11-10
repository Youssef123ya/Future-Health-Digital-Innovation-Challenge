/**
 * Scenario sanity check of the closed loop (integration aid; docs/dev/wave2c-integration.md): runs named scenarios
 * minute by minute under one policy and classifies every on-shift worker-minute from the world's own state.
 *
 *   npx tsx scripts/validate/scenario-sanity.ts [--policy=zill_full] [--json] [peak-day mild-day shade-only ...]
 *
 * Shares are of on-shift worker-minutes (evacuated minutes excluded):
 * - work: the worker works a task; idle: no task assigned (status 'idle'); rest: any other non-work minute;
 * - rest episode: resting in a followed or enforced engine rest episode, split by the device assessment the decision
 *   used (the one before the minute):
 *   - device asks for rest (stop or a rest action);
 *   - rule-held: the device no longer asks for rest, but its own assessment of the resume task (risk.assessSnapshot)
 *     is stopped by the regulation or environment channel (worldsim resumeTaskAllowed);
 *   - other: neither (should be 0: the simulator keeping a worker resting on its own account);
 * - projection hold: the device's projection hold is active (risk.ts ProjectionHold);
 * - dehydration-blocked: a pending ISO 7933 recovery review is blocked by the water-loss limit (phsRecovery.blockedBy);
 * - task not feasible now: the hold's rest estimate says even 60 min of rest would not pass the resume check.
 * Alarms per worker: metrics.ts alarmTimesByBasis — individual alarms at ≥ high / ≥ stop, exposure advisories at ≥ high
 * (worker-scope alerts that never became individual).
 * Evidence class: SIMULATED. Numbers describe the model, never measured outcomes.
 */
import { assessSnapshot } from '../../src/engine/risk'
import { RISK_ORDER, type ActionId, type RiskAssessment } from '../../src/engine/types'
import { alarmTimesByBasis } from '../../src/sim/metrics'
import { createScenarioWorld, getScenario, loadScenarioData, SCENARIO_IDS, type ScenarioId } from '../../src/sim/scenarios'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import type { PolicyId } from '../../src/sim/types'
import { finishWorld, stepWorld, worldMinutesRemaining, type World, type WorkerSim } from '../../src/sim/worldsim'
import { isMainModule } from './lib/io'

/** Same rule as worldsim.ts needsRest: the device asks for a stop or rest now. */
const REST_ACTIONS: readonly ActionId[] = ['stop_work', 'rest_shade_now', 'midday_break']
const asksRest = (a: RiskAssessment | null): boolean => a !== null && (RISK_ORDER[a.level] >= RISK_ORDER.stop || a.actions.some((x) => REST_ACTIONS.includes(x)))

/** Result of one scenario run. */
export interface ScenarioSanity {
  scenario: ScenarioId
  policy: PolicyId
  workers: number
  workerMinutes: number
  shares: {
    work: number
    idle: number
    rest: number
    restEpisode: number
    restEpisodeDeviceAsks: number
    restEpisodeRuleHeld: { regulation: number; environment: number }
    restEpisodeOther: number
    projectionHold: number
    dehydrationBlocked: number
    taskNotFeasible: number
  }
  alarmsPerWorker: { individualHighPlus: number; individualStopPlus: number; exposureHighPlus: number }
  intakeLPerWorker: number
  workMinPerWorker: number
}

/** Which rule channel stops the resume task in the device's own snapshot (null: none). Mirrors worldsim resumeTaskAllowed. */
function ruleBlocking(w: World, ws: WorkerSim, i: number, ti: number, engine: WorkerSim['engine'], heat: World['heat'], env: World['env'], net: boolean): 'regulation' | 'environment' | null {
  const task = ws.resumeTask
  if (!task || !heat || !engine) return null
  const scheduled = ws.crew.planTask[i] >= 0 && ws.crew.tasks[ws.crew.planTask[i]].id === task.id
  const location = ws.manual ? ws.manual.location : scheduled ? (ws.crew.planSun[i] === 1 ? 'sun' : 'shade') : task.inSun ? 'sun' : 'shade'
  const snap = assessSnapshot({ now: ti, profile: ws.profile, task, location, heat, env: env ?? undefined, pack: w.pack, network: net ? 'offline' : 'online', buddyAssigned: true, restArea: w.site.restArea, resumeTask: task }, engine)
  const at = (ch: 'regulation' | 'environment'): boolean => snap.channels.some((c) => c.channel === ch && RISK_ORDER[c.level] >= RISK_ORDER.stop)
  return at('regulation') ? 'regulation' : at('environment') ? 'environment' : null
}

/** Run one scenario minute by minute and classify every on-shift worker-minute (definitions in the file header). */
export async function scenarioSanity(id: ScenarioId, policy: PolicyId = 'zill_full'): Promise<ScenarioSanity> {
  const data = await loadScenarioData(id, createNodeSimDataLoader())
  const w = createScenarioWorld(id, data, { policy, trace: 'none' })
  const c = { n: 0, work: 0, idle: 0, rest: 0, ep: 0, asks: 0, reg: 0, env: 0, other: 0, hold: 0, dehyd: 0, infeasible: 0 }
  while (worldMinutesRemaining(w) > 0) {
    const i = w.minuteIndex
    const ti = w.t
    const heat = w.heat
    const env = w.env
    const net = w.networkDown
    const before = new Map(w.workers.map((ws) => [ws.id, { a: ws.assessment, engine: ws.engine }]))
    stepWorld(w, 1)
    for (const ws of w.workers) {
      if (ws.evacuated) continue
      c.n += 1
      if (ws.working) c.work += 1
      else if (ws.status === 'idle') c.idle += 1
      else c.rest += 1
      if (ws.rest !== null && (ws.rest.followed || ws.rest.enforced) && !ws.working) {
        c.ep += 1
        const p = before.get(ws.id)
        if (asksRest(p?.a ?? null)) c.asks += 1
        else {
          const rule = ruleBlocking(w, ws, i, ti, p?.engine ?? null, heat, env, net)
          if (rule === 'regulation') c.reg += 1
          else if (rule === 'environment') c.env += 1
          else c.other += 1
        }
      }
      if (ws.engine?.projectionHold) c.hold += 1
      if (ws.detail?.phsRecovery?.blockedBy === 'dehydration') c.dehyd += 1
      if (ws.detail?.resume?.infeasibleNow) c.infeasible += 1
    }
  }
  const r = finishWorld(w)
  const hi = alarmTimesByBasis(r.events, 'high')
  const st = alarmTimesByBasis(r.events, 'stop')
  const count = (m: Map<string, number[]>): number => [...m.values()].reduce((s, x) => s + x.length, 0)
  const n = r.outcomes.length
  const sh = (x: number): number => (c.n > 0 ? Math.round((1000 * x) / c.n) / 10 : 0)
  const per = (x: number): number => (n > 0 ? Math.round((100 * x) / n) / 100 : 0)
  return {
    scenario: id,
    policy,
    workers: n,
    workerMinutes: c.n,
    shares: {
      work: sh(c.work),
      idle: sh(c.idle),
      rest: sh(c.rest),
      restEpisode: sh(c.ep),
      restEpisodeDeviceAsks: sh(c.asks),
      restEpisodeRuleHeld: { regulation: sh(c.reg), environment: sh(c.env) },
      restEpisodeOther: sh(c.other),
      projectionHold: sh(c.hold),
      dehydrationBlocked: sh(c.dehyd),
      taskNotFeasible: sh(c.infeasible),
    },
    alarmsPerWorker: { individualHighPlus: per(count(hi.individual)), individualStopPlus: per(count(st.individual)), exposureHighPlus: per(count(hi.exposure)) },
    intakeLPerWorker: n > 0 ? Math.round(r.outcomes.reduce((s, o) => s + o.waterMl, 0) / n / 10) / 100 : 0,
    workMinPerWorker: n > 0 ? Math.round((10 * r.outcomes.reduce((s, o) => s + o.workMin, 0)) / n) / 10 : 0,
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const policy = (args.find((a) => a.startsWith('--policy='))?.slice(9) ?? 'zill_full') as PolicyId
  const ids = args.filter((a): a is ScenarioId => (SCENARIO_IDS as readonly string[]).includes(a))
  const run = async (): Promise<void> => {
    const out: ScenarioSanity[] = []
    for (const id of ids.length ? ids : (['peak-day', 'mild-day', 'shade-only'] as ScenarioId[])) {
      const t0 = performance.now()
      const s = await scenarioSanity(id, policy)
      out.push(s)
      if (!args.includes('--json')) console.log(`[sanity] ${id} (${getScenario(id).siteId} ${getScenario(id).date}, ${s.workers} workers, ${policy}) ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    }
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 1))
    else {
      console.log('| scenario | work % | idle % | rest % | rest episode % (device asks; rule-held regulation/environment; other) | projection hold % | dehydration-blocked % | not feasible % | individual HIGH+ /worker | individual STOP+ /worker | exposure advisories HIGH+ /worker | work min/worker | intake L/worker |')
      console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
      for (const s of out) {
        const x = s.shares
        const a = s.alarmsPerWorker
        console.log(
          `| ${s.scenario} | ${x.work} | ${x.idle} | ${x.rest} | ${x.restEpisode} (${x.restEpisodeDeviceAsks}; ${x.restEpisodeRuleHeld.regulation}/${x.restEpisodeRuleHeld.environment}; ${x.restEpisodeOther}) | ${x.projectionHold} | ${x.dehydrationBlocked} | ${x.taskNotFeasible} | ${a.individualHighPlus} | ${a.individualStopPlus} | ${a.exposureHighPlus} | ${s.workMinPerWorker} | ${s.intakeLPerWorker} |`,
        )
      }
    }
  }
  run().catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
}
