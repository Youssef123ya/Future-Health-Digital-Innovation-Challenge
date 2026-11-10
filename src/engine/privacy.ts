/**
 * Governance enforced in code (ARCHITECTURE §7): role × purpose projections, consent, k-anonymous aggregates with
 * complementary suppression, a SHA-256 hash-chained audit log, retention, and the minimal payload that leaves the
 * worker's device.
 *
 * Zill is occupational-safety decision support. It does not diagnose and it does not measure core temperature: the
 * heart-rate model output (ECTemp) is an *estimated* strain indicator. Individual physiological and health data stays
 * on the worker's device and leaves it only as "level + action" (ARCHITECTURE §1 principle 5).
 *
 * Citations carry the verification level recorded in docs/research/context_and_commercial.md §4 and §6.2:
 *   [primary]   wording verified against the primary source
 *   [secondary] verified only from secondary summaries (official text not retrieved)
 *   [D]         design proposal from the research notes, not a legal requirement
 *   [ENG]       engineering choice that no standard fixes, resolved in the worker-protective direction
 *   UNVERIFIED  the research notes could not confirm it
 * Source keys (S61, S73 …) refer to the reference list of context_and_commercial.md.
 */

import type {
  ActionId,
  Alert,
  AuditEntry,
  ChannelId,
  Checkin,
  ConsentState,
  DataField,
  LangCode,
  Purpose,
  RiskAssessment,
  RiskDriver,
  RiskFlagId,
  RiskLevel,
  Role,
  SymptomId,
  WorkerProfile,
} from './types'
import { PROHIBITED_PURPOSES, RISK_ORDER } from './types'
import { DAY_MS, HOUR_MS } from './time'

// ─────────────────────────────── Sources ───────────────────────────────

const ILO_CODE = "ILO Code of Practice 'Protection of workers' personal data' (1997)"

/** Citation fragments reused in `basis` strings, at the verification level recorded in the research notes. */
const SRC = {
  archP5: 'ARCHITECTURE §1 principle 5',
  archActors: 'ARCHITECTURE §2 actor table',
  archGov: 'ARCHITECTURE §7',
  ilo54: `${ILO_CODE} §5.4 (not used to control the behaviour of workers) [primary, S73]`,
  ilo55: `${ILO_CODE} §5.5 (no decision based solely on automated processing) [primary, S73]`,
  ilo56: `${ILO_CODE} §5.6 (monitoring data not the only factor in evaluating performance) [primary, S73]`,
  ilo513: `${ILO_CODE} §5.13 (workers may not waive their privacy rights) [primary, S73]`,
  ilo614: `${ILO_CODE} §6.14(1) (workers informed in advance; the employer must minimise the intrusion) [primary, S73]`,
  ilo82: `${ILO_CODE} §8.2 (medical data held only by personnel bound by medical secrecy, kept apart) [primary, S73]`,
  ilo101: `${ILO_CODE} §10.1 (no third-party disclosure without explicit consent, except to prevent serious and imminent threat to life or health) [primary, S73]`,
  ilo102: `${ILO_CODE} §10.2 (no commercial or marketing use without consent) [primary, S73]`,
  ilo108: `${ILO_CODE} §10.8–10.9 (employer receives only conclusions, no information of a medical nature) [primary, S73]`,
  // UNVERIFIED: PDPL executive regulations — conflicting reports, treated as pending (context_and_commercial §4.1);
  // article-level PDPL wording below comes from secondary summaries only (official text not retrieved).
  pdplSensitive:
    'UAE PDPL (Federal Decree-Law 45/2021): health and biometric data are sensitive personal data [secondary, S62]',
  pdplConsent:
    'UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]',
  pdplArt4:
    "UAE PDPL Art. 4: processing without consent for 'occupational or preventive medicine', public health and statistical studies [secondary, S61]",
  pdplPurpose:
    "UAE PDPL purpose limitation: collected 'only for specific and clearly defined purposes' [secondary, S61]",
  ictHealth:
    'Federal Law 2/2019 (ICT in Health Fields) Art. 13 localisation; Ministerial Decision 51/2021 exceptions [secondary, S65]',
  dohSbr: 'DoH Standard for Biomedical Research DoH/SD/HLSS/SBR/V1/2026 [primary, S70]',
  // UNVERIFIED: UAE ratification of C155 — not among the nine conventions listed; NORMLEX unreachable (§4.4). The
  // 2022 ILC decision makes a safe and healthy working environment a fundamental principle regardless (S76).
  c155: 'ILO C155 Art. 13 (a worker who removes himself from imminent, serious danger is protected) [secondary, S74; UAE ratification UNVERIFIED]',
  excluded: 'context_and_commercial §6.2 excluded uses (Zill contract term)',
  k10: 'context_and_commercial §6.2 item 4: suppress any group smaller than 10 workers [D]',
} as const

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner)
  }
  return value
}

// ─────────────────────────────── Field catalogue ───────────────────────────────

/** Governance class of a projectable field. */
export type FieldClass = 'identity' | 'operational' | 'clinical' | 'personal'

/** Label, governance class and plain-language description of a projectable field (governance UI). */
export interface FieldInfo {
  label: string
  class: FieldClass
  description: string
}

/**
 * Every projectable field with its governance class. `clinical` marks sensitive personal data (health or biometric)
 * plus the individual strain projection; these never reach supervisors, employers or regulators.
 * Basis: UAE PDPL sensitive-data definition (health, biometric) [secondary, S62]; ILO code §8.2 [primary, S73];
 * ARCHITECTURE §1 principle 8 (claims discipline: ECTemp is an estimated strain indicator).
 */
export const FIELD_INFO: Readonly<Record<DataField, FieldInfo>> = deepFreeze({
  displayName: {
    label: 'Name / badge',
    class: 'identity',
    description: 'Shown to the supervisor, buddy and first aider so a safety action reaches the right person.',
  },
  crewId: { label: 'Crew', class: 'operational', description: 'Crew assignment used to route crew alerts.' },
  level: { label: 'Zill level', class: 'operational', description: 'safe · caution · high · stop · emergency.' },
  actions: {
    label: 'Actions',
    class: 'operational',
    description: 'What to do now (rest in shade, drink water, stop work, call 998 …).',
  },
  workMinPerHour: {
    label: 'Work minutes per hour',
    class: 'operational',
    description: 'Allowed work minutes per hour from the NIOSH/ACGIH and ADOSH TWL work/rest rules.',
  },
  ackStatus: { label: 'Acknowledgement', class: 'operational', description: 'Whether the current alert was acknowledged.' },
  minutesToLimit: {
    label: 'Minutes to strain limit',
    class: 'clinical',
    description: 'Individual ISO 7933 model projection of minutes until a strain limit (an estimate).',
  },
  waterMlPerHour: {
    label: 'Water (mL/h)',
    class: 'operational',
    description: 'Recommended drinking volume, capped to prevent hyponatraemia.',
  },
  drivers_nonclinical: {
    label: 'Reasons (non-clinical)',
    class: 'operational',
    description: 'Environment, regulation and work-context reasons for the level.',
  },
  drivers_clinical: {
    label: 'Reasons (clinical)',
    class: 'clinical',
    description: 'Physiology, symptom and hydration reasons for the level.',
  },
  hrBpm: { label: 'Heart rate', class: 'clinical', description: 'Heart rate from a paired wearable (biometric data).' },
  ctEstC: {
    label: 'Estimated strain indicator (ECTemp)',
    class: 'clinical',
    description: 'Heart-rate-based estimate (Buller 2013) with an uncertainty band — an estimate, not a measurement.',
  },
  psi: {
    label: 'Physiological Strain Index',
    class: 'clinical',
    description: 'Moran 1998 PSI computed on the device from the estimate and heart rate.',
  },
  riskFlags: {
    label: 'Health factors',
    class: 'clinical',
    description: 'Self-declared, consented risk factors (yes/no, never scored).',
  },
  symptoms: {
    label: 'Reported symptoms',
    class: 'clinical',
    description: 'Check-in answers, including danger signs observed by a buddy.',
  },
  urineColor: { label: 'Urine colour', class: 'clinical', description: 'Armstrong 8-shade chart, 1 (pale) – 8 (dark).' },
  ageYears: { label: 'Age', class: 'personal', description: 'Age in years (used on the device for the HR > 180 − age rule).' },
  location: { label: 'Location', class: 'personal', description: 'Where the worker is, so a first aider can reach them.' },
})

/** All projectable fields in canonical order (the order of the `DataField` union). Basis: types.ts `DataField`. */
export const DATA_FIELDS: readonly DataField[] = deepFreeze(Object.keys(FIELD_INFO) as DataField[])

/**
 * Sensitive health/biometric fields (class `clinical`). Basis: UAE PDPL sensitive data [secondary, S62];
 * ILO code §8.2, §10.8–10.9 [primary, S73]; ARCHITECTURE §2 (supervisor never sees HR, core-temperature estimate,
 * risk flags or symptoms).
 */
export const CLINICAL_FIELDS: readonly DataField[] = deepFreeze(
  DATA_FIELDS.filter((f) => FIELD_INFO[f].class === 'clinical'),
)

/**
 * Risk channels whose drivers carry clinical content. Basis: types.ts `RiskDriver.text` contract (text must be
 * non-clinical when channel ∉ {physiology, symptoms, hydration}).
 */
export const CLINICAL_DRIVER_CHANNELS: readonly ChannelId[] = deepFreeze(['physiology', 'symptoms', 'hydration'])

/**
 * Actions that point at confidential clinical follow-up. They are released only to recipients cleared for clinical
 * drivers (the worker, consented occupational health) and never leave the device in the sync payload.
 * Basis: types.ts `RiskFlagId` (`oh_review_required` prompts a confidential review); ILO code §10.8–10.9
 * [primary, S73]. [ENG]
 */
export const CONFIDENTIAL_ACTIONS: readonly ActionId[] = deepFreeze(['occ_health_review'])

// ─────────────────────────────── Consent scopes ───────────────────────────────

/** A consent scope (every boolean of `ConsentState`). Basis: ARCHITECTURE §7 consent scopes. */
export type ConsentScope = Exclude<keyof ConsentState, 'updatedAt'>

/**
 * The five opt-in, revocable consent scopes. Core safety alerting needs none of them.
 * Basis: ARCHITECTURE §7; UAE PDPL consent rules [secondary, S62].
 */
export const CONSENT_SCOPES: readonly ConsentScope[] = deepFreeze([
  'wearable',
  'healthFlags',
  'checkins',
  'shareWithMedicOnEscalation',
  'aggregateStatistics',
])

/**
 * Fields whose very processing depends on a consent scope: while the scope is off they are released to nobody,
 * including the worker's own view, so a revocation takes effect on the next projection. Symptoms are deliberately
 * absent: a buddy or first aider can always record a red-flag emergency.
 * Basis: UAE PDPL consent withdrawable at any time [secondary, S62]; ILO code §10.1 vital-interest exception
 * [primary, S73]; ARCHITECTURE §5 (physiology channel evaluated only when consented).
 */
export const FIELD_CONSENT_DEPENDENCY: Readonly<Partial<Record<DataField, ConsentScope>>> = deepFreeze({
  hrBpm: 'wearable',
  ctEstC: 'wearable',
  psi: 'wearable',
  riskFlags: 'healthFlags',
  urineColor: 'checkins',
})

// ─────────────────────────────── On-device record ───────────────────────────────

/** Acknowledgement state of the worker's current alert ('none' when no alert is open). Basis: types.ts `Alert.status`. */
export type AckStatus = 'none' | Alert['status']

/** Armstrong 8-shade urine colour. Basis: types.ts `Checkin.urineColor`. */
export type UrineColor = NonNullable<Checkin['urineColor']>

/** Where a worker is, so a first aider can reach them. */
export interface WorkerLocation {
  siteId: string
  /** Human-readable place, e.g. "Bay 4, scaffold C". */
  label: string
  lat?: number
  lon?: number
}

/**
 * The full record held on the worker's device. It never leaves the device as a whole; `project()` releases parts of
 * it, `payloadForSync()` builds the routine broadcast. Basis: ARCHITECTURE §1 principle 5, §3.
 */
