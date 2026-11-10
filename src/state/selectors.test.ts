import { beforeAll, describe, expect, it } from 'vitest'
import { MINUTE_MS } from '../engine/time'
import { RISK_ORDER, type Alert, type RiskAssessment, type RiskLevel, type SymptomId, type WorkerProfile } from '../engine/types'
import { CLINICAL_DRIVER_CHANNELS, CLINICAL_FIELDS, CONFIDENTIAL_ACTIONS, CONSENT_SCOPES, type ConsentScope, type PublishedCell } from '../engine/privacy'
import { ACK_ROLES, CLINICAL_TEXT_PATTERN, acknowledge, createAlertEngine, processAssessments, tick } from '../engine/alerts'
import { SYMPTOM_IDS } from '../i18n'
import { createRng, type Rng } from '../sim/rng'
import { createNodeSimDataLoader, type SimDataLoader } from '../sim/simdata'
import { loadScenarioData, type ScenarioId } from '../sim/scenarios'
import type { SimConfigInput } from '../sim/worldsim'
import type { PolicyId, SimData, WorldInjection, WorldView } from '../sim/types'
import { createSimStore, type SimStore } from './simStore'
import { createGovernanceStore, type GovernanceStore } from './governanceStore'
import {
  caseIndex,
  caseStatus,
  deviceSnapshot,
  selectAggregate,
  selectBuddyCards,
  selectFirstAiderCases,
  selectHseAggregates,
  selectLabTrace,
  selectLabWorkers,
  selectOccHealthCases,
  selectRegulatorAggregates,
  selectSupervisorBoard,
  selectWorkerDevice,
  selectorInput,
  supervisedCrewIds,
  supervisorActors,
  type AggregateView,
  type SelectorInput,
} from './selectors'

// Fields each role may ever receive (privacy.ts ACCESS_MATRIX views).
const SUPERVISOR_FIELDS: readonly string[] = ['displayName', 'crewId', 'level', 'actions', 'workMinPerHour', 'ackStatus', 'drivers_nonclinical', 'waterMlPerHour']
const BUDDY_FIELDS: readonly string[] = ['displayName', 'level', 'actions', 'ackStatus']
const FIRST_AID_FIELDS: readonly string[] = ['displayName', 'level', 'actions', 'location', 'symptoms']
const TRUTH_MARK = '__TRUTH_SENTINEL__'
const TRUTH_NUMBERS = ['43.21987', '211.37', '7.77731']
const STAFF = { first_aider: 'FA-1', occ_health: 'OH-1', hse: 'HSE-1', regulator: 'ADPHC-1' }

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out)
  else
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      keysDeep(v, out)
    }
  return out
}

/** Replaces every worker's ground truth with sentinels, so any leak into an operational model is detectable. */
function withTruthSentinel(view: WorldView): WorldView {
  return { ...view, workers: view.workers.map((w) => ({ ...w, truth: { coreC: 43.21987, hrBpm: 211.37, dehydrationPct: 7.77731, symptoms: [TRUTH_MARK] } })) }
}

function expectNoTruth(model: unknown, label: string): void {
  const json = JSON.stringify(model)
  expect(json.includes(TRUTH_MARK), `${label}: ground-truth symptom leaked`).toBe(false)
  for (const n of TRUTH_NUMBERS) expect(json.includes(n), `${label}: ground-truth value ${n} leaked`).toBe(false)
  const keys = keysDeep(model)
  for (const k of ['truth', 'coreC', 'coreTrueC', 'dehydrationPct']) expect(keys.has(k), `${label}: key '${k}'`).toBe(false)
}

/** On-device engine detail (ECTemp band, last HR) belongs to the worker's own phone only. */
function expectNoDeviceDetail(model: unknown, label: string): void {
  const keys = keysDeep(model)
  for (const k of ['detail', 'physioDisplay', 'lastHrBpm', 'assessment']) expect(keys.has(k), `${label}: key '${k}'`).toBe(false)
}

