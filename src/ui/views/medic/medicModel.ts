/**
 * Pure view-model helpers of the first-aid and occupational-health view (#/medic). They work only on (a) what the role
 * projection released (state/selectors.ts FirstAiderModel / OccHealthModel), (b) the role/time record of the released
 * case alert (Alert.acks, escalatedAt, escalatedTo, resolvedAt: never its reason or the worker's own actions), (c) the
 * console's own entries (the first aider's re-checks, the cooling checklist) and (d) static reference data:
 * engine/clinical.ts (symptom tiers, triage timing, urine chart), RISK_THRESHOLDS.recovery (ISO 7933 recovery review),
 * engine/physio.ts (ECTemp display band, PSI floors), engine/regulation.ts (ADOSH Form G). They never read ground truth
 * or the device detail. Basis: ARCHITECTURE §1 principles 4–5, §2 (first aider and occupational health rows), §6.
 */
import { RISK_ORDER, type ActionId, type Alert, type DataField, type RiskDriver, type RiskLevel, type Role, type SymptomId } from '../../../engine/types'
import { SYMPTOM_RULES, TRIAGE_TIMING, urineAssessment, type FirstAidStep } from '../../../engine/clinical'
import { RISK_THRESHOLDS, type WorkerLocation as Place } from '../../../engine/risk'
import { ECTEMP_DISPLAY, PHYSIO_FLOORS } from '../../../engine/physio'
import { DEFAULT_RULE_PACK, heatIncidentNotification, type HeatIncidentOutcome, type RulePack } from '../../../engine/regulation'
import type { AckStatus, ProjectedData } from '../../../engine/privacy'
import type { Notification } from '../../../engine/alerts'
import { CONSOLE_PHRASES } from '../../../i18n/messages'
import { DAY_MS, HOUR_MS, MINUTE_MS, formatLocalHhmm, localParts, startOfLocalDay } from '../../../engine/time'
import type { AppliedInjection } from '../../../state/simStore'
import { CASE_SYMPTOM_WINDOW_MIN, type AlertItem } from '../../../state/selectors'

export type { Place }

/** The two roles of this view. */
export type MedicRole = 'first_aider' | 'occ_health'

/** Display names of the roles that appear in a case record (role and time only, never a person). */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  worker: 'Worker (own device)',
  buddy: 'Buddy',
  supervisor: 'Supervisor',
  first_aider: 'First aider',
  occ_health: 'Occupational health',
  hse_manager: 'HSE manager',
  regulator: 'Regulator',
  employer_hr: 'Employer HR',
}

const LEVEL_WORD: Readonly<Record<RiskLevel, string>> = { safe: 'Safe', caution: 'Caution', high: 'High', stop: 'Stop', emergency: 'Emergency' }

// ─────────────────────────────── Location (released field) ───────────────────────────────

/** The first aider's location label split into its parts (state/selectors.ts caseLocation). */
export interface ParsedLocation {
  site: string | null
  /** Task name, or null when the worker is not on a task (or the label could not be read). */
  task: string | null
  /** Sun, shade or the cooled rest area; null when the label could not be read. */
  place: Place | null
  /** Off task and out of the sun: the rest that counts toward a recovery review (engine/risk.ts recovery bout). */
  resting: boolean
}

const PLACE_PHRASE: Readonly<Record<Place, 'location_sun' | 'location_shade' | 'location_indoor_cool'>> = {
  sun: 'location_sun',
  shade: 'location_shade',
  indoor_cool: 'location_indoor_cool',
}

/**
 * Reads the released location label "<site> · <task or 'not on a task'> · <sun/shade/cooled>" in any console language
 * (i18n/messages.ts CONSOLE_PHRASES). An unreadable label is never counted as rest (protective).
 */
export function parseCaseLocation(label: string | null | undefined): ParsedLocation {
  if (!label) return { site: null, task: null, place: null, resting: false }
  const parts = label.split(' · ')
  const last = parts[parts.length - 1] ?? ''
  let place: Place | null = null
  let noTask = false
  const taskPart = parts.length >= 3 ? parts.slice(1, -1).join(' · ') : null
  for (const phrases of Object.values(CONSOLE_PHRASES)) {
    if (place === null) {
      for (const p of Object.keys(PLACE_PHRASE) as Place[]) if (phrases[PLACE_PHRASE[p]] === last) place = p
    }
    if (taskPart !== null && phrases.no_task === taskPart) noTask = true
  }
  return {
    site: parts.length >= 2 ? (parts[0] ?? null) : null,
    task: taskPart === null || noTask ? null : taskPart,
    place,
    resting: place !== null && place !== 'sun' && noTask,
  }
}

/** Plain words for a place. */
export const PLACE_WORDS: Readonly<Record<Place, string>> = { sun: 'in the sun', shade: 'in shade', indoor_cool: 'in the cooled rest area' }

// ─────────────────────────────── Rest observed on this console ───────────────────────────────

/** One observation of the released location. */
export interface PlaceObs {
  t: number
  place: Place | null
  resting: boolean
}

