/**
 * Role-projected view models (ARCHITECTURE §2, §7, §9).
 *
 * Rules enforced here:
 * - EVERY non-worker view model is built only from `privacy.project()` (individual records) or `privacy.aggregateFor()`
 *   (k-suppressed tables) with the right role and purpose, and returns the audit drafts those calls produced so the
 *   caller can append them to the hash-chained log (governanceStore.recordAll — the same entry `projectAndLog` appends,
 *   de-duplicated so a re-render does not flood the log).
 * - Buddy access passes `buddyIds` (the subject's paired buddy) and supervisor access passes `actorCrewIds` (the crews
 *   the actor supervises), so both are scoped, not only role-checked.
 * - The worker view gets the worker's own full snapshot (it is their device).
 * - Ground truth (`WorkerView.truth`) is read ONLY by the Lab selectors at the bottom of this file. Operational
 *   selectors build snapshots with `deviceSnapshot()`, which never reads it.
 *
 * Every function is pure (no store access, no clock): the simulated time `view.t` is the request time.
 * Claims discipline: the ECTemp value released to the worker or a consented occupational-health case is an estimated
 * strain indicator, never a measured core temperature.
 */
import {
  RISK_LEVELS,
  RISK_ORDER,
  type Alert,
  type ConsentState,
  type Crew,
  type DataField,
  type Purpose,
  type RiskAssessment,
  type RiskLevel,
  type Role,
  type Site,
  type SymptomId,
  type Task,
  type WorkerProfile,
} from '../engine/types'
import {
  CLINICAL_FIELDS,
  CONFIDENTIAL_ACTIONS,
  aggregateFor,
  createWorkerSnapshot,
  payloadForSync,
  project,
  type AckStatus,
  type AggregateTable,
  type AuditDraft,
  type ProjectedData,
  type ProjectionResult,
  type SyncPayload,
  type UrineColor,
  type WorkerLocation as CaseLocation,
  type WorkerSnapshot,
} from '../engine/privacy'
import { CLINICAL_TEXT_PATTERN, SUPERVISOR_MIN_LEVEL, type Notification } from '../engine/alerts'
import type { WorkerEnvStatus, WorkerLocation, WorkerStepDetail } from '../engine/risk'
import type { EctempBand } from '../engine/physio'
import type { SiteHeat } from '../engine/indices'
import type { CrewPlan } from '../engine/planner'
import { MINUTE_MS } from '../engine/time'
import type { SiteHour, WorkerMinute, WorkerView, WorldView } from '../sim/types'
import type { World } from '../sim/worldsim'
import { emptyDeviceRecord, type DeviceRecord, type RemotePayload, type RosterLink, type SimStoreState } from './simStore'

// ─────────────────────────────── Input ───────────────────────────────

/** Everything the selectors read. Built by {@link selectorInput} from the stores. */
export interface SelectorInput {
  view: WorldView
  crews: readonly Crew[]
  roster: Readonly<Record<string, RosterLink>>
  device: Readonly<Record<string, DeviceRecord>>
  /** Consent ledger (governanceStore): overrides the profile's consent, so a revocation applies on the next call. */
  consent?: Readonly<Record<string, ConsentState>>
  /** Latest sync payloads received from worker devices in other tabs (./syncBus.ts). */
  remote?: Readonly<Record<string, RemotePayload>>
}

/** A view model plus the audit drafts its projections produced (append them: governanceStore.recordAll). */
export interface Projected<T> {
  model: T
  audit: AuditDraft[]
}

/** Builds the selector input from the simulation store and the consent ledger; null before a world exists. */
export function selectorInput(
  sim: Pick<SimStoreState, 'view' | 'crews' | 'roster' | 'device' | 'remotePayloads'>,
  consent?: Readonly<Record<string, ConsentState>>,
): SelectorInput | null {
  if (!sim.view) return null
  return { view: sim.view, crews: sim.crews, roster: sim.roster, device: sim.device, remote: sim.remotePayloads, ...(consent ? { consent } : {}) }
}

// ─────────────────────────────── Parameters ───────────────────────────────

/**
 * Symptoms reported in check-ins within this window are part of the live case record (released to a first aider only
 * for an escalated active case, to occupational health only with consent). [ENG] long enough to span a stop-work
 * episode and its 15/30-min follow-ups (engine/clinical.ts), short enough not to carry a resolved morning complaint.
 */
export const CASE_SYMPTOM_WINDOW_MIN = 120

/** Plain-language location text for the first aider. Basis: privacy.ts WorkerLocation (so a first aider can reach them). */
export const LOCATION_TEXT: Readonly<Record<WorkerLocation, string>> = Object.freeze({
  sun: 'in the sun',
  shade: 'in shade',
  indoor_cool: 'in the cooled rest area',
})