function expectNoClinical(model: unknown, label: string, allowed: readonly string[] = []): void {
  for (const k of keysDeep(model)) {
    if ((CLINICAL_FIELDS as readonly string[]).includes(k) && !allowed.includes(k)) expect.fail(`${label}: clinical field '${k}' exposed`)
  }
}

function expectSuppressed(view: AggregateView, k: number, label: string): void {
  expect(view.decision, label).toBe('allowed')
  expect(view.k, label).toBe(k)
  const t = view.table!
  const cells: PublishedCell[] = [...t.cells.flat(), ...t.rowTotals, ...t.colTotals, t.total]
  for (const c of cells) if (!c.suppressed) expect(c.count === 0 || c.count >= k, `${label}: published small cell ${c.count} < k=${k}`).toBe(true)
}

const base = createNodeSimDataLoader()
const DATA = new Map<ScenarioId, SimData>()
const cached = (id: ScenarioId): SimDataLoader => ({ weather: (s, d) => base.weather(s, d), load: async () => DATA.get(id) as SimData, demoDays: () => base.demoDays() })

beforeAll(async () => {
  for (const id of ['peak-day', 'shade-only'] as const) DATA.set(id, await loadScenarioData(id, base))
}, 60_000)

async function world(id: ScenarioId, overrides: { seed?: string; policy?: PolicyId; behaviour?: SimConfigInput['behaviour'] } = {}): Promise<{ sim: SimStore; gov: GovernanceStore }> {
  const sim = createSimStore({ loader: cached(id), scheduler: { now: () => 0, requestFrame: () => 0, cancelFrame: () => undefined, yieldToUi: () => Promise.resolve() } })
  await sim.getState().loadScenario(id, overrides)
  const gov = createGovernanceStore()
  gov.getState().seedConsent(sim.getState().view!.workers.map((w) => w.profile))
  return { sim, gov }
}

const inputOf = (sim: SimStore, gov: GovernanceStore, sentinel = true): SelectorInput => {
  const input = selectorInput(sim.getState(), gov.getState().consent)!
  return sentinel ? { ...input, view: withTruthSentinel(input.view) } : input
}

/** Random UI actions at one checkpoint (seeded). */
function randomActions(rng: Rng, sim: SimStore, gov: GovernanceStore): void {
  const view = sim.getState().view!
  const t = view.t
  const workers = view.workers.map((w) => w.profile)
  const pick = (): WorkerProfile => rng.pick(workers)
  const out: WorldInjection[] = []
  if (rng.chance(0.5)) {
    const n = rng.int(0, 3)
    const symptoms = rng.shuffle(SYMPTOM_IDS).slice(0, n) as SymptomId[]
    out.push({ kind: 'checkin', checkin: { t, workerId: pick().id, by: rng.pick(['self', 'buddy'] as const), symptoms, ...(rng.chance(0.3) ? { urineColor: rng.int(1, 8) as 1 } : {}) } })
  }
  if (rng.chance(0.3)) out.push({ kind: 'intake', intake: { t, workerId: pick().id, ml: 250 } })
  for (const a of view.alerts) {
    if (a.status === 'resolved') continue
    if (rng.chance(0.3)) out.push({ kind: 'ack', alertId: a.id, role: rng.pick(ACK_ROLES.filter((r) => r !== 'worker')) })
    else if (a.workerId && rng.chance(0.1)) out.push({ kind: 'resolve', workerId: a.workerId, by: 'first_aider' })
  }
  if (rng.chance(0.25)) {
    const w = pick()
    const scope = rng.pick(CONSENT_SCOPES) as ConsentScope
    const on = gov.getState().consent[w.id]?.[scope] ?? false
    const change = { workerId: w.id, scope, t, language: w.language }
    if (on) gov.getState().revoke(change)
    else gov.getState().grant(change)
  }
  sim.getState().inject(out)
}

