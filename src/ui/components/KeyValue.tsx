import type { ReactNode } from 'react'
import { cx } from './cx'
import { ProvenanceTag, type ProvenanceKind } from './ProvenanceTag'

export interface KeyValueItem {
  /** Stable React key; the label is used when omitted. */
  id?: string
  label: ReactNode
  value: ReactNode
  /** Unit after the value, e.g. "°C", "W/m²", "mL/h". */
  unit?: string
  /** Small secondary line under the value. */
  hint?: ReactNode
  provenance?: ProvenanceKind
}

export interface KeyValueProps {
  items: readonly KeyValueItem[]
  /** `rows`: label start, value end, hairline dividers. `grid`: label over value in columns. */
  layout?: 'rows' | 'grid'
  /** Columns for the grid layout (2 on phones, more from sm up). */
  columns?: 2 | 3 | 4
  dense?: boolean
  className?: string
}

const GRID_COLUMNS = { 2: 'grid-cols-2', 3: 'grid-cols-2 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' } as const

function Value({ item }: { item: KeyValueItem }) {
  return (
    <>
      <span className="tabular-nums">{item.value}</span>
      {item.unit && <span className="ms-1 font-normal text-muted">{item.unit}</span>}
    </>
  )
}

/**
 * Definition list (`<dl>`) of labelled values, so assistive technology reads each label with its value (WCAG 2.2
 * SC 1.3.1). Values use tabular figures so columns of numbers align. [ENG] UI primitive.
 */
export function KeyValue({ items, layout = 'rows', columns = 2, dense = false, className }: KeyValueProps) {
  if (layout === 'grid') {
    return (
      <dl className={cx('grid gap-x-6', dense ? 'gap-y-2' : 'gap-y-4', GRID_COLUMNS[columns], className)}>
        {items.map((item, i) => (
          <div key={item.id ?? i} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
              {item.label}
              {item.provenance && <ProvenanceTag kind={item.provenance} />}
            </dt>
            <dd className="mt-0.5 text-base font-semibold text-ink">
              <Value item={item} />
              {item.hint && <div className="text-xs font-normal text-muted">{item.hint}</div>}
            </dd>
          </div>
        ))}
      </dl>
    )
  }
  return (
    <dl className={cx('divide-y divide-line', className)}>
      {items.map((item, i) => (
        <div key={item.id ?? i} className={cx('flex items-baseline justify-between gap-4', dense ? 'py-1.5' : 'py-2.5')}>
          <dt className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
            {item.label}
            {item.provenance && <ProvenanceTag kind={item.provenance} />}
          </dt>
          <dd className="text-end text-sm font-medium text-ink">
            <Value item={item} />
            {item.hint && <div className="text-xs font-normal text-muted">{item.hint}</div>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
