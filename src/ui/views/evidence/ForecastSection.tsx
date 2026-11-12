import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Section } from '../../components'
import { airportRows, EVENT_SHORT, eventRows, niceAxis, type EventLeadRow } from './derive'
import { NBSP, num, pct, sig, signed } from './format'
import { modelLabel, rmseByLead, type LeadSeriesRow } from './model'
import { Kpi, KpiRow, Segmented, SubHead, TableFrame, TD, TH } from './parts'
import type { ForecastFile } from './types'
import { AXIS, COLORS, ChartFrame, ChartTip, FileGate, MethodPanel, MiniTable, SelectField, tipRow, type LegendItem } from './ui'
import type { FileState } from './useEvidenceData'

export const FORECAST_SECTION_ID = 'evidence-forecast'

const AIRPORT_NOTES: Readonly<Record<string, string>> = {
  OMAA: 'Abu Dhabi Intl (≈ Musaffah, KEZAD)',
  OMAD: 'Al Bateen (≈ Saadiyat)',
  OMAL: 'Al Ain Intl (≈ Al Ain)',
}

const PERSISTENCE_COLOR = COLORS.context

const EVENT_TINY: Readonly<Record<string, string>> = {
  adosh_high: 'ADOSH High',
  wbgt_ge_ral115: 'WBGT ≥ 30.8',
  wbgt_ge_qatar_stop: 'WBGT ≥ 32.1',
}

// ─── RMSE by lead ───────────────────────────────────────────────────────────────────────────────────────────────────