/** Every invariant at one checkpoint; returns counters so the test can assert it exercised the interesting paths. */
function checkInvariants(input: SelectorInput, label: string, seen: { escalated: number; faSymptoms: number; ohClinical: number; rows: number }): void {
  const consentOf = (id: string) => input.consent![id]
  // Supervisor: scoped to own crews, never clinical, never confidential actions, no clinical wording.
  for (const actor of supervisorActors(input)) {
    const board = selectSupervisorBoard(input, actor.actorId)
    expectNoTruth(board.model, `${label} supervisor`)
    expectNoDeviceDetail(board.model, `${label} supervisor`)
    expectNoClinical(board.model, `${label} supervisor`)
    const own = supervisedCrewIds(input, actor.actorId)
    expect(own).toEqual([actor.crewId])
    for (const crew of board.model.crews) {
      expect(own).toContain(crew.crew.id)
      for (const row of crew.rows) {
        seen.rows += 1
        for (const k of Object.keys(row.data)) expect(SUPERVISOR_FIELDS, `${label} supervisor field ${k}`).toContain(k)
        for (const d of row.data.drivers_nonclinical ?? []) expect(CLINICAL_DRIVER_CHANNELS).not.toContain(d.channel)
        for (const a of row.data.actions ?? []) expect(CONFIDENTIAL_ACTIONS).not.toContain(a)
      }
    }
    for (const a of board.model.alerts) expect(CLINICAL_TEXT_PATTERN.test(a.reason), `${label} alert reason '${a.reason}'`).toBe(false)
    for (const n of board.model.notifications) expect(CLINICAL_TEXT_PATTERN.test(n.text), `${label} notification '${n.text}'`).toBe(false)
    for (const d of board.audit) expect(d).toMatchObject({ actorRole: 'supervisor', actorId: actor.actorId, purpose: 'safety_alerting' })
  }
  expect(selectSupervisorBoard(input, 'nobody:supervisor').model.crews).toEqual([])

  const cases = caseIndex(input.view.alerts)
  for (const wv of input.view.workers) {
    const id = wv.profile.id
    // Buddy: only partners paired with this buddy, buddy fields only.
    const cards = selectBuddyCards(input, id)
    expectNoTruth(cards.model, `${label} buddy`)
    expectNoDeviceDetail(cards.model, `${label} buddy`)
    expectNoClinical(cards.model, `${label} buddy`)
    for (const card of cards.model) {
      expect(input.roster[card.workerId]?.buddyId).toBe(id)
      for (const k of Object.keys(card.data)) expect(BUDDY_FIELDS, `${label} buddy field ${k}`).toContain(k)
    }
    // Worker device: own full record, ground truth never included.
    const dev = selectWorkerDevice(input, id)
    expectNoTruth(dev.model, `${label} worker device`)
    if (dev.model?.snapshot) expect(dev.model.snapshot.workerId).toBe(id)
    if (!consentOf(id).wearable) expect(dev.model?.snapshot?.hrBpm ?? null).toBeNull()
    if (dev.model?.outbound) expectNoClinical(dev.model.outbound, `${label} outbound`)
  }

  // First aider: active cases; symptoms only for an escalated case at stop or above.
  const fa = selectFirstAiderCases(input, STAFF.first_aider)
  expectNoTruth(fa.model, `${label} first aider`)
  expectNoDeviceDetail(fa.model, `${label} first aider`)
  expectNoClinical(fa.model, `${label} first aider`, ['symptoms'])
  for (const c of fa.model.cases) {
    for (const k of Object.keys(c.data)) expect(FIRST_AID_FIELDS, `${label} first-aid field ${k}`).toContain(k)
    if ('symptoms' in c.data) {
      seen.faSymptoms += 1
      expect(cases.get(c.workerId)?.escalated).toBe(true)
      expect(RISK_ORDER[c.data.level as RiskLevel]).toBeGreaterThanOrEqual(RISK_ORDER.stop)
    }
  }

  // Occupational health: escalated cases only; clinical detail only with the sharing consent (and its own scope).
  const oh = selectOccHealthCases(input, STAFF.occ_health)
  expectNoTruth(oh.model, `${label} occupational health`)
  expectNoDeviceDetail(oh.model, `${label} occupational health`)
  for (const c of oh.model.cases) {
    seen.escalated += 1
    expect(cases.get(c.workerId)?.escalated).toBe(true)
    const consent = consentOf(c.workerId)
    if (c.clinicalReleased) seen.ohClinical += 1
    if (!consent.shareWithMedicOnEscalation) expect(c.clinicalReleased).toBe(false)
    if (!consent.wearable) for (const f of ['hrBpm', 'ctEstC', 'psi']) expect(f in c.data).toBe(false)
    if (!consent.healthFlags) expect('riskFlags' in c.data).toBe(false)
  }
  for (const d of oh.audit) expect(d).toMatchObject({ actorRole: 'occ_health', purpose: 'clinical_care' })

  // HSE (k = 5) and regulator (k = 10): k-suppressed, no individual record.
  const hse = selectHseAggregates(input, STAFF.hse)
  expectNoTruth(hse.model, `${label} HSE`)
  expectNoDeviceDetail(hse.model, `${label} HSE`)
  expectSuppressed(hse.model.current, 5, `${label} HSE current`)
  expectSuppressed(hse.model.today, 5, `${label} HSE today`)
  const reg = selectRegulatorAggregates(input, STAFF.regulator)
  expectNoTruth(reg.model, `${label} regulator`)
  expectNoDeviceDetail(reg.model, `${label} regulator`)
  expectSuppressed(reg.model.compliance, 10, `${label} regulator compliance`)
  expectSuppressed(reg.model.publicHealth, 10, `${label} regulator public health`)
  const withAssessment = input.view.workers.filter((w) => w.assessment)
  expect(reg.model.publicHealth.excludedForConsent).toBe(withAssessment.filter((w) => !consentOf(w.profile.id).aggregateStatistics).length)
  for (const m of [hse.model, reg.model]) expect(keysDeep(m).has('workerId')).toBe(false)
}

