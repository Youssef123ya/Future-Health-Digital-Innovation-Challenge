/**
 * Zill clinical safety rules (engine/clinical.ts): symptom check-in triage with its time rules, red flags, the
 * cool-first first-aid protocol, urine colour, fluid caps and hyponatraemia prevention, risk-flag handling and
 * conservative mode — physio_and_clinical.md §5–§8 and the port-ready rules of §10.6–10.10.
 *
 * Claims discipline: these are occupational first-aid and safety rules (ACSM 2023, ILCOR 2019, TB MED 507 2022,
 * CDC/NIOSH, OSHA). They do not diagnose. "Suspected" conditions trigger human checks and first aid; symptoms always
 * override models. All [ENG] values are engineering defaults that need sign-off by a UAE-licensed occupational
 * physician before field use (physio_and_clinical.md §10, §10.13 item 10).
 *
 * Privacy: risk flags, symptoms and fluid logs stay on the worker's device. Supervisors see only level + actions.
 */
import { DAY_MS, DUBAI_OFFSET_MS, MINUTE_MS } from './time'
import {
  RISK_ORDER,
  TIER_TO_LEVEL,
  type ActionId,
  type ChannelResult,
  type Checkin,
  type ClinicalTier,
  type FluidIntake,
  type RiskDriver,
  type RiskFlagId,
  type RiskLevel,
  type SymptomId,
  type WorkerProfile,
} from './types'

// ─────────────────────────────── Sources ───────────────────────────────

/** Citation strings used in `basis` fields (full references: physio_and_clinical.md reference list). */
const SRC = {
  NIOSH_ILL: 'CDC/NIOSH Heat-related illnesses (2026)',
  NIOSH16: 'NIOSH 2016 Criteria for a Recommended Standard, Pub. 2016-106',
  TBMED: 'TB MED 507 (2022)',
  OSHA_FA: 'OSHA Heat-related illnesses and first aid',
  ILCOR19: 'ILCOR 2019 CoSTR first-aid cooling for heat stroke and exertional hyperthermia',
  IOC21: 'IOC consensus, Hosokawa et al. 2021 Br J Sports Med 55:1405',
  NATA: 'NATA exertional heat illnesses position statement (executive summary)',
  SPSA24: 'Sharjah OSHJ-CoP-33 Safety in Heat v2 (2024)',
  WMS19: 'Wilderness Medical Society EAH guideline, Bennett et al. 2020',
} as const

// ─────────────────────────────── Local day ───────────────────────────────

/**
 * Epoch ms of the Abu Dhabi local midnight at or before `t`. Asia/Dubai is UTC+4 all year with no daylight saving, so
 * exact arithmetic gives the same result as time.startOfLocalDay (string formatting + Date.parse) for every timestamp
 * from 1970 on, fractional milliseconds included, at a fraction of the cost (it runs on every engine step). A
 * non-finite `t` throws, as startOfLocalDay does. Exported for the equivalence test.
 */
export function localDayStartMs(t: number): number {
  if (!Number.isFinite(t)) throw new Error(`Invalid timestamp: ${t}`)
  return Math.floor((t + DUBAI_OFFSET_MS) / DAY_MS) * DAY_MS - DUBAI_OFFSET_MS
}

// ─────────────────────────────── Tiers ───────────────────────────────

/**
 * Worker-facing meaning of each clinical tier — physio_and_clinical.md §10.6–10.7 (oracle level names
 * T0_continue_with_precautions … T3_emergency_998_now). Zill level via TIER_TO_LEVEL.
 */
export const CLINICAL_TIER_LABEL: Record<ClinicalTier, string> = {
  0: 'Continue with precautions',
  1: 'Rest in shade, cool down, tell the supervisor',
  2: 'Stop work - first aider now, no more hot work today',
  3: 'Emergency - call 998 and cool first',
}

// ─────────────────────────────── Symptom table ───────────────────────────────

/** One check-in item of the §10.7 triage table. */
export interface SymptomRule {
  /** Tier when answered YES on its own. */
  tier: ClinicalTier
  /** Who usually reports it (the last five T3 items are typically buddy-observed). */
  observedBy: 'self' | 'buddy'
  /** Research check-in item code (physio_and_clinical.md §10.7; clinical_rules.py). */
  item: string
  label: string
  basis: string
}

/**
 * Symptom triage table — physio_and_clinical.md §10.7 and §5.2 (YES gives the tier; final = max):
 * T3 confusion, slurred speech / unsteady walking, collapse / unresponsive, seizure, chest pain, repeated vomiting;
 * T2 fainted (now alert), dizziness, headache, nausea, weakness, brown urine, cramps ≥ 60 min;
 * T1 cramps, heat rash; T0 thirst. "drank_a_lot" and "swollen_hands" are T0 alone; with each other or with headache,
 * nausea or vomiting they form the over-drinking item (S_OVERDRINK_SX, T2, suspected hyponatraemia).
 */
export const SYMPTOM_RULES: Record<SymptomId, SymptomRule> = {
  thirst: { tier: 0, observedBy: 'self', item: 'S_THIRST', label: 'Thirst', basis: 'physio_and_clinical.md §10.7 (drink advice only) [ENG]' },
  heat_rash: { tier: 1, observedBy: 'self', item: 'S_RASH', label: 'Heat rash', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} §4-3e` },
  cramps: { tier: 1, observedBy: 'self', item: 'S_CRAMPS', label: 'Muscle cramps', basis: `${SRC.NIOSH_ILL}; ${SRC.SPSA24}` },
  cramps_persistent: {
    tier: 2,
    observedBy: 'self',
    item: 'S_CRAMPS (>= 60 min)',
    label: 'Cramps lasting 60 min or more',
    basis: `${SRC.NIOSH_ILL} (medical help if cramps do not subside within 1 hour)`,
  },
  headache: { tier: 2, observedBy: 'self', item: 'S_HEADACHE', label: 'Headache', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} Table 5-1` },
  dizziness: { tier: 2, observedBy: 'self', item: 'S_DIZZY', label: 'Dizziness', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} Table 5-1` },
  nausea: { tier: 2, observedBy: 'self', item: 'S_NAUSEA', label: 'Nausea', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} Table 5-1` },
  weakness_fatigue: { tier: 2, observedBy: 'self', item: 'S_WEAK', label: 'Weakness or unusual tiredness', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} Table 5-1` },
  fainted: { tier: 2, observedBy: 'self', item: 'S_FAINTED', label: 'Fainted (now alert)', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} §4-3c` },
  brown_urine: {
    tier: 2,
    observedBy: 'self',
    item: 'S_URINE_BROWN',
    label: 'Brown, red or cola-coloured urine',
    basis: `${SRC.NIOSH_ILL} (rhabdomyolysis: medical facility, creatine kinase test); ${SRC.TBMED} §5-4c`,
  },
  drank_a_lot: { tier: 0, observedBy: 'self', item: 'S_OVERDRINK_SX (part)', label: 'Drank a lot of water', basis: `${SRC.TBMED} §5-4b, §3-7h` },
  swollen_hands: { tier: 0, observedBy: 'self', item: 'S_OVERDRINK_SX (part)', label: 'Swollen hands or feet', basis: `${SRC.TBMED} §5-4b (extremity oedema)` },
  repeated_vomiting: { tier: 3, observedBy: 'self', item: 'S_VOMIT_REPEAT', label: 'Repeated vomiting', basis: `${SRC.TBMED} Table 5-1 (recurrent vomiting)` },
  chest_pain: {
    tier: 3,
    observedBy: 'self',
    item: 'S_CHEST',
    label: 'Chest pain or breathing difficulty',
    basis: `General emergency criterion [ENG]; ${SRC.TBMED} Table 5-3 and ${SRC.IOC21} (exclude a cardiac cause)`,
  },
  confusion: { tier: 3, observedBy: 'buddy', item: 'B_CONFUSED', label: 'Confused or acting strangely', basis: `${SRC.NIOSH_ILL}; ${SRC.OSHA_FA}; ${SRC.TBMED} Table 5-1, §4-6` },
  slurred_speech: { tier: 3, observedBy: 'buddy', item: 'B_SPEECH_GAIT', label: 'Slurred speech', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} §4-4; ${SRC.OSHA_FA}` },
  unsteady_walking: { tier: 3, observedBy: 'buddy', item: 'B_SPEECH_GAIT', label: 'Stumbling or cannot walk straight', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} §4-4; ${SRC.OSHA_FA}` },
  collapsed_unresponsive: { tier: 3, observedBy: 'buddy', item: 'B_UNRESPONSIVE', label: 'Collapsed or not responding', basis: `${SRC.NIOSH_ILL}; ${SRC.TBMED} Table 5-1` },
  seizure: { tier: 3, observedBy: 'buddy', item: 'B_SEIZURE', label: 'Seizure (fit)', basis: `${SRC.NIOSH_ILL} (seizures); ${SRC.TBMED} Table 5-1 (convulsions and/or seizures)` },
}

