/**
 * Zill alert policy engine — ARCHITECTURE.md §6 (alert policy) on top of §5 (risk fusion).
 *
 * Pure and serialisable: every function takes an {@link AlertEngineState} and returns a new one. The input is never
 * mutated. Updates are copy-on-write: a call copies only the alert records and worker tracks it changes and shares the
 * rest with the input. There are no timers, clocks or randomness; the caller passes `now`. The engine turns per-worker
 * {@link RiskAssessment}s into {@link Alert}s and role-addressed {@link Notification}s:
 *
 * - every alert carries a privacy-safe basis ({@link AlertBasis}). 'exposure' means only shared site conditions and
 *   task, clothing or regulation rules drive it (environment and regulation channels). Its reason names the site or
 *   crew condition, never the person. 'individual' means the worker's projection or personal channels, a clinical
 *   latch or an ISO 7933 recovery review drive it. The basis never changes routing;
 * - escalation is recorded durably on the alert (`escalatedAt`, `acks`), so it stays visible after the status
 *   changes;
 * - escalate immediately; de-escalate (auto-resolve) exposure alerts only after the worker's level has stayed below the
 *   alert level for a dwell period; symptom/physiology-driven alerts latch until a first aider, supervisor or
 *   occupational-health nurse resolves them (ARCHITECTURE §1.4, §6);
 * - the worker is always notified on their own device; supervisor at ≥ high (crew-bundled when the environment or
 *   regulation channel drives several crew members to the same level) and on every stop/emergency; buddy when a stop
 *   is not acknowledged and on every emergency; first aider on symptom/physiology-driven stops and every emergency;
 *   occupational health on every emergency;
 * - repeat suppression: the same worker is not told the same level + actions again within 20 min unless the level
 *   escalates;
 * - designed suppression (ANSI/ISA-18.2-2016: an alarm must call for a new operator action): an exposure alert at
 *   caution or high whose required action the active day plan already enforces, or that is only the WBGT screen in
 *   monitored mode, is recorded with `suppression` (one pooled reason, 'action_in_force': the monitored-mode cause
 *   would reveal wearable consent; the cause stays in AlertRecord.suppressionCause) and notified to nobody, with no
 *   acknowledgement timer; the worker's device still shows the guidance. It is lifted, and notified at once, when the
 *   alert gains an individual basis or the condition ends; an escalation to stop raises a new, notified alert. Stop and
 *   emergency, individual, symptom, physiology, hydration and first-aid alerts are never suppressed;
 * - acknowledgement timers (via {@link tick}): stop unacknowledged → supervisor + buddy; emergency unacknowledged →
 *   re-notify + siren; high unacknowledged → supervisor reminder.
 *
 * Privacy (ARCHITECTURE §1.5, §7): alerts and notifications carry level + actions + a short NON-clinical reason only.
 * Reasons are built exclusively from drivers whose channel ∉ {physiology, symptoms, hydration}, through their
 * supervisor view (privacy.ts supervisorDriver: the generic `driver.<id>` phrase or a pooled phrase, site numbers only,
 * never an individual number), and a defensive text filter drops any driver that still looks clinical, reveals
 * conservative mode or names fasting or the wearable consent state ({@link supervisorSafeText}). Supervisors and
 * buddies get the console actions (privacy.ts supervisorActions: no device-only prompt). Clinical detail reaches
 * occupational health only through `privacy.project` after a consented escalation, never through this module.
 */

import type { ActionId, Alert, AlertBasis, AlertSuppression, ChannelId, RiskAssessment, RiskDriver, RiskLevel, Role } from './types'
import { RISK_LEVELS, RISK_ORDER } from './types'
import { MINUTE_MS } from './time'
import { CONFIDENTIAL_ACTIONS, POOLED_DRIVER_IDS, supervisorActions, supervisorDriver } from './privacy'

// ─────────────────────────────── Policy constants ───────────────────────────────

/**
 * Lowest level that raises an alert. `caution` reaches only the worker's own device (ARCHITECTURE §6: "the worker is
 * always notified on their device"); `safe` never alerts. [ENG]
 */
export const ALERT_MIN_LEVEL: RiskLevel = 'caution'

/**
 * Lowest level at which the crew supervisor is notified (ARCHITECTURE §2 crew board; task brief "supervisor at ≥ high").
 * Every stop and emergency therefore reaches the supervisor. [ENG]
 */
export const SUPERVISOR_MIN_LEVEL: RiskLevel = 'high'

/** Repeat suppression window, minutes: same worker + level + actions not repeated within it (ARCHITECTURE §6). */
export const REPEAT_SUPPRESSION_MIN = 20

/**
 * Crew bundling threshold [ENG]: at least 3 workers of one crew at the same level, driven only by the environment or
 * regulation channels, become one crew alert (ARCHITECTURE §6 "several workers … one crew alert"). Three is the smallest
 * group for which one message is clearly better than separate ones; two individual alerts remain readable.
 */
export const CREW_BUNDLE_MIN_WORKERS = 3

/**
 * Crew bundling window [ENG], minutes: individual alerts raised within 5 min of each other count towards one bundle.
 * Shared site conditions move a crew across a threshold within one or two assessment cycles (1-min steps).
 */
export const CREW_BUNDLE_WINDOW_MIN = 5

/** A stop not acknowledged within 2 min escalates to the supervisor and the buddy (ARCHITECTURE §6). */
export const STOP_ACK_TIMEOUT_MIN = 2

/**
 * An emergency not acknowledged by a responder within 1 min is re-notified (voice) and the siren sounds [ENG, protective:
 * cooling should start within minutes — "cool first, transport second", ACSM 2023; physio_and_clinical.md §10.10].
 */
export const EMERGENCY_ACK_TIMEOUT_MIN = 1

/**
 * Repeat interval [ENG], minutes, for further re-notifications while an emergency stays unacknowledged (bounded so a
 * shadow-mode simulation that never acknowledges does not flood the log).
 */
export const EMERGENCY_REPEAT_MIN = 5

/** A high alert not acknowledged within 10 min sends the supervisor a reminder [ENG] (task brief). */
export const HIGH_ACK_TIMEOUT_MIN = 10

/**
 * De-escalation dwell, minutes: an environment/regulation/projection alert auto-resolves only after the worker's
 * assessed level has stayed below the alert level this long (ARCHITECTURE §6 "10 minutes below the threshold").
 * Note: risk.ts already holds the displayed level for its own 10-min dwell; pass `deescalationDwellMin: 0` when a
 * single dwell is wanted (see the module's integration notes).
 */
export const DEESCALATION_DWELL_MIN = 10

/**
 * Resolution hold [ENG], minutes: after a latched (symptom/physiology) alert is resolved, risk.ts keeps the level latched
 * until a symptom-free re-check; during that interval the case is not re-paged at the same level. If no re-check clears
 * the latch within 30 min the case is paged again — the T2 "not improving at 30 min" step of physio_and_clinical.md
 * §10.7 (clinical.ts TRIAGE_TIMING.NOT_IMPROVING_MIN).
 */
export const CLINICAL_RESOLUTION_HOLD_MIN = 30

/** Closed alerts are kept in the engine state this long, minutes, for late acknowledgements [ENG]. */
export const CLOSED_ALERT_RETENTION_MIN = 60

/** Maximum suppression-log entries kept in the state (oldest dropped first) [ENG]. */
export const SUPPRESSION_LOG_MAX = 10_000

/** Channels whose drivers may carry clinical text (types.ts RiskDriver contract); never used for reasons. */
export const CLINICAL_CHANNELS: readonly ChannelId[] = ['physiology', 'symptoms', 'hydration']

/** Channels whose alerts latch until resolved by a first aider, supervisor or occ-health nurse (ARCHITECTURE §1.4). */
export const LATCHING_CHANNELS: readonly ChannelId[] = ['symptoms', 'physiology']

/**
 * Channels of shared conditions: site heat and the task, clothing and regulation rules. An alert driven only by these
 * has basis 'exposure' (ARCHITECTURE §6 "several workers … one crew alert"; task brief wave 2c).
 */
export const EXPOSURE_CHANNELS: readonly ChannelId[] = ['environment', 'regulation']

/** Channels about the individual worker (basis 'individual'): the PHS projection and the personal channels. */
export const INDIVIDUAL_CHANNELS: readonly ChannelId[] = ['projection', 'physiology', 'symptoms', 'hydration']

/**
 * Driver ids that make an alert 'individual' on whichever channel carries them [ENG, defensive]. They are the clinical
 * latch and its no-hot-work consequence, the ISO 7933 recovery review after a reached limit (risk.ts), and the
 * worker's own acclimatisation allowance used up (wave 2d: a personal budget, not a shared site condition, so it is
 * never framed as "Site heat"; its reason is the pooled "not cleared" phrase). risk.ts puts the first four on
 * individual channels today; the list keeps the basis right if a producer ever moves them to an exposure channel.
 */
export const INDIVIDUAL_DRIVER_IDS: readonly string[] = ['clinical_latch', 'no_hot_work_today', 'phs_limit_reached', 'phs_recovery_review_required', 'acclimatization_budget_exhausted']

/** Channels that may be crew-bundled: shared conditions, not individual state (ARCHITECTURE §6). Same as {@link EXPOSURE_CHANNELS}. */
export const BUNDLE_CHANNELS: readonly ChannelId[] = EXPOSURE_CHANNELS

/**
 * Routing to these roles counts as an escalation of the case and sets `Alert.escalatedAt`. They are the clinical
 * responders, paged on symptom- or physiology-driven stops and on every emergency (ARCHITECTURE §6). privacy.ts
 * ProjectionContext.escalated relies on this marker.
 */
export const ESCALATION_ROUTING_ROLES: readonly Role[] = ['first_aider', 'occ_health']

/** Who may resolve a latched (symptom/physiology) alert (ARCHITECTURE §1.4: first aider or supervisor; task brief adds occ_health). */
export const CLINICAL_RESOLVER_ROLES: readonly Role[] = ['first_aider', 'supervisor', 'occ_health']

/**
 * Who may resolve an exposure alert by hand [ENG]. The worker cannot: no one is talked out of a rest break
 * (ARCHITECTURE §1.3); exposure alerts otherwise auto-resolve after the dwell.
 */
export const EXPOSURE_RESOLVER_ROLES: readonly Role[] = ['supervisor', 'first_aider', 'occ_health', 'hse_manager']

/** Who may acknowledge or resolve a crew alert [ENG]. */
export const CREW_ROLES: readonly Role[] = ['supervisor', 'hse_manager']

/** Roles that may acknowledge a worker alert [ENG]. Management, regulator and HR roles never handle individual alerts. */
export const ACK_ROLES: readonly Role[] = ['worker', 'buddy', 'supervisor', 'first_aider', 'occ_health']

/**
 * Roles whose acknowledgement stops the emergency re-notification [ENG, protective]: a worker in an emergency may be
 * unable to respond, so only a responder's acknowledgement counts.
 */
export const EMERGENCY_RESPONDER_ROLES: readonly Role[] = ['buddy', 'supervisor', 'first_aider', 'occ_health']

/**
 * Defensive filter for reason text [ENG, privacy]: driver texts or ids matching this pattern are never used in an alert
 * reason or a notification, even when the driver's channel is non-clinical (defence in depth for the types.ts contract;
 * also hides conservative "extra-care" mode, which can stem from a declared health flag — ARCHITECTURE §2: supervisors
 * never see risk flags).
 */
export const CLINICAL_TEXT_PATTERN =
  /\b(heart|pulse|bpm|hr\s*\d|core\s*temp|body\s*temp|skin\s*temp|rectal|ectemp|psi\b|physiolog|strain index|symptom|dizz|headache|nause|vomit|faint|collaps|seizure|convuls|confus|slurred|unsteady|chest|cramp|urine|dehydrat|hyponatr|medicat|medicine|beta[-\s]?block|pacemaker|pregnan|diagnos|heat\s*stroke|illness|sick|rash|blood|unconscious|unrespons|swollen|vital|extra[-\s]?care|conservative|risk flag|health flag)/i

