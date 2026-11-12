import { describe, expect, it } from 'vitest'
import type { WorkerDeviceModel } from '../../../state'
import { BATTERY_SAVER_REDRAW_MIN, saverKeepsPrevious } from './model'
import { phoneLanguage } from './phonePrefs'

const MIN = 60_000

/** Just the fields the battery-saver rule reads. */
function model(over: { t?: number; level?: 'safe' | 'caution' | 'high' | 'stop' | 'emergency'; checkins?: number; intakes?: number; wearable?: boolean; network?: 'online' | 'offline'; alert?: { id: string; status: string } | null; workerId?: string }): WorkerDeviceModel {
  return {
    workerId: over.workerId ?? 'W-1',
    t: over.t ?? 0,
    assessment: { level: over.level ?? 'caution' },
    alert: over.alert ?? null,
    ackStatus: 'none',
    checkinDue: false,
    device: { checkins: Array.from({ length: over.checkins ?? 0 }), intakes: Array.from({ length: over.intakes ?? 0 }), levels: [], maxLevel: 'safe' },
    profile: { consent: { wearable: over.wearable ?? true, healthFlags: true, checkins: true, shareWithMedicOnEscalation: true, aggregateStatistics: true, updatedAt: 0 } },
    site: { network: over.network ?? 'online' },
  } as unknown as WorkerDeviceModel
}

describe('phone language', () => {
  it('prefers the choice made on the phone, then the address, then the worker profile', () => {
    expect(phoneLanguage({ choice: 'ar', urlLang: 'hi', profileLang: 'ne' })).toBe('ar')
    expect(phoneLanguage({ choice: null, urlLang: 'hi', profileLang: 'ne' })).toBe('hi')
    expect(phoneLanguage({ choice: null, urlLang: null, profileLang: 'ne' })).toBe('ne')
  })
  it('ignores an unknown address language and falls back to English without a profile', () => {
    expect(phoneLanguage({ choice: null, urlLang: 'xx', profileLang: 'ml' })).toBe('ml')
    expect(phoneLanguage({ choice: null, urlLang: undefined, profileLang: undefined })).toBe('en')
  })
})

describe('battery saver', () => {
  it('keeps the drawn screen while nothing the worker must see changes, within the redraw interval', () => {
    expect(saverKeepsPrevious(model({ t: 0 }), model({ t: 5 * MIN }))).toBe(true)
    expect(saverKeepsPrevious(model({ t: 0 }), model({ t: BATTERY_SAVER_REDRAW_MIN * MIN }))).toBe(false)
  })
  it('redraws at once on a level, alert, record, consent or network change, and for another worker', () => {
    const prev = model({ t: 0 })
    expect(saverKeepsPrevious(prev, model({ t: MIN, level: 'high' }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, alert: { id: 'a1', status: 'open' } }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, intakes: 1 }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, checkins: 1 }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, wearable: false }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, network: 'offline' }))).toBe(false)
    expect(saverKeepsPrevious(prev, model({ t: MIN, workerId: 'W-2' }))).toBe(false)
    expect(saverKeepsPrevious(null, prev)).toBe(false)
  })
  it('never holds a screen when the clock goes back (a rewind redraws)', () => {
    expect(saverKeepsPrevious(model({ t: 10 * MIN }), model({ t: 5 * MIN }))).toBe(false)
  })
})
