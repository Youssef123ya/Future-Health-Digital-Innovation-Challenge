import { Fragment, useMemo, useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { Badge, Section } from '../../components'
import { comparedDiff, referenceGroups, type ReferenceGroup } from './derive'
import { num, sig, toleranceUse, toleranceUseText, NBSP } from './format'
import { DisclosureButton, Kpi, KpiRow, PassBadge, TableFrame, TD, TH, UseMeter } from './parts'
import type { ReferenceCheck, ReferenceFile } from './types'
import { Code, FileGate, MethodPanel } from './ui'
import type { FileState } from './useEvidenceData'

export const REFERENCE_SECTION_ID = 'evidence-reference'

const KIND_LABEL: Readonly<Record<ReferenceCheck['kind'], string>> = {
  reference_implementation: 'Reference implementation',
  published_values: 'Published values',
}

function toleranceText(c: ReferenceCheck): string {
  const unit = c.unit && c.unit !== 'relative' ? `${NBSP}${c.unit}` : ''
  const value = c.tolerance === 0 ? '0 (exact)' : `${sig(c.tolerance, 3)}${unit}`
  if (c.toleranceKind === 'rms') return `RMS ≤ ${value}`
  if (c.toleranceKind === 'rel' || c.unit === 'relative') return `relative ≤ ${sig(c.tolerance, 3)}`
  return `|Δ| ≤ ${value}`
}

function diffText(c: ReferenceCheck): string {
  const unit = c.unit && c.unit !== 'relative' ? `${NBSP}${c.unit}` : ''
  return `${sig(c.maxAbsDiff, 3)}${unit}`
}

function CheckRows({ group, id }: { group: ReferenceGroup; id: string }) {
  return (
    <>
      {group.checks.map((c, i) => {
        const use = toleranceUse(comparedDiff(c), c.tolerance)
        return (
          <tr key={c.id} id={i === 0 ? id : undefined} className="bg-surface">
            <td className={`${TD} ps-9`}>
              <p className="font-medium text-ink">{c.title}</p>
              <p className="mt-0.5 font-mono text-[0.7rem] break-words text-subtle">{c.engine}</p>
              {c.note && <p className="mt-1 max-w-prose text-xs text-muted">{c.note}</p>}
            </td>
            <td className={`${TD} min-w-56`}>
              <Badge size="sm" tone={c.kind === 'published_values' ? 'info' : 'outline'}>
                {KIND_LABEL[c.kind] ?? c.kind}
              </Badge>
              <p className="mt-1 text-xs break-words text-ink">{c.reference}</p>
              <p className="mt-0.5 text-xs text-subtle">Quantity: {c.quantity}</p>
            </td>
            <td className={`${TD} text-end tabular-nums`}>
              {num(c.nCases)}
              <span className="block text-xs text-subtle">{num(c.nValues)} values</span>
            </td>
            <td className={`${TD} text-end whitespace-nowrap tabular-nums`}>
              {diffText(c)}
              {c.toleranceKind === 'rms' && typeof c.rmsDiff === 'number' && (
                <span className="block text-xs text-subtle">RMS {sig(c.rmsDiff, 3)}</span>
              )}
            </td>
            <td className={`${TD} text-end whitespace-nowrap tabular-nums`}>{toleranceText(c)}</td>
            <td className={`${TD} text-end`}>
              <UseMeter use={use} text={toleranceUseText(use)} />
            </td>
            <td className={`${TD} text-end`}>
              <PassBadge pass={c.pass} />
              {c.mismatches > 0 && <span className="block text-xs text-stop">{c.mismatches} mismatches</span>}
            </td>
          </tr>
        )
      })}
    </>
  )
}

function ReferenceTable({ groups }: { groups: readonly ReferenceGroup[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const allOpen = open.size === groups.length
  const toggle = (model: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(model)) next.delete(model)
      else next.add(model)
      return next
    })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Open a model to see each check, the reference it is compared with and its tolerance.</p>
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.model)))}
          className="h-8 rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-medium text-muted hover:bg-slate-50 hover:text-ink"
        >
          {allOpen ? 'Collapse all' : 'Expand all checks'}
        </button>
      </div>
      <TableFrame label="Reference agreement by model and check">
        <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Engine models against reference implementations and published values: cases, largest difference, tolerance,
            share of tolerance used and result.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-start`}>
                Model / check
              </th>
              <th scope="col" className={`${TH} text-start`}>
                Compared with
              </th>
              <th scope="col" className={`${TH} text-end`}>
                n cases
              </th>
              <th scope="col" className={`${TH} text-end`}>
                max |Δ|
              </th>
              <th scope="col" className={`${TH} text-end`}>
                Tolerance
              </th>
              <th scope="col" className={`${TH} text-end`}>
                Tolerance used
              </th>
              <th scope="col" className={`${TH} text-end`}>
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = open.has(g.model)
              const detailId = `ref-${g.model}`
              return (
                <Fragment key={g.model}>
                  <tr className="bg-canvas">
                    <th scope="row" className={`${TD} text-start font-normal`}>
                      <DisclosureButton open={isOpen} onToggle={() => toggle(g.model)} controls={isOpen ? detailId : undefined}>
                        <span className="font-semibold">{g.label}</span>
                      </DisclosureButton>
                    </th>
                    <td className={`${TD} text-xs text-muted`}>
                      {[
                        g.implementations ? `${g.implementations} vs reference implementation${g.implementations > 1 ? 's' : ''}` : null,
                        g.publishedSets ? `${g.publishedSets} vs published values` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    <td className={`${TD} text-end tabular-nums`}>
                      {g.total} check{g.total > 1 ? 's' : ''}
                      <span className="block text-xs text-subtle">{num(g.values)} values</span>
                    </td>
                    <td className={TD} />
                    <td className={TD} />
                    <td className={`${TD} text-end`}>
                      <UseMeter use={g.worstUse} text={toleranceUseText(g.worstUse)} />
                      <span className="block text-end text-[0.7rem] text-subtle">worst check</span>
                    </td>
                    <td className={`${TD} text-end`}>
                      <PassBadge pass={g.pass} label={`${g.passed}/${g.total}`} />
                    </td>
                  </tr>
                  {isOpen && <CheckRows group={g} id={detailId} />}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}

function ReferenceBody({ file }: { file: ReferenceFile }) {
  const groups = useMemo(() => referenceGroups(file), [file])
  const values = groups.reduce((s, g) => s + g.values, 0)
  const impl = file.checks.filter((c) => c.kind === 'reference_implementation').length
  const published = file.checks.length - impl
  const atLimit = file.checks.filter((c) => {
    const u = toleranceUse(comparedDiff(c), c.tolerance)
    return u !== null && u >= 0.9 && c.tolerance > 0
  }).length
  return (
    <div className="space-y-4">
      <KpiRow>
        <Kpi
          label="Checks passed"
          value={`${file.summary.passed} of ${file.summary.checks}`}
          icon={<BadgeCheck aria-hidden size={14} className="text-shade" />}
          hint={file.summary.allPass ? 'Every check within its tolerance' : 'At least one check fails: see the table'}
        />
        <Kpi label="Models checked" value={num(groups.length)} hint="Heat indices, ISO 7933, limits, physiology, simulation truth" />
        <Kpi label="Values compared" value={num(values)} hint="Engine output against the reference, value by value" />
        <Kpi
          label="Against independent code"
          value={num(impl)}
          unit="checks"
          hint={`${published} more against published tables and worked examples`}
        />
      </KpiRow>
      <ReferenceTable groups={groups} />
      <MethodPanel
        method={
          <>
            <p>
              Each check runs the engine on the reference&apos;s own fixture, with the options its unit test uses, and
              compares every value: |engine − reference|. Reference implementations are independent code (thermofeel,
              pvlib, pythermalcomfort, the USARIEM ECTemp algorithm, and Python oracles in <Code>scripts/oracles</Code>);
              published values are printed tables and worked examples (ISO 7933 Annex F, Brake &amp; Bates 2002, ACGIH
              Table 2, the NOAA heat-index chart).
            </p>
            {file.config?.note && <p className="text-muted">{file.config.note}</p>}
          </>
        }
        caveats={[
          'Agreement shows the code implements each published model as written. It does not show that the models fit Abu Dhabi workers (LIMITATIONS.md M-02, M-08).',
          `Printed tables are rounded, so their tolerances sit at the rounding step: ${atLimit} check${atLimit === 1 ? '' : 's'} use 90 % or more of the tolerance.`,
          'The Gagge two-node model is the simulation’s ground truth, deliberately different from the engine’s ISO 7933 model; it is checked so the simulated world is itself correct.',
        ]}
        script="scripts/validate/reference.ts"
        file={file}
        docs={[
          { path: 'docs/VALIDATION.md', label: 'VALIDATION.md §1 Reference agreement' },
          { path: 'docs/SCIENCE.md', label: 'SCIENCE.md: the models and their sources' },
          { path: 'docs/LIMITATIONS.md', label: 'LIMITATIONS.md: model limits' },
        ]}
      />
    </div>
  )
}

export function ReferenceSection({ state }: { state: FileState<ReferenceFile> }) {
  const detail =
    state.status === 'ready'
      ? `${state.data.summary.passed}/${state.data.summary.checks} checks · stamp ${state.data.stamp?.stamp ?? '—'}`
      : undefined
  return (
    <Section
      id={REFERENCE_SECTION_ID}
      title="1 · Reference agreement"
      provenance="reference"
      provenanceDetail={detail}
      description="Every model the engine uses, run against independent reference implementations and published values. A check passes when its largest difference is within the stated tolerance."
    >
      <FileGate state={state} label="Reference agreement">
        {(file) => <ReferenceBody file={file} />}
      </FileGate>
    </Section>
  )
}