function RmseByLead({ file }: { file: ForecastFile }) {
  const [variable, setVariable] = useState<'wbgt' | 'twl'>('wbgt')
  const rows = useMemo(() => rmseByLead(file, variable), [file, variable])
  const models = file.sameModel.map((m) => m.model)
  const primary = file.sameModel.find((m) => m.primary) ?? file.sameModel[0]
  const unit = variable === 'wbgt' ? '°C' : 'W/m²'
  const precision = variable === 'wbgt' ? 2 : 1
  const colorOf = (id: string) => COLORS.series[models.indexOf(id)] ?? COLORS.context
  const axis = useMemo(
    () => niceAxis(Math.max(0, ...rows.flatMap((r) => [...models.map((m) => r[m]), r.persistence]).filter((x): x is number => typeof x === 'number'))),
    [rows, models],
  )
  const legend: LegendItem[] = [
    ...models.map((m) => ({ label: `${modelLabel(m)}${m === primary?.model ? ' (primary)' : ''}`, color: colorOf(m), shape: 'line' as const })),
    { label: `Persistence: ${modelLabel(primary?.model ?? '')} d0 from 24·N h earlier`, color: PERSISTENCE_COLOR, shape: 'dash' as const },
  ]
  return (
    <ChartFrame
      title={`Hourly ${variable === 'wbgt' ? 'WBGT' : 'TWL'} error by lead day (RMSE)`}
      description={`Same-model verification, Jun–Sep ${file.config.years.join(' and ')}, five sites: each day-N forecast against the same model's most recent run for that hour. Lower is better.`}
      legend={legend}
      actions={<Segmented label="Variable" value={variable} options={[{ id: 'wbgt', label: 'WBGT' }, { id: 'twl', label: 'TWL' }]} onChange={(id) => setVariable(id as 'wbgt' | 'twl')} />}
      summary={`Line chart of ${variable.toUpperCase()} root-mean-square error at lead days 1 to 3 for three models and a persistence baseline.`}
      height={260}
      table={
        <MiniTable
          caption={`${variable.toUpperCase()} RMSE by lead day, ${unit}`}
          head={['Lead', ...models.map((m) => modelLabel(m)), 'Persistence']}
          rows={rows.map((r) => [r.label, ...models.map((m) => num(r[m] as number | null, precision)), num(r.persistence as number | null, precision)])}
        />
      }
      footnote="Same-model scores leave out the model's own bias against observations, so they are optimistic; the airport table below shows the bias."
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 10, right: 24, bottom: 22, left: 4 }} accessibilityLayer>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} padding={{ left: 24, right: 24 }} label={{ value: 'Lead time', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
          <YAxis domain={[0, axis.max]} ticks={axis.ticks} width={44} {...AXIS} tickFormatter={(v: number) => num(v, variable === 'wbgt' ? 1 : 0)} label={{ value: `RMSE, ${unit}`, angle: -90, position: 'insideLeft', offset: 10, fill: COLORS.tick, fontSize: 12, style: { textAnchor: 'middle' } }} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: COLORS.axis }}
            content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
              const r = tipRow<LeadSeriesRow>(props)
              if (!r) return null
              return (
                <ChartTip
                  title={`${r.label}: RMSE, ${unit}`}
                  lines={[
                    ...models.map((m) => ({ label: modelLabel(m), value: num(r[m] as number | null, precision), color: colorOf(m) })),
                    { label: 'persistence', value: num(r.persistence as number | null, precision), color: PERSISTENCE_COLOR, shape: 'dash' as const },
                  ]}
                />
              )
            }}
          />
          <Line dataKey="persistence" stroke={PERSISTENCE_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 4, fill: PERSISTENCE_COLOR, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
          {models.map((m) => (
            <Line key={m} dataKey={m} stroke={colorOf(m)} strokeWidth={2} dot={{ r: 4, fill: colorOf(m), stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

// ─── Event skill ────────────────────────────────────────────────────────────────────────────────────────────────────

function EventSkill({ file }: { file: ForecastFile }) {
  const primary = file.sameModel.find((m) => m.primary)?.model ?? file.config.primaryModel
  const [model, setModel] = useState(primary)
  const [eventId, setEventId] = useState(file.config.events[0]?.id ?? 'adosh_high')
  const rows = useMemo(() => eventRows(file, model, eventId), [file, model, eventId])
  const event = file.config.events.find((e) => e.id === eventId)
  const all = useMemo(
    () => file.config.events.flatMap((e) => eventRows(file, model, e.id).map((r) => ({ event: e.id, ...r }))),
    [file, model],
  )
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.35fr]">
      <ChartFrame
        title="Hit skill for the thresholds that matter (CSI)"
        description={`${EVENT_SHORT[eventId] ?? event?.label}: critical success index of the ${modelLabel(model)} forecast and of persistence at the same lag. 1 is perfect.`}
        legend={[
          { label: 'Forecast', color: COLORS.series[0] },
          { label: 'Persistence (24·N h)', color: PERSISTENCE_COLOR },
        ]}
        actions={
          <Segmented
            label="Event"
            value={eventId}
            options={file.config.events.map((e) => ({ id: e.id, label: EVENT_TINY[e.id] ?? e.id }))}
            onChange={setEventId}
          />
        }
        summary={`Grouped columns of critical success index at lead days 1 to 3, forecast versus persistence, for ${EVENT_SHORT[eventId] ?? eventId}.`}
        height={240}
        table={
          <MiniTable
            caption="Critical success index by lead day"
            head={['Lead', 'Forecast CSI', 'Persistence CSI']}
            rows={rows.map((r) => [r.label, num(r.csiForecast, 2), num(r.csiPersistence, 2)])}
          />
        }
        footnote={event ? `Basis: ${event.basis}. Base rate at day 1: ${pct(rows[0]?.forecast?.baseRate, 1)} of hours.` : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 12, bottom: 22, left: 4 }} barGap={2} barCategoryGap="28%" accessibilityLayer>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS} label={{ value: 'Lead time', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} width={40} {...AXIS} tickFormatter={(v: number) => num(v, 2)} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
              content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
                const r = tipRow<EventLeadRow>(props)
                if (!r) return null
                return (
                  <ChartTip
                    title={`${r.label}: ${EVENT_SHORT[eventId] ?? eventId}`}
                    lines={[
                      { label: `CSI forecast (POD ${num(r.forecast?.pod, 2)}, FAR ${num(r.forecast?.far, 2)})`, value: num(r.csiForecast, 2), color: COLORS.series[0], shape: 'rect' },
                      { label: `CSI persistence (POD ${num(r.persistence?.pod, 2)}, FAR ${num(r.persistence?.far, 2)})`, value: num(r.csiPersistence, 2), color: PERSISTENCE_COLOR, shape: 'rect' },
                    ]}
                  />
                )
              }}
            />
            <Bar dataKey="csiForecast" fill={COLORS.series[0]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
              <LabelList dataKey="csiForecast" position="top" formatter={(v: unknown) => num(typeof v === 'number' ? v : null, 2)} fill={COLORS.ink} fontSize={11} />
            </Bar>
            <Bar dataKey="csiPersistence" fill={PERSISTENCE_COLOR} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
              <LabelList dataKey="csiPersistence" position="top" formatter={(v: unknown) => num(typeof v === 'number' ? v : null, 2)} fill={COLORS.tick} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Detection scores by event and lead day</h3>
          <SelectField label="Model" value={model} options={file.sameModel.map((m) => ({ id: m.model, label: `${modelLabel(m.model)}${m.primary ? ' (primary)' : ''}` }))} onChange={setModel} className="w-72" />
        </div>
        <TableFrame label="Probability of detection, false-alarm ratio and critical success index">
          <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">POD, FAR and CSI by event and lead day, forecast against persistence.</caption>
            <thead>
              <tr>
                <th scope="col" className={`${TH} text-start`}>Event · lead</th>
                <th scope="col" className={`${TH} text-end`}>POD</th>
                <th scope="col" className={`${TH} text-end`}>FAR</th>
                <th scope="col" className={`${TH} text-end`}>CSI</th>
                <th scope="col" className={`${TH} text-end`}>Persistence POD / FAR / CSI</th>
                <th scope="col" className={`${TH} text-end`}>Misses</th>
              </tr>
            </thead>
            <tbody>
              {file.config.events.map((e) => (
                <EventGroup key={e.id} label={EVENT_SHORT[e.id] ?? e.label} rows={all.filter((r) => r.event === e.id)} />
              ))}
            </tbody>
          </table>
        </TableFrame>
        <p className="mt-2 text-xs text-subtle">
          POD: share of event hours forecast. FAR: share of forecast event hours that did not occur. CSI: hits ÷ (hits + misses + false alarms).
          The ADOSH High zone is rare (about 3 % of hours) and wind-sensitive, so a forecast TWL within one RMSE above 115 W/m² should read
          &ldquo;possibly High&rdquo;.
        </p>
      </div>
    </div>
  )
}

function EventGroup({ label, rows }: { label: string; rows: readonly EventLeadRow[] }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={6} className="border-b border-line bg-canvas px-3 py-1.5 text-start text-xs font-semibold text-ink">
          {label}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.lead}>
          <th scope="row" className={`${TD} ps-6 text-start font-normal text-muted`}>{r.label}</th>
          <td className={`${TD} text-end tabular-nums`}>{num(r.forecast?.pod, 2)}</td>
          <td className={`${TD} text-end tabular-nums`}>{num(r.forecast?.far, 2)}</td>
          <td className={`${TD} text-end font-semibold tabular-nums`}>{num(r.forecast?.csi, 2)}</td>
          <td className={`${TD} text-end text-muted tabular-nums`}>
            {num(r.persistence?.pod, 2)} / {num(r.persistence?.far, 2)} / {num(r.persistence?.csi, 2)}
          </td>
          <td className={`${TD} text-end tabular-nums`}>
            {num(r.forecast?.misses, 0)}
            <span className="block text-xs text-subtle">of {num((r.forecast?.hits ?? 0) + (r.forecast?.misses ?? 0), 0)} h</span>
          </td>
        </tr>
      ))}
    </>
  )
}

