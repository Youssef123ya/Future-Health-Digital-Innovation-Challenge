/**
 * Governance state (ARCHITECTURE §7, §9 #/governance): the hash-chained audit log (privacy.ts AuditLog), the consent
 * ledger with receipts (createConsentReceipt; grant/revoke), "who saw my data" per worker, chain verification, the
 * tamper demo, the prohibited-request demo (employer HR asks for heart rate for a performance review → refused and
 * logged) and the data-flow inspector feed (inspectSyncPayload of each worker's outbound payload).
 *
 * Audit de-duplication [ENG]: the selectors run on every render, so `record()` appends an access only when it differs
 * from the last one logged for the same actor, purpose and subject (decision, fields or reason changed), or when
 * {@link AUDIT_RELOG_MS} of simulated time has passed — continued access stays visible to the worker without flooding
 * the chain. The appended entry is exactly the one `projectAndLog` would append (`ProjectionResult.audit`). Demo
 * requests always log.
 *
 * Node-safe: no `window` at import; Web Crypto (`crypto.subtle`) is used only when an entry is appended.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AuditEntry, ConsentState, DataField, LangCode, WorkerProfile } from '../engine/types'
import {
  AuditLog,
  createConsentReceipt,
  grantConsent,
  inspectSyncPayload,
  projectAndLog,
  revokeConsent,
  type AccessRequest,
  type AuditAnchor,
  type AuditDraft,
  type AuditVerification,
  type ConsentCollector,
  type ConsentMethod,
  type ConsentReceipt,
  type ConsentScope,
  type ProjectionResult,
  type SyncInspection,
  type WorkerSnapshot,
} from '../engine/privacy'
import { MINUTE_MS } from '../engine/time'
import { caseIndex, profileWithConsent, type SelectorInput } from './selectors'
import type { SimStore } from './simStore'
import type { WorldInjection } from '../sim/types'

/** Re-log interval for an unchanged access (simulated time). [ENG] one alert-policy cycle; see module note. */
export const AUDIT_RELOG_MS = 15 * MINUTE_MS

/** Default actor of the prohibited-purpose demo. */
export const PROHIBITED_DEMO_ACTOR = 'HR-1'

/** Request of the prohibited-purpose demo. Basis: types.ts PROHIBITED_PURPOSES; privacy.ts PROHIBITION_BASIS. */
export const PROHIBITED_DEMO_REQUEST: Readonly<Omit<AccessRequest, 'actorId'>> = Object.freeze({
  role: 'employer_hr',
  purpose: 'performance_management',
  fields: Object.freeze(['hrBpm']) as readonly DataField[],
})

/** A consent change made by (or for) a worker. */
export interface ConsentChangeInput {
  workerId: string
  scope: ConsentScope
  /** Time of the change (simulated epoch ms). */
  t: number
  /** Language the notice was shown in. */
  language: LangCode
  /** Default 'electronic_affirmative_action'. */
  method?: ConsentMethod
  /** Default 'self'. A supervisor can never collect consent (createConsentReceipt throws). */
  collectedBy?: ConsentCollector
  witnessId?: string
  /** Consent to start from when the worker is not in the ledger yet (else the ledger must be seeded). */
  base?: ConsentState
}

/** Result of the tamper demo. */
export interface TamperDemoResult {
  index: number
  patch: Partial<AuditEntry>
  originalEntry: AuditEntry
  tamperedEntry: AuditEntry
  /** verify() on the tampered COPY (breaks at `index`). */
  tampered: AuditVerification
  /** verify() on the real log (unchanged, still valid). */
  original: AuditVerification
}

/** Result of the prohibited-request demo. */
export interface ProhibitedDemoResult {
  request: AccessRequest
  result: ProjectionResult & { entry: AuditEntry }
}

/** A worker's outbound payload as shown by the data-flow inspector. */
export interface DataFlowItem {
  workerId: string
  crewId: string
  inspection: SyncInspection
}

