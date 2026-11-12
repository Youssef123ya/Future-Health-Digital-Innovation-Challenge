/**
 * Governance centre view-model helpers (pure, no React). Everything shown in #/governance is derived from the live
 * privacy code (src/engine/privacy.ts): the role × purpose matrix, the sync payload, the consent notices and the
 * supervisor driver rules. This module only reshapes that data for display; it never decides access itself.
 * Basis: ARCHITECTURE §7 and §9 (governance centre); GOVERNANCE §2–§6.
 */
import type { ActionId, AuditEntry, ConsentState, DataField, Purpose, Role } from '../../../engine/types'
import {
  ACCESS_MATRIX,
  AUDIT_LOG_RETENTION,
  CHECKIN_RETENTION_MS,
  CONDITION_TEXT,
  CONSENT_RECEIPT_RETENTION,
  DATA_FIELDS,
  FIELD_INFO,
  LEVEL_HISTORY_RETENTION_MS,
  PURPOSE_LABELS,
  RAW_PHYSIOLOGY_RETENTION_MS,
  ROLE_LABELS,
  SUPERVISOR_DRIVER_RULES,
  SYNC_PAYLOAD_KEYS,
  activeProcessing,
  isProhibitedPurpose,
  type AccessRequest,
  type AuditVerification,
  type ConsentCollector,
  type ConsentMethod,
  type ConsentScope,
  type GrantCondition,
  type PooledDriverId,
  type ProcessingId,
  type ProjectionContext,
  type ProjectionResult,
  type SupervisorDriverRule,
  type SyncPayload,
} from '../../../engine/privacy'
import {
  DESIGNED_SUPPRESSION_MAX_LEVEL,
  MONITORED_SCREEN_DRIVER_IDS,
  PLAN_COVERED_ACTIONS,
  PLAN_IN_FORCE_DRIVER_IDS,
} from '../../../engine/alerts'
import { MONITORED_PLAN } from '../../../engine/planner'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../../engine/time'
import { PROHIBITED_DEMO_REQUEST } from '../../../state/governanceStore'
import { caseStatus, supervisedCrewIds, type SelectorInput } from '../../../state/selectors'
import { PAYLOAD_HEARTBEAT_MIN } from '../../../state/syncBus'
import { DEFAULT_ACTOR_IDS } from '../../../state/uiStore'

// ─────────────────────────────── Role × purpose matrix ───────────────────────────────

/** Roles in display order (privacy.ts ROLE_LABELS order: worker first, employer HR last). */
export const ROLE_ORDER: readonly Role[] = Object.freeze(Object.keys(ROLE_LABELS) as Role[])

/** Purposes in display order: the five permitted purposes, then the four prohibited ones. */
export const PURPOSE_ORDER: readonly Purpose[] = Object.freeze(Object.keys(PURPOSE_LABELS) as Purpose[])

export const PERMITTED_PURPOSES: readonly Purpose[] = Object.freeze(PURPOSE_ORDER.filter((p) => !isProhibitedPurpose(p)))
export const PROHIBITED_PURPOSE_LIST: readonly Purpose[] = Object.freeze(PURPOSE_ORDER.filter((p) => isProhibitedPurpose(p)))

/** Short chip text of each grant condition (the full sentence is privacy.ts CONDITION_TEXT). */
export const CONDITION_SHORT: Readonly<Record<GrantCondition, string>> = Object.freeze({
  is_self: 'Self only',
  is_buddy: 'Paired buddy',
  in_actor_crew: 'Own crew',
  active_case: 'Stop / emergency',
  escalated: 'Escalated case',
  medic_sharing_consent: 'Worker consent',
})

/** What a matrix cell allows at a glance. */
export type MatrixCellKind = 'prohibited' | 'individual' | 'aggregate' | 'none'