export interface WorkerSnapshot {
  /** Pseudonymous worker id (WorkerProfile.id), e.g. "W-7F3A". */
  workerId: string
  /** When the snapshot was taken (epoch ms). */
  t: number
  displayName: string
  crewId: string
  level: RiskLevel
  actions: ActionId[]
  workMinPerHour: number
  ackStatus: AckStatus
  minutesToLimit: number | null
  waterMlPerHour: number
  /** All drivers of the current assessment; split into clinical / non-clinical by channel on projection. */
  drivers: RiskDriver[]
  hrBpm: number | null
  /** ECTemp estimated strain indicator (°C scale), not a measurement. */
  ctEstC: number | null
  psi: number | null
  riskFlags: RiskFlagId[]
  symptoms: SymptomId[]
  urineColor: UrineColor | null
  ageYears: number | null
  location: WorkerLocation | null
  consent: ConsentState
}

/** On-device readings that are not part of `WorkerProfile` or `RiskAssessment`. */
export interface OnDeviceReadings {
  ackStatus?: AckStatus
  hrBpm?: number | null
  ctEstC?: number | null
  psi?: number | null
  symptoms?: readonly SymptomId[]
  urineColor?: UrineColor | null
  location?: WorkerLocation | null
}

/**
 * Builds a `WorkerSnapshot` from the profile, the latest assessment and on-device readings. Data whose consent is off
 * is not even copied in: no wearable consent → no HR/ECTemp/PSI; no health-flag consent → no risk flags; no check-in
 * consent → no urine colour. Throws when the assessment belongs to another worker.
 * Basis: types.ts `WorkerProfile.riskFlags` ("only populated when consent.healthFlags is true"); UAE PDPL consent
 * [secondary, S62]; ILO code §6.14(1) minimise the intrusion [primary, S73].
 */
export function createWorkerSnapshot(
  profile: WorkerProfile,
  assessment: RiskAssessment,
  readings: OnDeviceReadings = {},
): WorkerSnapshot {
  if (assessment.workerId !== profile.id) {
    throw new Error(`createWorkerSnapshot: assessment is for ${assessment.workerId}, profile is ${profile.id}`)
  }
  const consent = profile.consent
  return {
    workerId: profile.id,
    t: assessment.t,
    displayName: profile.displayName,
    crewId: profile.crewId,
    level: assessment.level,
    actions: [...assessment.actions],
    workMinPerHour: assessment.workMinPerHour,
    ackStatus: readings.ackStatus ?? 'none',
    minutesToLimit: assessment.minutesToLimit,
    waterMlPerHour: assessment.waterMlPerHour,
    drivers: assessment.drivers.map((d) => ({ ...d })),
    hrBpm: consent.wearable ? (readings.hrBpm ?? null) : null,
    ctEstC: consent.wearable ? (readings.ctEstC ?? null) : null,
    psi: consent.wearable ? (readings.psi ?? null) : null,
    riskFlags: consent.healthFlags ? [...profile.riskFlags] : [],
    symptoms: [...(readings.symptoms ?? [])],
    urineColor: consent.checkins ? (readings.urineColor ?? null) : null,
    ageYears: profile.ageYears ?? null,
    location: readings.location ? { ...readings.location } : null,
    consent: { ...consent },
  }
}

/** Value type of each projectable field. */
export interface FieldValues {
  displayName: string
  crewId: string
  level: RiskLevel
  actions: ActionId[]
  workMinPerHour: number
  ackStatus: AckStatus
  minutesToLimit: number | null
  waterMlPerHour: number
  drivers_nonclinical: RiskDriver[]
  drivers_clinical: RiskDriver[]
  hrBpm: number | null
  ctEstC: number | null
  psi: number | null
  riskFlags: RiskFlagId[]
  symptoms: SymptomId[]
  urineColor: UrineColor | null
  ageYears: number | null
  location: WorkerLocation | null
}

/** A projection: only the released fields are present as keys. */
export type ProjectedData = Partial<FieldValues>

// ─────────────────────────────── Access matrix ───────────────────────────────

/** Purposes for which Zill data may never be used. Mirrors types.ts `PROHIBITED_PURPOSES`. */
export type ProhibitedPurpose = Extract<
  Purpose,
  'performance_management' | 'disciplinary_action' | 'insurance_underwriting' | 'immigration_or_visa'
>

type PermittedPurpose = Exclude<Purpose, ProhibitedPurpose>

/** A condition a grant can require at request time; all conditions of a grant must hold. */
export type GrantCondition =
  /** The requester is the worker the data is about. */
  | 'is_self'
  /** The requester is the worker's paired buddy (checked when `ProjectionContext.buddyIds` is supplied). */
  | 'is_buddy'
  /** The worker is in a crew the requester supervises (checked when `ProjectionContext.actorCrewIds` is supplied). */
  | 'in_actor_crew'
  /** The worker is at STOP or EMERGENCY. */
  | 'active_case'
  /** The case has been escalated (`ProjectionContext.escalated`). */
  | 'escalated'
  /** The worker consented to share clinical detail with occupational health on escalation. */
  | 'medic_sharing_consent'

/** One set of fields released when all its conditions hold. */
export interface Grant {
  readonly fields: readonly DataField[]
  readonly requires: readonly GrantCondition[]
  /** Why the grant exists (governance UI). */
  readonly reason: string
}

/** One cell of the role × purpose matrix. */
export interface AccessRule {
  /** Individual-level grants; empty = no individual projection for this role and purpose. */
  readonly grants: readonly Grant[]
  /** Minimum cell size k when this role may receive k-suppressed aggregates for this purpose; null = none. */
  readonly aggregateMinCell: number | null
  /** Why this cell is what it is (governance UI). */
  readonly reason: string
  /** Standard / regulatory basis. */
  readonly basis: string
}

/**
 * Plain-language text of each grant condition (governance UI). Basis: ARCHITECTURE §2 actor table and §7;
 * UAE AI Charter (2024) principle 5 Transparency [primary, S71].
 */
export const CONDITION_TEXT: Readonly<Record<GrantCondition, string>> = deepFreeze({
  is_self: 'the requester is the worker the data is about',
  is_buddy: "the requester is the worker's paired buddy",
  in_actor_crew: "the worker is in the requester's crew",
  active_case: 'the worker is at STOP or EMERGENCY',
  escalated: 'the case has been escalated',
  medic_sharing_consent: 'the worker has consented to share clinical detail with occupational health on escalation',
})

/** Display names of the roles. Basis: ARCHITECTURE §2 actor table. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = deepFreeze({
  worker: 'Worker',
  buddy: 'Buddy',
  supervisor: 'Crew supervisor',
  first_aider: 'First aider',
  occ_health: 'Occupational health nurse',
  hse_manager: 'HSE manager',
  regulator: 'Regulator (ADPHC / ADOSH)',
  employer_hr: 'Employer HR',
})

/** Display names of the purposes. Basis: types.ts `Purpose`; context_and_commercial §6.2 excluded uses. */
export const PURPOSE_LABELS: Readonly<Record<Purpose, string>> = deepFreeze({
  safety_alerting: 'Safety alerting',
  clinical_care: 'Clinical care',
  operational_planning: 'Operational planning',
  compliance_reporting: 'Compliance reporting',
  public_health_statistics: 'Public-health statistics',
  performance_management: 'Performance management',
  disciplinary_action: 'Disciplinary action',
  insurance_underwriting: 'Insurance underwriting',
  immigration_or_visa: 'Immigration or visa decisions',
})

/**
 * Why each prohibited purpose is refused for every role, whatever the consent.
 * Basis: context_and_commercial §6.2 (excluded uses and why); ILO code §5.4–5.6, §5.13, §10.1–10.2 [primary, S73];
 * UAE PDPL purpose limitation [secondary, S61]; ICT Health Law Art. 13 [secondary, S65]; DoH SBR 2026 [primary, S70].
 */
export const PROHIBITION_BASIS: Readonly<Record<ProhibitedPurpose, { reason: string; basis: string }>> = deepFreeze({
  performance_management: {
    reason:
      "'performance_management' is a prohibited purpose: heat-strain data is never used for performance ranking, pay or attendance.",
    basis: `${SRC.excluded}; ${SRC.ilo56} — Zill's ban is stricter than this clause; ${SRC.ilo54}; ${SRC.pdplPurpose}`,
  },
  disciplinary_action: {
    reason:
      "'disciplinary_action' is a prohibited purpose: no discipline, deduction or termination may rest on Zill data — least of all for a worker who stopped work because of the heat.",
    basis: `${SRC.excluded}; ${SRC.ilo54}; ${SRC.ilo55}; ${SRC.c155}; ${SRC.pdplPurpose}`,
  },
  insurance_underwriting: {
    reason:
      "'insurance_underwriting' is a prohibited purpose: individual data is never shared with health, life, workers'-compensation or liability insurers.",
    basis: `${SRC.excluded}; ${SRC.ilo101}; ${SRC.ilo102}; ${SRC.ictHealth}`,
  },
  immigration_or_visa: {
    reason:
      "'immigration_or_visa' is a prohibited purpose: Zill data is never used in recruitment, fitness-for-hire, visa or sponsorship decisions.",
    basis: `${SRC.excluded}; ${SRC.ilo513} — consent cannot launder a coercive use; ${SRC.dohSbr} (workers in a hierarchy are vulnerable participants); ${SRC.pdplPurpose}`,
  },
})

/**
 * Default minimum cell size k for aggregates. Basis: ARCHITECTURE §7 ("default k = 5"). [ENG] — no standard in the
 * research notes fixes k.
 */
export const DEFAULT_MIN_CELL_SIZE = 5

/**
 * Minimum cell size for regulator-facing aggregates. Basis: context_and_commercial §6.2 item 4 ("Suppress any group
 * smaller than 10 workers") [D]; ARCHITECTURE §2 (regulator: k-suppressed aggregates only).
 */
export const REGULATOR_MIN_CELL_SIZE = 10

/**
 * Minimum cell size for employer-HR aggregates. Basis: context_and_commercial §6.2 item 4 — written for employers
 * ("Employers see crew-level actions and aggregates. Suppress any group smaller than 10 workers") [D].
 */
export const EMPLOYER_MIN_CELL_SIZE = 10

const SUPERVISOR_VIEW: readonly DataField[] = [
  'displayName',
  'crewId',
  'level',
  'actions',
  'workMinPerHour',
  'ackStatus',
  'drivers_nonclinical',
  'waterMlPerHour',
]
const BUDDY_VIEW: readonly DataField[] = ['displayName', 'level', 'actions', 'ackStatus']
const FIRST_AID_CASE_VIEW: readonly DataField[] = ['displayName', 'level', 'actions', 'location']
const OH_CASE_VIEW: readonly DataField[] = ['displayName', 'crewId', 'level', 'actions', 'ackStatus', 'location']
const OH_CLINICAL_VIEW: readonly DataField[] = DATA_FIELDS.filter((f) => !OH_CASE_VIEW.includes(f))

const deny = (reason: string, basis: string): AccessRule => ({ grants: [], aggregateMinCell: null, reason, basis })
const aggregatesOnly = (k: number, reason: string, basis: string): AccessRule => ({
  grants: [],
  aggregateMinCell: k,
  reason,
  basis,
})

const WORKER_BASIS = `${SRC.archActors} (Worker: own level, actions, own data, who accessed it; never other workers' data); ${SRC.ilo614}`
const selfOnly = (reason: string): AccessRule => ({
  grants: [{ fields: DATA_FIELDS, requires: ['is_self'], reason: 'A worker sees everything Zill holds about them.' }],
  aggregateMinCell: null,
  reason,
  basis: WORKER_BASIS,
})

const SUPERVISOR_BASIS = `${SRC.archP5} (supervisors see what to do, never clinical detail); ${SRC.archActors} (Crew supervisor row); ${SRC.ilo108}; ${SRC.ilo82}`
const supervisorView = (reason: string): AccessRule => ({
  grants: [
    {
      fields: SUPERVISOR_VIEW,
      requires: ['in_actor_crew'],
      reason: 'What to do, for the workers in the crew the supervisor runs.',
    },
  ],
  aggregateMinCell: null,
  reason,
  basis: SUPERVISOR_BASIS,
})

