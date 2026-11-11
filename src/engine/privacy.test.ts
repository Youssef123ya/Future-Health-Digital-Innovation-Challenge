import { describe, it, expect } from 'vitest'
import { createRng, type Rng } from '../sim/rng'
import type {
  ActionId,
  AuditEntry,
  ChannelId,
  ConsentState,
  DataField,
  Purpose,
  RiskAssessment,
  RiskDriver,
  RiskFlagId,
  RiskLevel,
  Role,
  SymptomId,
  WorkerProfile,
} from './types'
import { PROHIBITED_PURPOSES, RISK_LEVELS } from './types'
import {
  ACCESS_MATRIX,
  AGGREGATE_CONSENT,
  AUDIT_LOG_RETENTION,
  AuditLog,
  CHECKIN_RETENTION_MS,
  CLINICAL_DRIVER_CHANNELS,
  CLINICAL_FIELDS,
  CONSENT_NOTICES,
  CONSENT_NOTICE_VERSION,
  CONSENT_RECEIPT_RETENTION,
  CONSENT_SCOPES,
  DATA_FIELDS,
  DEFAULT_MIN_CELL_SIZE,
  EMPLOYER_MIN_CELL_SIZE,
  GENERAL_PRIVACY_NOTICE,
  GENERAL_PRIVACY_NOTICE_VERSION,
  GENESIS_HASH,
  LEVEL_HISTORY_RETENTION_MS,
  PROHIBITION_BASIS,
  RAW_PHYSIOLOGY_RETENTION_MS,
  REGULATOR_MIN_CELL_SIZE,
  SYNC_PAYLOAD_KEYS,
  activeProcessing,
  aggregate,
  aggregateAndLog,
  aggregateFor,
  applyRetention,
  canonicalJson,
  createConsentReceipt,
  createWorkerSnapshot,
  explain,
  grantConsent,
  inspectSyncPayload,
  isProhibitedPurpose,
  payloadForSync,
  project,
  POOLED_DRIVERS,
  POOLED_DRIVER_IDS,
  DEVICE_ONLY_ACTIONS,
  SITE_SENSOR_DRIVER_IDS,
  SUPERVISOR_DRIVER_RULES,
  SYNC_WATER_NOT_SENT_ML,
  notClearedForHeatWork,
  supervisorActions,
  supervisorDriver,
  supervisorDriverRule,
  supervisorDrivers,
  projectAndLog,
  purgeCheckins,
  purgeLevelHistory,
  purgeRawPhysiology,
  revokeConsent,
  sha256Hex,
  type AckStatus,
  type AggregateTable,
  type AuditDraft,
  type ConsentCollector,
  type ConsentReceiptInput,
  type PublishedCell,
  type UrineColor,
  type WorkerSnapshot,
} from './privacy'
import { ACTION_PRIORITY, DRIVER_IDS, createWorkerEngine, stepWorkerEngine } from './risk'
import { computeSiteHeat } from './indices'
import { HOUR_MS as HOUR, MINUTE_MS as MINUTE, epochFromLocal } from './time'
import { getSite } from '../data/sites'
import { CLINICAL_TEXT_PATTERN, PRIVATE_FACTOR_TEXT_PATTERN, supervisorSafeText } from './alerts'
import { CATALOGS, CONSOLE_PHRASES } from '../i18n/messages'

// ─────────────────────────────── Shared test data ───────────────────────────────

const ROLES: readonly Role[] = [
  'worker',
  'buddy',
  'supervisor',
  'first_aider',
  'occ_health',
  'hse_manager',
  'regulator',
  'employer_hr',
]
const PURPOSES: readonly Purpose[] = [
  'safety_alerting',
  'clinical_care',
  'operational_planning',
  'compliance_reporting',
  'public_health_statistics',
  'performance_management',
  'disciplinary_action',
  'insurance_underwriting',
  'immigration_or_visa',
]
const T0 = Date.UTC(2026, 6, 15, 9, 0) // 2026-07-15 13:00 Abu Dhabi (UTC+4)
const WORKER = 'W-7F3A'

// Independent transcription of the governance brief (task + ARCHITECTURE §2), used as the test oracle.
const ALL: DataField[] = [
  'displayName',
  'crewId',
  'level',
  'actions',
  'workMinPerHour',
  'ackStatus',
  'minutesToLimit',
  'waterMlPerHour',
  'drivers_nonclinical',
  'drivers_clinical',
  'hrBpm',
  'ctEstC',
  'psi',
  'riskFlags',
  'symptoms',
  'urineColor',
  'ageYears',
  'location',
]
// Wave 2d: no individual water figure for supervisors (GOVERNANCE §13 item 18; it reveals fasting and body size).
const SUPERVISOR_VIEW: DataField[] = [
  'displayName',
  'crewId',
  'level',
  'actions',
  'workMinPerHour',
  'ackStatus',
  'drivers_nonclinical',
]
const NEVER_TO_SUPERVISOR: DataField[] = [
  'waterMlPerHour',
  'hrBpm',
  'ctEstC',
  'psi',
  'riskFlags',
  'symptoms',
  'urineColor',
  'ageYears',
  'drivers_clinical',
  'minutesToLimit',
]
/** The supervisor view in canonical DataField order (the order project() releases fields in). */
const SUPERVISOR_VIEW_CANONICAL: DataField[] = ALL.filter((f) => SUPERVISOR_VIEW.includes(f))
const BUDDY_VIEW: DataField[] = ['displayName', 'level', 'actions', 'ackStatus']
const FIRST_AID_VIEW: DataField[] = ['displayName', 'level', 'actions', 'location']
const OH_CASE_VIEW: DataField[] = ['displayName', 'crewId', 'level', 'actions', 'ackStatus', 'location']

function consentOf(over: Partial<ConsentState> = {}): ConsentState {
  return {
    wearable: true,
    healthFlags: true,
    checkins: true,
    shareWithMedicOnEscalation: true,
    aggregateStatistics: true,
    updatedAt: T0,
    ...over,
  }
}
const NO_CONSENT = consentOf({
  wearable: false,
  healthFlags: false,
  checkins: false,
  shareWithMedicOnEscalation: false,
  aggregateStatistics: false,
})

const DRIVERS: RiskDriver[] = [
  { id: 'wbgt_over_limit', channel: 'environment', text: 'Effective WBGT 33.1 °C is 2.0 °C over the personal exposure limit for Rebar (412 W)', value: 33.1, unit: '°C', direction: 'raises', basis: 'NIOSH 2016 REL' },
  { id: 'twl_zone_high', channel: 'regulation', text: 'TWL 108 W/m²: High Risk — High Zone', value: 108, unit: 'W/m²', direction: 'raises', basis: 'ADOSH-SF CoP 11.0 v4.0' },
  { id: 'phs_minutes_to_limit', channel: 'projection', text: 'Heat-strain model: about 12 min to the body-heat limit at the current activity', value: 12, unit: 'min', direction: 'raises', basis: 'ISO 7933:2023' },
  { id: 'ct_est_high', channel: 'physiology', text: 'Estimated strain indicator high', value: 38.6, unit: '°C', direction: 'raises', basis: 'Buller 2013' },
  { id: 'symptom_t2', channel: 'symptoms', text: 'Dizziness reported', direction: 'raises', basis: 'ACSM 2023' },
  { id: 'urine_dark', channel: 'hydration', text: 'Urine shade 6', value: 6, direction: 'raises', basis: 'Armstrong 8-shade chart' },
]

function snapshotOf(over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    workerId: WORKER,
    t: T0,
    displayName: 'Ravi K.',
    crewId: 'crew-a',
    level: 'stop',
    actions: ['rest_shade_now', 'cool_down', 'first_aider_check', 'occ_health_review'],
    workMinPerHour: 15,
    ackStatus: 'active',
    minutesToLimit: 12,
    waterMlPerHour: 1000,
    drivers: DRIVERS.map((d) => ({ ...d })),
    hrBpm: 168,
    ctEstC: 38.6,
    psi: 7.1,
    riskFlags: ['heat_sensitive_medication'],
    symptoms: ['dizziness'],
    urineColor: 6,
    ageYears: 41,
    location: { siteId: 'musaffah', label: 'Bay 4, scaffold C' },
    consent: consentOf(),
    ...over,
  }
}

function profileOf(over: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id: WORKER,
    displayName: 'Ravi K.',
    crewId: 'crew-a',
    siteId: 'musaffah',
    language: 'ml',
    ageYears: 41,
    sex: 'male',
    massKg: 72,
    heightCm: 170,
    daysOnSite: 40,
    daysAwayRecent: 0,
    experiencedInHeat: true,
    clothing: 'cloth_coveralls',
    riskFlags: ['heat_sensitive_medication'],
    restingHrBpm: 64,
    consent: consentOf(),
    hasWearable: true,
    ...over,
  }
}

function assessmentOf(over: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    workerId: WORKER,
    t: T0,
    level: 'stop',
    channels: [],
    drivers: DRIVERS.map((d) => ({ ...d })),
    actions: ['rest_shade_now', 'cool_down', 'occ_health_review', 'restrict_fluids'],
    workMinPerHour: 14.6,
    minutesToLimit: 12,
    waterMlPerHour: 1006,
    confidence: 'medium',
    dataQuality: { env: 'forecast', physiology: 'good', network: 'online', stale: false },
    ...over,
  }
}

// ─────────────────────────────── Access matrix ───────────────────────────────

describe('ACCESS_MATRIX', () => {
  it('documents a reason and a basis for every role × purpose cell', () => {
    for (const role of ROLES) {
      for (const purpose of PURPOSES) {
        const rule = ACCESS_MATRIX[role][purpose]
        expect(rule.reason.length, `${role}/${purpose}`).toBeGreaterThan(20)
        expect(rule.basis.length, `${role}/${purpose}`).toBeGreaterThan(20)
        for (const grant of rule.grants) expect(grant.reason.length).toBeGreaterThan(10)
      }
    }
    expect(new Set(Object.keys(PROHIBITION_BASIS))).toEqual(new Set(PROHIBITED_PURPOSES))
    for (const purpose of PURPOSES) expect(isProhibitedPurpose(purpose)).toBe(PROHIBITED_PURPOSES.includes(purpose))
  })

  it('never grants a supervisor clinical fields, and gives HSE / regulator / HR aggregates only', () => {
    for (const purpose of PURPOSES) {
      const supervisorFields = ACCESS_MATRIX.supervisor[purpose].grants.flatMap((g) => g.fields)
      expect(supervisorFields.filter((f) => NEVER_TO_SUPERVISOR.includes(f))).toEqual([])
      for (const role of ['hse_manager', 'regulator', 'employer_hr'] as const) {
        expect(ACCESS_MATRIX[role][purpose].grants).toEqual([])
      }
    }
    expect(new Set(ACCESS_MATRIX.supervisor.safety_alerting.grants.flatMap((g) => g.fields))).toEqual(new Set(SUPERVISOR_VIEW))
    expect(ACCESS_MATRIX.hse_manager.compliance_reporting.aggregateMinCell).toBe(DEFAULT_MIN_CELL_SIZE)
    expect(ACCESS_MATRIX.regulator.compliance_reporting.aggregateMinCell).toBe(REGULATOR_MIN_CELL_SIZE)
    expect(ACCESS_MATRIX.regulator.public_health_statistics.aggregateMinCell).toBe(10)
    expect(ACCESS_MATRIX.employer_hr.compliance_reporting.aggregateMinCell).toBe(EMPLOYER_MIN_CELL_SIZE)
    for (const purpose of PROHIBITED_PURPOSES) {
      for (const role of ROLES) expect(ACCESS_MATRIX[role][purpose]).toMatchObject({ grants: [], aggregateMinCell: null })
    }
  })

  it('cannot be altered at run time', () => {
    expect(Object.isFrozen(ACCESS_MATRIX.supervisor.safety_alerting)).toBe(true)
    expect(() => {
      ;(ACCESS_MATRIX.supervisor.safety_alerting.grants[0].fields as DataField[]).push('hrBpm')
    }).toThrow(TypeError)
    expect(DATA_FIELDS).toEqual(ALL)
    expect(CLINICAL_FIELDS).toEqual(['minutesToLimit', 'drivers_clinical', 'hrBpm', 'ctEstC', 'psi', 'riskFlags', 'symptoms', 'urineColor'])
  })
})

