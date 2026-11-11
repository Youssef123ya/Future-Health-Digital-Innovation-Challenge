/**
 * What drives the Zill arms' work cost (integration analysis, waves 2c–2d): on the base-case days of a cohort report, the
 * midday-ban-only arm and each Zill arm with a wearable (zill_full; zill_monitored, the monitored plan basis) are re-run
 * with the report's own spec, and every worker-minute is attributed:
 * 1. Plan level (planner.planDay on the forecast, as scheduled by worldsim): the crew job (Σ task durations), the work the
 *    plan schedules for each worker (the crew layout, or the member's own layout for a member on an acclimatisation
 *    schedule, CrewPlan.memberCaps), the work it leaves unscheduled (deferred: no hour allows the task; incomplete: not
 *    enough hours at the allowed rates; crew level), and the scheduled wall minutes by what set each block-hour's work
 *    minutes (BlockHour.limitedBy: none, NIOSH/ACGIH, the rule pack's TWL zone cycle, the ISO 7933 screen; and how many
 *    are monitored block-hours, BlockHour.monitored), with the mean allowed rate by work class and effective WBGT band at
 *    the work location.
 * 2. Execution level (minute by minute): each scheduled work minute of the worker's own layout is worked, or lost to an
 *    engine rest episode (by the channel that raised it), the device's work/rest cycle, first aid or an evacuation.
 * 3. Per-member plans (wave 2d, planner.ts): the crew rate is planned for the acclimatised members; members on an
 *    acclimatisation schedule get personal caps. Reported: members on caps, crew-days with no acclimatised member
 *    (binding.limit 'RAL'), and the scheduled work per member on caps and per acclimatised member (CrewPlan.memberWorkMin).
 * Numbers are printed and written to docs/dev/work-cost-drivers.md (generated; nothing typed by hand).
 *
 *   npx tsx scripts/validate/work-cost-drivers.ts [--report=public/data/validation/cohort.json] [--out=docs/dev/work-cost-drivers.md]
 *       [--arms=zill_full,zill_monitored]
 *
 * Evidence class: SIMULATED. It explains the model's numbers; it does not measure anything.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { RISK_ORDER, type RiskAssessment } from '../../src/engine/types'
import { simConfigFor, type ArmId, type CohortDay, type CohortSpec, type VariantSpec } from '../../src/sim/backtest'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import { createWorld, runSiteDay, stepWorld, worldMinutesRemaining } from '../../src/sim/worldsim'
import { mdTable } from './lib/docs'
import { isMainModule, repoPath } from './lib/io'

/** The Zill arms analysed by default (both with a wearable: the tables and the monitored plan basis). */
export const DRIVER_ARMS: readonly ArmId[] = ['zill_full', 'zill_monitored']
const ARM_LABEL: Partial<Record<ArmId, string>> = { zill_env: 'Zill (no wearable)', zill_full: 'Zill (with wearable)', zill_monitored: 'Zill (monitored mode)' }
const PRIORITY = ['symptoms', 'physiology', 'hydration', 'projection', 'regulation', 'environment'] as const
const WBGT_BANDS: readonly [number, number, string][] = [
  [-Infinity, 28, '< 28 °C'],
  [28, 30, '28–30 °C'],
  [30, 32, '30–32 °C'],
  [32, 33, '32–33 °C'],
  [33, Infinity, '≥ 33 °C'],
]
const STRATA = ['all', 'hot', 'median', 'mild'] as const

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
  /** Wall minutes of monitored block-hours (BlockHour.monitored), per member. */
  monitoredWall: number
  rate: Record<string, { wall: number; work: number }>
  /** Crew-days, those with no acclimatised member (binding.limit 'RAL'), members, members on caps. */
  crewDays: number
  noAcclimatisedCrewDays: number
  crewMembers: number
  membersOnCaps: number
  /** Scheduled work (own layout) summed over members on caps / over the other members. */
  capMemberPlanned: number
  otherMemberPlanned: number
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
  monitoredWall: 0,
  rate: {},
  crewDays: 0,
  noAcclimatisedCrewDays: 0,
  crewMembers: 0,
  membersOnCaps: 0,
  capMemberPlanned: 0,
  otherMemberPlanned: 0,
})
const add = (m: Record<string, number>, k: string, x: number): void => {
  m[k] = (m[k] ?? 0) + x
}

/** Accumulators per Zill arm and stratum ('all', 'hot', 'median', 'mild'). */
export type DriverAcc = Record<string, Record<(typeof STRATA)[number], Acc>>