/**
 * Symptoms that, with over-drinking (self-reported "drank a lot" or logged intake above a cap), start the suspected
 * exercise-associated hyponatraemia path — TB MED 507 §5-4b ("headache, confusion, … nausea, and recurrent vomiting",
 * extremity oedema); physio_and_clinical.md §10.8; seizure per §5.4.
 */
export const HYPONATRAEMIA_SYMPTOMS: readonly SymptomId[] = [
  'headache',
  'nausea',
  'swollen_hands',
  'repeated_vomiting',
  'confusion',
  'seizure',
]

/**
 * Triage time rules — physio_and_clinical.md §10.7 and §5.2: re-check at +15 and +30 min; T2 not clearly improving at
 * 30 min → T3 ([ENG]; the cited outer limit is 60 min, TB MED 507 §5-1b); cramps lasting ≥ 60 min → T2 (CDC/NIOSH);
 * after +30 the re-checks continue every 15 min [ENG]; a check-in more than 60 min after the previous one starts a
 * new episode [ENG, TB MED 507 §5-1b first-hour window].
 */
export const TRIAGE_TIMING = {
  RECHECK_FIRST_MIN: 15,
  RECHECK_SECOND_MIN: 30,
  RECHECK_CONTINUE_EVERY_MIN: 15,
  NOT_IMPROVING_MIN: 30,
  CRAMPS_PERSISTENT_MIN: 60,
  EPISODE_LINK_MAX_GAP_MIN: 60,
} as const

// ─────────────────────────────── Triage ───────────────────────────────

/** Context for {@link triage}. */
export interface TriageContext {
  /** Consented risk flags; `oh_review_required` makes cramps T2 (it may stand for heart disease) [ENG, protective]. */
  riskFlags?: readonly RiskFlagId[]
  /** Heart disease or a low-sodium diet: CDC/NIOSH send cramps for medical help → T2. */
  crampsMedicalRisk?: boolean
  /** Logged intake above the hourly or daily cap ({@link fluidStatus}) — treated like a "drank a lot" report. */
  overFluidCap?: boolean
  /** Declared fasting hours in progress: no routine drink advice at T0 (symptoms always override). */
  fastingNow?: boolean
}

/** Result of {@link triage}. */
export interface TriageResult {
  tier: ClinicalTier
  level: RiskLevel
  /** Ordered actions (ActionId). */
  actions: ActionId[]
  /** T3 red-flag symptoms present. */
  redFlags: SymptomId[]
  /** Plain-language reasons (worker / first aider; clinical channel). */
  rationale: string[]
  /** Sources backing the result. */
  basis: string[]
  /** Minutes after this check-in when the next re-check is due; null at T0 and T3. */
  recheckAtMin: number | null
  /** Suspected exercise-associated hyponatraemia: plain water is stopped (`restrict_fluids`). */
  hyponatraemiaSuspected: boolean
  /** Time rule that raised the tier to T3, if any. */
  escalation: 'worsening' | 'not_improving_30min' | null
  /** Time of the first check-in of the current symptomatic episode; null when no episode is open. */
  episodeStartT: number | null
}

interface ScoreOptions {
  crampsMedicalRisk: boolean
  drankALot: boolean
  /** Compare like with like across re-checks: persistent cramps score as cramps [ENG]. */
  forTrend?: boolean
}

function scoreSymptoms(symptoms: readonly SymptomId[], o: ScoreOptions): { tier: ClinicalTier; hyponatraemia: boolean } {
  let tier: ClinicalTier = 0
  for (const s of symptoms) {
    let t = SYMPTOM_RULES[s].tier
    if (s === 'cramps' && o.crampsMedicalRisk) t = 2
    if (s === 'cramps_persistent' && o.forTrend === true) t = o.crampsMedicalRisk ? 2 : 1
    if (t > tier) tier = t
  }
  const hyponatraemia = o.drankALot && symptoms.some((s) => HYPONATRAEMIA_SYMPTOMS.includes(s))
  if (hyponatraemia && tier < 2) tier = 2
  return { tier, hyponatraemia }
}

/** Number of distinct T2+ warning symptoms reported (persistent cramps excluded: time-derived). */
function warningCount(symptoms: readonly SymptomId[]): number {
  return new Set(symptoms.filter((s) => s !== 'cramps_persistent' && SYMPTOM_RULES[s].tier >= 2)).size
}

/** Earlier symptomatic check-ins of the same episode, oldest first (same worker, same local day, ≤ 60-min links). */
function episodeBefore(current: Checkin, history: readonly Checkin[], crampsMedicalRisk: boolean): Checkin[] {
  const dayStart = localDayStartMs(current.t)
  const prior = history
    .filter((h) => h !== current && h.workerId === current.workerId && h.t < current.t && h.t >= dayStart)
    .sort((a, b) => a.t - b.t)
  const chain: Checkin[] = []
  let linkT = current.t
  for (let i = prior.length - 1; i >= 0; i--) {
    const h = prior[i]
    if (linkT - h.t > TRIAGE_TIMING.EPISODE_LINK_MAX_GAP_MIN * MINUTE_MS) break
    const drank = h.symptoms.includes('drank_a_lot')
    if (scoreSymptoms(h.symptoms, { crampsMedicalRisk, drankALot: drank }).tier === 0) break // symptom-free re-check
    chain.unshift(h)
    linkT = h.t
  }
  return chain
}

const hasCramps = (c: Checkin): boolean => c.symptoms.includes('cramps') || c.symptoms.includes('cramps_persistent')

/** Ordered actions for a clinical tier (shared by triage, fluid and hydration rules). */
function tierActions(tier: ClinicalTier, o: { restrictFluids: boolean; noDrinkAdvice: boolean }): ActionId[] {
  const drink: ActionId[] = o.restrictFluids ? ['restrict_fluids'] : o.noDrinkAdvice ? [] : ['drink_water']
  switch (tier) {
    case 3:
      return ['call_998', 'cool_first', 'stay_with_worker', 'first_aider_check', ...(o.restrictFluids ? (['restrict_fluids'] as ActionId[]) : [])]
    case 2:
      return ['stop_work', 'first_aider_check', 'stay_with_worker', 'rest_shade_now', 'cool_down', ...drink, 'medical_evaluation', 'symptom_checkin', 'no_hot_work_today']
    case 1:
      return ['rest_shade_now', 'cool_down', 'reduce_intensity', ...drink, 'electrolytes', 'symptom_checkin']
    default:
      return drink
  }
}

