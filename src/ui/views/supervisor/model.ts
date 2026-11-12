/**
 * Pure view-model helpers of the supervisor console (#/supervisor). No React and no stores: every input is a value the
 * console already received through the state selectors (SupervisorBoard, CrewBoardRow, AlertItem), the day plan (which a
 * supervisor may see, docs/dev/engine-api-wave2d.md §0) or alert workflow metadata (role and time only).
 *
 * Privacy rules applied here (ARCHITECTURE §1 principle 5, §2, §7; engine-api-wave2d §0):
 * - nothing below reads heart rate, strain estimates, flags, symptoms, hydration or per-worker confidence;
 * - the pooled driver ids are the only per-worker statuses derived from drivers, and they are shown without a reason;
 * - workflow metadata is reduced to acknowledgement roles/times and the escalation time.
 */
import type { ActionId, Alert, EnvSource, RiskLevel, Role, Task, WorkClass } from '../../../engine/types'
import { RISK_ORDER } from '../../../engine/types'
import type { BlockHour, CrewPlan, DayPlan, MemberCapHour, PlanBasis, PlanBlock, PlanLimitedBy, PlanWarning, PlanWarningCode } from '../../../engine/planner'
import type { WorkerEnvStatus } from '../../../engine/risk'
import type { SiteHour } from '../../../sim/types'
import type { AlertItem, CrewBoardRow } from '../../../state/selectors'
import { HOUR_MS, MINUTE_MS, formatLocalHhmm } from '../../../engine/time'

// ─────────────────────────────── Levels and filters ───────────────────────────────

/** Crew-board level filter: every worker, or workers at or above a level. */
export type LevelFilter = 'all' | 'caution' | 'high' | 'stop'

export const LEVEL_FILTER_OPTIONS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All levels' },
  { id: 'caution', label: 'Caution or above' },
  { id: 'high', label: 'High risk or above' },
  { id: 'stop', label: 'Stop work or above' },
]

/** True when `level` is at or above the filter's minimum. A row without a level passes only 'all'. */
export function passesLevelFilter(level: RiskLevel | null | undefined, filter: LevelFilter): boolean {
  if (filter === 'all') return true
  if (!level) return false
  return RISK_ORDER[level] >= RISK_ORDER[filter]
}

// ─────────────────────────────── Acknowledgement state ───────────────────────────────

/** Status values of an alert or of a row's open case (privacy.ts AckStatus). */
export type AckLike = 'none' | 'active' | 'acknowledged' | 'escalated' | 'resolved'

/** Nobody has acknowledged yet (an emergency counts only a responder's acknowledgement: the engine keeps it open). */
export function awaitingAck(status: AckLike | undefined): boolean {
  return status === 'active' || status === 'escalated'
}

export const ACK_STATUS_LABELS: Readonly<Record<AckLike, string>> = {
  none: 'No open alert',
  active: 'Needs acknowledgement',
  acknowledged: 'Acknowledged',
  escalated: 'Escalated, not acknowledged',
  resolved: 'Resolved',
}

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  worker: 'Worker',
  buddy: 'Buddy',
  supervisor: 'Supervisor',
  first_aider: 'First aider',
  occ_health: 'Occupational health',
  hse_manager: 'HSE manager',
  regulator: 'Regulator',
  employer_hr: 'Employer HR',
}

/** Workflow metadata of one alert: acknowledgement roles and times, and when it was first escalated. */
export interface AlertWorkflow {
  acks: ReadonlyArray<{ role: Role; t: number }>
  escalatedAt: number | null
}

/**
 * Workflow metadata of the alerts the console already shows (ids from the board), reduced to roles and times. The
 * board's AlertItem keeps only the first counted acknowledgement; the console needs every acknowledgement (did the
 * supervisor acknowledge after the worker?) and the durable escalation time (ARCHITECTURE §6). Nothing else is read.
 */
export function workflowIndex(alerts: readonly Alert[] | null | undefined, ids: ReadonlySet<string>): Map<string, AlertWorkflow> {
  const out = new Map<string, AlertWorkflow>()
  if (!alerts || ids.size === 0) return out
  for (const a of alerts) {
    if (!ids.has(a.id)) continue
    const acks = (a.acks ?? (a.ack ? [a.ack] : [])).map((k) => ({ role: k.role, t: k.t }))
    out.set(a.id, { acks, escalatedAt: a.escalatedAt ?? null })
  }
  return out
}

/** True when a supervisor acknowledgement is on record. */
export function supervisorAcked(wf: AlertWorkflow | undefined, item?: Pick<AlertItem, 'ack'>): boolean {
  if (wf) return wf.acks.some((k) => k.role === 'supervisor')
  return item?.ack?.role === 'supervisor'
}

/** Median of a list of numbers, or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Median minutes from an alert being raised to the first supervisor acknowledgement, over today's alerts in the
 * console's scope at or above `minLevel` that were not under designed suppression (nobody was asked to acknowledge
 * those). Reads id, time, level, scope, crew/worker id, suppression and acknowledgement times only.
 */
