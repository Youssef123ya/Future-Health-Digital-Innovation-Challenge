/**
 * Privacy tab of the worker phone — "privacy by architecture" the worker can check for themself:
 * - What I share: the exact outbound payload (JSON and byte size, privacy.inspectSyncPayload) beside the plain list of
 *   everything that stays on the phone;
 * - My choices: the five consent scopes with the notice text in the phone's language; grant and revoke take effect in
 *   the same minute (governanceStore → `{ kind: 'consent' }` on the device) and write a consent receipt;
 * - Who saw my data: every logged access about this worker, refusals included (the hash-chained audit log);
 * - the general privacy notice (legal-duty group totals, k-suppressed), and the phone settings.
 * Basis: ARCHITECTURE §1 principle 5, §3, §7; GOVERNANCE §4; ILO code §6.14(1).
 */
import { useMemo, useState } from 'react'
import { Ban, Battery, CircleCheck, Eye, FileLock2, Globe, Info, Lock, Send, Smartphone } from 'lucide-react'
import type { LangCode } from '../../../engine/types'
import { CONSENT_SCOPES, inspectSyncPayload, type ConsentScope } from '../../../engine/privacy'
import { formatLocalHhmm } from '../../../engine/time'
import { LANGUAGES, consentText, privacyNoticeText, t } from '../../../i18n'
import { entriesForSubject, governanceStore, type WorkerDeviceModel } from '../../../state'
import { useGovernance } from '../../../state/hooks'
import { Toggle, cx } from '../../components'
import { wt } from './messages'
import { KEPT_KEYS, ROLE_KEYS, keptGroups, purposeKey } from './model'
import { TILE, usePhone } from './ui'

export interface PrivacyTabProps {
  model: WorkerDeviceModel
  batterySaver: boolean
  onBatterySaver: (on: boolean) => void
  onOpenLanguage: () => void
}

export function PrivacyTab({ model, batterySaver, onBatterySaver, onOpenLanguage }: PrivacyTabProps) {
  const { lang } = usePhone()
  return (
    <div className="space-y-3 px-4 pt-1 pb-6">
      <p className="flex items-start gap-2 rounded-xl bg-shade-bg px-3 py-2.5 text-base leading-snug text-ink ring-1 ring-shade/25">
        <Lock size={18} aria-hidden className="mt-0.5 shrink-0 text-shade" />
        {t(lang, 'ui.data_stays')}
      </p>
      <WhatIShare model={model} />
      <MyChoices model={model} />
      <WhoSaw workerId={model.workerId} />
      <Notice />
      <Settings lang={lang} batterySaver={batterySaver} onBatterySaver={onBatterySaver} onOpenLanguage={onOpenLanguage} />
    </div>
  )
}

function SectionTitle({ icon: Icon, children, id }: { icon: typeof Send; children: string; id: string }) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-base font-bold text-ink">
      <Icon size={18} aria-hidden className="shrink-0 text-shade" />
      {children}
    </h3>
  )
}

