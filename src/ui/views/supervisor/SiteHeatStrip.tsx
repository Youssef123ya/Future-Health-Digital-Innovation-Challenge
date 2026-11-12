/**
 * Site heat strip: hourly forecast WBGT in sun and shade for the shift (two 2 px lines, legend + direct end labels),
 * the midday-break band, the current-time marker, the site readings seen by this console (forecast vs measured), the
 * TWL zone per hour and the rest-area type. Site-level data only. Chart rules: dataviz skill (one axis, thin marks,
 * recessive grid, crosshair tooltip with every series, table view). Palette validated with the skill's validator:
 * sun #2a78d6 / shade #0d9488 on white (CVD ΔE 15.7, normal-vision ΔE 16.4, both ≥ 3:1).
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import { Snowflake, Thermometer, Umbrella } from 'lucide-react'
import type { SiteHeat } from '../../../engine/indices'
import type { SiteHour } from '../../../sim/types'
import { Card, InfoTip, ProvenanceTag, cx } from '../../components'
import { addReading, forecastAt, heatDomain, heatRows, hhmm, middayBand, restAreaInfo, zoneShort, type HeatRow, type Reading } from './model'

export const SUN_COLOR = '#2a78d6'
export const SHADE_COLOR = '#0d9488'
const GRID = '#e2e8f0'
const AXIS_TEXT = '#475569'
const INK = '#0b1220'
const Y_AXIS_W = 36
const MARGIN = { top: 22, right: 44, bottom: 0, left: 0 }

const ZONE_CELL: Readonly<Record<'low' | 'medium' | 'high' | 'none', string>> = {
  high: 'bg-high-bg text-high',
  medium: 'bg-caution-bg text-caution',
  low: 'bg-safe-bg text-safe',
  none: 'bg-slate-100 text-slate-600',
}

export interface SiteHeatStripProps {
  hours: readonly SiteHour[]
  heat: SiteHeat | null
  now: number
  restArea: 'cooled_cabin' | 'shade'
  midday: { startT: number; endT: number } | null
  provenance: readonly string[]
  /** Changes when the world is rebuilt (scenario, policy, seed): the readings trail restarts. */
  worldKey: string
  className?: string
}

/** Readings seen by this console, one per 5 simulated minutes (forecast vs measured). */
function useReadingTrail(heat: SiteHeat | null, now: number, worldKey: string): readonly Reading[] {
  const [trail, setTrail] = useState<{ key: string; list: readonly Reading[] }>({ key: worldKey, list: [] })
  const wbgt = heat?.wbgtC
  const measured = heat?.measured ?? false
  useEffect(() => {
    if (wbgt === undefined) return
    setTrail((prev) => {
      const base = prev.key === worldKey ? prev.list : []
      const next = addReading(base, { t: now, wbgtC: wbgt, measured })
      return next === base && prev.key === worldKey ? prev : { key: worldKey, list: next }
    })
  }, [wbgt, measured, now, worldKey])
  return trail.key === worldKey ? trail.list : []
}

