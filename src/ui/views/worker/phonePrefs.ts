/**
 * Phone preferences of each simulated worker device: the phone's own language and battery saver. They live on the
 * phone (localStorage when available, else memory) and never leave it: they are not part of the sync payload and not
 * an audited access. Node-safe: storage is touched only through the guarded helpers, never at import.
 *
 * Language rule: the worker's explicit choice on this phone wins; otherwise a `?lang=` in the address (a presenter or a
 * screenshot run asking for one language everywhere); otherwise the language on the worker's profile, so every phone
 * opens in its owner's language (ARCHITECTURE §9 `#/worker/:id`: "language" first).
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { LangCode } from '../../../engine/types'
import { isLangCode } from '../../../i18n'

/** localStorage key of the phone preferences. [ENG] */
export const PHONE_PREFS_KEY = 'zill.phone.v1'

/** Preferences of one phone. */
export interface PhonePrefs {
  /** Language chosen on this phone; null = follow the address or the worker's profile. */
  lang: LangCode | null
  /** Fewer screen updates; warnings still sound and vibrate. */
  batterySaver: boolean
}

export const DEFAULT_PHONE_PREFS: Readonly<PhonePrefs> = Object.freeze({ lang: null, batterySaver: false })

interface PhonePrefsState {
  byWorker: Readonly<Record<string, PhonePrefs>>
  set(workerId: string, patch: Partial<PhonePrefs>): void
}

function readStorage(): Record<string, PhonePrefs> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PHONE_PREFS_KEY) : null
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, PhonePrefs> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      out[id] = { lang: isLangCode(o.lang) ? o.lang : null, batterySaver: o.batterySaver === true }
    }
    return out
  } catch {
    return {}
  }
}

function writeStorage(byWorker: Readonly<Record<string, PhonePrefs>>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PHONE_PREFS_KEY, JSON.stringify(byWorker))
  } catch {
    /* storage blocked or full: the choice still applies for this session */
  }
}

let hydrated = false

export const phonePrefsStore = createStore<PhonePrefsState>()((set, get) => ({
  byWorker: {},
  set: (workerId, patch) => {
    const next = { ...get().byWorker, [workerId]: { ...DEFAULT_PHONE_PREFS, ...get().byWorker[workerId], ...patch } }
    set({ byWorker: next })
    writeStorage(next)
  },
}))

/** Reads saved phone preferences once (call from a browser effect). */
export function hydratePhonePrefs(): void {
  if (hydrated) return
  hydrated = true
  const saved = readStorage()
  if (Object.keys(saved).length > 0) phonePrefsStore.setState({ byWorker: { ...saved, ...phonePrefsStore.getState().byWorker } })
}

/** The preferences of one phone (defaults until the worker changes something). */
export function usePhonePrefs(workerId: string | null | undefined): PhonePrefs {
  return useStore(phonePrefsStore, (s) => (workerId ? s.byWorker[workerId] : undefined) ?? DEFAULT_PHONE_PREFS)
}

/** The language a phone shows (see the module rule). */
export function phoneLanguage(input: { choice: LangCode | null; urlLang: string | null | undefined; profileLang: LangCode | null | undefined }): LangCode {
  if (input.choice) return input.choice
  if (input.urlLang && isLangCode(input.urlLang)) return input.urlLang
  return input.profileLang && isLangCode(input.profileLang) ? input.profileLang : 'en'
}
