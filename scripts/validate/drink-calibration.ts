/**
 * Calibration of the ground-truth drinking floor (sim/truth.ts DRINK_CALIBRATION, wave 2d) and the heat-tercile check of
 * the midday-ban-only arm. Only the ban_only arm is run — never a Zill arm — and the target is an independent field
 * observation (Bates & Schneider 2008: 5.44 L per 12-h UAE summer shift), never a Zill outcome.
 *
 *   npx tsx scripts/validate/drink-calibration.ts [--mode=eval|calibrate|terciles] [--f=0.87,0.4,1] [--crews=3]
 *
 * - eval: mean true intake, water loss and dehydration > 3 % per worker-shift at each habitualDrinkFraction on the
 *   calibration set (every hot-tercile site-day of the medium preset's season at the five sites, terciles as
 *   backtest.selectCohortDays, `--crews` generated crews per site).
 * - calibrate: regula falsi on habitualDrinkFraction alone between 0.4 and 1.0 to the target (stops within 0.01 L).
 * - terciles: every season site-day; dehydration > 3 % per 1,000 by WBGT stratum, stratum × midday-ban season and site,
 *   and by each worker-shift's own water-loss tercile (docs/dev/wave2d-sim.md §1).
 *
 * Evidence class: SIMULATED. It documents how a model parameter was set; it measures nothing.
 */
import { getSite, SITE_IDS } from '../../src/data/sites'
import { isMiddayBreak } from '../../src/engine/regulation'
import { epochFromLocal } from '../../src/engine/time'
import { COHORT_PRESETS, dayHeatFromAnalysis, seasonDates, selectCohortDays, type CohortDay, type DayHeat } from '../../src/sim/backtest'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import { DRINK_CALIBRATION } from '../../src/sim/truth'
import type { SimData } from '../../src/sim/types'
import { createWorld, finishWorld, makeSimConfig, stepWorld } from '../../src/sim/worldsim'
import { isMainModule } from './lib/io'

/** One ban-only worker-shift. */
export interface BanOnlyShift {
  day: CohortDay
  intakeMl: number
  waterLossMl: number
  dehydrated: boolean
}

/** Every season site-day of the medium preset with its heat stratum, and the loaded data per site-day. */
export async function seasonDays(crewsPerSite: number): Promise<{ days: CohortDay[]; data: Map<string, SimData> }> {
  const spec = COHORT_PRESETS.medium
  const loader = createNodeSimDataLoader()
  const heats: DayHeat[] = []
  for (const siteId of SITE_IDS) {
    for (const date of seasonDates(spec.year, spec.months)) {
      let analysis
      try {
        analysis = (await loader.weather(siteId, date)).analysis
      } catch {
        continue
      }
      const h = dayHeatFromAnalysis(getSite(siteId), date, analysis, spec.shift)
      if (h) heats.push(h)
    }
  }
  const days = selectCohortDays(heats, Number.MAX_SAFE_INTEGER)
  const data = new Map<string, SimData>()
  for (const d of days) data.set(`${d.siteId}|${d.date}`, await loader.load(d.siteId, d.date, { workforceSeed: spec.workforceSeed, crewsPerSite, includeDemoCrew: false }))
  return { days, data }
}

