/**
 * Case detail: who and where (as released), the escalation and acknowledgement record (role and time only), the cooling
 * protocol, the recovery sign-off, the case timeline, symptoms (first aider, once escalated) or the consented clinical
 * detail (occupational health), and the ADOSH Form G reminder.
 */
import { useMemo, type Ref } from 'react'
import {
  BellRing,
  ClipboardCheck,
  ClipboardList,
  ClipboardPen,
  Lock,
  Smartphone,
  Snowflake,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react'
import type { Notification } from '../../../engine/alerts'
import type { SymptomId } from '../../../engine/types'
import { formatLocalHhmm } from '../../../engine/time'
import { actionText } from '../../../i18n'
import { simStore } from '../../../state/simStore'
import { useSim } from '../../../state/hooks'
import { ActionChip, Button, Card, CardHeader, InfoTip, LevelPill, Timeline, type TimelineItem } from '../../components'
import {
  CASE_KIND_LABEL,
  NONE_REPORTED,
  ROLE_LABEL,
  caseTimeline,
  chainAcks,
  chainEscalatedAt,
  elapsedMin,
  firstAiderPagedAtRaise,
  recheckEntries,
  recheckStatus,
  restProgress,
  signoffConditions,
  waterHold,
  type CaseEventKind,
  type MedicCaseVM,
  type MedicRole,
} from './medicModel'
import { caseLocalOf, caseObsOf, clinicalOf, useMedic } from './medicStore'
import { ClinicalPanel } from './ClinicalPanel'
import { CoolingProtocol } from './CoolingProtocol'
import { IncidentNote } from './IncidentNote'
import { RecoverySignoff } from './RecoverySignoff'
import { Call998Link, Fact, PlaceTag, SymptomChip } from './ui'

export interface CaseDetailProps {
  c: MedicCaseVM
  role: MedicRole
  actorId: string
  now: number
  notifications: readonly Notification[]
  crewNames: Readonly<Record<string, string>>
  headingRef?: Ref<HTMLHeadingElement>
}

const VITAL_INTEREST_TIP =
  'Symptom- or physiology-driven stops and every emergency page the first aider the moment they are raised: vital interest, because the first aider is the responder. The case counts as escalated from that minute, so the reported symptoms are released to the first aider.'

const NOT_ESCALATED_TIP =
  'Not escalated: a stop acknowledged in time with no symptom or physiology cause. The first aider sees who, where, level and actions; symptoms stay on the worker’s device until the case escalates.'

const EVENT_ICON: Readonly<Partial<Record<CaseEventKind, LucideIcon>>> = {
  escalated: BellRing,
  notified: Smartphone,
  ack: UserRoundCheck,
  symptoms: ClipboardList,
  cooling: Snowflake,
  recheck: ClipboardPen,
  signoff: ClipboardCheck,
}

export function CaseDetail({ c, role, actorId, now, notifications, crewNames, headingRef }: CaseDetailProps) {
  const local = useMedic((s) => caseLocalOf(s, c.key))
  const obs = useMedic((s) => caseObsOf(s, c.key))
  const points = useMedic((s) => clinicalOf(s, c.key))
  const applied = useSim((s) => s.applied)
  const rechecks = useMemo(() => recheckEntries(applied, c.workerId), [applied, c.workerId])
  const rest = useMemo(() => restProgress(obs.place), [obs.place])
  const recheck = recheckStatus(rechecks, c.startT, rest.metT, obs.symptomsChangedT)
  const water = role === 'occ_health' && c.clinicalReleased ? waterHold([...(c.data.drivers_clinical ?? []), ...(c.data.drivers_nonclinical ?? [])]) : null
  const { conditions, ready } = signoffConditions({
    kind: c.kind,
    level: c.level,
    role,
    rest,
    recheck,
    clinicalReleased: c.clinicalReleased,
    water,
    handoverConfirmed: local.handoverConfirmed,
  })
  const showResults = role === 'first_aider' || c.clinicalReleased
  const events = useMemo(
    () =>
      caseTimeline({
        chain: c.chain,
        reasonText: c.alert.reasonText,
        role,
        notifications,
        rechecks: { entries: rechecks, showResults },
        steps: local.steps,
        symptomsSeen: c.symptoms.state === 'released' ? obs.symptomsSeen : null,
        caseFirstSeenT: obs.place.length > 0 || Object.keys(obs.symptomsSeen).length > 0 ? obs.firstSeenT : null,
      }),
    [c.chain, c.alert.reasonText, c.symptoms.state, role, notifications, rechecks, showResults, local.steps, obs.symptomsSeen, obs.place.length, obs.firstSeenT],
  )
  const items: TimelineItem[] = events.map((e) => ({
    id: e.id,
    t: e.t,
    title: e.title,
    ...(e.detail ? { description: e.detail } : {}),
    ...(e.level ? { level: e.level } : {}),
    ...(EVENT_ICON[e.kind] ? { icon: EVENT_ICON[e.kind] } : {}),
  }))

  const emergency = c.level === 'emergency'
  const current = c.chain[c.chain.length - 1]
  const ackedByMe = (current?.acks ?? []).some((a) => a.role === role)
  const escalatedAt = chainEscalatedAt(c.chain)
  const pagedAtRaise = firstAiderPagedAtRaise(c.chain)
  const acks = chainAcks(c.chain)
  const crewName = c.crewId ? (crewNames[c.crewId] ?? c.crewId) : null

  return (
    <article aria-labelledby="medic-case-heading" className="space-y-4">
      <Card level={c.level} padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted">
              {CASE_KIND_LABEL[c.kind]} · {c.alert.basisLabel}
              {c.alert.frameLabel ? ` · ${c.alert.frameLabel}` : ''}
              {role === 'occ_health' && crewName ? ` · ${crewName}` : ''}
            </p>
            <h2 id="medic-case-heading" ref={headingRef} tabIndex={-1} className="mt-0.5 text-xl font-semibold text-ink outline-none">
              {c.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{c.alert.reasonText}</p>
          </div>
          <LevelPill level={c.level} size="lg" variant="solid" />
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 2xl:grid-cols-4">
          <Fact label="Raised">
            <span className="tabular-nums">{formatLocalHhmm(c.startT)}</span>
            <span className="text-muted tabular-nums"> · open {elapsedMin(c.startT, now)} min</span>
          </Fact>
          <Fact
            label={
              <span className="inline-flex items-center gap-1">
                Escalated <InfoTip label="Why first aiders are paged at once" content={escalatedAt !== null ? VITAL_INTEREST_TIP : NOT_ESCALATED_TIP} />
              </span>
            }
          >
            {escalatedAt !== null ? (
              <>
                <span className="tabular-nums">{formatLocalHhmm(escalatedAt)}</span>
                <span className="text-muted">{pagedAtRaise ? ' · first aider paged at raise' : ` · ${elapsedMin(c.chain[0]?.t ?? c.startT, escalatedAt)} min after raise`}</span>
              </>
            ) : c.escalated ? (
              <span>Yes (hand-over to first aid)</span>
            ) : (
              <span className="text-muted">Not escalated</span>
            )}
          </Fact>
          <Fact label="Location">
            {c.location ? (
              <span className="flex flex-wrap items-center gap-x-2">
                <span>{c.location.task ?? 'Not on a task'}</span>
                <span aria-hidden className="text-muted">·</span>
                <PlaceTag place={c.location.place} />
              </span>
            ) : (
              <span className="text-muted">Withheld</span>
            )}
          </Fact>
          <Fact label="Acknowledged">
            {acks.length > 0 ? (
              <span>
                {acks.map((a, i) => (
                  <span key={`${a.role}-${a.t}-${i}`} className="me-2 inline-block">
                    {ROLE_LABEL[a.role]} <span className="text-muted tabular-nums">{formatLocalHhmm(a.t)}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-medium text-stop">Not yet</span>
            )}
          </Fact>
        </dl>

        {c.actions.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-muted">Actions on the case</p>
            <ul className="mt-1.5 flex flex-wrap gap-2" aria-label="Actions on the case">
              {c.actions.map((a) => (
                <li key={a}>
                  <ActionChip action={a} label={actionText('en', a)} size="sm" level={c.level} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {emergency ? <Call998Link size="lg" /> : <Call998Link size="md" variant="secondary" label="Call 998 if red flags appear" />}
          {!ackedByMe && current && (
            <Button
              variant={emergency ? 'secondary' : 'primary'}
              icon={UserRoundCheck}
              onClick={() => simStore.getState().inject({ kind: 'ack', alertId: current.id, role, actorId })}
            >
              {role === 'first_aider' ? 'Acknowledge: I am responding' : 'Acknowledge case'}
            </Button>
          )}
          {ackedByMe && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-safe">
              <UserRoundCheck aria-hidden size={16} /> Acknowledged as {ROLE_LABEL[role].toLowerCase()}
            </span>
          )}
          <p className="w-full text-xs text-muted">
            {emergency
              ? 'Cool first, transport second: start cooling on site now; do not wait for the ambulance.'
              : 'If the worker becomes confused, collapses, has a seizure or stops responding: call 998 and start cooling at once.'}
          </p>
        </div>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <CoolingProtocol
            key={`cool-${c.key}`}
            caseKey={c.key}
            local={local}
            now={now}
            caseT={c.startT}
            defaultOpen={c.kind === 'clinical'}
            emergency={emergency}
          />
          <RecoverySignoff c={c} role={role} now={now} local={local} conditions={conditions} ready={ready} rechecks={rechecks} />
        </div>
        <div className="space-y-4">
          {role === 'occ_health' ? <ClinicalPanel c={c} points={points} symptomsSeen={obs.symptomsSeen} /> : <SymptomsCard c={c} seen={obs.symptomsSeen} />}
          <Card as="section" aria-label="Case timeline">
            <CardHeader
              icon={ClipboardList}
              title="Case timeline"
              description="Alerts, escalation and acknowledgements (role and time only), plus this console’s entries."
            />
            <Timeline items={items} label="Case timeline" dense />
          </Card>
          <IncidentNote key={`inc-${c.key}`} caseKey={c.key} local={local} incidentT={c.startT} emergency={emergency} />
        </div>
      </div>
    </article>
  )
}

function SymptomsCard({ c, seen }: { c: MedicCaseVM; seen: Partial<Record<SymptomId, number>> }) {
  return (
    <Card as="section" aria-label="Reported symptoms">
      <CardHeader
        icon={ClipboardList}
        title="Reported symptoms"
        description={
          c.symptoms.state === 'released'
            ? 'Released because the case is escalated (vital interest). Check-ins of the last 120 min.'
            : 'Released to first aiders only once a case is escalated.'
        }
      />
      {c.symptoms.state === 'released' ? (
        c.symptoms.list.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Reported symptoms">
            {c.symptoms.list.map((s) => (
              <SymptomChip key={s} symptom={s} seenAt={seen[s] !== undefined ? `shown ${formatLocalHhmm(seen[s] as number)}` : undefined} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{NONE_REPORTED}.</p>
        )
      ) : (
        <p className="flex items-start gap-2 rounded-lg border border-dashed border-line-strong bg-canvas p-3 text-sm text-muted">
          <Lock aria-hidden size={16} className="mt-0.5 shrink-0" />
          <span>{c.symptoms.reason}</span>
        </p>
      )}
      <p className="mt-3 text-xs text-muted">Never shown to first aiders: history, physiology (heart rate, strain estimate) or health factors.</p>
    </Card>
  )
}
