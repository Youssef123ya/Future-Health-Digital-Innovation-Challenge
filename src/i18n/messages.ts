/**
 * Zill worker-facing message catalog: en (source) + ar, hi, ur, ml, bn, tl, ne.
 *
 * Basis
 * - Language set: ADPHC Safety in Heat 2025 materials (AR, EN, UR, HI, TL, BN) + Malayalam (HAAD Safety in the Heat
 *   2008 set) + Nepali — context_and_commercial.md §2.3 "Recommended launch set for Zill (8 languages)".
 * - Low-literacy design: plain words paired with pictograms and voice ("spoken directions plus pictures" [Ho06]);
 *   one yes/no item per screen; prompts "translate and back-translate" — physio_and_clinical.md §5.6.
 * - Symptom questions: §5.6 check-in table (B_* buddy items, S_* self items); illness spectrum §5.2.
 * - Emergency script: UAE ambulance 998 and the ordered T3 cooling steps — physio_and_clinical.md §10.10
 *   [ILCOR19][TBMED][IOC21][OSHA-FA][NATA15-ES]; "cool first, transport second" (ARCHITECTURE §1.4).
 * - Consent: DoH Standard for Biomedical Research (S70) §3.5.3.2.4 — Arabic and English drafts "should have same
 *   text"; language "clear, practical, and understandable … non-technical" (context_and_commercial.md §4.6).
 * - Claims discipline (ARCHITECTURE §1.8): no string predicts, diagnoses or measures core temperature; the heart-rate
 *   output is an "estimated" strain indicator.
 *
 * Every language must satisfy the {@link Catalog} interface exactly, so a missing ActionId, SymptomId, RiskFlagId,
 * RiskLevel or consent scope is a compile error. Templates use an ICU MessageFormat subset: `{name}` and
 * `{name, plural, one {…} other {…}}` with `#` = the formatted number (CLDR plural rules via Intl.PluralRules).
 * Braces are reserved characters in templates.
 *
 * All non-English text is a machine-assisted DRAFT — see {@link reviewStatus}. Nothing here is cleared for field use.
 */
// UNVERIFIED: no official statistic on literacy among UAE migrant workers was found (context_and_commercial.md §2.3);
// the catalog is written for low literacy regardless, and every string is meant to be paired with a pictogram + voice.
import type { ActionId, ConsentState, LangCode, RiskFlagId, RiskLevel, SymptomId } from '../engine/types'

// ─────────────────────────────── Shape ───────────────────────────────

/**
 * Opt-in consent scopes: the boolean members of {@link ConsentState} (ARCHITECTURE §7). Derived from the shared contract,
 * so a new scope added to types.ts forces a new consent explanation in every language.
 */
export type ConsentScope = { [K in keyof ConsentState]: ConsentState[K] extends boolean ? K : never }[keyof ConsentState]

/**
 * The complete set of texts one language must provide. Sections mirror the shared unions in engine/types.ts.
 * Basis per section: see the module header.
 */
export interface Catalog {
  /** Level name + one-line plain meaning (ARCHITECTURE §5; site flag colours, context_and_commercial.md §2.3). */
  level: Record<RiskLevel, { name: string; meaning: string }>
  /** Every ActionId as a short imperative (≤ 8 words in the English source). */
  action: Record<ActionId, string>
  /**
   * Parameterised action variants. Params: rest_shade_now {min} · drink_water {ml} · drink_water_every {ml} {min}
   * (TB MED 507 / ARCHITECTURE §5 cadence: 250 mL every 20 min) · shade_breaks {work} {rest} (minutes per hour, NIOSH
   * 2016 / ADOSH TWL zone cycles) · midday_break {from} {to} (MoHRE MR 44/2022, "12:30"–"15:00").
   */
  action_with: {
    rest_shade_now: string
    drink_water: string
    drink_water_every: string
    shade_breaks: string
    midday_break: string
  }
  /** Yes/no self question and buddy question per SymptomId (physio_and_clinical.md §5.6). */
  symptom: Record<SymptomId, { self: string; buddy: string }>
  /** Check-in framing and follow-up trend (§5.6 mapping rule 2: re-check at 15 and 30 min). */
  checkin: { self_intro: string; buddy_intro: string; trend_question: string; better: string; same: string; worse: string }
  /** Urine-colour self-check (Armstrong 8-shade chart; ARCHITECTURE §5 hydration channel: 1–3 OK, 4 drink more, 5–8 dark). */
  urine: { question: string; ok: string; drink_more: string; dark: string }
  /** T3 emergency script, in display order (see {@link EMERGENCY_SCRIPT}). */
  emergency: {
    title: string
    call_998: string
    cool_first: string
    shade: string
    immerse: string
    douse: string
    towels: string
    keep_cooling: string
    stay: string
    fluids: string
  }
  /** Worker-app interface strings (ARCHITECTURE §9 `#/worker/:id`). Params: next_break {min} · buddy_alert {name}. */
  ui: {
    status: string
    next_break: string
    break_now: string
    drank_water: string
    feel_unwell: string
    im_ok: string
    checkin: string
    yes: string
    no: string
    privacy: string
    what_i_share: string
    who_saw: string
    offline: string
    offline_note: string
    battery_saver: string
    language: string
    acknowledge: string
    help_coming: string
    buddy: string
    buddy_alert: string
    get_help: string
    slow_down_drinking: string
    listen: string
    data_stays: string
    flags_private: string
    strain_estimate: string
    not_medical: string
    translation_draft: string
  }
  /**
   * Consent notices, one per scope: translations of engine/privacy.ts `CONSENT_NOTICES` (same ids; title + statement,
   * version {@link CONSENT_TEXT_VERSION}). The English text equals the notice text exactly (tested), so a consent
   * receipt (scope + notice version + language) identifies the exact text the worker saw. DoH S70 §3.5.3.2.4: Arabic
   * and English drafts "should have same text"; every translation keeps the English sentence structure (tested).
   */
  consent: Record<ConsentScope, { title: string; statement: string }>
  /** Consent framing: voluntary, revocable, safety alerts unaffected (ILO code, DoH S70; ARCHITECTURE §7). */
  consent_info: { intro: string; voluntary: string; change_anytime: string }
  /**
   * General privacy notice shown to every worker: translation of engine/privacy.ts `GENERAL_PRIVACY_NOTICE` (version
   * {@link PRIVACY_NOTICE_TEXT_VERSION}): legal-duty aggregates for HSE (k = 5) and the regulator / employer HR
   * (k = 10) count every worker whatever the optional aggregateStatistics consent, never with individual data
   * (GOVERNANCE §4.2, §13 item 14). English equals the notice text exactly (tested).
   */
  privacy_notice: { title: string; statement: string }
  /** Private, worker-only explanation of each self-declared risk flag and what Zill does with it (types.ts RiskFlagId). */
  flag: Record<RiskFlagId, { name: string; explain: string }>
  /**
   * Short, plain, non-clinical text for every risk-driver id (engine/risk.ts `DRIVER_IDS`, plus ids being added), built
   * from the language's {@link DriverPhrases} by {@link driverTexts}. Non-clinical, because alerts.ts uses
   * `driver.<id>` as the reason key of supervisor-visible alerts (ARCHITECTURE §5: never name a personal reason).
   */
  driver: Record<DriverTextId, string>
}

/** Dotted paths to every string leaf of T, e.g. "level.safe.name". */
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>
}[keyof T & string]

/** Every message key, e.g. `'action.drink_water'`, `'symptom.dizziness.buddy'`, `'consent.wearable.explain'`. */
export type MessageKey = Leaves<Catalog>

// ─────────────────────────────── Plural helpers (ICU subset) ───────────────────────────────

/** English minutes with CLDR plural agreement ("1 minute", "15 minutes"). */
const enMinutes = (arg: string): string => `{${arg}, plural, one {# minute} other {# minutes}}`
/**
 * Arabic minutes with CLDR plural agreement: one (دقيقة واحدة), two (dual دقيقتين), few 3–10 (plural دقائق),
 * many 11–99 and other 100+ (singular دقيقة). Without this, "5 دقيقة" would be ungrammatical.
 */
const arMinutes = (arg: string): string =>
  `{${arg}, plural, one {دقيقة واحدة} two {دقيقتين} few {# دقائق} other {# دقيقة}}`
/** Arabic "every N minutes" (كل دقيقة / كل دقيقتين / كل 5 دقائق / كل 20 دقيقة). */
const arEveryMinutes = (arg: string): string =>
  `{${arg}, plural, one {كل دقيقة} two {كل دقيقتين} few {كل # دقائق} other {كل # دقيقة}}`

// ─────────────────────────────── Notice versions ───────────────────────────────

/**
 * Version of engine/privacy.ts `CONSENT_NOTICES` (`CONSENT_NOTICE_VERSION`) that the `consent.*` texts translate. Bump it
 * together with every translation whenever a notice title or statement changes; a test compares it with the engine
 * constant. Basis: UAE PDPL — the controller must be able to prove consent [secondary, S62]; DoH S70 §3.5.3.2.4.
 */
export const CONSENT_TEXT_VERSION = '1.0'

/** Version of engine/privacy.ts `GENERAL_PRIVACY_NOTICE` that `privacy_notice.*` translates (compared in a test). [ENG] */
export const PRIVACY_NOTICE_TEXT_VERSION = '1.0'

// ─────────────────────────────── Risk-driver texts ───────────────────────────────

/**
 * The distinct worker-facing phrases behind the `driver.<id>` texts. Several driver ids share one phrase
 * ({@link DRIVER_PHRASE}, {@link SYMPTOM_DRIVER_GROUP}), so a language translates about 80 phrases rather than about
 * 120 ids, and ids with the same meaning cannot drift apart. Every phrase is short (≤ 14 words in English), plain and
 * non-clinical: no symptom, heart-rate, urine or medicine words, and no personal reason (no RAL, "conservative" or flag
 * wording; ARCHITECTURE §5). Strain is always "estimated", never measured (ARCHITECTURE §1.8). Basis: plain language
 * for low literacy (physio_and_clinical.md §5.6); the engine driver each phrase explains (see DRIVER_PHRASE).
 */
export interface DriverPhrases {
  // environment and work (engine/risk.ts, engine/regulation.ts)
  heat_over_limit: string
  heat_near_limit: string
  heat_within_limit: string
  work_rest: string
  stricter_rest: string
  clothing: string
  not_used_limit: string
  lower_limit: string
  heat_time_left: string
  heat_time_used: string
  suit: string
  less_certain: string
  // heat-strain projection (ISO 7933)
  time_to_limit: string
  limit_reached: string
  no_limit_soon: string
  limit_stays: string
  fasting_limit: string
  // state, fusion and work organisation
  level_stays: string
  no_hot_work: string
  level_held: string
  safe_default: string
  checkin_due: string
  buddy: string
  no_lone_work: string
  fasting_reminders: string
  water_stop: string
  // site heat data
  check_sensor: string
  extreme_heat: string
  hot_surfaces: string
  site_sensor: string
  // ADOSH TWL zones and MoHRE midday break
  zone_high: string
  zone_medium: string
  zone_low: string
  zone_unknown: string
  essential_only: string
  permit: string
  not_used_reassign: string
  not_used_not_alone: string
  not_used_plan: string
  midday: string
  midday_other: string
  heat_unknown: string
  heat_stop: string
  // wearable band (on device, estimates only)
  band_not_used: string
  band_check: string
  band_starting: string
  band_odd: string
  strain_very_high: string
  strain_high: string
  strain_rising: string
  effort_high: string
  age_unknown: string
  band_ok: string
  // check-ins (symptom groups by triage tier) and drinking
  no_checkin: string
  checkin_ok: string
  too_much_water: string
  worse: string
  not_better: string
  sx_thirst: string
  sx_overdrink: string
  sx_t1: string
  sx_t2: string
  sx_t3: string
  colour_ok: string
  colour_more: string
  colour_dark: string
  colour_dark_again: string
  colour_very_dark: string
  too_much_today: string
  slow_down: string
  // weather data source and freshness (data/weather.ts)
  no_weather: string
  weather_old: string
  weather_old_margin: string
  src_forecast: string
  src_archive: string
  src_cached: string
  // rest area and human-reviewed recovery (ARCHITECTURE §5)
  rest_cooled: string
  rest_shade_only: string
  recovery_review: string
  recovery_cleared: string
  // projection hold and resume check, logged drinking and the water-loss limit (engine/risk.ts, wave 2c)
  resume_check: string
  task_too_hot: string
  work_bout: string
  drinks_counted: string
  drink_to_restart: string
}

/**
 * Driver id → phrase, for every id except `symptom_<SymptomId>` (see {@link SYMPTOM_DRIVER_GROUP}). Ids follow
 * engine/risk.ts `DRIVER_IDS` (risk.ts, indices.ts, regulation.ts, physio.ts, clinical.ts, data/weather.ts) plus
 * 'rest_area_cooled', 'rest_area_shade_only', 'phs_recovery_review_required' and 'phs_restarted_after_review'
 * (ARCHITECTURE §5 cooled rest areas and PHS recovery review). A test checks both directions against `DRIVER_IDS`.
 */
const DRIVER_PHRASE = {
  // engine/risk.ts: environment
  wbgt_over_limit: 'heat_over_limit',
  wbgt_near_limit: 'heat_near_limit',
  wbgt_within_limit: 'heat_within_limit',
  work_rest_cycle: 'work_rest',
  clothing_adjustment: 'clothing',
  limit_ral_unacclimatized: 'not_used_limit',
  limit_ral_acclimatizing: 'not_used_limit',
  limit_stricter_personal: 'lower_limit',
  acclimatization_budget: 'heat_time_left',
  acclimatization_budget_exhausted: 'heat_time_used',
  metabolic_rate_extrapolated: 'less_certain',
  wbgt_method_not_applicable: 'suit',
  stricter_work_rest: 'stricter_rest',
  // engine/risk.ts: projection
  phs_minutes_to_limit: 'time_to_limit',
  phs_limit_reached: 'limit_reached',
  phs_beyond_horizon: 'no_limit_soon',
  phs_out_of_validity: 'less_certain',
  phs_clothing_unverified: 'less_certain',
  phs_not_applicable: 'suit',
  phs_recovery_not_modelled: 'limit_stays',
  phs_no_drinking: 'fasting_limit',
  phs_recovery_review_required: 'recovery_review',
  phs_restarted_after_review: 'recovery_cleared',
  phs_resume_hold: 'resume_check',
  task_not_feasible_now: 'task_too_hot',
  phs_work_bout: 'work_bout',
  // engine/risk.ts: hydration (worker device only) and the day plan
  phs_water_credit: 'drinks_counted',
  phs_drink_to_restart: 'drink_to_restart',
  work_rest_planned: 'work_rest',
  // engine/risk.ts: state and fusion
  clinical_latch: 'level_stays',
  no_hot_work_today: 'no_hot_work',
  level_held_dwell: 'level_held',
  step_gap_capped: 'safe_default',
  conservative_checkin_due: 'checkin_due',
  buddy_required: 'buddy',
  lone_work_not_allowed: 'no_lone_work',
  water_paused_fasting: 'fasting_reminders',
  water_restricted: 'water_stop',
  meter_check_advised: 'check_sensor',
  rest_area_cooled: 'rest_cooled',
  rest_area_shade_only: 'rest_shade_only',
  // engine/indices.ts
  env_wind_default: 'safe_default',
  env_solar_clear_sky: 'safe_default',
  env_pressure_default: 'safe_default',
  env_radiant_boost_ignored: 'safe_default',
  env_radiant_boost_site_default: 'hot_surfaces',
  wbgt_measured: 'site_sensor',
  wbgt_meter_model_mismatch: 'check_sensor',
  wbgt_solver_not_converged: 'less_certain',
  twl_out_of_valid_range: 'less_certain',
  bb2002_backstop: 'extreme_heat',
  // engine/regulation.ts
  twl_zone_high: 'zone_high',
  twl_zone_medium: 'zone_medium',
  twl_zone_low: 'zone_low',
  twl_zone_unrestricted: 'zone_low',
  twl_unavailable: 'zone_unknown',
  ordinary_work_prohibited: 'essential_only',
  permit_to_work: 'permit',
  unacclimatized_excluded: 'not_used_reassign',
  unacclimatized_not_alone: 'not_used_not_alone',
  acclimatization_programme: 'not_used_plan',
  midday_break: 'midday',
  midday_break_window: 'midday_other',
  wbgt_unavailable: 'heat_unknown',
  wbgt_stop_limit: 'heat_stop',
  // engine/physio.ts
  physio_unavailable_not_consented: 'band_not_used',
  physio_unavailable_hr_suppressing_medication: 'band_not_used',
  physio_unavailable_no_signal: 'band_check',
  physio_unavailable_signal_unusable: 'band_check',
  physio_unavailable_warmup: 'band_starting',
  hr_implausible_high: 'band_odd',
  ectemp_ge_39_0: 'strain_very_high',
  ectemp_ge_38_4: 'strain_high',
  ectemp_ge_38_0_conservative: 'strain_high',
  ectemp_ge_38_0_advisory: 'strain_rising',
  psi_very_high: 'strain_very_high',
  psi_high: 'strain_high',
  psi_moderate_advisory: 'strain_rising',
  hr_over_180_minus_age: 'effort_high',
  hr_limit_age_unknown: 'age_unknown',
  physio_no_warning: 'band_ok',
  // engine/clinical.ts
  no_checkin_today: 'no_checkin',
  no_symptoms: 'checkin_ok',
  suspected_hyponatraemia: 'too_much_water',
  symptoms_worsening: 'worse',
  symptoms_not_improving_30min: 'not_better',
  urine_drink_more: 'colour_more',
  urine_dark: 'colour_dark',
  urine_dark_persistent: 'colour_dark_again',
  urine_very_dark: 'colour_very_dark',
  urine_ok: 'colour_ok',
  fluid_over_daily_cap: 'too_much_today',
  fluid_over_hourly_cap: 'slow_down',
  fasting_no_drink_reminders: 'fasting_reminders',
  // data/weather.ts
  env_conservative_default: 'no_weather',
  env_data_stale: 'weather_old',
  env_sensor_unavailable: 'check_sensor',
  env_series_wrong_site: 'safe_default',
  env_source_no_coverage: 'safe_default',
  env_stale_margin: 'weather_old_margin',
  env_source_site_sensor: 'site_sensor',
  env_source_forecast: 'src_forecast',
  env_source_archive: 'src_archive',
  env_source_cached_forecast: 'src_cached',
  env_source_conservative_default: 'no_weather',
} as const satisfies Record<string, keyof DriverPhrases>

/** Phrase used for a `symptom_<SymptomId>` driver: one per triage group, never naming the symptom. */
export type SymptomDriverGroup = 'sx_thirst' | 'sx_overdrink' | 'sx_t1' | 'sx_t2' | 'sx_t3'

/**
 * Symptom → driver phrase by triage tier (physio_and_clinical.md §10.7; engine/clinical.ts `SYMPTOM_RULES`, compared in
 * a test): T3 red flags → call 998 and cool first; T2 → stop hot work and get the first aider; T1 → rest in shade and
 * drink; T0 thirst → drink; the T0 over-drinking items (drank a lot, swollen hands) → no extra water (TB MED 507 §5-4b).
 * The text never names the symptom, so it stays non-clinical wherever it is shown.
 */
export const SYMPTOM_DRIVER_GROUP: Readonly<Record<SymptomId, SymptomDriverGroup>> = Object.freeze({
  thirst: 'sx_thirst',
  heat_rash: 'sx_t1',
  cramps: 'sx_t1',
  cramps_persistent: 'sx_t2',
  headache: 'sx_t2',
  dizziness: 'sx_t2',
  nausea: 'sx_t2',
  weakness_fatigue: 'sx_t2',
  fainted: 'sx_t2',
  brown_urine: 'sx_t2',
  drank_a_lot: 'sx_overdrink',
  swollen_hands: 'sx_overdrink',
  repeated_vomiting: 'sx_t3',
  chest_pain: 'sx_t3',
  confusion: 'sx_t3',
  slurred_speech: 'sx_t3',
  unsteady_walking: 'sx_t3',
  collapsed_unresponsive: 'sx_t3',
  seizure: 'sx_t3',
})

/** Every risk-driver id with a worker-facing text (`driver.<id>`). */
export type DriverTextId = keyof typeof DRIVER_PHRASE | `symptom_${SymptomId}`

/**
 * Expands one language's {@link DriverPhrases} into the text of every driver id ({@link DRIVER_PHRASE} and
 * {@link SYMPTOM_DRIVER_GROUP}). Pure. Basis: see {@link DriverPhrases}.
 */
export function driverTexts(phrases: DriverPhrases): Record<DriverTextId, string> {
  const out = {} as Record<DriverTextId, string>
  for (const [id, phrase] of Object.entries(DRIVER_PHRASE) as [keyof typeof DRIVER_PHRASE, keyof DriverPhrases][]) {
    out[id] = phrases[phrase]
  }
  for (const [symptom, group] of Object.entries(SYMPTOM_DRIVER_GROUP) as [SymptomId, SymptomDriverGroup][]) {
    out[`symptom_${symptom}`] = phrases[group]
  }
  return out
}

// ─────────────────────────────── English (source text) ───────────────────────────────

const EN: Catalog = {
  level: {
    safe: { name: 'Low risk', meaning: 'Normal work. Drink water and take your breaks.' },
    caution: { name: 'Caution', meaning: 'Hot. Drink water often and rest in the shade.' },
    high: { name: 'High risk', meaning: 'Very hot. Work less and rest more in the shade.' },
    stop: { name: 'Stop work', meaning: 'Stop hot work now. Go to the shade and rest.' },
    emergency: { name: 'Emergency', meaning: 'Danger. Call 998 and start cooling now.' },
  },
  action: {
    drink_water: 'Drink water now',
    shade_breaks: 'Take regular shade breaks',
    reduce_intensity: 'Slow down and work lighter',
    rotate_task: 'Swap to a cooler, lighter task',
    rest_shade_now: 'Rest in the shade now',
    cool_down: 'Cool down: wet your skin, use a fan',
    stop_work: 'Stop work now',
    buddy_check: 'Check on your buddy',
    first_aider_check: 'Call the first aider now',
    call_998: 'Call 998 now',
    cool_first: 'Cool them first, then go to hospital',
    stay_with_worker: 'Stay with them, never alone',
    midday_break: 'Midday break: no work in the sun',
    acclimatization_plan: 'New to the heat: work less at first',
    occ_health_review: 'See the clinic nurse for a check',
    check_sensor: 'Check the sensor is working',
    symptom_checkin: 'Answer the check-in questions',
    no_lone_work: 'Do not work alone',
    electrolytes: 'Have an electrolyte drink, no salt tablets',
    restrict_fluids: 'Stop drinking water for now. See first aider.',
    medical_evaluation: 'See a doctor today',
    no_hot_work_today: 'No more hot work today',
  },
  action_with: {
    rest_shade_now: `Rest in the shade ${enMinutes('min')}`,
    drink_water: 'Drink {ml} mL now',
    drink_water_every: 'Drink {ml} mL every {min, plural, one {minute} other {# minutes}}',
    shade_breaks: 'Work {work} min, rest {rest} min',
    midday_break: 'No work in the sun {from}–{to}',
  },
  symptom: {
    thirst: { self: 'Are you very thirsty?', buddy: 'Is your partner very thirsty?' },
    heat_rash: { self: 'Do you have an itchy red rash?', buddy: 'Does your partner have an itchy red rash?' },
    cramps: { self: 'Do you have painful muscle cramps?', buddy: 'Does your partner have painful muscle cramps?' },
    cramps_persistent: {
      self: 'Have your cramps lasted 1 hour or more?',
      buddy: "Have your partner's cramps lasted 1 hour or more?",
    },
    headache: { self: 'Do you have a headache?', buddy: 'Does your partner have a headache?' },
    dizziness: { self: 'Do you feel dizzy?', buddy: 'Is your partner dizzy or light-headed?' },
    nausea: { self: 'Do you feel sick in your stomach?', buddy: 'Does your partner feel sick in the stomach?' },
    weakness_fatigue: { self: 'Are you very tired or weak?', buddy: 'Is your partner very tired or weak?' },
    fainted: { self: 'Did you faint, even for a moment?', buddy: 'Did your partner faint, even for a moment?' },
    brown_urine: {
      self: 'Is your urine brown, like tea or cola?',
      buddy: 'Does your partner say their urine is brown?',
    },
    drank_a_lot: {
      self: 'Did you drink more than 6 cups (1.5 L) of water in the last hour?',
      buddy: 'Did your partner drink more than 6 cups (1.5 L) of water in the last hour?',
    },
    swollen_hands: { self: 'Are your hands swollen?', buddy: "Are your partner's hands swollen?" },
    repeated_vomiting: { self: 'Have you vomited more than once?', buddy: 'Has your partner vomited more than once?' },
    chest_pain: {
      self: 'Do you have chest pain or trouble breathing?',
      buddy: 'Does your partner have chest pain or trouble breathing?',
    },
    confusion: { self: 'Do you feel confused?', buddy: 'Is your partner confused or acting strange?' },
    slurred_speech: { self: 'Is it hard for you to speak clearly?', buddy: "Is your partner's speech slurred or unclear?" },
    unsteady_walking: {
      self: 'Are you stumbling or unable to walk straight?',
      buddy: 'Is your partner stumbling or unable to walk straight?',
    },
    collapsed_unresponsive: {
      self: 'Did you collapse and still not feel normal?',
      buddy: 'Did your partner collapse, or not respond to you?',
    },
    seizure: { self: 'Did you have a fit (seizure)?', buddy: 'Did your partner shake or have a fit?' },
  },
  checkin: {
    self_intro: 'Answer each question: YES or NO.',
    buddy_intro: 'Look at your partner. Answer YES or NO.',
    trend_question: 'Compared to before, how do you feel now?',
    better: 'Better',
    same: 'The same',
    worse: 'Worse',
  },
  urine: {
    question: 'Which colour is your urine? Tap the closest.',
    ok: 'Good. Keep drinking water.',
    drink_more: 'Drink more water.',
    dark: 'Too dark. Drink water now and rest in the shade.',
  },
  emergency: {
    title: 'Emergency. Act now.',
    call_998: 'Call 998 for an ambulance.',
    cool_first: 'Cool first. Start cooling before going to hospital.',
    shade: 'Move them to shade. Remove extra clothing.',
    immerse: 'Best: put the body in cold or ice water up to the neck, in a tub or tarp. Stir the water.',
    douse: 'No tub? Keep pouring cold water on them and fan them.',
    towels: 'Or use ice-water towels, changed every 1–2 minutes, and ice packs.',
    keep_cooling:
      'Keep cooling until the ambulance arrives. Take them out of ice water after about 15 minutes, or sooner if they act normal again.',
    stay: 'Stay with them. Never leave them alone.',
    fluids: 'Give drinks only if they are fully awake and alert.',
  },
  ui: {
    status: 'My status',
    next_break: 'Next break in {min} min',
    break_now: 'Break time. Go to the shade.',
    drank_water: 'I drank water',
    feel_unwell: 'I feel unwell',
    im_ok: "I'm OK",
    checkin: 'Check-in',
    yes: 'YES',
    no: 'NO',
    privacy: 'Privacy',
    what_i_share: 'What I share',
    who_saw: 'Who saw my data',
    offline: 'Offline mode',
    offline_note: 'No network. Warnings on this phone still work.',
    battery_saver: 'Battery saver',
    language: 'Language',
    acknowledge: 'OK, I understand',
    help_coming: 'Help is coming.',
    buddy: 'My buddy',
    buddy_alert: '{name} may need help. Go and check now.',
    get_help: 'Get help',
    slow_down_drinking: 'Slow down. You drank a lot of water this hour.',
    listen: 'Listen',
    data_stays: 'Your health data stays on this phone.',
    flags_private: 'Only you see this. It stays on your phone.',
    strain_estimate: 'Estimated heat strain',
    not_medical: 'A safety guide, not a medical test.',
    translation_draft: 'Draft translation. Not yet checked.',
  },
  consent: {
    wearable: {
      title: 'Heart rate from my band',
      statement:
        'Zill may read heart rate from my band on this phone to estimate my heat strain. It is an estimate to help keep me safe, not a medical measurement or a diagnosis. My supervisor never sees it.',
    },
    healthFlags: {
      title: 'Health factors that make heat more dangerous for me',
      statement:
        'Zill may use my yes/no answers (for example a recent illness, or a medicine that affects heat tolerance) to make my alerts stricter. My answers stay on this phone and are never shown to my supervisor or employer.',
    },
    checkins: {
      title: 'Symptom and hydration check-ins',
      statement:
        'Zill may ask how I feel and the colour of my urine. My answers stay on this phone. If my case is escalated, the first aider sees the symptoms I reported so they can help me.',
    },
    shareWithMedicOnEscalation: {
      title: 'Share with occupational health if my case is escalated',
      statement:
        'If my case is escalated, the occupational health nurse may see my heart-rate estimates, health factors and check-in answers to look after me. Nobody else sees them, and they are never used against me.',
    },
    aggregateStatistics: {
      title: 'Count me in anonymous statistics',
      statement:
        'My data may be counted in public-health statistics about heat at work. Groups of fewer than 10 people are hidden so that I cannot be picked out.',
    },
  },
  consent_info: {
    intro: 'Choose what Zill may use. Each choice is separate.',
    voluntary: 'Saying no is OK. You still get all safety alerts.',
    change_anytime: 'You can change your choice at any time.',
  },
  privacy_notice: {
    title: 'How you are counted in group totals',
    statement:
      "Your employer has a legal duty to keep work in the heat safe. For this, Zill counts every worker in group totals, even if you did not choose “Count me in anonymous statistics”. The site safety (HSE) manager sees only groups of 5 or more workers. The regulator and your employer's HR see only groups of 10 or more workers. Smaller groups are hidden, and the totals never show your name or any record about you alone. Your choice about anonymous statistics only decides whether you are also counted in public-health statistics.",
  },
  flag: {
    prior_heat_illness: {
      name: 'Heat illness before',
      explain: 'You were sick from heat before. Zill warns you earlier and gives more rest.',
    },
    heat_sensitive_medication: {
      name: 'Medicine that makes heat harder',
      explain: 'Some medicines make heat harder on your body. Zill warns you earlier and gives more rest.',
    },
    hr_suppressing_medication: {
      name: 'Medicine or device that slows the heart',
      explain: 'Your heart rate may not show heat strain. Zill does not use heart rate for you and warns you earlier.',
    },
    recent_illness: {
      name: 'Sick recently',
      explain: 'Being sick lately makes heat harder on your body. Zill warns you earlier and gives more rest.',
    },
    poor_sleep: {
      name: 'Poor sleep',
      explain: 'Little sleep makes heat harder on your body. Zill warns you earlier and gives more rest.',
    },
    fasting: {
      name: 'Fasting',
      explain: 'Zill does not remind you to drink during fasting hours. It warns you earlier and gives more rest.',
    },
    heat_rash_sunburn: {
      name: 'Heat rash or sunburn',
      explain: 'Rash or sunburn stops your skin from sweating well. Zill warns you earlier and gives more rest.',
    },
    oh_review_required: {
      name: 'Nurse check needed',
      explain: 'The clinic nurse will talk with you in private about safe work in heat.',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'The heat is over the safe limit for this work.',
    heat_near_limit: 'The heat is close to the safe limit for this work.',
    heat_within_limit: 'The heat is within the safe limit for this work.',
    work_rest: 'Keep to the work and rest times each hour.',
    clothing: 'Your work clothes hold in heat, so the limit is lower.',
    not_used_limit: 'You are not used to the heat yet, so your limit is lower.',
    lower_limit: 'Your limit is lower today to keep you safe.',
    stricter_rest: 'You get extra rest breaks today to keep you safe.',
    heat_time_left: 'Your hot-work time is limited while you get used to the heat.',
    heat_time_used: 'Your hot-work time for today is used up.',
    suit: 'Sealed protective clothing: heat limits are only a rough guide.',
    less_certain: 'The heat estimate is less certain here.',
    time_to_limit: 'At this work rate, your safe time in the heat is running out.',
    limit_reached: 'Your safe heat limit for this shift is reached. Rest somewhere cool.',
    no_limit_soon: 'No heat limit soon at this work rate.',
    limit_stays: 'Rest alone does not reset your heat limit today.',
    fasting_limit: 'Fasting: you are not drinking, so your limit is lower.',
    level_stays: 'This warning stays until a first aider or supervisor clears you.',
    no_hot_work: 'No more hot work for you today.',
    level_held: 'The level stays up a little longer after the heat eases.',
    safe_default: 'Some data is missing or wrong, so Zill uses safe values.',
    checkin_due: 'Time for your check-in.',
    buddy: 'Work with a buddy today.',
    no_lone_work: 'Do not work alone in this heat.',
    fasting_reminders: 'Fasting: no drink reminders. Rest in the shade and cool down.',
    water_stop: 'Stop drinking plain water until the first aider checks you.',
    check_sensor: 'The site heat sensor needs checking.',
    extreme_heat: 'Extreme heat and humidity: stopping work is advised.',
    hot_surfaces: 'Hot surfaces here add heat. This is counted.',
    site_sensor: 'Heat reading from the site sensor.',
    zone_high: 'Heat zone High: strict work and rest times, no working alone.',
    zone_medium: 'Heat zone Medium: set work and rest times, no working alone.',
    zone_low: 'Heat zone Low: normal work with water and breaks.',
    zone_unknown: 'Heat zone unknown, so the strictest rules apply.',
    essential_only: 'Too hot for normal work: essential tasks only.',
    permit: 'This work needs a heat work permit.',
    not_used_reassign: 'Not used to the heat yet: you will get work outside this zone.',
    not_used_not_alone: 'Not used to the heat yet: do not work alone here.',
    not_used_plan: 'Not used to the heat yet: follow your plan to get used to it.',
    midday: 'Midday break: no work in the sun now.',
    midday_other: 'Midday break time, but this task is not in the sun.',
    heat_unknown: 'No heat reading, so the stop-work rule cannot be checked.',
    heat_stop: 'Too hot: work must stop.',
    band_not_used: 'Band not used. Alerts use weather and work.',
    band_check: 'Band data missing or poor. Check the band is on and fits well.',
    band_starting: 'Band starting up (first 30 min). Alerts use weather and work.',
    band_odd: 'Unusual band reading. Your buddy will check on you.',
    strain_very_high: 'Very high heat strain estimated. Stop work and cool down.',
    strain_high: 'High heat strain estimated. Rest somewhere cool.',
    strain_rising: 'Estimated heat strain is rising. Answer the check-in.',
    effort_high: 'You have worked too hard for too long. Rest now.',
    age_unknown: 'Age not set, so a safer limit is used.',
    band_ok: 'Band: no warning.',
    no_checkin: 'No check-in yet today.',
    checkin_ok: 'Check-in: no warning signs.',
    too_much_water: 'Too much water with warning signs. Stop drinking and see the first aider.',
    worse: 'Feeling worse than before. Call 998 and start cooling now.',
    not_better: 'Not better after 30 minutes. Call 998 and keep cooling.',
    sx_thirst: 'You are thirsty. Drink water now.',
    sx_overdrink: 'Do not drink extra water. Tell the first aider if you feel unwell.',
    sx_t1: 'Check-in answer: rest in the shade and drink water.',
    sx_t2: 'Check-in answer: stop hot work and get the first aider now.',
    sx_t3: 'Danger sign reported. Call 998 and start cooling now.',
    colour_ok: 'Colour check: good. Keep drinking water.',
    colour_more: 'Colour check: drink more water.',
    colour_dark: 'Colour check: too dark. Drink water and rest in the shade.',
    colour_dark_again: 'Colour check still too dark. Rest, drink water and tell the first aider.',
    colour_very_dark: 'Colour check: very dark. Rest, cool down and drink water.',
    too_much_today: 'You drank a very large amount today. Slow down.',
    slow_down: 'Slow down. You drank a lot of water this hour.',
    no_weather: 'No weather data, so Zill assumes a very hot hour.',
    weather_old: 'Weather data is old, so it is less certain.',
    weather_old_margin: 'Weather data is very old, so a safety margin is added.',
    src_forecast: 'Weather from the forecast.',
    src_archive: 'Weather from weather records.',
    src_cached: 'Weather from a saved forecast.',
    rest_cooled: 'Breaks are in a cool, air-conditioned rest area.',
    rest_shade_only: 'Only shade for breaks here, so you need more rest.',
    recovery_review: 'Rest 30 minutes somewhere cool. Then a supervisor or first aider must clear you.',
    recovery_cleared: 'You were cleared to work again. Keep taking your breaks.',
    resume_check: 'Rest until the heat check says you can go back to this work.',
    task_too_hot: 'Too hot to return to this task now. Move to lighter or cooler work.',
    work_bout: 'Only a short work time is left before your next rest.',
    drinks_counted: 'The water you log is counted in your heat limit.',
    drink_to_restart: 'Drink water, log it, and rest before you start hot work again.',
  }),
}

