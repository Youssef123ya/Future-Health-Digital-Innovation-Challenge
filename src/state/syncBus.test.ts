import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SYNC_PAYLOAD_KEYS, type SyncPayload } from '../engine/privacy'
import { createNodeSimDataLoader, type SimDataLoader } from '../sim/simdata'
import { loadScenarioData } from '../sim/scenarios'
import type { SimData } from '../sim/types'
import { createSimStore, type SimStore } from './simStore'
import { selectSupervisorBoard, selectorInput } from './selectors'
import {
  SYNC_FORBIDDEN_KEYS,
  SYNC_MESSAGE_KEYS,
  connectSimToBus,
  createMemoryChannelHub,
  createSyncBus,
  findForbiddenKeys,
  injectionForMessage,
  isSyncMessage,
  parseEnvelope,
  type SyncEnvelope,
  type SyncMessage,
} from './syncBus'

const payload: SyncPayload = { v: 1, pseudonym: 'W-D2F6', crewId: 'musaffah-demo', level: 'high', actions: ['rest_shade_now'], workMinPerHour: 30, waterMlPerHour: 740, ack: 'active', t: 1000, confidence: 'high' }
const payloadMsg: SyncMessage = { kind: 'payload', payload }

describe('syncBus — schema', () => {
  it('accepts exactly the schema and rejects extra keys, clinical keys and wrong types', () => {
    expect(isSyncMessage(payloadMsg)).toBe(true)
    expect(isSyncMessage({ kind: 'checkin_done', workerId: 'W-1', t: 1, level: 'stop' })).toBe(true)
    expect(isSyncMessage({ kind: 'checkin_done', workerId: 'W-1', t: 1, level: 'stop', symptoms: ['confusion'] })).toBe(false)
    expect(isSyncMessage({ kind: 'payload', payload: { ...payload, hrBpm: 150 } })).toBe(false)
    expect(isSyncMessage({ kind: 'payload', payload: { ...payload, actions: ['not_an_action'] } })).toBe(false)
    expect(isSyncMessage({ kind: 'ack', alertId: 'A1', role: 'employer_hr', actorId: 'x', t: 1 })).toBe(false)
    expect(isSyncMessage({ kind: 'resolve', workerId: 'W-1', alertId: null, by: 'first_aider', actorId: 'FA-1', t: 1 })).toBe(true)
    expect(isSyncMessage({ kind: 'clock', scenarioId: 'peak-day', policy: 'zill_full', seed: 's', t: 1, playing: true, speed: 7 })).toBe(false)
    expect(isSyncMessage({ kind: 'nope' })).toBe(false)
    expect(findForbiddenKeys({ a: [{ b: { ctEstC: 1 } }], riskFlags: [] }).sort()).toEqual(['ctEstC', 'riskFlags'])
    for (const keys of Object.values(SYNC_MESSAGE_KEYS)) for (const k of keys) expect(SYNC_FORBIDDEN_KEYS).not.toContain(k)
    expect(parseEnvelope({ v: 1, id: 'x#1', origin: 'x', seq: 1, msg: payloadMsg })).not.toBeNull()
    expect(parseEnvelope({ v: 2, id: 'x#1', origin: 'x', seq: 1, msg: payloadMsg })).toBeNull()
    expect(injectionForMessage(payloadMsg)).toBeNull()
    expect(injectionForMessage({ kind: 'resolve', workerId: 'W-1', alertId: null, by: 'supervisor', actorId: 's', t: 1 })).toEqual({ kind: 'resolve', workerId: 'W-1', by: 'supervisor' })
  })
})

