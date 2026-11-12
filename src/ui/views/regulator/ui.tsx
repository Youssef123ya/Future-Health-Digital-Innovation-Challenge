/**
 * Shared pieces of the regulator / HSE view: the suppressed-cell marker, the k-suppressed table renderer, level column
 * headers, a segmented filter and the "show data table" disclosure. Risk levels always appear as colour + pictogram +
 * text; tables keep tabular figures; layouts use logical properties (RTL-ready).
 */
import type { ReactNode } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import type { AggregateTable, PublishedCell } from '../../../engine/privacy'
import type { RiskLevel } from '../../../engine/types'
import { DEFAULT_LEVEL_LABELS, InfoTip, LEVEL_STYLES, Tooltip, cx } from '../../components'
import { suppressedMark, suppressedText, suppressionExplainer } from './format'

/** The released form of a k-suppressed table (privacy.aggregateFor result, as the selectors return it). */
export interface ReleasedTable {
  decision: 'allowed' | 'denied'
  k: number | null
  table: AggregateTable | null
  reason: string
}

const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 4px, rgba(71, 85, 105, 0.16) 4px 5px)' }

/** A suppressed cell: "fewer than k" marker with a tooltip on primary and complementary suppression; never a number. */
export function SuppressedMark({ k, className }: { k: number | null; className?: string }) {
  return (
    <Tooltip content={suppressionExplainer(k)} align="end">
      <span
        className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-muted ring-1 ring-line ring-inset', className)}
        style={HATCH}
      >
        <Lock aria-hidden size={11} strokeWidth={2.5} />
        <span aria-hidden>{suppressedMark(k)}</span>
        <span className="sr-only">{suppressedText(k)}</span>
      </span>
    </Tooltip>
  )
}

/** A published count (zero muted) or the suppressed marker. */
export function CountCell({ cell, k, strong }: { cell: PublishedCell | undefined; k: number | null; strong?: boolean }) {
  if (!cell) return <span className="text-subtle">—</span>
  if (cell.suppressed) return <SuppressedMark k={k} />
  return <span className={cx('tabular-nums', cell.count === 0 ? 'text-subtle' : 'text-ink', strong && 'font-semibold')}>{cell.count.toLocaleString('en-US')}</span>
}

/** Compact level column header: pictogram in the level colour + the level name (colour is never the only cue). */
export function LevelHeader({ level, short }: { level: RiskLevel; short?: boolean }) {
  const s = LEVEL_STYLES[level]
  const Icon = s.icon
  const label = DEFAULT_LEVEL_LABELS[level]
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Icon aria-hidden size={16} className={s.mark} strokeWidth={2.25} />
      <span className="text-[11px] leading-tight font-semibold text-ink">{short ? label.replace(' risk', '').replace(' work', '') : label}</span>
    </span>
  )
}

/** One extra computed column of an {@link AggregateGrid} (e.g. a share); `row` is null for the total row. */
export interface GridExtraColumn {
  id: string
  header: ReactNode
  cell: (row: string | null) => ReactNode
}

export interface AggregateGridProps {
  /** Accessible table name (visually hidden). */
  caption: string
  released: ReleasedTable | null
  rowHeader: string
  rowLabel: (key: string) => ReactNode
  colLabel: (key: string) => ReactNode
  extra?: readonly GridExtraColumn[]
  /** Hide the total column (the row totals) — the total row is always shown. */
  hideRowTotals?: boolean
  totalLabel?: string
  className?: string
}

/**
 * A k-suppressed two-way table: published counts, suppressed cells as "fewer than k", row and column totals (which
 * are suppressed by the same rules). A refused request shows the refusal reason instead.
 */