const HSE_BASIS = `${SRC.archP5} (employers see only aggregates); ${SRC.archActors} (HSE manager row); ${SRC.archGov} (default k = 5) [ENG]`
const OH_NEVER = `${SRC.archActors} (Occupational health: never sees non-escalated workers)`
const FIRST_AID_ONLY = `${SRC.ilo614}; ${SRC.archActors} (First aider row)`
const HR_BASIS = `${SRC.archP5} (employers see only aggregates); ${SRC.archActors} (Employer HR row); ${SRC.ilo108}`

const PERMITTED_MATRIX: Record<Role, Record<PermittedPurpose, AccessRule>> = {
  worker: {
    safety_alerting: selfOnly('Workers see their own level, actions and everything Zill holds about them, on their own device.'),
    clinical_care: selfOnly('A worker may always see their own clinical detail.'),
    operational_planning: selfOnly('A worker may see their own schedule and the data behind it.'),
    compliance_reporting: selfOnly('A worker may see their own records, e.g. to check the rest they were given.'),
    public_health_statistics: selfOnly(
      'A worker may see their own data; whether it counts in statistics is their choice (aggregateStatistics consent).',
    ),
  },
  buddy: {
    safety_alerting: {
      grants: [
        {
          fields: BUDDY_VIEW,
          requires: ['is_buddy'],
          reason: "The partner's level and what to do, to run a buddy check.",
        },
      ],
      aggregateMinCell: null,
      reason: "A buddy sees the partner's level and a buddy-check prompt, never clinical data.",
      basis: `${SRC.archActors} (Buddy row); ARCHITECTURE §5 (buddy mandatory in conservative mode); ${SRC.ilo614}`,
    },
    clinical_care: deny(
      'Buddies are co-workers, not clinicians; clinical detail goes only to occupational health, with consent.',
      `${SRC.ilo82}; ${SRC.archActors} (Buddy: never the partner's clinical data)`,
    ),
    operational_planning: deny(
      'Planning is the supervisor’s job; a buddy only receives the live check prompt.',
      `${SRC.archActors} (Buddy row); ${SRC.ilo614}`,
    ),
    compliance_reporting: deny(
      'Compliance is reported to HSE and regulators as k-suppressed aggregates, not to co-workers.',
      `${SRC.archGov}; ${SRC.ilo614}`,
    ),
    public_health_statistics: deny(
      'Statistics are released only as k-suppressed aggregates to the regulator.',
      `${SRC.archActors}; ${SRC.archGov}`,
    ),
  },
  supervisor: {
    safety_alerting: supervisorView(
      'Supervisors see what to do — level, actions, work/rest, water, acknowledgement and non-clinical reasons — never clinical detail.',
    ),
    operational_planning: supervisorView(
      'Planning rest, rotation and water needs the same non-clinical view, never clinical detail.',
    ),
    clinical_care: deny(
      'Supervisors are not clinicians: heart rate, strain estimates, health factors and symptoms are never shown to them.',
      `${SRC.ilo82}; ${SRC.ilo108}; ${SRC.archActors} (Crew supervisor: never HR, core-temperature estimate, risk flags, symptoms)`,
    ),
    compliance_reporting: deny(
      'Individual compliance records would let a supervisor monitor individual behaviour; compliance is reported as k-suppressed aggregates.',
      `${SRC.ilo54}; ${SRC.archGov}`,
    ),
    public_health_statistics: deny(
      'Statistics are released only as k-suppressed aggregates to the regulator.',
      `${SRC.archActors}; ${SRC.archGov}`,
    ),
  },
  first_aider: {
    safety_alerting: {
      grants: [
        {
          fields: FIRST_AID_CASE_VIEW,
          requires: ['active_case'],
          reason: 'Who needs help, how urgently, what to do and where they are.',
        },
        {
          fields: ['symptoms'],
          requires: ['active_case', 'escalated'],
          reason: 'Reported symptoms guide first aid once the case is escalated (vital-interest exception).',
        },
      ],
      aggregateMinCell: null,
      reason:
        'First aiders see active STOP/EMERGENCY cases — name, level, actions, location — and the reported symptoms once the case is escalated.',
      basis: `${SRC.archActors} (First aider: active stop and emergency cases, protocol, location; never history or flags); ${SRC.ilo101} — symptoms are released under its vital-interest exception; ${SRC.ilo614}`,
    },
    clinical_care: deny(
      'First aid is given under safety alerting; ongoing clinical care belongs to occupational health, with consent.',
      `${SRC.ilo82}; ${SRC.archActors} (First aider row)`,
    ),
    operational_planning: deny('A first aider needs only the live case, not planning data.', FIRST_AID_ONLY),
    compliance_reporting: deny('A first aider needs only the live case, not compliance records.', FIRST_AID_ONLY),
    public_health_statistics: deny('A first aider needs only the live case, not statistics.', FIRST_AID_ONLY),
  },
  occ_health: {
    clinical_care: {
      grants: [
        {
          fields: OH_CASE_VIEW,
          requires: ['escalated'],
          reason: 'The escalated case: who, where, level, actions and acknowledgement.',
        },
        {
          fields: OH_CLINICAL_VIEW,
          requires: ['escalated', 'medic_sharing_consent'],
          reason: 'Clinical detail, because the worker agreed to share it with occupational health on escalation.',
        },
      ],
      aggregateMinCell: null,
      reason:
        'Occupational health sees escalated cases; clinical detail only when the worker consented to share it on escalation.',
      basis: `${SRC.archP5} (clinical detail reaches occupational health only when a case is escalated and the worker has consented); ${SRC.archActors} (Occupational health row); ${SRC.ilo82}; ${SRC.ilo101}; ${SRC.pdplConsent}; ${SRC.ictHealth} — applies inside a DoH-licensed OH service, applicability needs legal confirmation [D]`,
    },
    safety_alerting: {
      grants: [
        {
          fields: OH_CASE_VIEW,
          requires: ['escalated'],
          reason: 'Occupational health is alerted to escalated cases.',
        },
      ],
      aggregateMinCell: null,
      reason:
        'Occupational health is alerted to escalated cases without clinical detail; clinical detail needs the clinical-care purpose and consent.',
      basis: `ARCHITECTURE §6 (emergency → supervisor + first aider + occupational health immediately); ${SRC.archActors}`,
    },
    operational_planning: deny('Occupational health never sees workers whose case is not escalated.', OH_NEVER),
    compliance_reporting: deny(
      'Compliance is reported as k-suppressed aggregates to HSE, the regulator and HR, not by occupational health.',
      `${OH_NEVER}; ${SRC.archGov}`,
    ),
    public_health_statistics: deny(
      'Statistics are released only as k-suppressed aggregates to the regulator.',
      `${OH_NEVER}; ${SRC.archGov}`,
    ),
  },
  hse_manager: {
    safety_alerting: aggregatesOnly(
      DEFAULT_MIN_CELL_SIZE,
      'HSE managers see site status as aggregates (cells below k = 5 suppressed), never individual records.',
      HSE_BASIS,
    ),
    operational_planning: aggregatesOnly(
      DEFAULT_MIN_CELL_SIZE,
      'HSE managers plan from site aggregates (cells below k = 5 suppressed), never individual records.',
      HSE_BASIS,
    ),
    compliance_reporting: aggregatesOnly(
      DEFAULT_MIN_CELL_SIZE,
      'HSE managers see compliance and incidents as aggregates (cells below k = 5 suppressed), never individual records.',
      HSE_BASIS,
    ),
    clinical_care: deny('HSE has no clinical role.', `${SRC.ilo82}; ${SRC.ilo108}`),
    public_health_statistics: deny(
      'Public-health statistics are compiled for the regulator (k = 10), not for site management.',
      `${SRC.archActors} (Regulator row)`,
    ),
  },
  regulator: {
    compliance_reporting: aggregatesOnly(
      REGULATOR_MIN_CELL_SIZE,
      'Regulators see multi-site aggregates and compliance with cells below k = 10 suppressed, never an individual record.',
      `${SRC.archActors} (Regulator row); ${SRC.k10}; ${SRC.pdplArt4}`,
    ),
    public_health_statistics: aggregatesOnly(
      REGULATOR_MIN_CELL_SIZE,
      'Regulators see public-health aggregates (cells below k = 10 suppressed) counting only workers who consented to aggregate statistics.',
      `${SRC.archActors} (Regulator row); ${SRC.k10}; ${SRC.pdplArt4}; consent-first design (context_and_commercial §4.1) [D]`,
    ),
    safety_alerting: deny(
      'The regulator has no operational role over individual workers.',
      `${SRC.archActors} (Regulator: never any individual record)`,
    ),
    operational_planning: deny(
      'The regulator has no operational role over individual workers.',
      `${SRC.archActors} (Regulator: never any individual record)`,
    ),
    clinical_care: deny('The regulator has no clinical role.', `${SRC.archActors}; ${SRC.ilo82}`),
  },
  employer_hr: {
    compliance_reporting: aggregatesOnly(
      EMPLOYER_MIN_CELL_SIZE,
      'Employer HR sees nothing individual: crew-level compliance aggregates only, with groups below 10 suppressed.',
      `${HR_BASIS}; ${SRC.k10}`,
    ),
    safety_alerting: deny('Employer HR receives nothing individual; the request is refused and logged.', HR_BASIS),
    clinical_care: deny('Employer HR receives no medical information; the request is refused and logged.', HR_BASIS),
    operational_planning: deny('Employer HR receives nothing individual; the request is refused and logged.', HR_BASIS),
    public_health_statistics: deny(
      'Public-health statistics are compiled for the regulator only; the request is refused and logged.',
      HR_BASIS,
    ),
  },
}

const PROHIBITED_CELLS = Object.fromEntries(
  (Object.keys(PROHIBITION_BASIS) as ProhibitedPurpose[]).map((purpose): [ProhibitedPurpose, AccessRule] => [
    purpose,
    { grants: [], aggregateMinCell: null, ...PROHIBITION_BASIS[purpose] },
  ]),
) as Record<ProhibitedPurpose, AccessRule>

/**
 * Role × purpose → what may be released, with a documented reason and basis per cell. Frozen at load.
 * - worker: everything about themselves, for every permitted purpose;
 * - buddy (safety_alerting): displayName, level, actions, ackStatus;
 * - supervisor (safety_alerting, operational_planning): displayName, crewId, level, actions, workMinPerHour,
 *   ackStatus, drivers_nonclinical, waterMlPerHour — never clinical fields, age or minutes-to-limit;
 * - first_aider (safety_alerting): active STOP/EMERGENCY cases — displayName, level, actions, location; symptoms only
 *   once escalated;
 * - occ_health: escalated cases; clinical fields only for clinical_care with the worker's sharing consent;
 * - hse_manager (k = 5), regulator (k = 10), employer_hr (k = 10): aggregates only, no individual projection;
 * - prohibited purposes: refused for every role.
 * Basis: ARCHITECTURE §1 principle 5, §2, §7; ILO code §5.4–5.6, §6.14(1), §8.2, §10.1, §10.8–10.9 [primary, S73];
 * UAE PDPL purpose limitation and consent [secondary, S61, S62]; context_and_commercial §6.2.
 */
export const ACCESS_MATRIX: Readonly<Record<Role, Readonly<Record<Purpose, AccessRule>>>> = deepFreeze(
  Object.fromEntries(
    (Object.keys(PERMITTED_MATRIX) as Role[]).map((role) => [role, { ...PERMITTED_MATRIX[role], ...PROHIBITED_CELLS }]),
  ) as Record<Role, Record<Purpose, AccessRule>>,
)

/**
 * True for a purpose Zill data may never serve, whatever the role or consent.
 * Basis: types.ts `PROHIBITED_PURPOSES`; context_and_commercial §6.2; ILO code §5.13 [primary, S73].
 */
export function isProhibitedPurpose(purpose: Purpose): purpose is ProhibitedPurpose {
  return PROHIBITED_PURPOSES.includes(purpose)
}

