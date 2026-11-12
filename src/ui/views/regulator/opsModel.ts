/**
 * Live-operations aggregates for the regulator and HSE consoles (#/regulator). Pure: no store access, no clock.
 *
 * Every number these consoles show about workers comes out of `privacy.aggregateFor` with the console's role (regulator
 * k = 10, HSE manager k = 5 — never lowered), primary and complementary suppression, and the audit drafts it returns
 * (the caller appends them through `useProjected`). Individual records are read here only to build the aggregate
 * records; nothing individual is returned. Ground truth (`WorkerView.truth`) and device detail (`WorkerView.detail`)
 * are never read.
 *
 * Inputs: the world view (alerts, plan, forecast hours, roster), plus the task/location history that ./opsLog.ts
 * collects from the published `task` events (the same "pilot-computable" source sim/metrics.ts uses for its
 * midday-break and zone-control checks). Basis: ARCHITECTURE §2 (HSE: site aggregates, compliance, incidents; regulator:
 * multi-site aggregates, hours in each zone, compliance — k-suppressed, never an individual record), §6, §7.
 */
import { RISK_ORDER, type Alert, type AlertBasis, type Crew, type DataField, type Purpose, type WorkClass } from '../../../engine/types'
import { aggregateFor, type AggregateTable, type AuditDraft, type PublishedCell } from '../../../engine/privacy'
import { SUPERVISOR_MIN_LEVEL, isAlertSuppressed } from '../../../engine/alerts'
import { getRulePack, middayBreakWindow, regulatoryFloor, type RulePack, type RulePackId } from '../../../engine/regulation'
import type { PlanBasis } from '../../../engine/planner'
import type { WorkerLocation } from '../../../engine/risk'
import { MINUTE_MS } from '../../../engine/time'
import { METRIC_PARAMS, shiftWindow } from '../../../sim/metrics'
import type { PolicyId, SiteHour } from '../../../sim/types'
import type { Projected, SelectorInput } from '../../../state'

// ─────────────────────────────── Scope ───────────────────────────────

/** The two aggregate consoles of this view. */
export type ConsoleRole = 'regulator' | 'hse_manager'

/** Who is asking and how the rows are cut. */
export interface OpsScope {
  role: ConsoleRole
  actorId: string
  /** Regulator: one row per site; HSE manager: one row per crew of the site. */
  rowsBy: 'site' | 'crew'
}

// ─────────────────────────────── History (./opsLog.ts) ───────────────────────────────

/** A task/location change of one worker (sim/types.ts SimEvent 'task'). */
export interface TaskMark {
  t: number
  taskId: string | null
  location: WorkerLocation
}

/** Task history of the running site-day, collected from published events. */
export interface OpsHistory {
  /** Task/location marks per worker, oldest first. */
  tasks: ReadonlyMap<string, readonly TaskMark[]>
  /** A worker's own shift end (end of shift or an early end), when logged. */
  shiftEnds: ReadonlyMap<string, number>
  /**
   * Latest logged version of every alert of the day by id. The world view keeps only open and recently closed alerts
   * (engine/alerts.ts CLOSED_ALERT_RETENTION_MIN), so day totals need the logged versions.
   */
  alerts: ReadonlyMap<string, Alert>
  /** Simulated time from which the history is complete; null when nothing has been observed. */
  coveredFromT: number | null
  /** True when the history covers the whole run so far. */
  complete: boolean
}

export const EMPTY_HISTORY: OpsHistory = Object.freeze({ tasks: new Map(), shiftEnds: new Map(), alerts: new Map(), coveredFromT: null, complete: false })

// ─────────────────────────────── Sun work, midday break, zone controls ───────────────────────────────

/** Sun-work interval [a, b) on a task. */
export interface SunSegment {
  a: number
  b: number
  taskId: string
}

/** Minutes of [a, b) inside [lo, hi). */
export const overlapMin = (a: number, b: number, lo: number, hi: number): number => Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / MINUTE_MS

/**
 * Sun-work segments of one worker from its task marks, cut at `stopT` (now, or the worker's own shift end): a mark on a
 * task with location 'sun' lasts until the next mark. Same rule as sim/metrics.ts sunSegments.
 */
export function sunSegments(marks: readonly TaskMark[], stopT: number): SunSegment[] {
  const ts = [...marks].sort((x, y) => x.t - y.t)
  const out: SunSegment[] = []
  for (let i = 0; i < ts.length; i++) {
    const s = ts[i]
    if (s.taskId === null || s.location !== 'sun') continue
    const b = Math.min(i + 1 < ts.length ? ts[i + 1].t : stopT, stopT)
    if (b > s.t) out.push({ a: s.t, b, taskId: s.taskId })
  }
  return out
}

