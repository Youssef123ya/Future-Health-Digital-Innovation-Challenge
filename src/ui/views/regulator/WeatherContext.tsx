/**
 * Real-weather context: how many hours per season each Abu Dhabi site spends in each WBGT band and ADOSH TWL zone, by
 * month and by hour of day, and how much of the high heat falls outside the midday break. Source:
 * public/data/validation/hours-in-zone.json (ECMWF IFS analysis via Open-Meteo, Jun–Sep 2020–2025; environmental data,
 * no person). Charts follow the dataviz method: stacked bars for wholes on one shared axis, a validated one-hue ordinal
 * ramp (blue 700→250, light end ≥ 2:1 on white) with the most severe band on the baseline, ≤ 24 px bars with a 2 px
 * surface gap, hairline grid, a legend, a hover tooltip and a data-table twin for every chart.
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts'
import { CloudSun, LoaderCircle } from 'lucide-react'
import { SITES } from '../../../data/sites'
import { useUi } from '../../../state/hooks'
import { Card, CardHeader, EmptyState, Section, Stat, cx } from '../../components'
import {
  hourRows,
  middayBreakHours,
  middayRow,
  monthRows,
  seasonRows,
  seriesFor,
  useHoursInZone,
  type HizMeasure,
  type HizRow,
  type HizSeries,
  type HoursInZoneFile,
} from './weatherData'
import { DataDisclosure, Segmented } from './ui'
import { num, pct } from './format'

/** Ordinal ramp, most severe first (validated: scripts/validate_palette.js --ordinal on #ffffff, all checks pass). */
const WBGT_RAMP = ['#0d366b', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef']
const ADOSH_RAMP: Readonly<Record<string, string>> = { high: '#184f95', medium: '#5598e7' }
const GRID = '#e2e8f0'
const AXIS_TEXT = '#64748b'
const SURFACE = '#ffffff'

const siteName = (id: string): string => SITES.find((s) => s.id === id)?.name ?? id
const SITE_ORDER = SITES.map((s) => s.id)
const SHORT_NAMES: Readonly<Record<string, string>> = { musaffah: 'Musaffah', kezad: 'KEZAD', ruwais: 'Ruwais', alain: 'Al Ain', saadiyat: 'Saadiyat' }

function colorOf(measure: HizMeasure, series: readonly HizSeries[], s: HizSeries): string {
  return measure === 'wbgt' ? (WBGT_RAMP[series.indexOf(s)] ?? WBGT_RAMP[WBGT_RAMP.length - 1]) : (ADOSH_RAMP[s.id] ?? '#5598e7')
}

// ─────────────────────────────── Section ───────────────────────────────

/** Memoised: its props are stable strings, so the simulation clock does not re-render the charts. */
export const WeatherContext = memo(function WeatherContext({ focusSiteId, mode }: { focusSiteId: string; mode: 'regulator' | 'hse' }) {
  const hiz = useHoursInZone()
  const [measure, setMeasure] = useState<HizMeasure>('wbgt')
  const [site, setSite] = useState<string>(focusSiteId)

  return (
    <Section
      title="Real-weather context"
      provenance="real_weather"
      provenanceDetail="ECMWF IFS analysis via Open-Meteo (CC BY 4.0), 1 Jun – 30 Sep, 2020–2025"
      description={
        mode === 'regulator'
          ? 'Hours per season in each heat band at the five Abu Dhabi sites: where the exposure is, and how much of it the midday break does not cover.'
          : 'Hours per season in each heat band at this site and its neighbours, by month and by hour of day.'
      }
    >
      {hiz.status === 'loading' && (
        <Card className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden size={16} className="motion-safe:animate-spin" /> Loading hours-in-zone data…
        </Card>
      )}
      {hiz.status === 'error' && (
        <EmptyState tone="unavailable" icon={CloudSun} title="Real-weather data unavailable" description={`hours-in-zone.json could not be loaded (${hiz.message}).`} />
      )}
      {hiz.status === 'ready' && <WeatherBody data={hiz.data} measure={measure} setMeasure={setMeasure} site={site} setSite={setSite} liveSiteId={focusSiteId} />}
    </Section>
  )
})

function WeatherBody({
  data,
  measure,
  setMeasure,
  site,
  setSite,
  liveSiteId,
}: {
  data: HoursInZoneFile
  measure: HizMeasure
  setMeasure: (m: HizMeasure) => void
  site: string
  setSite: (s: string) => void
  liveSiteId: string
}) {
  const series = useMemo(() => seriesFor(data, measure), [data, measure])
  const season = useMemo(() => seasonRows(data, measure, SITE_ORDER, (id) => SHORT_NAMES[id] ?? siteName(id)), [data, measure])
  const months = useMemo(() => monthRows(data, site, measure), [data, site, measure])
  const hours = useMemo(() => hourRows(data, site, measure), [data, site, measure])
  const mb = data.config.middayBreak
  const breakHours = middayBreakHours(mb.startHhmm, mb.endHhmm)
  const breakLabels = breakHours.map((h) => `${String(h).padStart(2, '0')}:00`)
  const mrSite = middayRow(data, site)
  const mrAll = middayRow(data, 'all')
  const years = data.config.years
  const unitWord = measure === 'wbgt' ? 'band' : 'zone'
  const measureNote =
    measure === 'wbgt'
      ? 'WBGT bands from the engine equations: REL(300 W) 28.2 °C, RAL(115 W) 30.8 °C, the Qatar stop value 32.1 °C (comparison only) and REL(115 W) 33.0 °C.'
      : 'ADOSH-SF TG v4.0 Table 1 zones from the sun TWL; the Low zone (TWL ≥ 140 W/m²) carries no zone controls and is not charted.'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented<HizMeasure>
          label="Measure"
          value={measure}
          onChange={setMeasure}
          options={[
            { id: 'wbgt', label: 'WBGT band' },
            { id: 'adosh', label: 'ADOSH zone (sun)' },
          ]}
        />
        <Segmented<string>
          label="Site for the month and hour charts"
          value={site}
          onChange={setSite}
          options={SITE_ORDER.map((id) => ({ id, label: <span>{SHORT_NAMES[id] ?? siteName(id)}{id === liveSiteId ? <span className="sr-only"> (live site)</span> : null}{id === liveSiteId ? <span aria-hidden className="ms-1 inline-block size-1.5 rounded-full bg-shade align-middle" /> : null}</span> }))}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card as="section" aria-label="Hours per season by site" className="xl:col-span-3">
          <CardHeader
            title="Hours per season, by site"
            description={`Mean of ${years[0]}–${years[years.length - 1]}, ${data.config.season.split('(')[0].trim()}. ${measure === 'wbgt' ? 'Each bar is the whole season (2,928 h).' : 'Hours with ADOSH zone controls (sun).'}`}
          />
          <ChartLegend series={series} measure={measure} />
          <StackedBars
            rows={season}
            series={series}
            measure={measure}
            layout="bars"
            height={season.length * 40 + 40}
            ariaLabel={`Stacked bar chart: mean hours per season in each ${unitWord}, by site.`}
            highlight={SHORT_NAMES[site] ?? siteName(site)}
            onSelect={(label) => {
              const id = SITE_ORDER.find((x) => (SHORT_NAMES[x] ?? siteName(x)) === label)
              if (id) setSite(id)
            }}
          />
          <DataDisclosure>
            <SeriesTable rows={season} series={series} rowHeader="Site" caption={`Mean hours per season by ${unitWord} and site`} />
          </DataDisclosure>
        </Card>

        <Card as="section" aria-label="High heat outside the midday break" className="xl:col-span-2">
          <CardHeader
            title="High heat outside the midday break"
            description={`${siteName(site)}: share of high-heat hours that fall outside ${mb.startHhmm}–${mb.endHhmm} on 15 Jun – 15 Sep, the only window the federal rule covers.`}
          />
          {mrSite ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Stat
                framed
                label="WBGT ≥ 30.8 °C hours outside the break"
                value={Math.round(mrSite.wbgtGeRal115ShareOutside * 100)}
                unit="%"
                info="Hours at or above RAL(115 W) = 30.8 °C, where resting in the same conditions already exceeds the limit for unacclimatised workers."
                hint={`${num(mrSite.wbgtGeRal115OutsideBreak, 0)} of ${num(mrSite.wbgtGeRal115Hours, 0)} h per season · five-site mean ${pct(mrAll?.wbgtGeRal115ShareOutside ?? null)}`}
              />
              <Stat
                framed
                label="ADOSH High-zone hours outside the break"
                value={Math.round(mrSite.adoshHighShareOutside * 100)}
                unit="%"
                info="Hours with sun TWL below 115 W/m² (ADOSH High Risk Zone: strict work/rest cycling, no unacclimatised or lone work)."
                hint={`${num(mrSite.adoshHighOutsideBreak, 1)} of ${num(mrSite.adoshHighHours, 1)} h per season · five-site mean ${pct(mrAll?.adoshHighShareOutside ?? null)}`}
              />
            </div>
          ) : (
            <p className="text-sm text-muted">No midday-break summary for this site.</p>
          )}
          <p className="mt-3 text-xs text-muted">
            {pct(mrSite?.wbgtGeRal115OutsideSeasonDatesShare ?? null)} of the WBGT ≥ 30.8 °C hours fall on season dates outside 15 Jun – 15 Sep, when no
            midday break applies at all. Zone and work/rest duties apply whenever the conditions do.
          </p>
        </Card>

        <Card as="section" aria-label="Hours by month" className="xl:col-span-2">
          <CardHeader title={`By month · ${siteName(site)}`} description={`Mean hours per month in each ${unitWord}.`} />
          <ChartLegend series={series} measure={measure} />
          <StackedBars rows={months} series={series} measure={measure} layout="columns" height={240} ariaLabel={`Stacked column chart: mean hours per month in each ${unitWord}, ${siteName(site)}.`} />
          <DataDisclosure>
            <SeriesTable rows={months} series={series} rowHeader="Month" caption={`Mean hours per month by ${unitWord}, ${siteName(site)}`} />
          </DataDisclosure>
        </Card>

        <Card as="section" aria-label="Hours by hour of day" className="xl:col-span-3">
          <CardHeader
            title={`By hour of day · ${siteName(site)}`}
            description={`Mean days per season (of 122) in each ${unitWord} at each local hour. The shaded hours fall inside the midday break on 15 Jun – 15 Sep.`}
          />
          <ChartLegend series={series} measure={measure} extra={<span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-3 w-4 rounded-sm bg-shade/15 ring-1 ring-shade/30" />Midday break {mb.startHhmm}–{mb.endHhmm}</span>} />
          <StackedBars
            rows={hours}
            series={series}
            measure={measure}
            layout="columns"
            height={260}
            ariaLabel={`Stacked column chart: mean days per season in each ${unitWord} at each hour of day, ${siteName(site)}; ${breakLabels.join(' and ')} fall inside the midday break.`}
            shadeFrom={breakLabels[0]}
            shadeTo={breakLabels[breakLabels.length - 1]}
          />
          <DataDisclosure>
            <SeriesTable rows={hours} series={series} rowHeader="Hour" caption={`Mean days per season by ${unitWord} at each hour, ${siteName(site)}`} unit="d" />
          </DataDisclosure>
        </Card>
      </div>

      <div className="space-y-1 text-xs text-muted">
        <p>{measureNote}</p>
        <p>
          Model grid-cell values, not worksite measurements (about ±1.0–1.2 °C WBGT against airport METARs); the primary run applies no site radiant
          allowance. {data.provenance?.attribution?.weather ?? ''}
          {data.stamp?.stamp ? ` · ${data.stamp.stamp}` : ''}
        </p>
      </div>
    </div>
  )
}

