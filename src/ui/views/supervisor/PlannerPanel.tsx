/**
 * Planner panel: today's DayPlan per crew as a time-blocks timeline (work/rest cycles, location, water), the plan basis,
 * per-member acclimatisation caps (the operational cap only), the changes versus the naive plan, water logistics,
 * warnings with mitigation hints, and the ISO 7933 heat-strain screen per task-hour. A supervisor may see the day plan
 * (docs/dev/engine-api-wave2d.md §0); member caps never carry the reason or the history.
 */
import { memo, useMemo, useState } from 'react'
import { ArrowRight, CalendarClock, ClipboardList, Droplets, Info, ShieldCheck, TrendingDown, TriangleAlert } from 'lucide-react'
import { COOLER_CAPACITY_L, COOLER_REFILL_INTERVAL_H, type CrewPlan, type DayPlan, type PlanWarning } from '../../../engine/planner'
import type { CrewBoard } from '../../../state/selectors'
import { Card, InfoTip, ProvenanceTag, Tabs, cx } from '../../components'
import {
  ACTION_WARNINGS,
  LIMITED_BY_KEYS,
  LIMITED_BY_LABELS,
  WARNING_HINTS,
  WARNING_TITLES,
  acclimatisationText,
  crewWarnings,
  cycleText,
  durationText,
  exposureCut,
  groupWarnings,
  hhmm,
  hourRanges,
  plural,
  memberCapAt,
  memberCapMax,
  planBasisInfo,
  planChanges,
  planTimeline,
  screenMatrix,
  withNames,
  type ScreenCell,
  type SegmentKind,
} from './model'

const SEGMENT: Readonly<Record<SegmentKind, { cls: string; label: string }>> = {
  sun: { cls: 'bg-[#1d64b8] text-white', label: 'Work in the sun' },
  shade: { cls: 'bg-[#0f766e] text-white', label: 'Work in shade' },
  rest: { cls: 'bg-slate-200 text-slate-800', label: 'Rest area, no task' },
}

const REST_SOURCE: Readonly<Record<string, string>> = {
  niosh: 'NIOSH/ACGIH table',
  rule_pack: 'ADOSH zone rule',
  both: 'Table and zone rule',
  phs: 'ISO 7933 screen',
  none: '—',
}

export interface PlannerPanelProps {
  crews: readonly CrewBoard[]
  dayPlan: Pick<DayPlan, 'notes' | 'warnings' | 'planBasis'> | null
  names: ReadonlyMap<string, string>
  now: number
  className?: string
}

