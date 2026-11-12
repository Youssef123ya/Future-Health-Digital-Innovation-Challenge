/**
 * Scenario, plan-basis and clock helpers for the application shell: the SimClock bar, the live demo and the overview's
 * "start a scenario" buttons. Pure helpers (URL query parsing, labels, dates) are unit-tested; the actions only call the
 * public simStore actions (state/simStore.ts) and never touch the simulation or the engine.
 *
 * URL contract: the same keys as ui/bootstrap.ts (`scenario`, `policy`, `t`, `speed`, `play`), read from the hash query.
 * Bootstrap applies them once at start-up; {@link useScenarioUrlSync} applies later changes (an in-app link such as
 * `#/demo?scenario=humid-day`, a manual edit, Back/Forward), and the shell's own controls write the scenario and policy
 * back so the address bar stays shareable.
 */
import { useEffect } from 'react'
import { isSimSpeed, simStore, type SimSpeed } from '../../state'
import { SCENARIO_IDS, getScenario, type ScenarioId } from '../../sim/scenarios'
import { POLICY_IDS, type PolicyId } from '../../sim/types'
import { navigate, type Route } from '../router'
import { isHhmm } from './time'

// ─────────────────────────────── Plan basis and policy labels ───────────────────────────────

/** One option of the plan-basis switch. */
export interface PlanBasisOption {
  policy: PolicyId
  label: string
  /** One-paragraph explanation for the info tip (plain English, no individual data). */
  description: string
}

/**
 * The two plan bases a site can run (docs/dev/engine-api-wave2d.md §1–§2). Standard limits = policy `zill_full`: the
 * NIOSH/ACGIH WBGT work/rest tables, the ADOSH rule pack and an ISO 7933 screen set the plan. Monitored mode = policy
 * `zill_monitored`: a site opt-in with occupational-health sign-off.
 */
export const PLAN_BASIS_OPTIONS: readonly PlanBasisOption[] = Object.freeze([
  {
    policy: 'zill_full',
    label: 'Standard limits',
    description:
      'The NIOSH/ACGIH WBGT work/rest tables, the ADOSH heat-zone rules and an ISO 7933 screen set every crew plan. Members on an acclimatisation schedule get personal caps.',
  },
  {
    policy: 'zill_monitored',
    label: 'Monitored mode',
    description:
      'A site opt-in with occupational-health sign-off. The WBGT tables become a screen; for an acclimatised worker with valid wearable data, that worker’s own ISO 7933 projection and strain criteria set the limits. If monitoring lapses, the phone returns to the table limits in the same minute.',
  },
])

/** Plain-English names of every policy (shown when the Lab has switched to a policy outside the plan-basis switch). */
export const POLICY_LABELS: Readonly<Record<PolicyId, string>> = Object.freeze({
  ban_only: 'Midday ban only',
  site_index: 'Site TWL index',
  zill_env: 'Zill without wearable',
  zill_full: 'Standard limits',
  zill_monitored: 'Monitored mode',
})

/** The policy every demo scenario starts with (sim/scenarios.ts: all zill_full). */
export const DEFAULT_POLICY: PolicyId = 'zill_full'

/** True for a policy offered by the plan-basis switch. */
export function isPlanBasisPolicy(policy: PolicyId | null | undefined): boolean {
  return PLAN_BASIS_OPTIONS.some((o) => o.policy === policy)
}

// ─────────────────────────────── URL query ───────────────────────────────

/** Scenario keys of a hash query; `null` = absent or invalid (bootstrap ignores invalid values the same way). */
export interface ScenarioQuery {
  scenario: ScenarioId | null
  policy: PolicyId | null
  /** Local shift time 'HH:mm'. */
  t: string | null
  speed: SimSpeed | null
  play: boolean
}

/** Parses the scenario keys of a route query (same rules as ui/bootstrap.ts parseBootOptions, without defaults). */
export function parseScenarioQuery(query: Readonly<Record<string, string>>): ScenarioQuery {
  const scenario = (SCENARIO_IDS as readonly string[]).includes(query.scenario ?? '') ? (query.scenario as ScenarioId) : null
  const policy = (POLICY_IDS as readonly string[]).includes(query.policy ?? '') ? (query.policy as PolicyId) : null
  const speedNum = query.speed !== undefined ? Number(query.speed) : Number.NaN
  return {
    scenario,
    policy,
    t: isHhmm(query.t) ? query.t : null,
    speed: isSimSpeed(speedNum) ? speedNum : null,
    play: query.play === '1' || query.play === 'true',
  }
}

/** Stable identity of a scenario request, used to apply each URL change once. */
export function scenarioQueryKey(q: ScenarioQuery): string {
  return [q.scenario ?? '', q.policy ?? '', q.t ?? '', q.speed ?? '', q.play ? '1' : ''].join('|')
}

/**
 * A route query with the scenario keys replaced: `scenario` set, `policy` set (omitted for the default policy), `t` and
 * `play` set only when given; `speed` dropped. Other keys (`lang`, `clock`…) are kept.
 */
