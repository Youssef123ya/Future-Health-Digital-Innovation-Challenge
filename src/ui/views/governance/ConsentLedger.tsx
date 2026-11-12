/**
 * Consent ledger: a worker's five opt-in scopes with grant/revoke (governanceStore.grant / revoke → privacy.ts consent
 * receipts), what is processed under the current choices (privacy.ts activeProcessing), what the change does on the
 * phone, and the receipts (scope, notice version, language, method, collector, time). A supervisor may never collect
 * consent: choosing one shows the refusal createConsentReceipt raises. The ledger change reaches the simulated phone
 * through connectGovernanceToSim; nothing about consent crosses to a console.
 * Basis: ARCHITECTURE §7, §10; GOVERNANCE §4.
 */
import { useMemo, useState } from 'react'
import { BadgeCheck, CircleCheck, CircleSlash, FileSignature, Info, ReceiptText, Smartphone, Undo2, UserCheck } from 'lucide-react'
import type { ConsentState, LangCode } from '../../../engine/types'
import {
  CONSENT_NOTICES,
  CONSENT_SCOPES,
  GENERAL_PRIVACY_NOTICE,
  activeProcessing,
  type ConsentCollector,
  type ConsentMethod,
  type ConsentReceipt,
  type ConsentScope,
  type ProcessingId,
} from '../../../engine/privacy'
import { formatLocalHhmm } from '../../../engine/time'
import { LANGUAGES, LANG_CODES } from '../../../i18n'
import { governanceStore, simStore, type ConsentChangeInput } from '../../../state'
import { useGovernance, useSim, useUi } from '../../../state/hooks'
import { Badge, Card, CardHeader, DataTable, EmptyState, Section, Toggle, cx, type DataTableColumn } from '../../components'
import {
  COLLECTOR_LABELS,
  COLLECTOR_OPTIONS,
  CONSENT_DEVICE_EFFECT,
  METHOD_LABELS,
  PROCESSING_LABELS,
  processingChanges,
  type CollectorChoice,
} from './model'
import { FieldChip, INPUT_CLASS, SELECT_CLASS, SubjectSelect, useFlash } from './ui'

