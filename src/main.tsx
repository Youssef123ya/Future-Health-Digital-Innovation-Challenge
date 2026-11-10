import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './ui/App'
import { VIEW_COMPONENTS } from './ui/views'
import { bootstrap } from './ui/bootstrap'

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

// Wire the stores and load the scenario named in the URL (default peak-day); views render their loading states meanwhile.
bootstrap().catch((err: unknown) => {
  console.error('Zill start-up failed', err)
})

createRoot(root).render(
  <StrictMode>
    <App views={VIEW_COMPONENTS} />
  </StrictMode>,
)