/**
 * Symptom check-in triage — physio_and_clinical.md §10.7 (table and time rules), §5.2 red flags, §5.4 when to call
 * 998; ACSM 2023, CDC/NIOSH, TB MED 507 (2022), OSHA, Sharjah OSHJ-CoP-33.
 * - Table: YES gives the tier, final = max ({@link SYMPTOM_RULES}); cramps with heart disease / low-sodium diet → T2.
 * - Over-drinking (`drank_a_lot` or logged intake over a cap) + headache, nausea, swelling or vomiting → T2 with
 *   `restrict_fluids` (suspected hyponatraemia, TB MED 507 §5-4b); + confusion or seizure → T3 (still restrict fluids).
 * - Cramps reported continuously for ≥ 60 min within the episode → `cramps_persistent` (T2).
 * - Urine shade 7–8 on the check-in → T1 (§10.7 S_URINE_DARK → §10.8).
 * - Time rules against the previous check-in of the episode: any worsening (reported "worse", a higher tier, or more
 *   T2+ warning symptoms) → T3 [ENG reading of "any worsening"]; a new T3 item → T3; T2 not clearly improving (trend
 *   not "better") ≥ 30 min after T2 began → T3 [ENG; TB MED 507 §5-1b outer limit 60 min]; re-check at +15/+30.
 * Never diagnoses: it maps reported signs to first-aid tiers.
 */
export function triage(checkin: Checkin, history: readonly Checkin[] = [], ctx: TriageContext = {}): TriageResult {
  const crampsMedicalRisk = ctx.crampsMedicalRisk === true || (ctx.riskFlags ?? []).includes('oh_review_required')
  const episode = episodeBefore(checkin, history, crampsMedicalRisk)
  const symptoms = new Set<SymptomId>(checkin.symptoms)
  const rationale: string[] = []
  const basis = new Set<string>()

  if (symptoms.has('cramps') && !symptoms.has('cramps_persistent')) {
    let onset = checkin.t
    for (let i = episode.length - 1; i >= 0 && hasCramps(episode[i]); i--) onset = episode[i].t
    if (checkin.t - onset >= TRIAGE_TIMING.CRAMPS_PERSISTENT_MIN * MINUTE_MS) {
      symptoms.add('cramps_persistent')
      rationale.push('Cramps have lasted 60 min or more across check-ins')
    }
  }

  const list = [...symptoms]
  const drankALot = symptoms.has('drank_a_lot') || ctx.overFluidCap === true
  const scored = scoreSymptoms(list, { crampsMedicalRisk, drankALot })
  let tier = scored.tier

  for (const s of list) {
    const rule = SYMPTOM_RULES[s]
    const t: ClinicalTier = s === 'cramps' && crampsMedicalRisk ? 2 : rule.tier
    if (t === 0 && s !== 'thirst') continue
    if (s === 'cramps' && symptoms.has('cramps_persistent')) continue
    rationale.push(`${rule.label}: ${CLINICAL_TIER_LABEL[t]}${s === 'cramps' && t === 2 ? ' (heart disease, low-sodium diet or occupational-health flag)' : ''}`)
    basis.add(rule.basis)
    if (s === 'cramps' && t === 2) basis.add(`${SRC.NIOSH_ILL} (cramps with heart problems or a low-sodium diet: medical help)`)
  }
  if (scored.hyponatraemia) {
    rationale.push('Drank a lot of water and has headache, nausea, swelling, vomiting or confusion: suspected over-hydration (hyponatraemia) - stop plain water')
    basis.add(`${SRC.TBMED} §5-4b ("If EAH is suspected, restrict fluids"); ${SRC.WMS19}`)
  }
  if (checkin.urineColor !== undefined) {
    const u = urineAssessment(checkin.urineColor)
    if (u.tier !== null && u.tier >= 1) {
      if (u.tier > tier) tier = u.tier
      rationale.push(`Urine shade ${checkin.urineColor}: ${u.advice}`)
      u.basis.forEach((b) => basis.add(b))
    }
  }

  // Time rules (§10.7)
  let escalation: TriageResult['escalation'] = null
  const prev = episode.length > 0 ? episode[episode.length - 1] : undefined
  const trendOpts = { crampsMedicalRisk, forTrend: true }
  const trendNow = scoreSymptoms(list, { ...trendOpts, drankALot }).tier
  const trendPrev = prev ? scoreSymptoms(prev.symptoms, { ...trendOpts, drankALot: prev.symptoms.includes('drank_a_lot') }).tier : 0
  const reportedWorse = checkin.trend === 'worse' && Math.max(tier, trendPrev) >= 1
  const objectivelyWorse = prev !== undefined && (trendNow > trendPrev || warningCount(list) > warningCount(prev.symptoms))
  if (tier < 3 && (reportedWorse || objectivelyWorse)) {
    tier = 3
    escalation = 'worsening'
    rationale.push('Worse than at the last check: emergency - call 998 and cool first')
    basis.add(`${SRC.TBMED} §5-1b; ${SRC.OSHA_FA}; physio_and_clinical.md §10.7 (any worsening gives T3)`)
  }
  if (tier === 2) {
    const t2Onset = [...episode, checkin].find((c) =>
      c === checkin ? true : scoreSymptoms(c.symptoms, { crampsMedicalRisk, drankALot: c.symptoms.includes('drank_a_lot') }).tier >= 2,
    )?.t
    if (
      t2Onset !== undefined &&
      checkin.t - t2Onset >= TRIAGE_TIMING.NOT_IMPROVING_MIN * MINUTE_MS &&
      checkin.trend !== 'better'
    ) {
      tier = 3
      escalation = 'not_improving_30min'
      rationale.push('Not clearly improving 30 min after stopping work and cooling: emergency - call 998')
      basis.add(`${SRC.TBMED} §5-1b (improvement expected within the first hour); ${SRC.SPSA24}; 30 min [ENG]`)
    }
  }

  if (tier === 0 && rationale.length === 0) rationale.push('No warning symptoms reported: continue with precautions')
  if (tier === 3) basis.add(`${SRC.ILCOR19}; ${SRC.TBMED} §5-1b (cool first, transport second)`)

  const restrictFluids = scored.hyponatraemia
  const noDrinkAdvice = drankALot || (tier === 0 && ctx.fastingNow === true)
  const actions = tierActions(tier, { restrictFluids, noDrinkAdvice })
  if (tier === 0 && drankALot) actions.push('electrolytes')

  const episodeStartT = tier >= 1 || episode.length > 0 ? (episode[0]?.t ?? checkin.t) : null
  let recheckAtMin: number | null = null
  if (tier === 1 || tier === 2) {
    const elapsed = (checkin.t - (episodeStartT ?? checkin.t)) / MINUTE_MS
    const raw =
      elapsed < TRIAGE_TIMING.RECHECK_FIRST_MIN
        ? TRIAGE_TIMING.RECHECK_FIRST_MIN - elapsed
        : elapsed < TRIAGE_TIMING.RECHECK_SECOND_MIN
          ? TRIAGE_TIMING.RECHECK_SECOND_MIN - elapsed
          : TRIAGE_TIMING.RECHECK_CONTINUE_EVERY_MIN
    recheckAtMin = Math.max(1, Math.ceil(raw - 1e-9))
  }

  return {
    tier,
    level: TIER_TO_LEVEL[tier],
    actions,
    redFlags: list.filter((s) => SYMPTOM_RULES[s].tier === 3),
    rationale,
    basis: [...basis],
    recheckAtMin,
    hyponatraemiaSuspected: scored.hyponatraemia,
    escalation,
    episodeStartT,
  }
}

