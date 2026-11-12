/**
 * Audit chain panel: the hash-chained access log (governanceStore entries), chain verification, the tamper demo (an
 * edited COPY breaks verify() at the edited entry; the real log is untouched), the published head for the worker
 * committee, and a worker's "who saw my data". Every row is a real entry appended by a projection or an aggregate.
 * Basis: ARCHITECTURE §7; GOVERNANCE §6; privacy.ts AuditLog.
 */
import { useMemo, useState } from 'react'
import {
  Ban,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Eye,
  FilePenLine,
  History,
  Link2,
  ListChecks,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Stamp,
} from 'lucide-react'
import type { AuditEntry, Role } from '../../../engine/types'
import { PURPOSE_LABELS, ROLE_LABELS, isProhibitedPurpose, type AuditAnchor } from '../../../engine/privacy'
import { formatLocalHhmm } from '../../../engine/time'
import { entriesForSubject, governanceStore, selectorInput, simStore, type TamperDemoResult } from '../../../state'
import { useGovernance } from '../../../state/hooks'
import { Button, Card, CardHeader, DataTable, EmptyState, Section, cx, type DataTableColumn } from '../../components'
import { consoleAccessRound } from './accessRound'
import { ROLE_ORDER, chainStatus, fieldLabels, filterAudit, summarizeAccess, tamperDiff, type AuditFilter, type ChainStatus } from './model'
import { DecisionBadge, HashText, INPUT_CLASS, SELECT_CLASS, SubjectSelect } from './ui'

const MAX_ROWS = 150

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Busy = 'verify' | 'tamper' | 'publish' | 'round' | null

const COLUMNS: readonly DataTableColumn<AuditEntry>[] = [
  { id: 'seq', header: '#', numeric: true, align: 'end', sortValue: (e) => e.seq, cell: (e) => <span className="font-mono text-xs">{e.seq}</span> },
  { id: 't', header: 'Time', sortValue: (e) => e.t, cell: (e) => <span className="font-mono text-xs tabular-nums">{formatLocalHhmm(e.t)}</span> },
  {
    id: 'actor',
    header: 'Requester',
    sortValue: (e) => ROLE_LABELS[e.actorRole],
    cell: (e) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{ROLE_LABELS[e.actorRole]}</span>
        <span className="truncate font-mono text-[11px] text-muted">{e.actorId}</span>
      </span>
    ),
  },
  {
    id: 'purpose',
    header: 'Purpose',
    sortValue: (e) => PURPOSE_LABELS[e.purpose],
    cell: (e) =>
      isProhibitedPurpose(e.purpose) ? (
        <span className="inline-flex items-center gap-1 font-medium text-rose-800">
          <Ban aria-hidden size={13} className="shrink-0" />
          {PURPOSE_LABELS[e.purpose]}
          <span className="sr-only"> (prohibited purpose)</span>
        </span>
      ) : (
        PURPOSE_LABELS[e.purpose]
      ),
  },
  {
    id: 'subject',
    header: 'About',
    hideBelow: 'md',
    sortValue: (e) => e.subjectId ?? '',
    cell: (e) => (e.subjectId ? <span className="font-mono text-xs">{e.subjectId}</span> : <span className="text-xs text-muted italic">Group totals</span>),
  },
  {
    id: 'fields',
    header: 'Fields',
    hideBelow: 'lg',
    cell: (e) => {
      const text = fieldLabels(e.fields).join(', ')
      return (
        <span title={text} className="block max-w-[15rem] truncate text-xs text-muted">
          {text || '—'}
        </span>
      )
    },
  },
  { id: 'decision', header: 'Decision', sortValue: (e) => e.decision, cell: (e) => <DecisionBadge decision={e.decision} /> },
  { id: 'hash', header: 'Hash', hideBelow: 'sm', cell: (e) => <HashText hash={e.hash} n={10} /> },
]