/** Rest requirement of a reached ISO 7933 limit before a reviewed restart (engine/risk.ts RISK_THRESHOLDS.recovery). */
export const RECOVERY_REST = Object.freeze({
  cooledMin: RISK_THRESHOLDS.recovery.cooledRestMin,
  shadeMin: RISK_THRESHOLDS.recovery.shadeRestMin,
  /** [ENG] Two observations further apart than this are not assumed to be one continuous rest bout (protective). */
  maxGapMin: 15,
  basis: RISK_THRESHOLDS.recovery.basis,
})

/** Rest of the current continuous bout, as observed from the released location. */
export interface RestStatus {
  boutStartT: number | null
  cooledMin: number
  shadeMin: number
  /** cooled / 30 + shade / 45, capped at 1 (engine/risk.ts recoveryProgress). */
  progress: number
  /** When the observed bout first met the requirement. */
  metT: number | null
  restingNow: boolean
  placeNow: Place | null
  lastObsT: number | null
  firstObsT: number | null
}

/**
 * Rest of the current bout from successive location observations: an interval counts for the place seen at its start
 * when both ends are resting; work, sun, an unreadable label or a gap above {@link RECOVERY_REST}.maxGapMin restarts
 * the bout (as on the device: work or time in the sun restarts the rest requirement). Counting starts at the first
 * resting observation, so the console never shows more rest than the device counts.
 */
export function restProgress(obs: readonly PlaceObs[], req: Pick<typeof RECOVERY_REST, 'cooledMin' | 'shadeMin' | 'maxGapMin'> = RECOVERY_REST): RestStatus {
  let boutStartT: number | null = null
  let cooled = 0
  let shade = 0
  let metT: number | null = null
  let prev: PlaceObs | null = null
  const progressOf = () => Math.min(1, cooled / req.cooledMin + shade / req.shadeMin)
  for (const o of obs) {
    if (!o.resting) {
      boutStartT = null
      cooled = 0
      shade = 0
      metT = null
    } else if (boutStartT === null || prev === null || !prev.resting || (o.t - prev.t) / MINUTE_MS > req.maxGapMin) {
      boutStartT = o.t
      cooled = 0
      shade = 0
      metT = null
    } else {
      const gap = Math.max(0, (o.t - prev.t) / MINUTE_MS)
      if (prev.place === 'indoor_cool') cooled += gap
      else shade += gap
      if (metT === null && progressOf() >= 1 - 1e-9) metT = o.t
    }
    prev = o
  }
  const last = obs.length > 0 ? obs[obs.length - 1] : undefined
  return {
    boutStartT,
    cooledMin: cooled,
    shadeMin: shade,
    progress: progressOf(),
    metT,
    restingNow: last?.resting ?? false,
    placeNow: last?.place ?? null,
    lastObsT: last?.t ?? null,
    firstObsT: obs.length > 0 ? (obs[0]?.t ?? null) : null,
  }
}

/** Appends an observation, replacing one at the same minute and dropping later ones after a rewind; bounded. */
export function appendObs<T extends { t: number }>(list: readonly T[], item: T, max = 720): T[] {
  const out = list.filter((x) => x.t < item.t)
  out.push(item)
  return out.length > max ? out.slice(out.length - max) : out
}

// ─────────────────────────────── Case kind ───────────────────────────────

/**
 * What kind of stop the case is, from the console alert (never from the device detail):
 * - `clinical`: symptom-, physiology- or hydration-driven (reason "First-aid check needed" / "Emergency response
 *   needed now"), every emergency — latched until a sign-off after a symptom-free re-check (ARCHITECTURE §1.4);
 * - `site`: a shared site condition (exposure basis) — lifted by the device and the plan, no sign-off;
 * - `device`: another individual stop under a pooled reason ("Not cleared for heat work now", "Device-directed rest"):
 *   either a heat-strain limit waiting for a reviewed recovery or a hold the device releases itself; the console
 *   cannot tell which (privacy by design), so the sign-off is offered with the review conditions.
 */
export type CaseKind = 'clinical' | 'site' | 'device'

const CLINICAL_REASON_KEYS: readonly string[] = ['reason.first_aid_check', 'reason.emergency', 'reason.personal_check']

export function caseKind(alert: Pick<AlertItem, 'basis' | 'level' | 'reasonKey'>): CaseKind {
  if (alert.level === 'emergency') return 'clinical'
  if (alert.basis === 'exposure') return 'site'
  if (alert.reasonKey !== undefined && CLINICAL_REASON_KEYS.includes(alert.reasonKey)) return 'clinical'
  return 'device'
}

export const CASE_KIND_LABEL: Readonly<Record<CaseKind, string>> = {
  clinical: 'First-aid case',
  site: 'Site condition',
  device: 'Device-directed rest',
}

// ─────────────────────────────── Escalation chain (role/time record of the released case) ───────────────────────────────

/** One alert of the case, role/time record only (ARCHITECTURE §6 durable escalation record). */
export interface ChainAlert {
  id: string
  t: number
  level: RiskLevel
  acks: Array<{ role: Role; t: number }>
  escalatedAt: number | null
  escalatedTo: Role[]
  resolvedAt: number | null
}

