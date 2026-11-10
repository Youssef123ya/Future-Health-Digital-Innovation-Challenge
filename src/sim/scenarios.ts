/**
 * Named demo scenarios for the Simulation lab and the demo timeline (docs/SIMULATION.md §3): a real cached day, a roster,
 * a SimConfig partial and scripted events with narration. Every scenario runs the same world simulation as the
 * back-test (sim/worldsim.ts); scripted events only inject what a person or the system would do (a buddy report, a
 * sensor or network failure) — they never touch the ground truth.
 *
 * Evidence class: SIMULATED COHORT on real weather (docs/SIMULATION.md). Day choices are documented per scenario from the
 * cached data (public/data/weather/demo-days.json `why`, or a screening ranking of the cached IFS archive).
 */
import type { Crew, WorkerProfile } from '../engine/types'
import { epochFromLocal } from '../engine/time'
import { getSite, type SiteId } from '../data/sites'
import { DEFAULT_WORKFORCE_SEED, DEMO_CREW_ID, generateWorkforce } from '../data/workforce'
import { makeSimConfig, createWorld, runSiteDay, type SimConfigInput, type World } from './worldsim'
import type { SimDataLoader } from './simdata'
import type { ScriptedEvent, SimConfig, SimData, SiteDayResult } from './types'

/** Identifiers of the named demo scenarios. */
export type ScenarioId = 'peak-day' | 'humid-day' | 'mild-day' | 'saadiyat-peak' | 'shade-only'

/** A named demo scenario. */
export interface Scenario {
  id: ScenarioId
  title: string
  description: string
  siteId: SiteId
  /** Local date 'YYYY-MM-DD'. */
  date: string
  /** Why this day (data provenance of the choice). */
  dayChoice: string
  /** SimConfig partial (site, date, policy, seed, shift, trace, explicit roster, disruptions); see {@link scenarioConfig}. */
  config: SimConfigInput
  /** Scripted events in time order, each with a narration note for the demo timeline. */
  events: ScriptedEvent[]
  /** What the scenario is meant to show. */
  demonstrates: string[]
}

/** Shift used by every demo scenario: 05:00–17:00 local (UAE summer early start) [ENG]. */
export const SCENARIO_SHIFT = Object.freeze({ start: '05:00', end: '17:00' })

/**
 * Demo roster for a site: generated crews of data/workforce.ts (seed DEFAULT_WORKFORCE_SEED) — plus the fixed Musaffah
 * demo crew with its five personas when `includeDemoCrew` (Musaffah only). Basis: data/workforce.ts generateWorkforce
 * (the same seed always yields the same workforce).
 */
export function scenarioRoster(siteId: SiteId, generatedCrews: number, includeDemoCrew: boolean): { crews: Crew[]; workers: WorkerProfile[] } {
  const wf = generateWorkforce({ seed: DEFAULT_WORKFORCE_SEED, crewsPerSite: generatedCrews, sites: [getSite(siteId)], includeDemoCrew })
  const crews = wf.crews.filter((c) => c.siteId === siteId)
  const ids = new Set(crews.flatMap((c) => c.workerIds))
  return { crews, workers: wf.workers.filter((w) => ids.has(w.id)) }
}

const at = (date: string, hhmm: string): number => epochFromLocal(`${date}T${hhmm}`)

/** The demo-crew crewmate whose buddy reports confusion in 'peak-day' (W-D2F6, full consent, wearable; data/workforce.ts). */
export const PEAK_DAY_CONFUSION_WORKER = 'W-D2F6'

const PEAK_DATE = '2025-08-01'
const peakRoster = scenarioRoster('musaffah', 1, true)
const humidRoster = peakRoster
const saadiyatRoster = scenarioRoster('saadiyat', 2, false)
const alainRoster = scenarioRoster('alain', 2, false)

