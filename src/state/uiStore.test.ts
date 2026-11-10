import { describe, expect, it } from 'vitest'
import { createNodeSimDataLoader } from '../sim/simdata'
import { loadScenarioData } from '../sim/scenarios'
import { createSimStore } from './simStore'
import {
  DEFAULT_ACTOR_IDS,
  UI_STORAGE_KEY,
  actorFor,
  bindDocumentLanguage,
  connectUiToSim,
  createUiStore,
  persistUi,
  resolveDeviceWorkerId,
  uiStore,
  type StorageLike,
} from './uiStore'

const memoryStorage = (init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('uiStore', () => {
  it('defaults: supervisor view in English (ltr); language switch sets direction (Arabic and Urdu are rtl)', () => {
    const ui = createUiStore()
    expect(ui.getState()).toMatchObject({ role: 'supervisor', language: 'en', dir: 'ltr', deviceWorkerId: null })
    ui.getState().setLanguage('ar')
    expect(ui.getState().dir).toBe('rtl')
    ui.getState().setLanguage('ur')
    expect(ui.getState().dir).toBe('rtl')
    ui.getState().setLanguage('ml')
    expect(ui.getState().dir).toBe('ltr')
    expect(() => ui.getState().setLanguage('fr' as never)).toThrow(RangeError)
    expect(uiStore.getState().language).toBe('en')
  })

  it('role switching picks the natural actor; selections re-derive it unless chosen manually', () => {
    const ui = createUiStore()
    ui.getState().setDeviceWorker('W-D2F6')
    ui.getState().setSupervisorActor('musaffah-demo:supervisor')
    ui.getState().setRole('worker')
    expect(ui.getState().actorId).toBe('W-D2F6')
    ui.getState().setDeviceWorker('W-D2A1')
    expect(ui.getState().actorId).toBe('W-D2A1')
    ui.getState().setRole('supervisor')
    expect(ui.getState().actorId).toBe('musaffah-demo:supervisor')
    ui.getState().setRole('regulator')
    expect(ui.getState().actorId).toBe(DEFAULT_ACTOR_IDS.regulator)
    ui.getState().setRole('first_aider', 'FA-7')
    ui.getState().setDeviceWorker('W-D2B2')
    expect(ui.getState().actorId).toBe('FA-7')
    expect(actorFor('buddy', { deviceWorkerId: 'W-1', supervisorActorId: null })).toBe('W-1')
    expect(() => ui.getState().setRole('ceo' as never)).toThrow(RangeError)
    expect(resolveDeviceWorkerId('demo', { deviceWorkerId: 'W-D2F6' })).toBe('W-D2F6')
    expect(resolveDeviceWorkerId('W-X', { deviceWorkerId: 'W-D2F6' })).toBe('W-X')
    expect(resolveDeviceWorkerId(undefined, { deviceWorkerId: null })).toBeNull()
  })

  it('hydrates from storage and browser languages, persists changes, survives broken storage', () => {
    const storage = memoryStorage({ [UI_STORAGE_KEY]: JSON.stringify({ role: 'worker', language: 'bn', deviceWorkerId: 'W-D2D4' }) })
    const ui = createUiStore()
    ui.getState().hydrate({ languages: ['ar-AE'], storage })
    expect(ui.getState()).toMatchObject({ role: 'worker', language: 'bn', dir: 'ltr', deviceWorkerId: 'W-D2D4', actorId: 'W-D2D4' })
    const off = persistUi(ui, storage)
    ui.getState().setLanguage('ar')
    expect(JSON.parse(storage.data[UI_STORAGE_KEY])).toMatchObject({ language: 'ar', role: 'worker' })
    off()
    const ui2 = createUiStore()
    ui2.getState().hydrate({ languages: ['tl-PH', 'en'], storage: { getItem: () => '{not json', setItem: () => undefined } })
    expect(ui2.getState().language).toBe('tl')
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    ui2.getState().hydrate({ storage: throwing })
    const off2 = persistUi(ui2, throwing)
    expect(() => ui2.getState().setRole('worker')).not.toThrow()
    off2()
  })

  it('applies lang and dir to the document root', () => {
    const ui = createUiStore()
    const doc = { documentElement: { lang: '', dir: '' } }
    const off = bindDocumentLanguage(ui, doc)
    expect(doc.documentElement).toEqual({ lang: 'en-AE', dir: 'ltr' })
    ui.getState().setLanguage('ar')
    expect(doc.documentElement).toEqual({ lang: 'ar-AE', dir: 'rtl' })
    off()
    expect(bindDocumentLanguage(ui, null)()).toBeUndefined()
  })

  it('keeps selections valid for a newly loaded world', async () => {
    const base = createNodeSimDataLoader()
    const data = await loadScenarioData('peak-day', base)
    const sim = createSimStore({ loader: { weather: (s, d) => base.weather(s, d), load: async () => data, demoDays: () => base.demoDays() } })
    const ui = createUiStore()
    ui.getState().setDeviceWorker('W-GONE')
    const off = connectUiToSim(sim, ui)
    await sim.getState().loadScenario('peak-day')
    const ids = sim.getState().view!.workers.map((w) => w.profile.id)
    expect(ids).toContain(ui.getState().deviceWorkerId)
    expect(ui.getState().supervisorActorId).toMatch(/:supervisor$/)
    expect(ui.getState().actorId).toBe(ui.getState().supervisorActorId)
    expect(ui.getState().siteId).toBe('musaffah')
    off()
  })

  it('the React hooks module imports in Node (no window at import)', async () => {
    const hooks = await import('./hooks')
    expect(typeof hooks.useSupervisorBoard).toBe('function')
    const barrel = await import('./index')
    expect(typeof barrel.connectAppState).toBe('function')
  })
})
