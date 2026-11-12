/**
 * Role × purpose matrix (privacy.ts ACCESS_MATRIX) as a grid: what each role may receive for each purpose, under which
 * conditions, and why. Prohibited purposes are hatched and refused for every role. Each cell has a tooltip with the
 * reason and basis; selecting a cell opens privacy.ts explain() for it. Static reference data: nothing individual.
 * Basis: ARCHITECTURE §7 and §9; GOVERNANCE §3.
 */
import { memo, useMemo, useState } from 'react'
import { Ban, CircleSlash, Grid3x3, HeartPulse, Lock, ShieldCheck, UsersRound, type LucideIcon } from 'lucide-react'
import type { Purpose, Role } from '../../../engine/types'
import { ACCESS_MATRIX, CONSENT_NOTICES, PROHIBITION_BASIS, PURPOSE_LABELS, ROLE_LABELS, explain, isProhibitedPurpose } from '../../../engine/privacy'
import { Badge, Card, CardHeader, Section, Tooltip, cx } from '../../components'
import {
  CONDITION_SHORT,
  PERMITTED_PURPOSES,
  PROHIBITED_PURPOSE_LIST,
  ROLE_ORDER,
  cellAriaLabel,
  citations,
  clip,
  matrixCell,
  type MatrixCellKind,
  type MatrixCellSummary,
} from './model'
import { FIELD_CLASS_ORDER, FieldChip, FieldClassLegend } from './ui'

const PURPOSES: readonly Purpose[] = [...PERMITTED_PURPOSES, ...PROHIBITED_PURPOSE_LIST]

/** Every cell, computed once (the matrix is frozen). */
const CELLS: readonly (readonly MatrixCellSummary[])[] = ROLE_ORDER.map((role) => PURPOSES.map((p) => matrixCell(role, p)))

const HATCH = 'bg-[repeating-linear-gradient(135deg,#ffe4e6_0_5px,#fff1f2_5px_11px)]'

const KIND_STYLE: Readonly<Record<MatrixCellKind, { icon: LucideIcon; cls: string; legend: string }>> = {
  individual: { icon: ShieldCheck, cls: 'border-shade-tint bg-shade-bg text-shade-dark hover:border-shade', legend: 'Individual fields, with conditions' },
  aggregate: { icon: UsersRound, cls: 'border-indigo-200 bg-indigo-50 text-indigo-900 hover:border-indigo-400', legend: 'Group totals only, small groups hidden' },
  none: { icon: CircleSlash, cls: 'border-dashed border-line-strong bg-surface text-muted hover:border-slate-400', legend: 'No access' },
  prohibited: { icon: Ban, cls: cx('border-rose-200 text-rose-900 hover:border-rose-400', HATCH), legend: 'Prohibited purpose: refused for every role and logged' },
}

