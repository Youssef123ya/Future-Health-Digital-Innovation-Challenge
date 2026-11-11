import { describe, it, expect } from 'vitest'
import type { ActionId, Alert, ChannelId, ChannelResult, RiskAssessment, RiskDriver, RiskLevel, Role } from './types'
import { RISK_LEVELS, RISK_ORDER } from './types'
import { MINUTE_MS, epochFromLocal } from './time'
import {
  ACK_ROLES,
  CLINICAL_TEXT_PATTERN,
  CREW_BUNDLE_MIN_WORKERS,
  DEESCALATION_DWELL_MIN,
  DESIGNED_SUPPRESSION_MAX_LEVEL,
  EXPOSURE_CHANNELS,
  HIGH_ACK_TIMEOUT_MIN,
  INDIVIDUAL_CHANNELS,
  INDIVIDUAL_DRIVER_IDS,
  MONITORED_SCREEN_DRIVER_IDS,
  PLAN_COVERED_ACTIONS,
  PLAN_IN_FORCE_DRIVER_IDS,
  PRIVATE_FACTOR_TEXT_PATTERN,
  REPEAT_SUPPRESSION_MIN,
  STOP_ACK_TIMEOUT_MIN,
  acknowledge,
  alertStats,
  assessmentBasis,
  createAlertEngine,
  isAlertSuppressed,
  processAssessments,
  resolve,
  supervisorSafeText,
  tick,
} from './alerts'
import type { AlertEngineState, EngineAlert, Notification, RosterEntry } from './alerts'

// ─────────────────────────────── Fixtures ───────────────────────────────

const T0 = epochFromLocal('2025-08-01T09:00')
const at = (m: number): number => T0 + m * MINUTE_MS

const DRIVER: Record<ChannelId, RiskDriver> = {
  environment: {
    id: 'wbgt_over_limit',
    channel: 'environment',
    text: 'Effective WBGT 33.4 °C is 2.1 °C over the REL for heavy work',
    value: 33.4,
    unit: '°C',
    direction: 'raises',
    basis: 'NIOSH 2016 REL',
  },
  regulation: {
    id: 'midday_break',
    channel: 'regulation',
    text: 'Midday work ban in force (15 Jun–15 Sep, 12:30–15:00): work under direct sunlight and in open areas is not allowed',
    direction: 'raises',
    basis: 'MoHRE MR 44/2022',
  },
  projection: {
    id: 'phs_minutes_to_limit',
    channel: 'projection',
    text: 'Heat-strain model: about 20 min to the body-heat limit at the current activity',
    direction: 'raises',
    basis: 'ISO 7933:2023',
  },
  symptoms: {
    id: 'symptom_dizziness',
    channel: 'symptoms',
    text: 'Dizziness, headache and nausea reported (T2)',
    direction: 'raises',
    basis: 'ACSM 2023',
  },
  physiology: {
    id: 'ct_est_high',
    channel: 'physiology',
    text: 'ECTemp 39.1 °C and HR 182 bpm sustained; PSI 8.4',
    direction: 'raises',
    basis: 'Buller 2013; Moran 1998',
  },
  hydration: {
    id: 'urine_dark',
    channel: 'hydration',
    text: 'Urine shade 7; over the hourly fluid cap with swollen hands',
    direction: 'raises',
    basis: 'Armstrong; TB MED 507',
  },
}

const DEFAULT_ACTIONS: Record<RiskLevel, ActionId[]> = {
  safe: [],
  caution: ['drink_water'],
  high: ['shade_breaks', 'drink_water', 'rotate_task'],
  stop: ['stop_work', 'rest_shade_now', 'cool_down'],
  emergency: ['call_998', 'cool_first', 'stay_with_worker'],
}

const ALL_CHANNELS: ChannelId[] = ['environment', 'regulation', 'projection', 'physiology', 'symptoms', 'hydration']

interface AOpts {
  /** Single driving channel (default environment). */
  channel?: ChannelId
  /** Explicit channel levels (override `channel`). */
  channels?: Partial<Record<ChannelId, RiskLevel>>
  drivers?: RiskDriver[]
  actions?: ActionId[]
  network?: 'online' | 'offline'
  workMinPerHour?: number
}

function assess(workerId: string, t: number, level: RiskLevel, o: AOpts = {}): RiskAssessment {
  const levels: Partial<Record<ChannelId, RiskLevel>> = o.channels ?? (level === 'safe' ? {} : { [o.channel ?? 'environment']: level })
  const drivers =
    o.drivers ?? ALL_CHANNELS.filter((c) => levels[c] !== undefined && levels[c] !== 'safe').map((c) => DRIVER[c])
  const channels: ChannelResult[] = ALL_CHANNELS.map((c) => ({
    channel: c,
    level: levels[c] ?? 'safe',
    available: true,
    drivers: drivers.filter((d) => d.channel === c),
  }))
  return {
    workerId,
    t,
    level,
    channels,
    drivers,
    actions: o.actions ?? DEFAULT_ACTIONS[level],
    workMinPerHour: o.workMinPerHour ?? (level === 'high' ? 30 : level === 'caution' ? 60 : 0),
    minutesToLimit: null,
    waterMlPerHour: 750,
    confidence: 'high',
    dataQuality: { env: 'forecast', physiology: 'absent', network: o.network ?? 'online', stale: false },
  }
}

const CREW_A = ['W1', 'W2', 'W3', 'W4', 'W5']
const CREW_B = ['V1', 'V2']
const ROSTER: Record<string, RosterEntry> = {
  ...Object.fromEntries(
    CREW_A.map((w, i) => [
      w,
      { crewId: 'C-A', siteId: 'musaffah', displayName: `Ahmed ${i + 1}`, buddyId: CREW_A[(i + 1) % CREW_A.length], supervisorId: 'S-A' },
    ]),
  ),
  ...Object.fromEntries(CREW_B.map((w, i) => [w, { crewId: 'C-B', siteId: 'musaffah', displayName: `Ravi ${i + 1}`, supervisorId: 'S-B' }])),
}

/** Process one batch at minute `m`. */
function step(state: AlertEngineState, m: number, batch: RiskAssessment[], roster: Record<string, RosterEntry> = ROSTER) {
  return processAssessments(state, batch, { now: at(m), roster })
}

const toWorker = (ns: Notification[], w: string) => ns.filter((n) => n.to.role === 'worker' && n.to.id === w)
const toRole = (ns: Notification[], role: string) => ns.filter((n) => n.to.role === role)

/** Independent list of clinical words (not the engine's pattern) for the privacy properties. */
const CLINICAL_WORDS = [
  /dizz/i,
  /headache/i,
  /nause/i,
  /vomit/i,
  /faint/i,
  /collaps/i,
  /seizure/i,
  /confus/i,
  /slurred/i,
  /chest pain/i,
  /cramp/i,
  /urine/i,
  /heart/i,
  /\bbpm\b/i,
  /\bHR\b/,
  /ectemp/i,
  /core temp/i,
  /\bpsi\b/i,
  /medication/i,
  /beta.?blocker/i,
  /pregnan/i,
  /hyponatr/i,
  /diagnos/i,
  /heat stroke/i,
  /symptom/i,
  /swollen/i,
  /extra.?care/i,
  /fluid cap/i,
]
const NOTIFICATION_KEYS = ['id', 't', 'alertId', 'to', 'channel', 'level', 'actions', 'reasonKey', 'text', 'requiresAck', 'kind', 'basis'].sort()
/** Every field a published alert may carry (no engine bookkeeping such as driving channels or the clinical flag). */
const ALERT_KEYS = new Set(['id', 't', 'siteId', 'crewId', 'workerId', 'memberIds', 'scope', 'level', 'actions', 'consoleActions', 'reason', 'reasonKey', 'frame', 'basis', 'status', 'ack', 'acks', 'escalatedTo', 'escalatedAt', 'resolvedAt', 'suppression'])

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random 1-min assessment streams for crew A (levels follow a bounded random walk; random driving channels). */
function randomStream(seed: number, minutes: number, opts: { mislabelled?: boolean } = {}) {
  const r = seeded(seed)
  const lv: Record<string, number> = Object.fromEntries(CREW_A.map((w) => [w, 0]))
  const steps: Array<{ m: number; batch: RiskAssessment[] }> = []
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  for (let m = 0; m < minutes; m++) {
    const batch: RiskAssessment[] = []
    for (const w of CREW_A) {
      let l = lv[w]
      const u = r()
      if (u < 0.12) l = Math.min(3, l + 1)
      else if (u < 0.24) l = Math.max(0, l - 1)
      else if (u < 0.27) l = 3
      else if (u < 0.28) l = 4
      else if (l === 4 && u > 0.9) l = 2
      lv[w] = l
      const level = RISK_LEVELS[l]
      const channel: ChannelId = level === 'emergency' ? 'symptoms' : pick(['environment', 'environment', 'regulation', 'projection', 'symptoms', 'physiology', 'hydration'] as const)
      const o: AOpts = { channel, network: r() < 0.1 ? 'offline' : 'online' }
      if (opts.mislabelled && level !== 'safe' && r() < 0.3) {
        // A non-clinical channel driver whose text wrongly contains clinical words (defence in depth).
        o.drivers = [{ ...DRIVER[channel], channel: 'environment', id: 'leaky', text: 'Worker reported dizziness; HR 175 bpm; ECTemp high' }, DRIVER[channel]]
        o.channels = { [channel]: level, environment: level }
      }
      batch.push(assess(w, at(m), level, o))
    }
    steps.push({ m, batch })
  }
  return steps
}

// ─────────────────────────────── Routing ───────────────────────────────

