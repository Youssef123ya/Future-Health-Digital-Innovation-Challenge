import { describe, expect, it } from 'vitest'
import { MINUTE_MS, epochFromLocal } from '../../../engine/time'
import { createNodeSimDataLoader } from '../../../sim/simdata'
import { getScenario, loadScenarioData } from '../../../sim/scenarios'
import { runSiteDay } from '../../../sim/worldsim'
import type { WorkerMinute } from '../../../sim/types'
import {
  METRICS,
  archiveDayError,
  bandCoverage,
  comparisonHeadline,
  dayKey,
  dayOptions,
  defaultWorkerId,
  deltaText,
  eventsNear,
  firstLevelAtLeast,
  hasArchivedForecast,
  hourTicks,
  metricText,
  overallProgress,
  parseDemoDays,
  peakRow,
  rowAt,
  rowsFromMinutes,
  rowsFromPacked,
  sampleRows,
  segmentsOf,
  shareOfMax,
  sortPolicies,
  wearableGaps,
  type TruthRow,
} from './labModel'
import { NO_CODE, buildPolicyRunResult, packTraces, runOverrides, runSetup, scenarioDefaults, scenarioScript, windowError } from './labRun'
import type { ExperimentSpec, PolicyRunResult, PolicySummary } from './labTypes'

const T0 = epochFromLocal('2025-08-01T05:00')
const at = (min: number) => T0 + min * MINUTE_MS

function row(min: number, patch: Partial<TruthRow> = {}): TruthRow {
  return { t: at(min), core: 37, ect: null, ectBand: null, hrTrue: 90, hrMeas: null, dehy: 0, wbgt: 30, level: 'safe', working: true, location: 'sun', ...patch }
}

function minute(min: number, patch: Partial<WorkerMinute> = {}): WorkerMinute {
  return {
    t: at(min),
    workerId: 'W-1',
    taskId: 't',
    location: 'sun',
    working: true,
    level: 'safe',
    computedLevel: 'safe',
    workMinPerHour: 45,
    minutesToLimit: null,
    wbgtEffC: 31,
    coreTrueC: 37.2,
    hrTrueBpm: 100,
    hrMeasuredBpm: 98,
    ectempC: 37.34,
    dehydrationPct: 0.5,
    ...patch,
  }
}

function summary(patch: Partial<PolicySummary> = {}): PolicySummary {
  const h = (events: number, workers: number) => ({ events, workers })
  return {
    workers: 10,
    shiftMin: 7200,
    excessive: h(0, 0),
    severe: h(0, 0),
    critical: h(0, 0),
    dehydration: h(0, 0),
    heatSymptomEpisodes: 0,
    evacuations: 0,
    peakCoreC: 38.2,
    peakDehydrationPct: 2,
    minutesCoreAbove385: 0,
    workMin: 3000,
    hotWorkMin: 2000,
    restMin: 1500,
    idleMin: 2700,
    waterMl: 30000,
    alerts: { raised: 0, alarms: 0, notifications: 0, suppressed: 0, exposureToSupervisor: 0 },
    adherence: { instructions: 0, followed: 0 },
    middayViolationMin: 0,
    ...patch,
  }
}

const fakeResult = (policy: PolicyRunResult['policy'], s: PolicySummary): PolicyRunResult =>
  ({ policy, summary: s, workers: [], events: [] }) as unknown as PolicyRunResult

describe('day picker', () => {
  it('parses demo days defensively and drops days a scenario already uses', () => {
    const days = parseDemoDays({
      days: [
        { site: { id: 'musaffah' }, date: '2025-08-01', tags: ['peak_wbgt_proxy'], why: ['peak'] },
        { site: { id: 'musaffah' }, date: '2025-07-26', tags: ['hottest_dry_bulb'], why: ['hot'] },
        { site: { id: 'atlantis' }, date: '2025-07-26' },
        { site: { id: 'saadiyat' }, date: 'not-a-date' },
      ],
    })
    expect(days.map((d) => d.date)).toEqual(['2025-08-01', '2025-07-26'])
    const opts = dayOptions(days)
    const demo = opts.filter((o) => o.group === 'demo')
    expect(demo).toHaveLength(1)
    expect(demo[0].key).toBe(dayKey({ kind: 'site-day', siteId: 'musaffah', date: '2025-07-26' }))
    expect(demo[0].label).toContain('hottest air temperature')
    expect(opts.filter((o) => o.group === 'scenario').length).toBeGreaterThanOrEqual(5)
    expect(parseDemoDays(null)).toEqual([])
  })

  it('accepts only archived dates', () => {
    expect(archiveDayError('saadiyat', '2023-07-14')).toBeNull()
    expect(archiveDayError('musaffah', '2025-11-12')).toBeNull()
    expect(archiveDayError('saadiyat', '2025-11-12')).toMatch(/June–September/)
    expect(archiveDayError('alain', '2019-07-01')).not.toBeNull()
    expect(archiveDayError('alain', '')).toBe('Pick a date.')
    expect(hasArchivedForecast('2024-08-02')).toBe(true)
    expect(hasArchivedForecast('2021-08-02')).toBe(false)
  })

  it('orders policies as POLICY_IDS', () => {
    expect(sortPolicies(['zill_monitored', 'ban_only', 'zill_env'])).toEqual(['ban_only', 'zill_env', 'zill_monitored'])
  })
})