function WhatIShare({ model }: { model: WorkerDeviceModel }) {
  const { lang } = usePhone()
  const inspection = useMemo(
    () => (model.assessment ? inspectSyncPayload(model.assessment, model.profile, model.ackStatus) : null),
    [model.assessment, model.profile, model.ackStatus],
  )
  const groups = keptGroups(inspection?.keptOnDevice ?? [])
  return (
    <section aria-labelledby="priv-share" className={TILE}>
      <SectionTitle icon={Send} id="priv-share">
        {t(lang, 'ui.what_i_share')}
      </SectionTitle>
      <div className="mt-3 rounded-xl bg-ink p-3 text-white">
        <p className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span>{wt(lang, 'sent_title')}</span>
          {inspection && (
            <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-medium tabular-nums">{wt(lang, 'bytes', { n: inspection.bytes })}</span>
          )}
        </p>
        <pre dir="ltr" className="mt-2 max-h-48 overflow-auto font-mono text-[12px] leading-relaxed text-teal-100">
          {inspection ? JSON.stringify(inspection.payload, null, 1) : '—'}
        </pre>
      </div>
      <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-ink">
        <Smartphone size={16} aria-hidden className="text-shade" />
        {wt(lang, 'stays_title')}
      </p>
      <ul className="mt-2 grid gap-1.5">
        {groups.map((g) => (
          <li key={g} className="flex items-start gap-2 text-base leading-snug text-ink">
            <CircleCheck size={18} aria-hidden className="mt-0.5 shrink-0 text-safe" />
            {wt(lang, KEPT_KEYS[g])}
          </li>
        ))}
      </ul>
      {inspection && (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-shade-dark">
            <Info size={16} aria-hidden />
            {wt(lang, 'technical')}
          </summary>
          <ul dir="ltr" className="mt-1 flex flex-wrap gap-1.5">
            {inspection.keptOnDevice.map((k) => (
              <li key={k} className="rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-muted ring-1 ring-line">
                {k}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function MyChoices({ model }: { model: WorkerDeviceModel }) {
  const { lang } = usePhone()
  const ledger = useGovernance((s) => s.consent[model.workerId])
  const consent = ledger ?? model.profile.consent
  const [feedback, setFeedback] = useState<{ scope: ConsentScope; ok: boolean; t: number } | null>(null)

  const change = (scope: ConsentScope, on: boolean): void => {
    const input = { workerId: model.workerId, scope, t: model.t, language: lang, base: model.profile.consent }
    try {
      if (on) governanceStore.getState().grant(input)
      else governanceStore.getState().revoke(input)
      setFeedback({ scope, ok: true, t: model.t })
    } catch {
      setFeedback({ scope, ok: false, t: model.t })
    }
  }

  return (
    <section aria-labelledby="priv-choices" className={TILE}>
      <SectionTitle icon={FileLock2} id="priv-choices">
        {wt(lang, 'my_choices')}
      </SectionTitle>
      <p className="mt-2 text-sm leading-snug text-muted">
        {t(lang, 'consent_info.intro')} {t(lang, 'consent_info.voluntary')} {t(lang, 'consent_info.change_anytime')}
      </p>
      <ul className="mt-3 divide-y divide-line">
        {CONSENT_SCOPES.map((scope) => {
          const text = consentText(lang, scope)
          return (
            <li key={scope} className="py-3 first:pt-1 last:pb-0">
              <Toggle size="lg" checked={consent[scope]} onCheckedChange={(on) => change(scope, on)} label={text.title} description={text.statement} />
              {feedback?.scope === scope && (
                <p role="status" className={cx('mt-1.5 text-sm font-semibold', feedback.ok ? 'text-safe' : 'text-stop')}>
                  {feedback.ok ? wt(lang, 'saved_at', { time: formatLocalHhmm(feedback.t) }) : wt(lang, 'save_failed')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function WhoSaw({ workerId }: { workerId: string }) {
  const { lang } = usePhone()
  const entries = useGovernance((s) => s.entries)
  const mine = useMemo(() => entriesForSubject(entries, workerId).slice(-12).reverse(), [entries, workerId])
  return (
    <section aria-labelledby="priv-who" className={TILE}>
      <SectionTitle icon={Eye} id="priv-who">
        {t(lang, 'ui.who_saw')}
      </SectionTitle>
      <p className="mt-1 text-sm text-muted">{wt(lang, 'logged_note')}</p>
      {mine.length === 0 ? (
        <p className="mt-3 text-base text-ink">{wt(lang, 'who_none')}</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {mine.map((e) => {
            const allowed = e.decision === 'allowed'
            return (
              <li key={e.seq} className="flex items-start gap-3 rounded-xl bg-canvas px-3 py-2.5 ring-1 ring-line">
                <span
                  aria-hidden
                  className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', allowed ? 'bg-shade-bg text-shade' : 'bg-stop-bg text-stop')}
                >
                  {allowed ? <Eye size={16} /> : <Ban size={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-base font-semibold text-ink">
                    <span>{wt(lang, ROLE_KEYS[e.actorRole])}</span>
                    <span className="text-sm font-normal text-muted tabular-nums">{formatLocalHhmm(e.t)}</span>
                  </p>
                  <p className="text-sm text-muted">
                    {wt(lang, purposeKey(e.purpose))} ·{' '}
                    <span className={cx('font-semibold', allowed ? 'text-shade-dark' : 'text-stop')}>{wt(lang, allowed ? 'allowed' : 'refused')}</span>
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Notice() {
  const { lang } = usePhone()
  const notice = privacyNoticeText(lang)
  return (
    <section aria-labelledby="priv-notice" className={TILE}>
      <SectionTitle icon={Info} id="priv-notice">
        {notice.title}
      </SectionTitle>
      <p className="mt-2 text-sm leading-relaxed text-ink">{notice.statement}</p>
    </section>
  )
}

function Settings({
  lang,
  batterySaver,
  onBatterySaver,
  onOpenLanguage,
}: {
  lang: LangCode
  batterySaver: boolean
  onBatterySaver: (on: boolean) => void
  onOpenLanguage: () => void
}) {
  return (
    <section aria-labelledby="priv-settings" className={TILE}>
      <SectionTitle icon={Battery} id="priv-settings">
        {wt(lang, 'settings')}
      </SectionTitle>
      <button
        type="button"
        onClick={onOpenLanguage}
        className="mt-3 flex min-h-14 w-full items-center gap-3 rounded-xl border border-line-strong bg-surface px-3 text-start text-base font-semibold text-ink hover:bg-canvas"
      >
        <Globe size={20} aria-hidden className="shrink-0 text-shade" />
        <span className="flex-1">{t(lang, 'ui.language')}</span>
        <span className="text-muted" lang={LANGUAGES[lang].bcp47}>
          {LANGUAGES[lang].nativeName}
        </span>
      </button>
      <div className="mt-3">
        <Toggle size="lg" checked={batterySaver} onCheckedChange={onBatterySaver} label={t(lang, 'ui.battery_saver')} description={wt(lang, 'battery_note')} />
      </div>
      {lang !== 'en' && <p className="mt-3 text-xs text-muted">{t(lang, 'ui.translation_draft')}</p>}
    </section>
  )
}