/**
 * Second defensive filter for supervisor-facing text [ENG, privacy]: words that name a private factor the clinical
 * pattern does not cover: fasting (a religious practice and a risk flag) and the wearable consent state. A driver whose
 * text or supervisor phrase matches is never used in an alert reason, and state/selectors.ts replaces a console text
 * that matches. Worker-device texts may use these words (they are the worker's own data). Kept apart from
 * {@link CLINICAL_TEXT_PATTERN}, whose contract (driver phrases safe on a supervisor screen) other modules test.
 * Basis: wave 2d principle 4 (no inference of clinical, fasting or consent status); GOVERNANCE §13 item 18.
 */
export const PRIVATE_FACTOR_TEXT_PATTERN = /\b(fasting|ramadan|iftar|suhoor|sehri|consent\w*|wearable|wristband)\b/i

/** True when a text may be shown on a supervisor-facing surface: neither pattern matches. Pure. */
export function supervisorSafeText(text: string): boolean {
  return !CLINICAL_TEXT_PATTERN.test(text) && !PRIVATE_FACTOR_TEXT_PATTERN.test(text)
}

/**
 * Highest level designed suppression may apply to (ANSI/ISA-18.2-2016 designed suppression; wave 2d principle 5).
 * Stop and emergency always call for an operator action and are never suppressed.
 */
export const DESIGNED_SUPPRESSION_MAX_LEVEL: RiskLevel = 'high'

/**
 * Drivers showing that the active day plan already sets this worker's work/rest: engine/risk.ts `work_rest_planned`,
 * emitted only when the plan's cap binds (it is at least as strict as the live exposure limit), i.e. the engine's
 * `detail.plannedCapApplied`.
 */
export const PLAN_IN_FORCE_DRIVER_IDS: readonly string[] = ['work_rest_planned']

/**
 * Drivers showing monitored mode, where the WBGT tables are only a screen and the worker's own ISO 7933 projection and
 * physiological limits enforce (engine/risk.ts `wbgt_screen_monitored`; ISO 7243:2017, ACGIH TLV, NIOSH 2016).
 */
export const MONITORED_SCREEN_DRIVER_IDS: readonly string[] = ['wbgt_screen_monitored']

/**
 * Console actions an active plan already puts in force [ENG]: the work/rest cycle, task rotation and the work pace
 * (planner.ts plans work/rest, rotation and water by hour; drink reminders are device-only, privacy.ts
 * DEVICE_ONLY_ACTIONS). An exposure alert whose console actions include anything else (no lone work, a sensor check,
 * the acclimatisation plan …) asks for a new operator action and is never suppressed (protective).
 */
export const PLAN_COVERED_ACTIONS: readonly ActionId[] = ['shade_breaks', 'rotate_task', 'reduce_intensity']

/**
 * What put an alert under designed suppression, kept in the engine's own state only ({@link AlertRecord.suppressionCause};
 * the published alert carries the pooled 'action_in_force', see types.ts AlertSuppressionReason):
 * - 'plan_in_force': the active day plan already sets the work/rest ({@link PLAN_IN_FORCE_DRIVER_IDS});
 * - 'monitored_screen': monitored mode, where the WBGT tables are only a screen ({@link MONITORED_SCREEN_DRIVER_IDS}).
 */
export type DesignedSuppressionCause = 'plan_in_force' | 'monitored_screen'

/** True while an alert is under designed suppression (recorded, notified to nobody). Basis: {@link AlertSuppression}. */
export function isAlertSuppressed(a: Pick<Alert, 'suppression'>): boolean {
  return a.suppression !== undefined && a.suppression.liftedAt === undefined
}

/** Tunable alert policy (every field defaults to the exported constant of the same meaning). */
export interface AlertPolicy {
  minAlertLevel: RiskLevel
  supervisorMinLevel: RiskLevel
  repeatSuppressionMin: number
  crewBundleMinWorkers: number
  crewBundleWindowMin: number
  stopAckTimeoutMin: number
  emergencyAckTimeoutMin: number
  emergencyRepeatMin: number
  highAckTimeoutMin: number
  deescalationDwellMin: number
  clinicalResolutionHoldMin: number
  closedAlertRetentionMin: number
}

/** The default policy — ARCHITECTURE §6 plus the [ENG] constants above. */
export const DEFAULT_ALERT_POLICY: Readonly<AlertPolicy> = Object.freeze({
  minAlertLevel: ALERT_MIN_LEVEL,
  supervisorMinLevel: SUPERVISOR_MIN_LEVEL,
  repeatSuppressionMin: REPEAT_SUPPRESSION_MIN,
  crewBundleMinWorkers: CREW_BUNDLE_MIN_WORKERS,
  crewBundleWindowMin: CREW_BUNDLE_WINDOW_MIN,
  stopAckTimeoutMin: STOP_ACK_TIMEOUT_MIN,
  emergencyAckTimeoutMin: EMERGENCY_ACK_TIMEOUT_MIN,
  emergencyRepeatMin: EMERGENCY_REPEAT_MIN,
  highAckTimeoutMin: HIGH_ACK_TIMEOUT_MIN,
  deescalationDwellMin: DEESCALATION_DWELL_MIN,
  clinicalResolutionHoldMin: CLINICAL_RESOLUTION_HOLD_MIN,
  closedAlertRetentionMin: CLOSED_ALERT_RETENTION_MIN,
})

// ─────────────────────────────── Public types ───────────────────────────────

/** Delivery channel: in-app card, OS push, SMS (GSM fallback), automated voice call, local audible siren. */
export type NotificationChannel = 'app' | 'push' | 'sms' | 'voice' | 'siren'

/** Why a notification was sent (lets the UI and {@link alertStats} tell first alerts from escalations). */
export type NotificationKind =
  | 'alert'
  | 'crew_alert'
  | 'deescalation'
  | 'update'
  | 'escalation'
  | 'renotify'
  | 'siren'
  | 'reminder'
  | 'device_offline'

/**
 * One message to one role (optionally one person). `to.id` absent = the on-duty holder of that role for the crew/site
 * (first aider, occ-health console, or — for `buddy` — any crewmate when no buddy is assigned; for a `siren` the
 * broadcast goes to every crew device). `text` is English and non-clinical; `reasonKey` is the i18n key of the reason
 * (`driver.<id>`, `reason.<generic>` or `policy.<rule>`). `basis` is the alert's basis when the notification was sent.
 */
export interface Notification {
  id: string
  t: number
  alertId: string
  to: { role: Role; id?: string }
  channel: NotificationChannel
  level: RiskLevel
  actions: ActionId[]
  reasonKey: string
  text: string
  requiresAck: boolean
  kind: NotificationKind
  basis: AlertBasis
}

/**
 * An {@link Alert} as published by this engine. `basis`, `acks`, `consoleActions` and `reasonKey` are always present.
 * Crew alerts also list their members.
 */
export interface EngineAlert extends Alert {
  basis: AlertBasis
  acks: Array<{ role: Role; t: number }>
  /** Console-safe actions (see {@link Alert.consoleActions}); a crew alert's `actions` equal them. */
  consoleActions: ActionId[]
  /** i18n key of `reason` (see {@link Alert.reasonKey}). */
  reasonKey: string
  /** Crew alerts only: the bundled workers' pseudonymous ids, in joining order. */
  memberIds?: string[]
}

/** How an exposure alert's reason is framed: site heat (environment channel) or a site rule (regulation channel). */
export type ExposureFrame = 'heat' | 'rule'

/** What the alert engine needs to know about each worker (from the roster; operational data only). */
export interface RosterEntry {
  crewId: string
  siteId: string
  /** Name/badge shown to the supervisor, buddy and first aider (operational necessity, ARCHITECTURE §2). */
  displayName: string
  buddyId?: string
  supervisorId?: string
  /** Device connectivity; 'offline' triggers the supervisor SMS fallback [ENG]. */
  network?: 'online' | 'offline'
}

/** Context of a {@link processAssessments} call. */
export interface AlertContext {
  /** Engine clock (epoch ms); alert and notification times use it. */
  now: number
  roster: Readonly<Record<string, RosterEntry>>
}

/** How an alert came about. */
export type AlertOrigin = 'new' | 'escalation' | 'deescalation' | 'crew'

/** Why an alert was closed. */
export type AlertCloseReason = 'superseded' | 'auto_dwell' | 'manual' | 'members_cleared'

/** Engine bookkeeping for one alert (serialisable). */
export interface AlertRecord {
  alert: EngineAlert
  origin: AlertOrigin
  /** Channels at the alert's level when it was raised. */
  drivingChannels: ChannelId[]
  /** Symptom/physiology-driven (or emergency, or a symptomatic hydration stop). */
  clinical: boolean
  /** Never auto-resolves; resolvable only by {@link CLINICAL_RESOLVER_ROLES}. */
  latched: boolean
  bundleEligible: boolean
  requiresAck: boolean
  /** Every acknowledgement received, also published as `alert.acks` (the first counting one is mirrored in `alert.ack`). */
  acks: Array<{ role: Role; t: number }>
  reasonKey: string
  /** Exposure alerts (worker and crew): how the reason is framed, so a crew alert can rebuild it as members join. */
  exposureFrame?: ExposureFrame
  workMinPerHour?: number
  /** Worker alerts bundled into a crew alert. */
  crewAlertId?: string
  /** Crew alerts: members whose worker alert is still open. */
  activeMemberIds?: string[]
  /** Crew alerts: supervisor ids notified (null = the crew's on-duty supervisor). */
  supervisorTargets?: Array<string | null>
  stopEscalatedAt?: number
  renotifiedAt?: number
  remindedAt?: number
  /**
   * When the alert was first notified, if later than its raise (designed suppression lifted). The acknowledgement
   * timers and the crew-bundling window count from here, so a lifted alert gets the full acknowledgement time.
   */
  notifiedAt?: number
  /**
   * Designed suppression: what put the alert under it ({@link DesignedSuppressionCause}). Engine state only, never
   * published (it can reveal monitored mode, hence wearable consent).
   */
  suppressionCause?: DesignedSuppressionCause
  closedReason?: AlertCloseReason
  resolvedBy?: Role
}

/** Per-worker engine bookkeeping (serialisable). */
export interface WorkerAlertTrack {
  workerId: string
  /** Last roster snapshot (tick() has no roster argument). */
  roster: RosterEntry
  /** Last assessed level. */
  level: RiskLevel
  lastT: number
  openAlertId: string | null
  /** Since when the assessed level has been below the open alert's level (dwell timer). */
  belowSince: number | null
  /** Repeat-suppression memory: `${level}|${sorted actions}` → when the worker was last told it. */
  told: Record<string, number>
  /** Key of the episode currently being suppressed (counts one suppression per episode). */
  suppressedKey: string | null
  /** Set when a latched alert is resolved by hand (see {@link CLINICAL_RESOLUTION_HOLD_MIN}). */
  resolutionHold?: { level: RiskLevel; t: number }
}

/** One suppressed repeat (for pilot reporting). */
export interface SuppressionEvent {
  t: number
  workerId: string
  level: RiskLevel
  actions: ActionId[]
}

/** Complete, JSON-serialisable alert engine state. */
export interface AlertEngineState {
  version: 1
  idPrefix: string
  alertSeq: number
  notificationSeq: number
  /** Open alerts and alerts closed within the retention period, by id (insertion = raise order). */
  alerts: Record<string, AlertRecord>
  workers: Record<string, WorkerAlertTrack>
  /** `${crewId}|${level}` → open crew alert id. */
  crewOpen: Record<string, string>
  suppressed: SuppressionEvent[]
}