// ─────────────────────────────── Arabic (RTL) ───────────────────────────────

const AR: Catalog = {
  level: {
    safe: { name: 'خطر منخفض', meaning: 'عمل عادي. اشرب الماء وخذ استراحاتك.' },
    caution: { name: 'انتبه', meaning: 'الجو حار. اشرب الماء كثيرًا واسترح في الظل.' },
    high: { name: 'خطر مرتفع', meaning: 'الجو حار جدًا. اعمل أقل واسترح أكثر في الظل.' },
    stop: { name: 'أوقف العمل', meaning: 'أوقف العمل في الحر الآن. اذهب إلى الظل واسترح.' },
    emergency: { name: 'طوارئ', meaning: 'خطر. اتصل بالرقم 998 وابدأ التبريد الآن.' },
  },
  action: {
    drink_water: 'اشرب الماء الآن',
    shade_breaks: 'خذ استراحات منتظمة في الظل',
    reduce_intensity: 'اعمل ببطء وبجهد أخف',
    rotate_task: 'انتقل إلى عمل أخف في مكان أبرد',
    rest_shade_now: 'استرح في الظل الآن',
    cool_down: 'برّد جسمك: بلّل جلدك واستخدم مروحة',
    stop_work: 'أوقف العمل الآن',
    buddy_check: 'اطمئن على زميلك',
    first_aider_check: 'اطلب المسعف الآن',
    call_998: 'اتصل بالرقم 998 الآن',
    cool_first: 'برّده أولًا، ثم انقله إلى المستشفى',
    stay_with_worker: 'ابقَ معه، لا تتركه وحده',
    midday_break: 'استراحة الظهيرة: لا عمل تحت الشمس',
    acclimatization_plan: 'جديد على الحر: اعمل أقل في البداية',
    occ_health_review: 'راجع ممرض العيادة للفحص',
    check_sensor: 'تأكد أن الجهاز يعمل',
    symptom_checkin: 'أجب عن أسئلة: كيف حالك؟',
    no_lone_work: 'لا تعمل وحدك',
    electrolytes: 'اشرب مشروب أملاح، لا أقراص ملح',
    restrict_fluids: 'توقف عن شرب الماء الآن. راجع المسعف.',
    medical_evaluation: 'راجع الطبيب اليوم',
    no_hot_work_today: 'لا مزيد من العمل في الحر اليوم',
  },
  action_with: {
    rest_shade_now: `استرح في الظل ${arMinutes('min')}`,
    drink_water: 'اشرب {ml} مل الآن',
    drink_water_every: `اشرب {ml} مل ${arEveryMinutes('min')}`,
    shade_breaks: `اعمل ${arMinutes('work')}، واسترح ${arMinutes('rest')}`,
    midday_break: 'لا عمل تحت الشمس من {from} إلى {to}',
  },
  symptom: {
    thirst: { self: 'هل تشعر بعطش شديد؟', buddy: 'هل زميلك عطشان جدًا؟' },
    heat_rash: { self: 'هل عندك طفح جلدي أحمر يسبب الحكة؟', buddy: 'هل عند زميلك طفح جلدي أحمر يسبب الحكة؟' },
    cramps: { self: 'هل عندك تشنجات مؤلمة في العضلات؟', buddy: 'هل عند زميلك تشنجات مؤلمة في العضلات؟' },
    cramps_persistent: { self: 'هل استمرت التشنجات ساعة أو أكثر؟', buddy: 'هل استمرت تشنجات زميلك ساعة أو أكثر؟' },
    headache: { self: 'هل عندك صداع؟', buddy: 'هل عند زميلك صداع؟' },
    dizziness: { self: 'هل تشعر بدوخة؟', buddy: 'هل يشعر زميلك بدوخة؟' },
    nausea: { self: 'هل تشعر بغثيان في معدتك؟', buddy: 'هل يشعر زميلك بغثيان؟' },
    weakness_fatigue: { self: 'هل تشعر بتعب أو ضعف شديد؟', buddy: 'هل زميلك متعب أو ضعيف جدًا؟' },
    fainted: { self: 'هل أغمي عليك، ولو للحظة؟', buddy: 'هل أغمي على زميلك، ولو للحظة؟' },
    brown_urine: { self: 'هل لون بولك بني مثل الشاي أو الكولا؟', buddy: 'هل يقول زميلك إن لون بوله بني؟' },
    drank_a_lot: {
      self: 'هل شربت أكثر من 6 أكواب (1.5 لتر) من الماء في الساعة الأخيرة؟',
      buddy: 'هل شرب زميلك أكثر من 6 أكواب (1.5 لتر) من الماء في الساعة الأخيرة؟',
    },
    swollen_hands: { self: 'هل يداك منتفختان؟', buddy: 'هل يدا زميلك منتفختان؟' },
    repeated_vomiting: { self: 'هل تقيأت أكثر من مرة؟', buddy: 'هل تقيأ زميلك أكثر من مرة؟' },
    chest_pain: {
      self: 'هل عندك ألم في الصدر أو صعوبة في التنفس؟',
      buddy: 'هل عند زميلك ألم في الصدر أو صعوبة في التنفس؟',
    },
    confusion: { self: 'هل تشعر بالتشوش أو الارتباك؟', buddy: 'هل زميلك مرتبك أو يتصرف بشكل غريب؟' },
    slurred_speech: { self: 'هل تجد صعوبة في الكلام بوضوح؟', buddy: 'هل كلام زميلك متلعثم أو غير واضح؟' },
    unsteady_walking: {
      self: 'هل تتعثر أو لا تستطيع المشي باستقامة؟',
      buddy: 'هل يتعثر زميلك أو لا يستطيع المشي باستقامة؟',
    },
    collapsed_unresponsive: {
      self: 'هل سقطت فجأة وما زلت لا تشعر أنك طبيعي؟',
      buddy: 'هل سقط زميلك، أو لا يستجيب لك؟',
    },
    seizure: { self: 'هل أصابتك نوبة تشنج؟', buddy: 'هل ارتجف زميلك أو أصابته نوبة تشنج؟' },
  },
  checkin: {
    self_intro: 'أجب عن كل سؤال: نعم أو لا.',
    buddy_intro: 'انظر إلى زميلك. أجب: نعم أو لا.',
    trend_question: 'مقارنة بما قبل، كيف تشعر الآن؟',
    better: 'أفضل',
    same: 'كما كنت',
    worse: 'أسوأ',
  },
  urine: {
    question: 'ما لون بولك؟ اضغط على أقرب لون.',
    ok: 'جيد. استمر في شرب الماء.',
    drink_more: 'اشرب ماءً أكثر.',
    dark: 'اللون غامق جدًا. اشرب الماء الآن واسترح في الظل.',
  },
  emergency: {
    title: 'طوارئ. تصرّف الآن.',
    call_998: 'اتصل بالرقم 998 لطلب الإسعاف.',
    cool_first: 'التبريد أولًا. ابدأ التبريد قبل النقل إلى المستشفى.',
    shade: 'انقله إلى الظل. انزع الملابس الزائدة.',
    immerse: 'الأفضل: ضع جسمه في ماء بارد أو مثلج حتى الرقبة، في حوض أو مشمع. حرّك الماء.',
    douse: 'لا يوجد حوض؟ استمر في صب الماء البارد عليه وحرّك الهواء حوله بمروحة.',
    towels: 'أو ضع عليه مناشف مبللة بماء مثلج، وغيّرها كل دقيقة أو دقيقتين، واستخدم أكياس الثلج.',
    keep_cooling:
      'استمر في التبريد حتى يصل الإسعاف. أخرجه من الماء المثلج بعد حوالي 15 دقيقة، أو قبل ذلك إذا عاد إلى طبيعته.',
    stay: 'ابقَ معه. لا تتركه وحده أبدًا.',
    fluids: 'لا تعطه أي شراب إلا إذا كان مستيقظًا وواعيًا تمامًا.',
  },
  ui: {
    status: 'حالتي',
    next_break: `الاستراحة القادمة بعد ${arMinutes('min')}`,
    break_now: 'وقت الاستراحة. اذهب إلى الظل.',
    drank_water: 'شربت الماء',
    feel_unwell: 'لست بخير',
    im_ok: 'أنا بخير',
    checkin: 'كيف حالك؟',
    yes: 'نعم',
    no: 'لا',
    privacy: 'الخصوصية',
    what_i_share: 'ما الذي أشاركه',
    who_saw: 'من رأى بياناتي',
    offline: 'وضع عدم الاتصال',
    offline_note: 'لا توجد شبكة. التنبيهات على هذا الهاتف ما زالت تعمل.',
    battery_saver: 'توفير البطارية',
    language: 'اللغة',
    acknowledge: 'حسنًا، فهمت',
    help_coming: 'المساعدة في الطريق.',
    buddy: 'زميلي',
    buddy_alert: '{name} قد يحتاج إلى مساعدة. اذهب واطمئن عليه الآن.',
    get_help: 'اطلب المساعدة',
    slow_down_drinking: 'تمهّل. شربت كثيرًا من الماء في هذه الساعة.',
    listen: 'استمع',
    data_stays: 'بياناتك الصحية تبقى على هذا الهاتف.',
    flags_private: 'أنت فقط ترى هذا. يبقى على هاتفك.',
    strain_estimate: 'تقدير الإجهاد الحراري',
    not_medical: 'دليل للسلامة، وليس فحصًا طبيًا.',
    translation_draft: 'ترجمة أولية. لم تُراجَع بعد.',
  },
  consent: {
    wearable: {
      title: 'نبض القلب من سواري',
      statement:
        'يجوز لتطبيق «ظل» أن يقرأ نبض قلبي من سواري على هذا الهاتف لتقدير الإجهاد الحراري لدي. إنه تقدير يساعد على حمايتي، وليس قياسًا طبيًا ولا تشخيصًا. لا يراه مشرفي أبدًا.',
    },
    healthFlags: {
      title: 'عوامل صحية تجعل الحر أخطر عليّ',
      statement:
        'يجوز لتطبيق «ظل» أن يستخدم إجاباتي بنعم أو لا (مثل مرض حديث، أو دواء يؤثر في تحمّل الحر) لجعل تنبيهاتي أشد. تبقى إجاباتي على هذا الهاتف ولا تُعرض أبدًا على مشرفي أو صاحب العمل.',
    },
    checkins: {
      title: 'أسئلة الأعراض وشرب الماء',
      statement:
        'يجوز لتطبيق «ظل» أن يسألني عن شعوري ولون بولي. تبقى إجاباتي على هذا الهاتف. إذا صُعّدت حالتي، يرى المسعف الأعراض التي أبلغت عنها ليتمكن من مساعدتي.',
    },
    shareWithMedicOnEscalation: {
      title: 'المشاركة مع الصحة المهنية إذا صُعّدت حالتي',
      statement:
        'إذا صُعّدت حالتي، يجوز لممرض الصحة المهنية أن يرى تقديرات نبض قلبي وعواملي الصحية وإجاباتي عن الأسئلة ليعتني بي. لا يراها أحد غيره، ولا تُستخدم ضدي أبدًا.',
    },
    aggregateStatistics: {
      title: 'احسبوني في إحصاءات مجهولة الهوية',
      statement:
        'يجوز أن تُحسب بياناتي في إحصاءات الصحة العامة عن الحر في العمل. تُخفى المجموعات التي تضم أقل من 10 أشخاص حتى لا يمكن التعرف عليّ.',
    },
  },
  consent_info: {
    intro: 'اختر ما يمكن لتطبيق ظل استخدامه. كل اختيار منفصل.',
    voluntary: 'لا بأس أن ترفض. ستصلك كل تنبيهات السلامة مع ذلك.',
    change_anytime: 'يمكنك تغيير اختيارك في أي وقت.',
  },
  privacy_notice: {
    title: 'كيف تُحسب ضمن الأرقام الجماعية',
    statement:
      'على صاحب العمل واجب قانوني بجعل العمل في الحر آمنًا. لهذا يحسب تطبيق «ظل» كل عامل ضمن الأرقام الجماعية، حتى لو لم تختر «احسبوني في إحصاءات مجهولة الهوية». يرى مدير السلامة في الموقع (HSE) المجموعات التي تضم 5 عمال أو أكثر فقط. وترى الجهة الرقابية وقسم الموارد البشرية لدى صاحب العمل المجموعات التي تضم 10 عمال أو أكثر فقط. تُخفى المجموعات الأصغر، ولا تُظهر الأرقام أبدًا اسمك أو أي سجل عنك وحدك. اختيارك بشأن الإحصاءات المجهولة يحدد فقط ما إذا كنت تُحسب أيضًا في إحصاءات الصحة العامة.',
  },
  flag: {
    prior_heat_illness: {
      name: 'مرض بسبب الحر سابقًا',
      explain: 'مرضت بسبب الحر من قبل. ينبهك التطبيق مبكرًا ويعطيك راحة أكثر.',
    },
    heat_sensitive_medication: {
      name: 'دواء يجعل الحر أصعب',
      explain: 'بعض الأدوية تجعل الحر أصعب على جسمك. ينبهك التطبيق مبكرًا ويعطيك راحة أكثر.',
    },
    hr_suppressing_medication: {
      name: 'دواء أو جهاز يبطئ القلب',
      explain: 'قد لا يُظهر نبض قلبك الإجهاد الحراري. لا يستخدم التطبيق نبض قلبك، وينبهك مبكرًا.',
    },
    recent_illness: {
      name: 'مرض مؤخرًا',
      explain: 'المرض في الأيام الأخيرة يجعل الحر أصعب على جسمك. ينبهك التطبيق مبكرًا ويعطيك راحة أكثر.',
    },
    poor_sleep: {
      name: 'قلة النوم',
      explain: 'قلة النوم تجعل الحر أصعب على جسمك. ينبهك التطبيق مبكرًا ويعطيك راحة أكثر.',
    },
    fasting: {
      name: 'الصيام',
      explain: 'لا يذكّرك التطبيق بالشرب في ساعات الصيام. وينبهك مبكرًا ويعطيك راحة أكثر.',
    },
    heat_rash_sunburn: {
      name: 'طفح حراري أو حروق شمس',
      explain: 'الطفح أو حروق الشمس تمنع جلدك من التعرق جيدًا. ينبهك التطبيق مبكرًا ويعطيك راحة أكثر.',
    },
    oh_review_required: {
      name: 'مطلوب فحص من الممرض',
      explain: 'سيتحدث معك ممرض العيادة على انفراد عن العمل الآمن في الحر.',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'الحرارة فوق الحد الآمن لهذا العمل.',
    heat_near_limit: 'الحرارة قريبة من الحد الآمن لهذا العمل.',
    heat_within_limit: 'الحرارة ضمن الحد الآمن لهذا العمل.',
    work_rest: 'التزم بأوقات العمل والراحة في كل ساعة.',
    clothing: 'ملابس عملك تحبس الحرارة، لذا الحد أقل.',
    not_used_limit: 'لم تعتد الحر بعد، لذا حدك أقل.',
    lower_limit: 'حدك أقل اليوم حفاظًا على سلامتك.',
    stricter_rest: 'لديك فترات راحة إضافية اليوم حفاظًا على سلامتك.',
    heat_time_left: 'وقت عملك في الحر محدود حتى تعتاد الحر.',
    heat_time_used: 'انتهى وقت عملك في الحر لهذا اليوم.',
    suit: 'ملابس واقية محكمة: حدود الحرارة مجرد دليل تقريبي.',
    less_certain: 'تقدير الحرارة أقل دقة هنا.',
    time_to_limit: 'بهذا المعدل من العمل، يقترب انتهاء وقتك الآمن في الحر.',
    limit_reached: 'بلغت حدك الآمن من الحرارة لهذه الوردية. استرح في مكان بارد.',
    no_limit_soon: 'لا حد حراري قريب بهذا المعدل من العمل.',
    limit_stays: 'الراحة وحدها لا تعيد ضبط حدك الحراري اليوم.',
    fasting_limit: 'صيام: أنت لا تشرب، لذا حدك أقل.',
    level_stays: 'يبقى هذا التحذير حتى يسمح لك المسعف أو المشرف.',
    no_hot_work: 'لا مزيد من العمل في الحر لك اليوم.',
    level_held: 'يبقى المستوى مرتفعًا قليلًا بعد أن تخف الحرارة.',
    safe_default: 'بعض البيانات ناقصة أو خاطئة، لذا يستخدم التطبيق قيمًا آمنة.',
    checkin_due: 'حان وقت أسئلة الاطمئنان.',
    buddy: 'اعمل مع زميل اليوم.',
    no_lone_work: 'لا تعمل وحدك في هذا الحر.',
    fasting_reminders: 'صيام: لا تذكير بالشرب. استرح في الظل وبرّد جسمك.',
    water_stop: 'توقف عن شرب الماء العادي حتى يفحصك المسعف.',
    check_sensor: 'جهاز قياس الحرارة في الموقع يحتاج إلى فحص.',
    extreme_heat: 'حر ورطوبة شديدان: يُنصح بإيقاف العمل.',
    hot_surfaces: 'الأسطح الساخنة هنا تزيد الحرارة. وهذا محسوب.',
    site_sensor: 'قراءة الحرارة من جهاز الموقع.',
    zone_high: 'منطقة حرارة عالية: أوقات عمل وراحة صارمة، ولا عمل منفردًا.',
    zone_medium: 'منطقة حرارة متوسطة: أوقات عمل وراحة محددة، ولا عمل منفردًا.',
    zone_low: 'منطقة حرارة منخفضة: عمل عادي مع الماء والاستراحات.',
    zone_unknown: 'منطقة الحرارة غير معروفة، لذا تُطبق أشد القواعد.',
    essential_only: 'الحر شديد على العمل العادي: المهام الضرورية فقط.',
    permit: 'هذا العمل يحتاج إلى تصريح عمل في الحر.',
    not_used_reassign: 'لم تعتد الحر بعد: ستحصل على عمل خارج هذه المنطقة.',
    not_used_not_alone: 'لم تعتد الحر بعد: لا تعمل وحدك هنا.',
    not_used_plan: 'لم تعتد الحر بعد: اتبع خطتك لتعتاده.',
    midday: 'استراحة الظهيرة: لا عمل تحت الشمس الآن.',
    midday_other: 'وقت استراحة الظهيرة، لكن هذه المهمة ليست تحت الشمس.',
    heat_unknown: 'لا توجد قراءة حرارة، لذا لا يمكن التحقق من قاعدة إيقاف العمل.',
    heat_stop: 'الحر شديد: يجب إيقاف العمل.',
    band_not_used: 'السوار غير مستخدم. التنبيهات تعتمد على الطقس والعمل.',
    band_check: 'بيانات السوار ناقصة أو ضعيفة. تأكد أن السوار مثبت جيدًا.',
    band_starting: 'السوار يبدأ العمل (أول 30 دقيقة). التنبيهات تعتمد على الطقس والعمل.',
    band_odd: 'قراءة غير عادية من السوار. سيطمئن عليك زميلك.',
    strain_very_high: 'إجهاد حراري مرتفع جدًا حسب التقدير. أوقف العمل وبرّد جسمك.',
    strain_high: 'إجهاد حراري مرتفع حسب التقدير. استرح في مكان بارد.',
    strain_rising: 'تقدير الإجهاد الحراري يرتفع. أجب عن أسئلة الاطمئنان.',
    effort_high: 'عملت بجهد كبير لوقت طويل. استرح الآن.',
    age_unknown: 'العمر غير محدد، لذا يُستخدم حد أكثر أمانًا.',
    band_ok: 'السوار: لا تحذير.',
    no_checkin: 'لا أسئلة اطمئنان بعد اليوم.',
    checkin_ok: 'أسئلة الاطمئنان: لا علامات تحذير.',
    too_much_water: 'ماء كثير مع علامات تحذير. توقف عن الشرب واذهب إلى المسعف.',
    worse: 'تشعر بأنك أسوأ من قبل. اتصل بـ 998 وابدأ التبريد الآن.',
    not_better: 'لا تحسن بعد 30 دقيقة. اتصل بـ 998 واستمر في التبريد.',
    sx_thirst: 'أنت عطشان. اشرب الماء الآن.',
    sx_overdrink: 'لا تشرب ماءً زائدًا. أخبر المسعف إذا شعرت بتوعك.',
    sx_t1: 'إجابة الاطمئنان: استرح في الظل واشرب الماء.',
    sx_t2: 'إجابة الاطمئنان: أوقف العمل في الحر واطلب المسعف الآن.',
    sx_t3: 'تم الإبلاغ عن علامة خطر. اتصل بـ 998 وابدأ التبريد الآن.',
    colour_ok: 'فحص اللون: جيد. استمر في شرب الماء.',
    colour_more: 'فحص اللون: اشرب ماءً أكثر.',
    colour_dark: 'فحص اللون: غامق جدًا. اشرب الماء واسترح في الظل.',
    colour_dark_again: 'فحص اللون ما زال غامقًا جدًا. استرح واشرب الماء وأخبر المسعف.',
    colour_very_dark: 'فحص اللون: غامق للغاية. استرح وبرّد جسمك واشرب الماء.',
    too_much_today: 'شربت كمية كبيرة جدًا اليوم. تمهّل.',
    slow_down: 'تمهّل. شربت كثيرًا من الماء في هذه الساعة.',
    no_weather: 'لا توجد بيانات طقس، لذا يفترض التطبيق ساعة شديدة الحر.',
    weather_old: 'بيانات الطقس قديمة، لذا هي أقل دقة.',
    weather_old_margin: 'بيانات الطقس قديمة جدًا، لذا أُضيف هامش أمان.',
    src_forecast: 'الطقس من التوقعات.',
    src_archive: 'الطقس من سجلات الطقس.',
    src_cached: 'الطقس من توقعات محفوظة.',
    rest_cooled: 'الاستراحات في مكان راحة بارد ومكيّف.',
    rest_shade_only: 'لا يوجد هنا إلا الظل للاستراحة، لذا تحتاج إلى راحة أكثر.',
    recovery_review: 'استرح 30 دقيقة في مكان بارد. ثم يجب أن يسمح لك مشرف أو مسعف.',
    recovery_cleared: 'سُمح لك بالعودة إلى العمل. استمر في أخذ استراحاتك.',
    resume_check: 'استرح حتى يسمح لك فحص الحرارة بالعودة إلى هذا العمل.',
    task_too_hot: 'الجو حار جدًا للعودة إلى هذه المهمة الآن. انتقل إلى عمل أخف أو أبرد.',
    work_bout: 'بقي وقت عمل قصير فقط قبل استراحتك التالية.',
    drinks_counted: 'الماء الذي تسجله يُحسب في حدك الحراري.',
    drink_to_restart: 'اشرب الماء وسجّله واسترح قبل أن تبدأ العمل في الحر مرة أخرى.',
  }),
}

// ─────────────────────────────── Urdu (RTL, Nastaliq) ───────────────────────────────

