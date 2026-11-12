import { describe, expect, it } from 'vitest'
import type { Alert, RiskDriver } from '../../../engine/types'
import { epochFromLocal, MINUTE_MS } from '../../../engine/time'
import { CONSOLE_PHRASES } from '../../../i18n/messages'
import type { AlertItem } from '../../../state/selectors'
import {
  RECOVERY_REST,
  WITHHELD_TEXT,
  addWorkingDays,
  bandDomain,
  caseChain,
  caseKeyOf,
  caseKind,
  caseTimeline,
  formGNotice,
  formatLocalDay,
  isCleanRecheck,
  nextRecheckDue,
  parseCaseLocation,
  psiFromDrivers,
  recheckStatus,
  restProgress,
  signoffConditions,
  sortSymptoms,
  symptomView,
  toCaseVMs,
  trendRows,
  urineReading,
  waterHold,
  type PlaceObs,
  type RestStatus,
  type SignoffInput,
} from './medicModel'

const T0 = epochFromLocal('2025-08-01T10:00')
const min = (m: number) => T0 + m * MINUTE_MS
const en = CONSOLE_PHRASES.en
const NO_OUTCOME = { fatality: false, inpatientHospitalTreatment: false, lossOfConsciousnessOrResuscitation: false, unableToWorkNextShift: false }

function alert(p: Partial<Alert> & Pick<Alert, 'id' | 't' | 'level'>): Alert {
  return { siteId: 'musaffah', workerId: 'W-1', scope: 'worker', actions: [], reason: '', status: 'active', ...p }
}

function item(p: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 'A2',
    t: min(5),
    scope: 'worker',
    workerId: 'W-1',
    level: 'stop',
    actions: ['stop_work'],
    reason: 'First-aid check needed',
    reasonText: 'First-aid check needed',
    reasonKey: 'reason.first_aid_check',
    basis: 'individual',
    basisLabel: 'This worker',
    suppressed: false,
    status: 'escalated',
    ...p,
  }
}

const restNone: RestStatus = restProgress([])

function signoff(p: Partial<SignoffInput>): ReturnType<typeof signoffConditions> {
  return signoffConditions({
    kind: 'device',
    level: 'stop',
    role: 'first_aider',
    rest: restNone,
    recheck: { latest: null, why: 'none', valid: false },
    clinicalReleased: false,
    water: null,
    handoverConfirmed: false,
    ...p,
  })
}

describe('parseCaseLocation', () => {
  it('reads task and place from the released label', () => {
    expect(parseCaseLocation(`Musaffah · Pipe rack · ${en.location_sun}`)).toEqual({ site: 'Musaffah', task: 'Pipe rack', place: 'sun', resting: false })
  })
  it('counts rest only off task and out of the sun', () => {
    expect(parseCaseLocation(`Musaffah · ${en.no_task} · ${en.location_indoor_cool}`)).toMatchObject({ task: null, place: 'indoor_cool', resting: true })
    expect(parseCaseLocation(`Musaffah · ${en.no_task} · ${en.location_sun}`).resting).toBe(false)
    expect(parseCaseLocation(`Musaffah · Pipe rack · ${en.location_shade}`).resting).toBe(false)
  })
  it('reads the label in another console language', () => {
    const ar = CONSOLE_PHRASES.ar
    expect(parseCaseLocation(`Musaffah · ${ar.no_task} · ${ar.location_shade}`)).toMatchObject({ place: 'shade', resting: true })
  })
  it('never counts an unreadable label as rest', () => {
    expect(parseCaseLocation('somewhere')).toMatchObject({ place: null, resting: false })
    expect(parseCaseLocation(null)).toMatchObject({ place: null, resting: false })
  })
})

describe('restProgress', () => {
  const cooled = (from: number, to: number): PlaceObs[] => Array.from({ length: to - from + 1 }, (_, i) => ({ t: min(from + i), place: 'indoor_cool', resting: true }))
  it('meets the requirement after 30 min in a cooled area', () => {
    const r = restProgress(cooled(0, 31))
    expect(r.metT).toBe(min(RECOVERY_REST.cooledMin))
    expect(r.progress).toBe(1)
  })
  it('weights shade at 45 min', () => {
    const shade: PlaceObs[] = Array.from({ length: 46 }, (_, i) => ({ t: min(i), place: 'shade', resting: true }))
    expect(restProgress(shade.slice(0, 31)).metT).toBeNull()
    expect(restProgress(shade).metT).toBe(min(45))
  })
  it('restarts the bout after work or a long gap', () => {
    const obs = [...cooled(0, 20), { t: min(21), place: 'sun' as const, resting: false }, ...cooled(22, 40)]
    const r = restProgress(obs)
    expect(r.boutStartT).toBe(min(22))
    expect(r.metT).toBeNull()
    const gap = restProgress([...cooled(0, 10), ...cooled(30, 35)])
    expect(gap.boutStartT).toBe(min(30))
  })
})

