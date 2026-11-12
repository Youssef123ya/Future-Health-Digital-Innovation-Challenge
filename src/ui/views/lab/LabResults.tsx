/**
 * Results of a lab experiment: the run summary (day, seed, stamps, weather provenance, assumptions), the per-policy
 * comparison (cards, or a metric × policy table) and the worker explorer (one virtual worker under each policy, with
 * the truth-vs-estimate charts and the event log).
 *
 * Everything here is SIMULATED COHORT — a projection under stated assumptions, not a measured outcome — and the
 * explorer shows simulated ground truth: Lab view only.
 */
import { useId, useMemo, useState } from 'react'
import { CircleAlert, Cpu, FlaskConical, HeartPulse, Hourglass, LayoutGrid, Table2, User, Users } from 'lucide-react'
import { getSite } from '../../../data/sites'
import { MINUTE_MS } from '../../../engine/time'
import { RISK_LEVELS } from '../../../engine/types'
import { getScenario } from '../../../sim/scenarios'
import { isZillPolicy, policyUsesWearable, type PolicyId, type TruthEventKind } from '../../../sim/types'
import { simStore } from '../../../state'
import { Badge, Button, Card, EmptyState, LevelPill, ProvenanceTag, Section, cx } from '../../components'
import {
  METRICS,
  METRIC_GROUP_TEXT,
  POLICY_META,
  TRUTH_EVENT_META,
  baselineOf,
  comparisonHeadline,
  deltaText,
  fixed,
  formatDate,
  harmEvents,
  hhmm,
  hours,
  metricText,
  minutesAtLeast,
  rowsFromPacked,
  shareOfMax,
  type MetricDef,
  type MetricGroup,
} from './labModel'
import { useLab, labStore, type Experiment } from './labStore'
import { EventGlyph, TraceCharts } from './TraceCharts'
import type { LabEventMarker, LabEventSource, LabRunWorker, PolicyRunResult } from './labTypes'

const DISCLAIMER = 'Simulated cohort — a projection under stated assumptions, not a measured outcome.'
const CARD_METRICS = new Set(['excessive', 'severe', 'critical', 'dehydration', 'work', 'rest', 'water', 'alerts', 'suppressed', 'adherence'])
const GROUPS: readonly MetricGroup[] = ['harm', 'work', 'alerts']

const ACCLIM_TEXT: Readonly<Record<LabRunWorker['acclimatization'], string>> = { acclimatized: 'Acclimatised', acclimatizing: 'On an acclimatisation schedule', unacclimatized: 'Not acclimatised' }

function dayTitle(r: PolicyRunResult, spec: Experiment['spec']): string {
  if (spec?.source.kind === 'scenario') return getScenario(spec.source.scenarioId).title
  return `${getSite(r.siteId).name} site-day`
}

// ─────────────────────────────── Run summary ───────────────────────────────

function RunSummary({ exp }: { exp: Experiment }) {
  const first = exp.results[0]
  const spec = exp.spec
  if (!first || !spec) return null
  const forecastArchived = first.weatherProvenance.some((p) => /previous-runs|forecast/i.test(p) && !/perfect-forecast/i.test(p))
  const perfect = first.weatherProvenance.some((p) => /perfect-forecast/i.test(p))
  const d = spec.disruptions
  const assumptions = [
    `compliance ${Math.round(spec.behaviour.compliance * 100)} %`,
    `self-report × ${spec.behaviour.selfReportScale.toFixed(1)}`,
    `check-in answers × ${spec.behaviour.respondScale.toFixed(1)}`,
    `wearable dropout +${Math.round(d.wearableDropout * 100)} %`,
    `PPG noise × ${d.ppgNoiseMultiplier.toFixed(2)}`,
    d.envSensorFailure ? `WBGT sensor down ${d.envSensorFailure.from}–${d.envSensorFailure.to}` : 'no sensor failure',
    d.networkOutage ? `network down ${d.networkOutage.from}–${d.networkOutage.to}` : 'no network outage',
  ]
  return (
    <Card padding="md" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">Last experiment</p>
          <h2 className="text-lg font-semibold text-ink">{dayTitle(first, spec)}</h2>
          <p className="text-sm text-muted">
            {getSite(first.siteId).name} · {formatDate(first.date)} · shift {first.shift.start}–{first.shift.end} · {first.workers.length} virtual workers · {exp.results.length} of {spec.policies.length} {spec.policies.length === 1 ? 'policy' : 'policies'}
            {exp.elapsedMs !== null ? ` · ${(exp.elapsedMs / 1000).toFixed(1)} s` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ProvenanceTag kind="simulated" detail="Virtual workers; physiology from the ground-truth model, never shown to the engine" />
          <ProvenanceTag kind="real_weather" detail={first.weatherProvenance.join(' · ') || 'ECMWF IFS archive'} />
          {forecastArchived && <ProvenanceTag kind="archived_forecast" detail="Engine input: the archived day-ahead forecast for the same hours" />}
          {perfect && <ProvenanceTag kind="engineering_default" label="Perfect forecast" detail="No archived forecast for this date: the engine sees the analysis itself (optimistic)" />}
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="font-semibold text-ink">Seed</dt>
        <dd className="font-mono text-ink">{spec.seed}</dd>
        <dt className="font-semibold text-ink">Assumptions</dt>
        <dd className="text-muted">{assumptions.join(' · ')}</dd>
        <dt className="font-semibold text-ink">Reproducibility</dt>
        <dd className="break-all font-mono text-[11px] text-muted">
          {exp.results.map((r) => `${r.policy} ${r.stamp}`).join('   ')}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {exp.status === 'cancelled' ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <CircleAlert size={14} aria-hidden /> Cancelled: showing the {exp.results.length} {exp.results.length === 1 ? 'policy' : 'policies'} that finished.
          </p>
        ) : (
          <p className="text-xs text-muted">Re-running with the same seed and assumptions reproduces these numbers exactly.</p>
        )}
        <LoadInLive exp={exp} />
      </div>
    </Card>
  )
}

