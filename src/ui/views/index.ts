import type { ComponentType } from 'react'
import type { ViewProps } from '../App'
import type { ViewId } from '../router'
import { OverviewView } from './overview/OverviewView'
import { SupervisorView } from './supervisor/SupervisorView'
import { WorkerView } from './worker/WorkerView'
import { MedicView } from './medic/MedicView'
import { RegulatorView } from './regulator/RegulatorView'
import { GovernanceView } from './governance/GovernanceView'
import { LabView } from './lab/LabView'
import { EvidenceView } from './evidence/EvidenceView'

/** Route → view component map passed to <App views={...} /> (src/main.tsx). */
export const VIEW_COMPONENTS: Record<ViewId, ComponentType<ViewProps>> = {
  overview: OverviewView,
  supervisor: SupervisorView,
  worker: WorkerView,
  medic: MedicView,
  regulator: RegulatorView,
  governance: GovernanceView,
  lab: LabView,
  evidence: EvidenceView,
}
