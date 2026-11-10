/**
 * Cross-tab sync bus — the prototype of the device ↔ console link (ARCHITECTURE §3: "sync bus (prototype:
 * BroadcastChannel + in-memory; production: site gateway, MQTT/HTTPS, SMS fallback)").
 *
 * Typed message schema:
 * - worker → supervisor: `payload` (exactly privacy.payloadForSync output), `worker_ack` (the worker acknowledged an
 *   alert), `checkin_done` ("a check-in happened" with the resulting level only — never the symptoms);
 * - supervisor → worker: `ack` (responder acknowledgement), `resolve` (case resolved), `reassign` (task / location);
 * - control: `clock` (scenario, policy, seed, time, play state, speed) so a follower tab replays the same world.
 *
 * Guarantees: every message is validated against an exact key list on send AND on receipt, and scanned for clinical
 * keys (CLINICAL_FIELDS and raw on-device keys), so nothing clinical can cross even from a buggy sender. Echo
 * protection: a bus ignores its own envelopes and duplicates (seen-id set), and changes applied from the bus are marked
 * `origin: 'remote'` in the stores so they are never re-broadcast. Without BroadcastChannel the bus is a graceful no-op.
 */
import { RISK_LEVELS, type RiskLevel } from '../engine/types'
import { CLINICAL_FIELDS, SYNC_PAYLOAD_KEYS, SYNC_PAYLOAD_VERSION, payloadForSync, type SyncPayload } from '../engine/privacy'
import { ACK_ROLES } from '../engine/alerts'
import type { WorkerLocation } from '../engine/risk'
import { MINUTE_MS } from '../engine/time'
import { ACTION_IDS } from '../i18n'
import { POLICY_IDS, type PolicyId, type WorldInjection } from '../sim/types'
import { SCENARIO_IDS, type ScenarioId } from '../sim/scenarios'
import { isSimSpeed, type AppliedInjection, type ChangeOrigin, type SimSpeed, type SimStore, type SimStoreState } from './simStore'
import { caseStatus } from './selectors'

// ─────────────────────────────── Schema ───────────────────────────────

/** Envelope schema version. [ENG] */
export const SYNC_BUS_VERSION = 1
/** BroadcastChannel name. Basis: task brief (BroadcastChannel('zill')). */
export const SYNC_CHANNEL_NAME = 'zill'

/** Roles that acknowledge from a console (worker acknowledgements travel as `worker_ack`). Basis: alerts.ts ACK_ROLES. */
export type ResponderRole = 'buddy' | 'supervisor' | 'first_aider' | 'occ_health'
/** Roles that may resolve a case. Basis: sim/types.ts WorldInjection 'resolve'; alerts.ts CLINICAL_RESOLVER_ROLES. */
export type ResolverRole = 'first_aider' | 'supervisor' | 'occ_health'

/** Every message the bus carries. */
export type SyncMessage =
  | { kind: 'payload'; payload: SyncPayload }
  | { kind: 'worker_ack'; workerId: string; alertId: string; t: number }
  | { kind: 'checkin_done'; workerId: string; t: number; level: RiskLevel }
  | { kind: 'ack'; alertId: string; role: ResponderRole; actorId: string; t: number }
  | { kind: 'resolve'; workerId: string; alertId: string | null; by: ResolverRole; actorId: string; t: number }
  | { kind: 'reassign'; workerId: string; taskId: string | null; location: WorkerLocation; actorId: string; t: number }
  | { kind: 'clock'; scenarioId: ScenarioId; policy: PolicyId; seed: string; t: number; playing: boolean; speed: SimSpeed }

/** A message kind. */
export type SyncMessageKind = SyncMessage['kind']

/** The exact keys of each message kind (validated on send and receipt). Basis: ARCHITECTURE §1 principle 5 (minimal payload). */
export const SYNC_MESSAGE_KEYS: Readonly<Record<SyncMessageKind, readonly string[]>> = Object.freeze({
  payload: ['kind', 'payload'],
  worker_ack: ['kind', 'workerId', 'alertId', 't'],
  checkin_done: ['kind', 'workerId', 't', 'level'],
  ack: ['kind', 'alertId', 'role', 'actorId', 't'],
  resolve: ['kind', 'workerId', 'alertId', 'by', 'actorId', 't'],
  reassign: ['kind', 'workerId', 'taskId', 'location', 'actorId', 't'],
  clock: ['kind', 'scenarioId', 'policy', 'seed', 't', 'playing', 'speed'],
})

