/**
 * Simulation application state (zustand vanilla store): scenario selection (sim/scenarios.ts), world creation through
 * the data loader, the simulation clock (play/pause, 1×/10×/60×/300×, jump to a time), chunked stepping that keeps the
 * UI responsive, the injection queue (UI actions → WorldInjection) and the current WorldView.
 *
 * Node-safe: nothing touches `window`, `document` or the network at import. The browser data loader and the frame
 * scheduler are created lazily on first use, and both can be injected (tests pass the Node loader and a manual clock).
 *
 * The world (sim/worldsim.ts) is mutated in place by `stepWorld` and is not serialisable. The store keeps the reference
 * in `world` and publishes a fresh `view` (worldView) after every step chunk; views render `view` through the
 * role-projected selectors (./selectors.ts), never `world` (the Lab trace selector is the single exception).
 *
 * Determinism: the world is seeded (sim/rng.ts) and `stepWorld` is chunking-invariant, so the state at a given minute
 * depends only on the scenario, the overrides and the injections applied at each minute — not on frame timing. Real
 * time (the scheduler) only decides how many whole minutes are stepped per frame.
 *
 * Evidence class: everything shown from this store is a SIMULATED COHORT projection (docs/SIMULATION.md).
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { RISK_ORDER, type Checkin, type Crew, type FluidIntake, type RiskLevel } from '../engine/types'
import { MINUTE_MS, epochFromLocal } from '../engine/time'
import type { SyncPayload } from '../engine/privacy'
import { createScenarioWorld, getScenario, loadScenarioData, type ScenarioId } from '../sim/scenarios'
import { createBrowserSimDataLoader, type SimDataLoader } from '../sim/simdata'
import { stepWorld, worldView, type SimConfigInput, type World } from '../sim/worldsim'
import type { PolicyId, SimData, WorldInjection, WorldView } from '../sim/types'

// ─────────────────────────────── Clock parameters ───────────────────────────────

/** Clock speeds offered by the Lab (simulated time ÷ real time). Basis: task brief (1×/10×/60×/300×) [ENG]. */
export const SIM_SPEEDS = [1, 10, 60, 300] as const
/** One of {@link SIM_SPEEDS}. */
export type SimSpeed = (typeof SIM_SPEEDS)[number]

/** True when `value` is one of {@link SIM_SPEEDS}. Basis: {@link SIM_SPEEDS}. */
export function isSimSpeed(value: unknown): value is SimSpeed {
  return typeof value === 'number' && (SIM_SPEEDS as readonly number[]).includes(value)
}

/**
 * Clock and chunking parameters. All [ENG]: chosen so a frame stays well inside a 16.7 ms display frame for a
 * 30-worker site (docs/SIMULATION.md §3 performance target: a whole site-day in < 3 s, i.e. ≈ 4 ms per simulated
 * minute) and so a long jump yields to the UI every chunk.
 */
export const SIM_CLOCK = Object.freeze({
  /** Speed of a fresh store. */
  defaultSpeed: 60 as SimSpeed,
  /** Most simulated minutes owed to the clock at once; a backlog above this is dropped, not caught up. */
  frameChunkMin: 10,
  /** Real-time budget for stepping inside one animation frame. */
  frameBudgetMs: 12,
  /** Longest real gap between two frames counted towards the clock (a hidden tab does not cause a burst). */
  maxFrameGapMs: 250,
  /** Simulated minutes per chunk while jumping; the store yields to the UI between chunks. */
  jumpChunkMin: 10,
  /** A followed clock (cross-tab) is re-synchronised only when it differs by more than this while playing. */
  followToleranceMin: 3,
  basis: '[ENG] UI responsiveness; docs/SIMULATION.md §3 (1-min steps, < 3 s per 30-worker site-day)',
})

/** Bounds of the per-worker on-device log and of the injection history. [ENG] memory bounds for a browser tab. */
export const DEVICE_LOG_LIMITS = Object.freeze({
  checkins: 50,
  intakes: 100,
  levels: 300,
  remoteCheckins: 50,
  applied: 2000,
  basis: '[ENG] memory bounds; raw data stays on the device (ARCHITECTURE §1 principle 5, §7 retention)',
})

// ─────────────────────────────── Types ───────────────────────────────

