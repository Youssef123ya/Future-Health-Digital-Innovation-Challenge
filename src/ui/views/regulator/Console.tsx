/**
 * The two aggregate consoles of #/regulator: Regulator (k = 10, rows per site) and HSE manager (k = 5, rows per crew of
 * the site). Every live number comes from a k-suppressed `aggregateFor` table — the level tables from the state
 * selectors (useRegulatorAggregates / useHseAggregates) and the live-operations tables from ./opsModel.ts through
 * `useProjected` (audit entries appended). Shares and rates are computed from published cells only; a suppressed cell
 * renders as "fewer than k", never a number.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { BellRing, CalendarClock, ClipboardCheck, Gauge, Landmark, MapPin, ShieldCheck, Sun, Timer, Users } from 'lucide-react'
import { RISK_LEVELS, type RiskLevel } from '../../../engine/types'
import { formatLocalHhmm } from '../../../engine/time'
import type { PolicyId } from '../../../sim/types'
import type { PlanBasis } from '../../../engine/planner'
import { SITES } from '../../../data/sites'
import { DEFAULT_ACTOR_IDS, type AggregateView } from '../../../state'
import { useHseAggregates, useProjected, useRegulatorAggregates } from '../../../state/hooks'
import { Badge, Card, CardHeader, DEFAULT_LEVEL_LABELS, EmptyState, LevelPill, Stat, Tabs, cx } from '../../components'
import {
  ACK_BIN_LABELS,
  cellOf,
  colTotalOf,
  countOf,
  publishedShare,
  ratePer1000,
  rowTotalOf,
  selectOps,
  type OpsModel,
  type OpsScope,
} from './opsModel'
import { useOpsHistory } from './opsLog'
import { num, pct, suppressedMark } from './format'
import { AggregateGrid, Fact, LevelHeader, SuppressedMark, SuppressionLegend, type ReleasedTable } from './ui'
import { WeatherContext } from './WeatherContext'
import { RulePackPanel, type ExportTable } from './RulePackPanel'

export const REGULATOR_SCOPE: OpsScope = Object.freeze({ role: 'regulator', actorId: DEFAULT_ACTOR_IDS.regulator, rowsBy: 'site' })
export const HSE_SCOPE: OpsScope = Object.freeze({ role: 'hse_manager', actorId: DEFAULT_ACTOR_IDS.hse_manager, rowsBy: 'crew' })

/** Live-operations model of a console (audited). */
function useOpsModel(scope: OpsScope): OpsModel | null {
  const history = useOpsHistory()
  return useProjected((input) => selectOps(input, history, scope), [history, scope])
}

// ─────────────────────────────── Labels ───────────────────────────────

export const POLICY_LABELS: Readonly<Record<PolicyId, string>> = {
  ban_only: 'Midday ban only (no Zill)',
  site_index: 'Site heat index only',
  zill_env: 'Zill, environment only',
  zill_full: 'Zill, standard limits',
  zill_monitored: 'Zill, monitored mode',
}

export const PLAN_BASIS_TEXT: Readonly<Record<PlanBasis, { label: string; detail: string }>> = {
  tables: {
    label: 'Standard limits',
    detail: 'NIOSH/ACGIH WBGT work/rest tables, the ADOSH rule pack and an ISO 7933 screen set the plan.',
  },
  monitored: {
    label: 'Monitored mode',
    detail:
      'Site opt-in with occupational-health sign-off. WBGT tables act as a screen (ISO 7243, ACGIH decision flow); acclimatised workers with valid wearable data work to their own ISO 7933 projection, and the table limits return the same minute monitoring lapses.',
  },
}

const BASIS_ROW_LABELS: Readonly<Record<string, string>> = { exposure: 'Site condition', individual: 'This worker' }
const DELIVERY_LABELS: Readonly<Record<string, string>> = { notified: 'Notified', logged: 'Logged, not sent' }
const MIDDAY_LABELS: Readonly<Record<string, string>> = { compliant: 'No sun work', violation: 'Sun work in window' }
const ZONE_LABELS: Readonly<Record<string, string>> = { within: 'Within controls', outside: 'Outside controls' }
const ESC_LABELS: Readonly<Record<string, string>> = { escalated: 'Escalated', not_escalated: 'Not escalated' }

