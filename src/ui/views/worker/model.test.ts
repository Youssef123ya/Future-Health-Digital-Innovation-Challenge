import { describe, expect, it } from 'vitest'
import type { ResumeDetail } from '../../../engine/risk'
import { formatMessage, LANG_CODES } from '../../../i18n'
import {
  BUDDY_QUESTIONS,
  SELF_QUESTIONS,
  actionParamsFor,
  drinkMlPer20,
  drinkTotals,
  followUpTarget,
  initials,
  keptGroups,
  monitorState,
  nextQuestion,
  purposeKey,
  questionProgress,
  resolvePhoneWorker,
  strainGeometry,
  timerState,
  urineAdvice,
  waterGauge,
  yesSymptoms,
} from './model'
import { WORKER_MESSAGES, WORKER_MESSAGE_KEYS, wt } from './messages'

const T0 = Date.UTC(2025, 7, 1, 6, 30) // 10:30 in Abu Dhabi (UTC+4)
const MIN = 60_000

const resume = (over: Partial<ResumeDetail>): ResumeDetail => ({
  held: false,
  heldBy: [],
  taskId: 'crew:welding',
  ready: false,
  boutMin: null,
  estRestMin: null,
  infeasibleNow: false,
  nextCheckT: null,
  ...over,
})

describe('resolvePhoneWorker', () => {
  const opts = { rosterIds: ['W-1', 'W-D2A1', 'W-2'], personaIds: ['W-D2A1', 'W-D2B2'], deviceWorkerId: 'W-2' }
  it('keeps an explicit id and maps the demo alias to the first persona on the roster', () => {
    expect(resolvePhoneWorker('W-9', opts)).toBe('W-9')
    expect(resolvePhoneWorker('demo', opts)).toBe('W-D2A1')
    expect(resolvePhoneWorker(undefined, opts)).toBe('W-D2A1')
  })
  it('falls back to the device worker, then the first roster worker', () => {
    expect(resolvePhoneWorker('demo', { ...opts, personaIds: [] })).toBe('W-2')
    expect(resolvePhoneWorker('demo', { ...opts, personaIds: [], deviceWorkerId: 'W-X' })).toBe('W-1')
    expect(resolvePhoneWorker('demo', { rosterIds: [], personaIds: [], deviceWorkerId: null })).toBeNull()
  })
  it('makes initials from a display name', () => {
    expect(initials('Bikash G.')).toBe('BG')
    expect(initials('Jomar')).toBe('J')
  })
})

describe('timerState', () => {
  it('uses the engine rest estimate while held', () => {
    const s = timerState({ resume: resume({ held: true, heldBy: ['projection'], estRestMin: 25, nextCheckT: T0 + 5 * MIN }), workMinPerHour: 0, level: 'stop', now: T0 })
    expect(s).toMatchObject({ kind: 'rest', source: 'estimate', remainingMin: 25, totalMin: 60, heldBy: ['projection'] })
  })
  it('counts down to the next check when there is no estimate (task hold)', () => {
    const s = timerState({ resume: resume({ held: true, heldBy: ['regulation', 'environment'], nextCheckT: T0 + 90 * MIN }), workMinPerHour: 0, level: 'stop', now: T0 })
    expect(s).toMatchObject({ kind: 'rest', source: 'check', remainingMin: 90, totalMin: 120 })
  })
  it('reports infeasible holds and holds with no release this shift', () => {
    expect(timerState({ resume: resume({ held: true, heldBy: ['projection'], infeasibleNow: true, estRestMin: 60 }), workMinPerHour: 0, level: 'stop', now: T0 }).kind).toBe('rest_infeasible')
    expect(timerState({ resume: resume({ held: true, heldBy: ['environment'] }), workMinPerHour: 0, level: 'stop', now: T0 }).kind).toBe('rest_no_return')
  })
  it('shows the bout countdown after a release', () => {
    expect(timerState({ resume: resume({ ready: true, boutMin: 18 }), workMinPerHour: 45, level: 'high', now: T0 })).toMatchObject({ kind: 'bout', remainingMin: 18, totalMin: 30 })
  })
  it('falls back to the hour cycle, rounding work down', () => {
    expect(timerState({ resume: null, workMinPerHour: 22.9, level: 'high', now: T0 })).toEqual({ kind: 'cycle', workMin: 22, restMin: 38 })
    expect(timerState({ resume: null, workMinPerHour: 60, level: 'safe', now: T0 }).kind).toBe('cycle_free')
    expect(timerState({ resume: null, workMinPerHour: 0, level: 'safe', now: T0 }).kind).toBe('cycle_none')
    expect(timerState({ resume: null, workMinPerHour: 30, level: 'stop', now: T0 }).kind).toBe('none')
  })
})

describe('monitorState', () => {
  const env = { basis: 'monitored' as const, monitored: false, enforced: true, workMinPerHour: null, fallbackReason: null }
  it('is null under the tables basis and explains a fallback', () => {
    expect(monitorState({ ...env, basis: 'tables' })).toBeNull()
    expect(monitorState({ ...env, monitored: true, enforced: false })).toEqual({ kind: 'on' })
    expect(monitorState({ ...env, fallbackReason: 'consent' })).toEqual({ kind: 'fallback', reason: 'consent' })
  })
})

