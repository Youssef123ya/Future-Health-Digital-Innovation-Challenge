/**
 * React bindings for the state layer: store hooks and role-projected view-model hooks. Each projecting hook computes
 * its model in render (pure selectors) and appends the audit drafts after render (useEffect → governanceStore,
 * de-duplicated), so a render never mutates a store. Basis: ARCHITECTURE §7 (every access is logged).
 */
import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { simStore, type SimStoreState } from './simStore'
import { uiStore, resolveDeviceWorkerId, type UiState } from './uiStore'
import { buildDataFlowFeed, governanceStore, type DataFlowItem, type GovernanceState } from './governanceStore'
import {
  selectBuddyCards,
  selectFirstAiderCases,
  selectHseAggregates,
  selectLabWorkers,
  selectOccHealthCases,
  selectRegulatorAggregates,
  selectSupervisorBoard,
  selectWorkerDevice,
  type FirstAiderModel,
  type BuddyCard,
  type HseAggregates,
  type LabWorkerRow,
  type OccHealthModel,
  type Projected,
  type RegulatorAggregates,
  type SelectorInput,
  type SupervisorBoard,
  type WorkerDeviceModel,
} from './selectors'

/** Subscribes to a slice of the simulation store. */
export function useSim<T>(selector: (s: SimStoreState) => T): T {
  return useStore(simStore, selector)
}

/** Subscribes to a slice of the UI store. */
export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(uiStore, selector)
}

/** Subscribes to a slice of the governance store. */
export function useGovernance<T>(selector: (s: GovernanceState) => T): T {
  return useStore(governanceStore, selector)
}

/** The selector input (world view, roster, device logs, remote payloads, consent ledger); null before a world exists. */
export function useSelectorInput(): SelectorInput | null {
  const view = useSim((s) => s.view)
  const crews = useSim((s) => s.crews)
  const roster = useSim((s) => s.roster)
  const device = useSim((s) => s.device)
  const remote = useSim((s) => s.remotePayloads)
  const consent = useGovernance((s) => s.consent)
  return useMemo(() => (view ? { view, crews, roster, device, remote, consent } : null), [view, crews, roster, device, remote, consent])
}

/** Runs a projecting selector and logs its audit drafts after render. */
export function useProjected<T>(compute: (input: SelectorInput) => Projected<T>, deps: readonly unknown[]): T | null {
  const input = useSelectorInput()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => (input ? compute(input) : null), [input, ...deps])
  useEffect(() => {
    if (result && result.audit.length > 0) void governanceStore.getState().recordAll(result.audit)
  }, [result])
  return result ? result.model : null
}

/** The supervisor console for an actor (default: the UI actor). */
export function useSupervisorBoard(actorId?: string): SupervisorBoard | null {
  const uiActor = useUi((s) => s.actorId)
  const id = actorId ?? uiActor
  return useProjected((input) => selectSupervisorBoard(input, id), [id])
}

/** The worker phone (default: the device worker; 'demo' route alias resolved). */
export function useWorkerDevice(routeWorkerId?: string | null): WorkerDeviceModel | null {
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  const id = resolveDeviceWorkerId(routeWorkerId, { deviceWorkerId })
  const model = useProjected((input) => (id ? selectWorkerDevice(input, id) : { model: null, audit: [] }), [id])
  return model ?? null
}

/** Buddy cards of a buddy (default: the device worker). */
export function useBuddyCards(buddyId?: string | null): BuddyCard[] {
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  const id = buddyId ?? deviceWorkerId
  return useProjected((input) => (id ? selectBuddyCards(input, id) : { model: [], audit: [] }), [id]) ?? []
}

/** The first aider's active cases (default actor: the UI actor). */
export function useFirstAiderCases(actorId?: string): FirstAiderModel | null {
  const uiActor = useUi((s) => s.actorId)
  const id = actorId ?? uiActor
  return useProjected((input) => selectFirstAiderCases(input, id), [id])
}

/** Occupational health's escalated cases (default actor: the UI actor). */
export function useOccHealthCases(actorId?: string): OccHealthModel | null {
  const uiActor = useUi((s) => s.actorId)
  const id = actorId ?? uiActor
  return useProjected((input) => selectOccHealthCases(input, id), [id])
}

/** HSE aggregates (k = 5). */
export function useHseAggregates(actorId?: string): HseAggregates | null {
  const uiActor = useUi((s) => s.actorId)
  const id = actorId ?? uiActor
  return useProjected((input) => selectHseAggregates(input, id), [id])
}

/** Regulator aggregates (k = 10). */
export function useRegulatorAggregates(actorId?: string): RegulatorAggregates | null {
  const uiActor = useUi((s) => s.actorId)
  const id = actorId ?? uiActor
  return useProjected((input) => selectRegulatorAggregates(input, id), [id])
}

/** Lab rows with ground truth — for the Simulation Lab ONLY. */
export function useLabWorkers(): LabWorkerRow[] {
  const view = useSim((s) => s.view)
  return useMemo(() => (view ? selectLabWorkers(view) : []), [view])
}

/** The data-flow inspector feed (exact outbound payload per worker). */
export function useDataFlowFeed(): DataFlowItem[] {
  const input = useSelectorInput()
  return useMemo(() => (input ? buildDataFlowFeed(input) : []), [input])
}