/** Result of {@link processAssessments}. */
export interface ProcessResult {
  state: AlertEngineState
  /** Alerts created in this call (final state). */
  raised: EngineAlert[]
  /** Pre-existing alerts changed in this call (status, ack, actions, members, escalation, resolution, basis re-label). */
  updated: EngineAlert[]
  notifications: Notification[]
}

/** Result of {@link tick}. */
export interface TickResult {
  state: AlertEngineState
  updated: EngineAlert[]
  notifications: Notification[]
}

/** Result of {@link acknowledge}. */
export interface AckResult {
  state: AlertEngineState
  ok: boolean
  alert: EngineAlert | null
  /** False when the acknowledgement was recorded but does not stop the escalation (a worker acknowledging an emergency). */
  counted: boolean
  reason?: 'unknown_alert' | 'role_not_permitted'
}

/** Result of {@link resolve}. */
export interface ResolveResult {
  state: AlertEngineState
  ok: boolean
  alert: EngineAlert | null
  updated: EngineAlert[]
  reason?: 'unknown_alert' | 'role_not_permitted'
}

/** Counts for one {@link AlertBasis} in {@link AlertStats.byBasis}. */
export interface BasisCounts {
  /** Distinct alerts, by the basis of their latest version. */
  alerts: number
  /** Notifications sent, by the basis each one carried when it was sent. */
  notifications: number
  /** Of those, notifications that asked for an acknowledgement. */
  notificationsRequiringAck: number
  /** Alerts that asked someone to acknowledge (a notification with requiresAck) and never were. */
  unacknowledged: number
}

/** Designed-suppression counts in {@link AlertStats} (alerts by their latest version). */
export interface DesignedSuppressionStats {
  /** Distinct alerts recorded under designed suppression (also counted in `AlertStats.alerts` and the breakdowns). */
  alerts: number
  /** Of those, never notified: still suppressed in their latest version. */
  stillSuppressed: number
  /** Of those, lifted later (individual basis or the condition ended) and notified then. */
  lifted: number
}

/** Counts for the challenge's safety measures and pilot reporting (see {@link alertStats}). */
export interface AlertStats {
  alerts: number
  byLevel: Record<RiskLevel, number>
  byScope: Record<Alert['scope'], number>
  /**
   * The counts split by basis. An alert or notification without a basis counts as 'individual'. The existing totals
   * (`alerts`, `notifications`, `unacknowledged`) are the sums of the two.
   */
  byBasis: Record<AlertBasis, BasisCounts>
  acknowledged: number
  /** Alerts that asked someone to acknowledge (a notification with requiresAck) and never were. */
  unacknowledged: number
  resolved: number
  /** Median minutes from raise to the first counting acknowledgement (null when none). */
  medianTimeToAckMin: number | null
  medianTimeToAckMinByLevel: Partial<Record<RiskLevel, number>>
  escalations: {
    /** Distinct alerts escalated by an acknowledgement timer. */
    alertsEscalated: number
    stopUnacknowledged: number
    emergencyRenotified: number
    highReminders: number
  }
  /** Repeat suppressions (the same level + actions within 20 min), from `state.suppressed`. */
  suppressed: number
  /**
   * Designed suppression (ANSI/ISA-18.2): exposure alerts recorded but notified to nobody because the plan already
   * enforces their action or they are the monitored-mode screen. Counted separately from repeat suppressions.
   */
  designedSuppression: DesignedSuppressionStats
  /** Worker alerts carried by crew alerts (Σ crew-alert members). */
  crewBundledWorkerAlerts: number
  notifications: number
  notificationsByChannel: Record<NotificationChannel, number>
  notificationsByRole: Partial<Record<Role, number>>
  notificationsByKind: Partial<Record<NotificationKind, number>>
}

// ─────────────────────────────── Text (English, non-clinical) ───────────────────────────────

const LEVEL_TEXT: Record<RiskLevel, string> = {
  safe: 'LOW RISK',
  caution: 'CAUTION',
  high: 'HIGH RISK',
  stop: 'STOP WORK',
  emergency: 'EMERGENCY',
}

const ACTION_TEXT: Record<ActionId, string> = {
  drink_water: 'drink water regularly',
  shade_breaks: 'take breaks in the shade',
  reduce_intensity: 'slow the work pace',
  rotate_task: 'rotate to a lighter or shaded task',
  rest_shade_now: 'rest in the shade now',
  cool_down: 'cool down (shade, water, fan)',
  stop_work: 'stop work',
  buddy_check: 'buddy check',
  first_aider_check: 'first aider to check the worker',
  call_998: 'call 998',
  cool_first: 'cool first with cold water, transport second',
  stay_with_worker: 'stay with the worker',
  midday_break: 'midday break: no work in direct sun',
  acclimatization_plan: 'follow the acclimatisation plan',
  occ_health_review: 'occupational health review',
  check_sensor: 'check the site sensor',
  symptom_checkin: 'answer the quick check-in',
  no_lone_work: 'no lone work',
  electrolytes: 'electrolyte drink',
  restrict_fluids: 'do not drink more water until first aid has checked',
  medical_evaluation: 'arrange a medical evaluation',
  no_hot_work_today: 'no more hot work today',
}

/** Generic reasons when no usable non-clinical driver exists (keys for i18n). */
const GENERIC_REASON: Record<'environment' | 'regulation' | 'projection', { text: string; key: string }> = {
  environment: { text: 'Heat exposure is above the limit for this work', key: 'reason.heat_exposure' },
  regulation: { text: 'A heat-work regulation applies now', key: 'reason.regulation' },
  projection: { text: 'Heat-strain model limit approaching at the current work rate', key: 'reason.projection' },
}

/** Reasons for personal (device-side) alerts: action-oriented, never naming the cause. */
const PERSONAL_REASON: Record<RiskLevel, { text: string; key: string }> = {
  safe: { text: 'Personal check flagged on the worker’s device', key: 'reason.personal_check' },
  caution: { text: 'Personal check flagged on the worker’s device', key: 'reason.personal_check' },
  high: { text: 'Personal check flagged on the worker’s device', key: 'reason.personal_check' },
  stop: { text: 'First-aid check needed', key: 'reason.first_aid_check' },
  emergency: { text: 'Emergency response needed now', key: 'reason.emergency' },
}

const usableText = (s: string): boolean => supervisorSafeText(s)

/** Collapse whitespace, neutralise REL/RAL (which can hint at conservative mode) and bound the length. */
function tidyReason(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/\b(REL|RAL)\b/g, 'exposure limit')
  return t.length > 160 ? `${t.slice(0, 157)}…` : t
}

function phraseActions(actions: readonly ActionId[], workMinPerHour?: number): string {
  if (actions.length === 0) return 'follow the supervisor’s instructions'
  return actions
    .map((a) => {
      if (a === 'shade_breaks' && workMinPerHour !== undefined && Number.isFinite(workMinPerHour) && workMinPerHour < 60) {
        const w = Math.max(0, Math.floor(workMinPerHour))
        return `${ACTION_TEXT.shade_breaks} (${w} min work / ${60 - w} min rest per hour)`
      }
      return ACTION_TEXT[a] ?? a
    })
    .join('; ')
}

/**
 * Supervisor-facing reason of a site-heat exposure alert [ENG, privacy]. It names the shared condition and the
 * work/rest schedule in effect, never a personal factor, so the same words fit every crew member and a crew alert
 * (ARCHITECTURE §2: supervisors never see personal reasons). Work minutes are floored as in {@link phraseActions}, so
 * the reason and the action phrase agree.
 */
function heatReason(level: RiskLevel, workMinPerHour: number | undefined): string {
  const w = workMinPerHour !== undefined && Number.isFinite(workMinPerHour) ? Math.max(0, Math.floor(workMinPerHour)) : undefined
  if (RISK_ORDER[level] >= RISK_ORDER.stop || w === 0) return 'Site heat: too hot for this work now'
  if (w !== undefined && w < 60) return `Site heat: work/rest ${w}/${60 - w} in effect`
  if (RISK_ORDER[level] >= RISK_ORDER.high) return 'Site heat: heat controls in effect'
  return 'Site heat: close to the limit for this work'
}

/** Reason of a site-rule exposure alert: the regulation's own (non-clinical) text, framed as a site rule. */
const ruleReason = (text: string): string => tidyReason(`Site rule: ${text}`)

/** Site-rule reason when no usable regulation driver text exists. */
const SITE_RULE_GENERIC = 'Site rule: a heat-work regulation applies now'

/** i18n key of a reason taken from a driver's supervisor view: `reason.<pooled id>` or `driver.<id>`. */
const reasonKeyOf = (view: RiskDriver): string => ((POOLED_DRIVER_IDS as readonly string[]).includes(view.id) ? `reason.${view.id}` : `driver.${view.id}`)

/** Console actions of an alert; derived with the privacy rule for alerts from older producers (no drivers known). */
const consoleActionsOf = (al: Alert): ActionId[] => (al.consoleActions ? [...al.consoleActions] : supervisorActions(al.actions, []))

/**
 * Crew alert reason: the shared condition plus the member count. A site-heat reason is rebuilt with the crew's
 * strictest work/rest; a site rule keeps the first member's rule text.
 */
function crewReason(frame: ExposureFrame | undefined, level: RiskLevel, workMinPerHour: number | undefined, firstReason: string, n: number): string {
  const base = frame === 'heat' ? heatReason(level, workMinPerHour) : firstReason.replace(/ \(\d+ workers\)$/, '')
  return `${base} (${n} workers)`
}

// ─────────────────────────────── Internals ───────────────────────────────

interface Classified {
  level: RiskLevel
  actions: ActionId[]
  driving: ChannelId[]
  clinical: boolean
  basis: AlertBasis
  bundleEligible: boolean
  /** Reason for `basis` (site- or crew-framed for 'exposure'). */
  reason: string
  reasonKey: string
  /** Exposure only: how `reason` is framed. */
  frame?: ExposureFrame
  /** The non-clinical individual reason (equals `reason` when `basis` is 'individual'). Used when a carried clinical latch makes an exposure classification individual. */
  individual: { reason: string; reasonKey: string }
  workMinPerHour?: number
  /** privacy.ts supervisorActions of the assessment: what supervisors and the crew alert may show. */
  consoleActions: ActionId[]
  /** Designed suppression that would apply to an alert raised from this assessment (no carried latch), or null. */
  suppressibleBy: DesignedSuppressionCause | null
}

/** Copy-on-write bookkeeping of one call: what it has already copied and may therefore mutate. */
interface Owned {
  alerts: boolean
  workers: boolean
  crewOpen: boolean
  suppressed: boolean
  recs: Set<string>
  tracks: Set<string>
}

interface Work {
  /** Shallow copy of the input state. Containers, records and tracks are copied on their first write (see {@link Owned}). */
  s: AlertEngineState
  p: AlertPolicy
  now: number
  raised: string[]
  touched: Set<string>
  notes: Notification[]
  /** Bundle-eligible worker alerts whose supervisor notification waits for the end-of-batch bundling decision. */
  pending: string[]
  own: Owned
}

const atLeast = (a: RiskLevel, b: RiskLevel): boolean => RISK_ORDER[a] >= RISK_ORDER[b]

// ── Copy-on-write ──
// The input state is never mutated. A call writes only to objects it has copied. Every write to a record or track goes
// through recW/trackW, which copy it once per call. A record or track read before a recW/trackW call for the same id is
// stale after it, so it is only read, never written, afterwards.

const copyAck = (x: { role: Role; t: number }): { role: Role; t: number } => ({ role: x.role, t: x.t })

