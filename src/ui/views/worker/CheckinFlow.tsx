/**
 * The yes/no check-in on the worker phone, in two versions: the worker about themself ("I feel unwell") and a buddy
 * about their partner ("Check my buddy"). One question per screen with a pictogram, big YES / NO buttons (>= 56 px for
 * gloved hands), progress, Back. The most serious questions come first and a red-flag YES ends the questions at once
 * (model.ts SELF_QUESTIONS / BUDDY_QUESTIONS, nextQuestion). A follow-up within the hour starts with the trend question.
 *
 * The advice screen is the device engine's own triage of the answers (engine/clinical.ts `triage`, the function the
 * phone runs anyway), shown at once; the check-in is then handed to the simulated device (`{ kind: 'checkin' }`), which
 * raises the level, the alerts and the first-aid case in the same minute. Claims discipline: first-aid tiers from
 * reported signs, never a diagnosis.
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, CircleCheck, Phone, ShieldCheck, Siren, ThumbsDown, ThumbsUp, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import type { Checkin, RiskFlagId, SymptomId } from '../../../engine/types'
import { triage, type TriageResult } from '../../../engine/clinical'
import { actionText, levelMeaning, levelName, symptomQuestion, t } from '../../../i18n'
import { ActionChip, LevelPill, cx } from '../../components'
import { wt } from './messages'
import {
  BUDDY_QUESTIONS,
  SELF_QUESTIONS,
  URINE_SWATCHES,
  isRedFlag,
  nextQuestion,
  questionProgress,
  urineAdvice,
  yesSymptoms,
  type Answers,
} from './model'
import { MIRROR, PhoneDialog, ProgressBar, SYMPTOM_ICONS, TILE, bigButton, usePhone } from './ui'

type Trend = NonNullable<Checkin['trend']>
type UrineColor = NonNullable<Checkin['urineColor']>

export interface CheckinFlowProps {
  who: 'self' | 'buddy'
  /** The worker the answers are about (the phone owner, or the partner for a buddy check). */
  subjectId: string
  /** Partner's display name (buddy version). */
  subjectName?: string
  /** Simulated time now (epoch ms). */
  now: number
  /** Earlier check-ins on this device (own phone only; a buddy never sees the partner's history). */
  history: readonly Checkin[]
  /** Open symptomatic check-in in the last hour: this one is its follow-up (asks the trend question first). */
  followUpOf: Checkin | null
  /** Consent to use check-in answers (own phone); a buddy check is an in-person safety check and always allowed. */
  checkinsAllowed: boolean
  /** Consented risk flags for the triage context (own phone only). */
  riskFlags?: readonly RiskFlagId[]
  overFluidCap?: boolean
  onSubmit: (checkin: Checkin) => void
  onTurnOnCheckins?: () => void
  onSos: () => void
  onClose: () => void
}

type Step = { kind: 'off' } | { kind: 'trend' } | { kind: 'question' } | { kind: 'urine' } | { kind: 'result'; checkin: Checkin; result: TriageResult }

let seq = 0
const checkinId = (workerId: string, t: number): string => `ci:${workerId}:${t}:${(seq++).toString(36)}`

