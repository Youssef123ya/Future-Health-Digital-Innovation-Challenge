import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLINICAL_TIER_LABEL,
  CONSERVATIVE_MODE,
  COOLING_PROTOCOL,
  FIRST_AID,
  FLUID,
  HYPONATRAEMIA_SYMPTOMS,
  PROMPT_TIMEOUT,
  RISK_FLAG_HANDLING,
  SYMPTOM_RULES,
  UAE_EMERGENCY,
  conservativeMode,
  drinkReminderExposure,
  fluidCapCheck,
  fluidStatus,
  hydrationChannel,
  localDayStartMs,
  physioDisabled,
  promptTimeout,
  symptomsChannel,
  triage,
  urineAssessment,
  type TriageContext,
} from './clinical'
import { MINUTE_MS, epochFromLocal, startOfLocalDay } from './time'
import {
  TIER_TO_LEVEL,
  maxLevel,
  type ActionId,
  type Checkin,
  type ClinicalTier,
  type FluidIntake,
  type RiskFlagId,
  type SymptomId,
} from './types'

// ─────────────────────────────── fixture vocabulary ───────────────────────────────

interface TriageVector {
  name: string
  input: {
    answers: Record<string, boolean>
    cramps_minutes?: number
    profile?: { heart_disease?: boolean; low_sodium_diet?: boolean }
    minutes_since_first_symptom?: number
    improving?: boolean
    worsening?: boolean
  }
  expected: { level: string; actions: string[] }
}
interface ClinicalFixtures {
  _meta: { constants: { HOURLY_CAP_L: number; DAILY_CAP_L: number; CUP_L: number; REMINDER_DEFAULT_L: number; REMINDER_INTERVAL_MIN: number } }
  items: Record<string, { who: string; level_if_yes: string }>
  triage_vectors: TriageVector[]
  urine_vectors: { shade: number | null; brown_or_red: boolean; expected: { code: string; triage_floor: string; escalate_if_persists?: string } }[]
  fluid_vectors: { rolling_60min_L: number; today_L: number; fasting_now: boolean; expected: { hourly_cap_L: number; daily_cap_L: number; flags: string[]; send_drink_reminders: boolean } }[]
  fusion_vectors: { env: number; physio: number | null; symptom: number | null; expected: number }[]
}
const cfx = JSON.parse(readFileSync(new URL('../../fixtures/physio/clinical_rules_fixtures.json', import.meta.url), 'utf8')) as ClinicalFixtures

const LEVEL_TO_TIER: Record<string, ClinicalTier> = {
  T0_continue_with_precautions: 0,
  T1_rest_cool_notify_supervisor: 1,
  T2_first_aider_now: 2,
  T3_emergency_998_now: 3,
}

/** Research check-in items → SymptomId (task mapping). S_OVERDRINK_SX = drank_a_lot + a symptom. */
const ITEM_TO_SYMPTOMS: Record<string, SymptomId[]> = {
  B_CONFUSED: ['confusion'],
  B_SPEECH_GAIT: ['slurred_speech'],
  B_UNRESPONSIVE: ['collapsed_unresponsive'],
  S_CHEST: ['chest_pain'],
  S_VOMIT_REPEAT: ['repeated_vomiting'],
  S_FAINTED: ['fainted'],
  S_DIZZY: ['dizziness'],
  S_HEADACHE: ['headache'],
  S_NAUSEA: ['nausea'],
  S_WEAK: ['weakness_fatigue'],
  S_URINE_BROWN: ['brown_urine'],
  S_OVERDRINK_SX: ['drank_a_lot', 'swollen_hands'],
  S_CRAMPS: ['cramps'],
  S_RASH: ['heat_rash'],
  S_THIRST: ['thirst'],
  S_URINE_DARK: [], // carried by Checkin.urineColor 7-8
}

/** Oracle action vocabulary (clinical_rules.py) → ActionId. NOTIFY_SUPERVISOR is carried by the level (alerts.ts). */
const ACTION_MAP: Record<string, ActionId[]> = {
  CONTINUE_WITH_PRECAUTIONS: ['drink_water'],
  DRINK_WATER_PLUS_SNACK_OR_ELECTROLYTE: ['drink_water', 'electrolytes'],
  NOTIFY_SUPERVISOR: [],
  RECHECK_15_30_MIN: ['symptom_checkin'],
  REST_SHADE_COOL: ['rest_shade_now', 'cool_down'],
  STOP_STRENUOUS_WORK: ['reduce_intensity'],
  COOL_AND_REHYDRATE_IF_ALERT: ['rest_shade_now', 'cool_down', 'drink_water'],
  FIRST_AIDER_NOW: ['first_aider_check'],
  MEDICAL_EVALUATION_SAME_DAY: ['medical_evaluation'],
  MEDICAL_FACILITY_SAME_SHIFT_check_CK: ['medical_evaluation'],
  NO_RETURN_TO_HOT_WORK_TODAY: ['no_hot_work_today'],
  STAY_WITH_WORKER: ['stay_with_worker'],
  STOP_WORK: ['stop_work'],
  STOP_PLAIN_WATER_suspect_hyponatremia: ['restrict_fluids'],
  ALERT_SUPERVISOR_AND_FIRST_AIDER: ['first_aider_check'],
  CALL_998: ['call_998'],
  START_COOLING_NOW: ['cool_first'],
}
function expectedActions(codes: string[]): Set<ActionId> {
  const s = new Set<ActionId>(codes.flatMap((c) => {
    const ids = ACTION_MAP[c]
    if (!ids) throw new Error(`unmapped oracle action ${c}`)
    return ids
  }))
  if (s.has('restrict_fluids')) s.delete('drink_water') // never push water with suspected hyponatraemia
  return s
}

