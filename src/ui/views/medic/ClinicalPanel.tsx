/**
 * Occupational health: consented clinical detail of an escalated case, exactly as the clinical-care projection releases
 * it (state/selectors.ts selectOccHealthCases): the ECTemp estimated strain indicator with its ±0.6 °C band (Buller 2013
 * limits of agreement), heart rate, the PSI band the device reports, symptom history, urine and fluids, and the device's
 * own recovery status. Without the worker's consent nothing clinical is shown. ECTemp is an estimate from heart rate,
 * never a measured core temperature.
 */
import { useMemo } from 'react'
import { Activity, Droplets, HeartPulse, Lock, ShieldCheck, Smartphone } from 'lucide-react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { RiskDriver, SymptomId } from '../../../engine/types'
import { ECTEMP_DISPLAY, PHYSIO_FLOORS } from '../../../engine/physio'
import { formatLocalHhmm } from '../../../engine/time'
import { riskFlagText } from '../../../i18n'
import { Card, CardHeader, EmptyState, InfoTip, ProvenanceTag, Stat, cx, formatNumber } from '../../components'
import {
  PSI_BAND_TEXT,
  bandDomain,
  deviceStatusLines,
  hydrationLines,
  psiFromDrivers,
  sortSymptoms,
  trendRows,
  urineReading,
  waterHold,
  type MedicCaseVM,
  type PsiBandKnown,
  type TrendPoint,
  type TrendRow,
} from './medicModel'
import { Fact, SymptomChip } from './ui'

const LINE = '#0f766e' // shade (teal-700): the estimate
const BAND = '#14b8a6' // shade-light: its uncertainty band
const GRID = '#e2e8f0' // line
const AXIS = '#64748b' // subtle
const ADVISORY = '#94a3b8'
const STOP = '#dc2626'

export interface ClinicalPanelProps {
  c: MedicCaseVM
  points: readonly TrendPoint[]
  symptomsSeen: Partial<Record<SymptomId, number>>
}

export function ClinicalPanel({ c, points, symptomsSeen }: ClinicalPanelProps) {
  if (!c.clinicalReleased) {
    return (
      <Card as="section" aria-label="Clinical detail">
        <CardHeader icon={HeartPulse} title="Clinical detail" description="Escalated case: who, where, level and actions only." />
        <EmptyState
          size="sm"
          tone="unavailable"
          icon={Lock}
          title="Withheld: no consent"
          description="The worker has not agreed to share clinical detail with occupational health on escalation, so heart rate, the strain estimate, symptoms, urine and fluids stay on the device. The device still protects them with the same environment- and work-based limits."
        />
      </Card>
    )
  }
  return <ConsentedDetail c={c} points={points} symptomsSeen={symptomsSeen} />
}