// ─────────────────────────────── Comparison ───────────────────────────────

function MetricRow({ m, r, all, base }: { m: MetricDef; r: PolicyRunResult; all: readonly PolicyRunResult[]; base: PolicyRunResult | null }) {
  const v = m.value(r.summary)
  const shares = shareOfMax(all.map((x) => m.value(x.summary)))
  const share = shares[all.indexOf(r)] ?? 0
  const bv = base && base !== r ? m.value(base.summary) : null
  const delta = v !== null && bv !== null ? deltaText(v, bv, m.precision) : null
  const detail = m.detail?.(r.summary) ?? null
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="min-w-0 text-xs text-muted" title={m.hint}>
          {m.label}
        </dt>
        <dd className="shrink-0 text-end">
          <span className="text-sm font-semibold text-ink tabular-nums">{metricText(m, r.summary)}</span>
          {m.unit && v !== null && <span className="text-xs text-muted"> {m.unit}</span>}
          {delta && <span className="ms-1.5 text-[11px] text-subtle tabular-nums">({delta})</span>}
        </dd>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span aria-hidden className="block h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
          <span className="block h-full rounded-full bg-slate-500" style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        {detail && <span className="shrink-0 text-[11px] text-subtle">{detail}</span>}
      </div>
    </div>
  )
}

function PolicyCard({ r, all, base }: { r: PolicyRunResult; all: readonly PolicyRunResult[]; base: PolicyRunResult | null }) {
  const headingId = useId()
  const engineOff = r.policy === 'ban_only' || r.policy === 'site_index'
  return (
    <Card as="article" aria-labelledby={headingId} padding="md" className="flex flex-col">
      <header className="mb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 id={headingId} className="text-base font-semibold text-ink">
            {POLICY_META[r.policy].name}
          </h3>
          {r.policy === 'ban_only' && <Badge size="sm">Baseline</Badge>}
          {policyUsesWearable(r.policy) && (
            <Badge size="sm" tone="info" icon={HeartPulse}>
              Wearables
            </Badge>
          )}
          {r.policy === 'zill_monitored' && <Badge size="sm" tone="outline">Monitored basis</Badge>}
          {engineOff && <Badge size="sm" tone="outline">No Zill engine</Badge>}
        </div>
        <p className="mt-1 text-xs leading-snug text-muted">{POLICY_META[r.policy].description}</p>
      </header>
      {GROUPS.map((g) => (
        <section key={g} className="border-t border-line pt-2 first-of-type:mt-0">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{METRIC_GROUP_TEXT[g].title}</h4>
          <dl className="divide-y divide-line/60">
            {METRICS.filter((m) => m.group === g && CARD_METRICS.has(m.id)).map((m) => (
              <MetricRow key={m.id} m={m} r={r} all={all} base={base} />
            ))}
          </dl>
        </section>
      ))}
      <p className="mt-auto pt-2 text-[11px] text-subtle">
        <span className="font-mono">{r.seed}</span> · {(r.runMs / 1000).toFixed(1)} s in the worker
      </p>
    </Card>
  )
}