const levelLabel = (key: string): ReactNode => <LevelPill level={key as RiskLevel} size="sm" />
const levelName = (key: string): string => DEFAULT_LEVEL_LABELS[key as RiskLevel] ?? key

// ─────────────────────────────── Consoles ───────────────────────────────

/** One level table offered in the "Workers by level" card. */
interface LevelTableSpec {
  id: string
  label: string
  description: string
  view: AggregateView
}

/** Regulator console: k = 10, one row per site; compliance and public-health level tables. */
export function RegulatorConsole() {
  const agg = useRegulatorAggregates(REGULATOR_SCOPE.actorId)
  const ops = useOpsModel(REGULATOR_SCOPE)
  const tables = useMemo<LevelTableSpec[]>(
    () =>
      agg
        ? [
            {
              id: 'compliance',
              label: 'Highest today',
              description: 'Highest level each worker reached today, all workers (compliance reporting).',
              view: agg.compliance,
            },
            {
              id: 'public',
              label: 'Public-health statistics',
              description: 'Highest level today, counting only workers who consented to aggregate statistics.',
              view: agg.publicHealth,
            },
          ]
        : [],
    [agg],
  )
  return <ConsoleBody scope={REGULATOR_SCOPE} levelTables={tables} ops={ops} />
}

/** HSE manager console: k = 5, one row per crew of the site; current and highest-today level tables. */
export function HseConsole() {
  const agg = useHseAggregates(HSE_SCOPE.actorId)
  const ops = useOpsModel(HSE_SCOPE)
  const tables = useMemo<LevelTableSpec[]>(
    () =>
      agg
        ? [
            { id: 'current', label: 'Now', description: 'Level shown on each worker’s device now, by crew (safety alerting).', view: agg.current },
            { id: 'today', label: 'Highest today', description: 'Highest level each worker reached today, by crew (compliance reporting).', view: agg.today },
          ]
        : [],
    [agg],
  )
  return <ConsoleBody scope={HSE_SCOPE} levelTables={tables} ops={ops} />
}

// ─────────────────────────────── Body ───────────────────────────────

