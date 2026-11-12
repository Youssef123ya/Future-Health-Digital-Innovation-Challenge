/**
 * Alert feed of the supervisor console (docs/dev/wave2c-alerts.md "How the UI should present…"):
 * - INDIVIDUAL alerts (a person needs attention; non-clinical reason) are the prominent, actionable cards;
 * - EXPOSURE alerts (site/crew heat) are calm crew-level rows with one acknowledgement for the crew;
 * - alerts under designed suppression (ANSI/ISA-18.2) are only a quiet, expandable count, never alerts.
 * Reads AlertItem (console actions, filtered reason) and workflow roles/times only.
 */
import { useMemo, type ReactNode } from 'react'
import { BellOff, BellRing, CheckCheck, ChevronDown, Hourglass, Scale, ShieldCheck, Siren, Sun } from 'lucide-react'
import { RISK_ORDER, type RiskLevel } from '../../../engine/types'
import type { AlertItem, CrewBoard } from '../../../state/selectors'
import { ActionChip, LEVEL_STYLES, LevelPill, cx } from '../../components'
import {
  ROLE_LABELS,
  actionLabel,
  agoText,
  blockAt,
  clockText,
  durationText,
  escalationInfo,
  hhmm,
  reassignOptions,
  wantsReassign,
  type ReassignOption,
} from './model'
import { ACK_POLICY, type ConsoleData } from './useConsole'
import { AckButton, AssignedNote, OpenPhoneLink, ReassignControl, ResolveControl } from './controls'

export interface AlertFeedProps {
  data: ConsoleData
  restArea: 'cooled_cabin' | 'shade'
  assigned: Readonly<Record<string, { label: string; t: number }>>
  onAssign: (workerId: string, o: ReassignOption) => void
  onAck: (alertId: string) => void
  onResolve: (workerId: string, alertId: string) => void
  className?: string
}

const NEUTRAL_REASONS = new Set(['reason.device_directed_rest', 'reason.not_cleared_for_heat_work'])