// ─────────────────────────────── Unanswered prompts ───────────────────────────────

/**
 * Unanswered check-in escalation — physio_and_clinical.md §4.3 item 6 and §10.7: a prompt unanswered for 5 min while the
 * level is T1 (high) or above notifies the buddy, then the supervisor [ENG]. The supervisor step at 10 min (a second
 * 5-min interval) is [ENG]. Prompts raised by a physiology advisory escalate at any level [ENG, protective].
 */
export const PROMPT_TIMEOUT = { BUDDY_AFTER_MIN: 5, SUPERVISOR_AFTER_MIN: 10 } as const

/** Result of {@link promptTimeout}. */
export interface PromptTimeoutResult {
  notify: Array<'buddy' | 'supervisor'>
  /** Minutes past the buddy deadline (0 when not overdue or not applicable). */
  overdueMin: number
  /** When the next escalation step falls due; null when none remains or none applies. */
  nextEscalationAtMs: number | null
}

/** Escalation for an unanswered check-in prompt — see {@link PROMPT_TIMEOUT} (physio_and_clinical.md §4.3 item 6, §10.7). */
export function promptTimeout(
  promptedAtMs: number,
  nowMs: number,
  opts: { answered?: boolean; level: RiskLevel; raisedByWarning?: boolean },
): PromptTimeoutResult {
  const applies = opts.answered !== true && (RISK_ORDER[opts.level] >= RISK_ORDER.high || opts.raisedByWarning === true)
  if (!applies) return { notify: [], overdueMin: 0, nextEscalationAtMs: null }
  const elapsedMin = (nowMs - promptedAtMs) / MINUTE_MS
  const notify: Array<'buddy' | 'supervisor'> = []
  if (elapsedMin >= PROMPT_TIMEOUT.BUDDY_AFTER_MIN) notify.push('buddy')
  if (elapsedMin >= PROMPT_TIMEOUT.SUPERVISOR_AFTER_MIN) notify.push('supervisor')
  const nextEscalationAtMs =
    elapsedMin < PROMPT_TIMEOUT.BUDDY_AFTER_MIN
      ? promptedAtMs + PROMPT_TIMEOUT.BUDDY_AFTER_MIN * MINUTE_MS
      : elapsedMin < PROMPT_TIMEOUT.SUPERVISOR_AFTER_MIN
        ? promptedAtMs + PROMPT_TIMEOUT.SUPERVISOR_AFTER_MIN * MINUTE_MS
        : null
  return { notify, overdueMin: Math.max(0, elapsedMin - PROMPT_TIMEOUT.BUDDY_AFTER_MIN), nextEscalationAtMs }
}

// ─────────────────────────────── First aid ───────────────────────────────

/**
 * UAE emergency numbers — u.ae official portal ("Last updated 01 Oct 2026"; re-verify each release),
 * physio_and_clinical.md §5.5 / §10.10. Zill's emergency screen calls 998 first and offers 999 as the fallback [ENG].
 */
export const UAE_EMERGENCY = {
  AMBULANCE: '998',
  POLICE: '999',
  CIVIL_DEFENCE: '997',
  COASTGUARD: '996',
  SEARCH_RESCUE: '995',
  ELECTRICITY: '991',
  AD_SMS_PEOPLE_OF_DETERMINATION: '5999',
  AD_APP: 'AD999',
} as const

/**
 * Cooling constants — "cool first, transport second" (TB MED 507 §5-1b: "Do not delay cooling for want of rectal
 * temperature"): whole-body neck-down immersion in water 1–26 °C (ILCOR 2019); rotate ice-water towels every 1–2 min
 * (IOC 2021); without a thermometer stop immersion after about 15 min or when symptoms resolve (ILCOR 2019: "for a
 * reasonable amount of time, such as 15 minutes"); harm rises when cooling is delayed beyond 30 min (NATA; Bv18).
 * Fluids only if fully alert; never leave the worker alone (physio_and_clinical.md §5.3, §10.10).
 */
export const FIRST_AID = {
  IMMERSION_WATER_MIN_C: 1,
  IMMERSION_WATER_MAX_C: 26,
  TOWEL_ROTATE_MIN_MIN: 1,
  TOWEL_ROTATE_MAX_MIN: 2,
  IMMERSION_STOP_WITHOUT_THERMOMETER_MIN: 15,
  COOLING_DELAY_LIMIT_MIN: 30,
  FLUIDS_ONLY_IF_FULLY_ALERT: true,
  NEVER_LEAVE_ALONE: true,
} as const

/** One step of the T3 first-aid protocol. */
export interface FirstAidStep {
  order: number
  id: 'call_998' | 'shade_undress' | 'immerse' | 'douse_or_towels' | 'continue_until_ems' | 'fluids_if_alert'
  text: string
  basis: string
}

/**
 * Ordered lay-rescuer cooling protocol for the T3 screen — physio_and_clinical.md §10.10 and §5.3 (built [ENG] from
 * ILCOR 2019, TB MED 507 2022, IOC 2021, OSHA and NATA). Cool first, transport second.
 */
export const COOLING_PROTOCOL: readonly FirstAidStep[] = [
  {
    order: 1,
    id: 'call_998',
    text: `Call ${UAE_EMERGENCY.AMBULANCE} and alert the first aider and supervisor.`,
    basis: `${SRC.OSHA_FA} ("When in doubt, cool the worker and call 911"); u.ae emergency numbers`,
  },
  { order: 2, id: 'shade_undress', text: 'Move the worker to shade and remove outer clothing.', basis: SRC.NIOSH_ILL },
  {
    order: 3,
    id: 'immerse',
    text: 'Cool now, best method first: ice-water immersion or a tarp (TACO), neck down, water 1-26 °C, keep the water stirred.',
    basis: `${SRC.ILCOR19} (whole-body neck-down immersion, 1-26 °C); ${SRC.TBMED} Table 5-2`,
  },
  {
    order: 4,
    id: 'douse_or_towels',
    text: 'If immersion is not possible: continuous cold-water dousing plus fanning, or rotating ice-water towels every 1-2 min plus ice packs (including cheeks, palms and soles).',
    basis: `${SRC.ILCOR19}; ${SRC.IOC21} (towels every 1-2 min); ${SRC.TBMED} §5-1b`,
  },
  {
    order: 5,
    id: 'continue_until_ems',
    text: 'Keep cooling until the ambulance team takes over. Without a thermometer, stop ice-water immersion after about 15 min or as soon as the worker is alert and oriented, then keep dousing and fanning.',
    basis: `${SRC.ILCOR19} ("for a reasonable amount of time, such as 15 minutes")`,
  },
  {
    order: 6,
    id: 'fluids_if_alert',
    text: 'Give sips of fluid only if the worker is fully alert and not vomiting; if not alert, use the recovery position. Never leave the worker alone.',
    basis: `${SRC.TBMED} §5-1b; ${SRC.NIOSH_ILL} (stay with the worker)`,
  },
]

// ─────────────────────────────── Urine colour ───────────────────────────────

