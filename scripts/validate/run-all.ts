/**
 * `npm run validate` — regenerates every evidence number (ARCHITECTURE.md §8):
 *   1. reference.ts      → public/data/validation/reference.json       (reference agreement)
 *   2. hours-in-zone.ts  → public/data/validation/hours-in-zone.json   (real-data exposure, 2020–2025)
 *   3. forecast-skill.ts → public/data/validation/forecast-skill.json  (real-data forecast skill, 2024–2025)
 *   4. cohort.ts         → simulated cohort (written by another engineer; imported dynamically and skipped when absent)
 * then rewrites the generated tables in docs/VALIDATION.md (between the validate:begin/end markers).
 *
 * Flags: `--docs-only` re-renders docs/VALIDATION.md from the existing JSON without recomputing;
 *        `--skip=<name,...>` skips steps (reference, hours-in-zone, forecast-skill, cohort).
 * The scripts are deterministic (no clock or randomness in the outputs; the bootstrap uses the seeded sim/rng.ts).
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runReference } from './reference'
import type { ReferenceReport } from './reference'
import { runHoursInZone } from './hours-in-zone'
import type { HoursInZoneReport } from './hours-in-zone'
import { runForecastSkill } from './forecast-skill'
import type { ForecastSkillReport } from './forecast-skill'
import { isMainModule, readValidationJson, repoPath } from './lib/io'
import { renderValidationBlocks, updateValidationDoc, VALIDATION_DOC } from './lib/docs'

/** Outcome of one step. */
export interface RunAllStep {
  name: 'reference' | 'hours-in-zone' | 'forecast-skill' | 'cohort'
  status: 'ok' | 'skipped' | 'failed'
  ms: number
  detail: string
}

/** Outcome of `runAll`. */
export interface RunAllSummary {
  steps: RunAllStep[]
  docs: { path: string; updated: string[]; missing: string[] }
  ok: boolean
}

/** Options of {@link runAll}. */
export interface RunAllOptions {
  /** Only re-render docs/VALIDATION.md from the existing JSON. */
  docsOnly?: boolean
  /** Steps to skip. */
  skip?: readonly RunAllStep['name'][]
  /** Print progress (default true). */
  log?: boolean
}

/** Repository path of the optional simulated-cohort script (owned by another engineer). */
export const COHORT_SCRIPT = 'scripts/validate/cohort.ts'

/**
 * Run the cohort step if scripts/validate/cohort.ts exists: import it dynamically and call the first exported function
 * among `runCohort`, `run`, `main` or the default export (awaited when it returns a promise). Skips gracefully when the
 * file is absent; a module without such a function is reported as imported only.
 */
async function runCohortStep(log: boolean): Promise<Omit<RunAllStep, 'name' | 'ms'>> {
  const abs = repoPath(COHORT_SCRIPT)
  if (!existsSync(abs)) return { status: 'skipped', detail: `${COHORT_SCRIPT} not present (simulated cohort results: docs/VALIDATION-COHORT.md)` }
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>
  for (const name of ['runCohort', 'run', 'main', 'default']) {
    const fn = mod[name]
    if (typeof fn === 'function') {
      const out: unknown = (fn as (opts?: { log?: boolean }) => unknown)({ log })
      if (out instanceof Promise) await out
      return { status: 'ok', detail: `${COHORT_SCRIPT} ${name}()` }
    }
  }
  return { status: 'ok', detail: `${COHORT_SCRIPT} imported (no runCohort/run/main/default export to call)` }
}

/**
 * Run every validation script in order, print timings, and refresh the generated tables of docs/VALIDATION.md.
 * A failing step is reported and the remaining steps still run (the summary's `ok` is then false).
 */
export async function runAll(opts: RunAllOptions = {}): Promise<RunAllSummary> {
  const log = opts.log ?? true
  const skip = new Set(opts.skip ?? [])
  const steps: RunAllStep[] = []
  let ref: ReferenceReport | null = null
  let hours: HoursInZoneReport | null = null
  let skill: ForecastSkillReport | null = null

  const step = async (name: RunAllStep['name'], fn: () => Promise<Omit<RunAllStep, 'name' | 'ms'>>): Promise<void> => {
    if (opts.docsOnly || skip.has(name)) {
      steps.push({ name, status: 'skipped', ms: 0, detail: opts.docsOnly ? '--docs-only' : '--skip' })
      return
    }
    const t0 = performance.now()
    try {
      const r = await fn()
      steps.push({ name, ms: performance.now() - t0, ...r })
    } catch (e) {
      steps.push({ name, status: 'failed', ms: performance.now() - t0, detail: e instanceof Error ? (e.stack ?? e.message) : String(e) })
    }
  }

  await step('reference', async () => {
    ref = runReference({ log })
    return { status: 'ok', detail: `${ref.summary.passed}/${ref.summary.checks} checks pass` }
  })
  await step('hours-in-zone', async () => {
    hours = runHoursInZone({ log })
    return { status: 'ok', detail: `${hours.sites.length} site-run summaries` }
  })
  await step('forecast-skill', async () => {
    skill = runForecastSkill({ log })
    return { status: 'ok', detail: `${skill.sameModel.length} models, ${skill.airports.forecast.length} airport rows` }
  })
  await step('cohort', () => runCohortStep(log))

  // Refresh the generated tables from whatever JSON is now on disk.
  const blocks = renderValidationBlocks(
    ref ?? (readValidationJson('reference') as ReferenceReport | null),
    hours ?? (readValidationJson('hours-in-zone') as HoursInZoneReport | null),
    skill ?? (readValidationJson('forecast-skill') as ForecastSkillReport | null),
  )
  const docs = { path: VALIDATION_DOC, ...updateValidationDoc(blocks) }

  if (log) {
    for (const s of steps) console.log(`[validate] ${s.name.padEnd(15)} ${s.status.padEnd(8)} ${(s.ms / 1000).toFixed(1).padStart(6)} s  ${s.status === 'failed' ? s.detail.split('\n')[0] : s.detail}`)
    console.log(`[validate] ${VALIDATION_DOC}: ${docs.updated.length} tables updated${docs.missing.length ? `, no data for ${docs.missing.join(', ')}` : ''}`)
  }
  return { steps, docs, ok: steps.every((s) => s.status !== 'failed') }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const skipArg = args.find((a) => a.startsWith('--skip='))
  const skip = skipArg ? (skipArg.slice('--skip='.length).split(',').filter(Boolean) as RunAllStep['name'][]) : []
  runAll({ docsOnly: args.includes('--docs-only'), skip })
    .then((s) => {
      if (!s.ok) process.exitCode = 1
    })
    .catch((e: unknown) => {
      console.error(e)
      process.exitCode = 1
    })
}