/** Deep copy of a published alert (alerts are small: arrays and nested objects are copied). */
function copyAlert(a: EngineAlert): EngineAlert {
  const c: EngineAlert = { ...a, actions: [...a.actions], consoleActions: [...(a.consoleActions ?? [])], acks: (a.acks ?? []).map(copyAck) }
  if (a.suppression) c.suppression = { ...a.suppression }
  if (a.memberIds) c.memberIds = [...a.memberIds]
  if (a.escalatedTo) c.escalatedTo = [...a.escalatedTo]
  if (a.ack) c.ack = copyAck(a.ack)
  return c
}

function copyRecord(r: AlertRecord): AlertRecord {
  const c: AlertRecord = { ...r, alert: copyAlert(r.alert), drivingChannels: [...r.drivingChannels], acks: r.acks.map(copyAck) }
  if (r.activeMemberIds) c.activeMemberIds = [...r.activeMemberIds]
  if (r.supervisorTargets) c.supervisorTargets = [...r.supervisorTargets]
  return c
}

function copyTrack(t: WorkerAlertTrack): WorkerAlertTrack {
  const c: WorkerAlertTrack = { ...t, roster: { ...t.roster }, told: { ...t.told } }
  if (t.resolutionHold) c.resolutionHold = { ...t.resolutionHold }
  return c
}

function alertsW(work: Work): Record<string, AlertRecord> {
  if (!work.own.alerts) {
    work.s.alerts = { ...work.s.alerts }
    work.own.alerts = true
  }
  return work.s.alerts
}

function workersW(work: Work): Record<string, WorkerAlertTrack> {
  if (!work.own.workers) {
    work.s.workers = { ...work.s.workers }
    work.own.workers = true
  }
  return work.s.workers
}

function crewOpenW(work: Work): Record<string, string> {
  if (!work.own.crewOpen) {
    work.s.crewOpen = { ...work.s.crewOpen }
    work.own.crewOpen = true
  }
  return work.s.crewOpen
}

function suppressedW(work: Work): SuppressionEvent[] {
  if (!work.own.suppressed) {
    work.s.suppressed = [...work.s.suppressed]
    work.own.suppressed = true
  }
  return work.s.suppressed
}

/** Writable record `id` (must exist), copied on its first write in this call. */
function recW(work: Work, id: string): AlertRecord {
  const alerts = alertsW(work)
  if (!work.own.recs.has(id)) {
    alerts[id] = copyRecord(alerts[id])
    work.own.recs.add(id)
  }
  return alerts[id]
}

/** Writable track of `workerId` (must exist), copied on its first write in this call. */
function trackW(work: Work, workerId: string): WorkerAlertTrack {
  const workers = workersW(work)
  if (!work.own.tracks.has(workerId)) {
    workers[workerId] = copyTrack(workers[workerId])
    work.own.tracks.add(workerId)
  }
  return workers[workerId]
}

/** Adds a record created in this call (owned from the start). */
function addRecord(work: Work, rec: AlertRecord): void {
  alertsW(work)[rec.alert.id] = rec
  work.own.recs.add(rec.alert.id)
}

function resolvePolicy(opts?: Partial<AlertPolicy>): AlertPolicy {
  const p: AlertPolicy = { ...DEFAULT_ALERT_POLICY }
  if (!opts) return p
  for (const k of Object.keys(p) as Array<keyof AlertPolicy>) {
    const v = opts[k]
    if (v === undefined) continue
    if (typeof v === 'number' ? Number.isFinite(v) && v >= 0 : RISK_LEVELS.includes(v)) (p as unknown as Record<string, unknown>)[k] = v
  }
  return p
}

function begin(state: AlertEngineState, now: number, opts?: Partial<AlertPolicy>): Work {
  return {
    s: { ...state },
    p: resolvePolicy(opts),
    now,
    raised: [],
    touched: new Set(),
    notes: [],
    pending: [],
    own: { alerts: false, workers: false, crewOpen: false, suppressed: false, recs: new Set(), tracks: new Set() },
  }
}

function finish(work: Work): { state: AlertEngineState; raised: EngineAlert[]; updated: EngineAlert[]; notifications: Notification[] } {
  prune(work)
  const { s } = work
  const raisedSet = new Set(work.raised)
  const raised = work.raised.filter((id) => s.alerts[id]).map((id) => copyAlert(s.alerts[id].alert))
  const updated = [...work.touched].filter((id) => !raisedSet.has(id) && s.alerts[id]).map((id) => copyAlert(s.alerts[id].alert))
  return { state: s, raised, updated, notifications: work.notes }
}

function prune(work: Work): void {
  const { s, p, now } = work
  const cutoff = now - p.closedAlertRetentionMin * MINUTE_MS
  for (const id of Object.keys(s.alerts)) {
    const al = s.alerts[id].alert
    if (al.status === 'resolved' && (al.resolvedAt ?? al.t) < cutoff && !work.touched.has(id)) delete alertsW(work)[id]
  }
  const windowMs = p.repeatSuppressionMin * MINUTE_MS
  for (const workerId of Object.keys(s.workers)) {
    const told = s.workers[workerId].told
    if (!Object.keys(told).some((key) => now - told[key] >= windowMs)) continue
    const track = trackW(work, workerId)
    for (const [key, t] of Object.entries(track.told)) if (now - t >= windowMs) delete track.told[key]
  }
  if (s.suppressed.length > SUPPRESSION_LOG_MAX) {
    s.suppressed = s.suppressed.slice(-SUPPRESSION_LOG_MAX)
    work.own.suppressed = true
  }
}

function nextAlertId(s: AlertEngineState): string {
  s.alertSeq += 1
  return `${s.idPrefix}A-${s.alertSeq}`
}

/**
 * Actions a notification may carry for its recipient [ENG, privacy]: the worker's own device gets the alert's actions;
 * the clinical responders (first aider, occupational health) get them without the confidential ones; a buddy gets the
 * console actions plus its buddy-check prompt; every other recipient, and a crew-wide broadcast (siren), gets the
 * console actions (privacy.ts supervisorActions). Basis: ARCHITECTURE §1 principle 5; GOVERNANCE §13 item 18.
 */
function notificationActions(al: Alert, to: Notification['to'], given: readonly ActionId[]): ActionId[] {
  if (to.role === 'worker' && to.id !== undefined) return [...given]
  if (to.role === 'first_aider' || to.role === 'occ_health') return given.filter((x) => !CONFIDENTIAL_ACTIONS.includes(x))
  const shown = consoleActionsOf(al)
  if (to.role === 'buddy' && given.includes('buddy_check') && !shown.includes('buddy_check')) shown.push('buddy_check')
  return shown
}

/**
 * Queues a notification; it carries the alert's current basis ('individual' if the alert is unknown, protective) and
 * the actions its recipient may see ({@link notificationActions}).
 */
function push(work: Work, n: Omit<Notification, 'id' | 't' | 'basis'>): void {
  work.s.notificationSeq += 1
  const al = work.s.alerts[n.alertId]?.alert
  const basis: AlertBasis = al?.basis ?? 'individual'
  const actions = al ? notificationActions(al, n.to, n.actions) : [...n.actions]
  work.notes.push({ id: `${work.s.idPrefix}N-${work.s.notificationSeq}`, t: work.now, ...n, actions, basis })
}

function touch(work: Work, id: string): void {
  work.touched.add(id)
}

/** Sets `escalatedAt` once (the first escalation; durable through status changes and resolution). `rec` must be writable. */
function markEscalated(work: Work, rec: AlertRecord): void {
  if (rec.alert.escalatedAt === undefined) rec.alert.escalatedAt = work.now
}

/** Adds routing roles to a writable record. Routing to a role in {@link ESCALATION_ROUTING_ROLES} is an escalation. */
function addRoutedRole(work: Work, rec: AlertRecord, ...roles: Role[]): void {
  const list = rec.alert.escalatedTo ?? []
  for (const r of roles) if (!list.includes(r)) list.push(r)
  rec.alert.escalatedTo = list
  if (roles.some((r) => ESCALATION_ROUTING_ROLES.includes(r))) markEscalated(work, rec)
}

const workerTo = (id: string): Notification['to'] => ({ role: 'worker', id })
const supervisorTo = (r: RosterEntry): Notification['to'] => (r.supervisorId ? { role: 'supervisor', id: r.supervisorId } : { role: 'supervisor' })
const buddyTo = (r: RosterEntry): Notification['to'] => (r.buddyId ? { role: 'buddy', id: r.buddyId } : { role: 'buddy' })

const toldKey = (level: RiskLevel, actions: readonly ActionId[]): string => `${level}|${[...new Set(actions)].sort().join(',')}`

/** Channels at the assessment level (risk fusion = max over channels); falls back to the highest channel level. */
function drivingChannels(a: RiskAssessment): ChannelId[] {
  const at = a.channels.filter((c) => c.level === a.level).map((c) => c.channel)
  if (at.length > 0) return [...new Set(at)]
  let top: RiskLevel = 'safe'
  for (const c of a.channels) if (c.available && RISK_ORDER[c.level] > RISK_ORDER[top]) top = c.level
  if (top === 'safe') return []
  return [...new Set(a.channels.filter((c) => c.available && c.level === top).map((c) => c.channel))]
}

/**
 * Basis of the level of an assessment. It is 'individual' when any of these holds:
 * - the case is clinical;
 * - no channel explains the level (unknown cause: never presented as a site condition) [ENG, protective];
 * - a channel at the level is outside {@link EXPOSURE_CHANNELS};
 * - a raising driver from {@link INDIVIDUAL_DRIVER_IDS} sits on a channel at the level.
 * Otherwise it is 'exposure'. Only channels at the assessed level count: they are what raises it to that level.
 */
function basisOf(driving: readonly ChannelId[], clinical: boolean, pool: readonly RiskDriver[]): AlertBasis {
  const individual =
    clinical ||
    driving.length === 0 ||
    driving.some((c) => !EXPOSURE_CHANNELS.includes(c)) ||
    pool.some((d) => d.direction === 'raises' && INDIVIDUAL_DRIVER_IDS.includes(d.id) && driving.includes(d.channel))
  return individual ? 'individual' : 'exposure'
}

/**
 * True when a cause that is not a shared condition sits AT `level`: a channel at that level outside
 * {@link EXPOSURE_CHANNELS}, or a raising {@link INDIVIDUAL_DRIVER_IDS} driver on a channel at that level. The
 * drivingChannels() fallback to the highest channel below the level never counts: a dwell-held level is not a new
 * cause (safety review wave 2c: a dwell-held stop with the projection at caution re-labelled an exposure alert).
 */
function individualCauseAt(a: RiskAssessment, level: RiskLevel): boolean {
  const at = a.channels.filter((c) => c.level === level).map((c) => c.channel)
  if (at.length === 0) return false
  if (at.some((c) => !EXPOSURE_CHANNELS.includes(c))) return true
  return [...a.drivers, ...a.channels.flatMap((c) => c.drivers)].some(
    (d) => d.direction === 'raises' && INDIVIDUAL_DRIVER_IDS.includes(d.id) && at.includes(d.channel),
  )
}

/**
 * Designed suppression of an alert raised from an assessment (ANSI/ISA-18.2-2016 designed / state-based suppression;
 * wave 2d principle 5): only an exposure, non-clinical alert at caution or high whose console actions are all
 * {@link PLAN_COVERED_ACTIONS}, and then
 * - 'plan_in_force' when the active plan already sets the work/rest ({@link PLAN_IN_FORCE_DRIVER_IDS});
 * - 'monitored_screen' when only the environment channel drives it and monitored mode makes the WBGT tables a screen
 *   ({@link MONITORED_SCREEN_DRIVER_IDS}).
 * Never for stop or emergency, an individual basis, a symptom, physiology or hydration cause, or a first-aid case.
 */