/** Urine-colour codes (physio_and_clinical.md §6, §10.8; names as in the reference fixtures). */
export type UrineCode = 'U_OK' | 'U_DRINK_MORE' | 'U_DEHYDRATED' | 'U_VERY_DARK' | 'U_BROWN_RED' | 'U_INVALID'

/** Result of {@link urineAssessment}. */
export interface UrineAssessment {
  code: UrineCode
  /** Tier floor; null when the reading is invalid. */
  tier: ClinicalTier | null
  /** Tier if the same result persists at the next reading (shades 5–6 → T1). */
  escalateIfPersists: ClinicalTier | null
  advice: string
  basis: string[]
}

/**
 * Urine colour on the Armstrong 8-shade chart — physio_and_clinical.md §10.8 and §6: brown/red/cola → T2 (possible
 * rhabdomyolysis or blood: CDC/NIOSH; TB MED 507 §5-4c); 1–3 OK (NIOSH 2016 App. B; Armstrong 1994); 4 drink more
 * (Kavouras 2016 threshold ≥ 4; Armstrong 2010); 5–6 dehydrated, T0 → T1 if still ≥ 5 at the next reading (McKenzie
 * 2015: ≥ 5 identified ≥ 2 % body-mass loss, sensitivity 88.9 %, specificity 84.8 %); 7–8 → T1 (McKenzie 2015;
 * Armstrong 1998). Never drives drink advice above the fluid caps.
 */
export function urineAssessment(
  shade: number | null | undefined,
  brownRedCola = false,
  previousShade?: number | null,
): UrineAssessment {
  if (brownRedCola) {
    return {
      code: 'U_BROWN_RED',
      tier: 2,
      escalateIfPersists: null,
      advice: 'Not a hydration colour: stop work and see the first aider - medical facility this shift (creatine kinase test)',
      basis: [`${SRC.NIOSH_ILL} (rhabdomyolysis)`, `${SRC.TBMED} §5-4c`, `${SRC.NIOSH16} Table B-1`],
    }
  }
  if (shade === null || shade === undefined || !Number.isInteger(shade) || shade < 1 || shade > 8) {
    return { code: 'U_INVALID', tier: null, escalateIfPersists: null, advice: 'Pick the closest colour under daylight or white light', basis: [] }
  }
  if (shade <= 3) {
    return { code: 'U_OK', tier: 0, escalateIfPersists: null, advice: 'Good - keep drinking regularly', basis: [`${SRC.NIOSH16} Appendix B`, 'Armstrong et al. 1994 Int J Sport Nutr 4:265'] }
  }
  if (shade === 4) {
    return {
      code: 'U_DRINK_MORE',
      tier: 0,
      escalateIfPersists: null,
      advice: 'Drink a cup of water now and at every break',
      basis: ['Kavouras et al. 2016 Eur J Nutr 55:907 (threshold >= 4)', 'Armstrong et al. 2010 Int J Sport Nutr Exerc Metab 20:145 (reference values)'],
    }
  }
  if (shade <= 6) {
    const persists = typeof previousShade === 'number' && previousShade >= 5 && previousShade <= 8
    return {
      code: 'U_DEHYDRATED',
      tier: persists ? 1 : 0,
      escalateIfPersists: 1,
      advice: persists
        ? 'Still dark: rest in shade, drink 1 cup every 15-20 min and tell the supervisor'
        : 'Probably low on water: drink 1 cup every 15-20 min, rest in shade, check again at the next toilet visit',
      basis: ['McKenzie et al. 2015 J Athl Train 50:1306 (shade >= 5)'],
    }
  }
  return {
    code: 'U_VERY_DARK',
    tier: 1,
    escalateIfPersists: null,
    advice: 'Very dark: rest, cool down, drink and tell the supervisor; report any symptom in the check-in',
    basis: ['McKenzie et al. 2015 J Athl Train 50:1306 (shade >= 5)', 'Armstrong et al. 1998 Int J Sport Nutr 8:345'],
  }
}

// ─────────────────────────────── Fluids ───────────────────────────────

/** US liquid quart in litres (exact by definition: 57.75 in³). */
export const US_QUART_L = 0.946352946
/** US fluid ounce in litres (exact by definition). */
export const US_FL_OZ_L = 0.0295735295625

/**
 * Fluid limits — physio_and_clinical.md §10.8 and §8: hourly cap 1.5 US qt ≈ 1.4195 L/h (TB MED 507 Tables 3-2/3-3
 * "CAUTION: Hourly fluid intake should not exceed 1 1/2 qt"; NIOSH 2016); daily cap 12 US qt ≈ 11.356 L (TB MED 507
 * Table 3-6 note); cup 8 US fl oz, "1 cup every 15-20 min" (NIOSH 2016 executive summary); reminder 250 mL every
 * 20 min = 0.75 L/h [ENG]; electrolyte drink after 120 min of sweating (NIOSH 2016 "prolonged sweating lasting several
 * hours"; value [ENG]). Caps computed from the exact US-quart definition (equal to the oracle's values).
 */
export const FLUID = {
  HOURLY_CAP_L: 1.5 * US_QUART_L,
  DAILY_CAP_L: 12 * US_QUART_L,
  CUP_L: 8 * US_FL_OZ_L,
  REMINDER_L: 0.25,
  REMINDER_EVERY_MIN: 20,
  ELECTROLYTE_AFTER_MIN: 120,
} as const

/** Fluid-cap flags (names as in the reference fixtures). */
export type FluidFlag = 'OVER_HOURLY_CAP' | 'OVER_DAILY_CAP'

/**
 * Cap check — physio_and_clinical.md §10.8: rolling 60-min intake > HOURLY_CAP_L → OVER_HOURLY_CAP (stop drink
 * reminders, "slow down"); today's intake > DAILY_CAP_L → OVER_DAILY_CAP (warn, T1); no drink reminders while fasting
 * or over the hourly cap (TB MED 507 2022; NIOSH 2016).
 */
export function fluidCapCheck(rolling60L: number, todayL: number, fastingNow = false): { flags: FluidFlag[]; sendDrinkReminders: boolean } {
  const flags: FluidFlag[] = []
  if (rolling60L > FLUID.HOURLY_CAP_L) flags.push('OVER_HOURLY_CAP')
  if (todayL > FLUID.DAILY_CAP_L) flags.push('OVER_DAILY_CAP')
  return { flags, sendDrinkReminders: !fastingNow && !flags.includes('OVER_HOURLY_CAP') }
}

/** Context for {@link fluidStatus}. */
export interface FluidContext {
  /** Declared fasting hours in progress: no drink reminders (physio_and_clinical.md §7 fasting row). */
  fastingNow?: boolean
  /** Start of the current continuous sweating (hot-work) bout, epoch ms. */
  sweatingSinceMs?: number | null
  /** Symptoms from the latest check-in, for the hyponatraemia path. */
  symptoms?: readonly SymptomId[]
  /** Count only this worker's intakes. */
  workerId?: string
}

/** Result of {@link fluidStatus}. */
export interface FluidStatus {
  rolling60L: number
  todayL: number
  flags: FluidFlag[]
  sendDrinkReminders: boolean
  /** When the next 250 mL reminder is due (≤ now means due now); null when reminders are suppressed. */
  nextReminderAtMs: number | null
  reminderMl: number
  /** An electrolyte drink is suggested (≥ 120 min of continuous sweating). */
  electrolyteDue: boolean
  /** 0; 1 over the daily cap; 2 suspected hyponatraemia; 3 with confusion or seizure. */
  tier: ClinicalTier
  hyponatraemiaSuspected: boolean
  actions: ActionId[]
  /** Worker-facing message, e.g. the "slow down" warning. */
  message: string | null
  basis: string[]
}

