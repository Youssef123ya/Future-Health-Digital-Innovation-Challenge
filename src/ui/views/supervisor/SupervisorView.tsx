/**
 * Supervisor console (#/supervisor; ARCHITECTURE §9): header with site data-quality badges and headline stats, the alert
 * feed (individual alerts prominent, site conditions calm, suppressed advisories as a quiet count), the crew board, the
 * site heat strip and today's plan. Individual data comes only from useSupervisorBoard (privacy.project, audit logged);
 * actions go through the state injection API.
 */
import { useMemo, useRef, useState } from 'react'
import { Gauge, Loader2, ShieldCheck, Thermometer, TriangleAlert, Wifi, WifiOff } from 'lucide-react'
import type { ViewProps } from '../../App'
import type { CrewPlan } from '../../../engine/planner'
import { getRulePack, middayBreakWindow } from '../../../engine/regulation'
import type { RiskLevel } from '../../../engine/types'
import { uiStore } from '../../../state'
import { useSim } from '../../../state/hooks'
import type { CrewBoard } from '../../../state/selectors'
import { EmptyState, LEVEL_STYLES, Stat, cx } from '../../components'
import { AlertFeed } from './AlertFeed'
import { CrewBoardPanel } from './CrewBoard'
import { PlannerPanel } from './PlannerPanel'
import { SiteHeatStrip } from './SiteHeatStrip'
import { SiteBadge } from './controls'
import { dateText, envBadge, hhmm, minutesShort, networkBadge, planBasisInfo, plural, sensorBadge, type ReassignOption } from './model'
import { acknowledgeAlert, assignTask, resolveCase, useConsoleData, type ConsoleData } from './useConsole'

const LEVELS: readonly RiskLevel[] = ['safe', 'caution', 'high', 'stop', 'emergency']
const LEVEL_SHORT: Readonly<Record<RiskLevel, string>> = { safe: 'Safe', caution: 'Caution', high: 'High', stop: 'Stop', emergency: 'Emerg.' }

/** Keeps the previous crews array while crew ids and plan objects are unchanged (the planner re-renders less). */
function useStableCrews(crews: readonly CrewBoard[] | undefined): readonly CrewBoard[] {
  const ref = useRef<{ ids: string; plans: Array<CrewPlan | null>; value: readonly CrewBoard[] }>({ ids: '', plans: [], value: [] })
  if (!crews) return ref.current.value
  const ids = crews.map((c) => c.crew.id).join('|')
  const plans = crews.map((c) => c.plan)
  const same = ids === ref.current.ids && plans.length === ref.current.plans.length && plans.every((p, i) => p === ref.current.plans[i])
  if (!same) ref.current = { ids, plans, value: crews }
  return ref.current.value
}

export function SupervisorView(_props: ViewProps) {
  const { data, actors, actorId, status, error } = useConsoleData()
  const scenarioId = useSim((s) => s.scenarioId)
  const config = useSim((s) => s.view?.config)
  const dayPlan = useSim((s) => s.view?.plan ?? null)
  const provenance = useSim((s) => s.data?.weather.provenance)
  const injectionError = useSim((s) => s.injectionError)
  const worldKey = `${scenarioId ?? ''}|${config?.seed ?? ''}|${config?.policy ?? ''}|${config?.date ?? ''}`

  const [assigned, setAssigned] = useState<{ key: string; map: Record<string, { label: string; t: number }> }>({ key: worldKey, map: {} })
  const assignedMap = assigned.key === worldKey ? assigned.map : {}
  const stableCrews = useStableCrews(data?.board.crews)

  const firstHourT = data?.board.site.hours[0]?.t ?? null
  const packId = config?.packId
  const midday = useMemo(() => (packId && firstHourT !== null ? middayBreakWindow(firstHourT, getRulePack(packId)) : null), [packId, firstHourT])
  const dayPlanLite = useMemo(() => (dayPlan ? { notes: dayPlan.notes, warnings: dayPlan.warnings, planBasis: dayPlan.planBasis } : null), [dayPlan])

  if (!data) {
    return (
      <div className="py-10">
        {status === 'error' ? (
          <EmptyState icon={TriangleAlert} tone="unavailable" title="The simulated site day could not start" description={error ?? 'Unknown error.'} />
        ) : (
          <EmptyState icon={Loader2} title="Loading the simulated site day…" description="Weather, crews and the day plan are being prepared." />
        )}
      </div>
    )
  }

  const now = data.now
  const onAck = (alertId: string) => acknowledgeAlert(alertId, actorId)
  const onResolve = (workerId: string, alertId: string) => resolveCase(workerId, alertId)
  const onAssign = (workerId: string, o: ReassignOption) => {
    assignTask(workerId, o)
    setAssigned((prev) => ({ key: worldKey, map: { ...(prev.key === worldKey ? prev.map : {}), [workerId]: { label: o.label, t: now } } }))
  }
  const restArea = data.board.site.site.restArea

  return (
    <div className="@container flex flex-col gap-6">
      <ConsoleHeader data={data} actors={actors} actorId={actorId} dayBasis={dayPlan?.planBasis ?? null} />

      {injectionError && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-caution-fill/50 bg-caution-bg px-3 py-2 text-sm text-ink">
          <TriangleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-caution" />
          Last action was not applied: {injectionError}
        </p>
      )}

      <StatsRow data={data} />

      <div className="grid items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]">
        <AlertFeed
          data={data}
          restArea={restArea}
          assigned={assignedMap}
          onAssign={onAssign}
          onAck={onAck}
          onResolve={onResolve}
          className="@5xl:col-start-2 @5xl:row-start-1"
        />
        <CrewBoardPanel
          data={data}
          restArea={restArea}
          assigned={assignedMap}
          onAssign={onAssign}
          onAck={onAck}
          className="@5xl:col-start-1 @5xl:row-start-1"
        />
      </div>

      <SiteHeatStrip
        hours={data.board.site.hours}
        heat={data.board.site.heat}
        now={now}
        restArea={restArea}
        midday={midday}
        provenance={provenance ?? []}
        worldKey={worldKey}
      />

      <PlannerPanel crews={stableCrews} dayPlan={dayPlanLite} names={data.names} now={Math.floor(now / 60_000) * 60_000} />
    </div>
  )
}