const UR: Catalog = {
  level: {
    safe: { name: 'کم خطرہ', meaning: 'معمول کا کام۔ پانی پیتے رہیں اور وقفے لیتے رہیں۔' },
    caution: { name: 'احتیاط', meaning: 'گرمی ہے۔ بار بار پانی پئیں اور سائے میں آرام کریں۔' },
    high: { name: 'زیادہ خطرہ', meaning: 'بہت گرمی ہے۔ کام کم کریں اور سائے میں زیادہ آرام کریں۔' },
    stop: { name: 'کام روکیں', meaning: 'گرمی میں کام ابھی روک دیں۔ سائے میں جا کر آرام کریں۔' },
    emergency: { name: 'ایمرجنسی', meaning: 'خطرہ۔ 998 پر کال کریں اور ابھی ٹھنڈا کرنا شروع کریں۔' },
  },
  action: {
    drink_water: 'ابھی پانی پئیں',
    shade_breaks: 'باقاعدگی سے سائے میں وقفہ لیں',
    reduce_intensity: 'آہستہ اور ہلکا کام کریں',
    rotate_task: 'ٹھنڈی جگہ کے ہلکے کام پر جائیں',
    rest_shade_now: 'ابھی سائے میں آرام کریں',
    cool_down: 'جسم ٹھنڈا کریں: جلد گیلی کریں، پنکھا چلائیں',
    stop_work: 'ابھی کام روک دیں',
    buddy_check: 'اپنے ساتھی کی خبر لیں',
    first_aider_check: 'ابھی فرسٹ ایڈر کو بلائیں',
    call_998: 'ابھی 998 پر کال کریں',
    cool_first: 'پہلے ٹھنڈا کریں، پھر ہسپتال لے جائیں',
    stay_with_worker: 'ان کے ساتھ رہیں، اکیلا نہ چھوڑیں',
    midday_break: 'دوپہر کا وقفہ: دھوپ میں کام نہیں',
    acclimatization_plan: 'گرمی میں نئے ہیں: شروع میں کم کام کریں',
    occ_health_review: 'معائنے کے لیے کلینک کی نرس سے ملیں',
    check_sensor: 'دیکھیں کہ سینسر کام کر رہا ہے',
    symptom_checkin: 'طبیعت کے سوالوں کے جواب دیں',
    no_lone_work: 'اکیلے کام نہ کریں',
    electrolytes: 'نمکیات والا مشروب (ORS) پئیں، نمک کی گولیاں نہیں',
    restrict_fluids: 'ابھی پانی پینا بند کریں۔ فرسٹ ایڈر سے ملیں۔',
    medical_evaluation: 'آج ڈاکٹر کو دکھائیں',
    no_hot_work_today: 'آج مزید گرمی میں کام نہیں',
  },
  action_with: {
    rest_shade_now: '{min} منٹ سائے میں آرام کریں',
    drink_water: 'ابھی {ml} ملی لیٹر پانی پئیں',
    drink_water_every: 'ہر {min} منٹ بعد {ml} ملی لیٹر پانی پئیں',
    shade_breaks: '{work} منٹ کام، {rest} منٹ آرام',
    midday_break: '{from} سے {to} تک دھوپ میں کام نہیں',
  },
  symptom: {
    thirst: { self: 'کیا آپ کو بہت پیاس لگی ہے؟', buddy: 'کیا آپ کے ساتھی کو بہت پیاس لگی ہے؟' },
    heat_rash: {
      self: 'کیا آپ کی جلد پر خارش والے سرخ دانے ہیں؟',
      buddy: 'کیا آپ کے ساتھی کی جلد پر خارش والے سرخ دانے ہیں؟',
    },
    cramps: { self: 'کیا آپ کے پٹھوں میں دردناک اینٹھن ہے؟', buddy: 'کیا آپ کے ساتھی کے پٹھوں میں دردناک اینٹھن ہے؟' },
    cramps_persistent: {
      self: 'کیا اینٹھن ایک گھنٹہ یا اس سے زیادہ رہی ہے؟',
      buddy: 'کیا آپ کے ساتھی کی اینٹھن ایک گھنٹہ یا اس سے زیادہ رہی ہے؟',
    },
    headache: { self: 'کیا آپ کے سر میں درد ہے؟', buddy: 'کیا آپ کے ساتھی کے سر میں درد ہے؟' },
    dizziness: { self: 'کیا آپ کو چکر آ رہے ہیں؟', buddy: 'کیا آپ کے ساتھی کو چکر آ رہے ہیں؟' },
    nausea: { self: 'کیا آپ کا جی متلا رہا ہے؟', buddy: 'کیا آپ کے ساتھی کا جی متلا رہا ہے؟' },
    weakness_fatigue: { self: 'کیا آپ بہت تھکے ہوئے یا کمزور ہیں؟', buddy: 'کیا آپ کا ساتھی بہت تھکا ہوا یا کمزور ہے؟' },
    fainted: {
      self: 'کیا آپ بے ہوش ہوئے، چاہے ایک لمحے کے لیے؟',
      buddy: 'کیا آپ کا ساتھی بے ہوش ہوا، چاہے ایک لمحے کے لیے؟',
    },
    brown_urine: {
      self: 'کیا آپ کا پیشاب چائے یا کولا جیسا بھورا ہے؟',
      buddy: 'کیا آپ کا ساتھی کہتا ہے کہ اس کا پیشاب بھورا ہے؟',
    },
    drank_a_lot: {
      self: 'کیا آپ نے پچھلے ایک گھنٹے میں 6 گلاس (1.5 لیٹر) سے زیادہ پانی پیا؟',
      buddy: 'کیا آپ کے ساتھی نے پچھلے ایک گھنٹے میں 6 گلاس (1.5 لیٹر) سے زیادہ پانی پیا؟',
    },
    swollen_hands: { self: 'کیا آپ کے ہاتھ سوجے ہوئے ہیں؟', buddy: 'کیا آپ کے ساتھی کے ہاتھ سوجے ہوئے ہیں؟' },
    repeated_vomiting: { self: 'کیا آپ کو ایک سے زیادہ بار الٹی ہوئی؟', buddy: 'کیا آپ کے ساتھی کو ایک سے زیادہ بار الٹی ہوئی؟' },
    chest_pain: {
      self: 'کیا آپ کے سینے میں درد ہے یا سانس لینے میں مشکل ہے؟',
      buddy: 'کیا آپ کے ساتھی کے سینے میں درد ہے یا سانس لینے میں مشکل ہے؟',
    },
    confusion: {
      self: 'کیا آپ کو ذہنی الجھن محسوس ہو رہی ہے؟',
      buddy: 'کیا آپ کا ساتھی الجھا ہوا ہے یا عجیب حرکتیں کر رہا ہے؟',
    },
    slurred_speech: {
      self: 'کیا آپ کو صاف بولنے میں مشکل ہو رہی ہے؟',
      buddy: 'کیا آپ کے ساتھی کی زبان لڑکھڑا رہی ہے یا بات صاف نہیں ہے؟',
    },
    unsteady_walking: {
      self: 'کیا آپ لڑکھڑا رہے ہیں یا سیدھا نہیں چل پا رہے؟',
      buddy: 'کیا آپ کا ساتھی لڑکھڑا رہا ہے یا سیدھا نہیں چل پا رہا؟',
    },
    collapsed_unresponsive: {
      self: 'کیا آپ اچانک گر پڑے اور اب بھی ٹھیک محسوس نہیں کر رہے؟',
      buddy: 'کیا آپ کا ساتھی گر پڑا ہے، یا جواب نہیں دے رہا؟',
    },
    seizure: { self: 'کیا آپ کو دورہ پڑا (جھٹکے آئے)؟', buddy: 'کیا آپ کے ساتھی کو جھٹکے آئے یا دورہ پڑا؟' },
  },
  checkin: {
    self_intro: 'ہر سوال کا جواب دیں: ہاں یا نہیں۔',
    buddy_intro: 'اپنے ساتھی کو دیکھیں۔ جواب دیں: ہاں یا نہیں۔',
    trend_question: 'پہلے کے مقابلے میں اب آپ کیسا محسوس کر رہے ہیں؟',
    better: 'بہتر',
    same: 'ویسا ہی',
    worse: 'پہلے سے برا',
  },
  urine: {
    question: 'آپ کے پیشاب کا رنگ کیسا ہے؟ سب سے ملتے رنگ پر ٹیپ کریں۔',
    ok: 'ٹھیک ہے۔ پانی پیتے رہیں۔',
    drink_more: 'اور پانی پئیں۔',
    dark: 'رنگ بہت گہرا ہے۔ ابھی پانی پئیں اور سائے میں آرام کریں۔',
  },
  emergency: {
    title: 'ایمرجنسی۔ ابھی قدم اٹھائیں۔',
    call_998: 'ایمبولینس کے لیے 998 پر کال کریں۔',
    cool_first: 'پہلے ٹھنڈا کریں۔ ہسپتال لے جانے سے پہلے ٹھنڈا کرنا شروع کریں۔',
    shade: 'انہیں سائے میں لے جائیں۔ فالتو کپڑے اتار دیں۔',
    immerse: 'سب سے اچھا: جسم کو گردن تک ٹھنڈے یا برف والے پانی میں رکھیں، ٹب یا ترپال میں۔ پانی ہلاتے رہیں۔',
    douse: 'ٹب نہیں ہے؟ ان پر مسلسل ٹھنڈا پانی ڈالیں اور پنکھا کریں۔',
    towels: 'یا برف والے پانی میں بھیگے تولیے رکھیں، ہر 1–2 منٹ میں بدلیں، اور برف کے پیک لگائیں۔',
    keep_cooling:
      'ایمبولینس آنے تک ٹھنڈا کرتے رہیں۔ تقریباً 15 منٹ بعد برف والے پانی سے نکال لیں، یا اس سے پہلے اگر وہ ٹھیک ہو جائیں۔',
    stay: 'ان کے ساتھ رہیں۔ انہیں کبھی اکیلا نہ چھوڑیں۔',
    fluids: 'پینے کو صرف تب دیں جب وہ پوری طرح جاگ رہے ہوں اور ہوش میں ہوں۔',
  },
  ui: {
    status: 'میری حالت',
    next_break: 'اگلا وقفہ {min} منٹ میں',
    break_now: 'وقفے کا وقت۔ سائے میں جائیں۔',
    drank_water: 'میں نے پانی پیا',
    feel_unwell: 'میری طبیعت ٹھیک نہیں',
    im_ok: 'میں ٹھیک ہوں',
    checkin: 'طبیعت کا حال',
    yes: 'ہاں',
    no: 'نہیں',
    privacy: 'رازداری',
    what_i_share: 'کیا شیئر ہوتا ہے',
    who_saw: 'میرا ڈیٹا کس نے دیکھا',
    offline: 'آف لائن موڈ',
    offline_note: 'نیٹ ورک نہیں ہے۔ اس فون پر انتباہ پھر بھی کام کرتے ہیں۔',
    battery_saver: 'بیٹری کی بچت',
    language: 'زبان',
    acknowledge: 'ٹھیک ہے، سمجھ آ گئی',
    help_coming: 'مدد آ رہی ہے۔',
    buddy: 'میرا ساتھی',
    buddy_alert: '{name} کو مدد کی ضرورت ہو سکتی ہے۔ ابھی جا کر دیکھیں۔',
    get_help: 'مدد بلائیں',
    slow_down_drinking: 'آہستہ پئیں۔ آپ نے اس گھنٹے بہت پانی پیا ہے۔',
    listen: 'سنیں',
    data_stays: 'آپ کا صحت کا ڈیٹا اسی فون پر رہتا ہے۔',
    flags_private: 'یہ صرف آپ دیکھتے ہیں۔ یہ آپ کے فون پر رہتا ہے۔',
    strain_estimate: 'گرمی کے دباؤ کا اندازہ',
    not_medical: 'یہ حفاظتی رہنمائی ہے، طبی ٹیسٹ نہیں۔',
    translation_draft: 'ابتدائی ترجمہ۔ ابھی جانچا نہیں گیا۔',
  },
  consent: {
    wearable: {
      title: 'میرے بینڈ سے دل کی دھڑکن',
      statement:
        'ظل ایپ میرے بینڈ سے اس فون پر دل کی دھڑکن پڑھ سکتی ہے تاکہ میری گرمی کے دباؤ کا اندازہ لگا سکے۔ یہ مجھے محفوظ رکھنے میں مدد کے لیے ایک اندازہ ہے، طبی پیمائش یا تشخیص نہیں۔ میرا سپروائزر اسے کبھی نہیں دیکھتا۔',
    },
    healthFlags: {
      title: 'صحت کی وہ باتیں جو گرمی کو میرے لیے زیادہ خطرناک بناتی ہیں',
      statement:
        'ظل ایپ میرے ہاں یا نہیں والے جوابات (مثلاً حال ہی کی بیماری، یا کوئی دوا جو گرمی برداشت کرنے پر اثر ڈالتی ہے) میرے انتباہ زیادہ سخت کرنے کے لیے استعمال کر سکتی ہے۔ میرے جوابات اسی فون پر رہتے ہیں اور میرے سپروائزر یا آجر کو کبھی نہیں دکھائے جاتے۔',
    },
    checkins: {
      title: 'علامات اور پانی پینے کے بارے میں سوالات',
      statement:
        'ظل ایپ مجھ سے میری طبیعت اور میرے پیشاب کا رنگ پوچھ سکتی ہے۔ میرے جوابات اسی فون پر رہتے ہیں۔ اگر میرا کیس آگے بڑھایا جائے تو فرسٹ ایڈر میری بتائی ہوئی علامات دیکھتا ہے تاکہ میری مدد کر سکے۔',
    },
    shareWithMedicOnEscalation: {
      title: 'کیس آگے بڑھنے پر پیشہ ورانہ صحت کے ساتھ شیئر کریں',
      statement:
        'اگر میرا کیس آگے بڑھایا جائے تو پیشہ ورانہ صحت کی نرس میری دیکھ بھال کے لیے میرے دل کی دھڑکن کے اندازے، صحت کی باتیں اور سوالات کے جوابات دیکھ سکتی ہے۔ انہیں کوئی اور نہیں دیکھتا، اور یہ کبھی میرے خلاف استعمال نہیں ہوتے۔',
    },
    aggregateStatistics: {
      title: 'مجھے گمنام اعداد و شمار میں شامل کریں',
      statement:
        'میرا ڈیٹا کام کے دوران گرمی کے بارے میں عوامی صحت کے اعداد و شمار میں گنا جا سکتا ہے۔ 10 سے کم افراد والے گروپ چھپائے جاتے ہیں تاکہ مجھے پہچانا نہ جا سکے۔',
    },
  },
  consent_info: {
    intro: 'چنیں کہ ظل ایپ کیا استعمال کر سکتی ہے۔ ہر انتخاب الگ ہے۔',
    voluntary: 'انکار کرنا ٹھیک ہے۔ آپ کو پھر بھی سب حفاظتی انتباہ ملیں گے۔',
    change_anytime: 'آپ کسی بھی وقت اپنا انتخاب بدل سکتے ہیں۔',
  },
  privacy_notice: {
    title: 'گروپ کی گنتی میں آپ کو کیسے شمار کیا جاتا ہے',
    statement:
      'آپ کے آجر پر قانونی فرض ہے کہ گرمی میں کام کو محفوظ رکھے۔ اس لیے ظل ایپ ہر کارکن کو گروپ کی گنتی میں شمار کرتی ہے، چاہے آپ نے «مجھے گمنام اعداد و شمار میں شامل کریں» نہ چنا ہو۔ سائٹ کا سیفٹی (HSE) مینیجر صرف 5 یا زیادہ کارکنوں کے گروپ دیکھتا ہے۔ ریگولیٹر اور آپ کے آجر کا ایچ آر صرف 10 یا زیادہ کارکنوں کے گروپ دیکھتے ہیں۔ چھوٹے گروپ چھپائے جاتے ہیں، اور یہ گنتی کبھی آپ کا نام یا صرف آپ سے متعلق کوئی ریکارڈ نہیں دکھاتی۔ گمنام اعداد و شمار کے بارے میں آپ کا انتخاب صرف یہ طے کرتا ہے کہ آپ عوامی صحت کے اعداد و شمار میں بھی شمار ہوں یا نہیں۔',
  },
  flag: {
    prior_heat_illness: {
      name: 'پہلے گرمی سے بیماری',
      explain: 'آپ پہلے گرمی سے بیمار ہوئے تھے۔ ایپ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    heat_sensitive_medication: {
      name: 'دوا جو گرمی کو مشکل بنائے',
      explain: 'کچھ دوائیں گرمی کو جسم کے لیے مشکل بنا دیتی ہیں۔ ایپ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    hr_suppressing_medication: {
      name: 'دل کی رفتار کم کرنے والی دوا یا آلہ',
      explain: 'ہو سکتا ہے آپ کی دھڑکن گرمی کا دباؤ نہ دکھائے۔ ایپ آپ کی دھڑکن استعمال نہیں کرتی اور آپ کو پہلے خبردار کرتی ہے۔',
    },
    recent_illness: {
      name: 'حال ہی میں بیمار',
      explain: 'حال ہی کی بیماری گرمی کو جسم کے لیے مشکل بنا دیتی ہے۔ ایپ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    poor_sleep: {
      name: 'کم نیند',
      explain: 'کم نیند گرمی کو جسم کے لیے مشکل بنا دیتی ہے۔ ایپ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    fasting: {
      name: 'روزہ',
      explain: 'روزے کے اوقات میں ایپ پانی پینے کی یاد نہیں دلاتی۔ یہ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    heat_rash_sunburn: {
      name: 'گرمی دانے یا دھوپ سے جلن',
      explain: 'دانوں یا دھوپ کی جلن سے جلد ٹھیک سے پسینہ نہیں نکالتی۔ ایپ آپ کو پہلے خبردار کرتی ہے اور زیادہ آرام دیتی ہے۔',
    },
    oh_review_required: {
      name: 'نرس سے معائنہ ضروری',
      explain: 'کلینک کی نرس آپ سے اکیلے میں گرمی میں محفوظ کام کے بارے میں بات کرے گی۔',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'گرمی اس کام کی محفوظ حد سے زیادہ ہے۔',
    heat_near_limit: 'گرمی اس کام کی محفوظ حد کے قریب ہے۔',
    heat_within_limit: 'گرمی اس کام کی محفوظ حد کے اندر ہے۔',
    work_rest: 'ہر گھنٹے کام اور آرام کے اوقات کی پابندی کریں۔',
    clothing: 'آپ کے کام کے کپڑے گرمی روکتے ہیں، اس لیے حد کم ہے۔',
    not_used_limit: 'آپ ابھی گرمی کے عادی نہیں، اس لیے آپ کی حد کم ہے۔',
    lower_limit: 'آپ کی حفاظت کے لیے آج آپ کی حد کم ہے۔',
    stricter_rest: 'آپ کی حفاظت کے لیے آج آپ کو آرام کے زیادہ وقفے ملیں گے۔',
    heat_time_left: 'گرمی کا عادی ہونے تک گرمی میں آپ کے کام کا وقت محدود ہے۔',
    heat_time_used: 'آج کے لیے گرمی میں آپ کے کام کا وقت ختم ہو گیا ہے۔',
    suit: 'بند حفاظتی لباس: گرمی کی حدیں صرف ایک موٹا اندازہ ہیں۔',
    less_certain: 'یہاں گرمی کا اندازہ کم یقینی ہے۔',
    time_to_limit: 'کام کی اس رفتار پر گرمی میں آپ کا محفوظ وقت ختم ہو رہا ہے۔',
    limit_reached: 'اس شفٹ کے لیے آپ کی گرمی کی محفوظ حد پوری ہو گئی ہے۔ کسی ٹھنڈی جگہ آرام کریں۔',
    no_limit_soon: 'کام کی اس رفتار پر جلد کوئی گرمی کی حد نہیں۔',
    limit_stays: 'صرف آرام سے آج آپ کی گرمی کی حد دوبارہ شروع نہیں ہوتی۔',
    fasting_limit: 'روزہ: آپ پانی نہیں پی رہے، اس لیے آپ کی حد کم ہے۔',
    level_stays: 'یہ انتباہ تب تک رہے گا جب تک فرسٹ ایڈر یا سپروائزر آپ کو اجازت نہ دے۔',
    no_hot_work: 'آج آپ کے لیے گرمی میں مزید کام نہیں۔',
    level_held: 'گرمی کم ہونے کے بعد بھی سطح کچھ دیر اونچی رہتی ہے۔',
    safe_default: 'کچھ ڈیٹا موجود نہیں یا غلط ہے، اس لیے ایپ محفوظ قدریں استعمال کرتی ہے۔',
    checkin_due: 'آپ کے طبیعت کے سوالات کا وقت ہو گیا ہے۔',
    buddy: 'آج کسی ساتھی کے ساتھ کام کریں۔',
    no_lone_work: 'اس گرمی میں اکیلے کام نہ کریں۔',
    fasting_reminders: 'روزہ: پانی پینے کی یاد دہانی نہیں۔ سائے میں آرام کریں اور جسم ٹھنڈا کریں۔',
    water_stop: 'جب تک فرسٹ ایڈر آپ کو نہ دیکھ لے، سادہ پانی پینا بند کریں۔',
    check_sensor: 'سائٹ کا گرمی کا سینسر چیک کرنے کی ضرورت ہے۔',
    extreme_heat: 'شدید گرمی اور نمی: کام روکنے کا مشورہ ہے۔',
    hot_surfaces: 'یہاں گرم سطحیں گرمی بڑھاتی ہیں۔ یہ شامل کیا گیا ہے۔',
    site_sensor: 'گرمی کی ریڈنگ سائٹ کے سینسر سے۔',
    zone_high: 'گرمی کا زون زیادہ: کام اور آرام کے سخت اوقات، اکیلے کام نہیں۔',
    zone_medium: 'گرمی کا زون درمیانہ: کام اور آرام کے مقررہ اوقات، اکیلے کام نہیں۔',
    zone_low: 'گرمی کا زون کم: پانی اور وقفوں کے ساتھ معمول کا کام۔',
    zone_unknown: 'گرمی کا زون معلوم نہیں، اس لیے سب سے سخت قواعد لاگو ہیں۔',
    essential_only: 'عام کام کے لیے بہت گرمی ہے: صرف ضروری کام۔',
    permit: 'اس کام کے لیے گرمی میں کام کا پرمٹ ضروری ہے۔',
    not_used_reassign: 'ابھی گرمی کے عادی نہیں: آپ کو اس زون سے باہر کام ملے گا۔',
    not_used_not_alone: 'ابھی گرمی کے عادی نہیں: یہاں اکیلے کام نہ کریں۔',
    not_used_plan: 'ابھی گرمی کے عادی نہیں: عادی ہونے کے لیے اپنے منصوبے پر چلیں۔',
    midday: 'دوپہر کا وقفہ: ابھی دھوپ میں کام نہیں۔',
    midday_other: 'دوپہر کے وقفے کا وقت ہے، لیکن یہ کام دھوپ میں نہیں۔',
    heat_unknown: 'گرمی کی کوئی ریڈنگ نہیں، اس لیے کام روکنے کا قاعدہ چیک نہیں ہو سکتا۔',
    heat_stop: 'بہت گرمی ہے: کام روکنا ضروری ہے۔',
    band_not_used: 'بینڈ استعمال نہیں ہو رہا۔ انتباہ موسم اور کام پر مبنی ہیں۔',
    band_check: 'بینڈ کا ڈیٹا نہیں یا کمزور ہے۔ دیکھیں کہ بینڈ پہنا ہوا اور ٹھیک بندھا ہے۔',
    band_starting: 'بینڈ شروع ہو رہا ہے (پہلے 30 منٹ)۔ انتباہ موسم اور کام پر مبنی ہیں۔',
    band_odd: 'بینڈ کی غیر معمولی ریڈنگ۔ آپ کا ساتھی آپ کی خبر لے گا۔',
    strain_very_high: 'اندازے کے مطابق گرمی کا دباؤ بہت زیادہ ہے۔ کام روکیں اور جسم ٹھنڈا کریں۔',
    strain_high: 'اندازے کے مطابق گرمی کا دباؤ زیادہ ہے۔ کسی ٹھنڈی جگہ آرام کریں۔',
    strain_rising: 'گرمی کے دباؤ کا اندازہ بڑھ رہا ہے۔ طبیعت کے سوالات کا جواب دیں۔',
    effort_high: 'آپ نے بہت دیر تک بہت زیادہ محنت کی ہے۔ ابھی آرام کریں۔',
    age_unknown: 'عمر درج نہیں، اس لیے زیادہ محفوظ حد استعمال ہوتی ہے۔',
    band_ok: 'بینڈ: کوئی انتباہ نہیں۔',
    no_checkin: 'آج ابھی تک طبیعت کے سوالات نہیں ہوئے۔',
    checkin_ok: 'طبیعت کے سوالات: خطرے کی کوئی علامت نہیں۔',
    too_much_water: 'خطرے کی علامات کے ساتھ بہت زیادہ پانی۔ پینا بند کریں اور فرسٹ ایڈر سے ملیں۔',
    worse: 'پہلے سے زیادہ برا محسوس ہو رہا ہے۔ 998 پر کال کریں اور ابھی ٹھنڈا کرنا شروع کریں۔',
    not_better: '30 منٹ بعد بھی بہتری نہیں۔ 998 پر کال کریں اور ٹھنڈا کرتے رہیں۔',
    sx_thirst: 'آپ کو پیاس لگی ہے۔ ابھی پانی پئیں۔',
    sx_overdrink: 'زیادہ پانی نہ پئیں۔ طبیعت خراب لگے تو فرسٹ ایڈر کو بتائیں۔',
    sx_t1: 'سوال کا جواب: سائے میں آرام کریں اور پانی پئیں۔',
    sx_t2: 'سوال کا جواب: گرمی کا کام روکیں اور ابھی فرسٹ ایڈر کو بلائیں۔',
    sx_t3: 'خطرے کی علامت بتائی گئی ہے۔ 998 پر کال کریں اور ابھی ٹھنڈا کرنا شروع کریں۔',
    colour_ok: 'رنگ کی جانچ: ٹھیک ہے۔ پانی پیتے رہیں۔',
    colour_more: 'رنگ کی جانچ: مزید پانی پئیں۔',
    colour_dark: 'رنگ کی جانچ: بہت گہرا ہے۔ پانی پئیں اور سائے میں آرام کریں۔',
    colour_dark_again: 'رنگ ابھی بھی بہت گہرا ہے۔ آرام کریں، پانی پئیں اور فرسٹ ایڈر کو بتائیں۔',
    colour_very_dark: 'رنگ کی جانچ: بہت ہی گہرا ہے۔ آرام کریں، جسم ٹھنڈا کریں اور پانی پئیں۔',
    too_much_today: 'آپ نے آج بہت زیادہ پانی پیا ہے۔ آہستہ پئیں۔',
    slow_down: 'آہستہ پئیں۔ آپ نے اس گھنٹے بہت پانی پیا ہے۔',
    no_weather: 'موسم کا ڈیٹا نہیں، اس لیے ایپ ایک بہت گرم گھنٹہ فرض کرتی ہے۔',
    weather_old: 'موسم کا ڈیٹا پرانا ہے، اس لیے کم یقینی ہے۔',
    weather_old_margin: 'موسم کا ڈیٹا بہت پرانا ہے، اس لیے حفاظتی گنجائش شامل کی گئی ہے۔',
    src_forecast: 'موسم پیشگوئی سے۔',
    src_archive: 'موسم کے ریکارڈ سے۔',
    src_cached: 'موسم محفوظ کی ہوئی پیشگوئی سے۔',
    rest_cooled: 'وقفے ٹھنڈی، ایئر کنڈیشنڈ آرام گاہ میں ہیں۔',
    rest_shade_only: 'یہاں وقفے کے لیے صرف سایہ ہے، اس لیے آپ کو زیادہ آرام چاہیے۔',
    recovery_review: 'کسی ٹھنڈی جگہ 30 منٹ آرام کریں۔ پھر سپروائزر یا فرسٹ ایڈر کو آپ کو اجازت دینی ہوگی۔',
    recovery_cleared: 'آپ کو دوبارہ کام کی اجازت مل گئی ہے۔ وقفے لیتے رہیں۔',
    resume_check: 'آرام کریں جب تک گرمی کی جانچ آپ کو اس کام پر واپس جانے کی اجازت نہ دے۔',
    task_too_hot: 'ابھی اس کام پر واپس جانے کے لیے بہت گرمی ہے۔ ہلکے یا ٹھنڈے کام پر جائیں۔',
    work_bout: 'اگلے آرام سے پہلے کام کا تھوڑا سا وقت باقی ہے۔',
    drinks_counted: 'جو پانی آپ درج کرتے ہیں وہ آپ کی گرمی کی حد میں شمار ہوتا ہے۔',
    drink_to_restart: 'پانی پئیں، اسے درج کریں اور گرمی میں دوبارہ کام شروع کرنے سے پہلے آرام کریں۔',
  }),
}

// ─────────────────────────────── Hindi ───────────────────────────────

