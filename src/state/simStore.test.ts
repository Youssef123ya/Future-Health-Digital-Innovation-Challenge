import { beforeAll, describe, expect, it } from 'vitest'
import { MINUTE_MS, epochFromLocal } from '../engine/time'
import { RISK_ORDER, type Checkin } from '../engine/types'
import { createNodeSimDataLoader, type SimDataLoader } from '../sim/simdata'
import { loadScenarioData, type ScenarioId } from '../sim/scenarios'
import type { SimData, WorldInjection } from '../sim/types'
import { DEVICE_LOG_LIMITS, SIM_CLOCK, absorbEvents, createSimStore, resolveJumpTarget, simStore, type SimScheduler, type SimStore } from './simStore'

const SCENARIO: ScenarioId = 'peak-day'
const DATE = '2025-08-01'
const W = 'W-D2F6' // demo crew, all consents on, wearable

/** A loader that serves pre-loaded data (no disk access per store). */
function cachedLoader(base: SimDataLoader, data: SimData): SimDataLoader {
  return { weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() }
}

/** Manual frame clock: `frame(ms)` advances real time and runs the pending frame. */
function manualClock() {
  let now = 0
  let next: (() => void) | null = null
  let handle = 0
  const scheduler: SimScheduler = {
    now: () => now,
    requestFrame: (cb) => {
      next = cb
      return ++handle
    },
    cancelFrame: () => {
      next = null
    },
    yieldToUi: () => Promise.resolve(),
  }
  return {
    scheduler,
    frame(ms: number) {
      now += ms
      const cb = next
      next = null
      cb?.()
    },
    get scheduled() {
      return next !== null
    },
  }
}

const base = createNodeSimDataLoader()
let data: SimData
beforeAll(async () => {
  data = await loadScenarioData(SCENARIO, base)
}, 60_000)

async function ready(clock = manualClock()): Promise<{ store: SimStore; clock: ReturnType<typeof manualClock> }> {
  const store = createSimStore({ loader: cachedLoader(base, data), scheduler: clock.scheduler })
  await store.getState().loadScenario(SCENARIO)
  return { store, clock }
}

const at = (hhmm: string): number => epochFromLocal(`${DATE}T${hhmm}`)
const checkin = (t: number, symptoms: Checkin['symptoms'], by: Checkin['by'] = 'self'): WorldInjection => ({ kind: 'checkin', checkin: { t, workerId: W, by, symptoms } })
const viewJson = (s: SimStore): string => JSON.stringify(s.getState().view)

describe('simStore — Node safety and loading', () => {
  it('imports and creates stores without a browser (no window, lazy loader and scheduler)', () => {
    expect(typeof window).toBe('undefined')
    const s = createSimStore()
    expect(s.getState().status).toBe('idle')
    expect(s.getState().view).toBeNull()
    expect(simStore.getState().status).toBe('idle')
    s.getState().play() // no world: no-op, no scheduler needed
    expect(s.getState().playing).toBe(false)
  })

  it('loads a scenario: paused at the shift start, roster links (crew, buddy, supervisor) and crews', async () => {
    const { store } = await ready()
    const s = store.getState()
    expect(s.status).toBe('ready')
    expect(s.scenarioId).toBe(SCENARIO)
    expect(s.playing).toBe(false)
    expect(s.view?.t).toBe(s.world?.t0)
    expect(s.view?.t).toBe(at('05:00'))
    expect(s.view?.workers.length).toBeGreaterThan(5)
    expect(s.crews.map((c) => c.id)).toContain('musaffah-demo')
    expect(s.roster[W]?.crewId).toBe('musaffah-demo')
    expect(s.roster[W]?.supervisorId).toBe('musaffah-demo:supervisor')
    expect(typeof s.roster[W]?.buddyId).toBe('string')
  })

  it('reports an unknown scenario as an error state instead of throwing', async () => {
    const store = createSimStore({ loader: cachedLoader(base, data), scheduler: manualClock().scheduler })
    await store.getState().loadScenario('nope' as ScenarioId)
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toMatch(/nope|scenario/i)
  })
})