// ─────────────────────────────── Chart pieces ───────────────────────────────

function ChartLegend({ series, measure, extra }: { series: readonly HizSeries[]; measure: HizMeasure; extra?: ReactNode }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Legend">
      {series.map((s) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-3 rounded-sm" style={{ backgroundColor: colorOf(measure, series, s) }} />
          {s.label}
        </li>
      ))}
      {extra && <li className="inline-flex items-center">{extra}</li>}
    </ul>
  )
}

interface StackedBarsProps {
  rows: readonly HizRow[]
  series: readonly HizSeries[]
  measure: HizMeasure
  layout: 'bars' | 'columns'
  height: number
  ariaLabel: string
  /** Category label drawn in bold (the selected site). */
  highlight?: string
  onSelect?: (label: string) => void
  /** Category range shaded as a reference band (the midday-break hours). */
  shadeFrom?: string
  shadeTo?: string
}

interface TickArgs {
  x?: number | string
  y?: number | string
  payload?: { value?: unknown }
}

function StackedBars({ rows, series, measure, layout, height, ariaLabel, highlight, onSelect, shadeFrom, shadeTo }: StackedBarsProps) {
  const rtl = useUi((s) => s.dir) === 'rtl'
  const bars = layout === 'bars'
  const last = series.length - 1
  const radius = (i: number): [number, number, number, number] => (i !== last ? [0, 0, 0, 0] : bars ? (rtl ? [4, 0, 0, 4] : [0, 4, 4, 0]) : [4, 4, 0, 0])
  const tick = { fill: AXIS_TEXT, fontSize: 12 }
  const siteTick = (p: TickArgs) => {
    const label = String(p.payload?.value ?? '')
    const on = label === highlight
    return (
      <text x={Number(p.x)} y={Number(p.y)} dy={4} textAnchor={rtl ? 'start' : 'end'} fontSize={12} fontWeight={on ? 700 : 400} fill={on ? '#0b1220' : AXIS_TEXT}>
        {label}
      </text>
    )
  }
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows as HizRow[]}
          layout={bars ? 'vertical' : 'horizontal'}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barCategoryGap={bars ? '30%' : '18%'}
          maxBarSize={24}
          onClick={(state) => {
            const label = state?.activeLabel
            if (onSelect && label !== undefined && label !== null) onSelect(String(label))
          }}
          style={onSelect ? { cursor: 'pointer' } : undefined}
        >
          <CartesianGrid stroke={GRID} vertical={bars} horizontal={!bars} />
          {bars ? (
            <>
              <XAxis type="number" tick={tick} axisLine={false} tickLine={false} reversed={rtl} tickFormatter={(v: number) => v.toLocaleString('en-US')} />
              <YAxis type="category" dataKey="label" width={76} axisLine={false} tickLine={false} orientation={rtl ? 'right' : 'left'} tick={siteTick} />
            </>
          ) : (
            <>
              <XAxis dataKey="label" tick={tick} axisLine={{ stroke: '#cbd5e1' }} tickLine={false} reversed={rtl} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tick={tick} axisLine={false} tickLine={false} width={44} orientation={rtl ? 'right' : 'left'} tickFormatter={(v: number) => v.toLocaleString('en-US')} />
            </>
          )}
          {shadeFrom && shadeTo && (
            <ReferenceArea
              x1={shadeFrom}
              x2={shadeTo}
              fill="#0f766e"
              fillOpacity={0.1}
              stroke="#0f766e"
              strokeOpacity={0.3}
              ifOverflow="extendDomain"
              label={{ value: 'Midday break', position: 'insideTop', fill: '#115e59', fontSize: 11, fontWeight: 600 }}
            />
          )}
          <ChartTooltip
            cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
            isAnimationActive={false}
            content={(p: TooltipContentProps) => <ChartTip active={p.active} label={p.label} rows={rows} series={series} measure={measure} unit={layout === 'columns' && rows.length === 24 ? 'd' : 'h'} />}
          />
          {series.map((s, i) => (
            <Bar key={s.id} dataKey={s.id} name={s.label} stackId="hours" fill={colorOf(measure, series, s)} stroke={SURFACE} strokeWidth={1} radius={radius(i)} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChartTip({ active, label, rows, series, measure, unit }: { active: boolean; label: string | number | undefined; rows: readonly HizRow[]; series: readonly HizSeries[]; measure: HizMeasure; unit: string }) {
  if (!active || label === undefined) return null
  const row = rows.find((r) => r.label === String(label))
  if (!row) return null
  return (
    <div className="min-w-48 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold text-ink">{row.label}</p>
      <ul className="space-y-1">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: colorOf(measure, series, s) }} />
            <span className="w-12 text-end font-semibold text-ink tabular-nums">
              {num(Number(row[s.id] ?? 0), 1)} {unit}
            </span>
            <span className="text-muted">{s.label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 border-t border-line pt-1.5 text-muted">
        <span className="font-semibold text-ink tabular-nums">{num(row.total, 1)} {unit}</span> in total
      </p>
    </div>
  )
}

function SeriesTable({ rows, series, rowHeader, caption, unit = 'h' }: { rows: readonly HizRow[]; series: readonly HizSeries[]; rowHeader: string; caption: string; unit?: string }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full min-w-max text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-canvas">
          <tr className="border-b border-line">
            <th scope="col" className="py-1.5 pe-3 text-start font-semibold text-muted">
              {rowHeader}
            </th>
            {series.map((s) => (
              <th key={s.id} scope="col" className="px-2 py-1.5 text-end font-semibold text-muted">
                {s.label.replace('WBGT ', '')}
              </th>
            ))}
            <th scope="col" className="ps-2 py-1.5 text-end font-semibold text-muted">
              Total ({unit})
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line/60">
              <th scope="row" className="py-1 pe-3 text-start font-medium text-ink">
                {r.label}
              </th>
              {series.map((s) => (
                <td key={s.id} className="px-2 py-1 text-end text-ink tabular-nums">
                  {num(Number(r[s.id] ?? 0), 1)}
                </td>
              ))}
              <td className={cx('ps-2 py-1 text-end font-semibold text-ink tabular-nums')}>{num(r.total, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