// ─────────────────────────────── Shared helpers ───────────────────────────────

/** Status of a worker's open case (latest unresolved worker-scoped alert). */
export interface CaseStatus {
  alert: Alert | null
  ackStatus: AckStatus
  /**
   * privacy.ts ProjectionContext.escalated. True for a stop left unacknowledged, an emergency, routing to the first
   * aider or occupational health (`Alert.escalatedAt`), or a first-aider hand-over (any first-aider acknowledgement in
   * `Alert.acks`, also after someone else acknowledged first). It stays true until the alert is resolved. See
   * {@link isEscalated}.
   */
  escalated: boolean
}

const NO_CASE: CaseStatus = Object.freeze({ alert: null, ackStatus: 'none', escalated: false }) as CaseStatus

/**
 * Whether an open worker alert counts as escalated. `Alert.status` goes back from 'escalated' to 'acknowledged' after a
 * late acknowledgement, and `Alert.ack` keeps only the first counted acknowledgement. The durable record is therefore
 * `escalatedAt` (the first stop-acknowledgement timeout, emergency, or routing to the first aider or occupational
 * health) plus `acks` (every acknowledgement in order). Alerts without either field come from older producers. For
 * those, the old routing inference is kept as a fallback: the stop timeout adds the buddy, an emergency adds the buddy
 * and occupational health, and a first aider who acknowledged first is a hand-over.
 * Basis: privacy.ts ProjectionContext.escalated ("stop unacknowledged, emergency, first-aider hand-over"); engine/alerts.ts.
 */
function isEscalated(a: Alert): boolean {
  if (a.status === 'escalated' || a.level === 'emergency') return true
  if (a.escalatedAt !== undefined || Array.isArray(a.acks)) {
    return a.escalatedAt !== undefined || (a.acks ?? []).some((x) => x.role === 'first_aider')
  }
  const routed = a.escalatedTo ?? []
  return a.ack?.role === 'first_aider' || routed.includes('occ_health') || (RISK_ORDER[a.level] >= RISK_ORDER.stop && routed.includes('buddy'))
}

/** Open case of every worker (latest unresolved worker-scoped alert), from the alert list. Basis: {@link isEscalated}. */
export function caseIndex(alerts: readonly Alert[]): Map<string, CaseStatus> {
  const open = new Map<string, Alert>()
  for (const a of alerts) {
    if (a.scope !== 'worker' || !a.workerId || a.status === 'resolved') continue
    const prev = open.get(a.workerId)
    if (!prev || a.t >= prev.t) open.set(a.workerId, a)
  }
  const out = new Map<string, CaseStatus>()
  for (const [id, a] of open) out.set(id, { alert: a, ackStatus: a.status, escalated: isEscalated(a) })
  return out
}

/** Open case of one worker. Basis: {@link caseIndex}. */
export function caseStatus(alerts: readonly Alert[], workerId: string): CaseStatus {
  return caseIndex(alerts).get(workerId) ?? NO_CASE
}

/** The profile with the consent ledger applied (revocations are effective on the next projection). Basis: ARCHITECTURE §7. */
export function profileWithConsent(input: Pick<SelectorInput, 'consent'>, profile: WorkerProfile): WorkerProfile {
  const consent = input.consent?.[profile.id]
  return consent ? { ...profile, consent } : profile
}

/** Where the worker is, for a first aider: site, task and sun/shade/cooled. Basis: privacy.ts WorkerLocation. */
export function caseLocation(view: Pick<WorldView, 'site'>, wv: Pick<WorkerView, 'task' | 'location'>): CaseLocation {
  const site = view.site
  return {
    siteId: site.id,
    label: `${site.name} · ${wv.task ? wv.task.name : 'not on a task'} · ${LOCATION_TEXT[wv.location]}`,
    lat: site.lat,
    lon: site.lon,
  }
}

/** Symptoms reported in the case window (union, first-report order) and the latest urine colour. Basis: {@link CASE_SYMPTOM_WINDOW_MIN}. */
export function recentReports(device: DeviceRecord | undefined, now: number): { symptoms: SymptomId[]; urineColor: UrineColor | null } {
  const symptoms: SymptomId[] = []
  let urineColor: UrineColor | null = null
  for (const c of device?.checkins ?? []) {
    if (c.t > now || c.t < now - CASE_SYMPTOM_WINDOW_MIN * MINUTE_MS) continue
    for (const s of c.symptoms) if (!symptoms.includes(s)) symptoms.push(s)
    if (c.urineColor !== undefined) urineColor = c.urineColor
  }
  return { symptoms, urineColor }
}

