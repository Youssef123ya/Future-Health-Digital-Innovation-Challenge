/**
 * Prohibited-request demo: a form (role, purpose, fields, requester, subject) that sends a real access request through
 * privacy.project() and appends its audit entry. The preset is the challenge brief's case: employer HR asks for heart
 * rate for a performance review → refused, with the legal and ethical basis, and the refusal appears in the chain.
 * The result shows the decision and the fields released or withheld, never the values: they go only to the requester.
 * Basis: ARCHITECTURE §7 (a prohibited purpose is always refused and logged); GOVERNANCE §5; governanceStore.ts.
 */
import { useState } from 'react'
import { ArrowDownToLine, Ban, FileLock2, Gavel, Send, ShieldQuestion, Sparkles } from 'lucide-react'
import type { AuditEntry, DataField, Purpose, Role } from '../../../engine/types'
import {
  DATA_FIELDS,
  FIELD_INFO,
  PROHIBITION_BASIS,
  PURPOSE_LABELS,
  ROLE_LABELS,
  isProhibitedPurpose,
  projectAndLog,
  type AccessRequest,
  type ProjectionResult,
} from '../../../engine/privacy'
import { formatLocalHhmm } from '../../../engine/time'
import { deviceSnapshot, governanceStore, selectorInput, simStore } from '../../../state'
import { useSim } from '../../../state/hooks'
import { Badge, Button, Card, CardHeader, EmptyState, Section, cx } from '../../components'
import {
  PERMITTED_PURPOSES,
  PROHIBITED_PURPOSE_LIST,
  REQUEST_PRESETS,
  ROLE_ORDER,
  citations,
  defaultActorFor,
  isBriefCase,
  requestContext,
  requestOutcome,
  type RequestPreset,
} from './model'
import { FIELD_CLASS_ORDER, FIELD_CLASS_STYLE, FieldChip, HashText, INPUT_CLASS, OutcomeBadge, SELECT_CLASS, SubjectSelect, scrollToId, useFlash } from './ui'

