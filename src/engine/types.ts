/**
 * Zill shared domain contracts — the single source of truth for names used across engine, data, sim and UI.
 *
 * Units are encoded in property names:
 *   C = °C · Pct = % · Hpa = hPa · Ms = m/s · Wm2 = W/m² · W = watts · Kg = kg · Cm = cm · M = metres
 *   Min = minutes · Ml = millilitres · Bpm = beats/min
 * Timestamps are epoch milliseconds (UTC). Abu Dhabi local time is UTC+4 with no DST (see ./time.ts).
 */

// ─────────────────────────────── Environment ───────────────────────────────

/** Where an environmental value came from, in fail-safe priority order (sensor is best). */
export type EnvSource = 'site_sensor' | 'forecast' | 'archive' | 'cached_forecast' | 'conservative_default'

export interface EnvSample {
  /** Epoch ms. For Open-Meteo hourly data this is the END of the hour over which radiation was averaged. */
  t: number
  taC: number
  rhPct: number
  tdC?: number
  pHpa: number
  /** Wind speed at 10 m. */
  wind10Ms: number
  /** Global horizontal irradiance (Open-Meteo: mean over the preceding hour). */
  ghiWm2: number
  /**
   * Averaging window of the radiation fields, in minutes ending at `t`: 60 for raw Open-Meteo hourly values, 0 for
   * instantaneous values (site sensors, minute-interpolated samples). Solar geometry is evaluated at t − window/2.
   * When absent: 0 for 'site_sensor', otherwise 60.
   */
  radiationWindowMin?: number
  directWm2?: number
  diffuseWm2?: number
  dniWm2?: number
  cloudPct?: number
  source: EnvSource
  /** WBGT measured by an on-site meter (ISO 7243). When present it is used for the exposure channel. */
  measuredWbgtC?: number
  /** Site-specific extra radiant load (hot steel/asphalt/machinery) added to globe temperature, if configured. */
  radiantBoostC?: number
}

export interface HeatIndices {
  t: number
  /** Outdoor WBGT in direct sun (Liljegren 2008), or the measured value when a site meter is present. */
  wbgtC: number
  /** WBGT for a shaded rest area (no direct solar load). */
  wbgtShadeC: number
  /** 2-inch (0.0508 m) black globe temperature. */
  tgC: number
  /** Natural (unaspirated) wet-bulb temperature. */
  tnwbC: number
  /** Psychrometric wet-bulb temperature. */
  tpwbC: number
  /** Mean radiant temperature derived for the PHS model. */
  mrtC: number
  /** Wind speed at 2 m used by the models. */
  wind2Ms: number
  /** Thermal Work Limit, W/m² (Brake & Bates 2002), the index used by Abu Dhabi ADOSH-SF CoP 11.0 v4.0 (2024). */
  twlWm2: number
  /** NWS heat index, °C. */
  heatIndexC: number
  cosZenith: number
  source: EnvSource
}

// ─────────────────────────────── Work context ───────────────────────────────

/** ISO 8996 metabolic rate classes 0–4. */
export type WorkClass = 'rest' | 'light' | 'moderate' | 'heavy' | 'very_heavy'

/**
 * Clothing ensembles with ACGIH clothing adjustment factors (CAF) and PHS insulation values.
 * Exact CAF/clo values live in engine/limits.ts with citations.
 */
export type ClothingId =
  | 'work_clothes'
  | 'cloth_coveralls'
  | 'fr_coveralls'
  | 'double_layer'
  | 'sms_coveralls'
  | 'polyolefin_coveralls'
  | 'vapour_barrier'

export interface Task {
  id: string
  name: string
  workClass: WorkClass
  /** Optional override of the class's representative metabolic rate (W/m²). */
  metabolicWm2?: number
  /** True when performed in direct sun (outdoor WBGT); false = shade/indoor WBGT. */
  inSun: boolean
  /** Task-specific PPE that overrides the worker's default clothing. */
  clothing?: ClothingId
  /** Full head-and-neck hood worn (ACGIH: +1 °C added to WBGT_eff on top of the ensemble CAV). */
  hood?: boolean
  durationMin: number
  /** The planner may move this task to another time window. */
  flexible: boolean
  /** Local "HH:mm" constraints for the planner. */
  earliestStart?: string
  latestEnd?: string
}

export type AcclimatizationStatus = 'acclimatized' | 'acclimatizing' | 'unacclimatized'