const T = epochFromLocal('2026-07-15T10:00')
const min = (m: number): number => T + m * MINUTE_MS
const ck = (m: number, symptoms: SymptomId[], extra: Partial<Checkin> = {}): Checkin => ({ t: min(m), workerId: 'W-1', by: 'self', symptoms, ...extra })

function fixtureCase(v: TriageVector, swap?: Partial<Record<string, SymptomId[]>>): { checkin: Checkin; history: Checkin[]; ctx: TriageContext } {
  const map = { ...ITEM_TO_SYMPTOMS, ...swap }
  const symptoms = Object.entries(v.input.answers)
    .filter(([, yes]) => yes)
    .flatMap(([k]) => map[k] ?? [])
  if ((v.input.cramps_minutes ?? 0) >= 60) symptoms.push('cramps_persistent')
  const ctx: TriageContext = {}
  if (v.input.profile?.heart_disease || v.input.profile?.low_sodium_diet) ctx.crampsMedicalRisk = true
  const history: Checkin[] = []
  let at = 0
  let trend: Checkin['trend']
  if (v.input.minutes_since_first_symptom !== undefined) {
    history.push(ck(0, [...symptoms]))
    at = v.input.minutes_since_first_symptom
    trend = v.input.improving === true ? 'better' : 'same'
  }
  if (v.input.worsening === true) trend = 'worse'
  return { checkin: ck(at, symptoms, trend ? { trend } : {}), history, ctx }
}

// ─────────────────────────────── triage ───────────────────────────────

describe('triage: clinical_rules_fixtures triage vectors (§10.7)', () => {
  for (const v of cfx.triage_vectors) {
    it(v.name, () => {
      const { checkin, history, ctx } = fixtureCase(v)
      const r = triage(checkin, history, ctx)
      const tier = LEVEL_TO_TIER[v.expected.level]
      expect(r.tier).toBe(tier)
      expect(r.level).toBe(TIER_TO_LEVEL[tier])
      expect(new Set(r.actions)).toEqual(expectedActions(v.expected.actions))
      expect(r.actions.length).toBe(new Set(r.actions).size)
      expect(r.basis.length + (tier === 0 ? 1 : 0)).toBeGreaterThan(0)
    })
  }

  it('alternative code mappings give the same result (B_SPEECH_GAIT, S_OVERDRINK_SX)', () => {
    const slurred = cfx.triage_vectors.find((v) => v.name === 'buddy_slurred_speech') as TriageVector
    const r = triage(fixtureCase(slurred, { B_SPEECH_GAIT: ['unsteady_walking'] }).checkin)
    expect(r.tier).toBe(3)
    const od = cfx.triage_vectors.find((v) => v.name === 'overdrink_symptoms') as TriageVector
    for (const sx of [['headache'], ['nausea'], ['swollen_hands']] as SymptomId[][]) {
      const res = triage(fixtureCase(od, { S_OVERDRINK_SX: ['drank_a_lot', ...sx] }).checkin)
      expect(res.tier).toBe(2)
      expect(new Set(res.actions)).toEqual(expectedActions(od.expected.actions))
      expect(res.hyponatraemiaSuspected).toBe(true)
    }
    const vom = triage(ck(0, ['drank_a_lot', 'repeated_vomiting']))
    expect(vom.tier).toBe(3)
    expect(vom.actions).toContain('restrict_fluids')
  })

  it('item tiers agree with the oracle item table', () => {
    for (const [code, item] of Object.entries(cfx.items)) {
      const ids = ITEM_TO_SYMPTOMS[code]
      if (!ids || ids.length !== 1) continue
      expect(SYMPTOM_RULES[ids[0]].tier, code).toBe(LEVEL_TO_TIER[item.level_if_yes])
      expect(SYMPTOM_RULES[ids[0]].item).toBe(code)
    }
    expect(SYMPTOM_RULES.seizure.tier).toBe(3)
    expect(SYMPTOM_RULES.cramps_persistent.tier).toBe(2)
  })
})