export function AggregateGrid({ caption, released, rowHeader, rowLabel, colLabel, extra = [], hideRowTotals, totalLabel = 'Total', className }: AggregateGridProps) {
  if (!released) return null
  if (released.decision === 'denied' || !released.table) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong bg-canvas px-3 py-2 text-sm text-muted">
        <span className="font-semibold text-ink">Refused and logged. </span>
        {released.reason}
      </p>
    )
  }
  const t = released.table
  const k = released.k
  return (
    <div className={cx('-mx-1 overflow-x-auto px-1', className)}>
      <table className="w-full min-w-max border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="py-2 pe-3 text-start align-bottom text-xs font-semibold text-muted">
              {rowHeader}
            </th>
            {t.cols.map((c) => (
              <th key={c} scope="col" className="px-2 py-2 text-end align-bottom text-xs font-semibold text-muted">
                {colLabel(c)}
              </th>
            ))}
            {!hideRowTotals && (
              <th scope="col" className="ps-2 py-2 text-end align-bottom text-xs font-semibold text-muted">
                {totalLabel}
              </th>
            )}
            {extra.map((x) => (
              <th key={x.id} scope="col" className="ps-3 py-2 text-end align-bottom text-xs font-semibold text-muted">
                {x.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={r} className="border-b border-line/70">
              <th scope="row" className="max-w-48 py-2 pe-3 text-start font-medium text-ink">
                {rowLabel(r)}
              </th>
              {t.cells[i].map((c, j) => (
                <td key={t.cols[j]} className="px-2 py-2 text-end">
                  <CountCell cell={c} k={k} />
                </td>
              ))}
              {!hideRowTotals && (
                <td className="ps-2 py-2 text-end">
                  <CountCell cell={t.rowTotals[i]} k={k} strong />
                </td>
              )}
              {extra.map((x) => (
                <td key={x.id} className="ps-3 py-2 text-end tabular-nums text-ink">
                  {x.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="py-2 pe-3 text-start text-xs font-semibold tracking-wide text-muted uppercase">
              {totalLabel}
            </th>
            {t.colTotals.map((c, j) => (
              <td key={t.cols[j]} className="px-2 py-2 text-end">
                <CountCell cell={c} k={k} strong />
              </td>
            ))}
            {!hideRowTotals && (
              <td className="ps-2 py-2 text-end">
                <CountCell cell={t.total} k={k} strong />
              </td>
            )}
            {extra.map((x) => (
              <td key={x.id} className="ps-3 py-2 text-end font-semibold tabular-nums text-ink">
                {x.cell(null)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** Legend line under a k-suppressed table: what the marker means, with the full explanation in a tip. */
export function SuppressionLegend({ released, unit = 'workers' }: { released: ReleasedTable | null; unit?: string }) {
  if (!released || released.decision !== 'allowed') return null
  const n = released.table?.suppressedCells ?? 0
  return (
    <div className="mt-2 flex items-start gap-2 text-xs text-muted">
      <SuppressedMark k={released.k} className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        fewer than {released.k} {unit} behind the cell, or hidden to protect one (complementary suppression).
        {n > 0 ? ` ${n} cell${n === 1 ? '' : 's'} suppressed, totals included.` : ' No cell suppressed.'}
        <InfoTip content={suppressionExplainer(released.k)} label="How small-cell suppression works" className="-my-1 ms-0.5 inline-grid size-5 align-middle" />
      </p>
    </div>
  )
}

/** A segmented filter: one pressed button at a time (aria-pressed), keyboard focusable. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
}: {
  label: string
  value: T
  options: ReadonlyArray<{ id: T; label: ReactNode }>
  onChange: (id: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cx(
              'rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-shade',
              size === 'sm' ? 'min-h-8 px-2.5 text-xs' : 'min-h-9 px-3 text-sm',
              on ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:bg-white/60 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** "Show data table" disclosure (native details/summary: keyboard and screen-reader friendly). */
export function DataDisclosure({ summary = 'Show data table', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group mt-3 rounded-lg border border-line bg-canvas/60">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 px-3 text-xs font-semibold text-muted select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden size={14} className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="border-t border-line px-3 pt-2 pb-3">{children}</div>
    </details>
  )
}

/** A small "label: value" line used in card footers. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-xs text-muted">
      <span className="font-medium text-ink">{label}: </span>
      {children}
    </p>
  )
}
