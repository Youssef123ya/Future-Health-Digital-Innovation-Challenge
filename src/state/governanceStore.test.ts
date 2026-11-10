import { beforeAll, describe, expect, it } from 'vitest'
import { buildDemoCrew } from '../data/workforce'
import { SYNC_PAYLOAD_KEYS, createWorkerSnapshot, type AuditDraft } from '../engine/privacy'
import type { RiskAssessment } from '../engine/types'
import { MINUTE_MS, epochFromLocal } from '../engine/time'
import { createNodeSimDataLoader } from '../sim/simdata'
import { loadScenarioData } from '../sim/scenarios'
import {
  AUDIT_RELOG_MS,
  PROHIBITED_DEMO_ACTOR,
  auditKey,
  buildDataFlowFeed,
  connectGovernanceToSim,
  createGovernanceStore,
  entriesForSubject,
  governanceStore,
  sameConsentScopes,
} from './governanceStore'
import { createSimStore, type SimStore } from './simStore'
import { selectorInput } from './selectors'
import { findForbiddenKeys, messageForInjection } from './syncBus'
import type { SimData } from '../sim/types'

const demo = buildDemoCrew()
const ramesh = demo.workers.find((w) => w.id === 'W-D2F6')!
const T = epochFromLocal('2025-08-01T10:00')

function assessment(workerId: string, t = T): RiskAssessment {
  return {
    workerId,
    t,
    level: 'high',
    channels: [],
    drivers: [
      { id: 'ct_est_high', channel: 'physiology', text: 'Estimated strain indicator high', direction: 'raises', basis: 'Buller 2013' },
      { id: 'wbgt_over_rel', channel: 'environment', text: 'WBGT above the REL', direction: 'raises', basis: 'NIOSH 2016 REL' },
    ],
    actions: ['rest_shade_now', 'occ_health_review'],
    workMinPerHour: 30.7,
    minutesToLimit: 22,
    waterMlPerHour: 744,
    confidence: 'high',
    dataQuality: { env: 'forecast', physiology: 'good', network: 'online', stale: false },
  }
}
const snapshot = () => createWorkerSnapshot(ramesh, assessment(ramesh.id), { hrBpm: 152, ctEstC: 38.4, symptoms: ['headache'] })
const draft = (over: Partial<AuditDraft> = {}): AuditDraft => ({
  t: T,
  actorRole: 'supervisor',
  actorId: 'musaffah-demo:supervisor',
  purpose: 'safety_alerting',
  subjectId: ramesh.id,
  fields: ['level', 'actions'],
  decision: 'allowed',
  reason: 'crew board',
  ...over,
})

describe('governanceStore — prohibited request demo', () => {
  it('employer HR asking for heart rate for a performance review is denied, releases nothing, and is logged', async () => {
    const gov = createGovernanceStore()
    const { request, result } = await gov.getState().runProhibitedRequestDemo(snapshot(), T)
    expect(request).toEqual({ role: 'employer_hr', actorId: PROHIBITED_DEMO_ACTOR, purpose: 'performance_management', fields: ['hrBpm'] })
    expect(result.decision).toBe('denied')
    expect(result.data).toEqual({})
    expect(result.fields).toEqual([])
    expect(result.reason).toMatch(/refused/i)
    expect(result.entry).toMatchObject({ seq: 0, actorRole: 'employer_hr', purpose: 'performance_management', decision: 'denied', fields: ['hrBpm'], subjectId: ramesh.id })
    const s = gov.getState()
    expect(s.entries).toHaveLength(1)
    expect(s.prohibitedDemo?.result.decision).toBe('denied')
    expect(s.whoSawMyData(ramesh.id).map((e) => e.decision)).toEqual(['denied'])
    expect(entriesForSubject(s.entries, ramesh.id)).toHaveLength(1)
    expect((await s.verify()).ok).toBe(true)
    // Demo requests always log (no de-duplication): every refusal is on the record.
    await gov.getState().runProhibitedRequestDemo(snapshot(), T)
    expect(gov.getState().entries).toHaveLength(2)
  })
})

