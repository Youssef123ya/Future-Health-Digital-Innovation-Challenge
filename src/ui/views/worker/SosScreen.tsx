/**
 * Full-screen emergency help on the worker phone (SOS). Three things, in the order a frightened person needs them:
 * call 998; tell the crew who needs help and what you see (a check-in with the red-flag signs, so the device raises the
 * emergency, pages the first aider and alerts the supervisor in the same minute); and the cooling steps in the
 * phone's language ("cool first, transport second", stay with them). Basis: engine/clinical.ts UAE_EMERGENCY and the
 * T3 emergency script (i18n EMERGENCY_SCRIPT, physio_and_clinical.md §10.10); ARCHITECTURE §9 `#/worker/:id` SOS.
 */
import { useState } from 'react'
import { Check, CircleCheck, Phone, Send, UserRound, UsersRound } from 'lucide-react'
import type { Checkin, SymptomId } from '../../../engine/types'
import { formatLocalHhmm } from '../../../engine/time'
import { actionText, emergencySteps, t } from '../../../i18n'
import { cx } from '../../components'
import { wt } from './messages'
import { SOS_SIGNS } from './model'
import { PhoneDialog, SYMPTOM_ICONS, TILE, bigButton, usePhone } from './ui'

export interface SosPartner {
  workerId: string
  name: string
}

export interface SosScreenProps {
  /** The phone owner. */
  workerId: string
  /** Partners this worker is the buddy of (from the buddy projection: name only). */
  partners: readonly SosPartner[]
  now: number
  onSend: (checkin: Checkin) => void
  onClose: () => void
}

let seq = 0

export function SosScreen({ workerId, partners, now, onSend, onClose }: SosScreenProps) {
  const { lang } = usePhone()
  const [subject, setSubject] = useState<string>(workerId)
  const [signs, setSigns] = useState<ReadonlySet<number>>(new Set())
  const [sentAt, setSentAt] = useState<number | null>(null)
  const steps = emergencySteps(lang)
  const [stepsTitle, ...stepLines] = steps

  const toggle = (i: number): void =>
    setSigns((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const send = (): void => {
    const symptoms = [...new Set([...signs].flatMap((i) => SOS_SIGNS[i]?.symptoms ?? []))] as SymptomId[]
    if (symptoms.length === 0) return
    const self = subject === workerId
    onSend({ id: `sos:${subject}:${now}:${(seq++).toString(36)}`, t: now, workerId: subject, by: self ? 'self' : 'buddy', symptoms })
    setSentAt(now)
  }

  const people: { id: string; label: string; icon: typeof UserRound }[] = [
    { id: workerId, label: wt(lang, 'sos_me'), icon: UserRound },
    ...partners.map((p) => ({ id: p.workerId, label: p.name, icon: UsersRound })),
  ]

  return (
    <PhoneDialog title={wt(lang, 'sos_label')} onClose={onClose} closeLabel={wt(lang, 'close')} tone="emergency">
      <div className="space-y-4">
        <a href="tel:998" className={bigButton('emergency', 'min-h-20 justify-center text-2xl')}>
          <Phone size={30} aria-hidden className="shrink-0" />
          {actionText(lang, 'call_998')}
        </a>

        <section className={TILE} aria-labelledby="sos-who">
          <h3 id="sos-who" className="text-lg font-bold text-ink">
            {wt(lang, 'sos_who')}
          </h3>
          <div role="radiogroup" aria-labelledby="sos-who" className="mt-3 grid grid-cols-2 gap-2">
            {people.map((p) => {
              const on = subject === p.id
              const Icon = p.icon
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={sentAt !== null}
                  onClick={() => setSubject(p.id)}
                  className={cx(
                    'flex min-h-14 items-center gap-2 rounded-xl border-2 px-3 text-start text-base font-semibold transition-colors',
                    on ? 'border-emergency-fill bg-emergency-bg text-emergency' : 'border-line-strong bg-surface text-ink hover:bg-canvas',
                  )}
                >
                  <Icon size={20} aria-hidden className="shrink-0" />
                  <bdi className="min-w-0 truncate">{p.label}</bdi>
                  {on && <Check size={18} aria-hidden className="ms-auto shrink-0" />}
                </button>
              )
            })}
          </div>

          <h3 id="sos-what" className="mt-4 text-lg font-bold text-ink">
            {wt(lang, 'sos_what')}
          </h3>
          <ul aria-labelledby="sos-what" className="mt-3 grid gap-2">
            {SOS_SIGNS.map((s, i) => {
              const on = signs.has(i)
              const Icon = SYMPTOM_ICONS[s.symptoms[0] as SymptomId]
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={sentAt !== null}
                    onClick={() => toggle(i)}
                    className={cx(
                      'flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3 text-start text-base font-semibold transition-colors disabled:opacity-70',
                      on ? 'border-emergency-fill bg-emergency-bg text-emergency' : 'border-line bg-surface text-ink hover:bg-canvas',
                    )}
                  >
                    <span aria-hidden className={cx('grid size-9 shrink-0 place-items-center rounded-full', on ? 'bg-emergency-fill text-white' : 'bg-canvas text-muted')}>
                      {on ? <Check size={18} /> : <Icon size={18} />}
                    </span>
                    {wt(lang, s.key)}
                  </button>
                </li>
              )
            })}
          </ul>

          {sentAt === null ? (
            <button type="button" onClick={send} disabled={signs.size === 0} className={bigButton('emergency', 'mt-4')}>
              <Send size={22} aria-hidden className="shrink-0" />
              {wt(lang, 'sos_send')}
            </button>
          ) : (
            <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-safe-bg px-3 py-3 text-base font-semibold text-safe">
              <CircleCheck size={22} aria-hidden className="shrink-0" />
              {wt(lang, 'sos_sent', { time: formatLocalHhmm(sentAt) })} {t(lang, 'ui.help_coming')}
            </p>
          )}
        </section>

        <section className={TILE} aria-labelledby="sos-steps">
          <h3 id="sos-steps" className="text-lg font-bold text-emergency">
            {stepsTitle}
          </h3>
          <ol className="mt-3 space-y-2.5">
            {stepLines.map((line, i) => (
              <li key={i} className="flex items-start gap-3 text-base leading-snug text-ink">
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-emergency-bg text-sm font-bold text-emergency">
                  {i + 1}
                </span>
                <span className="min-w-0 pt-0.5">{line}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </PhoneDialog>
  )
}
