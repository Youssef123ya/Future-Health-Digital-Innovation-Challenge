/**
 * The active case list: one row per released case, most severe first (selector order). Rows show exactly what the role
 * projection released; a withheld field is stated as withheld, never left blank.
 */
import type { ReactNode } from 'react'
import { BellRing, ClipboardList, HeartPulse, Lock, ShieldCheck } from 'lucide-react'
import { formatLocalHhmm } from '../../../engine/time'
import { EmptyState, LEVEL_STYLES, LevelPill, cx } from '../../components'
import { ROLE_LABEL, elapsedMin, symptomLabel, type MedicCaseVM, type MedicRole } from './medicModel'
import { PlaceTag } from './ui'

export interface CaseListProps {
  cases: readonly MedicCaseVM[]
  role: MedicRole
  selectedKey: string | null
  onSelect: (c: MedicCaseVM) => void
  now: number
  crewNames: Readonly<Record<string, string>>
  emptyAction?: ReactNode
}

export function CaseList({ cases, role, selectedKey, onSelect, now, crewNames, emptyAction }: CaseListProps) {
  return (
    <section aria-labelledby="medic-cases-heading" className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id="medic-cases-heading" className="text-base font-semibold text-ink">
          {role === 'first_aider' ? 'Active cases' : 'Escalated cases'}
          <span className="ms-2 inline-grid min-w-6 place-items-center rounded-full bg-ink px-1.5 text-xs font-semibold text-white tabular-nums">{cases.length}</span>
        </h2>
        <span className="text-xs text-muted tabular-nums">as of {formatLocalHhmm(now)}</span>
      </div>
      {cases.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ShieldCheck}
          title={role === 'first_aider' ? 'No active stop or emergency cases' : 'No escalated cases'}
          description={
            role === 'first_aider'
              ? 'A case appears when a worker’s device raises a stop or an emergency, or routes a case to the first aider.'
              : 'Occupational health sees a case only once it is escalated: an emergency, a stop not acknowledged in time, or a case routed to first aid.'
          }
          action={emptyAction}
        />
      ) : (
        <ul className="divide-y divide-line" aria-label={role === 'first_aider' ? 'Active cases' : 'Escalated cases'}>
          {cases.map((c) => (
            <li key={c.key}>
              <CaseRow c={c} role={role} selected={c.key === selectedKey} onSelect={onSelect} now={now} crewName={c.crewId ? (crewNames[c.crewId] ?? c.crewId) : null} />
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line bg-canvas px-4 py-2 text-xs text-muted">
        {role === 'first_aider'
          ? 'Shown to first aiders: active stop and emergency cases only, never history.'
          : 'Shown to occupational health: escalated cases only, never other workers.'}
      </p>
    </section>
  )
}

function CaseRow({
  c,
  role,
  selected,
  onSelect,
  now,
  crewName,
}: {
  c: MedicCaseVM
  role: MedicRole
  selected: boolean
  onSelect: (c: MedicCaseVM) => void
  now: number
  crewName: string | null
}) {
  const open = elapsedMin(c.startT, now)
  const style = LEVEL_STYLES[c.level]
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(c)}
      className={cx(
        'block w-full border-s-4 px-4 py-3 text-start transition-colors focus-visible:outline-offset-[-2px]',
        style.border,
        selected ? 'bg-shade-bg' : 'hover:bg-canvas',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cx('truncate text-sm font-semibold', c.nameReleased ? 'text-ink' : 'text-muted')}>{c.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <LevelPill level={c.level} size="sm" />
            {c.escalated && role === 'first_aider' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-ink">
                <BellRing aria-hidden size={12} /> Escalated
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-end text-xs text-muted tabular-nums">
          <p>since {formatLocalHhmm(c.startT)}</p>
          <p className="font-semibold text-ink">{open} min</p>
        </div>
      </div>

      <div className="mt-2 space-y-1 text-xs">
        {role === 'first_aider' ? (
          c.location ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
              <span className="truncate">{c.location.task ?? 'Not on a task'}</span>
              <span aria-hidden>·</span>
              <PlaceTag place={c.location.place} />
            </p>
          ) : (
            <p className="text-muted">Location withheld</p>
          )
        ) : (
          <p className="text-muted">{crewName ?? 'Crew withheld'}</p>
        )}
        <SummaryLine c={c} role={role} />
        {c.chain.length > 0 && c.chain[c.chain.length - 1]?.acks.length === 0 && (
          <p className="text-stop">Not acknowledged yet</p>
        )}
        {c.chain.length > 0 && (c.chain[c.chain.length - 1]?.acks.length ?? 0) > 0 && (
          <p className="text-muted">
            Acknowledged by{' '}
            {[...new Set((c.chain[c.chain.length - 1]?.acks ?? []).map((a) => ROLE_LABEL[a.role].toLowerCase()))].join(', ')}
          </p>
        )}
      </div>
    </button>
  )
}

function SummaryLine({ c, role }: { c: MedicCaseVM; role: MedicRole }) {
  if (role === 'occ_health') {
    return c.clinicalReleased ? (
      <p className="flex items-center gap-1 text-ink">
        <HeartPulse aria-hidden size={13} className="text-shade" /> Clinical detail shared (consent)
      </p>
    ) : (
      <p className="flex items-center gap-1 text-muted">
        <Lock aria-hidden size={13} /> Clinical detail withheld: no consent
      </p>
    )
  }
  if (c.symptoms.state === 'withheld') {
    return (
      <p className="flex items-center gap-1 text-muted">
        <Lock aria-hidden size={13} /> Symptoms withheld: not escalated
      </p>
    )
  }
  const list = c.symptoms.list
  return (
    <p className="flex items-center gap-1 text-ink">
      <ClipboardList aria-hidden size={13} className="text-shade" />
      {list.length === 0 ? 'No symptoms reported' : `${symptomLabel(list[0] as (typeof list)[number])}${list.length > 1 ? ` +${list.length - 1} more` : ''}`}
    </p>
  )
}