const SLOW_DOWN_MESSAGE = 'Slow down - too much water can be dangerous. Eat salty food or use an electrolyte drink.'

/**
 * Fluid status from the intake log — physio_and_clinical.md §10.8 and §8 (TB MED 507 2022; NIOSH 2016):
 * rolling 60-min and local-day totals vs the caps; over the hourly cap → reminders stop and "slow down" is shown;
 * over the daily cap → warning, T1; over either cap with headache, nausea, swelling or vomiting → suspected
 * hyponatraemia, T2 with `restrict_fluids` (confusion or seizure → T3); reminders of 250 mL every 20 min otherwise
 * [ENG], none while fasting; an electrolyte drink after 120 min of sweating, never salt tablets (TB MED 507 §3-7;
 * NIOSH 2016).
 */
export function fluidStatus(intakes: readonly FluidIntake[], now: number, ctx: FluidContext = {}): FluidStatus {
  const dayStart = localDayStartMs(now)
  let rollingMl = 0
  let todayMl = 0
  let lastT: number | null = null
  for (const i of intakes) {
    if (ctx.workerId !== undefined && i.workerId !== ctx.workerId) continue
    if (!(i.t <= now) || !(i.ml > 0)) continue
    if (i.t > now - 60 * MINUTE_MS) rollingMl += i.ml
    if (i.t >= dayStart) todayMl += i.ml
    if (lastT === null || i.t > lastT) lastT = i.t
  }
  const rolling60L = rollingMl / 1000
  const todayL = todayMl / 1000
  const cap = fluidCapCheck(rolling60L, todayL, ctx.fastingNow === true)
  const overHourly = cap.flags.includes('OVER_HOURLY_CAP')
  const overDaily = cap.flags.includes('OVER_DAILY_CAP')
  const symptoms = ctx.symptoms ?? []
  const hyponatraemiaSuspected = (overHourly || overDaily) && symptoms.some((s) => HYPONATRAEMIA_SYMPTOMS.includes(s))
  const severe = hyponatraemiaSuspected && (symptoms.includes('confusion') || symptoms.includes('seizure'))
  const tier: ClinicalTier = severe ? 3 : hyponatraemiaSuspected ? 2 : overDaily ? 1 : 0
  const basis = [`${SRC.TBMED} Tables 3-2, 3-3, 3-6`, SRC.NIOSH16]
  const nextReminderAtMs = cap.sendDrinkReminders ? (lastT === null ? now : Math.max(now, lastT + FLUID.REMINDER_EVERY_MIN * MINUTE_MS)) : null
  const electrolyteDue =
    typeof ctx.sweatingSinceMs === 'number' && now - ctx.sweatingSinceMs >= FLUID.ELECTROLYTE_AFTER_MIN * MINUTE_MS

  const actions = new Set<ActionId>()
  let message: string | null = null
  if (hyponatraemiaSuspected) {
    tierActions(tier, { restrictFluids: true, noDrinkAdvice: true }).forEach((a) => actions.add(a))
    message = 'Stop drinking plain water now and see the first aider.'
    basis.push(`${SRC.TBMED} §5-4b`, SRC.WMS19)
  } else {
    if (overHourly || overDaily) {
      actions.add('electrolytes')
      message = SLOW_DOWN_MESSAGE
    }
    if (overDaily) actions.add('symptom_checkin')
    if (nextReminderAtMs !== null && nextReminderAtMs <= now) actions.add('drink_water')
    if (electrolyteDue) actions.add('electrolytes')
  }
  return {
    rolling60L,
    todayL,
    flags: cap.flags,
    sendDrinkReminders: cap.sendDrinkReminders,
    nextReminderAtMs,
    reminderMl: FLUID.REMINDER_L * 1000,
    electrolyteDue,
    tier,
    hyponatraemiaSuspected,
    actions: [...actions],
    message,
    basis,
  }
}

// ─────────────────────────────── Risk flags and conservative mode ───────────────────────────────

/** How Zill handles one self-declared risk flag. */
export interface RiskFlagHandling {
  conservativeMode: boolean
  /** Disables every heart-rate rule (ECTemp, PSI, HR limit). */
  disablesPhysiology: boolean
  /** Prompts a confidential occupational-health (or pharmacist) review. */
  ohReview: boolean
  handling: string
  workerMessage: string
  basis: string
}

/**
 * Risk-flag handling table — physio_and_clinical.md §7 and §10.9. Flags are booleans, never summed into a score
 * (TB MED 507 §4-2: "the desire to 'score' risk factors … is not recommended"). Visible only to the worker and
 * occupational health; supervisors see only the resulting actions.
 */
export const RISK_FLAG_HANDLING: Record<RiskFlagId, RiskFlagHandling> = {
  prior_heat_illness: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: true,
    handling: 'Conservative mode and occupational-health review; after exertional heat stroke, medical clearance before hot work',
    workerMessage: 'Because you had heat illness before, Zill uses safer limits for you.',
    basis: `${SRC.TBMED} §5-5 and EHS series (prior EHI in 20 % of EHS cases); ${SRC.NIOSH16} (history increases repeat risk)`,
  },
  heat_sensitive_medication: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: true,
    handling: 'Conservative mode; occupational-health or pharmacist review (drug not named on the device)',
    workerMessage: 'Do not stop your medicine; ask your doctor.',
    basis: `${SRC.TBMED} Table 4-2; ${SRC.NIOSH16} Table 4-2; CDC Heat and Medications guidance (2025)`,
  },
  hr_suppressing_medication: {
    conservativeMode: true,
    disablesPhysiology: true,
    ohReview: true,
    handling: 'Conservative mode; ECTemp, PSI and heart-rate limits disabled (heart rate does not reflect heat strain)',
    workerMessage: 'Do not stop your medicine. Zill will not use your heart rate and relies on weather, work and check-ins.',
    basis: `${SRC.NIOSH16}; Wonisch et al. 2003 Eur J Cardiovasc Prev Rehabil 10:296 (beta-blockade); physio_and_clinical.md §4.3 item 4 [ENG policy]`,
  },
  recent_illness: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: false,
    handling: 'Fever, vomiting or diarrhoea in the last 3 days [ENG window]: conservative mode; supervisor or occupational health decides on hot work today',
    workerMessage: 'Recent illness raises heat risk. Tell your supervisor before hot work.',
    basis: `${SRC.TBMED} (30 % of EHS cases had a recent infection); ${SRC.NIOSH16} (low-grade infection, diarrhoea may contraindicate exposure)`,
  },
  poor_sleep: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: false,
    handling: 'Conservative mode for the shift (evidence is mixed)',
    workerMessage: 'After a bad night, take extra breaks in the shade.',
    basis: `${SRC.TBMED} ("may weaken resistance"); ${SRC.NIOSH16} ("sleepless night"); evidence mixed (Moore 2013; Renberg 2018)`,
  },
  fasting: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: false,
    handling: 'Conservative mode; no drink reminders during declared fasting hours; shade, rest and cooling; heavy work early or after iftar where possible; symptoms always override (first aid comes first). Zill gives no religious rulings [ENG]',
    workerMessage: 'While you fast, rest in the shade often. If you feel unwell, first aid comes first.',
    basis: 'Manjunath et al. 2019 East Mediterr Health J 25:34 (Gulf smelter workers in Ramadan); Leiper & Molla 2003 Eur J Clin Nutr 57 S2',
  },
  heat_rash_sunburn: {
    conservativeMode: true,
    disablesPhysiology: false,
    ohReview: false,
    handling: 'Conservative mode for the day (impaired sweating)',
    workerMessage: 'Heat rash or sunburn makes it harder to cool down. Zill uses safer limits today.',
    basis: `${SRC.TBMED} §4-2g (miliaria rubra or sunburn impairs sweating)`,
  },
  oh_review_required: {
    conservativeMode: false,
    disablesPhysiology: false,
    ohReview: true,
    handling: 'Confidential occupational-health review (age >= 50, obesity, prior EHS, cardiac disease, pregnancy, sickle-cell trait); conservative mode at OH discretion; cramps treated as T2 [ENG]',
    workerMessage: 'Occupational health will talk with you confidentially about working in the heat.',
    basis: `${SRC.NIOSH16} (extra medical evaluation over 50 or with cardiac risk; obesity 3.5x heat disorders); ${SRC.TBMED} Tables 4-1, 5-3`,
  },
}

