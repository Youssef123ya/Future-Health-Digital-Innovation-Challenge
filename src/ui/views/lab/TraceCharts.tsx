/**
 * Per-worker truth-vs-estimate charts of the Simulation lab: simulated ground-truth core temperature against the
 * engine's ECTemp estimate band, the displayed-level / activity / wearable / ground-truth-event lanes, true against
 * measured heart rate, and ground-truth dehydration. Four synced recharts panels share one time axis and one crosshair;
 * a readout above them lists every value at the hovered minute, and a table view carries the same data without
 * hovering (dataviz: tooltips enhance, never gate).
 *
 * Colour roles (validated with the dataviz palette script): ink = simulated ground truth (a neutral reference line,
 * not a categorical series), blue #2a78d6 = what Zill saw or estimated (ΔE 31 to ink under CVD), slate ramp = activity
 * (ordinal, passes), level fills = the app's reserved risk colours, always with pictogram and text.
 * SIMULATED COHORT data with ground truth: Lab view only.
 */
import { memo, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, usePlotArea, useXAxisScale } from 'recharts'
import { Table2 } from 'lucide-react'
import { RISK_LEVELS, type RiskLevel } from '../../../engine/types'
import { TRUTH_PARAMS } from '../../../sim/truth'
import type { TruthEventKind } from '../../../sim/types'
import { Button, DataTable, DEFAULT_LEVEL_LABELS, LEVEL_STYLES, LevelPill, ProvenanceTag, cx, type DataTableColumn } from '../../components'
import {
  ACTIVITY_TEXT,
  ECTEMP_HALF_WIDTH_C,
  TRUTH_EVENT_META,
  activityOf,
  bandCoverage,
  coreDomain,
  eventsNear,
  firstLevelAtLeast,
  fixed,
  hhmm,
  hourTicks,
  hrDomain,
  peakRow,
  rowAt,
  sampleRows,
  segmentsOf,
  wearableGaps,
  type Activity,
  type TruthRow,
} from './labModel'
import type { LabEventMarker } from './labTypes'

// ─────────────────────────────── Tokens ───────────────────────────────

export const TRUTH_COLOR = '#1e293b'
export const ENGINE_COLOR = '#2a78d6'
const ENGINE_WASH = '#2a78d6'
const WEARABLE_OK = '#9ec5f4'
const GRID = '#e2e8f0'
const AXIS_TEXT = '#475569'
const CRITERIA = '#94a3b8'
const SURFACE = '#ffffff'
const TICK = { fill: AXIS_TEXT, fontSize: 11 }
const CURSOR = { stroke: '#64748b', strokeWidth: 1 }
const Y_W = 40
const MARGIN = { top: 8, right: 12, bottom: 0, left: 0 }

/** Level fills (index.css --color-*-fill) and the pictogram colour on them (components/levels.ts onSolid). */
const LEVEL_FILL: Readonly<Record<RiskLevel, string>> = { safe: '#16a34a', caution: '#f59e0b', high: '#ea580c', stop: '#dc2626', emergency: '#7e22ce' }
const LEVEL_ON: Readonly<Record<RiskLevel, string>> = { safe: '#0b1220', caution: '#0b1220', high: '#0b1220', stop: '#ffffff', emergency: '#ffffff' }
export const ACTIVITY_FILL: Readonly<Record<Activity, string>> = { rest: '#94a3b8', work_shade: '#64748b', work_sun: '#334155' }

const EVENT_ORDER: readonly TruthEventKind[] = ['symptom_onset', 'dehydration_3pct', 'excessive_strain', 'severe_strain', 'critical']

// ─────────────────────────────── Hover store (crosshair → readout without re-rendering the charts) ───────────────────────────────

interface HoverStore {
  get(): number | null
  set(t: number | null): void
  subscribe(listener: () => void): () => void
}