/** State and actions of the governance store. */
export interface GovernanceState {
  log: AuditLog
  /** Mirror of the log entries (frozen), oldest first — for rendering. */
  entries: readonly AuditEntry[]
  head: AuditAnchor
  /** Head published with publishAnchor() (verify(anchor) then also detects truncation and rewriting). */
  anchor: AuditAnchor | null
  verification: AuditVerification | null
  tamperDemo: TamperDemoResult | null
  prohibitedDemo: ProhibitedDemoResult | null
  consent: Readonly<Record<string, ConsentState>>
  receipts: readonly ConsentReceipt[]
  auditError: string | null

  /** Adds each profile's consent to the ledger (existing ledger entries are kept unless `overwrite`). */
  seedConsent(profiles: readonly WorkerProfile[], opts?: { overwrite?: boolean }): void
  grant(input: ConsentChangeInput): ConsentReceipt
  revoke(input: ConsentChangeInput): ConsentReceipt
  /** Appends one access (de-duplicated, see module note); resolves to the entry, or null when skipped. */
  record(draft: AuditDraft): Promise<AuditEntry | null>
  recordAll(drafts: readonly AuditDraft[]): Promise<void>
  /** "Who saw my data": every logged access about the worker, refusals included, oldest first. */
  whoSawMyData(workerId: string): AuditEntry[]
  publishAnchor(): AuditAnchor
  verify(): Promise<AuditVerification>
  runTamperDemo(opts?: { index?: number; patch?: Partial<AuditEntry> }): Promise<TamperDemoResult>
  runProhibitedRequestDemo(snapshot: WorkerSnapshot, now: number, actorId?: string): Promise<ProhibitedDemoResult>
  /** Resolves once every pending append has completed. */
  flush(): Promise<void>
  reset(): void
}