function designedSuppressionOf(
  basis: AlertBasis,
  level: RiskLevel,
  clinical: boolean,
  driving: readonly ChannelId[],
  consoleActions: readonly ActionId[],
  pool: readonly RiskDriver[],
): DesignedSuppressionCause | null {
  if (basis !== 'exposure' || clinical || RISK_ORDER[level] > RISK_ORDER[DESIGNED_SUPPRESSION_MAX_LEVEL]) return null
  if (driving.length === 0 || driving.some((c) => !EXPOSURE_CHANNELS.includes(c))) return null
  if (!consoleActions.every((x) => PLAN_COVERED_ACTIONS.includes(x))) return null
  if (pool.some((d) => PLAN_IN_FORCE_DRIVER_IDS.includes(d.id))) return 'plan_in_force'
  if (driving.every((c) => c === 'environment') && pool.some((d) => d.channel === 'environment' && MONITORED_SCREEN_DRIVER_IDS.includes(d.id))) {
    return 'monitored_screen'
  }
  return null
}

function classify(a: RiskAssessment): Classified {
  const level: RiskLevel = RISK_ORDER[a.level] === undefined ? 'stop' : a.level // fail-safe on a corrupt level [ENG]
  const driving = drivingChannels(a)
  const clinical =
    level === 'emergency' ||
    driving.some((c) => LATCHING_CHANNELS.includes(c)) ||
    (driving.includes('hydration') && atLeast(level, 'stop'))
  const exposureDriving = driving.filter((c) => !CLINICAL_CHANNELS.includes(c))
  const pool: RiskDriver[] = [...a.drivers, ...a.channels.flatMap((c) => c.drivers)]
  const basis = basisOf(driving, clinical, pool)
  // Crew bundling stays exposure-only (shared conditions, ARCHITECTURE §6).
  const bundleEligible = basis === 'exposure' && (level === 'high' || level === 'stop')

  // The most important usable non-clinical raising driver on a driving channel, as a supervisor may see it (privacy.ts
  // supervisorDriver: the generic `driver.<id>` phrase or a pooled phrase, site numbers only; a withheld driver is
  // skipped). Reasons never carry an individual number (GOVERNANCE §13 item 16) [wave 2d].
  let primary: RiskDriver | undefined
  let view: RiskDriver | undefined
  for (const d of pool) {
    if (d.direction !== 'raises' || CLINICAL_CHANNELS.includes(d.channel) || !exposureDriving.includes(d.channel)) continue
    if (typeof d.text !== 'string' || !usableText(d.text) || !usableText(d.id)) continue
    const v = supervisorDriver(d)
    if (v === null || !usableText(v.text)) continue
    primary = d
    view = v
    break
  }
  // The non-clinical individual reason (the reason every alert had before the basis split).
  let individual: { reason: string; reasonKey: string }
  if (clinical || exposureDriving.length === 0) {
    const base = PERSONAL_REASON[level]
    individual = { reason: view ? `${base.text}; ${tidyReason(view.text)}` : base.text, reasonKey: base.key }
  } else if (view) {
    individual = { reason: tidyReason(view.text), reasonKey: reasonKeyOf(view) }
  } else {
    const g = GENERIC_REASON[exposureDriving[0] as 'environment' | 'regulation' | 'projection'] ?? GENERIC_REASON.environment
    individual = { reason: g.text, reasonKey: g.key }
  }
  const wmph = Number.isFinite(a.workMinPerHour) ? a.workMinPerHour : undefined
  let reason = individual.reason
  let reasonKey = individual.reasonKey
  let frame: ExposureFrame | undefined
  if (basis === 'exposure') {
    // A site or crew condition: the risk engine's most important exposure driver picks the frame.
    if (primary ? primary.channel === 'regulation' : exposureDriving[0] === 'regulation') {
      frame = 'rule'
      reason = view ? ruleReason(view.text) : SITE_RULE_GENERIC
      reasonKey = view ? reasonKeyOf(view) : GENERIC_REASON.regulation.key
    } else {
      frame = 'heat'
      reason = heatReason(level, wmph)
      reasonKey = view ? reasonKeyOf(view) : GENERIC_REASON.environment.key
    }
  }
  const actions = [...new Set(a.actions)]
  const consoleActions = supervisorActions(actions, pool)
  const suppressibleBy = designedSuppressionOf(basis, level, clinical, driving, consoleActions, pool)
  return {
    level,
    actions,
    driving,
    clinical,
    basis,
    bundleEligible,
    reason,
    reasonKey,
    ...(frame ? { frame } : {}),
    individual,
    ...(wmph !== undefined ? { workMinPerHour: wmph } : {}),
    consoleActions,
    suppressibleBy,
  }
}

/**
 * Basis an alert raised from this assessment would carry (see {@link AlertBasis}). An open alert that carries a
 * clinical latch is always 'individual'. Pure; for tests and the UI. Basis: ARCHITECTURE.md §6; task brief wave 2c.
 */
export function assessmentBasis(a: RiskAssessment): AlertBasis {
  return classify(a).basis
}

function fallbackRoster(workerId: string, prev?: WorkerAlertTrack): RosterEntry {
  return prev?.roster ?? { crewId: '', siteId: 'unknown', displayName: workerId }
}

function closeAlert(work: Work, id: string, reason: AlertCloseReason, by?: Role): void {
  const { s, now } = work
  const current = s.alerts[id]
  if (!current || current.alert.status === 'resolved') return
  const rec = recW(work, id)
  const al = rec.alert
  al.status = 'resolved'
  al.resolvedAt = now
  rec.closedReason = reason
  if (by) rec.resolvedBy = by
  touch(work, id)
  if (al.scope === 'worker' && al.workerId) {
    const workerId = al.workerId
    if (s.workers[workerId]?.openAlertId === id) {
      const track = trackW(work, workerId)
      track.openAlertId = null
      track.belowSince = null
    }
    const crewAlertId = rec.crewAlertId
    if (crewAlertId && s.alerts[crewAlertId] && s.alerts[crewAlertId].alert.status !== 'resolved') {
      const crew = recW(work, crewAlertId)
      crew.activeMemberIds = (crew.activeMemberIds ?? []).filter((w) => w !== workerId)
      touch(work, crewAlertId)
      if (crew.activeMemberIds.length === 0) closeAlert(work, crewAlertId, 'members_cleared')
    }
  } else if (al.scope === 'crew') {
    const key = `${al.crewId ?? ''}|${al.level}`
    if (s.crewOpen[key] === id) delete crewOpenW(work)[key]
  }
}

// ─────────────────────────────── Routing ───────────────────────────────

/** Individual supervisor message for worker alert `id` (no-op without a worker track). */
function notifySupervisorIndividual(work: Work, id: string, kind: 'alert' | 'deescalation'): void {
  const workerId = work.s.alerts[id]?.alert.workerId
  const track = workerId ? work.s.workers[workerId] : undefined
  if (!track) return
  const rec = recW(work, id)
  const al = rec.alert
  const name = track.roster.displayName
  const phrase = phraseActions(consoleActionsOf(al), rec.workMinPerHour)
  push(work, {
    alertId: al.id,
    to: supervisorTo(track.roster),
    channel: kind === 'deescalation' || al.level === 'high' ? 'app' : 'push',
    level: al.level,
    actions: [...al.actions],
    reasonKey: kind === 'deescalation' ? 'policy.deescalated' : rec.reasonKey,
    text:
      kind === 'deescalation'
        ? `${name} — conditions eased to ${LEVEL_TEXT[al.level]}: ${phrase}. Reason: ${al.reason}`
        : `${name} — ${LEVEL_TEXT[al.level]}: ${phrase}. Reason: ${al.reason}`,
    requiresAck: kind === 'alert' && rec.requiresAck,
    kind,
  })
  addRoutedRole(work, rec, 'supervisor')
}

/**
 * Raises a worker alert and routes it, unless designed suppression applies: then it is recorded with `suppression`,
 * notified to nobody and left out of the repeat-suppression memory (the worker was not told). `track` must be writable
 * (trackW).
 */
function raiseWorkerAlert(work: Work, track: WorkerAlertTrack, info: Classified, origin: Exclude<AlertOrigin, 'crew'>, carryLatch: boolean): AlertRecord {
  const { s, now } = work
  const id = nextAlertId(s)
  const level = info.level
  const latched = info.clinical || carryLatch
  // A carried clinical latch keeps the case individual, whatever drives the new level.
  const basis: AlertBasis = latched ? 'individual' : info.basis
  const why = basis === info.basis ? { reason: info.reason, reasonKey: info.reasonKey } : info.individual
  const requiresAck = origin !== 'deescalation' && atLeast(level, 'high')
  const suppression = basis === 'exposure' && !latched ? info.suppressibleBy : null
  const roster = track.roster
  const alert: EngineAlert = {
    id,
    t: now,
    siteId: roster.siteId,
    ...(roster.crewId ? { crewId: roster.crewId } : {}),
    workerId: track.workerId,
    scope: 'worker',
    level,
    actions: [...info.actions],
    consoleActions: [...info.consoleActions],
    reason: why.reason,
    reasonKey: why.reasonKey,
    ...(basis === 'exposure' && info.frame ? { frame: info.frame } : {}),
    basis,
    status: 'active',
    escalatedTo: [],
    acks: [],
    ...(suppression ? { suppression: { reason: 'action_in_force', t: now } } : {}),
  }
  const rec: AlertRecord = {
    alert,
    origin,
    drivingChannels: [...info.driving],
    clinical: info.clinical,
    latched,
    bundleEligible: info.bundleEligible && !latched,
    requiresAck,
    acks: [],
    reasonKey: why.reasonKey,
    ...(basis === 'exposure' && info.frame ? { exposureFrame: info.frame } : {}),
    ...(info.workMinPerHour !== undefined ? { workMinPerHour: info.workMinPerHour } : {}),
    ...(suppression ? { suppressionCause: suppression } : {}),
  }
  addRecord(work, rec)
  work.raised.push(id)
  track.openAlertId = id
  track.belowSince = null
  track.suppressedKey = null
  delete track.resolutionHold
  // Designed suppression: recorded, notified to nobody; the worker's device still shows the guidance.
  if (!suppression) routeWorkerAlert(work, track, rec)
  return rec
}

/**
 * Routes worker alert `rec` (writable; raised in this call, or lifted from designed suppression) as at its raise:
 * worker, supervisor at ≥ high (bundling decided at the end of the batch), first aider, emergency responders, offline
 * SMS. `track` must be writable. Basis: ARCHITECTURE §6.
 */
