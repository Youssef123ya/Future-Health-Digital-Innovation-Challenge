import { useMemo } from 'react'
import { ArrowRight, Info, Wrench } from 'lucide-react'
import { Badge, Section } from '../../components'
import { FLAW_COUNT, FLAW_STEPS, type Flaw, type FlawStep } from './history'
import { num, pct, signedPct } from './format'
import { versionRows, type VersionRow } from './model'
import { SubHead, TableFrame, TD, TH, WorldFlag } from './parts'
import type { CohortFile } from './types'
import { Callout, Code, DocLink, FileGate, MethodPanel } from './ui'
import { EVIDENCE_PATHS, useValidationFile, type FileState } from './useEvidenceData'

export const HISTORY_SECTION_ID = 'evidence-history'

const VERSION_LABELS = ['v0.1', 'v0.2', 'v0.3'] as const

function formatValue(row: VersionRow, value: number | null): string {
  if (value === null) return 'not defined'
  switch (row.format) {
    case 'percent':
      return pct(value, row.precision)
    case 'signedPercent':
      return signedPct(value, row.precision)
    case 'signed':
      return value === 0 ? '0' : `${value > 0 ? '+' : '−'}${num(Math.abs(value), row.precision)}`
    default:
      return num(value, row.precision)
  }
}

// ─── Flaw cards ─────────────────────────────────────────────────────────────────────────────────────────────────────

function FlawCard({ flaw, index }: { flaw: Flaw; index: number }) {
  return (
    <li className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white tabular-nums">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-ink">{flaw.title}</h4>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {flaw.areas.map((a) => (
              <Badge key={a} size="sm" tone="outline">
                {a}
              </Badge>
            ))}
            {flaw.foundBy && (
              <Badge size="sm" tone="info">
                Found by: {flaw.foundBy}
              </Badge>
            )}
            {flaw.worldChange && <WorldFlag />}
          </div>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-xs font-semibold tracking-wide text-muted uppercase">What was wrong</dt>
              <dd className="mt-0.5 text-ink">{flaw.problem}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs font-semibold tracking-wide text-muted uppercase">
                <Wrench aria-hidden size={12} /> Fixed before any pilot
              </dt>
              <dd className="mt-0.5 text-ink">{flaw.fix}</dd>
            </div>
            {flaw.evidence && (
              <div>
                <dt className="text-xs font-semibold tracking-wide text-muted uppercase">Measured</dt>
                <dd className="mt-0.5 text-ink">{flaw.evidence}</dd>
              </div>
            )}
          </dl>
          <p className="mt-2 text-xs">
            <DocLink path={flaw.source.path} label={`Source: ${flaw.source.label}`} />
          </p>
        </div>
      </div>
    </li>
  )
}

function StepBlock({ step, offset }: { step: FlawStep; offset: number }) {
  return (
    <div>
      <SubHead>
        <span className="inline-flex flex-wrap items-center gap-2">
          {step.from} <ArrowRight aria-label="to" size={16} className="text-subtle rtl:rotate-180" /> {step.to}
          <span className="text-sm font-normal text-muted">
            {step.flaws.length} flaw{step.flaws.length === 1 ? '' : 's'} fixed
          </span>
        </span>
      </SubHead>
      <p className="mb-3 max-w-prose text-sm text-muted">{step.summary}</p>
      <ol className="grid gap-3 xl:grid-cols-2">
        {step.flaws.map((f, i) => (
          <FlawCard key={f.id} flaw={f} index={offset + i + 1} />
        ))}
      </ol>
    </div>
  )
}

// ─── Before / after table ───────────────────────────────────────────────────────────────────────────────────────────

