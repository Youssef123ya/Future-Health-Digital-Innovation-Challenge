/**
 * What drives the Zill arms' work cost (integration analysis, wave 2c): on the base-case days of a cohort report, the
 * midday-ban-only arm and the Zill (with wearable) arm are re-run with the report's own spec, and every worker-minute is
 * attributed:
 * 1. Plan level (planner.planDay on the forecast, as scheduled by worldsim): the crew job (Σ task durations), the work the
 *    plan schedules, the work it leaves unscheduled (deferred: no hour allows the task; incomplete: not enough hours at
 *    the allowed rates), and the scheduled wall minutes by what set each block-hour's work minutes (BlockHour.limitedBy:
 *    none, NIOSH/ACGIH, the rule pack's TWL zone cycle, the ISO 7933 screen), with the mean allowed rate by work class
 *    and effective WBGT band at the work location.
 * 2. Execution level (zill_full, minute by minute): each scheduled work minute is worked, or lost to an engine rest
 *    episode (by the channel that raised it), the device's work/rest cycle, first aid or an evacuation.
 * 3. Binding worker: the planner plans each crew for its strictest member (NIOSH RAL and the pack's next-stricter tier
 *    when any member is not acclimatised or is in conservative mode; planner.ts bindingOf). A counterfactual plan for
 *    the same crew without those members shows how much of the plan's work cost that crew-wide binding carries. It is
 *    an analysis only: the counterfactual is never used by the simulation.
 * Numbers are printed and written to docs/dev/work-cost-drivers.md (generated; nothing typed by hand).
 *
 *   npx tsx scripts/validate/work-cost-drivers.ts [--report=public/data/validation/cohort.json] [--out=docs/dev/work-cost-drivers.md]
 *
 * Evidence class: SIMULATED. It explains the model's numbers; it does not measure anything.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { conservativeMode } from '../../src/engine/clinical'
import { assessAcclimatization } from '../../src/engine/limits'
import { RISK_ORDER, type RiskAssessment } from '../../src/engine/types'
import { simConfigFor, type CohortDay, type CohortSpec, type VariantSpec } from '../../src/sim/backtest'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import { createWorld, runSiteDay, stepWorld, worldMinutesRemaining } from '../../src/sim/worldsim'
import { mdTable } from './lib/docs'
import { isMainModule, repoPath } from './lib/io'

const BASE: VariantSpec = { id: 'base', group: 'base', factor: 'base', label: 'Base case', value: 'default', arms: ['ban_only', 'zill_full'], strata: ['hot', 'median', 'mild'] }
const PRIORITY = ['symptoms', 'physiology', 'hydration', 'projection', 'regulation', 'environment'] as const
const WBGT_BANDS: readonly [number, number, string][] = [
  [-Infinity, 28, '< 28 °C'],
  [28, 30, '28–30 °C'],
  [30, 32, '30–32 °C'],
  [32, 33, '32–33 °C'],
  [33, Infinity, '≥ 33 °C'],
]

/** The channel that raised a rest episode: the highest-priority channel at ≥ stop, else 'midday break' / 'other'. */
function episodeChannel(a: RiskAssessment | null): string {
  if (!a) return 'other'
  const at = a.channels.filter((c) => RISK_ORDER[c.level] >= RISK_ORDER.stop).map((c) => c.channel)
  return PRIORITY.find((c) => at.includes(c)) ?? (a.actions.includes('midday_break') ? 'regulation' : 'other')
}