/** Sun-work minutes inside the midday-break window (0 when the window is not in force). MoHRE MR 44/2022. */
export function middaySunMinutes(segs: readonly SunSegment[], window: { startT: number; endT: number } | null): number {
  if (!window) return 0
  let m = 0
  for (const s of segs) m += overlapMin(s.a, s.b, window.startT, window.endT)
  return m
}

/** Zone controls apply in these TWL zones (ADOSH-SF TG v4.0 Table 1: Medium and High; sim/metrics.ts zoneCheck). */
export const CONTROLLED_ZONES: readonly string[] = ['medium', 'high']

/** One worker-hour of sun work in a controlled zone. */
export interface ZoneHourCheck {
  hourT: number
  zone: string
  sunMin: number
  /** Within the zone's work/rest allowance (dose ≤ 1 + tolerance) and no excluded unacclimatised worker. */
  within: boolean
}

interface Allowance {
  workMinPerHour: number
  excluded: boolean
}

const allowanceCache = new Map<string, Allowance>()

/** Work/rest allowance of a zone hour for a work class (regulation.ts regulatoryFloor; memoised, static rule data). */
function allowanceFor(h: SiteHour, workClass: WorkClass, unacclimatized: boolean, pack: RulePack): Allowance {
  const key = `${pack.id}|${h.t}|${h.twlWm2}|${workClass}|${unacclimatized ? 1 : 0}`
  const hit = allowanceCache.get(key)
  if (hit) return hit
  const floor = regulatoryFloor({ t: h.t, twlWm2: h.twlWm2, outdoorInSun: true, acclimatization: unacclimatized ? 'unacclimatized' : 'acclimatized', workClass, pack })
  const v: Allowance = { workMinPerHour: floor.workRest ? floor.workRest.workMinPerHour : 60, excluded: floor.unacclimatizedExcluded }
  if (allowanceCache.size > 4000) allowanceCache.clear()
  allowanceCache.set(key, v)
  return v
}

/**
 * Zone-control check of one worker, per clock hour of the forecast strip with a controlled TWL zone, up to `nowT`.
 * Tasks sharing an hour are combined as a dose Σ minutes / allowance ≤ 1 (sum-of-fractions rule); an hour is outside
 * the controls when the excess exceeds the tolerance, or when an ADOSH-unacclimatised worker did more than the tolerance
 * of sun work in a zone that excludes them. Same rule as sim/metrics.ts zoneCheck (ADOSH-SF TG v4.0 Table 1) [ENG].
 */
export function zoneHourChecks(
  segs: readonly SunSegment[],
  hours: readonly SiteHour[],
  taskById: ReadonlyMap<string, { workClass: WorkClass }>,
  unacclimatized: boolean,
  pack: RulePack,
  nowT: number,
): ZoneHourCheck[] {
  const out: ZoneHourCheck[] = []
  if (segs.length === 0) return out
  const tol = METRIC_PARAMS.zoneToleranceMin
  for (const h of hours) {
    if (!CONTROLLED_ZONES.includes(h.twlZone) || h.t >= nowT) continue
    const hEnd = Math.min(h.t + 60 * MINUTE_MS, nowT)
    let sunMin = 0
    let dose = 0
    let minAllowed = 60
    let excluded = false
    for (const s of segs) {
      const m = overlapMin(s.a, s.b, h.t, hEnd)
      if (m <= 0) continue
      sunMin += m
      const task = taskById.get(s.taskId)
      if (!task) continue
      const al = allowanceFor(h, task.workClass, unacclimatized, pack)
      if (al.excluded) excluded = true
      if (al.workMinPerHour > 0) dose += m / al.workMinPerHour
      minAllowed = Math.min(minAllowed, al.workMinPerHour)
    }
    if (sunMin <= 0) continue
    const excess = Math.max(0, dose - 1) * minAllowed
    const excl = excluded && sunMin > tol
    out.push({ hourT: h.t, zone: h.twlZone, sunMin, within: !excl && excess <= tol })
  }
  return out
}

// ─────────────────────────────── Alerts ───────────────────────────────

/** The day's alerts: the logged versions, replaced by the current version of every alert the view still holds. */
export function dayAlerts(logged: ReadonlyMap<string, Alert>, current: readonly Alert[]): Alert[] {
  const byId = new Map(logged)
  for (const a of current) byId.set(a.id, a)
  return [...byId.values()]
}