export function medianAckMinutes(
  alerts: readonly Alert[] | null | undefined,
  inScope: (a: Pick<Alert, 'scope' | 'crewId' | 'workerId'>) => boolean,
  minLevel: RiskLevel = 'high',
): { median: number | null; n: number } {
  const mins: number[] = []
  for (const a of alerts ?? []) {
    if (RISK_ORDER[a.level] < RISK_ORDER[minLevel] || !inScope(a)) continue
    if (a.suppression && a.suppression.liftedAt === undefined) continue
    const first = (a.acks ?? (a.ack ? [a.ack] : [])).find((k) => k.role === 'supervisor')
    if (first) mins.push(Math.max(0, (first.t - a.t) / MINUTE_MS))
  }
  return { median: median(mins), n: mins.length }
}

// ─────────────────────────────── Crew board rows ───────────────────────────────

/** Pooled supervisor driver ids (engine/privacy.ts POOLED_DRIVER_IDS): statuses shown without any reason. */
export const NOT_CLEARED_ID = 'not_cleared_for_heat_work'
export const DEVICE_REST_ID = 'device_directed_rest'

/** Operational statuses of a row, from the released fields only. */
export interface RowStatus {
  /** Pooled "Not cleared for heat work now: assign cooler work" (any private cause). */
  notCleared: boolean
  /** Pooled "Device-directed rest" (shown neutral, never with a reason). */
  deviceRest: boolean
  /** The device asks for another task (console action 'rotate_task'). */
  rotate: boolean
}

export function rowStatus(row: Pick<CrewBoardRow, 'data'>): RowStatus {
  const drivers = row.data.drivers_nonclinical ?? []
  const actions = row.data.actions ?? []
  return {
    notCleared: drivers.some((d) => d.id === NOT_CLEARED_ID),
    deviceRest: drivers.some((d) => d.id === DEVICE_REST_ID),
    rotate: actions.includes('rotate_task'),
  }
}

/**
 * Crew-board order: severity first, then rows waiting for an acknowledgement, then name. Rows without data (no
 * assessment yet) go last. Pure; returns a new array.
 */
export function sortRows<T extends Pick<CrewBoardRow, 'data' | 'workerId'>>(rows: readonly T[], needsAck: (row: T) => boolean): T[] {
  const sev = (r: T): number => (r.data.level ? RISK_ORDER[r.data.level] : -1)
  return [...rows].sort((a, b) => {
    const d = sev(b) - sev(a)
    if (d !== 0) return d
    const n = Number(needsAck(b)) - Number(needsAck(a))
    if (n !== 0) return n
    return (a.data.displayName ?? a.workerId).localeCompare(b.data.displayName ?? b.workerId)
  })
}

// ─────────────────────────────── Work/rest cycle guide ───────────────────────────────

/** The current work/rest phase implied by a work rate. */
export interface CycleGuide {
  kind: 'continuous' | 'work' | 'rest' | 'no_work'
  /** Minutes left in the current phase (0 for continuous / no_work). */
  remainingMin: number
  /** Length of the current phase, minutes. */
  phaseMin: number
  /** Whole work minutes per hour (floored, protective) and the matching rest. */
  workMin: number
  restMin: number
}

/** Anchor of a cycle: the plan block-hour the crew is in (start, wall minutes, planned bout). */
export interface CycleAnchor {
  startT: number
  wallMin: number
  boutMin: number
}

/**
 * The work/rest phase at `now` for a work rate of `workMinPerHour` min/h (the released operational field). The cycle
 * starts at the plan block-hour (work bout first, then rest, as the plan lays it out: planner.ts BlockHour.boutMin) or,
 * without a plan anchor, at the top of the clock hour. Work minutes are floored and never exceed the planned bout, so
 * the guide never shows more work than the device or the plan allows (protective rounding, as i18n actionText). A
 * guide only: the worker's device decides.
 */
export function cycleGuide(now: number, workMinPerHour: number | null | undefined, anchor: CycleAnchor | null): CycleGuide {
  const w = typeof workMinPerHour === 'number' && Number.isFinite(workMinPerHour) ? Math.floor(workMinPerHour + 1e-9) : 0
  if (w >= 60) return { kind: 'continuous', remainingMin: 0, phaseMin: 0, workMin: 60, restMin: 0 }
  if (w <= 0) return { kind: 'no_work', remainingMin: 0, phaseMin: 0, workMin: 0, restMin: 60 }
  const valid = anchor !== null && anchor.wallMin > 0 && now >= anchor.startT && now < anchor.startT + anchor.wallMin * MINUTE_MS
  const startT = valid ? anchor.startT : now - (((now % HOUR_MS) + HOUR_MS) % HOUR_MS)
  const cycleMin = valid ? anchor.wallMin : 60
  const workLen = valid ? Math.max(0, Math.min(anchor.boutMin, Math.floor((w * anchor.wallMin) / 60 + 1e-9))) : w
  const elapsed = (now - startT) / MINUTE_MS
  if (workLen <= 0) return { kind: 'no_work', remainingMin: 0, phaseMin: 0, workMin: 0, restMin: 60 }
  if (elapsed < workLen) return { kind: 'work', remainingMin: workLen - elapsed, phaseMin: workLen, workMin: w, restMin: 60 - w }
  return { kind: 'rest', remainingMin: Math.max(0, cycleMin - elapsed), phaseMin: Math.max(1, cycleMin - workLen), workMin: w, restMin: 60 - w }
}

// ─────────────────────────────── Day plan ───────────────────────────────

/** The plan block containing `t`, or null. */
export function blockAt(plan: Pick<CrewPlan, 'blocks'> | null | undefined, t: number): PlanBlock | null {
  if (!plan) return null
  return plan.blocks.find((b) => t >= b.startT && t < b.endT) ?? null
}

