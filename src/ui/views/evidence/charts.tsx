import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { num } from './format'
import type { StackRow } from './model'
import { AXIS, COLORS, ChartTip, tipRow } from './ui'

/**
 * Recharts building blocks shared by the Evidence sections. Marks follow the dataviz specs: bars ≤ 24 px with a 4 px
 * rounded data end, a 2 px surface gap between stacked segments (a surface-coloured stroke), hairline solid grid,
 * recessive axes, tooltips that enhance (every value is also in the chart's table view). No animation: the page is
 * static evidence and must not move for reduced-motion users.
 */

export interface BandDef {
  label: string
  color: string
}

interface StackedBarChartProps {
  rows: readonly StackRow[]
  bands: readonly BandDef[]
  /** 'bars': categories down the side (horizontal bars); 'columns': categories along the bottom. */
  orientation: 'bars' | 'columns'
  /** Unit of the values for the tooltip ("h per season"). */
  unit: string
  /** Axis title for the value axis. */
  valueTitle: string
  categoryTitle?: string
  domainMax?: number
  ticks?: readonly number[]
  /** Category key range to shade (e.g. the midday-break hours), with its label. */
  shade?: { from: string; to: string; label: string }
  tooltipTitle?: (row: StackRow) => ReactNode
  categoryWidth?: number
}

/** Stacked bars of hours per band (least → most severe), one stack per category. */
export function StackedBarChart({
  rows,
  bands,
  orientation,
  unit,
  valueTitle,
  categoryTitle,
  domainMax,
  ticks,
  shade,
  tooltipTitle,
  categoryWidth = 80,
}: StackedBarChartProps) {
  const last = bands.length - 1
  const horizontal = orientation === 'bars'
  const valueAxis = {
    type: 'number' as const,
    domain: [0, domainMax ?? 'auto'] as [number, number | 'auto'],
    ticks: ticks ? [...ticks] : undefined,
    tickFormatter: (v: number) => num(v),
    allowDecimals: false,
    ...AXIS,
  }
  const tip = (props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
    const row = tipRow<StackRow>(props)
    if (!row) return null
    return (
      <ChartTip
        title={tooltipTitle ? tooltipTitle(row) : row.label}
        lines={[...bands.map((b, i) => ({ label: b.label, value: num(row[`b${i}`], 1), color: b.color, shape: 'rect' as const })).reverse()]}
        note={`Total ${num(row.total, 0)} ${unit}`}
      />
    )
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows as StackRow[]}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 16, bottom: 22, left: horizontal ? 0 : 4 }}
        barCategoryGap={horizontal ? 10 : 3}
        accessibilityLayer
      >
        <CartesianGrid stroke={COLORS.grid} horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis {...valueAxis} label={{ value: valueTitle, position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis type="category" dataKey="label" width={categoryWidth} {...AXIS} />
          </>
        ) : (
          <>
            <XAxis type="category" dataKey="label" interval={0} {...AXIS} label={categoryTitle ? { value: categoryTitle, position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 } : undefined} />
            <YAxis {...valueAxis} width={44} label={{ value: valueTitle, angle: -90, position: 'insideLeft', offset: 10, fill: COLORS.tick, fontSize: 12, style: { textAnchor: 'middle' } }} />
          </>
        )}
        {shade && !horizontal && (
          <ReferenceArea
            x1={shade.from}
            x2={shade.to}
            fill={COLORS.band}
            fillOpacity={1}
            stroke={COLORS.bandStroke}
            strokeDasharray="3 3"
            ifOverflow="extendDomain"
            label={{ value: shade.label, position: 'insideTop', fill: COLORS.tick, fontSize: 11 }}
          />
        )}
        <Tooltip content={tip} cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }} isAnimationActive={false} />
        {bands.map((b, i) => (
          <Bar
            key={b.label}
            dataKey={`b${i}`}
            name={b.label}
            stackId="stack"
            fill={b.color}
            stroke="#ffffff"
            strokeWidth={horizontal ? 2 : 1}
            maxBarSize={24}
            radius={i === last ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