describe('syncBus — delivery', () => {
  it('delivers to other tabs only, drops echoes, duplicates and invalid envelopes', async () => {
    const hub = createMemoryChannelHub()
    const a = createSyncBus({ factory: hub.factory, origin: 'A' })
    const b = createSyncBus({ factory: hub.factory, origin: 'B' })
    const gotA: SyncMessage[] = []
    const gotB: SyncMessage[] = []
    a.subscribe((m) => gotA.push(m))
    b.subscribe((m) => gotB.push(m))
    const sent = a.send(payloadMsg)
    expect(sent.ok).toBe(true)
    await hub.settle()
    expect(gotB).toEqual([payloadMsg])
    expect(gotA).toEqual([])
    // A raw channel replays A's envelope (duplicate), forges B's own origin (echo), and sends clinical content.
    const raw = hub.factory('zill')!
    const env = (sent as { envelope: SyncEnvelope }).envelope
    raw.postMessage(env)
    raw.postMessage({ ...env, id: 'B#99', origin: 'B' })
    raw.postMessage({ v: 1, id: 'evil#1', origin: 'evil', seq: 1, msg: { kind: 'checkin_done', workerId: 'W-1', t: 1, level: 'stop', symptoms: ['confusion'] } })
    await hub.settle()
    expect(gotB).toHaveLength(1)
    expect(b.stats()).toMatchObject({ received: 1, droppedDuplicate: 1, droppedEcho: 1, rejected: 1 })
    // Sending clinical keys is refused before anything is posted.
    const before = hub.posted.length
    expect(a.send({ kind: 'payload', payload: { ...payload, symptoms: ['headache'] } } as unknown as SyncMessage)).toEqual({ ok: false, reason: 'forbidden_keys' })
    expect(a.send({ kind: 'checkin_done', workerId: 'W-1', t: 1, level: 'boiling' } as unknown as SyncMessage)).toEqual({ ok: false, reason: 'invalid' })
    expect(hub.posted.length).toBe(before)
    a.close()
    expect(a.available).toBe(false)
    expect(a.send(payloadMsg)).toEqual({ ok: false, reason: 'closed' })
    b.close()
  })

  it('is a graceful no-op without BroadcastChannel (or when opening the channel throws)', () => {
    const none = createSyncBus({ factory: null })
    expect(none.available).toBe(false)
    expect(none.send(payloadMsg)).toEqual({ ok: false, reason: 'unavailable' })
    const off = none.subscribe(() => undefined)
    off()
    none.close()
    const broken = createSyncBus({
      factory: () => {
        throw new Error('blocked')
      },
    })
    expect(broken.available).toBe(false)
    expect(broken.send(payloadMsg).ok).toBe(false)
  })

  it('works over the runtime BroadcastChannel', async () => {
    const name = `zill-test-${Math.floor(performance.now())}`
    const a = createSyncBus({ name })
    const b = createSyncBus({ name })
    expect(a.available).toBe(true)
    const received = new Promise<SyncMessage>((resolve) => b.subscribe((m) => resolve(m)))
    expect(a.send(payloadMsg).ok).toBe(true)
    expect(await received).toEqual(payloadMsg)
    a.close()
    b.close()
  })
})