/** Direction of each message kind (data-flow inspector). Basis: ARCHITECTURE §3. */
export const SYNC_MESSAGE_DIRECTION: Readonly<Record<SyncMessageKind, 'worker_to_supervisor' | 'supervisor_to_worker' | 'control'>> = Object.freeze({
  payload: 'worker_to_supervisor',
  worker_ack: 'worker_to_supervisor',
  checkin_done: 'worker_to_supervisor',
  ack: 'supervisor_to_worker',
  resolve: 'supervisor_to_worker',
  reassign: 'supervisor_to_worker',
  clock: 'control',
})

/** The wire envelope. */
export interface SyncEnvelope {
  v: typeof SYNC_BUS_VERSION
  /** Unique message id (`${origin}#${seq}`). */
  id: string
  /** Sending bus (one per tab). */
  origin: string
  seq: number
  msg: SyncMessage
}

const ENVELOPE_KEYS: readonly string[] = ['v', 'id', 'origin', 'seq', 'msg']

/**
 * Keys that may never appear anywhere in a sync message: every clinical projection field (privacy.ts CLINICAL_FIELDS)
 * and the raw on-device / ground-truth keys they come from. Basis: ARCHITECTURE §1 principle 5 ("information leaves the
 * device only as level + action"), §3 outbound payload.
 */
export const SYNC_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...CLINICAL_FIELDS,
    'drivers',
    'detail',
    'truth',
    'checkin',
    'symptoms',
    'urineColor',
    'riskFlags',
    'consent',
    'ageYears',
    'displayName',
    'physioDisplay',
    'lastHrBpm',
    'hrTrueBpm',
    'hrMeasuredBpm',
    'ectempC',
    'coreC',
    'coreTrueC',
    'dehydrationPct',
    'assessment',
    'profile',
  ]),
])

/** Every forbidden key found anywhere in `value` (recursive). Basis: {@link SYNC_FORBIDDEN_KEYS}. */
export function findForbiddenKeys(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    for (const [k, x] of Object.entries(v)) {
      if (SYNC_FORBIDDEN_KEYS.includes(k)) found.add(k)
      walk(x, depth + 1)
    }
  }
  walk(value, 0)
  return [...found]
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o)
  return own.length === keys.length && own.every((k) => keys.includes(k))
}
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isLevel = (x: unknown): x is RiskLevel => typeof x === 'string' && (RISK_LEVELS as readonly string[]).includes(x)
const ACK_STATUSES: readonly string[] = ['none', 'active', 'acknowledged', 'escalated', 'resolved']
const RESPONDER_ROLES: readonly string[] = ACK_ROLES.filter((r) => r !== 'worker')
const RESOLVER_ROLES: readonly string[] = ['first_aider', 'supervisor', 'occ_health']
const LOCATIONS: readonly string[] = ['sun', 'shade', 'indoor_cool']

/** True for a well-formed privacy.SyncPayload with exactly its keys. Basis: privacy.ts SYNC_PAYLOAD_KEYS. */
export function isSyncPayload(x: unknown): x is SyncPayload {
  if (!isObj(x) || !exactKeys(x, SYNC_PAYLOAD_KEYS)) return false
  return (
    x.v === SYNC_PAYLOAD_VERSION &&
    isId(x.pseudonym) &&
    isId(x.crewId) &&
    isLevel(x.level) &&
    Array.isArray(x.actions) &&
    x.actions.every((a) => typeof a === 'string' && (ACTION_IDS as readonly string[]).includes(a)) &&
    typeof x.workMinPerHour === 'number' &&
    x.workMinPerHour >= 0 &&
    x.workMinPerHour <= 60 &&
    typeof x.waterMlPerHour === 'number' &&
    x.waterMlPerHour >= 0 &&
    typeof x.ack === 'string' &&
    ACK_STATUSES.includes(x.ack) &&
    isTime(x.t) &&
    (x.confidence === 'high' || x.confidence === 'medium' || x.confidence === 'low')
  )
}

