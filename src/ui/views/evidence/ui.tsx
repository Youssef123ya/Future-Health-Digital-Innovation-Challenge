import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle, BarChart3, ExternalLink, FileWarning, Loader2, Table2, Terminal } from 'lucide-react'
import { EmptyState, cx } from '../../components'
import type { Est, ValidationFileBase } from './types'
import { estText, shortHash } from './format'
import type { FileState } from './useEvidenceData'

/**
 * Source documents live in the repository, not in the deployed app (docs/ is not under public/), so links point at the
 * repository's default branch. Taken from the project's git remote; change here if the repository moves.
 */
export const DOCS_BASE = 'https://github.com/Youssef123ya/Future-Health-Digital-Innovation-Challenge/blob/main/'

/**
 * Chart colours. Marks use the dataviz reference palette (categorical slots 1–3 validated all-pairs on white:
 * worst CVD ΔE 9.2, normal-vision ΔE 24.0; aqua is below 3:1, so every chart carries a legend and a table view) and its
 * blue ordinal ramp (steps 250–650, validated --ordinal). Risk-level colours are never used for data series: they are
 * reserved for risk levels with pictogram and text (WCAG 2.2 SC 1.4.1). Chrome uses the app's slate tokens.
 */
export const COLORS = {
  series: ['#2a78d6', '#eb6834', '#1baf7a'] as const,
  ordinal5: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'] as const,
  ordinal3: ['#86b6ef', '#2a78d6', '#104281'] as const,
  pairLight: '#6da7ec',
  pairDark: '#1c5cab',
  context: '#64748b',
  contextSoft: '#cbd5e1',
  grid: '#e2e8f0',
  axis: '#cbd5e1',
  tick: '#64748b',
  ink: '#0b1220',
  band: '#f1f5f9',
  bandStroke: '#cbd5e1',
} as const

export const AXIS = {
  tick: { fill: COLORS.tick, fontSize: 12 },
  axisLine: { stroke: COLORS.axis },
  tickLine: false,
} as const

/** Chart margin that leaves room for axis titles without clipping tick labels. */
export const CHART_MARGIN = { top: 8, right: 16, bottom: 4, left: 4 } as const

// ─── Links and small text pieces ────────────────────────────────────────────────────────────────────────────────────

export function DocLink({ path, label, className }: { path: string; label?: ReactNode; className?: string }) {
  return (
    <a
      href={`${DOCS_BASE}${path}`}
      target="_blank"
      rel="noreferrer"
      className={cx('inline-flex items-center gap-1 rounded font-medium text-shade-dark underline decoration-shade-tint underline-offset-2 hover:decoration-shade', className)}
    >
      {label ?? <code className="font-mono text-[0.85em]">{path}</code>}
      <ExternalLink aria-hidden size={13} className="shrink-0" />
      <span className="sr-only">(opens the repository in a new tab)</span>
    </a>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>
}

/** A value with its interval or bound on a muted line below (tables) or inline. */
export function EstValue({ est, precision = 1, scale = 1, unit, inline = false }: { est: Est | null | undefined; precision?: number; scale?: number; unit?: string; inline?: boolean }) {
  const t = estText(est, precision, scale)
  return (
    <span className={cx('tabular-nums', inline ? 'whitespace-nowrap' : 'inline-flex flex-col items-end leading-tight')}>
      <span className="font-medium text-ink">
        {t.value}
        {unit && t.value !== '—' ? <span className="font-normal text-muted"> {unit}</span> : null}
      </span>
      {t.detail && (
        <span className={cx('text-xs text-subtle', inline && 'ms-1')}>
          <span aria-hidden>{t.detail}</span>
          <span className="sr-only">{t.detailLabel}</span>
        </span>
      )}
    </span>
  )
}

export function StampLine({ file }: { file: ValidationFileBase }) {
  return (
    <p className="text-xs break-words text-subtle">
      Stamp <Code>{file.stamp?.stamp ?? '—'}</Code> · code SHA-256 {shortHash(file.stamp?.codeSha256)}… over{' '}
      {file.stamp?.codeFiles ?? '—'} files · inputs SHA-256 {shortHash(file.stamp?.inputsSha256)}… over {file.provenance?.inputs?.length ?? '—'} files
    </p>
  )
}

// ─── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SelectOption {
  id: string
  label: string
}