describe('selectors — property test over simulated worlds', () => {
  const RUNS: Array<{ id: ScenarioId; seed: string; policy?: PolicyId }> = [
    { id: 'peak-day', seed: 'prop-a' },
    { id: 'peak-day', seed: 'prop-b', policy: 'zill_env' },
    { id: 'shade-only', seed: 'prop-c' },
  ]
  for (const run of RUNS) {
    it(`${run.id} / ${run.seed}${run.policy ? ` / ${run.policy}` : ''}: no clinical field to supervisor, buddy or first aider; truth never operational; aggregates k-suppressed`, async () => {
      const { sim, gov } = await world(run.id, { seed: run.seed, ...(run.policy ? { policy: run.policy } : {}) })
      const rng = createRng(`state-selectors|${run.id}|${run.seed}`)
      const seen = { escalated: 0, faSymptoms: 0, ohClinical: 0, rows: 0 }
      let checkpoints = 0
      while (!sim.getState().view!.finished) {
        randomActions(rng, sim, gov)
        checkInvariants(inputOf(sim, gov), `${run.id}@${new Date(sim.getState().view!.t).toISOString()}`, seen)
        checkpoints += 1
        sim.getState().step(20)
      }
      expect(checkpoints).toBeGreaterThan(30)
      expect(seen.rows).toBeGreaterThan(100)
      expect(seen.escalated).toBeGreaterThan(0) // the random red flags produced escalated cases
      expect(seen.faSymptoms).toBeGreaterThan(0) // escalated first-aid cases released symptoms
      expect(seen.ohClinical).toBeGreaterThan(0) // consented OH cases released clinical detail
    })
  }

  it('the instrumentation works: the Lab selector does carry ground truth', async () => {
    const { sim, gov } = await world('peak-day')
    sim.getState().step(60)
    const rows = selectLabWorkers(inputOf(sim, gov).view)
    expect(JSON.stringify(rows)).toContain(TRUTH_MARK)
    expect(selectLabTrace(sim.getState().world, rows[0].workerId).length).toBeGreaterThan(0)
    expect(selectLabTrace(null, rows[0].workerId)).toEqual([])
  })
})