const HI: Catalog = {
  level: {
    safe: { name: 'कम खतरा', meaning: 'सामान्य काम। पानी पीते रहें और ब्रेक लेते रहें।' },
    caution: { name: 'सावधान', meaning: 'गर्मी है। बार-बार पानी पिएँ और छाँव में आराम करें।' },
    high: { name: 'ज्यादा खतरा', meaning: 'बहुत गर्मी है। कम काम करें, छाँव में ज्यादा आराम करें।' },
    stop: { name: 'काम रोकें', meaning: 'गर्मी में काम अभी रोकें। छाँव में जाकर आराम करें।' },
    emergency: { name: 'इमरजेंसी', meaning: 'खतरा। 998 पर कॉल करें और अभी ठंडा करना शुरू करें।' },
  },
  action: {
    drink_water: 'अभी पानी पिएँ',
    shade_breaks: 'थोड़ी-थोड़ी देर में छाँव में ब्रेक लें',
    reduce_intensity: 'धीरे और हल्का काम करें',
    rotate_task: 'ठंडी जगह का हल्का काम करें',
    rest_shade_now: 'अभी छाँव में आराम करें',
    cool_down: 'शरीर ठंडा करें: पानी डालें, पंखा चलाएँ',
    stop_work: 'अभी काम रोक दें',
    buddy_check: 'अपने साथी का हाल देखें',
    first_aider_check: 'अभी फर्स्ट एडर को बुलाएँ',
    call_998: 'अभी 998 पर कॉल करें',
    cool_first: 'पहले ठंडा करें, फिर अस्पताल ले जाएँ',
    stay_with_worker: 'उनके साथ रहें, अकेला न छोड़ें',
    midday_break: 'दोपहर का ब्रेक: धूप में काम नहीं',
    acclimatization_plan: 'गर्मी में नए हैं: शुरू में कम काम करें',
    occ_health_review: 'जाँच के लिए क्लिनिक की नर्स से मिलें',
    check_sensor: 'देखें कि सेंसर काम कर रहा है',
    symptom_checkin: 'तबीयत वाले सवालों के जवाब दें',
    no_lone_work: 'अकेले काम न करें',
    electrolytes: 'इलेक्ट्रोलाइट ड्रिंक (ORS) पिएँ, नमक की गोली नहीं',
    restrict_fluids: 'अभी पानी पीना बंद करें। फर्स्ट एडर से मिलें।',
    medical_evaluation: 'आज डॉक्टर को दिखाएँ',
    no_hot_work_today: 'आज और गर्मी वाला काम नहीं',
  },
  action_with: {
    rest_shade_now: '{min} मिनट छाँव में आराम करें',
    drink_water: 'अभी {ml} मि.ली. पानी पिएँ',
    drink_water_every: 'हर {min} मिनट में {ml} मि.ली. पानी पिएँ',
    shade_breaks: '{work} मिनट काम, {rest} मिनट आराम',
    midday_break: '{from} से {to} तक धूप में काम नहीं',
  },
  symptom: {
    thirst: { self: 'क्या आपको बहुत प्यास लगी है?', buddy: 'क्या आपके साथी को बहुत प्यास लगी है?' },
    heat_rash: {
      self: 'क्या आपको घमौरियाँ (खुजली वाले लाल दाने) हैं?',
      buddy: 'क्या आपके साथी को घमौरियाँ (खुजली वाले लाल दाने) हैं?',
    },
    cramps: { self: 'क्या आपको दर्द वाली ऐंठन हो रही है?', buddy: 'क्या आपके साथी को दर्द वाली ऐंठन हो रही है?' },
    cramps_persistent: {
      self: 'क्या ऐंठन 1 घंटे या उससे ज्यादा समय से है?',
      buddy: 'क्या आपके साथी की ऐंठन 1 घंटे या उससे ज्यादा समय से है?',
    },
    headache: { self: 'क्या आपके सिर में दर्द है?', buddy: 'क्या आपके साथी के सिर में दर्द है?' },
    dizziness: { self: 'क्या आपको चक्कर आ रहे हैं?', buddy: 'क्या आपके साथी को चक्कर आ रहे हैं?' },
    nausea: { self: 'क्या आपका जी मिचला रहा है?', buddy: 'क्या आपके साथी का जी मिचला रहा है?' },
    weakness_fatigue: { self: 'क्या आप बहुत थके हुए या कमजोर हैं?', buddy: 'क्या आपका साथी बहुत थका हुआ या कमजोर है?' },
    fainted: { self: 'क्या आप बेहोश हुए, एक पल के लिए भी?', buddy: 'क्या आपका साथी बेहोश हुआ, एक पल के लिए भी?' },
    brown_urine: {
      self: 'क्या आपका पेशाब चाय या कोला जैसा भूरा है?',
      buddy: 'क्या आपका साथी कहता है कि उसका पेशाब भूरा है?',
    },
    drank_a_lot: {
      self: 'क्या आपने पिछले 1 घंटे में 6 गिलास (1.5 लीटर) से ज्यादा पानी पिया?',
      buddy: 'क्या आपके साथी ने पिछले 1 घंटे में 6 गिलास (1.5 लीटर) से ज्यादा पानी पिया?',
    },
    swollen_hands: { self: 'क्या आपके हाथ सूजे हुए हैं?', buddy: 'क्या आपके साथी के हाथ सूजे हुए हैं?' },
    repeated_vomiting: { self: 'क्या आपको एक से ज्यादा बार उल्टी हुई?', buddy: 'क्या आपके साथी को एक से ज्यादा बार उल्टी हुई?' },
    chest_pain: {
      self: 'क्या आपके सीने में दर्द है या साँस लेने में तकलीफ है?',
      buddy: 'क्या आपके साथी के सीने में दर्द है या साँस लेने में तकलीफ है?',
    },
    confusion: {
      self: 'क्या आपको दिमाग में उलझन लग रही है?',
      buddy: 'क्या आपका साथी उलझन में है या अजीब बर्ताव कर रहा है?',
    },
    slurred_speech: {
      self: 'क्या आपको साफ बोलने में दिक्कत हो रही है?',
      buddy: 'क्या आपके साथी की बोली लड़खड़ा रही है या साफ नहीं है?',
    },
    unsteady_walking: {
      self: 'क्या आप लड़खड़ा रहे हैं या सीधा नहीं चल पा रहे?',
      buddy: 'क्या आपका साथी लड़खड़ा रहा है या सीधा नहीं चल पा रहा?',
    },
    collapsed_unresponsive: {
      self: 'क्या आप अचानक गिर पड़े और अब भी ठीक नहीं लग रहा?',
      buddy: 'क्या आपका साथी गिर पड़ा है, या जवाब नहीं दे रहा?',
    },
    seizure: { self: 'क्या आपको दौरा पड़ा (झटके आए)?', buddy: 'क्या आपके साथी को झटके आए या दौरा पड़ा?' },
  },
  checkin: {
    self_intro: 'हर सवाल का जवाब दें: हाँ या नहीं।',
    buddy_intro: 'अपने साथी को देखें। जवाब दें: हाँ या नहीं।',
    trend_question: 'पहले के मुकाबले अब आप कैसा महसूस कर रहे हैं?',
    better: 'बेहतर',
    same: 'पहले जैसा',
    worse: 'ज्यादा खराब',
  },
  urine: {
    question: 'आपके पेशाब का रंग कैसा है? सबसे मिलते रंग पर टैप करें।',
    ok: 'ठीक है। पानी पीते रहें।',
    drink_more: 'और पानी पिएँ।',
    dark: 'रंग बहुत गहरा है। अभी पानी पिएँ और छाँव में आराम करें।',
  },
  emergency: {
    title: 'इमरजेंसी। अभी कदम उठाएँ।',
    call_998: 'एम्बुलेंस के लिए 998 पर कॉल करें।',
    cool_first: 'पहले ठंडा करें। अस्पताल ले जाने से पहले ठंडा करना शुरू करें।',
    shade: 'उन्हें छाँव में ले जाएँ। फालतू कपड़े उतार दें।',
    immerse: 'सबसे अच्छा: शरीर को गर्दन तक ठंडे या बर्फ वाले पानी में रखें, टब या तिरपाल में। पानी हिलाते रहें।',
    douse: 'टब नहीं है? उन पर लगातार ठंडा पानी डालें और पंखा करें।',
    towels: 'या बर्फ वाले पानी में भीगे तौलिए रखें, हर 1–2 मिनट में बदलें, और बर्फ की थैली लगाएँ।',
    keep_cooling:
      'एम्बुलेंस आने तक ठंडा करते रहें। लगभग 15 मिनट बाद बर्फ वाले पानी से निकाल लें, या पहले ही, अगर वे ठीक हो जाएँ।',
    stay: 'उनके साथ रहें। उन्हें कभी अकेला न छोड़ें।',
    fluids: 'पीने को तभी दें जब वे पूरी तरह जागे हुए और होश में हों।',
  },
  ui: {
    status: 'मेरी स्थिति',
    next_break: 'अगला ब्रेक {min} मिनट में',
    break_now: 'ब्रेक का समय। छाँव में जाएँ।',
    drank_water: 'मैंने पानी पिया',
    feel_unwell: 'मेरी तबीयत ठीक नहीं',
    im_ok: 'मैं ठीक हूँ',
    checkin: 'तबीयत की जाँच',
    yes: 'हाँ',
    no: 'नहीं',
    privacy: 'प्राइवेसी',
    what_i_share: 'क्या शेयर होता है',
    who_saw: 'मेरा डेटा किसने देखा',
    offline: 'ऑफलाइन मोड',
    offline_note: 'नेटवर्क नहीं है। इस फोन पर चेतावनी फिर भी काम करती है।',
    battery_saver: 'बैटरी सेवर',
    language: 'भाषा',
    acknowledge: 'ठीक है, समझ आ गया',
    help_coming: 'मदद आ रही है।',
    buddy: 'मेरा साथी',
    buddy_alert: '{name} को मदद की जरूरत हो सकती है। अभी जाकर देखें।',
    get_help: 'मदद बुलाएँ',
    slow_down_drinking: 'धीरे पिएँ। आपने इस घंटे बहुत पानी पिया है।',
    listen: 'सुनें',
    data_stays: 'आपकी सेहत का डेटा इसी फोन पर रहता है।',
    flags_private: 'यह सिर्फ आप देखते हैं। यह आपके फोन पर रहता है।',
    strain_estimate: 'गर्मी के दबाव का अनुमान',
    not_medical: 'यह सुरक्षा गाइड है, मेडिकल टेस्ट नहीं।',
    translation_draft: 'शुरुआती अनुवाद। अभी जाँचा नहीं गया।',
  },
  consent: {
    wearable: {
      title: 'मेरे बैंड से दिल की धड़कन',
      statement:
        'ज़िल ऐप इस फोन पर मेरे बैंड से दिल की धड़कन पढ़ सकता है, ताकि मेरी गर्मी के दबाव का अनुमान लगा सके। यह मुझे सुरक्षित रखने में मदद के लिए एक अनुमान है, न कि कोई मेडिकल माप या बीमारी की पहचान। मेरा सुपरवाइज़र इसे कभी नहीं देखता।',
    },
    healthFlags: {
      title: 'सेहत की वे बातें जो गर्मी को मेरे लिए ज़्यादा खतरनाक बनाती हैं',
      statement:
        'ज़िल ऐप मेरे हाँ/ना वाले जवाबों (जैसे हाल की बीमारी, या कोई दवा जो गर्मी सहने की ताकत पर असर डालती है) का इस्तेमाल मेरी चेतावनियों को ज़्यादा सख्त बनाने के लिए कर सकता है। मेरे जवाब इसी फोन पर रहते हैं और मेरे सुपरवाइज़र या मालिक को कभी नहीं दिखाए जाते।',
    },
    checkins: {
      title: 'लक्षण और पानी पीने के बारे में सवाल',
      statement:
        'ज़िल ऐप मुझसे मेरी तबीयत और मेरे पेशाब का रंग पूछ सकता है। मेरे जवाब इसी फोन पर रहते हैं। अगर मेरा मामला आगे बढ़ाया जाता है, तो फर्स्ट एडर मेरे बताए लक्षण देखता है ताकि मेरी मदद कर सके।',
    },
    shareWithMedicOnEscalation: {
      title: 'मामला आगे बढ़ने पर व्यावसायिक स्वास्थ्य के साथ शेयर करें',
      statement:
        'अगर मेरा मामला आगे बढ़ाया जाता है, तो व्यावसायिक स्वास्थ्य की नर्स मेरी देखभाल के लिए मेरी धड़कन के अनुमान, सेहत की बातें और सवालों के जवाब देख सकती है। इन्हें और कोई नहीं देखता, और इनका इस्तेमाल कभी मेरे खिलाफ नहीं होता।',
    },
    aggregateStatistics: {
      title: 'मुझे गुमनाम आँकड़ों में गिनें',
      statement:
        'मेरा डेटा काम पर गर्मी के बारे में जन-स्वास्थ्य के आँकड़ों में गिना जा सकता है। 10 से कम लोगों वाले ग्रुप छिपाए जाते हैं, ताकि मुझे पहचाना न जा सके।',
    },
  },
  consent_info: {
    intro: 'चुनें कि ज़िल ऐप क्या इस्तेमाल कर सकता है। हर चुनाव अलग है।',
    voluntary: 'मना करना ठीक है। आपको फिर भी सारी सुरक्षा चेतावनियाँ मिलेंगी।',
    change_anytime: 'आप कभी भी अपना चुनाव बदल सकते हैं।',
  },
  privacy_notice: {
    title: 'ग्रुप की गिनती में आपको कैसे गिना जाता है',
    statement:
      'आपके मालिक का कानूनी फ़र्ज़ है कि गर्मी में काम को सुरक्षित रखे। इसलिए ज़िल ऐप हर कामगार को ग्रुप की गिनती में गिनता है, चाहे आपने “मुझे गुमनाम आँकड़ों में गिनें” न चुना हो। साइट का सेफ्टी (HSE) मैनेजर सिर्फ 5 या ज़्यादा कामगारों के ग्रुप देखता है। नियामक और आपके मालिक का HR सिर्फ 10 या ज़्यादा कामगारों के ग्रुप देखते हैं। छोटे ग्रुप छिपाए जाते हैं, और यह गिनती कभी आपका नाम या सिर्फ आपसे जुड़ा कोई रिकॉर्ड नहीं दिखाती। गुमनाम आँकड़ों के बारे में आपकी पसंद सिर्फ यह तय करती है कि आप जन-स्वास्थ्य के आँकड़ों में भी गिने जाएँ या नहीं।',
  },
  flag: {
    prior_heat_illness: {
      name: 'पहले गर्मी से बीमारी',
      explain: 'आप पहले गर्मी से बीमार हुए थे। ऐप आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    heat_sensitive_medication: {
      name: 'दवा जो गर्मी को मुश्किल बनाए',
      explain: 'कुछ दवाएँ गर्मी को शरीर के लिए मुश्किल बना देती हैं। ऐप आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    hr_suppressing_medication: {
      name: 'दिल की धड़कन धीमी करने वाली दवा या उपकरण',
      explain: 'हो सकता है आपकी धड़कन गर्मी का दबाव न दिखाए। ऐप आपकी धड़कन इस्तेमाल नहीं करता और आपको पहले चेतावनी देता है।',
    },
    recent_illness: {
      name: 'हाल में बीमार',
      explain: 'हाल की बीमारी गर्मी को शरीर के लिए मुश्किल बना देती है। ऐप आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    poor_sleep: {
      name: 'कम नींद',
      explain: 'कम नींद गर्मी को शरीर के लिए मुश्किल बना देती है। ऐप आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    fasting: {
      name: 'रोज़ा / उपवास',
      explain: 'उपवास के समय ऐप पानी पीने की याद नहीं दिलाता। यह आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    heat_rash_sunburn: {
      name: 'घमौरियाँ या धूप से जलन',
      explain: 'घमौरियों या धूप की जलन से त्वचा ठीक से पसीना नहीं निकाल पाती। ऐप आपको पहले चेतावनी देता है और ज्यादा आराम देता है।',
    },
    oh_review_required: {
      name: 'नर्स से जाँच जरूरी',
      explain: 'क्लिनिक की नर्स आपसे अकेले में गर्मी में सुरक्षित काम के बारे में बात करेगी।',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'गर्मी इस काम की सुरक्षित सीमा से ऊपर है।',
    heat_near_limit: 'गर्मी इस काम की सुरक्षित सीमा के करीब है।',
    heat_within_limit: 'गर्मी इस काम की सुरक्षित सीमा के अंदर है।',
    work_rest: 'हर घंटे काम और आराम के समय का पालन करें।',
    clothing: 'आपके काम के कपड़े गर्मी रोकते हैं, इसलिए सीमा कम है।',
    not_used_limit: 'आप अभी गर्मी के आदी नहीं हैं, इसलिए आपकी सीमा कम है।',
    lower_limit: 'आपकी सुरक्षा के लिए आज आपकी सीमा कम है।',
    stricter_rest: 'आपकी सुरक्षा के लिए आज आपको आराम के ज़्यादा ब्रेक मिलेंगे।',
    heat_time_left: 'गर्मी की आदत होने तक गर्मी में आपके काम का समय सीमित है।',
    heat_time_used: 'आज गर्मी में आपके काम का समय पूरा हो गया है।',
    suit: 'बंद सुरक्षा कपड़े: गर्मी की सीमाएँ सिर्फ मोटा अंदाज़ा हैं।',
    less_certain: 'यहाँ गर्मी का अनुमान कम पक्का है।',
    time_to_limit: 'काम की इस रफ्तार पर गर्मी में आपका सुरक्षित समय खत्म हो रहा है।',
    limit_reached: 'इस शिफ्ट के लिए आपकी गर्मी की सुरक्षित सीमा पूरी हो गई है। किसी ठंडी जगह आराम करें।',
    no_limit_soon: 'काम की इस रफ्तार पर जल्दी कोई गर्मी सीमा नहीं।',
    limit_stays: 'सिर्फ आराम से आज आपकी गर्मी की सीमा फिर से शुरू नहीं होती।',
    fasting_limit: 'रोज़ा / उपवास: आप पानी नहीं पी रहे, इसलिए आपकी सीमा कम है।',
    level_stays: 'यह चेतावनी तब तक रहेगी जब तक फर्स्ट एडर या सुपरवाइज़र आपको अनुमति न दे।',
    no_hot_work: 'आज आपके लिए गर्मी में और काम नहीं।',
    level_held: 'गर्मी कम होने के बाद भी स्तर थोड़ी देर ऊँचा रहता है।',
    safe_default: 'कुछ डेटा नहीं है या गलत है, इसलिए ऐप सुरक्षित मान इस्तेमाल करता है।',
    checkin_due: 'आपकी तबीयत की जाँच का समय हो गया है।',
    buddy: 'आज किसी साथी के साथ काम करें।',
    no_lone_work: 'इस गर्मी में अकेले काम न करें।',
    fasting_reminders: 'रोज़ा / उपवास: पानी पीने की याद नहीं दिलाई जाएगी। छाँव में आराम करें और शरीर ठंडा करें।',
    water_stop: 'जब तक फर्स्ट एडर आपको न देख ले, सादा पानी पीना बंद करें।',
    check_sensor: 'साइट के गर्मी सेंसर की जाँच ज़रूरी है।',
    extreme_heat: 'बहुत ज़्यादा गर्मी और उमस: काम रोकने की सलाह है।',
    hot_surfaces: 'यहाँ गर्म सतहें गर्मी बढ़ाती हैं। इसे गिना गया है।',
    site_sensor: 'गर्मी की रीडिंग साइट के सेंसर से।',
    zone_high: 'गर्मी ज़ोन ऊँचा: काम और आराम का सख्त समय, अकेले काम नहीं।',
    zone_medium: 'गर्मी ज़ोन मध्यम: काम और आराम का तय समय, अकेले काम नहीं।',
    zone_low: 'गर्मी ज़ोन कम: पानी और ब्रेक के साथ सामान्य काम।',
    zone_unknown: 'गर्मी ज़ोन पता नहीं, इसलिए सबसे सख्त नियम लागू हैं।',
    essential_only: 'आम काम के लिए बहुत गर्मी है: सिर्फ ज़रूरी काम।',
    permit: 'इस काम के लिए गर्मी में काम का परमिट ज़रूरी है।',
    not_used_reassign: 'अभी गर्मी के आदी नहीं: आपको इस ज़ोन के बाहर काम मिलेगा।',
    not_used_not_alone: 'अभी गर्मी के आदी नहीं: यहाँ अकेले काम न करें।',
    not_used_plan: 'अभी गर्मी के आदी नहीं: आदत डालने के लिए अपनी योजना का पालन करें।',
    midday: 'दोपहर का ब्रेक: अभी धूप में काम नहीं।',
    midday_other: 'दोपहर के ब्रेक का समय है, लेकिन यह काम धूप में नहीं है।',
    heat_unknown: 'गर्मी की कोई रीडिंग नहीं, इसलिए काम रोकने का नियम जाँचा नहीं जा सकता।',
    heat_stop: 'बहुत गर्मी है: काम रोकना होगा।',
    band_not_used: 'बैंड इस्तेमाल नहीं हो रहा। चेतावनियाँ मौसम और काम पर आधारित हैं।',
    band_check: 'बैंड का डेटा नहीं है या कमज़ोर है। देखें कि बैंड पहना है और ठीक से बँधा है।',
    band_starting: 'बैंड शुरू हो रहा है (पहले 30 मिनट)। चेतावनियाँ मौसम और काम पर आधारित हैं।',
    band_odd: 'बैंड की असामान्य रीडिंग। आपका साथी आपका हाल देखेगा।',
    strain_very_high: 'अनुमान के अनुसार गर्मी का दबाव बहुत ज़्यादा है। काम रोकें और शरीर ठंडा करें।',
    strain_high: 'अनुमान के अनुसार गर्मी का दबाव ज़्यादा है। किसी ठंडी जगह आराम करें।',
    strain_rising: 'गर्मी के दबाव का अनुमान बढ़ रहा है। तबीयत के सवालों के जवाब दें।',
    effort_high: 'आपने बहुत देर तक बहुत ज़्यादा मेहनत की है। अभी आराम करें।',
    age_unknown: 'उम्र दर्ज नहीं है, इसलिए ज़्यादा सुरक्षित सीमा इस्तेमाल होती है।',
    band_ok: 'बैंड: कोई चेतावनी नहीं।',
    no_checkin: 'आज अभी तक तबीयत की जाँच नहीं हुई।',
    checkin_ok: 'तबीयत की जाँच: खतरे का कोई संकेत नहीं।',
    too_much_water: 'खतरे के संकेतों के साथ बहुत ज़्यादा पानी। पीना बंद करें और फर्स्ट एडर से मिलें।',
    worse: 'पहले से ज़्यादा बुरा लग रहा है। 998 पर कॉल करें और अभी ठंडा करना शुरू करें।',
    not_better: '30 मिनट बाद भी सुधार नहीं। 998 पर कॉल करें और ठंडा करते रहें।',
    sx_thirst: 'आपको प्यास लगी है। अभी पानी पिएँ।',
    sx_overdrink: 'ज़्यादा पानी न पिएँ। तबीयत ठीक न लगे तो फर्स्ट एडर को बताएँ।',
    sx_t1: 'जाँच का जवाब: छाँव में आराम करें और पानी पिएँ।',
    sx_t2: 'जाँच का जवाब: गर्मी का काम रोकें और अभी फर्स्ट एडर को बुलाएँ।',
    sx_t3: 'खतरे का संकेत बताया गया है। 998 पर कॉल करें और अभी ठंडा करना शुरू करें।',
    colour_ok: 'रंग की जाँच: ठीक है। पानी पीते रहें।',
    colour_more: 'रंग की जाँच: और पानी पिएँ।',
    colour_dark: 'रंग की जाँच: बहुत गहरा है। पानी पिएँ और छाँव में आराम करें।',
    colour_dark_again: 'रंग अभी भी बहुत गहरा है। आराम करें, पानी पिएँ और फर्स्ट एडर को बताएँ।',
    colour_very_dark: 'रंग की जाँच: बहुत ही गहरा है। आराम करें, शरीर ठंडा करें और पानी पिएँ।',
    too_much_today: 'आपने आज बहुत ज़्यादा पानी पिया है। धीरे पिएँ।',
    slow_down: 'धीरे पिएँ। आपने इस घंटे बहुत पानी पिया है।',
    no_weather: 'मौसम का डेटा नहीं है, इसलिए ऐप एक बहुत गर्म घंटा मानकर चलता है।',
    weather_old: 'मौसम का डेटा पुराना है, इसलिए कम पक्का है।',
    weather_old_margin: 'मौसम का डेटा बहुत पुराना है, इसलिए सुरक्षा की गुंजाइश जोड़ी गई है।',
    src_forecast: 'मौसम पूर्वानुमान से।',
    src_archive: 'मौसम के रिकॉर्ड से।',
    src_cached: 'मौसम सहेजे हुए पूर्वानुमान से।',
    rest_cooled: 'ब्रेक ठंडी, एसी वाली आराम की जगह में हैं।',
    rest_shade_only: 'यहाँ ब्रेक के लिए सिर्फ छाँव है, इसलिए आपको ज़्यादा आराम चाहिए।',
    recovery_review: 'किसी ठंडी जगह 30 मिनट आराम करें। फिर सुपरवाइज़र या फर्स्ट एडर को आपको अनुमति देनी होगी।',
    recovery_cleared: 'आपको फिर से काम करने की अनुमति मिल गई है। ब्रेक लेते रहें।',
    resume_check: 'आराम करें, जब तक गर्मी की जाँच आपको इस काम पर लौटने की अनुमति न दे।',
    task_too_hot: 'अभी इस काम पर लौटने के लिए बहुत गर्मी है। हल्के या ठंडे काम पर जाएँ।',
    work_bout: 'अगले आराम से पहले काम का थोड़ा ही समय बचा है।',
    drinks_counted: 'आप जो पानी दर्ज करते हैं, वह आपकी गर्मी की सीमा में गिना जाता है।',
    drink_to_restart: 'पानी पिएँ, उसे दर्ज करें और गर्मी में फिर से काम शुरू करने से पहले आराम करें।',
  }),
}

// ─────────────────────────────── Nepali ───────────────────────────────

