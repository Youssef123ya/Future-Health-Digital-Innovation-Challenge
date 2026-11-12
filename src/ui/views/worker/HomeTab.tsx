/**
 * Home screen of the worker phone: status strips, the level card with the top actions, the rest/work timer, water
 * logging, the check-in and buddy entry points, and (own screen only) the water balance and the strain indicator.
 * Every number is the engine's (WorkerStepDetail / RiskAssessment via state/hooks useWorkerDevice). Claims discipline:
 * the strain indicator is an estimate with its band, never a temperature reading or a diagnosis (ARCHITECTURE §1.8).
 */
import { useId, type ReactNode } from 'react'
import {
  Activity,
  Ambulance,
  CircleCheck,
  CloudOff,
  Droplets,
  FaceSlightlyFrowning,
  GlassWater,
  HardHat,
  HeartHandshake,
  Hourglass,
  Info,
  Phone,
  Siren,
  Snowflake,
  Sun,
  Umbrella,
  Volume2,
  Watch,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { ActionChip, CountdownRing, LevelCard, cx } from '../../components'
import { actionText, driverText, formatNumber, levelMeaning, levelName, t } from '../../../i18n'
import type { WorkerDeviceModel } from '../../../state'
import type { WorkerLocation } from '../../../engine/risk'
import type { ActionId } from '../../../engine/types'
import { DEFAULT_RULE_PACK } from '../../../engine/regulation'
import { formatLocalHhmm } from '../../../engine/time'
import { wt, type WorkerMessageKey } from './messages'
import {
  FALLBACK_KEYS,
  HOLDER_KEYS,
  actionParamsFor,
  drinkTotals,
  isUrgent,
  monitorState,
  strainGeometry,
  timerState,
  waterGauge,
  type TimerState,
} from './model'
import { TILE, bigButton, usePhone } from './ui'

const LOCATION: Readonly<Record<WorkerLocation, { key: WorkerMessageKey; icon: LucideIcon }>> = {
  sun: { key: 'loc_sun', icon: Sun },
  shade: { key: 'loc_shade', icon: Umbrella },
  indoor_cool: { key: 'loc_cool', icon: Snowflake },
}

const MIDDAY = DEFAULT_RULE_PACK.middayBreak ? { from: DEFAULT_RULE_PACK.middayBreak.startHhmm, to: DEFAULT_RULE_PACK.middayBreak.endHhmm } : null

export interface HomeTabProps {
  model: WorkerDeviceModel
  taskName: (taskId: string | null | undefined) => string | null
  onDrink: () => void
  drinkFeedbackMl: number | null
  onCheckin: () => void
  onBuddy: () => void
  onSos: () => void
  onAck: (alertId: string) => void
  onListen: () => void
  voiceMissing: boolean
}

export function HomeTab({ model, taskName, onDrink, drinkFeedbackMl, onCheckin, onBuddy, onSos, onAck, onListen, voiceMissing }: HomeTabProps) {
  const { lang } = usePhone()
  const a = model.assessment
  const d = model.detail
  const offline = model.site.network === 'offline' || a?.dataQuality.network === 'offline'
  const stale = a?.dataQuality.stale === true || model.site.env?.stale === true
  const monitor = monitorState(d?.environment)
  const loc = LOCATION[model.location]
  const LocIcon = loc.icon
  const currentTask = model.task?.name ?? null

  return (
    <div className="space-y-3 px-4 pt-1 pb-6">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 font-medium text-ink ring-1 ring-line">
          <LocIcon size={15} aria-hidden className="text-shade" />
          {wt(lang, loc.key)}
        </span>
        <span>{currentTask ? wt(lang, 'working', { task: currentTask }) : wt(lang, 'resting')}</span>
      </p>

      {offline && (
        <Strip icon={WifiOff} tone="dark">
          <strong className="font-semibold">{t(lang, 'ui.offline')}.</strong> {t(lang, 'ui.offline_note')}
        </Strip>
      )}
      {stale && !offline && (
        <Strip icon={CloudOff} tone="neutral">
          {wt(lang, 'stale')}
        </Strip>
      )}
      {monitor?.kind === 'on' && (
        <Strip icon={Watch} tone="brand">
          {wt(lang, 'monitored_on')}
        </Strip>
      )}
      {monitor?.kind === 'fallback' && (
        <Strip icon={Info} tone="neutral">
          <strong className="font-semibold">{wt(lang, 'monitored_off')}</strong> {wt(lang, FALLBACK_KEYS[monitor.reason])}
        </Strip>
      )}

      {model.alert && model.alert.status !== 'resolved' && <AlertStrip model={model} onAck={onAck} />}

      {a ? (
        <LevelBlock model={model} onCheckin={onCheckin} onBuddy={onBuddy} onSos={onSos} onListen={onListen} voiceMissing={voiceMissing} />
      ) : (
        <div className={cx(TILE, 'text-muted')}>{wt(lang, 'loading')}</div>
      )}

      {model.checkinDue && model.profile.consent.checkins && (
        <button type="button" onClick={onCheckin} className={bigButton('secondary', 'border-shade/40 bg-shade-bg')}>
          <FaceSlightlyFrowning size={26} aria-hidden className="shrink-0 text-shade" />
          <span className="min-w-0">
            <span className="block">{t(lang, 'ui.checkin')}</span>
            <span className="block text-sm font-normal text-muted">{actionText(lang, 'symptom_checkin')}</span>
          </span>
        </button>
      )}

      {a && <TimerCard state={timerState({ resume: d?.resume, workMinPerHour: a.workMinPerHour, level: a.level, now: model.t })} model={model} taskName={taskName} />}

      <WaterCard model={model} onDrink={onDrink} feedbackMl={drinkFeedbackMl} />

      <div className="grid grid-cols-2 gap-3">
        <TileButton icon={FaceSlightlyFrowning} label={t(lang, 'ui.feel_unwell')} onClick={onCheckin} />
        <TileButton icon={HeartHandshake} label={wt(lang, 'check_buddy')} onClick={onBuddy} />
      </div>

      {d?.water && <WaterBalanceCard model={model} />}
      {model.profile.consent.wearable && d?.physioDisplay && <StrainCard centreC={d.physioDisplay.centreC} halfWidthC={d.physioDisplay.halfWidthC} lowC={d.physioDisplay.lowC} highC={d.physioDisplay.highC} />}
    </div>
  )
}

// ─────────────────────────────── Strips ───────────────────────────────

function Strip({ icon: Icon, tone, children }: { icon: LucideIcon; tone: 'dark' | 'neutral' | 'brand'; children: ReactNode }) {
  return (
    <div
      role={tone === 'dark' ? 'status' : undefined}
      className={cx(
        'flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-sm leading-snug',
        tone === 'dark' && 'bg-ink text-white',
        tone === 'neutral' && 'bg-surface text-ink ring-1 ring-line',
        tone === 'brand' && 'bg-shade-bg text-ink ring-1 ring-shade/30',
      )}
    >
      <Icon size={18} aria-hidden className={cx('mt-0.5 shrink-0', tone === 'brand' && 'text-shade', tone === 'neutral' && 'text-muted')} />
      <p className="min-w-0">{children}</p>
    </div>
  )
}

function AlertStrip({ model, onAck }: { model: WorkerDeviceModel; onAck: (alertId: string) => void }) {
  const { lang } = usePhone()
  const alert = model.alert
  if (!alert) return null
  const iAcked = (alert.acks ?? []).some((x) => x.role === 'worker') || alert.ack?.role === 'worker'
  if (alert.status === 'escalated' || model.ackStatus === 'escalated') {
    return (
      <Strip icon={Ambulance} tone="dark">
        <strong className="font-semibold">{t(lang, 'ui.help_coming')}</strong>
      </Strip>
    )
  }
  if (iAcked) {
    return (
      <Strip icon={CircleCheck} tone="neutral">
        {wt(lang, 'confirmed')}
      </Strip>
    )
  }
  return (
    <button type="button" onClick={() => onAck(alert.id)} className={bigButton('primary')}>
      <CircleCheck size={24} aria-hidden className="shrink-0" />
      <span>{t(lang, 'ui.acknowledge')}</span>
    </button>
  )
}

// ─────────────────────────────── Level card ───────────────────────────────

function LevelBlock({
  model,
  onCheckin,
  onBuddy,
  onSos,
  onListen,
  voiceMissing,
}: {
  model: WorkerDeviceModel
  onCheckin: () => void
  onBuddy: () => void
  onSos: () => void
  onListen: () => void
  voiceMissing: boolean
}) {
  const { lang } = usePhone()
  const a = model.assessment
  if (!a) return null
  const level = a.level
  const urgent = isUrgent(level)
  const reasons = a.drivers.filter((x) => x.direction === 'raises').slice(0, 4)
  const top = (reasons[0] ?? a.drivers[0]) as (typeof a.drivers)[number] | undefined
  const restMin = model.detail?.resume?.held ? model.detail.resume.estRestMin : null
  const actions = a.actions.filter((x) => x !== 'call_998').slice(0, level === 'emergency' ? 2 : 3)
  const params = (x: ActionId) =>
    actionParamsFor(x, { workMinPerHour: a.workMinPerHour, waterMlPerHour: a.waterMlPerHour, drinkDue: model.detail?.drink.reminder === 'drink', restMin, midday: MIDDAY })

  return (
    <LevelCard level={level} label={levelName(lang, level)} headline={levelMeaning(lang, level)} reason={top ? driverText(lang, top.id, top.text) : undefined}>
      {level === 'emergency' && (
        <div className="mb-3 grid gap-2">
          <a href="tel:998" className={bigButton('bare', 'justify-center bg-white text-emergency hover:bg-white/90 focus-visible:outline-white')}>
            <Phone size={24} aria-hidden className="shrink-0" />
            <span>{actionText(lang, 'call_998')}</span>
          </a>
          <button type="button" onClick={onSos} className={bigButton('bare', 'justify-center bg-white/10 text-white ring-1 ring-white/60 hover:bg-white/20 focus-visible:outline-white')}>
            <Siren size={22} aria-hidden className="shrink-0" />
            <span>{t(lang, 'emergency.cool_first')}</span>
          </button>
        </div>
      )}
      <ul className="grid gap-2">
        {actions.map((x) => (
          <li key={x}>
            <ActionChip
              action={x}
              label={actionText(lang, x, params(x))}
              level={level}
              size="lg"
              className="w-full"
              onClick={x === 'symptom_checkin' ? onCheckin : x === 'buddy_check' ? onBuddy : undefined}
            />
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onListen}
          className={cx(
            'inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-base font-semibold transition-colors',
            urgent ? 'bg-white/15 text-white ring-1 ring-white/50 hover:bg-white/25 focus-visible:outline-white' : 'bg-surface text-ink ring-1 ring-line-strong hover:bg-canvas',
          )}
        >
          <Volume2 size={20} aria-hidden />
          {t(lang, 'ui.listen')}
        </button>
        {voiceMissing && (
          <span role="status" className={cx('text-sm', urgent ? 'text-white' : 'text-muted')}>
            {wt(lang, 'no_voice')}
          </span>
        )}
      </div>
      {reasons.length > 1 && (
        <details className="group mt-3">
          <summary className={cx('flex min-h-11 cursor-pointer list-none items-center gap-2 text-base font-semibold', urgent ? 'text-white' : 'text-ink')}>
            <Info size={18} aria-hidden />
            {wt(lang, 'why')}
          </summary>
          <ul className={cx('mt-1 list-disc space-y-1 ps-6 text-sm leading-snug', urgent ? 'text-white' : 'text-muted')}>
            {reasons.map((r) => (
              <li key={r.id}>{driverText(lang, r.id, r.text)}</li>
            ))}
          </ul>
        </details>
      )}
    </LevelCard>
  )
}

// ─────────────────────────────── Timer ───────────────────────────────

function TimerCard({ state, model, taskName }: { state: TimerState; model: WorkerDeviceModel; taskName: (id: string | null | undefined) => string | null }) {
  const { lang } = usePhone()
  const headingId = useId()
  const level = model.assessment?.level
  if (state.kind === 'none') return null

  const minText = (m: number) => wt(lang, 'min_short', { min: Math.max(0, Math.ceil(m)) })

  if (state.kind === 'cycle' || state.kind === 'cycle_free' || state.kind === 'cycle_none') {
    return (
      <section aria-labelledby={headingId} className={TILE}>
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-muted">
          <Hourglass size={16} aria-hidden />
          {wt(lang, 'each_hour')}
        </h3>
        {state.kind === 'cycle' ? (
          <>
            <p className="mt-1 text-xl font-bold text-ink">{actionText(lang, 'shade_breaks', { work: state.workMin, rest: state.restMin })}</p>
            <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden>
              <div className="h-full rounded-s-full bg-sun/80" style={{ width: `${(state.workMin / 60) * 100}%` }} />
              <div className="h-full flex-1 rounded-e-full bg-shade" />
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                <Sun size={13} aria-hidden /> {minText(state.workMin)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Umbrella size={13} aria-hidden /> {minText(state.restMin)}
              </span>
            </div>
          </>
        ) : (
          <p className="mt-1 text-lg font-semibold text-ink">{wt(lang, state.kind === 'cycle_free' ? 'cycle_free' : 'cycle_none')}</p>
        )}
      </section>
    )
  }

  if (state.kind === 'bout') {
    const sentence = wt(lang, 'bout_left', { min: state.remainingMin })
    return (
      <section aria-labelledby={headingId} className={cx(TILE, 'flex items-center gap-4')}>
        <CountdownRing remainingMin={state.remainingMin} totalMin={state.totalMin} label={wt(lang, 'ring_work')} level={level} size={112} formatTime={minText} caption={wt(lang, 'ring_work')} ariaLabel={sentence} />
        <h3 id={headingId} className="min-w-0 text-lg leading-snug font-semibold text-ink">
          {sentence}
        </h3>
      </section>
    )
  }

  const task = taskName(state.taskId)
  const reasons = (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{wt(lang, 'why_rest')}</p>
      <ul className="mt-1 space-y-1 text-sm text-ink">
        {state.heldBy.map((h) => (
          <li key={h} className="flex items-start gap-2">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-shade" />
            {wt(lang, HOLDER_KEYS[h])}
          </li>
        ))}
      </ul>
    </div>
  )

  if (state.kind === 'rest_infeasible' || state.kind === 'rest_no_return') {
    return (
      <section aria-labelledby={headingId} className={TILE}>
        <div className="flex items-start gap-3">
          <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-shade-bg text-shade">
            <HardHat size={24} />
          </span>
          <h3 id={headingId} className="min-w-0 text-lg leading-snug font-semibold text-ink">
            {wt(lang, state.kind === 'rest_infeasible' ? 'infeasible' : 'no_return')}
          </h3>
        </div>
        {state.heldBy.length > 0 && reasons}
      </section>
    )
  }

  // state.kind === 'rest'
  const sentence =
    state.source === 'estimate'
      ? task
        ? wt(lang, 'rest_more_task', { min: state.remainingMin, task })
        : wt(lang, 'rest_more', { min: state.remainingMin })
      : state.nextCheckT !== null
        ? wt(lang, 'next_check', { time: formatLocalHhmm(state.nextCheckT) })
        : t(lang, 'ui.break_now')
  return (
    <section aria-labelledby={headingId} className={TILE}>
      <div className="flex items-center gap-4">
        <CountdownRing
          remainingMin={state.remainingMin}
          totalMin={state.totalMin}
          label={wt(lang, state.source === 'estimate' ? 'ring_rest' : 'ring_check')}
          level={level}
          size={112}
          formatTime={minText}
          caption={wt(lang, state.source === 'estimate' ? 'ring_rest' : 'ring_check')}
          ariaLabel={sentence}
        />
        <div className="min-w-0">
          <h3 id={headingId} className="text-lg leading-snug font-semibold text-ink">
            {sentence}
          </h3>
          {state.source === 'estimate' && state.nextCheckT !== null && (
            <p className="mt-1 text-sm text-muted">{wt(lang, 'next_check', { time: formatLocalHhmm(state.nextCheckT) })}</p>
          )}
        </div>
      </div>
      {state.heldBy.length > 0 && reasons}
    </section>
  )
}

// ─────────────────────────────── Water ───────────────────────────────

function WaterCard({ model, onDrink, feedbackMl }: { model: WorkerDeviceModel; onDrink: () => void; feedbackMl: number | null }) {
  const { lang } = usePhone()
  const totals = drinkTotals(model.device.intakes, model.workerId, model.t)
  const drink = model.detail?.drink
  const fmtL = (ml: number) => formatNumber(lang, ml / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const due = drink?.reminder === 'drink'
  const next = drink && drink.nextReminderAtMs !== null && drink.nextReminderAtMs > model.t ? drink.nextReminderAtMs : null
  return (
    <section aria-label={t(lang, 'ui.drank_water')} className={cx(TILE, due && 'ring-2 ring-shade')}>
      <button type="button" onClick={onDrink} className={bigButton('primary')}>
        <GlassWater size={28} aria-hidden className="shrink-0" />
        <span className="min-w-0">
          <span className="block">{t(lang, 'ui.drank_water')}</span>
          <span className="block text-sm font-normal text-white/90">{wt(lang, 'drink_sub')}</span>
        </span>
      </button>
      <p aria-live="polite" className="min-h-0 text-sm font-semibold text-shade-dark">
        {feedbackMl !== null && <span className="mt-2 flex items-center gap-1.5"><CircleCheck size={16} aria-hidden />{wt(lang, 'drink_logged', { ml: feedbackMl })}</span>}
      </p>
      {totals.overHourly ? (
        <p className="mt-2 rounded-lg bg-caution-bg px-3 py-2 text-sm font-semibold text-caution">{t(lang, 'ui.slow_down_drinking')}</p>
      ) : due ? (
        <p className="mt-2 text-base font-semibold text-ink">{actionText(lang, 'drink_water', { ml: 250 })}</p>
      ) : drink?.reminder === 'shade' ? (
        <p className="mt-2 text-sm text-ink">{wt(lang, 'shade_instead')}</p>
      ) : null}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-ink tabular-nums">{wt(lang, 'today_total', { today: fmtL(totals.todayMl), cap: fmtL(totals.dailyCapMl) })}</span>
          {next !== null && <span className="text-muted tabular-nums">{wt(lang, 'next_drink', { time: formatLocalHhmm(next) })}</span>}
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-shade-tint" aria-hidden>
          <div className="h-full rounded-full bg-shade" style={{ width: `${Math.min(100, (totals.todayMl / totals.dailyCapMl) * 100)}%` }} />
        </div>
      </div>
    </section>
  )
}

function TileButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-3 py-3 text-center text-base leading-snug font-semibold text-ink shadow-xs transition-colors hover:bg-canvas active:bg-slate-100"
    >
      <span aria-hidden className="grid size-12 place-items-center rounded-full bg-shade-bg text-shade">
        <Icon size={26} />
      </span>
      {label}
    </button>
  )
}

/** Water balance behind the ISO 7933 water-loss limit: sweat vs credited drinks vs the applied limit (own phone only). */
function WaterBalanceCard({ model }: { model: WorkerDeviceModel }) {
  const { lang } = usePhone()
  const headingId = useId()
  const w = model.detail?.water
  if (!w) return null
  const g = waterGauge(w, model.profile.massKg)
  const L = (x: number) => formatNumber(lang, x, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const summary = `${wt(lang, 'sweat_lost')} ${L(g.sweatL)} L · ${wt(lang, 'drinks_counted')} ${L(g.creditL)} L · ${wt(lang, 'limit_now')} ${L(g.thresholdL)} L`
  return (
    <section aria-labelledby={headingId} className={TILE}>
      <h3 id={headingId} className="flex items-center gap-2 text-base font-semibold text-ink">
        <Droplets size={18} aria-hidden className="text-shade" />
        {wt(lang, 'water_title')}
      </h3>
      <div role="img" aria-label={summary} className="mt-3 space-y-3">
        <MeterRow label={wt(lang, 'sweat_lost')} value={`${L(g.sweatL)} L`} frac={g.sweatFrac} markerFrac={g.thresholdFrac} />
        <MeterRow label={wt(lang, 'drinks_counted')} value={`${L(g.creditL)} L`} frac={g.creditFrac} />
      </div>
      <dl className="mt-3 grid gap-1 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="flex items-center gap-2 text-muted">
            <span aria-hidden className="h-4 w-0.5 rounded-full bg-ink" />
            {wt(lang, 'limit_now')}
          </dt>
          <dd className="font-semibold text-ink tabular-nums">{L(g.thresholdL)} L</dd>
        </div>
        {g.ceilingL !== null && !w.restricted && <dd className="text-xs text-muted">{wt(lang, 'limit_max', { l: L(g.ceilingL) })}</dd>}
      </dl>
      {(w.extended || w.capped || w.restricted) && (
        <ul className="mt-3 space-y-1.5 text-sm text-ink">
          {w.extended && !w.restricted && (
            <li className="flex items-start gap-2">
              <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-shade" />
              <span>
                {wt(lang, 'water_extended')} {actionText(lang, 'electrolytes')}.
              </span>
            </li>
          )}
          {w.capped && !w.restricted && (
            <li className="flex items-start gap-2">
              <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-shade" />
              <span>{wt(lang, 'water_capped')}</span>
            </li>
          )}
          {w.restricted && (
            <li className="flex items-start gap-2">
              <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-shade" />
              <span>{wt(lang, 'water_restricted')}</span>
            </li>
          )}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        {wt(lang, 'water_note')} {t(lang, 'ui.not_medical')}
      </p>
    </section>
  )
}

function MeterRow({ label, value, frac, markerFrac }: { label: string; value: string; frac: number; markerFrac?: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-semibold text-ink tabular-nums">{value}</span>
      </div>
      <div className="relative mt-1 h-3">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-shade-tint">
          <div className="h-full rounded-full bg-shade" style={{ width: `${frac * 100}%` }} />
        </div>
        {markerFrac !== undefined && (
          <span aria-hidden className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-ink rtl:translate-x-1/2" style={{ insetInlineStart: `${markerFrac * 100}%` }} />
        )}
      </div>
    </div>
  )
}

/** ECTemp display band: an estimated strain indicator with its uncertainty (physio.ts ectempDisplayBand). */
function StrainCard({ centreC, halfWidthC, lowC, highC }: { centreC: number; halfWidthC: number; lowC: number; highC: number }) {
  const { lang } = usePhone()
  const headingId = useId()
  const g = strainGeometry({ lowC, highC, centreC })
  const n1 = (x: number) => formatNumber(lang, x, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const value = `≈ ${n1(centreC)} ± ${n1(halfWidthC)}`
  return (
    <section aria-labelledby={headingId} className={TILE}>
      <h3 id={headingId} className="flex items-center gap-2 text-base font-semibold text-ink">
        <Activity size={18} aria-hidden className="text-shade" />
        {t(lang, 'ui.strain_estimate')}
      </h3>
      <p className="mt-1 text-3xl font-bold text-ink" dir="ltr">
        {value}
      </p>
      <div className="relative mt-3 h-3 rounded-full bg-shade-tint" role="img" aria-label={`${t(lang, 'ui.strain_estimate')} ${value}`}>
        <div className="absolute inset-y-0 rounded-full bg-shade/35" style={{ insetInlineStart: `${g.lowFrac * 100}%`, width: `${(g.highFrac - g.lowFrac) * 100}%` }} />
        <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-shade ring-2 ring-surface rtl:translate-x-1/2" style={{ insetInlineStart: `${g.centreFrac * 100}%` }} />
      </div>
      <p className="mt-3 text-sm text-muted">{t(lang, 'ui.not_medical')}</p>
    </section>
  )
}
