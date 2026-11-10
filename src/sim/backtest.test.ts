import { describe, expect, it } from 'vitest'
import { getSite } from '../data/sites'
import {
  ARM_IDS,
  BACKTEST_ARMS,
  COHORT_PRESETS,
  cohortSpec,
  cohortVariants,
  dayHeatFromAnalysis,
  runBacktest,
  seasonDates,
  selectCohortDays,
  simConfigFor,
  stratumCuts,
  summariseBacktest,
  type CohortDay,
  type DayHeat,
  type VariantSpec,
} from './backtest'
import { allFinite } from './metrics'
import { createNodeSimDataLoader } from './simdata'

const heat = (siteId: DayHeat['siteId'], date: string, c: number): DayHeat => ({ siteId, date, shiftMeanWbgtC: c, shiftMaxWbgtC: c + 2, shiftMinTwlWm2: 150, hours: 12 })

describe('cohort design (pure)', () => {
  it('seasonDates lists every day of the months', () => {
    const d = seasonDates(2025, [6, 7, 8, 9])
    expect(d).toHaveLength(122)
    expect(d[0]).toBe('2025-06-01')
    expect(d[121]).toBe('2025-09-30')
  })

  it('selectCohortDays ranks by heat, splits terciles and takes evenly spaced days', () => {
    const heats = Array.from({ length: 9 }, (_, i) => heat('kezad', `2025-07-0${i + 1}`, 30 + i)) // 07-09 hottest
    const one = selectCohortDays(heats, 1)
    expect(one.map((d) => [d.stratum, d.date, d.heatRank])).toEqual([
      ['hot', '2025-07-08', 2],
      ['median', '2025-07-05', 5],
      ['mild', '2025-07-02', 8],
    ])
    const all = selectCohortDays(heats, 3)
    expect(all).toHaveLength(9)
    expect(all.filter((d) => d.stratum === 'hot').map((d) => d.date)).toEqual(['2025-07-09', '2025-07-08', '2025-07-07'])
    // Ties resolve by date; more days requested than a tercile holds are capped.
    const tied = selectCohortDays([heat('ruwais', '2025-07-02', 31), heat('ruwais', '2025-07-01', 31), heat('ruwais', '2025-07-03', 30)], 5)
    expect(tied.map((d) => d.date)).toEqual(['2025-07-01', '2025-07-02', '2025-07-03'])
    const cuts = stratumCuts(heats)
    expect(cuts).toEqual([{ siteId: 'kezad', daysRanked: 9, hotMinC: 36, mildMaxC: 32, maxC: 38, minC: 30 }])
  })

  it('variants are fixed in advance, uniquely named, and always pair with ban_only', () => {
    const v = cohortVariants(COHORT_PRESETS.quick)
    expect(v[0].id).toBe('base')
    expect(v[0].arms).toEqual(ARM_IDS)
    expect(new Set(v.map((x) => x.id)).size).toBe(v.length)
    for (const x of v.slice(1)) {
      expect(x.arms).toContain('ban_only')
      expect(x.strata).toEqual(['hot'])
    }
    const factors = new Set(v.map((x) => x.factor))
    for (const f of ['compliance', 'selfReportScale', 'metabolicSigmaLn', 'hazardScale', 'ppgNoise', 'supervisorFollowThrough', 'wearableDropout', 'sensorFailure', 'forecastAgeH', 'networkOutage']) expect(factors.has(f)).toBe(true)
    // Supervisor follow-through 0.5 (backtest 1.1.0): closed-loop arms only, paired with ban_only.
    const sft = v.find((x) => x.id === 'supervisorFollowThrough=0.5')
    expect(sft?.behaviour).toEqual({ supervisorFollowThrough: 0.5 })
    expect(sft?.arms).toEqual(['ban_only', 'site_index', 'zill_env', 'zill_full'])
    expect(cohortVariants({ ...COHORT_PRESETS.quick, variants: 'base' })).toHaveLength(1)
  })

  it('cohortSpec keeps the preset name unless the design changes', () => {
    expect(cohortSpec('quick')).toEqual(COHORT_PRESETS.quick)
    expect(cohortSpec('medium', { daysPerStratum: 3 }).mode).toBe('medium')
    expect(cohortSpec('medium', { daysPerStratum: 4 }).mode).toBe('custom')
  })

  it('simConfigFor applies the arm, the variant overrides and traces only shadow arms', () => {
    const spec = cohortSpec('quick')
    const day = { siteId: 'kezad' as const, date: '2025-07-15' }
    const variant: VariantSpec = { id: 'x', group: 'sensitivity', factor: 'compliance', label: 'x', value: 0.5, behaviour: { compliance: 0.5 }, disruptions: { wearableDropout: 0.2 }, arms: ['ban_only'], strata: ['hot'] }
    const shadow = simConfigFor(spec, day, variant, 'shadow_zill_full')
    expect(shadow.policy).toBe('zill_full')
    expect(shadow.shadow).toBe(true)
    expect(shadow.trace).toBe('full')
    expect(shadow.seed).toBe(spec.seed)
    expect(shadow.behaviour.compliance).toBe(0.5)
    expect(shadow.disruptions.wearableDropout).toBe(0.2)
    expect(shadow.shift).toEqual(spec.shift)
    const closed = simConfigFor(spec, day, variant, 'zill_env')
    expect(closed.trace).toBe('none')
    expect(BACKTEST_ARMS.site_index.shadow).toBe(false)
  })
})

