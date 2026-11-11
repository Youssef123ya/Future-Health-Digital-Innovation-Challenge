/**
 * Scenario sanity check of the closed loop (integration aid; docs/dev/wave2c-integration.md, wave2d-integration.md):
 * runs named scenarios minute by minute under one or more policies and classifies every on-shift worker-minute from the
 * world's own state.
 *
 *   npx tsx scripts/validate/scenario-sanity.ts [--policy=zill_full,zill_monitored] [--json] [peak-day mild-day ...]
 * Defaults: every scenario (sim/scenarios.ts SCENARIO_IDS) under zill_full and zill_monitored.
 *
 * Shares are of on-shift worker-minutes (evacuated minutes excluded):
 * - work: the worker works a task; idle: no task assigned (status 'idle'); rest: any other non-work minute;
 * - rest episode: resting in a followed or enforced engine rest episode, split by the device state the decision used
 *   (the one before the minute): the device asks for rest (stop or a rest action) — of which the engine holds it with a
 *   task hold (regulation/environment stop of the task to resume, risk.ts TaskHold) or a projection hold (ISO 7933
 *   resume check, ProjectionHold) — or 'other': the device neither asks for rest nor holds (must be 0 since worldsim
 *   1.4.0: the engine owns every resume decision, the simulator keeps no resume rule of its own);
 * - projection hold / task hold: the device's hold is active after the step (WorkerStepDetail.resume.heldBy);
 * - monitored: monitored mode is in force on the device (WorkerStepDetail.environment.monitored; zill_monitored only);
 * - dehydration-blocked: a pending ISO 7933 recovery review is blocked by the water-loss limit (phsRecovery.blockedBy);
 * - task not feasible now: no release now for the task to resume (rest estimate beyond 60 min, or the acclimatisation
 *   budget used up).
 * Alarms per worker: metrics.ts alarmTimesByBasis — individual alarms at ≥ high / ≥ stop, exposure advisories at ≥ high
 * (worker-scope alerts that never became individual) and suppressed advisories (logged under designed suppression,
 * never notified). Members on caps: workers who follow their own per-member plan layout (CrewPlan.memberCaps).
 * Evidence class: SIMULATED. Numbers describe the model, never measured outcomes.
 */
import { RISK_ORDER, type ActionId, type RiskAssessment } from '../../src/engine/types'
import { alarmTimesByBasis } from '../../src/sim/metrics'
import { createScenarioWorld, getScenario, loadScenarioData, SCENARIO_IDS, type ScenarioId } from '../../src/sim/scenarios'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import { POLICY_IDS, type PolicyId } from '../../src/sim/types'
import { finishWorld, stepWorld, worldMinutesRemaining } from '../../src/sim/worldsim'
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
  /** Workers who follow their own per-member plan layout, and their scheduled work minutes per worker. */
  membersOnCaps: number
  memberScheduledMinPerMember: number | null
  shares: {
    work: number
    idle: number
    rest: number
    restEpisode: number
    restEpisodeDeviceAsks: number
    restEpisodeTaskHeld: number
    restEpisodeProjectionHeld: number
    restEpisodeOther: number
    projectionHold: number
    taskHold: number
    monitored: number
    dehydrationBlocked: number
    taskNotFeasible: number
  }
  alarmsPerWorker: { individualHighPlus: number; individualStopPlus: number; exposureHighPlus: number; suppressedHighPlus: number }
  intakeLPerWorker: number
  workMinPerWorker: number
  /** Plan warning codes of the day plan (null without a plan). */
  planWarnings: string[] | null
}