/** The block-hour of a block containing `t`, or null. */
export function blockHourAt(block: Pick<PlanBlock, 'hours'> | null | undefined, t: number): BlockHour | null {
  if (!block) return null
  return block.hours.find((h) => t >= h.startT && t < h.startT + h.wallMin * MINUTE_MS) ?? null
}

/** A member's personal cap (acclimatisation schedule) in the block-hour containing `t`, or null. */
export function memberCapAt(plan: Pick<CrewPlan, 'memberCaps'> | null | undefined, workerId: string, t: number): MemberCapHour | null {
  const caps = plan?.memberCaps[workerId]
  if (!caps) return null
  return caps.find((c) => t >= c.startT && t < c.startT + c.wallMin * MINUTE_MS) ?? null
}

/** Highest personal cap of a member today (min/h), or null when the member follows the crew layout. */
export function memberCapMax(plan: Pick<CrewPlan, 'memberCaps'> | null | undefined, workerId: string): number | null {
  const caps = plan?.memberCaps[workerId]
  if (!caps || caps.length === 0) return null
  return Math.max(...caps.map((c) => Math.floor(c.workMinPerHour)))
}

/**
 * The text a supervisor may see for a member on an acclimatisation schedule: the operational cap only, never the reason
 * or the history (engine-api-wave2d §0: "acclimatisation schedule: max N min/h").
 */
export function acclimatisationText(cap: Pick<MemberCapHour, 'workMinPerHour'> | null, dayMax: number | null): string | null {
  if (cap) {
    const w = Math.floor(cap.workMinPerHour)
    return w <= 0 ? 'Acclimatisation schedule: no heat work this hour' : `Acclimatisation schedule: max ${w} min/h`
  }
  if (dayMax === null) return null
  return dayMax <= 0 ? 'Acclimatisation schedule: no heat work in today’s plan' : `Acclimatisation schedule: max ${dayMax} min/h today`
}

/** One change of the plan against the naive plan (same tasks at their natural time, no heat controls). */
export interface PlanChange {
  taskId: string
  taskName: string
  kind: 'moved' | 'deferred' | 'kept'
  naiveStart: string
  planStart: string | null
}

/** Task-level changes versus the naive plan, in naive order. */
export function planChanges(plan: Pick<CrewPlan, 'blocks' | 'naive'>, taskName: (id: string) => string): PlanChange[] {
  const firstPlan = new Map<string, string>()
  for (const b of plan.blocks) if (b.taskId && !firstPlan.has(b.taskId)) firstPlan.set(b.taskId, b.start)
  const seen = new Set<string>()
  const out: PlanChange[] = []
  for (const nb of plan.naive.blocks) {
    if (seen.has(nb.taskId)) continue
    seen.add(nb.taskId)
    const planStart = firstPlan.get(nb.taskId) ?? null
    out.push({
      taskId: nb.taskId,
      taskName: taskName(nb.taskId),
      kind: planStart === null ? 'deferred' : planStart === nb.start ? 'kept' : 'moved',
      naiveStart: nb.start,
      planStart,
    })
  }
  return out
}

/** Share of the naive plan's heat exposure that the plan removes, 0–1, or null without a naive exposure. */
export function exposureCut(plan: Pick<CrewPlan, 'exposureReduction' | 'naive'>): number | null {
  const naive = plan.naive.exposureCMin
  if (!(naive > 0)) return null
  return Math.max(0, Math.min(1, plan.exposureReduction / naive))
}

/** Warnings of one crew, most actionable first. */
export function crewWarnings(dayPlan: Pick<DayPlan, 'warnings'> | null | undefined, crewId: string): PlanWarning[] {
  if (!dayPlan) return []
  const rank = (c: PlanWarningCode): number => WARNING_ORDER.indexOf(c)
  return dayPlan.warnings.filter((w) => w.crewId === undefined || w.crewId === crewId).sort((a, b) => rank(a.code) - rank(b.code))
}

const WARNING_ORDER: readonly PlanWarningCode[] = [
  'unacclimatized_reassign',
  'phs_rest_limit',
  'phs_not_feasible',
  'rest_exceeds_limit',
  'acclimatization_ramp',
  'task_deferred',
  'task_incomplete',
  'fixed_task_moved',
  'phs_screen_unavailable',
  'no_forecast',
  'forecast_gap',
  'unknown_worker',
  'empty_crew',
  'invalid_task',
  'invalid_shift',
]

export const WARNING_TITLES: Readonly<Record<PlanWarningCode, string>> = {
  invalid_shift: 'Shift times invalid',
  no_forecast: 'No forecast for the shift',
  forecast_gap: 'Forecast gap',
  unknown_worker: 'Unknown crew member',
  empty_crew: 'Crew has no members',
  invalid_task: 'Task definition invalid',
  task_deferred: 'Task deferred',
  task_incomplete: 'Task not fully scheduled',
  fixed_task_moved: 'Fixed task moved',
  unacclimatized_reassign: 'Reassign: not yet acclimatised',
  acclimatization_ramp: 'Acclimatisation schedule',
  rest_exceeds_limit: 'Rest alone exceeds a limit',
  phs_not_feasible: 'Heat-strain screen: no work possible',
  phs_screen_unavailable: 'Heat-strain screen not run',
  phs_rest_limit: 'Heat-strain screen: rest-only limit',
}