const chainAlertOf = (a: Alert): ChainAlert => ({
  id: a.id,
  t: a.t,
  level: a.level,
  acks: (a.acks ?? (a.ack ? [a.ack] : [])).map((x) => ({ role: x.role, t: x.t })),
  escalatedAt: a.escalatedAt ?? null,
  escalatedTo: [...(a.escalatedTo ?? [])],
  resolvedAt: a.resolvedAt ?? null,
})

/**
 * The released case alert and the stop-or-above alerts it superseded (engine/alerts.ts: a higher level or a new
 * clinical cause closes the open alert and raises the next one in the same minute), oldest first. Only the role/time
 * record and the level are copied; the caller passes an alert id the role projection already released.
 */
export function caseChain(alerts: readonly Alert[] | null | undefined, workerId: string, alertId: string): ChainAlert[] {
  if (!alerts) return []
  const mine = alerts.filter((a) => a.scope === 'worker' && a.workerId === workerId)
  let cur = mine.find((a) => a.id === alertId)
  if (!cur) return []
  const out: ChainAlert[] = [chainAlertOf(cur)]
  for (let guard = 0; guard < 24; guard++) {
    const at: number = cur.t
    const id: string = cur.id
    const prev: Alert | undefined = mine.find((a) => a.id !== id && a.resolvedAt === at && a.t < at && RISK_ORDER[a.level] >= RISK_ORDER.stop)
    if (!prev) break
    out.unshift(chainAlertOf(prev))
    cur = prev
  }
  return out
}

/** Stable key of a case: the worker and the start of its stop episode (survives escalation to a new alert id). */
export function caseKeyOf(workerId: string, startT: number): string {
  return `${workerId}@${startT}`
}

/** Earliest escalation of the case, or null. */
export function chainEscalatedAt(chain: readonly ChainAlert[]): number | null {
  const ts = chain.flatMap((c) => (c.escalatedAt !== null ? [c.escalatedAt] : []))
  return ts.length > 0 ? Math.min(...ts) : null
}

/** True when the first aider was paged within a minute of an alert of the case being raised (vital-interest routing). */
export function firstAiderPagedAtRaise(chain: readonly ChainAlert[]): boolean {
  return chain.some((c) => c.escalatedTo.includes('first_aider') && c.escalatedAt !== null && c.escalatedAt - c.t <= MINUTE_MS)
}

/** Every acknowledgement of the case in order, with the level of the alert acknowledged. */
export function chainAcks(chain: readonly ChainAlert[]): Array<{ role: Role; t: number; level: RiskLevel }> {
  return chain.flatMap((c) => c.acks.map((a) => ({ ...a, level: c.level }))).sort((x, y) => x.t - y.t)
}

// ─────────────────────────────── Symptoms and re-checks ───────────────────────────────

/** Short tier wording for a symptom (physio_and_clinical.md §10.7 tiers; engine/clinical.ts SYMPTOM_RULES). */
export const SYMPTOM_TIER_TEXT: Readonly<Record<0 | 1 | 2 | 3, string>> = {
  3: 'Red flag',
  2: 'Stop work',
  1: 'Rest and watch',
  0: 'Advice',
}

/** Tier of a symptom; an unknown id counts as a red flag (protective, as engine/risk.ts isCleanCheckin). */
export function symptomTier(s: SymptomId): 0 | 1 | 2 | 3 {
  return SYMPTOM_RULES[s]?.tier ?? 3
}

export function symptomLabel(s: SymptomId): string {
  return SYMPTOM_RULES[s]?.label ?? s
}

/** Symptoms sorted most severe first, then by label. */
export function sortSymptoms(symptoms: readonly SymptomId[]): SymptomId[] {
  return [...new Set(symptoms)].sort((a, b) => symptomTier(b) - symptomTier(a) || symptomLabel(a).localeCompare(symptomLabel(b)))
}

/** The check-in items grouped by tier, most severe first (for the re-check form). */
export function symptomsByTier(): Array<{ tier: 0 | 1 | 2 | 3; items: SymptomId[] }> {
  const ids = Object.keys(SYMPTOM_RULES) as SymptomId[]
  return ([3, 2, 1, 0] as const).map((tier) => ({ tier, items: ids.filter((s) => symptomTier(s) === tier) }))
}

/** A re-check that clears the latch: no T2 or T3 symptom (engine/risk.ts isCleanCheckin). */
export function isCleanRecheck(symptoms: readonly SymptomId[]): boolean {
  return symptoms.every((s) => symptomTier(s) < 2)
}

/** A re-check the first aider recorded on this console. */
export interface RecheckEntry {
  t: number
  symptoms: SymptomId[]
  clean: boolean
}

/** The first aider's re-checks of a worker from the store's applied injections (the console's own entries), oldest first. */
export function recheckEntries(applied: readonly AppliedInjection[], workerId: string): RecheckEntry[] {
  const out: RecheckEntry[] = []
  for (const a of applied) {
    if (!a.ok || a.injection.kind !== 'checkin') continue
    const c = a.injection.checkin
    if (c.by !== 'first_aider' || c.workerId !== workerId) continue
    out.push({ t: c.t, symptoms: [...c.symptoms], clean: isCleanRecheck(c.symptoms) })
  }
  return out.sort((x, y) => x.t - y.t)
}