/**
 * Self-declared, consented health factors (docs/research/physio_and_clinical.md §7, §10.9). Booleans only, never summed
 * into a score (TB MED 507). Stored on the worker's device only; never projected to supervisors.
 * - any flag except `oh_review_required` switches on conservative mode (stricter limits, ECTemp T1 at 38.0 °C,
 *   30-min check-ins, buddy mandatory);
 * - `hr_suppressing_medication` (beta-blockers, pacemaker…) disables every heart-rate rule (ECTemp, PSI, HR limits);
 * - `oh_review_required` is set by occupational health (e.g. age ≥ 50, obesity, prior heat stroke, cardiac disease,
 *   pregnancy, sickle-cell trait) and prompts a confidential review rather than an automatic rule.
 */
export type RiskFlagId =
  | 'prior_heat_illness'
  | 'heat_sensitive_medication'
  | 'hr_suppressing_medication'
  | 'recent_illness'
  | 'poor_sleep'
  | 'fasting'
  | 'heat_rash_sunburn'
  | 'oh_review_required'

export type LangCode = 'en' | 'ar' | 'hi' | 'ur' | 'ml' | 'bn' | 'tl' | 'ne'

export interface ConsentState {
  /** Heart rate from a paired wearable, processed on device (ECTemp, PSI). */
  wearable: boolean
  /** Self-declared risk factors used on device to personalise thresholds. */
  healthFlags: boolean
  /** Symptom and hydration check-ins. */
  checkins: boolean
  /** Share clinical detail with the occupational-health nurse only when a case is escalated. */
  shareWithMedicOnEscalation: boolean
  /** Contribute to de-identified aggregate statistics (k-suppressed). */
  aggregateStatistics: boolean
  updatedAt: number
}

export interface WorkerProfile {
  /** Pseudonymous identifier, e.g. "W-7F3A". */
  id: string
  /** Name/badge shown to the crew supervisor (operational necessity for safety actions). */
  displayName: string
  crewId: string
  siteId: string
  language: LangCode
  ageYears?: number
  sex?: 'male' | 'female'
  massKg?: number
  heightCm?: number
  /**
   * Days worked in the heat in the current stretch — since arrival, or since returning from an absence of ≥ 4 days.
   * The assessed day counts (1 = first day). See engine/limits.ts `assessAcclimatization`.
   */
  daysOnSite: number
  /**
   * Length in days of the absence from heat exposure that preceded the current stretch (0 = none). Values above 14 are
   * meaningful: ADOSH treats a worker off work for more than 14 days as unacclimatised.
   */
  daysAwayRecent: number
  /** Has completed a previous hot season (NIOSH faster schedule for experienced workers). */
  experiencedInHeat: boolean
  clothing: ClothingId
  /** Only populated when consent.healthFlags is true. */
  riskFlags: RiskFlagId[]
  restingHrBpm?: number
  consent: ConsentState
  hasWearable: boolean
}

// ─────────────────────────────── Physiology (on device) ───────────────────────────────

export interface HrSample {
  t: number
  /** null = no reading (dropout, sensor off-skin, battery). */
  hrBpm: number | null
}

export type SignalQuality = 'good' | 'degraded' | 'unusable' | 'absent'

export interface EctempState {
  /** Estimated core temperature. */
  ctC: number
  /** Kalman variance of the estimate. */
  variance: number
  t: number
}

// ─────────────────────────────── Check-ins ───────────────────────────────

/**
 * Yes/no check-in items (docs/research/physio_and_clinical.md §5.6, triage table §10.7). Tier in brackets:
 * T0 thirst · T1 heat_rash, cramps · T2 cramps_persistent (≥ 60 min), headache, dizziness, nausea, weakness_fatigue,
 * fainted (now alert), brown_urine, drank_a_lot + (headache | nausea | swollen_hands) ·
 * T3 repeated_vomiting, chest_pain, confusion, slurred_speech, unsteady_walking, collapsed_unresponsive, seizure.
 * The last five are typically buddy-observed.
 */
export type SymptomId =
  | 'thirst'
  | 'heat_rash'
  | 'cramps'
  | 'cramps_persistent'
  | 'headache'
  | 'dizziness'
  | 'nausea'
  | 'weakness_fatigue'
  | 'fainted'
  | 'brown_urine'
  | 'drank_a_lot'
  | 'swollen_hands'
  | 'repeated_vomiting'
  | 'chest_pain'
  | 'confusion'
  | 'slurred_speech'
  | 'unsteady_walking'
  | 'collapsed_unresponsive'
  | 'seizure'