function StatusLine({ status, anchor }: { status: ChainStatus; anchor: AuditAnchor | null }) {
  if (status.kind === 'unchecked') {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-muted">
        <ShieldCheck aria-hidden size={18} className="mt-px shrink-0 text-subtle" />
        Not verified yet. Verify recomputes every SHA-256 link from the genesis hash{anchor ? ' and checks the published head' : ''}.
      </p>
    )
  }
  if (status.kind === 'broken') {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-900">
        <CircleX aria-hidden size={18} className="mt-px shrink-0" />
        <span>
          <span className="font-semibold">Chain broken at entry #{status.brokenAt}.</span> {status.reason}.
        </span>
      </p>
    )
  }
  return (
    <p className="flex items-start gap-2 rounded-lg border border-shade-tint bg-shade-bg px-3 py-2.5 text-sm text-shade-dark">
      <CircleCheck aria-hidden size={18} className="mt-px shrink-0" />
      <span>
        <span className="font-semibold">
          Chain verified: {status.length} {status.length === 1 ? 'entry' : 'entries'}, every link intact
          {anchor ? `, matches the published head #${anchor.seq}` : ''}.
        </span>{' '}
        Head <HashText hash={status.head} n={16} className="text-shade-dark" />
        {status.stale > 0 && (
          <span className="mt-1 block text-xs text-muted">
            {status.stale} {status.stale === 1 ? 'entry was' : 'entries were'} added since. Verify again to include {status.stale === 1 ? 'it' : 'them'}.
          </span>
        )}
      </span>
    </p>
  )
}

function TamperResult({ demo }: { demo: TamperDemoResult }) {
  const diff = tamperDiff(demo.originalEntry, demo.tamperedEntry)
  return (
    <div className="mt-4 rounded-lg border border-rose-200 p-3">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <FilePenLine aria-hidden size={15} className="text-rose-700" />
        Demo copy: entry #{demo.index} edited without re-hashing
      </h4>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[20rem] text-sm">
          <caption className="sr-only">Fields changed in the edited copy</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th scope="col" className="py-1 pe-2 text-start font-medium">
                Field
              </th>
              <th scope="col" className="px-2 py-1 text-start font-medium">
                Real log
              </th>
              <th scope="col" className="px-2 py-1 text-start font-medium">
                Edited copy
              </th>
            </tr>
          </thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.key} className="border-b border-line last:border-0">
                <th scope="row" className="py-1 pe-2 text-start font-mono text-xs font-medium">
                  {d.key}
                </th>
                <td className="px-2 py-1 font-mono text-xs">{d.before}</td>
                <td className="px-2 py-1 font-mono text-xs text-rose-800">{d.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        <li className="flex items-start gap-2 text-rose-900">
          <CircleX aria-hidden size={16} className="mt-0.5 shrink-0" />
          <span>
            Edited copy:{' '}
            {demo.tampered.ok ? (
              'verify() still passes (unexpected)'
            ) : (
              <>
                <span className="font-semibold">verify() fails at entry #{demo.tampered.brokenAt}</span>, {demo.tampered.reason}.
              </>
            )}
          </span>
        </li>
        <li className="flex items-start gap-2 text-shade-dark">
          <CircleCheck aria-hidden size={16} className="mt-0.5 shrink-0" />
          <span>
            Real log: {demo.original.ok ? `still verifies (${demo.original.length} entries). The demo never touches it.` : `fails at entry #${demo.original.brokenAt}.`}
          </span>
        </li>
      </ul>
      <p className="mt-2 text-xs text-muted">
        Each hash covers the entry and the previous hash. Re-hashing an edited entry would break the next link instead, and a full rewrite is caught by
        the published head.
      </p>
    </div>
  )
}