describe('simStore — deterministic stepping', () => {
  it('chunked steps and a chunked jump give identical views (same injections at the same minute)', async () => {
    const a = (await ready()).store
    const b = (await ready()).store
    const inj = [checkin(at('08:00'), ['headache']), { kind: 'intake', intake: { t: at('08:00'), workerId: W, ml: 250 } } as WorldInjection]
    // A: 7-minute steps to 08:00, inject, 7-minute steps to 11:00 (exact minute counts).
    const stepTo = (s: SimStore, hhmm: string): void => {
      let left = Math.round((at(hhmm) - (s.getState().world?.t ?? 0)) / MINUTE_MS)
      while (left > 0) {
        const n = Math.min(7, left)
        s.getState().step(n)
        left -= n
      }
    }
    stepTo(a, '08:00')
    a.getState().inject(inj)
    stepTo(a, '11:00')
    // B: jumps (10-minute chunks).
    await b.getState().jumpTo('08:00')
    b.getState().inject(inj)
    await b.getState().jumpTo('11:00')
    expect(a.getState().view?.t).toBe(at('11:00'))
    expect(viewJson(a)).toBe(viewJson(b))
    expect(JSON.stringify(a.getState().device)).toBe(JSON.stringify(b.getState().device))
    expect(a.getState().applied.map((x) => x.t)).toEqual([at('08:00'), at('08:00')])
  })

  it('a backward jump rebuilds the world and replays earlier injections (same state as going straight there)', async () => {
    const c = (await ready()).store
    const d = (await ready()).store
    await c.getState().jumpTo('06:00')
    c.getState().inject(checkin(at('06:00'), ['headache', 'dizziness']))
    await c.getState().jumpTo('10:00')
    c.getState().inject(checkin(at('10:00'), ['nausea'])) // after the rewind target: dropped
    await c.getState().jumpTo('08:00')
    await d.getState().jumpTo('06:00')
    d.getState().inject(checkin(at('06:00'), ['headache', 'dizziness']))
    await d.getState().jumpTo('08:00')
    expect(c.getState().view?.t).toBe(at('08:00'))
    expect(viewJson(c)).toBe(viewJson(d))
    expect(c.getState().applied).toHaveLength(1)
  })

  it('a consent injection changes the device world from that minute and is replayed by a backward jump', async () => {
    const c = (await ready()).store
    const d = (await ready()).store
    const revoke = (s: SimStore): WorldInjection => {
      const ws = s.getState().world!.workerById.get(W)!
      return { kind: 'consent', workerId: W, consent: { ...ws.profile.consent, wearable: false, updatedAt: s.getState().world!.t } }
    }
    await c.getState().jumpTo('07:00')
    c.getState().inject(revoke(c))
    expect(c.getState().applied.at(-1)).toMatchObject({ ok: true, t: at('07:00'), injection: { kind: 'consent', workerId: W } })
    expect(c.getState().world!.workerById.get(W)!.physioActive).toBe(false)
    await c.getState().jumpTo('09:00')
    await c.getState().jumpTo('08:00') // rewind: rebuild and replay the 07:00 consent change
    await d.getState().jumpTo('07:00')
    d.getState().inject(revoke(d))
    await d.getState().jumpTo('08:00')
    expect(viewJson(c)).toBe(viewJson(d))
    expect(c.getState().view!.workers.find((x) => x.profile.id === W)!.profile.consent.wearable).toBe(false)
    expect(c.getState().view!.workers.find((x) => x.profile.id === W)!.lastHrBpm).toBeNull()
  })

  it('resolves jump targets onto the minute grid, clamped to the shift', async () => {
    const { store } = await ready()
    const w = store.getState().world!
    expect(resolveJumpTarget('04:00', w)).toBe(w.t0)
    expect(resolveJumpTarget('23:00', w)).toBe(w.tEnd)
    expect(resolveJumpTarget(at('09:00') + 30_000, w)).toBe(at('09:01'))
    expect(() => resolveJumpTarget('9am', w)).toThrow(RangeError)
  })
})

describe('simStore — clock', () => {
  it('plays at the chosen speed in whole minutes, pauses, and validates speeds', async () => {
    const { store, clock } = await ready()
    store.getState().setSpeed(300)
    store.getState().play()
    expect(store.getState().playing).toBe(true)
    const t0 = store.getState().view!.t
    for (let i = 0; i < 4; i++) clock.frame(250) // 1 s real at 300× = 5 simulated minutes
    expect(store.getState().view!.t - t0).toBe(5 * MINUTE_MS)
    store.getState().pause()
    expect(clock.scheduled).toBe(false)
    clock.frame(250)
    expect(store.getState().view!.t - t0).toBe(5 * MINUTE_MS)
    expect(() => store.getState().setSpeed(2 as never)).toThrow(RangeError)
  })

  it('a long real gap is capped (no burst after a hidden tab) and the backlog never exceeds one chunk', async () => {
    const { store, clock } = await ready()
    store.getState().setSpeed(300)
    store.getState().play()
    const t0 = store.getState().view!.t
    clock.frame(60_000) // counted as maxFrameGapMs only
    const stepped = (store.getState().view!.t - t0) / MINUTE_MS
    expect(stepped).toBeLessThanOrEqual(Math.ceil((SIM_CLOCK.maxFrameGapMs * 300) / MINUTE_MS))
    store.getState().dispose()
  })

  it('stops by itself at the end of the shift', async () => {
    const { store, clock } = await ready()
    await store.getState().jumpTo('16:58')
    store.getState().setSpeed(300)
    store.getState().play()
    for (let i = 0; i < 20 && store.getState().playing; i++) clock.frame(250)
    expect(store.getState().view?.finished).toBe(true)
    expect(store.getState().playing).toBe(false)
    store.getState().play()
    expect(store.getState().playing).toBe(false)
  })
})

