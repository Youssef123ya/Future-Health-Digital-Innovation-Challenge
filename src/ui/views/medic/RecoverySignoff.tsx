/**
 * Recovery sign-off: the conditions released to this role (rest observed from the location, the console's symptom-free
 * re-check, the water-loss restoration where the role may see it), the first aider's re-check form and the sign-off
 * itself ({ kind: 'resolve' } injection: the PHS recovery review / clinical latch resolution). The button enables only
 * when every condition is met or verified on the device; the device keeps enforcing its own holds either way.
 */
import { useId, useMemo, useState, type FormEvent } from 'react'
import { ClipboardCheck, ClipboardClock, ClipboardPen, Info, Lock, Siren } from 'lucide-react'
import { TRIAGE_TIMING } from '../../../engine/clinical'
import type { SymptomId } from '../../../engine/types'
import { formatLocalHhmm } from '../../../engine/time'
import { simStore } from '../../../state/simStore'
import { Button, Card, CardHeader, cx } from '../../components'
import {
  SYMPTOM_TIER_TEXT,
  elapsedMin,
  isCleanRecheck,
  nextRecheckDue,
  sortSymptoms,
  symptomLabel,
  symptomTier,
  symptomsByTier,
  type MedicCaseVM,
  type MedicRole,
  type RecheckEntry,
  type SignoffCondition,
} from './medicModel'
import { noteSignoff, updateCase, type CaseLocal } from './medicStore'
import { Call998Link, ConditionIcon, ConditionTag } from './ui'

export interface RecoverySignoffProps {
  c: MedicCaseVM
  role: MedicRole
  now: number
  local: CaseLocal
  conditions: SignoffCondition[]
  ready: boolean
  rechecks: readonly RecheckEntry[]
}

const TIER_HEADING: Readonly<Record<0 | 1 | 2 | 3, string>> = {
  3: 'Red flags: emergency, call 998',
  2: 'Stop work: first aid, no heat work today',
  1: 'Rest and watch',
  0: 'Advice only',
}