/** The midday-ban-only arm on `days` at a drinking floor (fasting workers excluded; none in Jun–Sep 2025). */
export function runBanOnly(days: readonly CohortDay[], data: ReadonlyMap<string, SimData>, habitualDrinkFraction: number): BanOnlyShift[] {
  const spec = COHORT_PRESETS.medium
  const out: BanOnlyShift[] = []
  for (const day of days) {
    const d = data.get(`${day.siteId}|${day.date}`)
    if (!d) continue
    const world = createWorld(makeSimConfig({ seed: spec.seed, siteId: day.siteId, date: day.date, policy: 'ban_only', shadow: false, shift: spec.shift, trace: 'none' }), d, {
      truthParams: { behaviour: { habitualDrinkFraction } },
    })
    stepWorld(world, world.nMinutes)
    const outcomes = new Map(finishWorld(world).outcomes.map((o) => [o.workerId, o]))
    for (const ws of world.workers) {
      if (ws.fastingFlag) continue
      out.push({ day, intakeMl: ws.truth.intakeMl, waterLossMl: ws.truth.waterLossMl, dehydrated: (outcomes.get(ws.id)?.events.dehydration_3pct.count ?? 0) > 0 })
    }
  }
  return out
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
/** "intake L, water loss L, dehydration per 1,000 (± binomial SE)" of a set of worker-shifts. */
export function summary(rows: readonly BanOnlyShift[]): { n: number; intakeL: number; waterLossL: number; dehydPer1000: number; se: number } {
  const p = rows.filter((r) => r.dehydrated).length / Math.max(1, rows.length)
  return { n: rows.length, intakeL: mean(rows.map((r) => r.intakeMl)) / 1000, waterLossL: mean(rows.map((r) => r.waterLossMl)) / 1000, dehydPer1000: 1000 * p, se: 1000 * Math.sqrt((p * (1 - p)) / Math.max(1, rows.length)) }
}

const line = (label: string, rows: readonly BanOnlyShift[]): string => {
  const s = summary(rows)
  return `${label.padEnd(28)} n ${String(s.n).padStart(5)}  intake ${s.intakeL.toFixed(3)} L  water loss ${s.waterLossL.toFixed(2)} L  dehydration > 3 % ${s.dehydPer1000.toFixed(0).padStart(4)} ± ${s.se.toFixed(0)} /1,000`
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (k: string, d: string): string => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
  const mode = arg('mode', 'eval')
  const { days, data } = await seasonDays(Number(arg('crews', '3')))
  const hot = days.filter((d) => d.stratum === 'hot')
  const target = DRINK_CALIBRATION.target.litresPer12hShift
  console.log(`[drink-calibration] ${days.length} season site-days, ${hot.length} hot-tercile; target ${target} L per 12-h shift`)
  if (mode === 'calibrate') {
    let a = 0.4
    let b = 1.0
    let ea = summary(runBanOnly(hot, data, a)).intakeL
    let eb = summary(runBanOnly(hot, data, b)).intakeL
    console.log(`f=${a}: ${ea.toFixed(3)} L; f=${b}: ${eb.toFixed(3)} L`)
    for (let it = 0; it < 8; it++) {
      const c = a + ((target - ea) * (b - a)) / (eb - ea)
      const e = summary(runBanOnly(hot, data, c)).intakeL
      console.log(`regula falsi ${it}: f=${c.toFixed(4)} → ${e.toFixed(3)} L`)
      if (Math.abs(e - target) < 0.01) break
      if (e < target) [a, ea] = [c, e]
      else [b, eb] = [c, e]
    }
  } else if (mode === 'terciles') {
    const season = (d: CohortDay): string => (isMiddayBreak(epochFromLocal(`${d.date}T13:00`)) ? 'ban season' : 'off season')
    for (const f of arg('f', '0.4,0.87').split(',').map(Number)) {
      const rows = runBanOnly(days, data, f)
      console.log(`\nhabitualDrinkFraction ${f}`)
      for (const st of ['hot', 'median', 'mild']) {
        console.log(line(st, rows.filter((r) => r.day.stratum === st)))
        for (const s of ['ban season', 'off season']) console.log(line(`  ${st} | ${s}`, rows.filter((r) => r.day.stratum === st && season(r.day) === s)))
      }
      for (const site of SITE_IDS) for (const st of ['hot', 'median', 'mild']) console.log(line(`  ${site} | ${st}`, rows.filter((r) => r.day.siteId === site && r.day.stratum === st)))
      const sorted = [...rows].sort((x, y) => y.waterLossMl - x.waterLossMl)
      ;['highest', 'middle', 'lowest'].forEach((name, k) => console.log(line(`water-loss tercile ${name}`, sorted.slice(Math.floor((k * sorted.length) / 3), Math.floor(((k + 1) * sorted.length) / 3)))))
    }
  } else {
    for (const f of arg('f', `${DRINK_CALIBRATION.value},0.4,1`).split(',').map(Number)) console.log(line(`f=${f} (hot tercile)`, runBanOnly(hot, data, f)))
  }
}
