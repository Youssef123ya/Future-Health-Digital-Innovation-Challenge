/**
 * UI state (zustand vanilla store): the viewing role and actor id, language with its text direction, the selected site
 * and worker, and the worker whose phone the #/worker view shows. Node-safe: `navigator`, `localStorage` and `document`
 * are only touched by the explicit helpers (`hydrate`, `persistUi`, `bindDocumentLanguage`), never at import.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { LangCode, Role } from '../engine/types'
import type { SiteId } from '../data/sites'
import { LANGUAGES, detectLang, dirFor, isLangCode, type TextDirection } from '../i18n'
import { supervisorActors } from './selectors'
import type { SimStore } from './simStore'

/** Every role, in the role-picker order of ARCHITECTURE §2. */
export const ROLES: readonly Role[] = Object.freeze(['worker', 'buddy', 'supervisor', 'first_aider', 'occ_health', 'hse_manager', 'regulator', 'employer_hr'])

/**
 * Demo actor ids of the roles that are not tied to a worker or a crew (logged in the audit chain). [ENG] placeholders;
 * a deployment uses authenticated staff ids.
 */
export const DEFAULT_ACTOR_IDS: Readonly<Record<'first_aider' | 'occ_health' | 'hse_manager' | 'regulator' | 'employer_hr', string>> = Object.freeze({
  first_aider: 'FA-1',
  occ_health: 'OH-1',
  hse_manager: 'HSE-1',
  regulator: 'ADPHC-1',
  employer_hr: 'HR-1',
})

/** Route alias for "the device worker" (#/worker/demo). Basis: ui/router.ts DEFAULT_WORKER_ID. */
export const DEVICE_ROUTE_ALIAS = 'demo'

/** localStorage key of the persisted UI preferences. [ENG] */
export const UI_STORAGE_KEY = 'zill.ui.v1'

/** Minimal Storage interface (localStorage or a test double). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** State and actions of the UI store. */
export interface UiState {
  role: Role
  /** Who is acting (stamped on audit entries): worker id, `${crewId}:supervisor`, or a staff id. */
  actorId: string
  language: LangCode
  dir: TextDirection
  siteId: SiteId | null
  selectedWorkerId: string | null
  /** The worker whose phone the #/worker view shows. */
  deviceWorkerId: string | null
  /** The supervisor actor (crew) selected for the supervisor console. */
  supervisorActorId: string | null

  /** Switches role; the actor id defaults to the role's natural actor (device worker, selected supervisor, staff id). */
  setRole(role: Role, actorId?: string): void
  setActorId(actorId: string): void
  setLanguage(lang: LangCode): void
  selectSite(siteId: SiteId | null): void
  selectWorker(workerId: string | null): void
  setDeviceWorker(workerId: string | null): void
  setSupervisorActor(actorId: string | null): void
  /** Points the device worker / supervisor at members of a newly loaded roster when the current ones are unknown. */
  ensureRoster(roster: { workerIds: readonly string[]; supervisorIds: readonly string[]; siteId?: SiteId }): void
  /** Reads preferences (localStorage) and the browser languages; both optional. */
  hydrate(env?: { languages?: readonly string[] | null; storage?: StorageLike | null }): void
}

/** A UI store. */
export type UiStore = StoreApi<UiState>

/** The natural actor id of a role in the current UI state. Basis: ARCHITECTURE §2 actor table. */
export function actorFor(role: Role, s: Pick<UiState, 'deviceWorkerId' | 'supervisorActorId'>): string {
  switch (role) {
    case 'worker':
    case 'buddy':
      return s.deviceWorkerId ?? ''
    case 'supervisor':
      return s.supervisorActorId ?? ''
    default:
      return DEFAULT_ACTOR_IDS[role]
  }
}

/** The worker a #/worker/:id route shows: the id itself, or the device worker for the 'demo' alias / no id. */
export function resolveDeviceWorkerId(routeId: string | null | undefined, s: Pick<UiState, 'deviceWorkerId'>): string | null {
  return routeId && routeId !== DEVICE_ROUTE_ALIAS ? routeId : s.deviceWorkerId
}

const isRole = (x: unknown): x is Role => typeof x === 'string' && (ROLES as readonly string[]).includes(x)