describe('governanceStore — audit chain', () => {
  it('de-duplicates unchanged accesses, re-logs on change, after the interval, and after a rewind', async () => {
    const gov = createGovernanceStore()
    const g = () => gov.getState()
    expect(await g().record(draft())).not.toBeNull()
    expect(await g().record(draft({ t: T + MINUTE_MS }))).toBeNull()
    expect(await g().record(draft({ t: T + 2 * MINUTE_MS, decision: 'denied', fields: [] }))).not.toBeNull()
    expect(await g().record(draft({ t: T + 3 * MINUTE_MS }))).not.toBeNull() // back to allowed: a change
    expect(await g().record(draft({ t: T + 3 * MINUTE_MS + AUDIT_RELOG_MS }))).not.toBeNull()
    expect(await g().record(draft({ t: T }))).not.toBeNull() // simulated time went backwards (jump)
    expect(await g().record(draft({ actorId: 'other-crew:supervisor' }))).not.toBeNull() // another actor
    await g().flush()
    expect(g().entries).toHaveLength(6)
    expect(g().head.seq).toBe(5)
    expect(auditKey(draft())).not.toBe(auditKey(draft({ subjectId: undefined })))
  })

  it('the tamper demo breaks the chain of a copy at the edited entry and leaves the real log valid', async () => {
    const gov = createGovernanceStore()
    await expect(gov.getState().runTamperDemo()).rejects.toThrow(RangeError)
    await gov.getState().recordAll([draft(), draft({ actorId: 'b' }), draft({ actorId: 'c' })])
    const demoResult = await gov.getState().runTamperDemo({ index: 1 })
    expect(demoResult.tampered).toMatchObject({ ok: false, brokenAt: 1 })
    expect(demoResult.original).toMatchObject({ ok: true, length: 3 })
    expect(demoResult.tamperedEntry.actorId).toBe('someone-else')
    expect(demoResult.originalEntry.actorId).toBe('b')
    expect(gov.getState().entries[1].actorId).toBe('b')
    expect(gov.getState().tamperDemo?.index).toBe(1)
  })

  it('verify() with a published anchor; reset() starts a fresh chain', async () => {
    const gov = createGovernanceStore()
    await gov.getState().recordAll([draft(), draft({ actorId: 'b' })])
    const anchor = gov.getState().publishAnchor()
    expect(anchor.seq).toBe(1)
    expect(await gov.getState().verify()).toMatchObject({ ok: true, length: 2, head: anchor.hash })
    gov.getState().reset()
    expect(gov.getState().entries).toEqual([])
    expect(gov.getState().anchor).toBeNull()
    expect(governanceStore.getState().entries).toEqual([]) // the app singleton is untouched by other stores
  })
})