// ─────────────────────────────── Projection: exhaustive matrix ───────────────────────────────

interface Situation {
  level: RiskLevel
  escalated: boolean
  isSelf: boolean
  consent: ConsentState
}

function expectedFields(role: Role, purpose: Purpose, s: Situation): DataField[] {
  if (PROHIBITED_PURPOSES.includes(purpose)) return []
  const activeCase = s.level === 'stop' || s.level === 'emergency'
  let fields: DataField[] = []
  if (role === 'worker' && s.isSelf) fields = ALL
  if (role === 'buddy' && purpose === 'safety_alerting') fields = BUDDY_VIEW
  if (role === 'supervisor' && (purpose === 'safety_alerting' || purpose === 'operational_planning')) {
    fields = SUPERVISOR_VIEW
  }
  if (role === 'first_aider' && purpose === 'safety_alerting' && activeCase) {
    fields = s.escalated ? [...FIRST_AID_VIEW, 'symptoms'] : FIRST_AID_VIEW
  }
  if (role === 'occ_health' && s.escalated && (purpose === 'safety_alerting' || purpose === 'clinical_care')) {
    fields = purpose === 'clinical_care' && s.consent.shareWithMedicOnEscalation ? ALL : OH_CASE_VIEW
  }
  return fields.filter((f) => {
    if (f === 'hrBpm' || f === 'ctEstC' || f === 'psi') return s.consent.wearable
    if (f === 'riskFlags') return s.consent.healthFlags
    if (f === 'urineColor') return s.consent.checkins
    return true
  })
}