export function SiteHeatStrip({ hours, heat, now, restArea, midday, provenance, worldKey, className }: SiteHeatStripProps) {
  const rows = useMemo(() => heatRows(hours), [hours])
  const trail = useReadingTrail(heat, now, worldKey)
  // Re-render the chart every 5 simulated minutes, not every tick (300× clock).
  const nowQ = Math.floor(now / 300_000) * 300_000
  const cw = heat ? Math.round(heat.wbgtC * 10) / 10 : null
  const cm = heat?.measured ?? false
  const current = useMemo(() => (cw === null ? null : { wbgtC: cw, measured: cm }), [cw, cm])
  const fc = forecastAt(rows, now)
  const rest = restAreaInfo(restArea)
  const RestIcon = restArea === 'cooled_cabin' ? Snowflake : Umbrella
  const band = useMemo(() => middayBand(rows, midday), [rows, midday])
  const delta = current && fc !== null ? current.wbgtC - fc : null

  return (
    <Card as="section" padding="none" aria-labelledby="heat-strip-h" className={cx('min-w-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id="heat-strip-h" className="flex items-center gap-2 text-base font-semibold text-ink">
            <Thermometer aria-hidden size={18} className="text-shade" />
            Site heat today
          </h2>
          <p className="text-sm text-muted">Hourly WBGT forecast in sun and shade, heat-stress zone (TWL) and the midday break.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-ink">
            <RestIcon aria-hidden size={14} className="text-shade" />
            {rest.label}
            <InfoTip content={rest.detail} label={`About: ${rest.label}`} />
          </span>
          <ProvenanceTag kind="archived_forecast" detail={provenance.length > 0 ? provenance.join(' · ') : 'Day-ahead forecast archived for this date.'} />
        </div>
      </div>

      <div className="px-4 pt-3">
        <NowLine current={current} delta={delta} now={now} />
        <Legend bandText={band ? `${hhmm(band.x1)}–${hhmm(band.x2)}` : null} />
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-muted">No forecast hours for this shift yet.</p>
      ) : (
        <HeatChart rows={rows} nowQ={nowQ} current={current} trail={trail} band={band} />
      )}

      <details className="group border-t border-line px-4 py-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-shade hover:text-shade-dark">Show hourly values as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-xs tabular-nums">
            <caption className="sr-only">Hourly site heat forecast</caption>
            <thead className="text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="py-1 text-start font-medium">Hour</th>
                <th scope="col" className="py-1 text-end font-medium">WBGT sun (°C)</th>
                <th scope="col" className="py-1 text-end font-medium">WBGT shade (°C)</th>
                <th scope="col" className="py-1 text-end font-medium">TWL (W/m²)</th>
                <th scope="col" className="py-1 ps-3 text-start font-medium">Zone</th>
                <th scope="col" className="py-1 text-start font-medium">Midday break</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hourT} className="border-b border-line/60">
                  <th scope="row" className="py-1 text-start font-medium text-ink">{r.hour}</th>
                  <td className="py-1 text-end">{r.sun.toFixed(1)}</td>
                  <td className="py-1 text-end">{r.shade.toFixed(1)}</td>
                  <td className="py-1 text-end">{Math.round(r.twl)}</td>
                  <td className="py-1 ps-3">{r.zone.label}</td>
                  <td className="py-1">{r.midday ? 'Yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  )
}

function NowLine({ current, delta, now }: { current: { wbgtC: number; measured: boolean } | null; delta: number | null; now: number }) {
  if (!current) return <p className="text-sm text-muted">Now {hhmm(now)} · waiting for the first site reading</p>
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink">
      <span className="font-semibold tabular-nums">
        Now {hhmm(now)} · {current.wbgtC.toFixed(1)} °C WBGT in sun
      </span>
      <span className="text-muted">
        {current.measured ? 'measured by the site meter' : 'from the forecast (no meter reading)'}
        {current.measured && delta !== null && Math.abs(delta) >= 0.05 && (
          <>
            {' '}
            · {delta > 0 ? '+' : '−'}
            {Math.abs(delta).toFixed(1)} °C vs forecast
          </>
        )}
      </span>
    </p>
  )
}

function Legend({ bandText }: { bandText: string | null }) {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="Chart legend">
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: SUN_COLOR }} />
        WBGT in sun (forecast)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: SHADE_COLOR }} />
        WBGT in shade (forecast)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full" style={{ background: SUN_COLOR }} />
        Site meter reading
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2 rounded-full border-2 bg-white" style={{ borderColor: SUN_COLOR }} />
        Forecast value in use
      </li>
      {bandText && (
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-4 rounded-sm bg-slate-300/60" />
          Midday break {bandText}
        </li>
      )}
    </ul>
  )
}

interface ChartProps {
  rows: HeatRow[]
  nowQ: number
  current: { wbgtC: number; measured: boolean } | null
  trail: readonly Reading[]
  band: { x1: number; x2: number } | null
}