describe('run setup', () => {
  const peak = getScenario('peak-day')
  const spec = (patch: Partial<ExperimentSpec> = {}): ExperimentSpec => {
    const d = scenarioDefaults('peak-day')
    return { source: { kind: 'scenario', scenarioId: 'peak-day' }, policies: ['zill_full'], seed: d.seed, behaviour: d.behaviour, disruptions: d.disruptions, ...patch }
  }

  it('keeps scripted sensor and network events only while their windows are unchanged', () => {
    const d = scenarioDefaults('peak-day').disruptions
    expect(scenarioScript(peak, d)).toHaveLength(peak.events.length)
    const noSensor = scenarioScript(peak, { ...d, envSensorFailure: null })
    expect(noSensor.some((e) => e.injection.kind === 'system' && (e.injection.what === 'sensor_fail' || e.injection.what === 'sensor_ok'))).toBe(false)
    expect(noSensor.some((e) => e.injection.kind === 'checkin')).toBe(true)
  })

  it('maps the spec onto the simulator config', () => {
    const o = runOverrides(spec({ behaviour: { compliance: 0.5, selfReportScale: 1.5, respondScale: 1 } }), 'zill_monitored')
    expect(o).toMatchObject({ policy: 'zill_monitored', trace: 'full', shadow: false, behaviour: { compliance: 0.5, selfReportScale: 1.5 } })
    const { config } = runSetup(spec(), 'ban_only')
    expect(config.policy).toBe('ban_only')
    expect(config.siteId).toBe('musaffah')
    const site = runSetup({ ...spec(), source: { kind: 'site-day', siteId: 'saadiyat', date: '2025-08-01' } }, 'zill_env')
    expect(site.script).toEqual([])
    expect(site.config.workers?.length).toBeGreaterThan(0)
    expect(site.config.shift).toEqual({ start: '05:00', end: '17:00' })
  })

  it('validates disruption windows inside the shift', () => {
    expect(windowError(null)).toBeNull()
    expect(windowError({ from: '11:00', to: '11:30' })).toBeNull()
    expect(windowError({ from: '11:30', to: '11:00' })).toMatch(/end after/)
    expect(windowError({ from: '04:00', to: '06:00' })).toMatch(/inside the shift/)
    expect(windowError({ from: '9:00', to: '10:00' })).toMatch(/HH:mm/)
  })
})

describe('traces', () => {
  it('packs minutes column-wise and unpacks them into chart rows with the ECTemp display band', () => {
    const minutes = [minute(0), minute(1, { hrMeasuredBpm: null, level: 'high' }), minute(0, { workerId: 'W-2', ectempC: null })]
    const p = packTraces(minutes, ['W-1', 'W-2'], T0, 3)
    expect(p.level[2]).toBe(NO_CODE)
    expect(Number.isNaN(p.coreTrueC[2])).toBe(true)
    const rows = rowsFromPacked(p, 0)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ core: expect.closeTo(37.2, 4), ect: 37.3, level: 'safe', working: true, location: 'sun' })
    expect(rows[0].ectBand?.[0]).toBeCloseTo(36.7, 5)
    expect(rows[0].ectBand?.[1]).toBeCloseTo(37.9, 5)
    expect(rows[1].hrMeas).toBeNull()
    expect(rows[1].level).toBe('high')
    expect(rowsFromPacked(p, 1)[0].ectBand).toBeNull()
    expect(rowsFromPacked(p, 5)).toEqual([])
    expect(rowsFromMinutes([minute(0)])[0].ect).toBe(37.3)
  })

  it('builds lanes, wearable gaps and band coverage', () => {
    const rows = [row(0), row(1), row(2, { level: 'high' }), row(3, { level: 'high' }), row(5, { level: 'high' })]
    expect(segmentsOf(rows, (r) => r.level)).toEqual([
      { from: at(0), to: at(2), value: 'safe' },
      { from: at(2), to: at(4), value: 'high' },
      { from: at(5), to: at(6), value: 'high' },
    ])
    const w = [row(0, { hrMeas: 90 }), row(1), row(2), row(3, { hrMeas: 95 })]
    expect(wearableGaps(w, true)).toEqual([{ from: at(1), to: at(3), value: true }])
    expect(wearableGaps(w, false)).toEqual([])
    const cov = bandCoverage([row(0, { core: 37, ectBand: [36.5, 37.7] }), row(1, { core: 38.5, ectBand: [37, 38.2] }), row(2)])
    expect(cov).toEqual({ inside: 1, total: 2 })
    expect(bandCoverage([row(0)])).toBeNull()
  })

  it('finds the peak, the row under a time and the first level crossing', () => {
    const rows = [row(0, { core: 37 }), row(1, { core: 38.4, level: 'caution' }), row(2, { core: 38.4, level: 'stop' }), row(3, { core: 37.9 })]
    expect(peakRow(rows)?.t).toBe(at(1))
    expect(rowAt(rows, at(2) + 30_000)?.t).toBe(at(2))
    expect(rowAt(rows, at(-1))).toBeNull()
    expect(firstLevelAtLeast(rows, 'high')).toBe(at(2))
    expect(firstLevelAtLeast(rows, 'emergency')).toBeNull()
    const ev = [{ t: at(10), workerId: 'W-1', source: 'truth' as const, label: 'x' }]
    expect(eventsNear(ev, at(11))).toHaveLength(1)
    expect(eventsNear(ev, at(13))).toHaveLength(0)
  })

  it('samples table rows on the local grid and ticks on whole hours', () => {
    const rows = Array.from({ length: 61 }, (_, i) => row(i))
    expect(sampleRows(rows, 30).map((r) => (r.t - T0) / MINUTE_MS)).toEqual([0, 30, 60])
    expect(hourTicks(at(0), at(12 * 60), 2)).toEqual([0, 2, 4, 6, 8, 10, 12].map((h) => at(h * 60)))
  })
})