export interface Checkin {
  id?: string
  t: number
  workerId: string
  by: 'self' | 'buddy' | 'supervisor' | 'first_aider'
  symptoms: SymptomId[]
  /** Armstrong 8-shade urine colour scale, 1 (pale) – 8 (dark). Brown/red/cola urine is the 'brown_urine' symptom. */
  urineColor?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  /** Follow-up check-ins (+15/+30 min) report whether the worker is improving. */
  followUpOf?: string
  trend?: 'better' | 'same' | 'worse'
}

/** A logged drink ("I drank water"), used for hourly/daily fluid caps and hydration reminders. */
export interface FluidIntake {
  t: number
  workerId: string
  ml: number
}

/** Clinical escalation tiers shared by the physiology and symptom rules (physio_and_clinical.md §10.5–10.7). */
export type ClinicalTier = 0 | 1 | 2 | 3

/**
 * Tier → Zill level. T1 = act now (rest in shade, water, check-in) · T2 = stop work, first aider now, no more hot work
 * today · T3 = emergency (call 998, cool first). Physiology alone never produces T3.
 */
export const TIER_TO_LEVEL: Record<ClinicalTier, RiskLevel> = { 0: 'safe', 1: 'high', 2: 'stop', 3: 'emergency' }

// ─────────────────────────────── Risk ───────────────────────────────

export type RiskLevel = 'safe' | 'caution' | 'high' | 'stop' | 'emergency'

export const RISK_LEVELS: readonly RiskLevel[] = ['safe', 'caution', 'high', 'stop', 'emergency'] as const

export const RISK_ORDER: Record<RiskLevel, number> = { safe: 0, caution: 1, high: 2, stop: 3, emergency: 4 }

export function maxLevel(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), 'safe')
}

export type ChannelId = 'environment' | 'regulation' | 'projection' | 'physiology' | 'symptoms' | 'hydration'

export interface RiskDriver {
  /** Stable id, e.g. 'wbgt_over_rel', 'unacclimatized', 'clothing_adjustment', 'ct_est_high'. */
  id: string
  channel: ChannelId
  /** English explanation; the UI may localise via id. Must be non-clinical when channel ∉ {physiology, symptoms, hydration}. */
  text: string
  value?: number
  unit?: string
  direction: 'raises' | 'lowers' | 'info'
  /** Standard or source backing the rule, e.g. 'NIOSH 2016 REL', 'ADOSH-SF CoP 11.0 v4.0 Table 1', 'ISO 7933:2023'. */
  basis: string
}

export interface ChannelResult {
  channel: ChannelId
  level: RiskLevel
  /** False when inputs were absent/unusable/not consented — never treated as reassurance. */
  available: boolean
  drivers: RiskDriver[]
}

export type ActionId =
  | 'drink_water'
  | 'shade_breaks'
  | 'reduce_intensity'
  | 'rotate_task'
  | 'rest_shade_now'
  | 'cool_down'
  | 'stop_work'
  | 'buddy_check'
  | 'first_aider_check'
  | 'call_998'
  | 'cool_first'
  | 'stay_with_worker'
  | 'midday_break'
  | 'acclimatization_plan'
  | 'occ_health_review'
  | 'check_sensor'
  | 'symptom_checkin'
  | 'no_lone_work'
  | 'electrolytes'
  | 'restrict_fluids'
  | 'medical_evaluation'
  | 'no_hot_work_today'

export interface DataQuality {
  env: EnvSource
  physiology: SignalQuality
  network: 'online' | 'offline'
  /** True when the environmental input is older than the freshness threshold. */
  stale: boolean
}

export interface RiskAssessment {
  workerId: string
  t: number
  level: RiskLevel
  channels: ChannelResult[]
  /** Most important drivers first. */
  drivers: RiskDriver[]
  /** Ordered recommended actions. */
  actions: ActionId[]
  /** Allowed work minutes per hour for the current task (NIOSH/ACGIH time-weighted average + TWL zone), 0–60. */
  workMinPerHour: number
  /** Predicted minutes until an ISO 7933 limit at the current activity; null when beyond the projection horizon. */
  minutesToLimit: number | null
  /** Recommended drinking volume (mL/h), capped to prevent hyponatraemia. */
  waterMlPerHour: number
  confidence: 'high' | 'medium' | 'low'
  dataQuality: DataQuality
}

// ─────────────────────────────── Alerts ───────────────────────────────