function ConsoleBody({ scope, levelTables, ops }: { scope: OpsScope; levelTables: LevelTableSpec[]; ops: OpsModel | null }) {
  if (!ops || levelTables.length === 0) {
    return <EmptyState icon={Gauge} title="Waiting for the site-day to load" description="The live aggregates appear as soon as the scenario is running." />
  }
  const k = ops.alerts.k
  const rowLabel = (key: string): ReactNode => ops.rowNames[key] ?? key
  const rowHeader = ops.rowsBy === 'crew' ? 'Crew' : 'Site'
  const exportTables: ExportTable[] = [
    ...levelTables.map((lt) => ({ title: `Workers by level: ${lt.label}`, rowHeader, rowLabel: (r: string) => ops.rowNames[r] ?? r, colLabel: levelName, released: lt.view })),
    { title: 'Worker alerts by basis and delivery', rowHeader: 'Alert basis', rowLabel: (r: string) => BASIS_ROW_LABELS[r] ?? r, colLabel: (c: string) => DELIVERY_LABELS[c] ?? c, released: ops.alerts },
    { title: 'Time to acknowledge (alerts at high or above)', rowHeader: 'Level', rowLabel: levelName, colLabel: (c: string) => ACK_BIN_LABELS[c as keyof typeof ACK_BIN_LABELS] ?? c, released: ops.response },
    { title: 'Escalations (alerts at high or above)', rowHeader: 'Level', rowLabel: levelName, colLabel: (c: string) => ESC_LABELS[c] ?? c, released: ops.escalation },
    ...(ops.midday.table
      ? [{ title: 'Midday-break compliance (workers)', rowHeader, rowLabel: (r: string) => ops.rowNames[r] ?? r, colLabel: (c: string) => MIDDAY_LABELS[c] ?? c, released: ops.midday.table }]
      : []),
    { title: 'Zone-control compliance (worker-hours of sun work in Medium/High zone hours)', rowHeader, rowLabel: (r: string) => ops.rowNames[r] ?? r, colLabel: (c: string) => ZONE_LABELS[c] ?? c, released: ops.zone },
  ]

  return (
    <div className="space-y-8">
      <Kpis ops={ops} workers={levelTables[0].view} k={k} />

      {!ops.history.complete && ops.history.coveredFromT !== null && (
        <p className="rounded-lg border border-caution-fill/40 bg-caution-bg px-3 py-2 text-sm text-caution">
          This console started receiving the event stream at {formatLocalHhmm(ops.history.coveredFromT)}: the midday-break and zone-control counts cover
          the time since then.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <LevelCard tables={levelTables} rowHeader={rowHeader} rowLabel={rowLabel} />
        <PlanBasisCard ops={ops} />
        <AlertsCard ops={ops} />
        <ResponseCard ops={ops} />
        <MiddayCard ops={ops} rowHeader={rowHeader} rowLabel={rowLabel} />
        <ZoneCard ops={ops} rowHeader={rowHeader} rowLabel={rowLabel} />
      </div>

      <WeatherContext focusSiteId={ops.site.id} mode={ops.rowsBy === 'site' ? 'regulator' : 'hse'} />

      <RulePackPanel scope={scope} ops={ops} tables={exportTables} />
    </div>
  )
}

// ─────────────────────────────── KPI row ───────────────────────────────

interface KpiValue {
  value: string | number | null
  unit?: string
  precision?: number
  hint: ReactNode
}

/** A KPI from published cells: value, "none yet" or "suppressed". */
function shareKpi(share: number | null, whole: { suppressed: boolean; count?: number } | undefined, k: number | null, noneText: string): KpiValue {
  if (share !== null) return { value: Math.round(share * 100), unit: '%', hint: null }
  if (whole && !whole.suppressed && whole.count === 0) return { value: null, hint: noneText }
  return { value: 'Suppressed', hint: <span className="inline-flex items-center gap-1">a count behind it is {suppressedMark(k)}</span> }
}

function Kpis({ ops, workers, k }: { ops: OpsModel; workers: ReleasedTable; k: number | null }) {
  const totalWorkers = workers.table?.total
  const alerts = ops.alerts.table
  const notified = colTotalOf(alerts, 'notified')
  const rate = ratePer1000(notified, ops.workerHours)
  const logged = shareKpi(publishedShare(colTotalOf(alerts, 'logged'), alerts?.total), alerts?.total, k, 'No worker alerts yet')
  const w = ops.midday.window
  const midday: KpiValue = !ops.midday.table || !w
    ? { value: 'Not in force', hint: 'The midday break applies 15 Jun – 15 Sep' }
    : ops.t < w.startT
      ? { value: 'Not started', hint: `Window ${formatLocalHhmm(w.startT)}–${formatLocalHhmm(w.endT)}` }
      : shareKpi(publishedShare(colTotalOf(ops.midday.table.table, 'compliant'), ops.midday.table.table?.total), ops.midday.table.table?.total, k, 'Nobody on shift yet')
  const zone = shareKpi(publishedShare(colTotalOf(ops.zone.table, 'within'), ops.zone.table?.total), ops.zone.table?.total, k, 'No sun work in a controlled zone yet')
  const resp = ops.response.table
  const stopAck = (() => {
    const a = countOf(cellOf(resp, 'stop', 'le1'))
    const b = countOf(cellOf(resp, 'stop', 'le2'))
    const whole = rowTotalOf(resp, 'stop')
    const share = a === null || b === null ? null : publishedShare({ suppressed: false, count: a + b }, whole)
    const v = shareKpi(share, whole, k, 'No stop alerts so far')
    return share !== null ? { ...v, hint: 'within the 2-minute timer' } : v
  })()

  const rateKpi: KpiValue =
    rate !== null
      ? { value: rate, precision: 1, unit: 'per 1,000 worker-h', hint: `${num(ops.workerHours, 0)} worker-hours so far` }
      : notified && !notified.suppressed && notified.count === 0 && ops.workerHours !== null
        ? { value: 0, unit: 'per 1,000 worker-h', hint: `${num(ops.workerHours, 0)} worker-hours so far` }
        : { value: 'Suppressed', hint: <span>a count behind it is {suppressedMark(k)}</span> }

  const tiles: Array<{ label: string; info: string; v: KpiValue }> = [
    {
      label: 'Workers on shift',
      info: 'Workers with a current assessment, from the k-suppressed level table total.',
      v: totalWorkers && !totalWorkers.suppressed ? { value: totalWorkers.count, hint: `k = ${k}` } : { value: 'Suppressed', hint: <span>{suppressedMark(k)} workers</span> },
    },
    {
      label: 'Alert rate',
      info: 'Notified worker alerts (all levels) per 1,000 worker-hours on shift so far. Designed-suppression alerts are excluded: they were logged, not sent.',
      v: rateKpi,
    },
    {
      label: 'Logged, not sent',
      info: 'Share of worker alerts recorded under designed suppression (ANSI/ISA-18.2): an exposure advisory whose action the plan already enforces is logged and notified to nobody. Stop, individual, symptom, physiology, hydration and first-aid alerts are never suppressed.',
      v: logged,
    },
    {
      label: 'Midday-break compliance',
      info: 'Share of workers on shift with no outdoor work in direct sun inside 12:30–15:00 (UAE MoHRE Ministerial Resolution 44/2022, 15 Jun – 15 Sep).',
      v: midday,
    },
    {
      label: 'Zone-control compliance',
      info: 'Share of worker-hours of sun work in ADOSH Medium/High zone hours that stayed within the zone’s work/rest allowance, without an excluded unacclimatised worker (ADOSH-SF TG v4.0 Table 1).',
      v: zone,
    },
    {
      label: 'Stop alerts acknowledged',
      info: 'Share of stop-level alerts acknowledged within the 2-minute timer, after which they escalate to the supervisor and the buddy.',
      v: stopAck,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Stat
          key={t.label}
          framed
          size="md"
          label={t.label}
          info={t.info}
          value={t.v.value}
          unit={t.v.unit}
          precision={t.v.precision}
          hint={t.v.hint}
          className={cx(typeof t.v.value === 'string' && '[&_.text-2xl]:text-lg [&_.text-2xl]:text-muted')}
        />
      ))}
    </div>
  )
}

