/**
 * Live demo (#/demo): the crew supervisor console and one worker's phone side by side on one simulated clock, with the
 * narration rail (scenario script and what to watch for). The view used for the demo video.
 *
 * Composition only: SupervisorView and WorkerView are mounted with synthetic routes (query `embed=demo`), and each reads
 * its own data through the state hooks with explicit ids (the supervisor actor and the device worker from uiStore), so
 * the console stays projected through privacy.project and the phone shows only its own worker's detail. The presenter
 * picks which worker's phone is shown (uiStore.setDeviceWorker); the same choice drives `#/worker/demo`.
 *
 * Layout: below xl the panes stack (rail, phone, console); from xl the console and the phone sit side by side under the
 * rail; from 2xl the rail becomes a third column.
 */
import { useMemo } from 'react'
import { useStore } from 'zustand'
import { ExternalLink, HardHat, Smartphone } from 'lucide-react'
import { uiStore } from '../../../state'
import { useSim, useUi } from '../../../state/hooks'
import { LANGUAGES } from '../../../i18n'
import { PhoneFrame, cx } from '../../components'
import type { ViewProps } from '../../App'
import { VIEW_META, pathFor, toHref, type Route } from '../../router'
import { SupervisorView } from '../supervisor/SupervisorView'
import { WorkerView } from '../worker/WorkerView'
import { NarrationRail } from './NarrationRail'
import { buildDemoCrew } from '../../../data/workforce'
import { tourStore } from '../../tour/tourStore'

const PERSONA_TITLES: ReadonlyMap<string, string> = new Map(buildDemoCrew().personas.map((p) => [p.workerId, p.title]))

const PANE_HEAD = 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5'
const OPEN_LINK =
  'ms-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-muted hover:bg-canvas hover:text-ink'

/** A route object for a view mounted inside the demo (never the address bar). */
function embeddedRoute(id: 'supervisor' | 'worker', query: Readonly<Record<string, string>>, workerId?: string): Route {
  const q = { ...query, embed: 'demo' }
  if (id === 'worker') {
    const wid = workerId ?? 'demo'
    return { id, pattern: VIEW_META.worker.pattern, path: pathFor('worker', { id: wid }), params: { id: wid }, query: q }
  }
  return { id, pattern: VIEW_META.supervisor.pattern, path: pathFor('supervisor'), params: {}, query: q }
}

/** Worker picker for the phone pane: crews in roster order; demo-crew personas carry their story title. */
function PhonePicker() {
  const crews = useSim((s) => s.crews)
  const roster = useSim((s) => s.roster)
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  if (crews.length === 0) return null
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted">
      <span className="shrink-0">Phone of</span>
      <select
        value={deviceWorkerId ?? ''}
        onChange={(e) => uiStore.getState().setDeviceWorker(e.target.value || null)}
        className="h-8 min-w-0 max-w-[16rem] truncate rounded-lg border border-line-strong bg-surface px-2 text-sm font-medium text-ink"
      >
        {deviceWorkerId === null && <option value="">Choose a worker</option>}
        {crews.map((c) => (
          <optgroup key={c.id} label={c.name}>
            {c.workerIds.map((id) => {
              const title = PERSONA_TITLES.get(id)
              return (
                <option key={id} value={id}>
                  {roster[id]?.displayName ?? id}
                  {title ? ` — ${title}` : ''}
                </option>
              )
            })}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

export function DemoView({ route }: ViewProps) {
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  const language = useUi((s) => s.language)
  const dir = useUi((s) => s.dir)
  const scenarioId = useSim((s) => s.scenarioId)
  const supervisorRoute = useMemo(() => embeddedRoute('supervisor', route.query), [route.query])
  const workerRoute = useMemo(() => embeddedRoute('worker', route.query, deviceWorkerId ?? undefined), [route.query, deviceWorkerId])
  const shareQuery = scenarioId ? { scenario: scenarioId } : undefined
  // During the guided tour the script rail steps aside so the console and the phone are both on screen.
  const touring = useStore(tourStore, (s) => s.active)

  return (
    <div className={cx('grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto]', !touring && '2xl:grid-cols-[20rem_minmax(0,1fr)_auto]')}>
      <h1 className="sr-only">Live demo: supervisor console and worker phone</h1>

      {!touring && <NarrationRail className="xl:col-span-2 2xl:col-span-1 2xl:max-h-[calc(100dvh-9rem)] 2xl:overflow-y-auto 2xl:pe-1" />}

      <section
        aria-labelledby="demo-console-title"
        className="order-3 flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-sm xl:order-none"
      >
        <div className={cx(PANE_HEAD, 'bg-surface')}>
          <HardHat aria-hidden size={18} className="text-shade" />
          <h2 id="demo-console-title" className="text-sm font-semibold text-ink">
            Supervisor console
          </h2>
          <span className="text-xs text-muted">Tablet · level and action only, never clinical detail</span>
          <a href={toHref(pathFor('supervisor', undefined, shareQuery))} target="_blank" rel="noreferrer" className={OPEN_LINK}>
            Open in its own tab
            <ExternalLink aria-hidden size={13} />
          </a>
        </div>
        <div className="min-h-[24rem] flex-1 p-3 sm:p-4 xl:max-h-[calc(100dvh-9rem)] xl:overflow-y-auto">
          <SupervisorView route={supervisorRoute} />
        </div>
      </section>

      <section aria-labelledby="demo-phone-title" data-tour="demo-phone" className="order-2 flex min-w-0 flex-col items-center gap-3 xl:order-none">
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3 py-2 xl:w-[414px]">
          <Smartphone aria-hidden size={18} className="text-shade" />
          <h2 id="demo-phone-title" className="text-sm font-semibold text-ink">
            Worker phone
          </h2>
          <PhonePicker />
          {deviceWorkerId && (
            <a href={toHref(pathFor('worker', { id: deviceWorkerId }, shareQuery))} target="_blank" rel="noreferrer" className={OPEN_LINK}>
              <span className="sr-only">Open this phone in its own tab</span>
              <ExternalLink aria-hidden size={13} />
            </a>
          )}
        </div>
        <PhoneFrame label="Worker phone screen" caption="Simulated device · the worker’s own data stays on this phone">
          <div className="zill-phone contents" lang={LANGUAGES[language].bcp47} dir={dir}>
            <WorkerView route={workerRoute} />
          </div>
        </PhoneFrame>
      </section>
    </div>
  )
}