describe('water', () => {
  it('puts sweat, credit and threshold on one scale up to the 7.5 % ceiling', () => {
    const g = waterGauge({ sweatLossL: 2.1, creditedIntakeL: 3.4, netLossPctBM: -1.9, thresholdL: 5.25, restricted: false, extended: true, capped: true }, 70)
    expect(g.ceilingL).toBeCloseTo(5.25)
    expect(g.scaleMaxL).toBeCloseTo(5.25)
    expect(g.thresholdFrac).toBeCloseTo(1)
    expect(g.sweatFrac).toBeCloseTo(0.4)
    expect(g.nearLimit).toBe(false)
  })
  it('totals today and the last hour against the caps', () => {
    const intakes = [
      { t: T0 - 30 * MIN, workerId: 'W-1', ml: 250 },
      { t: T0 - 90 * MIN, workerId: 'W-1', ml: 500 },
      { t: T0 - 10 * MIN, workerId: 'W-2', ml: 250 },
      { t: T0 + 10 * MIN, workerId: 'W-1', ml: 250 },
    ]
    const d = drinkTotals(intakes, 'W-1', T0)
    expect(d.todayMl).toBe(750)
    expect(d.lastHourMl).toBe(250)
    expect(d.hourlyCapMl).toBe(1420)
    expect(d.overHourly).toBe(false)
  })
  it('turns the hourly advice into a 20-minute sip and parameterises actions', () => {
    expect(drinkMlPer20(709.8)).toBe(250)
    expect(drinkMlPer20(606)).toBe(200)
    expect(drinkMlPer20(0)).toBeNull()
    expect(actionParamsFor('drink_water', { waterMlPerHour: 709.8 })).toEqual({ ml: 250, min: 20 })
    expect(actionParamsFor('drink_water', { drinkDue: true, waterMlPerHour: 709.8 })).toEqual({ ml: 250 })
    expect(actionParamsFor('shade_breaks', { workMinPerHour: 15 })).toEqual({ workMinPerHour: 15 })
    expect(actionParamsFor('midday_break', { midday: { from: '12:30', to: '15:00' } })).toEqual({ from: '12:30', to: '15:00' })
  })
})

describe('check-in flow', () => {
  it('asks cramps_persistent only after a YES to cramps', () => {
    const base = Object.fromEntries(SELF_QUESTIONS.slice(0, 7).map((s) => [s, false]))
    expect(nextQuestion(SELF_QUESTIONS, base)).toBe('cramps')
    expect(nextQuestion(SELF_QUESTIONS, { ...base, cramps: false })).toBe('brown_urine')
    expect(nextQuestion(SELF_QUESTIONS, { ...base, cramps: true })).toBe('cramps_persistent')
    expect(questionProgress(SELF_QUESTIONS, base)).toEqual({ n: 8, total: 13 })
    expect(questionProgress(SELF_QUESTIONS, { ...base, cramps: true })).toEqual({ n: 9, total: 14 })
  })
  it('stops at the first red flag and lists the YES answers', () => {
    expect(nextQuestion(BUDDY_QUESTIONS, { collapsed_unresponsive: false, seizure: true })).toBeNull()
    expect(yesSymptoms(BUDDY_QUESTIONS, { collapsed_unresponsive: false, seizure: true })).toEqual(['seizure'])
    expect(yesSymptoms(SELF_QUESTIONS, { cramps: false, cramps_persistent: true, headache: true })).toEqual(['headache'])
  })
  it('finds the check-in to follow up', () => {
    const c = [
      { id: 'a', t: T0 - 20 * MIN, workerId: 'W-1', by: 'self' as const, symptoms: ['headache' as const] },
      { id: 'b', t: T0 - 5 * MIN, workerId: 'W-1', by: 'self' as const, symptoms: [] },
      { id: 'c', t: T0 - 90 * MIN, workerId: 'W-1', by: 'self' as const, symptoms: ['dizziness' as const] },
    ]
    expect(followUpTarget(c, 'W-1', T0)?.id).toBe('a')
    expect(followUpTarget(c, 'W-2', T0)).toBeNull()
  })
  it('maps the urine scale', () => {
    expect([1, 3, 4, 5, 8].map(urineAdvice)).toEqual(['ok', 'ok', 'drink_more', 'dark', 'dark'])
  })
})

describe('privacy helpers', () => {
  it('groups the kept keys and always lists the on-device records', () => {
    expect(keptGroups(['assessment.drivers', 'profile.riskFlags', 'profile.massKg'])).toEqual(['reasons', 'heart', 'flags', 'checkins', 'water', 'body'])
  })
  it('labels prohibited purposes as forbidden', () => {
    expect(purposeKey('safety_alerting')).toBe('p_safety')
    expect(purposeKey('immigration_or_visa')).toBe('p_forbidden')
  })
  it('places the strain band on its scale', () => {
    const g = strainGeometry({ lowC: 37.6, highC: 38.8, centreC: 38.2 })
    expect(g.lowFrac).toBeCloseTo(0.4)
    expect(g.highFrac).toBeCloseTo(0.7)
    expect(g.centreFrac).toBeCloseTo(0.55)
  })
})

describe('worker messages', () => {
  const sample = { time: '10:30', min: 3, task: 'Pipe welding', ml: 250, today: '1.8', cap: '11.4', l: '5.3', n: 2, total: 9, name: 'Shaji V.' }
  it('provides every key in every language, and every template formats cleanly', () => {
    for (const lang of LANG_CODES) {
      for (const key of WORKER_MESSAGE_KEYS) {
        const template = WORKER_MESSAGES[lang][key]
        expect(typeof template === 'string' && template.trim().length > 0, `${lang}.${key}`).toBe(true)
        const out = formatMessage(template, lang, sample)
        expect(out.includes('{'), `${lang}.${key}: ${out}`).toBe(false)
      }
    }
  })
  it('uses plural agreement in English and Arabic', () => {
    expect(wt('en', 'recheck', { min: 1 })).toBe('Zill will ask again in 1 minute.')
    expect(wt('en', 'recheck', { min: 15 })).toBe('Zill will ask again in 15 minutes.')
    expect(wt('ar', 'recheck', { min: 2 })).toContain('دقيقتين')
  })
})
