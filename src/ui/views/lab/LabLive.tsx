/**
 * Live panel of the Simulation lab: the running shared world (the one the supervisor, worker and medic views show,
 * driven by the clock in the top bar) with each virtual worker's simulated ground truth next to what the engine
 * displayed, and the selected worker's truth-vs-estimate trace so far.
 *
 * Ground truth comes ONLY through state/hooks useLabWorkers (selectLabWorkers) and selectLabTrace — the Lab's sanctioned
 * readers of WorkerView.truth / WorkerMinute. SIMULATED COHORT: Lab view only.
 */
import { useMemo } from 'react'
import { FlaskConical, Play, Radio } from 'lucide-react'
import { MINUTE_MS, epochFromLocal } from '../../../engine/time'
import { RISK_LEVELS } from '../../../engine/types'
import { getScenario } from '../../../sim/scenarios'
import { isZillPolicy, policyUsesWearable } from '../../../sim/types'
import { selectLabTrace, simStore, type LabWorkerRow } from '../../../state'
import { useLabWorkers, useSim } from '../../../state/hooks'
import { Badge, Button, Card, DataTable, EmptyState, LevelPill, ProvenanceTag, Section, type DataTableColumn } from '../../components'
import { POLICY_META, fixed, hhmm, rowsFromMinutes } from './labModel'
import { idText } from './labRun'
import { useLab, labStore } from './labStore'
import { TraceCharts } from './TraceCharts'

/** Simulated minutes between live chart refreshes (the clock can run at 300×) [ENG]. */
const LIVE_CHART_STEP_MIN = 5

const LOCATION_TEXT = { sun: 'Sun', shade: 'Shade', indoor_cool: 'Cooled indoors' } as const

function TruthHead({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1" title="Simulated ground truth">
      <FlaskConical size={12} aria-hidden className="shrink-0 text-subtle" />
      {children}
    </span>
  )
}

const COLUMNS: readonly DataTableColumn<LabWorkerRow>[] = [
  {
    id: 'worker',
    header: 'Worker',
    cell: (r) => (
      <button type="button" onClick={() => labStore.getState().selectLiveWorker(r.workerId)} className="block min-w-0 rounded text-start" aria-label={`Chart ${r.displayName}`}>
        <span className="block font-medium text-ink underline-offset-2 hover:underline">{r.displayName}</span>
        <span className="block text-xs text-subtle">
          {r.workerId} · {r.crewId}
        </span>
      </button>
    ),
    sortValue: (r) => r.displayName,
  },
  { id: 'where', header: 'Task · location', cell: (r) => `${r.task?.name ?? 'No task'} · ${LOCATION_TEXT[r.location]}`, sortValue: (r) => r.location, hideBelow: 'lg' },
  {
    id: 'level',
    header: 'Displayed level',
    cell: (r) => (r.level ? <LevelPill level={r.level} size="sm" /> : <span className="text-subtle">Engine off</span>),
    sortValue: (r) => (r.level ? RISK_LEVELS.indexOf(r.level) : -1),
  },
  {
    id: 'ect',
    header: 'ECTemp estimate',
    cell: (r) => (r.ectempBand ? <span className="tabular-nums">{r.ectempBand.centreC.toFixed(1)} ± {r.ectempBand.halfWidthC.toFixed(1)} °C</span> : <span className="text-subtle">—</span>),
    sortValue: (r) => r.ectempBand?.centreC ?? null,
    numeric: true,
    hideBelow: 'sm',
  },
  { id: 'mtl', header: 'Minutes to limit', cell: (r) => (r.minutesToLimit === null ? '—' : Math.round(r.minutesToLimit)), sortValue: (r) => r.minutesToLimit, numeric: true, hideBelow: 'md' },
  {
    id: 'core',
    header: <TruthHead>Core °C</TruthHead>,
    cell: (r) => <span className="font-semibold">{fixed(r.truth?.coreC)}</span>,
    sortValue: (r) => r.truth?.coreC ?? null,
    numeric: true,
  },
  {
    id: 'hr',
    header: <TruthHead>HR true / measured</TruthHead>,
    cell: (r) => (
      <span className="tabular-nums">
        {fixed(r.truth?.hrBpm, 0)} / {r.hrMeasuredBpm === null ? '—' : r.hrMeasuredBpm}
      </span>
    ),
    sortValue: (r) => r.truth?.hrBpm ?? null,
    numeric: true,
    hideBelow: 'sm',
  },
  { id: 'dehy', header: <TruthHead>Dehydration %</TruthHead>, cell: (r) => fixed(r.truth?.dehydrationPct), sortValue: (r) => r.truth?.dehydrationPct ?? null, numeric: true, hideBelow: 'md' },
  {
    id: 'sym',
    header: <TruthHead>Symptoms</TruthHead>,
    cell: (r) => (r.truth && r.truth.symptoms.length > 0 ? <span className="text-ink">{r.truth.symptoms.map(idText).join(', ')}</span> : <span className="text-subtle">none</span>),
    sortValue: (r) => r.truth?.symptoms.length ?? 0,
    hideBelow: 'lg',
  },
]