describe('governanceStore — consent ledger', () => {
  it('grant/revoke update the ledger and issue receipts; invalid collectors and unknown workers are refused', () => {
    const gov = createGovernanceStore()
    gov.getState().seedConsent(demo.workers)
    expect(gov.getState().consent[ramesh.id].shareWithMedicOnEscalation).toBe(true)
    const receipt = gov.getState().revoke({ workerId: ramesh.id, scope: 'shareWithMedicOnEscalation', t: T, language: 'hi' })
    expect(receipt).toMatchObject({ subjectId: ramesh.id, scope: 'shareWithMedicOnEscalation', action: 'revoked', t: T, language: 'hi', method: 'electronic_affirmative_action', collectedBy: 'self' })
    expect(receipt.statement.length).toBeGreaterThan(20)
    expect(gov.getState().consent[ramesh.id]).toMatchObject({ shareWithMedicOnEscalation: false, updatedAt: T })
    gov.getState().grant({ workerId: ramesh.id, scope: 'shareWithMedicOnEscalation', t: T + 1, language: 'hi' })
    expect(gov.getState().consent[ramesh.id].shareWithMedicOnEscalation).toBe(true)
    expect(gov.getState().receipts.map((r) => r.action)).toEqual(['revoked', 'granted'])
    // A supervisor may never collect consent (DoH SBR 2026); a witnessed mark needs its witness.
    expect(() => gov.getState().grant({ workerId: ramesh.id, scope: 'wearable', t: T, language: 'hi', collectedBy: 'supervisor' as never })).toThrow(/superior/)
    expect(() => gov.getState().grant({ workerId: ramesh.id, scope: 'wearable', t: T, language: 'hi', method: 'witnessed_mark' })).toThrow(/witness/)
    expect(gov.getState().receipts).toHaveLength(2)
    expect(() => gov.getState().revoke({ workerId: 'W-NOPE', scope: 'wearable', t: T, language: 'en' })).toThrow(RangeError)
    expect(gov.getState().revoke({ workerId: 'W-NOPE', scope: 'wearable', t: T, language: 'en', base: ramesh.consent }).action).toBe('revoked')
    // Seeding keeps ledger choices unless asked to overwrite.
    gov.getState().revoke({ workerId: ramesh.id, scope: 'wearable', t: T + 2, language: 'hi' })
    gov.getState().seedConsent(demo.workers)
    expect(gov.getState().consent[ramesh.id].wearable).toBe(false)
    gov.getState().seedConsent(demo.workers, { overwrite: true })
    expect(gov.getState().consent[ramesh.id].wearable).toBe(true)
  })
})

describe('governanceStore — simulation wiring and data-flow inspector', () => {
  it('seeds the ledger from each world, keeps revocations across rebuilds, and inspects every outbound payload', async () => {
    const base = createNodeSimDataLoader()
    const data = await loadScenarioData('peak-day', base)
    const sim = createSimStore({ loader: { weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() } })
    const gov = createGovernanceStore()
    const off = connectGovernanceToSim(sim, gov)
    await sim.getState().loadScenario('peak-day')
    expect(Object.keys(gov.getState().consent).sort()).toEqual(sim.getState().view!.workers.map((w) => w.profile.id).sort())
    gov.getState().revoke({ workerId: ramesh.id, scope: 'checkins', t: T, language: 'hi' })
    sim.getState().reset()
    expect(gov.getState().consent[ramesh.id].checkins).toBe(false)
    off()

    await sim.getState().jumpTo('09:00')
    const feed = buildDataFlowFeed(selectorInput(sim.getState(), gov.getState().consent)!)
    expect(feed.length).toBe(sim.getState().view!.workers.length)
    for (const item of feed) {
      const parsed = JSON.parse(item.inspection.json) as Record<string, unknown>
      expect(Object.keys(parsed)).toEqual([...SYNC_PAYLOAD_KEYS])
      expect(findForbiddenKeys(parsed)).toEqual([])
      expect(item.inspection.bytes).toBe(new TextEncoder().encode(item.inspection.json).length)
      expect(item.inspection.keptOnDevice).toEqual(expect.arrayContaining(['assessment.drivers', 'assessment.minutesToLimit', 'profile.riskFlags', 'profile.consent', 'profile.displayName']))
      const profile = sim.getState().view!.workers.find((w) => w.profile.id === item.workerId)!.profile
      expect(item.inspection.json.includes(profile.displayName)).toBe(false)
    }
  })
})