/** Run one scenario minute by minute and classify every on-shift worker-minute (definitions in the file header). */
export async function scenarioSanity(id: ScenarioId, policy: PolicyId = 'zill_full'): Promise<ScenarioSanity> {
  const data = await loadScenarioData(id, createNodeSimDataLoader())
  const w = createScenarioWorld(id, data, { policy, trace: 'none' })
  const c = { n: 0, work: 0, idle: 0, rest: 0, ep: 0, asks: 0, epTask: 0, epProj: 0, other: 0, hold: 0, taskHold: 0, mon: 0, dehyd: 0, infeasible: 0 }
  const members = w.workers.filter((ws) => ws.crew.memberPlans.has(ws.id))
  const memberSched = members.reduce((s, ws) => s + ws.layout.work.reduce((a, x) => a + x, 0), 0)
  while (worldMinutesRemaining(w) > 0) {
    const before = new Map(w.workers.map((ws) => [ws.id, { a: ws.assessment, heldBy: ws.detail?.resume?.heldBy ?? [] }]))
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
        const heldBy = p?.heldBy ?? []
        if (asksRest(p?.a ?? null) || heldBy.length > 0) {
          c.asks += 1
          if (heldBy.some((h) => h === 'regulation' || h === 'environment')) c.epTask += 1
          if (heldBy.includes('projection')) c.epProj += 1
        } else c.other += 1
      }
      const heldNow = ws.detail?.resume?.heldBy ?? []
      if (heldNow.includes('projection')) c.hold += 1
      if (heldNow.some((h) => h === 'regulation' || h === 'environment')) c.taskHold += 1
      if (ws.detail?.environment?.monitored) c.mon += 1
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
    membersOnCaps: members.length,
    memberScheduledMinPerMember: members.length > 0 ? Math.round((10 * memberSched) / members.length) / 10 : null,
    shares: {
      work: sh(c.work),
      idle: sh(c.idle),
      rest: sh(c.rest),
      restEpisode: sh(c.ep),
      restEpisodeDeviceAsks: sh(c.asks),
      restEpisodeTaskHeld: sh(c.epTask),
      restEpisodeProjectionHeld: sh(c.epProj),
      restEpisodeOther: sh(c.other),
      projectionHold: sh(c.hold),
      taskHold: sh(c.taskHold),
      monitored: sh(c.mon),
      dehydrationBlocked: sh(c.dehyd),
      taskNotFeasible: sh(c.infeasible),
    },
    alarmsPerWorker: { individualHighPlus: per(count(hi.individual)), individualStopPlus: per(count(st.individual)), exposureHighPlus: per(count(hi.exposure)), suppressedHighPlus: per(count(hi.suppressed)) },
    intakeLPerWorker: n > 0 ? Math.round(r.outcomes.reduce((s, o) => s + o.waterMl, 0) / n / 10) / 100 : 0,
    workMinPerWorker: n > 0 ? Math.round((10 * r.outcomes.reduce((s, o) => s + o.workMin, 0)) / n) / 10 : 0,
    planWarnings: w.plan ? [...new Set(w.plan.warnings.map((x) => x.code))].sort() : null,
  }
}

/** Markdown table of scenario results (pure). */
export function renderSanity(out: readonly ScenarioSanity[]): string {
  const rows = [
    '| scenario | policy | work % | idle % | rest % | rest episode % (device asks: task-held / projection-held; other) | task hold % | projection hold % | monitored % | dehydration-blocked % | not feasible % | individual HIGH+ /worker | individual STOP+ /worker | exposure advisories HIGH+ /worker | suppressed HIGH+ /worker | members on caps (scheduled min each) | work min/worker | intake L/worker |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const s of out) {
    const x = s.shares
    const a = s.alarmsPerWorker
    rows.push(
      `| ${s.scenario} | ${s.policy} | ${x.work} | ${x.idle} | ${x.rest} | ${x.restEpisode} (${x.restEpisodeDeviceAsks}: ${x.restEpisodeTaskHeld} / ${x.restEpisodeProjectionHeld}; ${x.restEpisodeOther}) | ${x.taskHold} | ${x.projectionHold} | ${x.monitored} | ${x.dehydrationBlocked} | ${x.taskNotFeasible} | ${a.individualHighPlus} | ${a.individualStopPlus} | ${a.exposureHighPlus} | ${a.suppressedHighPlus} | ${s.membersOnCaps}${s.memberScheduledMinPerMember === null ? '' : ` (${s.memberScheduledMinPerMember})`} | ${s.workMinPerWorker} | ${s.intakeLPerWorker} |`,
    )
  }
  return rows.join('\n')
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const policies = (args.find((a) => a.startsWith('--policy='))?.slice(9) ?? 'zill_full,zill_monitored').split(',').filter((p): p is PolicyId => (POLICY_IDS as readonly string[]).includes(p))
  const ids = args.filter((a): a is ScenarioId => (SCENARIO_IDS as readonly string[]).includes(a))
  const run = async (): Promise<void> => {
    const out: ScenarioSanity[] = []
    for (const id of ids.length ? ids : SCENARIO_IDS) {
      for (const policy of policies) {
        const t0 = performance.now()
        const s = await scenarioSanity(id, policy)
        out.push(s)
        if (!args.includes('--json')) console.log(`[sanity] ${id} (${getScenario(id).siteId} ${getScenario(id).date}, ${s.workers} workers, ${policy}) ${((performance.now() - t0) / 1000).toFixed(1)} s; plan warnings: ${(s.planWarnings ?? []).join(', ') || '—'}`)
      }
    }
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 1))
    else console.log(renderSanity(out))
  }
  run().catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
}
