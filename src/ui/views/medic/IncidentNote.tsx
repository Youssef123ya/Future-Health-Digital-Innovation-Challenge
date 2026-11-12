/**
 * ADOSH Form G reminder for the case: the responder records the outcome as it becomes known and the panel states the
 * notification duty from the Abu Dhabi rule pack (engine/regulation.ts incidentNotification: fatality within 24 h,
 * Schedule B serious incident within 3 working days). Kept on this console only; the report itself is filed by HSE.
 */
import { useId } from 'react'
import { CircleCheck, FileExclamationPoint, Hourglass } from 'lucide-react'
import type { HeatIncidentOutcome } from '../../../engine/regulation'
import { DEFAULT_RULE_PACK } from '../../../engine/regulation'
import { formatLocalHhmm } from '../../../engine/time'
import { Card, CardHeader, InfoTip, cx } from '../../components'
import { formGNotice, formatLocalDay } from './medicModel'
import { updateCase, type CaseLocal } from './medicStore'

const OUTCOME_LABEL: Readonly<Record<keyof HeatIncidentOutcome, string>> = {
  fatality: 'Fatality',
  inpatientHospitalTreatment: 'Immediate in-patient treatment in a hospital',
  lossOfConsciousnessOrResuscitation: 'Loss of consciousness or resuscitation',
  unableToWorkNextShift: 'Unable to work the next shift',
}

const OUTCOME_ORDER: ReadonlyArray<keyof HeatIncidentOutcome> = ['inpatientHospitalTreatment', 'lossOfConsciousnessOrResuscitation', 'unableToWorkNextShift', 'fatality']

export function IncidentNote({ caseKey, local, incidentT, emergency }: { caseKey: string; local: CaseLocal; incidentT: number; emergency: boolean }) {
  const groupId = useId()
  const rule = DEFAULT_RULE_PACK.incidentNotification
  const notice = formGNotice(local.outcome, incidentT)
  if (!rule || !notice) return null
  const set = (k: keyof HeatIncidentOutcome, v: boolean) => updateCase(caseKey, (c) => ({ outcome: { ...c.outcome, [k]: v } }))

  return (
    <Card as="section" aria-label="Incident report, ADOSH Form G">
      <CardHeader
        icon={FileExclamationPoint}
        title={`Incident report: ADOSH ${rule.form}`}
        description={
          emergency
            ? 'An emergency is a likely notifiable incident: record the outcome as soon as it is known.'
            : 'Record the outcome if the case turns serious; the notification duty follows from it.'
        }
        actions={<InfoTip label="Rule source" align="end" content={rule.basis} />}
      />
      <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink">
        <span className="font-semibold">Fatality:</span> notify within {rule.fatalityWithinHours} h.{' '}
        <span className="font-semibold">Serious incident:</span> within {rule.seriousWithinWorkingDays} working days. To: {rule.recipient.toLowerCase()}.
      </p>

      <fieldset className="mt-3" aria-describedby={`${groupId}-hint`}>
        <legend className="text-sm font-semibold text-ink">Outcome for this case</legend>
        <p id={`${groupId}-hint`} className="text-xs text-muted">
          Schedule B criteria (a heat case meeting them is treated as notifiable).
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {OUTCOME_ORDER.map((k) => {
            const id = `${groupId}-${k}`
            return (
              <li key={k} className="flex items-start gap-2">
                <input id={id} type="checkbox" checked={local.outcome[k]} onChange={(e) => set(k, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-shade" />
                <label htmlFor={id} className="cursor-pointer text-sm text-ink">
                  {OUTCOME_LABEL[k]}
                </label>
              </li>
            )
          })}
        </ul>
      </fieldset>

      <div
        role="status"
        className={cx(
          'mt-3 flex items-start gap-3 rounded-lg border p-3 text-sm',
          notice.notifiable ? 'border-stop-fill/40 bg-stop-bg' : 'border-line bg-surface',
        )}
      >
        {notice.notifiable ? (
          <Hourglass aria-hidden size={18} className="mt-0.5 shrink-0 text-stop" />
        ) : (
          <CircleCheck aria-hidden size={18} className="mt-0.5 shrink-0 text-muted" />
        )}
        <div className="min-w-0">
          {notice.notifiable && notice.dueT !== null ? (
            <>
              <p className="font-semibold text-stop">
                Notifiable: submit {notice.form} {notice.deadline === 'fatality' ? `by ${formatLocalHhmm(notice.dueT)} on ${formatLocalDay(notice.dueT)}` : `by the end of ${formatLocalDay(notice.dueT)}`}
              </p>
              <p className="mt-0.5 text-muted">
                {notice.deadline === 'fatality'
                  ? `Within ${notice.fatalityWithinHours} h of the incident (raised ${formatLocalHhmm(incidentT)}, ${formatLocalDay(incidentT)}).`
                  : `Within ${notice.seriousWithinWorkingDays} working days of the incident on ${formatLocalDay(incidentT)} (Monday–Friday week assumed).`}{' '}
                Hand the record to the HSE manager, who files it with the {notice.recipient.toLowerCase()}.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-ink">Not notifiable on the outcome recorded so far.</p>
              <p className="mt-0.5 text-muted">Log the case in the site first-aid register; revisit if the worker is admitted or cannot work the next shift.</p>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
