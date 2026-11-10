import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cx } from './cx'

/** Sortable value of a cell. null, undefined, NaN and '' count as missing. */
export type SortValue = number | string | null | undefined

export interface DataTableColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Enables sorting on this column. */
  sortValue?: (row: T) => SortValue
  align?: 'start' | 'center' | 'end'
  /** Numeric column: end-aligned, tabular figures, sorts descending first. */
  numeric?: boolean
  /** Hide the column below a breakpoint, keeping phone layouts free of horizontal page scroll. */
  hideBelow?: 'sm' | 'md' | 'lg'
  className?: string
}

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  columnId: string
  direction: SortDirection
}

const isMissing = (v: SortValue): boolean =>
  v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))

/**
 * Stable sort of rows by one column. Missing values always sort last in both directions ([ENG]: a row with no data is
 * never presented as the best or the safest). Numbers compare numerically; strings use natural, case-insensitive order
 * ("W-2" before "W-10").
 */
export function sortRows<T>(rows: readonly T[], columns: readonly DataTableColumn<T>[], sort: SortState | null): T[] {
  const column = sort ? columns.find((c) => c.id === sort.columnId) : undefined
  const get = column?.sortValue
  if (!sort || !get) return [...rows]
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, key: get(row) }))
    .sort((a, b) => {
      const am = isMissing(a.key)
      const bm = isMissing(b.key)
      if (am || bm) return am === bm ? a.index - b.index : am ? 1 : -1
      const cmp =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' })
      return cmp !== 0 ? cmp * sign : a.index - b.index
    })
    .map((entry) => entry.row)
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  /** Table caption (required for an accessible name); can be visually hidden. */
  caption: ReactNode
  hideCaption?: boolean
  initialSort?: SortState
  /** Controlled sort state. */
  sort?: SortState | null
  onSortChange?: (sort: SortState) => void
  /** Shown in place of rows when there are none. */
  empty?: ReactNode
  dense?: boolean
  /** Sticky header inside a scrolling container (set `maxHeight`). */
  stickyHeader?: boolean
  maxHeight?: number | string
  rowClassName?: (row: T) => string | undefined
  className?: string
}

const ALIGN = { start: 'text-start', center: 'text-center', end: 'text-end' } as const
const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const

function alignOf<T>(col: DataTableColumn<T>): keyof typeof ALIGN {
  return col.align ?? (col.numeric ? 'end' : 'start')
}

/**
 * Simple sortable table for consoles. Sorting buttons live in the column headers and the sorted column carries
 * `aria-sort` (WAI-ARIA APG Sortable Table). The table scrolls inside its own container so a narrow screen never gets
 * horizontal page scroll. Missing values sort last (see {@link sortRows}).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  hideCaption = false,
  initialSort,
  sort: controlledSort,
  onSortChange,
  empty,
  dense = false,
  stickyHeader = false,
  maxHeight,
  rowClassName,
  className,
}: DataTableProps<T>) {
  const [innerSort, setInnerSort] = useState<SortState | null>(initialSort ?? null)
  const sort = controlledSort !== undefined ? controlledSort : innerSort
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort])

  const toggle = (col: DataTableColumn<T>) => {
    const next: SortState =
      sort?.columnId === col.id
        ? { columnId: col.id, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId: col.id, direction: col.numeric ? 'desc' : 'asc' }
    if (controlledSort === undefined) setInnerSort(next)
    onSortChange?.(next)
  }

  return (
    <div
      className={cx('overflow-auto rounded-xl border border-line bg-surface', className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className={hideCaption ? 'sr-only' : 'px-3 pt-3 pb-2 text-start text-sm font-semibold text-ink'}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort?.columnId === col.id
              const align = alignOf(col)
              const SortIcon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={col.sortValue && active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cx(
                    'border-b border-line bg-canvas px-3 py-2 text-xs font-semibold whitespace-nowrap text-muted',
                    ALIGN[align],
                    stickyHeader && 'sticky top-0 z-10',
                    col.hideBelow && HIDE[col.hideBelow],
                    col.className,
                  )}
                >
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(col)}
                      className={cx(
                        'inline-flex items-center gap-1 rounded hover:text-ink',
                        align === 'end' && 'flex-row-reverse',
                        active && 'text-ink',
                      )}
                    >
                      {col.header}
                      <SortIcon aria-hidden size={13} className={active ? 'opacity-100' : 'opacity-50'} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-muted">
                {empty ?? 'No rows to show'}
              </td>
            </tr>
          ) : (
            sorted.map((row, r) => (
              <tr key={rowKey(row)} className={cx('hover:bg-canvas', rowClassName?.(row))}>
                {columns.map((col) => (
                  <td
                    key={col.id}
                    className={cx(
                      dense ? 'px-3 py-1.5' : 'px-3 py-2.5',
                      r < sorted.length - 1 && 'border-b border-line',
                      ALIGN[alignOf(col)],
                      col.numeric && 'tabular-nums',
                      col.hideBelow && HIDE[col.hideBelow],
                      col.className,
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
