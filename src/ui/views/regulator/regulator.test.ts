import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Alert } from '../../../engine/types'
import type { AggregateTable, PublishedCell } from '../../../engine/privacy'
import { getRulePack } from '../../../engine/regulation'
import { MINUTE_MS, epochFromLocal } from '../../../engine/time'
import { createNodeSimDataLoader } from '../../../sim/simdata'
import { loadScenarioData } from '../../../sim/scenarios'
import type { SiteHour, SimData } from '../../../sim/types'
import { createSimStore, selectorInput, type SimStore } from '../../../state'
import { aggregatesCsv, csvField, suppressedText, type CsvTable } from './format'
import {
  ackBin,
  dayAlerts,
  middaySunMinutes,
  publishedShare,
  ratePer1000,
  responseRecords,
  selectOps,
  sunSegments,
  workerAlertRecords,
  zoneHourChecks,
  type OpsAggregate,
  type OpsScope,
  type TaskMark,
} from './opsModel'
import { getOpsHistory, startOpsLog, stopOpsLog } from './opsLog'
import { hourRows, middayBreakHours, seasonRows, seriesFor, type HoursInZoneFile } from './weatherData'
import { readFileSync } from 'node:fs'

const T0 = epochFromLocal('2025-08-01T10:00')
const min = (m: number): number => T0 + m * MINUTE_MS

function alert(p: Partial<Alert> & Pick<Alert, 'id'>): Alert {
  return { t: T0, siteId: 'musaffah', scope: 'worker', workerId: 'W-1', level: 'high', actions: [], reason: 'r', status: 'active', ...p }
}

describe('format', () => {
  it('escapes CSV fields and neutralises formula prefixes', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvField(-3)).toBe('-3')
    expect(csvField('plain')).toBe('plain')
  })

  it('writes suppressed cells as words, never as numbers', () => {
    const s: PublishedCell = { suppressed: true }
    const n = (count: number): PublishedCell => ({ suppressed: false, count })
    const table: AggregateTable = { k: 10, rows: ['a', 'b'], cols: ['x', 'y'], cells: [[s, n(0)], [n(12), s]], rowTotals: [s, s], colTotals: [s, s], total: n(25), suppressedCells: 6 }
    const t: CsvTable = { title: 'T', rowHeader: 'Row', rowLabel: (r) => r.toUpperCase(), colLabel: (c) => c, note: 'allowed', k: 10, table }
    const csv = aggregatesCsv([['Role', 'Regulator']], [t, { ...t, title: 'Refused', table: null, k: null }])
    expect(csv).toContain(`A,${suppressedText(10)},0,${suppressedText(10)}`)
    expect(csv).toContain(`B,12,${suppressedText(10)},${suppressedText(10)}`)
    expect(csv).toContain(`Total,${suppressedText(10)},${suppressedText(10)},25`)
    expect(csv).toContain('No table released')
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})

describe('sun work, midday break and zone controls', () => {
  const marks: TaskMark[] = [
    { t: min(0), taskId: 'dig', location: 'sun' },
    { t: min(30), taskId: null, location: 'shade' },
    { t: min(40), taskId: 'dig', location: 'sun' },
    { t: min(50), taskId: 'weld', location: 'shade' },
  ]

  it('builds sun segments from task marks, cut at the stop time', () => {
    expect(sunSegments(marks, min(100))).toEqual([
      { a: min(0), b: min(30), taskId: 'dig' },
      { a: min(40), b: min(50), taskId: 'dig' },
    ])
    expect(sunSegments(marks, min(20))).toEqual([{ a: min(0), b: min(20), taskId: 'dig' }])
  })

  it('counts sun minutes inside the midday window only', () => {
    const segs = sunSegments(marks, min(100))
    expect(middaySunMinutes(segs, { startT: min(25), endT: min(45) })).toBe(10)
    expect(middaySunMinutes(segs, null)).toBe(0)
  })

  it('flags worker-hours above the zone allowance', () => {
    const pack = getRulePack('abu-dhabi')
    const hours: SiteHour[] = [{ t: min(0), wbgtC: 33, wbgtShadeC: 30, twlWm2: 100, twlZone: 'high', middayBreak: false }]
    const tasks = new Map([['dig', { workClass: 'heavy' as const }]])
    const full = zoneHourChecks([{ a: min(0), b: min(60), taskId: 'dig' }], hours, tasks, false, pack, min(60))
    expect(full).toHaveLength(1)
    expect(full[0].within).toBe(false)
    const brief = zoneHourChecks([{ a: min(0), b: min(5), taskId: 'dig' }], hours, tasks, false, pack, min(60))
    expect(brief[0].within).toBe(true)
    const low: SiteHour[] = [{ ...hours[0], twlWm2: 200, twlZone: 'low' }]
    expect(zoneHourChecks([{ a: min(0), b: min(60), taskId: 'dig' }], low, tasks, false, pack, min(60))).toEqual([])
  })
})

