import { describe, expect, it } from 'vitest'
import { buildDemoCrew } from '../../data/workforce'
import { getScenario } from '../../sim/scenarios'
import { TOUR_SCENARIO, TOUR_STEPS, nextIndex, tourSeconds } from './tourSteps'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

describe('guided demo script', () => {
  it('runs about two minutes', () => {
    const s = tourSeconds()
    expect(s).toBeGreaterThanOrEqual(100)
    expect(s).toBeLessThanOrEqual(140)
  })

  it('covers every Challenge 07 criterion at least once', () => {
    const covered = new Set(TOUR_STEPS.map((s) => s.criterion.n))
    for (const n of [1, 2, 3, 4, 5, 6] as const) expect(covered.has(n)).toBe(true)
  })

  it('uses demo-crew phones, valid shift times and readable captions', () => {
    const crew = new Set(buildDemoCrew().workers.map((w) => w.id))
    const shift = getScenario(TOUR_SCENARIO).config.shift ?? { start: '05:00', end: '17:00' }
    for (const step of TOUR_STEPS) {
      if (step.phone) expect(crew.has(step.phone.workerId)).toBe(true)
      if (step.at) {
        expect(step.at).toMatch(HHMM)
        expect(step.at >= shift.start && step.at <= shift.end).toBe(true)
      }
      expect(step.caption.length).toBeLessThanOrEqual(320)
      expect(step.seconds).toBeGreaterThanOrEqual(8)
    }
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length)
  })

  it('shows the scripted peak-day moments after they happen', () => {
    const at = (id: string) => TOUR_STEPS.find((s) => s.id === id)?.at ?? ''
    expect(at('sensor') > '11:00' && at('sensor') < '11:30').toBe(true)
    expect(at('redflag') > '14:10').toBe(true)
    expect(at('offline') > '15:30' && at('offline') < '15:50').toBe(true)
  })

  it('steps forward and stops at the end', () => {
    expect(nextIndex(0)).toBe(1)
    expect(nextIndex(TOUR_STEPS.length - 1)).toBeNull()
  })
})
