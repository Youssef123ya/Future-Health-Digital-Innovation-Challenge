/**
 * Worker phone (#/worker/:id) — the heart of the worker-first design: one level, one action, in the worker's own
 * language, with everything personal kept on the phone. Composition of the phone screens:
 * - header: who, last update, language, and an SOS button that is always one tap away;
 * - Home (HomeTab): level card with the top actions and read-aloud, rest/work timer, water, check-in, buddy;
 * - Buddy: who looks after me, partners I look after (buddy projection only);
 * - Privacy: what leaves the phone (exact payload), consent choices, who saw my data, settings;
 * - full-screen flows: the yes/no check-in (self or buddy) with the device triage advice, and SOS.
 *
 * Data: only `useWorkerDevice` (the worker's own device model) and `useBuddyCards` through it; user actions go to the
 * simulated device as injections on the simulated clock. The phone's language is its own (phonePrefs.ts), so in the
 * #/demo split view the phone can speak Nepali while the console stays in English. Basis: ARCHITECTURE §1, §2, §9.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Globe, HeartHandshake, House, ShieldCheck, Siren, Smartphone } from 'lucide-react'
import type { Checkin, LangCode, RiskLevel } from '../../../engine/types'
import { formatLocalHhmm } from '../../../engine/time'
import { LANGUAGES, LANG_CODES, actionText, levelMeaning, levelName, t } from '../../../i18n'
import { vibrate } from '../../../i18n/speech'
import { governanceStore, simStore, uiStore, type WorkerDeviceModel } from '../../../state'
import { useSim, useUi, useWorkerDevice } from '../../../state/hooks'
import type { ViewProps } from '../../App'
import { pathFor, toHref } from '../../router'
import { cx } from '../../components'
import { BuddyTab, type BuddyPartner } from './BuddyTab'
import { CheckinFlow } from './CheckinFlow'
import { HomeTab } from './HomeTab'
import { PrivacyTab } from './PrivacyTab'
import { SosScreen } from './SosScreen'
import { wt } from './messages'
import { DEMO_ALIAS, DRINK_ML, actionParamsFor, drinkTotals, followUpTarget, initials, saverKeepsPrevious } from './model'
import { hydratePhonePrefs, phoneLanguage, phonePrefsStore, usePhonePrefs } from './phonePrefs'
import { PhoneContext, PhoneDialog, bigButton, langProps, speakAloud } from './ui'

type Tab = 'home' | 'buddy' | 'privacy'
type Dialog = { kind: 'checkin' } | { kind: 'buddy'; partnerId: string } | { kind: 'sos' } | { kind: 'language' } | { kind: 'no_partner' } | null

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { safe: 0, caution: 1, high: 2, stop: 3, emergency: 4 }

function useSaverModel(model: WorkerDeviceModel | null, on: boolean): WorkerDeviceModel | null {
  const shown = useRef<WorkerDeviceModel | null>(null)
  const next = on && saverKeepsPrevious(shown.current, model) ? shown.current : model
  useEffect(() => {
    shown.current = next
  })
  return next
}

export function WorkerView({ route }: ViewProps) {
  const embedded = route.query.embed === 'demo'
  const routeId = route.params.id ?? DEMO_ALIAS
  const roster = useSim((s) => s.roster)
  const crews = useSim((s) => s.crews)
  const status = useSim((s) => s.status)
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)

  useEffect(() => hydratePhonePrefs(), [])

  // A phone tab opened on an explicit worker is that worker's device: the sync bus publishes its payload and the
  // "Worker" navigation returns to it. (In the #/demo split view the presenter's choice drives the phone instead.)
  useEffect(() => {
    if (embedded || routeId === DEMO_ALIAS || !roster[routeId] || deviceWorkerId === routeId) return
    uiStore.getState().setDeviceWorker(routeId)
  }, [embedded, routeId, roster, deviceWorkerId])

  const live = useWorkerDevice(routeId)
  const prefs = usePhonePrefs(live?.workerId)
  const model = useSaverModel(live, prefs.batterySaver)
  const lang = phoneLanguage({ choice: prefs.lang, urlLang: route.query.lang, profileLang: live?.profile.language })
  const dir = LANGUAGES[lang].rtl ? 'rtl' : 'ltr'
  const ctx = useMemo(() => ({ lang, dir }) as const, [lang, dir])

  const [tab, setTab] = useState<Tab>('home')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [drinkFeedbackMl, setDrinkFeedbackMl] = useState<number | null>(null)
  const [voiceMissing, setVoiceMissing] = useState(false)

  // Reset the per-phone UI when the phone shows another worker (state adjusted during render, React's documented way).
  const workerId = model?.workerId ?? null
  const [shownWorker, setShownWorker] = useState(workerId)
  if (shownWorker !== workerId) {
    setShownWorker(workerId)
    setDialog(null)
    setTab('home')
  }

  // Vibrate the level's pattern when the level rises (W3C Vibration API; a no-op on desktop and iOS). Not while the
  // clock is jumping, and only after the person has touched the page (browsers block vibration before that).
  const level = live?.assessment?.level ?? null
  const jumping = useSim((s) => s.jumping)
  const prevLevel = useRef<{ id: string | null; level: RiskLevel | null }>({ id: null, level: null })
  useEffect(() => {
    const p = prevLevel.current
    prevLevel.current = { id: workerId, level }
    if (jumping || p.id !== workerId || !p.level || !level || LEVEL_RANK[level] <= LEVEL_RANK[p.level]) return
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
    if (activation && !activation.hasBeenActive) return
    vibrate(level)
  }, [workerId, level, jumping])

  useEffect(() => {
    if (drinkFeedbackMl === null) return
    const id = window.setTimeout(() => setDrinkFeedbackMl(null), 4000)
    return () => window.clearTimeout(id)
  }, [drinkFeedbackMl])

  const taskName = useCallback(
    (taskId: string | null | undefined): string | null => {
      if (!taskId) return null
      for (const c of crews) {
        const task = c.tasks.find((x) => x.id === taskId)
        if (task) return task.name
      }
      return null
    },
    [crews],
  )

  if (!model) {
    const loading = status !== 'ready' || Object.keys(roster).length === 0
    return (
      <PhoneContext.Provider value={ctx}>
        <div {...langProps(lang)} className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
          <span aria-hidden className="grid size-16 place-items-center rounded-full bg-shade-bg text-shade">
            <Smartphone size={30} />
          </span>
          <p className="text-lg font-semibold text-ink" role="status">
            {loading ? wt(lang, 'loading') : wt(lang, 'no_worker')}
          </p>
          {!loading && (
            <a href={toHref(pathFor('worker', { id: DEMO_ALIAS }))} className={bigButton('primary', 'w-auto justify-center')}>
              {wt(lang, 'open_demo')}
            </a>
          )}
        </div>
      </PhoneContext.Provider>
    )
  }

  const now = model.t
  const inject = simStore.getState().inject
  const partners: BuddyPartner[] = model.buddyCards.map((card) => ({
    card,
    name: (typeof card.data.displayName === 'string' ? card.data.displayName : null) ?? roster[card.workerId]?.displayName ?? card.workerId,
  }))
  const myBuddyId = roster[model.workerId]?.buddyId ?? null
  const myBuddyName = myBuddyId ? (roster[myBuddyId]?.displayName ?? myBuddyId) : null
  const totals = drinkTotals(model.device.intakes, model.workerId, now)

  const onDrink = (): void => {
    inject({ kind: 'intake', intake: { t: now, workerId: model.workerId, ml: DRINK_ML, loggedAt: now } })
    setDrinkFeedbackMl(DRINK_ML)
  }
  const onAck = (alertId: string): void => inject({ kind: 'ack', alertId, role: 'worker', actorId: model.workerId })
  const onCheckinSubmit = (checkin: Checkin): void => inject({ kind: 'checkin', checkin })
  const openBuddy = (): void => {
    if (partners.length === 1 && partners[0]) setDialog({ kind: 'buddy', partnerId: partners[0].card.workerId })
    else if (partners.length === 0) setDialog({ kind: 'no_partner' })
    else setTab('buddy')
  }
  const turnOnCheckins = (): void => {
    try {
      governanceStore.getState().grant({ workerId: model.workerId, scope: 'checkins', t: now, language: lang, base: model.profile.consent })
    } catch {
      /* the flow stays on the "check-ins are off" screen */
    }
  }
  const onListen = (): void => {
    const a = model.assessment
    if (!a) return
    const say = (l: LangCode): string => {
      const acts = a.actions
        .filter((x) => x !== 'call_998' || a.level === 'emergency')
        .slice(0, 3)
        .map((x) => actionText(l, x, actionParamsFor(x, { workMinPerHour: a.workMinPerHour, waterMlPerHour: a.waterMlPerHour })))
      return [levelName(l, a.level), levelMeaning(l, a.level), ...acts].join('. ')
    }
    setVoiceMissing(!speakAloud(say(lang), lang, say))
  }
  const setLang = (code: LangCode): void => {
    phonePrefsStore.getState().set(model.workerId, { lang: code })
    setDialog(null)
  }

  const buddyPartner = dialog?.kind === 'buddy' ? partners.find((p) => p.card.workerId === dialog.partnerId) : undefined
  const alertBadge = model.alert && model.alert.status !== 'resolved' && model.ackStatus !== 'acknowledged'
  const buddyBadge = partners.some((p) => p.card.buddyCheck)

  return (
    <PhoneContext.Provider value={ctx}>
      {/* Inside the desktop phone frame the screen is the scroll container (header and tabs stick to it); on a real
          phone the page scrolls under the app bar, so the header scrolls away and SOS moves into the bottom bar. */}
      <div {...langProps(lang)} className="flex min-h-[calc(100dvh-9.5rem)] flex-col bg-canvas text-ink md:min-h-full">
        <header className="z-30 border-b border-line bg-canvas/95 px-4 pt-2 pb-2.5 backdrop-blur supports-[backdrop-filter]:bg-canvas/80 md:sticky md:top-0">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-shade text-base font-bold text-white">
              {initials(model.profile.displayName)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base leading-tight font-bold text-ink">
                <bdi>{model.profile.displayName}</bdi>
              </p>
              <p className="truncate text-xs text-muted tabular-nums">{wt(lang, 'updated', { time: formatLocalHhmm(now) })}</p>
            </div>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'language' })}
              aria-label={`${t(lang, 'ui.language')}: ${LANGUAGES[lang].nativeName}`}
              className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink ring-1 ring-line-strong hover:bg-surface"
            >
              <Globe size={18} aria-hidden className="text-shade" />
              <span className="max-w-[5.5rem] truncate" lang={LANGUAGES[lang].bcp47}>
                {LANGUAGES[lang].nativeName}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'sos' })}
              aria-label={wt(lang, 'sos_label')}
              className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-full bg-stop-fill px-3.5 text-base font-extrabold tracking-wide text-white shadow-sm hover:bg-stop"
            >
              <Siren size={20} aria-hidden />
              <span dir="ltr">SOS</span>
            </button>
          </div>
        </header>

        <div className="flex-1 pt-3">
          {tab === 'home' && (
            <HomeTab
              model={model}
              taskName={taskName}
              onDrink={onDrink}
              drinkFeedbackMl={drinkFeedbackMl}
              onCheckin={() => setDialog({ kind: 'checkin' })}
              onBuddy={openBuddy}
              onSos={() => setDialog({ kind: 'sos' })}
              onAck={onAck}
              onListen={onListen}
              voiceMissing={voiceMissing}
            />
          )}
          {tab === 'buddy' && <BuddyTab myBuddyName={myBuddyName} partners={partners} onCheck={(id) => setDialog({ kind: 'buddy', partnerId: id })} />}
          {tab === 'privacy' && (
            <PrivacyTab
              model={model}
              batterySaver={prefs.batterySaver}
              onBatterySaver={(on) => phonePrefsStore.getState().set(model.workerId, { batterySaver: on })}
              onOpenLanguage={() => setDialog({ kind: 'language' })}
            />
          )}
        </div>

        <nav
          aria-label={wt(lang, 'phone_menu')}
          className="sticky bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:grid-cols-3"
        >
          {(
            [
              ['home', House, wt(lang, 'home'), alertBadge],
              ['buddy', HeartHandshake, t(lang, 'ui.buddy'), buddyBadge],
              ['privacy', ShieldCheck, t(lang, 'ui.privacy'), false],
            ] as const
          ).map(([id, Icon, label, badge]) => {
            const current = tab === id
            return (
              <button
                key={id}
                type="button"
                aria-current={current ? 'page' : undefined}
                onClick={() => setTab(id)}
                className={cx(
                  'relative flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-xs font-semibold transition-colors',
                  current ? 'text-shade-dark' : 'text-muted hover:text-ink',
                )}
              >
                <span className={cx('grid h-8 w-14 place-items-center rounded-full transition-colors', current && 'bg-shade-tint')}>
                  <Icon size={22} aria-hidden />
                </span>
                <span className="max-w-full truncate">{label}</span>
                {badge && <span aria-hidden className="absolute top-2 size-2.5 rounded-full bg-stop-fill ring-2 ring-surface ltr:ms-8 rtl:me-8" />}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => setDialog({ kind: 'sos' })}
            aria-label={wt(lang, 'sos_label')}
            className="flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-xs font-extrabold text-stop md:hidden"
          >
            <span className="grid h-8 w-14 place-items-center rounded-full bg-stop-fill text-white">
              <Siren size={20} aria-hidden />
            </span>
            <span dir="ltr">SOS</span>
          </button>
        </nav>

        {dialog?.kind === 'checkin' && (
          <CheckinFlow
            who="self"
            subjectId={model.workerId}
            now={now}
            history={model.device.checkins}
            followUpOf={followUpTarget(model.device.checkins, model.workerId, now)}
            checkinsAllowed={model.profile.consent.checkins}
            riskFlags={model.profile.consent.healthFlags ? model.profile.riskFlags : []}
            overFluidCap={totals.overHourly || totals.overDaily}
            onSubmit={onCheckinSubmit}
            onTurnOnCheckins={turnOnCheckins}
            onSos={() => setDialog({ kind: 'sos' })}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'buddy' && buddyPartner && (
          <CheckinFlow
            who="buddy"
            subjectId={buddyPartner.card.workerId}
            subjectName={buddyPartner.name}
            now={now}
            history={[]}
            followUpOf={null}
            checkinsAllowed
            onSubmit={onCheckinSubmit}
            onSos={() => setDialog({ kind: 'sos' })}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'sos' && (
          <SosScreen
            workerId={model.workerId}
            partners={partners.map((p) => ({ workerId: p.card.workerId, name: p.name }))}
            now={now}
            onSend={onCheckinSubmit}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'no_partner' && (
          <PhoneDialog title={wt(lang, 'check_buddy')} onClose={() => setDialog(null)} closeLabel={wt(lang, 'close')}>
            <p className="text-lg text-ink">{wt(lang, 'no_partner')}</p>
            {myBuddyName && <p className="mt-3 text-base text-muted">{wt(lang, 'your_buddy', { name: myBuddyName })}</p>}
          </PhoneDialog>
        )}
        {dialog?.kind === 'language' && (
          <PhoneDialog title={t(lang, 'ui.language')} onClose={() => setDialog(null)} closeLabel={wt(lang, 'close')}>
            <ul className="grid gap-2">
              {LANG_CODES.map((code) => {
                const meta = LANGUAGES[code]
                const on = code === lang
                return (
                  <li key={code}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setLang(code)}
                      className={cx(
                        'flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-4 text-start transition-colors',
                        on ? 'border-shade bg-shade-bg' : 'border-line bg-surface hover:bg-canvas',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-xl font-bold text-ink" lang={meta.bcp47} dir={meta.rtl ? 'rtl' : 'ltr'} style={{ fontFamily: meta.fontFamily }}>
                          {meta.nativeName}
                        </span>
                        <span className="block text-sm text-muted" lang="en" dir="ltr">
                          {meta.englishName}
                        </span>
                      </span>
                      {on && <Check size={24} aria-hidden className="shrink-0 text-shade" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </PhoneDialog>
        )}
      </div>
    </PhoneContext.Provider>
  )
}