// ─────────────────────────────── Projection ───────────────────────────────

/** Who is asking, for what. */
export interface AccessRequest {
  role: Role
  /** Identifier of the person asking (logged). */
  actorId: string
  purpose: Purpose
  /** Fields asked for; omitted = everything the role may receive for this purpose. */
  fields?: readonly DataField[]
}

/** Request-time facts the matrix conditions are evaluated against. */
export interface ProjectionContext {
  /** Request time (epoch ms); stamped on the audit entry. */
  now: number
  /** True once the subject's case has been escalated (stop unacknowledged, emergency, first-aider hand-over). */
  escalated: boolean
  /**
   * Actor ids paired as the subject's buddy. When supplied, buddy access requires membership; when omitted, pairing
   * is not checked [ENG]: a missing pairing table must not block a buddy check, and the buddy view is non-clinical.
   */
  buddyIds?: readonly string[]
  /**
   * Crews the requester supervises. When supplied, supervisor access requires the subject's crew to be listed; when
   * omitted, crew scope is not checked [ENG]: safety alerting must not fail closed, and the view is non-clinical.
   */
  actorCrewIds?: readonly string[]
}

/** An audit entry before the log assigns its sequence number and hashes. */
export type AuditDraft = Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'>

/** Result of `project()`. */
export interface ProjectionResult {
  decision: 'allowed' | 'denied'
  /** Pseudonymous id of the worker the data is about. */
  subjectId: string
  /** Fields actually released, in canonical order. */
  fields: DataField[]
  /** Values for exactly `fields` — no other key is present. */
  data: ProjectedData
  /** Requested fields that were not released. */
  withheld: DataField[]
  /** Human-readable reason (safe to show the requester). */
  reason: string
  /** Audit entry to append; `projectAndLog()` appends it. For a denial, `fields` lists what was requested. */
  audit: AuditDraft
}

function conditionHolds(
  condition: GrantCondition,
  snapshot: WorkerSnapshot,
  request: AccessRequest,
  ctx: ProjectionContext,
): boolean {
  switch (condition) {
    case 'is_self':
      return request.actorId === snapshot.workerId
    case 'is_buddy':
      return ctx.buddyIds === undefined || ctx.buddyIds.includes(request.actorId)
    case 'in_actor_crew':
      return ctx.actorCrewIds === undefined || ctx.actorCrewIds.includes(snapshot.crewId)
    case 'active_case':
      return RISK_ORDER[snapshot.level] >= RISK_ORDER.stop
    case 'escalated':
      return ctx.escalated
    case 'medic_sharing_consent':
      return snapshot.consent.shareWithMedicOnEscalation
  }
}

/** Requested fields in canonical order, de-duplicated; unknown strings are ignored. */
function normaliseFields(fields: readonly DataField[] | undefined): DataField[] {
  return fields === undefined ? [...DATA_FIELDS] : DATA_FIELDS.filter((f) => fields.includes(f))
}

function copyDriver(driver: RiskDriver, keepNumbers: boolean): RiskDriver {
  const out: RiskDriver = {
    id: driver.id,
    channel: driver.channel,
    text: driver.text,
    direction: driver.direction,
    basis: driver.basis,
  }
  if (keepNumbers && driver.value !== undefined) out.value = driver.value
  if (keepNumbers && driver.unit !== undefined) out.unit = driver.unit
  return out
}

function clinicalDriverAllowed(driver: RiskDriver, consent: ConsentState): boolean {
  if (!CLINICAL_DRIVER_CHANNELS.includes(driver.channel)) return false
  if (driver.channel === 'physiology') return consent.wearable
  if (driver.channel === 'hydration') return consent.checkins
  return true // symptoms: red flags can be buddy-reported (ILO code §10.1 vital-interest exception)
}

type Extractors = {
  readonly [F in DataField]: (snapshot: WorkerSnapshot, released: ReadonlySet<DataField>) => FieldValues[F]
}

/**
 * Value extraction per field. Copies are returned so a recipient can never mutate the on-device record.
 * - actions: confidential follow-up actions only for recipients cleared for clinical drivers;
 * - drivers_nonclinical: environment/regulation/projection drivers; a projection driver's number (the individual
 *   minutes-to-limit or sweat projection) is kept only when minutesToLimit itself is released [ENG].
 */
const EXTRACT: Extractors = {
  displayName: (s) => s.displayName,
  crewId: (s) => s.crewId,
  level: (s) => s.level,
  actions: (s, released) =>
    released.has('drivers_clinical') ? [...s.actions] : s.actions.filter((a) => !CONFIDENTIAL_ACTIONS.includes(a)),
  workMinPerHour: (s) => s.workMinPerHour,
  ackStatus: (s) => s.ackStatus,
  minutesToLimit: (s) => s.minutesToLimit,
  waterMlPerHour: (s) => s.waterMlPerHour,
  drivers_nonclinical: (s, released) =>
    s.drivers
      .filter((d) => !CLINICAL_DRIVER_CHANNELS.includes(d.channel))
      .map((d) => copyDriver(d, d.channel !== 'projection' || released.has('minutesToLimit'))),
  drivers_clinical: (s) => s.drivers.filter((d) => clinicalDriverAllowed(d, s.consent)).map((d) => copyDriver(d, true)),
  hrBpm: (s) => s.hrBpm,
  ctEstC: (s) => s.ctEstC,
  psi: (s) => s.psi,
  riskFlags: (s) => [...s.riskFlags],
  symptoms: (s) => [...s.symptoms],
  urineColor: (s) => s.urineColor,
  ageYears: (s) => s.ageYears,
  location: (s) => (s.location ? { ...s.location } : null),
}

function assignField<F extends DataField>(
  data: ProjectedData,
  field: F,
  snapshot: WorkerSnapshot,
  released: ReadonlySet<DataField>,
): void {
  data[field] = EXTRACT[field](snapshot, released)
}

const join = (fields: readonly DataField[]): string => fields.join(', ')

/**
 * Projects the on-device record for one request: returns ONLY the fields the role × purpose matrix grants under the
 * current conditions and consent, plus the reason and the audit entry to append. A prohibited purpose is refused for
 * every role, whatever the consent. Consent is read from the snapshot at call time, so a revocation is effective on
 * the next call. Use `projectAndLog()` so that every call is logged.
 * Basis: ARCHITECTURE §1 principle 5, §7; ILO code §6.14(1) minimise the intrusion, §8.2, §10.1, §10.8–10.9
 * [primary, S73]; UAE PDPL purpose limitation and consent withdrawal [secondary, S61, S62].
 */
export function project(snapshot: WorkerSnapshot, request: AccessRequest, ctx: ProjectionContext): ProjectionResult {
  const { role, actorId, purpose } = request
  const rule = ACCESS_MATRIX[role][purpose]
  const requested = normaliseFields(request.fields)
  const head = `${ROLE_LABELS[role]} · ${PURPOSE_LABELS[purpose]}:`

  const finish = (decision: 'allowed' | 'denied', fields: DataField[], reason: string): ProjectionResult => {
    const released = new Set(fields)
    const data: ProjectedData = {}
    for (const field of fields) assignField(data, field, snapshot, released)
    return {
      decision,
      subjectId: snapshot.workerId,
      fields,
      data,
      withheld: requested.filter((f) => !released.has(f)),
      reason,
      audit: {
        t: ctx.now,
        actorRole: role,
        actorId,
        purpose,
        subjectId: snapshot.workerId,
        fields: decision === 'allowed' ? [...fields] : [...requested],
        decision,
        reason,
      },
    }
  }

  if (isProhibitedPurpose(purpose)) {
    return finish('denied', [], `${head} refused. ${rule.reason} This refusal is logged.`)
  }

  const granted = new Set<DataField>()
  const failedConditions = new Map<DataField, Set<GrantCondition>>()
  for (const grant of rule.grants) {
    const failed = grant.requires.filter((c) => !conditionHolds(c, snapshot, request, ctx))
    for (const field of grant.fields) {
      if (failed.length === 0) granted.add(field)
      else {
        const set = failedConditions.get(field) ?? new Set<GrantCondition>()
        for (const c of failed) set.add(c)
        failedConditions.set(field, set)
      }
    }
  }
  const blockedByConsent: DataField[] = []
  for (const field of DATA_FIELDS) {
    const scope = FIELD_CONSENT_DEPENDENCY[field]
    if (granted.has(field) && scope !== undefined && !snapshot.consent[scope]) {
      granted.delete(field)
      if (requested.includes(field)) blockedByConsent.push(field)
    }
  }

  const fields = requested.filter((f) => granted.has(f))
  const blockedByCondition = requested.filter((f) => !granted.has(f) && failedConditions.has(f))
  const notForPurpose = requested.filter(
    (f) => !granted.has(f) && !failedConditions.has(f) && !blockedByConsent.includes(f),
  )

  const parts = [head, rule.reason]
  if (blockedByCondition.length > 0) {
    const unmet = new Set<GrantCondition>()
    for (const f of blockedByCondition) for (const c of failedConditions.get(f) ?? []) unmet.add(c)
    const conditions = [...unmet].map((c) => CONDITION_TEXT[c]).join(' and ')
    parts.push(`Not released until ${conditions}: ${join(blockedByCondition)}.`)
  }
  if (blockedByConsent.length > 0) {
    parts.push(`Not released because the worker's consent is off: ${join(blockedByConsent)}.`)
  }
  if (request.fields !== undefined && notForPurpose.length > 0) {
    parts.push(`Never released for this purpose: ${join(notForPurpose)}.`)
  }
  if (fields.length === 0 && rule.aggregateMinCell !== null) {
    parts.push(`Aggregates only (cells below k = ${rule.aggregateMinCell} suppressed).`)
  }
  return finish(fields.length > 0 ? 'allowed' : 'denied', fields, parts.join(' '))
}

/**
 * `project()` followed by appending its audit entry, so every access attempt — allowed or refused — is in the
 * hash-chained log. Basis: ARCHITECTURE §7 ("every call appends to the audit log"; refusals are logged).
 */
export async function projectAndLog(
  log: AuditLog,
  snapshot: WorkerSnapshot,
  request: AccessRequest,
  ctx: ProjectionContext,
): Promise<ProjectionResult & { entry: AuditEntry }> {
  const result = project(snapshot, request, ctx)
  const entry = await log.append(result.audit)
  return { ...result, entry }
}

/** What `explain()` is asked about. `AccessRequest` is accepted as is. */
export interface ExplainRequest {
  role: Role
  purpose: Purpose
  fields?: readonly DataField[]
}

/** Human-readable explanation of one matrix cell for the governance UI. */
export interface AccessExplanation {
  role: Role
  purpose: Purpose
  prohibited: boolean
  summary: string
  /** Releasable fields (restricted to the request) with the conditions of the grant that releases them. */
  grants: { fields: DataField[]; conditions: string[]; reason: string }[]
  /** Requested (or all) fields this role can never receive for this purpose. */
  neverReleased: DataField[]
  /** Releasable fields that also need an active consent scope. */
  consentGated: { field: DataField; scope: ConsentScope }[]
  /** k for aggregates, or null when no aggregates are available. */
  aggregateMinCell: number | null
  basis: string
  /** Sentences ready to render. */
  lines: string[]
}

const labels = (fields: readonly DataField[]): string => fields.map((f) => FIELD_INFO[f].label).join(', ')

/**
 * Explains, in plain language, what a role may receive for a purpose, under which conditions, and why.
 * Basis: UAE AI Charter (2024) principle 5 Transparency [primary, S71]; ILO code §6.14(1) (workers informed in
 * advance of the data collected) [primary, S73]; ARCHITECTURE §9 (governance centre: role × purpose matrix).
 */