export type RecheckWhy = 'none' | 'not_clean' | 'before_rest' | 'superseded' | 'ok'

export interface RecheckStatus {
  latest: RecheckEntry | null
  why: RecheckWhy
  valid: boolean
}

/**
 * Whether the latest re-check of this case counts toward the sign-off: recorded after the case was raised, after the
 * rest requirement was met (engine/risk.ts: the check-in must follow the met rest), symptom-free (no T2/T3) and not
 * followed by a newly released symptom.
 */
export function recheckStatus(entries: readonly RecheckEntry[], caseT: number, restMetT: number | null, symptomsChangedT: number | null): RecheckStatus {
  const mine = entries.filter((e) => e.t >= caseT)
  const latest = mine.length > 0 ? (mine[mine.length - 1] ?? null) : null
  let why: RecheckWhy
  if (!latest) why = 'none'
  else if (!latest.clean) why = 'not_clean'
  else if (restMetT === null || latest.t < restMetT) why = 'before_rest'
  else if (symptomsChangedT !== null && symptomsChangedT > latest.t) why = 'superseded'
  else why = 'ok'
  return { latest, why, valid: why === 'ok' }
}

/**
 * Next re-check due: +15 and +30 min after the case was raised, then every 15 min (engine/clinical.ts TRIAGE_TIMING),
 * after the latest re-check.
 */
export function nextRecheckDue(caseT: number, lastRecheckT: number | null): number {
  const first = caseT + TRIAGE_TIMING.RECHECK_FIRST_MIN * MINUTE_MS
  const second = caseT + TRIAGE_TIMING.RECHECK_SECOND_MIN * MINUTE_MS
  const every = TRIAGE_TIMING.RECHECK_CONTINUE_EVERY_MIN * MINUTE_MS
  if (lastRecheckT === null || lastRecheckT < first) return first
  if (lastRecheckT < second) return second
  return second + (Math.floor((lastRecheckT - second) / every) + 1) * every
}

// ─────────────────────────────── Device status released with consent ───────────────────────────────

const WATER_HOLD_DRIVERS: readonly string[] = ['phs_drink_to_restart', 'phs_no_drink_no_restart']
const REVIEW_DRIVERS: readonly string[] = ['clinical_latch', 'phs_limit_reached', 'phs_recovery_review_required', 'no_hot_work_today', ...WATER_HOLD_DRIVERS]

/** Water-loss restoration from the drivers released to consented occupational health; null when none were released. */
export function waterHold(drivers: readonly RiskDriver[] | undefined): { state: 'pending' | 'none'; text: string | null } | null {
  if (!drivers) return null
  const hold = drivers.find((d) => WATER_HOLD_DRIVERS.includes(d.id))
  if (hold) return { state: 'pending', text: hold.text }
  const review = drivers.find((d) => d.id === 'phs_recovery_review_required' && /water-loss limit is not yet restored/.test(d.text))
  if (review) return { state: 'pending', text: 'The water-loss limit is not yet restored.' }
  return { state: 'none', text: null }
}

/** The device's own review and latch texts (released to consented occupational health), raising ones first. */
export function deviceStatusLines(drivers: readonly RiskDriver[] | undefined): RiskDriver[] {
  if (!drivers) return []
  return drivers.filter((d) => REVIEW_DRIVERS.includes(d.id)).sort((a, b) => Number(b.direction === 'raises') - Number(a.direction === 'raises'))
}

/** Hydration-channel drivers (water balance, drinking credit, urine): consented occupational health only. */
export function hydrationLines(drivers: readonly RiskDriver[] | undefined): RiskDriver[] {
  if (!drivers) return []
  return drivers.filter((d) => d.channel === 'hydration' && !WATER_HOLD_DRIVERS.includes(d.id))
}

export type PsiBandKnown = 'very_high' | 'high' | 'moderate'

/** PSI band as the device reports it: only sustained bands are released as drivers (engine/physio.ts §10.5 floors). */
export interface PsiReading {
  /** Lower bound of the sustained band, or null when no PSI floor was crossed for 5 valid minutes. */
  band: PsiBandKnown | null
  floor: number | null
  value: number | null
  text: string
}

export const PSI_BAND_TEXT: Readonly<Record<PsiBandKnown, string>> = {
  very_high: `Very high: above ${PHYSIO_FLOORS.PSI_T2}`,
  high: `High: above ${PHYSIO_FLOORS.PSI_T1}`,
  moderate: `Moderate: above ${PHYSIO_FLOORS.PSI_ADVISORY}`,
}