describe('selectors — escalated case end to end', () => {
  const RAMESH = 'W-D2F6' // all consents on
  const JOMAR = 'W-D2E5' // declines every optional consent

  it('a buddy-reported red flag: first aider gets symptoms (vital interest), OH clinical detail only with consent, supervisor nothing clinical', async () => {
    const { sim, gov } = await world('peak-day')
    await sim.getState().jumpTo('10:00')
    const t = sim.getState().view!.t
    sim.getState().inject([
      { kind: 'checkin', checkin: { t, workerId: RAMESH, by: 'buddy', symptoms: ['confusion'] } },
      { kind: 'checkin', checkin: { t, workerId: JOMAR, by: 'buddy', symptoms: ['confusion'] } },
    ])
    sim.getState().step(2)
    const input = inputOf(sim, gov)
    for (const id of [RAMESH, JOMAR]) expect(input.view.workers.find((w) => w.profile.id === id)?.assessment?.level).toBe('emergency')

    const fa = selectFirstAiderCases(input, STAFF.first_aider).model
    for (const id of [RAMESH, JOMAR]) {
      const c = fa.cases.find((x) => x.workerId === id)!
      expect(c.escalated).toBe(true)
      expect(c.data.symptoms).toContain('confusion')
      expect(c.data.location?.label).toMatch(/Musaffah/)
      expect('hrBpm' in c.data).toBe(false)
    }

    const oh = selectOccHealthCases(input, STAFF.occ_health).model
    const ramesh = oh.cases.find((x) => x.workerId === RAMESH)!
    const jomar = oh.cases.find((x) => x.workerId === JOMAR)!
    expect(ramesh.clinicalReleased).toBe(true)
    expect(ramesh.data.symptoms).toContain('confusion')
    expect(jomar.clinicalReleased).toBe(false)
    expect(jomar.withheld).toContain('symptoms')

    const board = selectSupervisorBoard(input, 'musaffah-demo:supervisor').model
    expectNoClinical(board, 'supervisor')
    expect(JSON.stringify(board)).not.toMatch(/confusion/)
    const row = board.crews[0].rows.find((r) => r.workerId === RAMESH)!
    expect(row.data.level).toBe('emergency')
    expect(row.data.actions).toContain('call_998')

    // Revoking the sharing consent in the ledger withholds the clinical detail on the very next call.
    gov.getState().revoke({ workerId: RAMESH, scope: 'shareWithMedicOnEscalation', t, language: 'hi' })
    const after = selectOccHealthCases(inputOf(sim, gov), STAFF.occ_health).model.cases.find((x) => x.workerId === RAMESH)!
    expect(after.clinicalReleased).toBe(false)
    expect(Object.keys(after.data).some((k) => (CLINICAL_FIELDS as readonly string[]).includes(k))).toBe(false)
  })

  it('an escalated stop stays escalated after a late acknowledgement (durable routing marker)', async () => {
    // Slow responders (median acknowledgement delays 8-10 min, log-normal spread) so that nobody acknowledges within the
    // 2-min stop timeout, then step until the late acknowledgement arrives. Before worldsim 1.2.0 the default delays
    // (worker median 1 min) happened to draw a late acknowledgement on this scenario; the shared acknowledgement stream
    // draws differently now, so the test sets the delays instead of relying on one draw (intent unchanged).
    const { sim, gov } = await world('peak-day', { behaviour: { ackDelayMin: { worker: 10, buddy: 8, supervisor: 8, first_aider: 8, occ_health: 10 } } })
    await sim.getState().jumpTo('10:00')
    const t = sim.getState().view!.t
    sim.getState().inject({ kind: 'checkin', checkin: { t, workerId: RAMESH, by: 'self', symptoms: ['headache', 'dizziness'] } })
    const statuses: string[] = []
    for (let i = 0; i < 40 && statuses[statuses.length - 1] !== 'acknowledged'; i++) {
      sim.getState().step(1)
      const cs = caseStatus(sim.getState().view!.alerts, RAMESH)
      if (cs.alert) statuses.push(cs.alert.status)
      if (cs.alert?.status === 'escalated') expect(cs.escalated).toBe(true)
    }
    expect(statuses.indexOf('escalated')).toBeGreaterThanOrEqual(0)
    expect(statuses.indexOf('escalated')).toBeLessThan(statuses.indexOf('acknowledged'))
    // Left unacknowledged past the 2-min stop timeout, then acknowledged late by the (simulated) worker.
    expect(statuses).toContain('escalated')
    const cs = caseStatus(sim.getState().view!.alerts, RAMESH)
    expect(cs.alert).toMatchObject({ level: 'stop', status: 'acknowledged' })
    expect(cs.escalated).toBe(true)
    const fa = selectFirstAiderCases(inputOf(sim, gov), STAFF.first_aider).model.cases.find((c) => c.workerId === RAMESH)!
    expect(fa.data.symptoms).toEqual(expect.arrayContaining(['headache', 'dizziness']))
  })

  it('the worker gets their own full snapshot; the outbound payload is level + action only', async () => {
    const { sim, gov } = await world('peak-day')
    await sim.getState().jumpTo('11:00')
    const input = inputOf(sim, gov)
    const dev = selectWorkerDevice(input, RAMESH).model!
    expect(dev.snapshot).toEqual(deviceSnapshot(input, RAMESH))
    expect(dev.snapshot?.consent.wearable).toBe(true)
    expect(dev.detail).not.toBeNull()
    expect(Object.keys(dev.outbound!).sort()).toEqual(['ack', 'actions', 'confidence', 'crewId', 'level', 'pseudonym', 't', 'v', 'waterMlPerHour', 'workMinPerHour'])
    expect(selectWorkerDevice(input, 'W-NOPE').model).toBeNull()
  })

  it('regulator aggregates: small groups suppressed (k = 10), a smaller k is never applied, HR gets no aggregate by level', async () => {
    const { sim, gov } = await world('peak-day')
    await sim.getState().jumpTo('13:00')
    const input = inputOf(sim, gov)
    const asked = selectAggregate(input, { role: 'regulator', actorId: STAFF.regulator, purpose: 'compliance_reporting', dimension: 'current_level', rowsBy: 'crew', k: 2 }).model
    expectSuppressed(asked, 10, 'regulator k=2 request')
    expect(asked.table!.suppressedCells).toBeGreaterThan(0)
    const hr = selectAggregate(input, { role: 'employer_hr', actorId: 'HR-1', purpose: 'performance_management', dimension: 'current_level', rowsBy: 'site' })
    expect(hr.model.decision).toBe('denied')
    expect(hr.model.table).toBeNull()
    expect(hr.audit[0]).toMatchObject({ decision: 'denied', purpose: 'performance_management' })
  })

  it('engine-off policies yield no-data rows, never a crash or a fabricated level', async () => {
    const { sim, gov } = await world('peak-day', { policy: 'ban_only' })
    sim.getState().step(120)
    const input = inputOf(sim, gov)
    const board = selectSupervisorBoard(input, 'musaffah-demo:supervisor').model
    expect(board.crews[0].rows.every((r) => r.decision === 'no_data' && Object.keys(r.data).length === 0)).toBe(true)
    expect(selectHseAggregates(input, STAFF.hse).model.current.table?.total).toEqual({ suppressed: false, count: 0 })
  })
})