describe('alert records', () => {
  it('counts worker alerts by basis and delivery', () => {
    const recs = workerAlertRecords(
      [
        alert({ id: 'a', basis: 'exposure' }),
        alert({ id: 'b' }),
        alert({ id: 'c', basis: 'exposure', suppression: { reason: 'action_in_force', t: T0 } }),
        alert({ id: 'd', basis: 'exposure', suppression: { reason: 'action_in_force', t: T0, liftedAt: min(3) } }),
        alert({ id: 'e', scope: 'crew', workerId: undefined, crewId: 'C1', basis: 'exposure' }),
        alert({ id: 'f', t: min(99) }),
      ],
      min(10),
    )
    expect(recs).toEqual([
      { basis: 'exposure', delivery: 'notified', subject: 'W-1' },
      { basis: 'individual', delivery: 'notified', subject: 'W-1' },
      { basis: 'exposure', delivery: 'logged', subject: 'W-1' },
      { basis: 'exposure', delivery: 'notified', subject: 'W-1' },
    ])
  })

  it('bins acknowledgement times from notification and keeps escalations', () => {
    expect([ackBin(0.5), ackBin(1), ackBin(1.5), ackBin(2), ackBin(9), ackBin(11), ackBin(null)]).toEqual(['le1', 'le1', 'le2', 'le2', 'le10', 'gt10', 'none'])
    const recs = responseRecords(
      [
        alert({ id: 'a', level: 'stop', ack: { role: 'supervisor', t: min(1.5) }, escalatedAt: min(2) }),
        alert({ id: 'b', level: 'caution' }),
        alert({ id: 'c', level: 'high', suppression: { reason: 'action_in_force', t: T0, liftedAt: min(5) }, ack: { role: 'worker', t: min(5.5) } }),
        alert({ id: 'd', level: 'high', suppression: { reason: 'action_in_force', t: T0 } }),
        alert({ id: 'e', level: 'stop', scope: 'crew', workerId: undefined, crewId: 'C1' }),
      ],
      min(10),
    )
    expect(recs).toEqual([
      { level: 'stop', bin: 'le2', escalated: true, subject: 'W-1' },
      { level: 'high', bin: 'le1', escalated: false, subject: 'W-1' },
      { level: 'stop', bin: 'none', escalated: false, subject: 'crew:C1' },
    ])
  })

  it('merges logged alert versions with the current ones', () => {
    const logged = new Map([
      ['a', alert({ id: 'a', status: 'active' })],
      ['old', alert({ id: 'old', status: 'resolved' })],
    ])
    const merged = dayAlerts(logged, [alert({ id: 'a', status: 'acknowledged' })])
    expect(merged.map((a) => `${a.id}:${a.status}`).sort()).toEqual(['a:acknowledged', 'old:resolved'])
  })

  it('derives shares and rates from published cells only', () => {
    const n = (count: number): PublishedCell => ({ suppressed: false, count })
    expect(publishedShare(n(3), n(4))).toBe(0.75)
    expect(publishedShare({ suppressed: true }, n(4))).toBeNull()
    expect(publishedShare(n(0), n(0))).toBeNull()
    expect(ratePer1000(n(5), 50)).toBe(100)
    expect(ratePer1000({ suppressed: true }, 50)).toBeNull()
    expect(ratePer1000(n(5), null)).toBeNull()
  })
})