// ─────────────────────────────── Cards ───────────────────────────────

function LevelCard({ tables, rowHeader, rowLabel }: { tables: LevelTableSpec[]; rowHeader: string; rowLabel: (key: string) => ReactNode }) {
  const [active, setActive] = useState(tables[0]?.id ?? '')
  const spec = tables.find((x) => x.id === active) ?? tables[0]
  return (
    <Card as="section" aria-label="Workers by level">
      <CardHeader icon={Users} title="Workers by level" description={spec.description} />
      <Tabs
        items={tables.map((x) => ({ id: x.id, label: x.label }))}
        label="Level table"
        value={spec.id}
        onValueChange={setActive}
        variant="pill"
        className="mb-3"
      >
        {() => (
          <>
            <AggregateGrid
              caption={`Workers by level, ${spec.label}`}
              released={spec.view}
              rowHeader={rowHeader}
              rowLabel={rowLabel}
              colLabel={(c) => <LevelHeader level={c as RiskLevel} short />}
            />
            <SuppressionLegend released={spec.view} />
            {spec.view.excludedForConsent > 0 && (
              <Fact label="Consent">
                Workers without aggregate-statistics consent are left out of this table
                {spec.view.k !== null && spec.view.excludedForConsent < spec.view.k ? ` (${suppressedMark(spec.view.k)} workers).` : ` (${spec.view.excludedForConsent} workers).`}
              </Fact>
            )}
          </>
        )}
      </Tabs>
    </Card>
  )
}