/** Warning codes that ask the supervisor to act today (reassign or change the work). */
export const ACTION_WARNINGS: ReadonlySet<PlanWarningCode> = new Set<PlanWarningCode>([
  'unacclimatized_reassign',
  'phs_rest_limit',
  'phs_not_feasible',
  'rest_exceeds_limit',
])

/**
 * Replaces pseudonymous worker ids and crew ids in planner texts by the display names the console already received
 * (planner texts name members by id). Longest ids first, so no id is a prefix of another's replacement.
 */
export function withNames(text: string, names: ReadonlyMap<string, string>): string {
  const ids = [...names.keys()].filter((id) => id.length > 0).sort((a, b) => b.length - a.length)
  let out = text
  for (const id of ids) out = out.split(id).join(names.get(id) as string)
  return out
}

export const LIMITED_BY_LABELS: Readonly<Record<PlanLimitedBy, string>> = {
  none: 'No limit',
  niosh_acgih: 'NIOSH/ACGIH table',
  rule_pack: 'ADOSH zone rule',
  phs: 'ISO 7933 screen',
}

/** One-letter key of what set a task-hour (screen matrix). */
export const LIMITED_BY_KEYS: Readonly<Record<PlanLimitedBy, string>> = { none: '', niosh_acgih: 'N', rule_pack: 'R', phs: 'P' }

// ─────────────────────────────── Alerts ───────────────────────────────

/** A crew-scope exposure alert with the members' own exposure alerts folded in. */
export interface CrewCondition {
  alert: AlertItem
  members: AlertItem[]
}

/** The alert feed split by presentation (docs/dev/wave2c-alerts.md "How the UI should present…"). */
export interface AlertGroups {
  /** About one person: prominent, actionable. Emergencies first, then newest first. */
  individual: AlertItem[]
  /** Crew-bundled site conditions (calm banners), newest first. */
  crew: CrewCondition[]
  /** Site-scope conditions, newest first. */
  site: AlertItem[]
  /** Worker-scope exposure alerts no open crew alert covers (compact rows), newest first. */
  worker: AlertItem[]
}

export function groupAlerts(alerts: readonly AlertItem[]): AlertGroups {
  const newest = (a: AlertItem, b: AlertItem): number => b.t - a.t
  const individual = alerts
    .filter((a) => a.basis === 'individual')
    .sort((a, b) => Number(b.level === 'emergency') - Number(a.level === 'emergency') || newest(a, b))
  const exposure = alerts.filter((a) => a.basis === 'exposure')
  const crewAlerts = exposure.filter((a) => a.scope === 'crew').sort(newest)
  const covered = new Set<string>()
  const crew: CrewCondition[] = crewAlerts.map((ca) => {
    const ids = new Set(ca.memberIds ?? [])
    const members = exposure.filter((a) => a.scope === 'worker' && a.workerId !== undefined && ids.has(a.workerId)).sort(newest)
    for (const m of members) covered.add(m.id)
    return { alert: ca, members }
  })
  return {
    individual,
    crew,
    site: exposure.filter((a) => a.scope === 'site').sort(newest),
    worker: exposure.filter((a) => a.scope === 'worker' && !covered.has(a.id)).sort(newest),
  }
}

/** The alert asks for another task: console action 'rotate_task', or the pooled "not cleared" reason. */
export function wantsReassign(a: Pick<AlertItem, 'actions' | 'reasonKey'>): boolean {
  return a.actions.includes('rotate_task') || a.reasonKey === 'reason.not_cleared_for_heat_work'
}

/** Minutes an unacknowledged alert waits before the engine escalates or re-notifies (engine/alerts.ts policy defaults). */
export function ackTimerMin(level: RiskLevel, policy: { stopMin: number; emergencyMin: number; highMin: number }): number | null {
  if (level === 'emergency') return policy.emergencyMin
  if (level === 'stop') return policy.stopMin
  if (level === 'high') return policy.highMin
  return null
}

// ─────────────────────────────── Labels ───────────────────────────────

/**
 * Console wording of each action (plain English, supervisor perspective). Device-only and confidential actions never
 * reach the console (privacy.ts supervisorActions); they keep a label only so the record is total.
 */
export const ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  drink_water: 'Drink water',
  shade_breaks: 'Work/rest cycle',
  reduce_intensity: 'Lighter work pace',
  rotate_task: 'Assign a cooler task',
  rest_shade_now: 'Rest now',
  cool_down: 'Active cooling',
  stop_work: 'Stop hot work',
  buddy_check: 'Buddy check',
  first_aider_check: 'First aider check',
  call_998: 'Call 998',
  cool_first: 'Cool first, then transport',
  stay_with_worker: 'Stay with the worker',
  midday_break: 'Midday break: no sun work',
  acclimatization_plan: 'Acclimatisation schedule',
  occ_health_review: 'Clinic review',
  check_sensor: 'Check site sensor',
  symptom_checkin: 'Check-in',
  no_lone_work: 'No lone work',
  electrolytes: 'Electrolytes',
  restrict_fluids: 'Hold water: first aider',
  medical_evaluation: 'Medical evaluation today',
  no_hot_work_today: 'No more hot work today',
}

