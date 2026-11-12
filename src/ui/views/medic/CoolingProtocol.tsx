/**
 * The lay-rescuer cooling protocol as an interactive checklist with a running timer (engine/clinical.ts COOLING_PROTOCOL,
 * FIRST_AID, UAE_EMERGENCY): cool first, transport second. Ticks are the responder's own entries, stamped with the
 * simulated clock, kept on this console only.
 */
import { useId, useState } from 'react'
import { ChevronDown, Snowflake, Timer } from 'lucide-react'
import { COOLING_PROTOCOL, FIRST_AID, UAE_EMERGENCY, type FirstAidStep } from '../../../engine/clinical'
import { formatLocalHhmm } from '../../../engine/time'
import { Button, Card, CardHeader, CountdownRing, InfoTip, cx } from '../../components'
import { elapsedMin } from './medicModel'
import { updateCase, type CaseLocal } from './medicStore'
import { Call998Link } from './ui'

const COOLING_STEPS: ReadonlySet<FirstAidStep['id']> = new Set(['immerse', 'douse_or_towels'])

export interface CoolingProtocolProps {
  caseKey: string
  local: CaseLocal
  /** Current simulated time. */
  now: number
  /** Start of the case (first alert of the episode). */
  caseT: number
  /** Expanded by default (emergency and first-aid cases). */
  defaultOpen: boolean
  emergency: boolean
}

export function CoolingProtocol({ caseKey, local, now, caseT, defaultOpen, emergency }: CoolingProtocolProps) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  const started = local.coolingStartT
  const cooledFor = started !== null ? elapsedMin(started, now) : null
  const openFor = elapsedMin(caseT, now)
  const delayLeft = Math.max(0, FIRST_AID.COOLING_DELAY_LIMIT_MIN - openFor)
  const doneCount = COOLING_PROTOCOL.filter((s) => local.steps[s.id] !== undefined).length

  const toggle = (id: FirstAidStep['id'], checked: boolean) =>
    updateCase(caseKey, (c) => {
      const steps = { ...c.steps }
      if (checked) steps[id] = now
      else delete steps[id]
      const coolingStartT = checked && COOLING_STEPS.has(id) && c.coolingStartT === null ? now : c.coolingStartT
      return { steps, coolingStartT }
    })

  return (
    <Card as="section" aria-label="Cooling protocol" className={cx(emergency && 'border-emergency-fill/50')}>
      <CardHeader
        icon={Snowflake}
        title="Cooling protocol"
        description={
          <>
            <strong className="font-semibold text-ink">Cool first, transport second.</strong> Tick each step as it is done; times use the
            simulated clock.
          </>
        }
        actions={
          <>
            <span className="text-xs font-medium text-muted tabular-nums">
              {doneCount}/{COOLING_PROTOCOL.length} done
            </span>
            <InfoTip
              label="Protocol sources"
              align="end"
              content="Built from ILCOR 2019 (whole-body neck-down immersion, water 1–26 °C), TB MED 507 2022 (do not delay cooling for want of a thermometer), IOC 2021 (ice-water towels every 1–2 min), OSHA and NATA (harm rises when cooling is delayed beyond 30 min)."
            />
          </>
        }
      />

      <div className="rounded-lg border border-line bg-canvas p-3">
        <div className="flex flex-wrap items-center gap-4">
          <CountdownRing
            size={104}
            remainingMin={cooledFor !== null ? Math.max(0, FIRST_AID.IMMERSION_STOP_WITHOUT_THERMOMETER_MIN - cooledFor) : null}
            totalMin={FIRST_AID.IMMERSION_STOP_WITHOUT_THERMOMETER_MIN}
            label="until the immersion check"
            format="minutes"
            caption={cooledFor !== null ? 'to check' : 'not started'}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            {cooledFor !== null && started !== null ? (
              <>
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Timer aria-hidden size={16} className="text-shade" />
                  <span>
                    Cooling for <span className="tabular-nums">{cooledFor} min</span> (since <span className="tabular-nums">{formatLocalHhmm(started)}</span>)
                  </span>
                </p>
                <p className="text-sm text-muted">
                  {cooledFor >= FIRST_AID.IMMERSION_STOP_WITHOUT_THERMOMETER_MIN
                    ? 'Without a thermometer: stop ice-water immersion now if the worker is alert and oriented, then keep dousing and fanning until the ambulance team takes over.'
                    : `Without a thermometer, stop ice-water immersion after about ${FIRST_AID.IMMERSION_STOP_WITHOUT_THERMOMETER_MIN} min or as soon as the worker is alert and oriented. Rotate ice-water towels every ${FIRST_AID.TOWEL_ROTATE_MIN_MIN}–${FIRST_AID.TOWEL_ROTATE_MAX_MIN} min.`}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">
                  Cooling not started · case open <span className="tabular-nums">{openFor} min</span>
                </p>
                <p className="text-sm text-muted">
                  {delayLeft > 0
                    ? `Start on site now: harm rises when cooling is delayed beyond ${FIRST_AID.COOLING_DELAY_LIMIT_MIN} min (${delayLeft} min left of that window).`
                    : `More than ${FIRST_AID.COOLING_DELAY_LIMIT_MIN} min since the case was raised: if the worker shows red-flag signs, start cooling now.`}
                </p>
                <Button size="sm" variant={emergency ? 'emergency' : 'secondary'} icon={Timer} onClick={() => updateCase(caseKey, () => ({ coolingStartT: now }))}>
                  Start cooling timer
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="mt-3 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-2 text-start text-sm font-semibold text-ink hover:text-shade"
      >
        <span>{open ? 'Protocol steps' : `Show the ${COOLING_PROTOCOL.length} protocol steps`}</span>
        <ChevronDown aria-hidden size={18} className={cx('transition-transform', open && 'rotate-180')} />
      </button>

      <ol id={bodyId} hidden={!open} className="mt-1 space-y-2">
        {COOLING_PROTOCOL.map((step) => {
          const doneAt = local.steps[step.id]
          const done = doneAt !== undefined
          const inputId = `${caseKey}-${step.id}`
          return (
            <li
              key={step.id}
              className={cx('flex items-start gap-3 rounded-lg border p-3 transition-colors', done ? 'border-safe-fill/40 bg-safe-bg/50' : 'border-line bg-surface')}
            >
              <input
                id={inputId}
                type="checkbox"
                checked={done}
                onChange={(e) => toggle(step.id, e.target.checked)}
                className="mt-0.5 size-5 shrink-0 cursor-pointer accent-shade"
              />
              <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-sm text-ink">
                  <span className="font-semibold tabular-nums">{step.order}.</span> {step.text}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {done ? <>Done at <span className="tabular-nums">{formatLocalHhmm(doneAt)}</span></> : 'Not done yet'}
                </span>
              </label>
              {step.id === 'call_998' && <Call998Link size="sm" variant={emergency ? 'emergency' : 'secondary'} className="shrink-0" />}
            </li>
          )
        })}
      </ol>
      <p className="mt-3 text-xs text-muted">
        If {UAE_EMERGENCY.AMBULANCE} does not connect, call {UAE_EMERGENCY.POLICE}. Fluids only if the worker is fully alert; never leave the worker
        alone.
      </p>
    </Card>
  )
}