describe('syncBus — simulation tabs', () => {
  const base = createNodeSimDataLoader()
  let data: SimData
  beforeAll(async () => {
    data = await loadScenarioData('peak-day', base)
  }, 60_000)
  const loader = (): SimDataLoader => ({ weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() })
  const tab = async (): Promise<SimStore> => {
    const s = createSimStore({ loader: loader(), scheduler: { now: () => 0, requestFrame: () => 0, cancelFrame: () => undefined, yieldToUi: () => Promise.resolve() } })
    await s.getState().loadScenario('peak-day')
    await s.getState().jumpTo('10:00')
    return s
  }
  const W = 'W-D2F6'

  it('device → console: payloads and a level-only check-in notice; console → device: ack, resolve, reassignment; nothing clinical crosses; no echo', async () => {
    const hub = createMemoryChannelHub()
    const device = await tab()
    const consoleTab = await tab()
    const offDevice = connectSimToBus(device, createSyncBus({ factory: hub.factory, origin: 'device' }), { deviceWorkerId: () => W })
    const offConsole = connectSimToBus(consoleTab, createSyncBus({ factory: hub.factory, origin: 'console' }), { actorId: () => 'musaffah-demo:supervisor' })

    // Worker check-in on the phone (T2 symptoms), processed by the engine at the next minute.
    const t = device.getState().view!.t
    device.getState().inject({ kind: 'checkin', checkin: { t, workerId: W, by: 'self', symptoms: ['headache', 'dizziness'] } })
    device.getState().step(2)
    await hub.settle()
    const posted = () => hub.posted.map((p) => (p.data as SyncEnvelope).msg)
    const notices = posted().filter((m) => m.kind === 'checkin_done')
    expect(notices).toHaveLength(1)
    expect(Object.keys(notices[0]).sort()).toEqual(['kind', 'level', 't', 'workerId'])
    const deviceLevel = device.getState().view!.workers.find((w) => w.profile.id === W)!.assessment!.level
    expect(consoleTab.getState().remoteCheckins).toEqual([{ workerId: W, t, level: (notices[0] as { level: string }).level }])
    expect(['stop', 'emergency']).toContain(deviceLevel)

    // Device payloads: exactly the sync payload keys; the console board shows the device-reported level.
    const payloads = posted().filter((m): m is Extract<SyncMessage, { kind: 'payload' }> => m.kind === 'payload')
    expect(payloads.length).toBeGreaterThan(0)
    for (const p of payloads) expect(Object.keys(p.payload)).toEqual([...SYNC_PAYLOAD_KEYS])
    expect(consoleTab.getState().remotePayloads[W].payload.level).toBe(deviceLevel)
    const board = selectSupervisorBoard(selectorInput(consoleTab.getState())!, 'musaffah-demo:supervisor').model
    const row = board.crews.flatMap((c) => c.rows).find((r) => r.workerId === W)!
    expect(row.source).toBe('remote')
    expect(row.data.level).toBe(deviceLevel)

    // Console acknowledges the device's alert, then reassigns the worker to the cooled rest area and resolves.
    const alertId = device.getState().view!.alerts.find((a) => a.workerId === W && a.status !== 'resolved')!.id
    consoleTab.getState().inject({ kind: 'ack', alertId, role: 'supervisor', actorId: 'musaffah-demo:supervisor' })
    consoleTab.getState().inject({ kind: 'task', workerId: W, taskId: null, location: 'indoor_cool' })
    await hub.settle()
    const deviceAlert = device.getState().view!.alerts.find((a) => a.id === alertId)!
    expect(deviceAlert.status === 'acknowledged' || deviceAlert.ack?.role === 'supervisor').toBe(true)
    expect(device.getState().view!.workers.find((w) => w.profile.id === W)!.location).toBe('indoor_cool')
    consoleTab.getState().inject({ kind: 'resolve', workerId: W, by: 'supervisor' })
    await hub.settle()
    expect(device.getState().world!.events.some((e) => e.kind === 'resolution' && e.workerId === W && e.by === 'supervisor')).toBe(true)
    expect(device.getState().applied.filter((a) => a.origin === 'remote').map((a) => a.injection.kind)).toEqual(['ack', 'task', 'resolve'])

    // Echo protection: each action crossed once; the device did not re-broadcast what it received.
    const kinds = posted().map((m) => m.kind)
    expect(kinds.filter((k) => k === 'ack')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'reassign')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'resolve')).toHaveLength(1)
    // Nothing clinical ever crossed the bus.
    for (const p of hub.posted) expect(findForbiddenKeys(p.data)).toEqual([])
    expect(JSON.stringify(hub.posted)).not.toMatch(/headache|dizziness|ectemp|hrBpm/i)

    offDevice()
    offConsole()
  })

  it('a follower tab mirrors the leader clock (scenario, time, speed, play state)', async () => {
    const hub = createMemoryChannelHub()
    const leader = await tab()
    const follower = createSimStore({ loader: loader(), scheduler: { now: () => 0, requestFrame: () => 0, cancelFrame: () => undefined, yieldToUi: () => Promise.resolve() } })
    const offL = connectSimToBus(leader, createSyncBus({ factory: hub.factory, origin: 'leader' }), { shareClock: true })
    const offF = connectSimToBus(follower, createSyncBus({ factory: hub.factory, origin: 'follower' }), { followClock: true })
    leader.getState().setSpeed(10)
    await hub.settle()
    await vi.waitFor(() => expect(follower.getState().view?.t).toBe(leader.getState().view!.t), { timeout: 20_000, interval: 20 })
    expect(follower.getState().speed).toBe(10)
    await leader.getState().jumpTo('12:30')
    await hub.settle()
    await vi.waitFor(() => expect(follower.getState().view?.t).toBe(leader.getState().view!.t), { timeout: 20_000, interval: 20 })
    expect(JSON.stringify(follower.getState().view)).toBe(JSON.stringify(leader.getState().view))
    // The follower's own (remote-origin) clock changes are not re-broadcast.
    expect(hub.posted.filter((p) => (p.data as SyncEnvelope).origin === 'follower')).toEqual([])
    offL()
    offF()
  })
})