describe('triage: §10.11 inline vectors and time rules', () => {
  it('§10.11 list', () => {
    expect(triage(ck(0, [])).tier).toBe(0)
    expect(triage(ck(0, ['thirst'])).tier).toBe(0)
    expect(triage(ck(0, ['heat_rash'])).tier).toBe(1)
    expect(triage(ck(0, ['cramps'])).tier).toBe(1)
    expect(triage(ck(0, ['cramps_persistent'])).tier).toBe(2)
    expect(triage(ck(0, ['cramps']), [], { crampsMedicalRisk: true }).tier).toBe(2)
    expect(triage(ck(0, ['headache', 'dizziness'])).tier).toBe(2)
    expect(triage(ck(0, ['fainted'])).tier).toBe(2)
    expect(triage(ck(0, ['fainted', 'confusion'])).tier).toBe(3)
    expect(triage(ck(0, ['slurred_speech'], { by: 'buddy' })).tier).toBe(3)
    expect(triage(ck(0, ['repeated_vomiting'])).tier).toBe(3)
    expect(triage(ck(0, ['brown_urine'])).tier).toBe(2)
    expect(triage(ck(0, ['drank_a_lot', 'headache'])).tier).toBe(2)
    expect(triage(ck(0, ['drank_a_lot', 'headache', 'confusion'])).tier).toBe(3)
    expect(triage(ck(0, ['chest_pain'])).tier).toBe(3)
    const h = [ck(0, ['headache', 'weakness_fatigue'])]
    expect(triage(ck(30, ['headache', 'weakness_fatigue'], { trend: 'same' }), h).tier).toBe(3)
    expect(triage(ck(30, ['headache', 'weakness_fatigue'], { trend: 'better' }), h).tier).toBe(2)
    expect(triage(ck(0, ['cramps'], { trend: 'worse' })).tier).toBe(3)
  })

  it('seizure, collapse and unsteady walking are red flags (T3) with the emergency actions', () => {
    for (const s of ['seizure', 'collapsed_unresponsive', 'unsteady_walking'] as SymptomId[]) {
      const r = triage(ck(0, [s], { by: 'buddy' }))
      expect(r.tier).toBe(3)
      expect(r.redFlags).toEqual([s])
      expect(r.actions.slice(0, 3)).toEqual(['call_998', 'cool_first', 'stay_with_worker'])
      expect(r.recheckAtMin).toBeNull()
    }
  })

  it('re-checks at +15 and +30 min, then every 15 min', () => {
    expect(triage(ck(0, ['headache'])).recheckAtMin).toBe(15)
    expect(triage(ck(0, ['cramps'])).recheckAtMin).toBe(15)
    const h = [ck(0, ['headache'])]
    expect(triage(ck(15, ['headache'], { trend: 'better' }), h).recheckAtMin).toBe(15)
    const h2 = [...h, ck(15, ['headache'], { trend: 'better' })]
    const at30 = triage(ck(30, ['headache'], { trend: 'better' }), h2)
    expect(at30.tier).toBe(2)
    expect(at30.recheckAtMin).toBe(15)
    expect(at30.episodeStartT).toBe(min(0))
    expect(triage(ck(0, [])).recheckAtMin).toBeNull()
  })

  it('T2 not clearly improving: T3 at 30 min, not at 29; missing trend counts as not improving', () => {
    const h = [ck(0, ['dizziness'])]
    expect(triage(ck(29, ['dizziness'], { trend: 'same' }), h).tier).toBe(2)
    const r = triage(ck(30, ['dizziness']), h)
    expect(r.tier).toBe(3)
    expect(r.escalation).toBe('not_improving_30min')
  })

  it('any worsening gives T3: reported worse, a higher tier, or more warning symptoms', () => {
    const r1 = triage(ck(15, ['cramps', 'headache']), [ck(0, ['cramps'])])
    expect([r1.tier, r1.escalation]).toEqual([3, 'worsening'])
    const r2 = triage(ck(15, ['headache', 'nausea'], { trend: 'same' }), [ck(0, ['headache'])])
    expect([r2.tier, r2.escalation]).toEqual([3, 'worsening'])
    const r3 = triage(ck(15, [], { trend: 'worse' }), [ck(0, ['headache'])])
    expect(r3.tier).toBe(3)
    const swap = triage(ck(15, ['nausea'], { trend: 'better' }), [ck(0, ['headache'])])
    expect(swap.tier).toBe(2)
    const newRed = triage(ck(15, ['headache', 'confusion']), [ck(0, ['headache'])])
    expect(newRed.tier).toBe(3)
    expect(newRed.redFlags).toEqual(['confusion'])
  })

  it('episodes: a symptom-free re-check or a > 60-min gap starts a new episode', () => {
    expect(triage(ck(90, ['headache']), [ck(0, ['cramps'])]).tier).toBe(2)
    expect(triage(ck(30, ['headache']), [ck(0, ['cramps']), ck(15, [])]).tier).toBe(2)
    const otherWorker = { ...ck(0, ['cramps']), workerId: 'W-2' }
    expect(triage(ck(15, ['headache']), [otherWorker]).tier).toBe(2)
    const yesterday = { ...ck(0, ['cramps']), t: min(-24 * 60 + 30) }
    expect(triage(ck(15, ['headache']), [yesterday]).tier).toBe(2)
  })

  it('cramps that persist across check-ins for 60 min become T2 (not T3)', () => {
    const r = triage(ck(60, ['cramps'], { trend: 'same' }), [ck(0, ['cramps']), ck(30, ['cramps'], { trend: 'same' })])
    expect(r.tier).toBe(2)
    expect(r.escalation).toBeNull()
    expect(r.rationale.join(' ')).toMatch(/60 min/)
    expect(triage(ck(45, ['cramps'], { trend: 'same' }), [ck(0, ['cramps'])]).tier).toBe(1)
    expect(triage(ck(20, ['cramps_persistent']), [ck(0, ['cramps'])]).tier).toBe(2)
  })

  it('oh_review_required escalates cramps to T2; logged over-cap intake starts the hyponatraemia path', () => {
    expect(triage(ck(0, ['cramps']), [], { riskFlags: ['oh_review_required'] }).tier).toBe(2)
    const r = triage(ck(0, ['headache']), [], { overFluidCap: true })
    expect(r.tier).toBe(2)
    expect(r.actions).toContain('restrict_fluids')
    expect(r.actions).not.toContain('drink_water')
  })

  it('fluid advice: no routine water while fasting at T0 or after over-drinking; first aid overrides the fast', () => {
    expect(triage(ck(0, []), [], { fastingNow: true }).actions).not.toContain('drink_water')
    expect(triage(ck(0, ['headache']), [], { fastingNow: true }).actions).toContain('drink_water')
    const od = triage(ck(0, ['drank_a_lot']))
    expect(od.tier).toBe(0)
    expect(od.actions).toEqual(['electrolytes'])
  })

  it('urine shade 7-8 on a check-in gives T1 (§10.7 S_URINE_DARK)', () => {
    expect(triage(ck(0, [], { urineColor: 7 })).tier).toBe(1)
    expect(triage(ck(0, [], { urineColor: 4 })).tier).toBe(0)
  })
})