function PlanBasisCard({ ops }: { ops: OpsModel }) {
  const isSite = ops.rowsBy === 'site'
  return (
    <Card as="section" aria-label="Active plan basis">
      <CardHeader
        icon={ClipboardCheck}
        title={isSite ? 'Sites and plan basis' : 'Plan basis by crew'}
        description={isSite ? 'Which limits set the day plan at each site. One site streams live in this demo.' : 'Which limits set each crew’s plan today.'}
      />
      <ul className="divide-y divide-line">
        {isSite
          ? SITES.map((s) => {
              const live = s.id === ops.site.id
              const basis = live ? ops.planBasis.site : null
              return (
                <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                  <MapPin aria-hidden size={16} className={cx('mt-0.5 shrink-0', live ? 'text-shade' : 'text-subtle')} />
                  <div className="min-w-0 flex-1">
                    <p className={cx('text-sm font-medium', live ? 'text-ink' : 'text-muted')}>{s.name}</p>
                    <p className="text-xs text-muted">
                      {live ? `${POLICY_LABELS[ops.policy]} · live since ${formatLocalHhmm(ops.shift.startT)}` : 'No live feed in this demo · real-weather context below'}
                    </p>
                  </div>
                  {live ? <BasisBadge basis={basis} /> : <Badge tone="outline">Not streaming</Badge>}
                </li>
              )
            })
          : ops.planBasis.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <Users aria-hidden size={16} className="mt-0.5 shrink-0 text-shade" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{r.name}</p>
                  <p className="text-xs text-muted">{r.basis ? PLAN_BASIS_TEXT[r.basis].detail : 'No plan for this crew yet.'}</p>
                </div>
                <BasisBadge basis={r.basis} />
              </li>
            ))}
      </ul>
      {ops.planBasis.site && (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
          <span className="font-semibold text-ink">{PLAN_BASIS_TEXT[ops.planBasis.site].label}: </span>
          {PLAN_BASIS_TEXT[ops.planBasis.site].detail} Per-person caps and device-directed rest stay on the workers’ devices.
        </p>
      )}
    </Card>
  )
}

function BasisBadge({ basis }: { basis: PlanBasis | null }) {
  if (!basis) return <Badge tone="outline">No plan</Badge>
  return (
    <Badge tone={basis === 'monitored' ? 'brand' : 'info'} icon={basis === 'monitored' ? Gauge : ShieldCheck}>
      {PLAN_BASIS_TEXT[basis].label}
    </Badge>
  )
}

function AlertsCard({ ops }: { ops: OpsModel }) {
  const released = ops.alerts
  const rate = (row: string | null): ReactNode => {
    const cell = row === null ? colTotalOf(released.table, 'notified') : cellOf(released.table, row, 'notified')
    if (cell?.suppressed) return <SuppressedMark k={released.k} />
    const r = ratePer1000(cell, ops.workerHours)
    return r === null ? <span className="text-subtle">—</span> : num(r, 1)
  }
  return (
    <Card as="section" aria-label="Alerts per 1,000 worker-hours">
      <CardHeader
        icon={BellRing}
        title="Alerts per 1,000 worker-hours"
        description="Alerts on workers’ own devices since the shift began, by basis. “Logged, not sent” = designed suppression: an exposure advisory the plan already enforces."
      />
      <AggregateGrid
        caption="Worker alerts by basis and delivery"
        released={released}
        rowHeader="Basis"
        rowLabel={(r) => BASIS_ROW_LABELS[r] ?? r}
        colLabel={(c) => DELIVERY_LABELS[c] ?? c}
        extra={[{ id: 'rate', header: <span>Notified per 1,000 worker-h</span>, cell: rate }]}
      />
      <SuppressionLegend released={released} />
      <div className="mt-2 space-y-1">
        <Fact label="Worker-hours so far">
          {ops.workerHours !== null ? num(ops.workerHours, 0) : `not published (fewer than ${released.k ?? 'k'} workers on shift)`}
        </Fact>
        <Fact label="Never suppressed">stop, emergency, individual, symptom, physiology, hydration and first-aid alerts.</Fact>
      </div>
    </Card>
  )
}

function ResponseCard({ ops }: { ops: OpsModel }) {
  return (
    <Card as="section" aria-label="Acknowledgement and escalation">
      <CardHeader
        icon={Timer}
        title="Acknowledgement and escalation"
        description="Notified alerts at high or above, from notification to the first acknowledgement that counted. Timers: emergency 1 min, stop 2 min, high 10 min."
      />
      <AggregateGrid
        caption="Time to acknowledge by level"
        released={ops.response}
        rowHeader="Level"
        rowLabel={levelLabel}
        colLabel={(c) => ACK_BIN_LABELS[c as keyof typeof ACK_BIN_LABELS] ?? c}
      />
      <h4 className="mt-5 mb-1 text-sm font-semibold text-ink">Escalations</h4>
      <AggregateGrid
        caption="Escalated alerts by level"
        released={ops.escalation}
        rowHeader="Level"
        rowLabel={levelLabel}
        colLabel={(c) => ESC_LABELS[c] ?? c}
      />
      <SuppressionLegend released={ops.response} />
      <Fact label="Escalated">a stop not acknowledged within 2 min, an emergency, or a case routed to the first aider or occupational health.</Fact>
    </Card>
  )
}

