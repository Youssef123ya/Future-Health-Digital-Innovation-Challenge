/**
 * State layer (ARCHITECTURE §4 `state/`): simulation clock and world, UI role/language, governance (audit chain,
 * consent ledger), role-projected selectors and the cross-tab sync bus. React hooks live in ./hooks.
 */
export * from './simStore'
export * from './uiStore'
export * from './selectors'
export * from './governanceStore'
export * from './syncBus'

import { simStore } from './simStore'
import { bindDocumentLanguage, connectUiToSim, uiStore } from './uiStore'
import { connectGovernanceToSim, governanceStore } from './governanceStore'
import { connectSimToBus, getSyncBus, type SimBusOptions } from './syncBus'

/** Options of {@link connectAppState}. */
export interface AppStateOptions {
  /** Connect the cross-tab sync bus (default true; a no-op without BroadcastChannel). */
  bus?: boolean
  /** True while this tab shows a worker's phone (it then publishes that worker's sync payloads). */
  isDevice?: () => boolean
  shareClock?: boolean
  followClock?: boolean
}

/**
 * Wires the app's stores once at start-up: consent ledger seeded from each world, UI selections kept valid, document
 * language/direction applied, and (optionally) the sync bus. Returns a function that undoes every connection.
 * Basis: ARCHITECTURE §3, §7, §9.
 */
export function connectAppState(opts: AppStateOptions = {}): () => void {
  const offs: Array<() => void> = [
    connectGovernanceToSim(simStore, governanceStore),
    connectUiToSim(simStore, uiStore),
    bindDocumentLanguage(uiStore),
  ]
  if (opts.bus !== false) {
    const busOpts: SimBusOptions = {
      deviceWorkerId: () => (opts.isDevice?.() ? uiStore.getState().deviceWorkerId : null),
      actorId: () => uiStore.getState().actorId,
      ...(opts.shareClock !== undefined ? { shareClock: opts.shareClock } : {}),
      ...(opts.followClock !== undefined ? { followClock: opts.followClock } : {}),
    }
    offs.push(connectSimToBus(simStore, getSyncBus(), busOpts))
  }
  return () => {
    for (const off of offs) off()
  }
}
