/**
 * Console-local state of the medic view: what this console observed from the role projections (location for the rest
 * count, symptoms first released, consented clinical points for the trend) and the responder's own entries (cooling
 * checklist, hand-over confirmation, incident outcome). Per tab and in memory only; nothing here leaves the console.
 * Everything is keyed by case (worker + start of the stop episode, medicModel.ts caseKeyOf), so an escalation from stop
 * to emergency (a new alert id) keeps the checklist running. Observations are recorded after render (useEffect), so a
 * render never mutates a store. A new scenario clears everything; a rewind drops what lies after the new time.
 * Consented clinical points are purged as soon as a projection no longer releases them (consent revoked, case closed,
 * or the console switched to the first-aider role): data minimisation, ARCHITECTURE §7.
 */
import { useEffect } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { SymptomId } from '../../../engine/types'
import type { FirstAidStep } from '../../../engine/clinical'
import type { HeatIncidentOutcome } from '../../../engine/regulation'
import type { ProjectedData } from '../../../engine/privacy'
import { appendObs, parseCaseLocation, type CaseKind, type MedicRole, type PlaceObs, type TrendPoint } from './medicModel'

/** What this console saw of one case. */
export interface CaseObs {
  place: PlaceObs[]
  /** First time each symptom was released to this console. */
  symptomsSeen: Partial<Record<SymptomId, number>>
  /** Last time the released symptom set gained a symptom. */
  symptomsChangedT: number | null
  /** First observation of the case on this console. */
  firstSeenT: number
}

/** The responder's entries for one case. */
export interface CaseLocal {
  steps: Partial<Record<FirstAidStep['id'], number>>
  coolingStartT: number | null
  handoverConfirmed: boolean
  outcome: HeatIncidentOutcome
}

export const NO_OUTCOME: HeatIncidentOutcome = Object.freeze({
  fatality: false,
  inpatientHospitalTreatment: false,
  lossOfConsciousnessOrResuscitation: false,
  unableToWorkNextShift: false,
})

const EMPTY_CASE: CaseLocal = Object.freeze({ steps: {}, coolingStartT: null, handoverConfirmed: false, outcome: NO_OUTCOME }) as CaseLocal
const EMPTY_OBS: CaseObs = Object.freeze({ place: [], symptomsSeen: {}, symptomsChangedT: null, firstSeenT: 0 }) as CaseObs
const NO_POINTS: readonly TrendPoint[] = Object.freeze([])

/** The last sign-off made on this console, for the confirmation notice. */
export interface SignoffNotice {
  name: string
  t: number
  role: MedicRole
  kind: CaseKind
  emergency: boolean
}

export interface MedicLocalState {
  scenarioKey: string | null
  lastT: number | null
  obs: Record<string, CaseObs>
  /** Consented clinical points per case (occupational health only). */
  clinical: Record<string, TrendPoint[]>
  cases: Record<string, CaseLocal>
  lastSignoff: SignoffNotice | null
}

/** One released case record as observed (fields absent from `data` were withheld). */
export interface ObservedCase {
  key: string
  data: ProjectedData
  fields: readonly string[]
  clinicalReleased?: boolean
}

const initial = (scenarioKey: string | null): MedicLocalState => ({ scenarioKey, lastT: null, obs: {}, clinical: {}, cases: {}, lastSignoff: null })

export const medicStore = createStore<MedicLocalState>()(() => initial(null))

/** Subscribes to a slice of the medic console state. */
export function useMedic<T>(selector: (s: MedicLocalState) => T): T {
  return useStore(medicStore, selector)
}