describe('promptTimeout (§4.3 item 6)', () => {
  it('notifies the buddy at 5 min and then the supervisor at 10 min while the level is T1 or above', () => {
    expect(promptTimeout(T, min(4), { level: 'high' })).toEqual({ notify: [], overdueMin: 0, nextEscalationAtMs: min(5) })
    expect(promptTimeout(T, min(5), { level: 'stop' }).notify).toEqual(['buddy'])
    expect(promptTimeout(T, min(7), { level: 'high' }).nextEscalationAtMs).toBe(min(PROMPT_TIMEOUT.SUPERVISOR_AFTER_MIN))
    const late = promptTimeout(T, min(12), { level: 'emergency' })
    expect(late.notify).toEqual(['buddy', 'supervisor'])
    expect(late.overdueMin).toBe(7)
    expect(late.nextEscalationAtMs).toBeNull()
  })

  it('does nothing once answered or below T1, unless the prompt was raised by a warning', () => {
    expect(promptTimeout(T, min(20), { level: 'stop', answered: true }).notify).toEqual([])
    expect(promptTimeout(T, min(20), { level: 'caution' }).notify).toEqual([])
    expect(promptTimeout(T, min(6), { level: 'safe', raisedByWarning: true }).notify).toEqual(['buddy'])
  })
})

// ─────────────────────────────── urine and fluids ───────────────────────────────

describe('urineAssessment (§10.8; fixture urine vectors)', () => {
  for (const u of cfx.urine_vectors) {
    it(`shade ${u.shade}${u.brown_or_red ? ' brown/red' : ''}`, () => {
      const r = urineAssessment(u.shade, u.brown_or_red)
      expect(r.code).toBe(u.expected.code)
      expect(r.tier).toBe(LEVEL_TO_TIER[u.expected.triage_floor])
      expect(r.escalateIfPersists).toBe(u.expected.escalate_if_persists ? LEVEL_TO_TIER[u.expected.escalate_if_persists] : null)
      expect(r.basis.length).toBeGreaterThan(0)
    })
  }

  it('5-6 persisting at the next reading → T1; invalid shades are rejected', () => {
    expect(urineAssessment(5, false, 6).tier).toBe(1)
    expect(urineAssessment(6, false, 4).tier).toBe(0)
    for (const bad of [0, 9, 4.5, null, undefined]) {
      const r = urineAssessment(bad)
      expect(r.code).toBe('U_INVALID')
      expect(r.tier).toBeNull()
    }
  })
})

