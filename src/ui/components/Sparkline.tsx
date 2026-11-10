import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import type { RiskLevel } from '../../engine/types'
import { cx } from './cx'
import { formatNumber } from './format'
import { LEVEL_STYLES } from './levels'

/** A horizontal reference line, e.g. an exposure limit. */
export interface SparklineThreshold {
  value: number
  /** Colours the line with the level's mark colour; neutral grey when omitted. */
  level?: RiskLevel
  /** Name used in the accessible summary, e.g. "REL". */
  label?: string
}

export interface SparklineProps {
  /** Evenly spaced samples, oldest first. `null` is a gap: missing data is drawn as missing, never interpolated. */
  values: ReadonlyArray<number | null>
  /** Accessible name, e.g. "WBGT in the sun, 06:00–18:00". */
  label: string
  unit?: string
  /** Decimals in the summary and hover readout. */
  precision?: number
  /** Width in px (ignored when `fluid`). */
  width?: number
  height?: number
  /** Fill the container width (measured, so marks are never stretched). */
  fluid?: boolean
  /** Fixed y-domain; by default the data extent, widened to include the thresholds. */
  domain?: readonly [number, number]
  thresholds?: readonly SparklineThreshold[]
  /** Index of the first model-projected sample; projected values are drawn dashed (ARCHITECTURE.md §1 principle 7). */
  projectionFrom?: number
  /** Soft area wash under the observed line. */
  area?: boolean
  /** Colour by risk level; brand teal when omitted. */
  level?: RiskLevel
  /** Marks the latest observed value. */
  showEndDot?: boolean
  /** Per-sample labels for the hover readout, e.g. "14:00". */
  pointLabels?: ReadonlyArray<string>
  /** Hover crosshair + readout (pointer only; the accessible summary carries the same facts). */
  interactive?: boolean
  className?: string
}

interface Pt {
  i: number
  x: number
  y: number
  v: number
}

/** Inner padding: an r = 4 end dot plus its 2 px surface ring is never clipped. */
const PAD = 6

function toRuns(points: ReadonlyArray<Pt | null>): Pt[][] {
  const runs: Pt[][] = []
  let current: Pt[] = []
  for (const p of points) {
    if (p) current.push(p)
    else if (current.length) {
      runs.push(current)
      current = []
    }
  }
  if (current.length) runs.push(current)
  return runs
}

const r2 = (n: number) => Math.round(n * 100) / 100

function linePath(run: readonly Pt[]): string {
  // A zero-length subpath with a round cap renders an isolated sample as a dot.
  if (run.length === 1) return `M${r2(run[0].x)} ${r2(run[0].y)}h0`
  return run.map((p, k) => `${k === 0 ? 'M' : 'L'}${r2(p.x)} ${r2(p.y)}`).join('')
}

function areaPath(run: readonly Pt[], baseY: number): string {
  if (run.length < 2) return ''
  const first = run[0]
  const last = run[run.length - 1]
  return `M${r2(first.x)} ${r2(baseY)}${run.map((p) => `L${r2(p.x)} ${r2(p.y)}`).join('')}L${r2(last.x)} ${r2(baseY)}Z`
}

function useMeasuredWidth(enabled: boolean, fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      if (w > 0) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled])
  return [ref, enabled ? width : fallback] as const
}

function Dot({ pt }: { pt: Pt }) {
  return (
    <g>
      <circle cx={pt.x} cy={pt.y} r={6} className="fill-surface" />
      <circle cx={pt.x} cy={pt.y} r={4} fill="currentColor" />
    </g>
  )
}

/**
 * Word-sized trend line. Mark specs: 2 px line with round joins, r = 4 end dot with a 2 px surface ring, ~10 % area
 * wash, 1 px solid reference lines. Gaps stay gaps (missing data is never smoothed into reassurance, ARCHITECTURE.md §1
 * principle 3) and model projections are dashed (§1 principle 7). The chart exposes a text summary (latest, range, gaps,
 * projection, reference lines) as its accessible name (WCAG 2.2 SC 1.1.1). Time runs left to right in every language.
 */