/** Console label of an action, with the work/rest numbers or the rest place where they apply. */
export function actionLabel(action: ActionId, opts: { workMinPerHour?: number | null; restArea?: 'cooled_cabin' | 'shade' } = {}): string {
  if (action === 'shade_breaks' && typeof opts.workMinPerHour === 'number') {
    const w = Math.floor(opts.workMinPerHour + 1e-9)
    if (w > 0 && w < 60) return `Work/rest ${w}/${60 - w}`
  }
  if (action === 'rest_shade_now') return opts.restArea === 'cooled_cabin' ? 'Rest in the cooled cabin now' : opts.restArea === 'shade' ? 'Rest in the shade now' : 'Rest now'
  return ACTION_LABELS[action]
}

export const ENV_SOURCE_LABELS: Readonly<Record<EnvSource, string>> = {
  site_sensor: 'Site WBGT meter',
  forecast: 'Live forecast',
  archive: 'Weather archive',
  cached_forecast: 'Cached forecast',
  conservative_default: 'Conservative default',
}

/** TWL zone label for the strip (rule pack ids; 'none' and 'unrestricted' read as no restriction). */
export function zoneShort(zone: string | null | undefined): { key: 'low' | 'medium' | 'high' | 'none'; short: string; label: string } {
  if (zone === 'high') return { key: 'high', short: 'H', label: 'High' }
  if (zone === 'medium') return { key: 'medium', short: 'M', label: 'Medium' }
  if (zone === 'low') return { key: 'low', short: 'L', label: 'Low' }
  return { key: 'none', short: '–', label: 'Unrestricted' }
}

// ─────────────────────────────── Reassignment ───────────────────────────────

const WORK_CLASS_ORDER: Readonly<Record<WorkClass, number>> = { rest: 0, light: 1, moderate: 2, heavy: 3, very_heavy: 4 }

export const WORK_CLASS_LABELS: Readonly<Record<WorkClass, string>> = {
  rest: 'resting',
  light: 'light',
  moderate: 'moderate',
  heavy: 'heavy',
  very_heavy: 'very heavy',
}

/** One option of the Reassign control. `taskId` null = rest in the site's rest area with no task. */
export interface ReassignOption {
  key: string
  taskId: string | null
  location: 'sun' | 'shade' | 'indoor_cool'
  label: string
  detail: string
  /** Lighter-first order hint: true for the coolest options (rest area, light or shaded work). */
  cooler: boolean
}

/**
 * Reassignment targets for a crew: the rest area first, then the crew's tasks, lighter and shaded work first (the pooled
 * prompt asks for cooler work; the device re-assesses the new task at once).
 */
export function reassignOptions(tasks: readonly Task[], restArea: 'cooled_cabin' | 'shade'): ReassignOption[] {
  const rest: ReassignOption = {
    key: 'rest',
    taskId: null,
    location: restArea === 'cooled_cabin' ? 'indoor_cool' : 'shade',
    label: restArea === 'cooled_cabin' ? 'Rest in the cooled cabin' : 'Rest in the shade area',
    detail: 'No task until the device clears heat work',
    cooler: true,
  }
  const sorted = [...tasks].sort(
    (a, b) => WORK_CLASS_ORDER[a.workClass] - WORK_CLASS_ORDER[b.workClass] || Number(a.inSun) - Number(b.inSun) || a.name.localeCompare(b.name),
  )
  return [
    rest,
    ...sorted.map((t) => ({
      key: t.id,
      taskId: t.id,
      location: (t.inSun ? 'sun' : 'shade') as 'sun' | 'shade',
      label: t.name,
      detail: `${WORK_CLASS_LABELS[t.workClass]} work, ${t.inSun ? 'in the sun' : 'in shade'}`,
      cooler: WORK_CLASS_ORDER[t.workClass] <= 1 || !t.inSun,
    })),
  ]
}

// ─────────────────────────────── Formatting ───────────────────────────────

export const hhmm = (t: number): string => formatLocalHhmm(t)

/** "12 min", "1 h 05 min" (floored), or "<1 min". */
export function durationText(min: number): string {
  if (!Number.isFinite(min) || min < 1) return '<1 min'
  const m = Math.floor(min + 1e-9)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** Local date line, e.g. "Fri 1 Aug 2025" (Asia/Dubai). */
export function dateText(t: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(t)
  } catch {
    return new Date(t).toISOString().slice(0, 10)
  }
}

/** "1.4 min" below 10 min, else whole minutes. */
export function minutesShort(min: number): string {
  return min < 10 ? `${(Math.round(min * 10) / 10).toFixed(1)} min` : `${Math.round(min)} min`
}

// ─────────────────────────────── Console status badges ───────────────────────────────

/** State of a site-level status badge (never a per-worker figure: sensor status means the site sensors). */
export type BadgeState = 'ok' | 'warn' | 'bad' | 'off'

export interface StatusBadge {
  state: BadgeState
  label: string
  detail: string
}

