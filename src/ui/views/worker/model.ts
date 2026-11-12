/**
 * Pure view-model helpers of the worker phone (#/worker/:id). No store access, no clock, no React: every function maps
 * the worker's own device model (state/selectors.ts WorkerDeviceModel) to what the phone shows, so it is unit-tested.
 *
 * The engine owns every decision: rest holds, resume checks, bout countdowns, the work/rest cycle, the water-loss limit
 * and the monitored-mode fallback all come from `WorkerStepDetail` / `RiskAssessment`; nothing here recomputes a limit.
 * Basis: docs/dev/engine-api-wave2d.md §3 (detail.resume, detail.environment, detail.water, detail.drink).
 */
import { PROHIBITED_PURPOSES, type ActionId, type Checkin, type FluidIntake, type Purpose, type RiskLevel, type Role, type SymptomId } from '../../../engine/types'
import type { EnvironmentDetail, MonitoringFallbackReason, PhsWaterDetail, ResumeDetail } from '../../../engine/risk'
import type { EctempBand } from '../../../engine/physio'
import { FLUID, SYMPTOM_RULES } from '../../../engine/clinical'
import { MINUTE_MS, startOfLocalDay } from '../../../engine/time'
import type { ActionParams } from '../../../i18n'
import type { WorkerMessageKey } from './messages'

/** A channel holding the worker at rest until its resume check passes. */
export type Holder = ResumeDetail['heldBy'][number]

// ─────────────────────────────── Worker resolution ───────────────────────────────

/** Route alias for "the demo worker" (state/uiStore.ts DEVICE_ROUTE_ALIAS, ui/router.ts DEFAULT_WORKER_ID). */
export const DEMO_ALIAS = 'demo'

/**
 * The worker a phone shows: an explicit route id as is; the 'demo' alias (or no id) → the first demo persona on the
 * loaded roster, else the UI's device worker when it is on the roster, else the first roster worker.
 */
export function resolvePhoneWorker(
  routeId: string | null | undefined,
  opts: { rosterIds: readonly string[]; personaIds: readonly string[]; deviceWorkerId: string | null },
): string | null {
  if (routeId && routeId !== DEMO_ALIAS) return routeId
  const persona = opts.personaIds.find((id) => opts.rosterIds.includes(id))
  if (persona) return persona
  if (opts.deviceWorkerId && opts.rosterIds.includes(opts.deviceWorkerId)) return opts.deviceWorkerId
  return opts.rosterIds[0] ?? opts.deviceWorkerId ?? null
}

/** Up to two initials for the avatar ("Bikash G." → "BG"). */
export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('')
}

// ─────────────────────────────── Rest / work timer ───────────────────────────────

/** What the timer card shows, from the engine's own numbers only. */
export type TimerState =
  | { kind: 'rest'; source: 'estimate' | 'check'; remainingMin: number; totalMin: number; taskId: string | null; heldBy: Holder[]; nextCheckT: number | null }
  | { kind: 'rest_infeasible'; taskId: string | null; heldBy: Holder[] }
  | { kind: 'rest_no_return'; taskId: string | null; heldBy: Holder[] }
  | { kind: 'bout'; remainingMin: number; totalMin: number; taskId: string | null }
  | { kind: 'cycle'; workMin: number; restMin: number }
  | { kind: 'cycle_free' }
  | { kind: 'cycle_none' }
  | { kind: 'none' }

/** Ring span for a remaining time: one hour, or whole hours above it (the ring shows the share of that span). */
export function ringTotalMin(remainingMin: number): number {
  return remainingMin <= 60 ? 60 : Math.ceil(remainingMin / 60) * 60
}

/**
 * The timer card state. Order: an active hold (no release possible now → the supervisor reassigns; the engine's rest
 * estimate; else the next check time; else no return to that task this shift), then the bout countdown after a release,
 * then nothing at stop/emergency (the level card instructs), then the hour's work/rest cycle (work rounded down, rest
 * up: never more work than the engine allowed — the i18n actionText rule).
 */