function AnchorView({ anchor, total }: { anchor: AuditAnchor; total: number }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(`${anchor.seq}:${anchor.hash}`).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }
  const after = Math.max(0, total - 1 - anchor.seq)
  return (
    <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Stamp aria-hidden size={15} className="text-shade" />
          Published head for the worker committee
        </h4>
        <Button variant="ghost" size="sm" icon={ClipboardCopy} onClick={copy} disabled={anchor.seq < 0}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {anchor.seq < 0 ? (
        <p className="mt-1 text-sm text-muted">The log was empty when the head was published.</p>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm text-muted">Entry</span>
            <span className="font-mono text-lg font-semibold text-ink tabular-nums">#{anchor.seq}</span>
            <span className="text-sm text-muted">First 16 hex</span>
            <span className="font-mono text-lg font-semibold tracking-wider text-ink">{anchor.hash.slice(0, 16)}</span>
          </p>
          <p className="mt-1 font-mono text-[11px] break-all text-muted">{anchor.hash}</p>
          <p className="mt-2 text-xs text-muted">
            Verify now also checks this head, so a cut tail or rewritten history up to #{anchor.seq} is detected.
            {after > 0 ? ` ${after} newer ${after === 1 ? 'entry is' : 'entries are'} covered from the next publication.` : ''} In deployment the head is
            printed weekly on the site notice board and every head goes in the annual report to the worker committee.
          </p>
        </>
      )}
    </div>
  )
}