/** Environment source and age (site-level: the same data every device on the site uses). */
export function envBadge(env: Pick<WorkerEnvStatus, 'source' | 'ageMin' | 'stale' | 'wbgtMarginC'> | null): StatusBadge {
  if (!env) return { state: 'off', label: 'Environment: waiting for data', detail: 'No environment reading yet.' }
  const src = ENV_SOURCE_LABELS[env.source]
  const age = env.ageMin === null || !Number.isFinite(env.ageMin) ? null : Math.max(0, Math.round(env.ageMin))
  const label = age === null ? src : `${src} · ${age <= 1 ? 'live' : `${durationText(age)} old`}`
  const margin = env.wbgtMarginC > 0 ? ` A fail-safe margin of +${env.wbgtMarginC.toFixed(1)} °C WBGT is applied.` : ''
  if (env.source === 'conservative_default') {
    return { state: 'bad', label, detail: `No usable weather data: devices apply conservative default conditions.${margin}` }
  }
  if (env.stale || env.source === 'cached_forecast') {
    return { state: 'warn', label, detail: `Live data unavailable: devices use the last forecast received.${margin}` }
  }
  if (env.source === 'site_sensor') return { state: 'ok', label, detail: `WBGT measured by the site meter (ISO 7243).${margin}` }
  return { state: 'ok', label, detail: `WBGT modelled from the weather data (Liljegren model).${margin}` }
}

/** Site WBGT meter status. */
export function sensorBadge(sensor: 'ok' | 'failed' | 'none'): StatusBadge {
  if (sensor === 'ok') return { state: 'ok', label: 'Site sensor OK', detail: 'The site WBGT meter is reporting.' }
  if (sensor === 'failed') {
    return {
      state: 'bad',
      label: 'Site sensor down',
      detail: 'The site WBGT meter is not reporting: devices fall back down the fail-safe chain (cached forecast, then conservative defaults).',
    }
  }
  return { state: 'off', label: 'No site sensor', detail: 'This site has no WBGT meter: heat is modelled from the weather data.' }
}

/** Site network status. */
export function networkBadge(network: 'online' | 'offline'): StatusBadge {
  return network === 'online'
    ? { state: 'ok', label: 'Network online', detail: 'Phones and this console are in sync.' }
    : {
        state: 'bad',
        label: 'Network offline',
        detail: 'Phones keep assessing and alerting on their own; messages to this console queue until the network returns.',
      }
}

/** Plan basis badge text: a label and a one-line explanation (engine-api-wave2d §2). */
export function planBasisInfo(basis: PlanBasis): { label: string; explanation: string } {
  return basis === 'monitored'
    ? {
        label: 'Monitored mode',
        explanation:
          'WBGT tables screen the work; for acclimatised workers with valid wearable monitoring the device’s ISO 7933 projection sets the limits. A device that cannot confirm monitoring applies the table limits in the same minute.',
      }
    : {
        label: 'Standard limits',
        explanation: 'NIOSH/ACGIH WBGT work/rest tables, the ADOSH rule pack and an ISO 7933 heat-strain screen set the plan.',
      }
}

/** Rest-area wording. */
export function restAreaInfo(restArea: 'cooled_cabin' | 'shade'): { label: string; detail: string } {
  return restArea === 'cooled_cabin'
    ? { label: 'Rest area: cooled cabin', detail: 'Air-conditioned rest area (ADOSH-SF CoP 11.0 §3.2(c)).' }
    : { label: 'Rest area: shade canopy', detail: 'Open shade only: rest recovers less heat than in a cooled cabin.' }
}

// ─────────────────────────────── Site heat strip ───────────────────────────────

/** One forecast hour of the site heat strip. */
export interface HeatRow {
  /** Hour start, epoch ms. */
  hourT: number
  /** Plot position: the middle of the hour (the forecast is an hour average). */
  t: number
  hour: string
  sun: number
  shade: number
  twl: number
  zone: ReturnType<typeof zoneShort>
  midday: boolean
}

export function heatRows(hours: readonly SiteHour[]): HeatRow[] {
  return hours.map((h) => ({
    hourT: h.t,
    t: h.t + HOUR_MS / 2,
    hour: hhmm(h.t),
    sun: h.wbgtC,
    shade: h.wbgtShadeC,
    twl: h.twlWm2,
    zone: zoneShort(h.twlZone),
    midday: h.middayBreak,
  }))
}

/** Y domain of the strip, °C: padded, on whole 2 °C steps, at least 8 °C tall. */
export function heatDomain(rows: readonly HeatRow[], extra: readonly number[] = []): [number, number] {
  const vals = [...rows.flatMap((r) => [r.sun, r.shade]), ...extra].filter((v) => Number.isFinite(v))
  if (vals.length === 0) return [20, 40]
  let lo = Math.floor((Math.min(...vals) - 1) / 2) * 2
  let hi = Math.ceil((Math.max(...vals) + 1) / 2) * 2
  if (hi - lo < 8) {
    lo = Math.floor(((hi + lo) / 2 - 4) / 2) * 2
    hi = lo + 8
  }
  return [lo, hi]
}

/** Forecast WBGT at `t`, °C: linear between hour midpoints, flat beyond the ends; null without rows. */
export function forecastAt(rows: readonly HeatRow[], t: number, key: 'sun' | 'shade' = 'sun'): number | null {
  if (rows.length === 0 || !Number.isFinite(t)) return null
  if (t <= rows[0].t) return rows[0][key]
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    if (t <= b.t) return a[key] + ((b[key] - a[key]) * (t - a.t)) / (b.t - a.t)
  }
  return rows[rows.length - 1][key]
}

/** Midday-break band: the rule pack's window when known, else the span of the flagged hours; null when none. */
export function middayBand(rows: readonly HeatRow[], window: { startT: number; endT: number } | null): { x1: number; x2: number } | null {
  if (window && window.endT > window.startT) return { x1: window.startT, x2: window.endT }
  const flagged = rows.filter((r) => r.midday)
  if (flagged.length === 0) return null
  return { x1: flagged[0].hourT, x2: flagged[flagged.length - 1].hourT + HOUR_MS }
}