function routeWorkerAlert(work: Work, track: WorkerAlertTrack, rec: AlertRecord): void {
  const { p, now } = work
  const alert = rec.alert
  const id = alert.id
  const level = alert.level
  const origin = rec.origin
  const roster = track.roster
  const offline = roster.network === 'offline'
  const phrase = phraseActions(alert.actions, rec.workMinPerHour)
  // 1. The worker, always, on their own device (ARCHITECTURE §6).
  push(work, {
    alertId: id,
    to: workerTo(track.workerId),
    channel: offline || level === 'caution' || origin === 'deescalation' ? 'app' : 'push',
    level,
    actions: [...alert.actions],
    reasonKey: rec.reasonKey,
    text:
      origin === 'deescalation'
        ? `${LEVEL_TEXT[level]} — conditions have eased: ${phrase}. Reason: ${alert.reason}`
        : `${LEVEL_TEXT[level]}: ${phrase}. Reason: ${alert.reason}`,
    requiresAck: rec.requiresAck && level !== 'emergency',
    kind: origin === 'deescalation' ? 'deescalation' : 'alert',
  })
  track.told[toldKey(level, alert.actions)] = now

  // 2. Supervisor at ≥ high (bundling decided at the end of the batch).
  if (atLeast(level, p.supervisorMinLevel)) {
    if (origin === 'deescalation') notifySupervisorIndividual(work, id, 'deescalation')
    else if (rec.bundleEligible) work.pending.push(id)
    else notifySupervisorIndividual(work, id, 'alert')
  }

  // 3. First aider on symptom/physiology-driven stops and every emergency.
  if (origin !== 'deescalation' && (level === 'emergency' || (level === 'stop' && rec.clinical))) {
    const responderPhrase = phraseActions(
      alert.actions.filter((x) => !CONFIDENTIAL_ACTIONS.includes(x)),
      rec.workMinPerHour,
    )
    push(work, {
      alertId: id,
      to: { role: 'first_aider' },
      channel: 'push',
      level,
      actions: [...alert.actions],
      reasonKey: rec.reasonKey,
      text:
        level === 'emergency'
          ? `EMERGENCY — go to ${roster.displayName}${roster.crewId ? ` (crew ${roster.crewId})` : ''} now: call 998, cool first, stay with them.`
          : `${roster.displayName}${roster.crewId ? ` (crew ${roster.crewId})` : ''} — first-aid check needed now (${LEVEL_TEXT[level]}): ${responderPhrase}.`,
      requiresAck: true,
      kind: 'alert',
    })
    addRoutedRole(work, rec, 'first_aider')
  }

  // 4. Emergency: buddy and occupational health immediately (ARCHITECTURE §6).
  if (level === 'emergency' && origin !== 'deescalation') {
    push(work, {
      alertId: id,
      to: buddyTo(roster),
      channel: 'push',
      level,
      actions: [...alert.actions],
      reasonKey: rec.reasonKey,
      text: `EMERGENCY — go to ${roster.displayName} now: call 998, cool first, stay with them.`,
      requiresAck: true,
      kind: 'alert',
    })
    push(work, {
      alertId: id,
      to: { role: 'occ_health' },
      channel: 'app',
      level,
      actions: [...alert.actions],
      reasonKey: rec.reasonKey,
      text: `${LEVEL_TEXT[level]} case opened for ${roster.displayName}${roster.crewId ? ` (crew ${roster.crewId})` : ''}. Case details are available only through the consent-checked case record.`,
      requiresAck: true,
      kind: 'alert',
    })
    addRoutedRole(work, rec, 'buddy', 'occ_health')
  }

  // 5. Supervisor SMS fallback when the worker's device is offline [ENG].
  if (offline && atLeast(level, p.supervisorMinLevel) && origin !== 'deescalation') {
    push(work, {
      alertId: id,
      to: supervisorTo(roster),
      channel: 'sms',
      level,
      actions: [...alert.actions],
      reasonKey: 'policy.device_offline',
      text: `${roster.displayName}’s phone is offline — tell them in person: ${LEVEL_TEXT[level]}: ${phraseActions(consoleActionsOf(alert), rec.workMinPerHour)}.`,
      requiresAck: true,
      kind: 'device_offline',
    })
    addRoutedRole(work, rec, 'supervisor')
  }
}

/** Raise unless the repeat-suppression rule applies (never for escalations, clinical alerts or emergencies). `track` must be writable. */
function considerRaise(work: Work, track: WorkerAlertTrack, info: Classified, origin: Exclude<AlertOrigin, 'crew'>, escalation: boolean, carryLatch: boolean): void {
  const { p, now } = work
  const key = toldKey(info.level, info.actions)
  const suppressible = !escalation && !info.clinical && info.level !== 'emergency'
  const last = track.told[key]
  if (suppressible && last !== undefined && now - last < p.repeatSuppressionMin * MINUTE_MS) {
    if (track.suppressedKey !== key) {
      suppressedW(work).push({ t: now, workerId: track.workerId, level: info.level, actions: [...info.actions] })
      track.suppressedKey = key
    }
    return
  }
  raiseWorkerAlert(work, track, info, origin, carryLatch)
}

function handleAssessment(work: Work, a: RiskAssessment, roster: RosterEntry): void {
  const { s, p, now } = work
  let track: WorkerAlertTrack
  if (s.workers[a.workerId]) track = trackW(work, a.workerId)
  else {
    track = { workerId: a.workerId, roster, level: 'safe', lastT: now, openAlertId: null, belowSince: null, told: {}, suppressedKey: null }
    workersW(work)[a.workerId] = track
    work.own.tracks.add(a.workerId)
  }
  track.roster = roster
  const prevLevel = track.level
  const info = classify(a)
  const level = info.level
  // Read-only view of the open alert: every write below goes through recW/closeAlert.
  const open = track.openAlertId ? s.alerts[track.openAlertId] : undefined

  if (open && open.alert.status !== 'resolved') {
    const openId = open.alert.id
    if (RISK_ORDER[level] > RISK_ORDER[open.alert.level] || (level === open.alert.level && info.clinical && !open.clinical)) {
      // Escalate immediately: a higher level — or a symptom/physiology cause appearing at the same level, which changes
      // the routing (first aider) and latches — supersedes the open alert, inheriting its latch.
      const carryLatch = open.latched
      closeAlert(work, openId, 'superseded')
      raiseWorkerAlert(work, track, info, 'escalation', carryLatch)
    } else if (level === open.alert.level) {
      track.belowSince = null
      const before = new Set(open.alert.actions)
      const changed = info.actions.length !== before.size || info.actions.some((x) => !before.has(x))
      // Sticky individual [ENG, protective]: an individual cause joining at the alert's level re-labels the open alert
      // (reason replaced, routing unchanged); it never goes back to 'exposure' while it stays open. Only a channel AT
      // the alert's level counts ({@link individualCauseAt}). A level that no channel explains (the risk engine's
      // de-escalation dwell holding the displayed level while every channel has dropped, e.g. the worker rests in the
      // cabin) is not a new cause, and neither is a lower channel that the drivingChannels() fallback would pick
      // (safety review wave 2c): the open alert keeps its basis.
      const relabel = open.alert.basis === 'exposure' && individualCauseAt(a, open.alert.level)
      // Designed suppression holds while the alert stays exposure and its condition holds at the level; it is lifted,
      // and the alert notified at once, when the alert gains an individual basis or the condition ends (a channel at
      // the level no longer qualifies). A dwell-held level keeps it as it is.
      const suppressed = isAlertSuppressed(open.alert)
      const atLevel = a.channels.some((c) => c.level === open.alert.level)
      const lift = suppressed && (relabel || (atLevel && info.suppressibleBy === null))
      // An individual alert keeps a current reason when its cause changes at the same level (e.g. the projection limit
      // is now reached: the pooled "not cleared" phrase), published in `updated` without notification [ENG].
      const refresh = !relabel && atLevel && open.alert.basis === 'individual' && info.basis === 'individual' && open.alert.reason !== info.reason
      if (changed || relabel || lift || refresh) {
        const rec = recW(work, openId)
        if (refresh) {
          rec.alert.reason = info.reason
          rec.alert.reasonKey = info.reasonKey
          rec.reasonKey = info.reasonKey
        }
        if (relabel) {
          rec.alert.basis = 'individual'
          rec.alert.reason = info.reason
          rec.alert.reasonKey = info.reasonKey
          rec.reasonKey = info.reasonKey
          rec.bundleEligible = false
          delete rec.exposureFrame
          delete rec.alert.frame
        }
        if (changed) {
          const added = info.actions.filter((x) => !before.has(x))
          rec.alert.actions = [...info.actions]
          rec.alert.consoleActions = [...info.consoleActions]
          if (info.workMinPerHour !== undefined) rec.workMinPerHour = info.workMinPerHour
          if (rec.alert.basis === 'exposure' && info.basis === 'exposure') {
            // Keep the site/crew reason in step with the work/rest refreshed above.
            rec.alert.reason = info.reason
            rec.alert.reasonKey = info.reasonKey
            rec.reasonKey = info.reasonKey
            if (info.frame) {
              rec.exposureFrame = info.frame
              rec.alert.frame = info.frame
            }
          }
          const key = toldKey(level, info.actions)
          const last = track.told[key]
          // A suppressed alert tells nobody; a lifted one is notified in full just below.
          if (!suppressed && added.length > 0 && !(last !== undefined && now - last < p.repeatSuppressionMin * MINUTE_MS)) {
            push(work, {
              alertId: openId,
              to: workerTo(track.workerId),
              channel: 'app',
              level,
              actions: [...info.actions],
              reasonKey: rec.reasonKey,
              text: `${LEVEL_TEXT[level]} — updated actions: ${phraseActions(info.actions, rec.workMinPerHour)}.`,
              requiresAck: false,
              kind: 'update',
            })
            track.told[key] = now
          }
        }
        if (lift) {
          rec.alert.suppression = { ...(rec.alert.suppression as AlertSuppression), liftedAt: now }
          rec.notifiedAt = now
          routeWorkerAlert(work, track, rec)
        }
        touch(work, openId)
      }
    } else {
      if (track.belowSince === null) track.belowSince = now
      if (!open.latched && now - track.belowSince >= p.deescalationDwellMin * MINUTE_MS) {
        // A suppressed alert was never notified, so the lower alert is not a "conditions eased" message.
        const neverNotified = isAlertSuppressed(open.alert)
        closeAlert(work, openId, 'auto_dwell')
        // A clinical cause at the lower level is a new case (acknowledged, routed), not a quiet de-escalation.
        if (atLeast(level, p.minAlertLevel)) considerRaise(work, track, info, info.clinical || neverNotified ? 'new' : 'deescalation', false, false)
      }
    }
  } else {
    track.openAlertId = null
    track.belowSince = null
    let held = false
    const hold = track.resolutionHold
    if (hold) {
      const latchActive = a.channels.some((c) => LATCHING_CHANNELS.includes(c.channel) && atLeast(c.level, hold.level))
      const expired = now - hold.t >= p.clinicalResolutionHoldMin * MINUTE_MS
      if (!latchActive || expired || RISK_ORDER[level] > RISK_ORDER[hold.level]) delete track.resolutionHold
      else held = true
    }
    if (!held && atLeast(level, p.minAlertLevel)) {
      considerRaise(work, track, info, 'new', RISK_ORDER[level] > RISK_ORDER[prevLevel], false)
    } else if (!atLeast(level, p.minAlertLevel)) {
      track.suppressedKey = null
    }
  }
  track.level = level
  track.lastT = now
}

/** End-of-batch supervisor routing for bundle-eligible alerts: join/create a crew alert or notify individually. */
function settleSupervisorNotifications(work: Work): void {
  const { s, p, now } = work
  const groups = new Map<string, string[]>()
  for (const id of work.pending) {
    const rec = s.alerts[id]
    if (!rec || rec.alert.status === 'resolved') continue
    // Re-labelled individual later in this batch: the supervisor message must not be lost, so it goes individually.
    if (!rec.bundleEligible) {
      notifySupervisorIndividual(work, id, 'alert')
      continue
    }
    const key = `${rec.alert.crewId ?? ''}|${rec.alert.level}`
    const list = groups.get(key) ?? []
    list.push(id)
    groups.set(key, list)
  }
  for (const [key, ids] of groups) {
    const crewId = s.alerts[ids[0]].alert.crewId
    const level = s.alerts[ids[0]].alert.level
    const individual = (): void => {
      for (const id of ids) notifySupervisorIndividual(work, id, 'alert')
    }
    if (!crewId) {
      individual()
      continue
    }
    const openId = s.crewOpen[key]
    const openCrew = openId ? s.alerts[openId] : undefined
    if (openId && openCrew && openCrew.alert.status !== 'resolved') {
      for (const id of ids) joinCrew(work, openId, id)
      continue
    }
    const candidates = Object.keys(s.alerts).filter((id) => {
      const r = s.alerts[id]
      return (
        r.alert.scope === 'worker' &&
        r.alert.crewId === crewId &&
        r.alert.level === level &&
        r.alert.status !== 'resolved' &&
        r.bundleEligible &&
        !isAlertSuppressed(r.alert) &&
        !r.crewAlertId &&
        now - (r.notifiedAt ?? r.alert.t) <= p.crewBundleWindowMin * MINUTE_MS
      )
    })
    const workers = new Set(candidates.map((id) => s.alerts[id].alert.workerId))
    if (workers.size < p.crewBundleMinWorkers) {
      individual()
      continue
    }
    createCrewAlert(work, crewId, level, candidates)
  }
  work.pending = []
}