function ConsoleHeader({
  data,
  actors,
  actorId,
  dayBasis,
}: {
  data: ConsoleData
  actors: ReturnType<typeof useConsoleData>['actors']
  actorId: string
  dayBasis: 'tables' | 'monitored' | null
}) {
  const { board, now } = data
  const site = board.site
  const actor = actors.find((a) => a.actorId === actorId) ?? null
  const title = board.crews.length === 1 ? board.crews[0].crew.name : board.crews.length > 1 ? `${board.crews.length} crews` : 'No crew selected'
  const basis = planBasisInfo(board.crews[0]?.plan?.planBasis ?? dayBasis ?? 'tables')
  const env = envBadge(site.env)
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-shade uppercase">Supervisor console · {site.site.name}</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-sm text-muted tabular-nums">
            {dateText(now)} · {hhmm(now)} simulated time{actor ? ` · Supervisor ${actor.supervisorName}` : ''}
            {site.finished && ' · shift ended'}
          </p>
        </div>
        {actors.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Crew
            <select
              value={actorId}
              onChange={(e) => uiStore.getState().setSupervisorActor(e.target.value)}
              className="h-10 min-w-56 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink shadow-xs"
            >
              {actors.map((a) => (
                <option key={a.actorId} value={a.actorId}>
                  {a.crewName} · {a.supervisorName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-2" aria-label="Site data status">
        <SiteBadge badge={env} icon={Thermometer} />
        <SiteBadge badge={sensorBadge(site.sensor)} icon={Gauge} />
        <SiteBadge badge={networkBadge(site.network)} icon={site.network === 'online' ? Wifi : WifiOff} />
        <SiteBadge badge={{ state: 'ok', label: basis.label, detail: basis.explanation }} icon={ShieldCheck} />
      </ul>
    </header>
  )
}

function StatsRow({ data }: { data: ConsoleData }) {
  const { board, totals, tta, water } = data
  const total = LEVELS.reduce((n, l) => n + totals[l], 0)
  const individual = board.alertCounts.individual
  const exposure = board.alertCounts.exposure
  const suppressed = board.alertCounts.suppressed
  return (
    <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
      <div className="col-span-2 flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-xs @4xl:col-span-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted">Workers by level</span>
          <span className="text-xs text-muted tabular-nums">{total} reporting</span>
        </div>
        <ul className="grid grid-cols-5 gap-1" aria-label="Workers by level">
          {LEVELS.map((l) => {
            const s = LEVEL_STYLES[l]
            const Icon = s.icon
            const n = totals[l]
            return (
              <li key={l} className={cx('flex flex-col items-center gap-0.5 rounded-lg py-1.5', n > 0 ? s.tint : 'bg-canvas')}>
                <Icon aria-hidden size={15} className={n > 0 ? s.text : 'text-subtle'} />
                <span className={cx('text-lg leading-none font-semibold tabular-nums', n > 0 ? 'text-ink' : 'text-subtle')}>{n}</span>
                <span className={cx('text-[10px] font-medium', n > 0 ? s.text : 'text-subtle')}>{LEVEL_SHORT[l]}</span>
              </li>
            )
          })}
        </ul>
      </div>
      <Stat
        framed
        label="Alerts needing attention"
        value={individual}
        hint={
          <span>
            {exposure} site {exposure === 1 ? 'condition' : 'conditions'}
            {suppressed > 0 && ` · ${suppressed} logged, not sent`}
          </span>
        }
        info="Open alerts at High risk or above for your crews. Individual alerts are about one person; site conditions are shared heat or rule alerts for a crew."
      />
      <Stat
        framed
        label="Median time to acknowledge"
        value={tta.median === null ? null : tta.median < 10 ? Math.round(tta.median * 10) / 10 : Math.round(tta.median)}
        precision={tta.median !== null && tta.median < 10 ? 1 : 0}
        unit="min"
        hint={tta.n > 0 ? `${plural(tta.n, 'supervisor acknowledgement', 'supervisor acknowledgements')} this session` : 'No acknowledgements yet'}
        info={`From an alert being raised to the supervisor’s acknowledgement, alerts at High risk or above, since this console opened${tta.median !== null ? ` (median ${minutesShort(tta.median)})` : ''}.`}
      />
      <Stat
        framed
        label="Water planned today"
        value={water.planned > 0 ? Math.round(water.litres) : null}
        unit="L"
        hint={water.planned > 0 ? `${plural(water.coolers, 'cooler', 'coolers')} · refill every 2 h` : 'No plan yet'}
        provenance="projection"
        provenanceDetail="Planner water allowance per work block (rule pack water guidance), summed over your crews."
        className="col-span-2 @4xl:col-span-1"
      />
    </div>
  )
}