export function SelectField({ label, value, options, onChange, className }: { label: string; value: string; options: readonly SelectOption[]; onChange: (id: string) => void; className?: string }) {
  const id = useId()
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 min-w-0 rounded-lg border border-line-strong bg-surface ps-3 pe-8 text-sm text-ink hover:border-subtle"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── Charts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LegendShape = 'rect' | 'line' | 'dot' | 'diamond' | 'dash' | 'band' | 'errorbar'

export interface LegendItem {
  label: ReactNode
  color: string
  shape?: LegendShape
}

function Swatch({ color, shape = 'rect' }: { color: string; shape?: LegendShape }) {
  return (
    <svg aria-hidden width="18" height="12" viewBox="0 0 18 12" className="shrink-0">
      {shape === 'rect' && <rect x="2" y="1" width="14" height="10" rx="2" fill={color} />}
      {shape === 'line' && <line x1="1" y1="6" x2="17" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" />}
      {shape === 'dash' && <line x1="1" y1="6" x2="17" y2="6" stroke={color} strokeWidth="2" strokeDasharray="4 3" />}
      {shape === 'dot' && <circle cx="9" cy="6" r="4.5" fill={color} />}
      {shape === 'diamond' && <path d="M9 0.8 14.2 6 9 11.2 3.8 6Z" fill={color} />}
      {shape === 'band' && <rect x="1" y="1" width="16" height="10" rx="2" fill={color} stroke={COLORS.bandStroke} />}
      {shape === 'errorbar' && <path d="M3 6h12M3 3v6M15 3v6" stroke={color} strokeWidth="1.5" fill="none" />}
    </svg>
  )
}

export function LegendList({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  return (
    <ul className={cx('flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted', className)}>
      {items.map((item, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <Swatch color={item.color} shape={item.shape} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

export interface TipLine {
  label: ReactNode
  value: ReactNode
  color?: string
  shape?: LegendShape
}

/** Tooltip body: values lead (strong), labels follow (muted); series keyed with a short line, not a box. */
export function ChartTip({ title, lines, note }: { title: ReactNode; lines: readonly TipLine[]; note?: ReactNode }) {
  return (
    <div className="max-w-72 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-ink">{title}</p>
      <ul className="space-y-0.5">
        {lines.map((l, i) => (
          <li key={i} className="flex items-center gap-2">
            {l.color && <Swatch color={l.color} shape={l.shape ?? 'line'} />}
            <span className="font-semibold text-ink tabular-nums">{l.value}</span>
            <span className="text-muted">{l.label}</span>
          </li>
        ))}
      </ul>
      {note && <p className="mt-1 text-subtle">{note}</p>}
    </div>
  )
}

/** The data row behind the active tooltip (recharts passes it as payload[0].payload). */
export function tipRow<T>(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }): T | null {
  if (!props.active || !props.payload?.length) return null
  return (props.payload[0]?.payload as T) ?? null
}

export interface ChartFrameProps {
  title: string
  description?: ReactNode
  legend?: readonly LegendItem[]
  /** One-sentence summary for screen readers (also the chart's SVG description). */
  summary: string
  /** The table view: the accessible twin with every plotted value. */
  table: ReactNode
  height: number
  children: ReactNode
  footnote?: ReactNode
  actions?: ReactNode
  className?: string
}

/** A chart card with title, legend, a chart/table toggle and footnote. The chart area height includes its axis band. */
export function ChartFrame({ title, description, legend, summary, table, height, children, footnote, actions, className }: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false)
  const summaryId = useId()
  return (
    <figure className={cx('flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 shadow-xs', className)} aria-describedby={summaryId}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {description && <figcaption className="mt-0.5 text-xs text-muted">{description}</figcaption>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={() => setShowTable((s) => !s)}
            aria-pressed={showTable}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-medium text-muted hover:bg-slate-50 hover:text-ink"
          >
            {showTable ? <BarChart3 aria-hidden size={14} /> : <Table2 aria-hidden size={14} />}
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </div>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      {legend && !showTable && <LegendList items={legend} className="mb-2" />}
      {showTable ? (
        <div className="min-w-0">{table}</div>
      ) : (
        <div className="min-w-0" style={{ height }}>
          {children}
        </div>
      )}
      {footnote && <div className="mt-2 text-xs text-subtle">{footnote}</div>}
    </figure>
  )
}

/** A compact accessible table for chart twins (numbers end-aligned, tabular figures). */
export function MiniTable({ caption, head, rows, className }: { caption: string; head: readonly ReactNode[]; rows: readonly (readonly ReactNode[])[]; className?: string }) {
  return (
    <div className={cx('max-h-96 overflow-auto rounded-lg border border-line', className)}>
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-slate-50">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cx('border-b border-line px-2.5 py-2 font-semibold text-muted', i === 0 ? 'text-start' : 'text-end')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line last:border-b-0">
              {r.map((c, ci) =>
                ci === 0 ? (
                  <th key={ci} scope="row" className="px-2.5 py-1.5 text-start font-medium text-ink">
                    {c}
                  </th>
                ) : (
                  <td key={ci} className="px-2.5 py-1.5 text-end text-ink tabular-nums">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Section furniture ──────────────────────────────────────────────────────────────────────────────────────────────

export interface MethodPanelProps {
  method: ReactNode
  caveats: readonly ReactNode[]
  /** Script that writes the file (shown under "Reproduce"). */
  script?: string
  file?: ValidationFileBase
  docs: readonly { path: string; label: string }[]
  extra?: ReactNode
}

/** Method, caveats and how to reproduce: the same three blocks in every section. */
export function MethodPanel({ method, caveats, script, file, docs, extra }: MethodPanelProps) {
  return (
    <div className="grid gap-4 rounded-xl border border-line bg-canvas p-4 text-sm lg:grid-cols-[1.25fr_1.25fr_1fr]">
      <div className="min-w-0">
        <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Method</h3>
        <div className="space-y-2 text-ink">{method}</div>
      </div>
      <div className="min-w-0">
        <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
          <AlertTriangle aria-hidden size={13} /> Caveats
        </h3>
        <ul className="list-disc space-y-1 ps-4 text-ink marker:text-subtle">
          {caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
          <Terminal aria-hidden size={13} /> Reproduce
        </h3>
        <p className="font-mono text-[0.8rem] text-ink">
          <span aria-hidden className="text-subtle select-none">$ </span>npm run validate
        </p>
        {script && (
          <p className="text-xs text-muted">
            Writes this file with <Code>{script}</Code>; deterministic for a given code and input stamp.
          </p>
        )}
        {file && <StampLine file={file} />}
        <ul className="space-y-1 text-xs">
          {docs.map((d) => (
            <li key={d.path}>
              <DocLink path={d.path} label={d.label} />
            </li>
          ))}
        </ul>
        {extra}
      </div>
    </div>
  )
}

/** Renders `children(data)` when a file is ready; otherwise an explicit loading, missing or error state. */
export function FileGate<T>({ state, label, missingHint, children }: { state: FileState<T>; label: string; missingHint?: ReactNode; children: (data: T) => ReactNode }) {
  if (state.status === 'ready') return <>{children(state.data)}</>
  if (state.status === 'loading') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">
        <Loader2 aria-hidden size={16} className="animate-spin motion-reduce:animate-none" /> Loading {label}…
      </div>
    )
  }
  if (state.status === 'missing') {
    return (
      <EmptyState
        tone="unavailable"
        icon={FileWarning}
        title={`${label}: not generated yet`}
        description={
          <>
            <Code>{state.path.replace('./', 'public/')}</Code> is not in this build. Run <Code>npm run validate</Code> to
            generate it. {missingHint}
          </>
        }
      />
    )
  }
  return (
    <EmptyState
      tone="unavailable"
      icon={FileWarning}
      title={`${label}: could not be read`}
      description={
        <>
          <Code>{state.path.replace('./', 'public/')}</Code>: {state.message}. Nothing from this file is shown.
        </>
      }
    />
  )
}

/** A bordered note for key readings and disclaimers. */
export function Callout({ icon: Icon, title, children, tone = 'neutral', className }: { icon?: typeof AlertTriangle; title?: ReactNode; children: ReactNode; tone?: 'neutral' | 'brand' | 'caution'; className?: string }) {
  return (
    <div
      className={cx(
        'flex gap-3 rounded-xl border p-4 text-sm',
        tone === 'brand' && 'border-shade-tint bg-shade-bg',
        tone === 'neutral' && 'border-line bg-surface',
        tone === 'caution' && 'border-amber-300 bg-amber-50',
        className,
      )}
    >
      {Icon && <Icon aria-hidden size={18} className={cx('mt-0.5 shrink-0', tone === 'caution' ? 'text-amber-800' : 'text-shade')} />}
      <div className="min-w-0 space-y-1 text-ink">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  )
}