function createHoverStore(): HoverStore {
  let value: number | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (t) => {
      if (t === value) return
      value = t
      for (const l of listeners) l()
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

/** Tooltip content that renders nothing and reports the active minute to the hover store (mouse, touch and keyboard). */
function HoverBridge({ active, label, store }: { active?: boolean; label?: unknown; store: HoverStore }) {
  const t = active && typeof label === 'number' ? label : null
  useEffect(() => {
    store.set(t)
  }, [t, store])
  useEffect(() => () => store.set(null), [store])
  return null
}

// ─────────────────────────────── Shared chart pieces ───────────────────────────────

interface PanelProps {
  rows: readonly TruthRow[]
  domainX: [number, number]
  ticks: number[]
  syncId: string
  store: HoverStore
}

function xAxis(domainX: [number, number], ticks: number[], hide = false) {
  return (
    <XAxis
      dataKey="t"
      type="number"
      domain={domainX}
      ticks={ticks}
      tickFormatter={hhmm}
      allowDataOverflow
      hide={hide}
      tick={TICK}
      tickLine={false}
      stroke={GRID}
      height={22}
    />
  )
}

function bridge(store: HoverStore) {
  return <Tooltip content={<HoverBridge store={store} />} cursor={CURSOR} isAnimationActive={false} />
}

const criteriaLabel = (value: string) => ({ value, position: 'insideTopRight' as const, fill: AXIS_TEXT, fontSize: 10 })

const CoreChart = memo(function CoreChart({ rows, domainX, ticks, syncId, store, yDomain }: PanelProps & { yDomain: [number, number] }) {
  const E = TRUTH_PARAMS.events
  const yTicks = useMemo(() => {
    const out: number[] = []
    for (let v = Math.ceil(yDomain[0]); v <= yDomain[1]; v += 1) out.push(v)
    return out
  }, [yDomain])
  return (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={rows as TruthRow[]} syncId={syncId} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={GRID} />
        {xAxis(domainX, ticks)}
        <YAxis domain={yDomain} ticks={yTicks} width={Y_W} tick={TICK} tickLine={false} axisLine={false} allowDataOverflow tickFormatter={(v: number) => `${v}°`} />
        <ReferenceLine y={E.excessiveC} stroke={CRITERIA} label={criteriaLabel(`${E.excessiveC.toFixed(1)} °C excessive strain`)} />
        <ReferenceLine y={E.severeC} stroke={CRITERIA} label={criteriaLabel(`${E.severeC.toFixed(1)} °C severe`)} />
        <ReferenceLine y={E.criticalC} stroke={CRITERIA} label={criteriaLabel(`${E.criticalC.toFixed(1)} °C critical`)} />
        <Area dataKey="ectBand" stroke="none" fill={ENGINE_WASH} fillOpacity={0.16} isAnimationActive={false} connectNulls={false} activeDot={false} />
        <Line dataKey="ect" stroke={ENGINE_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="core" stroke={TRUTH_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        {bridge(store)}
      </ComposedChart>
    </ResponsiveContainer>
  )
})

const HrChart = memo(function HrChart({ rows, domainX, ticks, syncId, store }: PanelProps) {
  const yDomain = useMemo(() => hrDomain(rows), [rows])
  return (
    <ResponsiveContainer width="100%" height={160}>
      <ComposedChart data={rows as TruthRow[]} syncId={syncId} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={GRID} />
        {xAxis(domainX, ticks)}
        <YAxis domain={yDomain} width={Y_W} tick={TICK} tickLine={false} axisLine={false} allowDataOverflow tickCount={5} />
        <Line dataKey="hrTrue" stroke={TRUTH_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="hrMeas" stroke={ENGINE_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        {bridge(store)}
      </ComposedChart>
    </ResponsiveContainer>
  )
})

const DehydrationChart = memo(function DehydrationChart({ rows, domainX, ticks, syncId, store }: PanelProps) {
  const limit = TRUTH_PARAMS.events.dehydrationPct
  const yMax = useMemo(() => {
    let hi = limit + 1
    for (const r of rows) if (r.dehy !== null && r.dehy > hi) hi = r.dehy
    return Math.ceil(hi)
  }, [rows, limit])
  return (
    <ResponsiveContainer width="100%" height={128}>
      <ComposedChart data={rows as TruthRow[]} syncId={syncId} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={GRID} />
        {xAxis(domainX, ticks)}
        <YAxis domain={[0, yMax]} width={Y_W} tick={TICK} tickLine={false} axisLine={false} allowDataOverflow tickCount={yMax + 1 > 6 ? 4 : yMax + 1} tickFormatter={(v: number) => `${v} %`} />
        <ReferenceLine y={limit} stroke={CRITERIA} label={criteriaLabel(`${limit} % body-mass loss`)} />
        <Line dataKey="dehy" stroke={TRUTH_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        {bridge(store)}
      </ComposedChart>
    </ResponsiveContainer>
  )
})

// ─────────────────────────────── Lanes ───────────────────────────────

interface LaneData {
  level: { from: number; to: number; value: RiskLevel }[]
  /** Shown instead of the level lane when no Zill device ran (baseline policies). */
  levelNote: string | null
  activity: { from: number; to: number; value: Activity }[]
  wearableOk: { from: number; to: number }[]
  wearableGap: { from: number; to: number }[]
  wearableNote: string | null
  events: LabEventMarker[]
}

const LANE = { label: 13, level: 14, thin: 10, events: 14, gap: 7 }
const LANES_HEIGHT = 4 + (LANE.label + LANE.level + LANE.gap) + 2 * (LANE.label + LANE.thin + LANE.gap) + (LANE.label + LANE.events) + 6

/** Event marker silhouettes: distinct shapes in ink with a surface ring, so they read without colour. */
export function EventShape({ kind, x, y, r = 5 }: { kind: TruthEventKind; x: number; y: number; r?: number }) {
  const common = { stroke: SURFACE, strokeWidth: 2, paintOrder: 'stroke' as const }
  switch (kind) {
    case 'excessive_strain':
      return <path d={`M${x} ${y - r - 1} L${x + r + 1} ${y + r} L${x - r - 1} ${y + r} Z`} fill={TRUTH_COLOR} {...common} />
    case 'severe_strain':
      return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={1} fill={TRUTH_COLOR} {...common} />
    case 'critical':
      return (
        <g>
          <circle cx={x} cy={y} r={r + 1} fill={TRUTH_COLOR} {...common} />
          <path d={`M${x - 2.5} ${y - 2.5} L${x + 2.5} ${y + 2.5} M${x + 2.5} ${y - 2.5} L${x - 2.5} ${y + 2.5}`} stroke={SURFACE} strokeWidth={1.6} />
        </g>
      )
    case 'dehydration_3pct':
      return <path d={`M${x} ${y - r - 1} L${x + r + 1} ${y} L${x} ${y + r + 1} L${x - r - 1} ${y} Z`} fill={SURFACE} stroke={TRUTH_COLOR} strokeWidth={2} />
    case 'symptom_onset':
      return <circle cx={x} cy={y} r={r - 0.5} fill={SURFACE} stroke={TRUTH_COLOR} strokeWidth={2} />
  }
}

function LanesLayer({ data }: { data: LaneData }) {
  const xScale = useXAxisScale()
  const plot = usePlotArea()
  if (!xScale || !plot) return null
  const x = (t: number) => xScale(t) ?? plot.x
  const left = plot.x
  const right = plot.x + plot.width
  const clampX = (v: number) => Math.min(right, Math.max(left, v))
  let y = plot.y + 2
  const label = (text: string) => {
    const el = (
      <text x={left} y={y + 10} fontSize={11} fill={AXIS_TEXT}>
        {text}
      </text>
    )
    y += LANE.label
    return el
  }
  const span = (from: number, to: number) => {
    const x0 = clampX(x(from))
    const x1 = clampX(x(to))
    const w = Math.max(1, x1 - x0)
    // 1 px surface gap between touching segments once they are wide enough to keep it.
    return w >= 3 ? { x: x0 + 0.5, w: w - 1 } : { x: x0, w }
  }

  const levelLabel = label('Displayed level (engine)')
  const levelY = y
  const levelEls = data.levelNote ? (
    <text x={left} y={levelY + 10} fontSize={11} fill={AXIS_TEXT} fontStyle="italic">
      {data.levelNote}
    </text>
  ) : data.level.map((s, i) => {
    const { x: sx, w } = span(s.from, s.to)
    const Icon = LEVEL_STYLES[s.value].icon
    return (
      <g key={`l${i}`}>
        <rect x={sx} y={levelY} width={w} height={LANE.level} rx={2} fill={LEVEL_FILL[s.value]} />
        {w >= 18 && (
          <g transform={`translate(${sx + w / 2 - 5},${levelY + 2})`}>
            <Icon size={10} color={LEVEL_ON[s.value]} strokeWidth={2.5} aria-hidden />
          </g>
        )}
      </g>
    )
  })
  y += LANE.level + LANE.gap

  const actLabel = label('Activity')
  const actY = y
  const actEls = data.activity.map((s, i) => {
    const { x: sx, w } = span(s.from, s.to)
    return <rect key={`a${i}`} x={sx} y={actY} width={w} height={LANE.thin} rx={2} fill={ACTIVITY_FILL[s.value]} />
  })
  y += LANE.thin + LANE.gap

  const wearLabel = label('Wearable data (what the device received)')
  const wearY = y
  const wearEls = data.wearableNote ? (
    <text x={left} y={wearY + 9} fontSize={11} fill={AXIS_TEXT} fontStyle="italic">
      {data.wearableNote}
    </text>
  ) : (
    <g>
      {data.wearableOk.map((s, i) => {
        const { x: sx, w } = span(s.from, s.to)
        return <rect key={`w${i}`} x={sx} y={wearY} width={w} height={LANE.thin} rx={2} fill={WEARABLE_OK} />
      })}
      {data.wearableGap.map((s, i) => {
        const x0 = clampX(x(s.from))
        const w = Math.max(1.5, clampX(x(s.to)) - x0)
        return <rect key={`g${i}`} x={x0} y={wearY} width={w} height={LANE.thin} fill="url(#lab-gap-hatch)" stroke={TRUTH_COLOR} strokeWidth={0.75} />
      })}
    </g>
  )
  y += LANE.thin + LANE.gap

  const evLabel = label('Ground-truth events (simulated)')
  const evY = y + LANE.events / 2
  const evEls = data.events.map((e, i) => (e.truth ? <EventShape key={`e${i}`} kind={e.truth} x={clampX(x(e.t))} y={evY} /> : null))

  return (
    <g aria-hidden>
      <defs>
        <pattern id="lab-gap-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} fill={SURFACE} />
          <line x1={0} y1={0} x2={0} y2={4} stroke={TRUTH_COLOR} strokeWidth={1.5} />
        </pattern>
      </defs>
      {levelLabel}
      {levelEls}
      {actLabel}
      {actEls}
      {wearLabel}
      {wearEls}
      {evLabel}
      <line x1={left} x2={right} y1={evY} y2={evY} stroke={GRID} />
      {evEls}
    </g>
  )
}

const zero = () => 0

const LanesChart = memo(function LanesChart({ rows, domainX, ticks, syncId, store, lanes }: PanelProps & { lanes: LaneData }) {
  return (
    <ResponsiveContainer width="100%" height={LANES_HEIGHT}>
      <ComposedChart data={rows as TruthRow[]} syncId={syncId} margin={{ ...MARGIN, top: 0 }}>
        {xAxis(domainX, ticks, true)}
        <YAxis width={Y_W} domain={[0, 1]} tick={false} tickLine={false} axisLine={false} />
        <Line dataKey={zero} stroke="transparent" dot={false} activeDot={false} isAnimationActive={false} />
        <LanesLayer data={lanes} />
        {bridge(store)}
      </ComposedChart>
    </ResponsiveContainer>
  )
})

// ─────────────────────────────── Legend and readout ───────────────────────────────

function LineKey({ color, wash, label }: { color: string; wash?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="relative inline-block h-3 w-5">
        {wash && <span className="absolute inset-0 rounded-sm" style={{ background: color, opacity: 0.16 }} />}
        <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ background: color }} />
      </span>
      {label}
    </span>
  )
}

function SwatchKey({ fill, hatch, label, children }: { fill?: string; hatch?: boolean; label: string; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children ?? (
        <span
          aria-hidden
          className="inline-block h-2.5 w-4 rounded-sm"
          style={hatch ? { backgroundImage: `repeating-linear-gradient(45deg, ${TRUTH_COLOR} 0 1.5px, transparent 1.5px 4px)`, boxShadow: `inset 0 0 0 0.75px ${TRUTH_COLOR}` } : { background: fill }}
        />
      )}
      {label}
    </span>
  )
}

function EventKey({ kind }: { kind: TruthEventKind }) {
  return (
    <SwatchKey label={TRUTH_EVENT_META[kind].short}>
      <svg aria-hidden width={14} height={14} viewBox="0 0 14 14" className="shrink-0">
        <EventShape kind={kind} x={7} y={7} r={4} />
      </svg>
    </SwatchKey>
  )
}

function LevelKey({ level }: { level: RiskLevel }) {
  const Icon = LEVEL_STYLES[level].icon
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="grid size-4 place-items-center rounded-sm" style={{ background: LEVEL_FILL[level], color: LEVEL_ON[level] }}>
        <Icon size={10} strokeWidth={2.5} />
      </span>
      {DEFAULT_LEVEL_LABELS[level]}
    </span>
  )
}

function ReadoutCell({ label, children, tone }: { label: string; children: ReactNode; tone?: 'truth' | 'engine' }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] font-medium text-subtle">
        {tone && <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: tone === 'truth' ? TRUTH_COLOR : ENGINE_COLOR }} />}
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-semibold text-ink tabular-nums">{children}</dd>
    </div>
  )
}