/** Adds worker alert `id` to the open crew alert `crewAlertId` (no new supervisor message). */
function joinCrew(work: Work, crewAlertId: string, id: string): void {
  if (!work.s.alerts[id]?.alert.workerId) return
  const rec = recW(work, id)
  const wid = rec.alert.workerId as string
  const crew = recW(work, crewAlertId)
  rec.crewAlertId = crewAlertId
  addRoutedRole(work, rec, 'supervisor')
  touch(work, id)
  const members = crew.alert.memberIds ?? []
  if (!members.includes(wid)) members.push(wid)
  crew.alert.memberIds = members
  const active = crew.activeMemberIds ?? []
  if (!active.includes(wid)) active.push(wid)
  crew.activeMemberIds = active
  // A crew alert shows console actions only (supervisors): its `actions` and `consoleActions` are the same list.
  for (const a of consoleActionsOf(rec.alert)) {
    if (!crew.alert.actions.includes(a)) crew.alert.actions.push(a)
    if (!crew.alert.consoleActions.includes(a)) crew.alert.consoleActions.push(a)
  }
  // The crew shows its strictest work/rest (protective).
  if (rec.workMinPerHour !== undefined && (crew.workMinPerHour === undefined || rec.workMinPerHour < crew.workMinPerHour)) crew.workMinPerHour = rec.workMinPerHour
  crew.alert.reason = crewReason(crew.exposureFrame, crew.alert.level, crew.workMinPerHour, crew.alert.reason, members.length)
  touch(work, crewAlertId)
}

/** Bundles `candidateIds` (exposure worker alerts of one crew at one level) into a new crew alert. */
function createCrewAlert(work: Work, crewId: string, level: RiskLevel, candidateIds: string[]): void {
  const { s, now } = work
  const members = candidateIds
    .map((cid) => s.alerts[cid])
    .sort((x, y) => x.alert.t - y.alert.t || String(x.alert.workerId).localeCompare(String(y.alert.workerId)))
  const first = members[0]
  const id = nextAlertId(s)
  const actions: ActionId[] = []
  for (const m of members) for (const a of consoleActionsOf(m.alert)) if (!actions.includes(a)) actions.push(a)
  const memberIds = [...new Set(members.map((m) => m.alert.workerId as string))]
  const wmphs = members.map((m) => m.workMinPerHour).filter((v): v is number => v !== undefined)
  const workMinPerHour = wmphs.length > 0 ? Math.min(...wmphs) : undefined
  const tracks = memberIds.map((w) => s.workers[w]).filter((t): t is WorkerAlertTrack => t !== undefined)
  const supervisorTargets = [...new Set(tracks.map((t) => t.roster.supervisorId ?? null))]
  const reason = crewReason(first.exposureFrame, level, workMinPerHour, first.alert.reason, memberIds.length)
  const baseReason = reason.replace(/ \(\d+ workers\)$/, '')
  const alert: EngineAlert = {
    id,
    t: now,
    siteId: first.alert.siteId,
    crewId,
    scope: 'crew',
    level,
    actions,
    consoleActions: [...actions],
    reason,
    reasonKey: first.reasonKey,
    ...(first.exposureFrame ? { frame: first.exposureFrame } : {}),
    basis: 'exposure', // crew bundling is exposure-only
    status: 'active',
    escalatedTo: ['supervisor'],
    acks: [],
    memberIds,
  }
  const rec: AlertRecord = {
    alert,
    origin: 'crew',
    drivingChannels: [...new Set(members.flatMap((m) => m.drivingChannels))],
    clinical: false,
    latched: false,
    bundleEligible: false,
    requiresAck: true,
    acks: [],
    reasonKey: first.reasonKey,
    ...(first.exposureFrame ? { exposureFrame: first.exposureFrame } : {}),
    activeMemberIds: [...memberIds],
    supervisorTargets,
    ...(workMinPerHour !== undefined ? { workMinPerHour } : {}),
  }
  addRecord(work, rec)
  crewOpenW(work)[`${crewId}|${level}`] = id
  work.raised.push(id)
  for (const m of members) {
    const member = recW(work, m.alert.id)
    member.crewAlertId = id
    addRoutedRole(work, member, 'supervisor')
    touch(work, m.alert.id)
  }
  const names = tracks.map((t) => t.roster.displayName)
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` +${names.length - 5}` : '')
  for (const sup of supervisorTargets) {
    push(work, {
      alertId: id,
      to: sup ? { role: 'supervisor', id: sup } : { role: 'supervisor' },
      channel: level === 'high' ? 'app' : 'push',
      level,
      actions: [...actions],
      reasonKey: rec.reasonKey,
      text: `Crew ${crewId} — ${memberIds.length} workers at ${LEVEL_TEXT[level]} (${shown}): ${phraseActions(actions, workMinPerHour)}. Reason: ${baseReason}`,
      requiresAck: true,
      kind: 'crew_alert',
    })
  }
}

// ─────────────────────────────── Timers ───────────────────────────────

function runTimers(work: Work): void {
  const { s, p, now } = work
  for (const id of Object.keys(s.alerts)) {
    // Read-only checks first; a timer that fires takes the writable copy (recW) before changing anything.
    const cur = s.alerts[id]
    // A suppressed alert asked no one, so no timer runs for it; a lifted one counts from its first notification.
    if (cur.alert.status === 'resolved' || !cur.requiresAck || cur.alert.ack || isAlertSuppressed(cur.alert)) continue
    const ageMs = now - (cur.notifiedAt ?? cur.alert.t)
    if (cur.alert.scope === 'worker') {
      const track = cur.alert.workerId ? s.workers[cur.alert.workerId] : undefined
      if (!track) continue
      const roster = track.roster
      const name = roster.displayName
      if (cur.alert.level === 'stop') {
        if (cur.stopEscalatedAt === undefined && ageMs >= p.stopAckTimeoutMin * MINUTE_MS) {
          const rec = recW(work, id)
          const al = rec.alert
          rec.stopEscalatedAt = now
          al.status = 'escalated'
          markEscalated(work, rec)
          addRoutedRole(work, rec, 'supervisor', 'buddy')
          touch(work, id)
          const mins = Math.floor(ageMs / MINUTE_MS)
          push(work, {
            alertId: id,
            to: supervisorTo(roster),
            channel: 'push',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.stop_unacknowledged',
            text: `${name} has not acknowledged STOP WORK for ${mins} min — check on them now.`,
            requiresAck: true,
            kind: 'escalation',
          })
          push(work, {
            alertId: id,
            to: buddyTo(roster),
            channel: 'push',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.stop_unacknowledged',
            text: `Check on ${name} now: STOP WORK was not acknowledged. Make sure they rest in the shade.`,
            requiresAck: true,
            kind: 'escalation',
          })
        }
      } else if (cur.alert.level === 'emergency') {
        const due =
          ageMs >= p.emergencyAckTimeoutMin * MINUTE_MS &&
          (cur.renotifiedAt === undefined || now - cur.renotifiedAt >= p.emergencyRepeatMin * MINUTE_MS)
        if (due) {
          const rec = recW(work, id)
          const al = rec.alert
          rec.renotifiedAt = now
          al.status = 'escalated'
          markEscalated(work, rec)
          addRoutedRole(work, rec, 'supervisor', 'first_aider', 'buddy', 'occ_health')
          touch(work, id)
          const text = `EMERGENCY not acknowledged — ${name}${roster.crewId ? ` (crew ${roster.crewId})` : ''} needs help now: call 998, cool first, stay with them.`
          const targets: Array<[Notification['to'], NotificationChannel]> = [
            [supervisorTo(roster), 'voice'],
            [{ role: 'first_aider' }, 'voice'],
            [buddyTo(roster), 'push'],
            [{ role: 'occ_health' }, 'app'],
          ]
          for (const [to, channel] of targets) {
            push(work, { alertId: id, to, channel, level: al.level, actions: [...al.actions], reasonKey: 'policy.emergency_unacknowledged', text, requiresAck: true, kind: 'renotify' })
          }
          push(work, {
            alertId: id,
            to: { role: 'worker' },
            channel: 'siren',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.emergency_unacknowledged',
            text: `EMERGENCY${roster.crewId ? ` at crew ${roster.crewId}` : ''}: responders needed now — call 998, cool first.`,
            requiresAck: false,
            kind: 'siren',
          })
        }
      } else if (cur.alert.level === 'high') {
        if (cur.remindedAt === undefined && ageMs >= p.highAckTimeoutMin * MINUTE_MS && !cur.crewAlertId) {
          const rec = recW(work, id)
          const al = rec.alert
          rec.remindedAt = now
          touch(work, id)
          push(work, {
            alertId: id,
            to: supervisorTo(roster),
            channel: 'app',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.high_unacknowledged',
            text: `Reminder: ${name} — HIGH RISK alert not acknowledged for ${Math.floor(ageMs / MINUTE_MS)} min: ${phraseActions(consoleActionsOf(al), rec.workMinPerHour)}.`,
            requiresAck: true,
            kind: 'reminder',
          })
        }
      }
    } else if (cur.alert.scope === 'crew') {
      const targets = cur.supervisorTargets && cur.supervisorTargets.length > 0 ? [...cur.supervisorTargets] : [null]
      const n = (cur.activeMemberIds ?? cur.alert.memberIds ?? []).length
      if (cur.alert.level === 'stop' && cur.stopEscalatedAt === undefined && ageMs >= p.stopAckTimeoutMin * MINUTE_MS) {
        const rec = recW(work, id)
        const al = rec.alert
        rec.stopEscalatedAt = now
        al.status = 'escalated'
        markEscalated(work, rec)
        touch(work, id)
        for (const sup of targets) {
          push(work, {
            alertId: id,
            to: sup ? { role: 'supervisor', id: sup } : { role: 'supervisor' },
            channel: 'voice',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.stop_unacknowledged',
            text: `Crew ${al.crewId ?? ''} STOP WORK not acknowledged (${n} workers) — confirm the crew has stopped.`,
            requiresAck: true,
            kind: 'escalation',
          })
        }
      } else if (cur.alert.level === 'high' && cur.remindedAt === undefined && ageMs >= p.highAckTimeoutMin * MINUTE_MS) {
        const rec = recW(work, id)
        const al = rec.alert
        rec.remindedAt = now
        touch(work, id)
        for (const sup of targets) {
          push(work, {
            alertId: id,
            to: sup ? { role: 'supervisor', id: sup } : { role: 'supervisor' },
            channel: 'app',
            level: al.level,
            actions: [...al.actions],
            reasonKey: 'policy.high_unacknowledged',
            text: `Reminder: crew ${al.crewId ?? ''} HIGH RISK alert (${n} workers) not acknowledged for ${Math.floor(ageMs / MINUTE_MS)} min.`,
            requiresAck: true,
            kind: 'reminder',
          })
        }
      }
    }
  }
}

// ─────────────────────────────── Public API ───────────────────────────────

/**
 * A fresh, empty alert engine state (JSON-serialisable). `idPrefix` namespaces alert/notification ids when several
 * engines run (e.g. per device and on the site gateway) [ENG].
 */
export function createAlertEngine(opts: { idPrefix?: string } = {}): AlertEngineState {
  return { version: 1, idPrefix: opts.idPrefix ?? '', alertSeq: 0, notificationSeq: 0, alerts: {}, workers: {}, crewOpen: {}, suppressed: [] }
}

