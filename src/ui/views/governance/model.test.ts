import { describe, expect, it } from 'vitest'
import { ACCESS_MATRIX, DATA_FIELDS, PURPOSE_LABELS, ROLE_LABELS, SUPERVISOR_DRIVER_RULES, type SyncPayload } from '../../../engine/privacy'
import type { Alert, AuditEntry, ConsentState } from '../../../engine/types'
import type { SelectorInput } from '../../../state/selectors'
import {
  CONDITION_SHORT,
  GOVERNANCE_DOC_LINKS,
  NO_SYNC,
  PERMITTED_PURPOSES,
  PROHIBITED_PURPOSE_LIST,
  RETENTION_ROWS,
  ROLE_ORDER,
  cellAriaLabel,
  chainStatus,
  changedPayloadKeys,
  citations,
  clip,
  defaultActorFor,
  fieldLabels,
  filterAudit,
  formatDuration,
  githubSlug,
  groupKeptOnDevice,
  isBriefCase,
  matrixCell,
  nextSync,
  payloadLines,
  processingChanges,
  requestContext,
  requestOutcome,
  summarizeAccess,
  supervisorRuleCounts,
  tamperDiff,
} from './model'

const MIN = 60_000

const payload = (over: Partial<SyncPayload> = {}): SyncPayload => ({
  v: 1,
  pseudonym: 'W-1',
  crewId: 'c1',
  level: 'caution',
  actions: ['shade_breaks'],
  workMinPerHour: 45,
  waterMlPerHour: 0,
  ack: 'none',
  t: 1_000 * MIN,
  confidence: 'high',
  ...over,
})

let seq = 0
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  seq: seq++,
  t: 10 * MIN,
  actorRole: 'supervisor',
  actorId: 'c1:supervisor',
  purpose: 'safety_alerting',
  subjectId: 'W-1',
  fields: ['level', 'actions'],
  decision: 'allowed',
  reason: 'ok',
  prevHash: '0'.repeat(64),
  hash: 'a'.repeat(64),
  ...over,
})

const consent = (over: Partial<ConsentState> = {}): ConsentState => ({
  wearable: true,
  healthFlags: true,
  checkins: true,
  shareWithMedicOnEscalation: false,
  aggregateStatistics: true,
  updatedAt: 0,
  ...over,
})

describe('role × purpose matrix summary', () => {
  it('covers every role and every purpose, permitted before prohibited', () => {
    expect(ROLE_ORDER).toHaveLength(Object.keys(ROLE_LABELS).length)
    expect([...PERMITTED_PURPOSES, ...PROHIBITED_PURPOSE_LIST].sort()).toEqual(Object.keys(PURPOSE_LABELS).sort())
    expect(PROHIBITED_PURPOSE_LIST).toEqual(['performance_management', 'disciplinary_action', 'insurance_underwriting', 'immigration_or_visa'])
  })

  it('marks every prohibited cell refused, whatever the role', () => {
    for (const role of ROLE_ORDER) {
      for (const p of PROHIBITED_PURPOSE_LIST) {
        const cell = matrixCell(role, p)
        expect(cell.kind).toBe('prohibited')
        expect(cell.short).toBe('Refused, logged')
        expect(cellAriaLabel(cell)).toContain('prohibited purpose')
      }
    }
  })

  it('summarises the supervisor safety-alerting cell from the matrix itself', () => {
    const cell = matrixCell('supervisor', 'safety_alerting')
    const fields = new Set(ACCESS_MATRIX.supervisor.safety_alerting.grants.flatMap((g) => g.fields))
    expect(cell.kind).toBe('individual')
    expect(cell.fields).toEqual(DATA_FIELDS.filter((f) => fields.has(f)))
    expect(cell.clinical).toBe(false)
    expect(cell.conditions).toContain('in_actor_crew')
    expect(cell.short).toBe(`${cell.fields.length} fields`)
  })

  it('shows aggregate-only cells with their k', () => {
    const cell = matrixCell('regulator', 'compliance_reporting')
    expect(cell.kind).toBe('aggregate')
    expect(cell.short).toBe(`Aggregates, k ≥ ${String(cell.aggregateMinCell)}`)
    expect(cell.aggregateMinCell).toBe(10)
  })

  it('has a short label for every grant condition', () => {
    for (const role of ROLE_ORDER) for (const p of PERMITTED_PURPOSES) for (const c of matrixCell(role, p).conditions) expect(CONDITION_SHORT[c]).toBeTruthy()
  })

  it('clips and splits basis strings', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcdefgh', 5)).toBe('abcd…')
    expect(citations('A; B;  C')).toEqual(['A', 'B', 'C'])
  })
})

