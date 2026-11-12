/**
 * Evidence headline of the overview: four stat tiles (real weather, archived forecasts, reference implementations) and
 * the simulated-cohort comparison of both Zill plan bases against the two baselines, as two small multiples on their own
 * axes (excessive heat-strain worker-shifts per 1,000; work minutes per worker-shift), with 95 % intervals, direct
 * labels, a hover tooltip and a table view. Emphasis form: Zill arms in teal (#0d9488), baselines in a de-emphasis gray
 * (#a3acb9); identity is also carried by the axis labels (validated with the dataviz palette checker: CVD ΔE 11.3,
 * normal-vision ΔE 17.3; the gray's < 3:1 contrast is relieved by direct labels and the table).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { BookOpenCheck, FlaskConical } from 'lucide-react'
import { ProvenanceTag, Stat, cx } from '../../components'
import { toHref, pathFor } from '../../router'
import {
  formatRate,
  formatShare,
  parseCohortHeadline,
  parseForecastHeadline,
  parseHoursHeadline,
  parseReferenceSummary,
  type CohortArmRow,
  type CohortHeadline,
  type ForecastHeadline,
  type HoursHeadline,
  type ReferenceHeadline,
} from './evidence'

const ACCENT = '#0d9488'
const CONTEXT = '#a3acb9'
const WHISKER = '#334155'
const AXIS_TEXT = '#64748b'
const LABEL_TEXT = '#334155'

interface EvidenceData {
  hours: HoursHeadline | null
  forecast: ForecastHeadline | null
  reference: ReferenceHeadline | null
  cohort: CohortHeadline | null
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

let evidencePromise: Promise<EvidenceData> | null = null

/** Loads the four validation outputs once per page session (relative paths: the build runs under base './'). */
function loadEvidence(): Promise<EvidenceData> {
  evidencePromise ??= Promise.all(
    ['hours-in-zone', 'forecast-skill', 'reference', 'cohort'].map((f) => getJson(`./data/validation/${f}.json`).catch(() => null)),
  ).then(([hours, forecast, reference, cohort]) => ({
    hours: parseHoursHeadline(hours),
    forecast: parseForecastHeadline(forecast),
    reference: parseReferenceSummary(reference),
    cohort: parseCohortHeadline(cohort),
  }))
  return evidencePromise
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

// ─────────────────────────────── Cohort small multiples ───────────────────────────────

interface ChartRow {
  label: string
  short: string
  value: number
  lo: number | null
  hi: number | null
  text: string
  zill: boolean
  row: CohortArmRow
}

const SHORT: Readonly<Record<CohortArmRow['arm'], string>> = {
  ban_only: 'Midday ban',
  site_index: 'ADOSH zones',
  zill_full: 'Zill standard',
  zill_monitored: 'Zill monitored',
}

interface ShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: ChartRow
  background?: { x: number; y: number; width: number; height: number }
}

/** Bar with a 4 px rounded data end, its 95 % interval whisker and the direct label past the whisker. */
function barShape(domainMax: number) {
  return function BarWithInterval(props: unknown): ReactElement {
    const { x = 0, y = 0, width = 0, height = 0, payload, background } = props as ShapeProps
    if (!payload) return <g />
    const x0 = background?.x ?? x
    const scale = background && domainMax > 0 ? background.width / domainMax : payload.value > 0 ? width / payload.value : 0
    const cy = y + height / 2
    const end = x0 + payload.value * scale
    const r = Math.min(4, Math.max(0, end - x0))
    const fill = payload.zill ? ACCENT : CONTEXT
    const bar =
      end - x0 > 0.5 ? (
        <path d={`M${x0},${y} H${end - r} Q${end},${y} ${end},${y + r} V${y + height - r} Q${end},${y + height} ${end - r},${y + height} H${x0} Z`} fill={fill} />
      ) : (
        <rect x={x0} y={y} width={1.5} height={height} fill={fill} />
      )
    const hasCi = payload.lo !== null && payload.hi !== null && payload.hi > payload.lo
    const xLo = hasCi ? x0 + (payload.lo ?? 0) * scale : end
    const xHi = hasCi ? x0 + (payload.hi ?? 0) * scale : end
    const labelX = Math.max(end, xHi) + 8
    return (
      <g>
        {bar}
        {hasCi && (
          <g stroke={WHISKER} strokeWidth={1.5}>
            <line x1={xLo} x2={xHi} y1={cy} y2={cy} />
            <line x1={xLo} x2={xLo} y1={cy - 5} y2={cy + 5} />
            <line x1={xHi} x2={xHi} y1={cy - 5} y2={cy + 5} />
          </g>
        )}
        <text x={labelX} y={cy} dominantBaseline="central" fontSize={12} fontWeight={600} fill={LABEL_TEXT} className="tabular-nums">
          {payload.text}
        </text>
      </g>
    )
  }
}