/** Run the attribution on the report's base days for each arm; returns accumulators per arm and stratum. */
export async function workCostDrivers(report: { spec: CohortSpec; days: CohortDay[] }, arms: readonly ArmId[] = DRIVER_ARMS, log = true): Promise<DriverAcc> {
  const spec = report.spec
  const loader = createNodeSimDataLoader()
  const base: VariantSpec = { id: 'base', group: 'base', factor: 'base', label: 'Base case', value: 'default', arms: ['ban_only', ...arms], strata: ['hot', 'median', 'mild'] }
  const acc: DriverAcc = Object.fromEntries(arms.map((a) => [a, { all: newAcc(), hot: newAcc(), median: newAcc(), mild: newAcc() }]))
  for (const day of report.days) {
    const data = await loader.load(day.siteId, day.date, { workforceSeed: spec.workforceSeed, crewsPerSite: spec.crewsPerSite, includeDemoCrew: spec.includeDemoCrew })
    const ban = runSiteDay(simConfigFor(spec, day, base, 'ban_only'), data)
    for (const arm of arms) {
      const targets = [acc[arm].all, acc[arm][day.stratum]]
      for (const a of targets) {
        a.workerShifts += ban.outcomes.length
        a.banWork += ban.outcomes.reduce((s, o) => s + o.workMin, 0)
      }
      const w = createWorld(simConfigFor(spec, day, base, arm), data)
      // Plan level: per worker, each on their own layout (the crew's, or the member's own caps).
      for (const cs of w.crews) {
        const n = cs.crew.workerIds.length
        const cp = w.plan?.crews.find((p) => p.crewId === cs.crew.id)
        const job = cs.crew.tasks.reduce((s, t) => s + t.durationMin, 0)
        const crewPlanned = cs.planWork.reduce((s, x) => s + x, 0)
        let planned = 0
        let capPlanned = 0
        for (const id of cs.crew.workerIds) {
          const own = cs.memberPlans.get(id)
          const m = own ? own.work.reduce((s, x) => s + x, 0) : crewPlanned
          planned += m
          if (own) capPlanned += m
        }
        for (const a of targets) {
          a.crewDays += 1
          if (cp?.binding.limit === 'RAL') a.noAcclimatisedCrewDays += 1
          a.crewMembers += n
          a.membersOnCaps += cs.memberPlans.size
          a.capMemberPlanned += capPlanned
          a.otherMemberPlanned += planned - capPlanned
          a.job += job * n
          a.planned += planned
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
              if (h.monitored) a.monitoredWall += h.wallMin * n
              const k = `${task?.workClass ?? '?'}|${band}`
              const r = a.rate[k] ?? (a.rate[k] = { wall: 0, work: 0 })
              r.wall += h.wallMin * n
              r.work += h.workMin * n
            }
          }
        }
      }
      // Execution level: the worker's own scheduled work minutes.
      const epCh = new Map<string, string>()
      while (worldMinutesRemaining(w) > 0) {
        const prev = new Map(w.workers.map((ws) => [ws.id, { a: ws.assessment, rest: ws.rest }]))
        stepWorld(w, 1)
        const i = w.minuteIndex - 1
        for (const ws of w.workers) {
          const p = prev.get(ws.id)
          if (ws.rest && ws.rest !== p?.rest) epCh.set(ws.id, episodeChannel(p?.a ?? null))
          if (ws.manual || ws.layout.work[i] !== 1) continue
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
    }
    if (log) console.log(`[drivers] ${day.siteId} ${day.date} (${day.stratum}) done`)
  }
  return acc
}

