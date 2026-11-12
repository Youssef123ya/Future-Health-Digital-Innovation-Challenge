import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Section } from '../../components'
import { StackedBarChart, type BandDef } from './charts'
import { twlPoints, type TwlPoint } from './derive'
import { NBSP, hourLabel, num, pct, signedPct } from './format'
import {
  bandRowsByHour,
  bandRowsByMonth,
  bandRowsBySite,
  MONTH_LABELS,
  SITE_IDS,
  siteLabel,
  WORK_LIMIT_OPTIONS,
  workRestByHour,
  workRestPairs,
  type BandKey,
  type WorkRestPair,
} from './model'
import { DisclosureButton, Kpi, KpiRow, Segmented, ShareBar, SubHead, TableFrame, TD, TH } from './parts'
import type { HoursFile } from './types'
import { AXIS, COLORS, ChartFrame, ChartTip, FileGate, MethodPanel, MiniTable, SelectField, tipRow } from './ui'
import type { FileState } from './useEvidenceData'

export const EXPOSURE_SECTION_ID = 'evidence-exposure'

const SITE_OPTIONS = SITE_IDS.map((id) => ({ id, label: siteLabel(id) }))
const SITE_OPTIONS_ALL = [{ id: 'all', label: 'All five sites' }, ...SITE_OPTIONS]
const MONTH_OPTIONS = [0, 6, 7, 8, 9].map((m) => ({ id: String(m), label: MONTH_LABELS[m] }))
const BAND_SET_OPTIONS = [
  { id: 'wbgtBands', label: 'WBGT bands' },
  { id: 'adoshSun', label: 'ADOSH TWL zones (sun)' },
]

/** Band definitions for the stacked charts, least to most severe (ordinal blue ramp; risk colours stay reserved). */
function bandDefs(file: HoursFile, key: BandKey): BandDef[] {
  if (key === 'wbgtBands') {
    return file.config.wbgtBands.map((b, i) => ({ label: `WBGT ${b.label}${NBSP}°C`, color: COLORS.ordinal5[i] ?? COLORS.ordinal5[4] }))
  }
  const zones = [...file.config.adoshZones].reverse()
  const name: Readonly<Record<string, string>> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }
  return zones.map((z, i) => ({
    label: `${name[z.id] ?? z.label} (TWL ${z.minWm2 === null ? `≤ ${z.maxWm2}` : z.maxWm2 === null ? `≥ ${z.minWm2}` : `${z.minWm2}–${z.maxWm2}`})`,
    color: COLORS.ordinal3[i] ?? COLORS.ordinal3[2],
  }))
}

// ─── Hours by site / hour / month ───────────────────────────────────────────────────────────────────────────────────

function HoursBySite({ file }: { file: HoursFile }) {
  const [key, setKey] = useState<BandKey>('wbgtBands')
  const bands = useMemo(() => bandDefs(file, key), [file, key])
  const rows = useMemo(() => bandRowsBySite(file.sites, key, 'ifs'), [file, key])
  const season = file.headline.hoursPerSeason
  return (
    <ChartFrame
      title="Hours per season in each heat band, by site"
      description={`Mean of the ${file.config.years.length} seasons ${file.config.years[0]}–${file.config.years[file.config.years.length - 1]}, every hour from 1 June to 30 September. ECMWF IFS 9 km analysis, in sun.`}
      legend={bands.map((b) => ({ label: b.label, color: b.color }))}
      actions={<Segmented label="Bands" value={key} options={BAND_SET_OPTIONS} onChange={(id) => setKey(id as BandKey)} />}
      summary={`Stacked bars of hours per season by band for five sites; each bar totals ${num(season)} hours.`}
      height={260}
      table={
        <MiniTable
          caption="Hours per season by band and site"
          head={['Site', ...bands.map((b) => b.label), 'Total']}
          rows={rows.map((r) => [r.label, ...bands.map((_, i) => num(r[`b${i}`], 1)), num(r.total, 0)])}
        />
      }
      footnote={
        key === 'wbgtBands'
          ? 'Band edges from the engine equations: NIOSH REL at 300 W (28.2 °C), RAL at rest 115 W (30.8 °C), Qatar stop value (32.1 °C, comparison only), REL at rest (33.0 °C). Ordinary work clothes.'
          : 'ADOSH-SF Technical Guideline Safety in the Heat v4.0, Table 1: TWL in W/m², in direct sun. No hour reaches the High zone in engineered shade.'
      }
    >
      <StackedBarChart rows={rows} bands={bands} orientation="bars" unit="h per season" valueTitle="Hours per season" domainMax={season} ticks={[0, 500, 1000, 1500, 2000, 2500]} />
    </ChartFrame>
  )
}