function buildSnapshot(input: SelectorInput, wv: WorkerView, cs: CaseStatus): WorkerSnapshot | null {
  if (!wv.assessment) return null
  const profile = profileWithConsent(input, wv.profile)
  const reports = recentReports(input.device[profile.id], input.view.t)
  // Reads only on-device fields: never `wv.truth` (ground truth is for the Lab view only).
  return createWorkerSnapshot(profile, wv.assessment, {
    ackStatus: cs.ackStatus,
    hrBpm: wv.lastHrBpm,
    ctEstC: wv.detail?.physioDisplay?.centreC ?? null,
    psi: null,
    symptoms: reports.symptoms,
    urineColor: reports.urineColor,
    location: caseLocation(input.view, wv),
  })
}

/**
 * The full record held on a worker's device (privacy.ts WorkerSnapshot), built with the ledger consent: data whose
 * consent is off is never copied in. Null when the engine has produced no assessment yet (or does not run: ban_only /
 * site_index). Never reads ground truth. Basis: privacy.ts createWorkerSnapshot; ARCHITECTURE §1 principle 5.
 */
export function deviceSnapshot(input: SelectorInput, workerId: string): WorkerSnapshot | null {
  const wv = input.view.workers.find((w) => w.profile.id === workerId)
  if (!wv) return null
  return buildSnapshot(input, wv, caseStatus(input.view.alerts, workerId))
}

/** Non-personal site status shown to every role: site, heat indices, data status, forecast hours, network/sensor. */
export interface SiteStatus {
  t: number
  site: Site
  heat: SiteHeat | null
  env: WorkerEnvStatus | null
  hours: SiteHour[]
  network: WorldView['network']
  sensor: WorldView['sensor']
  finished: boolean
}

/** Site-level status (environment, not individual data). Basis: ARCHITECTURE §2 (site forecast for the supervisor). */
export function siteStatus(view: WorldView): SiteStatus {
  return { t: view.t, site: view.site, heat: view.heat, env: view.env, hours: view.hours, network: view.network, sensor: view.sensor, finished: view.finished }
}

/** Defence in depth: a supervisor-facing text that matches the clinical-term pattern is replaced. Basis: alerts.ts CLINICAL_TEXT_PATTERN. */
function safeText(text: string, fallback: string): string {
  return CLINICAL_TEXT_PATTERN.test(text) ? fallback : text
}

/** An alert as shown to an operational role: no confidential action, non-clinical reason. */
export interface AlertItem {
  id: string
  t: number
  scope: Alert['scope']
  crewId?: string
  workerId?: string
  memberIds?: string[]
  level: RiskLevel
  actions: Alert['actions']
  reason: string
  status: Alert['status']
  ack?: Alert['ack']
}

/** Alert → operational item: confidential actions removed, reason checked against the clinical-term pattern. Basis: alerts.ts. */
export function alertItem(a: Alert): AlertItem {
  return {
    id: a.id,
    t: a.t,
    scope: a.scope,
    ...(a.crewId !== undefined ? { crewId: a.crewId } : {}),
    ...(a.workerId !== undefined ? { workerId: a.workerId } : {}),
    ...(a.memberIds ? { memberIds: [...a.memberIds] } : {}),
    level: a.level,
    actions: a.actions.filter((x) => !CONFIDENTIAL_ACTIONS.includes(x)),
    reason: safeText(a.reason, `Level: ${a.level}`),
    status: a.status,
    ...(a.ack ? { ack: { ...a.ack } } : {}),
  }
}

function notificationsFor(view: WorldView, role: Role, actorId: string | null): Notification[] {
  return view.notifications
    .filter((n) => n.to.role === role && (n.to.id === undefined || actorId === null || n.to.id === actorId))
    .map((n) => (role === 'worker' ? { ...n, actions: [...n.actions] } : { ...n, actions: n.actions.filter((a) => !CONFIDENTIAL_ACTIONS.includes(a)), text: safeText(n.text, `Level: ${n.level}`) }))
}

/** An individual record as received by a role: only the released fields, plus why the rest was withheld. */
export interface ReceivedRecord {
  /** Pseudonymous id of the worker (projection subject). */
  workerId: string
  decision: ProjectionResult['decision'] | 'no_data'
  /** Exactly the released fields (privacy.project `data`). */
  data: ProjectedData
  fields: DataField[]
  withheld: DataField[]
  reason: string
}

const NO_DATA_REASON = 'No assessment from the worker device yet (or the engine does not run under this policy).'

function received(workerId: string, result: ProjectionResult | null): ReceivedRecord {
  if (!result) return { workerId, decision: 'no_data', data: {}, fields: [], withheld: [], reason: NO_DATA_REASON }
  return { workerId, decision: result.decision, data: result.data, fields: result.fields, withheld: result.withheld, reason: result.reason }
}

// ─────────────────────────────── Worker (own device) ───────────────────────────────