export function Sparkline({
  values,
  label,
  unit,
  precision = 1,
  width = 120,
  height = 32,
  fluid = false,
  domain,
  thresholds = [],
  projectionFrom,
  area = false,
  level,
  showEndDot = true,
  pointLabels,
  interactive = true,
  className,
}: SparklineProps) {
  const titleId = useId()
  const [boxRef, measured] = useMeasuredWidth(fluid, width)
  const [hover, setHover] = useState<number | null>(null)

  const w = Math.max(measured, 2 * PAD + 2)
  const h = Math.max(height, 2 * PAD + 2)
  const n = values.length
  const split = projectionFrom === undefined ? n : Math.max(0, Math.min(projectionFrom, n))

  const finite: number[] = []
  for (const v of values) if (v !== null && Number.isFinite(v)) finite.push(v)

  let lo: number
  let hi: number
  if (domain) {
    ;[lo, hi] = domain
  } else {
    const pool = finite.concat(thresholds.map((t) => t.value))
    lo = pool.length ? Math.min(...pool) : 0
    hi = pool.length ? Math.max(...pool) : 1
  }
  if (!(hi - lo > 1e-9)) {
    lo -= 1
    hi += 1
  }

  const innerW = w - 2 * PAD
  const innerH = h - 2 * PAD
  const x = (i: number) => PAD + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1))
  const y = (v: number) => Math.min(h, Math.max(0, PAD + innerH - ((v - lo) / (hi - lo)) * innerH))
  const points: Array<Pt | null> = values.map((v, i) =>
    v !== null && Number.isFinite(v) ? { i, x: x(i), y: y(v), v } : null,
  )

  const observedRuns = toRuns(points.slice(0, split))
  const projectedRuns = split < n ? toRuns(points.slice(Math.max(0, split - 1))) : []
  let endPoint: Pt | null = null
  for (let i = split - 1; i >= 0 && !endPoint; i--) endPoint = points[i]

  const fmt = (v: number) => formatNumber(v, precision)
  const u = unit ? ` ${unit}` : ''
  const summaryParts: string[] = []
  if (finite.length === 0) {
    summaryParts.push(`${label}: no data`)
  } else {
    summaryParts.push(`${label}: latest ${endPoint ? `${fmt(endPoint.v)}${u}` : 'not observed'}`)
    summaryParts.push(`range ${fmt(Math.min(...finite))} to ${fmt(Math.max(...finite))}${u} over ${n} points`)
    if (finite.length < n) summaryParts.push(`${n - finite.length} missing`)
    if (split < n) summaryParts.push(`the last ${n - split} are a model projection`)
    if (thresholds.length) {
      summaryParts.push(
        `reference ${thresholds.map((t) => `${t.label ? `${t.label} ` : ''}${fmt(t.value)}${u}`).join(', ')}`,
      )
    }
  }

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || n === 0) return
    const px = ((e.clientX - rect.left) / rect.width) * w
    const guess = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - PAD) / innerW) * (n - 1))))
    for (let d = 0; d < n; d++) {
      if (points[guess - d]) return setHover(guess - d)
      if (points[guess + d]) return setHover(guess + d)
    }
    setHover(null)
  }

  const hoverPt = hover !== null ? points[hover] ?? null : null
  const lineColor = level ? LEVEL_STYLES[level].mark : 'text-shade'
  const readoutAlign = hoverPt
    ? hoverPt.x < 56
      ? 'translate-x-0'
      : hoverPt.x > w - 56
        ? '-translate-x-full'
        : '-translate-x-1/2'
    : ''

  return (
    <div
      ref={boxRef}
      dir="ltr"
      className={cx('relative', fluid ? 'block w-full' : 'inline-block', className)}
      style={fluid ? { height: h } : { width: w, height: h }}
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-labelledby={titleId}
        className={cx('block overflow-visible', lineColor)}
        onPointerMove={interactive && finite.length > 0 ? onPointerMove : undefined}
        onPointerLeave={interactive ? () => setHover(null) : undefined}
      >
        <title id={titleId}>{summaryParts.join('; ')}</title>
        {thresholds.map((t, k) =>
          t.value >= lo && t.value <= hi ? (
            <line
              key={`t${k}`}
              x1={PAD}
              x2={w - PAD}
              y1={y(t.value)}
              y2={y(t.value)}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.8}
              className={t.level ? LEVEL_STYLES[t.level].mark : 'text-slate-400'}
            />
          ) : null,
        )}
        {area &&
          observedRuns.map((run, k) => <path key={`a${k}`} d={areaPath(run, h - PAD)} fill="currentColor" opacity={0.1} />)}
        {observedRuns.map((run, k) => (
          <path
            key={`o${k}`}
            d={linePath(run)}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {projectedRuns.map((run, k) => (
          <path
            key={`p${k}`}
            d={linePath(run)}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="3 4"
            opacity={0.85}
          />
        ))}
        {finite.length === 0 && (
          <line
            x1={PAD}
            x2={w - PAD}
            y1={h / 2}
            y2={h / 2}
            stroke="currentColor"
            strokeDasharray="2 4"
            className="text-slate-300"
          />
        )}
        {showEndDot && endPoint && !hoverPt && <Dot pt={endPoint} />}
        {hoverPt && (
          <>
            <line x1={hoverPt.x} x2={hoverPt.x} y1={0} y2={h} stroke="currentColor" strokeWidth={1} className="text-slate-300" />
            <Dot pt={hoverPt} />
          </>
        )}
      </svg>
      {hoverPt && (
        <div
          aria-hidden
          className={cx(
            'pointer-events-none absolute bottom-full z-20 mb-1 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-white tabular-nums shadow-md',
            readoutAlign,
          )}
          style={{ left: hoverPt.x }}
        >
          {pointLabels?.[hoverPt.i] !== undefined && <span className="text-white/70">{pointLabels[hoverPt.i]} · </span>}
          {fmt(hoverPt.v)}
          {u}
          {hoverPt.i >= split && <span className="text-white/70"> · projection</span>}
        </div>
      )}
    </div>
  )
}
