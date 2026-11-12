/**
 * Simulation lab Web Worker: runs one experiment (the same day, seed and assumptions once per policy, each in its own
 * world) off the main thread and streams progress and one compact result per policy back. A 33-worker day takes about
 * 2 s per policy, so the page never blocks; cancelling terminates this worker.
 *
 * Each run is createWorld → stepWorld in chunks → finishWorld, which is exactly what runScenario / runSiteDay do in one
 * call (sim/worldsim.ts: stepping is chunking-invariant), plus progress messages between chunks.
 *
 * Evidence class: SIMULATED COHORT (docs/SIMULATION.md). Results carry ground truth: Lab view only.
 */
import { createBrowserSimDataLoader } from '../../../sim/simdata'
import { loadScenarioData } from '../../../sim/scenarios'
import { createWorld, finishWorld, stepWorld, worldMinutesRemaining } from '../../../sim/worldsim'
import type { SimData } from '../../../sim/types'
import { buildPolicyRunResult, runSetup, siteDayRoster, traceBuffers } from './labRun'
import type { ExperimentSpec, LabRequest, LabResponse } from './labTypes'

/** The part of DedicatedWorkerGlobalScope this worker uses (the project compiles against the DOM lib only). */
interface LabWorkerScope {
  postMessage(message: LabResponse, options?: { transfer?: Transferable[] }): void
  addEventListener(type: 'message', listener: (event: MessageEvent<LabRequest>) => void): void
}

const scope = self as unknown as LabWorkerScope

/** Simulated minutes per step between progress checks [ENG]. */
const CHUNK_MIN = 20
/** Minimum wall time between progress messages, ms [ENG]. */
const PROGRESS_EVERY_MS = 80

function post(message: LabResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer ? { transfer } : undefined)
}

async function loadData(spec: ExperimentSpec, dataBaseUrl: string): Promise<SimData> {
  const loader = createBrowserSimDataLoader({ baseUrl: dataBaseUrl })
  if (spec.source.kind === 'scenario') return loadScenarioData(spec.source.scenarioId, loader)
  return loader.load(spec.source.siteId, spec.source.date, siteDayRoster(spec.source.siteId))
}

async function run(runId: number, spec: ExperimentSpec, dataBaseUrl: string): Promise<void> {
  const started = performance.now()
  const policyCount = spec.policies.length
  post({ type: 'progress', runId, phase: 'loading', policyIndex: 0, policyCount, fraction: 0 })
  const data = await loadData(spec, dataBaseUrl)
  for (let i = 0; i < policyCount; i++) {
    const policy = spec.policies[i]
    const t0 = performance.now()
    const { config, script } = runSetup(spec, policy)
    const world = createWorld(config, data, { script })
    const total = Math.max(1, world.nMinutes)
    let lastPost = 0
    post({ type: 'progress', runId, phase: 'running', policyIndex: i, policyCount, fraction: 0 })
    while (worldMinutesRemaining(world) > 0) {
      stepWorld(world, CHUNK_MIN)
      const now = performance.now()
      if (now - lastPost >= PROGRESS_EVERY_MS) {
        lastPost = now
        post({ type: 'progress', runId, phase: 'running', policyIndex: i, policyCount, fraction: 1 - worldMinutesRemaining(world) / total })
      }
    }
    const result = finishWorld(world)
    const out = buildPolicyRunResult(result, config.workers ?? data.workers, config.crews ?? data.crews, performance.now() - t0, data.weather.provenance)
    post({ type: 'policy', runId, policyIndex: i, result: out }, traceBuffers(out.traces))
  }
  post({ type: 'done', runId, elapsedMs: Math.round(performance.now() - started) })
}

scope.addEventListener('message', (event) => {
  const req = event.data
  if (req?.type !== 'run') return
  run(req.runId, req.spec, req.dataBaseUrl).catch((err: unknown) => {
    post({ type: 'error', runId: req.runId, message: err instanceof Error ? err.message : String(err) })
  })
})
