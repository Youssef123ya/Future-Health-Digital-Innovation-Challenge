/**
 * Crew board: one card per worker, grouped by crew and sorted by severity, with level and acknowledgement filters.
 * Shows only the supervisor projection (name, level, console actions, work/rest rate, acknowledgement status and the
 * two pooled statuses) plus the plan's operational cap of members on an acclimatisation schedule. No heart rate, strain
 * estimate, flags, symptoms or per-worker data quality ever reach this component. The other supervisor driver phrases
 * are not rendered: they are the worker-facing catalog texts (second person) and can say more than the operational cap.
 */
import { useId, useMemo, useState } from 'react'
import { BellRing, CalendarClock, Hourglass, Info, Link2, Radio, UsersRound } from 'lucide-react'
import { RISK_ORDER, type RiskLevel } from '../../../engine/types'
import type { CrewBoard as CrewBoardModel, CrewBoardRow } from '../../../state/selectors'
import { ActionChip, Card, CountdownRing, EmptyState, LEVEL_STYLES, LevelPill, Toggle, cx } from '../../components'
import {
  LEVEL_FILTER_OPTIONS,
  ROLE_LABELS,
  acclimatisationText,
  actionLabel,
  blockAt,
  blockHourAt,
  clockText,
  cycleGuide,
  durationText,
  escalationInfo,
  hhmm,
  memberCapAt,
  memberCapMax,
  passesLevelFilter,
  reassignOptions,
  rowStatus,
  sortRows,
  wantsReassign,
  type CycleGuide,
  type EscalationInfo,
  type LevelFilter,
  type ReassignOption,
} from './model'
import { ACK_POLICY, type ConsoleData } from './useConsole'
import { AckButton, AssignedNote, OpenPhoneLink, PrivacyNote, ReassignControl } from './controls'
import type { AlertItem } from '../../../state/selectors'
import type { ActionId } from '../../../engine/types'

const RESTING_ACTIONS: readonly ActionId[] = ['rest_shade_now', 'stop_work', 'cool_down', 'call_998', 'cool_first']

/** Everything a worker card shows, derived from released fields only. */
interface CardModel {
  row: CrewBoardRow
  name: string
  level: RiskLevel | null
  alert: AlertItem | null
  esc: EscalationInfo | null
  coveredBy: AlertItem | null
  needsAck: boolean
  notCleared: boolean
  deviceRest: boolean
  reassign: boolean
  resting: boolean
  emergency: boolean
  /** The plan has the crew in the rest area (no task) until this time. */
  restUntil: string | null
  /** A plan exists but `now` is outside its blocks. */
  offPlan: boolean
  guide: CycleGuide | null
  capText: string | null
  plannedTaskId: string | null
  buddy: string | null
}

function cardModel(row: CrewBoardRow, crew: CrewBoardModel, data: ConsoleData): CardModel {
  const now = data.now
  const d = row.data
  const level = d.level ?? null
  const alert = row.alertId ? (data.shown.get(row.alertId) ?? null) : null
  const crewAlert = data.crewAlertOf.get(row.workerId) ?? null
  const coveredBy = alert && alert.basis === 'exposure' && crewAlert ? crewAlert : null
  const esc = alert ? escalationInfo(alert, data.wf.get(alert.id), ACK_POLICY) : null
  const st = rowStatus(row)
  const actions = d.actions ?? []
  const plan = crew.plan
  const block = blockAt(plan, now)
  const bh = blockHourAt(block, now)
  const cap = memberCapAt(plan, row.workerId, now)
  const anchor = cap ? { startT: cap.startT, wallMin: cap.wallMin, boutMin: cap.boutMin } : bh ? { startT: bh.startT, wallMin: bh.wallMin, boutMin: bh.boutMin } : null
  const resting = (level !== null && RISK_ORDER[level] >= RISK_ORDER.stop) || actions.some((a) => RESTING_ACTIONS.includes(a)) || st.notCleared
  const guide = typeof d.workMinPerHour === 'number' ? cycleGuide(now, d.workMinPerHour, anchor) : null
  return {
    row,
    name: data.names.get(row.workerId) ?? row.workerId,
    level,
    alert,
    esc,
    coveredBy,
    needsAck: alert !== null && coveredBy === null && esc !== null && esc.supervisorAckT === null,
    notCleared: st.notCleared,
    deviceRest: st.deviceRest,
    reassign: level !== 'emergency' && (st.notCleared || st.rotate || (alert !== null && wantsReassign(alert))),
    resting,
    emergency: level === 'emergency',
    restUntil: block !== null && block.taskId === null ? block.end : null,
    offPlan: plan !== null && block === null,
    guide,
    capText: acclimatisationText(cap, memberCapMax(plan, row.workerId)),
    plannedTaskId: block?.taskId ?? null,
    buddy: data.buddyOf.get(row.workerId) ?? null,
  }
}