/**
 * What an alert is about. Privacy-safe: it never says which personal channel is involved.
 * - 'exposure': shared conditions only. These are site heat and the task, clothing and regulation rules (the
 *   environment and regulation channels). The same alert would apply to anyone doing that work there.
 * - 'individual': the worker's own heat-strain projection or personal channels (projection, physiology, symptoms,
 *   hydration), a clinical latch, or an ISO 7933 recovery review.
 * Basis: engine/alerts.ts (classification, sticky-individual rule); ARCHITECTURE.md §6.
 */
export type AlertBasis = 'exposure' | 'individual'

export interface Alert {
  id: string
  t: number
  siteId: string
  crewId?: string
  /** Undefined for crew- or site-scoped alerts. */
  workerId?: string
  /** Members covered by a crew- or site-scoped alert (pseudonymous ids). */
  memberIds?: string[]
  scope: 'worker' | 'crew' | 'site'
  level: RiskLevel
  actions: ActionId[]
  /** Short, non-clinical reason that is safe to show a supervisor. */
  reason: string
  /**
   * See {@link AlertBasis}. Crew alerts are always 'exposure'. Absent only on alerts from producers older than this
   * field: treat a missing basis as 'individual' (protective presentation).
   */
  basis?: AlertBasis
  status: 'active' | 'acknowledged' | 'escalated' | 'resolved'
  /** The first acknowledgement that counted (for an emergency, a responder's). */
  ack?: { role: Role; t: number }
  /** Every acknowledgement in order, counted or not. Role and time only. Kept through status changes and resolution. */
  acks?: Array<{ role: Role; t: number }>
  escalatedTo?: Role[]
  /**
   * When the alert was first escalated. That is the stop-acknowledgement timeout, an emergency, or routing to the first
   * aider or occupational health. Durable: it is kept when the status goes back from 'escalated' to 'acknowledged' and
   * after resolution. A first-aider hand-over without engine routing shows in `acks`, not here.
   */
  escalatedAt?: number
  resolvedAt?: number
}

// ─────────────────────────────── Governance ───────────────────────────────

export type Role =
  | 'worker'
  | 'buddy'
  | 'supervisor'
  | 'first_aider'
  | 'occ_health'
  | 'hse_manager'
  | 'regulator'
  | 'employer_hr'

export type Purpose =
  | 'safety_alerting'
  | 'clinical_care'
  | 'operational_planning'
  | 'compliance_reporting'
  | 'public_health_statistics'
  | 'performance_management'
  | 'disciplinary_action'
  | 'insurance_underwriting'
  | 'immigration_or_visa'

/** Purposes for which individual heat-health data may never be used, regardless of role or consent. */
export const PROHIBITED_PURPOSES: readonly Purpose[] = [
  'performance_management',
  'disciplinary_action',
  'insurance_underwriting',
  'immigration_or_visa',
] as const

export type DataField =
  | 'displayName'
  | 'crewId'
  | 'level'
  | 'actions'
  | 'workMinPerHour'
  | 'ackStatus'
  | 'minutesToLimit'
  | 'waterMlPerHour'
  | 'drivers_nonclinical'
  | 'drivers_clinical'
  | 'hrBpm'
  | 'ctEstC'
  | 'psi'
  | 'riskFlags'
  | 'symptoms'
  | 'urineColor'
  | 'ageYears'
  | 'location'

export interface AuditEntry {
  seq: number
  t: number
  actorRole: Role
  actorId: string
  purpose: Purpose
  subjectId?: string
  fields: DataField[]
  decision: 'allowed' | 'denied'
  reason: string
  prevHash: string
  hash: string
}

// ─────────────────────────────── Sites & crews ───────────────────────────────

export interface Site {
  id: 'musaffah' | 'kezad' | 'ruwais' | 'alain' | 'saadiyat'
  name: string
  nameAr: string
  lat: number
  lon: number
  kind: 'industrial' | 'port' | 'construction' | 'inland'
  coastal: boolean
  /** Extra radiant load from the work surface (hot steel, asphalt), °C added to globe temperature. */
  radiantBoostC: number
  hasWbgtMeter: boolean
  /**
   * Where workers rest. ADOSH-SF CoP 11.0 v4.0 §3.2(c) lists "cooled and air-conditioned rest areas" as an engineering
   * control, and §3.2(b)(vii) requires cooled shelter during the midday break. 'cooled_cabin' = air-conditioned rest
   * area (rest WBGT from engine/risk.ts COOLED_REST); 'shade' = open shade canopy only (rest WBGT = modelled shade WBGT).
   */
  restArea: 'cooled_cabin' | 'shade'
}

export interface Crew {
  id: string
  siteId: Site['id']
  name: string
  supervisorName: string
  workerIds: string[]
  tasks: Task[]
}