/** The worker's phone: their own full data (it is their device) plus the buddy cards they are entitled to. */
export interface WorkerDeviceModel {
  workerId: string
  t: number
  /** Own profile with the ledger consent. */
  profile: WorkerProfile
  /** Own full on-device record (null before the first assessment). */
  snapshot: WorkerSnapshot | null
  assessment: RiskAssessment | null
  /** Own engine detail (ECTemp band, allowed work, PHS recovery progress…). */
  detail: WorkerStepDetail | null
  task: Task | null
  location: WorkerLocation
  lastHrBpm: number | null
  checkinDue: boolean
  /** Own open case. */
  alert: Alert | null
  ackStatus: AckStatus
  notifications: Notification[]
  device: DeviceRecord
  /** Exactly what this device sends to the supervisor console (privacy.payloadForSync). */
  outbound: SyncPayload | null
  /** Partners this worker is the buddy of (privacy.project, role 'buddy'). */
  buddyCards: BuddyCard[]
  site: SiteStatus
}

/**
 * The worker's own device view: own full snapshot, assessment and detail without projection (own device, ARCHITECTURE
 * §2 "Worker: own level, actions, countdown, own data"), plus buddy cards built through `project`. Null for an unknown
 * worker. Basis: ARCHITECTURE §2, §9 (#/worker/:id); privacy.ts ACCESS_MATRIX worker row (is_self: everything).
 */
export function selectWorkerDevice(input: SelectorInput, workerId: string): Projected<WorkerDeviceModel | null> {
  const wv = input.view.workers.find((w) => w.profile.id === workerId)
  if (!wv) return { model: null, audit: [] }
  const cs = caseStatus(input.view.alerts, workerId)
  const profile = profileWithConsent(input, wv.profile)
  const buddies = selectBuddyCards(input, workerId)
  return {
    model: {
      workerId,
      t: input.view.t,
      profile,
      snapshot: buildSnapshot(input, wv, cs),
      assessment: wv.assessment,
      detail: wv.detail,
      task: wv.task,
      location: wv.location,
      lastHrBpm: profile.consent.wearable ? wv.lastHrBpm : null,
      checkinDue: wv.checkinDue,
      alert: cs.alert,
      ackStatus: cs.ackStatus,
      notifications: notificationsFor(input.view, 'worker', workerId),
      device: input.device[workerId] ?? emptyDeviceRecord(),
      outbound: wv.assessment ? payloadForSync(wv.assessment, profile, cs.ackStatus) : null,
      buddyCards: buddies.model,
      site: siteStatus(input.view),
    },
    audit: buddies.audit,
  }
}

// ─────────────────────────────── Buddy ───────────────────────────────

/** A buddy's card for one partner: name, level, actions, acknowledgement (privacy BUDDY view). */
export interface BuddyCard extends ReceivedRecord {
  /** The partner's actions include a buddy check. */
  buddyCheck: boolean
  alertId: string | null
  /** Notifications addressed to this buddy about this partner. */
  notifications: Notification[]
}

/**
 * Cards for every worker whose paired buddy is `buddyId`, through `project(role 'buddy', purpose 'safety_alerting')`
 * with `buddyIds` set to the subject's pairing. Basis: ARCHITECTURE §2 (Buddy: partner's level and a buddy-check
 * prompt; never clinical data); privacy.ts BUDDY_VIEW and 'is_buddy'.
 */
export function selectBuddyCards(input: SelectorInput, buddyId: string): Projected<BuddyCard[]> {
  const cases = caseIndex(input.view.alerts)
  const audit: AuditDraft[] = []
  const cards: BuddyCard[] = []
  for (const wv of input.view.workers) {
    const id = wv.profile.id
    const pairedBuddy = input.roster[id]?.buddyId
    if (pairedBuddy !== buddyId || id === buddyId) continue
    const cs = cases.get(id) ?? NO_CASE
    const snap = buildSnapshot(input, wv, cs)
    const result = snap
      ? project(snap, { role: 'buddy', actorId: buddyId, purpose: 'safety_alerting' }, { now: input.view.t, escalated: cs.escalated, buddyIds: [pairedBuddy] })
      : null
    if (result) audit.push(result.audit)
    const rec = received(id, result)
    const alertIds = new Set(input.view.alerts.filter((a) => a.workerId === id).map((a) => a.id))
    cards.push({
      ...rec,
      buddyCheck: (rec.data.actions ?? []).includes('buddy_check'),
      alertId: rec.decision === 'allowed' ? (cs.alert?.id ?? null) : null,
      notifications: notificationsFor(input.view, 'buddy', buddyId).filter((n) => alertIds.has(n.alertId)),
    })
  }
  return { model: cards, audit }
}

// ─────────────────────────────── Supervisor ───────────────────────────────