/**
 * Conservative-mode settings — physio_and_clinical.md §10.9 and §7: new workers for their first 14 days and workers
 * returning after ≥ 7 days away (OSHA new-worker guidance citing Tustin 2018; NIOSH 2016); effects: ECTemp T1 at
 * 38.0 °C, check-ins every 30 min from 'caution', buddy mandatory, next-stricter environment tier (RAL) [ENG].
 */
export const CONSERVATIVE_MODE = {
  NEW_WORKER_DAYS: 14,
  RETURNING_AWAY_DAYS: 7,
  ECTEMP_T1_C: 38.0,
  CHECKIN_EVERY_MIN: 30,
  CHECKIN_FROM_LEVEL: 'caution',
  BUDDY_MANDATORY: true,
} as const

/** Why conservative mode is on. */
export type ConservativeReason = RiskFlagId | 'new_worker_14d' | 'returning_after_absence' | 'heat_rash_today'

/** Result of {@link conservativeMode}. */
export interface ConservativeModeResult {
  conservative: boolean
  /** `hr_suppressing_medication`: every heart-rate rule is off. */
  physioDisabled: boolean
  reasons: ConservativeReason[]
  /** ECTemp T1 threshold to use (38.0 °C conservative, else 38.4 °C). */
  ectempT1C: number
  /** Check-in cadence when conservative; null otherwise. */
  checkinEveryMin: number | null
  /** Environment level from which conservative check-ins start; null otherwise. */
  checkinFromLevel: RiskLevel | null
  buddyMandatory: boolean
  /** Use the RAL (unacclimatised limit) and the next-stricter work/rest tier. */
  stricterEnvironment: boolean
}

/** Context for {@link conservativeMode}. */
export interface ConservativeModeContext {
  /** Symptoms reported in today's check-ins (heat rash today → conservative for the day). */
  symptomsToday?: readonly SymptomId[]
}

/**
 * True when the worker declared an HR-suppressing medication (beta-blockers, pacemaker…): ECTemp, PSI and HR rules are
 * disabled — physio_and_clinical.md §10.9 and §4.3 item 4 (NIOSH 2016; Wonisch 2003) [ENG policy].
 */
export function physioDisabled(profile: Pick<WorkerProfile, 'riskFlags'>): boolean {
  return profile.riskFlags.includes('hr_suppressing_medication')
}

/**
 * Conservative mode — physio_and_clinical.md §10.9 and §7: any risk flag except `oh_review_required`, the first 14 days
 * on the job, a return after ≥ 7 days away, or heat rash reported today. Flags are booleans and never summed
 * (TB MED 507 §4-2).
 */
export function conservativeMode(
  profile: Pick<WorkerProfile, 'riskFlags' | 'daysOnSite'> & Partial<Pick<WorkerProfile, 'daysAwayRecent'>>,
  ctx: ConservativeModeContext = {},
): ConservativeModeResult {
  const reasons: ConservativeReason[] = profile.riskFlags.filter((f) => RISK_FLAG_HANDLING[f].conservativeMode)
  if (profile.daysOnSite < CONSERVATIVE_MODE.NEW_WORKER_DAYS) reasons.push('new_worker_14d')
  if ((profile.daysAwayRecent ?? 0) >= CONSERVATIVE_MODE.RETURNING_AWAY_DAYS) reasons.push('returning_after_absence')
  if ((ctx.symptomsToday ?? []).includes('heat_rash') && !reasons.includes('heat_rash_sunburn')) reasons.push('heat_rash_today')
  const conservative = reasons.length > 0
  return {
    conservative,
    physioDisabled: physioDisabled(profile),
    reasons,
    ectempT1C: conservative ? CONSERVATIVE_MODE.ECTEMP_T1_C : 38.4,
    checkinEveryMin: conservative ? CONSERVATIVE_MODE.CHECKIN_EVERY_MIN : null,
    checkinFromLevel: conservative ? CONSERVATIVE_MODE.CHECKIN_FROM_LEVEL : null,
    buddyMandatory: conservative && CONSERVATIVE_MODE.BUDDY_MANDATORY,
    stricterEnvironment: conservative,
  }
}

// ─────────────────────────────── Channels ───────────────────────────────

/** Inputs for {@link symptomsChannel}. */
export interface SymptomsChannelInput {
  now: number
  /** The worker's check-ins (any order); only today's (local day) up to `now` are used. */
  checkins: readonly Checkin[]
  /** consent.checkins. Without it, only reports made by a buddy, supervisor or first aider are used. */
  consented: boolean
  ctx?: TriageContext
  workerId?: string
}

/** Symptoms channel result: a {@link ChannelResult} plus tier, actions and the full triage. */
export interface SymptomsChannelResult extends ChannelResult {
  channel: 'symptoms'
  tier: ClinicalTier
  actions: ActionId[]
  triage: TriageResult | null
}

function todaysCheckins(checkins: readonly Checkin[], now: number, consented: boolean, workerId?: string): Checkin[] {
  const dayStart = localDayStartMs(now)
  return checkins
    .filter((c) => c.t <= now && c.t >= dayStart && (workerId === undefined || c.workerId === workerId))
    .filter((c) => consented || c.by !== 'self')
    .sort((a, b) => a.t - b.t)
}

/**
 * Symptoms channel — ARCHITECTURE.md §5 and physio_and_clinical.md §10.7: {@link triage} of the latest check-in today
 * (self or buddy) with the earlier ones as its episode history, mapped with TIER_TO_LEVEL: T3 → emergency,
 * T2 → stop, T1 → high. Urine colour is left to the hydration channel. Self check-ins need consent; reports by a buddy,
 * supervisor or first aider are always used (vital interest) [ENG]. No check-in today → unavailable.
 */