/** True for a well-formed {@link SyncMessage} with exactly the keys of its kind and no forbidden key. */
export function isSyncMessage(x: unknown): x is SyncMessage {
  if (!isObj(x) || typeof x.kind !== 'string' || !(x.kind in SYNC_MESSAGE_KEYS)) return false
  const kind = x.kind as SyncMessageKind
  if (!exactKeys(x, SYNC_MESSAGE_KEYS[kind]) || findForbiddenKeys(x).length > 0) return false
  switch (kind) {
    case 'payload':
      return isSyncPayload(x.payload)
    case 'worker_ack':
      return isId(x.workerId) && isId(x.alertId) && isTime(x.t)
    case 'checkin_done':
      return isId(x.workerId) && isTime(x.t) && isLevel(x.level)
    case 'ack':
      return isId(x.alertId) && typeof x.role === 'string' && RESPONDER_ROLES.includes(x.role) && isId(x.actorId) && isTime(x.t)
    case 'resolve':
      return isId(x.workerId) && (x.alertId === null || isId(x.alertId)) && typeof x.by === 'string' && RESOLVER_ROLES.includes(x.by) && isId(x.actorId) && isTime(x.t)
    case 'reassign':
      return isId(x.workerId) && (x.taskId === null || isId(x.taskId)) && typeof x.location === 'string' && LOCATIONS.includes(x.location) && isId(x.actorId) && isTime(x.t)
    case 'clock':
      return (
        typeof x.scenarioId === 'string' &&
        (SCENARIO_IDS as readonly string[]).includes(x.scenarioId) &&
        typeof x.policy === 'string' &&
        (POLICY_IDS as readonly string[]).includes(x.policy) &&
        isId(x.seed) &&
        isTime(x.t) &&
        typeof x.playing === 'boolean' &&
        isSimSpeed(x.speed)
      )
  }
}

/** Parses a received envelope; null when malformed, from another schema version, or carrying a forbidden key. */
export function parseEnvelope(raw: unknown): SyncEnvelope | null {
  if (!isObj(raw) || !exactKeys(raw, ENVELOPE_KEYS)) return null
  if (raw.v !== SYNC_BUS_VERSION || !isId(raw.id) || !isId(raw.origin) || !isTime(raw.seq) || !isSyncMessage(raw.msg)) return null
  return raw as unknown as SyncEnvelope
}

// ─────────────────────────────── Channels ───────────────────────────────