describe('routing (ARCHITECTURE §6)', () => {
  it('caution reaches only the worker, in-app, without acknowledgement', () => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'caution')])
    expect(r.raised).toHaveLength(1)
    expect(r.notifications).toHaveLength(1)
    const n = r.notifications[0]
    expect(n.to).toEqual({ role: 'worker', id: 'W1' })
    expect(n.channel).toBe('app')
    expect(n.requiresAck).toBe(false)
    expect(r.raised[0]).toMatchObject({ scope: 'worker', workerId: 'W1', crewId: 'C-A', siteId: 'musaffah', level: 'caution', status: 'active' })
  })

  it('high: worker (push, ack) and supervisor (individual, ack); no buddy or first aider', () => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')])
    expect(toWorker(r.notifications, 'W1')).toEqual([expect.objectContaining({ channel: 'push', requiresAck: true, level: 'high', kind: 'alert' })])
    expect(toRole(r.notifications, 'supervisor')).toEqual([expect.objectContaining({ to: { role: 'supervisor', id: 'S-A' }, requiresAck: true, kind: 'alert' })])
    expect(toRole(r.notifications, 'buddy')).toHaveLength(0)
    expect(toRole(r.notifications, 'first_aider')).toHaveLength(0)
    expect(r.raised[0].escalatedTo).toEqual(['supervisor'])
    // Environment-only: an exposure alert whose supervisor-facing reason names the site condition, not the person.
    expect(r.raised[0].basis).toBe('exposure')
    expect(r.raised[0].reason).toBe('Site heat: work/rest 30/30 in effect')
    expect(r.raised[0].reason).not.toMatch(/\bREL\b|\bRAL\b|personal/i)
    expect(toRole(r.notifications, 'supervisor')[0].text).toContain('Reason: Site heat: work/rest 30/30 in effect')
  })

  it('environment-driven stop: worker and supervisor; no first aider; buddy only after the ack timeout', () => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')])
    expect(toWorker(r.notifications, 'W1')).toHaveLength(1)
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    expect(toRole(r.notifications, 'supervisor')[0].channel).toBe('push')
    expect(toRole(r.notifications, 'first_aider')).toHaveLength(0)
    expect(toRole(r.notifications, 'buddy')).toHaveLength(0)
  })

  it.each(['symptoms', 'physiology'] as const)('%s-driven stop also pages the first aider and latches', (channel) => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel })])
    expect(toRole(r.notifications, 'first_aider')).toEqual([expect.objectContaining({ to: { role: 'first_aider' }, requiresAck: true })])
    expect(r.state.alerts[r.raised[0].id].latched).toBe(true)
    // Non-clinical reason only.
    expect(r.raised[0].reason).toBe('First-aid check needed')
    for (const n of r.notifications) for (const w of CLINICAL_WORDS) expect(n.text).not.toMatch(w)
  })

  it('emergency: worker, buddy, supervisor, first aider and occupational health at once; 998 prompt; no clinical text', () => {
    const r = step(createAlertEngine(), 0, [assess('W2', at(0), 'emergency', { channel: 'symptoms' })])
    const roles = r.notifications.map((n) => n.to.role).sort()
    expect(roles).toEqual(['buddy', 'first_aider', 'occ_health', 'supervisor', 'worker'])
    expect(toRole(r.notifications, 'buddy')[0].to).toEqual({ role: 'buddy', id: 'W3' })
    expect(toWorker(r.notifications, 'W2')[0].requiresAck).toBe(false)
    expect(r.raised[0].actions).toContain('call_998')
    expect(r.raised[0].escalatedTo).toEqual(expect.arrayContaining(['supervisor', 'first_aider', 'buddy', 'occ_health']))
    expect(toRole(r.notifications, 'first_aider')[0].text).toContain('998')
    for (const n of r.notifications) for (const w of CLINICAL_WORDS) expect(n.text).not.toMatch(w)
  })

  it('a worker with no buddy assigned: the emergency goes to any crewmate (buddy role without id)', () => {
    const r = step(createAlertEngine(), 0, [assess('V1', at(0), 'emergency', { channel: 'symptoms' })])
    expect(toRole(r.notifications, 'buddy')[0].to).toEqual({ role: 'buddy' })
  })

  it('offline device: the worker is still notified on the device (app) and the supervisor gets an SMS fallback', () => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'high', { network: 'offline' })])
    expect(toWorker(r.notifications, 'W1')[0].channel).toBe('app')
    const sms = r.notifications.filter((n) => n.channel === 'sms')
    expect(sms).toEqual([expect.objectContaining({ to: { role: 'supervisor', id: 'S-A' }, kind: 'device_offline', requiresAck: true })])
    // Roster network overrides the assessment's.
    const r2 = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')], { ...ROSTER, W1: { ...ROSTER.W1, network: 'offline' } })
    expect(r2.notifications.some((n) => n.channel === 'sms')).toBe(true)
  })

  it('an unknown worker (no roster entry) is still alerted, fail-safe', () => {
    const r = step(createAlertEngine(), 0, [assess('X9', at(0), 'stop')])
    expect(toWorker(r.notifications, 'X9')).toHaveLength(1)
    expect(toRole(r.notifications, 'supervisor')[0].to).toEqual({ role: 'supervisor' })
  })
})

// ─────────────────────────────── Escalation, dwell, latch ───────────────────────────────

describe('escalation and de-escalation', () => {
  it('escalates immediately: high → stop raises a new stop alert at once and supersedes the high alert', () => {
    let s = createAlertEngine()
    const r1 = step(s, 0, [assess('W1', at(0), 'high')])
    s = r1.state
    const r2 = step(s, 1, [assess('W1', at(1), 'stop')])
    expect(r2.raised).toHaveLength(1)
    expect(r2.raised[0].level).toBe('stop')
    expect(r2.updated.find((a) => a.id === r1.raised[0].id)).toMatchObject({ status: 'resolved', resolvedAt: at(1) })
    expect(toWorker(r2.notifications, 'W1')[0].level).toBe('stop')
  })

  it('a symptom cause appearing at the same level re-routes (first aider) and latches', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    const r = step(s, 1, [assess('W1', at(1), 'stop', { channels: { environment: 'stop', symptoms: 'stop' } })])
    expect(r.raised).toHaveLength(1)
    expect(toRole(r.notifications, 'first_aider')).toHaveLength(1)
    s = r.state
    expect(s.alerts[r.raised[0].id].latched).toBe(true)
  })

  it(`exposure alerts auto-resolve only after ${DEESCALATION_DWELL_MIN} min below, then a quiet "conditions eased" alert follows`, () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    const highId = Object.keys(s.alerts)[0]
    for (let m = 1; m <= 10; m++) {
      const r = step(s, m, [assess('W1', at(m), 'caution')])
      s = r.state
      expect(s.alerts[highId].alert.status).not.toBe('resolved')
      expect(r.raised).toHaveLength(0)
    }
    const r = step(s, 11, [assess('W1', at(11), 'caution')])
    expect(r.updated.find((a) => a.id === highId)?.status).toBe('resolved')
    expect(r.state.alerts[highId].closedReason).toBe('auto_dwell')
    expect(r.raised).toEqual([expect.objectContaining({ level: 'caution' })])
    expect(r.state.alerts[r.raised[0].id].origin).toBe('deescalation')
    expect(r.notifications.every((n) => n.requiresAck === false)).toBe(true)
  })

  it('the dwell restarts when the level returns', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    const id = Object.keys(s.alerts)[0]
    for (let m = 1; m <= 6; m++) s = step(s, m, [assess('W1', at(m), 'caution')]).state
    s = step(s, 7, [assess('W1', at(7), 'high')]).state
    for (let m = 8; m <= 17; m++) s = step(s, m, [assess('W1', at(m), 'safe')]).state
    expect(s.alerts[id].alert.status).not.toBe('resolved') // 10 min below not yet complete (8..17 = 9 min)
    s = step(s, 18, [assess('W1', at(18), 'safe')]).state
    expect(s.alerts[id].alert.status).toBe('resolved')
  })

  it('symptom-driven alerts latch: they never auto-resolve, and the worker cannot resolve them', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel: 'symptoms' })]).state
    const id = Object.keys(s.alerts)[0]
    for (let m = 1; m <= 40; m++) s = step(s, m, [assess('W1', at(m), 'safe')]).state
    expect(s.alerts[id].alert.status).not.toBe('resolved')
    const byWorker = resolve(s, id, 'worker', at(41))
    expect(byWorker.ok).toBe(false)
    expect(byWorker.reason).toBe('role_not_permitted')
    const byFirstAider = resolve(s, id, 'first_aider', at(41))
    expect(byFirstAider.ok).toBe(true)
    expect(byFirstAider.alert).toMatchObject({ status: 'resolved', resolvedAt: at(41) })
    expect(byFirstAider.state.alerts[id].resolvedBy).toBe('first_aider')
  })

  it('a latch carries over when a clinical alert is superseded by an environment escalation', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high', { channel: 'physiology' })]).state
    const r = step(s, 1, [assess('W1', at(1), 'stop', { channels: { environment: 'stop', physiology: 'high' } })])
    s = r.state
    expect(s.alerts[r.raised[0].id].latched).toBe(true)
    for (let m = 2; m <= 30; m++) s = step(s, m, [assess('W1', at(m), 'safe')]).state
    expect(s.alerts[r.raised[0].id].alert.status).not.toBe('resolved')
  })

  it('resolution hold: no re-page while the latch awaits the re-check; paged again after 30 min; released when the latch clears', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel: 'symptoms' })]).state
    const id = Object.keys(s.alerts)[0]
    s = resolve(s, id, 'first_aider', at(5)).state
    // risk.ts keeps the symptoms channel latched at stop until the symptom-free re-check.
    for (let m = 6; m < 35; m++) {
      const r = step(s, m, [assess('W1', at(m), 'stop', { channel: 'symptoms' })])
      expect(r.raised).toHaveLength(0)
      s = r.state
    }
    const again = step(s, 35, [assess('W1', at(35), 'stop', { channel: 'symptoms' })])
    expect(again.raised).toHaveLength(1)
    expect(toRole(again.notifications, 'first_aider')).toHaveLength(1)

    // Latch cleared → hold released → a later stop is a new case.
    let s2 = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel: 'symptoms' })]).state
    s2 = resolve(s2, Object.keys(s2.alerts)[0], 'supervisor', at(2)).state
    s2 = step(s2, 3, [assess('W1', at(3), 'safe')]).state
    const r3 = step(s2, 4, [assess('W1', at(4), 'stop', { channel: 'symptoms' })])
    expect(r3.raised).toHaveLength(1)
    // An escalation during the hold is always raised.
    let s3 = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel: 'symptoms' })]).state
    s3 = resolve(s3, Object.keys(s3.alerts)[0], 'first_aider', at(1)).state
    const r4 = step(s3, 2, [assess('W1', at(2), 'emergency', { channel: 'symptoms' })])
    expect(r4.raised[0]?.level).toBe('emergency')
  })

  it('exposure alerts: supervisors may resolve, the worker may not', () => {
    const s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    const id = Object.keys(s.alerts)[0]
    expect(resolve(s, id, 'worker', at(1)).ok).toBe(false)
    expect(resolve(s, id, 'employer_hr', at(1)).ok).toBe(false)
    expect(resolve(s, id, 'supervisor', at(1)).ok).toBe(true)
    expect(resolve(s, 'nope', 'supervisor', at(1))).toMatchObject({ ok: false, reason: 'unknown_alert' })
  })
})

// ─────────────────────────────── Repeat suppression ───────────────────────────────