export function RecoverySignoff({ c, role, now, local, conditions, ready, rechecks }: RecoverySignoffProps) {
  const emergency = c.level === 'emergency'
  const [confirming, setConfirming] = useState(false)
  const caseRechecks = rechecks.filter((r) => r.t >= c.startT)
  const last = caseRechecks.length > 0 ? caseRechecks[caseRechecks.length - 1] : undefined
  const due = nextRecheckDue(c.startT, last?.t ?? null)
  const dueIn = Math.round((due - now) / 60_000)

  if (c.kind === 'site') {
    return (
      <Card as="section" aria-label="Recovery sign-off">
        <CardHeader icon={ClipboardCheck} title="Recovery sign-off" description="Not needed for this case." />
        <p className="flex gap-2 rounded-lg bg-canvas p-3 text-sm text-muted">
          <Info aria-hidden size={18} className="mt-0.5 shrink-0 text-shade" />
          <span>
            This stop follows a shared site condition (heat or a site rule). The worker’s device and the crew plan lift it when conditions allow; no one
            signs it off by hand. Check the worker, keep them in shade with water, and watch for symptoms.
          </span>
        </p>
      </Card>
    )
  }

  const pendingCount = conditions.filter((x) => x.state === 'pending' || x.state === 'confirm').length
  const signOff = () => {
    simStore.getState().inject({ kind: 'resolve', workerId: c.workerId, alertId: c.alert.id, by: role })
    noteSignoff({ name: c.name, t: now, role, kind: c.kind, emergency })
    setConfirming(false)
  }

  return (
    <Card as="section" aria-label={emergency ? 'Close the case' : 'Recovery sign-off'}>
      <CardHeader
        icon={ClipboardCheck}
        title={emergency ? 'Close the case: hand-over' : 'Recovery sign-off'}
        description={
          emergency
            ? 'An emergency ends with the hand-over to the 998 ambulance team.'
            : 'The sign-off enables when every condition below is met or verified on the worker’s device.'
        }
      />

      <ul className="space-y-2" aria-label="Sign-off conditions">
        {conditions.map((x) => (
          <li key={x.id} className="flex items-start gap-3 rounded-lg border border-line p-3">
            <ConditionIcon state={x.state} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{x.label}</p>
                <ConditionTag state={x.state} />
              </div>
              <p className="mt-0.5 text-sm text-muted">{x.detail}</p>
              {x.id === 'handover' && (
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    checked={local.handoverConfirmed}
                    onChange={(e) => updateCase(c.key, () => ({ handoverConfirmed: e.target.checked }))}
                    className="size-5 accent-shade"
                  />
                  The ambulance team has taken over
                </label>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!emergency && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm">
          <ClipboardClock aria-hidden size={18} className="shrink-0 text-shade" />
          <span className="text-ink">
            Next re-check due <span className="font-semibold tabular-nums">{formatLocalHhmm(due)}</span>
          </span>
          <span className={cx('tabular-nums', dueIn < 0 ? 'font-semibold text-stop' : 'text-muted')}>
            {dueIn < 0 ? `(overdue by ${-dueIn} min)` : dueIn === 0 ? '(due now)' : `(in ${dueIn} min)`}
          </span>
          <span className="w-full text-xs text-muted">
            Re-check at +{TRIAGE_TIMING.RECHECK_FIRST_MIN} and +{TRIAGE_TIMING.RECHECK_SECOND_MIN} min, then every {TRIAGE_TIMING.RECHECK_CONTINUE_EVERY_MIN} min; a
            stop-level sign not clearly better at {TRIAGE_TIMING.NOT_IMPROVING_MIN} min becomes an emergency.
          </span>
        </div>
      )}

      {!emergency && role === 'first_aider' && <RecheckForm c={c} now={now} />}
      {!emergency && role === 'occ_health' && (
        <p className="mt-3 flex gap-2 text-sm text-muted">
          <Lock aria-hidden size={16} className="mt-0.5 shrink-0" />
          Re-checks are recorded in person by the first aider{c.clinicalReleased ? '; their results appear here because the worker consented.' : '; their results stay off this console without consent.'}
        </p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        {!confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={ClipboardCheck} disabled={!ready} onClick={() => setConfirming(true)}>
              {emergency ? 'Close case: handed over' : 'Sign off recovery'}
            </Button>
            <p className="min-w-0 flex-1 text-sm text-muted" aria-live="polite">
              {ready
                ? 'All conditions met or verified on the device.'
                : `${pendingCount} condition${pendingCount === 1 ? '' : 's'} still open.`}
            </p>
          </div>
        ) : (
          <div role="group" aria-label="Confirm sign-off" className="rounded-lg border border-shade/40 bg-shade-bg p-3">
            <p className="text-sm font-medium text-ink">
              {emergency
                ? `Close the case for ${c.name} as handed over to the ambulance team at ${formatLocalHhmm(now)}?`
                : `Sign off the recovery of ${c.name} at ${formatLocalHhmm(now)}?`}
            </p>
            <p className="mt-1 text-sm text-muted">
              Recorded as {role === 'first_aider' ? 'first aider' : 'occupational health'} in the case record. The device keeps any hold it still
              enforces{c.kind === 'clinical' ? '; after a first-aid stop, no more heat work today' : ''}.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" icon={ClipboardCheck} onClick={signOff}>
                Confirm sign-off
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

/** The first aider's in-person re-check, recorded as a check-in by the first aider ({ kind: 'checkin' }). */
function RecheckForm({ c, now }: { c: MedicCaseVM; now: number }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<SymptomId[]>([])
  const [saved, setSaved] = useState<{ t: number; clean: boolean; redFlag: boolean } | null>(null)
  const formId = useId()
  const groups = useMemo(() => symptomsByTier(), [])
  const redFlag = picked.some((s) => symptomTier(s) === 3)
  const clean = isCleanRecheck(picked)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const symptoms = sortSymptoms(picked)
    simStore.getState().inject({ kind: 'checkin', checkin: { t: now, workerId: c.workerId, by: 'first_aider', symptoms } })
    setSaved({ t: now, clean: isCleanRecheck(symptoms), redFlag: symptoms.some((s) => symptomTier(s) === 3) })
    setPicked([])
    setOpen(false)
  }

  return (
    <div className="mt-3">
      {saved && (
        <p role="status" className={cx('mb-2 rounded-lg px-3 py-2 text-sm', saved.redFlag ? 'bg-emergency-bg text-emergency' : saved.clean ? 'bg-safe-bg text-safe' : 'bg-stop-bg text-stop')}>
          Re-check saved at <span className="tabular-nums">{formatLocalHhmm(saved.t)}</span>:{' '}
          {saved.redFlag ? 'red flag recorded — call 998 and start cooling.' : saved.clean ? 'no stop-level symptom.' : 'stop-level symptom recorded; keep resting and re-check.'}{' '}
          ({elapsedMin(saved.t, now)} min ago)
        </p>
      )}
      {!open ? (
        <Button variant="secondary" icon={ClipboardPen} onClick={() => setOpen(true)} aria-controls={formId} aria-expanded={false}>
          Record a re-check
        </Button>
      ) : (
        <form id={formId} onSubmit={submit} className="rounded-lg border border-line p-3">
          <fieldset>
            <legend className="text-sm font-semibold text-ink">Signs found at the in-person re-check</legend>
            <p className="mt-0.5 text-xs text-muted">Tick what you observe or the worker reports now. Leave everything unticked for a symptom-free re-check.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {groups.map((g) => (
                <div key={g.tier}>
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">{TIER_HEADING[g.tier]}</p>
                  <ul className="mt-1 space-y-1">
                    {g.items.map((s) => {
                      const id = `${formId}-${s}`
                      const checked = picked.includes(s)
                      return (
                        <li key={s} className="flex items-center gap-2">
                          <input
                            id={id}
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s] : p.filter((x) => x !== s)))}
                            className="size-4 accent-shade"
                          />
                          <label htmlFor={id} className="cursor-pointer text-sm text-ink">
                            {symptomLabel(s)}
                            <span className="sr-only"> ({SYMPTOM_TIER_TEXT[g.tier]})</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </fieldset>
          {redFlag && (
            <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-emergency-bg p-3 text-sm font-semibold text-emergency">
              <Siren aria-hidden size={18} />
              <span className="min-w-0 flex-1">Red flag: call 998 now and start cooling on site.</span>
              <Call998Link size="sm" />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant={clean ? 'primary' : 'secondary'} size="sm" icon={ClipboardPen}>
              {picked.length === 0 ? 'Save symptom-free re-check' : `Save re-check (${picked.length} sign${picked.length === 1 ? '' : 's'})`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPicked([])
                setOpen(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