function CellButton({
  cell,
  selected,
  onSelect,
  side,
  align,
}: {
  cell: MatrixCellSummary
  selected: boolean
  onSelect: () => void
  side: 'top' | 'bottom'
  align: 'start' | 'center' | 'end'
}) {
  const style = KIND_STYLE[cell.kind]
  const Icon = style.icon
  return (
    <Tooltip
      side={side}
      align={align}
      content={
        <>
          <span className="block font-semibold">
            {ROLE_LABELS[cell.role]} · {PURPOSE_LABELS[cell.purpose]}
          </span>
          <span className="mt-1 block">{clip(cell.reason, 170)}</span>
          <span className="mt-1 block text-slate-300">Basis: {clip(cell.basis, 150)}</span>
        </>
      }
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={cellAriaLabel(cell)}
        onClick={onSelect}
        className={cx(
          'flex min-h-[4.25rem] w-full flex-col items-start gap-1 rounded-md border p-2 text-start text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-shade',
          style.cls,
          selected && 'shadow-[0_0_0_2px_var(--color-ink)]',
        )}
      >
        <span className="inline-flex items-center gap-1 font-semibold">
          <Icon aria-hidden size={13} className="shrink-0" />
          {cell.kind === 'prohibited' ? 'Refused' : cell.kind === 'aggregate' ? 'Group totals' : cell.short}
        </span>
        {cell.kind === 'prohibited' && <span className="text-[11px] leading-4">Every request logged</span>}
        {cell.kind === 'aggregate' && (
          <span className="rounded bg-white/80 px-1 text-[11px] leading-4 font-medium ring-1 ring-indigo-200">
            Groups under {cell.aggregateMinCell} hidden
          </span>
        )}
        {cell.kind === 'individual' && (
          <span className="flex flex-wrap gap-1">
            {cell.conditions.map((c) => (
              <span key={c} className="rounded bg-white/80 px-1 text-[11px] leading-4 font-medium text-slate-700 ring-1 ring-line">
                {CONDITION_SHORT[c]}
              </span>
            ))}
          </span>
        )}
        {cell.clinical && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-800">
            <HeartPulse aria-hidden size={11} />
            Clinical fields
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/** Explanation of the selected cell (privacy.ts explain + the rule's grants). */
function CellDetail({ role, purpose }: { role: Role; purpose: Purpose }) {
  const rule = ACCESS_MATRIX[role][purpose]
  const ex = useMemo(() => explain({ role, purpose }), [role, purpose])
  const prohibited = isProhibitedPurpose(purpose)
  const cell = CELLS[ROLE_ORDER.indexOf(role)][PURPOSES.indexOf(purpose)]
  const style = KIND_STYLE[cell.kind]
  const Icon = style.icon
  return (
    <Card as="article" aria-labelledby="gov-matrix-detail-h" className="mt-4">
      <CardHeader
        id="gov-matrix-detail-h"
        as="h3"
        icon={Grid3x3}
        title={`${ROLE_LABELS[role]} · ${PURPOSE_LABELS[purpose]}`}
        description={rule.reason}
        actions={
          <span className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold', style.cls)}>
            <Icon aria-hidden size={13} />
            {cell.short}
          </span>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          {prohibited ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="flex items-start gap-2 font-semibold">
                <Ban aria-hidden size={16} className="mt-0.5 shrink-0" />
                Refused for every role, whatever the consent. Each refusal is written to the audit chain.
              </p>
              <p className="mt-1.5 ps-6">{PROHIBITION_BASIS[purpose as keyof typeof PROHIBITION_BASIS].reason}</p>
              <p className="mt-1.5 ps-6 text-xs">Consent cannot unlock it: workers may not waive their privacy rights (ILO code §5.13).</p>
            </div>
          ) : rule.grants.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong p-3 text-sm text-muted">
              <Lock aria-hidden size={15} />
              No individual record is released to this role for this purpose.
            </p>
          ) : (
            <div>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Released, and when</h4>
              <ul className="space-y-2.5">
                {rule.grants.map((g, i) => (
                  <li key={i} className="rounded-lg border border-line p-3">
                    <p className="text-sm text-ink">
                      {g.requires.length === 0 ? 'Always' : `When ${g.requires.map((c) => CONDITION_SHORT[c].toLowerCase()).join(' and ')}`}
                      <span className="text-muted"> · {g.reason}</span>
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Fields released">
                      {g.fields.map((f) => (
                        <li key={f}>
                          <FieldChip field={f} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ex.consentGated.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Also needs the worker’s consent</h4>
              <ul className="space-y-1 text-sm text-ink">
                {ex.consentGated.map(({ field, scope }) => (
                  <li key={field} className="flex flex-wrap items-center gap-1.5">
                    <FieldChip field={field} /> only while “{CONSENT_NOTICES[scope].title}” is on
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rule.aggregateMinCell !== null && (
            <p className="flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
              <UsersRound aria-hidden size={16} className="mt-0.5 shrink-0" />
              Group totals only. Every group smaller than {rule.aggregateMinCell} workers is hidden, with complementary suppression so a hidden
              group cannot be recovered by subtraction.
            </p>
          )}
          {!prohibited && ex.neverReleased.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer rounded font-medium text-shade-dark hover:underline">
                Never released for this purpose ({ex.neverReleased.length} fields)
              </summary>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {ex.neverReleased.map((f) => (
                  <li key={f}>
                    <FieldChip field={f} withheld />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div className="min-w-0">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Legal and ethical basis</h4>
          <ul className="space-y-1.5 text-sm text-ink">
            {citations(prohibited ? PROHIBITION_BASIS[purpose as keyof typeof PROHIBITION_BASIS].basis : rule.basis).map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-slate-400" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}

/** The matrix section. Memoised: it reads only frozen reference data. */
export const AccessMatrix = memo(function AccessMatrix() {
  const [sel, setSel] = useState<{ role: Role; purpose: Purpose }>({ role: 'supervisor', purpose: 'safety_alerting' })
  const lastRow = ROLE_ORDER.length - 1
  return (
    <Section
      id="gov-matrix"
      title="Role × purpose matrix"
      description="Who may see what, for which purpose, under which conditions. Every console request goes through this table in privacy.project(); select a cell for the full rule."
      provenance="engineering_default"
      provenanceDetail="The access rules in src/engine/privacy.ts (ACCESS_MATRIX)"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        {(Object.keys(KIND_STYLE) as MatrixCellKind[]).map((k) => {
          const s = KIND_STYLE[k]
          const Icon = s.icon
          return (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cx('inline-grid size-5 place-items-center rounded border', s.cls)}>
                <Icon size={12} />
              </span>
              {s.legend}
            </span>
          )
        })}
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
        <table className="w-full min-w-[66rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Role by purpose access matrix. Rows are roles, columns are purposes; each cell says what the role may receive.
          </caption>
          <thead>
            <tr>
              <td rowSpan={2} className="sticky start-0 z-10 w-40 border-b border-line bg-surface" />
              <th scope="colgroup" colSpan={PERMITTED_PURPOSES.length} className="border-b border-line px-2 pt-2.5 pb-1.5 text-start text-xs font-semibold text-shade-dark">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck aria-hidden size={14} />
                  Permitted purposes
                </span>
              </th>
              <th
                scope="colgroup"
                colSpan={PROHIBITED_PURPOSE_LIST.length}
                className="border-b border-s-2 border-rose-200 border-b-line bg-rose-50 px-2 pt-2.5 pb-1.5 text-start text-xs font-semibold text-rose-900"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Ban aria-hidden size={14} />
                  Prohibited purposes: refused for every role, whatever the consent
                </span>
              </th>
            </tr>
            <tr>
              {PURPOSES.map((p, i) => (
                <th
                  key={p}
                  scope="col"
                  className={cx(
                    'border-b border-line px-2 py-2 text-start align-bottom text-xs font-semibold',
                    isProhibitedPurpose(p) ? 'bg-rose-50 text-rose-900' : 'text-ink',
                    i === PERMITTED_PURPOSES.length && 'border-s-2 border-s-rose-200',
                  )}
                >
                  {PURPOSE_LABELS[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLE_ORDER.map((role, ri) => (
              <tr key={role}>
                <th
                  scope="row"
                  className={cx('sticky start-0 z-10 bg-surface px-3 py-1 text-start align-middle text-sm font-medium text-ink', ri < lastRow && 'border-b border-line')}
                >
                  {ROLE_LABELS[role]}
                </th>
                {CELLS[ri].map((cell, ci) => (
                  <td
                    key={cell.purpose}
                    className={cx(
                      'p-1 align-top [&>span]:flex [&>span]:w-full',
                      ri < lastRow && 'border-b border-line',
                      ci === PERMITTED_PURPOSES.length && 'border-s-2 border-s-rose-200',
                    )}
                  >
                    <CellButton
                      cell={cell}
                      selected={sel.role === role && sel.purpose === cell.purpose}
                      onSelect={() => setSel({ role, purpose: cell.purpose })}
                      side={ri < ROLE_ORDER.length / 2 ? 'bottom' : 'top'}
                      align={ci < 2 ? 'start' : ci > PURPOSES.length - 3 ? 'end' : 'center'}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Field classes:</span>
        {FIELD_CLASS_ORDER.map((c) => (
          <FieldClassLegend key={c} cls={c} />
        ))}
        <Badge tone="outline" size="sm">
          Any field not granted is withheld (default deny)
        </Badge>
      </div>
      <CellDetail role={sel.role} purpose={sel.purpose} />
    </Section>
  )
})