/** A crew a supervisor actor can act for. */
export interface SupervisorActor {
  actorId: string
  crewId: string
  crewName: string
  supervisorName: string
}

/** Supervisor actor ids of the loaded roster (worldsim: `${crewId}:supervisor`). Basis: engine/alerts.ts RosterEntry.supervisorId. */
export function supervisorActors(input: Pick<SelectorInput, 'crews' | 'roster'>): SupervisorActor[] {
  const out: SupervisorActor[] = []
  for (const crew of input.crews) {
    const sup = crew.workerIds.map((id) => input.roster[id]?.supervisorId).find((x): x is string => typeof x === 'string')
    if (sup) out.push({ actorId: sup, crewId: crew.id, crewName: crew.name, supervisorName: crew.supervisorName })
  }
  return out
}

/** Crews the actor supervises (privacy ProjectionContext.actorCrewIds). Basis: roster supervisorId. */
export function supervisedCrewIds(input: Pick<SelectorInput, 'roster'>, actorId: string): string[] {
  const ids = new Set<string>()
  for (const link of Object.values(input.roster)) if (link.supervisorId === actorId) ids.add(link.crewId)
  return [...ids]
}

/** One row of the crew board. */
export interface CrewBoardRow extends ReceivedRecord {
  crewId: string
  /** 'remote' when the row shows a newer payload received from the worker's device in another tab. */
  source: 'local' | 'remote'
  alertId: string | null
}

/** A crew on the supervisor's board. */
export interface CrewBoard {
  crew: { id: string; name: string; supervisorName: string; tasks: Task[] }
  rows: CrewBoardRow[]
  /** Released levels per level (rows with data only). */
  counts: Record<RiskLevel, number>
  plan: CrewPlan | null
}

/** The supervisor console model. */
export interface SupervisorBoard {
  actorId: string
  t: number
  crews: CrewBoard[]
  /** Open alerts in scope at or above the supervisor level (crew/site alerts included). */
  alerts: AlertItem[]
  notifications: Notification[]
  site: SiteStatus
}

const OVERLAY_FIELDS = ['level', 'actions', 'workMinPerHour', 'waterMlPerHour', 'ackStatus'] as const

/** Applies a newer device payload to the released operational fields only (the payload carries nothing else). */
function overlayRemote(data: ProjectedData, fields: readonly DataField[], remote: RemotePayload | undefined, localT: number): boolean {
  if (!remote || remote.payload.t < localT) return false
  const p = remote.payload
  for (const f of OVERLAY_FIELDS) {
    if (!fields.includes(f)) continue
    if (f === 'level') data.level = p.level
    else if (f === 'actions') data.actions = [...p.actions]
    else if (f === 'workMinPerHour') data.workMinPerHour = p.workMinPerHour
    else if (f === 'waterMlPerHour') data.waterMlPerHour = p.waterMlPerHour
    else data.ackStatus = p.ack
  }
  return true
}

const zeroCounts = (): Record<RiskLevel, number> => ({ safe: 0, caution: 0, high: 0, stop: 0, emergency: 0 })

/**
 * The crew board for a supervisor actor: one `project(role 'supervisor', purpose 'safety_alerting')` per worker of the
 * crews the actor supervises (`actorCrewIds`), the alert feed in scope, notifications to the actor, the crew plan and
 * the site status. A newer device payload from another tab overrides the released operational fields. Basis:
 * ARCHITECTURE §2 (Crew supervisor: name, level, action, ack status; never HR, core temperature, risk flags,
 * symptoms), §9 (#/supervisor); privacy.ts SUPERVISOR_VIEW and 'in_actor_crew'.
 */