function MiddayCard({ ops, rowHeader, rowLabel }: { ops: OpsModel; rowHeader: string; rowLabel: (key: string) => ReactNode }) {
  const w = ops.midday.window
  const released = ops.midday.table
  const status = !w ? null : ops.t < w.startT ? `Starts at ${formatLocalHhmm(w.startT)}` : ops.t < w.endT ? 'In force now' : `Ended at ${formatLocalHhmm(w.endT)}`
  return (
    <Card as="section" aria-label="Midday-break compliance">
      <CardHeader
        icon={Sun}
        title="Midday-break compliance"
        description="Workers with any outdoor work in direct sun inside the midday-break window (UAE MoHRE Ministerial Resolution 44/2022)."
        actions={status ? <Badge tone={ops.t >= (w?.startT ?? 0) && ops.t < (w?.endT ?? 0) ? 'brand' : 'neutral'} icon={CalendarClock}>{status}</Badge> : undefined}
      />
      {!w || !released ? (
        <EmptyState size="sm" icon={CalendarClock} title="Not in force on this date" description="The midday break applies from 15 June to 15 September, 12:30–15:00." />
      ) : (
        <>
          <AggregateGrid
            caption="Midday-break compliance"
            released={released}
            rowHeader={rowHeader}
            rowLabel={rowLabel}
            colLabel={(c) => MIDDAY_LABELS[c] ?? c}
            extra={[
              {
                id: 'share',
                header: 'Compliant',
                cell: (row) => shareCell(row === null ? colTotalOf(released.table, 'compliant') : cellOf(released.table, row, 'compliant'), row === null ? released.table?.total : rowTotalOf(released.table, row), released.k),
              },
            ]}
          />
          <SuppressionLegend released={released} />
          <Fact label="Window">
            {formatLocalHhmm(w.startT)}–{formatLocalHhmm(w.endT)}; exemptions (e.g. continuous concrete pours) are not modelled, so any sun work counts.
          </Fact>
        </>
      )}
    </Card>
  )
}

function ZoneCard({ ops, rowHeader, rowLabel }: { ops: OpsModel; rowHeader: string; rowLabel: (key: string) => ReactNode }) {
  const released = ops.zone
  return (
    <Card as="section" aria-label="Zone-control compliance">
      <CardHeader
        icon={Landmark}
        title="Zone-control compliance"
        description="Worker-hours of sun work in clock hours forecast as ADOSH Medium or High zone (sun TWL below 140 W/m²): within the zone’s work/rest allowance, or not."
      />
      <AggregateGrid
        caption="Zone-control compliance in worker-hours"
        released={released}
        rowHeader={rowHeader}
        rowLabel={rowLabel}
        colLabel={(c) => ZONE_LABELS[c] ?? c}
        extra={[
          {
            id: 'share',
            header: 'Within',
            cell: (row) => shareCell(row === null ? colTotalOf(released.table, 'within') : cellOf(released.table, row, 'within'), row === null ? released.table?.total : rowTotalOf(released.table, row), released.k),
          },
        ]}
      />
      <SuppressionLegend released={released} />
      <Fact label="Rule">
        tasks sharing an hour are combined as a dose (minutes ÷ allowance ≤ 1, 1-min tolerance); an unacclimatised worker in a zone that excludes them is outside the controls.
      </Fact>
    </Card>
  )
}

/** A share cell from published counts only. */
function shareCell(part: ReturnType<typeof cellOf>, whole: ReturnType<typeof cellOf>, k: number | null): ReactNode {
  if (part?.suppressed || whole?.suppressed) return <SuppressedMark k={k} />
  const s = publishedShare(part, whole)
  return s === null ? <span className="text-subtle">—</span> : pct(s)
}

/** Level order for row labels (re-exported for tests of label coverage). */
export const LEVEL_ORDER: readonly RiskLevel[] = RISK_LEVELS