const HeatChart = memo(function HeatChart({ rows, nowQ, current, trail, band }: ChartProps) {
  const x0 = rows[0].hourT
  const x1 = rows[rows.length - 1].hourT + 3_600_000
  const measuredTrail = useMemo(() => trail.filter((r) => r.measured && r.t >= x0 && r.t <= x1).map((r) => ({ t: r.t, reading: r.wbgtC })), [trail, x0, x1])
  const forecastTrail = useMemo(() => trail.filter((r) => !r.measured && r.t >= x0 && r.t <= x1).map((r) => ({ t: r.t, reading: r.wbgtC })), [trail, x0, x1])
  const domain = heatDomain(rows, current ? [current.wbgtC] : [])
  const ticks: number[] = []
  const step = rows.length > 9 ? 2 : 1
  for (let t = x0; t <= x1; t += 3_600_000 * step) ticks.push(t)
  const yTicks: number[] = []
  for (let v = domain[0]; v <= domain[1]; v += domain[1] - domain[0] > 12 ? 4 : 2) yTicks.push(v)
  const showNow = nowQ >= x0 && nowQ <= x1
  const bx1 = band ? Math.max(band.x1, x0) : 0
  const bx2 = band ? Math.min(band.x2, x1) : 0
  const last = rows[rows.length - 1]

  return (
    <div dir="ltr" className="px-2 pt-1 sm:px-3">
      <div className="h-56 w-full" role="img" aria-label={chartSummary(rows)}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={MARGIN}>
            <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
            {band && bx2 > bx1 && (
              <ReferenceArea
                x1={bx1}
                x2={bx2}
                fill="#94a3b8"
                fillOpacity={0.18}
                stroke="none"
                ifOverflow="hidden"
                label={{ value: 'Midday break', position: 'insideBottom', fill: AXIS_TEXT, fontSize: 11 }}
              />
            )}
            <XAxis
              type="number"
              dataKey="t"
              domain={[x0, x1]}
              ticks={ticks}
              tickFormatter={(t: number) => hhmm(t)}
              tick={{ fill: AXIS_TEXT, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              allowDataOverflow
            />
            <YAxis
              width={Y_AXIS_W}
              domain={domain}
              ticks={yTicks}
              tick={{ fill: AXIS_TEXT, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              unit="°"
              allowDataOverflow
            />
            <Tooltip content={<HeatTooltip rows={rows} />} cursor={{ stroke: INK, strokeWidth: 1, strokeOpacity: 0.35 }} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="shade"
              name="WBGT in shade"
              stroke={SHADE_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: '#ffffff', strokeWidth: 2, fill: SHADE_COLOR }}
              isAnimationActive={false}
              label={endLabel(rows.length - 1, 'Shade', AXIS_TEXT)}
            />
            <Line
              type="monotone"
              dataKey="sun"
              name="WBGT in sun"
              stroke={SUN_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: '#ffffff', strokeWidth: 2, fill: SUN_COLOR }}
              isAnimationActive={false}
              label={endLabel(rows.length - 1, 'Sun', AXIS_TEXT)}
            />
            {measuredTrail.length > 0 && (
              <Scatter data={measuredTrail} dataKey="reading" name="Site meter reading" fill={SUN_COLOR} isAnimationActive={false} shape={<TrailDot filled />} />
            )}
            {forecastTrail.length > 0 && (
              <Scatter data={forecastTrail} dataKey="reading" name="Forecast value in use" fill={SUN_COLOR} isAnimationActive={false} shape={<TrailDot filled={false} />} />
            )}
            {showNow && (
              <ReferenceLine
                x={nowQ}
                stroke={INK}
                strokeWidth={1.5}
                ifOverflow="hidden"
                label={{ value: 'Now', position: 'top', fill: INK, fontSize: 11, fontWeight: 600 }}
              />
            )}
            {showNow && current && (
              <ReferenceDot
                x={nowQ}
                y={current.wbgtC}
                r={5}
                fill={current.measured ? SUN_COLOR : '#ffffff'}
                stroke={current.measured ? '#ffffff' : SUN_COLOR}
                strokeWidth={2}
                ifOverflow="hidden"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ZoneStrip rows={rows} />
      <p className="sr-only">
        Last forecast hour {last.hour}: {last.sun.toFixed(1)} °C in sun, {last.shade.toFixed(1)} °C in shade.
      </p>
    </div>
  )
})

/** End-of-line direct label (selective labelling: one per series). */
function endLabel(lastIndex: number, text: string, fill: string) {
  return function Label(props: { index?: number; x?: number | string; y?: number | string }) {
    if (props.index !== lastIndex || typeof props.x !== 'number' || typeof props.y !== 'number') return null
    return (
      <text x={props.x + 6} y={props.y} dy={4} fill={fill} fontSize={11} fontWeight={600}>
        {text}
      </text>
    )
  }
}

function TrailDot(props: { cx?: number; cy?: number; filled?: boolean }) {
  if (typeof props.cx !== 'number' || typeof props.cy !== 'number') return null
  return props.filled ? (
    <circle cx={props.cx} cy={props.cy} r={2.5} fill={SUN_COLOR} fillOpacity={0.55} />
  ) : (
    <circle cx={props.cx} cy={props.cy} r={2.5} fill="#ffffff" stroke={SUN_COLOR} strokeWidth={1.25} strokeOpacity={0.7} />
  )
}

function HeatTooltip({ active, label, rows }: { active?: boolean; label?: number | string; rows: HeatRow[] }) {
  if (!active || typeof label !== 'number') return null
  const r = rows.find((x) => label >= x.hourT && label < x.hourT + 3_600_000) ?? null
  if (!r) return null
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold text-ink">
        {r.hour}–{hhmm(r.hourT + 3_600_000)}
        {r.midday && <span className="ms-1.5 font-normal text-muted">midday break</span>}
      </p>
      <p className="flex items-center gap-2">
        <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: SUN_COLOR }} />
        <span className="font-semibold text-ink tabular-nums">{r.sun.toFixed(1)} °C</span>
        <span className="text-muted">WBGT in sun</span>
      </p>
      <p className="flex items-center gap-2">
        <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: SHADE_COLOR }} />
        <span className="font-semibold text-ink tabular-nums">{r.shade.toFixed(1)} °C</span>
        <span className="text-muted">WBGT in shade</span>
      </p>
      <p className="mt-1 text-muted">
        TWL <span className="font-semibold text-ink tabular-nums">{Math.round(r.twl)} W/m²</span> · {r.zone.label} zone
      </p>
    </div>
  )
}