/** A governance store. */
export type GovernanceStore = StoreApi<GovernanceState>

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** De-duplication key of an access: actor, purpose, subject (or the aggregate's dimensions). [ENG] */
export function auditKey(d: AuditDraft): string {
  return [d.actorRole, d.actorId, d.purpose, d.subjectId ?? `aggregate:${d.fields.join(',')}`].join('|')
}

/** What must change for an access to be logged again before the re-log interval. [ENG] */
export function auditSignature(d: AuditDraft): string {
  return `${d.decision}|${d.fields.join(',')}|${d.reason}`
}

/** Entries about one worker (pure helper over the mirror). Basis: privacy.ts AuditLog.forSubject. */
export function entriesForSubject(entries: readonly AuditEntry[], workerId: string): AuditEntry[] {
  return entries.filter((e) => e.subjectId === workerId)
}

/**
 * The data-flow inspector feed: for each worker with an assessment, the exact payload that leaves the device, its JSON,
 * byte size and everything kept on the device (privacy.inspectSyncPayload). Basis: ARCHITECTURE §3 (outbound payload),
 * §9 (governance centre: data-flow inspector).
 */
export function buildDataFlowFeed(input: SelectorInput): DataFlowItem[] {
  const cases = caseIndex(input.view.alerts)
  const out: DataFlowItem[] = []
  for (const wv of input.view.workers) {
    if (!wv.assessment) continue
    const profile = profileWithConsent(input, wv.profile)
    out.push({ workerId: profile.id, crewId: profile.crewId, inspection: inspectSyncPayload(wv.assessment, profile, cases.get(profile.id)?.ackStatus ?? 'none') })
  }
  return out
}

/**
 * Creates a governance store with an empty audit log and consent ledger. Basis: ARCHITECTURE §7 (consent scopes
 * opt-in and revocable; append-only SHA-256 audit chain; "who saw my data"; verify() detects tampering); privacy.ts.
 */
export function createGovernanceStore(): GovernanceStore {
  let lastLogged = new Map<string, { sig: string; t: number }>()
  let tail: Promise<unknown> = Promise.resolve()

  return createStore<GovernanceState>()((set, get) => {
    const mirror = (log: AuditLog): void => {
      if (get().log === log) set({ entries: log.all(), head: log.head() })
    }
    /** Remembers an append so flush() can wait for it; `tail` itself never rejects (no unhandled rejection). */
    const track = <T>(p: Promise<T>): Promise<T> => {
      const settled = p.then(
        () => undefined,
        () => undefined,
      )
      tail = tail.then(() => settled)
      return p
    }
    const change = (input: ConsentChangeInput, action: 'granted' | 'revoked'): ConsentReceipt => {
      const base = get().consent[input.workerId] ?? input.base
      if (!base) throw new RangeError(`consent: worker '${input.workerId}' is not in the ledger (seedConsent first or pass base)`)
      const receipt = createConsentReceipt({
        subjectId: input.workerId,
        scope: input.scope,
        action,
        t: input.t,
        language: input.language,
        method: input.method ?? 'electronic_affirmative_action',
        collectedBy: input.collectedBy ?? 'self',
        ...(input.witnessId ? { witnessId: input.witnessId } : {}),
      })
      const next = action === 'granted' ? grantConsent(base, input.scope, input.t) : revokeConsent(base, input.scope, input.t)
      set((s) => ({ consent: { ...s.consent, [input.workerId]: next }, receipts: [...s.receipts, receipt] }))
      return receipt
    }

    const log0 = new AuditLog()
    return {
      log: log0,
      entries: [],
      head: log0.head(),
      anchor: null,
      verification: null,
      tamperDemo: null,
      prohibitedDemo: null,
      consent: {},
      receipts: [],
      auditError: null,

      seedConsent: (profiles, opts = {}) => {
        set((s) => {
          const consent = { ...s.consent }
          let changed = false
          for (const p of profiles) {
            if (!opts.overwrite && consent[p.id]) continue
            consent[p.id] = { ...p.consent }
            changed = true
          }
          return changed ? { consent } : {}
        })
      },

      grant: (input) => change(input, 'granted'),
      revoke: (input) => change(input, 'revoked'),

      record: (draft) => {
        const key = auditKey(draft)
        const sig = auditSignature(draft)
        const last = lastLogged.get(key)
        if (last && last.sig === sig && draft.t >= last.t && draft.t - last.t < AUDIT_RELOG_MS) return Promise.resolve(null)
        lastLogged.set(key, { sig, t: draft.t })
        const log = get().log
        return track(
          log.append(draft).then(
            (entry) => {
              mirror(log)
              return entry
            },
            (e: unknown) => {
              lastLogged.delete(key)
              set({ auditError: errorText(e) })
              return null
            },
          ),
        )
      },

      recordAll: async (drafts) => {
        await Promise.all(drafts.map((d) => get().record(d)))
      },

      whoSawMyData: (workerId) => get().log.forSubject(workerId),

      publishAnchor: () => {
        const anchor = get().log.head()
        set({ anchor })
        return anchor
      },

      verify: async () => {
        await get().flush()
        const { log, anchor } = get()
        const verification = await log.verify(anchor ?? undefined)
        set({ verification })
        return verification
      },

      runTamperDemo: async (opts = {}) => {
        await get().flush()
        const log = get().log
        if (log.length === 0) throw new RangeError('runTamperDemo: the audit log is empty')
        const index = opts.index ?? Math.floor(log.length / 2)
        const originalEntry = log.all()[index]
        if (!originalEntry) throw new RangeError(`runTamperDemo: no entry at position ${index}`)
        // Default edit: hide who accessed the data and flip the decision, as someone covering an access would.
        const patch: Partial<AuditEntry> = opts.patch ?? {
          actorId: 'someone-else',
          decision: originalEntry.decision === 'allowed' ? 'denied' : 'allowed',
        }
        const copy = log.demoTamper(index, patch)
        const result: TamperDemoResult = {
          index,
          patch,
          originalEntry,
          tamperedEntry: copy.all()[index],
          tampered: await copy.verify(),
          original: await log.verify(),
        }
        set({ tamperDemo: result })
        return result
      },

      runProhibitedRequestDemo: async (snapshot, now, actorId = PROHIBITED_DEMO_ACTOR) => {
        const request: AccessRequest = { ...PROHIBITED_DEMO_REQUEST, fields: [...(PROHIBITED_DEMO_REQUEST.fields ?? [])], actorId }
        const log = get().log
        const result = await track(projectAndLog(log, snapshot, request, { now, escalated: false }))
        mirror(log)
        const demo: ProhibitedDemoResult = { request, result }
        set({ prohibitedDemo: demo })
        return demo
      },

      flush: async () => {
        let seen: Promise<unknown>
        do {
          seen = tail
          await seen
        } while (seen !== tail)
      },

      reset: () => {
        lastLogged = new Map()
        tail = Promise.resolve()
        const log = new AuditLog()
        set({ log, entries: [], head: log.head(), anchor: null, verification: null, tamperDemo: null, prohibitedDemo: null, consent: {}, receipts: [], auditError: null })
      },
    }
  })
}

/** Options of {@link connectGovernanceToSim}. */
export interface GovernanceSimOptions {
  /**
   * The worker whose phone this tab is: only that worker's consent changes are injected into this tab's world (a
   * multi-tab demo, one phone per tab; return null in a console tab, which then injects nothing). Omit it in a
   * single-tab app, where the one world simulates every worker's device, so every grant/revoke made in the tab reaches
   * that worker's device.
   */
  deviceWorkerId?: () => string | null
}

/** Consent scopes compared when deciding whether the device must be told (updatedAt alone is not a change). */
const CONSENT_SCOPE_KEYS = ['wearable', 'healthFlags', 'checkins', 'shareWithMedicOnEscalation', 'aggregateStatistics'] as const

/** Same choice in every scope (ignores `updatedAt`). Basis: engine/types.ts ConsentState. */
export function sameConsentScopes(a: ConsentState, b: ConsentState): boolean {
  return CONSENT_SCOPE_KEYS.every((k) => a[k] === b[k])
}

/**
 * Seeds the consent ledger from every new world's roster (existing ledger choices are kept, so a worker's revocation
 * survives a scenario reload), and makes the device world follow the ledger: whenever a worker's ledger consent differs
 * from what their simulated device uses — after grant/revoke, on a new world (reset, reload, policy change) or once a
 * backward jump has replayed the earlier injections — a `{ kind: 'consent' }` injection goes through `sim.inject`, so the
 * on-device engine stops (or resumes) using wearable, check-in or health-flag data from that minute (sim/worldsim.ts
 * applyConsent). Device side only: the injection never leaves the tab (syncBus messageForInjection forwards only acks,
 * resolutions and reassignments), and nothing clinical crosses the bus. Nothing is injected into a finished shift.
 * Returns the unsubscribe function. Basis: ARCHITECTURE §1.5, §7 (consent opt-in per scope, revocable at any time).
 */
export function connectGovernanceToSim(sim: SimStore, gov: GovernanceStore, opts: GovernanceSimOptions = {}): () => void {
  const seed = (): void => {
    const world = sim.getState().world
    if (world) gov.getState().seedConsent(world.workers.map((w) => w.rosterProfile))
  }
  // Consent already sent to the current world (it may still be queued while the clock runs).
  let sentWorld: unknown = null
  let sent = new Map<string, ConsentState>()
  const syncConsent = (): void => {
    const s = sim.getState()
    const world = s.world
    if (!world || s.jumping || world.finished) return
    if (sentWorld !== world) {
      sentWorld = world
      sent = new Map()
    }
    const only = opts.deviceWorkerId ? opts.deviceWorkerId() : undefined
    const ledger = gov.getState().consent
    const out: WorldInjection[] = []
    for (const ws of world.workers) {
      if (only !== undefined && ws.id !== only) continue
      const want = ledger[ws.id]
      if (!want || sameConsentScopes(want, sent.get(ws.id) ?? ws.profile.consent)) continue
      sent.set(ws.id, want)
      out.push({ kind: 'consent', workerId: ws.id, consent: { ...want } })
    }
    if (out.length > 0) s.inject(out)
  }
  seed()
  syncConsent()
  const offSim = sim.subscribe((s, prev) => {
    if (s.world !== prev.world) seed()
    if (s.world !== prev.world || (prev.jumping && !s.jumping)) syncConsent()
  })
  const offGov = gov.subscribe((g, prev) => {
    if (g.consent !== prev.consent) syncConsent()
  })
  return () => {
    offSim()
    offGov()
  }
}

/** The app's governance store. Basis: {@link createGovernanceStore}. */
export const governanceStore: GovernanceStore = createGovernanceStore()