function HoursWhen({ file }: { file: HoursFile }) {
  const [site, setSite] = useState<string>('musaffah')
  const [key, setKey] = useState<BandKey>('wbgtBands')
  const [view, setView] = useState<'hour' | 'month'>('hour')
  const bands = useMemo(() => bandDefs(file, key), [file, key])
  const rows = useMemo(
    () => (view === 'hour' ? bandRowsByHour(file.byHour, site, key, 5, 20) : bandRowsByMonth(file.byMonth, site, key)),
    [file, site, key, view],
  )
  const mb = file.config.middayBreak
  return (
    <ChartFrame
      title="When the hours occur"
      description={
        view === 'hour'
          ? `Hours per season at each local clock hour (GST), ${siteLabel(site)}. The shaded hours fall inside the midday break (${mb.startHhmm}–${mb.endHhmm}, 15 Jun–15 Sep).`
          : `Hours per month in each band, ${siteLabel(site)}, mean of ${file.config.years.length} seasons.`
      }
      legend={bands.map((b) => ({ label: b.label, color: b.color }))}
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <SelectField label="Site" value={site} options={SITE_OPTIONS} onChange={setSite} className="w-36" />
          <Segmented label="By" value={view} options={[{ id: 'hour', label: 'Hour of day' }, { id: 'month', label: 'Month' }]} onChange={(id) => setView(id as 'hour' | 'month')} />
          <Segmented label="Bands" value={key} options={BAND_SET_OPTIONS} onChange={(id) => setKey(id as BandKey)} />
        </div>
      }
      summary={`Stacked columns of hours per season by ${view === 'hour' ? 'local hour from 05:00 to 20:00' : 'month, June to September'} for ${siteLabel(site)}.`}
      height={290}
      table={
        <MiniTable
          caption={`Hours by ${view} and band, ${siteLabel(site)}`}
          head={[view === 'hour' ? 'Hour' : 'Month', ...bands.map((b) => b.label), 'Total']}
          rows={rows.map((r) => [view === 'hour' ? hourLabel(Number(r.key)) : (MONTH_LABELS[Number(r.key)] ?? r.label), ...bands.map((_, i) => num(r[`b${i}`], 1)), num(r.total, 0)])}
        />
      }
    >
      <StackedBarChart
        rows={rows}
        bands={bands}
        orientation="columns"
        unit={view === 'hour' ? 'h per season at this hour' : 'h in this month'}
        valueTitle="Hours"
        categoryTitle={view === 'hour' ? 'Local hour (GST)' : undefined}
        domainMax={view === 'hour' ? 122 : undefined}
        ticks={view === 'hour' ? [0, 30, 60, 90, 120] : undefined}
        shade={view === 'hour' ? { from: '13', to: '14', label: 'Midday break' } : undefined}
        tooltipTitle={(r) => (view === 'hour' ? `${hourLabel(Number(r.key))}–${hourLabel(Number(r.key) + 1)}, ${siteLabel(site)}` : `${MONTH_LABELS[Number(r.key)] ?? r.label}, ${siteLabel(site)}`)}
      />
    </ChartFrame>
  )
}