const NE: Catalog = {
  level: {
    safe: { name: 'कम जोखिम', meaning: 'सामान्य काम। पानी पिइरहनुहोस् र ब्रेक लिइरहनुहोस्।' },
    caution: { name: 'सावधान', meaning: 'गर्मी छ। बारम्बार पानी पिउनुहोस् र छायाँमा आराम गर्नुहोस्।' },
    high: { name: 'उच्च जोखिम', meaning: 'धेरै गर्मी छ। कम काम गर्नुहोस्, छायाँमा धेरै आराम गर्नुहोस्।' },
    stop: { name: 'काम रोक्नुहोस्', meaning: 'गर्मीमा काम अहिले नै रोक्नुहोस्। छायाँमा गएर आराम गर्नुहोस्।' },
    emergency: { name: 'आपतकाल', meaning: 'खतरा। 998 मा फोन गर्नुहोस् र अहिले नै चिसो पार्न सुरु गर्नुहोस्।' },
  },
  action: {
    drink_water: 'अहिले पानी पिउनुहोस्',
    shade_breaks: 'बेला-बेलामा छायाँमा ब्रेक लिनुहोस्',
    reduce_intensity: 'बिस्तारै र हल्का काम गर्नुहोस्',
    rotate_task: 'चिसो ठाउँको हल्का काममा जानुहोस्',
    rest_shade_now: 'अहिले छायाँमा आराम गर्नुहोस्',
    cool_down: 'शरीर चिसो पार्नुहोस्: पानी छर्कनुहोस्, पंखा चलाउनुहोस्',
    stop_work: 'अहिले काम रोक्नुहोस्',
    buddy_check: 'आफ्नो साथीको हालचाल हेर्नुहोस्',
    first_aider_check: 'अहिले फर्स्ट एडरलाई बोलाउनुहोस्',
    call_998: 'अहिले 998 मा फोन गर्नुहोस्',
    cool_first: 'पहिले चिसो पार्नुहोस्, अनि अस्पताल लैजानुहोस्',
    stay_with_worker: 'उहाँसँगै बस्नुहोस्, एक्लै नछोड्नुहोस्',
    midday_break: 'दिउँसोको ब्रेक: घाममा काम नगर्नुहोस्',
    acclimatization_plan: 'गर्मीमा नयाँ हुनुहुन्छ: सुरुमा कम काम गर्नुहोस्',
    occ_health_review: 'जाँचका लागि क्लिनिकको नर्सलाई भेट्नुहोस्',
    check_sensor: 'सेन्सरले काम गर्दैछ कि हेर्नुहोस्',
    symptom_checkin: 'स्वास्थ्यका प्रश्नहरूको जवाफ दिनुहोस्',
    no_lone_work: 'एक्लै काम नगर्नुहोस्',
    electrolytes: 'इलेक्ट्रोलाइट (ORS) पेय पिउनुहोस्, नुनको चक्की होइन',
    restrict_fluids: 'अहिलेलाई पानी पिउन रोक्नुहोस्। फर्स्ट एडरलाई भेट्नुहोस्।',
    medical_evaluation: 'आजै डाक्टरलाई देखाउनुहोस्',
    no_hot_work_today: 'आज अब गर्मीमा काम नगर्नुहोस्',
  },
  action_with: {
    rest_shade_now: '{min} मिनेट छायाँमा आराम गर्नुहोस्',
    drink_water: 'अहिले {ml} मि.लि. पानी पिउनुहोस्',
    drink_water_every: 'हरेक {min} मिनेटमा {ml} मि.लि. पानी पिउनुहोस्',
    shade_breaks: '{work} मिनेट काम, {rest} मिनेट आराम',
    midday_break: '{from} देखि {to} सम्म घाममा काम नगर्नुहोस्',
  },
  symptom: {
    thirst: { self: 'के तपाईंलाई धेरै तिर्खा लागेको छ?', buddy: 'के तपाईंको साथीलाई धेरै तिर्खा लागेको छ?' },
    heat_rash: {
      self: 'के तपाईंलाई चिलाउने रातो दाना (घमौरा) आएको छ?',
      buddy: 'के तपाईंको साथीलाई चिलाउने रातो दाना आएको छ?',
    },
    cramps: {
      self: 'के तपाईंलाई दुख्ने गरी मांसपेशी बाउँडिएको छ?',
      buddy: 'के तपाईंको साथीलाई दुख्ने गरी मांसपेशी बाउँडिएको छ?',
    },
    cramps_persistent: {
      self: 'के मांसपेशी बाउँडिएको 1 घण्टा वा बढी भयो?',
      buddy: 'के तपाईंको साथीको मांसपेशी बाउँडिएको 1 घण्टा वा बढी भयो?',
    },
    headache: { self: 'के तपाईंको टाउको दुखेको छ?', buddy: 'के तपाईंको साथीको टाउको दुखेको छ?' },
    dizziness: { self: 'के तपाईंलाई रिंगटा लागेको छ?', buddy: 'के तपाईंको साथीलाई रिंगटा लागेको छ?' },
    nausea: { self: 'के तपाईंलाई वाकवाकी लागेको छ?', buddy: 'के तपाईंको साथीलाई वाकवाकी लागेको छ?' },
    weakness_fatigue: {
      self: 'के तपाईं धेरै थाकेको वा कमजोर हुनुहुन्छ?',
      buddy: 'के तपाईंको साथी धेरै थाकेको वा कमजोर हुनुहुन्छ?',
    },
    fainted: {
      self: 'के तपाईं बेहोस हुनुभयो, एक छिनका लागि भए पनि?',
      buddy: 'के तपाईंको साथी बेहोस हुनुभयो, एक छिनका लागि भए पनि?',
    },
    brown_urine: {
      self: 'के तपाईंको पिसाब चिया वा कोला जस्तो खैरो छ?',
      buddy: 'के तपाईंको साथी आफ्नो पिसाब खैरो छ भन्नुहुन्छ?',
    },
    drank_a_lot: {
      self: 'के तपाईंले पछिल्लो 1 घण्टामा 6 गिलास (1.5 लिटर) भन्दा बढी पानी पिउनुभयो?',
      buddy: 'के तपाईंको साथीले पछिल्लो 1 घण्टामा 6 गिलास (1.5 लिटर) भन्दा बढी पानी पिउनुभयो?',
    },
    swollen_hands: { self: 'के तपाईंको हात सुन्निएको छ?', buddy: 'के तपाईंको साथीको हात सुन्निएको छ?' },
    repeated_vomiting: {
      self: 'के तपाईंलाई एक पटकभन्दा बढी बान्ता भयो?',
      buddy: 'के तपाईंको साथीलाई एक पटकभन्दा बढी बान्ता भयो?',
    },
    chest_pain: {
      self: 'के तपाईंको छाती दुखेको छ वा सास फेर्न गाह्रो छ?',
      buddy: 'के तपाईंको साथीको छाती दुखेको छ वा सास फेर्न गाह्रो छ?',
    },
    confusion: {
      self: 'के तपाईंलाई अलमल्ल भएको जस्तो लागेको छ?',
      buddy: 'के तपाईंको साथी अलमल्ल हुनुहुन्छ वा अनौठो व्यवहार गर्दै हुनुहुन्छ?',
    },
    slurred_speech: {
      self: 'के तपाईंलाई प्रस्ट बोल्न गाह्रो भइरहेको छ?',
      buddy: 'के तपाईंको साथीको बोली लरबरिएको वा अस्पष्ट छ?',
    },
    unsteady_walking: {
      self: 'के तपाईं लरखराउँदै हुनुहुन्छ वा सिधा हिँड्न सक्नुहुन्न?',
      buddy: 'के तपाईंको साथी लरखराउँदै हुनुहुन्छ वा सिधा हिँड्न सक्नुहुन्न?',
    },
    collapsed_unresponsive: {
      self: 'के तपाईं अचानक ढल्नुभयो र अझै सामान्य महसुस गर्नुहुन्न?',
      buddy: 'के तपाईंको साथी ढल्नुभयो, वा जवाफ दिनुहुन्न?',
    },
    seizure: { self: 'के तपाईंलाई शरीर काम्ने दौरा पर्यो?', buddy: 'के तपाईंको साथीलाई शरीर काम्ने दौरा पर्यो?' },
  },
  checkin: {
    self_intro: 'हरेक प्रश्नको जवाफ दिनुहोस्: हो वा होइन।',
    buddy_intro: 'आफ्नो साथीलाई हेर्नुहोस्। जवाफ दिनुहोस्: हो वा होइन।',
    trend_question: 'पहिलेको तुलनामा अहिले तपाईंलाई कस्तो लागिरहेको छ?',
    better: 'अझ राम्रो',
    same: 'उस्तै',
    worse: 'झन् नराम्रो',
  },
  urine: {
    question: 'तपाईंको पिसाबको रङ कस्तो छ? सबैभन्दा मिल्ने रङमा थिच्नुहोस्।',
    ok: 'ठीक छ। पानी पिइरहनुहोस्।',
    drink_more: 'अझ पानी पिउनुहोस्।',
    dark: 'रङ धेरै गाढा छ। अहिले पानी पिउनुहोस् र छायाँमा आराम गर्नुहोस्।',
  },
  emergency: {
    title: 'आपतकाल। अहिले नै कदम चाल्नुहोस्।',
    call_998: 'एम्बुलेन्सका लागि 998 मा फोन गर्नुहोस्।',
    cool_first: 'पहिले चिसो पार्नुहोस्। अस्पताल लैजानुअघि नै चिसो पार्न सुरु गर्नुहोस्।',
    shade: 'उहाँलाई छायाँमा लैजानुहोस्। बढी लुगा फुकाल्नुहोस्।',
    immerse: 'सबैभन्दा राम्रो: शरीरलाई घाँटीसम्म चिसो वा बरफको पानीमा राख्नुहोस्, टब वा त्रिपालमा। पानी चलाइरहनुहोस्।',
    douse: 'टब छैन? उहाँमाथि लगातार चिसो पानी खन्याउनुहोस् र पंखाले हावा हम्काउनुहोस्।',
    towels: 'वा बरफको पानीमा भिजाएको तौलिया राख्नुहोस्, हरेक 1–2 मिनेटमा बदल्नुहोस्, र बरफको पोका लगाउनुहोस्।',
    keep_cooling:
      'एम्बुलेन्स नआउन्जेल चिसो पारिरहनुहोस्। करिब 15 मिनेटपछि बरफको पानीबाट निकाल्नुहोस्, वा उहाँ सामान्य भएमा अघि नै।',
    stay: 'उहाँसँगै बस्नुहोस्। उहाँलाई कहिल्यै एक्लै नछोड्नुहोस्।',
    fluids: 'उहाँ पूरा होसमा र ब्युँझेको भए मात्र पिउन दिनुहोस्।',
  },
  ui: {
    status: 'मेरो अवस्था',
    next_break: 'अर्को ब्रेक {min} मिनेटमा',
    break_now: 'ब्रेकको समय। छायाँमा जानुहोस्।',
    drank_water: 'मैले पानी पिएँ',
    feel_unwell: 'मलाई सन्चो छैन',
    im_ok: 'म ठीक छु',
    checkin: 'हालचाल',
    yes: 'हो',
    no: 'होइन',
    privacy: 'गोपनीयता',
    what_i_share: 'के सेयर हुन्छ',
    who_saw: 'मेरो डेटा कसले हेर्यो',
    offline: 'अफलाइन मोड',
    offline_note: 'नेटवर्क छैन। यो फोनमा चेतावनी अझै काम गर्छ।',
    battery_saver: 'ब्याट्री बचत',
    language: 'भाषा',
    acknowledge: 'ठीक छ, बुझें',
    help_coming: 'मद्दत आउँदैछ।',
    buddy: 'मेरो साथी',
    buddy_alert: '{name}लाई मद्दत चाहिन सक्छ। अहिले गएर हेर्नुहोस्।',
    get_help: 'मद्दत बोलाउनुहोस्',
    slow_down_drinking: 'बिस्तारै पिउनुहोस्। तपाईंले यो घण्टा धेरै पानी पिउनुभयो।',
    listen: 'सुन्नुहोस्',
    data_stays: 'तपाईंको स्वास्थ्य डेटा यही फोनमा रहन्छ।',
    flags_private: 'यो तपाईं मात्र देख्नुहुन्छ। यो तपाईंको फोनमै रहन्छ।',
    strain_estimate: 'गर्मीको तनावको अनुमान',
    not_medical: 'यो सुरक्षा गाइड हो, मेडिकल जाँच होइन।',
    translation_draft: 'प्रारम्भिक अनुवाद। अझै जाँच गरिएको छैन।',
  },
  consent: {
    wearable: {
      title: 'मेरो ब्यान्डबाट मुटुको धड्कन',
      statement:
        'ज़िल एपले यो फोनमा मेरो ब्यान्डबाट मुटुको धड्कन पढ्न सक्छ, ताकि मेरो गर्मीको तनावको अनुमान लगाउन सकियोस्। यो मलाई सुरक्षित राख्न मद्दत गर्ने एउटा अनुमान हो, मेडिकल मापन वा रोगको पहिचान होइन। मेरो सुपरभाइजरले यो कहिल्यै देख्दैन।',
    },
    healthFlags: {
      title: 'मेरा लागि गर्मीलाई बढी खतरनाक बनाउने स्वास्थ्यका कुराहरू',
      statement:
        'ज़िल एपले मेरा हो/होइन जवाफहरू (जस्तै हालैको बिरामी, वा गर्मी सहने क्षमतामा असर गर्ने औषधि) मेरा चेतावनीहरू अझ कडा बनाउन प्रयोग गर्न सक्छ। मेरा जवाफहरू यही फोनमा रहन्छन् र मेरो सुपरभाइजर वा रोजगारदातालाई कहिल्यै देखाइँदैनन्।',
    },
    checkins: {
      title: 'लक्षण र पानी पिउने बारेका प्रश्नहरू',
      statement:
        'ज़िल एपले मलाई मेरो हालचाल र मेरो पिसाबको रङ सोध्न सक्छ। मेरा जवाफहरू यही फोनमा रहन्छन्। मेरो केस अगाडि बढाइएमा, फर्स्ट एडरले मलाई मद्दत गर्न मैले बताएका लक्षणहरू देख्नुहुन्छ।',
    },
    shareWithMedicOnEscalation: {
      title: 'केस अगाडि बढेमा पेसागत स्वास्थ्यसँग सेयर गर्ने',
      statement:
        'मेरो केस अगाडि बढाइएमा, पेसागत स्वास्थ्यकी नर्सले मेरो हेरचाह गर्न मेरो मुटुको धड्कनका अनुमान, स्वास्थ्यका कुराहरू र प्रश्नका जवाफहरू हेर्न सक्नुहुन्छ। अरू कसैले यी देख्दैन, र यी कहिल्यै मेरो विरुद्ध प्रयोग हुँदैनन्।',
    },
    aggregateStatistics: {
      title: 'मलाई गुमनाम तथ्याङ्कमा गन्नुहोस्',
      statement:
        'मेरो डेटा कामको ठाउँमा गर्मीबारे जनस्वास्थ्य तथ्याङ्कमा गनिन सक्छ। 10 जनाभन्दा कम मानिस भएका समूहहरू लुकाइन्छन्, ताकि मलाई चिन्न नसकियोस्।',
    },
  },
  consent_info: {
    intro: 'जिल एपले के प्रयोग गर्न सक्छ, छान्नुहोस्। हरेक छनोट छुट्टै हो।',
    voluntary: 'होइन भन्नु ठीक छ। तपाईंले सबै सुरक्षा चेतावनी पाइरहनुहुनेछ।',
    change_anytime: 'तपाईं जुनसुकै बेला आफ्नो छनोट बदल्न सक्नुहुन्छ।',
  },
  privacy_notice: {
    title: 'समूहको गन्तीमा तपाईंलाई कसरी गनिन्छ',
    statement:
      'तपाईंको रोजगारदातालाई गर्मीमा कामलाई सुरक्षित राख्ने कानुनी दायित्व छ। त्यसैले ज़िल एपले हरेक कामदारलाई समूहको गन्तीमा गन्छ, तपाईंले “मलाई गुमनाम तथ्याङ्कमा गन्नुहोस्” नरोजेको भए पनि। साइटको सुरक्षा (HSE) म्यानेजरले 5 वा बढी कामदारका समूह मात्र देख्नुहुन्छ। नियामक र तपाईंको रोजगारदाताको HR ले 10 वा बढी कामदारका समूह मात्र देख्छन्। साना समूह लुकाइन्छन्, र यो गन्तीले तपाईंको नाम वा तपाईं एक्लैको कुनै रेकर्ड कहिल्यै देखाउँदैन। गुमनाम तथ्याङ्कबारे तपाईंको रोजाइले तपाईं जनस्वास्थ्य तथ्याङ्कमा पनि गनिने कि नगनिने भन्ने मात्र तय गर्छ।',
  },
  flag: {
    prior_heat_illness: {
      name: 'पहिले गर्मीले बिरामी',
      explain: 'तपाईं पहिले गर्मीले बिरामी पर्नुभएको थियो। एपले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    heat_sensitive_medication: {
      name: 'गर्मीलाई गाह्रो बनाउने औषधि',
      explain: 'केही औषधिले गर्मीलाई शरीरका लागि गाह्रो बनाउँछन्। एपले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    hr_suppressing_medication: {
      name: 'मुटुको धड्कन घटाउने औषधि वा उपकरण',
      explain: 'तपाईंको धड्कनले गर्मीको तनाव नदेखाउन सक्छ। एपले तपाईंको धड्कन प्रयोग गर्दैन र तपाईंलाई चाँडै चेतावनी दिन्छ।',
    },
    recent_illness: {
      name: 'भर्खरै बिरामी',
      explain: 'भर्खरैको बिरामीले गर्मीलाई शरीरका लागि गाह्रो बनाउँछ। एपले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    poor_sleep: {
      name: 'कम निद्रा',
      explain: 'कम निद्राले गर्मीलाई शरीरका लागि गाह्रो बनाउँछ। एपले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    fasting: {
      name: 'उपवास / रोजा',
      explain: 'उपवासको समयमा एपले पानी पिउन सम्झाउँदैन। यसले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    heat_rash_sunburn: {
      name: 'घमौरा वा घामले पोलेको',
      explain: 'घमौरा वा घामले पोलेको छालाबाट राम्रोसँग पसिना निस्कँदैन। एपले तपाईंलाई चाँडै चेतावनी दिन्छ र धेरै आराम दिन्छ।',
    },
    oh_review_required: {
      name: 'नर्सको जाँच आवश्यक',
      explain: 'क्लिनिकको नर्सले तपाईंसँग एकान्तमा गर्मीमा सुरक्षित कामबारे कुरा गर्नुहुनेछ।',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'गर्मी यो कामको सुरक्षित सीमाभन्दा माथि छ।',
    heat_near_limit: 'गर्मी यो कामको सुरक्षित सीमा नजिक छ।',
    heat_within_limit: 'गर्मी यो कामको सुरक्षित सीमाभित्र छ।',
    work_rest: 'हरेक घण्टा काम र आरामको समय पालना गर्नुहोस्।',
    clothing: 'तपाईंको कामको लुगाले गर्मी थुन्छ, त्यसैले सीमा कम छ।',
    not_used_limit: 'तपाईंलाई अझै गर्मीको बानी परेको छैन, त्यसैले तपाईंको सीमा कम छ।',
    lower_limit: 'तपाईंको सुरक्षाका लागि आज तपाईंको सीमा कम छ।',
    stricter_rest: 'तपाईंको सुरक्षाका लागि आज तपाईंलाई आराम गर्ने थप समय दिइन्छ।',
    heat_time_left: 'गर्मीको बानी नपरुन्जेल गर्मीमा तपाईंको कामको समय सीमित छ।',
    heat_time_used: 'आजका लागि गर्मीमा तपाईंको कामको समय सकियो।',
    suit: 'बन्द सुरक्षा लुगा: गर्मीका सीमा केवल मोटामोटी अनुमान हुन्।',
    less_certain: 'यहाँ गर्मीको अनुमान कम पक्का छ।',
    time_to_limit: 'कामको यो गतिमा गर्मीमा तपाईंको सुरक्षित समय सकिँदैछ।',
    limit_reached: 'यो सिफ्टका लागि तपाईंको गर्मीको सुरक्षित सीमा पुग्यो। कुनै शीतल ठाउँमा आराम गर्नुहोस्।',
    no_limit_soon: 'कामको यो गतिमा चाँडै कुनै गर्मी सीमा छैन।',
    limit_stays: 'आराम मात्रले आज तपाईंको गर्मी सीमा फेरि सुरु हुँदैन।',
    fasting_limit: 'उपवास / रोजा: तपाईं पानी पिउनुहुन्न, त्यसैले तपाईंको सीमा कम छ।',
    level_stays: 'फर्स्ट एडर वा सुपरभाइजरले अनुमति नदिएसम्म यो चेतावनी रहन्छ।',
    no_hot_work: 'आज तपाईंका लागि गर्मीमा थप काम छैन।',
    level_held: 'गर्मी घटेपछि पनि स्तर केही बेर माथि रहन्छ।',
    safe_default: 'केही डेटा छैन वा गलत छ, त्यसैले एपले सुरक्षित मान प्रयोग गर्छ।',
    checkin_due: 'तपाईंको हालचाल प्रश्नको समय भयो।',
    buddy: 'आज साथीसँग काम गर्नुहोस्।',
    no_lone_work: 'यो गर्मीमा एक्लै काम नगर्नुहोस्।',
    fasting_reminders: 'उपवास / रोजा: पानी पिउने सम्झना दिइँदैन। छायाँमा आराम गर्नुहोस् र शरीर चिसो पार्नुहोस्।',
    water_stop: 'फर्स्ट एडरले नजाँचुन्जेल सादा पानी पिउन बन्द गर्नुहोस्।',
    check_sensor: 'साइटको गर्मी सेन्सर जाँच्नुपर्छ।',
    extreme_heat: 'अत्यधिक गर्मी र उमस: काम रोक्न सल्लाह दिइन्छ।',
    hot_surfaces: 'यहाँका तातो सतहले गर्मी बढाउँछन्। यो गनिएको छ।',
    site_sensor: 'साइटको सेन्सरबाट गर्मीको रिडिङ।',
    zone_high: 'गर्मी क्षेत्र उच्च: काम र आरामको कडा समय, एक्लै काम छैन।',
    zone_medium: 'गर्मी क्षेत्र मध्यम: काम र आरामको तोकिएको समय, एक्लै काम छैन।',
    zone_low: 'गर्मी क्षेत्र न्यून: पानी र ब्रेकसहित सामान्य काम।',
    zone_unknown: 'गर्मी क्षेत्र थाहा छैन, त्यसैले सबैभन्दा कडा नियम लागू हुन्छन्।',
    essential_only: 'सामान्य कामका लागि धेरै गर्मी छ: अत्यावश्यक काम मात्र।',
    permit: 'यो कामका लागि गर्मीमा काम गर्ने अनुमतिपत्र चाहिन्छ।',
    not_used_reassign: 'अझै गर्मीको बानी परेको छैन: तपाईंलाई यो क्षेत्रबाहिर काम दिइनेछ।',
    not_used_not_alone: 'अझै गर्मीको बानी परेको छैन: यहाँ एक्लै काम नगर्नुहोस्।',
    not_used_plan: 'अझै गर्मीको बानी परेको छैन: बानी पार्न आफ्नो योजना पालना गर्नुहोस्।',
    midday: 'दिउँसोको ब्रेक: अहिले घाममा काम छैन।',
    midday_other: 'दिउँसोको ब्रेकको समय हो, तर यो काम घाममा छैन।',
    heat_unknown: 'गर्मीको कुनै रिडिङ छैन, त्यसैले काम रोक्ने नियम जाँच्न सकिँदैन।',
    heat_stop: 'धेरै गर्मी छ: काम रोक्नुपर्छ।',
    band_not_used: 'ब्यान्ड प्रयोग भइरहेको छैन। चेतावनीहरू मौसम र काममा आधारित छन्।',
    band_check: 'ब्यान्डको डेटा छैन वा कमजोर छ। ब्यान्ड लगाएको र राम्ररी कसिएको छ कि हेर्नुहोस्।',
    band_starting: 'ब्यान्ड सुरु हुँदैछ (पहिलो 30 मिनेट)। चेतावनीहरू मौसम र काममा आधारित छन्।',
    band_odd: 'ब्यान्डको असामान्य रिडिङ। तपाईंको साथीले तपाईंको हालचाल हेर्नुहुनेछ।',
    strain_very_high: 'अनुमान अनुसार गर्मीको तनाव धेरै उच्च छ। काम रोक्नुहोस् र शरीर चिसो पार्नुहोस्।',
    strain_high: 'अनुमान अनुसार गर्मीको तनाव उच्च छ। कुनै शीतल ठाउँमा आराम गर्नुहोस्।',
    strain_rising: 'गर्मीको तनावको अनुमान बढ्दैछ। हालचाल प्रश्नको जवाफ दिनुहोस्।',
    effort_high: 'तपाईंले धेरै बेरसम्म धेरै मेहनत गर्नुभयो। अहिले आराम गर्नुहोस्।',
    age_unknown: 'उमेर राखिएको छैन, त्यसैले बढी सुरक्षित सीमा प्रयोग हुन्छ।',
    band_ok: 'ब्यान्ड: कुनै चेतावनी छैन।',
    no_checkin: 'आज अझै हालचाल प्रश्न भएको छैन।',
    checkin_ok: 'हालचाल प्रश्न: खतराको कुनै संकेत छैन।',
    too_much_water: 'खतराका संकेतसहित धेरै पानी। पिउन बन्द गर्नुहोस् र फर्स्ट एडरलाई भेट्नुहोस्।',
    worse: 'पहिलेभन्दा खराब महसुस भइरहेको छ। 998 मा फोन गर्नुहोस् र अहिले नै चिसो पार्न सुरु गर्नुहोस्।',
    not_better: '30 मिनेटपछि पनि सुधार छैन। 998 मा फोन गर्नुहोस् र चिसो पारिरहनुहोस्।',
    sx_thirst: 'तपाईंलाई तिर्खा लागेको छ। अहिले पानी पिउनुहोस्।',
    sx_overdrink: 'धेरै पानी नपिउनुहोस्। सन्चो नभए फर्स्ट एडरलाई भन्नुहोस्।',
    sx_t1: 'प्रश्नको जवाफ: छायाँमा आराम गर्नुहोस् र पानी पिउनुहोस्।',
    sx_t2: 'प्रश्नको जवाफ: गर्मीको काम रोक्नुहोस् र अहिले फर्स्ट एडरलाई बोलाउनुहोस्।',
    sx_t3: 'खतराको संकेत बताइयो। 998 मा फोन गर्नुहोस् र अहिले नै चिसो पार्न सुरु गर्नुहोस्।',
    colour_ok: 'रङ जाँच: ठीक छ। पानी पिइरहनुहोस्।',
    colour_more: 'रङ जाँच: अझ पानी पिउनुहोस्।',
    colour_dark: 'रङ जाँच: धेरै गाढा छ। पानी पिउनुहोस् र छायाँमा आराम गर्नुहोस्।',
    colour_dark_again: 'रङ अझै धेरै गाढा छ। आराम गर्नुहोस्, पानी पिउनुहोस् र फर्स्ट एडरलाई भन्नुहोस्।',
    colour_very_dark: 'रङ जाँच: अत्यन्त गाढा छ। आराम गर्नुहोस्, शरीर चिसो पार्नुहोस् र पानी पिउनुहोस्।',
    too_much_today: 'तपाईंले आज धेरै नै पानी पिउनुभयो। बिस्तारै पिउनुहोस्।',
    slow_down: 'बिस्तारै पिउनुहोस्। तपाईंले यो घण्टा धेरै पानी पिउनुभयो।',
    no_weather: 'मौसमको डेटा छैन, त्यसैले एपले एकदमै तातो घण्टा मान्छ।',
    weather_old: 'मौसमको डेटा पुरानो छ, त्यसैले कम पक्का छ।',
    weather_old_margin: 'मौसमको डेटा धेरै पुरानो छ, त्यसैले सुरक्षा मार्जिन थपिएको छ।',
    src_forecast: 'पूर्वानुमानबाट मौसम।',
    src_archive: 'मौसमका रेकर्डबाट मौसम।',
    src_cached: 'सुरक्षित गरिएको पूर्वानुमानबाट मौसम।',
    rest_cooled: 'ब्रेकहरू चिसो, एसी भएको आराम गर्ने ठाउँमा छन्।',
    rest_shade_only: 'यहाँ ब्रेकका लागि छायाँ मात्र छ, त्यसैले तपाईंलाई बढी आराम चाहिन्छ।',
    recovery_review: 'कुनै शीतल ठाउँमा 30 मिनेट आराम गर्नुहोस्। त्यसपछि सुपरभाइजर वा फर्स्ट एडरले तपाईंलाई अनुमति दिनुपर्छ।',
    recovery_cleared: 'तपाईंलाई फेरि काम गर्ने अनुमति दिइयो। ब्रेक लिइरहनुहोस्।',
    resume_check: 'गर्मीको जाँचले यो काममा फर्कन अनुमति नदिएसम्म आराम गर्नुहोस्।',
    task_too_hot: 'अहिले यो काममा फर्कन धेरै गर्मी छ। हलुका वा शीतल काममा जानुहोस्।',
    work_bout: 'अर्को आरामभन्दा पहिले कामको थोरै समय मात्र बाँकी छ।',
    drinks_counted: 'तपाईंले दर्ता गरेको पानी तपाईंको गर्मी सीमामा गनिन्छ।',
    drink_to_restart: 'पानी पिउनुहोस्, दर्ता गर्नुहोस् र गर्मीमा फेरि काम सुरु गर्नुअघि आराम गर्नुहोस्।',
  }),
}

// ─────────────────────────────── Bengali (Bangladesh usage) ───────────────────────────────