describe(`repeat suppression (${REPEAT_SUPPRESSION_MIN} min)`, () => {
  it('a manually resolved exposure alert is not repeated within the window while the level persists, then is', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    s = resolve(s, Object.keys(s.alerts)[0], 'supervisor', at(2)).state
    for (let m = 3; m < 20; m++) {
      const r = step(s, m, [assess('W1', at(m), 'high')])
      expect(r.raised).toHaveLength(0)
      expect(r.notifications).toHaveLength(0)
      s = r.state
    }
    expect(s.suppressed).toHaveLength(1) // one episode, counted once
    const r = step(s, 20, [assess('W1', at(20), 'high')])
    expect(r.raised).toHaveLength(1)
    expect(toWorker(r.notifications, 'W1')).toHaveLength(1)
  })

  it('a de-escalation to a level told within the window is silent', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    const stop = step(s, 2, [assess('W1', at(2), 'stop')])
    s = acknowledge(stop.state, stop.raised[0].id, 'worker', at(2.5)).state // isolate from the stop-ack escalation
    let raised = 0
    let notes = 0
    for (let m = 3; m <= 13; m++) {
      const r = step(s, m, [assess('W1', at(m), 'high')])
      raised += r.raised.length
      notes += r.notifications.length
      s = r.state
    }
    // The stop auto-resolved at 13 (10 min below); "high" was told at 0 → suppressed.
    expect(Object.values(s.alerts).find((r) => r.alert.level === 'stop')?.alert.status).toBe('resolved')
    expect(raised).toBe(0)
    expect(notes).toBe(0)
    expect(s.suppressed).toHaveLength(1)
  })

  it('suppression never applies to an escalation, a clinical alert or an emergency', () => {
    // Escalation: stop after a resolved stop within the window, with the level rising from high.
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    s = resolve(s, Object.keys(s.alerts)[0], 'supervisor', at(1)).state
    s = step(s, 2, [assess('W1', at(2), 'high')]).state // high: rise? no (stop → high); told? no → raised
    const r = step(s, 3, [assess('W1', at(3), 'stop')])
    expect(r.raised.map((a) => a.level)).toEqual(['stop'])
    // Clinical: a resolved symptom case paged again after the latch cleared.
    let c = step(createAlertEngine(), 0, [assess('W1', at(0), 'high', { channel: 'symptoms' })]).state
    c = resolve(c, Object.keys(c.alerts)[0], 'first_aider', at(1)).state
    c = step(c, 2, [assess('W1', at(2), 'safe')]).state
    expect(step(c, 3, [assess('W1', at(3), 'high', { channel: 'symptoms' })]).raised).toHaveLength(1)
  })
})

// ─────────────────────────────── Crew bundling ───────────────────────────────