/** A site WBGT reading seen by this console (what the devices use: site meter or forecast). */
export interface Reading {
  t: number
  wbgtC: number
  measured: boolean
}

/**
 * Adds a reading to a trail kept at one point per `bucketMin` minutes (the first reading of a bucket stays). Returns the
 * same array when nothing changes; a reading earlier than the last point starts a new trail (the clock went back).
 */
export function addReading(trail: readonly Reading[], r: Reading, bucketMin = 5, max = 400): readonly Reading[] {
  if (!Number.isFinite(r.t) || !Number.isFinite(r.wbgtC)) return trail
  const last = trail.length > 0 ? trail[trail.length - 1] : undefined
  if (last && r.t < last.t) return [r]
  const size = bucketMin * MINUTE_MS
  if (last && Math.floor(last.t / size) === Math.floor(r.t / size)) return trail
  const next = [...trail, r]
  return next.length > max ? next.slice(next.length - max) : next
}

// ─────────────────────────────── Plan timeline and screen ───────────────────────────────

/** Work/rest wording of a rate (protective floor, as the device). */
export function cycleText(workMinPerHour: number): string {
  const w = Math.floor(workMinPerHour + 1e-9)
  if (w >= 60) return 'Continuous work'
  if (w <= 0) return 'Rest only'
  return `Work/rest ${w}/${60 - w}`
}

export type SegmentKind = 'sun' | 'shade' | 'rest'

/** One block of the crew's day on the time-blocks timeline. */
export interface TimelineSegment {
  key: string
  startT: number
  endT: number
  startPct: number
  widthPct: number
  kind: SegmentKind
  taskName: string | null
  start: string
  end: string
  workMinPerHour: number
  waterL: number
  current: boolean
}

export interface PlanTimeline {
  segments: TimelineSegment[]
  startT: number
  endT: number
  /** Position of `now`, 0–100, or null outside the plan. */
  nowPct: number | null
  /** Whole hours inside the plan, for ticks. */
  ticks: Array<{ t: number; pct: number; label: string }>
}

export function planTimeline(blocks: readonly PlanBlock[], now: number): PlanTimeline | null {
  if (blocks.length === 0) return null
  const startT = Math.min(...blocks.map((b) => b.startT))
  const endT = Math.max(...blocks.map((b) => b.endT))
  const span = endT - startT
  if (!(span > 0)) return null
  const pct = (t: number): number => ((t - startT) / span) * 100
  const segments = blocks.map((b, i) => ({
    key: `${i}-${b.start}`,
    startT: b.startT,
    endT: b.endT,
    startPct: pct(b.startT),
    widthPct: pct(b.endT) - pct(b.startT),
    kind: (b.taskId === null ? 'rest' : b.location) as SegmentKind,
    taskName: b.taskName,
    start: b.start,
    end: b.end,
    workMinPerHour: b.workMinPerHour,
    waterL: b.waterL,
    current: now >= b.startT && now < b.endT,
  }))
  const ticks: PlanTimeline['ticks'] = []
  for (let t = Math.ceil(startT / HOUR_MS) * HOUR_MS; t <= endT; t += HOUR_MS) ticks.push({ t, pct: pct(t), label: hhmm(t) })
  return { segments, startT, endT, nowPct: now >= startT && now <= endT ? pct(now) : null, ticks }
}

/** One task-hour of the ISO 7933 heat-strain screen. */
export interface ScreenCell {
  workMin: number
  phsWorkMin: number | null
  allowedMin: number
  limitedBy: PlanLimitedBy
}

export interface ScreenMatrix {
  hours: string[]
  rows: Array<{ taskId: string; taskName: string; cells: Array<ScreenCell | null> }>
  /** The screen's reference worker is acclimatised (crew rate for acclimatised members). */
  acclimatizedReference: boolean
}

/** The crew plan's heat-strain screen as a task × hour matrix (tasks in crew order); null when the screen was not run. */
export function screenMatrix(plan: Pick<CrewPlan, 'phsScreen'>, tasks: readonly Pick<Task, 'id' | 'name'>[]): ScreenMatrix | null {
  const scr = plan.phsScreen
  if (!scr || scr.hours.length === 0) return null
  const ids = new Set<string>()
  for (const h of scr.hours) for (const id of Object.keys(h.byTask)) ids.add(id)
  const order = tasks.map((t) => t.id).filter((id) => ids.has(id))
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return {
    hours: scr.hours.map((h) => h.hour),
    rows: order.map((id) => ({
      taskId: id,
      taskName: tasks.find((t) => t.id === id)?.name ?? id,
      cells: scr.hours.map((h) => {
        const c = h.byTask[id]
        return c ? { workMin: c.workMin, phsWorkMin: c.phsWorkMin, allowedMin: c.allowedMin, limitedBy: c.limitedBy } : null
      }),
    })),
    acclimatizedReference: scr.reference.acclimatized,
  }
}