function ChartTip({ active, payload, unit }: { active?: boolean; payload?: readonly { payload?: ChartRow }[]; unit: string }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row) return null
  const r = row.row
  return (
    <div className="max-w-60 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-snug text-white shadow-lg">
      <p className="font-semibold">{row.label}</p>
      <p className="tabular-nums">
        {row.text} {unit}
      </p>
      {row.lo !== null && row.hi !== null && row.hi > row.lo ? (
        <p className="tabular-nums text-white/75">
          95 % interval {Math.round(row.lo)}–{Math.round(row.hi)}
        </p>
      ) : null}
      <p className="text-white/75">{r.workerShifts} simulated worker-shifts</p>
    </div>
  )
}

function niceMax(v: number): number {
  if (v <= 0) return 10
  const p = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / p) * p
}

function CohortChart({ title, unit, rows, wide }: { title: string; unit: string; rows: ChartRow[]; wide: boolean }) {
  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.value, r.hi ?? 0))) * 1.05)
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 text-sm font-semibold text-ink">{title}</figcaption>
      <div className="h-[196px]" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 72, bottom: 0, left: 0 }} barCategoryGap="30%">
            <CartesianGrid horizontal={false} stroke="#eef2f6" />
            <XAxis
              type="number"
              domain={[0, max]}
              tickCount={5}
              allowDecimals={false}
              tick={{ fontSize: 11, fill: AXIS_TEXT }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
            />
            <YAxis
              type="category"
              dataKey={wide ? 'label' : 'short'}
              width={wide ? 178 : 104}
              tick={{ fontSize: 12, fill: '#475569' }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip cursor={{ fill: 'rgba(15, 118, 110, 0.06)' }} content={<ChartTip unit={unit} />} isAnimationActive={false} />
            <Bar dataKey="value" barSize={20} background={{ fill: 'transparent' }} shape={barShape(max)} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

function CohortCard({ cohort }: { cohort: CohortHeadline }) {
  const wide = useMediaQuery('(min-width: 640px)')
  const byArm = Object.fromEntries(cohort.arms.map((a) => [a.arm, a])) as Record<CohortArmRow['arm'], CohortArmRow>
  const eventRows: ChartRow[] = cohort.arms.map((r) => ({
    label: r.label,
    short: SHORT[r.arm],
    value: r.excessivePer1000,
    lo: r.excessiveCi?.[0] ?? null,
    hi: r.excessiveCi?.[1] ?? null,
    text: formatRate(r),
    zill: r.zill,
    row: r,
  }))
  const workRows: ChartRow[] = cohort.arms.map((r) => ({
    label: r.label,
    short: SHORT[r.arm],
    value: r.workMin,
    lo: r.workCi?.[0] ?? null,
    hi: r.workCi?.[1] ?? null,
    text: String(Math.round(r.workMin)),
    zill: r.zill,
    row: r,
  }))
  const ban = byArm.ban_only
  const site = byArm.site_index
  const zill = byArm.zill_full
  const upper = zill.excessiveUpper95 !== null ? Math.round(zill.excessiveUpper95) : null
  const change = cohort.workChangeVsBan

  return (
    <article className="rounded-2xl border border-line bg-surface p-4 sm:p-5" aria-labelledby="cohort-title">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id="cohort-title" className="text-base font-semibold text-ink">
            Simulated cohort: heat strain prevented, at a work cost
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {zill.workerShifts} simulated worker-shifts per arm on {cohort.siteDays ?? 'the'} real 2025 site-days at{' '}
            {cohort.sites ?? 'five'} Abu Dhabi sites. Both Zill plan bases projected{' '}
            <strong className="font-semibold text-ink">no excessive heat strain</strong>
            {upper !== null ? ` (0; 95 % upper bound ${upper} per 1,000)` : ''}, against{' '}
            <strong className="font-semibold text-ink">{Math.round(ban.excessivePer1000)} per 1,000</strong> under the midday ban
            alone and {Math.round(site.excessivePer1000)} under the ADOSH zone policy. The cost is large:{' '}
            <strong className="font-semibold text-ink">
              {Math.round(zill.workMin)} work minutes per shift against {Math.round(ban.workMin)}
              {change !== null ? ` (${Math.round(change * 100)} %)` : ''}
            </strong>
            . It comes from the day planner and is under review.
          </p>
        </div>
        <ProvenanceTag kind="simulated" detail="Virtual workforce on real 2025 weather; ground truth from an independent physiological model (docs/SIMULATION.md)." />
      </div>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <CohortChart title="Worker-shifts with excessive heat strain, per 1,000" unit="per 1,000 worker-shifts" rows={eventRows} wide={wide} />
        <CohortChart title="Work minutes per worker-shift" unit="work minutes per shift" rows={workRows} wide={wide} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 rounded-sm" style={{ background: ACCENT }} />
          Zill
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 rounded-sm" style={{ background: CONTEXT }} />
          Baselines
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-4 bg-[#334155]" />
          95 % interval (cluster bootstrap)
        </span>
        <span>Excessive strain: simulated core ≥ 38.5 °C (≥ 38.0 °C if unacclimatised) for ≥ 10 min.</span>
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer rounded-sm text-xs font-semibold text-shade-dark">Show as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-start text-xs">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="py-1.5 pe-3 text-start font-semibold">Arm</th>
                <th scope="col" className="py-1.5 pe-3 text-end font-semibold">Worker-shifts</th>
                <th scope="col" className="py-1.5 pe-3 text-end font-semibold">Excessive strain /1,000 [95 %]</th>
                <th scope="col" className="py-1.5 text-end font-semibold">Work min/shift [95 %]</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {cohort.arms.map((r) => (
                <tr key={r.arm} className="border-b border-line last:border-0">
                  <th scope="row" className="py-1.5 pe-3 text-start font-medium text-ink">{r.label}</th>
                  <td className="py-1.5 pe-3 text-end">{r.workerShifts}</td>
                  <td className="py-1.5 pe-3 text-end">
                    {formatRate(r)}
                    {r.excessiveCi && r.excessiveCi[1] > r.excessiveCi[0] ? ` [${Math.round(r.excessiveCi[0])}–${Math.round(r.excessiveCi[1])}]` : ''}
                  </td>
                  <td className="py-1.5 text-end">
                    {Math.round(r.workMin)}
                    {r.workCi ? ` [${Math.round(r.workCi[0])}–${Math.round(r.workCi[1])}]` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {cohort.disclaimer && <p className="mt-3 text-xs leading-relaxed text-subtle">{cohort.disclaimer}</p>}
    </article>
  )
}

// ─────────────────────────────── Section ───────────────────────────────

function Tiles({ data }: { data: EvidenceData }) {
  const { hours, forecast, reference } = data
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {hours && (
        <Stat
          framed
          label="High-heat hours outside the midday break"
          value={formatShare(hours.shareHighHeatOutsideBreak)}
          provenance="real_weather"
          provenanceDetail="ECMWF IFS analysis, five Abu Dhabi sites, June–September 2020–2025"
          hint={`of the ${Math.round(hours.hoursAtOrAboveRal)} h a season at WBGT ≥ 30.8 °C — above the NIOSH limit for an unacclimatised worker even at rest — fall outside 12:30–15:00; so do ${formatShare(hours.shareAdoshHighOutsideBreak)} of ADOSH High-zone hours.`}
        />
      )}
      {hours && (
        <Stat
          framed
          label="Work per hour with a cooled rest cabin"
          value={hours.moderateRelCabinMinPerHour.toFixed(1)}
          unit="min/h"
          provenance="real_weather"
          provenanceDetail="NIOSH 1-hour TWA, moderate work in sun, 07–17 h, same weather"
          hint={`against ${hours.moderateRelShadeMinPerHour.toFixed(1)} min/h when the rest area is shade only (acclimatised, NIOSH REL${hours.cooledRestWbgtC !== null ? `; cabin WBGT ${hours.cooledRestWbgtC} °C` : ''}).`}
        />
      )}
      {forecast && (
        <Stat
          framed
          label="Next-day WBGT forecast error"
          value={forecast.wbgtRmseD1.toFixed(2)}
          unit="°C RMSE"
          provenance="archived_forecast"
          provenanceDetail="ECMWF IFS 0.25° Previous Runs, lead day 1, June–September 2024–2025, five sites"
          hint={`against ${forecast.persistenceRmse.toFixed(2)} °C for “same as yesterday” (24-hour persistence), so the day plan can be set a day ahead.`}
        />
      )}
      {reference && (
        <Stat
          framed
          label="Reference checks passed"
          value={`${reference.passed}/${reference.checks}`}
          provenance="reference"
          provenanceDetail="WBGT, ISO 7933 PHS, TWL, NIOSH, ACGIH and heat-index implementations against published reference values"
          hint={`${reference.models} models checked against reference implementations and published tables.`}
        />
      )}
    </div>
  )
}

export function EvidenceSection() {
  const [data, setData] = useState<EvidenceData | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    loadEvidence()
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  if (failed || (data && !data.hours && !data.forecast && !data.reference && !data.cohort)) {
    return (
      <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
        The validation results could not be loaded. They are in public/data/validation and on the Evidence page.
      </p>
    )
  }
  if (!data) {
    return (
      <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-xl border border-line bg-surface" />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <Tiles data={data} />
      {data.cohort && <CohortCard cohort={data.cohort} />}
      <p className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 text-sm')}>
        <a href={toHref(pathFor('evidence'))} className="inline-flex items-center gap-1.5 font-semibold text-shade-dark underline underline-offset-2">
          <BookOpenCheck aria-hidden size={16} />
          All validation results with provenance
        </a>
        <a href={toHref(pathFor('lab'))} className="inline-flex items-center gap-1.5 font-semibold text-shade-dark underline underline-offset-2">
          <FlaskConical aria-hidden size={16} />
          Truth versus estimate in the simulation lab
        </a>
      </p>
    </div>
  )
}