function MiddayBreakTable({ file }: { file: HoursFile }) {
  const rows = [...SITE_IDS, 'all'].map((id) => file.middayBreak.find((r) => r.site === id)).filter((r) => !!r)
  return (
    <div>
      <SubHead>Most high-heat hours fall outside the midday break</SubHead>
      <p className="mb-2 max-w-prose text-sm text-muted">
        The midday break bans outdoor work in direct sun for {file.config.middayBreak.startHhmm}–{file.config.middayBreak.endHhmm} on 15
        Jun–15 Sep (UAE MoHRE Ministerial Resolution 44 of 2022). Hours per season, and the share of them that the break does not cover.
      </p>
      <TableFrame label="High-heat hours inside and outside the midday break">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">ADOSH High-zone hours and hours at WBGT at or above 30.8 °C per season, inside and outside the midday break, by site.</caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-start`}>Site</th>
              <th scope="col" className={`${TH} text-end`}>ADOSH High zone, h</th>
              <th scope="col" className={`${TH} text-end`}>Outside the break</th>
              <th scope="col" className={`${TH} text-end`}>WBGT ≥ 30.8 °C, h</th>
              <th scope="col" className={`${TH} text-end`}>Outside the break</th>
              <th scope="col" className={`${TH} text-end`}>On dates outside 15 Jun–15 Sep</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.site} className={r.site === 'all' ? 'bg-canvas font-semibold' : undefined}>
                <th scope="row" className={`${TD} text-start font-medium text-ink`}>{siteLabel(r.site)}</th>
                <td className={`${TD} text-end tabular-nums`}>{num(r.adoshHighHours, 0)}</td>
                <td className={`${TD} text-end`}>
                  <ShareBar share={r.adoshHighShareOutside} />
                </td>
                <td className={`${TD} text-end tabular-nums`}>{num(r.wbgtGeRal115Hours, 0)}</td>
                <td className={`${TD} text-end`}>
                  <ShareBar share={r.wbgtGeRal115ShareOutside} />
                </td>
                <td className={`${TD} text-end tabular-nums`}>{pct(r.wbgtGeRal115OutsideSeasonDatesShare, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <p className="mt-2 text-xs text-subtle">The break is a floor, not a complete control: this is the gap the environment, regulation and projection channels address.</p>
    </div>
  )
}

// ─── Cooled cabin versus shade ──────────────────────────────────────────────────────────────────────────────────────

const SHADE_COLOR = '#86b6ef'
const CABIN_COLOR = '#1c5cab'

interface DumbbellShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: WorkRestPair
}

function DumbbellShape({ x = 0, y = 0, width = 0, height = 0, payload }: DumbbellShapeProps) {
  const cy = y + height / 2
  const shadeX = x
  const cabinX = x + width
  return (
    <g>
      <line x1={shadeX} x2={cabinX} y1={cy} y2={cy} stroke={COLORS.contextSoft} strokeWidth={4} strokeLinecap="round" />
      <circle cx={shadeX} cy={cy} r={6} fill={SHADE_COLOR} stroke="#ffffff" strokeWidth={2} />
      <circle cx={cabinX} cy={cy} r={6} fill={CABIN_COLOR} stroke="#ffffff" strokeWidth={2} />
      {payload && (
        <>
          <text x={shadeX} y={cy - 11} textAnchor="middle" fontSize={11} fill={COLORS.tick} className="tabular-nums">
            {num(payload.shade, 1)}
          </text>
          <text x={cabinX} y={cy - 11} textAnchor="middle" fontSize={11} fontWeight={600} fill={COLORS.ink} className="tabular-nums">
            {num(payload.cabin, 1)}
          </text>
        </>
      )}
    </g>
  )
}