function Readout({ rows, store, events, fallbackT, fallbackLabel, wearableExpected, engineOn }: { rows: readonly TruthRow[]; store: HoverStore; events: readonly LabEventMarker[]; fallbackT: number | null; fallbackLabel: string; wearableExpected: boolean; engineOn: boolean }) {
  const hoverT = useSyncExternalStore(store.subscribe, store.get, store.get)
  const t = hoverT ?? fallbackT
  const r = t === null ? null : rowAt(rows, t)
  const near = r ? eventsNear(events, r.t, 2).filter((e) => e.source === 'truth') : []
  const act = r ? activityOf(r) : null
  const pos = r && r.core !== null && r.ectBand ? (r.core > r.ectBand[1] ? `${(r.core - r.ectBand[1]).toFixed(1)} °C above band` : r.core < r.ectBand[0] ? `${(r.ectBand[0] - r.core).toFixed(1)} °C below band` : 'inside band') : null
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
      <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-semibold text-ink tabular-nums">{r ? hhmm(r.t) : '—'}</span>
        <span>· {hoverT !== null ? 'value under the crosshair' : fallbackLabel}</span>
        <ProvenanceTag kind="simulated" label="Simulated ground truth" detail="Ground-truth values come from the hidden truth model; the engine never sees them" className="ms-auto" />
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <ReadoutCell label="Displayed level">{!engineOn ? 'no Zill device' : r?.level ? <LevelPill level={r.level} size="sm" /> : '—'}</ReadoutCell>
        <ReadoutCell label="Core, ground truth" tone="truth">
          {fixed(r?.core)} °C
        </ReadoutCell>
        <ReadoutCell label="ECTemp estimate" tone="engine">
          {r?.ect != null ? `${r.ect.toFixed(1)} ± ${ECTEMP_HALF_WIDTH_C.toFixed(1)} °C` : wearableExpected ? 'no estimate' : 'not available'}
        </ReadoutCell>
        <ReadoutCell label="Truth vs band">{pos ?? '—'}</ReadoutCell>
        <ReadoutCell label="Heart rate true / measured">
          {fixed(r?.hrTrue, 0)} / {r?.hrMeas != null ? fixed(r.hrMeas, 0) : wearableExpected ? 'gap' : '—'} bpm
        </ReadoutCell>
        <ReadoutCell label="Dehydration, ground truth" tone="truth">
          {fixed(r?.dehy)} %
        </ReadoutCell>
        <ReadoutCell label="Activity">{act ? ACTIVITY_TEXT[act] : '—'}</ReadoutCell>
        <ReadoutCell label="WBGT where the worker is">{fixed(r?.wbgt)} °C</ReadoutCell>
      </dl>
      {near.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink">
          {near.map((e, i) => (
            <li key={i} className="inline-flex items-center gap-1.5">
              {e.truth && (
                <svg aria-hidden width={14} height={14} viewBox="0 0 14 14">
                  <EventShape kind={e.truth} x={7} y={7} r={4} />
                </svg>
              )}
              <span className="tabular-nums text-muted">{hhmm(e.t)}</span> {e.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────────── Table view ───────────────────────────────

const tableColumns = (engineOn: boolean): readonly DataTableColumn<TruthRow>[] => [
  { id: 't', header: 'Time', cell: (r) => hhmm(r.t), sortValue: (r) => r.t, numeric: true },
  { id: 'level', header: 'Displayed level', cell: (r) => (engineOn && r.level ? <LevelPill level={r.level} size="sm" /> : '—'), sortValue: (r) => (engineOn && r.level ? RISK_LEVELS.indexOf(r.level) : null) },
  { id: 'act', header: 'Activity', cell: (r) => { const a = activityOf(r); return a ? ACTIVITY_TEXT[a] : '—' }, hideBelow: 'md' },
  { id: 'core', header: 'Core, truth (°C)', cell: (r) => fixed(r.core), sortValue: (r) => r.core, numeric: true },
  { id: 'ect', header: 'ECTemp band (°C)', cell: (r) => (r.ectBand ? `${r.ectBand[0].toFixed(1)}–${r.ectBand[1].toFixed(1)}` : '—'), sortValue: (r) => r.ect, numeric: true },
  { id: 'hrt', header: 'HR true', cell: (r) => fixed(r.hrTrue, 0), sortValue: (r) => r.hrTrue, numeric: true, hideBelow: 'sm' },
  { id: 'hrm', header: 'HR measured', cell: (r) => fixed(r.hrMeas, 0), sortValue: (r) => r.hrMeas, numeric: true, hideBelow: 'sm' },
  { id: 'dehy', header: 'Dehydration, truth (%)', cell: (r) => fixed(r.dehy), sortValue: (r) => r.dehy, numeric: true },
  { id: 'wbgt', header: 'WBGT eff. (°C)', cell: (r) => fixed(r.wbgt), sortValue: (r) => r.wbgt, numeric: true, hideBelow: 'lg' },
]

// ─────────────────────────────── The panel ───────────────────────────────

export interface TraceChartsProps {
  rows: readonly TruthRow[]
  t0: number
  tEnd: number
  /** This worker's event log (ground-truth markers come from the 'truth' rows). */
  events: readonly LabEventMarker[]
  /** True when the device should receive wearable data (wearable policy, band paired, consent). */
  wearableExpected: boolean
  /** Text for the wearable lane when no data is expected. */
  wearableNote: string
  /** Accessible name of the figure group, e.g. "Rashid K. under Zill with wearables". */
  label: string
  /** The readout's default minute: 'peak' (run results) or 'latest' (live world). */
  focus?: 'peak' | 'latest'
  /** False when no Zill device ran for this worker (baseline policies): the level lane then says so instead of a level. */
  engineOn?: boolean
}

/** The per-worker chart group (see the module comment). */
export function TraceCharts({ rows, t0, tEnd, events, wearableExpected, wearableNote, label, focus = 'peak', engineOn = true }: TraceChartsProps) {
  const syncId = useId()
  const [store] = useState(createHoverStore)
  const [showTable, setShowTable] = useState(false)

  const domainX = useMemo<[number, number]>(() => [t0, tEnd], [t0, tEnd])
  const ticks = useMemo(() => hourTicks(t0, tEnd, 2), [t0, tEnd])
  const yDomain = useMemo(() => coreDomain(rows), [rows])
  const truthEvents = useMemo(() => events.filter((e) => e.source === 'truth'), [events])
  const lanes = useMemo<LaneData>(
    () => ({
      level: engineOn ? segmentsOf(rows, (r) => r.level) : [],
      levelNote: engineOn ? null : 'No Zill device under this policy: nothing was displayed',
      activity: segmentsOf(rows, activityOf),
      wearableOk: wearableExpected ? segmentsOf(rows, (r) => (r.hrMeas !== null ? true : null)) : [],
      wearableGap: wearableGaps(rows, wearableExpected),
      wearableNote: wearableExpected ? null : wearableNote,
      events: truthEvents,
    }),
    [rows, wearableExpected, wearableNote, truthEvents, engineOn],
  )
  const summary = useMemo(() => {
    const peak = peakRow(rows)
    const cov = bandCoverage(rows)
    const high = firstLevelAtLeast(rows, 'high')
    const stop = firstLevelAtLeast(rows, 'stop')
    const gapMin = lanes.wearableGap.reduce((a, s) => a + Math.round((s.to - s.from) / 60000), 0)
    return { peak, cov, high, stop, gapMin }
  }, [rows, lanes.wearableGap])
  const fallbackT = focus === 'latest' ? (rows.at(-1)?.t ?? null) : (summary.peak?.t ?? null)
  const tableRows = useMemo(() => (showTable ? sampleRows(rows, 15) : []), [rows, showTable])

  if (rows.length === 0) return null
  const p = { rows, domainX, ticks, syncId, store }
  const covPct = summary.cov ? Math.round((summary.cov.inside / summary.cov.total) * 100) : null
  const coreCaption = [
    summary.peak?.core != null ? `Simulated core temperature peaked at ${summary.peak.core.toFixed(1)} °C at ${hhmm(summary.peak.t)}.` : '',
    covPct !== null ? `The truth lay inside the ECTemp band in ${covPct} % of ${summary.cov?.total} estimated minutes.` : 'No ECTemp estimate: the device had no wearable data.',
    !engineOn
      ? 'No Zill device ran under this policy.'
      : summary.high !== null
        ? `The device first showed High risk or above at ${hhmm(summary.high)}${summary.stop !== null ? ` and Stop work or above at ${hhmm(summary.stop)}` : ''}.`
        : 'The device never showed High risk or above.',
  ].join(' ')

  return (
    <div className="space-y-3" role="group" aria-label={label} onMouseLeave={() => store.set(null)}>
      <Readout rows={rows} store={store} events={truthEvents} fallbackT={fallbackT} fallbackLabel={focus === 'latest' ? 'latest minute' : 'minute of the peak simulated core temperature'} wearableExpected={wearableExpected} engineOn={engineOn} />

      <div dir="ltr" className="space-y-1">
        <figure className="min-w-0">
          <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-sm font-semibold text-ink">Core temperature: simulated ground truth vs ECTemp estimate</span>
            <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <LineKey color={TRUTH_COLOR} label="Simulated ground truth" />
              <LineKey color={ENGINE_COLOR} wash label={`ECTemp estimate ± ${ECTEMP_HALF_WIDTH_C.toFixed(1)} °C`} />
            </span>
          </figcaption>
          <p className="sr-only">{coreCaption}</p>
          <CoreChart {...p} yDomain={yDomain} />
        </figure>

        <figure className="min-w-0">
          <figcaption className="sr-only">
            Lanes: displayed level, activity, wearable data and ground-truth events over the shift. {summary.gapMin > 0 ? `${summary.gapMin} minutes without a valid wearable reading.` : ''}
          </figcaption>
          <LanesChart {...p} lanes={lanes} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 ps-10 text-[11px] text-muted">
            {RISK_LEVELS.map((lv) => (
              <LevelKey key={lv} level={lv} />
            ))}
            <span aria-hidden className="text-line-strong">|</span>
            {(['work_sun', 'work_shade', 'rest'] as const).map((a) => (
              <SwatchKey key={a} fill={ACTIVITY_FILL[a]} label={ACTIVITY_TEXT[a]} />
            ))}
            <span aria-hidden className="text-line-strong">|</span>
            <SwatchKey fill={WEARABLE_OK} label="Valid reading" />
            <SwatchKey hatch label="Dropout (no valid reading)" />
            <span aria-hidden className="text-line-strong">|</span>
            {EVENT_ORDER.map((k) => (
              <EventKey key={k} kind={k} />
            ))}
          </div>
        </figure>

        <figure className="min-w-0 pt-3">
          <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-sm font-semibold text-ink">Heart rate (bpm): true vs measured by the band</span>
            <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <LineKey color={TRUTH_COLOR} label="True (simulated)" />
              <LineKey color={ENGINE_COLOR} label="Measured: gaps are dropouts" />
            </span>
          </figcaption>
          <HrChart {...p} />
        </figure>

        <figure className="min-w-0 pt-3">
          <figcaption className="mb-1 text-sm font-semibold text-ink">Dehydration: body-mass loss, simulated ground truth</figcaption>
          <DehydrationChart {...p} />
        </figure>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-xs text-muted">
          {coreCaption}
          {summary.gapMin > 0 ? ` ${summary.gapMin} minutes without a valid wearable reading.` : ''}
        </p>
        <Button variant="secondary" size="sm" icon={Table2} aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide data table' : 'Show data table'}
        </Button>
      </div>
      {showTable && (
        <DataTable
          columns={tableColumns(engineOn)}
          rows={tableRows}
          rowKey={(r) => String(r.t)}
          caption={`${label}: every 15 minutes (simulated ground truth and engine output)`}
          dense
          stickyHeader
          maxHeight={360}
        />
      )}
    </div>
  )
}

/** Small inline legend of the ground-truth event shapes (for event logs outside the charts). */
export function EventGlyph({ kind, className }: { kind: TruthEventKind; className?: string }) {
  return (
    <svg aria-hidden width={14} height={14} viewBox="0 0 14 14" className={cx('shrink-0', className)}>
      <EventShape kind={kind} x={7} y={7} r={4} />
    </svg>
  )
}