describe('crew bundling', () => {
  it(`${CREW_BUNDLE_MIN_WORKERS} workers of one crew at the same environment-driven level → one crew alert for the supervisor`, () => {
    const r = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high')))
    const crew = r.raised.filter((a) => a.scope === 'crew')
    expect(crew).toHaveLength(1)
    expect(crew[0]).toMatchObject({ crewId: 'C-A', level: 'high', memberIds: ['W1', 'W2', 'W3'] })
    expect(crew[0].workerId).toBeUndefined()
    const sup = toRole(r.notifications, 'supervisor')
    expect(sup).toHaveLength(1)
    expect(sup[0]).toMatchObject({ alertId: crew[0].id, kind: 'crew_alert', requiresAck: true })
    expect(sup[0].text).toContain('3 workers')
    // Every worker is still notified individually.
    for (const w of ['W1', 'W2', 'W3']) expect(toWorker(r.notifications, w)).toHaveLength(1)
  })

  it('two workers are alerted individually', () => {
    const r = step(createAlertEngine(), 0, ['W1', 'W2'].map((w) => assess(w, at(0), 'high')))
    expect(r.raised.filter((a) => a.scope === 'crew')).toHaveLength(0)
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(2)
  })

  it('bundles across batches within 5 min and lets later members join without new supervisor messages', () => {
    let s = createAlertEngine()
    let r = step(s, 0, [assess('W1', at(0), 'high')])
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    s = r.state
    r = step(s, 2, [assess('W1', at(2), 'high'), assess('W2', at(2), 'high')])
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    s = r.state
    r = step(s, 4, ['W1', 'W2', 'W3'].map((w) => assess(w, at(4), 'high')))
    const crew = r.raised.find((a) => a.scope === 'crew') as EngineAlert
    expect(crew.memberIds).toEqual(['W1', 'W2', 'W3'])
    expect(toRole(r.notifications, 'supervisor')).toEqual([expect.objectContaining({ alertId: crew.id, kind: 'crew_alert' })])
    s = r.state
    r = step(s, 7, ['W1', 'W2', 'W3', 'W4'].map((w) => assess(w, at(7), 'high')))
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(0)
    expect(r.updated.find((a) => a.id === crew.id)?.memberIds).toEqual(['W1', 'W2', 'W3', 'W4'])
    expect(toWorker(r.notifications, 'W4')).toHaveLength(1)
  })

  it('the midday-break stop of a whole crew is one supervisor message; every worker must still acknowledge', () => {
    const r = step(createAlertEngine(), 0, CREW_A.map((w) => assess(w, at(0), 'stop', { channel: 'regulation', actions: ['midday_break', 'rest_shade_now'] })))
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    expect(toRole(r.notifications, 'supervisor')[0].text).toContain('Midday work ban')
    for (const w of CREW_A) expect(toWorker(r.notifications, w)[0]).toMatchObject({ requiresAck: true, level: 'stop' })
  })

  it('symptom-driven and projection-driven alerts are never bundled; crews are never mixed', () => {
    const r = step(createAlertEngine(), 0, [
      ...['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'stop', { channel: 'symptoms' })),
      ...['W4', 'W5'].map((w) => assess(w, at(0), 'high', { channel: 'projection' })),
      ...['V1', 'V2'].map((w) => assess(w, at(0), 'high')),
    ])
    expect(r.raised.filter((a) => a.scope === 'crew')).toHaveLength(0)
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(7)
  })

  it('the crew alert resolves when its last member alert resolves', () => {
    let s = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high'))).state
    const crewId = Object.values(s.alerts).find((r) => r.alert.scope === 'crew')!.alert.id
    for (let m = 1; m <= 11; m++) s = step(s, m, ['W1', 'W2', 'W3'].map((w) => assess(w, at(m), 'safe'))).state
    expect(s.alerts[crewId].alert.status).toBe('resolved')
    expect(s.alerts[crewId].closedReason).toBe('members_cleared')
  })
})

// ─────────────────────────────── Basis: exposure vs individual ───────────────────────────────

describe('basis: exposure vs individual', () => {
  it('environment- or regulation-only alerts are exposure, with a site-framed reason (known answers)', () => {
    const cases: Array<[RiskLevel, AOpts, string]> = [
      ['caution', { workMinPerHour: 60 }, 'Site heat: close to the limit for this work'],
      ['high', { workMinPerHour: 20 }, 'Site heat: work/rest 20/40 in effect'],
      ['high', { workMinPerHour: 20.9 }, 'Site heat: work/rest 20/40 in effect'], // floored like the action phrase
      ['high', { workMinPerHour: 60 }, 'Site heat: heat controls in effect'],
      ['stop', {}, 'Site heat: too hot for this work now'],
    ]
    for (const [level, o, reason] of cases) {
      const r = step(createAlertEngine(), 0, [assess('V1', at(0), level, o)])
      expect(r.raised[0], `${level} ${o.workMinPerHour}`).toMatchObject({ basis: 'exposure', reason })
      expect(r.notifications.every((n) => n.basis === 'exposure')).toBe(true)
      expect(r.state.alerts[r.raised[0].id].reasonKey).toBe('driver.wbgt_over_limit')
    }
    const rule = step(createAlertEngine(), 0, [assess('V1', at(0), 'stop', { channel: 'regulation' })])
    expect(rule.raised[0].basis).toBe('exposure')
    expect(rule.raised[0].reason).toMatch(/^Site rule: Midday work ban in force \(/)
    expect(rule.state.alerts[rule.raised[0].id].reasonKey).toBe('driver.midday_break')
    expect(EXPOSURE_CHANNELS).toEqual(['environment', 'regulation'])
  })

  it.each(INDIVIDUAL_CHANNELS)('a %s-driven alert is individual, with a non-clinical reason and no individual number', (channel) => {
    const r = step(createAlertEngine(), 0, [assess('V1', at(0), 'high', { channel })])
    const a = r.raised[0]
    expect(a.basis).toBe('individual')
    expect(r.notifications.every((n) => n.basis === 'individual')).toBe(true)
    // Wave 2d: the projection driver's text ("about 20 min to …") is replaced by its generic driver.<id> phrase.
    expect(a.reason).toBe(channel === 'projection' ? 'At this work rate, your safe time in the heat is running out.' : 'Personal check flagged on the worker’s device')
    expect(a.reason).not.toMatch(/\d/)
    expect(toRole(r.notifications, 'supervisor')[0].text).toContain(`Reason: ${a.reason}`)
    for (const w of CLINICAL_WORDS) expect(a.reason).not.toMatch(w)
  })

  it('mixed: an individual channel at the alert level makes it individual; one below the level does not', () => {
    const mixed = step(createAlertEngine(), 0, [assess('V1', at(0), 'high', { channels: { environment: 'high', projection: 'high' } })])
    expect(mixed.raised[0].basis).toBe('individual')
    expect(mixed.raised[0].reason).toBe('The heat is over the safe limit for this work.') // generic phrase: no personal-limit margin (wave 2d)
    const below = step(createAlertEngine(), 0, [assess('V1', at(0), 'stop', { channels: { environment: 'stop', projection: 'high' } })])
    expect(below.raised[0].basis).toBe('exposure')
    expect(assessmentBasis(assess('V1', at(0), 'stop', { channels: { regulation: 'stop', environment: 'high', physiology: 'caution' } }))).toBe('exposure')
    expect(assessmentBasis(assess('V1', at(0), 'stop', { channels: { regulation: 'stop', hydration: 'stop' } }))).toBe('individual')
    expect(assessmentBasis(assess('V1', at(0), 'emergency', { channel: 'symptoms' }))).toBe('individual')
  })

  it('a latch or recovery-review driver makes the alert individual on any channel; so does a carried clinical latch', () => {
    for (const id of ['clinical_latch', 'no_hot_work_today', 'phs_limit_reached', 'phs_recovery_review_required']) {
      const d: RiskDriver = { id, channel: 'environment', text: 'Stop stays in force until reviewed', direction: 'raises', basis: 'test' }
      expect(assessmentBasis(assess('V1', at(0), 'stop', { drivers: [DRIVER.environment, d] })), id).toBe('individual')
      // An 'info' driver with the same id does not raise the level, so the basis stays exposure.
      expect(assessmentBasis(assess('V1', at(0), 'stop', { drivers: [DRIVER.environment, { ...d, direction: 'info' }] })), id).toBe('exposure')
    }
    const s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high', { channel: 'physiology' })]).state
    const r = step(s, 1, [assess('W1', at(1), 'stop', { channels: { environment: 'stop', physiology: 'high' } })])
    expect(r.raised[0]).toMatchObject({ level: 'stop', basis: 'individual' })
    expect(r.raised[0].reason).not.toMatch(/^Site /)
    expect(r.state.alerts[r.raised[0].id]).toMatchObject({ latched: true, bundleEligible: false })
  })

  it('crew bundles are exposure only: the crew alert names the crew condition with the strictest work/rest', () => {
    let r = step(createAlertEngine(), 0, [
      assess('W1', at(0), 'high', { workMinPerHour: 30 }),
      assess('W2', at(0), 'high', { workMinPerHour: 20 }),
      assess('W3', at(0), 'high', { workMinPerHour: 25 }),
    ])
    const crew = r.raised.find((a) => a.scope === 'crew') as EngineAlert
    expect(crew).toMatchObject({ basis: 'exposure', reason: 'Site heat: work/rest 20/40 in effect (3 workers)', acks: [] })
    expect(r.raised.filter((a) => a.scope === 'worker').map((a) => a.basis)).toEqual(['exposure', 'exposure', 'exposure'])
    const sup = toRole(r.notifications, 'supervisor')
    expect(sup).toEqual([expect.objectContaining({ basis: 'exposure', kind: 'crew_alert' })])
    expect(sup[0].text).toContain('(20 min work / 40 min rest per hour)')
    expect(sup[0].text).toContain('Reason: Site heat: work/rest 20/40 in effect')
    // A member with a stricter schedule joins: count and strictest schedule update, no new supervisor message.
    const wmph = [30, 20, 25]
    r = step(r.state, 1, [...['W1', 'W2', 'W3'].map((w, i) => assess(w, at(1), 'high', { workMinPerHour: wmph[i] })), assess('W4', at(1), 'high', { workMinPerHour: 15 })])
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(0)
    expect(r.updated.find((a) => a.id === crew.id)?.reason).toBe('Site heat: work/rest 15/45 in effect (4 workers)')
    // A projection-driven alert in the same crew is individual and never joins the bundle.
    const p = step(r.state, 2, [assess('W5', at(2), 'high', { channel: 'projection' })])
    expect(p.raised[0].basis).toBe('individual')
    expect(toRole(p.notifications, 'supervisor')).toEqual([expect.objectContaining({ basis: 'individual', kind: 'alert' })])
    expect(p.updated.find((a) => a.id === crew.id)).toBeUndefined()
  })

  it('sticky individual: an individual cause joining at the same level re-labels the open alert, with no new routing', () => {
    let s = step(createAlertEngine(), 0, [assess('V1', at(0), 'high')]).state
    const id = Object.keys(s.alerts)[0]
    expect(s.alerts[id].alert.basis).toBe('exposure')
    const r = step(s, 1, [assess('V1', at(1), 'high', { channels: { environment: 'high', projection: 'high' } })])
    expect(r.raised).toHaveLength(0)
    expect(r.notifications).toHaveLength(0)
    expect(r.updated).toEqual([expect.objectContaining({ id, basis: 'individual', reason: 'The heat is over the safe limit for this work.' })])
    s = r.state
    // Back to environment only at the same level: still individual while it stays open.
    const back = step(s, 2, [assess('V1', at(2), 'high')])
    expect(back.state.alerts[id].alert.basis).toBe('individual')
    expect(back.updated).toHaveLength(0)
  })

  it('a level held by the de-escalation dwell (no channel at the level) keeps the open exposure alert exposure', () => {
    let s = step(createAlertEngine(), 0, [assess('V1', at(0), 'high')]).state
    const id = Object.keys(s.alerts)[0]
    expect(s.alerts[id].alert.basis).toBe('exposure')
    // The worker rests: every channel computes safe while risk.ts still displays HIGH (dwell). Not an individual cause.
    const held = step(s, 1, [assess('V1', at(1), 'high', { channels: {} })])
    expect(held.updated).toHaveLength(0)
    expect(held.state.alerts[id].alert.basis).toBe('exposure')
    expect(held.state.alerts[id].alert.reason).toMatch(/^Site heat:/)
    s = held.state
    // An individual channel at the level still re-labels it (sticky individual).
    const joined = step(s, 2, [assess('V1', at(2), 'high', { channels: { projection: 'high' } })])
    expect(joined.updated).toEqual([expect.objectContaining({ id, basis: 'individual' })])
    // A brand-new alert with no channel at its level stays individual (unknown cause, protective).
    expect(step(createAlertEngine(), 0, [assess('V2', at(0), 'high', { channels: {} })]).raised[0].basis).toBe('individual')
  })

  it('an alert re-labelled within its own batch still reaches the supervisor (individually)', () => {
    const r = step(createAlertEngine(), 0, [
      assess('W1', at(0), 'high'),
      assess('W2', at(0), 'high'),
      assess('W3', at(0), 'high'),
      assess('W1', at(0.5), 'high', { channels: { environment: 'high', projection: 'high' } }),
    ])
    expect(r.raised.filter((a) => a.scope === 'crew')).toHaveLength(0)
    const workerOf = (n: Notification) => r.raised.find((a) => a.id === n.alertId)?.workerId
    const sup = toRole(r.notifications, 'supervisor')
    expect(sup.map(workerOf).sort()).toEqual(['W1', 'W2', 'W3'])
    expect(sup.find((n) => workerOf(n) === 'W1')?.basis).toBe('individual')
    expect(r.raised.every((a) => (a.escalatedTo ?? []).includes('supervisor'))).toBe(true)
  })

  it('routing does not depend on the basis: the same level reaches the same roles on the same channels', () => {
    const shape = (ns: Notification[]) => ns.map((n) => `${n.to.role}:${n.to.id ?? ''}:${n.channel}:${n.requiresAck}:${n.kind}`).sort()
    for (const level of ['caution', 'high', 'stop'] as const) {
      for (const w of ['V1', 'W1']) {
        const exposure = step(createAlertEngine(), 0, [assess(w, at(0), level)])
        const individual = step(createAlertEngine(), 0, [assess(w, at(0), level, { channel: 'projection' })])
        expect([exposure.raised[0].basis, individual.raised[0].basis]).toEqual(['exposure', 'individual'])
        expect(shape(individual.notifications), `${level} ${w}`).toEqual(shape(exposure.notifications))
        // Acknowledgement timers too (stop → supervisor + buddy; high → reminder).
        expect(shape(tick(individual.state, at(10)).notifications), `${level} ${w} timers`).toEqual(shape(tick(exposure.state, at(10)).notifications))
      }
    }
  })
})

// ─────────────────────────────── Acknowledgement timers ───────────────────────────────

describe('acknowledgement timers (tick)', () => {
  it(`stop unacknowledged for ${STOP_ACK_TIMEOUT_MIN} min → supervisor + buddy, once`, () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    const id = Object.keys(s.alerts)[0]
    let r = tick(s, at(1))
    expect(r.notifications).toHaveLength(0)
    r = tick(r.state, at(2))
    expect(r.notifications.map((n) => n.to)).toEqual([
      { role: 'supervisor', id: 'S-A' },
      { role: 'buddy', id: 'W2' },
    ])
    expect(r.notifications.every((n) => n.kind === 'escalation' && n.alertId === id)).toBe(true)
    expect(r.updated[0]).toMatchObject({ id, status: 'escalated' })
    expect(r.updated[0].escalatedTo).toEqual(expect.arrayContaining(['supervisor', 'buddy']))
    expect(tick(r.state, at(3)).notifications).toHaveLength(0)
    // processAssessments runs the timers too.
    const s2 = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    expect(step(s2, 2, [assess('W1', at(2), 'stop')]).notifications.filter((n) => n.kind === 'escalation')).toHaveLength(2)
  })

  it('an acknowledged stop does not escalate', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    const id = Object.keys(s.alerts)[0]
    const ack = acknowledge(s, id, 'worker', at(1))
    expect(ack).toMatchObject({ ok: true, counted: true })
    expect(ack.alert).toMatchObject({ status: 'acknowledged', ack: { role: 'worker', t: at(1) } })
    s = ack.state
    expect(tick(s, at(5)).notifications).toHaveLength(0)
  })

  it('emergency unacknowledged for 1 min → re-notify (voice) + siren; a worker acknowledgement does not stop it, a responder does', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'emergency', { channel: 'symptoms' })]).state
    const id = Object.keys(s.alerts)[0]
    const workerAck = acknowledge(s, id, 'worker', at(0.5))
    expect(workerAck).toMatchObject({ ok: true, counted: false })
    s = workerAck.state
    let r = tick(s, at(1))
    expect(r.notifications.map((n) => `${n.to.role}:${n.channel}`).sort()).toEqual(
      ['buddy:push', 'first_aider:voice', 'occ_health:app', 'supervisor:voice', 'worker:siren'].sort(),
    )
    expect(r.notifications.find((n) => n.channel === 'siren')).toMatchObject({ kind: 'siren', to: { role: 'worker' } })
    s = r.state
    expect(tick(s, at(3)).notifications).toHaveLength(0)
    r = tick(s, at(6))
    expect(r.notifications.filter((n) => n.kind === 'renotify')).toHaveLength(4)
    s = acknowledge(r.state, id, 'first_aider', at(6.5)).state
    expect(tick(s, at(20)).notifications).toHaveLength(0)
  })

  it('high unacknowledged for 10 min → one supervisor reminder; bundled members are covered by the crew reminder', () => {
    let s = step(createAlertEngine(), 0, [assess('V1', at(0), 'high')]).state
    expect(tick(s, at(9)).notifications).toHaveLength(0)
    let r = tick(s, at(10))
    expect(r.notifications).toEqual([expect.objectContaining({ to: { role: 'supervisor', id: 'S-B' }, kind: 'reminder' })])
    expect(tick(r.state, at(20)).notifications).toHaveLength(0)

    s = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high'))).state
    r = tick(s, at(10))
    expect(r.notifications).toHaveLength(1)
    expect(r.state.alerts[r.notifications[0].alertId].alert.scope).toBe('crew')
  })

  it('a crew stop unacknowledged by the supervisor escalates by voice; member stops escalate individually to buddies', () => {
    const s = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'stop', { channel: 'regulation' }))).state
    const r = tick(s, at(2))
    expect(r.notifications.filter((n) => n.channel === 'voice')).toHaveLength(1)
    expect(toRole(r.notifications, 'buddy')).toHaveLength(3)
  })

  it('acknowledgement permissions', () => {
    const s = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high'))).state
    const crew = Object.values(s.alerts).find((r) => r.alert.scope === 'crew')!.alert.id
    const worker = Object.values(s.alerts).find((r) => r.alert.scope === 'worker')!.alert.id
    expect(acknowledge(s, worker, 'hse_manager', at(1))).toMatchObject({ ok: false, reason: 'role_not_permitted' })
    expect(acknowledge(s, worker, 'regulator', at(1)).ok).toBe(false)
    expect(acknowledge(s, crew, 'worker', at(1)).ok).toBe(false)
    expect(acknowledge(s, crew, 'supervisor', at(1)).ok).toBe(true)
    expect(acknowledge(s, 'missing', 'supervisor', at(1))).toMatchObject({ ok: false, reason: 'unknown_alert' })
  })
})

// ─────────────────────────────── Durable escalation record ───────────────────────────────