function CabinVsShade({ file }: { file: HoursFile }) {
  const [view, setView] = useState<'site' | 'hour'>('site')
  const [site, setSite] = useState('all')
  const [month, setMonth] = useState('0')
  const [combo, setCombo] = useState(WORK_LIMIT_OPTIONS[0].id)
  const pairs = useMemo(() => workRestPairs(file.workRest.dayShift, site, Number(month)), [file, site, month])
  const byHour = useMemo(() => workRestByHour(file.workRest.byHour, combo), [file, combo])
  const cooled = file.workRest.cooledRest.wbgtC
  const legend = [
    { label: `Rest in engineered shade (modelled shade WBGT)`, color: SHADE_COLOR, shape: (view === 'site' ? 'dot' : 'line') as 'dot' | 'line' },
    { label: `Rest in a cooled cabin (WBGT ${cooled}${NBSP}°C)`, color: CABIN_COLOR, shape: (view === 'site' ? 'dot' : 'line') as 'dot' | 'line' },
  ]
  const comboLabel = WORK_LIMIT_OPTIONS.find((o) => o.id === combo)?.label ?? combo
  return (
    <ChartFrame
      title="Cooled cabin versus shade: allowed work per hour"
      description={
        view === 'site'
          ? `Mean allowed work minutes per hour in direct sun, day shift (hours 07–17), ${site === 'all' ? 'all five sites' : siteLabel(site)}, ${MONTH_LABELS[Number(month)]}, ${file.config.years[0]}–${file.config.years[file.config.years.length - 1]}. NIOSH/ACGIH one-hour TWA.`
          : `${comboLabel}: mean allowed work minutes per hour by local hour, all sites, Jun–Sep ${file.config.years[0]}–${file.config.years[file.config.years.length - 1]}.`
      }
      legend={legend}
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <Segmented label="View" value={view} options={[{ id: 'site', label: 'Day shift' }, { id: 'hour', label: 'By hour' }]} onChange={(id) => setView(id as 'site' | 'hour')} />
          {view === 'site' ? (
            <>
              <SelectField label="Site" value={site} options={SITE_OPTIONS_ALL} onChange={setSite} className="w-36" />
              <SelectField label="Period" value={month} options={MONTH_OPTIONS} onChange={setMonth} className="w-60" />
            </>
          ) : (
            <SelectField label="Work and limit" value={combo} options={WORK_LIMIT_OPTIONS} onChange={setCombo} className="w-64" />
          )}
        </div>
      }
      summary={
        view === 'site'
          ? `Dumbbell chart: allowed work minutes per hour with rest in shade versus a cooled cabin, for four work and limit combinations.`
          : `Line chart of allowed work minutes per hour by local hour with rest in shade and in a cooled cabin.`
      }
      height={view === 'site' ? 250 : 270}
      table={
        view === 'site' ? (
          <MiniTable
            caption="Allowed work minutes per hour, shade versus cooled cabin"
            head={['Work and limit', 'Shade, min/h', 'Cabin, min/h', 'Gain', 'Hours with no work: shade', 'cabin']}
            rows={pairs.map((p) => [
              p.label,
              num(p.shade, 1),
              num(p.cabin, 1),
              p.shade !== null && p.cabin !== null ? `+${num(p.cabin - p.shade, 1)}` : '—',
              pct(p.shadeZeroShare, 1),
              pct(p.cabinZeroShare, 1),
            ])}
          />
        ) : (
          <MiniTable
            caption={`Allowed work minutes per hour by local hour, ${comboLabel}`}
            head={['Hour', 'Shade, min/h', 'Cabin, min/h']}
            rows={byHour.map((r) => [hourLabel(r.hour), num(r.shade, 1), num(r.cabin, 1)])}
          />
        )
      }
      footnote={
        view === 'site'
          ? `REL: acclimatised workers; RAL: workers not acclimatised. Moderate 300 W, heavy 415 W, rest ${file.workRest.restMetabolicW} W. Cabin ${cooled} °C WBGT: ADOSH-SF CoP 11.0 §3.2(c) cooled rest areas, an engineering default for a conservative cabin.`
          : 'Hours 13:00 and 14:00 fall inside the midday break on 15 Jun–15 Sep; their values apply only to season dates outside the ban.'
      }
    >
      {view === 'site' ? (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={pairs} layout="vertical" margin={{ top: 16, right: 24, bottom: 22, left: 0 }} barCategoryGap={14} accessibilityLayer>
            <CartesianGrid stroke={COLORS.grid} horizontal={false} />
            <XAxis type="number" domain={[0, 60]} ticks={[0, 10, 20, 30, 40, 50, 60]} {...AXIS} label={{ value: 'Allowed work, min per hour', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis type="category" dataKey="label" width={150} {...AXIS} tick={{ fill: COLORS.tick, fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
              isAnimationActive={false}
              content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
                const r = tipRow<WorkRestPair>(props)
                if (!r) return null
                return (
                  <ChartTip
                    title={r.label}
                    lines={[
                      { label: 'cooled cabin, min/h', value: num(r.cabin, 1), color: CABIN_COLOR, shape: 'dot' },
                      { label: 'shade, min/h', value: num(r.shade, 1), color: SHADE_COLOR, shape: 'dot' },
                    ]}
                    note={`No work allowed: ${pct(r.shadeZeroShare, 1)} of hours with shade rest, ${pct(r.cabinZeroShare, 1)} with cabin rest`}
                  />
                )
              }}
            />
            <Bar dataKey="range" shape={(p: unknown) => <DumbbellShape {...(p as DumbbellShapeProps)} />} isAnimationActive={false} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={byHour} margin={{ top: 8, right: 16, bottom: 22, left: 4 }} accessibilityLayer>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <ReferenceArea x1={12.5} x2={15} fill={COLORS.band} fillOpacity={1} stroke={COLORS.bandStroke} strokeDasharray="3 3" label={{ value: 'Midday break', position: 'insideTop', fill: COLORS.tick, fontSize: 11 }} />
            <XAxis type="number" dataKey="hour" domain={[0, 23]} ticks={[0, 3, 6, 9, 12, 15, 18, 21]} tickFormatter={(h: number) => hourLabel(h)} {...AXIS} label={{ value: 'Local hour (GST)', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis domain={[0, 60]} ticks={[0, 15, 30, 45, 60]} width={40} {...AXIS} label={{ value: 'min per hour', angle: -90, position: 'insideLeft', offset: 10, fill: COLORS.tick, fontSize: 12, style: { textAnchor: 'middle' } }} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: COLORS.axis }}
              content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
                const r = tipRow<{ hour: number; shade: number | null; cabin: number | null }>(props)
                if (!r) return null
                return (
                  <ChartTip
                    title={`${hourLabel(r.hour)}–${hourLabel(r.hour + 1)}`}
                    lines={[
                      { label: 'cooled cabin, min/h', value: num(r.cabin, 1), color: CABIN_COLOR },
                      { label: 'shade, min/h', value: num(r.shade, 1), color: SHADE_COLOR },
                    ]}
                  />
                )
              }}
            />
            <Line type="monotone" dataKey="shade" stroke={SHADE_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="cabin" stroke={CABIN_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  )
}

// ─── TWL plausibility ───────────────────────────────────────────────────────────────────────────────────────────────

const SUN_COLOR = COLORS.series[0]
const SHADE_TWL_COLOR = COLORS.series[1]
const FIELD_COLOR = '#334155'

function TwlPlausibility({ file }: { file: HoursFile }) {
  const [site, setSite] = useState('all')
  const [period, setPeriod] = useState<'jun_sep' | 'june'>('jun_sep')
  const points = useMemo(() => twlPoints(file, site, period), [file, site, period])
  const pub = file.twlPlausibility.published
  const [lo, hi] = pub.miller2011.meanBandWm2
  const below = [...SITE_IDS, 'all'].map((id) => file.twlPlausibility.daysDaytimeMinBelow.find((d) => d.site === id)).filter((d) => !!d)
  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <ChartFrame
        title="TWL plausibility against UAE field studies"
        description={`Modelled mean Thermal Work Limit at the field studies' clock hours, ${site === 'all' ? 'all five sites' : siteLabel(site)}, ${period === 'june' ? 'June' : 'Jun–Sep'} ${file.config.years[0]}–${file.config.years[file.config.years.length - 1]}. Lower TWL means more heat stress.`}
        legend={[
          { label: 'Modelled, in sun', color: SUN_COLOR, shape: 'line' },
          { label: 'Modelled, in shade', color: SHADE_TWL_COLOR, shape: 'line' },
          { label: `Bates & Schneider 2008, field means (${pub.batesSchneider2008.month})`, color: FIELD_COLOR, shape: 'diamond' },
          { label: `Miller et al. 2011: summer means ${lo}–${hi} W/m²`, color: COLORS.band, shape: 'band' },
        ]}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <SelectField label="Site" value={site} options={SITE_OPTIONS_ALL} onChange={setSite} className="w-36" />
            <Segmented label="Period" value={period} options={[{ id: 'jun_sep', label: 'Jun–Sep' }, { id: 'june', label: 'June' }]} onChange={(id) => setPeriod(id as 'jun_sep' | 'june')} />
          </div>
        }
        summary={`Modelled TWL in sun and shade at 08:00, 12:00, 14:00 and 16:00 against published UAE field values.`}
        height={280}
        table={
          <MiniTable
            caption="Modelled TWL against field means, W/m²"
            head={['Hour', 'Sun, W/m²', 'Shade, W/m²', 'Bates & Schneider 2008', `Miller 2011 band`]}
            rows={points.map((p) => [p.label, num(p.sun, 1), num(p.shade, 1), num(p.field, 1), `${lo}–${hi}`])}
          />
        }
        footnote={
          <>
            {pub.batesSchneider2008.citation}. {pub.miller2011.citation}: {pub.miller2011.note}. A sanity check, not a validation: other
            years, months and instruments, and TWL is very sensitive to wind.
          </>
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 10, right: 16, bottom: 22, left: 4 }} accessibilityLayer>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <ReferenceArea y1={lo} y2={hi} fill={COLORS.band} fillOpacity={1} stroke={COLORS.bandStroke} />
            <ReferenceLine y={115} stroke={COLORS.context} strokeDasharray="4 3" label={{ value: 'ADOSH High zone ≤ 115', position: 'insideBottomRight', fill: COLORS.tick, fontSize: 11 }} />
            <XAxis type="number" dataKey="hour" domain={[7, 17]} ticks={[8, 12, 14, 16]} tickFormatter={(h: number) => hourLabel(h)} {...AXIS} label={{ value: 'Local hour (GST)', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis domain={[0, 320]} ticks={[0, 80, 115, 140, 200, 280]} width={44} {...AXIS} label={{ value: 'TWL, W/m²', angle: -90, position: 'insideLeft', offset: 10, fill: COLORS.tick, fontSize: 12, style: { textAnchor: 'middle' } }} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: COLORS.axis }}
              content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
                const r = tipRow<TwlPoint>(props)
                if (!r) return null
                return (
                  <ChartTip
                    title={r.label}
                    lines={[
                      { label: 'W/m², modelled in sun', value: num(r.sun, 1), color: SUN_COLOR },
                      { label: 'W/m², modelled in shade', value: num(r.shade, 1), color: SHADE_TWL_COLOR },
                      { label: 'W/m², Bates & Schneider 2008', value: num(r.field, 1), color: FIELD_COLOR, shape: 'diamond' },
                    ]}
                    note={`Miller 2011 summer means: ${lo}–${hi} W/m²`}
                  />
                )
              }}
            />
            <Line type="linear" dataKey="shade" stroke={SHADE_TWL_COLOR} strokeWidth={2} dot={{ r: 4, fill: SHADE_TWL_COLOR, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
            <Line type="linear" dataKey="sun" stroke={SUN_COLOR} strokeWidth={2} dot={{ r: 4, fill: SUN_COLOR, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
            <Scatter dataKey="field" fill={FIELD_COLOR} shape="diamond" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      <div className="space-y-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold text-ink">Reading it</h3>
          <ul className="mt-2 list-disc space-y-1.5 ps-4 text-xs text-ink marker:text-subtle">
            {file.twlPlausibility.verdict.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
        <MiniTable
          caption="Share of season days whose lowest daytime TWL falls below 140 and 115 W/m²"
          head={['Site', 'Days with daytime min < 140', '< 115']}
          rows={below.map((d) => [siteLabel(d.site), pct(d.below140Share, 0), pct(d.below115Share, 0)])}
        />
        <p className="text-xs text-subtle">
          Miller 2011 reported days below 140 and occasionally below 115 W/m²; the model shows such days on {pct(below.find((d) => d.site === 'all')?.below140Share, 0)} and{' '}
          {pct(below.find((d) => d.site === 'all')?.below115Share, 0)} of season days (daytime 07–17 h, sun).
        </p>
      </div>
    </div>
  )
}

// ─── Uncertainty ────────────────────────────────────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  metar_obs_met: 'METAR observations + model radiation',
  ecmwf_ifs: 'ECMWF IFS 9 km (model only)',
  era5: 'ERA5 reanalysis (model only)',
}

function Uncertainty({ file }: { file: HoursFile }) {
  const [open, setOpen] = useState(false)
  const anchor = file.observationalAnchor
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <DisclosureButton open={open} onToggle={() => setOpen((o) => !o)} controls={open ? 'exposure-uncertainty' : undefined}>
        Uncertainty: model choice, radiant allowance and an observational anchor
      </DisclosureButton>
      {open && (
        <div id="exposure-uncertainty" className="mt-3 grid gap-4 lg:grid-cols-2">
          <MiniTable
            caption="Hours per season at WBGT at or above 30.8 °C under other weather models and with the site radiant allowance"
            head={['Site', 'IFS 9 km, h', 'ERA5, h', 'ERA5 vs IFS', 'IFS + radiant allowance, h', 'vs IFS']}
            rows={file.sensitivity.map((s) => [
              siteLabel(s.site),
              num(s.ral115HoursIfs, 0),
              num(s.ral115HoursEra5, 0),
              signedPct(s.era5MinusIfsPct / 100, 1),
              num(s.ral115HoursWithBoost, 0),
              signedPct(s.boostMinusNonePct / 100, 1),
            ])}
          />
          {anchor ? (
            <div className="space-y-2">
              <MiniTable
                caption="Summer 2025 hours at airports: METAR-based against model-only"
                head={['Airport · source', 'Matched h', 'WBGT ≥ 30.8 °C, h', 'ADOSH High (sun), h']}
                rows={anchor.rows.map((r) => [`${r.icao} · ${SOURCE_LABEL[r.source] ?? r.source}`, num(r.nMatched, 0), num(r.geRal115, 0), num(r.adoshHighSun, 0)])}
              />
              <p className="text-xs text-subtle">{anchor.note}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────────────────────────────────────────

function ExposureBody({ file }: { file: HoursFile }) {
  const h = file.headline
  const years = `${file.config.years[0]}–${file.config.years[file.config.years.length - 1]}`
  return (
    <div className="space-y-4">
      <KpiRow>
        <Kpi label="Hours at WBGT ≥ 30.8 °C per season" value={num(h.meanSiteHoursGeRal115PerSeason, 0)} unit="h" hint={`Mean of five sites, of ${num(h.hoursPerSeason)} season hours: above the RAL at rest`} />
        <Kpi label="Of those, outside the midday break" value={pct(h.shareWbgtGeRal115OutsideMiddayBreak, 0)} hint={`And ${pct(h.shareAdoshHighOutsideMiddayBreak, 0)} of ADOSH High-zone hours`} />
        <Kpi label="ADOSH High-zone hours, in sun" value={num(h.meanSiteHoursAdoshHighSunPerSeason, 0)} unit="h" hint={`Per season and site; ${num(h.meanSiteHoursAdoshHighShadePerSeason, 0)} in engineered shade`} />
        <Kpi
          label="Cooled cabin vs shade rest"
          value={`${num(h.dayShiftModerateRelCabinMinPerHour, 1)} vs ${num(h.dayShiftModerateRelShadeMinPerHour, 1)}`}
          unit="min/h"
          hint="Allowed work, moderate work, acclimatised, day shift"
        />
      </KpiRow>
      <div className="grid gap-4 2xl:grid-cols-2">
        <HoursBySite file={file} />
        <HoursWhen file={file} />
      </div>
      <MiddayBreakTable file={file} />
      <CabinVsShade file={file} />
      <TwlPlausibility file={file} />
      <Uncertainty file={file} />
      <MethodPanel
        method={
          <>
            <p>
              Every hour of every season ({file.config.season.split('(')[0].replace(' local, every hour', '').trim()}), {years}, at the five sites: Liljegren WBGT in sun and engineered shade, and
              TWL in sun and shade, computed by the engine from the archived ECMWF IFS 9 km analysis (ERA5 as a check). Hours are counted per band
              and averaged over the seasons.
            </p>
            <p className="text-muted">{file.workRest.method}</p>
          </>
        }
        caveats={[
          ...file.config.notes.slice(0, 2),
          'Exposure, not outcomes: hours in a zone describe the environment. They are not worker-hours, not incidence, and not a prediction of heat illness.',
          'Band edges assume ordinary work clothes and the ACGIH resting rate; coveralls, FR clothing or a hood raise the effective WBGT.',
        ]}
        script="scripts/validate/hours-in-zone.ts"
        file={file}
        docs={[
          { path: 'docs/VALIDATION.md', label: 'VALIDATION.md §2 Hours in each heat zone' },
          { path: 'docs/research/data_and_validation.md', label: 'Research note: data and validation' },
        ]}
      />
    </div>
  )
}

export function ExposureSection({ state }: { state: FileState<HoursFile> }) {
  const detail = state.status === 'ready' ? `${state.data.config.years.length} seasons · ECMWF IFS 9 km · stamp ${state.data.stamp?.stamp ?? '—'}` : undefined
  return (
    <Section
      id={EXPOSURE_SECTION_ID}
      title="2 · Real-weather exposure, 2020–2025"
      provenance="real_weather"
      provenanceDetail={detail}
      description="How often Abu Dhabi worksites reach each heat band and ADOSH zone, when those hours fall, what cooled rest buys, and whether the modelled TWL agrees with UAE field studies."
    >
      <FileGate state={state} label="Real-weather exposure">
        {(file) => <ExposureBody file={file} />}
      </FileGate>
    </Section>
  )
}