function pruneAfter(s: MedicLocalState, t: number): Partial<MedicLocalState> {
  const obs: Record<string, CaseObs> = {}
  for (const [key, o] of Object.entries(s.obs)) {
    if (o.firstSeenT > t) continue
    const seen: Partial<Record<SymptomId, number>> = {}
    for (const [k, v] of Object.entries(o.symptomsSeen) as Array<[SymptomId, number]>) if (v <= t) seen[k] = v
    obs[key] = { ...o, place: o.place.filter((p) => p.t <= t), symptomsSeen: seen, symptomsChangedT: o.symptomsChangedT !== null && o.symptomsChangedT <= t ? o.symptomsChangedT : null }
  }
  const clinical: Record<string, TrendPoint[]> = {}
  for (const [key, pts] of Object.entries(s.clinical)) {
    const kept = pts.filter((p) => p.t <= t)
    if (kept.length > 0) clinical[key] = kept
  }
  const cases: Record<string, CaseLocal> = {}
  for (const [key, c] of Object.entries(s.cases)) {
    const steps: CaseLocal['steps'] = {}
    for (const [k, v] of Object.entries(c.steps) as Array<[FirstAidStep['id'], number]>) if (v <= t) steps[k] = v
    cases[key] = { ...c, steps, coolingStartT: c.coolingStartT !== null && c.coolingStartT <= t ? c.coolingStartT : null }
  }
  return { obs, clinical, cases, lastSignoff: s.lastSignoff && s.lastSignoff.t <= t ? s.lastSignoff : null }
}

/**
 * Records one projection result at simulated time `t`. `clinicalMode` = this is the consented clinical-care projection
 * (occupational health): only then are ECTemp/heart-rate points kept, and only for cases with a clinical release;
 * every other point is purged.
 */
export function recordObservations(scenarioKey: string, t: number, cases: readonly ObservedCase[], clinicalMode: boolean): void {
  const s = medicStore.getState()
  let base: MedicLocalState = s
  if (s.scenarioKey !== scenarioKey) base = initial(scenarioKey)
  else if (s.lastT !== null && t < s.lastT) base = { ...s, ...pruneAfter(s, t) }
  const obs = { ...base.obs }
  const clinical: Record<string, TrendPoint[]> = {}
  for (const c of cases) {
    const prev = obs[c.key] ?? { ...EMPTY_OBS, firstSeenT: t }
    let next = prev
    if (c.fields.includes('location')) {
      const loc = parseCaseLocation(c.data.location?.label)
      const last = prev.place[prev.place.length - 1]
      if (!last || last.t !== t || last.resting !== loc.resting || last.place !== loc.place) {
        next = { ...next, place: appendObs(prev.place, { t, place: loc.place, resting: loc.resting }) }
      }
    }
    if (c.fields.includes('symptoms') && c.data.symptoms) {
      const added = c.data.symptoms.filter((x) => next.symptomsSeen[x] === undefined)
      if (added.length > 0) {
        const seen = { ...next.symptomsSeen }
        for (const x of added) seen[x] = t
        next = { ...next, symptomsSeen: seen, symptomsChangedT: t }
      }
    }
    if (next !== prev || obs[c.key] === undefined) obs[c.key] = next
    if (clinicalMode && c.clinicalReleased) {
      clinical[c.key] = appendObs(base.clinical[c.key] ?? [], { t, ct: c.data.ctEstC ?? null, hr: c.data.hrBpm ?? null })
    }
  }
  medicStore.setState({ ...base, obs, clinical, lastT: t })
}

/** Updates the responder's entries of one case. */
export function updateCase(key: string, patch: (c: CaseLocal) => Partial<CaseLocal>): void {
  const s = medicStore.getState()
  const cur = s.cases[key] ?? EMPTY_CASE
  medicStore.setState({ cases: { ...s.cases, [key]: { ...cur, ...patch(cur) } } })
}

export function caseLocalOf(s: MedicLocalState, key: string): CaseLocal {
  return s.cases[key] ?? EMPTY_CASE
}

export function caseObsOf(s: MedicLocalState, key: string): CaseObs {
  return s.obs[key] ?? EMPTY_OBS
}

export function clinicalOf(s: MedicLocalState, key: string): readonly TrendPoint[] {
  return s.clinical[key] ?? NO_POINTS
}

export function noteSignoff(notice: SignoffNotice): void {
  medicStore.setState({ lastSignoff: notice })
}

export function dismissSignoff(): void {
  medicStore.setState({ lastSignoff: null })
}

/** Records each new projection result after render. */
export function useRecordObservations(scenarioKey: string | null, t: number | null, cases: readonly ObservedCase[] | null, clinicalMode: boolean): void {
  useEffect(() => {
    if (scenarioKey === null || t === null || cases === null) return
    recordObservations(scenarioKey, t, cases, clinicalMode)
  }, [scenarioKey, t, cases, clinicalMode])
}