describe('re-checks', () => {
  it('a re-check is clean without T2 or T3 symptoms', () => {
    expect(isCleanRecheck([])).toBe(true)
    expect(isCleanRecheck(['thirst', 'cramps'])).toBe(true)
    expect(isCleanRecheck(['headache'])).toBe(false)
  })
  it('counts only a clean re-check after the met rest and before any new symptom', () => {
    const e = (m: number, symptoms: Parameters<typeof isCleanRecheck>[0] = []) => ({ t: min(m), symptoms: [...symptoms], clean: isCleanRecheck(symptoms) })
    expect(recheckStatus([], min(0), min(30), null).why).toBe('none')
    expect(recheckStatus([e(35, ['dizziness'])], min(0), min(30), null).why).toBe('not_clean')
    expect(recheckStatus([e(20)], min(0), min(30), null).why).toBe('before_rest')
    expect(recheckStatus([e(35)], min(0), null, null).why).toBe('before_rest')
    expect(recheckStatus([e(35)], min(0), min(30), min(40)).why).toBe('superseded')
    expect(recheckStatus([e(35)], min(0), min(30), min(10))).toMatchObject({ why: 'ok', valid: true })
  })
  it('schedules re-checks at +15, +30, then every 15 min', () => {
    expect(nextRecheckDue(min(0), null)).toBe(min(15))
    expect(nextRecheckDue(min(0), min(16))).toBe(min(30))
    expect(nextRecheckDue(min(0), min(31))).toBe(min(45))
    expect(nextRecheckDue(min(0), min(46))).toBe(min(60))
  })
  it('sorts symptoms most severe first', () => {
    expect(sortSymptoms(['thirst', 'confusion', 'headache', 'thirst'])).toEqual(['confusion', 'headache', 'thirst'])
  })
})

describe('caseKind', () => {
  it('classifies from the console alert only', () => {
    expect(caseKind({ level: 'emergency', basis: 'individual', reasonKey: 'reason.emergency' })).toBe('clinical')
    expect(caseKind({ level: 'stop', basis: 'exposure' })).toBe('site')
    expect(caseKind({ level: 'stop', basis: 'individual', reasonKey: 'reason.first_aid_check' })).toBe('clinical')
    expect(caseKind({ level: 'stop', basis: 'individual', reasonKey: 'reason.not_cleared_for_heat_work' })).toBe('device')
  })
})

describe('caseChain', () => {
  const alerts: Alert[] = [
    alert({ id: 'A0', t: min(-10), level: 'high', status: 'resolved', resolvedAt: min(0) }),
    alert({ id: 'A1', t: min(0), level: 'stop', status: 'resolved', resolvedAt: min(5), acks: [{ role: 'supervisor', t: min(1) }], escalatedAt: min(0), escalatedTo: ['first_aider'] }),
    alert({ id: 'A2', t: min(5), level: 'emergency', status: 'escalated', escalatedAt: min(5), escalatedTo: ['first_aider', 'occ_health'], reason: 'raw reason never copied' }),
    alert({ id: 'B1', t: min(5), level: 'stop', workerId: 'W-2' }),
  ]
  it('follows superseded stop-or-above alerts back to the start of the episode', () => {
    const chain = caseChain(alerts, 'W-1', 'A2')
    expect(chain.map((c) => c.id)).toEqual(['A1', 'A2'])
    expect(chain[0]).toEqual({ id: 'A1', t: min(0), level: 'stop', acks: [{ role: 'supervisor', t: min(1) }], escalatedAt: min(0), escalatedTo: ['first_aider'], resolvedAt: min(5) })
    expect(Object.keys(chain[1] ?? {})).not.toContain('reason')
  })
  it('keys the case by worker and episode start', () => {
    const [vm] = toCaseVMs([{ workerId: 'W-1', data: { displayName: 'Ramesh', level: 'emergency' }, fields: ['displayName', 'level'], withheld: ['symptoms'], alert: item({ id: 'A2', level: 'emergency' }), escalated: true }], 'first_aider', alerts)
    expect(vm?.key).toBe(caseKeyOf('W-1', min(0)))
    expect(vm?.startT).toBe(min(0))
    expect(vm?.symptoms).toEqual({ state: 'withheld', reason: WITHHELD_TEXT.firstAiderSymptoms })
    expect(vm?.location).toBeNull()
  })
})