const BN: Catalog = {
  level: {
    safe: { name: 'কম ঝুঁকি', meaning: 'স্বাভাবিক কাজ। পানি পান করতে থাকুন এবং বিরতি নিন।' },
    caution: { name: 'সাবধান', meaning: 'গরম। বারবার পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।' },
    high: { name: 'বেশি ঝুঁকি', meaning: 'খুব গরম। কম কাজ করুন, ছায়ায় বেশি বিশ্রাম নিন।' },
    stop: { name: 'কাজ বন্ধ করুন', meaning: 'গরমে কাজ এখনই বন্ধ করুন। ছায়ায় গিয়ে বিশ্রাম নিন।' },
    emergency: { name: 'জরুরি অবস্থা', meaning: 'বিপদ। 998-এ ফোন করুন এবং এখনই ঠান্ডা করা শুরু করুন।' },
  },
  action: {
    drink_water: 'এখনই পানি পান করুন',
    shade_breaks: 'নিয়মিত ছায়ায় বিরতি নিন',
    reduce_intensity: 'ধীরে ও হালকা কাজ করুন',
    rotate_task: 'ঠান্ডা জায়গার হালকা কাজে যান',
    rest_shade_now: 'এখনই ছায়ায় বিশ্রাম নিন',
    cool_down: 'শরীর ঠান্ডা করুন: গায়ে পানি দিন, পাখা চালান',
    stop_work: 'এখনই কাজ বন্ধ করুন',
    buddy_check: 'আপনার সঙ্গীর খোঁজ নিন',
    first_aider_check: 'এখনই ফার্স্ট এইডারকে ডাকুন',
    call_998: 'এখনই 998-এ ফোন করুন',
    cool_first: 'আগে ঠান্ডা করুন, তারপর হাসপাতালে নিন',
    stay_with_worker: 'তার সাথে থাকুন, একা ছাড়বেন না',
    midday_break: 'দুপুরের বিরতি: রোদে কাজ নয়',
    acclimatization_plan: 'গরমে নতুন: শুরুতে কম কাজ করুন',
    occ_health_review: 'পরীক্ষার জন্য ক্লিনিকের নার্সের সাথে দেখা করুন',
    check_sensor: 'সেন্সর কাজ করছে কিনা দেখুন',
    symptom_checkin: 'শরীরের অবস্থার প্রশ্নের উত্তর দিন',
    no_lone_work: 'একা কাজ করবেন না',
    electrolytes: 'খাবার স্যালাইন (ORS) পান করুন, লবণের ট্যাবলেট নয়',
    restrict_fluids: 'এখন পানি পান বন্ধ রাখুন। ফার্স্ট এইডারের কাছে যান।',
    medical_evaluation: 'আজই ডাক্তার দেখান',
    no_hot_work_today: 'আজ আর গরমে কাজ নয়',
  },
  action_with: {
    rest_shade_now: '{min} মিনিট ছায়ায় বিশ্রাম নিন',
    drink_water: 'এখনই {ml} মি.লি. পানি পান করুন',
    drink_water_every: 'প্রতি {min} মিনিটে {ml} মি.লি. পানি পান করুন',
    shade_breaks: '{work} মিনিট কাজ, {rest} মিনিট বিশ্রাম',
    midday_break: '{from} থেকে {to} পর্যন্ত রোদে কাজ নয়',
  },
  symptom: {
    thirst: { self: 'আপনার কি খুব পিপাসা লেগেছে?', buddy: 'আপনার সঙ্গীর কি খুব পিপাসা লেগেছে?' },
    heat_rash: {
      self: 'আপনার কি চুলকানিসহ লাল ফুসকুড়ি (ঘামাচি) হয়েছে?',
      buddy: 'আপনার সঙ্গীর কি চুলকানিসহ লাল ফুসকুড়ি হয়েছে?',
    },
    cramps: { self: 'আপনার কি পেশিতে ব্যথাসহ টান ধরছে?', buddy: 'আপনার সঙ্গীর কি পেশিতে ব্যথাসহ টান ধরছে?' },
    cramps_persistent: {
      self: 'টান কি 1 ঘণ্টা বা তার বেশি সময় ধরে আছে?',
      buddy: 'আপনার সঙ্গীর টান কি 1 ঘণ্টা বা তার বেশি সময় ধরে আছে?',
    },
    headache: { self: 'আপনার কি মাথাব্যথা আছে?', buddy: 'আপনার সঙ্গীর কি মাথাব্যথা আছে?' },
    dizziness: { self: 'আপনার কি মাথা ঘুরছে?', buddy: 'আপনার সঙ্গীর কি মাথা ঘুরছে?' },
    nausea: { self: 'আপনার কি বমি বমি লাগছে?', buddy: 'আপনার সঙ্গীর কি বমি বমি লাগছে?' },
    weakness_fatigue: { self: 'আপনি কি খুব ক্লান্ত বা দুর্বল?', buddy: 'আপনার সঙ্গী কি খুব ক্লান্ত বা দুর্বল?' },
    fainted: {
      self: 'আপনি কি অজ্ঞান হয়েছিলেন, এক মুহূর্তের জন্য হলেও?',
      buddy: 'আপনার সঙ্গী কি অজ্ঞান হয়েছিলেন, এক মুহূর্তের জন্য হলেও?',
    },
    brown_urine: {
      self: 'আপনার প্রস্রাব কি চা বা কোলার মতো বাদামি?',
      buddy: 'আপনার সঙ্গী কি বলছেন তার প্রস্রাব বাদামি?',
    },
    drank_a_lot: {
      self: 'আপনি কি গত 1 ঘণ্টায় 6 গ্লাসের (1.5 লিটার) বেশি পানি পান করেছেন?',
      buddy: 'আপনার সঙ্গী কি গত 1 ঘণ্টায় 6 গ্লাসের (1.5 লিটার) বেশি পানি পান করেছেন?',
    },
    swollen_hands: { self: 'আপনার হাত কি ফুলে গেছে?', buddy: 'আপনার সঙ্গীর হাত কি ফুলে গেছে?' },
    repeated_vomiting: { self: 'আপনি কি একবারের বেশি বমি করেছেন?', buddy: 'আপনার সঙ্গী কি একবারের বেশি বমি করেছেন?' },
    chest_pain: {
      self: 'আপনার কি বুকে ব্যথা বা শ্বাস নিতে কষ্ট হচ্ছে?',
      buddy: 'আপনার সঙ্গীর কি বুকে ব্যথা বা শ্বাস নিতে কষ্ট হচ্ছে?',
    },
    confusion: {
      self: 'আপনার কি সবকিছু গুলিয়ে যাচ্ছে মনে হচ্ছে?',
      buddy: 'আপনার সঙ্গী কি এলোমেলো বা অদ্ভুত আচরণ করছেন?',
    },
    slurred_speech: {
      self: 'আপনার কি স্পষ্ট করে কথা বলতে কষ্ট হচ্ছে?',
      buddy: 'আপনার সঙ্গীর কথা কি জড়িয়ে যাচ্ছে বা অস্পষ্ট?',
    },
    unsteady_walking: {
      self: 'আপনি কি টলছেন বা সোজা হাঁটতে পারছেন না?',
      buddy: 'আপনার সঙ্গী কি টলছেন বা সোজা হাঁটতে পারছেন না?',
    },
    collapsed_unresponsive: {
      self: 'আপনি কি হঠাৎ পড়ে গিয়েছিলেন এবং এখনও স্বাভাবিক লাগছে না?',
      buddy: 'আপনার সঙ্গী কি পড়ে গেছেন, বা সাড়া দিচ্ছেন না?',
    },
    seizure: { self: 'আপনার কি খিঁচুনি হয়েছে?', buddy: 'আপনার সঙ্গীর কি কাঁপুনি বা খিঁচুনি হয়েছে?' },
  },
  checkin: {
    self_intro: 'প্রতিটি প্রশ্নের উত্তর দিন: হ্যাঁ বা না।',
    buddy_intro: 'আপনার সঙ্গীকে দেখুন। উত্তর দিন: হ্যাঁ বা না।',
    trend_question: 'আগের তুলনায় এখন আপনি কেমন বোধ করছেন?',
    better: 'আগের চেয়ে ভালো',
    same: 'একই রকম',
    worse: 'আগের চেয়ে খারাপ',
  },
  urine: {
    question: 'আপনার প্রস্রাবের রং কেমন? সবচেয়ে কাছের রঙে চাপ দিন।',
    ok: 'ভালো। পানি পান করতে থাকুন।',
    drink_more: 'আরও পানি পান করুন।',
    dark: 'রং খুব গাঢ়। এখনই পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
  },
  emergency: {
    title: 'জরুরি অবস্থা। এখনই ব্যবস্থা নিন।',
    call_998: 'অ্যাম্বুলেন্সের জন্য 998-এ ফোন করুন।',
    cool_first: 'আগে ঠান্ডা করুন। হাসপাতালে নেওয়ার আগেই ঠান্ডা করা শুরু করুন।',
    shade: 'তাকে ছায়ায় নিয়ে যান। বাড়তি কাপড় খুলে দিন।',
    immerse: 'সবচেয়ে ভালো: শরীর গলা পর্যন্ত ঠান্ডা বা বরফ-পানিতে রাখুন, টব বা ত্রিপলে। পানি নাড়তে থাকুন।',
    douse: 'টব নেই? তার গায়ে একটানা ঠান্ডা পানি ঢালুন এবং বাতাস করুন।',
    towels: 'অথবা বরফ-পানিতে ভেজানো তোয়ালে দিন, প্রতি 1–2 মিনিটে বদলান, এবং বরফের প্যাক দিন।',
    keep_cooling:
      'অ্যাম্বুলেন্স না আসা পর্যন্ত ঠান্ডা করতে থাকুন। প্রায় 15 মিনিট পরে বরফ-পানি থেকে তুলুন, অথবা তিনি স্বাভাবিক হলে তার আগেই।',
    stay: 'তার সাথে থাকুন। তাকে কখনও একা ছাড়বেন না।',
    fluids: 'তিনি পুরোপুরি জেগে ও সজাগ থাকলেই কেবল পান করতে দিন।',
  },
  ui: {
    status: 'আমার অবস্থা',
    next_break: 'পরের বিরতি {min} মিনিট পরে',
    break_now: 'বিরতির সময়। ছায়ায় যান।',
    drank_water: 'আমি পানি পান করেছি',
    feel_unwell: 'আমার শরীর ভালো লাগছে না',
    im_ok: 'আমি ভালো আছি',
    checkin: 'শরীরের খোঁজ',
    yes: 'হ্যাঁ',
    no: 'না',
    privacy: 'গোপনীয়তা',
    what_i_share: 'কী শেয়ার হয়',
    who_saw: 'কে আমার তথ্য দেখেছে',
    offline: 'অফলাইন মোড',
    offline_note: 'নেটওয়ার্ক নেই। এই ফোনে সতর্কবার্তা তবুও কাজ করে।',
    battery_saver: 'ব্যাটারি সাশ্রয়',
    language: 'ভাষা',
    acknowledge: 'ঠিক আছে, বুঝেছি',
    help_coming: 'সাহায্য আসছে।',
    buddy: 'আমার সঙ্গী',
    buddy_alert: '{name}-এর সাহায্য লাগতে পারে। এখনই গিয়ে দেখুন।',
    get_help: 'সাহায্য ডাকুন',
    slow_down_drinking: 'ধীরে পান করুন। এই ঘণ্টায় আপনি অনেক পানি পান করেছেন।',
    listen: 'শুনুন',
    data_stays: 'আপনার স্বাস্থ্য তথ্য এই ফোনেই থাকে।',
    flags_private: 'এটি শুধু আপনি দেখেন। এটি আপনার ফোনেই থাকে।',
    strain_estimate: 'গরমের চাপের আনুমানিক মান',
    not_medical: 'এটি নিরাপত্তা নির্দেশিকা, মেডিকেল পরীক্ষা নয়।',
    translation_draft: 'খসড়া অনুবাদ। এখনও যাচাই করা হয়নি।',
  },
  consent: {
    wearable: {
      title: 'আমার ব্যান্ড থেকে হৃদস্পন্দন',
      statement:
        'জিল অ্যাপ এই ফোনে আমার ব্যান্ড থেকে হৃদস্পন্দন পড়তে পারে, যাতে আমার গরমের চাপ আন্দাজ করা যায়। এটি আমাকে নিরাপদ রাখতে সাহায্য করার একটি আনুমানিক হিসাব, কোনো মেডিকেল পরিমাপ বা রোগ নির্ণয় নয়। আমার সুপারভাইজার এটি কখনও দেখেন না।',
    },
    healthFlags: {
      title: 'স্বাস্থ্যের যে বিষয়গুলো আমার জন্য গরমকে বেশি বিপজ্জনক করে',
      statement:
        'জিল অ্যাপ আমার হ্যাঁ/না উত্তরগুলো (যেমন সাম্প্রতিক অসুখ, বা এমন ওষুধ যা গরম সহ্য করার ক্ষমতায় প্রভাব ফেলে) ব্যবহার করে আমার সতর্কবার্তা আরও কড়া করতে পারে। আমার উত্তরগুলো এই ফোনেই থাকে এবং আমার সুপারভাইজার বা মালিককে কখনও দেখানো হয় না।',
    },
    checkins: {
      title: 'উপসর্গ ও পানি পানের প্রশ্ন',
      statement:
        'জিল অ্যাপ আমাকে জিজ্ঞেস করতে পারে আমার শরীর কেমন আছে এবং আমার প্রস্রাবের রং কেমন। আমার উত্তরগুলো এই ফোনেই থাকে। আমার কেস এগিয়ে নেওয়া হলে, ফার্স্ট এইডার আমার জানানো উপসর্গগুলো দেখেন, যাতে আমাকে সাহায্য করতে পারেন।',
    },
    shareWithMedicOnEscalation: {
      title: 'কেস এগিয়ে নেওয়া হলে পেশাগত স্বাস্থ্যের সাথে শেয়ার',
      statement:
        'আমার কেস এগিয়ে নেওয়া হলে, পেশাগত স্বাস্থ্যের নার্স আমার যত্ন নিতে আমার হৃদস্পন্দনের আনুমানিক হিসাব, স্বাস্থ্যের বিষয় ও প্রশ্নের উত্তর দেখতে পারেন। আর কেউ এগুলো দেখে না, এবং এগুলো কখনও আমার বিরুদ্ধে ব্যবহার করা হয় না।',
    },
    aggregateStatistics: {
      title: 'আমাকে নামহীন পরিসংখ্যানে গুনুন',
      statement:
        'কাজের জায়গায় গরম নিয়ে জনস্বাস্থ্য পরিসংখ্যানে আমার তথ্য গোনা হতে পারে। 10 জনের কম মানুষের দল লুকিয়ে রাখা হয়, যাতে আমাকে আলাদা করে চেনা না যায়।',
    },
  },
  consent_info: {
    intro: 'জিল অ্যাপ কী ব্যবহার করতে পারবে তা বেছে নিন। প্রতিটি পছন্দ আলাদা।',
    voluntary: 'না বলা ঠিক আছে। আপনি তবুও সব নিরাপত্তা সতর্কবার্তা পাবেন।',
    change_anytime: 'আপনি যেকোনো সময় আপনার পছন্দ বদলাতে পারেন।',
  },
  privacy_notice: {
    title: 'দলগত হিসাবে আপনাকে কীভাবে গোনা হয়',
    statement:
      'গরমে কাজ নিরাপদ রাখা আপনার মালিকের আইনগত দায়িত্ব। তাই জিল অ্যাপ প্রত্যেক শ্রমিককে দলগত হিসাবে গোনে, আপনি “আমাকে নামহীন পরিসংখ্যানে গুনুন” বেছে না নিলেও। সাইটের নিরাপত্তা (HSE) ম্যানেজার শুধু 5 বা তার বেশি শ্রমিকের দল দেখেন। নিয়ন্ত্রক সংস্থা ও আপনার মালিকের HR শুধু 10 বা তার বেশি শ্রমিকের দল দেখে। ছোট দল লুকিয়ে রাখা হয়, এবং এই হিসাব কখনও আপনার নাম বা শুধু আপনার কোনো রেকর্ড দেখায় না। নামহীন পরিসংখ্যান নিয়ে আপনার পছন্দ শুধু ঠিক করে আপনাকে জনস্বাস্থ্য পরিসংখ্যানেও গোনা হবে কি না।',
  },
  flag: {
    prior_heat_illness: {
      name: 'আগে গরমে অসুস্থ',
      explain: 'আপনি আগে গরমে অসুস্থ হয়েছিলেন। অ্যাপ আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    heat_sensitive_medication: {
      name: 'যে ওষুধ গরমকে কঠিন করে',
      explain: 'কিছু ওষুধ গরমকে শরীরের জন্য কঠিন করে তোলে। অ্যাপ আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    hr_suppressing_medication: {
      name: 'হৃদস্পন্দন কমানোর ওষুধ বা যন্ত্র',
      explain: 'আপনার হৃদস্পন্দনে গরমের চাপ নাও দেখা যেতে পারে। অ্যাপ আপনার হৃদস্পন্দন ব্যবহার করে না এবং আপনাকে আগে সতর্ক করে।',
    },
    recent_illness: {
      name: 'সম্প্রতি অসুস্থ',
      explain: 'সম্প্রতি অসুখ হলে গরম শরীরের জন্য কঠিন হয়। অ্যাপ আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    poor_sleep: {
      name: 'কম ঘুম',
      explain: 'কম ঘুম গরমকে শরীরের জন্য কঠিন করে তোলে। অ্যাপ আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    fasting: {
      name: 'রোজা',
      explain: 'রোজার সময় অ্যাপ পানি পান করার কথা মনে করায় না। এটি আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    heat_rash_sunburn: {
      name: 'ঘামাচি বা রোদে পোড়া',
      explain: 'ঘামাচি বা রোদে পোড়া ত্বক ঠিকমতো ঘামতে পারে না। অ্যাপ আপনাকে আগে সতর্ক করে এবং বেশি বিশ্রাম দেয়।',
    },
    oh_review_required: {
      name: 'নার্সের পরীক্ষা দরকার',
      explain: 'ক্লিনিকের নার্স আপনার সাথে একান্তে গরমে নিরাপদ কাজ নিয়ে কথা বলবেন।',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'গরম এই কাজের নিরাপদ সীমার উপরে।',
    heat_near_limit: 'গরম এই কাজের নিরাপদ সীমার কাছাকাছি।',
    heat_within_limit: 'গরম এই কাজের নিরাপদ সীমার মধ্যে।',
    work_rest: 'প্রতি ঘণ্টায় কাজ ও বিশ্রামের সময় মেনে চলুন।',
    clothing: 'আপনার কাজের পোশাক গরম আটকে রাখে, তাই সীমা কম।',
    not_used_limit: 'আপনি এখনও গরমে অভ্যস্ত নন, তাই আপনার সীমা কম।',
    lower_limit: 'আপনার নিরাপত্তার জন্য আজ আপনার সীমা কম।',
    stricter_rest: 'আপনার নিরাপত্তার জন্য আজ আপনি বিশ্রামের বেশি বিরতি পাবেন।',
    heat_time_left: 'গরমে অভ্যস্ত না হওয়া পর্যন্ত গরমে আপনার কাজের সময় সীমিত।',
    heat_time_used: 'আজকের জন্য গরমে আপনার কাজের সময় শেষ।',
    suit: 'বন্ধ সুরক্ষা পোশাক: গরমের সীমা শুধু মোটামুটি নির্দেশনা।',
    less_certain: 'এখানে গরমের আনুমানিক হিসাব কম নিশ্চিত।',
    time_to_limit: 'কাজের এই গতিতে গরমে আপনার নিরাপদ সময় ফুরিয়ে আসছে।',
    limit_reached: 'এই শিফটের জন্য আপনার গরমের নিরাপদ সীমা পূর্ণ হয়েছে। কোনো ঠান্ডা জায়গায় বিশ্রাম নিন।',
    no_limit_soon: 'কাজের এই গতিতে শিগগির কোনো গরমের সীমা নেই।',
    limit_stays: 'শুধু বিশ্রামে আজ আপনার গরমের সীমা আবার শুরু হয় না।',
    fasting_limit: 'রোজা: আপনি পানি পান করছেন না, তাই আপনার সীমা কম।',
    level_stays: 'ফার্স্ট এইডার বা সুপারভাইজার অনুমতি না দেওয়া পর্যন্ত এই সতর্কতা থাকবে।',
    no_hot_work: 'আজ আপনার জন্য গরমে আর কাজ নয়।',
    level_held: 'গরম কমার পরেও মাত্রা কিছুক্ষণ উঁচু থাকে।',
    safe_default: 'কিছু তথ্য নেই বা ভুল, তাই অ্যাপ নিরাপদ মান ব্যবহার করে।',
    checkin_due: 'আপনার শরীরের খোঁজের প্রশ্নের সময় হয়েছে।',
    buddy: 'আজ একজন সঙ্গীর সাথে কাজ করুন।',
    no_lone_work: 'এই গরমে একা কাজ করবেন না।',
    fasting_reminders: 'রোজা: পানি পানের কোনো রিমাইন্ডার নেই। ছায়ায় বিশ্রাম নিন এবং শরীর ঠান্ডা করুন।',
    water_stop: 'ফার্স্ট এইডার না দেখা পর্যন্ত সাধারণ পানি পান বন্ধ রাখুন।',
    check_sensor: 'সাইটের গরম মাপার সেন্সর পরীক্ষা করা দরকার।',
    extreme_heat: 'প্রচণ্ড গরম ও আর্দ্রতা: কাজ বন্ধ করার পরামর্শ দেওয়া হচ্ছে।',
    hot_surfaces: 'এখানে গরম পৃষ্ঠ গরম বাড়ায়। এটি হিসাবে ধরা হয়েছে।',
    site_sensor: 'সাইটের সেন্সর থেকে গরমের রিডিং।',
    zone_high: 'গরমের জোন উচ্চ: কাজ ও বিশ্রামের কড়া সময়, একা কাজ নয়।',
    zone_medium: 'গরমের জোন মাঝারি: কাজ ও বিশ্রামের নির্দিষ্ট সময়, একা কাজ নয়।',
    zone_low: 'গরমের জোন নিম্ন: পানি ও বিরতিসহ স্বাভাবিক কাজ।',
    zone_unknown: 'গরমের জোন জানা নেই, তাই সবচেয়ে কড়া নিয়ম প্রযোজ্য।',
    essential_only: 'সাধারণ কাজের জন্য খুব গরম: শুধু জরুরি কাজ।',
    permit: 'এই কাজের জন্য গরমে কাজের পারমিট দরকার।',
    not_used_reassign: 'এখনও গরমে অভ্যস্ত নন: আপনাকে এই জোনের বাইরে কাজ দেওয়া হবে।',
    not_used_not_alone: 'এখনও গরমে অভ্যস্ত নন: এখানে একা কাজ করবেন না।',
    not_used_plan: 'এখনও গরমে অভ্যস্ত নন: অভ্যস্ত হতে আপনার পরিকল্পনা মেনে চলুন।',
    midday: 'দুপুরের বিরতি: এখন রোদে কাজ নয়।',
    midday_other: 'দুপুরের বিরতির সময়, তবে এই কাজটি রোদে নয়।',
    heat_unknown: 'গরমের কোনো রিডিং নেই, তাই কাজ বন্ধের নিয়ম যাচাই করা যাচ্ছে না।',
    heat_stop: 'খুব গরম: কাজ বন্ধ করতে হবে।',
    band_not_used: 'ব্যান্ড ব্যবহার হচ্ছে না। সতর্কবার্তা আবহাওয়া ও কাজের উপর ভিত্তি করে।',
    band_check: 'ব্যান্ডের তথ্য নেই বা দুর্বল। ব্যান্ড পরা আছে এবং ঠিকমতো লাগানো কিনা দেখুন।',
    band_starting: 'ব্যান্ড চালু হচ্ছে (প্রথম 30 মিনিট)। সতর্কবার্তা আবহাওয়া ও কাজের উপর ভিত্তি করে।',
    band_odd: 'ব্যান্ডের অস্বাভাবিক রিডিং। আপনার সঙ্গী আপনার খোঁজ নেবেন।',
    strain_very_high: 'আনুমানিক হিসাবে গরমের চাপ খুব বেশি। কাজ বন্ধ করুন এবং শরীর ঠান্ডা করুন।',
    strain_high: 'আনুমানিক হিসাবে গরমের চাপ বেশি। কোনো ঠান্ডা জায়গায় বিশ্রাম নিন।',
    strain_rising: 'গরমের চাপের আনুমানিক হিসাব বাড়ছে। প্রশ্নগুলোর উত্তর দিন।',
    effort_high: 'আপনি অনেকক্ষণ ধরে খুব বেশি পরিশ্রম করেছেন। এখন বিশ্রাম নিন।',
    age_unknown: 'বয়স দেওয়া নেই, তাই আরও নিরাপদ সীমা ব্যবহার করা হয়।',
    band_ok: 'ব্যান্ড: কোনো সতর্কতা নেই।',
    no_checkin: 'আজ এখনও শরীরের খোঁজের প্রশ্ন হয়নি।',
    checkin_ok: 'শরীরের খোঁজ: বিপদের কোনো লক্ষণ নেই।',
    too_much_water: 'বিপদের লক্ষণসহ অনেক বেশি পানি। পান বন্ধ করুন এবং ফার্স্ট এইডারের কাছে যান।',
    worse: 'আগের চেয়ে খারাপ লাগছে। 998-এ কল করুন এবং এখনই ঠান্ডা করা শুরু করুন।',
    not_better: '30 মিনিট পরেও ভালো হয়নি। 998-এ কল করুন এবং ঠান্ডা করতে থাকুন।',
    sx_thirst: 'আপনার পিপাসা পেয়েছে। এখনই পানি পান করুন।',
    sx_overdrink: 'বাড়তি পানি পান করবেন না। খারাপ লাগলে ফার্স্ট এইডারকে জানান।',
    sx_t1: 'প্রশ্নের উত্তর: ছায়ায় বিশ্রাম নিন এবং পানি পান করুন।',
    sx_t2: 'প্রশ্নের উত্তর: গরমের কাজ বন্ধ করুন এবং এখনই ফার্স্ট এইডারকে ডাকুন।',
    sx_t3: 'বিপদের লক্ষণ জানানো হয়েছে। 998-এ কল করুন এবং এখনই ঠান্ডা করা শুরু করুন।',
    colour_ok: 'রং পরীক্ষা: ভালো। পানি পান করতে থাকুন।',
    colour_more: 'রং পরীক্ষা: আরও পানি পান করুন।',
    colour_dark: 'রং পরীক্ষা: খুব গাঢ়। পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
    colour_dark_again: 'রং এখনও খুব গাঢ়। বিশ্রাম নিন, পানি পান করুন এবং ফার্স্ট এইডারকে জানান।',
    colour_very_dark: 'রং পরীক্ষা: অত্যন্ত গাঢ়। বিশ্রাম নিন, শরীর ঠান্ডা করুন এবং পানি পান করুন।',
    too_much_today: 'আপনি আজ অনেক বেশি পানি পান করেছেন। ধীরে পান করুন।',
    slow_down: 'ধীরে পান করুন। এই ঘণ্টায় আপনি অনেক পানি পান করেছেন।',
    no_weather: 'আবহাওয়ার তথ্য নেই, তাই অ্যাপ খুব গরম একটি ঘণ্টা ধরে নেয়।',
    weather_old: 'আবহাওয়ার তথ্য পুরোনো, তাই কম নিশ্চিত।',
    weather_old_margin: 'আবহাওয়ার তথ্য অনেক পুরোনো, তাই নিরাপত্তার জন্য বাড়তি মার্জিন যোগ করা হয়েছে।',
    src_forecast: 'পূর্বাভাস থেকে আবহাওয়া।',
    src_archive: 'আবহাওয়ার রেকর্ড থেকে আবহাওয়া।',
    src_cached: 'সংরক্ষিত পূর্বাভাস থেকে আবহাওয়া।',
    rest_cooled: 'বিরতি ঠান্ডা, এসি-যুক্ত বিশ্রামের জায়গায়।',
    rest_shade_only: 'এখানে বিরতির জন্য শুধু ছায়া আছে, তাই আপনার বেশি বিশ্রাম দরকার।',
    recovery_review: 'কোনো ঠান্ডা জায়গায় 30 মিনিট বিশ্রাম নিন। তারপর সুপারভাইজার বা ফার্স্ট এইডারকে আপনাকে অনুমতি দিতে হবে।',
    recovery_cleared: 'আপনাকে আবার কাজের অনুমতি দেওয়া হয়েছে। বিরতি নিতে থাকুন।',
    resume_check: 'গরমের পরীক্ষা এই কাজে ফিরতে অনুমতি না দেওয়া পর্যন্ত বিশ্রাম নিন।',
    task_too_hot: 'এখন এই কাজে ফেরার জন্য খুব গরম। হালকা বা ঠান্ডা কাজে যান।',
    work_bout: 'পরের বিশ্রামের আগে কাজের অল্প সময়ই বাকি আছে।',
    drinks_counted: 'আপনি যে পানি লিখে রাখেন, তা আপনার গরমের সীমায় গোনা হয়।',
    drink_to_restart: 'পানি পান করুন, তা লিখে রাখুন এবং গরমে আবার কাজ শুরু করার আগে বিশ্রাম নিন।',
  }),
}

// ─────────────────────────────── Malayalam ───────────────────────────────