export function symptomsChannel(input: SymptomsChannelInput): SymptomsChannelResult {
  const list = todaysCheckins(input.checkins, input.now, input.consented, input.workerId)
  if (list.length === 0) {
    return {
      channel: 'symptoms',
      level: 'safe',
      available: false,
      drivers: [{ id: 'no_checkin_today', channel: 'symptoms', text: 'No check-in today', direction: 'info', basis: 'physio_and_clinical.md §10.7' }],
      tier: 0,
      actions: [],
      triage: null,
    }
  }
  const latest = list[list.length - 1]
  const tr = triage({ ...latest, urineColor: undefined }, list.slice(0, -1), input.ctx ?? {})
  const drivers: RiskDriver[] = []
  for (const s of tr.redFlags) {
    drivers.push({ id: `symptom_${s}`, channel: 'symptoms', text: `Red flag: ${SYMPTOM_RULES[s].label}`, direction: 'raises', basis: SYMPTOM_RULES[s].basis })
  }
  for (const s of latest.symptoms) {
    const rule = SYMPTOM_RULES[s]
    if (rule.tier === 3 || (rule.tier === 0 && s !== 'thirst')) continue
    drivers.push({ id: `symptom_${s}`, channel: 'symptoms', text: rule.label, direction: rule.tier >= 1 ? 'raises' : 'info', basis: rule.basis })
  }
  if (tr.hyponatraemiaSuspected) {
    drivers.push({ id: 'suspected_hyponatraemia', channel: 'symptoms', text: 'Over-drinking with symptoms: stop plain water', direction: 'raises', basis: `${SRC.TBMED} §5-4b` })
  }
  if (tr.escalation !== null) {
    drivers.push({
      id: tr.escalation === 'worsening' ? 'symptoms_worsening' : 'symptoms_not_improving_30min',
      channel: 'symptoms',
      text: tr.escalation === 'worsening' ? 'Worse than at the last check' : 'Not clearly improving after 30 min',
      direction: 'raises',
      basis: `${SRC.TBMED} §5-1b; physio_and_clinical.md §10.7`,
    })
  }
  if (tr.tier === 0 && drivers.length === 0) {
    drivers.push({ id: 'no_symptoms', channel: 'symptoms', text: 'No warning symptoms reported', direction: 'info', basis: 'physio_and_clinical.md §10.7' })
  }
  return { channel: 'symptoms', level: tr.level, available: true, drivers, tier: tr.tier, actions: tr.actions, triage: tr }
}

/** Inputs for {@link hydrationChannel}. */
export interface HydrationChannelInput {
  now: number
  checkins: readonly Checkin[]
  intakes: readonly FluidIntake[]
  /** consent.checkins (covers hydration logs). */
  consented: boolean
  fastingNow?: boolean
  sweatingSinceMs?: number | null
  workerId?: string
}

/** Hydration channel result: a {@link ChannelResult} plus tier, actions and the urine/fluid detail. */
export interface HydrationChannelResult extends ChannelResult {
  channel: 'hydration'
  tier: ClinicalTier
  actions: ActionId[]
  urine: UrineAssessment | null
  fluid: FluidStatus
}

/**
 * Hydration channel — ARCHITECTURE.md §5; physio_and_clinical.md §6, §8, §10.8: latest urine shade today 1–3 OK,
 * 4 drink more (driver only), 5–6 → caution (→ high if still ≥ 5 at the next reading), 7–8 → high (Armstrong 8-shade
 * chart; McKenzie 2015); logged intake over the hourly cap (1.42 L/h) stops reminders and shows "slow down"; over the
 * daily cap (11.36 L) → high; over a cap with symptoms → stop with `restrict_fluids` (suspected hyponatraemia;
 * confusion or seizure → emergency) (TB MED 507 2022; NIOSH 2016). No drink advice while fasting or over the hourly
 * cap. Unavailable without consent or without any reading today.
 */
export function hydrationChannel(input: HydrationChannelInput): HydrationChannelResult {
  const list = todaysCheckins(input.checkins, input.now, input.consented, input.workerId)
  const withUrine = list.filter((c) => c.urineColor !== undefined)
  const latestUrine = withUrine[withUrine.length - 1]
  const previousUrine = withUrine.length >= 2 ? withUrine[withUrine.length - 2] : undefined
  const urine = latestUrine ? urineAssessment(latestUrine.urineColor, false, previousUrine?.urineColor ?? null) : null
  const latest = list[list.length - 1]
  const fluid = fluidStatus(input.consented ? input.intakes : [], input.now, {
    fastingNow: input.fastingNow,
    sweatingSinceMs: input.sweatingSinceMs,
    symptoms: latest?.symptoms ?? [],
    workerId: input.workerId,
  })
  const drivers: RiskDriver[] = []
  const actions = new Set<ActionId>()
  let level = 'safe' as RiskLevel // widened: raised inside the closure below
  const raise = (l: RiskLevel): void => {
    if (RISK_ORDER[l] > RISK_ORDER[level]) level = l
  }

  if (urine && latestUrine) {
    const shade = latestUrine.urineColor
    const ub = urine.basis.join('; ')
    if (urine.code === 'U_DRINK_MORE') {
      drivers.push({ id: 'urine_drink_more', channel: 'hydration', text: urine.advice, value: shade, unit: 'shade 1-8', direction: 'info', basis: ub })
      actions.add('drink_water')
    } else if (urine.code === 'U_DEHYDRATED') {
      raise(urine.tier === 1 ? TIER_TO_LEVEL[1] : 'caution')
      drivers.push({ id: urine.tier === 1 ? 'urine_dark_persistent' : 'urine_dark', channel: 'hydration', text: urine.advice, value: shade, unit: 'shade 1-8', direction: 'raises', basis: ub })
      actions.add('drink_water')
      actions.add('rest_shade_now')
    } else if (urine.code === 'U_VERY_DARK') {
      raise(TIER_TO_LEVEL[1])
      drivers.push({ id: 'urine_very_dark', channel: 'hydration', text: urine.advice, value: shade, unit: 'shade 1-8', direction: 'raises', basis: ub })
      ;(['rest_shade_now', 'cool_down', 'drink_water', 'symptom_checkin'] as const).forEach((a) => actions.add(a))
    } else if (urine.code === 'U_OK') {
      drivers.push({ id: 'urine_ok', channel: 'hydration', text: urine.advice, value: shade, unit: 'shade 1-8', direction: 'info', basis: ub })
    }
  }

  const fb = fluid.basis.join('; ')
  if (fluid.hyponatraemiaSuspected) {
    raise(TIER_TO_LEVEL[fluid.tier])
    drivers.push({ id: 'suspected_hyponatraemia', channel: 'hydration', text: 'Drinking above the safe limit with symptoms: stop plain water', direction: 'raises', basis: fb })
  } else {
    if (fluid.flags.includes('OVER_DAILY_CAP')) {
      raise(TIER_TO_LEVEL[1])
      drivers.push({ id: 'fluid_over_daily_cap', channel: 'hydration', text: 'More than 11.4 L of water today', value: fluid.todayL, unit: 'L', direction: 'raises', basis: fb })
    }
    if (fluid.flags.includes('OVER_HOURLY_CAP')) {
      drivers.push({ id: 'fluid_over_hourly_cap', channel: 'hydration', text: SLOW_DOWN_MESSAGE, value: fluid.rolling60L, unit: 'L/h', direction: 'info', basis: fb })
    }
  }
  fluid.actions.forEach((a) => actions.add(a))

  const noDrink = input.fastingNow === true || fluid.flags.includes('OVER_HOURLY_CAP') || actions.has('restrict_fluids')
  if (noDrink) actions.delete('drink_water')
  if (input.fastingNow === true && !fluid.hyponatraemiaSuspected) {
    drivers.push({ id: 'fasting_no_drink_reminders', channel: 'hydration', text: 'Fasting: no drink reminders - rest in shade and cool down', direction: 'info', basis: RISK_FLAG_HANDLING.fasting.basis })
  }
  const available = urine !== null || fluid.todayL > 0
  const tier: ClinicalTier = RISK_ORDER[level] >= RISK_ORDER.emergency ? 3 : RISK_ORDER[level] >= RISK_ORDER.stop ? 2 : RISK_ORDER[level] >= RISK_ORDER.high ? 1 : 0
  return { channel: 'hydration', level, available, drivers, tier, actions: [...actions], urine, fluid }
}