describe('fluid caps (§10.8; fixture fluid vectors)', () => {
  it('FLUID constants equal the oracle values (1.5 qt, 12 qt, 8 fl oz)', () => {
    const c = cfx._meta.constants
    expect(FLUID.HOURLY_CAP_L).toBe(c.HOURLY_CAP_L)
    expect(FLUID.DAILY_CAP_L).toBe(c.DAILY_CAP_L)
    expect(FLUID.CUP_L).toBe(c.CUP_L)
    expect(FLUID.REMINDER_L).toBe(c.REMINDER_DEFAULT_L)
    expect(FLUID.REMINDER_EVERY_MIN).toBe(c.REMINDER_INTERVAL_MIN)
  })

  const NOW = epochFromLocal('2026-07-15T14:00')
  for (const v of cfx.fluid_vectors) {
    it(`rolling ${v.rolling_60min_L} L, today ${v.today_L} L, fasting ${v.fasting_now}`, () => {
      expect(Math.round(FLUID.HOURLY_CAP_L * 1e4) / 1e4).toBe(v.expected.hourly_cap_L)
      expect(Math.round(FLUID.DAILY_CAP_L * 1e3) / 1e3).toBe(v.expected.daily_cap_L)
      const cap = fluidCapCheck(v.rolling_60min_L, v.today_L, v.fasting_now)
      expect(cap.flags).toEqual(v.expected.flags)
      expect(cap.sendDrinkReminders).toBe(v.expected.send_drink_reminders)
      // Same result from an intake log.
      const intakes: FluidIntake[] = []
      if (v.rolling_60min_L > 0) intakes.push({ t: NOW - 10 * MINUTE_MS, workerId: 'W-1', ml: v.rolling_60min_L * 1000 })
      const earlier = v.today_L - v.rolling_60min_L
      if (earlier > 0) intakes.push({ t: NOW - 3 * 60 * MINUTE_MS, workerId: 'W-1', ml: earlier * 1000 })
      const st = fluidStatus(intakes, NOW, { fastingNow: v.fasting_now })
      expect(st.rolling60L).toBeCloseTo(v.rolling_60min_L, 12)
      expect(st.todayL).toBeCloseTo(v.today_L, 12)
      expect(st.flags).toEqual(v.expected.flags)
      expect(st.sendDrinkReminders).toBe(v.expected.send_drink_reminders)
    })
  }

  it('hyponatraemia path: over a cap with symptoms → T2 restrict fluids; with confusion → T3', () => {
    const intakes: FluidIntake[] = [
      { t: NOW - 50 * MINUTE_MS, workerId: 'W-1', ml: 750 },
      { t: NOW - 20 * MINUTE_MS, workerId: 'W-1', ml: 750 },
    ]
    const t2 = fluidStatus(intakes, NOW, { symptoms: ['headache'] })
    expect(t2.flags).toEqual(['OVER_HOURLY_CAP'])
    expect([t2.tier, t2.hyponatraemiaSuspected]).toEqual([2, true])
    expect(t2.actions).toEqual(expect.arrayContaining(['restrict_fluids', 'first_aider_check', 'stop_work']))
    expect(t2.actions).not.toContain('drink_water')
    const t3 = fluidStatus(intakes, NOW, { symptoms: ['confusion'] })
    expect(t3.tier).toBe(3)
    expect(t3.actions).toEqual(expect.arrayContaining(['call_998', 'restrict_fluids']))
    const noSx = fluidStatus(intakes, NOW, { symptoms: ['dizziness'] })
    expect(noSx.tier).toBe(0)
    expect(noSx.message).toMatch(/Slow down/)
    expect(noSx.nextReminderAtMs).toBeNull()
    expect(noSx.actions).not.toContain('drink_water')
  })

  it('daily cap → T1 warning; reminders every 20 min; none while fasting; electrolytes after 120 min of sweating', () => {
    const day: FluidIntake[] = Array.from({ length: 12 }, (_, i) => ({ t: NOW - (i + 1) * 30 * MINUTE_MS - 61 * MINUTE_MS, workerId: 'W-1', ml: 1000 }))
    const d = fluidStatus(day, NOW)
    expect(d.flags).toEqual(['OVER_DAILY_CAP'])
    expect(d.tier).toBe(1)
    expect(d.actions).toEqual(expect.arrayContaining(['electrolytes', 'symptom_checkin']))

    const recent = fluidStatus([{ t: NOW - 10 * MINUTE_MS, workerId: 'W-1', ml: 250 }], NOW)
    expect(recent.nextReminderAtMs).toBe(NOW + 10 * MINUTE_MS)
    expect(recent.actions).not.toContain('drink_water')
    const due = fluidStatus([{ t: NOW - 25 * MINUTE_MS, workerId: 'W-1', ml: 250 }], NOW)
    expect(due.nextReminderAtMs).toBe(NOW)
    expect(due.actions).toContain('drink_water')
    expect(due.reminderMl).toBe(250)

    const fasting = fluidStatus([], NOW, { fastingNow: true })
    expect([fasting.sendDrinkReminders, fasting.nextReminderAtMs]).toEqual([false, null])
    expect(fasting.actions).not.toContain('drink_water')

    expect(fluidStatus([], NOW, { sweatingSinceMs: NOW - 120 * MINUTE_MS }).electrolyteDue).toBe(true)
    expect(fluidStatus([], NOW, { sweatingSinceMs: NOW - 119 * MINUTE_MS }).electrolyteDue).toBe(false)
  })

  it('counts only today (Abu Dhabi local day) and only the given worker', () => {
    const intakes: FluidIntake[] = [
      { t: epochFromLocal('2026-07-14T23:30'), workerId: 'W-1', ml: 5000 },
      { t: epochFromLocal('2026-07-15T08:00'), workerId: 'W-1', ml: 500 },
      { t: epochFromLocal('2026-07-15T13:30'), workerId: 'W-2', ml: 900 },
    ]
    const st = fluidStatus(intakes, NOW, { workerId: 'W-1' })
    expect(st.todayL).toBeCloseTo(0.5, 12)
    expect(st.rolling60L).toBe(0)
  })
})

// ─────────────────────────────── fusion contract ───────────────────────────────

describe('fusion vectors (§10.6) through the shared TIER_TO_LEVEL / maxLevel contract', () => {
  it('max over available channels; missing channels never lower anything', () => {
    for (const f of cfx.fusion_vectors) {
      const levels = [f.env, f.physio, f.symptom].filter((x): x is number => x !== null).map((x) => TIER_TO_LEVEL[x as ClinicalTier])
      expect(maxLevel(...levels)).toBe(TIER_TO_LEVEL[f.expected as ClinicalTier])
    }
  })
})

// ─────────────────────────────── channels ───────────────────────────────

describe('symptomsChannel (ARCHITECTURE §5)', () => {
  const NOW = min(60)
  it('is unavailable without a check-in today; previous days are ignored', () => {
    const r = symptomsChannel({ now: NOW, checkins: [{ ...ck(0, ['headache']), t: min(-24 * 60) }], consented: true })
    expect([r.available, r.level, r.tier]).toEqual([false, 'safe', 0])
  })

  it('maps tiers with TIER_TO_LEVEL and carries actions and drivers with a basis', () => {
    const r = symptomsChannel({ now: NOW, checkins: [ck(0, ['confusion'], { by: 'buddy' })], consented: true })
    expect([r.available, r.level, r.tier]).toEqual([true, 'emergency', 3])
    expect(r.actions[0]).toBe('call_998')
    expect(r.drivers.find((d) => d.id === 'symptom_confusion')?.basis).toMatch(/NIOSH/)
    expect(symptomsChannel({ now: NOW, checkins: [ck(0, ['cramps'])], consented: true }).level).toBe('high')
    expect(symptomsChannel({ now: NOW, checkins: [ck(0, ['nausea'])], consented: true }).level).toBe('stop')
    expect(symptomsChannel({ now: NOW, checkins: [ck(0, [])], consented: true }).drivers[0].id).toBe('no_symptoms')
  })

  it('uses the earlier check-ins as the episode history (T2 not improving at 30 min → emergency)', () => {
    const r = symptomsChannel({ now: NOW, checkins: [ck(30, ['headache'], { trend: 'same' }), ck(0, ['headache'])], consented: true })
    expect(r.level).toBe('emergency')
    expect(r.drivers.map((d) => d.id)).toContain('symptoms_not_improving_30min')
  })

  it('without consent ignores self check-ins but always uses buddy / first-aider reports', () => {
    expect(symptomsChannel({ now: NOW, checkins: [ck(0, ['headache'])], consented: false }).available).toBe(false)
    const r = symptomsChannel({ now: NOW, checkins: [ck(0, ['collapsed_unresponsive'], { by: 'first_aider' })], consented: false })
    expect(r.level).toBe('emergency')
  })

  it('leaves urine colour to the hydration channel', () => {
    const r = symptomsChannel({ now: NOW, checkins: [ck(0, [], { urineColor: 8 })], consented: true })
    expect(r.level).toBe('safe')
  })
})