describe('runBacktest (real 2025 weather, tiny cohort)', () => {
  const loader = createNodeSimDataLoader()

  it('dayHeatFromAnalysis summarises the shift hours of a real day', async () => {
    const w = await loader.weather('kezad', '2025-07-15')
    const h = dayHeatFromAnalysis(getSite('kezad'), '2025-07-15', w.analysis)
    expect(h).not.toBeNull()
    expect(h?.hours).toBe(12)
    expect(h && h.shiftMeanWbgtC > 20 && h.shiftMeanWbgtC < 40 && h.shiftMaxWbgtC >= h.shiftMeanWbgtC).toBe(true)
  })

  it('is deterministic, finite, and shadow mode reproduces ban_only ground truth exactly', async () => {
    const spec = cohortSpec('quick', { sites: ['kezad'], replicates: 100 })
    const w = await loader.weather('kezad', '2025-07-15')
    const day: CohortDay = { ...(dayHeatFromAnalysis(getSite('kezad'), '2025-07-15', w.analysis) as DayHeat), stratum: 'hot', heatRank: 1, daysRanked: 1 }
    const variants: VariantSpec[] = [
      { id: 'base', group: 'base', factor: 'base', label: 'Base', value: 'default', arms: ['ban_only', 'shadow_zill_env'], strata: ['hot'] },
      { id: 'hazardScale=2', group: 'sensitivity', factor: 'hazardScale', label: 'hazard ×2', value: 2, truthParams: { symptoms: { hazardScale: 2 } }, arms: ['ban_only'], strata: ['hot'] },
    ]
    const a = await runBacktest(spec, loader, { days: [day], variants })
    const b = await runBacktest(spec, loader, { days: [day], variants })
    const ra = summariseBacktest(a)
    const rb = summariseBacktest(b)
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb))
    expect(allFinite(ra)).toBe(true)

    const base = a.variants.find((v) => v.spec.id === 'base')
    expect(base?.runs).toBe(2)
    expect(ra.runs.rows.filter((r) => r[0] === 0)).toHaveLength(2)
    for (const row of ra.runs.rows) {
      expect(row[3]).toBe(spec.seed)
      expect(String(row[4]).startsWith('zill-worldsim@')).toBe(true)
    }
    const shadow = ra.main.arms.find((x) => x.arm === 'shadow_zill_env')
    const p = shadow?.vsBanOnly
    expect(p?.pairedWorkerShifts).toBeGreaterThan(0)
    for (const e of [p?.excessivePer1000, p?.severePer1000, p?.dehydrationPer1000, p?.symptomaticEpisodesPer1000, p?.workMinPerShift, p?.restMinPerShift, p?.waterMlPerShift]) expect(e?.value).toBe(0)
    expect(shadow?.detection?.map((d) => d.target)).toEqual(['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'heat_symptoms', 'symptomatic'])
    // Headline detection counts individual alarms (≥ high; ≥ stop alongside); the all-alarm 1.0.0 definition is kept.
    expect(shadow?.detection?.every((d) => d.alarmSet === 'individual' && d.minLevel === 'high')).toBe(true)
    expect(shadow?.detectionStop?.every((d) => d.alarmSet === 'individual' && d.minLevel === 'stop')).toBe(true)
    expect(shadow?.detectionAllAlarms?.every((d) => d.alarmSet === 'all')).toBe(true)
    for (const [i, d] of (shadow?.detection ?? []).entries()) expect(d.alarms).toBeLessThanOrEqual(shadow?.detectionAllAlarms?.[i].alarms ?? 0)
    expect(shadow?.challenge.ack.workerShifts).toBe(shadow?.rates.workerShifts)
    expect(shadow?.challenge.ack.crewShifts).toBe(1)
    expect(shadow?.calibration?.length).toBe(5)
    expect(ra.main.arms.find((x) => x.arm === 'ban_only')?.challenge.alarmsPerShift.value).toBe(0)

    // A ground-truth sweep never runs with silently ignored parameters; worldsim ≥ 1.1.0 forwards truthParams, so it runs.
    const hz = a.variants.find((v) => v.spec.id === 'hazardScale=2')
    expect(hz?.supported).toBe(true)
    expect(hz?.runs).toBe(1)
  })
})