interface Acc {
  workerShifts: number
  banWork: number
  job: number
  planned: number
  unscheduledDeferred: number
  unscheduledIncomplete: number
  delivered: number
  lost: Record<string, number>
  wallBy: Record<string, number>
  workBy: Record<string, number>
  rate: Record<string, { wall: number; work: number }>
  /** Crew-days by binding limit; members that bind the crew (not acclimatised or conservative) and crew size. */
  bindingRal: number
  crewDays: number
  bindingMembers: number
  crewMembers: number
  /** Counterfactual: scheduled work per worker of the crews planned without their binding members (crews with any left). */
  cfCrewDays: number
  cfPlannedPerWorker: number
  cfActualPlannedPerWorker: number
}
const newAcc = (): Acc => ({
  workerShifts: 0,
  banWork: 0,
  job: 0,
  planned: 0,
  unscheduledDeferred: 0,
  unscheduledIncomplete: 0,
  delivered: 0,
  lost: {},
  wallBy: {},
  workBy: {},
  rate: {},
  bindingRal: 0,
  crewDays: 0,
  bindingMembers: 0,
  crewMembers: 0,
  cfCrewDays: 0,
  cfPlannedPerWorker: 0,
  cfActualPlannedPerWorker: 0,
})
const add = (m: Record<string, number>, k: string, x: number): void => {
  m[k] = (m[k] ?? 0) + x
}

/** Run the attribution on the report's base days; returns accumulators per stratum and overall. */
export async function workCostDrivers(report: { spec: CohortSpec; days: CohortDay[] }, log = true): Promise<Record<string, Acc>> {
  const spec = report.spec
  const loader = createNodeSimDataLoader()
  const acc: Record<string, Acc> = { all: newAcc(), hot: newAcc(), median: newAcc(), mild: newAcc() }
  for (const day of report.days) {
    const data = await loader.load(day.siteId, day.date, { workforceSeed: spec.workforceSeed, crewsPerSite: spec.crewsPerSite, includeDemoCrew: spec.includeDemoCrew })
    const targets = [acc.all, acc[day.stratum]]
    const ban = runSiteDay(simConfigFor(spec, day, BASE, 'ban_only'), data)
    for (const a of targets) {
      a.workerShifts += ban.outcomes.length
      a.banWork += ban.outcomes.reduce((s, o) => s + o.workMin, 0)
    }
    const w = createWorld(simConfigFor(spec, day, BASE, 'zill_full'), data)
    // Plan level, per worker (crew minutes × crew size).
    for (const cs of w.crews) {
      const n = cs.crew.workerIds.length
      const cp = w.plan?.crews.find((p) => p.crewId === cs.crew.id)
      const job = cs.crew.tasks.reduce((s, t) => s + t.durationMin, 0)
      let planned = 0
      for (let i = 0; i < w.nMinutes; i++) planned += cs.planWork[i]
      // Binding worker and the counterfactual plan without the members who bind the crew to the stricter limit.
      const byId = new Map(data.workers.map((x) => [x.id, x]))
      const binders = cs.crew.workerIds.filter((id) => {
        const prof = byId.get(id)
        return !prof || assessAcclimatization(prof).status !== 'acclimatized' || conservativeMode(prof).conservative
      })
      const rest = cs.crew.workerIds.filter((id) => !binders.includes(id))
      let cfPlanned: number | null = null
      if (rest.length > 0) {
        const crew = { ...cs.crew, workerIds: rest }
        const cf = createWorld({ ...simConfigFor(spec, day, BASE, 'zill_full'), crews: [crew], workers: rest.map((id) => byId.get(id)!) }, data)
        cfPlanned = 0
        for (let i = 0; i < cf.nMinutes; i++) cfPlanned += cf.crews[0].planWork[i]
      }
      for (const a of targets) {
        a.crewDays += 1
        if (cp?.binding.limit === 'RAL') a.bindingRal += 1
        a.bindingMembers += binders.length
        a.crewMembers += n
        if (cfPlanned !== null) {
          a.cfCrewDays += 1
          a.cfPlannedPerWorker += cfPlanned
          a.cfActualPlannedPerWorker += planned
        }
        a.job += job * n
        a.planned += planned * n
        for (const u of cp?.unscheduled ?? []) {
          if (u.reason === 'deferred') a.unscheduledDeferred += (u.requiredMin - u.scheduledMin) * n
          else if (u.reason === 'incomplete') a.unscheduledIncomplete += (u.requiredMin - u.scheduledMin) * n
        }
      }
      for (const b of cp?.blocks ?? []) {
        if (!b.taskId) continue
        const task = cs.crew.tasks.find((t) => t.id === b.taskId)
        for (const h of b.hours) {
          const band = WBGT_BANDS.find(([lo, hi]) => h.wbgtWorkEffC >= lo && h.wbgtWorkEffC < hi)?.[2] ?? '?'
          for (const a of targets) {
            add(a.wallBy, h.limitedBy, h.wallMin * n)
            add(a.workBy, h.limitedBy, h.workMin * n)
            const k = `${task?.workClass ?? '?'}|${band}`
            const r = a.rate[k] ?? (a.rate[k] = { wall: 0, work: 0 })
            r.wall += h.wallMin * n
            r.work += h.workMin * n
          }
        }
      }
    }
    // Execution level.
    const epCh = new Map<string, string>()
    while (worldMinutesRemaining(w) > 0) {
      const prev = new Map(w.workers.map((ws) => [ws.id, { a: ws.assessment, rest: ws.rest }]))
      stepWorld(w, 1)
      const i = w.minuteIndex - 1
      for (const ws of w.workers) {
        const p = prev.get(ws.id)
        if (ws.rest && ws.rest !== p?.rest) epCh.set(ws.id, episodeChannel(p?.a ?? null))
        if (ws.manual || ws.crew.planWork[i] !== 1) continue
        let why: string
        if (ws.evacuated) why = 'evacuated'
        else if (ws.working) why = 'worked'
        else if (ws.firstAid && ws.firstAid.startedT !== null) why = 'first aid'
        else if (ws.rest && (ws.rest.followed || ws.rest.enforced)) why = `rest episode: ${epCh.get(ws.id) ?? 'other'}`
        else if (ws.cycle?.followed) why = 'device work/rest cycle'
        else why = 'other'
        for (const a of targets) {
          if (why === 'worked') a.delivered += 1
          else add(a.lost, why, 1)
        }
      }
    }
    if (log) console.log(`[drivers] ${day.siteId} ${day.date} (${day.stratum}) done`)
  }
  return acc
}