describe('project — exhaustive role × purpose × level × escalation × consent matrix', () => {
  it('releases exactly the specified fields in every one of 18,432 situations', () => {
    let cases = 0
    for (const role of ROLES) {
      for (const purpose of PURPOSES) {
        for (const level of ['safe', 'high', 'stop', 'emergency'] as const) {
          for (const escalated of [false, true]) {
            for (const isSelf of [false, true]) {
              for (let bits = 0; bits < 16; bits++) {
                const consent = consentOf({
                  wearable: (bits & 1) !== 0,
                  healthFlags: (bits & 2) !== 0,
                  checkins: (bits & 4) !== 0,
                  shareWithMedicOnEscalation: (bits & 8) !== 0,
                })
                const result = project(
                  snapshotOf({ level, consent }),
                  { role, actorId: isSelf ? WORKER : 'actor-1', purpose },
                  { now: T0, escalated },
                )
                const expected = expectedFields(role, purpose, { level, escalated, isSelf, consent })
                const label = `${role}/${purpose}/${level}/escalated=${escalated}/self=${isSelf}/consent=${bits}`
                expect(result.fields, label).toEqual(ALL.filter((f) => expected.includes(f)))
                expect(Object.keys(result.data).sort(), label).toEqual([...result.fields].sort())
                expect(result.decision, label).toBe(expected.length > 0 ? 'allowed' : 'denied')
                expect(result.audit.decision).toBe(result.decision)
                cases++
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(18_432)
  })
})

// ─────────────────────────────── Projection: specific rules ───────────────────────────────

const ALL_ACTIONS: ActionId[] = [
  'drink_water', 'shade_breaks', 'reduce_intensity', 'rotate_task', 'rest_shade_now', 'cool_down', 'stop_work',
  'buddy_check', 'first_aider_check', 'call_998', 'cool_first', 'stay_with_worker', 'midday_break',
  'acclimatization_plan', 'occ_health_review', 'check_sensor', 'symptom_checkin', 'no_lone_work', 'electrolytes',
  'restrict_fluids', 'medical_evaluation', 'no_hot_work_today',
]
const ALL_SYMPTOMS: SymptomId[] = [
  'thirst', 'heat_rash', 'cramps', 'cramps_persistent', 'headache', 'dizziness', 'nausea', 'weakness_fatigue',
  'fainted', 'brown_urine', 'drank_a_lot', 'swollen_hands', 'repeated_vomiting', 'chest_pain', 'confusion',
  'slurred_speech', 'unsteady_walking', 'collapsed_unresponsive', 'seizure',
]
const ALL_FLAGS: RiskFlagId[] = [
  'prior_heat_illness', 'heat_sensitive_medication', 'hr_suppressing_medication', 'recent_illness', 'poor_sleep',
  'fasting', 'heat_rash_sunburn', 'oh_review_required',
]
const CHANNELS: ChannelId[] = ['environment', 'regulation', 'projection', 'physiology', 'symptoms', 'hydration']
const ACKS: AckStatus[] = ['none', 'active', 'acknowledged', 'escalated', 'resolved']
const URINE: UrineColor[] = [1, 2, 3, 4, 5, 6, 7, 8]

const subsetOf = <T,>(rng: Rng, items: readonly T[]): T[] => items.filter(() => rng.chance(0.35))

function randomSnapshot(rng: Rng, n: number): WorkerSnapshot {
  return {
    workerId: `W-${n}`,
    t: T0 + n * 60_000,
    displayName: `Worker ${n}`,
    crewId: rng.pick(['crew-a', 'crew-b']),
    level: rng.pick(RISK_LEVELS),
    actions: subsetOf(rng, ALL_ACTIONS),
    workMinPerHour: rng.int(0, 60),
    ackStatus: rng.pick(ACKS),
    minutesToLimit: rng.chance(0.3) ? null : rng.int(0, 120),
    waterMlPerHour: rng.int(0, 1420),
    drivers: Array.from({ length: rng.int(0, 7) }, (_, i): RiskDriver => {
      const channel = rng.pick(CHANNELS)
      return { id: `${channel}_${i}`, channel, text: `${channel} reason ${i}`, value: rng.uniform(0, 200), unit: 'u', direction: 'raises', basis: 'test' }
    }),
    hrBpm: rng.int(60, 200),
    ctEstC: rng.uniform(36.5, 40),
    psi: rng.uniform(0, 10),
    riskFlags: subsetOf(rng, ALL_FLAGS),
    symptoms: subsetOf(rng, ALL_SYMPTOMS),
    urineColor: rng.pick(URINE),
    ageYears: rng.int(18, 65),
    location: { siteId: 'musaffah', label: `Bay ${n % 9}` },
    consent: {
      wearable: rng.chance(0.5),
      healthFlags: rng.chance(0.5),
      checkins: rng.chance(0.5),
      shareWithMedicOnEscalation: rng.chance(0.5),
      aggregateStatistics: rng.chance(0.5),
      updatedAt: T0,
    },
  }
}

describe('project — rules', () => {
  it('refuses every prohibited purpose for every role, even with full consent, and logs each refusal', async () => {
    const log = new AuditLog()
    const snap = snapshotOf({ level: 'emergency' })
    for (const role of ROLES) {
      for (const purpose of PROHIBITED_PURPOSES) {
        for (const actorId of [WORKER, 'actor-1']) {
          const ctx = { now: T0, escalated: true, buddyIds: [actorId], actorCrewIds: ['crew-a'] }
          const r = await projectAndLog(log, snap, { role, actorId, purpose }, ctx)
          expect(r.decision).toBe('denied')
          expect(r.fields).toEqual([])
          expect(r.data).toEqual({})
          expect(r.reason).toMatch(/prohibited purpose/)
          expect(r.reason).toMatch(/logged/)
          expect(r.entry).toMatchObject({ decision: 'denied', purpose, actorRole: role, actorId, subjectId: WORKER })
          expect(r.entry.fields).toEqual(ALL) // what was asked for
        }
      }
    }
    expect(log.length).toBe(ROLES.length * PROHIBITED_PURPOSES.length * 2)
    expect((await log.verify()).ok).toBe(true)
  })

  it('never hands a supervisor clinical detail (property test, 3,000 random snapshots)', () => {
    const rng = createRng('privacy-supervisor-property')
    let allowed = 0
    for (let n = 0; n < 3000; n++) {
      const snap = randomSnapshot(rng, n)
      const purpose = rng.pick(PURPOSES)
      const fields = rng.chance(0.5) ? undefined : rng.shuffle(DATA_FIELDS).slice(0, rng.int(1, DATA_FIELDS.length))
      const ctx = {
        now: snap.t,
        escalated: rng.chance(0.5),
        actorCrewIds: rng.chance(0.3) ? undefined : [rng.pick(['crew-a', 'crew-b'])],
      }
      const r = project(snap, { role: 'supervisor', actorId: 'S-01', purpose, fields }, ctx)
      if (r.decision === 'allowed') allowed++
      const keys = Object.keys(r.data) as DataField[]
      expect(keys.filter((k) => !SUPERVISOR_VIEW.includes(k))).toEqual([])
      expect(r.fields.filter((f) => NEVER_TO_SUPERVISOR.includes(f))).toEqual([])
      for (const d of r.data.drivers_nonclinical ?? []) {
        expect(CLINICAL_DRIVER_CHANNELS).not.toContain(d.channel)
        if (d.channel === 'projection') expect(d.value).toBeUndefined() // the individual minutes-to-limit number
      }
      expect(r.data.actions ?? []).not.toContain('occ_health_review')
      const json = JSON.stringify(r.data)
      for (const s of snap.symptoms) expect(json).not.toContain(`"${s}"`)
      for (const f of snap.riskFlags) expect(json).not.toContain(`"${f}"`)
      for (const key of NEVER_TO_SUPERVISOR) expect(json).not.toContain(`"${key}"`)
    }
    expect(allowed).toBeGreaterThan(300) // the property was exercised on real releases, not only refusals
  })

  it('scopes supervisors to their crews and buddies to their partner when the context says so', () => {
    const snap = snapshotOf()
    const sup = { role: 'supervisor', actorId: 'S-01', purpose: 'safety_alerting' } as const
    expect(project(snap, sup, { now: T0, escalated: false, actorCrewIds: ['crew-b'] }).decision).toBe('denied')
    expect(project(snap, sup, { now: T0, escalated: false, actorCrewIds: ['crew-a'] }).fields).toEqual(SUPERVISOR_VIEW_CANONICAL)
    const buddy = { role: 'buddy', actorId: 'W-0002', purpose: 'safety_alerting' } as const
    expect(project(snap, buddy, { now: T0, escalated: false, buddyIds: ['W-0001'] }).decision).toBe('denied')
    expect(project(snap, buddy, { now: T0, escalated: false, buddyIds: ['W-0002'] }).fields).toEqual(BUDDY_VIEW)
    const other = project(snap, { role: 'worker', actorId: 'W-0002', purpose: 'safety_alerting' }, { now: T0, escalated: false })
    expect(other.decision).toBe('denied')
    expect(other.reason).toMatch(/the requester is the worker the data is about/)
  })

  it('gives first aiders the live case, and symptoms only once escalated — never flags or physiology', () => {
    const fa = { role: 'first_aider', actorId: 'FA-01', purpose: 'safety_alerting' } as const
    expect(project(snapshotOf({ level: 'high' }), fa, { now: T0, escalated: true }).decision).toBe('denied')
    const live = project(snapshotOf(), fa, { now: T0, escalated: false })
    expect(live.fields).toEqual(['displayName', 'level', 'actions', 'location'])
    expect(live.reason).toMatch(/Not released until the case has been escalated: symptoms/)
    const escalated = project(snapshotOf({ level: 'emergency' }), fa, { now: T0, escalated: true })
    expect(escalated.data.symptoms).toEqual(['dizziness'])
    expect(escalated.fields).not.toContain('riskFlags')
    expect(escalated.fields).not.toContain('hrBpm')
  })

  it('releases clinical detail to occupational health only for an escalated, consented case', () => {
    const oh = { role: 'occ_health', actorId: 'OH-01', purpose: 'clinical_care' } as const
    expect(project(snapshotOf(), oh, { now: T0, escalated: false }).decision).toBe('denied')
    const noConsent = project(snapshotOf({ consent: consentOf({ shareWithMedicOnEscalation: false }) }), oh, {
      now: T0,
      escalated: true,
    })
    expect(noConsent.fields).toEqual(OH_CASE_VIEW)
    expect(noConsent.reason).toMatch(/consented to share clinical detail/)
    const full = project(snapshotOf(), oh, { now: T0, escalated: true })
    expect(full.fields).toEqual(ALL)
    expect(full.data.hrBpm).toBe(168)
    expect(full.data.actions).toContain('occ_health_review')
    expect(full.data.drivers_nonclinical?.find((d) => d.channel === 'projection')?.value).toBe(12)
    expect(full.data.drivers_clinical?.map((d) => d.channel)).toEqual(['physiology', 'symptoms', 'hydration'])
  })

  it('answers a field-level request with only the permitted subset and says why', () => {
    const r = project(
      snapshotOf(),
      { role: 'supervisor', actorId: 'S-01', purpose: 'safety_alerting', fields: ['level', 'hrBpm', 'symptoms'] },
      { now: T0, escalated: true },
    )
    expect(r).toMatchObject({ decision: 'allowed', fields: ['level'], withheld: ['hrBpm', 'symptoms'], data: { level: 'stop' } })
    expect(r.reason).toMatch(/Never released for this purpose: hrBpm, symptoms/)
    expect(r.audit.fields).toEqual(['level'])
    const supervisorDrivers = project(snapshotOf(), { role: 'supervisor', actorId: 'S-01', purpose: 'safety_alerting' }, { now: T0, escalated: false }).data.drivers_nonclinical
    // Wave 2d: only the site driver (the ADOSH zone) keeps its number; the personal-limit margin, the metabolic rate
    // and the minutes to the limit become generic phrases.
    expect(supervisorDrivers?.map((d) => [d.channel, d.value])).toEqual([
      ['environment', undefined],
      ['regulation', 108],
      ['projection', undefined],
    ])
  })

  it('returns copies, so a recipient cannot alter the on-device record', () => {
    const snap = snapshotOf()
    const r = project(snap, { role: 'worker', actorId: WORKER, purpose: 'safety_alerting' }, { now: T0, escalated: false })
    r.data.actions?.push('call_998')
    r.data.symptoms?.push('seizure')
    if (r.data.location) r.data.location.label = 'moved'
    if (r.data.drivers_clinical) r.data.drivers_clinical[0].text = 'edited'
    expect(snap.actions).not.toContain('call_998')
    expect(snap.symptoms).toEqual(['dizziness'])
    expect(snap.location?.label).toBe('Bay 4, scaffold C')
    expect(snap.drivers[3].text).toBe('Estimated strain indicator high')
  })

  it('explains every cell in plain language for the governance centre', () => {
    for (const role of ROLES) {
      for (const purpose of PURPOSES) {
        const e = explain({ role, purpose })
        expect(e.lines.length).toBeGreaterThanOrEqual(2)
        expect(e.lines.at(-1)).toMatch(/^Basis: /)
        expect(e.prohibited).toBe(isProhibitedPurpose(purpose))
        if (e.prohibited) {
          expect(e.grants).toEqual([])
          expect(e.lines.join(' ')).toMatch(/prohibited purpose/)
        }
      }
    }
    const sup = explain({ role: 'supervisor', purpose: 'safety_alerting' })
    expect(sup.neverReleased).toEqual(expect.arrayContaining(NEVER_TO_SUPERVISOR))
    expect(sup.grants[0].conditions).toEqual(["the worker is in the requester's crew"])
    const oh = explain({ role: 'occ_health', purpose: 'clinical_care', fields: ['hrBpm'] })
    expect(oh.consentGated).toEqual([{ field: 'hrBpm', scope: 'wearable' }])
    expect(oh.grants).toHaveLength(1)
    expect(oh.grants[0].conditions).toHaveLength(2)
    const reg = explain({ role: 'regulator', purpose: 'compliance_reporting' })
    expect(reg).toMatchObject({ aggregateMinCell: 10, grants: [] })
  })
})

// ─────────────────────────────── Consent ───────────────────────────────

describe('consent', () => {
  it('grants and revokes immutably, stamping the change time', () => {
    const c0 = consentOf({ wearable: false })
    const c1 = grantConsent(c0, 'wearable', T0 + 5)
    expect(c0.wearable).toBe(false)
    expect(c1).toEqual({ ...c0, wearable: true, updatedAt: T0 + 5 })
    const c2 = revokeConsent(c1, 'wearable', T0 + 9)
    expect(c1.wearable).toBe(true)
    expect(c2).toEqual({ ...c1, wearable: false, updatedAt: T0 + 9 })
  })

  it('makes a revocation effective on the very next projection', () => {
    const snap = snapshotOf()
    const oh = { role: 'occ_health', actorId: 'OH-01', purpose: 'clinical_care' } as const
    expect(project(snap, oh, { now: T0, escalated: true }).fields).toContain('hrBpm')
    const revoked = { ...snap, consent: revokeConsent(snap.consent, 'shareWithMedicOnEscalation', T0 + 1) }
    expect(snap.consent.shareWithMedicOnEscalation).toBe(true)
    expect(project(revoked, oh, { now: T0 + 1, escalated: true }).fields).toEqual(OH_CASE_VIEW)

    // Withdrawing wearable consent stops physiology for everyone, including the worker's own view.
    const self = { role: 'worker', actorId: WORKER, purpose: 'safety_alerting' } as const
    const noWearable = { ...snap, consent: revokeConsent(snap.consent, 'wearable', T0 + 2) }
    const own = project(noWearable, self, { now: T0 + 2, escalated: false })
    expect(own.fields).not.toContain('hrBpm')
    expect(own.fields).not.toContain('ctEstC')
    expect(own.fields).not.toContain('psi')
    expect(own.data.drivers_clinical?.map((d) => d.channel)).toEqual(['symptoms', 'hydration'])
    expect(project(noWearable, oh, { now: T0 + 2, escalated: true }).fields).not.toContain('hrBpm')
    const regranted = { ...noWearable, consent: grantConsent(noWearable.consent, 'wearable', T0 + 3) }
    expect(project(regranted, self, { now: T0 + 3, escalated: false }).data.hrBpm).toBe(168)
  })

  it('keeps core safety alerting on without consent and lets each scope switch on exactly its activity', () => {
    const none = activeProcessing(NO_CONSENT)
    expect(none.filter((a) => a.active).map((a) => a.id)).toEqual(['core_safety_alerting'])
    expect(none[0].fields).not.toContain('hrBpm')
    for (const scope of CONSENT_SCOPES) {
      const one = activeProcessing(grantConsent(NO_CONSENT, scope, T0))
      expect(one.filter((a) => a.active).map((a) => a.scope)).toEqual([null, scope])
    }
  })

  it('issues receipts that prove what was agreed, when, in which language and under which notice version', () => {
    const input: ConsentReceiptInput = {
      subjectId: WORKER,
      scope: 'wearable',
      action: 'granted',
      t: T0,
      language: 'ml',
      method: 'electronic_affirmative_action',
      collectedBy: 'self',
    }
    const receipt = createConsentReceipt(input)
    expect(receipt).toMatchObject({
      subjectId: WORKER,
      scope: 'wearable',
      action: 'granted',
      t: T0,
      noticeVersion: CONSENT_NOTICE_VERSION,
      statement: CONSENT_NOTICES.wearable.statement,
      language: 'ml',
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(() => createConsentReceipt({ ...input, collectedBy: 'supervisor' as unknown as ConsentCollector })).toThrow(
      /hierarchical superior/,
    )
    expect(() => createConsentReceipt({ ...input, method: 'witnessed_mark' })).toThrow(/witness/)
    const witnessed = createConsentReceipt({ ...input, method: 'witnessed_mark', witnessId: 'RS-02', collectedBy: 'research_staff' })
    expect(witnessed.witnessId).toBe('RS-02')
  })

  it('words every consent notice within the claims discipline', () => {
    for (const scope of CONSENT_SCOPES) {
      const n = CONSENT_NOTICES[scope]
      expect(n.scope).toBe(scope)
      expect(n.version).toBe(CONSENT_NOTICE_VERSION)
      const text = `${n.title} ${n.statement} ${n.dataProcessed} ${n.whoSees} ${n.retention}`
      expect(text).not.toMatch(/predict|heat ?stroke|measures? (your |my )?core temperature|diagnoses/i)
      expect(n.withdrawal).toMatch(/at any time/)
    }
  })

  it('builds the on-device snapshot without data whose consent is off', () => {
    const profile = profileOf({ consent: consentOf({ wearable: false, healthFlags: false, checkins: false }) })
    const readings = { hrBpm: 150, ctEstC: 38.2, psi: 5, urineColor: 5 as const, symptoms: ['headache'] as SymptomId[], ackStatus: 'active' as const }
    expect(createWorkerSnapshot(profile, assessmentOf(), readings)).toMatchObject({
      hrBpm: null,
      ctEstC: null,
      psi: null,
      riskFlags: [],
      urineColor: null,
      symptoms: ['headache'],
      ackStatus: 'active',
      ageYears: 41,
    })
    const full = createWorkerSnapshot(profileOf(), assessmentOf(), readings)
    expect(full).toMatchObject({ hrBpm: 150, riskFlags: ['heat_sensitive_medication'], urineColor: 5 })
    expect(() => createWorkerSnapshot(profileOf(), assessmentOf({ workerId: 'W-OTHER' }))).toThrow()
  })
})

// ─────────────────────────────── Aggregates ───────────────────────────────

interface Rec {
  row: string
  col: string
  who: string
}
const BY_ROW_COL = { row: (r: Rec) => r.row, col: (r: Rec) => r.col, subject: (r: Rec) => r.who }
const show = (c: PublishedCell): number | 'x' => (c.suppressed ? 'x' : c.count)

/** True extended table (inner cells + totals) and its distinct-individual counts, built independently. */
function truth(records: readonly Rec[], rows: readonly string[], cols: readonly string[]) {
  const R = rows.length
  const C = cols.length
  const value = Array.from({ length: R + 1 }, () => new Array<number>(C + 1).fill(0))
  const people = Array.from({ length: R + 1 }, () => Array.from({ length: C + 1 }, () => new Set<string>()))
  for (const rec of records) {
    const i = rows.indexOf(rec.row)
    const j = cols.indexOf(rec.col)
    for (const [a, b] of [[i, j], [i, C], [R, j], [R, C]]) {
      value[a][b] += 1
      people[a][b].add(rec.who)
    }
  }
  return { value, individuals: people.map((row) => row.map((s) => s.size)) }
}

const extended = (t: AggregateTable): PublishedCell[][] => [
  ...t.cells.map((row, i) => [...row, t.rowTotals[i]]),
  [...t.colTotals, t.total],
]

/**
 * Subtraction attack: hidden cells as unknowns, every published row/column equation as a constraint. A hidden cell is
 * exactly recoverable by some combination of additions and subtractions iff it is a pivot whose RREF row is a unit
 * vector.
 */
function recoverableBySubtraction(mask: boolean[][]): Array<[number, number]> {
  const R = mask.length - 1
  const C = mask[0].length - 1
  const unknowns: Array<[number, number]> = []
  mask.forEach((row, a) => row.forEach((hidden, b) => hidden && unknowns.push([a, b])))
  const index = new Map(unknowns.map(([a, b], u) => [`${a},${b}`, u]))
  const eqs: number[][] = []
  const add = (eq: number[], a: number, b: number, sign: number) => {
    const u = index.get(`${a},${b}`)
    if (u !== undefined) eq[u] += sign
  }
  for (let a = 0; a <= R; a++) {
    const eq = new Array<number>(unknowns.length).fill(0)
    for (let b = 0; b < C; b++) add(eq, a, b, 1)
    add(eq, a, C, -1)
    eqs.push(eq)
  }
  for (let b = 0; b <= C; b++) {
    const eq = new Array<number>(unknowns.length).fill(0)
    for (let a = 0; a < R; a++) add(eq, a, b, 1)
    add(eq, R, b, -1)
    eqs.push(eq)
  }
  const m = eqs.map((row) => row.slice())
  const pivots: Array<[number, number]> = []
  let r = 0
  for (let c = 0; c < unknowns.length && r < m.length; c++) {
    let p = r
    for (let i = r + 1; i < m.length; i++) if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i
    if (Math.abs(m[p][c]) < 1e-9) continue
    ;[m[r], m[p]] = [m[p], m[r]]
    const pv = m[r][c]
    for (let j = 0; j < unknowns.length; j++) m[r][j] /= pv
    for (let i = 0; i < m.length; i++) {
      if (i === r || Math.abs(m[i][c]) < 1e-12) continue
      const f = m[i][c]
      for (let j = 0; j < unknowns.length; j++) m[i][j] -= f * m[r][j]
    }
    pivots.push([r, c])
    r++
  }
  return pivots
    .filter(([row, col]) => m[row].every((x, j) => j === col || Math.abs(x) < 1e-9))
    .map(([, col]) => unknowns[col])
}

/**
 * Non-negativity attack: finds a cycle of hidden cells through (a0, b0) (own BFS) and returns the two tables obtained by
 * shifting ±1 around it. If both are consistent with everything published, the hidden value is not determined.
 */
function shiftedTables(value: number[][], mask: boolean[][], a0: number, b0: number): number[][][] {
  const R = value.length - 1
  const C = value[0].length - 1
  const colNode = (b: number) => R + 1 + b
  const prev = new Map<number, { from: number; cell: [number, number] }>()
  const seen = new Set<number>([a0])
  const queue = [a0]
  while (queue.length > 0) {
    const u = queue.shift() as number
    const edges: Array<[number, number, number]> = []
    if (u <= R) for (let b = 0; b <= C; b++) edges.push([u, b, colNode(b)])
    else for (let a = 0; a <= R; a++) edges.push([a, u - R - 1, a])
    for (const [a, b, v] of edges) {
      if (!mask[a][b] || (a === a0 && b === b0) || seen.has(v)) continue
      seen.add(v)
      prev.set(v, { from: u, cell: [a, b] })
      queue.push(v)
    }
  }
  if (!seen.has(colNode(b0))) return []
  const cycle: Array<[number, number]> = [[a0, b0]]
  for (let v = colNode(b0); v !== a0; ) {
    const step = prev.get(v) as { from: number; cell: [number, number] }
    cycle.push(step.cell)
    v = step.from
  }
  return [1, -1].map((delta) => {
    const y = value.map((row) => row.slice())
    cycle.forEach(([a, b], n) => {
      const alternate = n % 2 === 0 ? 1 : -1
      const marginFlip = (a === R) !== (b === C) ? -1 : 1
      y[a][b] += delta * alternate * marginFlip
    })
    return y
  })
}

function consistentWithPublication(y: number[][], value: number[][], mask: boolean[][]): boolean {
  const R = value.length - 1
  const C = value[0].length - 1
  for (let a = 0; a <= R; a++) {
    for (let b = 0; b <= C; b++) {
      if (y[a][b] < 0) return false
      if (!mask[a][b] && y[a][b] !== value[a][b]) return false
    }
  }
  for (let a = 0; a <= R; a++) {
    let sum = 0
    for (let b = 0; b < C; b++) sum += y[a][b]
    if (sum !== y[a][C]) return false
  }
  for (let b = 0; b <= C; b++) {
    let sum = 0
    for (let a = 0; a < R; a++) sum += y[a][b]
    if (sum !== y[R][b]) return false
  }
  return true
}

function recordsFrom(counts: Record<string, Record<string, number>>): Rec[] {
  const out: Rec[] = []
  for (const [row, cols] of Object.entries(counts)) {
    for (const [col, n] of Object.entries(cols)) for (let i = 0; i < n; i++) out.push({ row, col, who: `${row}-${col}-${i}` })
  }
  return out
}

describe('aggregate — k-suppression with complementary suppression', () => {
  it('worked example: hides the small cells, their complements and the small column total', () => {
    const records = recordsFrom({
      A: { safe: 12, caution: 6, high: 2, stop: 0 },
      B: { safe: 9, caution: 7, high: 6, stop: 1 },
      C: { safe: 15, caution: 5, high: 5, stop: 0 },
    })
    const rows = ['A', 'B', 'C']
    const cols = ['safe', 'caution', 'high', 'stop']
    const table = aggregate(records, { ...BY_ROW_COL, rows, cols }, 5)
    // Primary: A/high = 2, B/stop = 1 and the stop column total = 1. Complements close every hidden cell into a cycle.
    expect(table.cells.map((r) => r.map(show))).toEqual([
      [12, 'x', 'x', 0],
      [9, 7, 'x', 'x'],
      [15, 'x', 'x', 0],
    ])
    expect(table.rowTotals.map(show)).toEqual([20, 23, 25])
    expect(table.colTotals.map(show)).toEqual([36, 18, 'x', 'x'])
    expect(show(table.total)).toBe(68)
    expect(table.suppressedCells).toBe(8)
    const mask = extended(table).map((row) => row.map((c) => c.suppressed))
    expect(recoverableBySubtraction(mask)).toEqual([])
    for (const cell of table.cells.flat()) if (cell.suppressed) expect('count' in cell).toBe(false)
  })

  it('suppresses every small cell and leaves no hidden cell recoverable (property test, 400 random tables)', () => {
    const rng = createRng('privacy-aggregate-property')
    let hiddenChecked = 0
    for (let n = 0; n < 400; n++) {
      const R = rng.int(1, 6)
      const C = rng.int(2, 5)
      const rows = Array.from({ length: R }, (_, i) => `crew-${i}`)
      const cols = Array.from({ length: C }, (_, j) => `level-${j}`)
      const rowWeights = rows.map(() => rng.lognormal(1, 1.2))
      const colWeights = cols.map(() => rng.lognormal(1, 1.2))
      const k = rng.pick([2, 3, 5, 10])
      const distinctPeople = rng.chance(0.6)
      const pool = rng.int(1, 40)
      const records: Rec[] = Array.from({ length: rng.int(0, 160) }, (_, m) => ({
        row: rng.weighted(rows, rowWeights),
        col: rng.weighted(cols, colWeights),
        who: distinctPeople ? `p${m}` : `p${rng.int(1, pool)}`,
      }))
      const table = aggregate(records, { ...BY_ROW_COL, rows, cols }, k)
      const { value, individuals } = truth(records, rows, cols)
      const published = extended(table)
      const mask = published.map((row) => row.map((c) => c.suppressed))
      for (let a = 0; a <= R; a++) {
        for (let b = 0; b <= C; b++) {
          const cell = published[a][b]
          const label = `table ${n} cell ${a},${b} k=${k}`
          // Primary suppression: 1..k-1 individuals → hidden (totals included).
          if (individuals[a][b] > 0 && individuals[a][b] < k) expect(cell.suppressed, label).toBe(true)
          if (cell.suppressed) {
            expect('count' in cell, label).toBe(false)
            expect(value[a][b], label).toBeGreaterThan(0) // zero cells are never hidden or used as complements
            // Non-negativity attack: ±1 around a cycle of hidden cells stays consistent with the publication.
            const alternatives = shiftedTables(value, mask, a, b)
            expect(alternatives, label).toHaveLength(2)
            for (const y of alternatives) {
              expect(consistentWithPublication(y, value, mask), label).toBe(true)
              expect(y[a][b], label).not.toBe(value[a][b])
            }
            hiddenChecked++
          } else {
            expect(cell.count, label).toBe(value[a][b])
          }
        }
      }
      // Subtraction attack: no hidden cell is determined by any combination of published rows and columns.
      expect(recoverableBySubtraction(mask), `table ${n}`).toEqual([])
    }
    expect(hiddenChecked).toBeGreaterThan(1000)
  })

  it('counts distinct individuals, not records, when deciding what is small', () => {
    const records: Rec[] = [
      ...Array.from({ length: 6 }, () => ({ row: 'crew-a', col: 'stop', who: 'W-1' })),
      ...Array.from({ length: 12 }, (_, i) => ({ row: 'crew-a', col: 'safe', who: `W-a${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ row: 'crew-b', col: 'safe', who: `W-b${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ row: 'crew-b', col: 'stop', who: `W-c${i}` })),
    ]
    const spec = { row: (r: Rec) => r.row, col: (r: Rec) => r.col, rows: ['crew-a', 'crew-b'], cols: ['safe', 'stop'] }
    expect(aggregate(records, { ...spec, subject: (r: Rec) => r.who }, 5).cells[0][1]).toEqual({ suppressed: true })
    expect(aggregate(records, spec, 5).cells[0][1]).toEqual({ suppressed: false, count: 6 }) // six shifts, one worker
  })

  it('handles empty input, fixed category order and rejects an invalid k', () => {
    const empty = aggregate<Rec>([], { ...BY_ROW_COL, rows: ['crew-a'], cols: RISK_LEVELS })
    expect(empty.k).toBe(DEFAULT_MIN_CELL_SIZE)
    expect(empty.cols).toEqual([...RISK_LEVELS])
    expect(empty.cells[0].map(show)).toEqual([0, 0, 0, 0, 0])
    expect(empty.total).toEqual({ suppressed: false, count: 0 })
    expect(() => aggregate<Rec>([], BY_ROW_COL, 0)).toThrow(RangeError)
    expect(() => aggregate<Rec>([], BY_ROW_COL, 2.5)).toThrow(RangeError)
  })
})

interface ShiftRecord {
  workerId: string
  crewId: string
  level: RiskLevel
  consent: ConsentState
}
const SHIFTS: ShiftRecord[] = Array.from({ length: 60 }, (_, i) => ({
  workerId: `W-${i}`,
  crewId: `crew-${i % 3}`,
  level: (['safe', 'safe', 'caution', 'high', 'stop'] as const)[i % 5],
  consent: consentOf({ aggregateStatistics: i % 4 !== 0 }),
}))
const BY_CREW_LEVEL = {
  row: (s: ShiftRecord) => s.crewId,
  col: (s: ShiftRecord) => s.level,
  cols: RISK_LEVELS,
  subject: (s: ShiftRecord) => s.workerId,
}

describe('aggregateFor — role-checked aggregates', () => {
  it('applies the role minimum k and never lowers it', () => {
    const reg = aggregateFor({ role: 'regulator', actorId: 'ADPHC-1', purpose: 'compliance_reporting', k: 3 }, SHIFTS, BY_CREW_LEVEL, { now: T0 })
    expect(reg).toMatchObject({ decision: 'allowed', k: REGULATOR_MIN_CELL_SIZE })
    expect(reg.table?.k).toBe(10)
    const hse = { role: 'hse_manager', actorId: 'HSE-1', purpose: 'compliance_reporting' } as const
    expect(aggregateFor(hse, SHIFTS, BY_CREW_LEVEL, { now: T0 }).k).toBe(DEFAULT_MIN_CELL_SIZE)
    expect(aggregateFor({ ...hse, k: 8 }, SHIFTS, BY_CREW_LEVEL, { now: T0 }).k).toBe(8)
    const hr = aggregateFor({ role: 'employer_hr', actorId: 'HR-1', purpose: 'compliance_reporting' }, SHIFTS, BY_CREW_LEVEL, { now: T0 })
    expect(hr.k).toBe(EMPLOYER_MIN_CELL_SIZE)
  })

  it('refuses aggregates to every role/purpose without them and to every prohibited purpose', () => {
    for (const role of ROLES) {
      for (const purpose of PURPOSES) {
        const r = aggregateFor({ role, actorId: 'x', purpose }, SHIFTS, BY_CREW_LEVEL, { now: T0, consentOf: (s) => s.consent })
        const allowed =
          (role === 'hse_manager' && ['safety_alerting', 'operational_planning', 'compliance_reporting'].includes(purpose)) ||
          (role === 'regulator' && ['compliance_reporting', 'public_health_statistics'].includes(purpose)) ||
          (role === 'employer_hr' && purpose === 'compliance_reporting')
        expect(r.decision, `${role}/${purpose}`).toBe(allowed ? 'allowed' : 'denied')
        if (!allowed) expect(r.table).toBeNull()
        if (isProhibitedPurpose(purpose)) expect(r.reason).toMatch(/prohibited purpose/)
      }
    }
  })

  it('counts only consenting workers in public-health statistics, and refuses when consent cannot be checked', () => {
    const req = { role: 'regulator', actorId: 'ADPHC-1', purpose: 'public_health_statistics' } as const
    const r = aggregateFor(req, SHIFTS, BY_CREW_LEVEL, { now: T0, consentOf: (s) => s.consent })
    expect(r.excludedForConsent).toBe(15)
    expect(r.table?.total).toEqual({ suppressed: false, count: 45 })
    expect(aggregateFor(req, SHIFTS, BY_CREW_LEVEL, { now: T0 }).decision).toBe('denied')
  })

  it('logs aggregate access without a subject', async () => {
    const log = new AuditLog()
    const req = { role: 'hse_manager', actorId: 'HSE-1', purpose: 'compliance_reporting', dimensions: ['crewId', 'level'] } as const
    const r = await aggregateAndLog(log, req, SHIFTS, BY_CREW_LEVEL, { now: T0 })
    expect(r.entry).toMatchObject({ seq: 0, actorRole: 'hse_manager', decision: 'allowed', fields: ['crewId', 'level'] })
    expect(r.entry.subjectId).toBeUndefined()
  })
})

// ─────────────────────────────── Audit log ───────────────────────────────

function draftAt(i: number): AuditDraft {
  const draft: AuditDraft = {
    t: T0 + i * 1000,
    actorRole: ROLES[i % ROLES.length],
    actorId: `actor-${i}`,
    purpose: PURPOSES[(i * 5) % PURPOSES.length],
    fields: i % 2 === 0 ? ['level', 'actions'] : [],
    decision: i % 3 === 0 ? 'denied' : 'allowed',
    reason: `reason ${i}`,
  }
  if (i % 4 !== 3) draft.subjectId = `W-${i % 2}`
  return draft
}

async function buildLog(n: number): Promise<AuditLog> {
  const log = new AuditLog()
  for (let i = 0; i < n; i++) await log.append(draftAt(i))
  return log
}

const ENTRY_KEY_SET = {
  seq: true,
  t: true,
  actorRole: true,
  actorId: true,
  purpose: true,
  subjectId: true,
  fields: true,
  decision: true,
  reason: true,
  prevHash: true,
  hash: true,
} satisfies Record<keyof AuditEntry, true>
const ENTRY_KEYS = Object.keys(ENTRY_KEY_SET) as (keyof AuditEntry)[]
const flipFirstHex = (h: string) => (h[0] === '0' ? '1' : '0') + h.slice(1)

function tamperPatch(e: AuditEntry, key: keyof AuditEntry): Partial<AuditEntry> {
  switch (key) {
    case 'seq':
      return { seq: e.seq + 7 }
    case 't':
      return { t: e.t + 1 }
    case 'actorRole':
      return { actorRole: e.actorRole === 'employer_hr' ? 'worker' : 'employer_hr' }
    case 'actorId':
      return { actorId: `${e.actorId}-forged` }
    case 'purpose':
      return { purpose: e.purpose === 'clinical_care' ? 'safety_alerting' : 'clinical_care' }
    case 'subjectId':
      return { subjectId: e.subjectId === undefined ? 'W-FORGED' : undefined }
    case 'fields':
      return { fields: e.fields.includes('hrBpm') ? e.fields.filter((f) => f !== 'hrBpm') : [...e.fields, 'hrBpm'] }
    case 'decision':
      return { decision: e.decision === 'allowed' ? 'denied' : 'allowed' }
    case 'reason':
      return { reason: `${e.reason} (edited)` }
    case 'prevHash':
      return { prevHash: flipFirstHex(e.prevHash) }
    case 'hash':
      return { hash: flipFirstHex(e.hash) }
  }
}

describe('AuditLog — SHA-256 hash chain', () => {
  it('hashes canonical JSON with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    )
    expect(canonicalJson({ y: 2, x: 1 })).toBe(canonicalJson({ x: 1, y: 2 }))
    expect(() => canonicalJson({ t: Number.NaN })).toThrow(TypeError)
  })

  it('chains entries from the genesis hash and verifies', async () => {
    const log = await buildLog(5)
    const entries = log.all()
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(entries[0].prevHash).toBe(GENESIS_HASH)
    for (let i = 1; i < entries.length; i++) expect(entries[i].prevHash).toBe(entries[i - 1].hash)
    expect(entries[3].subjectId).toBeUndefined()
    expect(await log.verify()).toEqual({ ok: true, length: 5, head: entries[4].hash })
    expect(log.head()).toEqual({ seq: 4, hash: entries[4].hash })
    expect(new AuditLog().head()).toEqual({ seq: -1, hash: GENESIS_HASH })
  })

  it('chains concurrent appends in order', async () => {
    const log = new AuditLog()
    const appended = await Promise.all(Array.from({ length: 25 }, (_, i) => log.append(draftAt(i))))
    expect(appended.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    for (let i = 1; i < appended.length; i++) expect(appended[i].prevHash).toBe(appended[i - 1].hash)
    expect(await log.verify()).toMatchObject({ ok: true, length: 25 })
  })

  it('detects tampering of any single field of any entry', async () => {
    const log = await buildLog(6)
    const entries = log.all()
    let forgeries = 0
    for (let i = 0; i < entries.length; i++) {
      for (const key of ENTRY_KEYS) {
        const verdict = await log.demoTamper(i, tamperPatch(entries[i], key)).verify()
        expect(verdict.ok, `${key} of entry ${i}`).toBe(false)
        if (!verdict.ok) expect(verdict.brokenAt, `${key} of entry ${i}`).toBe(i)
        forgeries++
      }
    }
    expect(forgeries).toBe(6 * 11)
    expect((await log.verify()).ok).toBe(true) // demoTamper never touches the original
  })

  it('detects edited, deleted and reordered entries in an exported log', async () => {
    const log = await buildLog(6)
    expect(await AuditLog.import(log.export()).verify()).toEqual({ ok: true, length: 6, head: log.head().hash })
    const exported = JSON.parse(log.export()) as { entries: AuditEntry[] }

    const edited = structuredClone(exported)
    edited.entries[2].fields = ['hrBpm', 'symptoms']
    expect(await AuditLog.import(JSON.stringify(edited)).verify()).toMatchObject({ ok: false, brokenAt: 2 })

    const deleted = structuredClone(exported)
    deleted.entries.splice(3, 1)
    expect(await AuditLog.import(JSON.stringify(deleted)).verify()).toMatchObject({ ok: false, brokenAt: 3 })

    const swapped = structuredClone(exported)
    ;[swapped.entries[1], swapped.entries[4]] = [swapped.entries[4], swapped.entries[1]]
    expect(await AuditLog.import(JSON.stringify(swapped)).verify()).toMatchObject({ ok: false, brokenAt: 1 })

    const extraKey = structuredClone(exported) as { entries: Array<AuditEntry & { note?: string }> }
    extraKey.entries[5].note = 'injected'
    expect(await AuditLog.import(JSON.stringify(extraKey)).verify()).toMatchObject({ ok: false, brokenAt: 5 })
  })

  it('needs an anchored head to expose a cut tail or a rewritten history', async () => {
    const log = await buildLog(5)
    const anchor = log.head()
    const exported = JSON.parse(log.export()) as { entries: AuditEntry[] }
    exported.entries.pop()
    const truncated = AuditLog.import(JSON.stringify(exported))
    expect((await truncated.verify()).ok).toBe(true) // a chain alone cannot see a cut tail…
    expect(await truncated.verify(anchor)).toMatchObject({ ok: false, brokenAt: 4 }) // …an anchor can
    const rewritten = new AuditLog()
    for (let i = 0; i < 5; i++) await rewritten.append(i === 1 ? { ...draftAt(i), decision: 'allowed', reason: 'rewritten' } : draftAt(i))
    expect((await rewritten.verify()).ok).toBe(true)
    expect(await rewritten.verify(anchor)).toMatchObject({ ok: false, brokenAt: 4 })
  })

  it("answers the worker's 'who saw my data', refusals included", async () => {
    const log = new AuditLog()
    const snap = snapshotOf()
    const ctx = { now: T0, escalated: false }
    await projectAndLog(log, snap, { role: 'supervisor', actorId: 'S-01', purpose: 'safety_alerting' }, ctx)
    await projectAndLog(log, snap, { role: 'employer_hr', actorId: 'HR-01', purpose: 'performance_management' }, ctx)
    await projectAndLog(log, snapshotOf({ workerId: 'W-OTHER' }), { role: 'supervisor', actorId: 'S-01', purpose: 'safety_alerting' }, ctx)
    const mine = log.forSubject(WORKER)
    expect(mine.map((e) => [e.actorId, e.decision])).toEqual([
      ['S-01', 'allowed'],
      ['HR-01', 'denied'],
    ])
    expect(mine[0].fields).toEqual(SUPERVISOR_VIEW_CANONICAL)
    expect(mine[1].reason).toMatch(/prohibited purpose/)
    expect((await log.verify()).ok).toBe(true)
  })

  it('stores frozen copies and rejects malformed imports', async () => {
    const log = new AuditLog()
    const draft = draftAt(0)
    const entry = await log.append(draft)
    draft.fields.push('hrBpm')
    expect(entry.fields).toEqual(['level', 'actions'])
    expect(Object.isFrozen(entry)).toBe(true)
    expect(() => {
      ;(entry.fields as DataField[]).push('hrBpm')
    }).toThrow(TypeError)
    expect(() => AuditLog.import('{"entries":[{"seq":"0"}]}')).toThrow(TypeError)
    expect(() => AuditLog.import('42')).toThrow(TypeError)
    expect(() => log.demoTamper(3, { reason: 'x' })).toThrow(RangeError)
  })
})

// ─────────────────────────────── Retention ───────────────────────────────

describe('retention', () => {
  it('purges raw physiology at 24 h and level history at 30 days, purging the exact boundary', () => {
    expect(RAW_PHYSIOLOGY_RETENTION_MS).toBe(24 * 3_600_000)
    expect(LEVEL_HISTORY_RETENTION_MS).toBe(30 * 86_400_000)
    const samples = [T0 - RAW_PHYSIOLOGY_RETENTION_MS - 1, T0 - RAW_PHYSIOLOGY_RETENTION_MS, T0 - RAW_PHYSIOLOGY_RETENTION_MS + 1, T0].map(
      (t) => ({ t, hrBpm: 120 }),
    )
    expect(purgeRawPhysiology(samples, T0).map((s) => s.t)).toEqual([T0 - RAW_PHYSIOLOGY_RETENTION_MS + 1, T0])
    expect(samples).toHaveLength(4) // pure
    const history = [T0 - LEVEL_HISTORY_RETENTION_MS, T0 - LEVEL_HISTORY_RETENTION_MS + 1, T0 - RAW_PHYSIOLOGY_RETENTION_MS].map(
      (t) => ({ t, level: 'high' as RiskLevel }),
    )
    expect(purgeLevelHistory(history, T0).map((h) => h.t)).toEqual([T0 - LEVEL_HISTORY_RETENTION_MS + 1, T0 - RAW_PHYSIOLOGY_RETENTION_MS])
    const result = applyRetention({ rawPhysiology: samples, levelHistory: history }, T0)
    expect(result.purged).toEqual({ rawPhysiology: 2, levelHistory: 1 })
    expect(result.rawPhysiology).toHaveLength(2)
    expect(result.levelHistory).toHaveLength(2)
  })

  it('purges check-ins and logged drinks at 30 days (boundary purged), keeping subjects whose escalated case OH holds open', () => {
    expect(CHECKIN_RETENTION_MS).toBe(30 * 86_400_000)
    expect(CHECKIN_RETENTION_MS).toBe(LEVEL_HISTORY_RETENTION_MS)
    const ages = [CHECKIN_RETENTION_MS + 1, CHECKIN_RETENTION_MS, CHECKIN_RETENTION_MS - 1, 0]
    const checkins = ['W-A', 'W-B'].flatMap((workerId) =>
      ages.map((age) => ({ t: T0 - age, workerId, by: 'self' as const, symptoms: ['headache'] as SymptomId[], urineColor: 5 as const })),
    )
    const none = purgeCheckins(checkins, T0, { escalatedSubjects: [] })
    expect(none.map((c) => [c.workerId, T0 - c.t])).toEqual([
      ['W-A', CHECKIN_RETENTION_MS - 1],
      ['W-A', 0],
      ['W-B', CHECKIN_RETENTION_MS - 1],
      ['W-B', 0],
    ])
    const held = purgeCheckins(checkins, T0, { escalatedSubjects: new Set(['W-B']) })
    expect(held.filter((c) => c.workerId === 'W-B')).toHaveLength(4) // held by OH: nothing purged
    expect(held.filter((c) => c.workerId === 'W-A')).toHaveLength(2) // another worker's hold changes nothing for W-A
    expect(checkins).toHaveLength(8) // pure
    // once OH closes the case (the id is removed), the 30-day rule applies again
    expect(purgeCheckins(held, T0, { escalatedSubjects: [] })).toEqual(none)
    // logged drinks follow the same rule
    const drinks = [
      { t: T0 - CHECKIN_RETENTION_MS, workerId: 'W-A', ml: 250 },
      { t: T0 - 1, workerId: 'W-A', ml: 250 },
    ]
    expect(purgeCheckins(drinks, T0, { escalatedSubjects: ['W-A'] })).toHaveLength(2)
    expect(purgeCheckins(drinks, T0, { escalatedSubjects: [] })).toEqual([drinks[1]])
    // the check-in notice states the same periods
    expect(CONSENT_NOTICES.checkins.retention).toContain(`after ${CHECKIN_RETENTION_MS / 86_400_000} days`)
    expect(CONSENT_NOTICES.checkins.retention).toContain(`for ${LEVEL_HISTORY_RETENTION_MS / 86_400_000} days`)
  })

  it('records audit-log and consent-receipt retention as policy set by legal review (null), not as a guessed number', () => {
    for (const policy of [AUDIT_LOG_RETENTION, CONSENT_RECEIPT_RETENTION]) {
      expect(policy.ms).toBeNull()
      expect(policy.decidedBy).toMatch(/^Set by legal review/)
      expect(policy.decidedBy).toContain('GOVERNANCE §13 item 5')
      expect(policy.basis).toContain('GOVERNANCE §13 item 5')
      expect(Object.isFrozen(policy)).toBe(true)
    }
    expect(AUDIT_LOG_RETENTION.mustCover).toMatch(/longer than the data it describes/i)
    expect(CONSENT_RECEIPT_RETENTION.mustCover).toMatch(/processing it proves, plus a dispute period/)
  })
})

// ─────────────────────────────── General privacy notice ───────────────────────────────

describe('general privacy notice (GOVERNANCE §4.2 and §13 item 14)', () => {
  it('tells every worker that legal-duty aggregates count them whatever their consent, never with individual data', () => {
    const n = GENERAL_PRIVACY_NOTICE
    expect(n.version).toBe(GENERAL_PRIVACY_NOTICE_VERSION)
    expect(Object.isFrozen(n)).toBe(true)
    expect(n.statement).toMatch(/^Your employer has a legal duty/)
    expect(n.statement).toContain(`even if you did not choose “${CONSENT_NOTICES.aggregateStatistics.title}”`)
    expect(n.statement).toContain(`(HSE) manager sees only groups of ${DEFAULT_MIN_CELL_SIZE} or more workers`)
    expect(n.statement).toContain(`HR see only groups of ${REGULATOR_MIN_CELL_SIZE} or more workers`)
    expect(n.statement).toContain('never show your name or any record about you alone')
    expect(n.statement).toMatch(/only decides whether you are also counted in public-health statistics\.$/)
    // the wording gives the regulator and HR one k: the code must agree
    expect(EMPLOYER_MIN_CELL_SIZE).toBe(REGULATOR_MIN_CELL_SIZE)
    expect(`${n.title} ${n.statement}`).not.toMatch(/predict|heat ?stroke|core temperature|diagnos/i)
    expect(n.legalBasis).toMatch(/legal duty/)
  })

  it('matches what aggregateFor() does: HSE (k = 5) and compliance (k = 10) count everyone; only public-health statistics need consent', () => {
    for (const purpose of PURPOSES) {
      const k = ACCESS_MATRIX.hse_manager[purpose].aggregateMinCell
      if (k !== null) expect(k, purpose).toBe(DEFAULT_MIN_CELL_SIZE)
    }
    expect(ACCESS_MATRIX.regulator.compliance_reporting.aggregateMinCell).toBe(REGULATOR_MIN_CELL_SIZE)
    expect(ACCESS_MATRIX.employer_hr.compliance_reporting.aggregateMinCell).toBe(EMPLOYER_MIN_CELL_SIZE)
    expect(Object.keys(AGGREGATE_CONSENT)).toEqual(['public_health_statistics'])
    const records = Array.from({ length: 12 }, (_, i) => ({ id: i, crew: 'crew-a', level: 'safe' }))
    const groupBy = { row: (r: (typeof records)[number]) => r.crew, col: (r: (typeof records)[number]) => r.level }
    const ctx = { now: T0, consentOf: () => NO_CONSENT }
    for (const [role, purpose] of [
      ['hse_manager', 'compliance_reporting'],
      ['regulator', 'compliance_reporting'],
      ['employer_hr', 'compliance_reporting'],
    ] as const) {
      const res = aggregateFor({ role, actorId: 'A-1', purpose }, records, groupBy, ctx)
      expect(res.decision, role).toBe('allowed')
      expect(res.excludedForConsent, role).toBe(0)
    }
    const stats = aggregateFor({ role: 'regulator', actorId: 'A-1', purpose: 'public_health_statistics' }, records, groupBy, ctx)
    expect(stats.excludedForConsent).toBe(12)
  })
})

// ─────────────────────────────── Sync payload ───────────────────────────────

describe('payloadForSync — what leaves the device', () => {
  it('sends exactly { v, pseudonym, crewId, level, actions, workMinPerHour, waterMlPerHour, ack, t, confidence }', () => {
    const payload = payloadForSync(assessmentOf(), profileOf(), 'acknowledged')
    expect(Object.keys(payload)).toEqual([...SYNC_PAYLOAD_KEYS])
    expect(payload).toEqual({
      v: 1,
      pseudonym: WORKER,
      crewId: 'crew-a',
      level: 'stop',
      actions: ['rest_shade_now', 'cool_down', 'restrict_fluids'],
      workMinPerHour: 14,
      // Wave 2d: the individual water figure (1006 mL/h) stays on the device (GOVERNANCE §13 item 18).
      waterMlPerHour: 0,
      ack: 'acknowledged',
      t: T0,
      confidence: 'medium',
    })
  })

  it('carries no clinical key, no name and no health value, and reports its byte size', () => {
    const inspection = inspectSyncPayload(assessmentOf(), profileOf())
    const forbidden = [
      ...CLINICAL_FIELDS,
      'drivers',
      'channels',
      'dataQuality',
      'displayName',
      'ageYears',
      'sex',
      'massKg',
      'heightCm',
      'restingHrBpm',
      'riskFlags',
      'consent',
      'minutesToLimit',
    ]
    for (const key of forbidden) expect(Object.keys(inspection.payload)).not.toContain(key)
    expect(inspection.json).not.toMatch(/Ravi|heat_sensitive_medication|occ_health_review|hrBpm|ctEst|"psi|symptom|urine|driver|minutesToLimit/i)
    expect(inspection.bytes).toBe(Buffer.byteLength(inspection.json, 'utf8'))
    expect(inspection.bytes).toBeLessThan(300)
    expect(inspection.keptOnDevice).toEqual(
      expect.arrayContaining(['assessment.drivers', 'assessment.minutesToLimit', 'assessment.waterMlPerHour', 'profile.riskFlags', 'profile.displayName', 'profile.consent']),
    )
    expect(inspection.keptOnDevice).not.toContain('assessment.level')
  })

  it('refuses to attach one worker’s assessment to another worker’s pseudonym', () => {
    expect(() => payloadForSync(assessmentOf({ workerId: 'W-OTHER' }), profileOf())).toThrow()
  })
})

// ─────────────────────────────── Supervisor-facing drivers and actions (wave 2d) ───────────────────────────────

/** Independent oracle: the site allow-list (drivers whose numbers describe the site, not the person). */
const SITE_ALLOW_LIST = [
  // rule pack
  'twl_zone_high', 'twl_zone_medium', 'twl_zone_low', 'twl_zone_unrestricted', 'twl_unavailable', 'ordinary_work_prohibited', 'permit_to_work',
  'unacclimatized_excluded', 'unacclimatized_not_alone', 'acclimatization_programme', 'midday_break', 'midday_break_window', 'wbgt_unavailable',
  'wbgt_stop_limit', 'lone_work_not_allowed',
  // site heat data and weather
  'env_wind_default', 'env_solar_clear_sky', 'env_pressure_default', 'env_radiant_boost_ignored', 'env_radiant_boost_site_default', 'wbgt_measured',
  'wbgt_meter_model_mismatch', 'wbgt_solver_not_converged', 'twl_out_of_valid_range', 'bb2002_backstop', 'env_conservative_default', 'env_data_stale',
  'env_sensor_unavailable', 'env_series_wrong_site', 'env_source_no_coverage', 'env_stale_margin', 'env_source_site_sensor', 'env_source_forecast',
  'env_source_archive', 'env_source_cached_forecast', 'env_source_conservative_default',
  // site rest area and meter
  'rest_area_cooled', 'meter_check_advised',
].sort()
const NON_CLINICAL: ChannelId[] = ['environment', 'regulation', 'projection']
const DIGIT = /\d/
/** A worst-case driver: every number a producer could put in a text (projection minutes, mass-scaled W, a margin). */
const loaded = (id: string, channel: ChannelId, direction: RiskDriver['direction'] = 'raises'): RiskDriver => ({
  id,
  channel,
  text: 'about 14 min to the limit; rest 35 % done; 1.2 L to drink; (412 W); 2.1 °C over the personal limit; 45 min work per hour',
  value: 14.2,
  unit: 'min',
  direction,
  basis: 'ISO 7933:2023 (412 W, 75 kg)',
})

describe('supervisor drivers — no individual numbers (wave 2d)', () => {
  it('every engine driver id has a rule; clinical ids are withheld; every phrase id has a catalog phrase', () => {
    const missing = DRIVER_IDS.filter((id) => !Object.prototype.hasOwnProperty.call(SUPERVISOR_DRIVER_RULES, id) && supervisorDriverRule(id) !== 'withhold')
    expect(missing).toEqual([])
    for (const id of DRIVER_IDS) {
      const rule = supervisorDriverRule(id)
      if (rule === 'phrase') expect(Object.prototype.hasOwnProperty.call(CATALOGS.en.driver, id), id).toBe(true)
      if (/^(symptom_|symptoms_|physio_|hr_|ectemp_|psi_|urine_|fluid_)/.test(id)) expect(rule, id).toBe('withhold')
    }
    // Ids that reveal logged drinking, fasting or extra-care mode are withheld on every channel.
    for (const id of ['phs_water_credit', 'phs_no_drinking', 'phs_no_drink_no_restart', 'water_paused_fasting', 'water_restricted', 'fasting_no_drink_reminders', 'conservative_checkin_due']) {
      for (const ch of NON_CLINICAL) expect(supervisorDriver(loaded(id, ch)), `${id}/${ch}`).toBeNull()
    }
    // Default-deny: an unknown id is withheld; so is an id named like a prototype key.
    for (const id of ['brand_new_driver', 'constructor', '__proto__', 'toString']) expect(supervisorDriver(loaded(id, 'environment'))).toBeNull()
  })

  it('the site allow-list is explicit (changing it is a deliberate, reviewed change)', () => {
    const site = Object.keys(SUPERVISOR_DRIVER_RULES).filter((id) => SUPERVISOR_DRIVER_RULES[id] === 'site').sort()
    expect(site).toEqual(SITE_ALLOW_LIST)
  })

  it('matrix: no digit in any supervisor driver text, no value or unit, a generic basis (site allow-list excepted)', () => {
    const ids = [...new Set([...DRIVER_IDS, ...Object.keys(SUPERVISOR_DRIVER_RULES)])]
    let checked = 0
    for (const id of ids) {
      for (const channel of NON_CLINICAL) {
        for (const direction of ['raises', 'info'] as const) {
          const view = supervisorDriver(loaded(id, channel, direction))
          if (view === null) continue
          checked += 1
          if (SITE_ALLOW_LIST.includes(id)) {
            // Site drivers keep their own text and numbers (they describe the site).
            expect(view).toMatchObject({ id, text: loaded(id, channel).text, value: 14.2, unit: 'min' })
            continue
          }
          expect(view.text, `${id}/${channel}`).not.toMatch(DIGIT)
          expect(view.basis, `${id}/${channel}`).not.toMatch(/412|75 kg/)
          expect(view.value, `${id}/${channel}`).toBeUndefined()
          expect(view.unit, `${id}/${channel}`).toBeUndefined()
          expect(supervisorSafeText(view.text), `${id}/${channel}: ${view.text}`).toBe(true)
        }
      }
    }
    expect(checked).toBeGreaterThan(150)
  })

  it('known answers: the projection countdown, the environment margin with the metabolic rate, a rest estimate', () => {
    const minutes: RiskDriver = { id: 'phs_minutes_to_limit', channel: 'projection', text: 'Heat-strain model: about 14 min to the water-loss limit at the current activity', value: 14, unit: 'min', direction: 'raises', basis: 'ISO 7933:2023' }
    const margin: RiskDriver = { id: 'wbgt_over_limit', channel: 'environment', text: 'Effective WBGT 33.1 °C is 2.0 °C over the personal exposure limit for Rebar (412 W)', value: 33.1, unit: '°C', direction: 'raises', basis: 'NIOSH 2016 REL; NIOSH 2016 RAL' }
    const hold: RiskDriver = { id: 'phs_resume_hold', channel: 'projection', text: 'Rest before going back to this task: about 25 min of rest needed (rest 40 % done)', direction: 'raises', basis: 'ISO 7933:2023' }
    expect(supervisorDriver(minutes)).toEqual({ id: 'phs_minutes_to_limit', channel: 'projection', text: CATALOGS.en.driver.phs_minutes_to_limit, direction: 'raises', basis: expect.stringContaining('ISO 7933') })
    expect(supervisorDriver(margin)).toEqual({ id: 'wbgt_over_limit', channel: 'environment', text: CATALOGS.en.driver.wbgt_over_limit, direction: 'raises', basis: expect.stringContaining('NIOSH 2016') })
    expect(supervisorDriver(hold)).toEqual({ id: 'not_cleared_for_heat_work', ...POOLED_DRIVERS.not_cleared_for_heat_work })
    expect(POOLED_DRIVERS.not_cleared_for_heat_work.text).toBe('Not cleared for heat work now: assign cooler work; the device will say when to return.')
  })

  it('the work/rest cycle reads the same whether the tables enforce it or monitored mode makes it a guide', () => {
    const enforced: RiskDriver = { id: 'work_rest_cycle', channel: 'environment', text: 'Work at most 30 min per hour, rest in shade the remainder', value: 30, unit: 'min/h', direction: 'raises', basis: 'b' }
    const guide: RiskDriver = { ...enforced, text: 'Work/rest guide: about 30 min work per hour, rest in shade the remainder', direction: 'info', basis: 'b; monitoring' }
    expect(supervisorDriver(guide)).toEqual(supervisorDriver(enforced))
    expect(supervisorDriver(guide)?.direction).toBe('raises')
  })
})

describe('supervisor drivers — pooled phrases (wave 2d)', () => {
  const NOT_CLEARED_IDS = Object.keys(SUPERVISOR_DRIVER_RULES).filter((id) => SUPERVISOR_DRIVER_RULES[id] === 'not_cleared_for_heat_work')
  const DEVICE_REST_IDS = Object.keys(SUPERVISOR_DRIVER_RULES).filter((id) => SUPERVISOR_DRIVER_RULES[id] === 'device_directed_rest')

  it('covers every not-cleared and device-directed reason named in the brief', () => {
    expect(NOT_CLEARED_IDS).toEqual(
      expect.arrayContaining([
        'phs_limit_reached',
        'phs_recovery_review_required',
        'phs_resume_hold',
        'task_not_feasible_now',
        'phs_drink_to_restart',
        'acclimatization_budget_exhausted',
        'resume_hold_environment',
        'resume_hold_regulation',
        'no_hot_work_today',
        'clinical_latch',
      ]),
    )
    expect([...DEVICE_REST_IDS].sort()).toEqual(['limit_stricter_personal', 'monitoring_fallback_tables', 'stricter_work_rest', 'wbgt_screen_monitored'])
  })

  it.each(['environment', 'regulation', 'projection'] as ChannelId[])('every not-cleared or device-directed reason on the %s channel gives one pooled driver (id, text, channel, direction, basis)', (channel) => {
    for (const id of NOT_CLEARED_IDS) {
      for (const direction of ['raises', 'info'] as const) expect(supervisorDriver(loaded(id, channel, direction)), id).toEqual({ id: 'not_cleared_for_heat_work', ...POOLED_DRIVERS.not_cleared_for_heat_work })
    }
    for (const id of DEVICE_REST_IDS) {
      for (const direction of ['raises', 'info'] as const) expect(supervisorDriver(loaded(id, channel, direction)), id).toEqual({ id: 'device_directed_rest', ...POOLED_DRIVERS.device_directed_rest })
    }
  })

  it('pooled drivers are listed once and first, whatever their sources and count', () => {
    const a = supervisorDrivers([DRIVERS[1], loaded('phs_limit_reached', 'projection'), loaded('limit_stricter_personal', 'environment'), loaded('phs_resume_hold', 'projection')])
    const b = supervisorDrivers([loaded('wbgt_screen_monitored', 'environment'), loaded('acclimatization_budget_exhausted', 'environment'), DRIVERS[1]])
    expect(a.map((d) => d.id)).toEqual(['not_cleared_for_heat_work', 'device_directed_rest', 'twl_zone_high'])
    expect(b).toEqual(a)
    expect(notClearedForHeatWork([loaded('resume_hold_regulation', 'regulation')])).toBe(true)
    expect(notClearedForHeatWork([loaded('phs_limit_reached', 'physiology')])).toBe(false) // clinical channels never count
    expect(notClearedForHeatWork([DRIVERS[0], DRIVERS[1]])).toBe(false)
  })

  it('pooled texts equal the console phrases, carry no number and pass both supervisor text filters', () => {
    expect(POOLED_DRIVER_IDS).toEqual(['not_cleared_for_heat_work', 'device_directed_rest'])
    expect(POOLED_DRIVERS.not_cleared_for_heat_work.text).toBe(CONSOLE_PHRASES.en.not_cleared)
    expect(POOLED_DRIVERS.device_directed_rest.text).toBe(CONSOLE_PHRASES.en.device_rest)
    for (const id of POOLED_DRIVER_IDS) {
      const d = POOLED_DRIVERS[id]
      expect(d.text).not.toMatch(DIGIT)
      expect(d.text).not.toMatch(CLINICAL_TEXT_PATTERN)
      expect(d.text).not.toMatch(PRIVATE_FACTOR_TEXT_PATTERN)
      expect(d.basis).not.toMatch(/fasting|consent|wearable|conservative|extra.?care/i)
    }
    // Every English console phrase passes both filters too (they are shown on consoles).
    for (const [id, text] of Object.entries(CONSOLE_PHRASES.en)) {
      expect(text, id).not.toMatch(CLINICAL_TEXT_PATTERN)
      expect(text, id).not.toMatch(PRIVATE_FACTOR_TEXT_PATTERN)
    }
  })
})

describe('supervisor actions (wave 2d)', () => {
  it('drop device-only prompts and confidential actions, keep a sensor check only for a site sensor, add re-assignment when not cleared', () => {
    expect(DEVICE_ONLY_ACTIONS).toEqual(['drink_water', 'electrolytes', 'symptom_checkin', 'buddy_check'])
    const all: ActionId[] = ['rest_shade_now', 'drink_water', 'electrolytes', 'symptom_checkin', 'buddy_check', 'occ_health_review', 'check_sensor', 'shade_breaks']
    expect(supervisorActions(all, [])).toEqual(['rest_shade_now', 'shade_breaks'])
    const meter: RiskDriver = { id: SITE_SENSOR_DRIVER_IDS[0], channel: 'environment', text: 'Check the site WBGT meter', direction: 'info', basis: 'b' }
    expect(supervisorActions(all, [meter])).toEqual(['rest_shade_now', 'shade_breaks', 'check_sensor'])
    expect(supervisorActions(['rest_shade_now', 'cool_down'], [loaded('phs_resume_hold', 'projection')])).toEqual(['rest_shade_now', 'cool_down', 'rotate_task'])
    expect(supervisorActions(all, [], { keep: ['buddy_check'] })).toEqual(['rest_shade_now', 'shade_breaks', 'buddy_check'])
  })

  it('keep the engine action order (privacy.ts mirrors risk.ts ACTION_PRIORITY)', () => {
    const shuffled = [...ACTION_PRIORITY].reverse()
    const expected = ACTION_PRIORITY.filter((a) => !DEVICE_ONLY_ACTIONS.includes(a) && a !== 'occ_health_review' && a !== 'check_sensor')
    expect(supervisorActions(shuffled, [])).toEqual(expected)
  })
})

/** The private parts of a worker at the ISO 7933 water-loss limit: drinking normally vs fasting (drink-restricted). */
function atWaterLossLimit(fasting: boolean): { snapshot: WorkerSnapshot; assessment: RiskAssessment; profile: WorkerProfile } {
  const shared: RiskDriver[] = [
    { id: 'phs_limit_reached', channel: 'projection', text: 'Heat-strain model: the water-loss limit is reached', direction: 'raises', basis: 'ISO 7933:2023' },
    {
      id: 'phs_recovery_review_required',
      channel: 'projection',
      text: fasting
        ? 'Not drinking: the water-loss allowance is used up and rest does not restore it, so no more heat work this shift'
        : 'Heat-strain limit reached: work resumes only after 30 min rest in a cooled area (rest 0 % done; check-in pending; sign-off pending; the water-loss limit is not yet restored)',
      direction: 'raises',
      basis: 'ISO 7933:2023 clause 5',
    },
    { id: 'twl_zone_low', channel: 'regulation', text: 'TWL 300 W/m²: Low Risk — Unrestricted Zone', value: 300, unit: 'W/m²', direction: 'info', basis: 'ADOSH-SF CoP 11.0 v4.0' },
    {
      id: 'wbgt_within_limit',
      channel: 'environment',
      text: `Effective WBGT 27.9 °C is ${fasting ? '0.4' : '3.4'} °C under the personal exposure limit for Rebar (${fasting ? 298 : 321} W)`,
      value: 27.9,
      unit: '°C',
      direction: 'info',
      basis: 'NIOSH 2016 REL; NIOSH 2016 RAL',
    },
    { id: 'rest_area_cooled', channel: 'environment', text: 'Rest breaks in the air-conditioned rest area (WBGT 25.0 °C)', value: 25, unit: '°C', direction: 'info', basis: 'COOLED_REST' },
  ]
  const own: RiskDriver[] = fasting
    ? [
        { id: 'phs_no_drink_no_restart', channel: 'hydration', text: 'Not drinking (fasting): no more heat work this shift', direction: 'info', basis: 'ISO 7933:2023 Annex B' },
        { id: 'water_paused_fasting', channel: 'hydration', text: 'Fasting: water recommendation paused (0 mL/h)', value: 0, unit: 'mL/h', direction: 'info', basis: 'b' },
        // A producer that put the restriction on a non-clinical channel is pooled too.
        { id: 'phs_resume_hold', channel: 'projection', text: 'Drinking restricted: no more heat work this shift', direction: 'raises', basis: 'ISO 7933:2023' },
      ]
    : [
        { id: 'phs_drink_to_restart', channel: 'projection', text: 'Drink and rest: about 1.2 L to drink before heat work can restart', value: 1.2, unit: 'L', direction: 'raises', basis: 'ISO 7933:2023' },
        { id: 'phs_water_credit', channel: 'hydration', text: 'Logged drinks counted: 1.5 L', value: 1.5, unit: 'L', direction: 'info', basis: 'b' },
      ]
  const drivers = [...shared, ...own]
  const actions: ActionId[] = fasting ? ['rest_shade_now', 'cool_down', 'symptom_checkin'] : ['rest_shade_now', 'cool_down', 'symptom_checkin', 'drink_water', 'electrolytes']
  const profile = profileOf({ riskFlags: fasting ? ['fasting'] : [], consent: consentOf({ wearable: false }), hasWearable: false })
  const assessment = assessmentOf({
    level: 'stop',
    drivers,
    channels: [],
    actions,
    workMinPerHour: 0,
    minutesToLimit: 0,
    waterMlPerHour: fasting ? 0 : 709.76,
    confidence: 'high',
    dataQuality: { env: 'archive', physiology: 'absent', network: 'online', stale: false },
  })
  const snapshot = snapshotOf({
    level: 'stop',
    drivers,
    actions,
    workMinPerHour: 0,
    minutesToLimit: 0,
    waterMlPerHour: assessment.waterMlPerHour,
    riskFlags: profile.riskFlags,
    consent: profile.consent,
    hrBpm: null,
    ctEstC: null,
    psi: null,
    symptoms: [],
    urineColor: null,
  })
  return { snapshot, assessment, profile }
}

/** Everything a supervisor receives from a projection, minus the audit entry (the worker's own log). */
function supervisorOutput(snapshot: WorkerSnapshot, purpose: Purpose = 'safety_alerting') {
  const r = project(snapshot, { role: 'supervisor', actorId: 'S-01', purpose }, { now: T0, escalated: false })
  return { decision: r.decision, fields: r.fields, withheld: r.withheld, reason: r.reason, data: r.data }
}

describe('supervisor output — fasting and consent are not inferable (wave 2d)', () => {
  it.each(['safety_alerting', 'operational_planning'] as Purpose[])('fasting vs drinking at the same limit: identical supervisor projection (%s) and sync payload', (purpose) => {
    const drinking = atWaterLossLimit(false)
    const fasting = atWaterLossLimit(true)
    const a = supervisorOutput(drinking.snapshot, purpose)
    const b = supervisorOutput(fasting.snapshot, purpose)
    expect(b).toEqual(a)
    expect(a.decision).toBe('allowed')
    expect(a.data.actions).toEqual(['rest_shade_now', 'cool_down', 'rotate_task'])
    expect(a.data.drivers_nonclinical?.[0]).toEqual({ id: 'not_cleared_for_heat_work', ...POOLED_DRIVERS.not_cleared_for_heat_work })
    expect(a.data).not.toHaveProperty('waterMlPerHour')
    expect(JSON.stringify(a.data)).not.toMatch(/fasting|drink|water-loss|1\.2 L|321|298|709/i)
    expect(payloadForSync(fasting.assessment, fasting.profile, 'active')).toEqual(payloadForSync(drinking.assessment, drinking.profile, 'active'))
    expect(payloadForSync(fasting.assessment, fasting.profile, 'active').waterMlPerHour).toBe(SYNC_WATER_NOT_SENT_ML)
  })

  it('the buddy sees the same partner card for both (level, actions, acknowledgement)', () => {
    const view = (s: WorkerSnapshot) => project(s, { role: 'buddy', actorId: 'B-01', purpose: 'safety_alerting' }, { now: T0, escalated: false }).data
    expect(view(atWaterLossLimit(true).snapshot)).toEqual(view(atWaterLossLimit(false).snapshot))
  })

  it('wearable consent declined vs consented (monitored mode): identical supervisor output except the released operational fields', () => {
    const base = (consented: boolean): WorkerSnapshot => {
      const drivers: RiskDriver[] = [
        { id: 'wbgt_over_limit', channel: 'environment', text: 'Effective WBGT 31.2 °C is 1.1 °C over the personal exposure limit for Rebar (412 W)', value: 31.2, unit: '°C', direction: 'raises', basis: 'NIOSH 2016 REL; NIOSH 2016 RAL' },
        consented
          ? { id: 'wbgt_screen_monitored', channel: 'environment', text: 'WBGT is above the table limit: your own heat-strain projection (ISO 7933) and wearable monitoring are in use', direction: 'raises', basis: 'ISO 7243:2017; ACGIH TLV; NIOSH 2016' }
          : { id: 'monitoring_fallback_tables', channel: 'environment', text: 'Wearable monitoring is off (consent, wearable or setting): the table work/rest limits apply again', direction: 'raises', basis: 'ISO 7243:2017; ACGIH TLV; NIOSH 2016' },
        consented
          ? { id: 'work_rest_cycle', channel: 'environment', text: 'Work/rest guide: about 30 min work per hour, rest in shade the remainder', value: 30, unit: 'min/h', direction: 'info', basis: 'b; monitoring' }
          : { id: 'work_rest_cycle', channel: 'environment', text: 'Work at most 30 min per hour, rest in shade the remainder', value: 30, unit: 'min/h', direction: 'raises', basis: 'b' },
        { id: 'twl_zone_medium', channel: 'regulation', text: 'TWL 160 W/m²: Medium Risk — Warning Zone', value: 160, unit: 'W/m²', direction: 'raises', basis: 'ADOSH-SF CoP 11.0 v4.0' },
        consented
          ? { id: 'physio_no_warning', channel: 'physiology', text: 'HR 128 bpm; strain indicator in band', value: 128, unit: 'bpm', direction: 'info', basis: 'Buller 2013' }
          : { id: 'physio_unavailable_not_consented', channel: 'physiology', text: 'Wearable not consented', direction: 'info', basis: 'ARCHITECTURE §7' },
      ]
      return snapshotOf({
        level: 'high',
        drivers,
        actions: consented ? ['shade_breaks', 'drink_water', 'buddy_check'] : ['shade_breaks', 'drink_water', 'check_sensor'],
        workMinPerHour: 30,
        minutesToLimit: consented ? 48 : null,
        hrBpm: consented ? 128 : null,
        ctEstC: consented ? 37.9 : null,
        consent: consentOf({ wearable: consented }),
        riskFlags: [],
      })
    }
    const consented = supervisorOutput(base(true))
    const declined = supervisorOutput(base(false))
    expect(declined).toEqual(consented)
    expect(consented.data.drivers_nonclinical?.map((d) => d.id)).toEqual(['device_directed_rest', 'wbgt_over_limit', 'work_rest_cycle', 'twl_zone_medium'])
    expect(JSON.stringify(consented.data)).not.toMatch(/consent|wearable|monitor|bpm|412/i)
    // The released operational fields (level, work minutes) are the only ones that may differ, and only because the
    // enforcing limits differ (wave 2d principle 2): change them and nothing else changes.
    const looser = supervisorOutput({ ...base(true), level: 'caution', workMinPerHour: 45 })
    expect({ ...looser.data, level: declined.data.level, workMinPerHour: declined.data.workMinPerHour }).toEqual(declined.data)
  })

  it('the sync payload never carries the individual water figure and agrees with the supervisor actions', () => {
    const { assessment, profile, snapshot } = atWaterLossLimit(false)
    const p = payloadForSync(assessment, profile, 'active')
    expect(p.waterMlPerHour).toBe(SYNC_WATER_NOT_SENT_ML)
    expect(p.actions).toEqual(supervisorOutput(snapshot).data.actions)
  })
})

describe('supervisor view of real engine output (wave 2d, safety review HIGH reproduction)', () => {
  // The safety review's probe (privacy-fasting2.mts): a moderate task in shade, 36 °C / 30 %, cooled rest area, one
  // worker drinking normally and one fasting, until the ISO 7933 water-loss limit is reached.
  const site = { ...getSite('musaffah'), radiantBoostC: 0, restArea: 'cooled_cabin' as const }
  const t0 = epochFromLocal('2025-07-20T06:00')
  const heat = computeSiteHeat({ t: t0, taC: 36, rhPct: 30, pHpa: 1005, wind10Ms: 2, ghiWm2: 700, radiationWindowMin: 0, radiantBoostC: 0, source: 'archive' }, site)
  const task = { id: 'T', name: 'Rebar', workClass: 'moderate' as const, inSun: false, durationMin: 600, flexible: true }
  const SITE_IDS = new Set(SITE_ALLOW_LIST)

  function run(fasting: boolean) {
    const profile = profileOf({ id: 'W1', riskFlags: fasting ? ['fasting'] : [], consent: consentOf({ wearable: false }), hasWearable: false, clothing: 'work_clothes', daysOnSite: 400 })
    let st = createWorkerEngine(profile, t0)
    const views: Array<{ t: number; data: ReturnType<typeof supervisorOutput>['data'] }> = []
    let atLimit: { t: number; snapshot: WorkerSnapshot; assessment: RiskAssessment } | null = null
    for (let t = t0; t < t0 + 11 * HOUR && atLimit === null; t += MINUTE) {
      const r = stepWorkerEngine(st, { now: t, profile, task, location: 'shade', heat, network: 'online', restArea: 'cooled_cabin', fastingNow: fasting, resumeTask: task })
      st = r.state
      const snapshot = createWorkerSnapshot(profile, r.assessment)
      if ((t - t0) % (5 * MINUTE) === 0 || r.detail.phsRecovery) views.push({ t, data: supervisorOutput(snapshot).data })
      if (r.detail.phsRecovery) atLimit = { t, snapshot, assessment: r.assessment }
    }
    return { profile, views, atLimit }
  }

  it('fasting or not, at the water-loss limit the supervisor sees the pooled "not cleared" driver and re-assignment, never a number, drink wording or water figure', () => {
    for (const fasting of [false, true]) {
      const { profile, views, atLimit } = run(fasting)
      expect(atLimit, `fasting=${fasting}`).not.toBeNull()
      // The probe's known timing: about 157 min (fasting) and 426 min (drinking) into the shift.
      expect((atLimit!.t - t0) / MINUTE).toBeGreaterThan(fasting ? 100 : 300)
      expect(views.length).toBeGreaterThan(20)
      const sup = supervisorOutput(atLimit!.snapshot).data
      expect(sup.level).toBe('stop')
      expect(sup.drivers_nonclinical?.[0]).toEqual({ id: 'not_cleared_for_heat_work', ...POOLED_DRIVERS.not_cleared_for_heat_work })
      expect(sup.actions).toContain('rotate_task')
      for (const a of DEVICE_ONLY_ACTIONS) expect(sup.actions).not.toContain(a)
      expect(sup).not.toHaveProperty('waterMlPerHour')
      expect(payloadForSync(atLimit!.assessment, profile, 'active').waterMlPerHour).toBe(SYNC_WATER_NOT_SENT_ML)
      // Every supervisor view along the shift: numbers only in site drivers; no clinical, fasting or consent words.
      for (const v of views) {
        for (const d of v.data.drivers_nonclinical ?? []) {
          if (!SITE_IDS.has(d.id)) {
            expect(d.text, `${d.id} at +${(v.t - t0) / MINUTE} min`).not.toMatch(DIGIT)
            expect(d.value).toBeUndefined()
          }
          expect(supervisorSafeText(d.text), d.text).toBe(true)
          expect(d.text).not.toMatch(/drink|water-loss/i)
        }
      }
    }
  })
})
