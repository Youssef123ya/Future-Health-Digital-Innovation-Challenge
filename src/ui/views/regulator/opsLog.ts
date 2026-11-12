/**
 * Event-history collector for the regulator and HSE consoles: keeps every published `task`, `shift` and `alert` event of the
 * running site-day, the way a site server would receive the device and roster event stream. The world view carries only
 * the latest events (sim/worldsim.ts WORLD_PARAMS.viewEvents), so this module listens to every published view from
 * start-up (`startOpsLog()` runs when the view module loads, before bootstrap positions the clock) and appends the
 * events it has not seen, by object identity (worldView slices the same event objects). A view whose event window no
 * longer overlaps the last one seen marks the history incomplete from that point; a rebuilt world (new scenario,
 * reset, backward jump) starts a new history.
 *
 * The history holds pseudonymous task/location marks only; it is never rendered. ./opsModel.ts turns it into
 * k-suppressed aggregates through `privacy.aggregateFor`.
 */
import { useSyncExternalStore } from 'react'
import { simStore, type SimStore } from '../../../state'
import { WORLD_PARAMS } from '../../../sim/worldsim'
import type { SimEvent, WorldView } from '../../../sim/types'
import type { Alert } from '../../../engine/types'
import { shiftWindow } from '../../../sim/metrics'
import { EMPTY_HISTORY, type OpsHistory, type TaskMark } from './opsModel'

interface LogState {
  config: WorldView['config'] | null
  lastT: number
  lastEvent: SimEvent | null
  tasks: Map<string, TaskMark[]>
  shiftEnds: Map<string, number>
  alerts: Map<string, Alert>
  coveredFromT: number | null
  complete: boolean
}

const fresh = (): LogState => ({ config: null, lastT: -Infinity, lastEvent: null, tasks: new Map(), shiftEnds: new Map(), alerts: new Map(), coveredFromT: null, complete: false })

let state: LogState = fresh()
let snapshot: OpsHistory = EMPTY_HISTORY
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = { tasks: state.tasks, shiftEnds: state.shiftEnds, alerts: state.alerts, coveredFromT: state.coveredFromT, complete: state.complete }
  for (const l of listeners) l()
}

function absorb(e: SimEvent): void {
  if (e.kind === 'task') {
    let list = state.tasks.get(e.workerId)
    if (!list) state.tasks.set(e.workerId, (list = []))
    list.push({ t: e.t, taskId: e.taskId, location: e.location })
  } else if (e.kind === 'alert') {
    state.alerts.set(e.alert.id, e.alert)
  } else if (e.kind === 'shift' && e.what === 'end') {
    const prev = state.shiftEnds.get(e.workerId)
    if (prev === undefined || e.t < prev) state.shiftEnds.set(e.workerId, e.t)
  }
}

/** Appends the unseen events of a published view (exported for tests). */
export function ingestView(view: WorldView): void {
  const evs = view.events
  const rebuilt = view.config !== state.config || view.t < state.lastT
  let start = 0
  let changed = false
  if (!rebuilt && state.lastEvent) {
    const idx = evs.lastIndexOf(state.lastEvent)
    if (idx >= 0) start = idx + 1
    else if (evs.length < WORLD_PARAMS.viewEvents) {
      // Fewer events than the window holds and the last seen one is gone: a new world with the same config object.
      state = fresh()
    } else {
      // The window moved past the last seen event: events in between were not observed.
      state.complete = false
      state.coveredFromT = evs[0]?.t ?? view.t
      changed = true
    }
  }
  if (rebuilt || state.config === null) {
    state = fresh()
    state.config = view.config
    // A window that is not full holds every event since the world was created.
    state.complete = evs.length < WORLD_PARAMS.viewEvents
    state.coveredFromT = state.complete ? shiftWindow(view.config).startT : (evs[0]?.t ?? view.t)
    start = 0
    changed = true
  }
  if (start < evs.length) changed = true
  for (let i = start; i < evs.length; i++) absorb(evs[i])
  if (evs.length > 0) state.lastEvent = evs[evs.length - 1]
  state.lastT = view.t
  if (changed) publish()
}

let unsubscribe: (() => void) | null = null

/** Starts collecting from the simulation store (idempotent). */
export function startOpsLog(store: SimStore = simStore): void {
  if (unsubscribe) return
  let last: WorldView | null = null
  const onState = (view: WorldView | null): void => {
    if (view && view !== last) {
      last = view
      ingestView(view)
    }
  }
  unsubscribe = store.subscribe((s) => onState(s.view))
  onState(store.getState().view)
}

/** Stops collecting and clears the history (tests). */
export function stopOpsLog(): void {
  unsubscribe?.()
  unsubscribe = null
  state = fresh()
  snapshot = EMPTY_HISTORY
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const getSnapshot = (): OpsHistory => snapshot

/** The current history outside React (tests, exports). */
export const getOpsHistory = (): OpsHistory => snapshot

/** The current task history (a new object whenever it changes). */
export function useOpsHistory(): OpsHistory {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