/** The named demo scenarios (policy zill_full by default; the Lab can switch policy or shadow mode). */
export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: 'peak-day',
    title: 'Peak heat at Musaffah',
    description:
      'The hottest day of summer 2025 at the Musaffah industrial area, with the demo crew (five personas) and a generated pipe-rack crew. The environment feed fails late morning, a buddy reports confusion in the afternoon, and the site network drops for twenty minutes.',
    siteId: 'musaffah',
    date: PEAK_DATE,
    dayChoice:
      'public/data/weather/demo-days.json musaffah_2025-08-01: rank 1 of 122 summer-2025 days by daily-max Liljegren WBGT at Musaffah (40.2 °C) and highest daylight shade-WBGT screening proxy (36 °C at 14:00).',
    config: {
      siteId: 'musaffah',
      date: PEAK_DATE,
      seed: 'zill-demo-peak-day',
      policy: 'zill_full',
      shift: { ...SCENARIO_SHIFT },
      trace: 'full',
      crews: peakRoster.crews,
      workers: peakRoster.workers,
      disruptions: { envSensorFailure: { from: '11:00', to: '11:30' }, networkOutage: { from: '15:30', to: '15:50' } },
    },
    events: [
      {
        at: '11:00',
        injection: { kind: 'system', what: 'sensor_fail' },
        note: 'The environment feed fails: devices keep their cached forecast and the engine falls back down its fail-safe chain (a missing input can only make the result more conservative).',
      },
      { at: '11:30', injection: { kind: 'system', what: 'sensor_ok' }, note: 'The environment feed is back.' },
      {
        at: '14:10',
        injection: { kind: 'checkin', checkin: { t: at(PEAK_DATE, '14:10'), workerId: PEAK_DAY_CONFUSION_WORKER, by: 'buddy', symptoms: ['confusion'] } },
        note: 'A buddy reports that Ramesh is confused: a red-flag symptom → EMERGENCY — call 998, cool first, stay with him; the first aider and supervisor are alerted at once.',
      },
      {
        at: '15:30',
        injection: { kind: 'system', what: 'network_down' },
        note: 'Site network outage: worker phones keep assessing and alerting locally; messages to supervisors and first aiders queue until the network returns.',
      },
      { at: '15:50', injection: { kind: 'system', what: 'network_up' }, note: 'Network restored: queued messages are delivered.' },
    ],
    demonstrates: [
      'day-2 arrival: stricter limit and ADOSH exclusion from Medium/High TWL zones',
      'FR coveralls + hood: clothing adjustment drives shade breaks',
      'beta-blocker: heart-rate rules off, never falsely reassuring',
      'fasting: no drink reminders during fasting hours',
      'declined consent: same environment- and work-based protection',
      'fail-safe environment chain; red-flag emergency routing; offline operation',
    ],
  },
  {
    id: 'humid-day',
    title: 'Humid day at Musaffah',
    description:
      'The most humid day of summer 2025 at Musaffah: lower air temperature but very little evaporative cooling, so sweat stops working long before the thermometer looks alarming.',
    siteId: 'musaffah',
    date: '2025-09-09',
    dayChoice: 'public/data/weather/demo-days.json musaffah_2025-09-09: tagged most_humid (highest summer-2025 dew point at Musaffah in the cached archive).',
    config: {
      siteId: 'musaffah',
      date: '2025-09-09',
      seed: 'zill-demo-humid-day',
      policy: 'zill_full',
      shift: { ...SCENARIO_SHIFT },
      trace: 'full',
      crews: humidRoster.crews,
      workers: humidRoster.workers,
    },
    events: [],
    demonstrates: ['humidity limits evaporative cooling (PHS projection, TWL)', 'midday break still in force (15 Jun–15 Sep)'],
  },
  {
    id: 'mild-day',
    title: 'Mild November day at Musaffah',
    description:
      'A mild late-November day outside the midday-break season: the low-heat comparison day. It shows how often Zill still alerts when heat stress is low (alert burden), which individual limits bind for heavy work in protective clothing, and the statutory break.',
    siteId: 'musaffah',
    date: '2025-11-26',
    dayChoice: 'public/data/weather/demo-days.json musaffah_2025-11-26: tagged mild_november (the cached mild comparison day).',
    config: {
      siteId: 'musaffah',
      date: '2025-11-26',
      seed: 'zill-demo-mild-day',
      policy: 'zill_full',
      shift: { ...SCENARIO_SHIFT },
      trace: 'full',
      crews: peakRoster.crews,
      workers: peakRoster.workers,
    },
    events: [],
    demonstrates: ['alert burden when heat stress is low', 'no midday break outside 15 Jun–15 Sep', 'statutory break'],
  },
  {
    id: 'saadiyat-peak',
    title: 'Peak WBGT on Saadiyat Island',
    description: 'Coastal construction on Saadiyat Island on its peak-WBGT day of summer 2025: sea-breeze humidity plus full sun on concrete and rebar crews.',
    siteId: 'saadiyat',
    date: '2025-07-21',
    dayChoice: 'public/data/weather/demo-days.json saadiyat_2025-07-21: tagged peak_wbgt_liljegren (highest daily-max Liljegren WBGT at Saadiyat in summer 2025).',
    config: {
      siteId: 'saadiyat',
      date: '2025-07-21',
      seed: 'zill-demo-saadiyat-peak',
      policy: 'zill_full',
      shift: { ...SCENARIO_SHIFT },
      trace: 'full',
      crews: saadiyatRoster.crews,
      workers: saadiyatRoster.workers,
    },
    events: [],
    demonstrates: ['construction crews: planner moves flexible heavy work early', 'ADOSH TWL zone work/rest cycles'],
  },
  {
    id: 'shade-only',
    title: 'Al Ain with shade only',
    description:
      'Inland road works at Al Ain on a hot day, where the only rest area is an open shade canopy. Shade WBGT in the Gulf summer often exceeds the resting limit, so work/rest cycles buy less recovery than an air-conditioned cabin, and a reviewed recovery needs 45 min in shade instead of 30 in a cooled cabin.',
    siteId: 'alain',
    date: '2025-07-24',
    dayChoice:
      'Highest daylight (06:00–18:00) shade-WBGT screening proxy at Al Ain in summer 2025 (0.7·Tw_Stull + 0.3·Ta ≈ 31.9 °C; Tmax 45.2 °C), ranked from the cached ECMWF IFS archive public/data/weather/archive/alain_2025.json (screening only, not the Zill WBGT).',
    config: {
      siteId: 'alain',
      date: '2025-07-24',
      seed: 'zill-demo-shade-only',
      policy: 'zill_full',
      shift: { ...SCENARIO_SHIFT },
      trace: 'full',
      crews: alainRoster.crews,
      workers: alainRoster.workers,
    },
    events: [],
    demonstrates: ['rest area matters: shade-only vs cooled cabins (site.restArea)', 'PHS recovery needs 45 min in shade'],
  },
] satisfies Scenario[])