export function explain(request: ExplainRequest): AccessExplanation {
  const { role, purpose } = request
  const rule = ACCESS_MATRIX[role][purpose]
  const scope = normaliseFields(request.fields)
  const prohibited = isProhibitedPurpose(purpose)
  const grants = rule.grants
    .map((g) => ({
      fields: scope.filter((f) => g.fields.includes(f)),
      conditions: g.requires.map((c) => CONDITION_TEXT[c]),
      reason: g.reason,
    }))
    .filter((g) => g.fields.length > 0)
  const releasable = scope.filter((f) => grants.some((g) => g.fields.includes(f)))
  const neverReleased = scope.filter((f) => !releasable.includes(f))
  const consentGated = releasable.flatMap((field) => {
    const consentScope = FIELD_CONSENT_DEPENDENCY[field]
    return consentScope === undefined ? [] : [{ field, scope: consentScope }]
  })

  const lines = [`${ROLE_LABELS[role]} · ${PURPOSE_LABELS[purpose]}: ${rule.reason}`]
  if (prohibited) lines.push('Refused for every role, whatever the consent. Each refusal is written to the audit log.')
  for (const g of grants) {
    const when = g.conditions.length > 0 ? `when ${g.conditions.join(' and ')}` : 'always'
    lines.push(`Released ${when}: ${labels(g.fields)}.`)
  }
  for (const { field, scope: consentScope } of consentGated) {
    lines.push(`${FIELD_INFO[field].label} only while the worker's '${consentScope}' consent is on.`)
  }
  if (!prohibited && neverReleased.length > 0) lines.push(`Never released for this purpose: ${labels(neverReleased)}.`)
  if (rule.aggregateMinCell !== null) {
    lines.push(
      `Aggregates only, with every group smaller than ${rule.aggregateMinCell} suppressed and complementary suppression so no hidden cell can be recovered.`,
    )
  }
  lines.push(`Basis: ${rule.basis}`)

  return {
    role,
    purpose,
    prohibited,
    summary: rule.reason,
    grants,
    neverReleased,
    consentGated,
    aggregateMinCell: rule.aggregateMinCell,
    basis: rule.basis,
    lines,
  }
}

// ─────────────────────────────── Consent ───────────────────────────────

/**
 * Returns a new `ConsentState` with `scope` switched on (the input is not modified).
 * Basis: UAE PDPL — consent "specific, informed and unambiguous", by "a clear affirmative action" [secondary, S62];
 * ARCHITECTURE §7 (all scopes opt-in).
 */
export function grantConsent(state: ConsentState, scope: ConsentScope, t: number): ConsentState {
  const next: ConsentState = { ...state, updatedAt: t }
  next[scope] = true
  return next
}

/**
 * Returns a new `ConsentState` with `scope` switched off (the input is not modified). Projections read consent at
 * call time, so the revocation is effective on the very next request.
 * Basis: UAE PDPL — "Data subjects may withdraw their consent at any time" [secondary, S62]; ILO code §5.13
 * [primary, S73]; DoH SBR 2026 (free choice to withdraw with no consequence) [primary, S70].
 */
export function revokeConsent(state: ConsentState, scope: ConsentScope, t: number): ConsentState {
  const next: ConsentState = { ...state, updatedAt: t }
  next[scope] = false
  return next
}

/** The notice a worker agrees to for one consent scope. */
export interface ConsentNotice {
  scope: ConsentScope
  version: string
  title: string
  /** Plain-language statement agreed to (English master; translations must carry the same text). */
  statement: string
  dataProcessed: string
  whoSees: string
  retention: string
  withdrawal: string
  legalBasis: string
}

/**
 * Version of the consent notices; recorded on every receipt. Basis: UAE PDPL — the controller "must be able to prove
 * that the data subject gave consent" [secondary, S62]. [ENG]
 */
export const CONSENT_NOTICE_VERSION = '1.0'

const WITHDRAWAL_TEXT =
  'I can switch this off at any time in Zill. It takes effect immediately and I will not be penalised for it.'

/**
 * Plain-language consent notices, one per scope. Wording follows the claims discipline (an estimate, not a medical
 * measurement or diagnosis). Basis: UAE PDPL consent rules [secondary, S62]; DoH SBR 2026 §3.5.3.2.4 (Arabic and
 * English with the same text; clear, non-technical, non-exculpatory language) [primary, S70]; ILO code §6.14(1)
 * [primary, S73]; ARCHITECTURE §1 principle 8.
 */
export const CONSENT_NOTICES: Readonly<Record<ConsentScope, ConsentNotice>> = deepFreeze({
  wearable: {
    scope: 'wearable',
    version: CONSENT_NOTICE_VERSION,
    title: 'Heart rate from my band',
    statement:
      'Zill may read heart rate from my band on this phone to estimate my heat strain. It is an estimate to help keep me safe, not a medical measurement or a diagnosis. My supervisor never sees it.',
    dataProcessed: 'Heart-rate samples; estimated strain indicators (ECTemp, PSI) calculated on this phone.',
    whoSees: 'Only me — and occupational health only if my case is escalated and I also agreed to share with them.',
    retention: 'Raw heart-rate and strain traces are deleted from this phone after 24 hours.',
    withdrawal: WITHDRAWAL_TEXT,
    legalBasis: `${SRC.pdplConsent}; ${SRC.pdplSensitive}`,
  },
  healthFlags: {
    scope: 'healthFlags',
    version: CONSENT_NOTICE_VERSION,
    title: 'Health factors that make heat more dangerous for me',
    statement:
      'Zill may use my yes/no answers (for example a recent illness, or a medicine that affects heat tolerance) to make my alerts stricter. My answers stay on this phone and are never shown to my supervisor or employer.',
    dataProcessed: 'Self-declared yes/no risk factors; never added up into a score.',
    whoSees: 'Only me — and occupational health only if my case is escalated and I also agreed to share with them.',
    retention: 'Kept on this phone until I change or delete them.',
    withdrawal: WITHDRAWAL_TEXT,
    legalBasis: `${SRC.pdplConsent}; ${SRC.pdplSensitive}`,
  },
  checkins: {
    scope: 'checkins',
    version: CONSENT_NOTICE_VERSION,
    title: 'Symptom and hydration check-ins',
    statement:
      'Zill may ask how I feel and the colour of my urine. My answers stay on this phone. If my case is escalated, the first aider sees the symptoms I reported so they can help me.',
    dataProcessed: 'Check-in answers (symptoms, urine colour) and the drinks I log.',
    whoSees:
      'Me; the first aider for an escalated STOP or EMERGENCY case. A buddy or first aider can always report danger signs for me.',
    // Must match CHECKIN_RETENTION_MS and LEVEL_HISTORY_RETENTION_MS (asserted in privacy.test.ts).
    retention:
      'Deleted from this phone after 30 days, unless my case is escalated and occupational health still holds it open. My level history is kept under a pseudonym for 30 days.',
    withdrawal: WITHDRAWAL_TEXT,
    legalBasis: `${SRC.pdplConsent}; ${SRC.ilo101}`,
  },
  shareWithMedicOnEscalation: {
    scope: 'shareWithMedicOnEscalation',
    version: CONSENT_NOTICE_VERSION,
    title: 'Share with occupational health if my case is escalated',
    statement:
      'If my case is escalated, the occupational health nurse may see my heart-rate estimates, health factors and check-in answers to look after me. Nobody else sees them, and they are never used against me.',
    dataProcessed: 'The clinical fields held on this phone, released only for an escalated case.',
    whoSees: 'The occupational health nurse, bound by medical confidentiality.',
    retention: 'Kept by occupational health under medical confidentiality, apart from all other personal data.',
    withdrawal: WITHDRAWAL_TEXT,
    legalBasis: `${SRC.pdplConsent}; ${SRC.ilo82}; ${SRC.ilo101}`,
  },
  aggregateStatistics: {
    scope: 'aggregateStatistics',
    version: CONSENT_NOTICE_VERSION,
    title: 'Count me in anonymous statistics',
    statement:
      'My data may be counted in public-health statistics about heat at work. Groups of fewer than 10 people are hidden so that I cannot be picked out.',
    dataProcessed: 'Counts by site, crew and level; never an individual record.',
    whoSees: 'The regulator (ADPHC / ADOSH), as aggregates only.',
    retention: 'Aggregates are kept; they contain no individual record.',
    withdrawal: WITHDRAWAL_TEXT,
    legalBasis: `${SRC.pdplConsent}; ${SRC.pdplArt4}; ${SRC.k10}`,
  },
})

/** A general privacy notice: information every worker receives whatever their choices. It is not a consent. */
export interface PrivacyNotice {
  version: string
  title: string
  /** Plain-language statement (English master; every translation must carry the same text — i18n `privacy_notice.*`). */
  statement: string
  legalBasis: string
}

/**
 * Version of {@link GENERAL_PRIVACY_NOTICE}; bump it whenever its title or statement changes, so translations can be
 * checked against it. [ENG]
 */
export const GENERAL_PRIVACY_NOTICE_VERSION = '1.0'

/**
 * General privacy notice (English source text), shown to every worker whatever their consent choices. It closes the
 * transparency gap recorded in GOVERNANCE §4.2 and §13 item 14: aggregate counts for the HSE manager (k = 5) and for
 * the regulator and employer HR (k = 10) are made under the employer's legal duty, whether or not the worker gave the
 * optional `aggregateStatistics` consent, and never contain individual data. That consent only adds the worker to
 * public-health statistics ({@link AGGREGATE_CONSENT}). The k values and the consent title are taken from the code, so
 * the notice cannot drift from what `aggregateFor()` does.
 * Basis: ILO code §6.14(1) workers informed in advance [primary, S73]; UAE PDPL Art. 4 (processing without consent for
 * occupational medicine and statistics) [secondary, S61]; employer legal duty (MoHRE MR 44/2022; ADOSH-SF CoP 11.0
 * v4.0); ARCHITECTURE §7 (k = 5 default; k = 10 for the regulator and employer HR).
 */
export const GENERAL_PRIVACY_NOTICE: Readonly<PrivacyNotice> = deepFreeze({
  version: GENERAL_PRIVACY_NOTICE_VERSION,
  title: 'How you are counted in group totals',
  statement:
    'Your employer has a legal duty to keep work in the heat safe. ' +
    `For this, Zill counts every worker in group totals, even if you did not choose “${CONSENT_NOTICES.aggregateStatistics.title}”. ` +
    `The site safety (HSE) manager sees only groups of ${DEFAULT_MIN_CELL_SIZE} or more workers. ` +
    `The regulator and your employer's HR see only groups of ${REGULATOR_MIN_CELL_SIZE} or more workers. ` +
    'Smaller groups are hidden, and the totals never show your name or any record about you alone. ' +
    'Your choice about anonymous statistics only decides whether you are also counted in public-health statistics.',
  legalBasis: `Employer legal duty (MoHRE MR 44/2022; ADOSH-SF CoP 11.0 v4.0); ${SRC.pdplArt4}; ${SRC.ilo614}; ${SRC.archGov} (k = ${DEFAULT_MIN_CELL_SIZE} for the HSE manager, k = ${REGULATOR_MIN_CELL_SIZE} for the regulator and employer HR); GOVERNANCE §4.2 and §13 item 14 [D]`,
})

/** Who may collect a consent. Basis: DoH SBR 2026 — supervisors must not obtain consent [primary, S70]. */
export type ConsentCollector = 'self' | 'research_staff' | 'occ_health'

/**
 * How the consent was given. `witnessed_mark` = the worker cannot read; an impartial witness signs.
 * Basis: UAE PDPL ("a statement or a clear affirmative action in writing or electronic form") [secondary, S62];
 * DoH SBR 2026 (impartial witness) [primary, S70].
 */
export type ConsentMethod = 'electronic_affirmative_action' | 'written_signature' | 'witnessed_mark'

/** Input of `createConsentReceipt()`. */
export interface ConsentReceiptInput {
  subjectId: string
  scope: ConsentScope
  action: 'granted' | 'revoked'
  t: number
  /** Language the notice was shown in. */
  language: LangCode
  method: ConsentMethod
  collectedBy: ConsentCollector
  /** Required for `witnessed_mark`. */
  witnessId?: string
}

/** Proof of what was agreed (or withdrawn), when, in which language, and which notice version. */
export interface ConsentReceipt {
  receiptId: string
  subjectId: string
  scope: ConsentScope
  action: 'granted' | 'revoked'
  t: number
  noticeVersion: string
  title: string
  statement: string
  language: LangCode
  method: ConsentMethod
  collectedBy: ConsentCollector
  witnessId?: string
}