export function selectSupervisorBoard(input: SelectorInput, actorId: string): Projected<SupervisorBoard> {
  const crewIds = supervisedCrewIds(input, actorId)
  const cases = caseIndex(input.view.alerts)
  const audit: AuditDraft[] = []
  const byId = new Map(input.view.workers.map((w) => [w.profile.id, w] as const))
  const crews: CrewBoard[] = []
  for (const crew of input.crews) {
    if (!crewIds.includes(crew.id)) continue
    const rows: CrewBoardRow[] = []
    const counts = zeroCounts()
    for (const id of crew.workerIds) {
      const wv = byId.get(id)
      if (!wv) continue
      const cs = cases.get(id) ?? NO_CASE
      const snap = buildSnapshot(input, wv, cs)
      const result = snap
        ? project(snap, { role: 'supervisor', actorId, purpose: 'safety_alerting' }, { now: input.view.t, escalated: cs.escalated, actorCrewIds: crewIds })
        : null
      if (result) audit.push(result.audit)
      const rec = received(id, result)
      const remote = rec.decision === 'allowed' && snap ? overlayRemote(rec.data, rec.fields, input.remote?.[id], snap.t) : false
      if (rec.data.level) counts[rec.data.level] += 1
      rows.push({ ...rec, crewId: crew.id, source: remote ? 'remote' : 'local', alertId: rec.decision === 'allowed' ? (cs.alert?.id ?? null) : null })
    }
    crews.push({
      crew: { id: crew.id, name: crew.name, supervisorName: crew.supervisorName, tasks: crew.tasks.map((t) => ({ ...t })) },
      rows,
      counts,
      plan: input.view.plan?.crews.find((c) => c.crewId === crew.id) ?? null,
    })
  }
  const inScope = (a: Alert): boolean =>
    a.scope === 'site' ? crewIds.length > 0 : a.crewId !== undefined ? crewIds.includes(a.crewId) : a.workerId !== undefined && crewIds.includes(input.roster[a.workerId]?.crewId ?? '')
  const alerts = input.view.alerts
    .filter((a) => a.status !== 'resolved' && inScope(a) && (a.scope !== 'worker' || RISK_ORDER[a.level] >= RISK_ORDER[SUPERVISOR_MIN_LEVEL]))
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level] || a.t - b.t)
    .map(alertItem)
  return {
    model: { actorId, t: input.view.t, crews, alerts, notifications: crewIds.length > 0 ? notificationsFor(input.view, 'supervisor', actorId) : [], site: siteStatus(input.view) },
    audit,
  }
}

// ─────────────────────────────── First aider ───────────────────────────────

/** An active case on the first aider's list. */
export interface FirstAidCase extends ReceivedRecord {
  alert: AlertItem
  escalated: boolean
}

/** The first aider's model: active stop/emergency cases (most severe first) and their notifications. */
export interface FirstAiderModel {
  actorId: string
  t: number
  cases: FirstAidCase[]
  notifications: Notification[]
  site: SiteStatus
}

/**
 * Active cases for a first aider: workers with an open worker-scoped alert at stop or above, or routed to the first
 * aider; each record through `project(role 'first_aider', purpose 'safety_alerting')` — name, level, actions and
 * location for an active case, reported symptoms only once escalated (vital interest). Basis: ARCHITECTURE §2 (First
 * aider row; ILO code §8.2); privacy.ts FIRST_AID_CASE_VIEW, 'active_case', 'escalated'.
 */
export function selectFirstAiderCases(input: SelectorInput, actorId: string): Projected<FirstAiderModel> {
  const audit: AuditDraft[] = []
  const cases: FirstAidCase[] = []
  for (const [id, cs] of caseIndex(input.view.alerts)) {
    const a = cs.alert as Alert
    if (RISK_ORDER[a.level] < RISK_ORDER.stop && !(a.escalatedTo ?? []).includes('first_aider')) continue
    const wv = input.view.workers.find((w) => w.profile.id === id)
    if (!wv) continue
    const snap = buildSnapshot(input, wv, cs)
    const result = snap ? project(snap, { role: 'first_aider', actorId, purpose: 'safety_alerting' }, { now: input.view.t, escalated: cs.escalated }) : null
    if (result) audit.push(result.audit)
    const rec = received(id, result)
    if (rec.decision !== 'allowed') continue
    cases.push({ ...rec, alert: alertItem(a), escalated: cs.escalated })
  }
  cases.sort((x, y) => RISK_ORDER[y.alert.level] - RISK_ORDER[x.alert.level] || x.alert.t - y.alert.t)
  return { model: { actorId, t: input.view.t, cases, notifications: notificationsFor(input.view, 'first_aider', actorId), site: siteStatus(input.view) }, audit }
}

// ─────────────────────────────── Occupational health ───────────────────────────────

/** An escalated case on the occupational-health console. */
export interface OccHealthCase extends ReceivedRecord {
  alert: AlertItem
  /** Any clinical field was released (the worker consented to sharing on escalation). */
  clinicalReleased: boolean
}

/** The occupational-health model: escalated cases only. */
export interface OccHealthModel {
  actorId: string
  t: number
  cases: OccHealthCase[]
  notifications: Notification[]
}

/**
 * Escalated cases for occupational health through `project(role 'occ_health', purpose 'clinical_care')`: the case view
 * always, clinical detail only with the worker's `shareWithMedicOnEscalation` consent; non-escalated workers are never
 * requested. Basis: ARCHITECTURE §2 (Occupational health nurse: escalated cases with consented clinical detail; never
 * non-escalated workers); privacy.ts OH_CASE_VIEW / OH_CLINICAL_VIEW.
 */