/** Reads the PSI band from the released physiology drivers (psi_very_high > 8, psi_high > 6, psi_moderate_advisory > 4). */
export function psiFromDrivers(drivers: readonly RiskDriver[] | undefined): PsiReading {
  const find = (id: string) => drivers?.find((d) => d.id === id)
  const vh = find('psi_very_high')
  if (vh) return { band: 'very_high', floor: PHYSIO_FLOORS.PSI_T2, value: vh.value ?? null, text: PSI_BAND_TEXT.very_high }
  const h = find('psi_high')
  if (h) return { band: 'high', floor: PHYSIO_FLOORS.PSI_T1, value: h.value ?? null, text: PSI_BAND_TEXT.high }
  const m = find('psi_moderate_advisory')
  if (m) return { band: 'moderate', floor: PHYSIO_FLOORS.PSI_ADVISORY, value: m.value ?? null, text: PSI_BAND_TEXT.moderate }
  return { band: null, floor: null, value: null, text: `Not above ${PHYSIO_FLOORS.PSI_ADVISORY} for 5 valid minutes, or not computed` }
}

/** Armstrong urine chart: an approximate swatch per shade (decorative; the shade number and advice carry the meaning). */
const URINE_SWATCH = ['#fdf9e1', '#faf3b8', '#f6e98a', '#efd95c', '#e5c53a', '#d6ab24', '#c08d18', '#9d6d12'] as const

export function urineReading(shade: number | null | undefined): { shade: number; swatch: string; advice: string } | null {
  if (shade === null || shade === undefined || !Number.isFinite(shade)) return null
  const s = Math.min(8, Math.max(1, Math.round(shade)))
  return { shade: s, swatch: URINE_SWATCH[s - 1] ?? URINE_SWATCH[0], advice: urineAssessment(s).advice }
}

// ─────────────────────────────── Case view model ───────────────────────────────

/** Symptoms as released to this role, or why they were withheld (never blank). */
export type SymptomView = { state: 'released'; list: SymptomId[] } | { state: 'withheld'; reason: string }

export const WITHHELD_TEXT = {
  firstAiderSymptoms: 'Withheld: not escalated. Symptoms reach the first aider only once the case is escalated (vital interest).',
  ohClinical: 'Withheld: no consent. The worker has not agreed to share clinical detail with occupational health.',
} as const

export const NONE_REPORTED = `None reported in the last ${CASE_SYMPTOM_WINDOW_MIN} min`

export function symptomView(role: MedicRole, fields: readonly DataField[], data: ProjectedData): SymptomView {
  if (fields.includes('symptoms')) return { state: 'released', list: sortSymptoms(data.symptoms ?? []) }
  return { state: 'withheld', reason: role === 'first_aider' ? WITHHELD_TEXT.firstAiderSymptoms : WITHHELD_TEXT.ohClinical }
}

/** One released case record (FirstAidCase or OccHealthCase) as the view needs it. */
export interface CaseRecordIn {
  workerId: string
  data: ProjectedData
  fields: DataField[]
  withheld: DataField[]
  alert: AlertItem
  escalated?: boolean
  clinicalReleased?: boolean
}

export interface MedicCaseVM {
  key: string
  workerId: string
  alert: AlertItem
  level: RiskLevel
  name: string
  nameReleased: boolean
  /** Actions as released by the projection (falls back to the console actions of the alert). */
  actions: ActionId[]
  location: ParsedLocation | null
  locationLabel: string | null
  symptoms: SymptomView
  escalated: boolean
  clinicalReleased: boolean
  crewId: string | null
  ackStatus: AckStatus | null
  kind: CaseKind
  chain: ChainAlert[]
  /** Start of the stop episode (first alert of the chain). */
  startT: number
  data: ProjectedData
  fields: DataField[]
  withheld: DataField[]
}

/** Maps the released records of a role to the view model, keeping the selector's order (most severe first). */
export function toCaseVMs(records: readonly CaseRecordIn[], role: MedicRole, alerts: readonly Alert[] | null | undefined): MedicCaseVM[] {
  return records.map((r) => {
    const chain = caseChain(alerts, r.workerId, r.alert.id)
    const startT = chain[0]?.t ?? r.alert.t
    const label = r.fields.includes('location') ? (r.data.location?.label ?? null) : null
    return {
      key: caseKeyOf(r.workerId, startT),
      workerId: r.workerId,
      alert: r.alert,
      level: r.data.level ?? r.alert.level,
      name: r.data.displayName ?? 'Name withheld',
      nameReleased: r.data.displayName !== undefined,
      actions: r.data.actions ? [...r.data.actions] : [...r.alert.actions],
      location: label !== null ? parseCaseLocation(label) : null,
      locationLabel: label,
      symptoms: symptomView(role, r.fields, r.data),
      escalated: role === 'occ_health' ? true : r.escalated === true,
      clinicalReleased: role === 'occ_health' && r.clinicalReleased === true,
      crewId: r.data.crewId ?? null,
      ackStatus: r.data.ackStatus ?? null,
      kind: caseKind(r.alert),
      chain: chain.length > 0 ? chain : [{ id: r.alert.id, t: r.alert.t, level: r.alert.level, acks: [], escalatedAt: null, escalatedTo: [], resolvedAt: null }],
      startT,
      data: r.data,
      fields: r.fields,
      withheld: r.withheld,
    }
  })
}

// ─────────────────────────────── Recovery sign-off ───────────────────────────────

/** `device`: verified by the worker's device and not released to this role; `confirm`: the signer must confirm it. */
export type ConditionState = 'met' | 'pending' | 'device' | 'confirm'