/** Creates a UI store (English, supervisor view, nothing selected). Basis: ARCHITECTURE §2, §9; i18n dirFor (RTL for ar/ur). */
export function createUiStore(): UiStore {
  return createStore<UiState>()((set, get) => {
    const followActor = (patch: Partial<UiState>): Partial<UiState> => {
      const next = { ...get(), ...patch }
      const natural = actorFor(get().role, get())
      // Keep a manually chosen actor; re-derive the actor that followed the previous selection.
      return get().actorId === natural || get().actorId === '' ? { ...patch, actorId: actorFor(next.role, next) } : patch
    }
    return {
      role: 'supervisor',
      actorId: '',
      language: 'en',
      dir: dirFor('en'),
      siteId: null,
      selectedWorkerId: null,
      deviceWorkerId: null,
      supervisorActorId: null,

      setRole: (role, actorId) => {
        if (!isRole(role)) throw new RangeError(`setRole: unknown role '${String(role)}'`)
        set({ role, actorId: actorId ?? actorFor(role, get()) })
      },
      setActorId: (actorId) => set({ actorId }),
      setLanguage: (lang) => {
        if (!isLangCode(lang)) throw new RangeError(`setLanguage: unsupported language '${String(lang)}'`)
        set({ language: lang, dir: dirFor(lang) })
      },
      selectSite: (siteId) => set({ siteId }),
      selectWorker: (workerId) => set({ selectedWorkerId: workerId }),
      setDeviceWorker: (workerId) => set(followActor({ deviceWorkerId: workerId })),
      setSupervisorActor: (actorId) => set(followActor({ supervisorActorId: actorId })),
      ensureRoster: ({ workerIds, supervisorIds, siteId }) => {
        const s = get()
        const patch: Partial<UiState> = {}
        if (siteId !== undefined && s.siteId !== siteId) patch.siteId = siteId
        if (workerIds.length > 0 && (s.deviceWorkerId === null || !workerIds.includes(s.deviceWorkerId))) patch.deviceWorkerId = workerIds[0]
        if (s.selectedWorkerId !== null && !workerIds.includes(s.selectedWorkerId)) patch.selectedWorkerId = null
        if (supervisorIds.length > 0 && (s.supervisorActorId === null || !supervisorIds.includes(s.supervisorActorId))) patch.supervisorActorId = supervisorIds[0]
        if (Object.keys(patch).length > 0) set(followActor(patch))
      },
      hydrate: (env = {}) => {
        const patch: Partial<UiState> = {}
        if (env.languages) {
          const lang = detectLang(env.languages, get().language)
          patch.language = lang
          patch.dir = dirFor(lang)
        }
        try {
          const raw = env.storage?.getItem(UI_STORAGE_KEY)
          const saved: unknown = raw ? JSON.parse(raw) : null
          if (saved && typeof saved === 'object') {
            const o = saved as Record<string, unknown>
            if (isLangCode(o.language)) {
              patch.language = o.language
              patch.dir = dirFor(o.language)
            }
            if (isRole(o.role)) patch.role = o.role
            if (typeof o.deviceWorkerId === 'string') patch.deviceWorkerId = o.deviceWorkerId
          }
        } catch {
          // Blocked or corrupt storage: keep defaults.
        }
        const next = { ...get(), ...patch }
        set({ ...patch, actorId: actorFor(next.role, next) })
      },
    }
  })
}

/**
 * Persists role, language and device worker to `storage` on change (try/catch: storage may be blocked). Returns the
 * unsubscribe function. Basis: per-viewer convenience only [ENG]; nothing personal is stored.
 */
export function persistUi(store: UiStore, storage: StorageLike): () => void {
  return store.subscribe((s, prev) => {
    if (s.role === prev.role && s.language === prev.language && s.deviceWorkerId === prev.deviceWorkerId) return
    try {
      storage.setItem(UI_STORAGE_KEY, JSON.stringify({ role: s.role, language: s.language, deviceWorkerId: s.deviceWorkerId }))
    } catch {
      // ignore
    }
  })
}

/** A document whose root element receives `lang` and `dir`. */
export interface DocumentLike {
  documentElement: { lang: string; dir: string }
}

/**
 * Applies the language (BCP 47 tag) and direction to the document root now and on every change; no-op without a
 * document. Basis: i18n LANGUAGES (bcp47, rtl); WCAG 2.2 SC 3.1.1 Language of Page.
 */
export function bindDocumentLanguage(store: UiStore, doc: DocumentLike | null = typeof document === 'undefined' ? null : document): () => void {
  if (!doc) return () => undefined
  const apply = (s: UiState): void => {
    doc.documentElement.lang = LANGUAGES[s.language].bcp47
    doc.documentElement.dir = s.dir
  }
  apply(store.getState())
  return store.subscribe((s, prev) => {
    if (s.language !== prev.language || s.dir !== prev.dir) apply(s)
  })
}

/**
 * Keeps the UI selections valid for every new world: device worker and supervisor actor default to the first members
 * of the loaded roster, and the site follows the scenario. Returns the unsubscribe function.
 */
export function connectUiToSim(sim: SimStore, ui: UiStore): () => void {
  const sync = (): void => {
    const s = sim.getState()
    if (!s.world) return
    ui.getState().ensureRoster({
      workerIds: s.world.workers.map((w) => w.profile.id),
      supervisorIds: supervisorActors(s).map((a) => a.actorId),
      siteId: s.world.site.id,
    })
  }
  sync()
  return sim.subscribe((s, prev) => {
    if (s.world !== prev.world) sync()
  })
}

/** The app's UI store. Basis: {@link createUiStore}. */
export const uiStore: UiStore = createUiStore()
