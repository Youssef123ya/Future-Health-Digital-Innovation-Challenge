/**
 * State of the guided 2-minute demo (tourSteps.ts): whether it runs, the current step, auto-advance on or paused, and
 * the end screen. The tour borrows the phone and the clock while it runs, so it snapshots the phone choices on start
 * and gives them back when it stops.
 */
import { createStore } from 'zustand/vanilla'
import { simStore, uiStore, type SimSpeed } from '../../state'
import { phonePrefsStore, type PhonePrefs } from '../views/worker/phonePrefs'
import { TOUR_STEPS, nextIndex } from './tourSteps'

export interface TourState {
  active: boolean
  index: number
  /** Auto-advance running (false = paused by the viewer). */
  playing: boolean
  /** The end screen is shown (the last step finished or the viewer pressed Finish). */
  ended: boolean
  /** Bumped on every (re)entry of a step, so the runner re-applies it. */
  rev: number
}

interface Snapshot {
  deviceWorkerId: string | null
  phones: Readonly<Record<string, PhonePrefs>>
  speed: SimSpeed
}

let snapshot: Snapshot | null = null

export const tourStore = createStore<TourState>()(() => ({ active: false, index: 0, playing: true, ended: false, rev: 0 }))

export function startTour(index = 0): void {
  if (!tourStore.getState().active) {
    snapshot = { deviceWorkerId: uiStore.getState().deviceWorkerId, phones: phonePrefsStore.getState().byWorker, speed: simStore.getState().speed }
  }
  tourStore.setState((s) => ({ active: true, index: Math.max(0, Math.min(index, TOUR_STEPS.length - 1)), playing: true, ended: false, rev: s.rev + 1 }))
}

export function stopTour(): void {
  if (!tourStore.getState().active) return
  tourStore.setState({ active: false, ended: false, playing: true })
  if (snapshot) {
    phonePrefsStore.setState({ byWorker: snapshot.phones })
    if (snapshot.deviceWorkerId) uiStore.getState().setDeviceWorker(snapshot.deviceWorkerId)
    simStore.getState().pause()
    simStore.getState().setSpeed(snapshot.speed)
    snapshot = null
  }
}

export function goToStep(index: number): void {
  if (index < 0 || index >= TOUR_STEPS.length) return
  tourStore.setState((s) => ({ index, ended: false, rev: s.rev + 1 }))
}

export function nextStep(): void {
  const { index } = tourStore.getState()
  const n = nextIndex(index)
  if (n === null) tourStore.setState({ ended: true, playing: false })
  else goToStep(n)
}

export function previousStep(): void {
  const s = tourStore.getState()
  if (s.ended) tourStore.setState((x) => ({ ended: false, rev: x.rev + 1 }))
  else goToStep(s.index - 1)
}

export function setTourPlaying(playing: boolean): void {
  tourStore.setState({ playing })
}