describe('durable escalation record (escalatedAt, acks)', () => {
  it('a stop left unacknowledged: escalatedAt is set once and survives a late acknowledgement, a hand-over and resolution', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    const id = Object.keys(s.alerts)[0]
    expect(s.alerts[id].alert).toMatchObject({ acks: [] })
    expect(s.alerts[id].alert.escalatedAt).toBeUndefined()
    const t = tick(s, at(2))
    expect(t.updated[0]).toMatchObject({ id, status: 'escalated', escalatedAt: at(2) })
    s = tick(t.state, at(3)).state
    const late = acknowledge(s, id, 'worker', at(4))
    expect(late.alert).toMatchObject({ status: 'acknowledged', ack: { role: 'worker', t: at(4) }, escalatedAt: at(2), acks: [{ role: 'worker', t: at(4) }] })
    const handover = acknowledge(late.state, id, 'first_aider', at(5))
    expect(handover.alert).toMatchObject({ ack: { role: 'worker', t: at(4) }, acks: [{ role: 'worker', t: at(4) }, { role: 'first_aider', t: at(5) }] })
    const done = resolve(handover.state, id, 'supervisor', at(6))
    expect(done.alert).toMatchObject({ status: 'resolved', escalatedAt: at(2), acks: [{ role: 'worker', t: at(4) }, { role: 'first_aider', t: at(5) }] })
    // A late acknowledgement of a resolved alert is still recorded, in order.
    expect(acknowledge(done.state, id, 'buddy', at(7)).alert?.acks.map((a) => a.role)).toEqual(['worker', 'first_aider', 'buddy'])
  })

  it('routing to the first aider or occupational health is an escalation from the start; ordinary stops and reminders are not', () => {
    expect(step(createAlertEngine(), 0, [assess('W1', at(0), 'emergency', { channel: 'symptoms' })]).raised[0].escalatedAt).toBe(at(0))
    expect(step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', { channel: 'physiology' })]).raised[0].escalatedAt).toBe(at(0))
    for (const o of [{}, { channel: 'projection' as const }]) {
      const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop', o)])
      expect(r.raised[0].escalatedAt).toBeUndefined()
      const acked = acknowledge(r.state, r.raised[0].id, 'worker', at(1))
      expect(tick(acked.state, at(5)).state.alerts[r.raised[0].id].alert.escalatedAt).toBeUndefined()
    }
    const high = step(createAlertEngine(), 0, [assess('V1', at(0), 'high')])
    const reminded = tick(high.state, at(10))
    expect(reminded.notifications.map((n) => n.kind)).toEqual(['reminder'])
    expect(reminded.state.alerts[high.raised[0].id].alert.escalatedAt).toBeUndefined()
  })

  it("an emergency: the worker's own acknowledgement is recorded but not counted; the responder's is", () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'emergency', { channel: 'symptoms' })]).state
    const id = Object.keys(s.alerts)[0]
    s = acknowledge(s, id, 'worker', at(0.5)).state
    expect(s.alerts[id].alert.ack).toBeUndefined()
    const r = acknowledge(s, id, 'first_aider', at(1))
    expect(r.alert).toMatchObject({ status: 'acknowledged', ack: { role: 'first_aider', t: at(1) }, escalatedAt: at(0) })
    expect(r.alert?.acks).toEqual([{ role: 'worker', t: at(0.5) }, { role: 'first_aider', t: at(1) }])
    expect(r.state.alerts[id].acks).toEqual(r.alert?.acks)
  })

  it('a superseded alert keeps its record; a crew stop left unacknowledged is escalated; refused acknowledgements are not recorded', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')]).state
    const stopId = Object.keys(s.alerts)[0]
    s = tick(s, at(2)).state
    s = acknowledge(s, stopId, 'buddy', at(3)).state
    s = step(s, 4, [assess('W1', at(4), 'emergency', { channel: 'symptoms' })]).state
    expect(s.alerts[stopId].alert).toMatchObject({ status: 'resolved', escalatedAt: at(2), acks: [{ role: 'buddy', t: at(3) }] })

    const c = step(createAlertEngine(), 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'stop', { channel: 'regulation' }))).state
    const crewId = Object.values(c.alerts).find((r) => r.alert.scope === 'crew')!.alert.id
    const t = tick(c, at(2))
    expect(t.state.alerts[crewId].alert).toMatchObject({ status: 'escalated', escalatedAt: at(2), basis: 'exposure' })
    const refused = acknowledge(t.state, crewId, 'worker', at(3))
    expect(refused.ok).toBe(false)
    expect(refused.state.alerts[crewId].alert.acks).toEqual([])
    expect(refused.state.alerts[crewId].acks).toEqual([])
  })
})

// ─────────────────────────────── Purity, stats ───────────────────────────────

/** Freezes `v` and everything reachable from it, so any in-place write throws (ES modules run in strict mode). */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v as object)) deepFreeze(x)
  }
  return v
}

describe('state', () => {
  it('is JSON-serialisable and never mutated', () => {
    let s = createAlertEngine({ idPrefix: 'gw1:' })
    for (const { m, batch } of randomStream(7, 40)) {
      const before = JSON.stringify(s)
      const r = step(s, m, batch)
      expect(JSON.stringify(s)).toBe(before)
      expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state)
      s = r.state
    }
    expect(Object.keys(s.alerts).every((id) => id.startsWith('gw1:A-'))).toBe(true)
  })

  /**
   * Runs every call twice: on the deep-frozen current state (any in-place write to the input throws; the input must be
   * JSON-identical afterwards) and on a JSON clone of a reference state (the semantics before copy-on-write). The two
   * results must be JSON-identical.
   */
  function cowHarness(idPrefix: string) {
    let s = createAlertEngine({ idPrefix })
    let ref = createAlertEngine({ idPrefix })
    const calls: Record<string, number> = {}
    const check = (name: string, run: (st: AlertEngineState) => { state: AlertEngineState }): void => {
      const before = JSON.stringify(s)
      const out = run(deepFreeze(s))
      expect(JSON.stringify(s), `${name} changed its input`).toBe(before)
      const expected = run(JSON.parse(JSON.stringify(ref)) as AlertEngineState)
      expect(JSON.stringify(out), `${name} differs from deep-clone semantics`).toBe(JSON.stringify(expected))
      s = out.state
      ref = expected.state
      calls[name] = (calls[name] ?? 0) + 1
    }
    return { check, calls, state: () => s }
  }

  it('copy-on-write, scripted: crew create/join/resolve/clear, suppression, latch hold, emergency, pruning', () => {
    const h = cowHarness('cow:')
    const { check } = h
    const crewOf = () => Object.values(h.state().alerts).filter((x) => x.alert.scope === 'crew')
    const openOf = (w: string) => h.state().workers[w].openAlertId as string
    check('process', (st) => step(st, 0, ['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high')))) // crew created
    check('process', (st) => step(st, 1, ['W1', 'W2', 'W3', 'W4'].map((w) => assess(w, at(1), 'high', { workMinPerHour: w === 'W4' ? 10 : 30 })))) // join
    check('tick', (st) => tick(st, at(10))) // crew reminder
    const crew1 = crewOf()[0].alert.id
    check('ack', (st) => acknowledge(st, crew1, 'supervisor', at(11)))
    check('ack', (st) => acknowledge(st, crew1, 'worker', at(11))) // refused
    check('resolve', (st) => resolve(st, crew1, 'supervisor', at(12))) // crewOpen entry removed
    check('resolve', (st) => resolve(st, openOf('W1'), 'supervisor', at(12)))
    check('process', (st) => step(st, 13, ['W1', 'W2', 'W3', 'W4'].map((w) => assess(w, at(13), 'high')))) // W1 suppressed
    for (let m = 14; m <= 26; m++) check('process', (st) => step(st, m, ['W2', 'W3', 'W4'].map((w) => assess(w, at(m), 'safe'))))
    check('process', (st) => step(st, 30, ['W1', 'W2', 'W3'].map((w) => assess(w, at(30), 'stop', { channel: 'regulation' })))) // crew stop
    check('tick', (st) => tick(st, at(32))) // crew + member stop escalations
    for (const w of ['W1', 'W2', 'W3']) check('resolve', (st) => resolve(st, openOf(w), 'supervisor', at(33))) // members_cleared
    check('process', (st) => step(st, 34, [assess('W5', at(34), 'high'), assess('W5', at(34.5), 'high', { channels: { environment: 'high', projection: 'high' } })])) // re-label
    check('process', (st) => step(st, 35, [assess('V1', at(35), 'stop', { channel: 'symptoms' })]))
    check('resolve', (st) => resolve(st, openOf('V1'), 'first_aider', at(36))) // resolution hold
    check('process', (st) => step(st, 37, [assess('V1', at(37), 'stop', { channel: 'symptoms' }), assess('V2', at(37), 'emergency', { channel: 'symptoms' })]))
    check('tick', (st) => tick(st, at(39))) // emergency re-notification
    check('ack', (st) => acknowledge(st, openOf('V2'), 'buddy', at(40)))
    check('process', (st) => step(st, 200, [assess('W1', at(200), 'safe')])) // prune closed alerts and told keys
    expect(crewOf().length).toBe(0)
    expect(h.state().suppressed.length).toBeGreaterThan(0)
    expect(Object.values(h.calls).reduce((a, b) => a + b, 0)).toBeGreaterThan(30)
  })

  it('copy-on-write, random: a deep-frozen input survives processAssessments, acknowledge, resolve and tick, and results equal deep-clone semantics', () => {
    const roles: Role[] = [...ACK_ROLES, 'hse_manager']
    for (const seed of [31, 32, 33]) {
      const r = seeded(seed * 7919)
      const h = cowHarness(`s${seed}:`)
      const { check, calls } = h
      for (const { m, batch } of randomStream(seed, 60)) {
        check('processAssessments', (st) => step(st, m, batch))
        const open = Object.values(h.state().alerts)
          .filter((x) => x.alert.status !== 'resolved')
          .map((x) => x.alert.id)
        if (open.length > 0 && r() < 0.6) {
          const id = open[Math.floor(r() * open.length)]
          const role = roles[Math.floor(r() * roles.length)]
          check('acknowledge', (st) => acknowledge(st, id, role, at(m + 0.25)))
        }
        if (open.length > 0 && r() < 0.2) {
          const id = open[Math.floor(r() * open.length)]
          const role = (['supervisor', 'first_aider', 'worker'] as const)[Math.floor(r() * 3)]
          check('resolve', (st) => resolve(st, id, role, at(m + 0.5)))
        }
        if (r() < 0.3) check('tick', (st) => tick(st, at(m + 0.75)))
      }
      expect(calls.processAssessments).toBe(60)
      expect(calls.acknowledge).toBeGreaterThan(15)
      expect(calls.resolve).toBeGreaterThan(3)
      expect(calls.tick).toBeGreaterThan(5)
    }
  })

  it('published alerts are copies: changing them never reaches the engine state', () => {
    const r = step(createAlertEngine(), 0, [assess('W1', at(0), 'stop')])
    const a = r.raised[0]
    a.actions.push('call_998')
    a.acks.push({ role: 'worker', t: 0 })
    a.escalatedTo?.push('occ_health')
    a.status = 'resolved'
    const rec = r.state.alerts[a.id]
    expect(rec.alert).toMatchObject({ status: 'active', acks: [], escalatedTo: ['supervisor'] })
    expect(rec.alert.actions).not.toContain('call_998')
    const ack = acknowledge(r.state, a.id, 'worker', at(1))
    ack.alert?.acks.push({ role: 'buddy', t: 0 })
    expect(ack.state.alerts[a.id].alert.acks).toEqual([{ role: 'worker', t: at(1) }])
  })

  it('prunes closed alerts after the retention period', () => {
    let s = step(createAlertEngine(), 0, [assess('W1', at(0), 'high')]).state
    s = resolve(s, Object.keys(s.alerts)[0], 'supervisor', at(1)).state
    s = step(s, 120, [assess('W1', at(120), 'safe')]).state
    expect(Object.keys(s.alerts)).toHaveLength(0)
  })
})

