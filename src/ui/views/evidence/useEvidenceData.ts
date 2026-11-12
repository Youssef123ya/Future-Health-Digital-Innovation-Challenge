import { useEffect, useState } from 'react'
import type { CohortFile, ForecastFile, HoursFile, ReferenceFile } from './types'

/**
 * Loading state of one validation file. `missing` means the file has not been generated (HTTP 404, or the dev server's
 * SPA fallback answered with HTML); `error` means it exists but could not be read or has an unexpected schema.
 */
export type FileState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'missing'; path: string }
  | { status: 'error'; path: string; message: string }

/** Relative paths: the app is deployed under base './'. */
export const EVIDENCE_PATHS = {
  reference: './data/validation/reference.json',
  hours: './data/validation/hours-in-zone.json',
  forecast: './data/validation/forecast-skill.json',
  cohort: './data/validation/cohort.json',
  cohortV01: './data/validation/cohort-v0.1.json',
  cohortV02: './data/validation/cohort-v0.2.json',
} as const

type Settled = Exclude<FileState<unknown>, { status: 'loading' }>

const cache = new Map<string, Promise<Settled>>()

/** Schema checks: the field and prefix each file must carry, so a renamed or foreign file is never rendered as evidence. */
const SCHEMA: Readonly<Record<string, { field: string; prefix: string }>> = {
  [EVIDENCE_PATHS.reference]: { field: 'schema', prefix: 'zill.validation.reference/' },
  [EVIDENCE_PATHS.hours]: { field: 'schema', prefix: 'zill.validation.hours_in_zone/' },
  [EVIDENCE_PATHS.forecast]: { field: 'schema', prefix: 'zill.validation.forecast_skill/' },
  [EVIDENCE_PATHS.cohort]: { field: 'kind', prefix: 'zill.validation.cohort/' },
  [EVIDENCE_PATHS.cohortV01]: { field: 'kind', prefix: 'zill.validation.cohort/' },
  [EVIDENCE_PATHS.cohortV02]: { field: 'kind', prefix: 'zill.validation.cohort/' },
}

async function load(path: string): Promise<Settled> {
  try {
    const res = await fetch(path)
    if (res.status === 404) return { status: 'missing', path }
    if (!res.ok) return { status: 'error', path, message: `HTTP ${res.status}` }
    const text = await res.text()
    if (/^\s*</.test(text)) return { status: 'missing', path }
    const data: unknown = JSON.parse(text)
    const check = SCHEMA[path]
    if (check) {
      const tag = data && typeof data === 'object' ? (data as Record<string, unknown>)[check.field] : undefined
      if (typeof tag !== 'string' || !tag.startsWith(check.prefix)) {
        return { status: 'error', path, message: `unexpected schema ${typeof tag === 'string' ? `"${tag}"` : '(none)'}` }
      }
    }
    return { status: 'ready', data }
  } catch (err) {
    return { status: 'error', path, message: err instanceof Error ? err.message : String(err) }
  }
}

function request(path: string): Promise<Settled> {
  let p = cache.get(path)
  if (!p) {
    p = load(path)
    cache.set(path, p)
    // A failed read may succeed later (e.g. after `npm run validate`): let the next mount retry.
    void p.then((s) => {
      if (s.status !== 'ready') cache.delete(path)
    })
  }
  return p
}

/** Loads one validation file once per page session (shared across mounts). */
export function useValidationFile<T>(path: string, enabled = true): FileState<T> {
  const [state, setState] = useState<{ path: string; value: FileState<T> }>({ path, value: { status: 'loading' } })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void request(path).then((s) => {
      if (alive) setState({ path, value: s as FileState<T> })
    })
    return () => {
      alive = false
    }
  }, [path, enabled])
  return state.path === path ? state.value : { status: 'loading' }
}

export interface EvidenceData {
  reference: FileState<ReferenceFile>
  hours: FileState<HoursFile>
  forecast: FileState<ForecastFile>
  cohort: FileState<CohortFile>
}

export function useEvidenceData(): EvidenceData {
  return {
    reference: useValidationFile<ReferenceFile>(EVIDENCE_PATHS.reference),
    hours: useValidationFile<HoursFile>(EVIDENCE_PATHS.hours),
    forecast: useValidationFile<ForecastFile>(EVIDENCE_PATHS.forecast),
    cohort: useValidationFile<CohortFile>(EVIDENCE_PATHS.cohort),
  }
}