function VersionStrip({ reports }: { reports: readonly (CohortFile | null)[] }) {
  return (
    <ol className="grid gap-3 md:grid-cols-3">
      {reports.map((r, i) => {
        const prev = i > 0 ? reports[i - 1] : null
        const worldMoved = !!(r && prev && (r.versions.worldsim !== prev.versions.worldsim || (r.versions.truth ?? '') !== (prev.versions.truth ?? '')))
        return (
          <li key={VERSION_LABELS[i]} className="min-w-0 rounded-xl border border-line bg-surface p-3 text-xs">
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-ink">{VERSION_LABELS[i]}</span>
              {worldMoved && <WorldFlag />}
            </p>
            {r ? (
              <dl className="mt-1 space-y-0.5 text-muted">
                <div>
                  <dt className="inline">Stamp </dt>
                  <dd className="inline break-all text-ink">
                    <Code>{r.stamp.stamp.replace('zill@0.1.0+', '')}</Code>
                  </dd>
                </div>
                <div>
                  <dt className="inline">Back-test / metrics / world / ground truth: </dt>
                  <dd className="inline text-ink tabular-nums">
                    {r.versions.backtest} / {r.versions.metrics} / {r.versions.worldsim} / {r.versions.truth ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Arms · variants · site-day runs: </dt>
                  <dd className="inline text-ink tabular-nums">
                    {r.arms.length} · {r.sensitivity.length + r.robustness.length} · {num(r.runs.rows.length)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1 text-muted">File not generated.</p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function VersionTable({ reports }: { reports: readonly (CohortFile | null)[] }) {
  const rows = useMemo(() => versionRows(reports), [reports])
  const groups: { id: VersionRow['group']; label: string }[] = [
    { id: 'zill', label: 'Zill: Standard limits, with wearable (zill_full)' },
    { id: 'baseline', label: 'Baseline arms: no Zill in them, so any change is the simulated world' },
  ]
  return (
    <TableFrame label="Before and after, cohort versions 0.1 to 0.3">
      <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Key cohort measures in v0.1, v0.2 and v0.3. Baseline rows that changed are flagged as simulated-world changes.</caption>
        <thead>
          <tr>
            <th scope="col" className={`${TH} text-start`}>Measure (base case)</th>
            {VERSION_LABELS.map((l) => (
              <th key={l} scope="col" className={`${TH} text-end`}>
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.id} label={g.label} rows={rows.filter((r) => r.group === g.id)} />
          ))}
        </tbody>
      </table>
    </TableFrame>
  )
}

function GroupRows({ label, rows }: { label: string; rows: readonly VersionRow[] }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={4} className="border-b border-line bg-canvas px-3 py-1.5 text-start text-xs font-semibold text-ink">
          {label}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.id}>
          <th scope="row" className={`${TD} text-start font-normal text-ink`}>
            {r.label}
          </th>
          {r.values.map((value, i) => (
            <td key={i} className={`${TD} text-end tabular-nums ${value === null ? 'text-subtle' : 'text-ink'}`}>
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                {r.worldChanged[i] && <WorldFlag compact />}
                {formatValue(r, value)}
              </span>
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function HistoryTable({ v03 }: { v03: CohortFile }) {
  const v01 = useValidationFile<CohortFile>(EVIDENCE_PATHS.cohortV01)
  const v02 = useValidationFile<CohortFile>(EVIDENCE_PATHS.cohortV02)
  const reports = useMemo(
    () => [v01.status === 'ready' ? v01.data : null, v02.status === 'ready' ? v02.data : null, v03] as const,
    [v01, v02, v03],
  )
  const loading = v01.status === 'loading' || v02.status === 'loading'
  return (
    <div className="space-y-3">
      <SubHead>Before and after, in numbers</SubHead>
      <VersionStrip reports={reports} />
      {loading ? (
        <p role="status" className="text-sm text-muted">
          Loading the v0.1 and v0.2 cohort files…
        </p>
      ) : (
        <>
          {(v01.status !== 'ready' || v02.status !== 'ready') && (
            <p className="text-sm text-muted">
              {v01.status !== 'ready' && <Code>public/data/validation/cohort-v0.1.json</Code>} {v02.status !== 'ready' && <Code>public/data/validation/cohort-v0.2.json</Code>}{' '}
              not available: those columns read &ldquo;not defined&rdquo;.
            </p>
          )}
          <VersionTable reports={reports} />
        </>
      )}
      <Callout icon={Info}>
        <p>
          <strong>How to read the table.</strong> The fixes in each step were made together, so a column shows their joint effect, plus any change
          to the simulated world; no difference is attributed to a single fix. Rows marked <WorldFlag compact /> are baseline arms that moved
          between versions: the simulated world changed (world simulation, ground-truth model or metric definitions), not Zill, and part of every
          Zill change is the same world change. Compare Zill with the midday ban only through the paired rows, which stay within one version&apos;s
          world. Under Zill, dehydration, heat-symptom and evacuation counts are a handful of events in 333 worker-shifts: too few to rank versions.
          &ldquo;Not defined&rdquo;: the measure did not exist in that version&apos;s metrics.
        </p>
      </Callout>
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────────────────────────────────────────

const OFFSETS = FLAW_STEPS.map((_, i) => FLAW_STEPS.slice(0, i).reduce((n, s) => n + s.flaws.length, 0))

export function HistorySection({ cohort }: { cohort: FileState<CohortFile> }) {
  return (
    <Section
      id={HISTORY_SECTION_ID}
      title="5 · What the simulation caught"
      provenance="simulated"
      provenanceDetail="Cohort v0.1, v0.2 and v0.3 with the project's change records"
      description={`A simulation before a pilot is there to find what is wrong with the design while it costs nothing and harms no one. ${FLAW_COUNT} design flaws, found by the closed-loop simulation and by independent safety and privacy reviews, were fixed before any worker wore the system.`}
    >
      <div className="space-y-6">
        {FLAW_STEPS.map((step, i) => (
          <StepBlock key={step.id} step={step} offset={OFFSETS[i]} />
        ))}
        <FileGate state={cohort} label="Cohort history">
          {(file) => <HistoryTable v03={file} />}
        </FileGate>
        <MethodPanel
          method={
            <p>
              The same 45 site-days, workforce and seeds were re-run after each round of fixes, and{' '}
              <Code>scripts/validate/compare-cohorts.ts</Code> generated the version comparisons from the cohort files. The narrative above condenses
              the project&apos;s records; each card names its source.
            </p>
          }
          caveats={[
            'Each version also changed the simulated world (behaviour, drinking, schedules) or the metric definitions; the baseline rows show how much.',
            'A flaw list is not a safety case: it shows the process finds problems, not that none remain.',
          ]}
          docs={[
            { path: 'docs/dev/cohort-v0.1-vs-v0.2.md', label: 'Generated comparison: v0.1 vs v0.2' },
            { path: 'docs/dev/cohort-v0.2-vs-v0.3.md', label: 'Generated comparison: v0.2 vs v0.3' },
            { path: 'docs/VALIDATION-COHORT.md', label: 'VALIDATION-COHORT.md §3.8' },
          ]}
          extra={
            <p className="text-xs text-muted">
              Compare: <Code>npx tsx scripts/validate/compare-cohorts.ts</Code>
            </p>
          }
        />
      </div>
    </Section>
  )
}