describe('alertStats', () => {
  it('counts by level and scope, median time to acknowledge, escalations, suppressed and bundling', () => {
    const log: EngineAlert[] = []
    const notes: Notification[] = []
    const keep = (r: { raised?: EngineAlert[]; updated: EngineAlert[]; notifications: Notification[] }) => {
      log.push(...(r.raised ?? []), ...r.updated)
      notes.push(...r.notifications)
    }
    let r = step(createAlertEngine(), 0, [assess('V1', at(0), 'high'), assess('V2', at(0), 'stop'), ...['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high'))])
    keep(r)
    let s = r.state
    const v1 = r.raised.find((a) => a.workerId === 'V1')!.id
    const w1 = r.raised.find((a) => a.workerId === 'W1')!.id
    let a = acknowledge(s, v1, 'worker', at(1))
    log.push(a.alert!)
    a = acknowledge(a.state, w1, 'supervisor', at(3))
    log.push(a.alert!)
    s = a.state
    const t = tick(s, at(10))
    keep(t)
    s = t.state
    s = resolve(s, w1, 'supervisor', at(11)).state
    r = step(s, 12, [assess('W1', at(12), 'high')]) // suppressed repeat
    keep(r)
    const st = alertStats(log, notes, r.state.suppressed)
    expect(st.alerts).toBe(6)
    expect(st.byScope).toEqual({ worker: 5, crew: 1, site: 0 })
    expect(st.byLevel.high).toBe(5)
    expect(st.byLevel.stop).toBe(1)
    expect(st.acknowledged).toBe(2)
    expect(st.medianTimeToAckMin).toBe(2)
    expect(st.medianTimeToAckMinByLevel.high).toBe(2)
    expect(st.escalations.stopUnacknowledged).toBe(1) // V2
    expect(st.escalations.highReminders).toBe(1) // crew reminder (V1 acknowledged)
    expect(st.escalations.alertsEscalated).toBe(1)
    expect(st.suppressed).toBe(1)
    expect(st.crewBundledWorkerAlerts).toBe(3)
    expect(st.notificationsByChannel.push).toBeGreaterThan(0)
    expect(st.unacknowledged).toBeGreaterThan(0)
    expect(alertStats([], []).medianTimeToAckMin).toBeNull()
  })

  it('splits alerts, notifications, acknowledgement requests and unacknowledged alerts by basis (known answer)', () => {
    const log: EngineAlert[] = []
    const notes: Notification[] = []
    const keep = (r: { raised?: EngineAlert[]; updated: EngineAlert[]; notifications: Notification[] }) => {
      log.push(...(r.raised ?? []), ...r.updated)
      notes.push(...r.notifications)
    }
    // V1 environment high (exposure; supervisor told individually), V2 projection stop (individual),
    // W1–W3 environment high (one crew alert, exposure).
    const r = step(createAlertEngine(), 0, [assess('V1', at(0), 'high'), assess('V2', at(0), 'stop', { channel: 'projection' }), ...['W1', 'W2', 'W3'].map((w) => assess(w, at(0), 'high'))])
    keep(r)
    const ack = acknowledge(r.state, r.raised.find((a) => a.workerId === 'V1')!.id, 'worker', at(1))
    log.push(ack.alert!)
    keep(tick(ack.state, at(2))) // V2's stop unacknowledged → supervisor + buddy (individual)
    const st = alertStats(log, notes)
    // Exposure: V1, W1–W3, crew = 5 alerts; notifications: 4 workers + V1 supervisor + crew supervisor = 6 (all ack);
    // unacknowledged: W1–W3 + crew = 4 (V1 acknowledged).
    expect(st.byBasis.exposure).toEqual({ alerts: 5, notifications: 6, notificationsRequiringAck: 6, unacknowledged: 4 })
    // Individual: V2 = 1 alert; worker + supervisor + 2 escalations = 4 notifications (all ack); unacknowledged 1.
    expect(st.byBasis.individual).toEqual({ alerts: 1, notifications: 4, notificationsRequiringAck: 4, unacknowledged: 1 })
    expect([st.alerts, st.notifications, st.unacknowledged]).toEqual([6, 10, 5])
    // Without a basis (older producers), alerts and notifications count as individual.
    const legacy: Alert = { id: 'L1', t: at(0), siteId: 's', scope: 'worker', workerId: 'X', level: 'high', actions: [], reason: 'r', status: 'active' }
    const { basis: _drop, ...legacyNote } = { ...notes[0], id: 'LN', alertId: 'L1', requiresAck: true }
    void _drop
    const st2 = alertStats([legacy], [legacyNote as Notification])
    expect(st2.byBasis.individual).toEqual({ alerts: 1, notifications: 1, notificationsRequiringAck: 1, unacknowledged: 1 })
    expect(st2.byBasis.exposure).toEqual({ alerts: 0, notifications: 0, notificationsRequiringAck: 0, unacknowledged: 0 })
  })
})

// ─────────────────────────────── Properties ───────────────────────────────

describe('properties', () => {
  it('notifications carry no clinical words or fields; alert reasons are non-clinical (incl. mislabelled drivers)', () => {
    const seen = { exposure: 0, individual: 0 }
    for (const seed of [1, 2, 3, 4, 5]) {
      let s = createAlertEngine()
      const alerts: EngineAlert[] = []
      const notes: Notification[] = []
      for (const { m, batch } of randomStream(seed, 90, { mislabelled: true })) {
        const r = step(s, m, batch)
        alerts.push(...r.raised, ...r.updated)
        notes.push(...r.notifications)
        s = r.state
      }
      expect(notes.length).toBeGreaterThan(50)
      for (const n of notes) {
        expect(Object.keys(n).sort()).toEqual(NOTIFICATION_KEYS)
        for (const w of CLINICAL_WORDS) expect(n.text, n.text).not.toMatch(w)
        expect(n.reasonKey).not.toMatch(/symptom|ct_est|urine|leaky/)
        expect(['exposure', 'individual']).toContain(n.basis)
      }
      for (const a of alerts) {
        for (const w of CLINICAL_WORDS) expect(a.reason, a.reason).not.toMatch(w)
        expect(CLINICAL_TEXT_PATTERN.test(a.reason)).toBe(false)
        // The published alert carries no bookkeeping (driving channels, clinical flag): the basis is all it says.
        for (const k of Object.keys(a)) expect(ALERT_KEYS.has(k), k).toBe(true)
        if (a.basis === 'exposure') expect(a.reason).toMatch(/^Site (heat|rule): /)
        else expect(a.reason).not.toMatch(/^Site (heat|rule): /)
        seen[a.basis] += 1
      }
    }
    // Both kinds occur, so the checks above cover individual reasons too.
    expect(seen.individual).toBeGreaterThan(20)
    expect(seen.exposure).toBeGreaterThan(10)
  })

  it('individual reasons never name the personal channel, whichever channel drives them', () => {
    const reasons = new Set<string>()
    for (const channel of ['physiology', 'symptoms', 'hydration'] as const) {
      for (const level of ['caution', 'high'] as const) {
        const a = step(createAlertEngine(), 0, [assess('V1', at(0), level, { channel })]).raised[0]
        expect(a.basis).toBe('individual')
        reasons.add(a.reason)
      }
    }
    // One wording for all three personal channels, so neither the reason nor the basis tells them apart.
    expect([...reasons]).toEqual(['Personal check flagged on the worker’s device'])
  })

  it('every unacknowledged stop eventually escalates to the supervisor and the buddy', () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      let s = createAlertEngine()
      const latest = new Map<string, EngineAlert>()
      const notes: Notification[] = []
      const steps = randomStream(seed, 120)
      for (const { m, batch } of steps) {
        const r = step(s, m, batch)
        for (const a of [...r.raised, ...r.updated]) latest.set(a.id, a)
        notes.push(...r.notifications)
        s = r.state
      }
      const end = tick(s, at(140))
      for (const a of end.updated) latest.set(a.id, a)
      notes.push(...end.notifications)
      const stops = [...latest.values()].filter((a) => a.scope === 'worker' && a.level === 'stop')
      expect(stops.length).toBeGreaterThan(3)
      for (const a of stops) {
        const openFor = (a.resolvedAt ?? Number.POSITIVE_INFINITY) - a.t
        if (openFor < STOP_ACK_TIMEOUT_MIN * MINUTE_MS) continue // superseded by a higher alert first
        const esc = notes.filter((n) => n.alertId === a.id && n.kind === 'escalation')
        expect(esc.map((n) => n.to.role).sort(), a.id).toEqual(['buddy', 'supervisor'])
        expect(esc[0].t - a.t).toBeLessThanOrEqual((STOP_ACK_TIMEOUT_MIN + 1) * MINUTE_MS)
      }
    }
  })

  it('suppression never hides an escalation (worker always told; supervisor told at ≥ high, individually or via the crew alert)', () => {
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      let s = createAlertEngine()
      const latest = new Map<string, EngineAlert>()
      const prev: Record<string, RiskLevel> = Object.fromEntries(CREW_A.map((w) => [w, 'safe']))
      let escalations = 0
      for (const { m, batch } of randomStream(seed, 120)) {
        const openLevel = (w: string): RiskLevel | null => {
          const open = [...latest.values()].filter((a) => a.scope === 'worker' && a.workerId === w && a.status !== 'resolved')
          return open.length === 0 ? null : open.reduce<RiskLevel>((x, a) => (RISK_ORDER[a.level] > RISK_ORDER[x] ? a.level : x), 'safe')
        }
        const expected = batch.filter((a) => {
          const o = openLevel(a.workerId)
          return RISK_ORDER[a.level] > RISK_ORDER[prev[a.workerId]] && RISK_ORDER[a.level] >= RISK_ORDER.caution && (o === null || RISK_ORDER[a.level] > RISK_ORDER[o])
        })
        const r = step(s, m, batch)
        for (const a of [...r.raised, ...r.updated]) latest.set(a.id, a)
        for (const a of expected) {
          escalations += 1
          const told = r.notifications.filter((n) => n.to.role === 'worker' && n.to.id === a.workerId && n.level === a.level && n.kind === 'alert')
          expect(told, `${seed}@${m} ${a.workerId} → ${a.level}`).toHaveLength(1)
          if (RISK_ORDER[a.level] >= RISK_ORDER.high) {
            const alertId = told[0].alertId
            const direct = r.notifications.some((n) => n.alertId === alertId && n.to.role === 'supervisor')
            const viaCrew = [...latest.values()].some((c) => c.scope === 'crew' && c.level === a.level && (c.memberIds ?? []).includes(a.workerId))
            expect(direct || viaCrew, `${seed}@${m} supervisor for ${a.workerId}`).toBe(true)
          }
        }
        for (const a of batch) prev[a.workerId] = a.level
        s = r.state
      }
      expect(escalations).toBeGreaterThan(10)
    }
  })
})

// ─────────────────────────────── Wave 2d: designed suppression, relabel, supervisor texts ───────────────────────────────