const CONSENT_COLLECTORS: readonly ConsentCollector[] = ['self', 'research_staff', 'occ_health']

/**
 * Creates a frozen consent receipt recording what was agreed, when, in which language and under which notice
 * version. Throws if a hierarchical superior collects the consent, or a witnessed mark has no witness.
 * Basis: UAE PDPL — the controller "must be able to prove that the data subject gave consent" [secondary, S62];
 * DoH SBR 2026 — workers in a hierarchy are vulnerable participants, supervisors must not obtain consent, trained
 * research staff may (§3.11.2.5), an impartial witness signs for a participant who cannot read [primary, S70].
 */
export function createConsentReceipt(input: ConsentReceiptInput): ConsentReceipt {
  if (!CONSENT_COLLECTORS.includes(input.collectedBy)) {
    throw new Error(
      `Consent collected by '${String(input.collectedBy)}' is invalid: a worker's consent may not be obtained by a hierarchical superior (DoH SBR 2026).`,
    )
  }
  if (input.method === 'witnessed_mark' && !input.witnessId) {
    throw new Error('A witnessed mark needs the impartial witness who signed (DoH SBR 2026).')
  }
  const notice = CONSENT_NOTICES[input.scope]
  const receipt: ConsentReceipt = {
    receiptId: `${input.subjectId}/${input.scope}/${input.action}/${input.t}`,
    subjectId: input.subjectId,
    scope: input.scope,
    action: input.action,
    t: input.t,
    noticeVersion: notice.version,
    title: notice.title,
    statement: notice.statement,
    language: input.language,
    method: input.method,
    collectedBy: input.collectedBy,
  }
  if (input.witnessId) receipt.witnessId = input.witnessId
  return Object.freeze(receipt)
}

/** A processing activity and whether the worker's consent currently switches it on. */
export type ProcessingId =
  | 'core_safety_alerting'
  | 'wearable_physiology'
  | 'personalised_thresholds'
  | 'symptom_checkins'
  | 'clinical_sharing_on_escalation'
  | 'aggregate_statistics'

/** One processing activity, whether it is currently active, and the consent scope and legal basis behind it. */
export interface ProcessingActivity {
  id: ProcessingId
  active: boolean
  /** Consent scope that switches it on; null = needs no consent. */
  scope: ConsentScope | null
  description: string
  /** Fields the activity produces or discloses. */
  fields: DataField[]
  legalBasis: string
}

/**
 * Lists every processing activity and whether it is active under `consent`. Core safety alerting uses only the
 * environment and work context and is always on; everything else follows its consent scope.
 * Basis: ARCHITECTURE §7 ("core safety alerting uses only environment and work context"); UAE PDPL Art. 4
 * (occupational or preventive medicine without consent) [secondary, S61] and consent rules [secondary, S62];
 * MoHRE Ministerial Resolution 44/2022 and ADOSH-SF CoP 11.0 v4.0 (employer duties, ARCHITECTURE §1 principle 6).
 */
export function activeProcessing(consent: ConsentState): ProcessingActivity[] {
  return [
    {
      id: 'core_safety_alerting',
      active: true,
      scope: null,
      description:
        'Site weather and work context → level, actions, work/rest and water schedule. Uses no health data.',
      fields: ['level', 'actions', 'workMinPerHour', 'waterMlPerHour', 'minutesToLimit', 'drivers_nonclinical'],
      legalBasis: `Employer legal duty (MoHRE MR 44/2022 midday break; ADOSH-SF CoP 11.0 v4.0); ${SRC.pdplArt4}`,
    },
    {
      id: 'wearable_physiology',
      active: consent.wearable,
      scope: 'wearable',
      description: 'Heart rate from a paired band → estimated strain indicators on this phone (can only raise the level).',
      fields: ['hrBpm', 'ctEstC', 'psi', 'drivers_clinical'],
      legalBasis: `${SRC.pdplConsent}; ${SRC.pdplSensitive}`,
    },
    {
      id: 'personalised_thresholds',
      active: consent.healthFlags,
      scope: 'healthFlags',
      description: 'Self-declared health factors make the limits stricter (conservative mode).',
      fields: ['riskFlags'],
      legalBasis: `${SRC.pdplConsent}; ${SRC.pdplSensitive}`,
    },
    {
      id: 'symptom_checkins',
      active: consent.checkins,
      scope: 'checkins',
      description:
        'Symptom and hydration check-ins. A buddy or first aider can always report danger signs (vital-interest exception).',
      fields: ['symptoms', 'urineColor', 'drivers_clinical'],
      legalBasis: `${SRC.pdplConsent}; ${SRC.ilo101}`,
    },
    {
      id: 'clinical_sharing_on_escalation',
      active: consent.shareWithMedicOnEscalation,
      scope: 'shareWithMedicOnEscalation',
      description: 'Clinical detail is released to occupational health only for an escalated case.',
      fields: [...OH_CLINICAL_VIEW],
      legalBasis: `${SRC.pdplConsent}; ${SRC.ilo82}; ${SRC.ilo101}`,
    },
    {
      id: 'aggregate_statistics',
      active: consent.aggregateStatistics,
      scope: 'aggregateStatistics',
      description: 'Counted in public-health statistics (groups smaller than 10 suppressed).',
      fields: [],
      legalBasis: `${SRC.pdplConsent}; ${SRC.pdplArt4}; ${SRC.k10}`,
    },
  ]
}

// ─────────────────────────────── Aggregates ───────────────────────────────

/** How records are cross-tabulated. Records must not be individual-level data the recipient may not see. */
export interface AggregateGroupBy<T> {
  /** Row dimension, e.g. crew or site. */
  row: (record: T) => string
  /** Column dimension, e.g. level or TWL zone. */
  col: (record: T) => string
  /** Fixed row order; categories with no records still appear as zero cells. Unlisted keys are appended. */
  rows?: readonly string[]
  /** Fixed column order (e.g. RISK_LEVELS). Unlisted keys are appended. */
  cols?: readonly string[]
  /**
   * The individual behind a record. When records are events (e.g. worker-shifts), a cell's sensitivity is its number
   * of DISTINCT individuals, not of records. Defaults to one individual per record.
   */
  subject?: (record: T) => string
}

/** A published count, or a suppressed cell (which carries no count at all). */
export type PublishedCell = { suppressed: false; count: number } | { suppressed: true }

/** A k-suppressed two-way table with row, column and grand totals. */
export interface AggregateTable {
  k: number
  rows: string[]
  cols: string[]
  /** cells[i][j] for rows[i] × cols[j]. */
  cells: PublishedCell[][]
  rowTotals: PublishedCell[]
  colTotals: PublishedCell[]
  total: PublishedCell
  /** Number of suppressed cells, margins included (which ones were primary is not published). */
  suppressedCells: number
}

function grid<V>(rows: number, cols: number, init: (r: number, c: number) => V): V[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (__, c) => init(r, c)))
}

/**
 * Cheapest set of currently unsuppressed cells whose suppression puts cell (a, b) of the extended table on a cycle of
 * suppressed cells: Dijkstra from row-node a to column-node b over cells with a positive count, excluding (a, b);
 * suppressed cells cost 0. Returns null only if no path exists (impossible for a cell with a positive count).
 */
function cheapestCompletion(
  value: number[][],
  suppressed: boolean[][],
  a: number,
  b: number,
  cost: (x: number, y: number) => number,
): Array<[number, number]> | null {
  const nRows = value.length // row nodes 0..R (R = totals row)
  const nCols = value[0].length // column nodes nRows..nRows+C (C = totals column)
  const nodes = nRows + nCols
  const target = nRows + b
  const dist = new Array<number>(nodes).fill(Infinity)
  const done = new Array<boolean>(nodes).fill(false)
  const viaNode = new Array<number>(nodes).fill(-1)
  const viaCell: Array<[number, number] | null> = new Array<[number, number] | null>(nodes).fill(null)
  dist[a] = 0
  for (;;) {
    let u = -1
    for (let v = 0; v < nodes; v++) if (!done[v] && dist[v] < Infinity && (u === -1 || dist[v] < dist[u])) u = v
    if (u === -1) return null
    if (u === target) break
    done[u] = true
    const relax = (x: number, y: number, v: number): void => {
      if ((x === a && y === b) || value[x][y] < 1 || done[v]) return
      const d = dist[u] + (suppressed[x][y] ? 0 : cost(x, y))
      if (d < dist[v]) {
        dist[v] = d
        viaNode[v] = u
        viaCell[v] = [x, y]
      }
    }
    if (u < nRows) for (let y = 0; y < nCols; y++) relax(u, y, nRows + y)
    else for (let x = 0; x < nRows; x++) relax(x, u - nRows, x)
  }
  const path: Array<[number, number]> = []
  for (let v = target; v !== a; v = viaNode[v]) path.push(viaCell[v] as [number, number])
  return path
}

/**
 * Two-way frequency table with primary and complementary small-cell suppression.
 *
 * Primary suppression: every cell — inner cells AND the row, column and grand totals — whose number of distinct
 * individuals is between 1 and k − 1.
 *
 * Complementary suppression: in the extended (R+1)×(C+1) table (totals included) every suppressed cell is placed on a
 * cycle of suppressed cells of the bipartite row/column graph, and only cells with a positive count are ever
 * suppressed. Adding +1/−1 alternately around such a cycle (sign flipped on single-margin cells) changes no published
 * number and keeps every count ≥ 0, so each hidden cell has at least three values consistent with the publication:
 * no suppressed cell can be recovered by subtraction from row/column totals, even using non-negativity. Cycles are
 * completed by cheapest-path search (cost = hidden count, totals heavily penalised so inner cells are preferred), a
 * shortest-path heuristic for 2-D cell suppression [ENG]. Zero cells are never suppressed nor used as complements.
 * Known limitation: k-suppression does not stop homogeneity disclosure (when all members of a group share one
 * category, the zero cells reveal it).
 *
 * Basis: ARCHITECTURE §7 ("suppress any cell with fewer than k individuals (default k = 5); complementary suppression
 * stops a hidden cell from being recovered by subtraction"); context_and_commercial §6.2 item 4 (k = 10 for
 * employers) [D]; UAE PDPL sensitive data [secondary, S62].
 */
export function aggregate<T>(
  records: readonly T[],
  groupBy: AggregateGroupBy<T>,
  k: number = DEFAULT_MIN_CELL_SIZE,
): AggregateTable {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`aggregate: k must be a positive integer, got ${k}`)
  const rows = [...new Set(groupBy.rows ?? [])]
  const cols = [...new Set(groupBy.cols ?? [])]
  const rowIndex = new Map(rows.map((key, i) => [key, i] as const))
  const colIndex = new Map(cols.map((key, j) => [key, j] as const))
  const located = records.map((record, n) => {
    const rowKey = groupBy.row(record)
    const colKey = groupBy.col(record)
    if (!rowIndex.has(rowKey)) rowIndex.set(rowKey, rows.push(rowKey) - 1)
    if (!colIndex.has(colKey)) colIndex.set(colKey, cols.push(colKey) - 1)
    return {
      i: rowIndex.get(rowKey) as number,
      j: colIndex.get(colKey) as number,
      who: groupBy.subject ? `s:${groupBy.subject(record)}` : `r:${n}`,
    }
  })

  const R = rows.length
  const C = cols.length
  const value = grid(R + 1, C + 1, () => 0)
  const individuals = grid(R + 1, C + 1, () => new Set<string>())
  for (const { i, j, who } of located) {
    for (const [x, y] of [
      [i, j],
      [i, C],
      [R, j],
      [R, C],
    ] as const) {
      value[x][y] += 1
      individuals[x][y].add(who)
    }
  }

  const suppressed = grid(R + 1, C + 1, (x, y) => individuals[x][y].size > 0 && individuals[x][y].size < k)
  const penalty = value[R][C] + 1 // exceeds the cost of any path made of inner cells only
  const cost = (x: number, y: number): number => {
    const margins = (x === R ? 1 : 0) + (y === C ? 1 : 0) // 0 inner · 1 row/column total · 2 grand total
    return value[x][y] + margins * margins * penalty
  }
  for (let changed = true; changed; ) {
    changed = false
    for (let x = 0; x <= R; x++) {
      for (let y = 0; y <= C; y++) {
        if (!suppressed[x][y]) continue
        const path = cheapestCompletion(value, suppressed, x, y, cost)
        if (path === null) throw new Error('aggregate: no complementary suppression pattern exists') // unreachable
        for (const [p, q] of path) {
          if (!suppressed[p][q]) {
            suppressed[p][q] = true
            changed = true
          }
        }
      }
    }
  }

  const publish = (x: number, y: number): PublishedCell =>
    suppressed[x][y] ? { suppressed: true } : { suppressed: false, count: value[x][y] }
  return {
    k,
    rows,
    cols,
    cells: grid(R, C, publish),
    rowTotals: rows.map((_, i) => publish(i, C)),
    colTotals: cols.map((_, j) => publish(R, j)),
    total: publish(R, C),
    suppressedCells: suppressed.flat().filter(Boolean).length,
  }
}