describe('sync payload display and transmission rule', () => {
  it('prints one key per line in canonical order and parses back to the payload', () => {
    const p = payload()
    const text = `{\n${payloadLines(p)
      .map((l) => l.text)
      .join('\n')}\n}`
    expect(JSON.parse(text)).toEqual(p)
  })

  it('sends first, then on change (time excluded), then on the heartbeat', () => {
    const first = nextSync(NO_SYNC, payload())
    expect(first?.reason).toBe('first')
    const tracker = first!.tracker
    expect(nextSync(tracker, payload({ t: tracker.t + MIN }))).toBeNull()
    const change = nextSync(tracker, payload({ t: tracker.t + MIN, level: 'high' }))
    expect(change?.reason).toBe('change')
    expect(change?.changed).toEqual(['level'])
    expect(nextSync(tracker, payload({ t: tracker.t + 5 * MIN }), 5)?.reason).toBe('heartbeat')
  })

  it('starts afresh on another worker or a backward jump', () => {
    const tracker = nextSync(NO_SYNC, payload())!.tracker
    expect(nextSync(tracker, payload({ pseudonym: 'W-2' }))?.reason).toBe('first')
    expect(nextSync(tracker, payload({ t: tracker.t - MIN }))?.reason).toBe('first')
  })

  it('lists changed keys without the time stamp', () => {
    expect(changedPayloadKeys(payload(), payload({ t: 0, ack: 'acknowledged', actions: [] }))).toEqual(['actions', 'ack'])
  })

  it('groups kept-on-device keys and keeps unknown keys truthfully', () => {
    const groups = groupKeptOnDevice(['assessment.drivers', 'profile.massKg', 'profile.consent', 'assessment.somethingNew'])
    expect(groups.map((g) => g.id)).toEqual(['reasons', 'body', 'consent', 'other'])
    expect(groups.at(-1)?.items[0]).toEqual({ key: 'assessment.somethingNew', label: 'assessment.somethingNew' })
  })
})

describe('request demo helpers', () => {
  it('recognises the brief’s case only when role, purpose and fields match', () => {
    expect(isBriefCase({ role: 'employer_hr', purpose: 'performance_management', fields: ['hrBpm'] })).toBe(true)
    expect(isBriefCase({ role: 'employer_hr', purpose: 'performance_management', fields: ['hrBpm', 'level'] })).toBe(false)
    expect(isBriefCase({ role: 'employer_hr', purpose: 'disciplinary_action', fields: ['hrBpm'] })).toBe(false)
    expect(isBriefCase({ role: 'supervisor', purpose: 'performance_management', fields: ['hrBpm'] })).toBe(false)
  })

  it('names the outcome', () => {
    expect(requestOutcome({ decision: 'denied', withheld: [] })).toBe('refused')
    expect(requestOutcome({ decision: 'allowed', withheld: ['hrBpm'] })).toBe('partial')
    expect(requestOutcome({ decision: 'allowed', withheld: [] })).toBe('allowed')
  })

  it('proposes requester ids from the roster', () => {
    expect(defaultActorFor('worker', { subjectId: 'W-1' })).toBe('W-1')
    expect(defaultActorFor('buddy', { subjectId: 'W-1', buddyId: 'W-2' })).toBe('W-2')
    expect(defaultActorFor('supervisor', { subjectId: 'W-1', supervisorId: 'c1:supervisor' })).toBe('c1:supervisor')
    expect(defaultActorFor('employer_hr', { subjectId: 'W-1' })).toBe('HR-1')
  })

  it('builds the projection context the way the console selectors do', () => {
    const alert = { id: 'a1', t: 5 * MIN, workerId: 'W-1', scope: 'worker', level: 'emergency', status: 'active' } as unknown as Alert
    const input = {
      view: { t: 9 * MIN, alerts: [alert] },
      roster: {
        'W-1': { crewId: 'c1', displayName: 'n/a', buddyId: 'W-2', supervisorId: 'c1:supervisor' },
        'W-3': { crewId: 'c2', displayName: 'n/a', supervisorId: 'c2:supervisor' },
      },
    } as unknown as Pick<SelectorInput, 'view' | 'roster'>
    expect(requestContext(input, { role: 'employer_hr', actorId: 'HR-1' }, 'W-1')).toEqual({ now: 9 * MIN, escalated: true })
    expect(requestContext(input, { role: 'buddy', actorId: 'W-2' }, 'W-1').buddyIds).toEqual(['W-2'])
    expect(requestContext(input, { role: 'buddy', actorId: 'W-9' }, 'W-3').buddyIds).toEqual([])
    expect(requestContext(input, { role: 'supervisor', actorId: 'c1:supervisor' }, 'W-3').actorCrewIds).toEqual(['c1'])
    expect(requestContext(input, { role: 'first_aider', actorId: 'FA-1' }, 'W-3').escalated).toBe(false)
  })
})