/** engine/risk.ts `work_rest_planned`: the day plan's cap binds (it is at least as strict as the live limit). */
const PLANNED: RiskDriver = {
  id: 'work_rest_planned',
  channel: 'environment',
  text: 'Day plan: at most 30 min work per hour on this task, rest the remainder',
  value: 30,
  unit: 'min/h',
  direction: 'info',
  basis: 'engine/planner.ts day plan',
}
/** engine/risk.ts `wbgt_screen_monitored`: monitored mode, the WBGT tables are only a screen. */
const MONITORED: RiskDriver = {
  id: 'wbgt_screen_monitored',
  channel: 'environment',
  text: 'WBGT is above the table limit: your own heat-strain projection (ISO 7933) and wearable monitoring are in use',
  direction: 'raises',
  basis: 'ISO 7243:2017; ACGIH TLV; NIOSH 2016',
}
/** An environment-driven assessment with the day plan in force (plus any extra drivers). */
const planned = (w: string, t: number, level: RiskLevel, o: AOpts = {}): RiskAssessment => {
  const base = assess(w, t, level, o)
  const extra = [PLANNED, ...(o.drivers ?? [])].filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i)
  const drivers = [...base.drivers.filter((d) => !extra.some((x) => x.id === d.id)), ...extra]
  return { ...base, drivers, channels: base.channels.map((c) => ({ ...c, drivers: drivers.filter((d) => d.channel === c.channel) })) }
}

describe('designed suppression (ANSI/ISA-18.2-2016, wave 2d)', () => {
  it('constants: at most high; plan and monitored-screen drivers; the console actions a plan already puts in force', () => {
    expect(DESIGNED_SUPPRESSION_MAX_LEVEL).toBe('high')
    expect(PLAN_IN_FORCE_DRIVER_IDS).toEqual(['work_rest_planned'])
    expect(MONITORED_SCREEN_DRIVER_IDS).toEqual(['wbgt_screen_monitored'])
    expect(PLAN_COVERED_ACTIONS).toEqual(['shade_breaks', 'rotate_task', 'reduce_intensity'])
  })

  it('an exposure alert at high whose work/rest the active plan already enforces is recorded and notified to nobody; no timer runs', () => {
    const r = step(createAlertEngine(), 0, [planned('V1', at(0), 'high')])
    expect(r.raised).toHaveLength(1)
    const a = r.raised[0]
    expect(a).toMatchObject({ level: 'high', basis: 'exposure', status: 'active', suppression: { reason: 'action_in_force', t: at(0) } })
    expect(a.suppression?.liftedAt).toBeUndefined()
    expect(isAlertSuppressed(a)).toBe(true)
    expect(r.notifications).toEqual([])
    expect(r.state.alerts[a.id].suppressionCause).toBe('plan_in_force')
    // No acknowledgement was asked, so no reminder after the high timeout.
    expect(tick(r.state, at(HIGH_ACK_TIMEOUT_MIN + 5)).notifications).toEqual([])
    // It stays open and silent while the plan stays in force.
    let s = r.state
    for (let m = 1; m <= 30; m++) {
      const x = step(s, m, [planned('V1', at(m), 'high')])
      expect(x.notifications).toEqual([])
      s = x.state
    }
    expect(isAlertSuppressed(s.alerts[a.id].alert)).toBe(true)
  })

  it('a monitored-mode screen alert (WBGT tables only a screen) is suppressed too; the published alert never names the cause', () => {
    const r = step(createAlertEngine(), 0, [assess('V1', at(0), 'caution', { drivers: [DRIVER.environment, MONITORED], actions: ['drink_water'] })])
    const a = r.raised[0]
    expect(a.suppression).toEqual({ reason: 'action_in_force', t: at(0) })
    expect(r.state.alerts[a.id].suppressionCause).toBe('monitored_screen')
    expect(r.notifications).toEqual([])
    // Plan and monitored mode share one published reason: monitored mode would reveal wearable consent.
    const plan = step(createAlertEngine(), 0, [planned('V1', at(0), 'caution', { actions: ['drink_water'] })]).raised[0]
    expect(plan.suppression).toEqual(a.suppression)
    expect(JSON.stringify([a, plan])).not.toMatch(/monitor|plan_in_force|wearable|consent/i)
  })

  const NEVER: Array<[string, () => RiskAssessment]> = [
    ['stop level', () => planned('V1', at(0), 'stop')],
    ['emergency', () => planned('V1', at(0), 'emergency', { channel: 'symptoms' })],
    ['individual basis (projection at the level)', () => planned('V1', at(0), 'high', { channels: { environment: 'high', projection: 'high' } })],
    ['symptoms at the level', () => planned('V1', at(0), 'high', { channels: { environment: 'high', symptoms: 'high' } })],
    ['physiology at the level', () => planned('V1', at(0), 'high', { channels: { environment: 'high', physiology: 'high' } })],
    ['hydration at the level', () => planned('V1', at(0), 'high', { channels: { environment: 'high', hydration: 'high' } })],
    ['a first-aid action', () => planned('V1', at(0), 'high', { actions: [...DEFAULT_ACTIONS.high, 'first_aider_check'] })],
    ['a new operator action (no lone work)', () => planned('V1', at(0), 'high', { actions: [...DEFAULT_ACTIONS.high, 'no_lone_work'] })],
    ['a site sensor check', () => planned('V1', at(0), 'high', { actions: [...DEFAULT_ACTIONS.high, 'check_sensor'], drivers: [{ id: 'meter_check_advised', channel: 'environment', text: 'Check the site WBGT meter', direction: 'info', basis: 'b' }] })],
    ['a rest-now action', () => planned('V1', at(0), 'high', { actions: [...DEFAULT_ACTIONS.high, 'rest_shade_now'] })],
    ['an individual driver on the exposure channel (clinical latch)', () => planned('V1', at(0), 'high', { drivers: [DRIVER.environment, { id: 'clinical_latch', channel: 'environment', text: 'Level stays until the case is resolved', direction: 'raises', basis: 'b' }] })],
    ['no plan in force and no monitored screen', () => assess('V1', at(0), 'high')],
  ]
  it.each(NEVER)('never suppressed: %s (worker notified at once)', (_label, make) => {
    const r = step(createAlertEngine(), 0, [make()])
    expect(r.raised).toHaveLength(1)
    expect(r.raised[0].suppression).toBeUndefined()
    expect(toWorker(r.notifications, 'V1')).toHaveLength(1)
  })

  it('a carried clinical latch is never suppressed, even when the new level is exposure-only with the plan in force', () => {
    let s = step(createAlertEngine(), 0, [assess('V1', at(0), 'high', { channel: 'symptoms' })]).state
    const r = step(s, 1, [planned('V1', at(1), 'stop')])
    s = r.state
    const next = step(s, 2, [planned('V1', at(2), 'stop')])
    expect([...r.raised, ...next.raised].every((a) => a.suppression === undefined)).toBe(true)
  })

  it('escalation out of suppression: caution → high stay silent; the stop notifies at once and its acknowledgement timer runs', () => {
    let r = step(createAlertEngine(), 0, [planned('V1', at(0), 'caution', { actions: ['drink_water'] })])
    const caution = r.raised[0]
    expect(isAlertSuppressed(caution)).toBe(true)
    r = step(r.state, 1, [planned('V1', at(1), 'high')])
    expect(r.raised).toHaveLength(1)
    expect(isAlertSuppressed(r.raised[0])).toBe(true)
    expect(r.updated.find((a) => a.id === caution.id)?.status).toBe('resolved')
    expect(r.notifications).toEqual([])
    r = step(r.state, 2, [planned('V1', at(2), 'stop')])
    const stop = r.raised[0]
    expect(stop.level).toBe('stop')
    expect(stop.suppression).toBeUndefined()
    expect(toWorker(r.notifications, 'V1')).toEqual([expect.objectContaining({ requiresAck: true, kind: 'alert' })])
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    const t = tick(r.state, at(2 + STOP_ACK_TIMEOUT_MIN))
    expect(t.updated.find((a) => a.id === stop.id)?.escalatedAt).toBe(at(2 + STOP_ACK_TIMEOUT_MIN))
    expect(t.notifications.length).toBeGreaterThan(0)
  })

  it('gaining an individual basis lifts the suppression: notified at once, individually, timers counted from the lift', () => {
    let r = step(createAlertEngine(), 0, [planned('V1', at(0), 'high')])
    const id = r.raised[0].id
    r = step(r.state, 3, [planned('V1', at(3), 'high', { channels: { environment: 'high', projection: 'high' } })])
    expect(r.raised).toHaveLength(0)
    expect(r.updated).toEqual([expect.objectContaining({ id, basis: 'individual', suppression: { reason: 'action_in_force', t: at(0), liftedAt: at(3) } })])
    expect(toWorker(r.notifications, 'V1')).toHaveLength(1)
    const sup = toRole(r.notifications, 'supervisor')
    expect(sup).toHaveLength(1)
    expect(sup[0]).toMatchObject({ basis: 'individual', requiresAck: true })
    expect(sup[0].text).not.toMatch(/\d+ min to/)
    expect(r.state.alerts[id].notifiedAt).toBe(at(3))
    // The high reminder counts from the first notification (at 3), not from the raise (at 0).
    expect(tick(r.state, at(HIGH_ACK_TIMEOUT_MIN + 1)).notifications).toEqual([])
    expect(tick(r.state, at(3 + HIGH_ACK_TIMEOUT_MIN)).notifications.filter((n) => n.kind === 'reminder')).toHaveLength(1)
  })

  it('the suppressing condition ending lifts it too (the plan cap no longer binds): notified at once', () => {
    let r = step(createAlertEngine(), 0, [planned('V1', at(0), 'high')])
    const id = r.raised[0].id
    r = step(r.state, 5, [assess('V1', at(5), 'high')])
    expect(r.updated).toEqual([expect.objectContaining({ id, basis: 'exposure', suppression: { reason: 'action_in_force', t: at(0), liftedAt: at(5) } })])
    expect(toWorker(r.notifications, 'V1')).toHaveLength(1)
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
  })

  it('a level held only by the dwell (no channel at the level) keeps the suppression', () => {
    let r = step(createAlertEngine(), 0, [planned('V1', at(0), 'high')])
    const id = r.raised[0].id
    r = step(r.state, 4, [assess('V1', at(4), 'high', { channels: {}, drivers: [] })])
    expect(r.notifications).toEqual([])
    expect(isAlertSuppressed(r.state.alerts[id].alert)).toBe(true)
  })

  it('suppressed alerts are never crew-bundled; lifted together, they bundle (window counted from the lift)', () => {
    const crew = ['W1', 'W2', 'W3']
    let r = step(createAlertEngine(), 0, crew.map((w) => planned(w, at(0), 'high')))
    expect(r.notifications).toEqual([])
    expect(r.raised.every((a) => a.scope === 'worker' && isAlertSuppressed(a))).toBe(true)
    r = step(r.state, 20, crew.map((w) => assess(w, at(20), 'high')))
    const crewAlert = r.raised.find((a) => a.scope === 'crew')
    expect(crewAlert?.memberIds?.slice().sort()).toEqual(crew)
    expect(toRole(r.notifications, 'supervisor')).toHaveLength(1)
    for (const w of crew) expect(toWorker(r.notifications, w)).toHaveLength(1)
  })

  it('leaving a suppressed alert below the level raises a new alert, never a "conditions eased" message', () => {
    let r = step(createAlertEngine(), 0, [planned('V1', at(0), 'high')])
    let s = r.state
    const told: Notification[] = []
    for (let m = 1; m <= DEESCALATION_DWELL_MIN + 2; m++) {
      r = step(s, m, [assess('V1', at(m), 'caution')])
      told.push(...r.notifications)
      s = r.state
    }
    const toV1 = toWorker(told, 'V1')
    expect(toV1).toHaveLength(1)
    expect(toV1[0].kind).toBe('alert')
    expect(toV1[0].text).not.toMatch(/eased/)
  })

  it('alertStats counts designed suppression apart from repeat suppressions (known answer)', () => {
    // V1: suppressed, never lifted. W1: suppressed, then lifted by an individual cause. V2: notified normally.
    const s1 = step(createAlertEngine(), 0, [planned('V1', at(0), 'high'), planned('W1', at(0), 'high'), assess('V2', at(0), 'high')])
    const s2 = step(s1.state, 2, [
      planned('V1', at(2), 'high'),
      planned('W1', at(2), 'high', { channels: { environment: 'high', projection: 'high' } }),
      assess('V2', at(2), 'high'),
    ])
    const v1 = s1.raised.find((a) => a.workerId === 'V1')!
    const notes = [...s1.notifications, ...s2.notifications]
    const stats = alertStats([...s1.raised, ...s2.raised, ...s2.updated], notes, s2.state.suppressed)
    expect(stats.designedSuppression).toEqual({ alerts: 2, stillSuppressed: 1, lifted: 1 })
    expect(stats.alerts).toBe(3)
    expect(stats.suppressed).toBe(0)
    expect(stats.byBasis.exposure.alerts).toBe(2)
    expect(stats.byBasis.individual.alerts).toBe(1)
    expect(notes.some((n) => n.alertId === v1.id)).toBe(false)
  })
})