/** Delivery of an alert: notified, or logged and notified to nobody (designed suppression, ANSI/ISA-18.2). */
export type AlertDelivery = 'notified' | 'logged'
export const ALERT_BASES: readonly AlertBasis[] = ['exposure', 'individual']
export const ALERT_DELIVERIES: readonly AlertDelivery[] = ['notified', 'logged']

/** One worker alert as an aggregate record (subject = the worker). */
export interface AlertRecord {
  basis: AlertBasis
  delivery: AlertDelivery
  subject: string
}

/**
 * Worker alerts raised by `t` (one per alert on a worker's own device; crew alerts bundle the same condition for the
 * supervisor and are not counted again). Basis as shown (a missing basis is 'individual', never overstating the
 * exposure share); delivery 'logged' while the alert is under designed suppression that was never lifted.
 */
export function workerAlertRecords(alerts: readonly Alert[], t: number): AlertRecord[] {
  const out: AlertRecord[] = []
  for (const a of alerts) {
    if (a.scope !== 'worker' || a.workerId === undefined || a.t > t) continue
    out.push({ basis: a.basis === 'exposure' ? 'exposure' : 'individual', delivery: isAlertSuppressed(a) ? 'logged' : 'notified', subject: a.workerId })
  }
  return out
}

/** Time-to-acknowledge bins, aligned with the acknowledgement timers (engine/alerts.ts: emergency 1, stop 2, high 10 min). */
export const ACK_BINS = ['le1', 'le2', 'le10', 'gt10', 'none'] as const
export type AckBin = (typeof ACK_BINS)[number]
export const ACK_BIN_LABELS: Readonly<Record<AckBin, string>> = { le1: '≤ 1 min', le2: '1–2 min', le10: '2–10 min', gt10: '> 10 min', none: 'Not yet' }

/** The bin of a time to acknowledge in minutes (null = no acknowledgement recorded). */
export function ackBin(minutes: number | null): AckBin {
  if (minutes === null || !Number.isFinite(minutes)) return 'none'
  if (minutes <= 1) return 'le1'
  if (minutes <= 2) return 'le2'
  if (minutes <= 10) return 'le10'
  return 'gt10'
}

/** Levels whose alerts ask a responder to acknowledge (SUPERVISOR_MIN_LEVEL and above). */
export const RESPONSE_LEVELS = ['high', 'stop', 'emergency'] as const
export type ResponseLevel = (typeof RESPONSE_LEVELS)[number]

/** A notified alert at or above the supervisor level as an aggregate record. */
export interface ResponseRecord {
  level: ResponseLevel
  bin: AckBin
  escalated: boolean
  /** The worker; a crew or site alert counts as one subject (conservative: never more individuals than it names). */
  subject: string
}

/**
 * Notified alerts at ≥ SUPERVISOR_MIN_LEVEL raised by `t`, any scope (worker alerts and the crew alerts sent to
 * supervisors): time from notification (raise, or the lift of a designed suppression) to the first acknowledgement
 * that counted (`Alert.ack`, any role), and whether the alert was escalated (`Alert.escalatedAt`, durable).
 */
export function responseRecords(alerts: readonly Alert[], t: number): ResponseRecord[] {
  const out: ResponseRecord[] = []
  for (const a of alerts) {
    if (a.t > t || isAlertSuppressed(a) || RISK_ORDER[a.level] < RISK_ORDER[SUPERVISOR_MIN_LEVEL]) continue
    const level = (RESPONSE_LEVELS as readonly string[]).includes(a.level) ? (a.level as ResponseLevel) : null
    if (!level) continue
    const notifiedT = a.suppression?.liftedAt ?? a.t
    const ackMin = a.ack && a.ack.t <= t ? Math.max(0, (a.ack.t - notifiedT) / MINUTE_MS) : null
    const subject = a.scope === 'worker' && a.workerId !== undefined ? a.workerId : a.scope === 'crew' ? `crew:${a.crewId ?? a.id}` : `site:${a.siteId}`
    out.push({ level, bin: ackBin(ackMin), escalated: a.escalatedAt !== undefined && a.escalatedAt <= t, subject })
  }
  return out
}

// ─────────────────────────────── The model ───────────────────────────────

/** A k-suppressed table as received by the console. */
export interface OpsAggregate {
  purpose: Purpose
  decision: 'allowed' | 'denied'
  k: number | null
  table: AggregateTable | null
  reason: string
}

/** Active plan basis of a site or crew (non-personal; a missing plan is null). */
export interface PlanBasisRow {
  id: string
  name: string
  basis: PlanBasis | null
}