export function timerState(input: {
  resume: ResumeDetail | null | undefined
  workMinPerHour: number | null | undefined
  level: RiskLevel | null | undefined
  now: number
}): TimerState {
  const r = input.resume
  if (r && r.held) {
    const heldBy = [...r.heldBy]
    if (r.infeasibleNow) return { kind: 'rest_infeasible', taskId: r.taskId, heldBy }
    if (r.estRestMin !== null && r.estRestMin > 0) {
      return { kind: 'rest', source: 'estimate', remainingMin: r.estRestMin, totalMin: ringTotalMin(r.estRestMin), taskId: r.taskId, heldBy, nextCheckT: r.nextCheckT }
    }
    if (r.nextCheckT !== null) {
      const remainingMin = Math.max(0, Math.ceil((r.nextCheckT - input.now) / MINUTE_MS))
      return { kind: 'rest', source: 'check', remainingMin, totalMin: ringTotalMin(remainingMin), taskId: r.taskId, heldBy, nextCheckT: r.nextCheckT }
    }
    return { kind: 'rest_no_return', taskId: r.taskId, heldBy }
  }
  if (r && r.boutMin !== null && r.boutMin > 0) {
    return { kind: 'bout', remainingMin: r.boutMin, totalMin: Math.max(30, r.boutMin), taskId: r.taskId }
  }
  if (input.level === 'stop' || input.level === 'emergency') return { kind: 'none' }
  const w = input.workMinPerHour
  if (typeof w !== 'number' || !Number.isFinite(w)) return { kind: 'none' }
  const work = Math.floor(w)
  if (work <= 0) return { kind: 'cycle_none' }
  if (work >= 60) return { kind: 'cycle_free' }
  return { kind: 'cycle', workMin: work, restMin: 60 - work }
}

/** Worker-facing reason for each hold (detail.resume.heldBy, worker device only). */
export const HOLDER_KEYS: Readonly<Record<Holder, WorkerMessageKey>> = Object.freeze({
  projection: 'held_projection',
  regulation: 'held_regulation',
  environment: 'held_environment',
})

// ─────────────────────────────── Monitored mode ───────────────────────────────

/** Monitored-mode badge: in force, fallen back to the table limits (with the device-only reason), or not applicable. */
export type MonitorState = { kind: 'on' } | { kind: 'fallback'; reason: MonitoringFallbackReason } | null

export function monitorState(env: EnvironmentDetail | null | undefined): MonitorState {
  if (!env) return null
  if (env.monitored) return { kind: 'on' }
  if (env.basis === 'monitored' && env.fallbackReason) return { kind: 'fallback', reason: env.fallbackReason }
  return null
}

/** Plain reason for a monitored-mode fallback (detail.environment.fallbackReason — the worker's own phone only). */
export const FALLBACK_KEYS: Readonly<Record<MonitoringFallbackReason, WorkerMessageKey>> = Object.freeze({
  data: 'fb_data',
  consent: 'fb_consent',
  model: 'fb_model',
  status: 'fb_status',
})

// ─────────────────────────────── Water ───────────────────────────────

/** The credited water-loss threshold never exceeds this share of body mass (risk.ts hydrationCredit.maxLossFraction). */
export const WATER_CEILING_FRACTION = 0.075