interface LastChange {
  id: number
  workerId: string
  scope: ConsentScope
  granted: boolean
  t: number
  changed: ProcessingId[]
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let changeSeq = 0

const RECEIPT_COLUMNS: readonly DataTableColumn<ConsentReceipt & { key: string }>[] = [
  { id: 't', header: 'Time', sortValue: (r) => r.t, cell: (r) => <span className="font-mono text-xs tabular-nums">{formatLocalHhmm(r.t)}</span> },
  { id: 'scope', header: 'Consent', sortValue: (r) => r.title, cell: (r) => r.title },
  {
    id: 'action',
    header: 'Action',
    sortValue: (r) => r.action,
    cell: (r) =>
      r.action === 'granted' ? (
        <span className="inline-flex items-center gap-1 font-medium text-shade-dark">
          <CircleCheck aria-hidden size={13} />
          Granted
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 font-medium text-slate-700">
          <Undo2 aria-hidden size={13} />
          Withdrawn
        </span>
      ),
  },
  { id: 'version', header: 'Notice', hideBelow: 'sm', cell: (r) => <span className="tabular-nums">v{r.noticeVersion}</span> },
  { id: 'lang', header: 'Language', hideBelow: 'md', cell: (r) => LANGUAGES[r.language].englishName },
  { id: 'method', header: 'Method', hideBelow: 'lg', cell: (r) => METHOD_LABELS[r.method] + (r.witnessId ? ` (${r.witnessId})` : '') },
  { id: 'by', header: 'Collected by', hideBelow: 'md', cell: (r) => COLLECTOR_LABELS[r.collectedBy] },
]

export function ConsentLedger({ subjectId, onSubjectChange }: { subjectId: string | null; onSubjectChange: (id: string) => void }) {
  const consent = useGovernance((s) => (subjectId ? s.consent[subjectId] : undefined))
  const receipts = useGovernance((s) => s.receipts)
  const uiLanguage = useUi((s) => s.language)
  const ready = useSim((s) => s.view !== null)
  const [collector, setCollector] = useState<CollectorChoice>('self')
  const [method, setMethod] = useState<ConsentMethod>('electronic_affirmative_action')
  const [witness, setWitness] = useState('WIT-1')
  const [noticeLang, setNoticeLang] = useState<LangCode | null>(null)
  const [last, setLast] = useState<LastChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const language = noticeLang ?? uiLanguage
  const flashing = useFlash(last?.id ?? 0, 2200)

  const processing = useMemo(() => (consent ? activeProcessing(consent) : []), [consent])
  const mine = useMemo(
    () =>
      receipts
        .map((r, i) => ({ ...r, key: `${r.receiptId}#${i}` }))
        .filter((r) => r.subjectId === subjectId)
        .reverse(),
    [receipts, subjectId],
  )
  const lastHere = last && last.workerId === subjectId ? last : null

  const change = (scope: ConsentScope, on: boolean) => {
    if (!subjectId || !consent) return
    const t = simStore.getState().view?.t
    if (t === undefined) return
    setError(null)
    const before: ConsentState = consent
    try {
      const gov = governanceStore.getState()
      const input: ConsentChangeInput = {
        workerId: subjectId,
        scope,
        t,
        language,
        method,
        // 'supervisor' is not a ConsentCollector: passed on purpose so createConsentReceipt shows its refusal.
        collectedBy: collector as ConsentCollector,
        ...(method === 'witnessed_mark' ? { witnessId: witness.trim() } : {}),
      }
      if (on) gov.grant(input)
      else gov.revoke(input)
      const after = governanceStore.getState().consent[subjectId] ?? before
      changeSeq += 1
      setLast({ id: changeSeq, workerId: subjectId, scope, granted: on, t, changed: processingChanges(before, after) })
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Section
      id="gov-consent"
      title="Consent ledger"
      description="Five scopes, all opt-in and revocable at any time. Each change writes a receipt and reaches the worker’s phone from that minute. Core safety alerting needs no consent and never stops."
      provenance="simulated"
      provenanceDetail="Consent choices of the simulated cohort; changes made here apply to the simulated phone"
      actions={<SubjectSelect id="gov-consent-worker" value={subjectId} onChange={onSubjectChange} />}
    >
      {!consent ? (
        <Card>
          <EmptyState icon={FileSignature} title="No ledger entry yet" description="The ledger is filled from the roster when a shift loads." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12">
          <Card as="article" aria-labelledby="gov-consent-h" className="min-w-0 lg:col-span-5">
            <CardHeader
              id="gov-consent-h"
              as="h3"
              icon={UserCheck}
              title={`Choices of ${subjectId}`}
              description="In deployment the worker changes these on their own phone, or in a session run by research staff or occupational health, away from supervisors."
            />
            <div className="grid gap-3 rounded-lg border border-line bg-canvas p-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="gov-consent-collector" className="mb-1 block text-xs font-medium text-muted">
                  Collected by
                </label>
                <select id="gov-consent-collector" value={collector} onChange={(e) => setCollector(e.target.value as CollectorChoice)} className={SELECT_CLASS}>
                  {COLLECTOR_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="gov-consent-lang" className="mb-1 block text-xs font-medium text-muted">
                  Notice shown in
                </label>
                <select id="gov-consent-lang" value={language} onChange={(e) => setNoticeLang(e.target.value as LangCode)} className={SELECT_CLASS}>
                  {LANG_CODES.map((c) => (
                    <option key={c} value={c}>
                      {LANGUAGES[c].englishName} ({LANGUAGES[c].nativeName})
                    </option>
                  ))}
                </select>
              </div>
              <div className={cx('min-w-0', method !== 'witnessed_mark' && 'sm:col-span-2')}>
                <label htmlFor="gov-consent-method" className="mb-1 block text-xs font-medium text-muted">
                  Method
                </label>
                <select id="gov-consent-method" value={method} onChange={(e) => setMethod(e.target.value as ConsentMethod)} className={SELECT_CLASS}>
                  {(Object.keys(METHOD_LABELS) as ConsentMethod[]).map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              {method === 'witnessed_mark' && (
                <div className="min-w-0">
                  <label htmlFor="gov-consent-witness" className="mb-1 block text-xs font-medium text-muted">
                    Impartial witness id
                  </label>
                  <input id="gov-consent-witness" value={witness} onChange={(e) => setWitness(e.target.value)} className={cx(INPUT_CLASS, 'font-mono')} autoComplete="off" />
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                <CircleSlash aria-hidden size={16} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-semibold">Refused, nothing changed.</span> {error}
                </span>
              </p>
            )}

            <ul className="mt-3 divide-y divide-line">
              {CONSENT_SCOPES.map((scope) => {
                const notice = CONSENT_NOTICES[scope]
                return (
                  <li key={scope} className="py-3 first:pt-1 last:pb-0">
                    <Toggle
                      id={`gov-consent-${scope}`}
                      checked={consent[scope]}
                      onCheckedChange={(on) => change(scope, on)}
                      disabled={!ready}
                      label={notice.title}
                      description={notice.whoSees}
                    />
                  </li>
                )
              })}
            </ul>
          </Card>

          <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
            <Card as="article" aria-labelledby="gov-processing-h" className="min-w-0">
              <CardHeader
                id="gov-processing-h"
                as="h3"
                icon={BadgeCheck}
                title="What is processed now"
                description="Recomputed from the current choices by privacy.ts activeProcessing()."
              />
              <div role="status" aria-live="polite" aria-atomic="true">
                {lastHere ? (
                  <div className={cx('mb-3 rounded-lg border p-3 text-sm transition-colors duration-700', flashing ? 'border-shade bg-shade-bg' : 'border-line bg-canvas')}>
                    <p className="flex items-start gap-2 font-medium text-ink">
                      <Smartphone aria-hidden size={16} className="mt-0.5 shrink-0 text-shade" />
                      <span>
                        “{CONSENT_NOTICES[lastHere.scope].title}” {lastHere.granted ? 'granted' : 'withdrawn'} at {formatLocalHhmm(lastHere.t)}.{' '}
                        {CONSENT_DEVICE_EFFECT[lastHere.scope][lastHere.granted ? 'on' : 'off']}
                      </span>
                    </p>
                    <p className="mt-1.5 ps-6 text-xs text-muted">
                      {lastHere.changed.length > 0
                        ? `Changed: ${lastHere.changed.map((id) => PROCESSING_LABELS[id]).join(', ')}. `
                        : 'No processing activity changed state. '}
                      Nothing about this choice reaches a console: the sync payload has no consent field.
                    </p>
                  </div>
                ) : (
                  <p className="mb-3 flex items-start gap-2 text-xs text-muted">
                    <Info aria-hidden size={14} className="mt-px shrink-0" />
                    Switch a scope to see which processing stops or starts, and what changes on the phone.
                  </p>
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {processing.map((p) => {
                  const changed = lastHere?.changed.includes(p.id) && flashing
                  return (
                    <li
                      key={p.id}
                      className={cx(
                        'flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 transition-colors duration-700',
                        changed ? 'border-shade bg-shade-bg' : p.active ? 'border-line bg-surface' : 'border-dashed border-line-strong bg-canvas',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className={cx('text-sm font-medium', p.active ? 'text-ink' : 'text-muted')}>{PROCESSING_LABELS[p.id]}</p>
                        {p.active ? (
                          <Badge tone="brand" size="sm" icon={CircleCheck} className="shrink-0">
                            On
                          </Badge>
                        ) : (
                          <Badge tone="outline" size="sm" icon={CircleSlash} className="shrink-0">
                            Off
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted">{p.description}</p>
                      {p.fields.length > 0 && (
                        <ul className="flex flex-wrap gap-1" aria-label="Fields involved">
                          {p.fields.map((f) => (
                            <li key={f}>
                              <FieldChip field={f} withheld={!p.active} />
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-auto text-[11px] text-subtle">
                        {p.scope ? `Needs “${CONSENT_NOTICES[p.scope].title}”` : 'Needs no consent: employer’s legal duty'}
                      </p>
                    </li>
                  )
                })}
              </ul>
            </Card>

            <Card as="article" aria-labelledby="gov-notice-h" padding="sm" className="min-w-0">
              <div className="px-1">
                <h3 id="gov-notice-h" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                  <Info aria-hidden size={15} className="text-shade" />
                  {GENERAL_PRIVACY_NOTICE.title}
                  <Badge tone="outline" size="sm">
                    Shown to every worker · v{GENERAL_PRIVACY_NOTICE.version}
                  </Badge>
                </h3>
                <p className="mt-1 text-sm text-muted">{GENERAL_PRIVACY_NOTICE.statement}</p>
              </div>
            </Card>
          </div>

          <Card as="article" aria-labelledby="gov-receipts-h" className="min-w-0 lg:col-span-12">
            <CardHeader
              id="gov-receipts-h"
              as="h3"
              icon={ReceiptText}
              title="Receipts"
              description={`Proof of every grant and withdrawal for ${subjectId}: notice version, language, method and who collected it. ${receipts.length} in this session for all workers.`}
            />
            <DataTable
              columns={RECEIPT_COLUMNS}
              rows={mine}
              rowKey={(r) => r.key}
              caption={`Consent receipts for ${subjectId ?? 'the selected worker'}, newest first`}
              hideCaption
              dense
              maxHeight="18rem"
              stickyHeader
              empty={
                <EmptyState
                  size="sm"
                  icon={ReceiptText}
                  title="No receipts in this session"
                  description="The starting choices come from enrolment. Every change made above writes a receipt here."
                />
              }
            />
          </Card>
        </div>
      )}
    </Section>
  )
}
