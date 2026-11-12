/**
 * Simulation lab state (main thread): the experiment form, the cached demo days, the experiment runner (one Web Worker,
 * labWorker.ts, created lazily and terminated on cancel) and the explorer selections. A module-level store, so results
 * survive tab switches inside the lab and leaving and re-entering #/lab.
 *
 * Everything here is SIMULATED COHORT data and may carry ground truth: Lab view only.
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { SiteId } from '../../../data/sites'
import { POLICY_IDS, type PolicyId } from '../../../sim/types'
import { CUSTOM_DAY_KEY, archiveDayError, dayKey, dayOptions, defaultWorkerId, parseDemoDays, sortPolicies, type DemoDayOption } from './labModel'
import { DEFAULT_LAB_BEHAVIOUR, scenarioDefaults, siteDaySeed, windowError } from './labRun'
import type { DaySource, ExperimentSpec, LabBehaviour, LabDisruptions, LabRequest, LabResponse, PolicyRunResult } from './labTypes'

/** The experiment form. `dayKey` is a day-picker key (labModel.ts dayKey) or {@link CUSTOM_DAY_KEY}. */
export interface LabForm {
  dayKey: string
  custom: { siteId: SiteId; date: string }
  policies: PolicyId[]
  seed: string
  behaviour: LabBehaviour
  disruptions: LabDisruptions
}

/** Progress of a running experiment (from the worker). */
export interface LabProgress {
  phase: 'loading' | 'running'
  policyIndex: number
  policyCount: number
  fraction: number
}

export type ExperimentStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

export interface Experiment {
  runId: number
  status: ExperimentStatus
  spec: ExperimentSpec | null
  progress: LabProgress | null
  /** Finished policy runs, in the spec's policy order. */
  results: PolicyRunResult[]
  startedAt: number | null
  elapsedMs: number | null
  error: string | null
}

export interface LabState {
  form: LabForm
  demoDays: DemoDayOption[]
  demoDaysStatus: 'idle' | 'loading' | 'ready' | 'error'
  experiment: Experiment
  /** Worker explorer: the policy run and the worker shown. */
  explorer: { policy: PolicyId | null; workerId: string | null }
  /** Live panel: the worker whose trace is charted. */
  liveWorkerId: string | null
  setForm(patch: Partial<LabForm>): void
  /** Picks a day; a scenario brings its own seed and disruption windows, a site-day a derived seed and none. */
  selectDay(key: string): void
  /** Changes the custom site-day (site or date) and its derived seed. */
  setCustomDay(patch: Partial<LabForm['custom']>): void
  resetAssumptions(): void
  loadDemoDays(): void
  run(): void
  cancel(): void
  selectExplorer(patch: Partial<LabState['explorer']>): void
  selectLiveWorker(id: string | null): void
}

const DEFAULT_SCENARIO = 'peak-day' as const

function initialForm(): LabForm {
  const d = scenarioDefaults(DEFAULT_SCENARIO)
  return {
    dayKey: dayKey({ kind: 'scenario', scenarioId: DEFAULT_SCENARIO }),
    custom: { siteId: 'musaffah', date: '2025-07-15' },
    policies: [...POLICY_IDS],
    seed: d.seed,
    behaviour: { ...d.behaviour },
    disruptions: { ...d.disruptions },
  }
}

const IDLE: Experiment = { runId: 0, status: 'idle', spec: null, progress: null, results: [], startedAt: null, elapsedMs: null, error: null }

/** Resolves the form's day: the picked option's source, or the custom site-day. */
export function formSource(form: LabForm, options: readonly { key: string; source: DaySource }[]): DaySource | null {
  if (form.dayKey === CUSTOM_DAY_KEY) return { kind: 'site-day', siteId: form.custom.siteId, date: form.custom.date }
  return options.find((o) => o.key === form.dayKey)?.source ?? null
}

/** Validation messages of the form, by field (empty when it can run). */
export function formErrors(form: LabForm, source: DaySource | null): Partial<Record<'day' | 'policies' | 'seed' | 'sensor' | 'network', string>> {
  const e: Partial<Record<'day' | 'policies' | 'seed' | 'sensor' | 'network', string>> = {}
  if (!source) e.day = 'Pick a day.'
  else if (source.kind === 'site-day' && form.dayKey === CUSTOM_DAY_KEY) {
    const msg = archiveDayError(source.siteId, source.date)
    if (msg) e.day = msg
  }
  if (form.policies.length === 0) e.policies = 'Pick at least one policy.'
  if (!form.seed.trim()) e.seed = 'Enter a seed.'
  const s = windowError(form.disruptions.envSensorFailure)
  if (s) e.sensor = s
  const n = windowError(form.disruptions.networkOutage)
  if (n) e.network = n
  return e
}

/** The experiment a valid form describes. */
export function specFromForm(form: LabForm, source: DaySource): ExperimentSpec {
  return {
    source,
    policies: sortPolicies(form.policies),
    seed: form.seed.trim(),
    behaviour: { ...form.behaviour },
    disruptions: {
      ...form.disruptions,
      envSensorFailure: form.disruptions.envSensorFailure ? { ...form.disruptions.envSensorFailure } : null,
      networkOutage: form.disruptions.networkOutage ? { ...form.disruptions.networkOutage } : null,
    },
  }
}

/** Absolute base URL of the static data for the worker (a worker resolves relative URLs against its own script). */
function dataBaseUrl(): string {
  return new URL('./data/', document.baseURI).href
}

let worker: Worker | null = null