function ConsentedDetail({ c, points, symptomsSeen }: ClinicalPanelProps) {
  const d = c.data
  const drivers = useMemo<RiskDriver[]>(() => [...(d.drivers_clinical ?? []), ...(d.drivers_nonclinical ?? [])], [d.drivers_clinical, d.drivers_nonclinical])
  const rows = useMemo(() => trendRows(points), [points])
  const psi = psiFromDrivers(drivers)
  const urine = urineReading(d.urineColor)
  const water = waterHold(drivers)
  const status = deviceStatusLines(drivers)
  const fluids = hydrationLines(drivers)
  const symptoms = sortSymptoms(d.symptoms ?? [])
  const hrTrend = rows.slice(-30).map((r) => r.hr)
  const ct = d.ctEstC ?? null

  return (
    <Card as="section" aria-label="Clinical detail">
      <CardHeader
        icon={HeartPulse}
        title="Clinical detail"
        description="Shared because the worker consented to share it with occupational health on escalation. Held on this console only while the case is open."
        actions={<ProvenanceTag kind="simulated" detail="Demo workers are simulated. On a site this comes from the worker’s own device and wearable." />}
      />

      <EctempTrend rows={rows} current={ct} />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Heart rate"
          value={d.hrBpm ?? null}
          unit="bpm"
          framed
          size="sm"
          trend={hrTrend.length >= 2 ? hrTrend : undefined}
          hint={d.hrBpm === null || d.hrBpm === undefined ? 'No valid wearable reading' : `Observed on this console, ${hrTrend.length} min`}
        />
        <PsiCard band={psi.band} value={psi.value} text={psi.text} />
      </div>

      <div className="mt-4">
        <h4 className="text-sm font-semibold text-ink">Symptoms reported (last 120 min)</h4>
        {symptoms.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Reported symptoms">
            {symptoms.map((s) => (
              <SymptomChip key={s} symptom={s} seenAt={symptomsSeen[s] !== undefined ? `shown ${formatLocalHhmm(symptomsSeen[s] as number)}` : undefined} />
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">None reported in the case window.</p>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section aria-label="Urine and fluids" className="rounded-lg border border-line p-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Droplets aria-hidden size={16} className="text-shade" /> Urine and fluids
          </h4>
          <dl className="mt-2 space-y-2">
            <Fact label="Urine colour (Armstrong chart)">
              {urine ? (
                <span className="flex items-start gap-2">
                  <span aria-hidden className="mt-0.5 inline-block size-4 shrink-0 rounded border border-line-strong" style={{ backgroundColor: urine.swatch }} />
                  <span>
                    Shade <span className="font-semibold tabular-nums">{urine.shade}</span> of 8 · {urine.advice}
                  </span>
                </span>
              ) : (
                <span className="text-muted">No reading in the case window</span>
              )}
            </Fact>
            <Fact label="Device water advice">
              {d.waterMlPerHour !== undefined ? (
                d.waterMlPerHour > 0 ? (
                  <span className="tabular-nums">{formatNumber(d.waterMlPerHour)} mL per hour</span>
                ) : (
                  <span>No drink reminders now (the device withholds them)</span>
                )
              ) : (
                <span className="text-muted">Not released</span>
              )}
            </Fact>
            <Fact label="Water-loss limit">
              {water === null ? <span className="text-muted">Not released</span> : water.state === 'pending' ? <span className="font-medium text-stop">{water.text}</span> : 'No water-loss hold reported'}
            </Fact>
          </dl>
          {fluids.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {fluids.map((f) => (
                <li key={f.id}>• {f.text}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Device status" className="rounded-lg border border-line p-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Smartphone aria-hidden size={16} className="text-shade" /> Device status
          </h4>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <Fact label="To the heat-strain limit">
              {d.minutesToLimit === null || d.minutesToLimit === undefined ? <span className="text-muted">Not projected</span> : <span className="tabular-nums">{Math.floor(d.minutesToLimit)} min</span>}
            </Fact>
            <Fact label="Work per hour">{d.workMinPerHour !== undefined ? <span className="tabular-nums">{Math.floor(d.workMinPerHour)} min</span> : <span className="text-muted">—</span>}</Fact>
          </dl>
          {status.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {status.map((s) => (
                <li key={s.id} className="text-sm text-ink">
                  {s.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No recovery review or latch reported.</p>
          )}
          <HealthFactors flags={d.riskFlags} age={d.ageYears ?? null} />
        </section>
      </div>
    </Card>
  )
}

function HealthFactors({ flags, age }: { flags: MedicCaseVM['data']['riskFlags']; age: number | null }) {
  return (
    <div className="mt-3 border-t border-line pt-2">
      <p className="text-xs font-medium text-muted">Health factors (self-declared, consented; never scored)</p>
      <p className="mt-0.5 text-sm text-ink">
        {flags && flags.length > 0 ? flags.map((f) => riskFlagText('en', f).name).join(', ') : 'None shared'}
        {age !== null && <span className="text-muted"> · age {age}</span>}
      </p>
    </div>
  )
}

const PSI_SEGMENTS: ReadonlyArray<{ id: 'low' | PsiBandKnown; label: string }> = [
  { id: 'low', label: '≤ 4' },
  { id: 'moderate', label: '> 4' },
  { id: 'high', label: '> 6' },
  { id: 'very_high', label: '> 8' },
]

function PsiCard({ band, value, text }: { band: PsiBandKnown | null; value: number | null; text: string }) {
  const activeIndex = band === null ? -1 : PSI_SEGMENTS.findIndex((s) => s.id === band)
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted">
          <Activity aria-hidden size={16} /> PSI band
        </p>
        <InfoTip
          label="About the PSI band"
          align="end"
          content={`Physiological Strain Index (Moran 1998), computed on the device from the strain estimate and heart rate. The device reports a band only once it holds for 5 valid minutes: above ${PHYSIO_FLOORS.PSI_ADVISORY} advisory, above ${PHYSIO_FLOORS.PSI_T1} high, above ${PHYSIO_FLOORS.PSI_T2} very high (stop).`}
        />
      </div>
      <p className={cx('mt-1 text-base font-semibold', band === 'very_high' ? 'text-stop' : band === 'high' ? 'text-high' : 'text-ink')}>
        {band ? PSI_BAND_TEXT[band] : 'No sustained band'}
        {value !== null && <span className="ms-1 text-sm font-normal text-muted tabular-nums">(latest {formatNumber(value, 1)})</span>}
      </p>
      <div className="mt-2 grid grid-cols-4 gap-0.5" aria-hidden>
        {PSI_SEGMENTS.map((s, i) => (
          <div key={s.id} className="text-center">
            <div className={cx('h-2 rounded-sm', i <= activeIndex ? (i >= 3 ? 'bg-stop-fill' : i === 2 ? 'bg-high-fill' : 'bg-caution-fill') : 'bg-slate-200')} />
            <span className="text-[11px] text-muted tabular-nums">{s.label}</span>
          </div>
        ))}
      </div>
      {band === null && <p className="mt-1 text-xs text-muted">{text}</p>}
    </div>
  )
}

// ─────────────────────────────── ECTemp trend ───────────────────────────────

interface TipPayload {
  payload?: TrendRow
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: readonly TipPayload[] }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row || row.ct === null || !row.band) return null
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="font-medium text-muted tabular-nums">{formatLocalHhmm(row.t)}</p>
      <p className="mt-0.5 flex items-center gap-2 text-ink">
        <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: LINE }} />
        <span className="font-semibold tabular-nums">{row.ct.toFixed(1)} °C</span>
        <span className="text-muted">estimate</span>
      </p>
      <p className="mt-0.5 text-muted tabular-nums">
        Band {row.band[0].toFixed(1)}–{row.band[1].toFixed(1)} °C{row.hr !== null ? ` · HR ${row.hr} bpm` : ''}
      </p>
    </div>
  )
}

function EctempTrend({ rows, current }: { rows: readonly TrendRow[]; current: number | null }) {
  const valid = rows.filter((r) => r.ct !== null)
  const domain = bandDomain(valid)
  const latest = valid.length > 0 ? valid[valid.length - 1] : undefined
  return (
    <section aria-label="ECTemp trend">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            ECTemp estimated strain indicator
            <InfoTip
              label="About ECTemp"
              content={`An estimate of core-temperature strain from heart rate (Buller 2013 model), shown with a ±${ECTEMP_DISPLAY.HALF_WIDTH_C} °C band (the model’s limits of agreement). It is not a measured core temperature and does not diagnose heat illness. Device floors: ${PHYSIO_FLOORS.ECTEMP_ADVISORY_C.toFixed(1)} °C advisory, ${PHYSIO_FLOORS.ECTEMP_T1_C.toFixed(1)} °C high, ${PHYSIO_FLOORS.ECTEMP_T2_C.toFixed(1)} °C stop.`}
            />
          </h4>
          <p className="text-xs text-muted">One point per simulated minute while this console is open.</p>
        </div>
        <p className="text-sm text-ink">
          {current !== null ? (
            <>
              <span className="text-lg font-semibold tabular-nums">{current.toFixed(1)} °C</span>{' '}
              <span className="text-muted tabular-nums">
                (band {(current - ECTEMP_DISPLAY.HALF_WIDTH_C).toFixed(1)}–{(current + ECTEMP_DISPLAY.HALF_WIDTH_C).toFixed(1)})
              </span>
            </>
          ) : (
            <span className="text-muted">No valid estimate now</span>
          )}
        </p>
      </div>

      {valid.length >= 2 ? (
        <div className="mt-2 h-52 w-full" role="img" aria-label={`ECTemp estimate trend, ${valid.length} minutes, latest ${latest?.ct?.toFixed(1) ?? '—'} °C with a ±${ECTEMP_DISPLAY.HALF_WIDTH_C} °C band. Table below.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={valid as TrendRow[]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t: number) => formatLocalHhmm(t)}
                tick={{ fill: AXIS, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={28}
              />
              <YAxis
                domain={domain}
                tickFormatter={(v: number) => v.toFixed(1)}
                tick={{ fill: AXIS, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={36}
                allowDecimals
              />
              <ReferenceLine
                y={PHYSIO_FLOORS.ECTEMP_ADVISORY_C}
                stroke={ADVISORY}
                strokeWidth={1}
                ifOverflow="hidden"
                label={{ value: '38.0 advisory', position: 'insideTopRight', fill: AXIS, fontSize: 11 }}
              />
              <ReferenceLine
                y={PHYSIO_FLOORS.ECTEMP_T2_C}
                stroke={STOP}
                strokeWidth={1}
                ifOverflow="hidden"
                label={{ value: '39.0 stop floor', position: 'insideTopRight', fill: AXIS, fontSize: 11 }}
              />
              <Area dataKey="band" type="monotone" stroke="none" fill={BAND} fillOpacity={0.2} isAnimationActive={false} activeDot={false} />
              <Line dataKey="ct" type="monotone" stroke={LINE} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#ffffff', strokeWidth: 2 }} isAnimationActive={false} />
              <Tooltip content={<TrendTooltip />} cursor={{ stroke: AXIS, strokeWidth: 1 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-2 grid h-24 place-items-center rounded-lg border border-dashed border-line-strong bg-canvas px-4 text-center text-sm text-muted">
          {valid.length === 1 ? 'One observation so far: the trend builds as the simulated clock runs.' : 'No valid estimate observed yet on this console.'}
        </div>
      )}

      {valid.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-shade hover:underline">Show as table (last {Math.min(10, valid.length)} min)</summary>
          <table className="mt-2 w-full text-start text-xs tabular-nums">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="py-1 text-start font-medium">Time</th>
                <th scope="col" className="py-1 text-end font-medium">Estimate °C</th>
                <th scope="col" className="py-1 text-end font-medium">Band °C</th>
                <th scope="col" className="py-1 text-end font-medium">HR bpm</th>
              </tr>
            </thead>
            <tbody>
              {valid
                .slice(-10)
                .reverse()
                .map((r) => (
                  <tr key={r.t} className="border-b border-line/60">
                    <td className="py-1">{formatLocalHhmm(r.t)}</td>
                    <td className="py-1 text-end">{r.ct?.toFixed(1)}</td>
                    <td className="py-1 text-end">{r.band ? `${r.band[0].toFixed(1)}–${r.band[1].toFixed(1)}` : '—'}</td>
                    <td className="py-1 text-end">{r.hr ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck aria-hidden size={14} /> Estimate with uncertainty band; not a measured core temperature, not a diagnosis.
      </p>
    </section>
  )
}
