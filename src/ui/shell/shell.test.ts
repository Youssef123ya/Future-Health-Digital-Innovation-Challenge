import { describe, expect, it } from 'vitest'
import { POLICY_IDS } from '../../sim/types'
import { SCENARIO_IDS } from '../../sim/scenarios'
import { formatScenarioDate, hhmmMinutes, isHhmm, minutesHhmm, shiftProgress } from './time'
import {
  DEFAULT_POLICY,
  PLAN_BASIS_OPTIONS,
  POLICY_LABELS,
  isPlanBasisPolicy,
  parseScenarioQuery,
  pathWithQuery,
  scenarioQueryKey,
  scenarioTitle,
  withScenarioQuery,
} from './scenario'
import { DOC_LINKS, docHref } from './SiteFooter'

describe('shell time helpers', () => {
  it('validates and converts HH:mm', () => {
    expect(isHhmm('05:00')).toBe(true)
    expect(isHhmm('23:59')).toBe(true)
    for (const bad of ['24:00', '5:00', '12:60', '', null, undefined]) expect(isHhmm(bad)).toBe(false)
    expect(hhmmMinutes('10:30')).toBe(630)
    expect(hhmmMinutes('nope')).toBeNaN()
    expect(minutesHhmm(630)).toBe('10:30')
    expect(minutesHhmm(-5)).toBe('00:00')
    expect(minutesHhmm(5000)).toBe('23:59')
  })

  it('computes shift progress, clamped, and null for bad input', () => {
    const shift = { start: '05:00', end: '17:00' }
    expect(shiftProgress('11:00', shift)).toBeCloseTo(0.5)
    expect(shiftProgress('04:00', shift)).toBe(0)
    expect(shiftProgress('18:00', shift)).toBe(1)
    expect(shiftProgress(null, shift)).toBeNull()
    expect(shiftProgress('11:00', { start: '17:00', end: '05:00' })).toBeNull()
  })

  it('formats scenario dates without a time zone', () => {
    expect(formatScenarioDate('2025-08-01')).toBe('Fri 1 Aug 2025')
    expect(formatScenarioDate('2025-11-26', { weekday: false })).toBe('26 Nov 2025')
    expect(formatScenarioDate('2025-02-30')).toBe('2025-02-30')
    expect(formatScenarioDate('soon')).toBe('soon')
  })
})

describe('scenario URL contract', () => {
  it('parses the same keys as bootstrap and ignores invalid values', () => {
    expect(parseScenarioQuery({ scenario: 'humid-day', policy: 'zill_monitored', t: '11:00', speed: '60', play: '1' })).toEqual({
      scenario: 'humid-day',
      policy: 'zill_monitored',
      t: '11:00',
      speed: 60,
      play: true,
    })
    expect(parseScenarioQuery({ scenario: 'nope', policy: 'hr', t: '25:00', speed: '7' })).toEqual({
      scenario: null,
      policy: null,
      t: null,
      speed: null,
      play: false,
    })
  })

  it('gives each request a stable key', () => {
    const a = parseScenarioQuery({ scenario: 'peak-day', t: '10:45' })
    expect(scenarioQueryKey(a)).toBe(scenarioQueryKey(parseScenarioQuery({ t: '10:45', scenario: 'peak-day' })))
    expect(scenarioQueryKey(a)).not.toBe(scenarioQueryKey(parseScenarioQuery({ scenario: 'peak-day' })))
  })

  it('replaces the scenario keys, keeps other keys and omits the default policy', () => {
    const q = withScenarioQuery({ lang: 'ar', speed: '300', t: '09:00', clock: 'lead' }, { scenario: 'mild-day', policy: DEFAULT_POLICY })
    expect(q).toEqual({ lang: 'ar', clock: 'lead', scenario: 'mild-day' })
    expect(withScenarioQuery({}, { scenario: 'peak-day', policy: 'zill_monitored', t: '10:45', play: true })).toEqual({
      scenario: 'peak-day',
      policy: 'zill_monitored',
      t: '10:45',
      play: '1',
    })
    expect(pathWithQuery('/demo', { scenario: 'peak-day', t: '10:45' })).toBe('/demo?scenario=peak-day&t=10%3A45')
    expect(pathWithQuery('/demo', {})).toBe('/demo')
  })

  it('labels every policy and offers exactly the two plan bases', () => {
    for (const p of POLICY_IDS) expect(POLICY_LABELS[p]).toBeTruthy()
    expect(PLAN_BASIS_OPTIONS.map((o) => o.policy)).toEqual(['zill_full', 'zill_monitored'])
    expect(isPlanBasisPolicy('zill_monitored')).toBe(true)
    expect(isPlanBasisPolicy('ban_only')).toBe(false)
    expect(isPlanBasisPolicy(null)).toBe(false)
  })

  it('titles scenarios', () => {
    for (const id of SCENARIO_IDS) expect(scenarioTitle(id)).not.toBe(id)
    expect(scenarioTitle(null)).toBe('No scenario loaded')
  })
})

describe('footer document links', () => {
  it('resolves repository-relative paths', () => {
    expect(docHref('docs/ARCHITECTURE.md')).toMatch(/\/blob\/main\/docs\/ARCHITECTURE\.md$/)
    expect(docHref('./README.md')).toMatch(/\/blob\/main\/README\.md$/)
    expect(new Set(DOC_LINKS.map((d) => d.path)).size).toBe(DOC_LINKS.length)
  })
})