export interface SignoffCondition {
  id: 'rest' | 'recheck' | 'water' | 'handover'
  label: string
  state: ConditionState
  detail: string
}

export interface SignoffInput {
  kind: CaseKind
  level: RiskLevel
  role: MedicRole
  rest: RestStatus
  recheck: RecheckStatus
  /** Occupational health with the worker's consent to share clinical detail on escalation. */
  clinicalReleased: boolean
  water: { state: 'pending' | 'none'; text: string | null } | null
  handoverConfirmed: boolean
  /** Formats an epoch time as local HH:mm. */
  hhmm?: (t: number) => string
}

/**
 * The conditions shown before the sign-off button enables — only what the projection releases to the role, plus the
 * console's own re-checks. `ready` when every condition is met or verified on the device (the device keeps enforcing
 * those: a sign-off never releases a worker whose device still holds).
 * - Site-condition stops need no sign-off (the plan and the device lift them).
 * - An emergency is closed on hand-over to the ambulance team (998): no recovery on site, no heat work today.
 * - Other stops: rest in a cooled area or shade, a symptom-free re-check after that rest, and — where a heat-strain
 *   limit may be the cause — the water-loss restoration the device verifies (figures only to consented OH).
 */
export function signoffConditions(i: SignoffInput): { conditions: SignoffCondition[]; ready: boolean } {
  const hhmm = i.hhmm ?? formatLocalHhmm
  if (i.kind === 'site') return { conditions: [], ready: false }
  if (i.level === 'emergency') {
    const handover: SignoffCondition = {
      id: 'handover',
      label: 'Hand-over to the ambulance team confirmed',
      state: i.handoverConfirmed ? 'met' : 'confirm',
      detail: 'An emergency is closed when the 998 ambulance team takes over. No recovery sign-off on site and no heat work today; medical evaluation is required.',
    }
    return { conditions: [handover], ready: i.handoverConfirmed }
  }
  const conditions: SignoffCondition[] = []
  const r = i.rest
  const cooledEq = Math.floor(r.progress * RECOVERY_REST.cooledMin)
  conditions.push({
    id: 'rest',
    label: `Rest off task and out of the sun: ${RECOVERY_REST.cooledMin} min in a cooled area or ${RECOVERY_REST.shadeMin} min in shade`,
    state: r.metT !== null ? 'met' : 'pending',
    detail:
      r.metT !== null
        ? `Met at ${hhmm(r.metT)}: ${Math.floor(r.cooledMin)} min cooled, ${Math.floor(r.shadeMin)} min shade observed.`
        : r.lastObsT === null
          ? 'No location received yet.'
          : r.restingNow && r.placeNow
            ? `Resting ${PLACE_WORDS[r.placeNow]}: ${cooledEq} of ${RECOVERY_REST.cooledMin} min cooled-area equivalent observed (${Math.floor(r.progress * 100)} %).`
            : r.placeNow === 'sun'
              ? 'Not resting: the worker is in the sun.'
              : r.placeNow === null
                ? 'Location could not be read: rest is not counted.'
                : 'Not resting: the worker is on a task.',
  })
  if (i.role === 'occ_health' && !i.clinicalReleased) {
    conditions.push({
      id: 'recheck',
      label: 'Symptom-free re-check after the rest',
      state: 'device',
      detail: 'The device requires a symptom-free re-check before the case clears; its result is not shared without consent.',
    })
  } else {
    const rc = i.recheck
    const at = rc.latest ? hhmm(rc.latest.t) : ''
    const detail: Record<RecheckWhy, string> = {
      none: 'No re-check recorded for this case yet.',
      not_clean: `Re-check at ${at} found a stop-level or red-flag symptom.`,
      before_rest: `Re-check at ${at} was before the rest requirement was met: repeat it after the rest.`,
      superseded: `A symptom was reported after the re-check at ${at}: repeat it.`,
      ok: `Symptom-free re-check at ${at}.`,
    }
    conditions.push({ id: 'recheck', label: 'Symptom-free re-check after the rest', state: rc.valid ? 'met' : 'pending', detail: detail[rc.why] })
  }
  const ohWater = i.role === 'occ_health' && i.clinicalReleased && i.water !== null
  if (ohWater && i.water) {
    if (i.kind === 'device' || i.water.state === 'pending') {
      conditions.push({
        id: 'water',
        label: 'Water-loss limit restored (drinking and rest)',
        state: i.water.state === 'pending' ? 'pending' : 'met',
        detail: i.water.state === 'pending' ? (i.water.text ?? 'The water-loss limit is not yet restored.') : 'No water-loss hold reported by the device.',
      })
    }
  } else if (i.kind === 'device') {
    conditions.push({
      id: 'water',
      label: 'Water-loss limit restored (drinking and rest)',
      state: 'device',
      detail:
        i.role === 'first_aider'
          ? 'Checked on the worker’s device: if the water-loss limit was reached, work stays held until the water balance is restored (logged drinks count). Water figures are not released to first aiders.'
          : 'Checked on the worker’s device; water figures are not shared without consent.',
    })
  }
  return { conditions, ready: conditions.every((c) => c.state === 'met' || c.state === 'device') }
}

// ─────────────────────────────── Case timeline ───────────────────────────────