/**
 * Purposes whose aggregates count only workers who consented. Basis: ARCHITECTURE §7 `aggregateStatistics` scope;
 * consent-first design with a separate legal basis documented (context_and_commercial §4.1) [D]; compliance
 * reporting relies on the employer's legal duty instead (UAE PDPL Art. 4 [secondary, S61]).
 */
export const AGGREGATE_CONSENT: Readonly<Partial<Record<Purpose, ConsentScope>>> = deepFreeze({
  public_health_statistics: 'aggregateStatistics',
})

/** A request for an aggregate table. */
export interface AggregateRequest {
  role: Role
  actorId: string
  purpose: Purpose
  /** A larger k may be asked for; a smaller one than the role's minimum is never applied. */
  k?: number
  /** Fields used as table dimensions (logged). */
  dimensions?: readonly DataField[]
}

/** Request-time facts for an aggregate request. */
export interface AggregateContext<T> {
  now: number
  /** The consent of the individual behind a record; required when the purpose needs consent. */
  consentOf?: (record: T) => ConsentState | undefined
}

/** Result of `aggregateFor()`. */
export interface AggregateResult {
  decision: 'allowed' | 'denied'
  /** The k actually applied, or null when denied. */
  k: number | null
  table: AggregateTable | null
  /** Records left out because their subject has not consented (for consent-based purposes). */
  excludedForConsent: number
  reason: string
  audit: AuditDraft
}

/**
 * Role-checked aggregate: applies the role × purpose matrix (no aggregates for roles without them), the role's
 * minimum k (regulator 10, employer HR 10, HSE 5 — never lowered), and the `aggregateStatistics` consent filter for
 * public-health statistics. Returns the audit entry to append.
 * Basis: ARCHITECTURE §1 principle 5, §2, §7; context_and_commercial §6.2 item 4 [D]; UAE PDPL Art. 4
 * [secondary, S61].
 */
export function aggregateFor<T>(
  request: AggregateRequest,
  records: readonly T[],
  groupBy: AggregateGroupBy<T>,
  ctx: AggregateContext<T>,
): AggregateResult {
  const { role, actorId, purpose } = request
  const rule = ACCESS_MATRIX[role][purpose]
  const head = `${ROLE_LABELS[role]} · ${PURPOSE_LABELS[purpose]}:`
  const result = (
    decision: 'allowed' | 'denied',
    reason: string,
    k: number | null = null,
    table: AggregateTable | null = null,
    excludedForConsent = 0,
  ): AggregateResult => ({
    decision,
    k,
    table,
    excludedForConsent,
    reason,
    audit: { t: ctx.now, actorRole: role, actorId, purpose, fields: [...(request.dimensions ?? [])], decision, reason },
  })

  if (isProhibitedPurpose(purpose)) return result('denied', `${head} refused. ${rule.reason} This refusal is logged.`)
  if (rule.aggregateMinCell === null) return result('denied', `${head} no aggregates for this role and purpose. ${rule.reason}`)
  const k = Math.max(rule.aggregateMinCell, request.k ?? 0)
  const scope = AGGREGATE_CONSENT[purpose]
  let included = records
  if (scope !== undefined) {
    const consentOf = ctx.consentOf
    if (consentOf === undefined) {
      return result('denied', `${head} refused: '${scope}' consent cannot be verified for these records.`)
    }
    included = records.filter((r) => consentOf(r)?.[scope] === true)
  }
  const excluded = records.length - included.length
  const note = excluded > 0 ? ` ${excluded} record(s) excluded: no '${scope}' consent.` : ''
  return result(
    'allowed',
    `${head} ${rule.reason} Cells below k = ${k} suppressed, with complementary suppression.${note}`,
    k,
    aggregate(included, groupBy, k),
    excluded,
  )
}

/**
 * `aggregateFor()` followed by appending its audit entry. Basis: ARCHITECTURE §7 (every access is logged).
 */
export async function aggregateAndLog<T>(
  log: AuditLog,
  request: AggregateRequest,
  records: readonly T[],
  groupBy: AggregateGroupBy<T>,
  ctx: AggregateContext<T>,
): Promise<AggregateResult & { entry: AuditEntry }> {
  const result = aggregateFor(request, records, groupBy, ctx)
  const entry = await log.append(result.audit)
  return { ...result, entry }
}

// ─────────────────────────────── Audit log ───────────────────────────────

/** prevHash of the first entry. Basis: ARCHITECTURE §7 (SHA-256 hash chain). [ENG] */
export const GENESIS_HASH = '0'.repeat(64)

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (as in RFC 8785), no whitespace, undefined properties
 * omitted, non-finite numbers rejected. The same entry therefore always hashes the same, whatever its key order.
 * Basis: ARCHITECTURE §7 (hash-chained audit log). [ENG]
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers are not valid JSON')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v: unknown) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
      }
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((key) => obj[key] !== undefined)
        .sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
  }
}

/**
 * SHA-256 of the UTF-8 text, as lowercase hex, via Web Crypto (`globalThis.crypto.subtle`; browsers need a secure
 * context). Basis: ARCHITECTURE §7 ("SHA-256 hash chain (Web Crypto)").
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle
  if (subtle === undefined) {
    throw new Error('Web Crypto is unavailable: the audit log needs crypto.subtle (https or localhost)')
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** A published reference point of the chain (e.g. printed in the report to the site worker committee). */
export interface AuditAnchor {
  seq: number
  hash: string
}

/** Outcome of `AuditLog.verify()`. */
export type AuditVerification =
  | { ok: true; length: number; head: string }
  | { ok: false; brokenAt: number; reason: string }

const AUDIT_EXPORT_FORMAT = 'zill-audit/1'

function freezeEntry(entry: AuditEntry): AuditEntry {
  const fields = Array.isArray(entry.fields) ? (Object.freeze([...entry.fields]) as DataField[]) : entry.fields
  return Object.freeze({ ...entry, fields })
}

function looksLikeAuditEntry(raw: unknown): raw is AuditEntry {
  if (raw === null || typeof raw !== 'object') return false
  const e = raw as Record<string, unknown>
  return (
    typeof e.seq === 'number' &&
    typeof e.t === 'number' &&
    typeof e.actorRole === 'string' &&
    typeof e.actorId === 'string' &&
    typeof e.purpose === 'string' &&
    (e.subjectId === undefined || typeof e.subjectId === 'string') &&
    Array.isArray(e.fields) &&
    e.fields.every((f) => typeof f === 'string') &&
    (e.decision === 'allowed' || e.decision === 'denied') &&
    typeof e.reason === 'string' &&
    typeof e.prevHash === 'string' &&
    typeof e.hash === 'string'
  )
}

/**
 * Append-only audit log with a SHA-256 hash chain: each entry's `hash` covers its canonical JSON (every key except
 * `hash`, including `seq` and `prevHash`), so editing, inserting, deleting or reordering any entry breaks
 * `verify()`. A chain alone cannot reveal a wholesale rewrite or a cut tail; anchoring the head (e.g. in the report to
 * the site worker committee) and passing it to `verify(anchor)` does [ENG]. Appends are serialised, so concurrent
 * calls still chain correctly. `forSubject()` answers the worker's "who saw my data" (refusals included).
 * Basis: ARCHITECTURE §7 (append-only, SHA-256 hash chain via Web Crypto, "who saw my data", verify() detects
 * tampering); context_and_commercial §6.2 item 4 (audit logs plus a report to the site worker committee) [D];
 * UAE AI Charter (2024) principle 7 Governance and Accountability [primary, S71]; ILO code §6.14(1) [primary, S73].
 */
export class AuditLog {
  #entries: AuditEntry[] = []
  #tail: Promise<void> = Promise.resolve()

  /** Number of entries. */
  get length(): number {
    return this.#entries.length
  }

  /** The latest entry's position and hash (seq −1 and GENESIS_HASH when empty) — publish it to anchor the chain. */
  head(): AuditAnchor {
    const last = this.#entries.at(-1)
    return last ? { seq: last.seq, hash: last.hash } : { seq: -1, hash: GENESIS_HASH }
  }

  /** All entries (frozen), oldest first. */
  all(): readonly AuditEntry[] {
    return this.#entries.slice()
  }

  /** Appends an entry: assigns `seq`, links `prevHash` and computes `hash`. The stored entry is frozen. */
  append(draft: AuditDraft): Promise<AuditEntry> {
    const body: AuditDraft = {
      t: draft.t,
      actorRole: draft.actorRole,
      actorId: draft.actorId,
      purpose: draft.purpose,
      fields: [...draft.fields],
      decision: draft.decision,
      reason: draft.reason,
    }
    if (draft.subjectId !== undefined) body.subjectId = draft.subjectId
    const run = async (): Promise<AuditEntry> => {
      const unsigned = { ...body, seq: this.#entries.length, prevHash: this.head().hash }
      const hash = await sha256Hex(canonicalJson(unsigned))
      const entry = freezeEntry({ ...unsigned, hash })
      this.#entries.push(entry)
      return entry
    }
    const appended = this.#tail.then(run)
    this.#tail = appended.then(
      () => undefined,
      () => undefined,
    )
    return appended
  }

  /** Entries about one worker, oldest first — the worker's "who saw my data" view, refusals included. */
  forSubject(subjectId: string): AuditEntry[] {
    return this.#entries.filter((e) => e.subjectId === subjectId)
  }

  /**
   * Recomputes the chain. Returns the first broken position, or ok with the head hash. With an anchor, also detects
   * truncation and wholesale rewriting up to the anchored entry.
   */
  async verify(anchor?: AuditAnchor): Promise<AuditVerification> {
    const entries = this.#entries.slice()
    let prevHash = GENESIS_HASH
    for (let i = 0; i < entries.length; i++) {
      const { hash, ...unsigned } = entries[i]
      if (unsigned.seq !== i) return { ok: false, brokenAt: i, reason: `entry ${i} carries sequence number ${String(unsigned.seq)}` }
      if (unsigned.prevHash !== prevHash) {
        return { ok: false, brokenAt: i, reason: `entry ${i} is not linked to the entry before it` }
      }
      let recomputed: string
      try {
        recomputed = await sha256Hex(canonicalJson(unsigned))
      } catch {
        return { ok: false, brokenAt: i, reason: `entry ${i} cannot be serialised` }
      }
      if (recomputed !== hash) return { ok: false, brokenAt: i, reason: `entry ${i} does not match its hash (edited)` }
      prevHash = hash
    }
    if (anchor !== undefined && anchor.seq >= 0) {
      if (anchor.seq >= entries.length) {
        return { ok: false, brokenAt: entries.length, reason: `log ends before anchored entry ${anchor.seq} (truncated)` }
      }
      if (entries[anchor.seq].hash !== anchor.hash) {
        return { ok: false, brokenAt: anchor.seq, reason: `entry ${anchor.seq} differs from its anchor (history rewritten)` }
      }
    }
    return { ok: true, length: entries.length, head: prevHash }
  }