/** TWL zone per hour, aligned with the chart's plot area (letter + colour + label in the table view). */
function ZoneStrip({ rows }: { rows: HeatRow[] }) {
  return (
    <div className="pb-2" style={{ paddingLeft: Y_AXIS_W + MARGIN.left, paddingRight: MARGIN.right }}>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }} aria-hidden>
        {rows.map((r) => (
          <div
            key={r.hourT}
            title={`${r.hour}: TWL ${Math.round(r.twl)} W/m², ${r.zone.label} zone`}
            className={cx('grid h-5 place-items-center rounded-[3px] text-[10px] font-semibold', ZONE_CELL[r.zone.key])}
          >
            {r.zone.short}
          </div>
        ))}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="font-medium text-ink">Heat-stress zone (TWL):</span>
        {(['high', 'medium', 'low'] as const).map((k) => {
          const z = zoneShort(k)
          return (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={cx('grid size-4 place-items-center rounded-[3px] text-[10px] font-semibold', ZONE_CELL[k])}>{z.short}</span>
              {z.label}
            </span>
          )
        })}
      </p>
    </div>
  )
}

function chartSummary(rows: HeatRow[]): string {
  const peak = rows.reduce((m, r) => (r.sun > m.sun ? r : m), rows[0])
  return `WBGT forecast from ${rows[0].hour} to ${hhmm(rows[rows.length - 1].hourT + 3_600_000)}: peak ${peak.sun.toFixed(1)} °C in sun at ${peak.hour}. Values are in the table below.`
}