export function selectOccHealthCases(input: SelectorInput, actorId: string): Projected<OccHealthModel> {
  const audit: AuditDraft[] = []
  const cases: OccHealthCase[] = []
  for (const [id, cs] of caseIndex(input.view.alerts)) {
    if (!cs.escalated) continue
    const wv = input.view.workers.find((w) => w.profile.id === id)
    if (!wv) continue
    const snap = buildSnapshot(input, wv, cs)
    const result = snap ? project(snap, { role: 'occ_health', actorId, purpose: 'clinical_care' }, { now: input.view.t, escalated: true }) : null
    if (result) audit.push(result.audit)
    const rec = received(id, result)
    if (rec.decision !== 'allowed') continue
    cases.push({ ...rec, alert: alertItem(cs.alert as Alert), clinicalReleased: rec.fields.some((f) => CLINICAL_FIELDS.includes(f)) })
  }
  cases.sort((x, y) => RISK_ORDER[y.alert.level] - RISK_ORDER[x.alert.level] || x.alert.t - y.alert.t)
  return { model: { actorId, t: input.view.t, cases, notifications: notificationsFor(input.view, 'occ_health', null) }, audit }
}

// ─────────────────────────────── Aggregates (HSE, regulator) ───────────────────────────────

/** Table column: the current displayed level, or the highest level reached today. */
export type AggregateDimension = 'current_level' | 'max_level_today'

/** One individual-level record fed to aggregateFor (never published itself). */
export interface AggregateRecord {
  workerId: string
  crewId: string
  siteId: string
  level: RiskLevel
  maxLevel: RiskLevel
  consent: ConsentState
}

/** A k-suppressed table as received by HSE or the regulator. */
export interface AggregateView {
  purpose: Purpose
  dimension: AggregateDimension
  rowsBy: 'crew' | 'site'
  decision: 'allowed' | 'denied'
  k: number | null
  table: AggregateTable | null
  excludedForConsent: number
  reason: string
}

/** Records of the workers with an assessment (input of aggregateFor only). Basis: privacy.ts aggregateFor. */
export function aggregateRecords(input: SelectorInput): AggregateRecord[] {
  const out: AggregateRecord[] = []
  for (const wv of input.view.workers) {
    if (!wv.assessment) continue
    const id = wv.profile.id
    const level = wv.assessment.level
    const dev = input.device[id]
    const maxLevel = dev && RISK_ORDER[dev.maxLevel] > RISK_ORDER[level] ? dev.maxLevel : level
    out.push({ workerId: id, crewId: wv.profile.crewId, siteId: input.view.site.id, level, maxLevel, consent: profileWithConsent(input, wv.profile).consent })
  }
  return out
}

/** Request of {@link selectAggregate}. */
export interface AggregateSelectRequest {
  role: Role
  actorId: string
  purpose: Purpose
  dimension: AggregateDimension
  rowsBy: 'crew' | 'site'
  /** A larger k may be requested; the role's minimum is never lowered (privacy.aggregateFor). */
  k?: number
}

/**
 * A level table (rows: crews or the site; columns: RISK_LEVELS) through `aggregateFor` — role minimum k (HSE 5,
 * regulator and employer HR 10), complementary suppression, `aggregateStatistics` consent for public-health
 * statistics; distinct workers are counted per cell. Basis: ARCHITECTURE §2 (HSE, Regulator rows), §7; privacy.ts
 * aggregateFor / aggregate.
 */
export function selectAggregate(input: SelectorInput, req: AggregateSelectRequest): Projected<AggregateView> {
  const records = aggregateRecords(input)
  const rows = req.rowsBy === 'crew' ? input.crews.map((c) => c.id) : [input.view.site.id]
  const result = aggregateFor(
    { role: req.role, actorId: req.actorId, purpose: req.purpose, dimensions: req.rowsBy === 'crew' ? ['crewId', 'level'] : ['level'], ...(req.k !== undefined ? { k: req.k } : {}) },
    records,
    {
      row: (r) => (req.rowsBy === 'crew' ? r.crewId : r.siteId),
      col: (r) => (req.dimension === 'current_level' ? r.level : r.maxLevel),
      rows,
      cols: RISK_LEVELS,
      subject: (r) => r.workerId,
    },
    { now: input.view.t, consentOf: (r) => r.consent },
  )
  return {
    model: {
      purpose: req.purpose,
      dimension: req.dimension,
      rowsBy: req.rowsBy,
      decision: result.decision,
      k: result.k,
      table: result.table,
      excludedForConsent: result.excludedForConsent,
      reason: result.reason,
    },
    audit: [result.audit],
  }
}

/** The HSE manager's aggregates (k = 5): current levels and today's highest levels per crew. */
export interface HseAggregates {
  current: AggregateView
  today: AggregateView
  site: SiteStatus
}