describe('selectors — cadence sanity', () => {
  it('case symptoms come from the recent window only', async () => {
    const { sim, gov } = await world('peak-day')
    await sim.getState().jumpTo('06:00')
    sim.getState().inject({ kind: 'checkin', checkin: { t: sim.getState().view!.t, workerId: 'W-D2F6', by: 'self', symptoms: ['heat_rash'] } })
    sim.getState().step(1)
    expect(deviceSnapshot(inputOf(sim, gov), 'W-D2F6')?.symptoms).toEqual(['heat_rash'])
    sim.getState().step(3 * 60)
    expect(deviceSnapshot(inputOf(sim, gov), 'W-D2F6')?.symptoms).toEqual([])
    expect(sim.getState().view!.t).toBeGreaterThan(sim.getState().world!.t0 + 3 * 60 * MINUTE_MS)
  })
})

describe('selectors — caseIndex escalation record (escalatedAt / acks)', () => {
  const T0 = Date.UTC(2025, 7, 1, 6, 0)
  const at = (m: number): number => T0 + m * MINUTE_MS
  const ROSTER = { W1: { crewId: 'C1', siteId: 'site', displayName: 'Worker 1', buddyId: 'W2', supervisorId: 'S1' } }
  const envStop = (t: number): RiskAssessment => ({
    workerId: 'W1',
    t,
    level: 'stop',
    channels: [{ channel: 'environment', level: 'stop', available: true, drivers: [] }],
    drivers: [],
    actions: ['stop_work', 'rest_shade_now'],
    workMinPerHour: 0,
    minutesToLimit: null,
    waterMlPerHour: 750,
    confidence: 'high',
    dataQuality: { env: 'forecast', physiology: 'absent', network: 'online', stale: false },
  })

  it('a first-aider hand-over after a supervisor acknowledgement escalates the case (engine alerts)', () => {
    const raised = processAssessments(createAlertEngine(), [envStop(at(0))], { now: at(0), roster: ROSTER })
    const id = raised.raised[0].id
    expect(raised.raised[0]).toMatchObject({ basis: 'exposure', acks: [] })
    expect(caseIndex(raised.raised).get('W1')?.escalated).toBe(false) // an exposure stop is not routed to the first aider
    const bySupervisor = acknowledge(raised.state, id, 'supervisor', at(1))
    expect(caseStatus([bySupervisor.alert!], 'W1')).toMatchObject({ ackStatus: 'acknowledged', escalated: false })
    // The first aider takes over: `ack` keeps the supervisor, `acks` shows the hand-over.
    const byFirstAider = acknowledge(bySupervisor.state, id, 'first_aider', at(2))
    expect(byFirstAider.alert).toMatchObject({ ack: { role: 'supervisor', t: at(1) }, acks: [{ role: 'supervisor', t: at(1) }, { role: 'first_aider', t: at(2) }] })
    expect(caseStatus([raised.raised[0], bySupervisor.alert!, byFirstAider.alert!], 'W1')).toMatchObject({ ackStatus: 'acknowledged', escalated: true })
  })

  it('escalatedAt is durable: a stop escalated by its timer stays escalated after a late acknowledgement', () => {
    const r = processAssessments(createAlertEngine(), [envStop(at(0))], { now: at(0), roster: ROSTER })
    const t = tick(r.state, at(2))
    const late = acknowledge(t.state, r.raised[0].id, 'worker', at(3)).alert!
    expect(late).toMatchObject({ status: 'acknowledged', escalatedAt: at(2) })
    expect(caseStatus([late], 'W1').escalated).toBe(true)
  })

  it('alerts without the new fields fall back to the routing inference', () => {
    const legacy = (o: Partial<Alert>): Alert => ({ id: 'A', t: at(0), siteId: 'site', workerId: 'W1', scope: 'worker', level: 'stop', actions: [], reason: 'r', status: 'acknowledged', ...o })
    expect(caseStatus([legacy({ ack: { role: 'supervisor', t: at(1) } })], 'W1').escalated).toBe(false)
    expect(caseStatus([legacy({ ack: { role: 'first_aider', t: at(1) } })], 'W1').escalated).toBe(true)
    expect(caseStatus([legacy({ escalatedTo: ['supervisor', 'buddy'] })], 'W1').escalated).toBe(true)
    expect(caseStatus([legacy({ level: 'high', escalatedTo: ['supervisor', 'buddy'] })], 'W1').escalated).toBe(false)
    expect(caseStatus([legacy({ escalatedTo: ['occ_health'] })], 'W1').escalated).toBe(true)
    // With the new fields, routing conventions alone no longer decide; escalatedAt or a first-aider ack does.
    expect(caseStatus([legacy({ acks: [], escalatedTo: ['supervisor', 'buddy'] })], 'W1').escalated).toBe(false)
    expect(caseStatus([legacy({ acks: [{ role: 'supervisor', t: at(1) }, { role: 'first_aider', t: at(2) }], ack: { role: 'supervisor', t: at(1) } })], 'W1').escalated).toBe(true)
    expect(caseStatus([legacy({ acks: [], escalatedAt: at(1) })], 'W1').escalated).toBe(true)
    expect(caseStatus([legacy({ acks: [], level: 'emergency' })], 'W1').escalated).toBe(true)
  })
})