/** One role × purpose cell, summarised for the grid. */
export interface MatrixCellSummary {
  role: Role
  purpose: Purpose
  kind: MatrixCellKind
  /** Union of the fields every grant can release, in canonical field order. */
  fields: DataField[]
  /** Union of the grant conditions, in first-seen order. */
  conditions: GrantCondition[]
  /** One sentence per grant, e.g. "7 fields when the worker is in the requester's crew". */
  grants: string[]
  /** Some grant releases a clinical field (health or biometric data, or the individual strain projection). */
  clinical: boolean
  aggregateMinCell: number | null
  reason: string
  basis: string
  /** Cell headline, e.g. "7 fields", "Aggregates, k ≥ 5", "Refused, logged", "No access". */
  short: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Summarises one ACCESS_MATRIX cell. Pure; reads the matrix every call (it is frozen). */
export function matrixCell(role: Role, purpose: Purpose): MatrixCellSummary {
  const rule = ACCESS_MATRIX[role][purpose]
  const prohibited = isProhibitedPurpose(purpose)
  const fieldSet = new Set<DataField>()
  const conditions: GrantCondition[] = []
  const grants: string[] = []
  for (const g of rule.grants) {
    for (const f of g.fields) fieldSet.add(f)
    for (const c of g.requires) if (!conditions.includes(c)) conditions.push(c)
    const when = g.requires.length > 0 ? `when ${g.requires.map((c) => CONDITION_TEXT[c]).join(' and ')}` : 'always'
    grants.push(`${plural(g.fields.length, 'field')} ${when}`)
  }
  const fields = DATA_FIELDS.filter((f) => fieldSet.has(f))
  const kind: MatrixCellKind = prohibited
    ? 'prohibited'
    : fields.length > 0
      ? 'individual'
      : rule.aggregateMinCell !== null
        ? 'aggregate'
        : 'none'
  const short =
    kind === 'prohibited'
      ? 'Refused, logged'
      : kind === 'individual'
        ? plural(fields.length, 'field')
        : kind === 'aggregate'
          ? `Aggregates, k ≥ ${String(rule.aggregateMinCell)}`
          : 'No access'
  return {
    role,
    purpose,
    kind,
    fields,
    conditions,
    grants,
    clinical: fields.some((f) => FIELD_INFO[f].class === 'clinical'),
    aggregateMinCell: rule.aggregateMinCell,
    reason: rule.reason,
    basis: rule.basis,
    short,
  }
}

/** Accessible name of a matrix cell button. */
export function cellAriaLabel(cell: MatrixCellSummary): string {
  const head = `${ROLE_LABELS[cell.role]}, ${PURPOSE_LABELS[cell.purpose]}`
  if (cell.kind === 'prohibited') return `${head}: prohibited purpose, refused for every role and logged`
  if (cell.kind === 'none') return `${head}: no access`
  const parts = [...cell.grants]
  if (cell.aggregateMinCell !== null) parts.push(`aggregates with groups smaller than ${cell.aggregateMinCell} suppressed`)
  return `${head}: ${parts.join('; ')}${cell.clinical ? '; includes clinical fields' : ''}`
}

/** Shortens a long basis string for a tooltip (the detail panel shows it in full). */
export function clip(text: string, max = 220): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** Splits a basis string ("A; B; C") into its citations. */
export function citations(basis: string): string[] {
  return basis
    .split(/;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ─────────────────────────────── Sync payload ───────────────────────────────

/** Plain-language meaning of every key of the outbound payload. Basis: privacy.ts SyncPayload, payloadForSync. */
export const PAYLOAD_KEY_INFO: Readonly<Record<keyof SyncPayload, { label: string; note: string }>> = Object.freeze({
  v: { label: 'Schema version', note: 'Payload format version 1.' },
  pseudonym: { label: 'Pseudonymous id', note: 'No name. The supervisor console maps it to its own crew roster.' },
  crewId: { label: 'Crew', note: 'Routes crew alerts to the right supervisor.' },
  level: { label: 'Zill level', note: 'Shown on consoles with colour, pictogram and text.' },
  actions: {
    label: 'Console actions',
    note: 'What a supervisor can act on. Drink, electrolyte, check-in and buddy prompts stay on the phone.',
  },
  workMinPerHour: { label: 'Work minutes per hour', note: 'The operational work/rest allowance, floored to whole minutes.' },
  waterMlPerHour: {
    label: 'Water (legacy key)',
    note: 'Always 0. A personal water figure could reveal fasting or body size, so it never leaves the phone.',
  },
  ack: { label: 'Acknowledgement', note: 'Whether the open alert has been acknowledged.' },
  t: { label: 'Time', note: 'When the phone made this assessment.' },
  confidence: {
    label: 'Data confidence',
    note: 'Never displayed on consoles: it can reflect wearable signal quality (open governance item).',
  },
})

/** Payload as display lines (canonical key order, one key per line); joined, it parses back to the payload. */
export function payloadLines(p: SyncPayload): { key: keyof SyncPayload; text: string }[] {
  return SYNC_PAYLOAD_KEYS.map((key, i) => ({
    key,
    text: `  ${JSON.stringify(key)}: ${JSON.stringify(p[key])}${i < SYNC_PAYLOAD_KEYS.length - 1 ? ',' : ''}`,
  }))
}

/** What the phone remembers about the last payload it sent. */
export interface SyncTracker {
  key: string | null
  t: number
  payload: SyncPayload | null
}

export const NO_SYNC: SyncTracker = Object.freeze({ key: null, t: Number.NEGATIVE_INFINITY, payload: null })

/** Why a payload was (or would be) transmitted. */
export type SyncReason = 'first' | 'change' | 'heartbeat'

export interface SyncStep {
  reason: SyncReason
  /** Keys whose value changed since the last transmission (time excluded). */
  changed: (keyof SyncPayload)[]
  tracker: SyncTracker
}

/** Payload identity without its time stamp (state/syncBus.ts sends on a change of this key). */
export function payloadKey(p: SyncPayload): string {
  return JSON.stringify({ ...p, t: 0 })
}

/** Keys whose value differs between two payloads, in canonical order, time excluded. */
export function changedPayloadKeys(a: SyncPayload, b: SyncPayload): (keyof SyncPayload)[] {
  return SYNC_PAYLOAD_KEYS.filter((k) => k !== 't' && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

/**
 * The phone's transmission rule, mirrored from state/syncBus.ts: send when the payload (time excluded) changes, else
 * re-send after {@link PAYLOAD_HEARTBEAT_MIN} simulated minutes. A new worker or a backward clock jump starts afresh.
 * Returns null when nothing would be sent.
 */
export function nextSync(prev: SyncTracker, payload: SyncPayload, heartbeatMin: number = PAYLOAD_HEARTBEAT_MIN): SyncStep | null {
  const key = payloadKey(payload)
  const tracker: SyncTracker = { key, t: payload.t, payload }
  if (prev.key === null || prev.payload === null || payload.t < prev.t || payload.pseudonym !== prev.payload.pseudonym) {
    return { reason: 'first', changed: [], tracker }
  }
  if (key !== prev.key) return { reason: 'change', changed: changedPayloadKeys(prev.payload, payload), tracker }
  if (payload.t - prev.t >= heartbeatMin * MINUTE_MS) return { reason: 'heartbeat', changed: [], tracker }
  return null
}

/** Group of on-device record keys in the inspector. */
export type DeviceGroupId = 'reasons' | 'numbers' | 'body' | 'heat' | 'identity' | 'work' | 'consent' | 'other'

export const DEVICE_GROUPS: Readonly<Record<DeviceGroupId, { title: string; why: string }>> = Object.freeze({
  reasons: {
    title: 'Why the level is what it is',
    why: 'Channel detail and clinical reasons. Consoles get generic or pooled phrases instead.',
  },
  numbers: {
    title: 'Individual numbers',
    why: 'Minutes to limit, water and data quality could reveal health, fasting or consent.',
  },
  body: { title: 'Body and health', why: 'Personal and sensitive data, used on the phone only.' },
  heat: { title: 'Acclimatisation history', why: 'A supervisor may see a schedule cap, never the history behind it.' },
  identity: { title: 'Identity', why: 'The payload carries a pseudonym; the name stays in the roster and on the phone.' },
  work: { title: 'Work context', why: 'Used on the phone to compute the limits.' },
  consent: { title: 'Consent and devices', why: 'Never sent, so no console can read or infer a consent choice.' },
  other: { title: 'Other device fields', why: 'Not part of the payload.' },
})

const DEVICE_KEY_INFO: Readonly<Record<string, { label: string; group: DeviceGroupId }>> = Object.freeze({
  'assessment.channels': { label: 'Risk channels and their levels', group: 'reasons' },
  'assessment.drivers': { label: 'Reasons, including clinical ones', group: 'reasons' },
  'assessment.minutesToLimit': { label: 'Minutes to the strain limit', group: 'numbers' },
  'assessment.waterMlPerHour': { label: 'Personal water figure', group: 'numbers' },
  'assessment.dataQuality': { label: 'Sensor and data quality', group: 'numbers' },
  'profile.displayName': { label: 'Name', group: 'identity' },
  'profile.ageYears': { label: 'Age', group: 'body' },
  'profile.sex': { label: 'Sex', group: 'body' },
  'profile.massKg': { label: 'Body mass', group: 'body' },
  'profile.heightCm': { label: 'Height', group: 'body' },
  'profile.restingHrBpm': { label: 'Resting heart rate', group: 'body' },
  'profile.riskFlags': { label: 'Health factors', group: 'body' },
  'profile.daysOnSite': { label: 'Days on site', group: 'heat' },
  'profile.daysAwayRecent': { label: 'Recent days away', group: 'heat' },
  'profile.experiencedInHeat': { label: 'Heat experience', group: 'heat' },
  'profile.siteId': { label: 'Site', group: 'work' },
  'profile.language': { label: 'Language', group: 'work' },
  'profile.clothing': { label: 'Clothing and PPE', group: 'work' },
  'profile.consent': { label: 'Consent choices', group: 'consent' },
  'profile.hasWearable': { label: 'Paired band', group: 'consent' },
})

const DEVICE_GROUP_ORDER: readonly DeviceGroupId[] = ['reasons', 'numbers', 'body', 'heat', 'identity', 'work', 'consent', 'other']

export interface DeviceGroup {
  id: DeviceGroupId
  title: string
  why: string
  items: { key: string; label: string }[]
}

/**
 * Groups privacy.ts SyncInspection.keptOnDevice keys for display. Unknown keys are kept (group 'other', labelled with
 * the key) so the inspector stays truthful when the engine adds a field.
 */
export function groupKeptOnDevice(keys: readonly string[]): DeviceGroup[] {
  const byGroup = new Map<DeviceGroupId, { key: string; label: string }[]>()
  for (const key of keys) {
    const info = DEVICE_KEY_INFO[key]
    const group = info?.group ?? 'other'
    const list = byGroup.get(group) ?? []
    list.push({ key, label: info?.label ?? key })
    byGroup.set(group, list)
  }
  return DEVICE_GROUP_ORDER.filter((g) => byGroup.has(g)).map((id) => ({ id, ...DEVICE_GROUPS[id], items: byGroup.get(id) ?? [] }))
}

/** Records the phone holds outside the assessment and profile (never in any payload). Basis: GOVERNANCE §2.3. */
export const DEVICE_ONLY_RECORDS: readonly { label: string; note: string }[] = Object.freeze([
  { label: 'Raw heart-rate samples, ECTemp and PSI traces', note: 'Purged after 24 h' },
  { label: 'Check-in answers and logged drinks', note: 'Kept 30 days on the phone' },
  {
    label: 'Step detail: monitored mode and fallback reason, resume holds, water balance, drink reminders',
    note: 'This phone only',
  },
  { label: 'Level history', note: '30 days, under a pseudonym' },
])

// ─────────────────────────────── Prohibited-request demo ───────────────────────────────

/** A ready-made access request for the demo form. */
export interface RequestPreset {
  id: string
  label: string
  role: Role
  purpose: Purpose
  fields: DataField[]
}

/** The first preset is the challenge brief's case (state/governanceStore.ts PROHIBITED_DEMO_REQUEST). */
export const REQUEST_PRESETS: readonly RequestPreset[] = Object.freeze([
  {
    id: 'hr-performance',
    label: 'Employer HR asks for heart rate for a performance review',
    role: 'employer_hr',
    purpose: 'performance_management',
    fields: ['hrBpm'],
  },
  {
    id: 'hr-insurance',
    label: 'Employer HR asks for symptoms for insurance underwriting',
    role: 'employer_hr',
    purpose: 'insurance_underwriting',
    fields: ['symptoms', 'riskFlags'],
  },
  {
    id: 'supervisor-hr',
    label: 'Supervisor asks for heart rate with the level, for safety alerting',
    role: 'supervisor',
    purpose: 'safety_alerting',
    fields: ['level', 'actions', 'hrBpm'],
  },
  {
    id: 'oh-clinical',
    label: 'Occupational health asks for clinical detail',
    role: 'occ_health',
    purpose: 'clinical_care',
    fields: ['level', 'hrBpm', 'ctEstC', 'symptoms'],
  },
])

/** Requester id the form proposes for a role (the subject for the worker, the roster's buddy and supervisor). */
export function defaultActorFor(role: Role, ctx: { subjectId: string | null; buddyId?: string; supervisorId?: string }): string {
  switch (role) {
    case 'worker':
      return ctx.subjectId ?? 'worker'
    case 'buddy':
      return ctx.buddyId ?? 'buddy'
    case 'supervisor':
      return ctx.supervisorId ?? 'supervisor'
    default:
      return DEFAULT_ACTOR_IDS[role]
  }
}

/** Outcome of a request as the result panel names it. */
export type RequestOutcome = 'refused' | 'partial' | 'allowed'

export function requestOutcome(r: Pick<ProjectionResult, 'decision' | 'withheld'>): RequestOutcome {
  if (r.decision === 'denied') return 'refused'
  return r.withheld.length > 0 ? 'partial' : 'allowed'
}

// ─────────────────────────────── Audit chain ───────────────────────────────

/** First `n` hex digits of a hash. */
export function hashPrefix(hash: string, n = 10): string {
  return hash.slice(0, n)
}

export interface AuditFilter {
  decision: 'all' | 'denied'
  role: Role | 'all'
  /** Only entries about this worker; null = everyone. */
  subjectId: string | null
}

/** Entries matching the filter, newest first. */
export function filterAudit(entries: readonly AuditEntry[], f: AuditFilter): AuditEntry[] {
  const out: AuditEntry[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (f.decision === 'denied' && e.decision !== 'denied') continue
    if (f.role !== 'all' && e.actorRole !== f.role) continue
    if (f.subjectId !== null && e.subjectId !== f.subjectId) continue
    out.push(e)
  }
  return out
}

/** "Who saw my data", per role. */
export interface AccessSummary {
  role: Role
  actors: string[]
  count: number
  refused: number
  lastT: number
  purposes: Purpose[]
}

/** Summarises a worker's audit entries by requesting role, in role display order. */
export function summarizeAccess(entries: readonly AuditEntry[]): AccessSummary[] {
  const byRole = new Map<Role, AccessSummary>()
  for (const e of entries) {
    const s = byRole.get(e.actorRole) ?? { role: e.actorRole, actors: [], count: 0, refused: 0, lastT: Number.NEGATIVE_INFINITY, purposes: [] }
    s.count += 1
    if (e.decision === 'denied') s.refused += 1
    if (!s.actors.includes(e.actorId)) s.actors.push(e.actorId)
    if (!s.purposes.includes(e.purpose)) s.purposes.push(e.purpose)
    s.lastT = Math.max(s.lastT, e.t)
    byRole.set(e.actorRole, s)
  }
  return ROLE_ORDER.flatMap((r) => {
    const s = byRole.get(r)
    return s ? [s] : []
  })
}

/** Field labels of an audit entry (privacy.ts FIELD_INFO), unknown keys kept as is. */
export function fieldLabels(fields: readonly string[]): string[] {
  return fields.map((f) => (Object.prototype.hasOwnProperty.call(FIELD_INFO, f) ? FIELD_INFO[f as DataField].label : f))
}

/** Rows of the tamper demo's before/after table: only the keys the patch changed. */
export function tamperDiff(original: AuditEntry, tampered: AuditEntry): { key: string; before: string; after: string }[] {
  const keys = Object.keys(tampered) as (keyof AuditEntry)[]
  return keys
    .filter((k) => JSON.stringify(original[k]) !== JSON.stringify(tampered[k]))
    .map((k) => ({ key: k, before: String(original[k]), after: String(tampered[k]) }))
}

// ─────────────────────────────── Consent ───────────────────────────────

/** Display names of the processing activities (privacy.ts activeProcessing). */
export const PROCESSING_LABELS: Readonly<Record<ProcessingId, string>> = Object.freeze({
  core_safety_alerting: 'Core safety alerting',
  wearable_physiology: 'Heart rate from the band',
  personalised_thresholds: 'Health factors make limits stricter',
  symptom_checkins: 'Symptom and hydration check-ins',
  clinical_sharing_on_escalation: 'Clinical detail to occupational health on escalation',
  aggregate_statistics: 'Public-health statistics',
})

/** Processing activities whose on/off state differs between two consent states. */
export function processingChanges(before: ConsentState, after: ConsentState): ProcessingId[] {
  const was = new Map(activeProcessing(before).map((p) => [p.id, p.active]))
  return activeProcessing(after)
    .filter((p) => was.get(p.id) !== p.active)
    .map((p) => p.id)
}

/** What a consent change does on the worker's phone (ARCHITECTURE §7; sim/worldsim.ts applyConsent). */
export const CONSENT_DEVICE_EFFECT: Readonly<Record<ConsentScope, { on: string; off: string }>> = Object.freeze({
  wearable: {
    on: 'The phone reads heart rate from the band and estimates strain. Physiology can only raise the level.',
    off: 'The phone stops reading heart rate: no strain estimate, no monitored mode. Alerting continues from site heat and work.',
  },
  healthFlags: {
    on: 'Declared health factors make this worker’s limits stricter, on the phone only.',
    off: 'Health factors are not used, so they cannot make the limits stricter.',
  },
  checkins: {
    on: 'Own check-ins and logged drinks are used, including the water credit for drinks.',
    off: 'Own check-ins and logged drinks are not used (no water credit). A buddy or first aider can still report danger signs.',
  },
  shareWithMedicOnEscalation: {
    on: 'On an escalated case, occupational health may see the clinical detail.',
    off: 'Occupational health sees an escalated case without clinical detail.',
  },
  aggregateStatistics: {
    on: 'Counted in public-health statistics (groups under 10 hidden).',
    off: 'Not counted in public-health statistics. Legal-duty group totals still count everyone, suppressed below k.',
  },
})

// ─────────────────────────────── What supervisors never see ───────────────────────────────

/** Engine driver ids that a supervisor rule maps to (privacy.ts SUPERVISOR_DRIVER_RULES). */
export function driversByRule(rule: SupervisorDriverRule): string[] {
  return Object.entries(SUPERVISOR_DRIVER_RULES)
    .filter(([, r]) => r === rule)
    .map(([id]) => id)
}

/** The private reasons each pooled phrase hides (privacy.ts POOLED_DRIVERS documentation). */
export const POOLED_HIDES: Readonly<Record<PooledDriverId, readonly string[]>> = Object.freeze({
  not_cleared_for_heat_work: [
    'An ISO 7933 strain limit reached or not yet restored',
    'Drinking restricted while fasting',
    'A resume hold: heat-zone rule, WBGT stop limit, midday ban or heat-exposure limit',
    'The task is not feasible at the worker’s own limit',
    'The acclimatisation allowance is used up',
    'A clinical latch or no more hot work today',
    'A monitored-mode fallback that stops the work',
  ],
  device_directed_rest: [
    'Conservative mode from a declared health factor',
    'Fasting',
    'A stricter tier for a new or returning worker',
    'Consent state, including a declined wearable',
    'Monitored mode in force',
    'Monitored-mode fallback to the table limits (consent, data, model or status)',
  ],
})

// ─────────────────────────────── Retention and documents ───────────────────────────────

/** A retention period in words: "24 hours", "30 days"; null = "Set by legal review". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'Set by legal review'
  if (ms >= 2 * DAY_MS && ms % DAY_MS === 0) return plural(ms / DAY_MS, 'day')
  if (ms > 0 && ms % HOUR_MS === 0) return plural(ms / HOUR_MS, 'hour')
  return plural(Math.round(ms / MINUTE_MS), 'minute')
}

/** Where the project documents are published (the app itself serves only public/). */
export const DOCS_BASE_URL = 'https://github.com/Youssef123ya/Future-Health-Digital-Innovation-Challenge/blob/main/docs/'

/**
 * GitHub's heading anchor (github-slugger): lower case, punctuation and symbols removed, spaces to hyphens.
 * "## 3. Who may see what: the role × purpose matrix" → "3-who-may-see-what-the-role--purpose-matrix".
 */
export function githubSlug(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/** A link to a heading of a project document. */
export function docLink(file: string, heading: string): string {
  return `${DOCS_BASE_URL}${file}#${githubSlug(heading)}`
}

/** GOVERNANCE.md sections linked from the centre (headings copied verbatim). */
export const GOVERNANCE_DOC_LINKS: readonly { label: string; heading: string; href: string }[] = Object.freeze(
  [
    { label: 'What leaves the worker’s device', heading: "2.4 What leaves the worker's device" },
    { label: 'Where data lives and how long it is kept', heading: '2.3 Where data lives and how long it is kept' },
    { label: 'Role × purpose matrix', heading: '3. Who may see what: the role × purpose matrix' },
    { label: 'Consent scopes, receipts and withdrawal', heading: '4. Consent' },
    { label: 'Prohibited purposes and their enforcement', heading: '5. Prohibited purposes and their enforcement' },
    { label: 'Audit log and the published chain head', heading: '6. Audit log, "who saw my data", and the published chain head' },
    { label: 'Aggregates and k-suppression', heading: '7. Aggregates and k-suppression' },
    { label: 'Device status and claims framing', heading: '9. Device status and claims framing' },
    { label: 'Open governance decisions', heading: '13. Open governance decisions' },
  ].map((l) => ({ ...l, href: docLink('GOVERNANCE.md', l.heading) })),
)

// ─────────────────────────────── Request demo: context ───────────────────────────────

/**
 * The request-time facts of a demo access request, built the way the console selectors build them
 * (state/selectors.ts): the subject's open case decides `escalated`; a buddy request is checked against the subject's
 * paired buddy, a supervisor request against the crews the requester supervises. Pure.
 */
export function requestContext(
  input: Pick<SelectorInput, 'view' | 'roster'>,
  request: Pick<AccessRequest, 'role' | 'actorId'>,
  subjectId: string,
): ProjectionContext {
  const ctx: ProjectionContext = { now: input.view.t, escalated: caseStatus(input.view.alerts, subjectId).escalated }
  if (request.role === 'buddy') {
    const paired = input.roster[subjectId]?.buddyId
    ctx.buddyIds = paired ? [paired] : []
  }
  if (request.role === 'supervisor') ctx.actorCrewIds = supervisedCrewIds(input, request.actorId)
  return ctx
}

/** True when a request is exactly the brief's case, which governanceStore.runProhibitedRequestDemo logs. */
export function isBriefCase(request: Pick<AccessRequest, 'role' | 'purpose' | 'fields'>): boolean {
  const want = PROHIBITED_DEMO_REQUEST.fields ?? []
  const got = request.fields ?? []
  return (
    request.role === PROHIBITED_DEMO_REQUEST.role &&
    request.purpose === PROHIBITED_DEMO_REQUEST.purpose &&
    got.length === want.length &&
    want.every((f) => got.includes(f))
  )
}

// ─────────────────────────────── Audit chain status ───────────────────────────────

/** The integrity state shown for the chain. `stale` = entries appended since the last verification. */
export type ChainStatus =
  | { kind: 'unchecked' }
  | { kind: 'ok'; length: number; head: string; stale: number }
  | { kind: 'broken'; brokenAt: number; reason: string }

export function chainStatus(v: AuditVerification | null, entryCount: number): ChainStatus {
  if (v === null) return { kind: 'unchecked' }
  if (!v.ok) return { kind: 'broken', brokenAt: v.brokenAt, reason: v.reason }
  return { kind: 'ok', length: v.length, head: v.head, stale: Math.max(0, entryCount - v.length) }
}

// ─────────────────────────────── Consent collection ───────────────────────────────

/**
 * Who collects a consent change in the demo. 'supervisor' is offered on purpose: privacy.ts createConsentReceipt
 * refuses it (DoH SBR 2026: a hierarchical superior may not obtain a worker's consent), and the ledger shows the refusal.
 */
export type CollectorChoice = ConsentCollector | 'supervisor'

export const COLLECTOR_OPTIONS: readonly { id: CollectorChoice; label: string }[] = Object.freeze([
  { id: 'self', label: 'The worker (own phone)' },
  { id: 'research_staff', label: 'Research staff (pilot)' },
  { id: 'occ_health', label: 'Occupational health' },
  { id: 'supervisor', label: 'Crew supervisor (not allowed)' },
])

export const COLLECTOR_LABELS: Readonly<Record<ConsentCollector, string>> = Object.freeze({
  self: 'Worker (self)',
  research_staff: 'Research staff',
  occ_health: 'Occupational health',
})

export const METHOD_LABELS: Readonly<Record<ConsentMethod, string>> = Object.freeze({
  electronic_affirmative_action: 'Tap to agree on the phone',
  written_signature: 'Written signature',
  witnessed_mark: 'Witnessed mark (impartial witness signs)',
})

// ─────────────────────────────── What supervisors never see ───────────────────────────────

/** Number of engine driver ids per supervisor rule (privacy.ts SUPERVISOR_DRIVER_RULES). */
export function supervisorRuleCounts(): Record<SupervisorDriverRule, number> {
  const counts: Record<SupervisorDriverRule, number> = {
    site: 0,
    phrase: 0,
    not_cleared_for_heat_work: 0,
    device_directed_rest: 0,
    withhold: 0,
  }
  for (const rule of Object.values(SUPERVISOR_DRIVER_RULES)) counts[rule] += 1
  return counts
}

/** Individual figures and states that never reach a supervisor, HSE or regulator screen (engine-api-wave2d §0). */
export const NEVER_TO_SUPERVISORS: readonly string[] = Object.freeze([
  'Minutes to the strain limit, rest estimate and work-bout countdown',
  'Metabolic rate (W/m²) and the worker’s personal limit',
  'Personal water figure, logged drinks and water balance',
  'Heart rate, ECTemp and PSI',
  'Symptoms, urine colour and health factors',
  'Fasting, extra-care (conservative) mode and consent choices',
  'Monitored-mode status and the reason for a fallback',
  'Data confidence (it can reflect a removed band)',
])

/** Designed suppression (ANSI/ISA-18.2): what is logged and notified to nobody. Basis: engine/alerts.ts. */
export const LOGGED_NOT_SENT: readonly { title: string; detail: string; drivers: readonly string[] }[] = Object.freeze([
  {
    title: 'Exposure advisory the plan already enforces',
    detail: `Caution or ${DESIGNED_SUPPRESSION_MAX_LEVEL}, driven by site or crew conditions only, every console action already in the day plan, and the plan’s work/rest cap in force.`,
    drivers: PLAN_IN_FORCE_DRIVER_IDS,
  },
  {
    title: 'WBGT screen in monitored mode',
    detail: `Caution or ${DESIGNED_SUPPRESSION_MAX_LEVEL}, environment only: the WBGT tables are a screen and the worker’s own limits enforce.`,
    drivers: MONITORED_SCREEN_DRIVER_IDS,
  },
])

/** Console actions a day plan already puts in force (an advisory asking for anything else is never suppressed). */
export const PLAN_COVERED_ACTION_IDS: readonly ActionId[] = PLAN_COVERED_ACTIONS

/** Alert classes designed suppression never applies to. Basis: engine/alerts.ts designedSuppressionOf. */
export const NEVER_SUPPRESSED: readonly { title: string; detail: string }[] = Object.freeze([
  { title: 'Stop and emergency', detail: 'They always call for an operator action.' },
  { title: 'Individual basis', detail: 'A cause specific to one worker is always notified.' },
  { title: 'Symptoms, physiology and hydration', detail: 'Clinical causes are always notified.' },
  { title: 'First-aid cases', detail: 'A page to the first aider is never held back.' },
])

// ─────────────────────────────── Site settings: monitored mode ───────────────────────────────

/** What the monitored plan basis requires (ARCHITECTURE §1.5, §7; wave 2d; GOVERNANCE §5.3). */
export const MONITORED_REQUIREMENTS: readonly { title: string; detail: string }[] = Object.freeze([
  {
    title: 'Occupational-health sign-off, logged',
    detail: 'The site opts in only with a named occupational-health sign-off. The change, the time and who signed are logged.',
  },
  {
    title: 'Per worker, only when every condition holds',
    detail:
      'Acclimatised, a paired band with wearable consent on, valid data, and an ISO 7933 model that applies. Every other worker follows the table limits.',
  },
  {
    title: 'Immediate fallback to the table limits',
    detail:
      'If monitoring lapses (consent, data, model or status), the phone returns to the WBGT table limits in the same minute. The supervisor sees only “device-directed rest”.',
  },
  {
    title: 'Declining never costs the worker',
    detail: 'Declining or switching off the wearable never affects pay, assignment or evaluation.',
  },
  {
    title: 'Rest is never a performance measure',
    detail: 'Device-directed rest is never counted, ranked or used in a performance or disciplinary process: both are prohibited purposes.',
  },
])

/** The citations of the monitored plan (planner.ts MONITORED_PLAN). */
export const MONITORED_BASIS: readonly string[] = MONITORED_PLAN.basis

// ─────────────────────────────── Retention and claims ───────────────────────────────

export interface RetentionRow {
  data: string
  where: string
  period: string
  note?: string
  basis: string
}

/** Retention periods, read from the privacy code (null periods are set by legal review). Basis: GOVERNANCE §2.3. */
export const RETENTION_ROWS: readonly RetentionRow[] = Object.freeze([
  {
    data: 'Raw heart-rate samples, ECTemp and PSI traces',
    where: 'Worker’s phone only',
    period: formatDuration(RAW_PHYSIOLOGY_RETENTION_MS),
    note: 'A sample exactly 24 hours old is purged.',
    basis: 'ARCHITECTURE §7; ILO code §6.14(1)',
  },
  {
    data: 'Check-in answers and logged drinks',
    where: 'Worker’s phone',
    period: formatDuration(CHECKIN_RETENTION_MS),
    note: 'Kept longer only while occupational health holds an escalated case open.',
    basis: 'Data minimisation; GOVERNANCE §13 item 5; ILO code §8.2',
  },
  {
    data: 'Level history (level, actions, work/rest, acknowledgement)',
    where: 'Phone and site console, under a pseudonym',
    period: formatDuration(LEVEL_HISTORY_RETENTION_MS),
    basis: 'ARCHITECTURE §7',
  },
  {
    data: 'Audit log',
    where: 'Prototype: in memory in this browser',
    period: formatDuration(AUDIT_LOG_RETENTION.ms),
    note: AUDIT_LOG_RETENTION.mustCover,
    basis: AUDIT_LOG_RETENTION.decidedBy,
  },
  {
    data: 'Consent receipts',
    where: 'Consent ledger',
    period: formatDuration(CONSENT_RECEIPT_RETENTION.ms),
    note: CONSENT_RECEIPT_RETENTION.mustCover,
    basis: CONSENT_RECEIPT_RETENTION.decidedBy,
  },
  {
    data: 'Aggregates (k-suppressed tables)',
    where: 'HSE console and regulator reports',
    period: 'Retained',
    note: 'They contain no individual record.',
    basis: 'ARCHITECTURE §7',
  },
])

/** The intended-purpose statement, verbatim (GOVERNANCE §9). */
export const INTENDED_PURPOSE =
  'Zill is occupational safety software. It helps employers and workers apply the heat-stress controls set out in UAE occupational safety rules: the MoHRE midday break, and ADPHC/OSHAD Thermal Work Limit work-rest and hydration schedules. It converts site environmental measurements and forecasts into work-rest and hydration schedules. It delivers multilingual safety instructions. It records worker-reported symptoms in order to trigger the employer’s first-aid and escalation procedure. Zill does not diagnose, treat, monitor or predict any disease or medical condition in an individual, and it is not a substitute for first aid or medical care.'

/** Claims Zill never makes, and wording that is fine (GOVERNANCE §9). */
export const CLAIMS_AVOID: readonly string[] = Object.freeze([
  'Predicts heat stroke or detects heat exhaustion',
  'Measures or estimates core body temperature',
  'Screens fitness for work',
  'Any individual risk score presented as a medical risk',
])

export const CLAIMS_FINE: readonly string[] = Object.freeze([
  'Implements ADPHC TWL work-rest schedules',
  'Schedules rest and hydration',
  'Escalates symptom reports to your first aider',
  'Estimated strain indicator, shown with its uncertainty',
])