describe('symptomView', () => {
  it('states why symptoms are withheld, per role', () => {
    expect(symptomView('first_aider', ['displayName'], {})).toEqual({ state: 'withheld', reason: WITHHELD_TEXT.firstAiderSymptoms })
    expect(symptomView('occ_health', ['displayName'], {})).toEqual({ state: 'withheld', reason: WITHHELD_TEXT.ohClinical })
    expect(symptomView('first_aider', ['symptoms'], { symptoms: ['thirst', 'seizure'] })).toEqual({ state: 'released', list: ['seizure', 'thirst'] })
    expect(symptomView('first_aider', ['symptoms'], {})).toEqual({ state: 'released', list: [] })
  })
})

describe('signoffConditions', () => {
  const metRest = restProgress(Array.from({ length: 31 }, (_, i) => ({ t: min(i), place: 'indoor_cool' as const, resting: true })))
  const okRecheck = { latest: { t: min(32), symptoms: [], clean: true }, why: 'ok' as const, valid: true }
  it('needs no sign-off for a site condition', () => {
    expect(signoff({ kind: 'site' })).toEqual({ conditions: [], ready: false })
  })
  it('closes an emergency on hand-over only', () => {
    expect(signoff({ kind: 'clinical', level: 'emergency' }).conditions.map((c) => c.id)).toEqual(['handover'])
    expect(signoff({ kind: 'clinical', level: 'emergency' }).ready).toBe(false)
    expect(signoff({ kind: 'clinical', level: 'emergency', handoverConfirmed: true }).ready).toBe(true)
  })
  it('enables once rest and a clean re-check are met; water stays on the device for first aiders', () => {
    const pending = signoff({})
    expect(pending.ready).toBe(false)
    expect(pending.conditions.find((c) => c.id === 'water')?.state).toBe('device')
    const ready = signoff({ rest: metRest, recheck: okRecheck })
    expect(ready.conditions.map((c) => [c.id, c.state])).toEqual([
      ['rest', 'met'],
      ['recheck', 'met'],
      ['water', 'device'],
    ])
    expect(ready.ready).toBe(true)
  })
  it('omits the water condition for a first-aid case', () => {
    expect(signoff({ kind: 'clinical', rest: metRest, recheck: okRecheck }).conditions.map((c) => c.id)).toEqual(['rest', 'recheck'])
  })
  it('keeps the re-check result on the device for occupational health without consent', () => {
    const r = signoff({ role: 'occ_health', rest: metRest })
    expect(r.conditions.find((c) => c.id === 'recheck')?.state).toBe('device')
    expect(r.ready).toBe(true)
  })
  it('shows a pending water-loss restoration to consented occupational health', () => {
    const r = signoff({ role: 'occ_health', clinicalReleased: true, rest: metRest, recheck: okRecheck, water: { state: 'pending', text: 'Drink water and rest' } })
    expect(r.conditions.find((c) => c.id === 'water')).toMatchObject({ state: 'pending', detail: 'Drink water and rest' })
    expect(r.ready).toBe(false)
  })
})

describe('device drivers released to consented occupational health', () => {
  const d = (id: string, text = id, value?: number): RiskDriver => ({ id, channel: 'physiology', text, direction: 'raises', basis: 'test', ...(value !== undefined ? { value } : {}) })
  it('reads the sustained PSI band', () => {
    expect(psiFromDrivers([d('psi_high', 'x', 6.4)])).toMatchObject({ band: 'high', value: 6.4 })
    expect(psiFromDrivers([d('psi_high'), d('psi_very_high', 'x', 8.2)]).band).toBe('very_high')
    expect(psiFromDrivers([]).band).toBeNull()
  })
  it('reads the water-loss hold', () => {
    expect(waterHold(undefined)).toBeNull()
    expect(waterHold([d('phs_drink_to_restart', 'Drink water and rest')])).toEqual({ state: 'pending', text: 'Drink water and rest' })
    expect(waterHold([d('phs_recovery_review_required', 'Heat-strain limit reached: … (the water-loss limit is not yet restored)')])?.state).toBe('pending')
    expect(waterHold([d('phs_limit_reached')])).toEqual({ state: 'none', text: null })
  })
  it('clamps the urine shade to the Armstrong chart', () => {
    expect(urineReading(null)).toBeNull()
    expect(urineReading(9)?.shade).toBe(8)
    expect(urineReading(2)?.advice.length).toBeGreaterThan(0)
  })
})