/** Geometry of the water-balance gauge: every bar on one scale (0 → the 7.5 % ceiling, or the largest value). */
export interface WaterGauge {
  scaleMaxL: number
  sweatL: number
  creditL: number
  thresholdL: number
  ceilingL: number | null
  sweatFrac: number
  creditFrac: number
  thresholdFrac: number
  /** Sweat loss at or above 80 % of the applied threshold [ENG: a gentle heads-up, not a limit]. */
  nearLimit: boolean
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

export function waterGauge(w: PhsWaterDetail, massKg: number | null | undefined): WaterGauge {
  const ceilingL = typeof massKg === 'number' && massKg > 0 ? WATER_CEILING_FRACTION * massKg : null
  const scaleMaxL = Math.max(ceilingL ?? 0, w.thresholdL, w.sweatLossL, w.creditedIntakeL, 0.5)
  return {
    scaleMaxL,
    sweatL: w.sweatLossL,
    creditL: w.creditedIntakeL,
    thresholdL: w.thresholdL,
    ceilingL,
    sweatFrac: clamp01(w.sweatLossL / scaleMaxL),
    creditFrac: clamp01(w.creditedIntakeL / scaleMaxL),
    thresholdFrac: clamp01(w.thresholdL / scaleMaxL),
    nearLimit: w.thresholdL > 0 && w.sweatLossL >= 0.8 * w.thresholdL,
  }
}

/** Today's logged drinks against the TB MED 507 caps (engine/clinical.ts FLUID). */
export interface DrinkTotals {
  todayMl: number
  lastHourMl: number
  hourlyCapMl: number
  dailyCapMl: number
  overHourly: boolean
  overDaily: boolean
}

export function drinkTotals(intakes: readonly FluidIntake[], workerId: string, now: number): DrinkTotals {
  const dayStart = startOfLocalDay(now)
  let todayMl = 0
  let lastHourMl = 0
  for (const i of intakes) {
    if (i.workerId !== workerId || !(i.ml > 0) || !(i.t <= now)) continue
    if (i.t >= dayStart) todayMl += i.ml
    if (i.t > now - 60 * MINUTE_MS) lastHourMl += i.ml
  }
  const hourlyCapMl = Math.round(FLUID.HOURLY_CAP_L * 1000)
  const dailyCapMl = Math.round(FLUID.DAILY_CAP_L * 1000)
  return { todayMl, lastHourMl, hourlyCapMl, dailyCapMl, overHourly: lastHourMl > hourlyCapMl, overDaily: todayMl > dailyCapMl }
}

/** One logged drink ("1 cup"), the reminder volume. Basis: engine/clinical.ts FLUID.REMINDER_L (TB MED 507 cadence). */
export const DRINK_ML = Math.round(FLUID.REMINDER_L * 1000)

/** The engine's hourly water advice as a 20-min sip (nearest 50 mL); null when there is none. */
export function drinkMlPer20(waterMlPerHour: number | null | undefined): number | null {
  if (typeof waterMlPerHour !== 'number' || !(waterMlPerHour > 0)) return null
  return Math.max(50, Math.round(waterMlPerHour / 3 / 50) * 50)
}

/** Parameters that turn an action into its specific variant (i18n actionText): minutes, mL, the midday window. */
export function actionParamsFor(
  action: ActionId,
  ctx: { workMinPerHour?: number; waterMlPerHour?: number; drinkDue?: boolean; restMin?: number | null; midday?: { from: string; to: string } | null },
): ActionParams {
  switch (action) {
    case 'shade_breaks':
      return typeof ctx.workMinPerHour === 'number' ? { workMinPerHour: ctx.workMinPerHour } : {}
    case 'drink_water': {
      if (ctx.drinkDue) return { ml: DRINK_ML }
      const ml = drinkMlPer20(ctx.waterMlPerHour)
      return ml !== null ? { ml, min: FLUID.REMINDER_EVERY_MIN } : {}
    }
    case 'rest_shade_now':
      return typeof ctx.restMin === 'number' && ctx.restMin > 0 ? { min: ctx.restMin } : {}
    case 'midday_break':
      return ctx.midday ? { from: ctx.midday.from, to: ctx.midday.to } : {}
    default:
      return {}
  }
}

// ─────────────────────────────── Check-in flow ───────────────────────────────

/** Self check-in order: the most serious first, so a red flag is caught early; cramps_persistent only after a YES to cramps. */
export const SELF_QUESTIONS: readonly SymptomId[] = Object.freeze([
  'chest_pain',
  'repeated_vomiting',
  'fainted',
  'dizziness',
  'headache',
  'nausea',
  'weakness_fatigue',
  'cramps',
  'cramps_persistent',
  'brown_urine',
  'heat_rash',
  'drank_a_lot',
  'swollen_hands',
  'thirst',
] as const)

/** Buddy check order: what a partner can see first (the T3 signs are typically buddy-observed, clinical.ts SYMPTOM_RULES). */
export const BUDDY_QUESTIONS: readonly SymptomId[] = Object.freeze([
  'collapsed_unresponsive',
  'seizure',
  'confusion',
  'slurred_speech',
  'unsteady_walking',
  'chest_pain',
  'repeated_vomiting',
  'fainted',
  'dizziness',
  'weakness_fatigue',
  'nausea',
  'headache',
  'cramps',
  'cramps_persistent',
] as const)

/** A question asked only after a YES to its parent. */
const CONDITIONAL: Readonly<Partial<Record<SymptomId, SymptomId>>> = Object.freeze({ cramps_persistent: 'cramps' })

/** T3 red-flag symptom (YES → emergency: stop asking and act). Basis: engine/clinical.ts SYMPTOM_RULES tiers. */
export function isRedFlag(s: SymptomId): boolean {
  return SYMPTOM_RULES[s].tier === 3
}

export type Answers = Readonly<Partial<Record<SymptomId, boolean>>>

const applicable = (s: SymptomId, answers: Answers): boolean => {
  const parent = CONDITIONAL[s]
  return parent === undefined || answers[parent] === true
}

/** The next question, or null when done (all answered, or a red flag answered YES). */
export function nextQuestion(order: readonly SymptomId[], answers: Answers): SymptomId | null {
  if (order.some((s) => answers[s] === true && isRedFlag(s))) return null
  for (const s of order) {
    if (answers[s] === undefined && applicable(s, answers)) return s
  }
  return null
}

/** 1-based position of the next question and the number of questions that apply so far. */
export function questionProgress(order: readonly SymptomId[], answers: Answers): { n: number; total: number } {
  const list = order.filter((s) => applicable(s, answers))
  const answered = list.filter((s) => answers[s] !== undefined).length
  return { n: Math.min(list.length, answered + 1), total: list.length }
}

/** Symptoms answered YES, in question order (an answer to a question that no longer applies is dropped). */
export function yesSymptoms(order: readonly SymptomId[], answers: Answers): SymptomId[] {
  return order.filter((s) => answers[s] === true && applicable(s, answers))
}

/** The latest check-in with symptoms in the last `windowMin` minutes: the next check-in is its follow-up (trend question). */
export function followUpTarget(checkins: readonly Checkin[], workerId: string, now: number, windowMin = 60): Checkin | null {
  let best: Checkin | null = null
  for (const c of checkins) {
    if (c.workerId !== workerId || c.symptoms.length === 0 || !c.id) continue
    if (c.t > now || c.t < now - windowMin * MINUTE_MS) continue
    if (!best || c.t > best.t) best = c
  }
  return best
}

/** Red-flag picks on the SOS screen (T3 items a bystander can see), each with its short label. */
export const SOS_SIGNS: readonly { symptoms: SymptomId[]; key: WorkerMessageKey }[] = Object.freeze([
  { symptoms: ['collapsed_unresponsive'], key: 'sx_collapsed' },
  { symptoms: ['confusion'], key: 'sx_confusion' },
  { symptoms: ['seizure'], key: 'sx_seizure' },
  { symptoms: ['slurred_speech'], key: 'sx_speech' },
  { symptoms: ['unsteady_walking'], key: 'sx_walk' },
  { symptoms: ['chest_pain'], key: 'sx_chest' },
  { symptoms: ['repeated_vomiting'], key: 'sx_vomit' },
])

// ─────────────────────────────── Urine colour ───────────────────────────────

export type UrineAdvice = 'ok' | 'drink_more' | 'dark'

/** Armstrong 8-shade scale → advice: 1–3 OK, 4 drink more, 5–8 dark (ARCHITECTURE §5 hydration channel; i18n `urine`). */
export function urineAdvice(color: number): UrineAdvice {
  if (color <= 3) return 'ok'
  if (color === 4) return 'drink_more'
  return 'dark'
}

/** Approximate on-screen shades of the 8-step chart, pale → dark [ENG: a self-check aid, not a calibrated chart]. */
export const URINE_SWATCHES: readonly string[] = Object.freeze(['#fbf7d4', '#f7efa6', '#f3e27a', '#ecd04f', '#e0b932', '#cf9d24', '#b9841d', '#9b6a18'])

// ─────────────────────────────── Strain indicator ───────────────────────────────

/** Display scale of the strain band (ECTemp display clamp is 35.5–42.0; this window frames the working range) [ENG]. */
export const STRAIN_SCALE = Object.freeze({ min: 36, max: 40 })

export function strainGeometry(band: Pick<EctempBand, 'lowC' | 'highC' | 'centreC'>): { lowFrac: number; highFrac: number; centreFrac: number } {
  const span = STRAIN_SCALE.max - STRAIN_SCALE.min
  const f = (x: number): number => clamp01((x - STRAIN_SCALE.min) / span)
  return { lowFrac: f(band.lowC), highFrac: f(band.highC), centreFrac: f(band.centreC) }
}

// ─────────────────────────────── Privacy tab ───────────────────────────────

/** Plain-language groups for the keys that never leave the phone (privacy.inspectSyncPayload keptOnDevice). */
export type KeptGroup = 'reasons' | 'projection' | 'water' | 'quality' | 'identity' | 'body' | 'flags' | 'heart' | 'choices' | 'checkins'

const GROUP_ORDER: readonly KeptGroup[] = ['reasons', 'projection', 'heart', 'flags', 'checkins', 'water', 'body', 'identity', 'quality', 'choices']

const KEY_GROUP: Readonly<Record<string, KeptGroup>> = Object.freeze({
  'assessment.channels': 'reasons',
  'assessment.drivers': 'reasons',
  'assessment.minutesToLimit': 'projection',
  'assessment.waterMlPerHour': 'water',
  'assessment.dataQuality': 'quality',
  'profile.displayName': 'identity',
  'profile.siteId': 'identity',
  'profile.language': 'identity',
  'profile.ageYears': 'body',
  'profile.sex': 'body',
  'profile.massKg': 'body',
  'profile.heightCm': 'body',
  'profile.daysOnSite': 'body',
  'profile.daysAwayRecent': 'body',
  'profile.experiencedInHeat': 'body',
  'profile.clothing': 'body',
  'profile.riskFlags': 'flags',
  'profile.restingHrBpm': 'heart',
  'profile.hasWearable': 'heart',
  'profile.consent': 'choices',
})

/**
 * Groups present in `keptOnDevice`, plus the on-device records that are not assessment/profile keys and never enter the
 * payload: heart-rate readings and the strain estimate, check-in answers, logged drinks and the water balance.
 */
export function keptGroups(keys: readonly string[]): KeptGroup[] {
  const present = new Set<KeptGroup>(['heart', 'checkins', 'water'])
  for (const k of keys) {
    const g = KEY_GROUP[k]
    if (g) present.add(g)
  }
  return GROUP_ORDER.filter((g) => present.has(g))
}

export const KEPT_KEYS: Readonly<Record<KeptGroup, WorkerMessageKey>> = Object.freeze({
  reasons: 'kept_reasons',
  projection: 'kept_projection',
  water: 'kept_water',
  quality: 'kept_quality',
  identity: 'kept_identity',
  body: 'kept_body',
  flags: 'kept_flags',
  heart: 'kept_heart',
  choices: 'kept_choices',
  checkins: 'kept_checkins',
})

export const ROLE_KEYS: Readonly<Record<Role, WorkerMessageKey>> = Object.freeze({
  worker: 'role_worker',
  buddy: 'role_buddy',
  supervisor: 'role_supervisor',
  first_aider: 'role_first_aider',
  occ_health: 'role_occ_health',
  hse_manager: 'role_hse_manager',
  regulator: 'role_regulator',
  employer_hr: 'role_employer_hr',
})

/** Plain label of an access purpose; the prohibited ones (performance, discipline, insurance, visa) share one label. */
export function purposeKey(p: Purpose): WorkerMessageKey {
  if (PROHIBITED_PURPOSES.includes(p)) return 'p_forbidden'
  switch (p) {
    case 'safety_alerting':
      return 'p_safety'
    case 'clinical_care':
      return 'p_clinical'
    case 'operational_planning':
      return 'p_planning'
    case 'compliance_reporting':
      return 'p_compliance'
    case 'public_health_statistics':
      return 'p_statistics'
    default:
      return 'p_forbidden'
  }
}

/** Display order of the levels that make a level card urgent (saturated card, assertive announcement). */
export function isUrgent(level: RiskLevel): boolean {
  return level === 'stop' || level === 'emergency'
}