describe('hydrationChannel (ARCHITECTURE §5)', () => {
  const NOW = min(240)
  const intake = (mAgo: number, ml: number): FluidIntake => ({ t: NOW - mAgo * MINUTE_MS, workerId: 'W-1', ml })
  const run = (checkins: Checkin[], intakes: FluidIntake[] = [], extra: { fastingNow?: boolean; consented?: boolean } = {}) =>
    hydrationChannel({ now: NOW, checkins, intakes, consented: extra.consented ?? true, fastingNow: extra.fastingNow })

  it('urine shade: 1-3 safe, 4 driver only, 5-6 caution (persistent → high), 7-8 high', () => {
    expect(run([ck(0, [], { urineColor: 2 })]).level).toBe('safe')
    const s4 = run([ck(0, [], { urineColor: 4 })])
    expect(s4.level).toBe('safe')
    expect(s4.drivers.find((d) => d.id === 'urine_drink_more')?.direction).toBe('info')
    expect(s4.actions).toContain('drink_water')
    expect(run([ck(0, [], { urineColor: 5 })]).level).toBe('caution')
    expect(run([ck(0, [], { urineColor: 6 }), ck(120, [], { urineColor: 5 })]).level).toBe('high')
    expect(run([ck(0, [], { urineColor: 8 })]).level).toBe('high')
  })

  it('intake: daily cap → high; hourly cap → "slow down" and no drink advice; over a cap with symptoms → stop / emergency', () => {
    const day = Array.from({ length: 12 }, (_, i) => intake(70 + i * 10, 1000))
    expect(run([], day).level).toBe('high')
    const hourly = run([ck(0, [], { urineColor: 5 })], [intake(40, 800), intake(10, 700)])
    expect(hourly.drivers.map((d) => d.id)).toContain('fluid_over_hourly_cap')
    expect(hourly.actions).not.toContain('drink_water')
    const hypo = run([ck(230, ['headache'])], [intake(40, 800), intake(10, 700)])
    expect(hypo.level).toBe('stop')
    expect(hypo.actions).toContain('restrict_fluids')
    expect(run([ck(230, ['confusion'], { by: 'buddy' })], [intake(40, 800), intake(10, 700)]).level).toBe('emergency')
  })

  it('no drink advice while fasting; unavailable without consent or data', () => {
    const f = run([ck(0, [], { urineColor: 5 })], [], { fastingNow: true })
    expect(f.level).toBe('caution')
    expect(f.actions).not.toContain('drink_water')
    expect(run([]).available).toBe(false)
    expect(run([ck(0, [], { urineColor: 8 })], [intake(10, 500)], { consented: false }).available).toBe(false)
  })
})

// ─────────────────────────────── risk flags, conservative mode, first aid ───────────────────────────────

const ALL_FLAGS: RiskFlagId[] = [
  'prior_heat_illness',
  'heat_sensitive_medication',
  'hr_suppressing_medication',
  'recent_illness',
  'poor_sleep',
  'fasting',
  'heat_rash_sunburn',
  'oh_review_required',
]

describe('conservative mode and risk flags (§10.9, §7)', () => {
  const base = { riskFlags: [] as RiskFlagId[], daysOnSite: 30, daysAwayRecent: 0 }

  it('any flag except oh_review_required switches it on; flags are never summed', () => {
    for (const f of ALL_FLAGS) {
      const r = conservativeMode({ ...base, riskFlags: [f] })
      expect(r.conservative, f).toBe(f !== 'oh_review_required')
      if (r.conservative) {
        expect(r.reasons).toEqual([f])
        expect([r.ectempT1C, r.checkinEveryMin, r.checkinFromLevel, r.buddyMandatory]).toEqual([38.0, 30, 'caution', true])
      }
    }
    const off = conservativeMode(base)
    expect([off.conservative, off.ectempT1C, off.checkinEveryMin, off.buddyMandatory]).toEqual([false, 38.4, null, false])
  })

  it('first 14 days on the job, a return after ≥ 7 days away, or heat rash today', () => {
    expect(conservativeMode({ ...base, daysOnSite: 13 }).reasons).toEqual(['new_worker_14d'])
    expect(conservativeMode({ ...base, daysOnSite: CONSERVATIVE_MODE.NEW_WORKER_DAYS }).conservative).toBe(false)
    expect(conservativeMode({ ...base, daysAwayRecent: 7 }).reasons).toEqual(['returning_after_absence'])
    expect(conservativeMode({ ...base, daysAwayRecent: 6 }).conservative).toBe(false)
    expect(conservativeMode(base, { symptomsToday: ['heat_rash'] }).reasons).toEqual(['heat_rash_today'])
  })

  it('hr_suppressing_medication disables physiology', () => {
    expect(physioDisabled({ riskFlags: ['hr_suppressing_medication'] })).toBe(true)
    expect(physioDisabled({ riskFlags: ['heat_sensitive_medication'] })).toBe(false)
    expect(conservativeMode({ ...base, riskFlags: ['hr_suppressing_medication'] }).physioDisabled).toBe(true)
  })

  it('the handling table covers every flag with a citation', () => {
    expect(Object.keys(RISK_FLAG_HANDLING).sort()).toEqual([...ALL_FLAGS].sort())
    for (const f of ALL_FLAGS) {
      const h = RISK_FLAG_HANDLING[f]
      expect(h.basis.length, f).toBeGreaterThan(10)
      expect(h.disablesPhysiology).toBe(f === 'hr_suppressing_medication')
    }
    expect(RISK_FLAG_HANDLING.heat_sensitive_medication.workerMessage).toMatch(/Do not stop your medicine/)
  })
})

