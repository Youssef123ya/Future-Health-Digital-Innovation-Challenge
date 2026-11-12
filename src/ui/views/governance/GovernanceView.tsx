/**
 * Governance centre (#/governance): makes "privacy by architecture" visible and testable. Every panel runs the live
 * privacy code (src/engine/privacy.ts) through the governance store: the data-flow inspector (the exact payload that
 * leaves a phone beside what never does), the role × purpose matrix, the prohibited-request demo, the audit chain
 * (verify, tamper demo, published head, "who saw my data"), the consent ledger with receipts, the site's plan basis,
 * what supervisors never see (pooled phrases, designed suppression), retention and the claims discipline.
 * Individual data reaches this page only through the state layer (useDataFlowFeed, deviceSnapshot → privacy.project
 * with an audit entry, the consent ledger); no ground truth and no device detail is read here.
 * Basis: ARCHITECTURE §7 and §9; GOVERNANCE §2–§9.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, CircleCheck, CircleX, ShieldQuestion } from 'lucide-react'
import type { ViewProps } from '../../App'
import { governanceStore, selectorInput, simStore } from '../../../state'
import { useGovernance, useSim, useUi } from '../../../state/hooks'
import { ProvenanceTag, Stat, cx } from '../../components'
import { AccessMatrix } from './AccessMatrix'
import { AuditChain } from './AuditChain'
import { ConsentLedger } from './ConsentLedger'
import { DataFlowInspector } from './DataFlowInspector'
import { RequestDemo } from './RequestDemo'
import { RetentionClaims } from './RetentionClaims'
import { SiteSettings } from './SiteSettings'
import { SupervisorBoundary } from './SupervisorBoundary'
import { consoleAccessRound } from './accessRound'
import { chainStatus, type ChainStatus } from './model'
import { HashText, scrollToId } from './ui'

const NAV: readonly { id: string; label: string }[] = [
  { id: 'gov-dataflow', label: 'Data flow' },
  { id: 'gov-matrix', label: 'Access matrix' },
  { id: 'gov-request', label: 'Prohibited request' },
  { id: 'gov-audit', label: 'Audit chain' },
  { id: 'gov-consent', label: 'Consent' },
  { id: 'gov-site', label: 'Site settings' },
  { id: 'gov-boundary', label: 'Supervisor boundary' },
  { id: 'gov-retention', label: 'Retention and claims' },
]

/** The worker the panels inspect: the one picked here, else the device worker, else the first rostered worker. */
function useSubject(): [string | null, (id: string) => void] {
  const [picked, setPicked] = useState<string | null>(null)
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  const crews = useSim((s) => s.crews)
  const subject = useMemo(() => {
    const known = (id: string | null): id is string => id !== null && crews.some((c) => c.workerIds.includes(id))
    if (known(picked)) return picked
    if (known(deviceWorkerId)) return deviceWorkerId
    return crews[0]?.workerIds[0] ?? null
  }, [picked, deviceWorkerId, crews])
  return [subject, setPicked]
}

/**
 * When the page opens on an empty chain (no console opened in this tab yet), every console is opened once through the
 * real selectors, so the chain starts with real projections (accessRound.ts). Returns true once that round is logged.
 */
function useOpeningRound(subjectId: string | null): boolean {
  // Wait for the phones' first assessments (at the very start of a shift, or mid-jump, there is nothing to project).
  const ready = useSim((s) => s.status === 'ready' && !s.jumping && s.view !== null && s.view.workers.some((w) => w.assessment !== null))
  const empty = useGovernance((s) => s.entries.length === 0)
  const started = useRef(false)
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (started.current || !ready || !empty || !subjectId) return
    const input = selectorInput(simStore.getState(), governanceStore.getState().consent)
    if (!input) return
    started.current = true
    void governanceStore
      .getState()
      .recordAll(consoleAccessRound(input, subjectId))
      .then(() => setSeeded(true))
  }, [ready, empty, subjectId])
  return seeded
}