/** The live-operations model of one console. */
export interface OpsModel {
  t: number
  /** Local date of the site-day ('YYYY-MM-DD'). */
  date: string
  site: { id: string; name: string }
  /** Jurisdiction rule pack in force on the site. */
  packId: RulePackId
  rowsBy: 'site' | 'crew'
  /** Row key → display name (site or crew names). */
  rowNames: Readonly<Record<string, string>>
  shift: { startT: number; endT: number }
  /** Worker-hours on shift so far (site total); null while fewer than k workers are on shift (or access is denied). */
  workerHours: number | null
  policy: PolicyId
  planBasis: { site: PlanBasis | null; rows: PlanBasisRow[] }
  /** Midday break: the window of the day (null outside the season) and workers with any sun work inside it. */
  midday: { window: { startT: number; endT: number } | null; table: OpsAggregate | null }
  /** Worker-hours of sun work in controlled TWL zones, within / outside the zone controls. */
  zone: OpsAggregate
  /** Worker alerts by basis × delivery. */
  alerts: OpsAggregate
  /** Notified alerts ≥ high by level × time to acknowledge. */
  response: OpsAggregate
  /** The same alerts by level × escalated. */
  escalation: OpsAggregate
  history: { coveredFromT: number | null; complete: boolean }
}

/** Column keys of the compliance and escalation tables. */
export const MIDDAY_COLS = ['compliant', 'violation'] as const
export const ZONE_COLS = ['within', 'outside'] as const
export const ESCALATION_COLS = ['escalated', 'not_escalated'] as const

/**
 * Live-operations aggregates for one console: worker alerts by basis and delivery, response times and escalations,
 * midday-break and zone-control compliance — each through `aggregateFor` (role minimum k, complementary suppression,
 * purpose 'compliance_reporting'); plan basis per site/crew (non-personal). Returns the audit drafts.
 */
