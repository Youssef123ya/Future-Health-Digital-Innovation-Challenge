import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './ui/App'
import { VIEW_COMPONENTS, prefetchView } from './ui/views'
import { bootstrap } from './ui/bootstrap'
import { SimClockBar } from './ui/shell/SimClockBar'
import { UpdatePrompt } from './ui/shell/UpdatePrompt'
import { WorkerPersonaPanel } from './ui/views/worker/PersonaPanel'
import { GuidedTour } from './ui/tour/GuidedTour'

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

// Wire the stores and load the scenario named in the URL (default peak-day); views render their loading states meanwhile.
bootstrap().catch((err: unknown) => {
  console.error('Zill start-up failed', err)
})

createRoot(root).render(
  <StrictMode>
    <App
      views={VIEW_COMPONENTS}
      status={(route) => <SimClockBar route={route} />}
      workerAside={(route) => <WorkerPersonaPanel route={route} />}
      prefetch={prefetchView}
    />
    <GuidedTour />
    <UpdatePrompt />
  </StrictMode>,
)