export interface CrewBoardProps {
  data: ConsoleData
  restArea: 'cooled_cabin' | 'shade'
  assigned: Readonly<Record<string, { label: string; t: number }>>
  onAssign: (workerId: string, o: ReassignOption) => void
  onAck: (alertId: string) => void
  className?: string
}

export function CrewBoardPanel({ data, restArea, assigned, onAssign, onAck, className }: CrewBoardProps) {
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [needsAckOnly, setNeedsAckOnly] = useState(false)
  const filterName = useId()

  const groups = useMemo(
    () =>
      data.board.crews.map((crew) => {
        const cards = crew.rows.map((r) => cardModel(r, crew, data))
        const byId = new Map(cards.map((c) => [c.row.workerId, c] as const))
        const sorted = sortRows(crew.rows, (r) => byId.get(r.workerId)?.needsAck ?? false).map((r) => byId.get(r.workerId) as CardModel)
        return { crew, cards: sorted, options: reassignOptions(crew.crew.tasks, restArea) }
      }),
    [data, restArea],
  )
  const total = groups.reduce((n, g) => n + g.cards.length, 0)
  const waiting = groups.reduce((n, g) => n + g.cards.filter((c) => c.needsAck).length, 0)
  const visible = groups.map((g) => ({ ...g, cards: g.cards.filter((c) => passesLevelFilter(c.level, filter) && (!needsAckOnly || c.needsAck)) }))
  const shown = visible.reduce((n, g) => n + g.cards.length, 0)

  return (
    <section aria-labelledby="crew-board-h" className={cx('@container flex min-w-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="crew-board-h" className="text-base font-semibold text-ink">
            Crew board
          </h2>
          <p className="text-sm text-muted">
            {total} workers · sorted by severity
            {waiting > 0 && (
              <>
                {' '}
                · <span className="font-semibold text-ink">{waiting} need your acknowledgement</span>
              </>
            )}
          </p>
        </div>
        <PrivacyNote />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-3 py-2">
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="sr-only">Show workers at level</legend>
          {LEVEL_FILTER_OPTIONS.map((o) => (
            <label
              key={o.id}
              className={cx(
                'cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === o.id ? 'border-ink bg-ink text-white' : 'border-line-strong bg-surface text-ink hover:bg-canvas',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-shade',
              )}
            >
              <input type="radio" name={filterName} value={o.id} checked={filter === o.id} onChange={() => setFilter(o.id)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </fieldset>
        <Toggle checked={needsAckOnly} onCheckedChange={setNeedsAckOnly} label="Needs acknowledgement only" />
        <span className="ms-auto text-xs text-muted tabular-nums" aria-live="polite">
          Showing {shown} of {total}
        </span>
      </div>

      {shown === 0 ? (
        <EmptyState
          icon={UsersRound}
          title={total === 0 ? 'No workers on this board' : 'No workers match these filters'}
          description={total === 0 ? 'This supervisor has no crew in the loaded scenario.' : 'Change the level filter or turn off “Needs acknowledgement only”.'}
          size="sm"
        />
      ) : (
        visible
          .filter((g) => g.cards.length > 0)
          .map((g) => (
            <section key={g.crew.crew.id} aria-labelledby={`crew-${g.crew.crew.id}`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id={`crew-${g.crew.crew.id}`} className="text-sm font-semibold text-ink">
                  {g.crew.crew.name}
                </h3>
                <span className="text-xs text-muted">
                  Supervisor {g.crew.crew.supervisorName} · {g.crew.rows.length} workers
                </span>
                <CrewCounts counts={g.crew.counts} />
              </div>
              <ul className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                {g.cards.map((c) => (
                  <WorkerCard
                    key={c.row.workerId}
                    c={c}
                    now={data.now}
                    options={g.options}
                    assigned={assigned[c.row.workerId] ?? null}
                    query={data.scenarioQuery}
                    onAssign={(o) => onAssign(c.row.workerId, o)}
                    onAck={onAck}
                  />
                ))}
              </ul>
            </section>
          ))
      )}
    </section>
  )
}

/** Level counts of a crew: pictogram + number + level name (never colour alone). */
export function CrewCounts({ counts, className }: { counts: Readonly<Record<RiskLevel, number>>; className?: string }) {
  const levels: RiskLevel[] = ['emergency', 'stop', 'high', 'caution', 'safe']
  return (
    <ul className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', className)} aria-label="Workers by level">
      {levels
        .filter((l) => counts[l] > 0)
        .map((l) => {
          const s = LEVEL_STYLES[l]
          const Icon = s.icon
          return (
            <li key={l} className={cx('inline-flex items-center gap-1 font-medium', s.text)}>
              <Icon aria-hidden size={13} />
              <span className="tabular-nums">{counts[l]}</span>
              <span>{LEVEL_LABEL[l]}</span>
            </li>
          )
        })}
    </ul>
  )
}

const LEVEL_LABEL: Readonly<Record<RiskLevel, string>> = { safe: 'safe', caution: 'caution', high: 'high risk', stop: 'stop work', emergency: 'emergency' }

function CycleLine({ c }: { c: CardModel }) {
  const level = c.level ?? undefined
  if (c.emergency) return null
  if (c.resting) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink">
        <Hourglass aria-hidden size={16} className="shrink-0 text-muted" />
        <span>
          Resting now
          <span className="block text-xs text-muted">The device says when heat work can resume.</span>
        </span>
      </p>
    )
  }
  if (c.restUntil || c.offPlan) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink">
        <Hourglass aria-hidden size={16} className="shrink-0 text-muted" />
        <span>
          {c.restUntil ? `Rest area until ${c.restUntil}` : 'Outside the planned shift'}
          <span className="block text-xs text-muted">No task planned{c.restUntil ? ' for the crew in this block' : ''}.</span>
        </span>
      </p>
    )
  }
  const g = c.guide
  if (!g) return <p className="text-xs text-muted">Work/rest: no data from the device</p>
  if (g.kind === 'continuous') return <p className="text-sm text-ink">Continuous work allowed</p>
  if (g.kind === 'no_work') return c.capText ? null : <p className="text-sm text-ink">No heat work this hour</p>
  const working = g.kind === 'work'
  return (
    <div className="flex items-center gap-3">
      <CountdownRing
        remainingMin={g.remainingMin}
        totalMin={g.phaseMin}
        label={working ? 'of work in this cycle' : 'of rest in this cycle'}
        level={working ? level : undefined}
        size={48}
        strokeWidth={5}
        formatTime={(m) => String(Math.max(0, Math.ceil(m)))}
      />
      <p className="min-w-0 text-sm text-ink">
        <span className="font-medium">{working ? 'Working' : 'On rest break'}</span> · {durationText(Math.ceil(g.remainingMin))} left
        <span className="block text-xs text-muted">
          Work/rest {g.workMin}/{g.restMin} min per hour · guide, the device decides
        </span>
      </p>
    </div>
  )
}

function AckLine({ c, now }: { c: CardModel; now: number }) {
  if (c.coveredBy) return <span className="text-muted">Covered by the crew site-condition alert</span>
  if (!c.alert || !c.esc) {
    const st = c.row.data.ackStatus
    return <span className="text-muted">{st && st !== 'none' && st !== 'resolved' ? 'Alert handled on the worker’s phone' : 'No open alert'}</span>
  }
  const e = c.esc
  if (e.supervisorAckT !== null) return <span className="text-safe">Acknowledged by supervisor · {hhmm(e.supervisorAckT)}</span>
  if (e.firstAck) {
    return (
      <span className="text-muted">
        Acknowledged by {ROLE_LABELS[e.firstAck.role].toLowerCase()} · {hhmm(e.firstAck.t)}
      </span>
    )
  }
  if (e.escalatedAt !== null) return <span className="font-medium text-stop">Escalated at {hhmm(e.escalatedAt)}</span>
  return <span className="text-muted">Raised {hhmm(c.alert.t)} · {Math.max(0, Math.floor((now - c.alert.t) / 60000))} min ago</span>
}

function WorkerCard({
  c,
  now,
  options,
  assigned,
  query,
  onAssign,
  onAck,
}: {
  c: CardModel
  now: number
  options: readonly ReassignOption[]
  assigned: { label: string; t: number } | null
  query: Readonly<Record<string, string>>
  onAssign: (o: ReassignOption) => void
  onAck: (alertId: string) => void
}) {
  const id = c.row.workerId
  const d = c.row.data
  const level = c.level
  const style = level ? LEVEL_STYLES[level] : null
  const emphasise = level !== null && RISK_ORDER[level] >= RISK_ORDER.high
  const actions = (d.actions ?? []).filter((a) => a !== 'shade_breaks' && !((c.notCleared || c.emergency) && a === 'rotate_task'))
  const noData = c.row.decision !== 'allowed'
  const due = c.esc?.dueT ?? null
  return (
    <li className="min-w-0">
      <Card
        as="article"
        padding="none"
        level={emphasise ? (level as RiskLevel) : undefined}
        aria-labelledby={`wk-${id}`}
        className={cx('flex h-full flex-col gap-3 p-3.5', c.needsAck && style && cx('ring-2 ring-offset-1', RING[level as RiskLevel]))}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 id={`wk-${id}`} className="truncate text-sm font-semibold text-ink">
              {c.name}
            </h4>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                <Link2 aria-hidden size={12} />
                {c.buddy ? `Buddy: ${c.buddy}` : 'No buddy assigned'}
              </span>
              {c.row.source === 'remote' && (
                <span className="inline-flex items-center gap-1 text-shade">
                  <Radio aria-hidden size={12} />
                  Live from phone
                </span>
              )}
            </p>
          </div>
          {level ? (
            <LevelPill level={level} size="sm" variant={RISK_ORDER[level] >= RISK_ORDER.stop ? 'solid' : 'tint'} />
          ) : (
            <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">No data</span>
          )}
        </div>

        {noData ? (
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Info aria-hidden size={14} className="mt-0.5 shrink-0" />
            {c.row.reason}
          </p>
        ) : (
          <>
            {c.needsAck && c.alert && style && (
              <div className={cx('flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2', style.tint)}>
                <p className="min-w-0 text-xs text-ink">
                  <span className={cx('flex items-center gap-1 font-semibold', style.text)}>
                    <BellRing aria-hidden size={14} />
                    Needs your acknowledgement
                  </span>
                  <span className="mt-0.5 block">{c.alert.reasonText}</span>
                  {due !== null && (
                    <span className="block tabular-nums text-muted">
                      {now < due
                        ? `${c.alert.level === 'high' ? 'Reminder' : 'Escalates'} in ${clockText((due - now) / 60000)}`
                        : `Waiting ${durationText((now - c.alert.t) / 60000)}`}
                    </span>
                  )}
                </p>
                <AckButton level={c.alert.level} who={c.name} onAck={() => onAck((c.alert as AlertItem).id)} />
              </div>
            )}

            {c.notCleared && !c.emergency && (
              <p className="rounded-lg border border-line bg-canvas px-2.5 py-2 text-xs text-ink">
                <span className="font-semibold">Not cleared for heat work now:</span> assign cooler work. The device will say when to return.
              </p>
            )}
            {c.deviceRest && !c.notCleared && (
              <p className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-ink">
                <Hourglass aria-hidden size={13} className="text-muted" />
                Device-directed rest
              </p>
            )}

            <CycleLine c={c} />

            {actions.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Actions">
                {actions.map((a) => (
                  <li key={a}>
                    <ActionChip action={a} size="sm" label={actionLabel(a, { workMinPerHour: d.workMinPerHour })} level={actionLevel(a, level)} />
                  </li>
                ))}
              </ul>
            )}

            {c.capText && (
              <p className="flex items-start gap-1.5 text-xs text-ink">
                <CalendarClock aria-hidden size={14} className="mt-0.5 shrink-0 text-shade" />
                {c.capText}
              </p>
            )}

            {assigned && <AssignedNote assigned={assigned} />}
            {c.reassign && <ReassignControl who={c.name} options={options} plannedTaskId={c.plannedTaskId} onAssign={onAssign} />}
          </>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-2 text-xs">
          <AckLine c={c} now={now} />
          <OpenPhoneLink workerId={id} who={c.name} query={query} />
        </div>
      </Card>
    </li>
  )
}

const RING: Readonly<Record<RiskLevel, string>> = {
  safe: 'ring-safe-fill',
  caution: 'ring-caution-fill',
  high: 'ring-high-fill',
  stop: 'ring-stop-fill',
  emergency: 'ring-emergency-fill',
}

/** Urgent actions carry the worker's level tint; routine ones stay neutral. */
function actionLevel(a: ActionId, level: RiskLevel | null): RiskLevel | undefined {
  if (!level) return undefined
  const urgent: readonly ActionId[] = ['stop_work', 'rest_shade_now', 'cool_down', 'call_998', 'cool_first', 'stay_with_worker', 'first_aider_check']
  return urgent.includes(a) ? level : undefined
}