// ─── Airports ───────────────────────────────────────────────────────────────────────────────────────────────────────

function Airports({ file }: { file: ForecastFile }) {
  const leads = [...new Set(file.airports.forecast.map((a) => a.lead).filter((l): l is number => typeof l === 'number'))].sort()
  const [lead, setLead] = useState(leads.includes(1) ? 1 : (leads[0] ?? 0))
  const rows = useMemo(() => airportRows(file, lead), [file, lead])
  const p = file.airports.period
  return (
    <div>
      <SubHead aside={<Segmented label="Forecast lead" value={String(lead)} options={leads.map((l) => ({ id: String(l), label: `Day ${l}` }))} onChange={(id) => setLead(Number(id))} />}>
        Verification against airport observations (METAR)
      </SubHead>
      <p className="mb-2 max-w-prose text-sm text-muted">
        {p.start.slice(0, 10)} to {p.end.slice(0, 10)}: every routine METAR at the three airports, matched to the model value for the same
        hour. Error = model − observation; the WBGT/TWL reference uses METAR temperature, dew point and wind with model radiation.
      </p>
      <TableFrame label="Airport verification">
        <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Bias and RMSE of temperature, dew point, WBGT and TWL against METAR, by airport and model.</caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-start`}>Airport · model</th>
              <th scope="col" className={`${TH} text-end`}>Hours</th>
              <th scope="col" className={`${TH} text-end`}>T bias, °C</th>
              <th scope="col" className={`${TH} text-end`}>Dew-point bias, °C</th>
              <th scope="col" className={`${TH} text-end`}>WBGT bias, °C</th>
              <th scope="col" className={`${TH} text-end`}>WBGT RMSE, °C</th>
              <th scope="col" className={`${TH} text-end`}>TWL bias, W/m²</th>
              <th scope="col" className={`${TH} text-end`}>TWL RMSE, W/m²</th>
            </tr>
          </thead>
          <tbody>
            {[...new Set(rows.map((r) => r.icao))].map((icao) => (
              <AirportGroup key={icao} icao={icao} rows={rows.filter((r) => r.icao === icao)} lead={lead} />
            ))}
          </tbody>
        </table>
      </TableFrame>
      <p className="mt-2 text-xs text-subtle">
        Analyses carry about 1.0–1.2 °C WBGT RMSE against observations before any forecast error. Dew-point bias shows which model to trust
        for humidity: a large negative value is a dry model, which reads WBGT too low.
      </p>
    </div>
  )
}

function AirportGroup({ icao, rows, lead }: { icao: string; rows: readonly ReturnType<typeof airportRows>[number][]; lead: number }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={8} className="border-b border-line bg-canvas px-3 py-1.5 text-start text-xs font-semibold text-ink">
          {icao} · {AIRPORT_NOTES[icao] ?? ''}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.key}>
          <th scope="row" className={`${TD} ps-6 text-start font-normal`}>
            {modelLabel(r.model)}
            <span className="ms-1.5 text-xs text-subtle">{r.kind === 'analysis' ? 'analysis' : `forecast, day ${lead}`}</span>
          </th>
          <td className={`${TD} text-end tabular-nums`}>{num(r.n, 0)}</td>
          <td className={`${TD} text-end tabular-nums`}>{signed(r.tBias, 2)}</td>
          <td className={`${TD} text-end tabular-nums ${r.tdBias !== null && Math.abs(r.tdBias) >= 2 ? 'font-semibold' : ''}`}>{signed(r.tdBias, 2)}</td>
          <td className={`${TD} text-end tabular-nums`}>{signed(r.wbgtBias, 2)}</td>
          <td className={`${TD} text-end font-semibold tabular-nums`}>{num(r.wbgtRmse, 2)}</td>
          <td className={`${TD} text-end tabular-nums`}>{signed(r.twlBias, 1)}</td>
          <td className={`${TD} text-end tabular-nums`}>{num(r.twlRmse, 1)}</td>
        </tr>
      ))}
    </>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────────────────────────────────────────

function ForecastBody({ file }: { file: ForecastFile }) {
  const primary = file.sameModel.find((m) => m.primary) ?? file.sameModel[0]
  const d1 = primary?.leads.find((l) => l.lead === 1)
  const adosh = d1?.events.find((e) => e.id === 'adosh_high')?.scores
  const ral = d1?.events.find((e) => e.id === 'wbgt_ge_ral115')?.scores
  return (
    <div className="space-y-4">
      <KpiRow>
        <Kpi
          label="Hourly WBGT error, day 1"
          value={`±${sig(d1?.wbgt.rmse, 2)}`}
          unit="°C"
          hint={d1?.wbgt.rmseCi95 ? `RMSE, 95 % interval ${num(d1.wbgt.rmseCi95[0], 2)}–${num(d1.wbgt.rmseCi95[1], 2)} °C (block bootstrap)` : 'RMSE'}
        />
        <Kpi label="Daily-maximum WBGT error, day 1" value={`±${sig(d1?.wbgt.dailyMaxRmse, 2)}`} unit="°C" hint={`RMSE; bias ${signed(d1?.wbgt.dailyMaxBias, 2)}${NBSP}°C`} />
        <Kpi label="Skill against persistence, day 1" value={pct(d1?.wbgt.skillVsPersistence, 0)} hint={`WBGT MSE reduction against yesterday's value (RMSE ${num(primary?.persistence[0]?.wbgt.rmse, 2)} °C)`} />
        <Kpi label="Threshold skill, day 1 (CSI)" value={`${num(ral?.csi, 2)} · ${num(adosh?.csi, 2)}`} hint="WBGT ≥ 30.8 °C · ADOSH High zone (rare, wind-sensitive)" />
      </KpiRow>
      <RmseByLead file={file} />
      <EventSkill file={file} />
      <Airports file={file} />
      <MethodPanel
        method={
          <>
            <p>
              Archived forecasts from Open-Meteo Previous Runs for {file.config.models.map(modelLabel).join(', ')} at the five sites, Jun–Sep{' '}
              {file.config.years.join(' and ')}, run through the engine&apos;s own heat indices. {file.config.leadDefinition}
            </p>
            <p className="text-muted">
              Reference: {file.config.reference} Intervals: {num(file.config.bootstrap.replicates)} bootstrap replicates, resampling {file.config.bootstrap.block}.
            </p>
          </>
        }
        caveats={file.config.notes}
        script="scripts/validate/forecast-skill.ts"
        file={file}
        docs={[
          { path: 'docs/VALIDATION.md', label: 'VALIDATION.md §3 Forecast skill' },
          { path: 'docs/LIMITATIONS.md', label: 'LIMITATIONS.md: forecast and WBGT model limits' },
        ]}
      />
    </div>
  )
}

export function ForecastSection({ state }: { state: FileState<ForecastFile> }) {
  const detail = state.status === 'ready' ? `${modelLabel(state.data.config.primaryModel)} · ${state.data.config.years.join(', ')} · stamp ${state.data.stamp?.stamp ?? '—'}` : undefined
  return (
    <Section
      id={FORECAST_SECTION_ID}
      title="3 · Forecast skill"
      provenance="archived_forecast"
      provenanceDetail={detail}
      description="How far ahead the heat forecast can be trusted: error by lead day, detection of the regulatory thresholds, a persistence baseline, and verification against airport observations."
    >
      <FileGate state={state} label="Forecast skill">
        {(file) => <ForecastBody file={file} />}
      </FileGate>
    </Section>
  )
}