describe('first-aid protocol data (§10.10)', () => {
  it('orders the cooling steps: call 998, shade, immerse 1-26 °C, douse/towels, ~15 min without a thermometer, fluids only if alert', () => {
    expect(COOLING_PROTOCOL.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6])
    expect(COOLING_PROTOCOL.map((s) => s.id)).toEqual(['call_998', 'shade_undress', 'immerse', 'douse_or_towels', 'continue_until_ems', 'fluids_if_alert'])
    expect(COOLING_PROTOCOL[0].text).toContain('998')
    expect(COOLING_PROTOCOL[2].text).toMatch(/1-26 °C/)
    expect(COOLING_PROTOCOL[4].text).toMatch(/15 min/)
    expect(COOLING_PROTOCOL[5].text).toMatch(/fully alert.*Never leave the worker alone/)
    for (const s of COOLING_PROTOCOL) expect(s.basis.length).toBeGreaterThan(5)
    expect([FIRST_AID.IMMERSION_WATER_MIN_C, FIRST_AID.IMMERSION_WATER_MAX_C, FIRST_AID.IMMERSION_STOP_WITHOUT_THERMOMETER_MIN]).toEqual([1, 26, 15])
    expect(UAE_EMERGENCY).toMatchObject({ AMBULANCE: '998', POLICE: '999', CIVIL_DEFENCE: '997', AD_SMS_PEOPLE_OF_DETERMINATION: '5999', AD_APP: 'AD999' })
  })
})

describe('claims discipline', () => {
  it('no text claims diagnosis, heat-stroke prediction or core-temperature measurement', () => {
    const texts: string[] = [
      ...Object.values(CLINICAL_TIER_LABEL),
      ...Object.values(SYMPTOM_RULES).map((r) => r.label),
      ...COOLING_PROTOCOL.map((s) => s.text),
      ...Object.values(RISK_FLAG_HANDLING).flatMap((h) => [h.handling, h.workerMessage]),
      ...cfx.triage_vectors.flatMap((v) => {
        const c = fixtureCase(v)
        return triage(c.checkin, c.history, c.ctx).rationale
      }),
      ...[1, 4, 5, 7].map((s) => urineAssessment(s).advice),
    ]
    for (const t of texts) expect(t).not.toMatch(/diagnos|predicts? heat ?stroke|measures? core temperature/i)
    expect(HYPONATRAEMIA_SYMPTOMS).toContain('swollen_hands')
  })
})

describe('local day start (Asia/Dubai arithmetic, wave 2c performance)', () => {
  it('equals time.startOfLocalDay for many timestamps, including midnight edges and fractional milliseconds', () => {
    const midnights = ['2025-01-01', '2025-02-28', '2025-03-01', '2025-06-15', '2025-08-01', '2025-11-26', '2025-12-31', '2028-02-29'].map((d) => epochFromLocal(`${d}T00:00`))
    const ts: number[] = [0, 1, 4 * 3_600_000 - 1, 4 * 3_600_000]
    for (const m of midnights) ts.push(m - 60_000, m - 1, m - 0.5, m, m + 0.5, m + 1, m + 60_000, m + 12 * 3_600_000, m + 86_400_000 - 1)
    for (let t = epochFromLocal('2025-07-24T00:00'); t < epochFromLocal('2025-07-26T00:00'); t += 7 * MINUTE_MS + 13) ts.push(t)
    for (const t of ts) expect(localDayStartMs(t), String(t)).toBe(startOfLocalDay(t))
    expect(() => localDayStartMs(Number.NaN)).toThrow()
    expect(() => startOfLocalDay(Number.NaN)).toThrow()
  })

  it('keeps the local-day totals of fluidStatus and the today filter of the channels at midnight', () => {
    const m = epochFromLocal('2025-08-02T00:00')
    const intakes: FluidIntake[] = [
      { t: m - 1, workerId: 'X', ml: 500 },
      { t: m, workerId: 'X', ml: 300 },
    ]
    expect(fluidStatus(intakes, m + 30 * MINUTE_MS).todayL).toBeCloseTo(0.3, 12)
    expect(fluidStatus(intakes, m - 1).todayL).toBeCloseTo(0.5, 12)
    const day = symptomsChannel({ now: m + MINUTE_MS, checkins: [{ t: m - 1, workerId: 'X', by: 'self', symptoms: ['cramps'] }], consented: true })
    expect(day.available).toBe(false) // yesterday's check-in does not count today
  })
})

