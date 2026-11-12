import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SITES } from '../../../data/sites'
import type { WeatherSeries } from '../../../data/weather'
import {
  formatRate,
  formatShare,
  parseCohortHeadline,
  parseForecastHeadline,
  parseHoursHeadline,
  parseReferenceSummary,
} from './evidence'
import { boundObtainedAt, conditionsFor, fetchLiveConditions, sourceText } from './siteConditions'
import { GLOBAL_FIGURES, LOCAL_FIGURES, researchSource } from './research'

const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../public/data/validation/${name}.json`, import.meta.url), 'utf8'))

describe('evidence headline parsing', () => {
  it('reads the shipped validation outputs', () => {
    const hours = parseHoursHeadline(readJson('hours-in-zone'))
    expect(hours).not.toBeNull()
    expect(hours!.shareHighHeatOutsideBreak).toBeGreaterThan(0.5)
    expect(hours!.moderateRelCabinMinPerHour).toBeGreaterThan(hours!.moderateRelShadeMinPerHour)
    const forecast = parseForecastHeadline(readJson('forecast-skill'))
    expect(forecast!.wbgtRmseD1).toBeLessThan(forecast!.persistenceRmse)
    const ref = parseReferenceSummary(readJson('reference'))
    expect(ref!.passed).toBeLessThanOrEqual(ref!.checks)
    const cohort = parseCohortHeadline(readJson('cohort'))
    expect(cohort!.arms.map((a) => a.arm)).toEqual(['ban_only', 'site_index', 'zill_full', 'zill_monitored'])
    expect(cohort!.arms.every((a) => a.workerShifts > 0)).toBe(true)
    expect(cohort!.workChangeVsBan).not.toBeNull()
    expect(cohort!.disclaimer).toMatch(/Simulated cohort/)
  })

  it('returns null for unexpected shapes instead of guessing', () => {
    for (const bad of [null, 42, 'x', {}, { headline: {} }, { headline: { wbgtRmseD1: 'a' } }]) {
      expect(parseHoursHeadline(bad)).toBeNull()
      expect(parseForecastHeadline(bad)).toBeNull()
      expect(parseReferenceSummary(bad)).toBeNull()
      expect(parseCohortHeadline(bad)).toBeNull()
    }
    expect(parseCohortHeadline({ main: { arms: [{ arm: 'ban_only', rates: {} }] } })).toBeNull()
  })

  it('formats shares and zero-count rates with the rule-of-three bound', () => {
    expect(formatShare(0.837)).toBe('84 %')
    expect(formatRate({ excessivePer1000: 0, excessiveUpper95: 9, excessiveCount: 0 })).toBe('0 (≤ 9)')
    expect(formatRate({ excessivePer1000: 114.1, excessiveUpper95: null, excessiveCount: 38 })).toBe('114')
  })
})

const hour = 3_600_000
const series = (firstT: number, obtainedAt?: number): WeatherSeries => ({
  locationId: 'musaffah',
  source: 'forecast',
  model: 'ecmwf_ifs',
  grid: null,
  obtainedAt,
  samples: [{ t: firstT, taC: 30, tdC: 20, pHpa: 1005, wind10Ms: 3, ghiWm2: 0, source: 'forecast' }],
  droppedHours: 0,
})

describe('site conditions', () => {
  it('ages a forecast by its own time axis (a cached response cannot pass as fresh)', () => {
    const now = Date.UTC(2026, 10, 11, 10)
    const fresh = boundObtainedAt(series(now - 6 * hour, now), now)
    expect(fresh.obtainedAt).toBe(now)
    const old = boundObtainedAt(series(now - 72 * hour, now), now)
    expect(old.obtainedAt).toBe(now - 48 * hour)
  })

  it('falls back down the fail-safe chain without a live forecast', () => {
    const now = Date.UTC(2026, 10, 11, 8)
    const c = conditionsFor('musaffah', now, null, 'timeout')
    expect(c.source).toBe('conservative_default')
    expect(c.wbgtC).toBeGreaterThan(c.wbgtShadeC - 0.001)
    expect(c.zone).not.toBeNull()
    expect(sourceText(c)).toBe('Fail-safe default')
    expect(sourceText({ source: 'forecast', ageMin: 12, stale: false })).toBe('Live forecast · 12 min old')
    expect(sourceText({ source: 'forecast', ageMin: 400, stale: true })).toBe('Stale forecast · 6.7 h old')
  })

  it('resolves every site even when every live request fails', async () => {
    const failing = () => Promise.reject(new Error('offline'))
    const res = await fetchLiveConditions({ now: Date.UTC(2026, 10, 11, 8), fetch: failing, timeoutMs: 50 })
    expect(res.sites.map((s) => s.siteId)).toEqual(SITES.map((s) => s.id))
    expect(res.liveCount).toBe(0)
    expect(res.sites.every((s) => s.fetchError !== null)).toBe(true)
  })
})

describe('research figures', () => {
  it('cite known sources', () => {
    for (const f of [...GLOBAL_FIGURES, ...LOCAL_FIGURES]) expect(researchSource(f.sourceId).short).toBeTruthy()
  })
})