/** Markdown of the attribution (pure). */
export function renderDrivers(acc: Record<string, Acc>, source: string): string {
  const per = (a: Acc, x: number): string => (a.workerShifts > 0 ? (x / a.workerShifts).toFixed(1) : '—')
  const out: string[] = []
  out.push('# What drives the Zill work cost (simulated cohort, base case)')
  out.push('')
  out.push(
    `Generated by \`npx tsx scripts/validate/work-cost-drivers.ts\` from the base-case days and spec of \`${source}\`; the midday-ban-only and Zill (with wearable) arms are re-run with the same seed. Minutes per worker-shift. Simulated: it explains the model's numbers, it measures nothing.`,
  )
  out.push('', '## 1. From the crew job to delivered work', '')
  out.push(
    mdTable(
      ['Stratum', 'Worker-shifts', 'Midday ban only: work delivered', 'Crew job (Σ task durations)', 'Zill plan: scheduled work', 'Plan: unscheduled, deferred', 'Plan: unscheduled, incomplete', 'Zill: work delivered', 'Scheduled but not worked'],
      ['all', 'hot', 'median', 'mild'].map((k) => {
        const a = acc[k]
        const lost = Object.values(a.lost).reduce((s, x) => s + x, 0)
        return [k, a.workerShifts, per(a, a.banWork), per(a, a.job), per(a, a.planned), per(a, a.unscheduledDeferred), per(a, a.unscheduledIncomplete), per(a, a.delivered), per(a, lost)]
      }),
    ),
  )
  out.push('', '## 2. Scheduled work minutes not worked, by cause (Zill with wearable)', '')
  const causes = [...new Set(Object.values(acc).flatMap((a) => Object.keys(a.lost)))].sort()
  out.push(mdTable(['Stratum', ...causes], ['all', 'hot', 'median', 'mild'].map((k) => [k, ...causes.map((c) => per(acc[k], acc[k].lost[c] ?? 0))])))
  out.push('', '## 3. Plan block-hours by what set the work minutes', '')
  out.push('Wall minutes in task blocks and the work minutes planned in them, per worker-shift; work share = work ÷ wall.', '')
  const lims = ['none', 'niosh_acgih', 'rule_pack', 'phs']
  out.push(
    mdTable(
      ['Stratum', ...lims.flatMap((l) => [`${l}: wall`, `${l}: work share`])],
      ['all', 'hot', 'median', 'mild'].map((k) => {
        const a = acc[k]
        return [k, ...lims.flatMap((l) => [per(a, a.wallBy[l] ?? 0), (a.wallBy[l] ?? 0) > 0 ? `${((100 * (a.workBy[l] ?? 0)) / (a.wallBy[l] as number)).toFixed(0)} %` : '—'])]
      }),
    ),
  )
  out.push('', '## 4. Binding worker: crew-wide stricter limit', '')
  out.push(
    'The planner plans each crew for its strictest member: the NIOSH RAL and the pack\'s next-stricter work/rest tier when any member is not acclimatised or is in conservative mode (planner.ts bindingOf). Counterfactual (analysis only, never simulated): the same crew planned without those members; scheduled work per worker, mean over crew-days with members left.',
    '',
  )
  out.push(
    mdTable(
      ['Stratum', 'Crew-days', 'Bound to the RAL', 'Binding members / crew members', 'Plan: scheduled work per worker', 'Counterfactual plan without binding members', 'Crew-days in the counterfactual'],
      ['all', 'hot', 'median', 'mild'].map((k) => {
        const a = acc[k]
        return [
          k,
          a.crewDays,
          a.bindingRal,
          `${a.bindingMembers} / ${a.crewMembers}`,
          a.cfCrewDays > 0 ? (a.cfActualPlannedPerWorker / a.cfCrewDays).toFixed(1) : '—',
          a.cfCrewDays > 0 ? (a.cfPlannedPerWorker / a.cfCrewDays).toFixed(1) : '—',
          a.cfCrewDays,
        ]
      }),
    ),
  )
  out.push('', '## 5. Planned work rate by work class and effective WBGT at the work location (all strata)', '')
  out.push('Mean planned work minutes per hour in task block-hours (Σ work ÷ Σ wall × 60), with the wall minutes per worker-shift in brackets.', '')
  const classes = [...new Set(Object.keys(acc.all.rate).map((k) => k.split('|')[0]))].sort()
  out.push(
    mdTable(
      ['Work class', ...WBGT_BANDS.map((b) => b[2])],
      classes.map((c) => [
        c,
        ...WBGT_BANDS.map(([, , label]) => {
          const r = acc.all.rate[`${c}|${label}`]
          return r && r.wall > 0 ? `${((60 * r.work) / r.wall).toFixed(0)} (${per(acc.all, r.wall)})` : '—'
        }),
      ]),
    ),
  )
  out.push('')
  return out.join('\n')
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name: string, dflt: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
  const path = (p: string): string => (isAbsolute(p) ? p : repoPath(p))
  const src = arg('report', 'public/data/validation/cohort.json')
  const report = JSON.parse(readFileSync(path(src), 'utf8')) as { spec: CohortSpec; days: CohortDay[] }
  workCostDrivers(report)
    .then((acc) => {
      const md = renderDrivers(acc, src)
      const out = arg('out', 'docs/dev/work-cost-drivers.md')
      writeFileSync(path(out), md, 'utf8')
      console.log(md)
    })
    .catch((e: unknown) => {
      console.error(e)
      process.exitCode = 1
    })
}