describe('governanceStore — consent changes reach the device world', () => {
  const base = createNodeSimDataLoader()
  let data: SimData
  beforeAll(async () => {
    data = await loadScenarioData('peak-day', base)
  }, 60_000)
  const make = (): SimStore => createSimStore({ loader: { weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() } })
  const device = (sim: SimStore, id: string) => {
    const ws = sim.getState().world?.workerById.get(id)
    if (!ws) throw new Error(`no worker ${id}`)
    return ws
  }

  it('grant/revoke inject the new consent into the device world from that minute; nothing leaves the tab', async () => {
    const sim = make()
    const gov = createGovernanceStore()
    const off = connectGovernanceToSim(sim, gov)
    await sim.getState().loadScenario('peak-day')
    expect(sim.getState().applied).toEqual([]) // ledger = roster: nothing to tell the device
    await sim.getState().jumpTo('08:00')
    const t = sim.getState().world!.t
    gov.getState().revoke({ workerId: ramesh.id, scope: 'wearable', t, language: 'hi' })
    const last = sim.getState().applied.at(-1)!
    expect(last).toMatchObject({ t, ok: true, origin: 'local', injection: { kind: 'consent', workerId: ramesh.id, consent: { wearable: false, checkins: true } } })
    expect(device(sim, ramesh.id).physioActive).toBe(false)
    expect(messageForInjection(last, sim.getState(), 'actor')).toBeNull() // device side only: never on the bus
    sim.getState().step(15)
    const wv = sim.getState().view!.workers.find((w) => w.profile.id === ramesh.id)!
    expect(wv.lastHrBpm).toBeNull()
    expect(wv.assessment?.dataQuality.physiology).toBe('absent')
    // A ledger change that leaves every scope as it was is not sent again; a grant is.
    const n = sim.getState().applied.length
    gov.getState().revoke({ workerId: ramesh.id, scope: 'wearable', t: sim.getState().world!.t, language: 'hi' })
    expect(sim.getState().applied.length).toBe(n)
    gov.getState().grant({ workerId: ramesh.id, scope: 'wearable', t: sim.getState().world!.t, language: 'hi' })
    expect(sim.getState().applied.length).toBe(n + 1)
    expect(device(sim, ramesh.id).physioActive).toBe(true)
    expect(sameConsentScopes(device(sim, ramesh.id).profile.consent, gov.getState().consent[ramesh.id])).toBe(true)
    off()
  })

  it('the device keeps following the ledger after a backward jump and a rebuild (revocation applied from the new start)', async () => {
    const sim = make()
    const gov = createGovernanceStore()
    const off = connectGovernanceToSim(sim, gov)
    await sim.getState().loadScenario('peak-day')
    await sim.getState().jumpTo('09:00')
    gov.getState().revoke({ workerId: ramesh.id, scope: 'checkins', t: sim.getState().world!.t, language: 'hi' })
    expect(device(sim, ramesh.id).checkinsConsented).toBe(false)
    await sim.getState().jumpTo('07:00') // rebuild + replay: the 09:00 change is after the target, the ledger still says revoked
    expect(sim.getState().world!.t).toBe(epochFromLocal('2025-08-01T07:00'))
    expect(device(sim, ramesh.id).checkinsConsented).toBe(false)
    sim.getState().reset()
    const w = sim.getState().world!
    expect(w.minuteIndex).toBe(0)
    expect(device(sim, ramesh.id).checkinsConsented).toBe(false)
    expect(sim.getState().applied).toMatchObject([{ t: w.t0, ok: true, injection: { kind: 'consent', workerId: ramesh.id, consent: { checkins: false } } }])
    off()
  })

  it('with a device worker set, only that worker has consent changes injected into this tab', async () => {
    const sim = make()
    const gov = createGovernanceStore()
    let phone: string | null = 'W-D2B2'
    const off = connectGovernanceToSim(sim, gov, { deviceWorkerId: () => phone })
    await sim.getState().loadScenario('peak-day')
    const t0 = sim.getState().world!.t
    gov.getState().revoke({ workerId: ramesh.id, scope: 'wearable', t: t0, language: 'hi' })
    expect(sim.getState().applied).toEqual([])
    expect(device(sim, ramesh.id).physioActive).toBe(true)
    phone = ramesh.id
    gov.getState().revoke({ workerId: ramesh.id, scope: 'checkins', t: t0, language: 'hi' })
    expect(sim.getState().applied.map((a) => a.injection.kind)).toEqual(['consent'])
    expect(device(sim, ramesh.id).physioActive).toBe(false) // the ledger state, both revocations
    expect(device(sim, ramesh.id).checkinsConsented).toBe(false)
    phone = null // a console tab injects nothing
    gov.getState().grant({ workerId: ramesh.id, scope: 'wearable', t: t0, language: 'hi' })
    expect(sim.getState().applied).toHaveLength(1)
    off()
  })
})