export type CaseEventKind = 'raised' | 'escalated' | 'notified' | 'ack' | 'symptoms' | 'recheck' | 'cooling' | 'signoff'

export interface CaseEvent {
  id: string
  t: number
  kind: CaseEventKind
  title: string
  detail?: string
  level?: RiskLevel
}

/** Short past-tense labels of the cooling steps for the timeline. */
export const COOLING_STEP_DONE: Readonly<Record<FirstAidStep['id'], string>> = {
  call_998: 'Called 998',
  shade_undress: 'Moved to shade, outer clothing off',
  immerse: 'Cold-water immersion started',
  douse_or_towels: 'Dousing or ice-water towels started',
  continue_until_ems: 'Cooling continued until hand-over',
  fluids_if_alert: 'Fluids or recovery position',
}

const NOTIFICATION_KIND_LABEL: Readonly<Record<Notification['kind'], string>> = {
  alert: 'Alert',
  crew_alert: 'Crew alert',
  deescalation: 'Level lowered',
  update: 'Update',
  escalation: 'Escalation',
  renotify: 'Repeat alert',
  siren: 'Site siren',
  reminder: 'Reminder',
  device_offline: 'Device offline',
}

const CHANNEL_LABEL: Readonly<Record<Notification['channel'], string>> = { app: 'app', push: 'push', sms: 'SMS', voice: 'voice call', siren: 'siren' }

const EVENT_ORDER: Readonly<Record<CaseEventKind, number>> = { raised: 0, escalated: 1, notified: 2, ack: 3, symptoms: 4, cooling: 5, recheck: 6, signoff: 7 }

export interface TimelineInput {
  chain: readonly ChainAlert[]
  reasonText: string
  role: MedicRole
  /** Notifications to this role (FirstAiderModel / OccHealthModel `notifications`). */
  notifications: readonly Pick<Notification, 'id' | 't' | 'alertId' | 'channel' | 'kind' | 'level'>[]
  /** The console's re-checks of this case; `showResults` false = the role may not see their result. */
  rechecks: { entries: readonly RecheckEntry[]; showResults: boolean }
  steps: Partial<Record<FirstAidStep['id'], number>>
  /** First time each symptom was released to this console (only when symptoms are released to the role). */
  symptomsSeen: Partial<Record<SymptomId, number>> | null
  /** First observation of the case on this console: symptoms seen then were already on the record. */
  caseFirstSeenT?: number | null
}

/**
 * The case record in time order: alerts of the chain (raised, escalated), the escalation routing, pages to this role,
 * acknowledgements (role and time), symptoms as first released to this console, the console's re-checks and cooling
 * steps. Nothing outside the active case (no history: ARCHITECTURE §2 first-aider row).
 */
export function caseTimeline(i: TimelineInput): CaseEvent[] {
  const out: CaseEvent[] = []
  const ids = new Set(i.chain.map((c) => c.id))
  i.chain.forEach((c, k) => {
    out.push({
      id: `raised:${c.id}`,
      t: c.t,
      kind: 'raised',
      level: c.level,
      title: k === 0 ? `${LEVEL_WORD[c.level]} raised` : `Escalated to ${LEVEL_WORD[c.level].toLowerCase()}`,
      ...(k === i.chain.length - 1 ? { detail: i.reasonText } : {}),
    })
    if (c.escalatedAt !== null) {
      const routed = c.escalatedTo.filter((r) => r === 'first_aider' || r === 'occ_health' || r === 'buddy' || r === 'supervisor')
      out.push({
        id: `esc:${c.id}`,
        t: c.escalatedAt,
        kind: 'escalated',
        title: 'Case escalated',
        detail: routed.length > 0 ? `Routed to ${routed.map((r) => ROLE_LABEL[r].toLowerCase()).join(', ')}.` : 'Stop not acknowledged in time.',
      })
    }
    c.acks.forEach((a, n) => out.push({ id: `ack:${c.id}:${n}`, t: a.t, kind: 'ack', title: `Acknowledged by ${ROLE_LABEL[a.role].toLowerCase()}` }))
  })
  const roleWord = ROLE_LABEL[i.role].toLowerCase()
  for (const n of i.notifications) {
    if (!ids.has(n.alertId) || n.kind === 'update' || n.kind === 'deescalation') continue
    out.push({ id: `note:${n.id}`, t: n.t, kind: 'notified', title: `${NOTIFICATION_KIND_LABEL[n.kind]} sent to ${roleWord}`, detail: `By ${CHANNEL_LABEL[n.channel]}.` })
  }
  if (i.symptomsSeen) {
    const byT = new Map<number, SymptomId[]>()
    for (const [s, t] of Object.entries(i.symptomsSeen) as Array<[SymptomId, number]>) byT.set(t, [...(byT.get(t) ?? []), s])
    const opened = i.caseFirstSeenT ?? null
    for (const [t, list] of byT) {
      const onRecord = opened !== null && t <= opened
      out.push({
        id: `sym:${t}`,
        t,
        kind: 'symptoms',
        title: onRecord ? 'Symptoms on the case record' : 'New symptoms reported',
        detail: `${sortSymptoms(list).map(symptomLabel).join(', ')}${onRecord ? ' (first shown on this console)' : ''}`,
      })
    }
  }
  for (const [id, t] of Object.entries(i.steps) as Array<[FirstAidStep['id'], number]>) {
    out.push({ id: `step:${id}`, t, kind: 'cooling', title: COOLING_STEP_DONE[id] })
  }
  const first = i.chain[0]?.t ?? -Infinity
  i.rechecks.entries.forEach((e, n) => {
    if (e.t < first) return
    out.push({
      id: `re:${n}:${e.t}`,
      t: e.t,
      kind: 'recheck',
      title: !i.rechecks.showResults ? 'Re-check recorded by the first aider' : e.clean ? 'Re-check: no stop-level symptom' : 'Re-check: symptoms found',
      detail: !i.rechecks.showResults
        ? 'Result not shared without the worker’s consent.'
        : e.symptoms.length === 0
          ? 'No symptoms.'
          : sortSymptoms(e.symptoms).map(symptomLabel).join(', '),
    })
  })
  return out.sort((a, b) => a.t - b.t || EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind])
}