export function AlertFeed({ data, restArea, assigned, onAssign, onAck, onResolve, className }: AlertFeedProps) {
  const { groups, board, now, names } = data
  const crewOfWorker = useMemo(() => {
    const m = new Map<string, CrewBoard>()
    for (const c of board.crews) for (const r of c.rows) m.set(r.workerId, c)
    return m
  }, [board])
  const optionsByCrew = useMemo(() => new Map(board.crews.map((c) => [c.crew.id, reassignOptions(c.crew.tasks, restArea)] as const)), [board.crews, restArea])

  const individual = groups.individual
  const waiting = individual.filter((a) => escalationInfo(a, data.wf.get(a.id), ACK_POLICY).supervisorAckT === null).length
  const conditions = groups.crew.length + groups.site.length + groups.worker.length
  const suppressed = board.suppressedAlerts

  return (
    <section aria-labelledby="alerts-h" className={cx('flex min-w-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="alerts-h" className="text-base font-semibold text-ink">
            Alerts
          </h2>
          <p className="text-sm text-muted" aria-live="polite">
            {individual.length === 0 ? 'Nobody needs individual attention' : `${individual.length} need attention`}
            {waiting > 0 && `, ${waiting} not yet acknowledged by you`}
          </p>
        </div>
      </div>

      {(groups.crew.length > 0 || groups.site.length > 0) && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Site conditions</h3>
          <ul className="flex flex-col gap-2">
            {groups.site.map((a) => (
              <ConditionRow key={a.id} a={a} scopeText="Whole site" members={[]} data={data} onAck={onAck} />
            ))}
            {groups.crew.map((c) => (
              <ConditionRow
                key={c.alert.id}
                a={c.alert}
                scopeText={names.get(c.alert.crewId ?? '') ?? 'Crew'}
                members={(c.alert.memberIds ?? []).map((id) => names.get(id) ?? id)}
                data={data}
                onAck={onAck}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Needs attention</h3>
        {individual.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-3 text-sm text-muted">
            <ShieldCheck aria-hidden size={18} className="text-safe" />
            No individual alerts open.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {individual.map((a) => {
              const crew = a.workerId ? crewOfWorker.get(a.workerId) : undefined
              const opts = crew ? (optionsByCrew.get(crew.crew.id) ?? []) : []
              return (
                <IndividualAlert
                  key={a.id}
                  a={a}
                  data={data}
                  crew={crew}
                  options={opts}
                  assigned={a.workerId ? (assigned[a.workerId] ?? null) : null}
                  onAssign={onAssign}
                  onAck={onAck}
                  onResolve={onResolve}
                />
              )
            })}
          </ol>
        )}
      </div>

      {groups.worker.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Site heat for individual workers</h3>
          <ul className="flex flex-col gap-2">
            {groups.worker.map((a) => {
              const crew = a.workerId ? crewOfWorker.get(a.workerId) : undefined
              const wid = a.workerId
              return (
                <ConditionRow
                  key={a.id}
                  a={a}
                  scopeText={names.get(wid ?? '') ?? 'Worker'}
                  members={[]}
                  data={data}
                  onAck={onAck}
                  reassign={
                    wid && crew && wantsReassign(a)
                      ? {
                          options: optionsByCrew.get(crew.crew.id) ?? [],
                          plannedTaskId: blockAt(crew.plan, now)?.taskId ?? null,
                          onAssign: (o) => onAssign(wid, o),
                        }
                      : null
                  }
                />
              )
            })}
          </ul>
        </div>
      )}

      {conditions === 0 && individual.length === 0 && suppressed.length === 0 && (
        <p className="text-xs text-muted">The feed updates as the simulated day runs.</p>
      )}

      {suppressed.length > 0 && (
        <details className="group rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-muted [&::-webkit-details-marker]:hidden">
            <BellOff aria-hidden size={15} className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink tabular-nums">{suppressed.length}</span> site{' '}
              {suppressed.length === 1 ? 'advisory' : 'advisories'} logged, not sent: already covered by the plan
            </span>
            <ChevronDown aria-hidden size={15} className="shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-2 flex flex-col divide-y divide-line border-t border-line">
            {suppressed.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-xs text-muted">
                <span className="tabular-nums">{hhmm(a.t)}</span>
                <span className="font-medium text-ink">{scopeName(a, names)}</span>
                <span className="min-w-0 flex-1">{a.reasonText}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted">
            Logged for the record and notified to nobody while the plan already enforces the action (ANSI/ISA-18.2 designed
            suppression). Stop-level and individual alerts are never suppressed.
          </p>
        </details>
      )}
    </section>
  )
}

function scopeName(a: AlertItem, names: ReadonlyMap<string, string>): string {
  if (a.scope === 'site') return 'Whole site'
  if (a.scope === 'crew') return names.get(a.crewId ?? '') ?? 'Crew'
  return names.get(a.workerId ?? '') ?? 'Worker'
}

/** Calm crew/site condition row: frame icon, the shared reason, members, one acknowledgement. */
function ConditionRow({
  a,
  scopeText,
  members,
  data,
  onAck,
  reassign,
}: {
  a: AlertItem
  scopeText: string
  members: string[]
  data: ConsoleData
  onAck: (id: string) => void
  reassign?: { options: readonly ReassignOption[]; plannedTaskId: string | null; onAssign: (o: ReassignOption) => void } | null
}) {
  const esc = escalationInfo(a, data.wf.get(a.id), ACK_POLICY)
  const Icon = a.frame === 'rule' ? Scale : Sun
  const style = LEVEL_STYLES[a.level]
  const label = a.frameLabel ?? a.basisLabel
  const neutral = a.reasonKey !== undefined && NEUTRAL_REASONS.has(a.reasonKey)
  const stripped = a.reasonText.startsWith(label) ? a.reasonText.slice(label.length).replace(/^[\s:–-]+/, '') : a.reasonText
  const reason = stripped.length > 0 ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : a.reasonText
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
      <span aria-hidden className={cx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-surface', style.text)}>
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          <span className="me-1.5 inline-block rounded border border-line bg-surface px-1.5 py-px text-[11px] font-semibold text-muted">{label}</span>
          <span className={neutral ? 'text-ink' : 'font-medium'}>{reason}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{scopeText}</span>
          {members.length > 0 && <span>· {members.length} members</span>}
          <span>· since {hhmm(a.t)}</span>
          <LevelPill level={a.level} size="sm" />
        </p>
        {members.length > 0 && <p className="mt-1 text-xs text-muted">Applies to {members.join(', ')}</p>}
        {a.actions.length > 0 && (
          <p className="mt-1 text-xs text-ink">
            {a.actions.map((x) => actionLabel(x)).join(' · ')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {esc.supervisorAckT !== null ? (
          <span className="inline-flex items-center gap-1 text-xs text-safe">
            <CheckCheck aria-hidden size={14} />
            Acknowledged {hhmm(esc.supervisorAckT)}
          </span>
        ) : (
          <AckButton level={RISK_ORDER[a.level] >= RISK_ORDER.stop ? a.level : 'high'} label="Acknowledge" who={`${scopeText}, ${reason}`} onAck={() => onAck(a.id)} />
        )}
      </div>
      {reassign && reassign.options.length > 0 && (
        <ReassignControl who={scopeText} options={reassign.options} plannedTaskId={reassign.plannedTaskId} onAssign={reassign.onAssign} />
      )}
    </li>
  )
}

/** Prominent, actionable card about one person. */
function IndividualAlert({
  a,
  data,
  crew,
  options,
  assigned,
  onAssign,
  onAck,
  onResolve,
}: {
  a: AlertItem
  data: ConsoleData
  crew: CrewBoard | undefined
  options: readonly ReassignOption[]
  assigned: { label: string; t: number } | null
  onAssign: (workerId: string, o: ReassignOption) => void
  onAck: (id: string) => void
  onResolve: (workerId: string, alertId: string) => void
}) {
  const now = data.now
  const esc = escalationInfo(a, data.wf.get(a.id), ACK_POLICY)
  const style = LEVEL_STYLES[a.level]
  const who = a.workerId ? (data.names.get(a.workerId) ?? 'Worker') : scopeName(a, data.names)
  const neutral = a.reasonKey !== undefined && NEUTRAL_REASONS.has(a.reasonKey)
  const severe = RISK_ORDER[a.level] >= RISK_ORDER.stop
  const block = crew ? blockAt(crew.plan, now) : null
  const LeadIcon = a.level === 'emergency' ? Siren : BellRing
  return (
    <li>
      <article
        aria-labelledby={`al-${a.id}`}
        className={cx('rounded-xl border border-s-4 bg-surface p-3.5 shadow-xs', style.border, a.level === 'emergency' && style.tint)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 id={`al-${a.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <LeadIcon aria-hidden size={15} className={style.text} />
              <span className="truncate">{who}</span>
            </h4>
            <p className="mt-0.5 text-xs text-muted">
              {crew ? `${crew.crew.name} · ` : ''}
              {a.basisLabel} · raised {hhmm(a.t)} ({agoText(now, a.t)})
            </p>
          </div>
          <LevelPill level={a.level} size="sm" variant={severe ? 'solid' : 'tint'} />
        </div>

        <p className={cx('mt-2 text-sm', neutral ? 'text-muted' : 'text-ink')}>
          {neutral && <Hourglass aria-hidden size={14} className="me-1 inline-block align-[-2px]" />}
          {a.reasonText}
        </p>

        {a.actions.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Actions">
            {a.actions.filter((x) => !(a.level === 'emergency' && x === 'rotate_task')).map((x) => (
              <li key={x}>
                <ActionChip action={x} size="sm" label={actionLabel(x)} level={severe && x !== 'rotate_task' && x !== 'midday_break' ? a.level : undefined} />
              </li>
            ))}
          </ul>
        )}

        <EscalationLine level={a.level} esc={esc} raisedT={a.t} now={now} />

        {assigned && (
          <div className="mt-2">
            <AssignedNote assigned={assigned} />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {esc.supervisorAckT === null && <AckButton level={a.level} who={who} onAck={() => onAck(a.id)} />}
          {a.scope === 'worker' && a.workerId && <ResolveControl who={who} onResolve={() => onResolve(a.workerId as string, a.id)} />}
          {a.workerId && (
            <OpenPhoneLink workerId={a.workerId} who={who} query={data.scenarioQuery} className="ms-auto text-xs" />
          )}
          {wantsReassign(a) && a.level !== 'emergency' && a.workerId && options.length > 0 && (
            <ReassignControl who={who} options={options} plannedTaskId={block?.taskId ?? null} onAssign={(o) => onAssign(a.workerId as string, o)} />
          )}
        </div>
      </article>
    </li>
  )
}

function EscalationLine({ level, esc, raisedT, now }: { level: RiskLevel; esc: ReturnType<typeof escalationInfo>; raisedT: number; now: number }) {
  const parts: ReactNode[] = []
  if (esc.escalatedAt !== null) {
    parts.push(
      <span key="esc" className="inline-flex items-center gap-1 font-medium text-stop">
        <Siren aria-hidden size={13} />
        Escalated {hhmm(esc.escalatedAt)}
      </span>,
    )
  }
  if (esc.firstAck) {
    const by = ROLE_LABELS[esc.firstAck.role].toLowerCase()
    parts.push(
      <span key="ack" className="inline-flex items-center gap-1 text-safe">
        <CheckCheck aria-hidden size={13} />
        Acknowledged by {by} {hhmm(esc.firstAck.t)} ({durationText((esc.firstAck.t - raisedT) / 60000)})
      </span>,
    )
    if (esc.supervisorAckT !== null && esc.firstAck.role !== 'supervisor') {
      parts.push(
        <span key="sup" className="text-safe">
          supervisor {hhmm(esc.supervisorAckT)}
        </span>,
      )
    }
  } else if (esc.dueT !== null) {
    parts.push(
      now < esc.dueT ? (
        <span key="due" className="font-medium text-ink tabular-nums">
          Not acknowledged · {level === 'high' ? 'reminder' : 'escalates'} in {clockText((esc.dueT - now) / 60000)}
        </span>
      ) : (
        <span key="due" className="font-medium text-stop tabular-nums">
          Not acknowledged for {durationText((now - raisedT) / 60000)}
        </span>
      ),
    )
  } else if (esc.supervisorAckT === null) {
    parts.push(
      <span key="wait" className="text-muted">
        Not acknowledged yet
      </span>,
    )
  }
  if (parts.length === 0) return null
  return <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">{parts}</p>
}