export function selectOps(input: SelectorInput, history: OpsHistory, scope: OpsScope): Projected<OpsModel> {
  const view = input.view
  const t = view.t
  const pack = getRulePack(view.config.packId)
  const shift = shiftWindow(view.config)
  const crews: readonly Crew[] = input.crews
  const siteId = view.site.id
  const rows = scope.rowsBy === 'crew' ? crews.map((c) => c.id) : [siteId]
  const rowNames: Record<string, string> = scope.rowsBy === 'crew' ? Object.fromEntries(crews.map((c) => [c.id, c.name])) : { [siteId]: view.site.name }
  const rowOf = (crewId: string): string => (scope.rowsBy === 'crew' ? crewId : siteId)
  const audit: AuditDraft[] = []

  const run = <T>(
    dims: DataField[],
    records: readonly T[],
    row: (r: T) => string,
    col: (r: T) => string,
    rowKeys: readonly string[],
    cols: readonly string[],
    subject: (r: T) => string,
  ): OpsAggregate => {
    const purpose: Purpose = 'compliance_reporting'
    const r = aggregateFor({ role: scope.role, actorId: scope.actorId, purpose, dimensions: dims }, records, { row, col, rows: rowKeys, cols, subject }, { now: t })
    audit.push(r.audit)
    return { purpose, decision: r.decision, k: r.k, table: r.table, reason: r.reason }
  }

  // Workers on shift so far, their sun work, the midday window and the controlled zone hours.
  const window = middayBreakWindow(shift.startT, pack)
  const unaccl = new Set<string>()
  for (const cp of view.plan?.crews ?? []) for (const id of cp.binding.adoshUnacclimatizedMemberIds) unaccl.add(id)
  const tasksByCrew = new Map<string, Map<string, { workClass: WorkClass }>>()
  for (const c of crews) tasksByCrew.set(c.id, new Map(c.tasks.map((x) => [x.id, { workClass: x.workClass }] as const)))

  interface WorkerFacts {
    workerId: string
    crewId: string
    violation: boolean
  }
  const onShift: WorkerFacts[] = []
  const zoneRecords: Array<{ workerId: string; crewId: string; within: boolean }> = []
  let workerMin = 0
  for (const wv of view.workers) {
    const id = wv.profile.id
    const crewId = wv.profile.crewId
    const stopT = Math.min(t, shift.endT, history.shiftEnds.get(id) ?? Infinity)
    const minutes = Math.max(0, (stopT - shift.startT) / MINUTE_MS)
    if (minutes <= 0) continue
    workerMin += minutes
    const segs = sunSegments(history.tasks.get(id) ?? [], stopT)
    const w = window ? { startT: window.startT, endT: Math.min(window.endT, stopT) } : null
    onShift.push({ workerId: id, crewId, violation: middaySunMinutes(segs, w) > 0 })
    for (const z of zoneHourChecks(segs, view.hours, tasksByCrew.get(crewId) ?? new Map(), unaccl.has(id), pack, stopT)) {
      zoneRecords.push({ workerId: id, crewId, within: z.within })
    }
  }

  const midday = window
    ? run(scope.rowsBy === 'crew' ? ['crewId', 'location'] : ['location'], onShift, (r) => rowOf(r.crewId), (r) => (r.violation ? 'violation' : 'compliant'), rows, MIDDAY_COLS, (r) => r.workerId)
    : null
  const zone = run(
    scope.rowsBy === 'crew' ? ['crewId', 'location', 'workMinPerHour'] : ['location', 'workMinPerHour'],
    zoneRecords,
    (r) => rowOf(r.crewId),
    (r) => (r.within ? 'within' : 'outside'),
    rows,
    ZONE_COLS,
    (r) => r.workerId,
  )
  const all = dayAlerts(history.alerts, view.alerts)
  const alerts = run(['level', 'drivers_nonclinical'], workerAlertRecords(all, t), (r) => r.basis, (r) => r.delivery, ALERT_BASES, ALERT_DELIVERIES, (r) => r.subject)
  const resp = responseRecords(all, t)
  const response = run(['level', 'ackStatus'], resp, (r) => r.level, (r) => r.bin, RESPONSE_LEVELS, ACK_BINS, (r) => r.subject)
  const escalation = run(['level', 'ackStatus'], resp, (r) => r.level, (r) => (r.escalated ? 'escalated' : 'not_escalated'), RESPONSE_LEVELS, ESCALATION_COLS, (r) => r.subject)

  // The worker-hours denominator is a site total: published only when the site has at least k workers on shift.
  const k = alerts.k
  const workerHours = alerts.decision === 'allowed' && k !== null && onShift.length >= k ? workerMin / 60 : null

  const plan = view.plan
  const planRows: PlanBasisRow[] =
    scope.rowsBy === 'crew'
      ? crews.map((c) => ({ id: c.id, name: c.name, basis: plan?.crews.find((p) => p.crewId === c.id)?.planBasis ?? null }))
      : [{ id: siteId, name: view.site.name, basis: plan?.planBasis ?? null }]

  return {
    model: {
      t,
      date: view.config.date,
      site: { id: siteId, name: view.site.name },
      packId: view.config.packId,
      rowsBy: scope.rowsBy,
      rowNames,
      shift,
      workerHours,
      policy: view.config.policy,
      planBasis: { site: plan?.planBasis ?? null, rows: planRows },
      midday: { window, table: midday },
      zone,
      alerts,
      response,
      escalation,
      history: { coveredFromT: history.coveredFromT, complete: history.complete },
    },
    audit,
  }
}

// ─────────────────────────────── Reading published cells ───────────────────────────────

/** The published count of a cell, or null when suppressed. */
export const countOf = (c: PublishedCell | undefined): number | null => (c && !c.suppressed ? c.count : null)

/** A cell of `table` by row and column key (undefined when either key is absent). */
export function cellOf(table: AggregateTable | null, row: string, col: string): PublishedCell | undefined {
  if (!table) return undefined
  const i = table.rows.indexOf(row)
  const j = table.cols.indexOf(col)
  return i < 0 || j < 0 ? undefined : table.cells[i][j]
}

/** A column total of `table` by column key. */
export function colTotalOf(table: AggregateTable | null, col: string): PublishedCell | undefined {
  if (!table) return undefined
  const j = table.cols.indexOf(col)
  return j < 0 ? undefined : table.colTotals[j]
}

/** A row total of `table` by row key. */
export function rowTotalOf(table: AggregateTable | null, row: string): PublishedCell | undefined {
  if (!table) return undefined
  const i = table.rows.indexOf(row)
  return i < 0 ? undefined : table.rowTotals[i]
}

/**
 * Share part / whole from published cells only: null when either is suppressed or the whole is zero. A share is never
 * derived from a hidden count.
 */
export function publishedShare(part: PublishedCell | undefined, whole: PublishedCell | undefined): number | null {
  const p = countOf(part)
  const w = countOf(whole)
  return p === null || w === null || w === 0 ? null : p / w
}

/** Rate per 1,000 worker-hours of a published count (null when suppressed or no worker-hours). */
export function ratePer1000(count: PublishedCell | undefined, workerHours: number | null): number | null {
  const c = countOf(count)
  return c === null || workerHours === null || workerHours <= 0 ? null : (c / workerHours) * 1000
}