function IntegrityTile({ status }: { status: ChainStatus }) {
  const view =
    status.kind === 'ok'
      ? { icon: CircleCheck, text: 'Verified', cls: 'text-shade-dark', hint: status.stale > 0 ? `${status.stale} new since` : `${status.length} entries intact` }
      : status.kind === 'broken'
        ? { icon: CircleX, text: `Broken at #${status.brokenAt}`, cls: 'text-rose-800', hint: 'See the audit chain' }
        : { icon: ShieldQuestion, text: 'Not checked', cls: 'text-slate-700', hint: 'Verify it below' }
  const Icon = view.icon
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-surface p-4 shadow-xs">
      <span className="flex min-h-6 items-center text-xs font-medium text-muted">Chain integrity</span>
      <span className={cx('inline-flex items-center gap-1.5 text-2xl leading-none font-semibold', view.cls)}>
        <Icon aria-hidden size={22} className="shrink-0" />
        <span className="truncate">{view.text}</span>
      </span>
      <button
        type="button"
        onClick={() => scrollToId('gov-audit')}
        className="inline-flex w-fit items-center gap-1 rounded text-xs text-muted hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade"
      >
        {view.hint}
        <ArrowDown aria-hidden size={12} />
      </button>
    </div>
  )
}

function Summary() {
  const entries = useGovernance((s) => s.entries)
  const verification = useGovernance((s) => s.verification)
  const anchor = useGovernance((s) => s.anchor)
  const receipts = useGovernance((s) => s.receipts.length)
  const refused = useMemo(() => entries.reduce((n, e) => n + (e.decision === 'denied' ? 1 : 0), 0), [entries])
  const status = chainStatus(verification, entries.length)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Governance summary">
      <Stat framed label="Accesses logged" value={entries.length} hint="Allowed and refused, hash-chained" />
      <Stat framed label="Refused and logged" value={refused} hint="Including prohibited purposes" />
      <IntegrityTile status={status} />
      <Stat
        framed
        label="Published head"
        value={anchor && anchor.seq >= 0 ? `#${anchor.seq}` : 'Not yet'}
        hint={anchor && anchor.seq >= 0 ? <HashText hash={anchor.hash} n={12} /> : 'For the worker committee'}
      />
      <Stat framed label="Consent receipts" value={receipts} hint="Grants and withdrawals, this session" className="col-span-2 sm:col-span-1" />
    </div>
  )
}

export function GovernanceView(_props: ViewProps) {
  const [subjectId, setSubjectId] = useSubject()
  const seeded = useOpeningRound(subjectId)
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null)

  return (
    <div className="space-y-10">
      <header className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-shade-dark">Privacy by architecture</p>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Governance centre</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Every panel runs the same privacy code as the phones and consoles. Pick a worker, send a forbidden request, tamper with the log, withdraw a
              consent, and see what changes, what is logged, and what never leaves the phone.
            </p>
          </div>
          <ProvenanceTag kind="simulated" detail="A simulated crew on a real Abu Dhabi weather day; governance rules from src/engine/privacy.ts" />
        </div>
        <Summary />
        <nav aria-label="Governance centre sections">
          <ul className="flex flex-wrap gap-1.5">
            {NAV.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => scrollToId(n.id)}
                  className="inline-flex h-9 items-center rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade"
                >
                  {n.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <DataFlowInspector subjectId={subjectId} onSubjectChange={setSubjectId} />
      <AccessMatrix />
      <RequestDemo subjectId={subjectId} onSubjectChange={setSubjectId} onLogged={setHighlightSeq} />
      <AuditChain subjectId={subjectId} onSubjectChange={setSubjectId} highlightSeq={highlightSeq} seeded={seeded} />
      <ConsentLedger subjectId={subjectId} onSubjectChange={setSubjectId} />
      <SiteSettings />
      <SupervisorBoundary />
      <RetentionClaims />
    </div>
  )
}