describe('caseTimeline', () => {
  const chain = caseChain(
    [
      alert({ id: 'A1', t: min(0), level: 'stop', status: 'resolved', resolvedAt: min(5), acks: [{ role: 'first_aider', t: min(2) }], escalatedAt: min(0), escalatedTo: ['first_aider'] }),
      alert({ id: 'A2', t: min(5), level: 'emergency', escalatedAt: min(5), escalatedTo: ['first_aider', 'occ_health'] }),
    ],
    'W-1',
    'A2',
  )
  const notes = [
    { id: 'N1', t: min(0), alertId: 'A1', channel: 'push' as const, kind: 'alert' as const, level: 'stop' as const },
    { id: 'N2', t: min(6), alertId: 'A2', channel: 'push' as const, kind: 'update' as const, level: 'emergency' as const },
    { id: 'N3', t: min(6), alertId: 'OTHER', channel: 'push' as const, kind: 'alert' as const, level: 'stop' as const },
  ]
  it('orders the case record and keeps only this case', () => {
    const ev = caseTimeline({
      chain,
      reasonText: 'Emergency response needed now',
      role: 'first_aider',
      notifications: notes,
      rechecks: { entries: [{ t: min(8), symptoms: ['headache'], clean: false }], showResults: true },
      steps: { call_998: min(6) },
      symptomsSeen: { confusion: min(5) },
    })
    expect(ev.map((e) => e.kind)).toEqual(['raised', 'escalated', 'notified', 'ack', 'raised', 'escalated', 'symptoms', 'cooling', 'recheck'])
    expect(ev[4]).toMatchObject({ title: 'Escalated to emergency', detail: 'Emergency response needed now', level: 'emergency' })
    expect(ev[8]?.detail).toBe('Headache')
  })
  it('hides re-check results from a role that may not see them', () => {
    const ev = caseTimeline({ chain, reasonText: '', role: 'occ_health', notifications: [], rechecks: { entries: [{ t: min(8), symptoms: ['headache'], clean: false }], showResults: false }, steps: {}, symptomsSeen: null })
    const re = ev.find((e) => e.kind === 'recheck')
    expect(re?.title).toBe('Re-check recorded by the first aider')
    expect(re?.detail).not.toContain('Headache')
    expect(ev.some((e) => e.kind === 'symptoms')).toBe(false)
  })
})

describe('ADOSH Form G', () => {
  const fri = epochFromLocal('2025-08-01T14:10') // Friday
  it('skips the weekend when counting working days', () => {
    expect(formatLocalDay(addWorkingDays(fri, 3))).toBe('Wed 6 Aug')
  })
  it('gives 24 h for a fatality and 3 working days for a serious incident', () => {
    expect(formGNotice({ ...NO_OUTCOME, fatality: true }, fri)).toMatchObject({ notifiable: true, deadline: 'fatality', dueT: fri + 24 * 60 * MINUTE_MS, form: 'Form G' })
    const serious = formGNotice({ ...NO_OUTCOME, unableToWorkNextShift: true }, fri)
    expect(serious).toMatchObject({ notifiable: true, deadline: 'serious' })
    expect(formatLocalDay(serious?.dueT ?? 0)).toBe('Wed 6 Aug')
    expect(formGNotice(NO_OUTCOME, fri)).toMatchObject({ notifiable: false, deadline: null, dueT: null })
  })
})

describe('trend', () => {
  it('adds the ±0.6 °C display band and a covering domain', () => {
    const rows = trendRows([
      { t: min(0), ct: 38.2, hr: 150 },
      { t: min(1), ct: null, hr: null },
    ])
    expect(rows[0]?.band).toEqual([37.6, 38.8])
    expect(rows[1]?.band).toBeNull()
    expect(bandDomain(rows)).toEqual([37, 39])
    expect(bandDomain([])).toEqual([36.5, 39.5])
  })
})