const ML: Catalog = {
  level: {
    safe: { name: 'കുറഞ്ഞ അപകടസാധ്യത', meaning: 'സാധാരണ ജോലി. വെള്ളം കുടിക്കുക, ഇടവേളകൾ എടുക്കുക.' },
    caution: { name: 'ശ്രദ്ധിക്കുക', meaning: 'ചൂടുണ്ട്. ഇടയ്ക്കിടെ വെള്ളം കുടിക്കുക, തണലിൽ വിശ്രമിക്കുക.' },
    high: { name: 'ഉയർന്ന അപകടസാധ്യത', meaning: 'കടുത്ത ചൂട്. ജോലി കുറയ്ക്കുക, തണലിൽ കൂടുതൽ വിശ്രമിക്കുക.' },
    stop: { name: 'ജോലി നിർത്തുക', meaning: 'ചൂടിലെ ജോലി ഇപ്പോൾ നിർത്തുക. തണലിൽ പോയി വിശ്രമിക്കുക.' },
    emergency: { name: 'അടിയന്തരാവസ്ഥ', meaning: 'അപകടം. 998-ൽ വിളിക്കുക, ഉടൻ തണുപ്പിക്കാൻ തുടങ്ങുക.' },
  },
  action: {
    drink_water: 'ഇപ്പോൾ വെള്ളം കുടിക്കുക',
    shade_breaks: 'ഇടയ്ക്കിടെ തണലിൽ വിശ്രമിക്കുക',
    reduce_intensity: 'പതുക്കെ, ഭാരം കുറഞ്ഞ ജോലി ചെയ്യുക',
    rotate_task: 'തണുത്ത സ്ഥലത്തെ ലഘുവായ ജോലിയിലേക്ക് മാറുക',
    rest_shade_now: 'ഇപ്പോൾ തണലിൽ വിശ്രമിക്കുക',
    cool_down: 'ശരീരം തണുപ്പിക്കുക: വെള്ളം നനയ്ക്കുക, ഫാൻ ഉപയോഗിക്കുക',
    stop_work: 'ഇപ്പോൾ ജോലി നിർത്തുക',
    buddy_check: 'കൂടെയുള്ളയാളെ ശ്രദ്ധിക്കുക',
    first_aider_check: 'ഉടൻ ഫസ്റ്റ് എയ്ഡറെ വിളിക്കുക',
    call_998: 'ഉടൻ 998-ൽ വിളിക്കുക',
    cool_first: 'ആദ്യം തണുപ്പിക്കുക, പിന്നെ ആശുപത്രിയിൽ കൊണ്ടുപോകുക',
    stay_with_worker: 'കൂടെ നിൽക്കുക, ഒറ്റയ്ക്ക് വിടരുത്',
    midday_break: 'ഉച്ച വിശ്രമം: വെയിലത്ത് ജോലി പാടില്ല',
    acclimatization_plan: 'ചൂടിൽ പുതിയ ആളാണോ: ആദ്യം കുറച്ച് ജോലി ചെയ്യുക',
    occ_health_review: 'പരിശോധനയ്ക്ക് ക്ലിനിക്കിലെ നഴ്സിനെ കാണുക',
    check_sensor: 'സെൻസർ പ്രവർത്തിക്കുന്നുണ്ടോ എന്ന് നോക്കുക',
    symptom_checkin: 'ആരോഗ്യ ചോദ്യങ്ങൾക്ക് ഉത്തരം നൽകുക',
    no_lone_work: 'ഒറ്റയ്ക്ക് ജോലി ചെയ്യരുത്',
    electrolytes: 'ഇലക്ട്രോലൈറ്റ് (ORS) പാനീയം കുടിക്കുക, ഉപ്പ് ഗുളിക വേണ്ട',
    restrict_fluids: 'തൽക്കാലം വെള്ളം കുടിക്കുന്നത് നിർത്തുക. ഫസ്റ്റ് എയ്ഡറെ കാണുക.',
    medical_evaluation: 'ഇന്നുതന്നെ ഡോക്ടറെ കാണുക',
    no_hot_work_today: 'ഇന്ന് ഇനി ചൂടിൽ ജോലി പാടില്ല',
  },
  action_with: {
    rest_shade_now: '{min} മിനിറ്റ് തണലിൽ വിശ്രമിക്കുക',
    drink_water: 'ഇപ്പോൾ {ml} മി.ലി. വെള്ളം കുടിക്കുക',
    drink_water_every: 'ഓരോ {min} മിനിറ്റിലും {ml} മി.ലി. വെള്ളം കുടിക്കുക',
    shade_breaks: '{work} മിനിറ്റ് ജോലി, {rest} മിനിറ്റ് വിശ്രമം',
    midday_break: '{from} മുതൽ {to} വരെ വെയിലത്ത് ജോലി പാടില്ല',
  },
  symptom: {
    thirst: { self: 'നിങ്ങൾക്ക് വല്ലാത്ത ദാഹമുണ്ടോ?', buddy: 'കൂടെയുള്ളയാൾക്ക് വല്ലാത്ത ദാഹമുണ്ടോ?' },
    heat_rash: {
      self: 'നിങ്ങൾക്ക് ചൊറിച്ചിലുള്ള ചുവന്ന കുരുക്കൾ (ചൂടുകുരു) ഉണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാൾക്ക് ചൊറിച്ചിലുള്ള ചുവന്ന കുരുക്കൾ ഉണ്ടോ?',
    },
    cramps: {
      self: 'നിങ്ങൾക്ക് വേദനയുള്ള മസിൽ പിടുത്തം ഉണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാൾക്ക് വേദനയുള്ള മസിൽ പിടുത്തം ഉണ്ടോ?',
    },
    cramps_persistent: {
      self: 'മസിൽ പിടുത്തം 1 മണിക്കൂറോ അതിൽ കൂടുതലോ നീണ്ടുനിന്നോ?',
      buddy: 'കൂടെയുള്ളയാളുടെ മസിൽ പിടുത്തം 1 മണിക്കൂറോ അതിൽ കൂടുതലോ നീണ്ടുനിന്നോ?',
    },
    headache: { self: 'നിങ്ങൾക്ക് തലവേദനയുണ്ടോ?', buddy: 'കൂടെയുള്ളയാൾക്ക് തലവേദനയുണ്ടോ?' },
    dizziness: { self: 'നിങ്ങൾക്ക് തലകറക്കമുണ്ടോ?', buddy: 'കൂടെയുള്ളയാൾക്ക് തലകറക്കമുണ്ടോ?' },
    nausea: { self: 'നിങ്ങൾക്ക് ഓക്കാനം വരുന്നുണ്ടോ?', buddy: 'കൂടെയുള്ളയാൾക്ക് ഓക്കാനം വരുന്നുണ്ടോ?' },
    weakness_fatigue: {
      self: 'നിങ്ങൾക്ക് വല്ലാത്ത ക്ഷീണമോ തളർച്ചയോ ഉണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാൾക്ക് വല്ലാത്ത ക്ഷീണമോ തളർച്ചയോ ഉണ്ടോ?',
    },
    fainted: {
      self: 'നിങ്ങൾ ബോധംകെട്ടു വീണോ, ഒരു നിമിഷത്തേക്കെങ്കിലും?',
      buddy: 'കൂടെയുള്ളയാൾ ബോധംകെട്ടു വീണോ, ഒരു നിമിഷത്തേക്കെങ്കിലും?',
    },
    brown_urine: {
      self: 'നിങ്ങളുടെ മൂത്രത്തിന് ചായയുടെയോ കോളയുടെയോ പോലെ തവിട്ടുനിറമാണോ?',
      buddy: 'തന്റെ മൂത്രം തവിട്ടുനിറമാണെന്ന് കൂടെയുള്ളയാൾ പറയുന്നുണ്ടോ?',
    },
    drank_a_lot: {
      self: 'കഴിഞ്ഞ 1 മണിക്കൂറിൽ നിങ്ങൾ 6 ഗ്ലാസിൽ (1.5 ലിറ്റർ) കൂടുതൽ വെള്ളം കുടിച്ചോ?',
      buddy: 'കഴിഞ്ഞ 1 മണിക്കൂറിൽ കൂടെയുള്ളയാൾ 6 ഗ്ലാസിൽ (1.5 ലിറ്റർ) കൂടുതൽ വെള്ളം കുടിച്ചോ?',
    },
    swollen_hands: { self: 'നിങ്ങളുടെ കൈകൾ വീങ്ങിയിട്ടുണ്ടോ?', buddy: 'കൂടെയുള്ളയാളുടെ കൈകൾ വീങ്ങിയിട്ടുണ്ടോ?' },
    repeated_vomiting: {
      self: 'നിങ്ങൾ ഒന്നിലധികം തവണ ഛർദ്ദിച്ചോ?',
      buddy: 'കൂടെയുള്ളയാൾ ഒന്നിലധികം തവണ ഛർദ്ദിച്ചോ?',
    },
    chest_pain: {
      self: 'നിങ്ങൾക്ക് നെഞ്ചുവേദനയോ ശ്വാസം മുട്ടലോ ഉണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാൾക്ക് നെഞ്ചുവേദനയോ ശ്വാസം മുട്ടലോ ഉണ്ടോ?',
    },
    confusion: {
      self: 'നിങ്ങൾക്ക് ആശയക്കുഴപ്പം തോന്നുന്നുണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാൾക്ക് ആശയക്കുഴപ്പമുണ്ടോ, അതോ വിചിത്രമായി പെരുമാറുന്നുണ്ടോ?',
    },
    slurred_speech: {
      self: 'വ്യക്തമായി സംസാരിക്കാൻ നിങ്ങൾക്ക് ബുദ്ധിമുട്ടുണ്ടോ?',
      buddy: 'കൂടെയുള്ളയാളുടെ സംസാരം കുഴയുന്നുണ്ടോ, അതോ വ്യക്തമല്ലേ?',
    },
    unsteady_walking: {
      self: 'നിങ്ങൾ വേച്ചുപോകുന്നുണ്ടോ, നേരെ നടക്കാൻ കഴിയുന്നില്ലേ?',
      buddy: 'കൂടെയുള്ളയാൾ വേച്ചുപോകുന്നുണ്ടോ, നേരെ നടക്കാൻ കഴിയുന്നില്ലേ?',
    },
    collapsed_unresponsive: {
      self: 'നിങ്ങൾ പെട്ടെന്ന് കുഴഞ്ഞുവീണോ, ഇപ്പോഴും സാധാരണ നിലയിലായില്ലേ?',
      buddy: 'കൂടെയുള്ളയാൾ കുഴഞ്ഞുവീണോ, അതോ പ്രതികരിക്കുന്നില്ലേ?',
    },
    seizure: { self: 'നിങ്ങൾക്ക് ഫിറ്റ്സ് (വിറയൽ) ഉണ്ടായോ?', buddy: 'കൂടെയുള്ളയാൾക്ക് ഫിറ്റ്സ് (വിറയൽ) ഉണ്ടായോ?' },
  },
  checkin: {
    self_intro: 'ഓരോ ചോദ്യത്തിനും ഉത്തരം നൽകുക: അതെ അല്ലെങ്കിൽ ഇല്ല.',
    buddy_intro: 'കൂടെയുള്ളയാളെ നോക്കുക. ഉത്തരം നൽകുക: അതെ അല്ലെങ്കിൽ ഇല്ല.',
    trend_question: 'മുമ്പത്തേക്കാൾ ഇപ്പോൾ നിങ്ങൾക്ക് എങ്ങനെയുണ്ട്?',
    better: 'ഭേദമുണ്ട്',
    same: 'അതുപോലെ തന്നെ',
    worse: 'കൂടുതൽ മോശം',
  },
  urine: {
    question: 'നിങ്ങളുടെ മൂത്രത്തിന്റെ നിറം ഏതാണ്? ഏറ്റവും അടുത്ത നിറത്തിൽ തൊടുക.',
    ok: 'നല്ലത്. വെള്ളം കുടിച്ചുകൊണ്ടിരിക്കുക.',
    drink_more: 'കൂടുതൽ വെള്ളം കുടിക്കുക.',
    dark: 'നിറം വളരെ കടുപ്പമാണ്. ഇപ്പോൾ വെള്ളം കുടിക്കുക, തണലിൽ വിശ്രമിക്കുക.',
  },
  emergency: {
    title: 'അടിയന്തരാവസ്ഥ. ഉടൻ പ്രവർത്തിക്കുക.',
    call_998: 'ആംബുലൻസിനായി 998-ൽ വിളിക്കുക.',
    cool_first: 'ആദ്യം തണുപ്പിക്കുക. ആശുപത്രിയിൽ കൊണ്ടുപോകുന്നതിന് മുമ്പ് തണുപ്പിക്കാൻ തുടങ്ങുക.',
    shade: 'അവരെ തണലിലേക്ക് മാറ്റുക. അധിക വസ്ത്രങ്ങൾ മാറ്റുക.',
    immerse:
      'ഏറ്റവും നല്ലത്: കഴുത്തുവരെ തണുത്ത വെള്ളത്തിലോ ഐസ് വെള്ളത്തിലോ ശരീരം മുക്കുക, ടബ്ബിലോ ടാർപ്പിലോ. വെള്ളം ഇളക്കിക്കൊണ്ടിരിക്കുക.',
    douse: 'ടബ് ഇല്ലേ? അവരുടെ ദേഹത്ത് തുടർച്ചയായി തണുത്ത വെള്ളം ഒഴിക്കുക, വീശുക.',
    towels: 'അല്ലെങ്കിൽ ഐസ് വെള്ളത്തിൽ മുക്കിയ തുണികൾ വയ്ക്കുക, ഓരോ 1–2 മിനിറ്റിലും മാറ്റുക, ഐസ് പാക്കുകളും വയ്ക്കുക.',
    keep_cooling:
      'ആംബുലൻസ് എത്തുന്നതുവരെ തണുപ്പിക്കുന്നത് തുടരുക. ഏകദേശം 15 മിനിറ്റിനു ശേഷം ഐസ് വെള്ളത്തിൽ നിന്ന് പുറത്തെടുക്കുക, അല്ലെങ്കിൽ സാധാരണ നിലയിലായാൽ അതിനുമുമ്പ്.',
    stay: 'അവരുടെ കൂടെ നിൽക്കുക. ഒരിക്കലും ഒറ്റയ്ക്ക് വിടരുത്.',
    fluids: 'പൂർണ്ണ ബോധത്തോടെ ഉണർന്നിരിക്കുന്നുണ്ടെങ്കിൽ മാത്രം കുടിക്കാൻ കൊടുക്കുക.',
  },
  ui: {
    status: 'എന്റെ നില',
    next_break: 'അടുത്ത ഇടവേള {min} മിനിറ്റിൽ',
    break_now: 'ഇടവേള സമയം. തണലിലേക്ക് പോകുക.',
    drank_water: 'ഞാൻ വെള്ളം കുടിച്ചു',
    feel_unwell: 'എനിക്ക് സുഖമില്ല',
    im_ok: 'എനിക്ക് കുഴപ്പമില്ല',
    checkin: 'സുഖവിവരം',
    yes: 'അതെ',
    no: 'ഇല്ല',
    privacy: 'സ്വകാര്യത',
    what_i_share: 'എന്താണ് പങ്കിടുന്നത്',
    who_saw: 'എന്റെ വിവരങ്ങൾ ആരൊക്കെ കണ്ടു',
    offline: 'ഓഫ് ലൈൻ മോഡ്',
    offline_note: 'നെറ്റ്വർക്ക് ഇല്ല. ഈ ഫോണിലെ മുന്നറിയിപ്പുകൾ ഇപ്പോഴും പ്രവർത്തിക്കും.',
    battery_saver: 'ബാറ്ററി ലാഭം',
    language: 'ഭാഷ',
    acknowledge: 'ശരി, മനസ്സിലായി',
    help_coming: 'സഹായം വരുന്നു.',
    buddy: 'എന്റെ കൂട്ടാളി',
    buddy_alert: '{name}-ന് സഹായം വേണ്ടിവന്നേക്കാം. ഇപ്പോൾ പോയി നോക്കുക.',
    get_help: 'സഹായം വിളിക്കുക',
    slow_down_drinking: 'പതുക്കെ കുടിക്കുക. ഈ മണിക്കൂറിൽ നിങ്ങൾ ധാരാളം വെള്ളം കുടിച്ചു.',
    listen: 'കേൾക്കുക',
    data_stays: 'നിങ്ങളുടെ ആരോഗ്യ വിവരങ്ങൾ ഈ ഫോണിൽ തന്നെ ഇരിക്കും.',
    flags_private: 'ഇത് നിങ്ങൾക്ക് മാത്രമേ കാണാനാകൂ. ഇത് നിങ്ങളുടെ ഫോണിൽ തന്നെ ഇരിക്കും.',
    strain_estimate: 'ചൂട് സമ്മർദ്ദത്തിന്റെ ഏകദേശ കണക്ക്',
    not_medical: 'ഇത് സുരക്ഷാ മാർഗ്ഗനിർദ്ദേശമാണ്, മെഡിക്കൽ പരിശോധനയല്ല.',
    translation_draft: 'കരട് പരിഭാഷ. ഇതുവരെ പരിശോധിച്ചിട്ടില്ല.',
  },
  consent: {
    wearable: {
      title: 'എന്റെ ബാൻഡിൽ നിന്നുള്ള ഹൃദയമിടിപ്പ്',
      statement:
        'എന്റെ ചൂട് സമ്മർദ്ദം കണക്കാക്കാൻ സിൽ ആപ്പിന് ഈ ഫോണിൽ എന്റെ ബാൻഡിൽ നിന്ന് ഹൃദയമിടിപ്പ് വായിക്കാം. ഇത് എന്നെ സുരക്ഷിതമായി സൂക്ഷിക്കാൻ സഹായിക്കുന്ന ഒരു ഏകദേശ കണക്കാണ്, മെഡിക്കൽ അളവോ രോഗനിർണയമോ അല്ല. എന്റെ സൂപ്പർവൈസർ ഇത് ഒരിക്കലും കാണില്ല.',
    },
    healthFlags: {
      title: 'ചൂട് എനിക്ക് കൂടുതൽ അപകടകരമാക്കുന്ന ആരോഗ്യ കാര്യങ്ങൾ',
      statement:
        'എന്റെ മുന്നറിയിപ്പുകൾ കൂടുതൽ കർശനമാക്കാൻ സിൽ ആപ്പിന് എന്റെ അതെ/അല്ല ഉത്തരങ്ങൾ (ഉദാഹരണത്തിന് അടുത്തിടെയുണ്ടായ അസുഖം, അല്ലെങ്കിൽ ചൂട് താങ്ങാനുള്ള ശേഷിയെ ബാധിക്കുന്ന മരുന്ന്) ഉപയോഗിക്കാം. എന്റെ ഉത്തരങ്ങൾ ഈ ഫോണിൽ തന്നെ ഇരിക്കും, എന്റെ സൂപ്പർവൈസർക്കോ തൊഴിലുടമയ്ക്കോ ഒരിക്കലും കാണിക്കില്ല.',
    },
    checkins: {
      title: 'ലക്ഷണങ്ങളെയും വെള്ളം കുടിക്കുന്നതിനെയും കുറിച്ചുള്ള ചോദ്യങ്ങൾ',
      statement:
        'എനിക്ക് എങ്ങനെ തോന്നുന്നുവെന്നും എന്റെ മൂത്രത്തിന്റെ നിറവും സിൽ ആപ്പ് ചോദിച്ചേക്കാം. എന്റെ ഉത്തരങ്ങൾ ഈ ഫോണിൽ തന്നെ ഇരിക്കും. എന്റെ കേസ് മുന്നോട്ട് നീക്കിയാൽ, എന്നെ സഹായിക്കാൻ ഫസ്റ്റ് എയ്ഡർ ഞാൻ പറഞ്ഞ ലക്ഷണങ്ങൾ കാണും.',
    },
    shareWithMedicOnEscalation: {
      title: 'എന്റെ കേസ് മുന്നോട്ട് നീക്കിയാൽ തൊഴിൽ ആരോഗ്യ വിഭാഗവുമായി പങ്കിടുക',
      statement:
        'എന്റെ കേസ് മുന്നോട്ട് നീക്കിയാൽ, എന്നെ പരിചരിക്കാൻ തൊഴിൽ ആരോഗ്യ നഴ്സിന് എന്റെ ഹൃദയമിടിപ്പ് കണക്കുകളും ആരോഗ്യ കാര്യങ്ങളും ചോദ്യങ്ങൾക്കുള്ള ഉത്തരങ്ങളും കാണാം. മറ്റാരും ഇവ കാണില്ല, ഇവ ഒരിക്കലും എനിക്കെതിരെ ഉപയോഗിക്കില്ല.',
    },
    aggregateStatistics: {
      title: 'പേരില്ലാത്ത സ്ഥിതിവിവരക്കണക്കുകളിൽ എന്നെ ഉൾപ്പെടുത്തുക',
      statement:
        'ജോലിസ്ഥലത്തെ ചൂടിനെക്കുറിച്ചുള്ള പൊതുജനാരോഗ്യ സ്ഥിതിവിവരക്കണക്കുകളിൽ എന്റെ വിവരങ്ങൾ എണ്ണിയേക്കാം. എന്നെ തിരിച്ചറിയാതിരിക്കാൻ 10-ൽ കുറവ് ആളുകളുള്ള കൂട്ടങ്ങൾ മറച്ചുവെക്കും.',
    },
  },
  consent_info: {
    intro: 'സിൽ ആപ്പ് എന്ത് ഉപയോഗിക്കാമെന്ന് തിരഞ്ഞെടുക്കുക. ഓരോ തിരഞ്ഞെടുപ്പും വേറെയാണ്.',
    voluntary: 'വേണ്ട എന്ന് പറയാം. എങ്കിലും എല്ലാ സുരക്ഷാ മുന്നറിയിപ്പുകളും നിങ്ങൾക്ക് ലഭിക്കും.',
    change_anytime: 'എപ്പോൾ വേണമെങ്കിലും നിങ്ങളുടെ തിരഞ്ഞെടുപ്പ് മാറ്റാം.',
  },
  privacy_notice: {
    title: 'കൂട്ടക്കണക്കുകളിൽ നിങ്ങളെ എങ്ങനെ എണ്ണുന്നു',
    statement:
      'ചൂടിലെ ജോലി സുരക്ഷിതമാക്കാൻ നിങ്ങളുടെ തൊഴിലുടമയ്ക്ക് നിയമപരമായ ബാധ്യതയുണ്ട്. അതിനാൽ, നിങ്ങൾ “പേരില്ലാത്ത സ്ഥിതിവിവരക്കണക്കുകളിൽ എന്നെ ഉൾപ്പെടുത്തുക” തിരഞ്ഞെടുത്തില്ലെങ്കിലും സിൽ ആപ്പ് എല്ലാ തൊഴിലാളികളെയും കൂട്ടക്കണക്കുകളിൽ എണ്ണുന്നു. സൈറ്റിലെ സുരക്ഷാ (HSE) മാനേജർ 5-ഓ അതിലധികമോ തൊഴിലാളികളുള്ള കൂട്ടങ്ങൾ മാത്രമേ കാണൂ. റെഗുലേറ്ററും നിങ്ങളുടെ തൊഴിലുടമയുടെ HR-ഉം 10-ഓ അതിലധികമോ തൊഴിലാളികളുള്ള കൂട്ടങ്ങൾ മാത്രമേ കാണൂ. ചെറിയ കൂട്ടങ്ങൾ മറച്ചുവെക്കും, ഈ കണക്കുകൾ ഒരിക്കലും നിങ്ങളുടെ പേരോ നിങ്ങളെ മാത്രം കുറിച്ചുള്ള ഒരു രേഖയോ കാണിക്കില്ല. പേരില്ലാത്ത സ്ഥിതിവിവരക്കണക്കുകളെക്കുറിച്ചുള്ള നിങ്ങളുടെ തിരഞ്ഞെടുപ്പ്, നിങ്ങളെ പൊതുജനാരോഗ്യ സ്ഥിതിവിവരക്കണക്കുകളിലും എണ്ണണോ എന്ന് മാത്രമാണ് തീരുമാനിക്കുന്നത്.',
  },
  flag: {
    prior_heat_illness: {
      name: 'മുമ്പ് ചൂട് കൊണ്ട് അസുഖം',
      explain: 'മുമ്പ് നിങ്ങൾക്ക് ചൂട് കൊണ്ട് അസുഖം വന്നിട്ടുണ്ട്. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    heat_sensitive_medication: {
      name: 'ചൂട് ബുദ്ധിമുട്ടാക്കുന്ന മരുന്ന്',
      explain: 'ചില മരുന്നുകൾ ചൂട് ശരീരത്തിന് കൂടുതൽ ബുദ്ധിമുട്ടാക്കും. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    hr_suppressing_medication: {
      name: 'ഹൃദയമിടിപ്പ് കുറയ്ക്കുന്ന മരുന്നോ ഉപകരണമോ',
      explain: 'നിങ്ങളുടെ ഹൃദയമിടിപ്പിൽ ചൂട് സമ്മർദ്ദം കാണണമെന്നില്ല. ആപ്പ് നിങ്ങളുടെ ഹൃദയമിടിപ്പ് ഉപയോഗിക്കില്ല, നേരത്തെ മുന്നറിയിപ്പ് നൽകും.',
    },
    recent_illness: {
      name: 'അടുത്തിടെ അസുഖം',
      explain: 'അടുത്തിടെ വന്ന അസുഖം ചൂട് ശരീരത്തിന് കൂടുതൽ ബുദ്ധിമുട്ടാക്കും. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    poor_sleep: {
      name: 'ഉറക്കക്കുറവ്',
      explain: 'ഉറക്കക്കുറവ് ചൂട് ശരീരത്തിന് കൂടുതൽ ബുദ്ധിമുട്ടാക്കും. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    fasting: {
      name: 'നോമ്പ്',
      explain: 'നോമ്പ് സമയത്ത് വെള്ളം കുടിക്കാൻ ആപ്പ് ഓർമ്മിപ്പിക്കില്ല. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    heat_rash_sunburn: {
      name: 'ചൂടുകുരു അല്ലെങ്കിൽ വെയിലേറ്റ പൊള്ളൽ',
      explain: 'ചൂടുകുരുവോ വെയിലേറ്റ പൊള്ളലോ ഉള്ള തൊലി ശരിയായി വിയർക്കില്ല. ആപ്പ് നേരത്തെ മുന്നറിയിപ്പ് നൽകും, കൂടുതൽ വിശ്രമം നൽകും.',
    },
    oh_review_required: {
      name: 'നഴ്സിന്റെ പരിശോധന വേണം',
      explain: 'ചൂടിൽ സുരക്ഷിതമായി ജോലി ചെയ്യുന്നതിനെക്കുറിച്ച് ക്ലിനിക്കിലെ നഴ്സ് നിങ്ങളോട് സ്വകാര്യമായി സംസാരിക്കും.',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'ചൂട് ഈ ജോലിയുടെ സുരക്ഷിത പരിധിക്ക് മുകളിലാണ്.',
    heat_near_limit: 'ചൂട് ഈ ജോലിയുടെ സുരക്ഷിത പരിധിക്ക് അടുത്താണ്.',
    heat_within_limit: 'ചൂട് ഈ ജോലിയുടെ സുരക്ഷിത പരിധിക്കുള്ളിലാണ്.',
    work_rest: 'ഓരോ മണിക്കൂറിലും ജോലിയുടെയും വിശ്രമത്തിന്റെയും സമയം പാലിക്കുക.',
    clothing: 'നിങ്ങളുടെ ജോലി വസ്ത്രം ചൂട് പിടിച്ചുനിർത്തുന്നു, അതിനാൽ പരിധി കുറവാണ്.',
    not_used_limit: 'നിങ്ങൾ ഇതുവരെ ചൂടുമായി പൊരുത്തപ്പെട്ടിട്ടില്ല, അതിനാൽ നിങ്ങളുടെ പരിധി കുറവാണ്.',
    lower_limit: 'നിങ്ങളുടെ സുരക്ഷയ്ക്കായി ഇന്ന് നിങ്ങളുടെ പരിധി കുറവാണ്.',
    stricter_rest: 'നിങ്ങളുടെ സുരക്ഷയ്ക്കായി ഇന്ന് നിങ്ങൾക്ക് കൂടുതൽ വിശ്രമ ഇടവേളകൾ ലഭിക്കും.',
    heat_time_left: 'ചൂടുമായി പൊരുത്തപ്പെടുന്നതുവരെ ചൂടിലെ നിങ്ങളുടെ ജോലിസമയം പരിമിതമാണ്.',
    heat_time_used: 'ഇന്നത്തെ ചൂടിലെ ജോലിസമയം തീർന്നു.',
    suit: 'അടച്ച സുരക്ഷാ വസ്ത്രം: ചൂടിന്റെ പരിധികൾ ഏകദേശ സൂചന മാത്രമാണ്.',
    less_certain: 'ഇവിടെ ചൂടിന്റെ കണക്ക് അത്ര ഉറപ്പുള്ളതല്ല.',
    time_to_limit: 'ഈ ജോലി വേഗതയിൽ ചൂടിലെ നിങ്ങളുടെ സുരക്ഷിത സമയം തീരുകയാണ്.',
    limit_reached: 'ഈ ഷിഫ്റ്റിലെ നിങ്ങളുടെ സുരക്ഷിത ചൂട് പരിധി എത്തി. തണുത്ത സ്ഥലത്ത് വിശ്രമിക്കുക.',
    no_limit_soon: 'ഈ ജോലി വേഗതയിൽ ഉടനെ ചൂട് പരിധി ഇല്ല.',
    limit_stays: 'വിശ്രമം കൊണ്ട് മാത്രം ഇന്ന് നിങ്ങളുടെ ചൂട് പരിധി പുനഃസജ്ജമാകില്ല.',
    fasting_limit: 'നോമ്പ്: നിങ്ങൾ വെള്ളം കുടിക്കുന്നില്ല, അതിനാൽ നിങ്ങളുടെ പരിധി കുറവാണ്.',
    level_stays: 'ഫസ്റ്റ് എയ്ഡറോ സൂപ്പർവൈസറോ അനുമതി നൽകുന്നതുവരെ ഈ മുന്നറിയിപ്പ് തുടരും.',
    no_hot_work: 'ഇന്ന് നിങ്ങൾക്ക് ഇനി ചൂടിൽ ജോലി ഇല്ല.',
    level_held: 'ചൂട് കുറഞ്ഞശേഷവും നില കുറച്ചുനേരം ഉയർന്നുനിൽക്കും.',
    safe_default: 'ചില വിവരങ്ങൾ ഇല്ല അല്ലെങ്കിൽ തെറ്റാണ്, അതിനാൽ ആപ്പ് സുരക്ഷിത മൂല്യങ്ങൾ ഉപയോഗിക്കുന്നു.',
    checkin_due: 'നിങ്ങളുടെ സുഖവിവര ചോദ്യങ്ങൾക്കുള്ള സമയമായി.',
    buddy: 'ഇന്ന് ഒരു കൂട്ടാളിയോടൊപ്പം ജോലി ചെയ്യുക.',
    no_lone_work: 'ഈ ചൂടിൽ ഒറ്റയ്ക്ക് ജോലി ചെയ്യരുത്.',
    fasting_reminders: 'നോമ്പ്: വെള്ളം കുടിക്കാനുള്ള ഓർമ്മപ്പെടുത്തലുകൾ ഇല്ല. തണലിൽ വിശ്രമിച്ച് ശരീരം തണുപ്പിക്കുക.',
    water_stop: 'ഫസ്റ്റ് എയ്ഡർ പരിശോധിക്കുന്നതുവരെ സാധാരണ വെള്ളം കുടിക്കുന്നത് നിർത്തുക.',
    check_sensor: 'സൈറ്റിലെ ചൂട് സെൻസർ പരിശോധിക്കേണ്ടതുണ്ട്.',
    extreme_heat: 'കടുത്ത ചൂടും ഈർപ്പവും: ജോലി നിർത്താൻ നിർദേശിക്കുന്നു.',
    hot_surfaces: 'ഇവിടെയുള്ള ചൂടുള്ള പ്രതലങ്ങൾ ചൂട് കൂട്ടുന്നു. ഇത് കണക്കിലെടുത്തിട്ടുണ്ട്.',
    site_sensor: 'സൈറ്റ് സെൻസറിൽ നിന്നുള്ള ചൂട് റീഡിംഗ്.',
    zone_high: 'ചൂട് മേഖല ഉയർന്നത്: കർശനമായ ജോലി-വിശ്രമ സമയം, ഒറ്റയ്ക്ക് ജോലി പാടില്ല.',
    zone_medium: 'ചൂട് മേഖല ഇടത്തരം: നിശ്ചിത ജോലി-വിശ്രമ സമയം, ഒറ്റയ്ക്ക് ജോലി പാടില്ല.',
    zone_low: 'ചൂട് മേഖല താഴ്ന്നത്: വെള്ളവും ഇടവേളകളുമായി സാധാരണ ജോലി.',
    zone_unknown: 'ചൂട് മേഖല അറിയില്ല, അതിനാൽ ഏറ്റവും കർശനമായ നിയമങ്ങൾ ബാധകമാണ്.',
    essential_only: 'സാധാരണ ജോലിക്ക് വളരെ ചൂടാണ്: അത്യാവശ്യ ജോലികൾ മാത്രം.',
    permit: 'ഈ ജോലിക്ക് ചൂടിലെ ജോലിക്കുള്ള പെർമിറ്റ് വേണം.',
    not_used_reassign: 'ഇതുവരെ ചൂടുമായി പൊരുത്തപ്പെട്ടിട്ടില്ല: ഈ മേഖലയ്ക്ക് പുറത്ത് നിങ്ങൾക്ക് ജോലി ലഭിക്കും.',
    not_used_not_alone: 'ഇതുവരെ ചൂടുമായി പൊരുത്തപ്പെട്ടിട്ടില്ല: ഇവിടെ ഒറ്റയ്ക്ക് ജോലി ചെയ്യരുത്.',
    not_used_plan: 'ഇതുവരെ ചൂടുമായി പൊരുത്തപ്പെട്ടിട്ടില്ല: പൊരുത്തപ്പെടാൻ നിങ്ങളുടെ പദ്ധതി പാലിക്കുക.',
    midday: 'ഉച്ച വിശ്രമം: ഇപ്പോൾ വെയിലത്ത് ജോലി പാടില്ല.',
    midday_other: 'ഉച്ച വിശ്രമ സമയമാണ്, പക്ഷേ ഈ ജോലി വെയിലത്തല്ല.',
    heat_unknown: 'ചൂട് റീഡിംഗ് ഇല്ല, അതിനാൽ ജോലി നിർത്തൽ നിയമം പരിശോധിക്കാൻ കഴിയില്ല.',
    heat_stop: 'വളരെ ചൂടാണ്: ജോലി നിർത്തണം.',
    band_not_used: 'ബാൻഡ് ഉപയോഗിക്കുന്നില്ല. മുന്നറിയിപ്പുകൾ കാലാവസ്ഥയും ജോലിയും അടിസ്ഥാനമാക്കിയാണ്.',
    band_check: 'ബാൻഡ് വിവരങ്ങൾ ഇല്ല അല്ലെങ്കിൽ മോശമാണ്. ബാൻഡ് ധരിച്ചിട്ടുണ്ടോ, ശരിയായി ഉറപ്പിച്ചിട്ടുണ്ടോ എന്ന് നോക്കുക.',
    band_starting: 'ബാൻഡ് ആരംഭിക്കുന്നു (ആദ്യ 30 മിനിറ്റ്). മുന്നറിയിപ്പുകൾ കാലാവസ്ഥയും ജോലിയും അടിസ്ഥാനമാക്കിയാണ്.',
    band_odd: 'ബാൻഡിൽ അസാധാരണ റീഡിംഗ്. നിങ്ങളുടെ കൂട്ടാളി നിങ്ങളെ ശ്രദ്ധിക്കും.',
    strain_very_high: 'കണക്കനുസരിച്ച് ചൂട് സമ്മർദ്ദം വളരെ കൂടുതലാണ്. ജോലി നിർത്തി ശരീരം തണുപ്പിക്കുക.',
    strain_high: 'കണക്കനുസരിച്ച് ചൂട് സമ്മർദ്ദം കൂടുതലാണ്. തണുത്ത സ്ഥലത്ത് വിശ്രമിക്കുക.',
    strain_rising: 'ചൂട് സമ്മർദ്ദത്തിന്റെ കണക്ക് ഉയരുന്നു. സുഖവിവര ചോദ്യങ്ങൾക്ക് ഉത്തരം നൽകുക.',
    effort_high: 'നിങ്ങൾ ഏറെനേരം വളരെ കഠിനമായി ജോലി ചെയ്തു. ഇപ്പോൾ വിശ്രമിക്കുക.',
    age_unknown: 'പ്രായം നൽകിയിട്ടില്ല, അതിനാൽ കൂടുതൽ സുരക്ഷിതമായ പരിധി ഉപയോഗിക്കുന്നു.',
    band_ok: 'ബാൻഡ്: മുന്നറിയിപ്പില്ല.',
    no_checkin: 'ഇന്ന് ഇതുവരെ സുഖവിവര ചോദ്യങ്ങൾ നടന്നിട്ടില്ല.',
    checkin_ok: 'സുഖവിവരം: അപകട സൂചനകളൊന്നുമില്ല.',
    too_much_water: 'അപകട സൂചനകളോടൊപ്പം അമിതമായി വെള്ളം. കുടിക്കുന്നത് നിർത്തി ഫസ്റ്റ് എയ്ഡറെ കാണുക.',
    worse: 'മുമ്പത്തേക്കാൾ മോശമായി തോന്നുന്നു. 998-ൽ വിളിച്ച് ഉടൻ തണുപ്പിക്കാൻ തുടങ്ങുക.',
    not_better: '30 മിനിറ്റിനു ശേഷവും മെച്ചമില്ല. 998-ൽ വിളിച്ച് തണുപ്പിക്കൽ തുടരുക.',
    sx_thirst: 'നിങ്ങൾക്ക് ദാഹിക്കുന്നു. ഇപ്പോൾ വെള്ളം കുടിക്കുക.',
    sx_overdrink: 'അധികം വെള്ളം കുടിക്കരുത്. സുഖമില്ലെന്ന് തോന്നിയാൽ ഫസ്റ്റ് എയ്ഡറോട് പറയുക.',
    sx_t1: 'ചോദ്യത്തിന്റെ ഉത്തരം: തണലിൽ വിശ്രമിച്ച് വെള്ളം കുടിക്കുക.',
    sx_t2: 'ചോദ്യത്തിന്റെ ഉത്തരം: ചൂടിലെ ജോലി നിർത്തി ഉടൻ ഫസ്റ്റ് എയ്ഡറെ വിളിക്കുക.',
    sx_t3: 'അപകട സൂചന അറിയിച്ചു. 998-ൽ വിളിച്ച് ഉടൻ തണുപ്പിക്കാൻ തുടങ്ങുക.',
    colour_ok: 'നിറം പരിശോധന: നല്ലത്. വെള്ളം കുടിക്കുന്നത് തുടരുക.',
    colour_more: 'നിറം പരിശോധന: കൂടുതൽ വെള്ളം കുടിക്കുക.',
    colour_dark: 'നിറം പരിശോധന: വളരെ കടുപ്പം. വെള്ളം കുടിച്ച് തണലിൽ വിശ്രമിക്കുക.',
    colour_dark_again: 'നിറം ഇപ്പോഴും വളരെ കടുപ്പമാണ്. വിശ്രമിക്കുക, വെള്ളം കുടിക്കുക, ഫസ്റ്റ് എയ്ഡറോട് പറയുക.',
    colour_very_dark: 'നിറം പരിശോധന: അതീവ കടുപ്പം. വിശ്രമിക്കുക, ശരീരം തണുപ്പിക്കുക, വെള്ളം കുടിക്കുക.',
    too_much_today: 'ഇന്ന് നിങ്ങൾ വളരെയധികം വെള്ളം കുടിച്ചു. പതുക്കെ കുടിക്കുക.',
    slow_down: 'പതുക്കെ കുടിക്കുക. ഈ മണിക്കൂറിൽ നിങ്ങൾ ധാരാളം വെള്ളം കുടിച്ചു.',
    no_weather: 'കാലാവസ്ഥാ വിവരങ്ങളില്ല, അതിനാൽ വളരെ ചൂടുള്ള ഒരു മണിക്കൂറാണെന്ന് ആപ്പ് കണക്കാക്കുന്നു.',
    weather_old: 'കാലാവസ്ഥാ വിവരങ്ങൾ പഴയതാണ്, അതിനാൽ അത്ര ഉറപ്പില്ല.',
    weather_old_margin: 'കാലാവസ്ഥാ വിവരങ്ങൾ വളരെ പഴയതാണ്, അതിനാൽ ഒരു സുരക്ഷാ മാർജിൻ ചേർത്തു.',
    src_forecast: 'പ്രവചനത്തിൽ നിന്നുള്ള കാലാവസ്ഥ.',
    src_archive: 'കാലാവസ്ഥാ രേഖകളിൽ നിന്നുള്ള കാലാവസ്ഥ.',
    src_cached: 'സംരക്ഷിച്ച പ്രവചനത്തിൽ നിന്നുള്ള കാലാവസ്ഥ.',
    rest_cooled: 'ഇടവേളകൾ തണുത്ത, എസി ഉള്ള വിശ്രമസ്ഥലത്താണ്.',
    rest_shade_only: 'ഇവിടെ ഇടവേളയ്ക്ക് തണൽ മാത്രമേയുള്ളൂ, അതിനാൽ നിങ്ങൾക്ക് കൂടുതൽ വിശ്രമം വേണം.',
    recovery_review: 'തണുത്ത സ്ഥലത്ത് 30 മിനിറ്റ് വിശ്രമിക്കുക. തുടർന്ന് സൂപ്പർവൈസറോ ഫസ്റ്റ് എയ്ഡറോ നിങ്ങൾക്ക് അനുമതി നൽകണം.',
    recovery_cleared: 'വീണ്ടും ജോലി ചെയ്യാൻ നിങ്ങൾക്ക് അനുമതി ലഭിച്ചു. ഇടവേളകൾ എടുക്കുന്നത് തുടരുക.',
    resume_check: 'ഈ ജോലിയിലേക്ക് മടങ്ങാമെന്ന് ചൂട് പരിശോധന പറയുന്നതുവരെ വിശ്രമിക്കുക.',
    task_too_hot: 'ഇപ്പോൾ ഈ ജോലിയിലേക്ക് മടങ്ങാൻ വളരെ ചൂടാണ്. ലഘുവായ അല്ലെങ്കിൽ തണുത്ത ജോലിയിലേക്ക് മാറുക.',
    work_bout: 'അടുത്ത വിശ്രമത്തിന് മുമ്പ് കുറച്ച് ജോലി സമയം മാത്രമേ ബാക്കിയുള്ളൂ.',
    drinks_counted: 'നിങ്ങൾ രേഖപ്പെടുത്തുന്ന വെള്ളം നിങ്ങളുടെ ചൂട് പരിധിയിൽ കണക്കാക്കുന്നു.',
    drink_to_restart: 'വെള്ളം കുടിക്കുക, അത് രേഖപ്പെടുത്തുക, ചൂടിൽ വീണ്ടും ജോലി തുടങ്ങുന്നതിന് മുമ്പ് വിശ്രമിക്കുക.',
  }),
}

// ─────────────────────────────── Tagalog / Filipino ───────────────────────────────