/** What the supervisor can do about a warning (mitigation hints; non-clinical). */
export const WARNING_HINTS: Readonly<Partial<Record<PlanWarningCode, string>>> = {
  unacclimatized_reassign: 'Give these members Low-zone or shaded work until their acclimatisation schedule allows Medium/High-zone work.',
  phs_rest_limit: 'Rest alone reaches the heat-strain screen margin here: use a cooled rest area, ask workers to log their drinks, or shorten the shift.',
  phs_not_feasible: 'No work passes the heat-strain screen in these hours: move the task to a cooler hour, shade it, or assign lighter work.',
  rest_exceeds_limit: 'Resting in the current rest area alone exceeds a limit: move rest to a cooled area.',
  task_deferred: 'The task does not fit today’s safe hours: plan it for an earlier start or a cooler day.',
  task_incomplete: 'Only part of the task fits today’s safe hours.',
}

/**
 * Planner 'HH:mm' hours merged into spans of whole hours: ['06:00','07:00','09:00'] → '06:00–08:00, 09:00–10:00'.
 * Duplicates and order do not matter; unparseable entries are dropped.
 */
export function hourRanges(hours: readonly string[]): string {
  const mins = [
    ...new Set(
      hours
        .map((h) => /^(\d{1,2}):(\d{2})$/.exec(h.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]) * 60 + Number(m[2])),
    ),
  ].sort((a, b) => a - b)
  const fmt = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const out: string[] = []
  let start = -1
  let prev = -1
  for (const m of mins) {
    if (start >= 0 && m === prev + 60) {
      prev = m
      continue
    }
    if (start >= 0) out.push(`${fmt(start)}–${fmt(prev + 60)}`)
    start = m
    prev = m
  }
  if (start >= 0) out.push(`${fmt(start)}–${fmt(prev + 60)}`)
  return out.join(', ')
}

/** Warnings grouped by code, in the order of first appearance (crewWarnings already ranks them). */
export function groupWarnings(warnings: readonly PlanWarning[]): Array<{ code: PlanWarningCode; items: PlanWarning[] }> {
  const out: Array<{ code: PlanWarningCode; items: PlanWarning[] }> = []
  for (const w of warnings) {
    const g = out.find((x) => x.code === w.code)
    if (g) g.items.push(w)
    else out.push({ code: w.code, items: [w] })
  }
  return out
}

/** "1 cooler", "3 coolers". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Crew water to provide today and coolers, summed over plans. */
export function waterTotals(plans: ReadonlyArray<Pick<CrewPlan, 'waterL' | 'coolersNeeded'> | null>): { litres: number; coolers: number; planned: number } {
  let litres = 0
  let coolers = 0
  let planned = 0
  for (const p of plans) {
    if (!p) continue
    litres += p.waterL
    coolers += p.coolersNeeded
    planned += 1
  }
  return { litres, coolers, planned }
}

/** Released levels summed over crews. */
export function levelTotals(crews: ReadonlyArray<{ counts: Readonly<Record<RiskLevel, number>> }>): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { safe: 0, caution: 0, high: 0, stop: 0, emergency: 0 }
  for (const c of crews) for (const k of Object.keys(out) as RiskLevel[]) out[k] += c.counts[k] ?? 0
  return out
}

// ─────────────────────────────── Escalation and timers ───────────────────────────────

/** Acknowledgement and escalation state of one shown alert (roles and times only). */
export interface EscalationInfo {
  /** First counted acknowledgement. */
  firstAck: { role: Role; t: number } | null
  /** This console's (supervisor) acknowledgement time. */
  supervisorAckT: number | null
  /** When the engine first escalated the alert (durable). */
  escalatedAt: number | null
  /** When an unacknowledged alert is escalated or re-notified; null once acknowledged or without a timer. */
  dueT: number | null
}

export function escalationInfo(
  item: Pick<AlertItem, 't' | 'level' | 'ack'>,
  wf: AlertWorkflow | undefined,
  policy: { stopMin: number; emergencyMin: number; highMin: number },
): EscalationInfo {
  const acks = wf?.acks ?? (item.ack ? [item.ack] : [])
  const sup = acks.find((k) => k.role === 'supervisor')
  const firstAck = item.ack ? { role: item.ack.role, t: item.ack.t } : null
  const timer = ackTimerMin(item.level, policy)
  return {
    firstAck,
    supervisorAckT: sup ? sup.t : null,
    escalatedAt: wf?.escalatedAt ?? null,
    dueT: firstAck === null && timer !== null ? item.t + timer * MINUTE_MS : null,
  }
}

/** Minutes from raise to the first supervisor acknowledgement, per alert id (scope, level and suppression as {@link medianAckMinutes}). */
export function ackMinutesById(
  alerts: readonly Alert[] | null | undefined,
  inScope: (a: Pick<Alert, 'scope' | 'crewId' | 'workerId'>) => boolean,
  minLevel: RiskLevel = 'high',
): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of alerts ?? []) {
    if (RISK_ORDER[a.level] < RISK_ORDER[minLevel] || !inScope(a)) continue
    if (a.suppression && a.suppression.liftedAt === undefined) continue
    const first = (a.acks ?? (a.ack ? [a.ack] : [])).find((k) => k.role === 'supervisor')
    if (first) out.set(a.id, Math.max(0, (first.t - a.t) / MINUTE_MS))
  }
  return out
}

/** "m:ss" of a countdown in minutes (never negative). */
export function clockText(min: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(min) ? min : 0) * 60))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "just now", "6 min ago", "1 h 05 min ago". */
export function agoText(now: number, t: number): string {
  const m = (now - t) / MINUTE_MS
  return m < 1 ? 'just now' : `${durationText(m)} ago`
}