// ─────────────────────────────── Incident notification (ADOSH Form G) ───────────────────────────────

/** Local start of the day `n` working days after the day of `t` (weekend days skipped). */
export function addWorkingDays(t: number, n: number, weekend: readonly number[] = [0, 6]): number {
  let day = startOfLocalDay(t)
  let count = 0
  for (let guard = 0; guard < 60 && count < n; guard++) {
    day += DAY_MS
    if (!weekend.includes(localParts(day).weekday)) count++
  }
  return day
}

export interface FormGNotice {
  notifiable: boolean
  deadline: 'fatality' | 'serious' | null
  /** Fatality: the exact deadline; serious incident: the local start of the due day (due by its end). */
  dueT: number | null
  form: string
  recipient: string
  fatalityWithinHours: number
  seriousWithinWorkingDays: number
  criteria: readonly string[]
  basis: string
}

/**
 * The Form G duty for a recorded outcome (engine/regulation.ts heatIncidentNotification on the Abu Dhabi pack): 24 h for
 * a fatality, 3 working days for a serious incident (Schedule B criteria). [ENG] Working days assume a Monday–Friday
 * week. Null when the pack transcribes no notification duty.
 */
export function formGNotice(outcome: HeatIncidentOutcome, incidentT: number, pack: RulePack = DEFAULT_RULE_PACK): FormGNotice | null {
  const rule = pack.incidentNotification
  const n = heatIncidentNotification(outcome, pack)
  if (!rule || !n) return null
  const deadline = n.withinHours !== null ? 'fatality' : n.withinWorkingDays !== null ? 'serious' : null
  return {
    notifiable: n.notifiable,
    deadline,
    dueT:
      deadline === 'fatality' ? incidentT + rule.fatalityWithinHours * HOUR_MS : deadline === 'serious' ? addWorkingDays(incidentT, rule.seriousWithinWorkingDays) : null,
    form: rule.form,
    recipient: rule.recipient,
    fatalityWithinHours: rule.fatalityWithinHours,
    seriousWithinWorkingDays: rule.seriousWithinWorkingDays,
    criteria: rule.seriousCriteria,
    basis: rule.basis,
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "Wed 6 Aug" in Abu Dhabi local time. */
export function formatLocalDay(t: number): string {
  const p = localParts(t)
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`
}

// ─────────────────────────────── Clinical trend (consented) ───────────────────────────────

/** One consented observation of the case (state/selectors.ts OccHealthCase data). */
export interface TrendPoint {
  t: number
  ct: number | null
  hr: number | null
}

export interface TrendRow {
  t: number
  ct: number | null
  /** ECTemp display band (±0.6 °C ≈ Buller 2013 limits of agreement, engine/physio.ts ECTEMP_DISPLAY). */
  band: [number, number] | null
  hr: number | null
}

const round1 = (x: number) => Math.round(x * 10) / 10

export function trendRows(points: readonly TrendPoint[], halfWidthC: number = ECTEMP_DISPLAY.HALF_WIDTH_C): TrendRow[] {
  return points.map((p) => ({ t: p.t, ct: p.ct, band: p.ct === null ? null : [round1(p.ct - halfWidthC), round1(p.ct + halfWidthC)], hr: p.hr }))
}

/** A y-domain covering every band, on half-degree steps, at least `minSpan` wide. */
export function bandDomain(rows: readonly TrendRow[], minSpan = 2): [number, number] {
  const lows = rows.flatMap((r) => (r.band ? [r.band[0]] : []))
  const highs = rows.flatMap((r) => (r.band ? [r.band[1]] : []))
  if (lows.length === 0) return [36.5, 39.5]
  let lo = Math.floor(Math.min(...lows) * 2) / 2
  let hi = Math.ceil(Math.max(...highs) * 2) / 2
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2
    lo = Math.floor((mid - minSpan / 2) * 2) / 2
    hi = lo + minSpan
  }
  return [lo, hi]
}

/** Minutes from `from` to `to`, floored, never negative. */
export function elapsedMin(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / MINUTE_MS))
}