describe('relabel needs a cause AT the alert level (safety review wave 2c, relabel-dwell probe)', () => {
  it('the drivingChannels() fallback to a lower channel never relabels; an individual driver on a channel at the level does', () => {
    // The probe: environment stop (exposure), then a dwell-held stop with every channel safe but the projection at
    // caution (the highest channel, below the level), then all safe.
    let r = step(createAlertEngine(), 0, [assess('V1', at(0), 'stop')])
    const id = r.raised[0].id
    expect(r.raised[0].basis).toBe('exposure')
    r = step(r.state, 1, [assess('V1', at(1), 'stop', { channels: { projection: 'caution' } })])
    expect(r.updated).toEqual([])
    expect(r.state.alerts[id].alert).toMatchObject({ basis: 'exposure', reason: 'Site heat: too hot for this work now' })
    r = step(r.state, 2, [assess('V1', at(2), 'stop', { channels: {}, drivers: [] })])
    expect(r.state.alerts[id].alert.basis).toBe('exposure')
    // An individual driver on a channel below the level does not relabel either.
    r = step(r.state, 3, [assess('V1', at(3), 'stop', { channels: { environment: 'stop', projection: 'caution' }, drivers: [DRIVER.environment, { ...DRIVER.projection, id: 'phs_limit_reached' }] })])
    expect(r.state.alerts[id].alert.basis).toBe('exposure')
    // One on a channel at the level does.
    const budget: RiskDriver = { id: 'acclimatization_budget_exhausted', channel: 'environment', text: "Today's heat-exposure allowance is used up: no more hot work today", direction: 'raises', basis: 'b' }
    expect(INDIVIDUAL_DRIVER_IDS).toContain('acclimatization_budget_exhausted')
    r = step(r.state, 4, [assess('V1', at(4), 'stop', { drivers: [budget, DRIVER.environment] })])
    expect(r.updated).toEqual([expect.objectContaining({ id, basis: 'individual', reason: 'Not cleared for heat work now: assign cooler work; the device will say when to return.', reasonKey: 'reason.not_cleared_for_heat_work' })])
    expect(r.notifications).toEqual([])
  })
})

describe('supervisor-facing texts (wave 2d)', () => {
  it('the private-factor filter: fasting and consent words are caught; site and pooled texts pass', () => {
    for (const t of ['Fasting: your water limit is used up', 'Wearable monitoring is off (consent, wearable or setting)', 'during Ramadan', 'consented band']) {
      expect(PRIVATE_FACTOR_TEXT_PATTERN.test(t), t).toBe(true)
      expect(supervisorSafeText(t), t).toBe(false)
    }
    for (const t of ['Site heat: work/rest 30/30 in effect', 'Not cleared for heat work now: assign cooler work; the device will say when to return.', "Device-directed rest: follow the work and rest times on the worker's device.", 'Breakfast break at 09:00']) {
      expect(supervisorSafeText(t), t).toBe(true)
    }
    expect(supervisorSafeText('Dizziness reported')).toBe(false) // the clinical pattern still applies
  })

  const PRIVATE_DRIVERS: Array<[string, RiskDriver, RiskLevel]> = [
    ['monitored mode', MONITORED, 'stop'],
    ['monitoring fallback (consent)', { id: 'monitoring_fallback_tables', channel: 'environment', text: 'Wearable monitoring is off (consent, wearable or setting): the table work/rest limits apply again', direction: 'raises', basis: 'b' }, 'high'],
    ['stricter personal limit', { id: 'limit_stricter_personal', channel: 'environment', text: 'The stricter personal exposure limit applies', direction: 'raises', basis: 'b' }, 'high'],
    ['environment task hold', { id: 'resume_hold_environment', channel: 'environment', text: 'Rest before going back to this task: the heat-exposure limit does not allow it now', direction: 'raises', basis: 'b' }, 'stop'],
    ['regulation task hold', { id: 'resume_hold_regulation', channel: 'regulation', text: 'Midday work ban: rest until it ends at 15:00', direction: 'raises', basis: 'b' }, 'stop'],
    ['projection resume hold with a rest estimate', { id: 'phs_resume_hold', channel: 'projection', text: 'Rest before going back to this task: about 25 min of rest needed (rest 40 % done)', direction: 'raises', basis: 'b' }, 'stop'],
    ['projection work-bout countdown', { id: 'phs_work_bout', channel: 'projection', text: 'About 12 min of work left before the next rest', value: 12, unit: 'min', direction: 'raises', basis: 'b' }, 'high'],
    ['drink-restricted wording on the projection channel', { id: 'phs_limit_reached', channel: 'projection', text: 'Not drinking (fasting): no more heat work this shift', direction: 'raises', basis: 'b' }, 'stop'],
  ]
  it.each(PRIVATE_DRIVERS)('%s: the alert reason, key and supervisor notification carry no number, private word or private id', (_label, d, level) => {
    const r = step(createAlertEngine(), 0, [assess('V1', at(0), level, { channel: d.channel, drivers: [d] })])
    const a = r.raised[0]
    const sup = toRole(r.notifications, 'supervisor')
    expect(sup.length).toBeGreaterThan(0)
    // The work/rest minutes are the released operational field (workMinPerHour); no other number may appear.
    const released = (s: string): string =>
      s.replace(ROSTER.V1.displayName, '').replace(/\(\d+ min work \/ \d+ min rest per hour\)/g, '').replace(/work\/rest \d+\/\d+/g, '')
    for (const text of [a.reason, ...sup.map((n) => n.text)]) {
      expect(released(text), text).not.toMatch(/\d/)
      expect(supervisorSafeText(text), text).toBe(true)
    }
    expect(a.reasonKey).toMatch(/^(driver\.[a-z_]+|reason\.(not_cleared_for_heat_work|device_directed_rest|heat_exposure|regulation|projection|personal_check|first_aid_check|emergency))$/)
    expect(a.reasonKey).not.toMatch(/monitor|fasting|drink|stricter|resume_hold/)
  })

  it('fasting vs drinking at the same limit: identical supervisor-facing alert and notifications', () => {
    const at0 = (fasting: boolean): RiskAssessment => {
      const proj: RiskDriver[] = [
        { id: 'phs_limit_reached', channel: 'projection', text: 'Heat-strain model: the water-loss limit is reached', direction: 'raises', basis: 'ISO 7933:2023' },
        fasting
          ? { id: 'phs_recovery_review_required', channel: 'projection', text: 'Not drinking: the water-loss allowance is used up, so no more heat work this shift', direction: 'raises', basis: 'b' }
          : { id: 'phs_drink_to_restart', channel: 'projection', text: 'Drink and rest: about 1.2 L to drink before heat work can restart (rest 0 % done)', value: 1.2, unit: 'L', direction: 'raises', basis: 'b' },
      ]
      const hyd: RiskDriver[] = fasting
        ? [{ id: 'water_paused_fasting', channel: 'hydration', text: 'Fasting: water recommendation paused (0 mL/h)', direction: 'info', basis: 'b' }]
        : [{ id: 'phs_water_credit', channel: 'hydration', text: 'Logged drinks counted: 1.5 L', direction: 'info', basis: 'b' }]
      return assess('V1', at(0), 'stop', {
        channels: { projection: 'stop' },
        drivers: [...proj, ...hyd],
        actions: fasting ? ['rest_shade_now', 'cool_down', 'symptom_checkin'] : ['rest_shade_now', 'cool_down', 'drink_water', 'electrolytes', 'symptom_checkin'],
      })
    }
    const view = (fasting: boolean) => {
      const r = step(createAlertEngine(), 0, [at0(fasting)])
      const a = r.raised[0]
      const t = tick(r.state, at(STOP_ACK_TIMEOUT_MIN))
      const consoles = [...r.notifications, ...t.notifications].filter((n) => !(n.to.role === 'worker' && n.to.id === 'V1'))
      return {
        alert: { level: a.level, basis: a.basis, reason: a.reason, reasonKey: a.reasonKey, consoleActions: a.consoleActions, frame: a.frame, suppression: a.suppression },
        consoles: consoles.map((n) => ({ to: n.to, channel: n.channel, level: n.level, actions: n.actions, reasonKey: n.reasonKey, text: n.text, kind: n.kind })),
      }
    }
    expect(view(true)).toEqual(view(false))
    expect(view(true).alert).toMatchObject({ basis: 'individual', reasonKey: 'reason.not_cleared_for_heat_work', consoleActions: ['rest_shade_now', 'cool_down', 'rotate_task'] })
    expect(JSON.stringify(view(true))).not.toMatch(/drink|fasting|water-loss|electrolyte|check-in|mL/i)
  })
})

describe('individual reason refresh (wave 2d)', () => {
  it('an open individual alert takes the current reason when its cause changes at the same level, without a notification; no churn otherwise', () => {
    let r = step(createAlertEngine(), 0, [assess('V1', at(0), 'stop', { channel: 'projection' })])
    const id = r.raised[0].id
    expect(r.raised[0]).toMatchObject({ basis: 'individual', reasonKey: 'driver.phs_minutes_to_limit' })
    // The same assessment again: nothing to publish.
    r = step(r.state, 0.5, [assess('V1', at(0.5), 'stop', { channel: 'projection' })])
    expect(r.updated).toEqual([])
    // The limit is now reached: the pooled phrase replaces the countdown phrase.
    const reached: RiskDriver = { id: 'phs_limit_reached', channel: 'projection', text: 'Heat-strain model: the body-heat limit is reached', direction: 'raises', basis: 'ISO 7933:2023' }
    r = step(r.state, 1, [assess('V1', at(1), 'stop', { channel: 'projection', drivers: [reached] })]) // within the 2-min stop timeout
    expect(r.updated).toEqual([expect.objectContaining({ id, reason: 'Not cleared for heat work now: assign cooler work; the device will say when to return.', reasonKey: 'reason.not_cleared_for_heat_work' })])
    expect(r.notifications).toEqual([])
  })
})