function WhoSawMyData({ entries, subjectId, onSubjectChange }: { entries: readonly AuditEntry[]; subjectId: string | null; onSubjectChange: (id: string) => void }) {
  const mine = useMemo(() => (subjectId ? entriesForSubject(entries, subjectId) : []), [entries, subjectId])
  const summary = useMemo(() => summarizeAccess(mine), [mine])
  const recent = mine.slice(-5).reverse()
  return (
    <Card as="article" aria-labelledby="gov-who-h" className="min-w-0 xl:col-span-5">
      <CardHeader
        id="gov-who-h"
        as="h3"
        icon={Eye}
        title="Who saw my data"
        description="Every access about one worker, refusals included: the list the worker sees on their own phone."
        actions={<SubjectSelect id="gov-who-worker" value={subjectId} onChange={onSubjectChange} />}
      />
      {summary.length === 0 ? (
        <EmptyState size="sm" icon={History} title="No access logged yet" description="Nobody has requested this worker’s data in this session." />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {summary.map((s) => (
              <li key={s.role} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="min-w-0 text-sm font-medium text-ink">
                  {ROLE_LABELS[s.role]} <span className="font-mono text-[11px] font-normal text-muted">{s.actors.join(', ')}</span>
                </span>
                <span className="text-end text-sm text-ink tabular-nums">
                  {s.count}× {s.refused > 0 && <span className="ms-1 inline-flex items-center gap-0.5 text-xs font-medium text-rose-800"><Ban aria-hidden size={12} />{s.refused} refused</span>}
                </span>
                <span className="min-w-0 truncate text-xs text-muted">{s.purposes.map((p) => PURPOSE_LABELS[p]).join(', ')}</span>
                <span className="text-end text-xs text-muted tabular-nums">last {formatLocalHhmm(s.lastT)}</span>
              </li>
            ))}
          </ul>
          <h4 className="mt-3 mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Latest</h4>
          <ol className="space-y-1.5 text-sm">
            {recent.map((e) => (
              <li key={e.seq} className="flex gap-2">
                <span className="w-11 shrink-0 font-mono text-xs leading-5 text-muted tabular-nums">{formatLocalHhmm(e.t)}</span>
                <span className="min-w-0">
                  <span className="font-medium">{ROLE_LABELS[e.actorRole]}</span> · {PURPOSE_LABELS[e.purpose]} ·{' '}
                  {e.decision === 'denied' ? <span className="font-medium text-rose-800">refused</span> : <span className="text-muted">{fieldLabels(e.fields).join(', ') || 'no fields'}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="mt-3 text-xs text-muted">Group totals carry no worker id, so they appear in the committee report rather than in this list.</p>
    </Card>
  )
}

export function AuditChain({
  subjectId,
  onSubjectChange,
  highlightSeq,
  seeded,
}: {
  subjectId: string | null
  onSubjectChange: (id: string) => void
  highlightSeq: number | null
  seeded: boolean
}) {
  const entries = useGovernance((s) => s.entries)
  const anchor = useGovernance((s) => s.anchor)
  const verification = useGovernance((s) => s.verification)
  const tamperDemo = useGovernance((s) => s.tamperDemo)
  const auditError = useGovernance((s) => s.auditError)
  const [busy, setBusy] = useState<Busy>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tamperAt, setTamperAt] = useState<string>('')
  const [roundNote, setRoundNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<AuditFilter>({ decision: 'all', role: 'all', subjectId: null })

  const status = chainStatus(verification, entries.length)
  const filtered = useMemo(() => filterAudit(entries, filter), [entries, filter])
  const rows = filtered.slice(0, MAX_ROWS)
  const refused = useMemo(() => entries.reduce((n, e) => n + (e.decision === 'denied' ? 1 : 0), 0), [entries])
  const defaultTamper = Math.floor(entries.length / 2)
  const tamperIndex = tamperAt === '' ? defaultTamper : Math.min(Math.max(0, Math.trunc(Number(tamperAt))), Math.max(0, entries.length - 1))

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<void> | void) => {
    setBusy(kind)
    setActionError(null)
    try {
      await fn()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const logRound = () =>
    run('round', async () => {
      const gov = governanceStore.getState()
      const input = selectorInput(simStore.getState(), gov.consent)
      if (!input) throw new Error('No shift is loaded yet.')
      const drafts = consoleAccessRound(input, subjectId)
      const before = gov.entries.length
      await gov.recordAll(drafts)
      await governanceStore.getState().flush()
      const added = governanceStore.getState().entries.length - before
      setRoundNote(
        `${drafts.length} console accesses: ${added} logged, ${drafts.length - added} unchanged ${drafts.length - added === 1 ? 'access' : 'accesses'} not logged again (an unchanged access is re-logged after 15 simulated minutes).`,
      )
    })

  return (
    <Section
      id="gov-audit"
      title="Audit chain"
      description="Every access to individual data and every group-total request, allowed or refused, appended to a SHA-256 hash chain. Verify it, try to tamper with it, and publish its head."
      provenance="simulated"
      provenanceDetail="Accesses made in this browser session; times are simulated"
    >
      {auditError && (
        <p role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <ShieldAlert aria-hidden size={16} className="mt-0.5 shrink-0" />
          The chain could not be written: {auditError}. Web Crypto needs a secure context (https or localhost).
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-12">
        <Card as="article" aria-labelledby="gov-integrity-h" className="min-w-0 xl:col-span-7">
          <CardHeader
            id="gov-integrity-h"
            as="h3"
            icon={Link2}
            title="Chain integrity"
            description={
              entries.length === 0
                ? 'Nothing logged yet.'
                : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · ${refused} refused · head #${entries.length - 1}, linked back to the genesis hash`
            }
          />
          <div className="flex flex-wrap items-end gap-2">
            <Button icon={ShieldCheck} loading={busy === 'verify'} disabled={busy !== null} onClick={() => void run('verify', async () => void (await governanceStore.getState().verify()))}>
              Verify chain
            </Button>
            <Button
              variant="secondary"
              icon={Stamp}
              loading={busy === 'publish'}
              disabled={busy !== null || entries.length === 0}
              onClick={() => void run('publish', () => void governanceStore.getState().publishAnchor())}
            >
              Publish head
            </Button>
            <div className="flex items-end gap-2 sm:ms-auto">
              <div>
                <label htmlFor="gov-tamper-at" className="mb-1 block text-xs font-medium text-muted">
                  Entry to edit
                </label>
                <input
                  id="gov-tamper-at"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={Math.max(0, entries.length - 1)}
                  value={tamperAt === '' ? String(defaultTamper) : tamperAt}
                  onChange={(e) => setTamperAt(e.target.value)}
                  className={cx(INPUT_CLASS, 'w-20 font-mono tabular-nums')}
                  disabled={entries.length === 0}
                />
              </div>
              <Button
                variant="danger"
                icon={FilePenLine}
                loading={busy === 'tamper'}
                disabled={busy !== null || entries.length === 0}
                onClick={() => void run('tamper', async () => void (await governanceStore.getState().runTamperDemo({ index: tamperIndex })))}
              >
                Tamper with an entry (demo)
              </Button>
            </div>
          </div>
          <div role="status" aria-live="polite" className="mt-3">
            <StatusLine status={status} anchor={anchor} />
            {actionError && <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">{actionError}</p>}
          </div>
          {tamperDemo && <TamperResult demo={tamperDemo} />}
          {anchor && <AnchorView anchor={anchor} total={entries.length} />}
        </Card>

        <WhoSawMyData entries={entries} subjectId={subjectId} onSubjectChange={onSubjectChange} />

        <Card as="article" aria-labelledby="gov-entries-h" className="min-w-0 xl:col-span-12">
          <CardHeader
            id="gov-entries-h"
            as="h3"
            icon={ScrollText}
            title="Entries"
            description="Newest first. Demo view of the full log: in deployment a worker sees their own entries, the committee sees heads and counts, and a full export is made only for an audit under the DPO."
            actions={
              <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === 'round'} disabled={busy !== null} onClick={() => void logRound()}>
                Open every console once
              </Button>
            }
          />
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="gov-audit-decision" className="mb-1 block text-xs font-medium text-muted">
                Decision
              </label>
              <select
                id="gov-audit-decision"
                value={filter.decision}
                onChange={(e) => setFilter((f) => ({ ...f, decision: e.target.value as AuditFilter['decision'] }))}
                className={cx(SELECT_CLASS, 'w-36')}
              >
                <option value="all">All</option>
                <option value="denied">Refused only</option>
              </select>
            </div>
            <div>
              <label htmlFor="gov-audit-role" className="mb-1 block text-xs font-medium text-muted">
                Requester
              </label>
              <select
                id="gov-audit-role"
                value={filter.role}
                onChange={(e) => setFilter((f) => ({ ...f, role: e.target.value as Role | 'all' }))}
                className={cx(SELECT_CLASS, 'w-52')}
              >
                <option value="all">Every role</option>
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={filter.subjectId !== null}
                onChange={(e) => setFilter((f) => ({ ...f, subjectId: e.target.checked ? subjectId : null }))}
                className="size-4 accent-[var(--color-shade)]"
                disabled={!subjectId}
              />
              Only about <span className="font-mono text-xs">{filter.subjectId ?? subjectId ?? '—'}</span>
            </label>
            <p className="text-xs text-muted sm:ms-auto">
              {filtered.length > rows.length ? `Showing the latest ${rows.length} of ${filtered.length}` : `${filtered.length} shown`}
            </p>
          </div>
          {(roundNote || seeded) && (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
              <ListChecks aria-hidden size={14} className="mt-px shrink-0" />
              {roundNote ??
                'When this page opened, every console was opened once through the real selectors (supervisors, the worker’s phone and buddy, first aider, occupational health, HSE and regulator), so the chain starts with real projections.'}
            </p>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            rowKey={(e) => String(e.seq)}
            caption="Audit log entries, newest first"
            hideCaption
            dense
            stickyHeader
            maxHeight="28rem"
            rowClassName={(e) =>
              e.seq === highlightSeq ? 'bg-shade-bg' : tamperDemo && e.seq === tamperDemo.index ? 'bg-rose-50' : undefined
            }
            empty={<EmptyState size="sm" icon={ScrollText} title="No entries" description="Nothing matches this filter yet." />}
          />
        </Card>
      </div>
    </Section>
  )
}