/** Markdown of the attribution (pure). */
export function renderDrivers(acc: DriverAcc, source: string): string {
  const per = (a: Acc, x: number): string => (a.workerShifts > 0 ? (x / a.workerShifts).toFixed(1) : '—')
  const arms = Object.keys(acc)
  const label = (arm: string): string => ARM_LABEL[arm as ArmId] ?? arm
  const out: string[] = []
  out.push('# What drives the Zill work cost (simulated cohort, base case)')
  out.push('')
  out.push(
    `Generated by \`npx tsx scripts/validate/work-cost-drivers.ts\` from the base-case days and spec of \`${source}\`; the midday-ban-only arm and ${arms.map(label).join(' and ')} are re-run with the same seed. Minutes per worker-shift. Simulated: it explains the model's numbers, it measures nothing.`,
  )
  out.push('', '## 1. From the crew job to delivered work', '')
  out.push('Scheduled work is each worker\'s own layout: the crew layout, or the member\'s own caps for a member on an acclimatisation schedule (planner.ts CrewPlan.memberCaps, wave 2d). Unscheduled work is the crew\'s.', '')
  out.push(
    mdTable(
      ['Arm', 'Stratum', 'Worker-shifts', 'Midday ban only: work delivered', 'Crew job (Σ task durations)', 'Zill plan: scheduled work', 'Plan: unscheduled, deferred', 'Plan: unscheduled, incomplete', 'Zill: work delivered', 'Scheduled but not worked'],
      arms.flatMap((arm) =>
        STRATA.map((k) => {
          const a = acc[arm][k]
          const lost = Object.values(a.lost).reduce((s, x) => s + x, 0)
          return [label(arm), k, a.workerShifts, per(a, a.banWork), per(a, a.job), per(a, a.planned), per(a, a.unscheduledDeferred), per(a, a.unscheduledIncomplete), per(a, a.delivered), per(a, lost)]
        }),
      ),
    ),
  )
  out.push('', '## 2. Scheduled work minutes not worked, by cause', '')
  const causes = [...new Set(arms.flatMap((arm) => Object.values(acc[arm]).flatMap((a) => Object.keys(a.lost))))].sort()
  out.push(mdTable(['Arm', 'Stratum', ...causes], arms.flatMap((arm) => STRATA.map((k) => [label(arm), k, ...causes.map((c) => per(acc[arm][k], acc[arm][k].lost[c] ?? 0))]))))
  out.push('', '## 3. Plan block-hours by what set the work minutes', '')
  out.push('Wall minutes in task blocks and the crew work minutes planned in them, per worker-shift; work share = work ÷ wall. Monitored = block-hours planned on the monitored basis (BlockHour.monitored: the NIOSH/ACGIH cap is a screen there).', '')
  const lims = ['none', 'niosh_acgih', 'rule_pack', 'phs']
  out.push(
    mdTable(
      ['Arm', 'Stratum', ...lims.flatMap((l) => [`${l}: wall`, `${l}: work share`]), 'monitored: wall'],
      arms.flatMap((arm) =>
        STRATA.map((k) => {
          const a = acc[arm][k]
          return [label(arm), k, ...lims.flatMap((l) => [per(a, a.wallBy[l] ?? 0), (a.wallBy[l] ?? 0) > 0 ? `${((100 * (a.workBy[l] ?? 0)) / (a.wallBy[l] as number)).toFixed(0)} %` : '—']), per(a, a.monitoredWall)]
        }),
      ),
    ),
  )
  out.push('', '## 4. Per-member plans', '')
  out.push(
    'The planner plans the crew rate for its acclimatised members (NIOSH REL, the pack\'s base tier, an acclimatised ISO 7933 reference) and gives members on an acclimatisation schedule personal caps (RAL with their own size and clothing, the next-stricter tier, the ADOSH note b exclusion, the exposure ramp and an unacclimatised ISO 7933 screen; never above the crew rate). Crews with no acclimatised member keep the RAL crew rate (binding.limit \'RAL\'). Scheduled work per member: the member\'s own layout.',
    '',
  )
  out.push(
    mdTable(
      ['Arm', 'Stratum', 'Crew-days', 'Crew-days with no acclimatised member', 'Members on caps / crew members', 'Scheduled work per member on caps', 'Scheduled work per other member'],
      arms.flatMap((arm) =>
        STRATA.map((k) => {
          const a = acc[arm][k]
          const others = a.crewMembers - a.membersOnCaps
          return [label(arm), k, a.crewDays, a.noAcclimatisedCrewDays, `${a.membersOnCaps} / ${a.crewMembers}`, a.membersOnCaps > 0 ? (a.capMemberPlanned / a.membersOnCaps).toFixed(1) : '—', others > 0 ? (a.otherMemberPlanned / others).toFixed(1) : '—']
        }),
      ),
    ),
  )
  out.push('', '## 5. Planned work rate by work class and effective WBGT at the work location (all strata)', '')
  out.push('Mean planned crew work minutes per hour in task block-hours (Σ work ÷ Σ wall × 60), with the wall minutes per worker-shift in brackets.', '')
  for (const arm of arms) {
    const all = acc[arm].all
    const classes = [...new Set(Object.keys(all.rate).map((k) => k.split('|')[0]))].sort()
    out.push(`**${label(arm)}**`, '')
    out.push(
      mdTable(
        ['Work class', ...WBGT_BANDS.map((b) => b[2])],
        classes.map((c) => [
          c,
          ...WBGT_BANDS.map(([, , band]) => {
            const r = all.rate[`${c}|${band}`]
            return r && r.wall > 0 ? `${((60 * r.work) / r.wall).toFixed(0)} (${per(all, r.wall)})` : '—'
          }),
        ]),
      ),
      '',
    )
  }
  return out.join('\n')
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name: string, dflt: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
  const path = (p: string): string => (isAbsolute(p) ? p : repoPath(p))
  const src = arg('report', 'public/data/validation/cohort.json')
  const arms = arg('arms', DRIVER_ARMS.join(',')).split(',') as ArmId[]
  const report = JSON.parse(readFileSync(path(src), 'utf8')) as { spec: CohortSpec; days: CohortDay[] }
  workCostDrivers(report, arms)
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
