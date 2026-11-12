import { describe, expect, it } from 'vitest'
import { SCENARIO_IDS, SCENARIO_SHIFT, getScenario, PEAK_DAY_CONFUSION_WORKER } from '../../../sim/scenarios'
import { hhmmMinutes } from '../../shell/time'
import { DEMO_START_TIMES, inMiddayBreakSeason, jumpTargetFor, narrationItems, narrationStates, scriptedTitle } from './narration'

describe('demo narration', () => {
  it('starts every scenario inside its shift', () => {
    for (const id of SCENARIO_IDS) {
      const t = hhmmMinutes(DEMO_START_TIMES[id])
      expect(t).toBeGreaterThan(hhmmMinutes(SCENARIO_SHIFT.start))
      expect(t).toBeLessThan(hhmmMinutes(SCENARIO_SHIFT.end))
    }
  })

  it('knows the midday-break season (15 Jun – 15 Sep inclusive)', () => {
    expect(inMiddayBreakSeason('2025-06-15')).toBe(true)
    expect(inMiddayBreakSeason('2025-09-15')).toBe(true)
    expect(inMiddayBreakSeason('2025-06-14')).toBe(false)
    expect(inMiddayBreakSeason('2025-11-26')).toBe(false)
    expect(inMiddayBreakSeason('bad')).toBe(false)
  })

  it('lists the peak day in time order with the break window and the shift end', () => {
    const items = narrationItems(getScenario('peak-day'))
    const times = items.map((i) => i.at)
    expect(times).toEqual([...times].sort())
    expect(items.filter((i) => i.kind === 'scripted')).toHaveLength(getScenario('peak-day').events.length)
    const brk = items.find((i) => i.kind === 'rule')
    expect(brk).toMatchObject({ at: '12:30', until: '15:00' })
    expect(items.at(-1)).toMatchObject({ kind: 'shift', at: '17:00' })
    const confusion = items.find((i) => i.at === '14:10')
    expect(confusion?.workerId).toBe(PEAK_DAY_CONFUSION_WORKER)
    expect(confusion?.title).toBe('Buddy reports confusion')
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('has no midday break on the mild November day', () => {
    expect(narrationItems(getScenario('mild-day')).some((i) => i.kind === 'rule')).toBe(false)
  })

  it('marks now, next, later and past against the simulated clock', () => {
    const items = narrationItems(getScenario('peak-day'))
    const at = (now: string | null) => narrationStates(items, now)
    const idx = (t: string) => items.findIndex((i) => i.at === t)
    const s1 = at('10:00')
    expect(s1[idx('11:00')]).toBe('next')
    expect(s1.filter((s) => s === 'next')).toHaveLength(1)
    expect(s1.every((s) => s === 'next' || s === 'later')).toBe(true)
    const s2 = at('11:05')
    expect(s2[idx('11:00')]).toBe('now')
    expect(s2[idx('11:30')]).toBe('next')
    const s3 = at('13:00')
    expect(s3[idx('12:30')]).toBe('now')
    expect(s3[idx('11:00')]).toBe('past')
    expect(at(null)[0]).toBe('next')
  })

  it('jumps a little before an event, never before the shift', () => {
    expect(jumpTargetFor({ at: '14:10' })).toBe('14:08')
    expect(jumpTargetFor({ at: '05:01' }, 2, '05:00')).toBe('05:00')
  })

  it('titles system events and check-ins', () => {
    expect(scriptedTitle({ at: '11:00', note: '', injection: { kind: 'system', what: 'network_down' } })).toBe('Site network drops')
    expect(
      scriptedTitle({ at: '11:00', note: '', injection: { kind: 'checkin', checkin: { t: 0, workerId: 'w', by: 'self', symptoms: [] } } }),
    ).toBe('Worker check-in')
  })
})
