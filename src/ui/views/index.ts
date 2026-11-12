import { lazy, type ComponentType } from 'react'
import type { ViewProps } from '../App'
import type { ViewId } from '../router'
import { OverviewView } from './overview/OverviewView'

type ViewModule = { default: ComponentType<ViewProps> }

/**
 * Code splitting: the shell and the Overview are in the first download; every other screen is its own chunk, fetched
 * on first visit (or earlier, when its navigation entry is hovered or focused: {@link prefetchView}). The service worker
 * precaches every chunk, so the screens still open offline after the first load (vite.config.ts workbox globPatterns).
 */
const LOADERS: Readonly<Record<Exclude<ViewId, 'overview'>, () => Promise<ViewModule>>> = {
  demo: () => import('./demo/DemoView').then((m) => ({ default: m.DemoView })),
  supervisor: () => import('./supervisor/SupervisorView').then((m) => ({ default: m.SupervisorView })),
  worker: () => import('./worker/WorkerView').then((m) => ({ default: m.WorkerView })),
  medic: () => import('./medic/MedicView').then((m) => ({ default: m.MedicView })),
  regulator: () => import('./regulator/RegulatorView').then((m) => ({ default: m.RegulatorView })),
  governance: () => import('./governance/GovernanceView').then((m) => ({ default: m.GovernanceView })),
  lab: () => import('./lab/LabView').then((m) => ({ default: m.LabView })),
  evidence: () => import('./evidence/EvidenceView').then((m) => ({ default: m.EvidenceView })),
}

/** Route → view component map passed to <App views={...} /> (src/main.tsx). */
export const VIEW_COMPONENTS: Record<ViewId, ComponentType<ViewProps>> = {
  overview: OverviewView,
  demo: lazy(LOADERS.demo),
  supervisor: lazy(LOADERS.supervisor),
  worker: lazy(LOADERS.worker),
  medic: lazy(LOADERS.medic),
  regulator: lazy(LOADERS.regulator),
  governance: lazy(LOADERS.governance),
  lab: lazy(LOADERS.lab),
  evidence: lazy(LOADERS.evidence),
}

const prefetched = new Set<ViewId>()

/** Starts downloading a screen's chunk ahead of navigation (nav hover/focus); safe to call repeatedly. */
export function prefetchView(id: ViewId): void {
  if (id === 'overview' || prefetched.has(id)) return
  prefetched.add(id)
  LOADERS[id]().catch(() => prefetched.delete(id))
}