/** HSE aggregates. Basis: ARCHITECTURE §2 (HSE manager: site aggregates, suppressed below k; never individual records). */
export function selectHseAggregates(input: SelectorInput, actorId: string): Projected<HseAggregates> {
  const current = selectAggregate(input, { role: 'hse_manager', actorId, purpose: 'safety_alerting', dimension: 'current_level', rowsBy: 'crew' })
  const today = selectAggregate(input, { role: 'hse_manager', actorId, purpose: 'compliance_reporting', dimension: 'max_level_today', rowsBy: 'crew' })
  return { model: { current: current.model, today: today.model, site: siteStatus(input.view) }, audit: [...current.audit, ...today.audit] }
}

/** Hours of the site day in one ADOSH TWL zone (environmental data, no individual). */
export interface ZoneHours {
  zone: string
  hours: number
  middayBreakHours: number
}

/** Site hours per TWL zone from the forecast strip (no personal data, no suppression needed). Basis: ADOSH-SF CoP 11.0 v4.0. */
export function zoneHours(hours: readonly SiteHour[]): ZoneHours[] {
  const map = new Map<string, ZoneHours>()
  for (const h of hours) {
    const z = map.get(h.twlZone) ?? { zone: h.twlZone, hours: 0, middayBreakHours: 0 }
    z.hours += 1
    if (h.middayBreak) z.middayBreakHours += 1
    map.set(h.twlZone, z)
  }
  return [...map.values()]
}

/** The regulator's aggregates (k = 10): compliance and public-health tables per site, plus zone hours. */
export interface RegulatorAggregates {
  compliance: AggregateView
  publicHealth: AggregateView
  zoneHours: ZoneHours[]
  site: { id: Site['id']; name: string }
}

/**
 * Regulator aggregates: site × highest level today for compliance reporting and for public-health statistics (the
 * latter counts only workers with `aggregateStatistics` consent), each k = 10 with complementary suppression; zone
 * hours are environmental. Basis: ARCHITECTURE §2 (Regulator: multi-site aggregates, hours in each zone, compliance,
 * k-suppressed; never an individual record), §7.
 */
export function selectRegulatorAggregates(input: SelectorInput, actorId: string): Projected<RegulatorAggregates> {
  const compliance = selectAggregate(input, { role: 'regulator', actorId, purpose: 'compliance_reporting', dimension: 'max_level_today', rowsBy: 'site' })
  const publicHealth = selectAggregate(input, { role: 'regulator', actorId, purpose: 'public_health_statistics', dimension: 'max_level_today', rowsBy: 'site' })
  return {
    model: { compliance: compliance.model, publicHealth: publicHealth.model, zoneHours: zoneHours(input.view.hours), site: { id: input.view.site.id, name: input.view.site.name } },
    audit: [...compliance.audit, ...publicHealth.audit],
  }
}

// ─────────────────────────────── Lab (ground truth — NOT operational) ───────────────────────────────

/** A Lab row: the engine's estimate next to the simulated ground truth. Never shown in an operational view. */
export interface LabWorkerRow {
  workerId: string
  displayName: string
  crewId: string
  task: Task | null
  location: WorkerLocation
  level: RiskLevel | null
  computedLevel: RiskLevel | null
  minutesToLimit: number | null
  hrMeasuredBpm: number | null
  ectempBand: EctempBand | null
  /** Ground truth (SIMULATED COHORT): core temperature, heart rate, dehydration, active symptoms. */
  truth: WorkerView['truth']
}

/**
 * Truth-vs-estimate rows for the Simulation Lab ONLY (ARCHITECTURE §9 #/lab). This is the only selector that reads
 * `WorkerView.truth`; operational views must never call it. Basis: sim/types.ts WorkerView.truth ("Lab view only").
 */
export function selectLabWorkers(view: WorldView): LabWorkerRow[] {
  return view.workers.map((wv) => ({
    workerId: wv.profile.id,
    displayName: wv.profile.displayName,
    crewId: wv.profile.crewId,
    task: wv.task,
    location: wv.location,
    level: wv.assessment?.level ?? null,
    computedLevel: wv.detail?.computedLevel ?? null,
    minutesToLimit: wv.assessment?.minutesToLimit ?? null,
    hrMeasuredBpm: wv.lastHrBpm,
    ectempBand: wv.detail?.physioDisplay ?? null,
    truth: wv.truth ? { ...wv.truth, symptoms: [...wv.truth.symptoms] } : null,
  }))
}

/**
 * Per-minute truth-vs-estimate trace of one worker (config.trace 'full'; empty otherwise), for the Lab charts ONLY.
 * Reads the live world's trace (the one place a view reads `world`). Basis: sim/types.ts WorkerMinute ("Lab/evidence
 * views only, never a worker UI").
 */
export function selectLabTrace(world: Pick<World, 'minutes'> | null, workerId: string, sinceT = -Infinity): WorkerMinute[] {
  if (!world?.minutes) return []
  return world.minutes.filter((m) => m.workerId === workerId && m.t >= sinceT)
}