/** The subset of BroadcastChannel the bus uses. */
export interface ChannelLike {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

/** Opens a channel by name; null when channels are unavailable. */
export type ChannelFactory = (name: string) => ChannelLike | null

/** BroadcastChannel factory, or null when the runtime has none (bus becomes a no-op). Node channels are unref'd. */
export function broadcastChannelFactory(): ChannelFactory | null {
  if (typeof BroadcastChannel !== 'function') return null
  return (name) => {
    const ch = new BroadcastChannel(name)
    ;(ch as unknown as { unref?: () => void }).unref?.()
    return ch as unknown as ChannelLike
  }
}

/** An in-memory channel hub (same-process tabs in tests, or demos without BroadcastChannel). */
export interface MemoryChannelHub {
  factory: ChannelFactory
  /** Every message posted on the hub (structured clones), oldest first. */
  posted: Array<{ name: string; data: unknown }>
  /** Resolves once every queued delivery has run. */
  settle(): Promise<void>
}

/**
 * In-memory BroadcastChannel stand-in: structured-clone delivery to every other open channel of the same name,
 * asynchronously, never to the sender. Basis: HTML BroadcastChannel semantics [ENG].
 */
export function createMemoryChannelHub(): MemoryChannelHub {
  const open = new Set<{ name: string; ch: ChannelLike }>()
  const posted: Array<{ name: string; data: unknown }> = []
  let queue: Promise<void> = Promise.resolve()
  const factory: ChannelFactory = (name) => {
    let closed = false
    const self = {
      name,
      ch: {
        onmessage: null,
        postMessage(data: unknown) {
          if (closed) throw new Error('InvalidStateError: channel is closed')
          const copy: unknown = structuredClone(data)
          posted.push({ name, data: copy })
          for (const other of [...open]) {
            if (other === self || other.name !== name) continue
            queue = queue.then(() => {
              if (open.has(other)) other.ch.onmessage?.({ data: structuredClone(copy) })
            })
          }
        },
        close() {
          closed = true
          open.delete(self)
        },
      } as ChannelLike,
    }
    open.add(self)
    return self.ch
  }
  return {
    factory,
    posted,
    settle: async () => {
      let seen: Promise<void>
      do {
        seen = queue
        await seen
      } while (seen !== queue)
    },
  }
}

// ─────────────────────────────── Bus ───────────────────────────────

/** Bus counters (governance / debug panel). */
export interface SyncBusStats {
  sent: number
  received: number
  droppedEcho: number
  droppedDuplicate: number
  rejected: number
}

/** Outcome of {@link SyncBus.send}. */
export type SendResult = { ok: true; envelope: SyncEnvelope } | { ok: false; reason: 'unavailable' | 'invalid' | 'forbidden_keys' | 'closed' | 'post_failed' }

/** Receives a validated message from another tab. */
export type SyncListener = (msg: SyncMessage, envelope: SyncEnvelope) => void

/** A sync bus endpoint (one per tab). */
export interface SyncBus {
  readonly name: string
  readonly origin: string
  /** False without BroadcastChannel (or after close): send() is then a no-op. */
  readonly available: boolean
  send(msg: SyncMessage): SendResult
  subscribe(listener: SyncListener): () => void
  stats(): SyncBusStats
  close(): void
}

/** Options of {@link createSyncBus}. */
export interface SyncBusOptions {
  /** Channel name (default 'zill'). */
  name?: string
  /** This endpoint's id (default a random UUID). */
  origin?: string
  /** Channel factory; default BroadcastChannel when present; null forces the no-op bus. */
  factory?: ChannelFactory | null
  /** How many message ids are remembered for duplicate suppression (default 500). */
  seenLimit?: number
}

let originCounter = 0
function newOrigin(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `tab-${uuid}` : `tab-${++originCounter}`
}

/**
 * Creates a bus endpoint. Messages are validated (exact keys, types, no forbidden key) before posting and after
 * receipt; own and duplicate envelopes are dropped; a throwing listener never breaks delivery to the others.
 * Basis: ARCHITECTURE §3 (sync bus), §1 principle 5; [ENG] echo protection.
 */
export function createSyncBus(opts: SyncBusOptions = {}): SyncBus {
  const name = opts.name ?? SYNC_CHANNEL_NAME
  const origin = opts.origin ?? newOrigin()
  const factory = opts.factory === undefined ? broadcastChannelFactory() : opts.factory
  let channel: ChannelLike | null = null
  try {
    channel = factory ? factory(name) : null
  } catch {
    channel = null
  }
  const listeners = new Set<SyncListener>()
  const seen = new Set<string>()
  const seenOrder: string[] = []
  const seenLimit = opts.seenLimit ?? 500
  const counters: SyncBusStats = { sent: 0, received: 0, droppedEcho: 0, droppedDuplicate: 0, rejected: 0 }
  let seq = 0
  let closed = false
  const remember = (id: string): void => {
    seen.add(id)
    seenOrder.push(id)
    while (seenOrder.length > seenLimit) seen.delete(seenOrder.shift() as string)
  }
  if (channel) {
    channel.onmessage = (event) => {
      if (closed) return
      const env = parseEnvelope(event.data)
      if (!env) {
        counters.rejected++
        return
      }
      if (env.origin === origin) {
        counters.droppedEcho++
        return
      }
      if (seen.has(env.id)) {
        counters.droppedDuplicate++
        return
      }
      remember(env.id)
      counters.received++
      for (const listener of [...listeners]) {
        try {
          listener(env.msg, env)
        } catch {
          // A failing view must not stop delivery to the others.
        }
      }
    }
  }
  return {
    name,
    origin,
    get available() {
      return channel !== null && !closed
    },
    send(msg) {
      if (closed) return { ok: false, reason: 'closed' }
      if (findForbiddenKeys(msg).length > 0) {
        counters.rejected++
        return { ok: false, reason: 'forbidden_keys' }
      }
      if (!isSyncMessage(msg)) {
        counters.rejected++
        return { ok: false, reason: 'invalid' }
      }
      if (!channel) return { ok: false, reason: 'unavailable' }
      const n = ++seq
      const envelope: SyncEnvelope = { v: SYNC_BUS_VERSION, id: `${origin}#${n}`, origin, seq: n, msg: JSON.parse(JSON.stringify(msg)) as SyncMessage }
      try {
        channel.postMessage(envelope)
      } catch {
        return { ok: false, reason: 'post_failed' }
      }
      remember(envelope.id)
      counters.sent++
      return { ok: true, envelope }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stats: () => ({ ...counters }),
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      try {
        channel?.close()
      } catch {
        // already closed
      }
    },
  }
}

let appBus: SyncBus | null = null
/** The app's bus endpoint, created on first use (never at import). Basis: {@link createSyncBus}. */
export function getSyncBus(): SyncBus {
  return (appBus ??= createSyncBus())
}

// ─────────────────────────────── Simulation ↔ bus ───────────────────────────────

/** Re-send an unchanged device payload after this many simulated minutes. [ENG] keeps a late-opened console current. */
export const PAYLOAD_HEARTBEAT_MIN = 5
/** Re-send the shared clock after this many simulated minutes while playing. [ENG] */
export const CLOCK_HEARTBEAT_MIN = 15

/** Options of {@link connectSimToBus}. */
export interface SimBusOptions {
  /** The worker whose phone this tab is (publishes that worker's payloads); null/absent for a console tab. */
  deviceWorkerId?: () => string | null
  /** Broadcast this tab's local clock changes (one leader tab). */
  shareClock?: boolean
  /** Follow clock messages from other tabs. */
  followClock?: boolean
  /** Actor id stamped on outbound console actions (resolve, reassign) and acks without one. */
  actorId?: () => string
  heartbeatMin?: number
}

const REMOTE: { origin: ChangeOrigin } = Object.freeze({ origin: 'remote' as ChangeOrigin })

/** The bus message for a locally applied injection (null when it does not leave the tab). Basis: message schema above. */
export function messageForInjection(a: AppliedInjection, state: Pick<SimStoreState, 'view'>, actorId: string | null): SyncMessage | null {
  const inj: WorldInjection = a.injection
  switch (inj.kind) {
    case 'ack': {
      if (inj.role === 'worker') {
        const workerId = inj.actorId ?? state.view?.alerts.find((x) => x.id === inj.alertId)?.workerId
        return workerId ? { kind: 'worker_ack', workerId, alertId: inj.alertId, t: a.t } : null
      }
      if (!RESPONDER_ROLES.includes(inj.role)) return null
      return { kind: 'ack', alertId: inj.alertId, role: inj.role as ResponderRole, actorId: inj.actorId ?? actorId ?? inj.role, t: a.t }
    }
    case 'resolve':
      return { kind: 'resolve', workerId: inj.workerId, alertId: inj.alertId ?? null, by: inj.by, actorId: actorId ?? inj.by, t: a.t }
    case 'task':
      return { kind: 'reassign', workerId: inj.workerId, taskId: inj.taskId, location: inj.location, actorId: actorId ?? 'supervisor', t: a.t }
    default:
      return null // check-ins become `checkin_done` (level only); drinks stay on the device; system toggles are Lab-only
  }
}

/** The world injection for an inbound action message (null for data messages). Basis: sim/types.ts WorldInjection. */
export function injectionForMessage(msg: SyncMessage): WorldInjection | null {
  switch (msg.kind) {
    case 'worker_ack':
      return { kind: 'ack', alertId: msg.alertId, role: 'worker', actorId: msg.workerId }
    case 'ack':
      return { kind: 'ack', alertId: msg.alertId, role: msg.role, actorId: msg.actorId }
    case 'resolve':
      return { kind: 'resolve', workerId: msg.workerId, ...(msg.alertId ? { alertId: msg.alertId } : {}), by: msg.by }
    case 'reassign':
      return { kind: 'task', workerId: msg.workerId, taskId: msg.taskId, location: msg.location }
    default:
      return null
  }
}

/**
 * Wires a simulation store to a bus. Outbound: locally applied acknowledgements, resolutions and reassignments; for a
 * device tab, the device worker's sync payload (on change, else every {@link PAYLOAD_HEARTBEAT_MIN}); a
 * `checkin_done` notice with the resulting level once the engine has processed a local check-in; the clock when
 * `shareClock`. Inbound: actions become `origin: 'remote'` injections (never re-broadcast), payloads and check-in
 * notices are stored for the console, clocks are followed when `followClock`. Returns the disconnect function.
 * Basis: ARCHITECTURE §3 (outbound {pseudonym, level, actions, workMinPerHour, ack}), §1 principle 5.
 */
export function connectSimToBus(sim: SimStore, bus: SyncBus, opts: SimBusOptions = {}): () => void {
  const heartbeatMs = (opts.heartbeatMin ?? PAYLOAD_HEARTBEAT_MIN) * MINUTE_MS
  let lastSeq = 0
  for (const a of sim.getState().applied) lastSeq = Math.max(lastSeq, a.seq)
  let lastPayloadKey = ''
  let lastPayloadT = -Infinity
  const pendingCheckins = new Map<string, number>()
  let lastClockRev = sim.getState().clock.rev
  let lastClockSentT = -Infinity

  const sendClock = (s: SimStoreState): void => {
    if (!s.scenarioId || !s.world) return
    const r = bus.send({ kind: 'clock', scenarioId: s.scenarioId, policy: s.world.config.policy, seed: s.world.config.seed, t: s.world.t, playing: s.playing, speed: s.speed })
    if (r.ok) lastClockSentT = s.world.t
  }

  const devicePayload = (s: SimStoreState): void => {
    const id = opts.deviceWorkerId?.() ?? null
    if (!id || !s.view) return
    const wv = s.view.workers.find((w) => w.profile.id === id)
    if (!wv?.assessment) return
    const payload = payloadForSync(wv.assessment, wv.profile, caseStatus(s.view.alerts, id).ackStatus)
    const key = JSON.stringify({ ...payload, t: 0 })
    if (key === lastPayloadKey && payload.t >= lastPayloadT && payload.t - lastPayloadT < heartbeatMs) return
    if (bus.send({ kind: 'payload', payload }).ok) {
      lastPayloadKey = key
      lastPayloadT = payload.t
    }
  }

  const checkinNotices = (s: SimStoreState): void => {
    if (!s.view) return
    for (const [workerId, t] of pendingCheckins) {
      const wv = s.view.workers.find((w) => w.profile.id === workerId)
      if (!wv || s.view.t < t) {
        pendingCheckins.delete(workerId) // rewound before the check-in, or unknown worker
        continue
      }
      if (s.view.t === t) continue // not processed by the engine yet
      if (wv.assessment) bus.send({ kind: 'checkin_done', workerId, t, level: wv.assessment.level })
      pendingCheckins.delete(workerId)
    }
  }

  const unsubStore = sim.subscribe((s, prev) => {
    if (s.applied !== prev.applied) {
      for (const a of s.applied) {
        if (a.seq <= lastSeq) continue
        lastSeq = a.seq
        if (!a.ok || a.origin !== 'local') continue
        if (a.injection.kind === 'checkin') pendingCheckins.set(a.injection.checkin.workerId, a.t)
        const msg = messageForInjection(a, s, opts.actorId?.() ?? null)
        if (msg) bus.send(msg)
      }
    }
    if (s.view && s.view !== prev.view) {
      devicePayload(s)
      checkinNotices(s)
    }
    if (s.clock.rev !== lastClockRev) {
      lastClockRev = s.clock.rev
      if (opts.shareClock && s.clock.origin === 'local') sendClock(s)
    } else if (opts.shareClock && s.playing && s.world && s.world.t - lastClockSentT >= CLOCK_HEARTBEAT_MIN * MINUTE_MS) {
      sendClock(s)
    }
  })

  const unsubBus = bus.subscribe((msg) => {
    const st = sim.getState()
    if (msg.kind === 'payload') st.acceptRemotePayload(msg.payload)
    else if (msg.kind === 'checkin_done') st.acceptRemoteCheckin({ workerId: msg.workerId, t: msg.t, level: msg.level })
    else if (msg.kind === 'clock') {
      if (opts.followClock) {
        st.syncClock({ scenarioId: msg.scenarioId, policy: msg.policy, seed: msg.seed, t: msg.t, playing: msg.playing, speed: msg.speed }, REMOTE).catch(() => undefined)
      }
    } else {
      const injection = injectionForMessage(msg)
      if (injection && st.world) st.inject(injection, REMOTE)
    }
  })

  return () => {
    unsubStore()
    unsubBus()
  }
}