describe('audit helpers', () => {
  const log = [
    entry({ seq: 0, actorRole: 'supervisor', subjectId: 'W-1', t: 1 * MIN }),
    entry({ seq: 1, actorRole: 'employer_hr', actorId: 'HR-1', purpose: 'performance_management', fields: ['hrBpm'], decision: 'denied', subjectId: 'W-1', t: 2 * MIN }),
    entry({ seq: 2, actorRole: 'regulator', actorId: 'ADPHC-1', purpose: 'compliance_reporting', subjectId: undefined, fields: [], t: 3 * MIN }),
    entry({ seq: 3, actorRole: 'supervisor', subjectId: 'W-2', t: 4 * MIN }),
  ]

  it('filters newest first by decision, role and subject', () => {
    expect(filterAudit(log, { decision: 'all', role: 'all', subjectId: null }).map((e) => e.seq)).toEqual([3, 2, 1, 0])
    expect(filterAudit(log, { decision: 'denied', role: 'all', subjectId: null }).map((e) => e.seq)).toEqual([1])
    expect(filterAudit(log, { decision: 'all', role: 'supervisor', subjectId: 'W-1' }).map((e) => e.seq)).toEqual([0])
  })

  it('summarises who saw a worker’s data, refusals counted', () => {
    const s = summarizeAccess(log.filter((e) => e.subjectId === 'W-1'))
    expect(s.map((x) => x.role)).toEqual(['supervisor', 'employer_hr'])
    expect(s[1]).toMatchObject({ count: 1, refused: 1, actors: ['HR-1'], purposes: ['performance_management'], lastT: 2 * MIN })
  })

  it('labels fields and keeps unknown keys', () => {
    expect(fieldLabels(['hrBpm', 'current_level'])).toEqual(['Heart rate', 'current_level'])
  })

  it('diffs only the tampered keys', () => {
    const a = entry({ seq: 7, actorId: 'c1:supervisor', decision: 'allowed' })
    const b = { ...a, actorId: 'someone-else', decision: 'denied' as const }
    expect(tamperDiff(a, b)).toEqual([
      { key: 'actorId', before: 'c1:supervisor', after: 'someone-else' },
      { key: 'decision', before: 'allowed', after: 'denied' },
    ])
  })

  it('reports the chain status, with entries added since the check', () => {
    expect(chainStatus(null, 3)).toEqual({ kind: 'unchecked' })
    expect(chainStatus({ ok: true, length: 3, head: 'h' }, 5)).toEqual({ kind: 'ok', length: 3, head: 'h', stale: 2 })
    expect(chainStatus({ ok: false, brokenAt: 1, reason: 'edited' }, 5)).toEqual({ kind: 'broken', brokenAt: 1, reason: 'edited' })
  })
})

describe('consent, supervisor boundary, retention and documents', () => {
  it('lists the processing activities a consent change switches', () => {
    expect(processingChanges(consent(), consent({ wearable: false }))).toEqual(['wearable_physiology'])
    expect(processingChanges(consent(), consent())).toEqual([])
  })

  it('counts every supervisor driver rule once', () => {
    const counts = supervisorRuleCounts()
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(Object.keys(SUPERVISOR_DRIVER_RULES).length)
    expect(counts.not_cleared_for_heat_work).toBeGreaterThan(0)
    expect(counts.device_directed_rest).toBeGreaterThan(0)
  })

  it('formats retention periods from the privacy constants', () => {
    expect(formatDuration(24 * 60 * MIN)).toBe('24 hours')
    expect(formatDuration(30 * 24 * 60 * MIN)).toBe('30 days')
    expect(formatDuration(null)).toBe('Set by legal review')
    expect(RETENTION_ROWS.find((r) => r.data.startsWith('Raw heart-rate'))?.period).toBe('24 hours')
    expect(RETENTION_ROWS.find((r) => r.data === 'Audit log')?.period).toBe('Set by legal review')
  })

  it('builds GitHub heading anchors for the governance document', () => {
    expect(githubSlug('## 3. Who may see what: the role × purpose matrix')).toBe('3-who-may-see-what-the-role--purpose-matrix')
    expect(githubSlug("2.4 What leaves the worker's device")).toBe('24-what-leaves-the-workers-device')
    expect(githubSlug('6. Audit log, "who saw my data", and the published chain head')).toBe('6-audit-log-who-saw-my-data-and-the-published-chain-head')
    expect(GOVERNANCE_DOC_LINKS.every((l) => l.href.includes('/docs/GOVERNANCE.md#'))).toBe(true)
  })
})