export const PlannerPanel = memo(function PlannerPanel({ crews, dayPlan, names, now, className }: PlannerPanelProps) {
  const withPlan = crews.filter((c) => c.plan !== null)
  const [tab, setTab] = useState<string | undefined>(undefined)
  return (
    <section aria-labelledby="planner-h" className={cx('@container flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="planner-h" className="flex items-center gap-2 text-base font-semibold text-ink">
            <ClipboardList aria-hidden size={18} className="text-shade" />
            Today’s plan
          </h2>
          <p className="text-sm text-muted">Work/rest blocks, water and the heat-strain screen for each crew. The worker’s device can always ask for more rest.</p>
        </div>
        <ProvenanceTag kind="projection" detail="Day plan computed from the forecast with the NIOSH/ACGIH tables, the ADOSH rule pack and an ISO 7933 screen (engine/planner.ts)." />
      </div>
      {withPlan.length === 0 ? (
        <Card padding="md">
          <p className="text-sm text-muted">No day plan for these crews yet.</p>
        </Card>
      ) : withPlan.length === 1 ? (
        <CrewPlanCard crew={withPlan[0]} plan={withPlan[0].plan as CrewPlan} dayPlan={dayPlan} names={names} now={now} />
      ) : (
        <Tabs
          label="Crew plans"
          items={withPlan.map((c) => ({ id: c.crew.id, label: c.crew.name }))}
          value={tab ?? withPlan[0].crew.id}
          onValueChange={setTab}
          variant="pill"
        >
          {(id) => {
            const c = withPlan.find((x) => x.crew.id === id) ?? withPlan[0]
            return <CrewPlanCard crew={c} plan={c.plan as CrewPlan} dayPlan={dayPlan} names={names} now={now} />
          }}
        </Tabs>
      )}
    </section>
  )
})

function CrewPlanCard({ crew, plan, dayPlan, names, now }: { crew: CrewBoard; plan: CrewPlan; dayPlan: PlannerPanelProps['dayPlan']; names: ReadonlyMap<string, string>; now: number }) {
  const nowMin = Math.floor(now / 60_000) * 60_000
  const timeline = useMemo(() => planTimeline(plan.blocks, nowMin), [plan, nowMin])
  const taskName = useMemo(() => {
    const m = new Map(crew.crew.tasks.map((t) => [t.id, t.name] as const))
    return (id: string) => m.get(id) ?? id
  }, [crew.crew.tasks])
  const changes = useMemo(() => planChanges(plan, taskName).filter((c) => c.kind !== 'kept'), [plan, taskName])
  const cut = exposureCut(plan)
  const basis = planBasisInfo(plan.planBasis)
  const warnings = crewWarnings(dayPlan, crew.crew.id)
  const capped = Object.keys(plan.memberCaps)
  const matrix = useMemo(() => screenMatrix(plan, crew.crew.tasks), [plan, crew.crew.tasks])
  const notes = [...plan.notes, ...(dayPlan?.notes ?? [])]
  const monitoredHours = plan.blocks.flatMap((b) => b.hours).filter((h) => h.monitored).length

  return (
    <Card as="article" padding="none" aria-labelledby={`plan-${crew.crew.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <h3 id={`plan-${crew.crew.id}`} className="text-sm font-semibold text-ink">
          {crew.crew.name}
        </h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-shade-tint bg-shade-bg px-2.5 py-0.5 text-xs font-semibold text-shade-dark">
          <ShieldCheck aria-hidden size={13} />
          {basis.label}
        </span>
        <span className="min-w-0 flex-1 basis-64 text-xs text-muted">
          {basis.explanation}
          {plan.planBasis === 'monitored' && monitoredHours > 0 && ` ${monitoredHours} block-hours use the monitored rate.`}
        </span>
      </div>

      <div className="grid gap-6 p-4 @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {timeline && <TimelineBar timeline={timeline} />}
          <BlockTable plan={plan} now={nowMin} />
          {plan.binding.text && <p className="text-xs text-muted">{withNames(plan.binding.text, names)}</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-lg border border-line p-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
              <TrendingDown aria-hidden size={14} />
              Versus the naive plan
            </h4>
            <p className="mt-1 text-sm text-ink">
              {cut !== null && cut > 0 ? (
                <>
                  <span className="font-semibold tabular-nums">{Math.round(cut * 100)} %</span> less heat exposure than doing the same tasks at their usual times
                </>
              ) : (
                'Same heat exposure as the usual schedule'
              )}
              {plan.lostWorkMinVsNaive > 0
                ? `, for ${durationText(plan.lostWorkMinVsNaive)} less crew work.`
                : plan.lostWorkMinVsNaive < 0
                  ? `, with ${durationText(-plan.lostWorkMinVsNaive)} more crew work.`
                  : ', with no work lost.'}
            </p>
            {changes.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {changes.map((c) => (
                  <li key={c.taskId} className="flex flex-wrap items-center gap-x-1.5 text-ink">
                    <span className="font-medium">{c.taskName}</span>
                    {c.kind === 'moved' ? (
                      <span className="inline-flex items-center gap-1 text-muted tabular-nums">
                        moved {c.naiveStart}
                        <ArrowRight aria-label="to" size={12} />
                        <span className="font-semibold text-ink">{c.planStart}</span>
                      </span>
                    ) : (
                      <span className="text-muted">deferred: no safe hours today (usual start {c.naiveStart})</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-line p-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
              <Droplets aria-hidden size={14} />
              Water logistics
            </h4>
            <p className="mt-1 text-sm text-ink">
              <span className="font-semibold tabular-nums">{Math.round(plan.waterL)} L</span> for the crew today ·{' '}
              <span className="font-semibold tabular-nums">{plural(plan.coolersNeeded, 'cooler', 'coolers')}</span> of {COOLER_CAPACITY_L.toFixed(0)} L, refilled every{' '}
              {COOLER_REFILL_INTERVAL_H} h
            </p>
            <p className="mt-1 text-xs text-muted">Workers’ phones remind them to drink, also while resting in the heat.</p>
          </div>

          {capped.length > 0 && (
            <div className="rounded-lg border border-line p-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
                <CalendarClock aria-hidden size={14} />
                Acclimatisation schedules
              </h4>
              <ul className="mt-1 flex flex-col gap-1.5 text-sm">
                {capped.map((id) => (
                  <li key={id} className="text-ink">
                    <span className="font-medium">{names.get(id) ?? id}</span>
                    <span className="block text-xs text-muted">
                      {acclimatisationText(memberCapAt(plan, id, nowMin), memberCapMax(plan, id))}
                      {typeof plan.memberWorkMin[id] === 'number' &&
                        (plan.memberWorkMin[id] >= 1 ? ` · ${durationText(plan.memberWorkMin[id])} of heat work planned` : ' · no heat work planned today')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Planner warnings</h4>
              <ul className="flex flex-col gap-2">
                {groupWarnings(warnings).map((g) => {
                  const act = ACTION_WARNINGS.has(g.code)
                  const Icon = act ? TriangleAlert : Info
                  const subjects = g.items.map((w) => warningSubject(w, taskName, names))
                  const listed = subjects.some((s) => s !== null)
                  return (
                    <li key={g.code} className={cx('rounded-lg border p-2.5 text-sm', act ? 'border-caution-fill/50 bg-caution-bg' : 'border-line bg-canvas')}>
                      <p className={cx('flex items-center gap-1.5 font-semibold', act ? 'text-caution' : 'text-ink')}>
                        <Icon aria-hidden size={14} className="shrink-0" />
                        {WARNING_TITLES[g.code]}
                        {g.items.length > 1 && <span className="font-normal tabular-nums">({g.items.length})</span>}
                      </p>
                      {listed ? (
                        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink">
                          {g.items.map((w, i) => (
                            <li key={i} className="tabular-nums">
                              <span className="font-medium">{subjects[i] ?? crew.crew.name}</span>
                              {w.hours && w.hours.length > 0 && <span className="text-muted"> · {hourRanges(w.hours)}</span>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs text-ink">{g.items.map((w) => withNames(w.text, names)).join(' ')}</p>
                      )}
                      {WARNING_HINTS[g.code] && <p className="mt-1 text-xs text-ink">{WARNING_HINTS[g.code]}</p>}
                      {listed && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer font-medium text-shade hover:text-shade-dark">Planner detail</summary>
                          <ul className="mt-1 flex flex-col gap-1 text-muted">
                            {g.items.map((w, i) => (
                              <li key={i}>{withNames(w.text, names)}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {notes.length > 0 && (
            <ul className="flex flex-col gap-1">
              {notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted">
                  <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
                  {withNames(n, names)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {matrix && <ScreenTable matrix={matrix} now={nowMin} />}
    </Card>
  )
}

/** Who or what a warning is about: the task, or the members on a schedule (display names); null when neither. */
function warningSubject(w: PlanWarning, taskName: (id: string) => string, names: ReadonlyMap<string, string>): string | null {
  if (w.workerIds && w.workerIds.length > 0) return w.workerIds.map((id) => names.get(id) ?? id).join(', ')
  if (w.taskId) return taskName(w.taskId)
  return null
}

function TimelineBar({ timeline }: { timeline: NonNullable<ReturnType<typeof planTimeline>> }) {
  return (
    <div>
      <div dir="ltr" className="relative">
        <ol className="relative h-11 w-full" aria-label="Crew day, time blocks">
          {timeline.segments.map((s) => {
            const cfg = SEGMENT[s.kind]
            const label = s.taskName ?? 'Rest area'
            const cycle = s.kind === 'rest' ? 'no task' : cycleText(s.workMinPerHour).toLowerCase()
            const desc = `${s.start}–${s.end}: ${label}, ${cfg.label.toLowerCase()}, ${cycle}, ${Math.round(s.waterL)} L water`
            return (
              <li key={s.key} className="absolute inset-y-0 px-px" style={{ left: `${s.startPct}%`, width: `${s.widthPct}%` }}>
                <div
                  title={desc}
                  aria-label={desc}
                  className={cx('flex h-full items-center rounded-[4px] px-1.5 text-[11px] leading-tight font-medium', cfg.cls, s.current && 'outline-2 outline-offset-1 outline-ink')}
                >
                  {s.widthPct >= 11 && <span className="truncate">{label}</span>}
                </div>
              </li>
            )
          })}
        </ol>
        {timeline.nowPct !== null && (
          <div aria-hidden className="pointer-events-none absolute -top-1.5 -bottom-1.5 w-0.5 -translate-x-1/2 rounded bg-ink" style={{ left: `${timeline.nowPct}%` }} />
        )}
        <div aria-hidden className="relative mt-1 h-4 text-[10px] text-subtle tabular-nums">
          {timeline.ticks
            .filter((_, i) => timeline.ticks.length <= 8 || i % 2 === 0)
            .map((t) => (
              <span key={t.t} className="absolute -translate-x-1/2" style={{ left: `${t.pct}%` }}>
                {t.label}
              </span>
            ))}
        </div>
      </div>
      <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="Timeline legend">
        {(['sun', 'shade', 'rest'] as const).map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx('h-3 w-4 rounded-sm', SEGMENT[k].cls)} />
            {SEGMENT[k].label}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 rounded bg-ink" />
          Now
        </li>
      </ul>
    </div>
  )
}

function BlockTable({ plan, now }: { plan: CrewPlan; now: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[36rem] text-sm tabular-nums">
        <caption className="sr-only">Plan blocks with work/rest cycle, location and water</caption>
        <thead className="bg-canvas text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-start font-medium">Time</th>
            <th scope="col" className="px-3 py-2 text-start font-medium">Task</th>
            <th scope="col" className="px-3 py-2 text-start font-medium">Where</th>
            <th scope="col" className="px-3 py-2 text-start font-medium">Work/rest per hour</th>
            <th scope="col" className="px-3 py-2 text-end font-medium">Water</th>
            <th scope="col" className="px-3 py-2 text-start font-medium">Set by</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {plan.blocks.map((b, i) => {
            const current = now >= b.startT && now < b.endT
            return (
              <tr key={`${i}-${b.start}`} className={cx(current && 'bg-shade-bg')} aria-current={current ? 'time' : undefined}>
                <th scope="row" className="px-3 py-1.5 text-start font-medium whitespace-nowrap text-ink">
                  {b.start}–{b.end}
                  {current && <span className="ms-1.5 rounded bg-shade px-1 py-0.5 text-[10px] font-semibold text-white">Now</span>}
                </th>
                <td className="px-3 py-1.5 text-ink">{b.taskName ?? <span className="text-muted">Rest area</span>}</td>
                <td className="px-3 py-1.5 text-muted">{b.taskId === null ? '—' : b.location === 'sun' ? 'Sun' : 'Shade'}</td>
                <td className="px-3 py-1.5 text-ink">{b.taskId === null ? '—' : cycleText(b.workMinPerHour).replace('Work/rest ', '')}</td>
                <td className="px-3 py-1.5 text-end text-ink">{b.waterL > 0 ? `${b.waterL.toFixed(1)} L` : '—'}</td>
                <td className="px-3 py-1.5 text-muted">{REST_SOURCE[b.rest.source] ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function cellTitle(task: string, hour: string, c: ScreenCell): string {
  const screen = c.phsWorkMin === null ? 'not screened in this hour' : `ISO 7933 screen allows ${Math.floor(c.phsWorkMin)} min/h`
  return `${hour}, ${task}: ${Math.floor(c.workMin)} min/h of work (tables and zone rule allow ${Math.floor(c.allowedMin)}; ${screen}; set by ${LIMITED_BY_LABELS[c.limitedBy]})`
}

function ScreenTable({ matrix, now }: { matrix: NonNullable<ReturnType<typeof screenMatrix>>; now: number }) {
  const nowHour = hhmm(Math.floor(now / 3_600_000) * 3_600_000)
  return (
    <div className="border-t border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          Heat-strain screen per task-hour
          <InfoTip
            label="About the heat-strain screen"
            content="Allowed work minutes per hour for each task: the lower of the NIOSH/ACGIH table and the ADOSH zone rule, then checked with an ISO 7933 (PHS) projection for the crew’s reference worker. The device re-checks every worker live."
          />
        </h4>
        <p className="text-xs text-muted">
          min/h of work · {matrix.acclimatizedReference ? 'acclimatised reference worker' : 'unacclimatised reference worker'} · set by:{' '}
          <span className="font-semibold text-ink">N</span> table, <span className="font-semibold text-ink">R</span> zone rule,{' '}
          <span className="font-semibold text-ink">P</span> ISO 7933 screen
        </p>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <caption className="sr-only">Allowed work minutes per hour by task and hour, with what set each value</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="sticky start-0 bg-surface py-1 pe-3 text-start font-medium">Task</th>
              {matrix.hours.map((h) => (
                <th key={h} scope="col" className={cx('px-1 py-1 text-center font-medium', h === nowHour && 'text-ink')}>
                  {h.slice(0, 2)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.taskId} className="border-t border-line/70">
                <th scope="row" className="sticky start-0 max-w-40 truncate bg-surface py-1 pe-3 text-start font-medium text-ink">
                  {r.taskName}
                </th>
                {r.cells.map((c, i) => (
                  <td key={matrix.hours[i]} className="px-0.5 py-0.5 text-center">
                    {c ? (
                      <span
                        title={cellTitle(r.taskName, matrix.hours[i], c)}
                        className={cx(
                          'inline-flex min-w-9 items-baseline justify-center gap-0.5 rounded px-1 py-0.5',
                          c.workMin <= 0 ? 'bg-slate-100 text-muted' : c.limitedBy === 'phs' ? 'bg-shade-tint/60 text-ink' : 'text-ink',
                          matrix.hours[i] === nowHour && 'outline outline-1 outline-ink/40',
                        )}
                      >
                        <span aria-hidden className="font-semibold">{Math.floor(c.workMin)}</span>
                        {LIMITED_BY_KEYS[c.limitedBy] && <span aria-hidden className="text-[9px] text-muted">{LIMITED_BY_KEYS[c.limitedBy]}</span>}
                        <span className="sr-only">{cellTitle(r.taskName, matrix.hours[i], c)}</span>
                      </span>
                    ) : (
                      <span className="text-subtle">·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
