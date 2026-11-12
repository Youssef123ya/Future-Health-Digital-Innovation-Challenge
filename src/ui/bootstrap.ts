/**
 * App start-up: wires the stores once (state/index.ts connectAppState) and loads a scenario from the URL.
 *
 * URL parameters, read from the page query (`index.html?scenario=peak-day#/supervisor`) or the hash query
 * (`#/supervisor?scenario=peak-day&t=10:30`); the hash query wins when both are given:
 *
 * | key        | values                                                    | default     |
 * |------------|-----------------------------------------------------------|-------------|
 * | `scenario` | a ScenarioId (sim/scenarios.ts SCENARIO_IDS)              | `peak-day`  |
 * | `policy`   | a PolicyId (sim/types.ts POLICY_IDS)                      | scenario's  |
 * | `t`        | local shift time `HH:mm` to jump to after loading         | shift start |
 * | `speed`    | one of state/simStore.ts SIM_SPEEDS (1, 10, 60, 300)      | store's     |
 * | `play`     | `1` starts the clock after loading                        | paused      |
 * | `lang`     | a LangCode (ar, en, hi, ur, bn, ml, tl, ne)               | browser     |
 * | `clock`    | `lead` (broadcast this tab's clock) or `follow` (follow other tabs) | see below |
 *
 * Cross-tab clock [ENG]: a phone tab (`#/worker/…`) follows by default and every other tab leads, so a presenter can
 * open the console in one tab and a worker's phone in another and drive both from the console. One leader is the
 * intended set-up (state/syncBus.ts); `clock=` overrides the default.
 *
 * Nothing here touches the simulation or engine maths: it only calls the public store actions.
 */
import { connectAppState, governanceStore, isSimSpeed, simStore, uiStore } from '../state'
import { SCENARIO_IDS, type ScenarioId } from '../sim/scenarios'
import { POLICY_IDS, type PolicyId } from '../sim/types'
import { isLangCode } from '../i18n'
import type { SimConfigInput } from '../sim/worldsim'
import { parseHash } from './router'

/** The scenario shown when the URL names none. */
export const DEFAULT_SCENARIO: ScenarioId = 'peak-day'

/** Start-up options parsed from the URL (see the module doc). */
export interface BootOptions {
  scenario: ScenarioId
  policy: PolicyId | null
  time: string | null
  speed: number | null
  play: boolean
  lang: string | null
  clock: 'lead' | 'follow' | null
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Parses start-up options from a page query string and a location hash. Unknown or invalid values are ignored. */
export function parseBootOptions(search: string, hash: string): BootOptions {
  const page = Object.fromEntries(new URLSearchParams(search.startsWith('?') ? search.slice(1) : search))
  const q: Record<string, string> = { ...page, ...parseHash(hash).query }
  const scenario = (SCENARIO_IDS as readonly string[]).includes(q.scenario ?? '') ? (q.scenario as ScenarioId) : DEFAULT_SCENARIO
  const policy = (POLICY_IDS as readonly string[]).includes(q.policy ?? '') ? (q.policy as PolicyId) : null
  const time = q.t && HHMM.test(q.t) ? q.t : null
  const speedNum = q.speed !== undefined ? Number(q.speed) : NaN
  const speed = isSimSpeed(speedNum) ? speedNum : null
  const clock = q.clock === 'lead' || q.clock === 'follow' ? q.clock : null
  return { scenario, policy, time, speed, play: q.play === '1' || q.play === 'true', lang: q.lang ?? null, clock }
}

/** True while the current hash route shows a worker's phone. */
function onDeviceRoute(): boolean {
  return parseHash(window.location.hash).id === 'worker'
}

let started = false
let clockFollows: boolean | null = null

/**
 * True when this tab follows another tab's simulated clock (a phone tab by default, or `clock=follow`), so the shell
 * can say so next to its clock controls; false when it leads; null before start-up.
 */
export function clockFollowsOtherTab(): boolean | null {
  return clockFollows
}

/**
 * Wires the stores and loads the scenario named in the URL. Idempotent (a second call is a no-op, e.g. under React
 * StrictMode or hot reload). Returns a promise that settles when the scenario is loaded and positioned.
 */
export async function bootstrap(): Promise<void> {
  if (started) return
  started = true
  const opts = parseBootOptions(window.location.search, window.location.hash)

  let storage: Storage | null = null
  try {
    storage = window.localStorage
  } catch {
    storage = null
  }
  uiStore.getState().hydrate({ languages: typeof navigator !== 'undefined' ? navigator.languages : null, storage })
  if (opts.lang && isLangCode(opts.lang)) uiStore.getState().setLanguage(opts.lang)

  const follow = opts.clock ? opts.clock === 'follow' : onDeviceRoute()
  clockFollows = follow
  connectAppState({ isDevice: onDeviceRoute, shareClock: !follow, followClock: follow })

  if (import.meta.env.DEV) {
    ;(window as unknown as { __zill?: unknown }).__zill = { simStore, uiStore, governanceStore }
  }

  const overrides: Partial<SimConfigInput> = opts.policy ? { policy: opts.policy } : {}
  const sim = simStore.getState()
  await sim.loadScenario(opts.scenario, overrides)
  if (opts.time) await simStore.getState().jumpTo(opts.time)
  if (opts.speed !== null && isSimSpeed(opts.speed)) simStore.getState().setSpeed(opts.speed)
  if (opts.play) simStore.getState().play()
}