/** Abstract frame clock, so the store runs in a browser (requestAnimationFrame) and in Node tests (manual). */
export interface SimScheduler {
  /** Monotonic real time in ms (performance.now in the browser). */
  now(): number
  requestFrame(callback: () => void): unknown
  cancelFrame(handle: unknown): void
  /** Resolves after the UI had a chance to render (between jump chunks). */
  yieldToUi(): Promise<void>
}

/**
 * The default scheduler: requestAnimationFrame when present, else a 16 ms timer; `performance.now()` for time;
 * a zero-delay timer to yield. Resolved lazily, at first use. Basis: [ENG] browser frame pacing.
 */
export function browserScheduler(): SimScheduler {
  const hasRaf = typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'
  return {
    now: () => globalThis.performance.now(),
    requestFrame: (callback) => (hasRaf ? requestAnimationFrame(() => callback()) : setTimeout(callback, 16)),
    cancelFrame: (handle) => {
      if (hasRaf && typeof handle === 'number') cancelAnimationFrame(handle)
      else clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

/** Where a state change came from: this tab (`local`) or another tab through the sync bus (`remote`). */
export type ChangeOrigin = 'local' | 'remote'

/** Optional metadata of a store action. */
export interface ActionMeta {
  /** Default 'local'. Remote changes are never re-broadcast by the sync bus (echo protection). */
  origin?: ChangeOrigin
}

/** An injection waiting for the next step. */
export interface QueuedInjection {
  injection: WorldInjection
  origin: ChangeOrigin
}

/** An injection that was applied (or refused) at simulated time `t`. */
export interface AppliedInjection {
  /** Monotonic sequence number within this store. */
  seq: number
  /** Simulated time at which it was applied (start of the next minute to simulate). */
  t: number
  injection: WorldInjection
  origin: ChangeOrigin
  ok: boolean
  error?: string
}

/** Roster links of a worker (from the world's alert roster): crew, buddy and supervisor ids. Operational data only. */
export interface RosterLink {
  crewId: string
  displayName: string
  buddyId?: string
  supervisorId?: string
}

/**
 * Data held on a worker's own device, collected from the world's event log: their check-ins (self or reported by a
 * buddy, supervisor or first aider), logged drinks and displayed-level history. Leaves the device only through
 * privacy.project / aggregateFor (./selectors.ts). Basis: ARCHITECTURE §1 principle 5, §3, §7.
 */
export interface DeviceRecord {
  checkins: Checkin[]
  intakes: FluidIntake[]
  /** Displayed-level transitions, oldest first. */
  levels: Array<{ t: number; level: RiskLevel }>
  /** Highest displayed level since the start of the shift. */
  maxLevel: RiskLevel
}

/** A sync payload received from another tab (a worker's device). */
export interface RemotePayload {
  payload: SyncPayload
  /** Local simulated time at reception. */
  receivedAt: number
}

/** "A check-in happened" notice from a worker's device: the resulting level only. */
export interface RemoteCheckin {
  workerId: string
  t: number
  level: RiskLevel
}

/** A clock state to follow (cross-tab). */
export interface ClockSync {
  scenarioId: ScenarioId
  policy: PolicyId
  seed: string
  t: number
  playing: boolean
  speed: SimSpeed
}

/** Loading status of the store. */
export type SimStatus = 'idle' | 'loading' | 'ready' | 'error'

/** State and actions of the simulation store. */
export interface SimStoreState {
  status: SimStatus
  error: string | null
  scenarioId: ScenarioId | null
  /** Config overrides applied on top of the scenario (policy, seed, behaviour, disruptions…). */
  overrides: Partial<SimConfigInput>
  data: SimData | null
  /** The live world — mutated in place; do not render from it (use `view`). */
  world: World | null
  /** Fresh snapshot after every step chunk. Holds clinical items and ground truth: render only through selectors. */
  view: WorldView | null
  crews: readonly Crew[]
  roster: Readonly<Record<string, RosterLink>>
  device: Readonly<Record<string, DeviceRecord>>
  playing: boolean
  speed: SimSpeed
  jumping: boolean
  pending: readonly QueuedInjection[]
  applied: readonly AppliedInjection[]
  /** Last refused injection (unknown worker, unknown task, shift ended…). */
  injectionError: string | null
  remotePayloads: Readonly<Record<string, RemotePayload>>
  remoteCheckins: readonly RemoteCheckin[]
  /** Bumped on every clock change (scenario, reset, play/pause, speed, jump) with its origin. */
  clock: { rev: number; origin: ChangeOrigin }
  /** Bumped every time `view` is refreshed. */
  revision: number

  /** Loads the scenario's data (cached per scenario) and builds a fresh world at the start of the shift (paused). */
  loadScenario(id: ScenarioId, overrides?: Partial<SimConfigInput>, meta?: ActionMeta): Promise<void>
  /** Merges config overrides and rebuilds the world at the start of the shift. */
  configure(overrides: Partial<SimConfigInput>, meta?: ActionMeta): void
  /** Rebuilds the world at the start of the shift; the injection history is cleared. */
  reset(meta?: ActionMeta): void
  play(meta?: ActionMeta): void
  pause(meta?: ActionMeta): void
  togglePlay(meta?: ActionMeta): void
  setSpeed(speed: SimSpeed, meta?: ActionMeta): void
  /** Applies pending injections, then steps `minutes` whole minutes synchronously. */
  step(minutes: number): void
  /**
   * Jumps to a local 'HH:mm' time or an epoch-ms time, in chunks that yield to the UI. A backward jump rebuilds the
   * world and replays the injections applied before the target, so user actions survive a rewind.
   */
  jumpTo(target: string | number, meta?: ActionMeta): Promise<void>
  /** Queues injections; applied at once when the clock is paused, else at the start of the next frame. */
  inject(injection: WorldInjection | readonly WorldInjection[], meta?: ActionMeta): void
  /** Applies pending injections now without advancing the clock. */
  flush(): void
  /** Follows another tab's clock (scenario, policy, seed, time, play state, speed). */
  syncClock(clock: ClockSync, meta?: ActionMeta): Promise<void>
  acceptRemotePayload(payload: SyncPayload): void
  acceptRemoteCheckin(notice: RemoteCheckin): void
  /** Stops the frame loop and cancels pending loads and jumps. */
  dispose(): void
}

/** A simulation store. */
export type SimStore = StoreApi<SimStoreState>

/** Dependencies of {@link createSimStore}; everything is optional and resolved lazily. */
export interface SimStoreDeps {
  /** Data loader, or a factory for it. Default: sim/simdata.ts createBrowserSimDataLoader(), created on first load. */
  loader?: SimDataLoader | (() => SimDataLoader)
  /** Frame clock. Default: {@link browserScheduler}, created on first use. */
  scheduler?: SimScheduler
}

// ─────────────────────────────── Helpers ───────────────────────────────

/** A new, empty on-device record. Basis: {@link DeviceRecord}. */
export function emptyDeviceRecord(): DeviceRecord {
  return { checkins: [], intakes: [], levels: [], maxLevel: 'safe' }
}

function pushBounded<T>(list: T[], item: T, limit: number): void {
  list.push(item)
  if (list.length > limit) list.splice(0, list.length - limit)
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isInjectionList = (x: WorldInjection | readonly WorldInjection[]): x is readonly WorldInjection[] => Array.isArray(x)

/**
 * Copies the world's new events (from `cursor`) into the per-worker device records: check-ins, drinks and displayed
 * levels. Only touched records are copied, so unchanged workers keep their object identity. Basis: sim/types.ts
 * SimEvent (append-only event log); ARCHITECTURE §3 (check-ins and physiology stay on the device).
 */
export function absorbEvents(
  world: Pick<World, 'events'>,
  cursor: number,
  device: Readonly<Record<string, DeviceRecord>>,
): { cursor: number; device: Readonly<Record<string, DeviceRecord>> } {
  const events = world.events
  if (cursor >= events.length) return { cursor: events.length, device }
  const next: Record<string, DeviceRecord> = { ...device }
  const touched = new Set<string>()
  const rec = (id: string): DeviceRecord => {
    if (!touched.has(id)) {
      const prev = next[id] ?? emptyDeviceRecord()
      next[id] = { checkins: [...prev.checkins], intakes: [...prev.intakes], levels: [...prev.levels], maxLevel: prev.maxLevel }
      touched.add(id)
    }
    return next[id]
  }
  for (let i = cursor; i < events.length; i++) {
    const e = events[i]
    if (e.kind === 'checkin') pushBounded(rec(e.checkin.workerId).checkins, e.checkin, DEVICE_LOG_LIMITS.checkins)
    else if (e.kind === 'intake') pushBounded(rec(e.intake.workerId).intakes, e.intake, DEVICE_LOG_LIMITS.intakes)
    else if (e.kind === 'level') {
      const r = rec(e.workerId)
      pushBounded(r.levels, { t: e.t, level: e.to }, DEVICE_LOG_LIMITS.levels)
      if (RISK_ORDER[e.to] > RISK_ORDER[r.maxLevel]) r.maxLevel = e.to
    }
  }
  return { cursor: events.length, device: touched.size > 0 ? next : device }
}

/**
 * Resolves a jump target ('HH:mm' local on the world's date, or epoch ms) to a minute of the shift grid, clamped to
 * [start, end]. Throws RangeError on a malformed target. Basis: engine/time.ts (Asia/Dubai, UTC+4, no DST).
 */
export function resolveJumpTarget(target: string | number, world: Pick<World, 'config' | 't0' | 'tEnd'>): number {
  let t: number
  if (typeof target === 'number') t = target
  else {
    if (!/^\d{2}:\d{2}$/.test(target)) throw new RangeError(`jumpTo: expected 'HH:mm', got '${target}'`)
    t = epochFromLocal(`${world.config.date}T${target}`)
  }
  if (!Number.isFinite(t)) throw new RangeError(`jumpTo: invalid target ${String(target)}`)
  const clamped = Math.min(Math.max(t, world.t0), world.tEnd)
  return world.t0 + Math.ceil((clamped - world.t0) / MINUTE_MS) * MINUTE_MS
}

function rosterLinks(world: World): Record<string, RosterLink> {
  const out: Record<string, RosterLink> = {}
  for (const [id, e] of Object.entries(world.rosterOnline)) {
    out[id] = {
      crewId: e.crewId,
      displayName: e.displayName,
      ...(e.buddyId ? { buddyId: e.buddyId } : {}),
      ...(e.supervisorId ? { supervisorId: e.supervisorId } : {}),
    }
  }
  return out
}

function applyOne(world: World, injection: WorldInjection): { ok: boolean; error?: string } {
  if (world.finished) return { ok: false, error: 'The shift has ended; the action was not applied.' }
  try {
    stepWorld(world, 0, [injection])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

const INITIAL = {
  status: 'idle' as SimStatus,
  error: null,
  scenarioId: null,
  overrides: {},
  data: null,
  world: null,
  view: null,
  crews: [],
  roster: {},
  device: {},
  playing: false,
  speed: SIM_CLOCK.defaultSpeed,
  jumping: false,
  pending: [],
  applied: [],
  injectionError: null,
  remotePayloads: {},
  remoteCheckins: [],
  clock: { rev: 0, origin: 'local' as ChangeOrigin },
  revision: 0,
}

// ─────────────────────────────── Store ───────────────────────────────

/**
 * Creates a simulation store. Safe to call in Node: the loader and the scheduler are only created when first needed.
 * Basis: docs/SIMULATION.md §3 (1-min world steps), sim/worldsim.ts (stepWorld mutates in place, chunking-invariant;
 * worldView returns a fresh snapshot), ARCHITECTURE §4 (state/: simulation clock and world state).
 */
export function createSimStore(deps: SimStoreDeps = {}): SimStore {
  let scheduler: SimScheduler | null = deps.scheduler ?? null
  const sched = (): SimScheduler => (scheduler ??= browserScheduler())
  let loader: SimDataLoader | null = null
  const getLoader = (): SimDataLoader => {
    if (loader) return loader
    const d = deps.loader
    loader = d === undefined ? createBrowserSimDataLoader() : typeof d === 'function' ? d() : d
    return loader
  }
  const dataCache = new Map<ScenarioId, Promise<SimData>>()
  let frame: unknown = null
  let lastFrameT = 0
  let owedMin = 0
  let cursor = 0
  let seq = 0
  let loadToken = 0
  let jumpToken = 0

  return createStore<SimStoreState>()((set, get) => {
    const bumpClock = (origin: ChangeOrigin): void => set((s) => ({ clock: { rev: s.clock.rev + 1, origin } }))

    const refresh = (): void => {
      const w = get().world
      if (!w) return
      const absorbed = absorbEvents(w, cursor, get().device)
      cursor = absorbed.cursor
      set((s) => ({ view: worldView(w), device: absorbed.device, revision: s.revision + 1 }))
    }

    const applyPending = (): void => {
      const s = get()
      const w = s.world
      if (!w || s.pending.length === 0) return
      const applied = s.applied.slice()
      let error = s.injectionError
      for (const q of s.pending) {
        const r = applyOne(w, q.injection)
        applied.push({ seq: ++seq, t: w.t, injection: q.injection, origin: q.origin, ok: r.ok, ...(r.error ? { error: r.error } : {}) })
        if (r.error) error = r.error
      }
      set({ pending: [], applied: applied.length > DEVICE_LOG_LIMITS.applied ? applied.slice(-DEVICE_LOG_LIMITS.applied) : applied, injectionError: error })
    }

    /** Applies pending injections, steps up to `minutes` (within `budgetMs` when finite), refreshes the view. */
    const advance = (minutes: number, budgetMs = Infinity): number => {
      const w = get().world
      if (!w) return 0
      applyPending()
      let done = 0
      if (budgetMs === Infinity) {
        const before = w.minuteIndex
        stepWorld(w, minutes)
        done = w.minuteIndex - before
      } else {
        const start = sched().now()
        while (done < minutes && !w.finished) {
          stepWorld(w, 1)
          done += 1
          if (sched().now() - start >= budgetMs) break
        }
      }
      refresh()
      return done
    }

    const build = (id: ScenarioId, data: SimData, overrides: Partial<SimConfigInput>, keepHistory: boolean): void => {
      const world = createScenarioWorld(id, data, overrides)
      cursor = 0
      set((s) => ({
        status: 'ready',
        error: null,
        scenarioId: id,
        overrides,
        data,
        world,
        crews: world.crews.map((c) => c.crew),
        roster: rosterLinks(world),
        device: {},
        applied: keepHistory ? s.applied : [],
        pending: keepHistory ? s.pending : [],
        injectionError: null,
        remotePayloads: {},
        remoteCheckins: [],
      }))
      refresh()
    }

    const stopLoop = (): void => {
      if (frame !== null) sched().cancelFrame(frame)
      frame = null
    }

    const onFrame = (): void => {
      frame = null
      const s = get()
      if (!s.playing || s.jumping || !s.world) return
      const now = sched().now()
      const gap = Math.min(Math.max(0, now - lastFrameT), SIM_CLOCK.maxFrameGapMs)
      lastFrameT = now
      owedMin = Math.min(owedMin + (gap * s.speed) / MINUTE_MS, SIM_CLOCK.frameChunkMin)
      const n = Math.floor(owedMin)
      if (n > 0 || s.pending.length > 0) owedMin -= advance(n, SIM_CLOCK.frameBudgetMs)
      const after = get()
      if (after.world?.finished) {
        set({ playing: false })
        bumpClock('local')
        return
      }
      if (after.playing && !after.jumping && frame === null) frame = sched().requestFrame(onFrame)
    }

    const startLoop = (): void => {
      if (frame !== null || get().jumping) return
      lastFrameT = sched().now()
      owedMin = 0
      frame = sched().requestFrame(onFrame)
    }

    return {
      ...INITIAL,

      loadScenario: async (id, overrides = {}, meta = {}) => {
        const token = ++loadToken
        jumpToken++
        stopLoop()
        set({ status: 'loading', error: null, scenarioId: id, playing: false, jumping: false })
        try {
          getScenario(id) // RangeError for an unknown id
          let pending = dataCache.get(id)
          if (!pending) {
            pending = loadScenarioData(id, getLoader())
            dataCache.set(id, pending)
            pending.catch(() => dataCache.delete(id))
          }
          const data = await pending
          if (token !== loadToken) return
          build(id, data, overrides, false)
          bumpClock(meta.origin ?? 'local')
        } catch (e) {
          if (token === loadToken) set({ status: 'error', error: errorText(e) })
        }
      },

      configure: (overrides, meta = {}) => {
        const s = get()
        const merged = { ...s.overrides, ...overrides }
        if (!s.data || !s.scenarioId) {
          set({ overrides: merged })
          return
        }
        jumpToken++
        stopLoop()
        set({ playing: false, jumping: false })
        build(s.scenarioId, s.data, merged, false)
        bumpClock(meta.origin ?? 'local')
      },

      reset: (meta = {}) => {
        const s = get()
        if (!s.data || !s.scenarioId) return
        jumpToken++
        stopLoop()
        set({ playing: false, jumping: false })
        build(s.scenarioId, s.data, s.overrides, false)
        bumpClock(meta.origin ?? 'local')
      },

      play: (meta = {}) => {
        const s = get()
        if (!s.world || s.world.finished || s.playing) return
        set({ playing: true })
        bumpClock(meta.origin ?? 'local')
        startLoop()
      },

      pause: (meta = {}) => {
        stopLoop()
        if (!get().playing) return
        set({ playing: false })
        bumpClock(meta.origin ?? 'local')
      },

      togglePlay: (meta = {}) => (get().playing ? get().pause(meta) : get().play(meta)),

      setSpeed: (speed, meta = {}) => {
        if (!isSimSpeed(speed)) throw new RangeError(`setSpeed: speed must be one of ${SIM_SPEEDS.join(', ')}`)
        if (get().speed === speed) return
        set({ speed })
        bumpClock(meta.origin ?? 'local')
      },

      step: (minutes) => {
        if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`step: minutes must be a non-negative integer (got ${minutes})`)
        advance(minutes)
      },

      jumpTo: async (target, meta = {}) => {
        const s0 = get()
        if (!s0.world || !s0.data || !s0.scenarioId) return
        const tTarget = resolveJumpTarget(target, s0.world)
        const token = ++jumpToken
        stopLoop()
        set({ jumping: true })
        try {
          let replay: AppliedInjection[] = []
          if (tTarget < s0.world.t) {
            replay = s0.applied.filter((a) => a.ok && a.t < tTarget)
            build(s0.scenarioId, s0.data, s0.overrides, true)
            set({ applied: replay })
          }
          const w = get().world as World
          let k = 0
          while (w.t < tTarget && !w.finished) {
            while (k < replay.length && replay[k].t <= w.t) applyOne(w, replay[k++].injection)
            const nextT = k < replay.length ? Math.min(replay[k].t, tTarget) : tTarget
            const n = Math.max(1, Math.min(SIM_CLOCK.jumpChunkMin, Math.ceil((nextT - w.t) / MINUTE_MS)))
            advance(n)
            await sched().yieldToUi()
            if (token !== jumpToken) return
          }
          while (k < replay.length && replay[k].t <= w.t) applyOne(w, replay[k++].injection)
          refresh()
        } finally {
          if (token === jumpToken) {
            set({ jumping: false })
            bumpClock(meta.origin ?? 'local')
            if (get().playing) startLoop()
          }
        }
      },

      inject: (input, meta = {}) => {
        const list = isInjectionList(input) ? input : [input]
        if (list.length === 0) return
        const origin = meta.origin ?? 'local'
        set((s) => ({ pending: [...s.pending, ...list.map((injection) => ({ injection, origin }))] }))
        const s = get()
        if (s.world && !s.playing && !s.jumping) {
          applyPending()
          refresh()
        }
      },

      flush: () => {
        if (!get().world) return
        applyPending()
        refresh()
      },

      syncClock: async (c, meta = { origin: 'remote' }) => {
        const origin = meta.origin ?? 'remote'
        if (!isSimSpeed(c.speed)) throw new RangeError(`syncClock: unsupported speed ${String(c.speed)}`)
        const s = get()
        const cfg = s.world?.config
        if (s.scenarioId !== c.scenarioId || !cfg || cfg.policy !== c.policy || cfg.seed !== c.seed) {
          await get().loadScenario(c.scenarioId, { ...s.overrides, policy: c.policy, seed: c.seed }, { origin })
        }
        const w = get().world
        if (!w) return
        if (get().speed !== c.speed) {
          set({ speed: c.speed })
          bumpClock(origin)
        }
        const tolerance = c.playing ? SIM_CLOCK.followToleranceMin * MINUTE_MS : 0
        if (Math.abs(w.t - c.t) > tolerance) await get().jumpTo(c.t, { origin })
        if (c.playing) get().play({ origin })
        else get().pause({ origin })
      },

      acceptRemotePayload: (payload) => {
        set((s) => {
          const prev = s.remotePayloads[payload.pseudonym]
          if (prev && prev.payload.t > payload.t) return {}
          return { remotePayloads: { ...s.remotePayloads, [payload.pseudonym]: { payload, receivedAt: s.view?.t ?? payload.t } } }
        })
      },

      acceptRemoteCheckin: (notice) => {
        set((s) => {
          const list = [...s.remoteCheckins, { ...notice }]
          return { remoteCheckins: list.length > DEVICE_LOG_LIMITS.remoteCheckins ? list.slice(-DEVICE_LOG_LIMITS.remoteCheckins) : list }
        })
      },

      dispose: () => {
        stopLoop()
        loadToken++
        jumpToken++
        set({ playing: false, jumping: false })
      },
    }
  })
}

/** The app's simulation store (browser loader and scheduler created lazily). Basis: {@link createSimStore}. */
export const simStore: SimStore = createSimStore()