describe('simStore — injection queue and device log', () => {
  it('queues while playing (applied at the next frame) and applies at once while paused', async () => {
    const { store, clock } = await ready()
    store.getState().play()
    store.getState().inject(checkin(at('05:00'), ['thirst']))
    expect(store.getState().pending).toHaveLength(1)
    clock.frame(16)
    expect(store.getState().pending).toHaveLength(0)
    expect(store.getState().applied[0]).toMatchObject({ ok: true, origin: 'local', t: at('05:00') })
    store.getState().pause()
    store.getState().inject({ kind: 'ack', alertId: 'none', role: 'supervisor' }, { origin: 'remote' })
    expect(store.getState().pending).toHaveLength(0)
    expect(store.getState().applied.at(-1)?.origin).toBe('remote')
  })

  it('refuses a bad injection without throwing and keeps the others', async () => {
    const { store } = await ready()
    store.getState().inject([{ kind: 'task', workerId: 'W-NOPE', taskId: null, location: 'shade' }, checkin(at('05:00'), ['thirst'])])
    const applied = store.getState().applied
    expect(applied.map((a) => a.ok)).toEqual([false, true])
    expect(store.getState().injectionError).toMatch(/W-NOPE/)
  })

  it('collects check-ins and displayed levels into the on-device record', async () => {
    const { store } = await ready()
    await store.getState().jumpTo('12:00')
    store.getState().inject(checkin(at('12:00'), ['headache', 'dizziness']))
    store.getState().step(3)
    const rec = store.getState().device[W]
    expect(rec.checkins.at(-1)?.symptoms).toEqual(['headache', 'dizziness'])
    expect(rec.levels.length).toBeGreaterThan(0)
    for (const l of rec.levels) expect(RISK_ORDER[rec.maxLevel]).toBeGreaterThanOrEqual(RISK_ORDER[l.level])
    // absorbEvents is incremental: nothing new → same object.
    const again = absorbEvents(store.getState().world!, store.getState().world!.events.length, store.getState().device)
    expect(again.device).toBe(store.getState().device)
    expect(DEVICE_LOG_LIMITS.checkins).toBeGreaterThan(0)
  })

  it('keeps only newer remote payloads, and a bounded list of check-in notices', async () => {
    const { store } = await ready()
    const p = { v: 1, pseudonym: W, crewId: 'musaffah-demo', level: 'high', actions: [], workMinPerHour: 30, waterMlPerHour: 500, ack: 'none', t: 100, confidence: 'high' } as const
    store.getState().acceptRemotePayload({ ...p, actions: [] })
    store.getState().acceptRemotePayload({ ...p, actions: [], t: 50, level: 'safe' })
    expect(store.getState().remotePayloads[W].payload.level).toBe('high')
    for (let i = 0; i < DEVICE_LOG_LIMITS.remoteCheckins + 5; i++) store.getState().acceptRemoteCheckin({ workerId: W, t: i, level: 'high' })
    expect(store.getState().remoteCheckins).toHaveLength(DEVICE_LOG_LIMITS.remoteCheckins)
  })

  it('follows another clock: loads, jumps and adopts speed and play state', async () => {
    const leader = (await ready()).store
    await leader.getState().jumpTo('09:30')
    const follower = createSimStore({ loader: cachedLoader(base, data), scheduler: manualClock().scheduler })
    const cfg = leader.getState().world!.config
    await follower.getState().syncClock({ scenarioId: SCENARIO, policy: cfg.policy, seed: cfg.seed, t: leader.getState().world!.t, playing: false, speed: 10 })
    expect(follower.getState().speed).toBe(10)
    expect(follower.getState().clock.origin).toBe('remote')
    expect(viewJson(follower)).toBe(viewJson(leader))
  })
})