// ─────────────────────────────── drink reminders follow heat exposure (wave 2d) ───────────────────────────────

describe('drink reminders follow heat exposure (drinkReminderExposure; FLUID)', () => {
  const NOW = epochFromLocal('2026-07-15T10:00')

  it('constants: 78 °F (TB MED 507 heat category 1 lower bound) converted exactly; 30 min after hot work [ENG]', () => {
    expect(FLUID.EXPOSED_REST_WBGT_C).toBeCloseTo(25.5556, 4)
    expect(FLUID.EXPOSED_REST_WBGT_C).toBe(((78 - 32) * 5) / 9)
    expect(FLUID.REMINDER_AFTER_HOT_WORK_MIN).toBe(30)
    expect([FLUID.REMINDER_L, FLUID.REMINDER_EVERY_MIN]).toEqual([0.25, 20])
  })

  it('known answers: hot work (and 30 min after it), rest/idle outside a cooled area at ≥ 25.56 °C, else none', () => {
    const base = { hotWorkNow: false, minutesSinceHotWork: null, restingOutsideCooled: false, wbgtC: 20 }
    expect(drinkReminderExposure({ ...base, hotWorkNow: true })).toBe('hot_work')
    expect(drinkReminderExposure({ ...base, minutesSinceHotWork: 0 })).toBe('hot_work')
    expect(drinkReminderExposure({ ...base, minutesSinceHotWork: 29.9 })).toBe('hot_work')
    expect(drinkReminderExposure({ ...base, minutesSinceHotWork: 30 })).toBeNull()
    expect(drinkReminderExposure({ ...base, restingOutsideCooled: true, wbgtC: FLUID.EXPOSED_REST_WBGT_C })).toBe('heat_rest')
    expect(drinkReminderExposure({ ...base, restingOutsideCooled: true, wbgtC: 25.55 })).toBeNull()
    expect(drinkReminderExposure({ ...base, restingOutsideCooled: true, wbgtC: Number.NaN })).toBe('heat_rest') // fail-safe
    expect(drinkReminderExposure({ ...base, restingOutsideCooled: false, wbgtC: 35 })).toBeNull() // cooled rest area
    expect(drinkReminderExposure({ ...base, minutesSinceHotWork: -1, restingOutsideCooled: false })).toBeNull()
  })

  it('fluidStatus: reminders only while exposed (absent = exposed, the behaviour before wave 2d); same cadence and caps', () => {
    const last = [{ t: NOW - 25 * MINUTE_MS, workerId: 'W-1', ml: 250 }]
    const before = fluidStatus(last, NOW)
    expect(before).toMatchObject({ exposed: true, sendDrinkReminders: true, nextReminderAtMs: NOW, reminder: 'drink' })
    expect(fluidStatus(last, NOW, { exposed: true })).toEqual(before)
    const off = fluidStatus(last, NOW, { exposed: false })
    expect(off).toMatchObject({ exposed: false, sendDrinkReminders: false, nextReminderAtMs: null, reminder: null })
    expect(off.actions).not.toContain('drink_water')
    expect(off.flags).toEqual(before.flags)
    const notDue = fluidStatus([{ t: NOW - 10 * MINUTE_MS, workerId: 'W-1', ml: 250 }], NOW, { exposed: true })
    expect([notDue.nextReminderAtMs, notDue.reminder]).toEqual([NOW + 10 * MINUTE_MS, null])
    // Over the hourly cap: no reminder even while exposed.
    const capped = fluidStatus([{ t: NOW - 5 * MINUTE_MS, workerId: 'W-1', ml: 1500 }], NOW, { exposed: true })
    expect(capped.flags).toContain('OVER_HOURLY_CAP')
    expect([capped.sendDrinkReminders, capped.reminder]).toEqual([false, null])
  })

  it('fasting: no drink reminder, rest-in-shade guidance while exposed (none when not exposed)', () => {
    const fx = fluidStatus([], NOW, { fastingNow: true, exposed: true })
    expect(fx).toMatchObject({ sendDrinkReminders: false, nextReminderAtMs: null, reminder: 'shade' })
    expect(fx.actions).not.toContain('drink_water')
    expect(fluidStatus([], NOW, { fastingNow: true, exposed: false }).reminder).toBeNull()
    const ch = hydrationChannel({ now: NOW, checkins: [], intakes: [], consented: true, fastingNow: true, exposed: true })
    expect(ch.fluid.reminder).toBe('shade')
    expect(ch.drivers.map((d) => d.id)).toContain('fasting_no_drink_reminders')
    expect(ch.actions).not.toContain('drink_water')
  })

  it('hydrationChannel passes the exposure through (absent = exposed)', () => {
    const intakes = [{ t: NOW - 30 * MINUTE_MS, workerId: 'W-1', ml: 250 }]
    const on = hydrationChannel({ now: NOW, checkins: [], intakes, consented: true, workerId: 'W-1' })
    const off = hydrationChannel({ now: NOW, checkins: [], intakes, consented: true, workerId: 'W-1', exposed: false })
    expect(on.actions).toContain('drink_water')
    expect(off.actions).not.toContain('drink_water')
    expect(off.fluid.reminder).toBeNull()
    expect(off.level).toBe(on.level)
  })
})
