/**
 * Formatting and CSV export of k-suppressed aggregate tables (pure; unit-tested). A suppressed cell is always written as
 * "fewer than k" text — its count is not in the table object at all (privacy.ts PublishedCell), so it cannot leak here.
 */
import type { AggregateTable, PublishedCell } from '../../../engine/privacy'

/** Visible marker of a suppressed cell. */
export const suppressedMark = (k: number | null): string => (k === null ? 'n/a' : `<${k}`)

/** Plain-text wording of a suppressed cell (CSV, screen readers). */
export const suppressedText = (k: number | null): string => (k === null ? 'not available' : `fewer than ${k} (suppressed)`)

/** Tooltip/legend explanation of primary and complementary suppression. */
export function suppressionExplainer(k: number | null): string {
  const kk = k ?? 'k'
  return (
    `Not published. Either fewer than ${kk} workers are behind this cell (primary suppression), or the cell is hidden ` +
    `so that a small cell cannot be worked out from the row and column totals (complementary suppression). Which of ` +
    `the two applies is not published either, and the count is never shown.`
  )
}

/** A count for a table cell. */
export function cellText(c: PublishedCell | undefined, k: number | null): string {
  if (!c) return '—'
  return c.suppressed ? suppressedText(k) : String(c.count)
}

/** A share as a whole percentage ("—" when null). */
export const pct = (v: number | null, digits = 0): string => (v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)} %`)

/** Fixed-precision number ("—" when null). */
export const num = (v: number | null, digits = 0): string =>
  v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

// ─────────────────────────────── CSV ───────────────────────────────

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. A leading = + - @ is neutralised. */
export function csvField(v: string | number): string {
  let s = String(v)
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One aggregate table for the CSV export. */
export interface CsvTable {
  title: string
  /** Header of the row-label column, e.g. "Crew" or "Alert basis". */
  rowHeader: string
  rowLabel: (key: string) => string
  colLabel: (key: string) => string
  /** Purpose and decision line, e.g. "compliance_reporting · allowed". */
  note: string
  k: number | null
  table: AggregateTable | null
}

/**
 * CSV of k-suppressed tables: a metadata block (key,value) and each table with its row and column totals. Suppressed
 * cells are written as "fewer than k (suppressed)". Lines end with CRLF (RFC 4180).
 */
export function aggregatesCsv(meta: ReadonlyArray<readonly [string, string]>, tables: readonly CsvTable[]): string {
  const lines: string[] = []
  const row = (cells: ReadonlyArray<string | number>): void => {
    lines.push(cells.map(csvField).join(','))
  }
  row(['Zill aggregate export', 'k-suppressed; suppressed cells are never written as numbers'])
  for (const [k, v] of meta) row([k, v])
  for (const t of tables) {
    lines.push('')
    row(['Table', t.title])
    row(['Access', t.note])
    row(['Minimum cell size k', t.k === null ? 'denied' : String(t.k)])
    if (!t.table) {
      row(['No table released'])
      continue
    }
    const tb = t.table
    row([t.rowHeader, ...tb.cols.map(t.colLabel), 'Total'])
    tb.rows.forEach((r, i) => row([t.rowLabel(r), ...tb.cells[i].map((c) => cellText(c, t.k)), cellText(tb.rowTotals[i], t.k)]))
    row(['Total', ...tb.colTotals.map((c) => cellText(c, t.k)), cellText(tb.total, t.k)])
  }
  return lines.join('\r\n') + '\r\n'
}

/** Triggers a browser download of `text` (UTF-8 with BOM so spreadsheet apps read "–" and "≤" correctly). */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿', text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