const TL: Catalog = {
  level: {
    safe: { name: 'Mababang panganib', meaning: 'Normal na trabaho. Uminom ng tubig at mag-break.' },
    caution: { name: 'Mag-ingat', meaning: 'Mainit. Uminom ng tubig nang madalas at magpahinga sa lilim.' },
    high: { name: 'Mataas na panganib', meaning: 'Napakainit. Bawasan ang trabaho, dagdagan ang pahinga sa lilim.' },
    stop: { name: 'Itigil ang trabaho', meaning: 'Itigil na ang trabaho sa init. Pumunta sa lilim at magpahinga.' },
    emergency: { name: 'Emergency', meaning: 'Panganib. Tumawag sa 998 at simulan agad ang pagpapalamig.' },
  },
  action: {
    drink_water: 'Uminom ng tubig ngayon',
    shade_breaks: 'Regular na magpahinga sa lilim',
    reduce_intensity: 'Bagalan at gaanan ang trabaho',
    rotate_task: 'Lumipat sa mas magaan at malamig na gawain',
    rest_shade_now: 'Magpahinga sa lilim ngayon',
    cool_down: 'Magpalamig: basain ang balat, gumamit ng bentilador',
    stop_work: 'Itigil ang trabaho ngayon',
    buddy_check: 'Tingnan ang kalagayan ng iyong kasama',
    first_aider_check: 'Tawagin agad ang first aider',
    call_998: 'Tumawag agad sa 998',
    cool_first: 'Palamigin muna, saka dalhin sa ospital',
    stay_with_worker: 'Samahan siya, huwag iwanang mag-isa',
    midday_break: 'Tanghaliang pahinga: bawal magtrabaho sa araw',
    acclimatization_plan: 'Bago sa init: mas kaunting trabaho muna',
    occ_health_review: 'Magpatingin sa nurse ng klinika',
    check_sensor: 'Tingnan kung gumagana ang sensor',
    symptom_checkin: 'Sagutin ang mga tanong sa kalusugan',
    no_lone_work: 'Huwag magtrabahong mag-isa',
    electrolytes: 'Uminom ng electrolyte drink, hindi salt tablet',
    restrict_fluids: 'Huminto muna sa pag-inom ng tubig. Pumunta sa first aider.',
    medical_evaluation: 'Magpatingin sa doktor ngayong araw',
    no_hot_work_today: 'Wala nang trabaho sa init ngayong araw',
  },
  action_with: {
    rest_shade_now: 'Magpahinga sa lilim nang {min} minuto',
    drink_water: 'Uminom ng {ml} mL ngayon',
    drink_water_every: 'Uminom ng {ml} mL bawat {min} minuto',
    shade_breaks: 'Trabaho {work} minuto, pahinga {rest} minuto',
    midday_break: 'Bawal magtrabaho sa araw mula {from} hanggang {to}',
  },
  symptom: {
    thirst: { self: 'Nauuhaw ka ba nang husto?', buddy: 'Nauuhaw ba nang husto ang iyong kasama?' },
    heat_rash: {
      self: 'May makating pulang pantal ka ba (bungang-araw)?',
      buddy: 'May makating pulang pantal ba ang iyong kasama?',
    },
    cramps: { self: 'May masakit na pulikat ka ba?', buddy: 'May masakit na pulikat ba ang iyong kasama?' },
    cramps_persistent: {
      self: 'Tumagal ba ang pulikat nang 1 oras o higit pa?',
      buddy: 'Tumagal ba ang pulikat ng iyong kasama nang 1 oras o higit pa?',
    },
    headache: { self: 'Masakit ba ang ulo mo?', buddy: 'Masakit ba ang ulo ng iyong kasama?' },
    dizziness: { self: 'Nahihilo ka ba?', buddy: 'Nahihilo ba ang iyong kasama?' },
    nausea: { self: 'Nasusuka ka ba?', buddy: 'Nasusuka ba ang iyong kasama?' },
    weakness_fatigue: { self: 'Sobrang pagod o nanghihina ka ba?', buddy: 'Sobrang pagod o nanghihina ba ang iyong kasama?' },
    fainted: { self: 'Nahimatay ka ba, kahit sandali lang?', buddy: 'Nahimatay ba ang iyong kasama, kahit sandali lang?' },
    brown_urine: {
      self: 'Kulay brown ba ang ihi mo, parang tsaa o cola?',
      buddy: 'Sinasabi ba ng iyong kasama na brown ang kanyang ihi?',
    },
    drank_a_lot: {
      self: 'Uminom ka ba ng higit sa 6 na baso (1.5 L) ng tubig sa nakaraang 1 oras?',
      buddy: 'Uminom ba ang iyong kasama ng higit sa 6 na baso (1.5 L) ng tubig sa nakaraang 1 oras?',
    },
    swollen_hands: { self: 'Namamaga ba ang mga kamay mo?', buddy: 'Namamaga ba ang mga kamay ng iyong kasama?' },
    repeated_vomiting: {
      self: 'Sumuka ka ba nang higit sa isang beses?',
      buddy: 'Sumuka ba ang iyong kasama nang higit sa isang beses?',
    },
    chest_pain: {
      self: 'Masakit ba ang dibdib mo o hirap kang huminga?',
      buddy: 'Masakit ba ang dibdib ng iyong kasama o hirap siyang huminga?',
    },
    confusion: { self: 'Nalilito ka ba?', buddy: 'Nalilito ba ang iyong kasama o kakaiba ang kilos niya?' },
    slurred_speech: {
      self: 'Hirap ka bang magsalita nang malinaw?',
      buddy: 'Bulol o hindi malinaw ba ang pagsasalita ng iyong kasama?',
    },
    unsteady_walking: {
      self: 'Pasuray-suray ka ba o hindi makalakad nang tuwid?',
      buddy: 'Pasuray-suray ba ang iyong kasama o hindi makalakad nang tuwid?',
    },
    collapsed_unresponsive: {
      self: 'Bigla ka bang bumagsak at hindi pa rin maayos ang pakiramdam mo?',
      buddy: 'Bumagsak ba ang iyong kasama, o hindi siya sumasagot sa iyo?',
    },
    seizure: { self: 'Nangisay ka ba (kumbulsyon)?', buddy: 'Nangisay ba o nanginig nang husto ang iyong kasama?' },
  },
  checkin: {
    self_intro: 'Sagutin ang bawat tanong: OO o HINDI.',
    buddy_intro: 'Tingnan ang iyong kasama. Sumagot: OO o HINDI.',
    trend_question: 'Kumpara kanina, ano ang pakiramdam mo ngayon?',
    better: 'Mas mabuti',
    same: 'Ganoon pa rin',
    worse: 'Mas malala',
  },
  urine: {
    question: 'Anong kulay ng ihi mo? Pindutin ang pinakamalapit.',
    ok: 'Mabuti. Patuloy na uminom ng tubig.',
    drink_more: 'Uminom pa ng tubig.',
    dark: 'Masyadong madilim ang kulay. Uminom ng tubig ngayon at magpahinga sa lilim.',
  },
  emergency: {
    title: 'Emergency. Kumilos ngayon.',
    call_998: 'Tumawag sa 998 para sa ambulansya.',
    cool_first: 'Palamigin muna. Simulan ang pagpapalamig bago dalhin sa ospital.',
    shade: 'Dalhin siya sa lilim. Alisin ang sobrang damit.',
    immerse: 'Pinakamainam: ilubog ang katawan sa malamig o yelong tubig hanggang leeg, sa tub o trapal. Haluin ang tubig.',
    douse: 'Walang tub? Patuloy siyang buhusan ng malamig na tubig at paypayan.',
    towels: 'O lagyan ng tuwalyang binabad sa yelong tubig, palitan bawat 1–2 minuto, at gumamit ng ice pack.',
    keep_cooling:
      'Ituloy ang pagpapalamig hanggang dumating ang ambulansya. Iahon siya sa yelong tubig pagkalipas ng mga 15 minuto, o mas maaga kung bumalik na siya sa normal.',
    stay: 'Samahan siya. Huwag siyang iwanang mag-isa.',
    fluids: 'Painumin lang kung lubos siyang gising at alerto.',
  },
  ui: {
    status: 'Aking kalagayan',
    next_break: 'Susunod na break sa {min} minuto',
    break_now: 'Oras ng break. Pumunta sa lilim.',
    drank_water: 'Uminom ako ng tubig',
    feel_unwell: 'Masama ang pakiramdam ko',
    im_ok: 'Okay lang ako',
    checkin: 'Kumustahan',
    yes: 'OO',
    no: 'HINDI',
    privacy: 'Privacy',
    what_i_share: 'Ano ang ibinabahagi ko',
    who_saw: 'Sino ang nakakita ng data ko',
    offline: 'Offline mode',
    offline_note: 'Walang network. Gumagana pa rin ang mga babala sa teleponong ito.',
    battery_saver: 'Tipid-baterya',
    language: 'Wika',
    acknowledge: 'Sige, naiintindihan ko',
    help_coming: 'Paparating na ang tulong.',
    buddy: 'Aking kasama',
    buddy_alert: 'Maaaring kailangan ni {name} ng tulong. Puntahan at tingnan ngayon.',
    get_help: 'Humingi ng tulong',
    slow_down_drinking: 'Dahan-dahan. Marami ka nang nainom na tubig ngayong oras.',
    listen: 'Pakinggan',
    data_stays: 'Nananatili sa teleponong ito ang iyong health data.',
    flags_private: 'Ikaw lang ang nakakakita nito. Nasa telepono mo lang ito.',
    strain_estimate: 'Tantiya ng hirap ng katawan sa init',
    not_medical: 'Gabay sa kaligtasan ito, hindi medical test.',
    translation_draft: 'Draft na salin. Hindi pa nasusuri.',
  },
  consent: {
    wearable: {
      title: 'Tibok ng puso mula sa aking band',
      statement:
        'Maaaring basahin ng Zill sa teleponong ito ang tibok ng puso mula sa aking band para tantiyahin ang hirap ng katawan ko sa init. Isa itong tantiya para tulungan akong manatiling ligtas, hindi medikal na sukat o diyagnosis. Hindi ito kailanman nakikita ng aking supervisor.',
    },
    healthFlags: {
      title: 'Mga bagay sa kalusugan na nagpapadelikado sa init para sa akin',
      statement:
        'Maaaring gamitin ng Zill ang aking mga sagot na oo/hindi (halimbawa, kamakailang sakit, o gamot na nakaaapekto sa pagtitiis sa init) para gawing mas mahigpit ang aking mga babala. Nananatili sa teleponong ito ang aking mga sagot at hindi kailanman ipinapakita sa aking supervisor o employer.',
    },
    checkins: {
      title: 'Mga tanong tungkol sa sintomas at pag-inom ng tubig',
      statement:
        'Maaaring itanong ng Zill kung ano ang pakiramdam ko at ang kulay ng aking ihi. Nananatili sa teleponong ito ang aking mga sagot. Kapag in-escalate ang kaso ko, makikita ng first aider ang mga sintomas na iniulat ko para matulungan niya ako.',
    },
    shareWithMedicOnEscalation: {
      title: 'Ibahagi sa occupational health kapag in-escalate ang kaso ko',
      statement:
        'Kapag in-escalate ang kaso ko, maaaring makita ng occupational health nurse ang mga tantiya ng tibok ng puso ko, mga bagay sa kalusugan, at mga sagot sa tanong para alagaan ako. Walang ibang nakakakita sa mga ito, at hindi kailanman gagamitin ang mga ito laban sa akin.',
    },
    aggregateStatistics: {
      title: 'Isama ako sa anonymous na estadistika',
      statement:
        'Maaaring maisama ang data ko sa estadistika ng pampublikong kalusugan tungkol sa init sa trabaho. Itinatago ang mga grupong may mas kaunti sa 10 tao para hindi ako makilala.',
    },
  },
  consent_info: {
    intro: 'Piliin kung ano ang puwedeng gamitin ng Zill. Hiwalay ang bawat pili.',
    voluntary: 'Okay lang tumanggi. Makakatanggap ka pa rin ng lahat ng safety alert.',
    change_anytime: 'Puwede mong baguhin ang pili mo anumang oras.',
  },
  privacy_notice: {
    title: 'Paano ka binibilang sa kabuuang bilang ng grupo',
    statement:
      'May legal na tungkulin ang iyong employer na panatilihing ligtas ang trabaho sa init. Dahil dito, binibilang ng Zill ang bawat manggagawa sa kabuuang bilang ng grupo, kahit hindi mo pinili ang “Isama ako sa anonymous na estadistika”. Ang safety (HSE) manager ng site ay nakakakita lang ng mga grupong may 5 o higit pang manggagawa. Ang regulator at ang HR ng iyong employer ay nakakakita lang ng mga grupong may 10 o higit pang manggagawa. Itinatago ang mas maliliit na grupo, at hindi kailanman ipinapakita ng mga bilang ang pangalan mo o anumang rekord tungkol sa iyo lamang. Ang pinili mo tungkol sa anonymous na estadistika ay nagpapasya lamang kung bibilangin ka rin sa estadistika ng pampublikong kalusugan.',
  },
  flag: {
    prior_heat_illness: {
      name: 'Nagkasakit sa init dati',
      explain: 'Nagkasakit ka na dahil sa init dati. Mas maagang babala at mas maraming pahinga ang ibibigay ng Zill.',
    },
    heat_sensitive_medication: {
      name: 'Gamot na nagpapahirap sa init',
      explain: 'Ang ilang gamot ay nagpapahirap sa katawan sa init. Mas maagang babala at mas maraming pahinga ang ibibigay ng Zill.',
    },
    hr_suppressing_medication: {
      name: 'Gamot o device na nagpapabagal ng puso',
      explain: 'Maaaring hindi makita sa tibok ng puso mo ang hirap sa init. Hindi gagamitin ng Zill ang tibok ng puso mo, at mas maaga itong magbababala.',
    },
    recent_illness: {
      name: 'Nagkasakit kamakailan',
      explain: 'Ang sakit kamakailan ay nagpapahirap sa katawan sa init. Mas maagang babala at mas maraming pahinga ang ibibigay ng Zill.',
    },
    poor_sleep: {
      name: 'Kulang sa tulog',
      explain: 'Ang kulang na tulog ay nagpapahirap sa katawan sa init. Mas maagang babala at mas maraming pahinga ang ibibigay ng Zill.',
    },
    fasting: {
      name: 'Nag-aayuno',
      explain: 'Hindi ka paaalalahanang uminom ng Zill sa oras ng ayuno. Mas maagang babala at mas maraming pahinga ang ibibigay nito.',
    },
    heat_rash_sunburn: {
      name: 'Bungang-araw o sunog sa araw',
      explain: 'Hindi makapagpawis nang maayos ang balat na may bungang-araw o sunog sa araw. Mas maagang babala at mas maraming pahinga ang ibibigay ng Zill.',
    },
    oh_review_required: {
      name: 'Kailangan ng check ng nurse',
      explain: 'Kakausapin ka nang pribado ng nurse ng klinika tungkol sa ligtas na trabaho sa init.',
    },
  },
  driver: driverTexts({
    heat_over_limit: 'Lampas sa ligtas na limitasyon ang init para sa trabahong ito.',
    heat_near_limit: 'Malapit na sa ligtas na limitasyon ang init para sa trabahong ito.',
    heat_within_limit: 'Pasok sa ligtas na limitasyon ang init para sa trabahong ito.',
    work_rest: 'Sundin ang oras ng trabaho at pahinga bawat oras.',
    clothing: 'Kumukulong ng init ang damit mo sa trabaho, kaya mas mababa ang limitasyon.',
    not_used_limit: 'Hindi ka pa sanay sa init, kaya mas mababa ang limitasyon mo.',
    lower_limit: 'Mas mababa ang limitasyon mo ngayon para sa iyong kaligtasan.',
    stricter_rest: 'May dagdag kang pahinga ngayon para sa iyong kaligtasan.',
    heat_time_left: 'Limitado ang oras mo sa mainit na trabaho habang nasasanay ka sa init.',
    heat_time_used: 'Ubos na ang oras mo sa mainit na trabaho ngayong araw.',
    suit: 'Saradong pamprotektang damit: tantiya lang ang mga limitasyon sa init.',
    less_certain: 'Hindi gaanong tiyak ang tantiya ng init dito.',
    time_to_limit: 'Sa bilis na ito ng trabaho, nauubos na ang ligtas mong oras sa init.',
    limit_reached: 'Naabot na ang ligtas mong limitasyon sa init para sa shift na ito. Magpahinga sa malamig na lugar.',
    no_limit_soon: 'Walang malapit na limitasyon sa init sa bilis na ito ng trabaho.',
    limit_stays: 'Hindi nare-reset ng pahinga lang ang limitasyon mo sa init ngayong araw.',
    fasting_limit: 'Nag-aayuno: hindi ka umiinom, kaya mas mababa ang limitasyon mo.',
    level_stays: 'Mananatili ang babalang ito hanggang payagan ka ng first aider o supervisor.',
    no_hot_work: 'Wala ka nang mainit na trabaho ngayong araw.',
    level_held: 'Nananatiling mataas ang level nang kaunti pang oras pagkatapos humupa ang init.',
    safe_default: 'May kulang o maling data, kaya gumagamit ang Zill ng ligtas na mga value.',
    checkin_due: 'Oras na para sa iyong kumustahan.',
    buddy: 'Magtrabaho kasama ang isang buddy ngayong araw.',
    no_lone_work: 'Huwag magtrabahong mag-isa sa init na ito.',
    fasting_reminders: 'Nag-aayuno: walang paalala sa pag-inom. Magpahinga sa lilim at magpalamig.',
    water_stop: 'Itigil ang pag-inom ng plain na tubig hanggang masuri ka ng first aider.',
    check_sensor: 'Kailangang suriin ang heat sensor ng site.',
    extreme_heat: 'Matinding init at halumigmig: ipinapayong itigil ang trabaho.',
    hot_surfaces: 'Nagdaragdag ng init ang maiinit na surface dito. Kasama na ito sa bilang.',
    site_sensor: 'Sukat ng init mula sa sensor ng site.',
    zone_high: 'Heat zone Mataas: mahigpit na oras ng trabaho at pahinga, bawal mag-isa.',
    zone_medium: 'Heat zone Katamtaman: takdang oras ng trabaho at pahinga, bawal mag-isa.',
    zone_low: 'Heat zone Mababa: normal na trabaho na may tubig at break.',
    zone_unknown: 'Hindi alam ang heat zone, kaya ang pinakamahigpit na patakaran ang sinusunod.',
    essential_only: 'Masyadong mainit para sa karaniwang trabaho: mahahalagang gawain lang.',
    permit: 'Kailangan ng heat work permit ang trabahong ito.',
    not_used_reassign: 'Hindi pa sanay sa init: bibigyan ka ng trabaho sa labas ng zone na ito.',
    not_used_not_alone: 'Hindi pa sanay sa init: huwag magtrabahong mag-isa rito.',
    not_used_plan: 'Hindi pa sanay sa init: sundin ang plano mo para masanay.',
    midday: 'Tanghaliang pahinga: walang trabaho sa araw ngayon.',
    midday_other: 'Oras ng tanghaliang pahinga, pero hindi sa araw ang gawaing ito.',
    heat_unknown: 'Walang sukat ng init, kaya hindi masuri ang patakaran sa pagtigil ng trabaho.',
    heat_stop: 'Masyadong mainit: dapat itigil ang trabaho.',
    band_not_used: 'Hindi ginagamit ang band. Batay sa panahon at trabaho ang mga alerto.',
    band_check: 'Kulang o mahina ang data ng band. Tiyaking suot at maayos ang kabit ng band.',
    band_starting: 'Nagsisimula pa ang band (unang 30 minuto). Batay sa panahon at trabaho ang mga alerto.',
    band_odd: 'Kakaibang reading ng band. Titingnan ka ng iyong buddy.',
    strain_very_high: 'Tantiyang napakataas na hirap sa init. Itigil ang trabaho at magpalamig.',
    strain_high: 'Tantiyang mataas na hirap sa init. Magpahinga sa malamig na lugar.',
    strain_rising: 'Tumataas ang tantiya ng hirap sa init. Sagutin ang kumustahan.',
    effort_high: 'Masyado kang nagpakapagod nang matagal. Magpahinga ngayon.',
    age_unknown: 'Walang nakatakdang edad, kaya mas ligtas na limitasyon ang ginagamit.',
    band_ok: 'Band: walang babala.',
    no_checkin: 'Wala pang kumustahan ngayong araw.',
    checkin_ok: 'Kumustahan: walang senyales ng panganib.',
    too_much_water: 'Sobrang tubig na may senyales ng panganib. Tumigil sa pag-inom at magpatingin sa first aider.',
    worse: 'Mas masama ang pakiramdam kaysa dati. Tumawag sa 998 at magsimulang magpalamig ngayon.',
    not_better: 'Hindi bumuti pagkalipas ng 30 minuto. Tumawag sa 998 at ituloy ang pagpapalamig.',
    sx_thirst: 'Nauuhaw ka. Uminom ng tubig ngayon.',
    sx_overdrink: 'Huwag uminom ng sobrang tubig. Sabihan ang first aider kung masama ang pakiramdam mo.',
    sx_t1: 'Sagot sa kumustahan: magpahinga sa lilim at uminom ng tubig.',
    sx_t2: 'Sagot sa kumustahan: itigil ang mainit na trabaho at tawagin agad ang first aider.',
    sx_t3: 'May iniulat na senyales ng panganib. Tumawag sa 998 at magsimulang magpalamig ngayon.',
    colour_ok: 'Tingin sa kulay: maayos. Patuloy na uminom ng tubig.',
    colour_more: 'Tingin sa kulay: uminom pa ng tubig.',
    colour_dark: 'Tingin sa kulay: masyadong madilim. Uminom ng tubig at magpahinga sa lilim.',
    colour_dark_again: 'Masyado pa ring madilim ang kulay. Magpahinga, uminom ng tubig at sabihan ang first aider.',
    colour_very_dark: 'Tingin sa kulay: napakadilim. Magpahinga, magpalamig at uminom ng tubig.',
    too_much_today: 'Napakarami mo nang nainom ngayong araw. Dahan-dahan.',
    slow_down: 'Dahan-dahan. Marami ka nang nainom na tubig ngayong oras.',
    no_weather: 'Walang data ng panahon, kaya itinuturing ng Zill na napakainit ng oras na ito.',
    weather_old: 'Luma na ang data ng panahon, kaya hindi gaanong tiyak.',
    weather_old_margin: 'Napakaluma na ng data ng panahon, kaya nagdagdag ng safety margin.',
    src_forecast: 'Panahon mula sa forecast.',
    src_archive: 'Panahon mula sa mga rekord ng panahon.',
    src_cached: 'Panahon mula sa naka-save na forecast.',
    rest_cooled: 'Sa malamig at may aircon na pahingahan ang mga break.',
    rest_shade_only: 'Lilim lang ang pahingahan dito, kaya kailangan mo ng mas mahabang pahinga.',
    recovery_review: 'Magpahinga ng 30 minuto sa malamig na lugar. Pagkatapos, kailangan kang payagan ng supervisor o first aider.',
    recovery_cleared: 'Pinayagan ka nang bumalik sa trabaho. Patuloy na mag-break.',
    resume_check: 'Magpahinga hanggang sabihin ng heat check na puwede ka nang bumalik sa trabahong ito.',
    task_too_hot: 'Masyadong mainit para bumalik sa gawaing ito ngayon. Lumipat sa mas magaan o mas malamig na trabaho.',
    work_bout: 'Kaunting oras na lang ng trabaho bago ang susunod mong pahinga.',
    drinks_counted: 'Binibilang sa limitasyon mo sa init ang tubig na itinatala mo.',
    drink_to_restart: 'Uminom ng tubig, itala ito, at magpahinga bago ka muling magtrabaho sa init.',
  }),
}

// ─────────────────────────────── Registry ───────────────────────────────

/** The source language. Every other catalog is a translation of it. */
export const SOURCE_LANG: LangCode = 'en'

/**
 * All catalogs by language (launch set, context_and_commercial.md §2.3). Frozen at module load; there is no runtime
 * mutation path, so a worker can never see a half-edited catalog.
 */
export const CATALOGS: Readonly<Record<LangCode, Catalog>> = deepFreeze({
  en: EN,
  ar: AR,
  hi: HI,
  ur: UR,
  ml: ML,
  bn: BN,
  tl: TL,
  ne: NE,
})

function deepFreeze<T extends object>(node: T): Readonly<T> {
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value as object)
  }
  return Object.freeze(node)
}

/** Flattens a catalog into dotted keys ("level.safe.name" → text). Pure; used for lookup and tests. */
export function flattenCatalog(catalog: Catalog): Readonly<Record<MessageKey, string>> {
  const out: Record<string, string> = {}
  const walk = (node: object, prefix: string): void => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') out[prefix + k] = v
      else if (v !== null && typeof v === 'object') walk(v as object, `${prefix}${k}.`)
    }
  }
  walk(catalog, '')
  return out as Record<MessageKey, string>
}

/** Every message key, in source (English) order. */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(Object.keys(flattenCatalog(EN)) as MessageKey[])

/** Every ActionId (types.ts), in catalog order — derived from the compile-time-complete English record. */
export const ACTION_IDS: readonly ActionId[] = Object.freeze(Object.keys(EN.action) as ActionId[])
/** Every SymptomId (types.ts; triage tiers T0→T3 per physio_and_clinical.md §10.7), in catalog order. */
export const SYMPTOM_IDS: readonly SymptomId[] = Object.freeze(Object.keys(EN.symptom) as SymptomId[])
/** Every RiskFlagId (types.ts; physio_and_clinical.md §7, §10.9), in catalog order. */
export const RISK_FLAG_IDS: readonly RiskFlagId[] = Object.freeze(Object.keys(EN.flag) as RiskFlagId[])
/** Every consent scope (ARCHITECTURE §7: all opt-in and revocable), in catalog order. */
export const CONSENT_SCOPES: readonly ConsentScope[] = Object.freeze(Object.keys(EN.consent) as ConsentScope[])
/**
 * Every risk-driver id with a `driver.<id>` text, in catalog order: engine/risk.ts `DRIVER_IDS` plus the ids being added
 * (see {@link DRIVER_PHRASE}); derived from the compile-time-complete English record.
 */
export const DRIVER_TEXT_IDS: readonly DriverTextId[] = Object.freeze(Object.keys(EN.driver) as DriverTextId[])

/**
 * Ordered T3 emergency script: call 998 → cool first → cooling steps (shade and remove clothing; cold/ice-water
 * immersion to the neck in a tub or tarp, water 1–26 °C, stirred; otherwise continuous cold-water dousing + fanning, or
 * ice-water towels rotated every 1–2 min + ice packs; keep cooling until EMS arrives, stop immersion after ≈ 15 min or
 * when symptoms resolve) → stay with them → fluids only if fully alert.
 * Basis: physio_and_clinical.md §10.10 [ILCOR19 "for a reasonable amount of time, such as 15 minutes"][TBMED][IOC21]
 * [OSHA-FA "When in doubt, cool the worker and call 911"][NATA15-ES]; UAE ambulance 998 (u.ae, "Last updated
 * 01 Oct 2026" — re-verify each release).
 */
export const EMERGENCY_SCRIPT: readonly MessageKey[] = Object.freeze([
  'emergency.title',
  'emergency.call_998',
  'emergency.cool_first',
  'emergency.shade',
  'emergency.immerse',
  'emergency.douse',
  'emergency.towels',
  'emergency.keep_cooling',
  'emergency.stay',
  'emergency.fluids',
] as const)

// ─────────────────────────────── Translation review status ───────────────────────────────

/**
 * Pictogram/message comprehension acceptance criterion: ≥ 85 % correct comprehension with < 5 % critical confusions
 * (ANSI Z535.3, as cited by CPSC and VS — physio_and_clinical.md §5.6; locally co-designed pictograms met it 20/23 vs
 * 11/23 for generic ones [DE01]). Test method ISO 9186-1:2014.
 */
export const COMPREHENSION_CRITERION = Object.freeze({
  standard: 'ANSI Z535.3',
  minCorrectPct: 85,
  maxCriticalConfusionPct: 5,
  // UNVERIFIED: ISO 9186-1:2014 is paywalled; its own pass threshold was not verified (physio_and_clinical.md §5.6).
  method: 'ISO 9186-1:2014',
})

/** A step a language must pass before its text may be shown to workers in the field. */
export type ReviewStep =
  | 'native_speaker_review'
  | 'back_translation'
  | 'occupational_health_review'
  | 'comprehension_test'
  | 'authenticated_translation'

/** Review state of one language's catalog. */
export interface TranslationReview {
  /** 'source' = authored English text; 'machine_assisted_draft' = not yet reviewed by a human translator. */
  readonly stage: 'source' | 'machine_assisted_draft'
  /** Steps still outstanding. Empty ⇒ deployable. */
  readonly pending: readonly ReviewStep[]
  /** Points a reviewer should check first. */
  readonly note: string
}

const DRAFT_STEPS: readonly ReviewStep[] = Object.freeze([
  'native_speaker_review',
  'back_translation',
  'occupational_health_review',
  'comprehension_test',
  'authenticated_translation',
] as const)

/**
 * Review status per language. English is the source text (plain language, claims-checked) and still needs
 * occupational-health sign-off and a comprehension test with low-literacy workers. Every other language is a
 * machine-assisted draft that needs native-speaker review, back-translation (§5.6 "translate and back-translate"),
 * occupational-health review, a comprehension test meeting {@link COMPREHENSION_CRITERION}, and — for consent text —
 * an authenticated translation (DoH S70 §3.5.3.2.4: Arabic and English "should have same text"; the worker languages
 * need authenticated translations, context_and_commercial.md §4.6).
 */
export const reviewStatus: Readonly<Record<LangCode, TranslationReview>> = Object.freeze({
  en: {
    stage: 'source',
    pending: Object.freeze(['occupational_health_review', 'comprehension_test'] as const),
    note: 'Source text. Plain words, no prediction/diagnosis claims; 998 and cooling steps per physio_and_clinical.md §10.10.',
  },
  ar: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'MSA, masculine imperative by default; app name ظل also means "shade". Consent must match English word for word (DoH S70 §3.5.3.2.4).',
  },
  hi: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Everyday Hindustani (not Sanskritised); घमौरियाँ for heat rash; ORS added to electrolyte advice.',
  },
  ur: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Needs a Nastaliq font; Urdu letters ی/ک/ہ (not Arabic ي/ك/ه); gender-neutral acknowledgement wording.',
  },
  ml: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Colloquial terms chosen for comprehension: മസിൽ പിടുത്തം (cramp), ഫിറ്റ്സ് (seizure), ചൂടുകുരു (heat rash).',
  },
  bn: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Bangladeshi usage: পানি (not জল), খাবার স্যালাইন for ORS, রোজা for fasting.',
  },
  tl: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Filipino with common Taglish loanwords (first aider, break, sensor); bungang-araw for heat rash.',
  },
  ne: {
    stage: 'machine_assisted_draft',
    pending: DRAFT_STEPS,
    note: 'Polite तपाईं forms; घमौरा for heat rash; Devanagari digits available via the native-digit option.',
  },
})

/** True only when a language has cleared every review step ({@link reviewStatus}). Currently false for all languages. */
export function isDeployable(lang: LangCode): boolean {
  const status = reviewStatus[lang] as TranslationReview | undefined
  return status !== undefined && status.pending.length === 0
}