/** Scenario ids in display order (the Lab's scenario picker). Basis: {@link SCENARIOS}. */
export const SCENARIO_IDS: readonly ScenarioId[] = SCENARIOS.map((s) => s.id)

/** The scenario with this id. Basis: {@link SCENARIOS}. @throws RangeError for an unknown id. */
export function getScenario(id: ScenarioId): Scenario {
  const s = SCENARIOS.find((x) => x.id === id)
  if (!s) throw new RangeError(`Unknown scenario '${String(id)}'`)
  return s
}

/**
 * Complete SimConfig for a scenario (worldsim.makeSimConfig defaults), with optional overrides — e.g. another policy or
 * shadow mode for the Lab's comparison. Basis: sim/types.ts SimConfig.
 */
export function scenarioConfig(id: ScenarioId, overrides: Partial<SimConfigInput> = {}): SimConfig {
  const s = getScenario(id)
  return makeSimConfig({
    ...s.config,
    ...overrides,
    siteId: s.siteId,
    date: s.date,
    behaviour: { ...(s.config.behaviour ?? {}), ...(overrides.behaviour ?? {}) },
    disruptions: { ...(s.config.disruptions ?? {}), ...(overrides.disruptions ?? {}) },
  })
}

/** Load the scenario's SimData (weather for its site and date, its roster) with any SimDataLoader. Basis: sim/simdata.ts. */
export async function loadScenarioData(id: ScenarioId, loader: SimDataLoader): Promise<SimData> {
  const s = getScenario(id)
  return loader.load(s.siteId, s.date, s.config.crews && s.config.workers ? { crews: s.config.crews, workers: s.config.workers } : {})
}

/** A world for a scenario with its scripted events, ready for chunked stepping in the UI (worldsim.stepWorld). Basis: docs/SIMULATION.md §3. */
export function createScenarioWorld(id: ScenarioId, data: SimData, overrides: Partial<SimConfigInput> = {}): World {
  return createWorld(scenarioConfig(id, overrides), data, { script: getScenario(id).events })
}

/** Run a whole scenario day (worldsim.runSiteDay with the scenario's scripted events). Basis: docs/SIMULATION.md §3. */
export function runScenario(id: ScenarioId, data: SimData, overrides: Partial<SimConfigInput> = {}): SiteDayResult {
  return runSiteDay(scenarioConfig(id, overrides), data, { script: getScenario(id).events })
}

/** True when the roster contains the Musaffah demo crew (personas; data/workforce.ts buildDemoCrew). */
export function hasDemoCrew(s: Scenario): boolean {
  return (s.config.crews ?? []).some((c) => c.id === DEMO_CREW_ID)
}