function ComparisonTable({ results, base }: { results: readonly PolicyRunResult[]; base: PolicyRunResult | null }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">Policy comparison, all metrics. {DISCLAIMER}</caption>
        <thead>
          <tr className="border-b border-line bg-canvas text-start text-xs text-muted">
            <th scope="col" className="px-3 py-2 text-start font-semibold">
              Metric
            </th>
            {results.map((r) => (
              <th key={r.policy} scope="col" className="px-3 py-2 text-end font-semibold text-ink">
                {POLICY_META[r.policy].name}
              </th>
            ))}
          </tr>
        </thead>
        {GROUPS.map((g) => (
          <tbody key={g}>
            <tr>
              <th colSpan={results.length + 1} scope="colgroup" className="bg-surface px-3 pb-1 pt-3 text-start text-[11px] font-semibold uppercase tracking-wide text-subtle">
                {METRIC_GROUP_TEXT[g].title} <span className="font-normal normal-case tracking-normal">— {METRIC_GROUP_TEXT[g].note}</span>
              </th>
            </tr>
            {METRICS.filter((m) => m.group === g).map((m) => (
              <tr key={m.id} className="border-t border-line/60">
                <th scope="row" className="px-3 py-1.5 text-start text-xs font-medium text-ink">
                  {m.label}
                  <span className="block font-normal text-subtle">{m.hint}</span>
                </th>
                {results.map((r) => {
                  const v = m.value(r.summary)
                  const bv = base && base !== r ? m.value(base.summary) : null
                  return (
                    <td key={r.policy} className="px-3 py-1.5 text-end tabular-nums">
                      <span className="font-semibold text-ink">{metricText(m, r.summary)}</span>
                      {m.unit && v !== null && <span className="text-xs text-muted"> {m.unit}</span>}
                      {v !== null && bv !== null && <span className="block text-[11px] text-subtle">{deltaText(v, bv, m.precision)} vs baseline</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function Comparison({ results }: { results: readonly PolicyRunResult[] }) {
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const base = baselineOf(results)
  const headline = comparisonHeadline(results)
  return (
    <Section
      title="Policy comparison"
      provenance="simulated"
      provenanceDetail={DISCLAIMER}
      description={
        <>
          <strong className="font-semibold text-ink">{DISCLAIMER}</strong> Same virtual workers, weather and seed in every column; brackets show the difference from the midday ban alone.
        </>
      }
      actions={
        <div role="group" aria-label="Comparison layout" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          {(
            [
              ['cards', 'Cards', LayoutGrid],
              ['table', 'Table', Table2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cx('inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium', view === id ? 'bg-shade-bg text-shade-dark' : 'text-muted hover:text-ink')}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      }
    >
      {headline && (
        <p className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
          <FlaskConical size={14} aria-hidden className="me-1.5 inline-block -translate-y-px text-muted" />
          {headline}
        </p>
      )}
      {view === 'cards' ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {results.map((r) => (
            <PolicyCard key={r.policy} r={r} all={results} base={base} />
          ))}
        </div>
      ) : (
        <ComparisonTable results={results} base={base} />
      )}
    </Section>
  )
}

// ─────────────────────────────── Worker explorer ───────────────────────────────

const SOURCE_TEXT: Readonly<Record<LabEventSource, string>> = { truth: 'Ground truth', engine: 'Engine', worker: 'Worker', response: 'Response' }
const SOURCE_ICON = { truth: FlaskConical, engine: Cpu, worker: User, response: Users } as const

/**
 * The explorer's policy switcher: one button per policy run, each carrying the selected worker's outcome under that
 * policy (peak simulated core, harm events, work and water), so the same person can be compared across policies.
 */
function PolicySwitcher({ results, workerId, policy, onPick }: { results: readonly PolicyRunResult[]; workerId: string | null; policy: PolicyId; onPick: (p: PolicyId) => void }) {
  return (
    <div role="radiogroup" aria-label="Policy run shown" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
      {results.map((r) => {
        const w = workerId ? r.workers.find((x) => x.id === workerId) : undefined
        const on = r.policy === policy
        const harm = w ? harmEvents(w) : 0
        return (
          <button
            key={r.policy}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(r.policy)}
            className={cx('rounded-lg border px-3 py-2 text-start transition-colors', on ? 'border-shade bg-shade-bg ring-1 ring-shade' : 'border-line bg-surface hover:bg-canvas')}
          >
            <span className={cx('block text-sm font-semibold', on ? 'text-shade-dark' : 'text-ink')}>{POLICY_META[r.policy].name}</span>
            {w && (
              <>
                <span className="mt-0.5 block text-xs text-ink tabular-nums">
                  peak {fixed(w.maxCoreC)} °C · {harm} harm {harm === 1 ? 'event' : 'events'}
                </span>
                <span className="block text-[11px] text-muted tabular-nums">
                  work {hours(w.workMin)} · water {(w.waterMl / 1000).toFixed(1)} L · {minutesAtLeast(w, 'high')} min at High+
                </span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

function EventLog({ events }: { events: readonly LabEventMarker[] }) {
  const [filter, setFilter] = useState<'all' | 'key'>('key')
  const shown = filter === 'all' ? events : events.filter((e) => e.source === 'truth' || e.source === 'response' || e.label.startsWith('Displayed level'))
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">Event log</h4>
        <div role="group" aria-label="Event filter" className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          {(
            [
              ['key', 'Truth, levels, responses'],
              ['all', `Everything (${events.length})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('h-7 rounded-md px-2.5 font-medium', filter === id ? 'bg-shade-bg text-shade-dark' : 'text-muted hover:text-ink')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No events of this kind in the shift.</p>
      ) : (
        <ol className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface" aria-label="Events in time order">
          {shown.map((e, i) => {
            const Icon = SOURCE_ICON[e.source]
            return (
              <li key={i} className="flex items-start gap-2.5 px-3 py-1.5 text-sm">
                <span className="w-11 shrink-0 pt-px text-xs font-semibold text-ink tabular-nums">{hhmm(e.t)}</span>
                {e.truth ? <EventGlyph kind={e.truth} className="mt-0.5" /> : <Icon size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />}
                <span className="min-w-0 flex-1">
                  <span className="me-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{SOURCE_TEXT[e.source]}</span>
                  <span className="text-ink">{e.label}</span>
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function WorkerExplorer({ results }: { results: readonly PolicyRunResult[] }) {
  const explorer = useLab((s) => s.explorer)
  const selectId = useId()
  const run = results.find((r) => r.policy === explorer.policy) ?? results[0]
  const workerIndex = run ? run.traces.workerIds.indexOf(explorer.workerId ?? '') : -1
  const worker = run && workerIndex >= 0 ? run.workers[workerIndex] : null
  const rows = useMemo(() => (run && workerIndex >= 0 ? rowsFromPacked(run.traces, workerIndex) : []), [run, workerIndex])
  const events = useMemo(() => (run && worker ? run.events.filter((e) => e.workerId === worker.id) : []), [run, worker])
  if (!run) return null
  const t0 = run.traces.t0
  const tEnd = t0 + run.traces.nMinutes * MINUTE_MS
  const wearableExpected = !!worker && policyUsesWearable(run.policy) && worker.wearable
  const wearableNote = !worker ? '' : !policyUsesWearable(run.policy) ? 'No wearable data under this policy' : 'No band paired or no wearable consent'
  const sortedWorkers = [...run.workers].sort((a, b) => b.maxCoreC - a.maxCoreC)
  const truthCounts = worker ? (Object.entries(worker.events) as [TruthEventKind, number][]).filter(([, n]) => n > 0) : []

  return (
    <Section
      title="Per-worker traces"
      provenance="simulated"
      provenanceDetail="Simulated ground truth next to what the engine displayed"
      description="Simulated ground truth (hidden from the engine) against what the device estimated and displayed, minute by minute. Pick the same worker under another policy to see what changed for that person."
    >
      <Card padding="md" className="space-y-4">
        <div className="flex flex-col gap-3">
          <div className="min-w-0 sm:max-w-md">
            <label htmlFor={selectId} className="mb-1 block text-xs font-semibold text-ink">
              Virtual worker <span className="font-normal text-subtle">(hottest first under the selected policy)</span>
            </label>
            <select
              id={selectId}
              value={worker?.id ?? ''}
              onChange={(e) => labStore.getState().selectExplorer({ workerId: e.target.value })}
              className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink shadow-xs"
            >
              {sortedWorkers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.id} · peak {w.maxCoreC.toFixed(1)} °C{harmEvents(w) ? ` · ${harmEvents(w)} harm ${harmEvents(w) === 1 ? 'event' : 'events'}` : ''}
                </option>
              ))}
            </select>
          </div>
          <PolicySwitcher results={results} workerId={worker?.id ?? null} policy={run.policy} onPick={(p) => labStore.getState().selectExplorer({ policy: p })} />
        </div>

        {worker ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
              <span className="text-sm font-semibold text-ink">{worker.name}</span>
              <span>
                {worker.id} · crew {worker.crewId}
              </span>
              <span>{ACCLIM_TEXT[worker.acclimatization]}</span>
              <span>Age {worker.ageBand}</span>
              <span>{worker.clothing.replace(/_/g, ' ')}</span>
              <span className="inline-flex items-center gap-1">
                <HeartPulse size={12} aria-hidden />
                {worker.wearable ? 'Band paired, wearable consent given' : 'No band or no wearable consent'}
              </span>
              <span className="inline-flex items-center gap-1">
                <Hourglass size={12} aria-hidden />
                work {hours(worker.workMin)} · rest {hours(worker.restMin)} · water {(worker.waterMl / 1000).toFixed(1)} L
              </span>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {RISK_LEVELS.filter((lv) => (worker.minutesByLevel[lv] ?? 0) > 0 && lv !== 'safe').map((lv) => (
                  <span key={lv} className="inline-flex items-center gap-1">
                    <LevelPill level={lv} size="sm" /> <span className="tabular-nums">{worker.minutesByLevel[lv]} min</span>
                  </span>
                ))}
              </span>
              {truthCounts.length > 0 && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {truthCounts.map(([k, n]) => (
                    <span key={k} className="inline-flex items-center gap-1 text-ink">
                      <EventGlyph kind={k} /> {TRUTH_EVENT_META[k].short} × {n}
                    </span>
                  ))}
                </span>
              )}
            </div>

            <TraceCharts
              key={`${run.policy}:${worker.id}`}
              rows={rows}
              t0={t0}
              tEnd={tEnd}
              events={events}
              wearableExpected={wearableExpected}
              wearableNote={wearableNote}
              label={`${worker.name} under ${POLICY_META[run.policy].name}`}
              engineOn={isZillPolicy(run.policy)}
            />

            <EventLog events={events} />
          </>
        ) : (
          <EmptyState size="sm" title="Pick a worker" description="Choose a virtual worker to see the traces." />
        )}
      </Card>
    </Section>
  )
}

// ─────────────────────────────── Results root ───────────────────────────────

/** Opens the experiment's scenario in the shared live world with the explorer's policy (scenario days only). */
function LoadInLive({ exp }: { exp: Experiment }) {
  const policy = useLab((s) => s.explorer.policy)
  const spec = exp.spec
  if (!spec || spec.source.kind !== 'scenario' || !policy) return null
  const scenarioId = spec.source.scenarioId
  const load = () => {
    void simStore.getState().loadScenario(scenarioId, {
      policy,
      seed: spec.seed,
      behaviour: { ...spec.behaviour },
      disruptions: {
        wearableDropout: spec.disruptions.wearableDropout,
        ppgNoiseMultiplier: spec.disruptions.ppgNoiseMultiplier,
        ...(spec.disruptions.envSensorFailure ? { envSensorFailure: { ...spec.disruptions.envSensorFailure } } : {}),
        ...(spec.disruptions.networkOutage ? { networkOutage: { ...spec.disruptions.networkOutage } } : {}),
      },
    })
  }
  return (
    <Button variant="secondary" size="sm" onClick={load}>
      Load this day in the live world ({POLICY_META[policy].name})
    </Button>
  )
}

export function LabResults() {
  const exp = useLab((s) => s.experiment)
  if (exp.results.length === 0) {
    if (exp.status === 'running') return null
    if (exp.status === 'error')
      return <EmptyState tone="unavailable" icon={CircleAlert} title="The experiment did not finish" description={exp.error ?? 'Unknown error.'} />
    return (
      <EmptyState
        icon={FlaskConical}
        title="No experiment yet"
        description="Pick a day and the policies to compare, then Run. Results appear here as each policy finishes: comparison cards, then per-worker truth-vs-estimate charts."
      />
    )
  }
  return (
    <div className={cx('space-y-8 transition-opacity', exp.status === 'running' && 'opacity-90')}>
      <RunSummary exp={exp} />
      <Comparison results={exp.results} />
      <WorkerExplorer results={exp.results} />
    </div>
  )
}