export const labStore = createStore<LabState>()((set, get) => {
  const onMessage = (msg: LabResponse): void => {
    const exp = get().experiment
    if (msg.runId !== exp.runId || exp.status !== 'running') return
    switch (msg.type) {
      case 'progress':
        set({ experiment: { ...exp, progress: { phase: msg.phase, policyIndex: msg.policyIndex, policyCount: msg.policyCount, fraction: msg.fraction } } })
        break
      case 'policy': {
        const results = [...exp.results.filter((r) => r.policy !== msg.result.policy), msg.result]
        const order = exp.spec?.policies ?? POLICY_IDS
        results.sort((a, b) => order.indexOf(a.policy) - order.indexOf(b.policy))
        const ex = get().explorer
        const policy = ex.policy && results.some((r) => r.policy === ex.policy) ? ex.policy : results[0].policy
        const workerId = ex.workerId && results[0].workers.some((w) => w.id === ex.workerId) ? ex.workerId : defaultWorkerId(results)
        set({ experiment: { ...exp, results }, explorer: { policy, workerId } })
        break
      }
      case 'done':
        set({ experiment: { ...exp, status: 'done', progress: null, elapsedMs: msg.elapsedMs } })
        break
      case 'error':
        set({ experiment: { ...exp, status: 'error', progress: null, error: msg.message, elapsedMs: exp.startedAt === null ? null : performance.now() - exp.startedAt } })
        break
    }
  }

  const getWorker = (): Worker => {
    if (worker) return worker
    const w = new Worker(new URL('./labWorker.ts', import.meta.url), { type: 'module' })
    w.addEventListener('message', (e: MessageEvent<LabResponse>) => onMessage(e.data))
    w.addEventListener('error', (e: ErrorEvent) => {
      const exp = get().experiment
      if (exp.status === 'running') set({ experiment: { ...exp, status: 'error', progress: null, error: e.message || 'The simulation worker failed to start.' } })
      w.terminate()
      if (worker === w) worker = null
    })
    worker = w
    return w
  }

  return {
    form: initialForm(),
    demoDays: [],
    demoDaysStatus: 'idle',
    experiment: IDLE,
    explorer: { policy: null, workerId: null },
    liveWorkerId: null,

    setForm: (patch) => set({ form: { ...get().form, ...patch } }),

    selectDay: (key) => {
      const form = get().form
      const source = formSource({ ...form, dayKey: key }, dayOptions(get().demoDays))
      if (source?.kind === 'scenario') {
        const d = scenarioDefaults(source.scenarioId)
        set({ form: { ...form, dayKey: key, seed: d.seed, disruptions: { ...d.disruptions } } })
      } else {
        const site = source?.kind === 'site-day' ? source : { siteId: form.custom.siteId, date: form.custom.date }
        set({
          form: {
            ...form,
            dayKey: key,
            seed: siteDaySeed(site.siteId, site.date),
            disruptions: { ...form.disruptions, envSensorFailure: null, networkOutage: null },
          },
        })
      }
    },

    setCustomDay: (patch) => {
      const form = get().form
      const custom = { ...form.custom, ...patch }
      set({ form: { ...form, custom, seed: siteDaySeed(custom.siteId, custom.date) } })
    },

    resetAssumptions: () => {
      const form = get().form
      const source = formSource(form, dayOptions(get().demoDays))
      const d = source?.kind === 'scenario' ? scenarioDefaults(source.scenarioId) : null
      set({
        form: {
          ...form,
          behaviour: { ...(d?.behaviour ?? DEFAULT_LAB_BEHAVIOUR) },
          disruptions: d ? { ...d.disruptions } : { wearableDropout: 0, ppgNoiseMultiplier: 1, envSensorFailure: null, networkOutage: null },
        },
      })
    },

    loadDemoDays: () => {
      if (get().demoDaysStatus === 'loading' || get().demoDaysStatus === 'ready') return
      set({ demoDaysStatus: 'loading' })
      fetch('./data/weather/demo-days.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json: unknown) => set({ demoDays: parseDemoDays(json), demoDaysStatus: 'ready' }))
        .catch(() => set({ demoDaysStatus: 'error' }))
    },

    run: () => {
      const state = get()
      const source = formSource(state.form, dayOptions(state.demoDays))
      if (!source || Object.keys(formErrors(state.form, source)).length > 0) return
      if (worker && state.experiment.status === 'running') {
        worker.terminate()
        worker = null
      }
      const spec = specFromForm(state.form, source)
      const runId = state.experiment.runId + 1
      set({
        experiment: {
          runId,
          status: 'running',
          spec,
          progress: { phase: 'loading', policyIndex: 0, policyCount: spec.policies.length, fraction: 0 },
          results: [],
          startedAt: performance.now(),
          elapsedMs: null,
          error: null,
        },
      })
      try {
        const req: LabRequest = { type: 'run', runId, dataBaseUrl: dataBaseUrl(), spec }
        getWorker().postMessage(req)
      } catch (err) {
        set({ experiment: { ...get().experiment, status: 'error', progress: null, error: err instanceof Error ? err.message : String(err) } })
      }
    },

    cancel: () => {
      const exp = get().experiment
      if (exp.status !== 'running') return
      worker?.terminate()
      worker = null
      set({ experiment: { ...exp, status: 'cancelled', progress: null, elapsedMs: exp.startedAt === null ? null : performance.now() - exp.startedAt } })
    },

    selectExplorer: (patch) => set({ explorer: { ...get().explorer, ...patch } }),
    selectLiveWorker: (id) => set({ liveWorkerId: id }),
  }
})

/** Subscribes to a slice of the lab store. */
export function useLab<T>(selector: (s: LabState) => T): T {
  return useStore(labStore, selector)
}