export function LabLive() {
  const status = useSim((s) => s.status)
  const scenarioId = useSim((s) => s.scenarioId)
  const view = useSim((s) => s.view)
  const playing = useSim((s) => s.playing)
  const rows = useLabWorkers()
  const selected = useLab((s) => s.liveWorkerId)

  const t = view?.t ?? null
  const config = view?.config ?? null
  const workerId = selected && rows.some((r) => r.workerId === selected) ? selected : ([...rows].sort((a, b) => (b.truth?.coreC ?? 0) - (a.truth?.coreC ?? 0))[0]?.workerId ?? null)
  const bucket = t === null ? null : Math.floor(t / (LIVE_CHART_STEP_MIN * MINUTE_MS))
  // The world is mutated in place by the clock; re-read its trace once per LIVE_CHART_STEP_MIN simulated minutes.
  const trace = useMemo(() => (workerId && bucket !== null ? rowsFromMinutes(selectLabTrace(simStore.getState().world, workerId)) : []), [workerId, bucket])
  const sortedRows = useMemo(() => [...rows].sort((a, b) => (b.truth?.coreC ?? 0) - (a.truth?.coreC ?? 0)), [rows])

  if (status === 'loading') return <EmptyState icon={Radio} title="Loading the live world…" description="Weather and roster are loading." />
  if (!view || !config) {
    return (
      <EmptyState
        icon={Radio}
        title="No live world is running"
        description="The live world is the shared simulation behind every console. Load a scenario to see its ground truth here."
        action={
          <Button icon={Play} onClick={() => void simStore.getState().loadScenario('peak-day')}>
            Load “Peak heat at Musaffah”
          </Button>
        }
      />
    )
  }

  const t0 = epochFromLocal(`${config.date}T${config.shift.start}`)
  const tEnd = epochFromLocal(`${config.date}T${config.shift.end}`)
  const selectedRow = rows.find((r) => r.workerId === workerId) ?? null
  const profile = view.workers.find((w) => w.profile.id === workerId)?.profile ?? null
  const wearableExpected = !!profile && policyUsesWearable(config.policy) && profile.hasWearable && profile.consent.wearable
  const traceOn = config.trace === 'full'

  return (
    <div className="space-y-6">
      <Card padding="md" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-subtle">
            <Radio size={12} aria-hidden /> Live world {playing ? '· running' : '· paused'}
          </p>
          <h2 className="text-lg font-semibold text-ink">{scenarioId ? getScenario(scenarioId).title : view.site.name}</h2>
          <p className="text-sm text-muted">
            {view.site.name} · {config.date} · <span className="font-semibold text-ink tabular-nums">{hhmm(view.t)}</span> · {POLICY_META[config.policy].name} · seed <span className="font-mono">{config.seed}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ProvenanceTag kind="simulated" label="Simulated ground truth" detail="Read only in the lab; never shown in an operational view" />
          <ProvenanceTag kind="real_weather" />
          <Badge tone="outline">Clock: top bar</Badge>
        </div>
      </Card>

      <Section
        title="Ground truth next to what the engine displayed"
        provenance="simulated"
        provenanceDetail="Simulated ground truth"
        description={
          <>
            Columns marked <FlaskConical size={12} aria-label="flask" className="inline-block -translate-y-px" /> are <strong className="font-semibold text-ink">simulated ground truth</strong> from the hidden truth model: the engine never sees them. ECTemp is an estimated strain indicator with its uncertainty band, not a measured core temperature. Pick a worker's name to chart that worker below.
          </>
        }
      >
        <DataTable
          columns={COLUMNS}
          rows={sortedRows}
          rowKey={(r) => r.workerId}
          caption={`Live world at ${hhmm(view.t)}: simulated ground truth and engine output per virtual worker`}
          hideCaption
          dense
          stickyHeader
          maxHeight={420}
          rowClassName={(r) => (r.workerId === workerId ? 'bg-shade-bg/70' : undefined)}
          empty="No workers on shift."
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <label htmlFor="lab-live-worker" className="font-semibold text-ink">
            Chart worker
          </label>
          <select
            id="lab-live-worker"
            value={workerId ?? ''}
            onChange={(e) => labStore.getState().selectLiveWorker(e.target.value)}
            className="h-9 min-w-0 max-w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink"
          >
            {sortedRows.map((r) => (
              <option key={r.workerId} value={r.workerId}>
                {r.displayName} · {r.workerId} · core {fixed(r.truth?.coreC)} °C
              </option>
            ))}
          </select>
        </div>
      </Section>

      {selectedRow && (
        <Section
          title={`${selectedRow.displayName}: trace so far`}
          provenance="simulated"
          provenanceDetail="Simulated ground truth vs engine estimate"
          description={`Updates every ${LIVE_CHART_STEP_MIN} simulated minutes while the clock runs.`}
        >
          <Card padding="md">
            {traceOn && trace.length > 0 ? (
              <TraceCharts
                rows={trace}
                t0={t0}
                tEnd={tEnd}
                events={[]}
                wearableExpected={wearableExpected}
                wearableNote={!policyUsesWearable(config.policy) ? 'No wearable data under this policy' : 'No band paired or no wearable consent'}
                label={`${selectedRow.displayName} in the live world`}
                focus="latest"
                engineOn={isZillPolicy(config.policy) || config.shadow}
              />
            ) : (
              <EmptyState size="sm" title={traceOn ? 'No minutes simulated yet' : 'This world keeps no per-minute trace'} description={traceOn ? 'Start the clock in the top bar.' : 'Run an experiment for full traces.'} />
            )}
          </Card>
        </Section>
      )}
    </div>
  )
}