interface DemoOutcome {
  id: number
  request: AccessRequest
  subjectId: string
  result: ProjectionResult & { entry: AuditEntry }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let outcomeSeq = 0

/**
 * Sends one request: the brief's case through governanceStore.runProhibitedRequestDemo (always logged), any other
 * request through privacy.projectAndLog on the governance store's own log, then mirrors the store's entries so the
 * chain shows it (the store mirrors its log the same way after its own appends).
 */
async function sendRequest(request: AccessRequest, subjectId: string): Promise<DemoOutcome> {
  const gov = governanceStore.getState()
  const input = selectorInput(simStore.getState(), gov.consent)
  if (!input) throw new Error('No shift is loaded yet.')
  const snapshot = deviceSnapshot(input, subjectId)
  if (!snapshot) throw new Error(`The phone of ${subjectId} has no assessment yet. Try again once the shift is running.`)
  outcomeSeq += 1
  if (isBriefCase(request)) {
    const demo = await gov.runProhibitedRequestDemo(snapshot, input.view.t, request.actorId)
    return { id: outcomeSeq, request: demo.request, subjectId, result: demo.result }
  }
  const log = gov.log
  const result = await projectAndLog(log, snapshot, request, requestContext(input, request, subjectId))
  if (governanceStore.getState().log === log) governanceStore.setState({ entries: log.all(), head: log.head() })
  return { id: outcomeSeq, request, subjectId, result }
}

export function RequestDemo({
  subjectId,
  onSubjectChange,
  onLogged,
}: {
  subjectId: string | null
  onSubjectChange: (id: string) => void
  onLogged: (seq: number) => void
}) {
  const roster = useSim((s) => s.roster)
  const ready = useSim((s) => s.view !== null)
  const first = REQUEST_PRESETS[0]
  const [presetId, setPresetId] = useState<string | null>(first.id)
  const [role, setRole] = useState<Role>(first.role)
  const [purpose, setPurpose] = useState<Purpose>(first.purpose)
  const [fields, setFields] = useState<readonly DataField[]>(first.fields)
  const [actorOverride, setActorOverride] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<DemoOutcome | null>(null)
  const flashing = useFlash(outcome?.id ?? 0)

  const link = subjectId ? roster[subjectId] : undefined
  const defaultActor = defaultActorFor(role, { subjectId, buddyId: link?.buddyId, supervisorId: link?.supervisorId })
  const actorId = actorOverride ?? defaultActor
  const draft: AccessRequest = { role, actorId: actorId.trim() || defaultActor, purpose, ...(fields.length > 0 ? { fields: DATA_FIELDS.filter((f) => fields.includes(f)) } : {}) }
  const briefCase = isBriefCase(draft)

  const applyPreset = (p: RequestPreset) => {
    setPresetId(p.id)
    setRole(p.role)
    setPurpose(p.purpose)
    setFields(p.fields)
    setActorOverride(null)
    setError(null)
  }
  const edited = () => setPresetId(null)
  const toggleField = (f: DataField, on: boolean) => {
    edited()
    setFields((prev) => (on ? [...prev, f] : prev.filter((x) => x !== f)))
  }

  const submit = async () => {
    if (!subjectId || busy) return
    setBusy(true)
    setError(null)
    try {
      const out = await sendRequest(draft, subjectId)
      setOutcome(out)
      onLogged(out.result.entry.seq)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      id="gov-request"
      title="Prohibited-request demo"
      description="Try to get data for a purpose Zill forbids. The request goes through the same privacy.project() call the consoles use, and the decision is written to the audit chain whatever it is."
      provenance="simulated"
      provenanceDetail="Requests run against the simulated worker's on-device record"
    >
      <div className="grid gap-4 lg:grid-cols-12">
        <Card as="article" aria-labelledby="gov-req-form-h" className="min-w-0 lg:col-span-5">
          <CardHeader id="gov-req-form-h" as="h3" icon={ShieldQuestion} title="Build a request" description="Start from a preset or set every part yourself." />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
            className="space-y-4"
          >
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-muted">Presets</legend>
              <div className="grid gap-1.5">
                {REQUEST_PRESETS.map((p, i) => {
                  const on = presetId === p.id
                  const prohibited = isProhibitedPurpose(p.purpose)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => applyPreset(p)}
                      className={cx(
                        'flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade',
                        on ? 'border-ink bg-slate-50 font-medium text-ink' : 'border-line bg-surface text-ink hover:border-line-strong hover:bg-canvas',
                      )}
                    >
                      {prohibited ? <Ban aria-hidden size={16} className="shrink-0 text-rose-700" /> : <FileLock2 aria-hidden size={16} className="shrink-0 text-shade" />}
                      <span className="min-w-0 flex-1">{p.label}</span>
                      {i === 0 && (
                        <Badge tone="outline" size="sm" className="shrink-0">
                          Brief’s case
                        </Badge>
                      )}
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="gov-req-role" className="mb-1 block text-sm font-medium text-muted">
                  Requesting role
                </label>
                <select
                  id="gov-req-role"
                  value={role}
                  onChange={(e) => {
                    edited()
                    setRole(e.target.value as Role)
                    setActorOverride(null)
                  }}
                  className={SELECT_CLASS}
                >
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="gov-req-purpose" className="mb-1 block text-sm font-medium text-muted">
                  Purpose
                </label>
                <select
                  id="gov-req-purpose"
                  value={purpose}
                  onChange={(e) => {
                    edited()
                    setPurpose(e.target.value as Purpose)
                  }}
                  className={SELECT_CLASS}
                >
                  <optgroup label="Permitted">
                    {PERMITTED_PURPOSES.map((p) => (
                      <option key={p} value={p}>
                        {PURPOSE_LABELS[p]}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Prohibited">
                    {PROHIBITED_PURPOSE_LIST.map((p) => (
                      <option key={p} value={p}>
                        {PURPOSE_LABELS[p]}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="gov-req-actor" className="mb-1 block text-sm font-medium text-muted">
                  Requester id
                </label>
                <input
                  id="gov-req-actor"
                  value={actorId}
                  onChange={(e) => setActorOverride(e.target.value)}
                  className={cx(INPUT_CLASS, 'font-mono')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex min-w-0 flex-col justify-end">
                <SubjectSelect id="gov-req-subject" label="About" value={subjectId} onChange={onSubjectChange} className="[&_select]:w-full [&_select]:flex-1" />
              </div>
            </div>

            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-muted">Fields asked for</legend>
              <div className="flex min-h-7 flex-wrap items-center gap-1.5" aria-live="polite">
                {fields.length === 0 ? (
                  <span className="text-sm text-muted">Everything this role may receive for this purpose</span>
                ) : (
                  DATA_FIELDS.filter((f) => fields.includes(f)).map((f) => <FieldChip key={f} field={f} />)
                )}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer rounded text-sm font-medium text-shade-dark hover:underline">Choose fields</summary>
                <p className="mt-2 mb-2 text-xs text-subtle">None ticked = everything this role may receive for this purpose.</p>
              <div className="space-y-2">
                {FIELD_CLASS_ORDER.map((cls) => {
                  const style = FIELD_CLASS_STYLE[cls]
                  const Icon = style.icon
                  const list = DATA_FIELDS.filter((f) => FIELD_INFO[f].class === cls)
                  return (
                    <div key={cls} className="grid gap-1.5 sm:grid-cols-[5.5rem_1fr]">
                      <span className="text-xs font-medium text-subtle sm:pt-2">{style.label}</span>
                      <div className="flex flex-wrap gap-1.5">
                      {list.map((f) => {
                        const on = fields.includes(f)
                        return (
                          <label
                            key={f}
                            title={FIELD_INFO[f].description}
                            className={cx(
                              'inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-shade',
                              on ? style.chip : 'border-line bg-surface text-muted hover:border-line-strong',
                            )}
                          >
                            <input type="checkbox" checked={on} onChange={(e) => toggleField(f, e.target.checked)} className="sr-only" />
                            <Icon aria-hidden size={12} className={on ? '' : 'opacity-60'} />
                            {FIELD_INFO[f].label}
                            <span aria-hidden className={cx('ms-0.5 text-[11px]', on ? '' : 'invisible')}>
                              ✓
                            </span>
                          </label>
                        )
                      })}
                      </div>
                    </div>
                  )
                })}
              </div>
              </details>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button type="submit" icon={Send} loading={busy} disabled={!subjectId || !ready}>
                Send request
              </Button>
              {briefCase && (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  <Sparkles aria-hidden size={13} />
                  The challenge brief’s case
                </span>
              )}
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                {error}
              </p>
            )}
          </form>
        </Card>

        <Card
          as="article"
          aria-labelledby="gov-req-result-h"
          className={cx('min-w-0 transition-shadow duration-700 lg:col-span-7', flashing && 'shadow-[0_0_0_3px_var(--color-shade-tint)]')}
        >
          <CardHeader id="gov-req-result-h" as="h3" icon={Gavel} title="Decision" description="What privacy.project() returned, and the entry it wrote to the audit chain." />
          <div role="status" aria-live="polite" aria-atomic="true">
            {!outcome ? (
              <EmptyState
                size="sm"
                icon={Gavel}
                title="No request sent yet"
                description="Send the preset to see employer HR refused, with the legal and ethical basis, and the refusal written to the chain."
              />
            ) : (
              <OutcomeView outcome={outcome} />
            )}
          </div>
        </Card>
      </div>
    </Section>
  )
}

function OutcomeView({ outcome }: { outcome: DemoOutcome }) {
  const { request, result } = outcome
  const verdict = requestOutcome(result)
  const prohibited = isProhibitedPurpose(request.purpose)
  const basis = prohibited ? PROHIBITION_BASIS[request.purpose as keyof typeof PROHIBITION_BASIS] : null
  const entry = result.entry
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeBadge outcome={verdict} size="lg" />
        <p className="min-w-0 text-sm text-ink">
          <span className="font-semibold">{ROLE_LABELS[request.role]}</span> <span className="font-mono text-xs text-muted">{request.actorId}</span> asked for{' '}
          <span className="font-semibold">{PURPOSE_LABELS[request.purpose]}</span> about <span className="font-mono text-xs">{outcome.subjectId}</span>
        </p>
      </div>

      <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink">{result.reason}</p>

      {basis && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-rose-900">
            <Ban aria-hidden size={15} />
            Why this is refused for every role
          </h4>
          <p className="mt-1 text-sm text-rose-950">{basis.reason}</p>
          <h5 className="mt-3 text-xs font-semibold tracking-wide text-rose-900 uppercase">Legal and ethical basis</h5>
          <ul className="mt-1 space-y-1 text-sm text-rose-950">
            {citations(basis.basis).map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-rose-400" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-rose-900">Consent cannot unlock it: workers may not waive their privacy rights (ILO code §5.13).</p>
        </div>
      )}

      {!prohibited && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Released ({result.fields.length})</h4>
            {result.fields.length === 0 ? (
              <p className="text-sm text-muted">Nothing.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {result.fields.map((f) => (
                  <li key={f}>
                    <FieldChip field={f} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Withheld ({result.withheld.length})</h4>
            {result.withheld.length === 0 ? (
              <p className="text-sm text-muted">Nothing.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {result.withheld.map((f) => (
                  <li key={f}>
                    <FieldChip field={f} withheld />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-muted sm:col-span-2">Values go only to the requester’s console. This page shows the decision, never the data.</p>
        </div>
      )}

      <div className="rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-ink">
            Written to the audit chain as entry <span className="tabular-nums">#{entry.seq}</span>
          </h4>
          <Button variant="secondary" size="sm" icon={ArrowDownToLine} onClick={() => scrollToId('gov-audit')}>
            Show in the chain
          </Button>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Time</dt>
          <dd className="tabular-nums">{formatLocalHhmm(entry.t)} (simulated)</dd>
          <dt className="text-muted">Decision</dt>
          <dd>{entry.decision === 'denied' ? 'Refused' : 'Allowed'}</dd>
          <dt className="text-muted">Fields logged</dt>
          <dd className="min-w-0 break-words">{entry.fields.length > 0 ? entry.fields.map((f) => FIELD_INFO[f].label).join(', ') : 'None'}</dd>
          <dt className="text-muted">Hash</dt>
          <dd className="min-w-0">
            <HashText hash={entry.hash} n={16} />
          </dd>
          <dt className="text-muted">Links to</dt>
          <dd className="min-w-0">
            <HashText hash={entry.prevHash} n={16} /> <span className="text-xs text-muted">{entry.seq === 0 ? '(genesis)' : `(entry #${entry.seq - 1})`}</span>
          </dd>
        </dl>
      </div>
    </div>
  )
}