export function withScenarioQuery(
  query: Readonly<Record<string, string>>,
  patch: { scenario: ScenarioId; policy?: PolicyId | null; t?: string | null; play?: boolean },
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) {
    if (k !== 'scenario' && k !== 'policy' && k !== 't' && k !== 'speed' && k !== 'play') out[k] = v
  }
  out.scenario = patch.scenario
  if (patch.policy && patch.policy !== DEFAULT_POLICY) out.policy = patch.policy
  if (patch.t && isHhmm(patch.t)) out.t = patch.t
  if (patch.play) out.play = '1'
  return out
}

/** "path?query" from a route path and a query object (keys in insertion order). */
export function pathWithQuery(path: string, query: Readonly<Record<string, string>>): string {
  const s = new URLSearchParams(query).toString()
  return s ? `${path}?${s}` : path
}

// ─────────────────────────────── Actions (public store API only) ───────────────────────────────

/** The URL key the shell last applied or wrote; {@link useScenarioUrlSync} acts only on a different key. */
let lastAppliedKey: string | null = null

/** Records a scenario request as handled (the shell's own controls call this before they rewrite the URL). */
export function markScenarioQueryApplied(q: ScenarioQuery): void {
  lastAppliedKey = scenarioQueryKey(q)
}

/** The effective policy of the loaded world, else the pending override, else null. */
export function currentPolicy(): PolicyId | null {
  const s = simStore.getState()
  return s.view?.config.policy ?? s.overrides.policy ?? null
}

/**
 * Loads a scenario with an optional policy override, then positions the clock: jump to `t` ('HH:mm' or epoch ms), set
 * the speed, start playing. Every step is a public simStore action, so the sync bus mirrors it to follower tabs.
 */
export async function loadScenarioAt(
  id: ScenarioId,
  opts: { policy?: PolicyId | null; t?: string | number | null; speed?: SimSpeed | null; play?: boolean } = {},
): Promise<void> {
  const s = simStore.getState()
  const keep = s.scenarioId === id ? s.overrides : {}
  const overrides = { ...keep, ...(opts.policy ? { policy: opts.policy } : {}) }
  await s.loadScenario(id, overrides)
  if (simStore.getState().status !== 'ready') return
  if (opts.t !== null && opts.t !== undefined) await simStore.getState().jumpTo(opts.t)
  if (opts.speed) simStore.getState().setSpeed(opts.speed)
  if (opts.play) simStore.getState().play()
}

/**
 * Reloads the current scenario under another policy (the plan-basis switch) and returns to the same simulated time, in
 * the same play state. User actions taken in the old world are not replayed: a policy change starts a new world.
 */
export async function switchPolicyKeepTime(policy: PolicyId): Promise<void> {
  const s = simStore.getState()
  if (!s.scenarioId) return
  const t = s.view?.t ?? null
  const wasPlaying = s.playing
  await s.loadScenario(s.scenarioId, { ...s.overrides, policy })
  if (simStore.getState().status !== 'ready') return
  if (t !== null) await simStore.getState().jumpTo(t)
  if (wasPlaying) simStore.getState().play()
}

/**
 * Writes the loaded scenario and policy into the current route's query (history replace, no extra Back step) so the
 * address can be shared, and marks that request as applied.
 */
export function writeScenarioToUrl(route: Route, scenario: ScenarioId, policy: PolicyId | null): void {
  const query = withScenarioQuery(route.query, { scenario, policy })
  markScenarioQueryApplied(parseScenarioQuery(query))
  navigate(pathWithQuery(route.path, query), { replace: true })
}

/**
 * Starts a demo scenario from the overview: loads it fresh at `t` (paused) under `policy`, then opens the live demo
 * with the matching URL.
 */
export function startScenarioDemo(id: ScenarioId, opts: { t?: string | null; policy?: PolicyId | null } = {}): void {
  const query = withScenarioQuery({}, { scenario: id, policy: opts.policy ?? null, t: opts.t ?? null })
  markScenarioQueryApplied(parseScenarioQuery(query))
  void loadScenarioAt(id, { policy: opts.policy ?? null, t: opts.t ?? null })
  navigate(pathWithQuery('/demo', query))
}

/**
 * Applies scenario keys that appear in the hash query after start-up. Start-up itself is ui/bootstrap.ts: the first
 * call only records the current key. A URL without `scenario` is not a request and changes nothing.
 */
export function useScenarioUrlSync(route: Route): void {
  useEffect(() => {
    const q = parseScenarioQuery(route.query)
    const key = scenarioQueryKey(q)
    if (lastAppliedKey === null) {
      lastAppliedKey = key
      return
    }
    if (key === lastAppliedKey) return
    lastAppliedKey = key
    if (!q.scenario) return
    const s = simStore.getState()
    const policyNow = s.view?.config.policy ?? null
    const wantPolicy = q.policy ?? DEFAULT_POLICY
    if (s.scenarioId !== q.scenario || (policyNow !== null && policyNow !== wantPolicy)) {
      void loadScenarioAt(q.scenario, { policy: q.policy, t: q.t, speed: q.speed, play: q.play })
      return
    }
    void (async () => {
      if (q.t) await simStore.getState().jumpTo(q.t)
      if (q.speed) simStore.getState().setSpeed(q.speed)
      if (q.play) simStore.getState().play()
    })()
  }, [route.query])
}

/** Title of a scenario id, or a neutral fallback while nothing is loaded. */
export function scenarioTitle(id: ScenarioId | null): string {
  if (!id) return 'No scenario loaded'
  try {
    return getScenario(id).title
  } catch {
    return id
  }
}