export function CheckinFlow(props: CheckinFlowProps) {
  const { lang } = usePhone()
  const { who, subjectId, subjectName, now, history, followUpOf, checkinsAllowed } = props
  const order = who === 'self' ? SELF_QUESTIONS : BUDDY_QUESTIONS
  const [answers, setAnswers] = useState<Answers>({})
  const [answered, setAnswered] = useState<SymptomId[]>([])
  const [trend, setTrend] = useState<Trend | null>(null)
  const [step, setStep] = useState<Step>(() =>
    who === 'self' && !checkinsAllowed ? { kind: 'off' } : who === 'self' && followUpOf ? { kind: 'trend' } : { kind: 'question' },
  )

  const current = step.kind === 'question' ? nextQuestion(order, answers) : null
  const progress = questionProgress(order, answers)

  /** Builds the check-in from the final answers, runs the device triage, hands it to the device and shows the advice. */
  const finish = (final: Answers, urine: UrineColor | null): void => {
    const checkin: Checkin = {
      id: checkinId(subjectId, now),
      t: now,
      workerId: subjectId,
      by: who,
      symptoms: yesSymptoms(order, final),
      ...(urine !== null ? { urineColor: urine } : {}),
      ...(followUpOf?.id && who === 'self' ? { followUpOf: followUpOf.id } : {}),
      ...(trend && who === 'self' ? { trend } : {}),
    }
    const result = triage(checkin, who === 'self' ? history : [], {
      ...(props.riskFlags ? { riskFlags: props.riskFlags } : {}),
      ...(props.overFluidCap ? { overFluidCap: true } : {}),
    })
    props.onSubmit(checkin)
    setStep({ kind: 'result', checkin, result })
  }

  const answer = (s: SymptomId, yes: boolean): void => {
    const nextAnswers = { ...answers, [s]: yes }
    setAnswers(nextAnswers)
    setAnswered((a) => [...a, s])
    if (nextQuestion(order, nextAnswers) !== null) return
    // Questions done. A red flag (or the buddy version) acts now; the worker's own check-in ends with the urine shade.
    if (who === 'self' && !(yes && isRedFlag(s))) setStep({ kind: 'urine' })
    else finish(nextAnswers, null)
  }

  const back = (): void => {
    if (step.kind === 'urine') {
      const last = answered[answered.length - 1]
      if (last) undo(last)
      setStep({ kind: 'question' })
      return
    }
    const last = answered[answered.length - 1]
    if (last) undo(last)
    else if (followUpOf && who === 'self') setStep({ kind: 'trend' })
  }
  const undo = (s: SymptomId): void => {
    setAnswered((a) => a.slice(0, -1))
    setAnswers((prev) => {
      const next = { ...prev }
      delete next[s]
      return next
    })
  }

  const title = who === 'self' ? t(lang, 'ui.checkin') : subjectName ? wt(lang, 'check_name', { name: subjectName }) : wt(lang, 'check_buddy')
  const showProgress = step.kind === 'question' || step.kind === 'urine'
  const progressValue = step.kind === 'urine' ? 1 : progress.total > 0 ? (progress.n - 1) / progress.total : 0

  return (
    <PhoneDialog
      title={title}
      onClose={props.onClose}
      closeLabel={wt(lang, 'close')}
      tone={step.kind === 'result' && step.result.tier === 3 ? 'emergency' : 'plain'}
      headerExtra={
        showProgress ? (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between text-sm text-muted">
              <span>{step.kind === 'question' ? wt(lang, 'progress', { n: progress.n, total: progress.total }) : t(lang, 'urine.question')}</span>
            </div>
            <ProgressBar value={progressValue} label={wt(lang, 'progress', { n: progress.n, total: progress.total })} />
          </div>
        ) : undefined
      }
    >
      {step.kind === 'off' && <ConsentOff onTurnOn={props.onTurnOnCheckins} onSos={props.onSos} onClose={props.onClose} />}

      {step.kind === 'trend' && (
        <div className="space-y-4">
          <p className="text-xl leading-snug font-bold text-ink">{t(lang, 'checkin.trend_question')}</p>
          <div className="grid gap-3">
            {(
              [
                ['better', TrendingUp],
                ['same', Minus],
                ['worse', TrendingDown],
              ] as const
            ).map(([k, Icon]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setTrend(k)
                  setStep({ kind: 'question' })
                }}
                className={bigButton(k === 'worse' ? 'danger' : 'secondary', 'min-h-16 justify-center text-xl')}
              >
                <Icon size={26} aria-hidden className="shrink-0" />
                {t(lang, `checkin.${k}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {step.kind === 'question' && current && (
        <Question
          key={current}
          symptom={current}
          who={who}
          intro={answered.length === 0 && !followUpOf ? t(lang, who === 'self' ? 'checkin.self_intro' : 'checkin.buddy_intro') : null}
          onAnswer={(yes) => answer(current, yes)}
          onBack={answered.length > 0 || (followUpOf && who === 'self') ? back : undefined}
        />
      )}

      {step.kind === 'urine' && <UrineStep onPick={(c) => finish(answers, c)} onSkip={() => finish(answers, null)} onBack={back} />}

      {step.kind === 'result' && <Result who={who} checkin={step.checkin} result={step.result} onSos={props.onSos} onClose={props.onClose} />}
    </PhoneDialog>
  )
}

function ConsentOff({ onTurnOn, onSos, onClose }: { onTurnOn?: () => void; onSos: () => void; onClose: () => void }) {
  const { lang } = usePhone()
  return (
    <div className="space-y-4">
      <div className={cx(TILE, 'flex items-start gap-3')}>
        <ShieldCheck size={26} aria-hidden className="mt-0.5 shrink-0 text-shade" />
        <p className="text-base leading-snug text-ink">{wt(lang, 'checkins_off')}</p>
      </div>
      {onTurnOn && (
        <button type="button" onClick={onTurnOn} className={bigButton('primary')}>
          <CircleCheck size={24} aria-hidden className="shrink-0" />
          {wt(lang, 'turn_on')}
        </button>
      )}
      <p className="text-base leading-snug text-ink">{wt(lang, 'checkins_off_help')}</p>
      <button type="button" onClick={onSos} className={bigButton('danger')}>
        <Siren size={24} aria-hidden className="shrink-0" />
        {wt(lang, 'sos_label')}
      </button>
      <button type="button" onClick={onClose} className={bigButton('secondary', 'justify-center')}>
        {wt(lang, 'close')}
      </button>
    </div>
  )
}

function Question({
  symptom,
  who,
  intro,
  onAnswer,
  onBack,
}: {
  symptom: SymptomId
  who: 'self' | 'buddy'
  intro: string | null
  onAnswer: (yes: boolean) => void
  onBack?: () => void
}) {
  const { lang } = usePhone()
  const Icon = SYMPTOM_ICONS[symptom]
  const red = isRedFlag(symptom)
  return (
    <div className="flex min-h-full flex-col gap-5">
      {intro && <p className="rounded-xl bg-shade-bg px-3 py-2 text-base text-ink ring-1 ring-shade/25">{intro}</p>}
      <div className="flex flex-col items-center gap-4 pt-2 text-center">
        <span aria-hidden className={cx('grid size-24 place-items-center rounded-full', red ? 'bg-stop-bg text-stop' : 'bg-shade-bg text-shade')}>
          <Icon size={48} strokeWidth={1.75} />
        </span>
        <p className="text-2xl leading-snug font-bold text-ink">{symptomQuestion(lang, symptom, who)}</p>
      </div>
      <div className="mt-auto grid grid-cols-2 gap-3">
        <button type="button" onClick={() => onAnswer(true)} className={bigButton('bare', 'min-h-20 flex-col justify-center gap-1 bg-ink text-center text-2xl text-white hover:bg-ink/90')}>
          <ThumbsUp size={28} aria-hidden />
          {t(lang, 'ui.yes')}
        </button>
        <button type="button" onClick={() => onAnswer(false)} className={bigButton('secondary', 'min-h-20 flex-col justify-center gap-1 text-center text-2xl')}>
          <ThumbsDown size={28} aria-hidden />
          {t(lang, 'ui.no')}
        </button>
      </div>
      {onBack && (
        <button type="button" onClick={onBack} className="inline-flex min-h-12 items-center gap-2 self-start rounded-full px-3 text-base font-semibold text-muted hover:bg-surface hover:text-ink">
          <ArrowLeft size={20} aria-hidden className={MIRROR} />
          {wt(lang, 'back')}
        </button>
      )}
    </div>
  )
}

function UrineStep({ onPick, onSkip, onBack }: { onPick: (c: UrineColor) => void; onSkip: () => void; onBack: () => void }) {
  const { lang } = usePhone()
  return (
    <div className="space-y-4">
      <p className="text-xl leading-snug font-bold text-ink">{t(lang, 'urine.question')}</p>
      <div className="grid grid-cols-4 gap-2.5" role="group" aria-label={t(lang, 'urine.question')}>
        {URINE_SWATCHES.map((hex, i) => {
          const color = (i + 1) as UrineColor
          return (
            <button
              key={hex}
              type="button"
              onClick={() => onPick(color)}
              aria-label={`${i + 1} / 8`}
              className="flex aspect-square flex-col items-center justify-end rounded-2xl border border-line-strong pb-1.5 text-sm font-bold text-ink shadow-xs transition-transform hover:scale-[1.03] focus-visible:scale-[1.03]"
              style={{ background: hex, color: i >= 5 ? '#fff' : undefined }}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted">{t(lang, 'ui.not_medical')}</p>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex min-h-12 items-center gap-2 rounded-full px-3 text-base font-semibold text-muted hover:bg-surface hover:text-ink">
          <ArrowLeft size={20} aria-hidden className={MIRROR} />
          {wt(lang, 'back')}
        </button>
        <button type="button" onClick={onSkip} className="inline-flex min-h-12 items-center rounded-full px-4 text-base font-semibold text-shade-dark ring-1 ring-shade/40 hover:bg-shade-bg">
          {wt(lang, 'skip')}
        </button>
      </div>
    </div>
  )
}

function Result({ who, checkin, result, onSos, onClose }: { who: 'self' | 'buddy'; checkin: Checkin; result: TriageResult; onSos: () => void; onClose: () => void }) {
  const { lang } = usePhone()
  const actions = useMemo(() => result.actions.filter((a) => a !== 'call_998').slice(0, 5), [result.actions])
  const urine = checkin.urineColor !== undefined ? urineAdvice(checkin.urineColor) : null
  const emergency = result.tier === 3
  return (
    <div className="space-y-4">
      {emergency && (
        <div className="space-y-2">
          <a href="tel:998" className={bigButton('emergency', 'min-h-16 justify-center text-xl')}>
            <Phone size={26} aria-hidden className="shrink-0" />
            {actionText(lang, 'call_998')}
          </a>
          <button type="button" onClick={onSos} className={bigButton('secondary', 'justify-center')}>
            <Siren size={22} aria-hidden className="shrink-0 text-emergency" />
            {t(lang, 'emergency.cool_first')}
          </button>
        </div>
      )}
      <section className={TILE} aria-live={emergency ? 'assertive' : 'polite'}>
        <p className="text-sm font-semibold tracking-wide text-muted uppercase">{wt(lang, 'advice')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <LevelPill level={result.level} label={levelName(lang, result.level)} size="lg" />
        </div>
        <p className="mt-2 text-lg leading-snug font-semibold text-ink">{levelMeaning(lang, result.level)}</p>
        {actions.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {actions.map((a) => (
              <li key={a}>
                <ActionChip action={a} label={actionText(lang, a)} level={result.level} size="lg" className="w-full" />
              </li>
            ))}
          </ul>
        )}
        {urine && (
          <p className="mt-3 rounded-xl bg-canvas px-3 py-2 text-base text-ink ring-1 ring-line">{t(lang, `urine.${urine}`)}</p>
        )}
        {result.recheckAtMin !== null && who === 'self' && <p className="mt-3 text-base text-ink">{wt(lang, 'recheck', { min: result.recheckAtMin })}</p>}
        <p className="mt-3 text-sm text-muted">
          {who === 'self' ? wt(lang, 'saved') : wt(lang, 'confirmed')} {t(lang, 'ui.not_medical')}
        </p>
      </section>
      <button type="button" onClick={onClose} className={bigButton('primary', 'justify-center')}>
        <CircleCheck size={22} aria-hidden className="shrink-0" />
        {wt(lang, 'done')}
      </button>
    </div>
  )
}