describe('hours-in-zone transforms', () => {
  const data = JSON.parse(readFileSync('public/data/validation/hours-in-zone.json', 'utf8')) as HoursInZoneFile

  it('orders series from the most severe band and charts the controlled ADOSH zones only', () => {
    const w = seriesFor(data, 'wbgt')
    expect(w).toHaveLength(5)
    expect(w[0].id).toBe('above_rel115')
    expect(w[4].id).toBe('below_rel300')
    expect(seriesFor(data, 'adosh').map((s) => s.id)).toEqual(['high', 'medium'])
  })

  it('keeps season and hour-of-day totals', () => {
    const rows = seasonRows(data, 'wbgt', ['musaffah', 'kezad'], (id) => id)
    expect(rows.map((r) => r.key)).toEqual(['musaffah', 'kezad'])
    for (const r of rows) expect(Math.abs(r.total - 2928)).toBeLessThan(1)
    const hrs = hourRows(data, 'musaffah', 'wbgt')
    expect(hrs).toHaveLength(24)
    for (const r of hrs) expect(Math.abs(r.total - 122)).toBeLessThan(1)
  })

  it('maps the 12:30–15:00 midday break onto the 13:00 and 14:00 samples', () => {
    expect(middayBreakHours('12:30', '15:00')).toEqual([13, 14])
    expect(middayBreakHours('10:00', '15:30')).toEqual([10, 11, 12, 13, 14, 15])
  })
})

describe('live operations aggregates (peak-day, end to end)', () => {
  let sim: SimStore
  let data: SimData
  beforeAll(async () => {
    const base = createNodeSimDataLoader()
    data = await loadScenarioData('peak-day', base)
    sim = createSimStore({
      loader: { weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() },
      scheduler: { now: () => 0, requestFrame: () => 0, cancelFrame: () => undefined, yieldToUi: () => Promise.resolve() },
    })
    stopOpsLog()
    startOpsLog(sim)
    await sim.getState().loadScenario('peak-day')
    await sim.getState().jumpTo('14:30')
  }, 120_000)
  afterAll(() => stopOpsLog())

  const scopes: OpsScope[] = [
    { role: 'regulator', actorId: 'ADPHC-1', rowsBy: 'site' },
    { role: 'hse_manager', actorId: 'HSE-1', rowsBy: 'crew' },
  ]

  it('collects a complete history from start-up', () => {
    const h = getOpsHistory()
    expect(h.complete).toBe(true)
    expect(h.tasks.size).toBeGreaterThan(0)
    expect(h.alerts.size).toBeGreaterThanOrEqual(sim.getState().view!.alerts.length)
  })

  for (const scope of scopes) {
    it(`${scope.role}: publishes no cell below k and no individual id`, () => {
      const input = selectorInput(sim.getState())!
      const { model, audit } = selectOps(input, getOpsHistory(), scope)
      const k = scope.role === 'regulator' ? 10 : 5
      const tables: OpsAggregate[] = [model.zone, model.alerts, model.response, model.escalation, ...(model.midday.table ? [model.midday.table] : [])]
      for (const t of tables) {
        expect(t.decision).toBe('allowed')
        expect(t.k).toBe(k)
        const tb = t.table!
        for (const c of [...tb.cells.flat(), ...tb.rowTotals, ...tb.colTotals, tb.total]) if (!c.suppressed) expect(c.count === 0 || c.count >= k).toBe(true)
      }
      expect(audit).toHaveLength(tables.length)
      for (const a of audit) expect(a).toMatchObject({ actorRole: scope.role, purpose: 'compliance_reporting', decision: 'allowed' })
      const json = JSON.stringify(model)
      for (const w of input.view.workers) expect(json.includes(`"${w.profile.id}"`)).toBe(false)
      expect(model.midday.window).not.toBeNull()
    })
  }
})