  /** Serialises the log (format tag, head and entries) as JSON. */
  export(): string {
    return JSON.stringify({ format: AUDIT_EXPORT_FORMAT, head: this.head(), entries: this.#entries })
  }

  /**
   * Loads an exported log (or a bare entry array). Malformed input throws; a structurally valid but tampered chain
   * loads, and `verify()` reports where it breaks.
   */
  static import(json: string): AuditLog {
    const parsed: unknown = JSON.parse(json)
    const list: unknown =
      Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? (parsed as { entries?: unknown }).entries : undefined
    if (!Array.isArray(list)) throw new TypeError('AuditLog.import: not a Zill audit export')
    const log = new AuditLog()
    list.forEach((raw: unknown, i) => {
      if (!looksLikeAuditEntry(raw)) throw new TypeError(`AuditLog.import: malformed entry at position ${i}`)
      log.#entries.push(freezeEntry(raw))
    })
    return log
  }

  /**
   * Governance-centre demo: returns a COPY of the log with one entry patched and NOT re-hashed, so `verify()` on the
   * copy shows where the chain breaks. The original log is never modified.
   */
  demoTamper(index: number, patch: Partial<AuditEntry>): AuditLog {
    if (!Number.isInteger(index) || index < 0 || index >= this.#entries.length) {
      throw new RangeError(`demoTamper: no entry at position ${index}`)
    }
    const copy = new AuditLog()
    copy.#entries = this.#entries.map((e, i) => (i === index ? freezeEntry({ ...e, ...patch }) : e))
    return copy
  }
}

// ─────────────────────────────── Retention ───────────────────────────────

/**
 * Raw physiology (HR samples, ECTemp traces) stays on the device for 24 h. Basis: ARCHITECTURE §7 retention [ENG];
 * ILO code §6.14(1) minimise the intrusion [primary, S73]; UAE PDPL purpose limitation [secondary, S61].
 */
export const RAW_PHYSIOLOGY_RETENTION_MS = 24 * HOUR_MS

/**
 * Pseudonymous level history is kept for 30 days. Basis: ARCHITECTURE §7 retention [ENG]; ILO code §6.14(1)
 * [primary, S73].
 */
export const LEVEL_HISTORY_RETENTION_MS = 30 * DAY_MS

/**
 * Keeps raw physiology samples younger than 24 h; a sample exactly 24 h old is purged ([ENG] boundary resolved toward
 * privacy). Pure: returns a new array. Basis: ARCHITECTURE §7 ("raw HR and ECTemp traces: on device, purged after 24 h").
 */
export function purgeRawPhysiology<T extends { t: number }>(samples: readonly T[], now: number): T[] {
  return samples.filter((s) => now - s.t < RAW_PHYSIOLOGY_RETENTION_MS)
}

/**
 * Keeps level-history entries younger than 30 days (exactly 30 days → purged [ENG]). Pure.
 * Basis: ARCHITECTURE §7 ("level history: pseudonymous, 30 days").
 */
export function purgeLevelHistory<T extends { t: number }>(history: readonly T[], now: number): T[] {
  return history.filter((h) => now - h.t < LEVEL_HISTORY_RETENTION_MS)
}

/**
 * Check-in answers (symptoms, urine colour) and logged drinks are deleted from the device 30 days after they were
 * recorded, the same period as the level history, unless occupational health holds them for an escalated case (see
 * {@link purgeCheckins}). Basis: data minimisation [ENG], following the GOVERNANCE §13 item 5 recommendation; ILO code
 * §6.14(1) minimise the intrusion [primary, S73]; UAE PDPL purpose limitation [secondary, S61].
 */
export const CHECKIN_RETENTION_MS = 30 * DAY_MS

/** Options of {@link purgeCheckins}. Required, so that no caller can forget the escalated-case holds. */
export interface CheckinPurgeOptions {
  /**
   * Pseudonymous ids (`WorkerProfile.id`) whose escalated case occupational health currently holds open. Their
   * check-ins are kept while the hold lasts; remove the id when OH closes the case, and the 30-day rule applies again.
   */
  escalatedSubjects: ReadonlySet<string> | readonly string[]
}

/**
 * Keeps check-ins and logged drinks younger than {@link CHECKIN_RETENTION_MS} (exactly 30 days old → purged [ENG],
 * as for level history), plus every item of a subject whose escalated case occupational health holds open. Works for
 * `Checkin` and `FluidIntake`. Pure: returns a new array in input order. Basis: data minimisation [ENG]; GOVERNANCE
 * §13 item 5 (keep check-ins only while OH needs them for an escalated case); ILO code §8.2 medical data held by
 * personnel bound by medical secrecy [primary, S73].
 */
export function purgeCheckins<T extends { t: number; workerId: string }>(
  items: readonly T[],
  now: number,
  opts: CheckinPurgeOptions,
): T[] {
  const held = new Set<string>(opts.escalatedSubjects)
  return items.filter((c) => held.has(c.workerId) || now - c.t < CHECKIN_RETENTION_MS)
}

/** A retention period that is a policy decision rather than an engineering default. */
export interface RetentionPolicy {
  /** Retention in milliseconds; null = not set in code because the period is "set by legal review". */
  readonly ms: number | null
  /** What any period chosen must at least cover, whoever sets it. */
  readonly mustCover: string
  /** Who sets the period, and where the open decision is tracked. */
  readonly decidedBy: string
  readonly basis: string
}

/**
 * Audit-log retention. `ms` null = set by legal review (GOVERNANCE §13 item 5: privacy owner, DPO, counsel). Whatever is
 * chosen, the log must outlive the data it describes, so that "who saw my data" and disputes can still be checked.
 * Basis: ARCHITECTURE §7 (append-only, hash-chained audit log); GOVERNANCE §2.3 and §13 item 5.
 */
export const AUDIT_LOG_RETENTION: RetentionPolicy = deepFreeze({
  ms: null,
  mustCover: 'Longer than the data it describes, so that "who saw my data" and disputes can still be checked.',
  decidedBy: 'Set by legal review (privacy owner, DPO, counsel): GOVERNANCE §13 item 5',
  basis: `${SRC.archGov} (append-only, hash-chained audit log); GOVERNANCE §2.3; GOVERNANCE §13 item 5`,
})

/**
 * Consent-receipt retention. `ms` null = set by legal review (GOVERNANCE §13 item 5). Whatever is chosen, a receipt is
 * kept as long as the processing it proves, plus a dispute period. Basis: UAE PDPL — the controller "must be able to
 * prove that the data subject gave consent" [secondary, S62]; GOVERNANCE §2.3 and §13 item 5.
 */
export const CONSENT_RECEIPT_RETENTION: RetentionPolicy = deepFreeze({
  ms: null,
  mustCover: 'As long as the processing it proves, plus a dispute period.',
  decidedBy: 'Set by legal review (privacy owner, DPO, counsel): GOVERNANCE §13 item 5',
  basis: `${SRC.pdplConsent}; GOVERNANCE §2.3; GOVERNANCE §13 item 5`,
})

/** Result of `applyRetention()`. */
export interface RetentionResult<P, L> {
  rawPhysiology: P[]
  levelHistory: L[]
  purged: { rawPhysiology: number; levelHistory: number }
}

/**
 * Applies the raw-physiology and level-history retention rules to an on-device store and reports how much was purged
 * (data-flow inspector). Check-ins and logged drinks need the escalated-case holds and go through
 * {@link purgeCheckins}. Aggregates are retained. Basis: ARCHITECTURE §7 retention.
 */
export function applyRetention<P extends { t: number }, L extends { t: number }>(
  store: { rawPhysiology: readonly P[]; levelHistory: readonly L[] },
  now: number,
): RetentionResult<P, L> {
  const rawPhysiology = purgeRawPhysiology(store.rawPhysiology, now)
  const levelHistory = purgeLevelHistory(store.levelHistory, now)
  return {
    rawPhysiology,
    levelHistory,
    purged: {
      rawPhysiology: store.rawPhysiology.length - rawPhysiology.length,
      levelHistory: store.levelHistory.length - levelHistory.length,
    },
  }
}

// ─────────────────────────────── Sync payload ───────────────────────────────

/** Schema version of the sync payload. Basis: ARCHITECTURE §3 (outbound payload). [ENG] */
export const SYNC_PAYLOAD_VERSION = 1

/** The only record that routinely leaves the worker's device. */
export interface SyncPayload {
  v: typeof SYNC_PAYLOAD_VERSION
  /** Pseudonymous id (WorkerProfile.id); the supervisor console maps it to the crew roster. */
  pseudonym: string
  crewId: string
  level: RiskLevel
  actions: ActionId[]
  workMinPerHour: number
  waterMlPerHour: number
  ack: AckStatus
  t: number
  confidence: RiskAssessment['confidence']
}

/** The exact keys of `SyncPayload`, in serialisation order. Basis: ARCHITECTURE §3 outbound payload. */
export const SYNC_PAYLOAD_KEYS: readonly (keyof SyncPayload)[] = deepFreeze([
  'v',
  'pseudonym',
  'crewId',
  'level',
  'actions',
  'workMinPerHour',
  'waterMlPerHour',
  'ack',
  't',
  'confidence',
])

/**
 * Builds the minimal "level + action" payload that leaves the device: no name, no clinical key, no driver text.
 * Confidential follow-up actions are dropped; work minutes are floored to whole minutes (never more work than the
 * engine allowed) and water rounded to 10 mL — data minimisation [ENG]. Throws if the assessment belongs to another
 * worker. Basis: ARCHITECTURE §1 principle 5 and §3 ("outbound: {pseudonym, level, actions, workMinPerHour, ack}");
 * ILO code §6.14(1) minimise the intrusion, §10.8–10.9 [primary, S73]; UAE PDPL sensitive data [secondary, S62].
 */
export function payloadForSync(
  assessment: RiskAssessment,
  profile: WorkerProfile,
  ack: AckStatus = 'none',
): SyncPayload {
  if (assessment.workerId !== profile.id) {
    throw new Error(`payloadForSync: assessment is for ${assessment.workerId}, profile is ${profile.id}`)
  }
  return {
    v: SYNC_PAYLOAD_VERSION,
    pseudonym: profile.id,
    crewId: profile.crewId,
    level: assessment.level,
    actions: assessment.actions.filter((a) => !CONFIDENTIAL_ACTIONS.includes(a)),
    workMinPerHour: Math.min(60, Math.max(0, Math.floor(assessment.workMinPerHour))),
    waterMlPerHour: Math.round(assessment.waterMlPerHour / 10) * 10,
    ack,
    t: assessment.t,
    confidence: assessment.confidence,
  }
}

/** What the data-flow inspector shows. */
export interface SyncInspection {
  payload: SyncPayload
  /** The exact serialised text that is transmitted. */
  json: string
  /** UTF-8 byte size of `json`. */
  bytes: number
  /** Source keys that never leave the device, e.g. "assessment.drivers", "profile.riskFlags". */
  keptOnDevice: string[]
}

const SENT_FROM_ASSESSMENT = new Set(['workerId', 'level', 'actions', 'workMinPerHour', 'waterMlPerHour', 't', 'confidence'])
const SENT_FROM_PROFILE = new Set(['id', 'crewId'])

/**
 * The sync payload, its exact JSON, its UTF-8 byte size, and everything that stays on the device.
 * Basis: ARCHITECTURE §9 (governance centre: data-flow inspector), §1 principle 5.
 */
export function inspectSyncPayload(
  assessment: RiskAssessment,
  profile: WorkerProfile,
  ack: AckStatus = 'none',
): SyncInspection {
  const payload = payloadForSync(assessment, profile, ack)
  const json = JSON.stringify(payload)
  return {
    payload,
    json,
    bytes: new TextEncoder().encode(json).length,
    keptOnDevice: [
      ...Object.keys(assessment)
        .filter((key) => !SENT_FROM_ASSESSMENT.has(key))
        .map((key) => `assessment.${key}`),
      ...Object.keys(profile)
        .filter((key) => !SENT_FROM_PROFILE.has(key))
        .map((key) => `profile.${key}`),
    ],
  }
}
