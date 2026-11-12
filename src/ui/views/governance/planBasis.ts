/**
 * Site settings of the governance centre: the plan-basis switch (Standard limits = policy zill_full; Monitored mode =
 * policy zill_monitored, a site opt-in with occupational-health sign-off) and its change log for the session.
 * The switch reloads the scenario under the new policy and returns to the same simulated time and play state, using
 * public simStore actions only (as the shell's plan-basis switch does). Basis: docs/dev/engine-api-wave2d.md §1–§2;
 * sim/types.ts policyPlanBasis.
 */
import { createStore } from 'zustand/vanilla'
import { simStore } from '../../../state'
import type { PolicyId } from '../../../sim/types'

/** One plan-basis change, as logged with its sign-off. */
export interface PlanBasisChange {
  id: number
  /** Simulated time of the change (epoch ms), null when no shift was loaded. */
  t: number | null
  from: PolicyId | null
  to: PolicyId
  /** Occupational-health sign-off for an opt-in to monitored mode; null for a return to the standard limits. */
  signedOffBy: string | null
}

export interface SiteSettingsState {
  changes: readonly PlanBasisChange[]
  record(change: Omit<PlanBasisChange, 'id'>): void
}

/** Session log of plan-basis changes made in the governance centre. */
export const siteSettingsStore = createStore<SiteSettingsState>()((set) => ({
  changes: [],
  record: (change) => set((s) => ({ changes: [...s.changes, { ...change, id: s.changes.length + 1 }] })),
}))

/** Plain-English names of the plan bases and comparison policies. */
export const POLICY_NAMES: Readonly<Record<PolicyId, string>> = Object.freeze({
  ban_only: 'Midday ban only (comparison)',
  site_index: 'Site TWL index (comparison)',
  zill_env: 'Zill without wearable (comparison)',
  zill_full: 'Standard limits',
  zill_monitored: 'Monitored mode',
})

/**
 * Reloads the current scenario under `policy`, then jumps back to the same simulated time and resumes playing if it
 * was. Resolves false when nothing is loaded or the load failed. User actions of the old world are not replayed.
 */
export async function switchPlanBasis(policy: PolicyId): Promise<boolean> {
  const s = simStore.getState()
  if (!s.scenarioId) return false
  const t = s.view?.t ?? null
  const wasPlaying = s.playing
  await s.loadScenario(s.scenarioId, { ...s.overrides, policy })
  if (simStore.getState().status !== 'ready') return false
  if (t !== null) await simStore.getState().jumpTo(t)
  if (wasPlaying) simStore.getState().play()
  return true
}