/**
 * Apply one batch of risk assessments (any number of workers, processed in time order) at `ctx.now` — the alert
 * policy of ARCHITECTURE §6. The acknowledgement timers of {@link tick} run first (idempotent), so callers that only
 * call this function still get every escalation.
 *
 * Per worker: a level above the open alert's level escalates immediately (new alert, never suppressed, inherits a
 * clinical latch); the same level keeps the alert (actions updated in place); a lower level starts the de-escalation
 * dwell — exposure alerts auto-resolve after `deescalationDwellMin` below and, when the level is still ≥ caution, a
 * lower "conditions eased" alert (no acknowledgement) replaces them; latched alerts wait for {@link resolve}. With no
 * open alert, a level ≥ `minAlertLevel` raises an alert unless the same level + actions were told to that worker within
 * `repeatSuppressionMin` and the level did not rise (suppressed repeats are logged in `state.suppressed`). Clinical
 * alerts and emergencies are never suppressed.
 *
 * Basis of each alert ({@link AlertBasis}): set at raise from the channels at the alert level. A carried clinical latch
 * makes it individual. While an exposure alert stays open at the same level, an individual cause joining re-labels it
 * individual (sticky): its reason is replaced, and it is published in `updated` without new routing. A level that no
 * channel explains (the risk engine's de-escalation dwell holding the displayed level) is not a cause and does not
 * re-label an open alert. Crew alerts are exposure only.
 *
 * Basis: ARCHITECTURE.md §1.3–§1.5, §5, §6; physio_and_clinical.md §10.7 (first aider / 998 routing).
 */
export function processAssessments(
  state: AlertEngineState,
  assessments: readonly RiskAssessment[],
  ctx: AlertContext,
  opts?: Partial<AlertPolicy>,
): ProcessResult {
  const work = begin(state, ctx.now, opts)
  runTimers(work)
  const ordered = assessments.map((a, i) => ({ a, i })).sort((x, y) => x.a.t - y.a.t || x.i - y.i)
  for (const { a } of ordered) {
    const prev = work.s.workers[a.workerId]
    const base = ctx.roster[a.workerId] ?? fallbackRoster(a.workerId, prev)
    const network = ctx.roster[a.workerId]?.network ?? a.dataQuality?.network ?? base.network ?? 'online'
    handleAssessment(work, a, { ...base, network })
  }
  settleSupervisorNotifications(work)
  return finish(work)
}

/**
 * Acknowledgement timers at `now` (ARCHITECTURE §6; idempotent — each step fires once, emergencies repeat every
 * `emergencyRepeatMin`): stop unacknowledged for `stopAckTimeoutMin` → status 'escalated', supervisor + buddy notified;
 * emergency unacknowledged by a responder for `emergencyAckTimeoutMin` → supervisor and first aider by voice, buddy,
 * occupational health, plus the crew siren; high unacknowledged for `highAckTimeoutMin` → supervisor reminder (bundled
 * members are covered by their crew alert's reminder). Crew alerts: stop → supervisor voice escalation; high → reminder.
 */
export function tick(state: AlertEngineState, now: number, opts?: Partial<AlertPolicy>): TickResult {
  const work = begin(state, now, opts)
  runTimers(work)
  const out = finish(work)
  return { state: out.state, updated: out.updated, notifications: out.notifications }
}

/**
 * Record an acknowledgement. Worker alerts accept {@link ACK_ROLES}; crew alerts {@link CREW_ROLES}. The first counting
 * acknowledgement sets `alert.ack` and status 'acknowledged' (a resolved alert keeps 'resolved'); for an emergency only
 * {@link EMERGENCY_RESPONDER_ROLES} count — the worker's own acknowledgement is recorded but the re-notification goes on.
 * Every permitted acknowledgement is appended to `alert.acks` (and the record's `acks`), in order. A refused or unknown
 * acknowledgement returns the input state unchanged.
 */
export function acknowledge(state: AlertEngineState, alertId: string, role: Role, t: number): AckResult {
  const cur = state.alerts[alertId]
  if (!cur) return { state, ok: false, alert: null, counted: false, reason: 'unknown_alert' }
  const allowed = cur.alert.scope === 'crew' ? CREW_ROLES : ACK_ROLES
  if (!allowed.includes(role)) return { state, ok: false, alert: copyAlert(cur.alert), counted: false, reason: 'role_not_permitted' }
  const work = begin(state, t)
  const rec = recW(work, alertId)
  rec.acks.push({ role, t })
  rec.alert.acks.push({ role, t })
  const counted = rec.alert.level === 'emergency' ? EMERGENCY_RESPONDER_ROLES.includes(role) : true
  if (counted && !rec.alert.ack) {
    rec.alert.ack = { role, t }
    if (rec.alert.status !== 'resolved') rec.alert.status = 'acknowledged'
  }
  return { state: work.s, ok: true, alert: copyAlert(rec.alert), counted }
}

/**
 * Resolve an alert by hand. Latched (symptom/physiology-driven) alerts: {@link CLINICAL_RESOLVER_ROLES} only
 * (ARCHITECTURE §1.4 — after a symptom-free re-check); exposure alerts: {@link EXPOSURE_RESOLVER_ROLES}; crew alerts:
 * {@link CREW_ROLES} (members keep their own alerts). Resolving a latched alert starts the resolution hold
 * ({@link CLINICAL_RESOLUTION_HOLD_MIN}). If the condition persists, the next assessment may raise the alert again
 * (exposure alerts subject to repeat suppression). A refused, unknown or already-resolved alert returns the input state
 * unchanged.
 */
export function resolve(state: AlertEngineState, alertId: string, role: Role, t: number): ResolveResult {
  const cur = state.alerts[alertId]
  if (!cur) return { state, ok: false, alert: null, updated: [], reason: 'unknown_alert' }
  if (cur.alert.status === 'resolved') return { state, ok: true, alert: copyAlert(cur.alert), updated: [] }
  const allowed = cur.alert.scope === 'crew' ? CREW_ROLES : cur.latched ? CLINICAL_RESOLVER_ROLES : EXPOSURE_RESOLVER_ROLES
  if (!allowed.includes(role)) return { state, ok: false, alert: copyAlert(cur.alert), updated: [], reason: 'role_not_permitted' }
  const work = begin(state, t)
  closeAlert(work, alertId, 'manual', role)
  const workerId = cur.alert.workerId
  if (cur.alert.scope === 'worker' && cur.latched && workerId && work.s.workers[workerId]) {
    trackW(work, workerId).resolutionHold = { level: cur.alert.level, t }
  }
  const out = finish(work)
  return { state: out.state, ok: true, alert: copyAlert(work.s.alerts[alertId].alert), updated: out.updated }
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const v = [...xs].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Safety-measure and pilot-reporting counts from a log of alerts (later versions of the same id replace earlier ones)
 * and notifications: alerts by level and scope, acknowledgement rate and median time to acknowledge, escalations by
 * timer, suppressed repeats (pass `state.suppressed` or a count), designed suppression (`designedSuppression`: alerts
 * recorded but notified to nobody: still suppressed or lifted), crew-bundled worker alerts, notifications
 * by channel, role and kind, and the split by basis (`byBasis`: exposure vs individual alerts, notifications,
 * acknowledgement requests and unacknowledged alerts). Basis: ARCHITECTURE.md §6, §8 (alert burden, false alarms per
 * worker-shift); ANSI/ISA-18.2-2016 (suppressed alarms are recorded and reported, not announced).
 */
export function alertStats(
  alerts: readonly Alert[],
  notifications: readonly Notification[],
  suppressed: number | readonly SuppressionEvent[] = 0,
): AlertStats {
  const latest = new Map<string, Alert>()
  for (const a of alerts) latest.set(a.id, a)
  const byLevel = { safe: 0, caution: 0, high: 0, stop: 0, emergency: 0 } as Record<RiskLevel, number>
  const byScope = { worker: 0, crew: 0, site: 0 } as Record<Alert['scope'], number>
  const needAck = new Set(notifications.filter((n) => n.requiresAck).map((n) => n.alertId))
  const tta: number[] = []
  const ttaByLevel: Partial<Record<RiskLevel, number[]>> = {}
  let acknowledged = 0
  let unacknowledged = 0
  let resolved = 0
  let crewBundledWorkerAlerts = 0
  const zero = (): BasisCounts => ({ alerts: 0, notifications: 0, notificationsRequiringAck: 0, unacknowledged: 0 })
  const byBasis: Record<AlertBasis, BasisCounts> = { exposure: zero(), individual: zero() }
  const designedSuppression: DesignedSuppressionStats = { alerts: 0, stillSuppressed: 0, lifted: 0 }
  // A missing basis (older producers) counts as 'individual' [ENG]: the exposure share is never overstated.
  const basisOfAlert = (a: Alert | undefined): AlertBasis => (a?.basis === 'exposure' ? 'exposure' : 'individual')
  for (const a of latest.values()) {
    byLevel[a.level] += 1
    byScope[a.scope] += 1
    const b = byBasis[basisOfAlert(a)]
    b.alerts += 1
    if (a.ack) {
      acknowledged += 1
      const m = (a.ack.t - a.t) / MINUTE_MS
      tta.push(m)
      ;(ttaByLevel[a.level] ??= []).push(m)
    } else if (needAck.has(a.id)) {
      unacknowledged += 1
      b.unacknowledged += 1
    }
    if (a.status === 'resolved') resolved += 1
    if (a.scope === 'crew') crewBundledWorkerAlerts += a.memberIds?.length ?? 0
    if (a.suppression) {
      designedSuppression.alerts += 1
      if (a.suppression.liftedAt === undefined) designedSuppression.stillSuppressed += 1
      else designedSuppression.lifted += 1
    }
  }
  for (const n of notifications) {
    const sent = (n as { basis?: AlertBasis }).basis
    const b = byBasis[sent === 'exposure' || sent === 'individual' ? sent : basisOfAlert(latest.get(n.alertId))]
    b.notifications += 1
    if (n.requiresAck) b.notificationsRequiringAck += 1
  }
  const distinct = (pred: (n: Notification) => boolean): Set<string> => new Set(notifications.filter(pred).map((n) => n.alertId))
  const stopUnack = distinct((n) => n.kind === 'escalation')
  const renotified = distinct((n) => n.kind === 'renotify')
  const reminders = distinct((n) => n.kind === 'reminder')
  const escalatedIds = new Set<string>([...stopUnack, ...renotified])
  for (const a of latest.values()) if (a.status === 'escalated') escalatedIds.add(a.id)
  const notificationsByChannel = { app: 0, push: 0, sms: 0, voice: 0, siren: 0 } as Record<NotificationChannel, number>
  const notificationsByRole: Partial<Record<Role, number>> = {}
  const notificationsByKind: Partial<Record<NotificationKind, number>> = {}
  for (const n of notifications) {
    notificationsByChannel[n.channel] += 1
    notificationsByRole[n.to.role] = (notificationsByRole[n.to.role] ?? 0) + 1
    notificationsByKind[n.kind] = (notificationsByKind[n.kind] ?? 0) + 1
  }
  const medianTimeToAckMinByLevel: Partial<Record<RiskLevel, number>> = {}
  for (const lvl of RISK_LEVELS) {
    const m = median(ttaByLevel[lvl] ?? [])
    if (m !== null) medianTimeToAckMinByLevel[lvl] = m
  }
  return {
    alerts: latest.size,
    byLevel,
    byScope,
    byBasis,
    acknowledged,
    unacknowledged,
    resolved,
    medianTimeToAckMin: median(tta),
    medianTimeToAckMinByLevel,
    escalations: {
      alertsEscalated: escalatedIds.size,
      stopUnacknowledged: stopUnack.size,
      emergencyRenotified: renotified.size,
      highReminders: reminders.size,
    },
    suppressed: typeof suppressed === 'number' ? suppressed : suppressed.length,
    designedSuppression,
    crewBundledWorkerAlerts,
    notifications: notifications.length,
    notificationsByChannel,
    notificationsByRole,
    notificationsByKind,
  }
}