describe('comparison', () => {
  it('formats metrics, deltas and meter shares', () => {
    const s = summary({ excessive: { events: 3, workers: 2 }, adherence: { instructions: 8, followed: 6 } })
    const byId = Object.fromEntries(METRICS.map((m) => [m.id, m]))
    expect(metricText(byId.excessive, s)).toBe('3')
    expect(byId.excessive.detail?.(s)).toBe('2 workers')
    expect(metricText(byId.adherence, s)).toBe('75')
    expect(metricText(byId.adherence, summary())).toBe('—')
    expect(metricText(byId.work, s)).toBe('50.0')
    expect(byId.work.detail?.(s)).toBe('5.0 h per worker-shift')
    expect(deltaText(3, 19)).toBe('−16')
    expect(deltaText(5, 5)).toBe('±0')
    expect(deltaText(50.04, 48.9, 1)).toBe('+1.1')
    expect(shareOfMax([0, 5, 10, null])).toEqual([0, 0.5, 1, 0])
    expect(shareOfMax([0, 0])).toEqual([0, 0])
  })

  it('writes a factual headline only with a baseline and a Zill policy', () => {
    const base = fakeResult('ban_only', summary({ excessive: { events: 19, workers: 7 }, dehydration: { events: 9, workers: 9 }, workMin: 3000 }))
    const full = fakeResult('zill_full', summary({ excessive: { events: 3, workers: 2 }, dehydration: { events: 1, workers: 1 }, workMin: 2700 }))
    const env = fakeResult('zill_env', summary({ excessive: { events: 5, workers: 3 }, workMin: 2800 }))
    const text = comparisonHeadline([base, env, full])
    expect(text).toContain('Zill with wearables: 3 excessive-strain events and 1 worker over 3 % dehydration, against 19 and 9 under the midday ban only')
    expect(text).toContain('10 % less work delivered')
    expect(comparisonHeadline([full])).toBeNull()
  })

  it('reports overall progress across policies', () => {
    expect(overallProgress(null)).toBe(0)
    expect(overallProgress({ phase: 'loading', policyIndex: 0, policyCount: 5, fraction: 0 })).toBe(0)
    expect(overallProgress({ phase: 'running', policyIndex: 2, policyCount: 4, fraction: 0.5 })).toBeCloseTo(0.625)
  })
})

describe('one real run (mild day, Zill with wearables)', () => {
  it('summarises a site-day into the lab result with consistent totals and packed traces', async () => {
    const loader = createNodeSimDataLoader()
    const data = await loadScenarioData('mild-day', loader)
    const d = scenarioDefaults('mild-day')
    const spec: ExperimentSpec = { source: { kind: 'scenario', scenarioId: 'mild-day' }, policies: ['zill_full'], seed: d.seed, behaviour: d.behaviour, disruptions: d.disruptions }
    const { config, script } = runSetup(spec, 'zill_full')
    const result = runSiteDay(config, data, { script })
    const out = buildPolicyRunResult(result, config.workers ?? data.workers, config.crews ?? data.crews, 1, data.weather.provenance)
    expect(out.workers.length).toBe(result.outcomes.length)
    expect(out.summary.workers).toBe(out.workers.length)
    expect(out.summary.workMin).toBe(out.workers.reduce((a, w) => a + w.workMin, 0))
    expect(out.traces.nMinutes).toBe(12 * 60)
    expect(out.traces.workerIds).toEqual(out.workers.map((w) => w.id))
    expect(out.weatherProvenance.length).toBeGreaterThan(0)
    const i = out.workers.findIndex((w) => w.wearable)
    const rows = rowsFromPacked(out.traces, Math.max(0, i))
    expect(rows.length).toBeGreaterThan(300)
    expect(rows.some((r) => r.ectBand !== null)).toBe(i >= 0)
    expect(defaultWorkerId([out])).toBe([...out.workers].sort((a, b) => b.maxCoreC - a.maxCoreC)[0].id)
  })
})
