import { useMemo, type ReactNode } from 'react'
import { CartesianGrid, ErrorBar, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { FlaskConical, Scale } from 'lucide-react'
import { Section } from '../../components'
import { CohortDetection, CohortFairness, CohortVariants } from './CohortDetail'
import { estLine, estText, num, signedPct } from './format'
import { ARM_COLORS } from './palette'
import { ARM_META, findArm, tradeoffPoints, type TradeoffPoint } from './model'
import { SubHead, TableFrame, TD, TH } from './parts'
import type { ArmId, CohortArm, CohortFile, Est, PairedDiff } from './types'
import { AXIS, COLORS, Callout, ChartFrame, ChartTip, Code, DocLink, EstValue, FileGate, MethodPanel, MiniTable, tipRow, type LegendItem } from './ui'
import type { FileState } from './useEvidenceData'

export const COHORT_SECTION_ID = 'evidence-cohort'

/** Closed-loop arms in reading order: the two baselines, then the Zill arms. */
export const CLOSED_LOOP: readonly ArmId[] = ['ban_only', 'site_index', 'zill_env', 'zill_full', 'zill_monitored']
const TRADEOFF_ARMS: readonly ArmId[] = ['ban_only', 'site_index', 'zill_full', 'zill_monitored']

const v = (e: Est | null | undefined): number | null => (e && typeof e.value === 'number' ? e.value : null)

// ─── Headline ───────────────────────────────────────────────────────────────────────────────────────────────────────

function ArmHeadline({ arm, base }: { arm: CohortArm; base: CohortArm | undefined }) {
  const meta = ARM_META[arm.arm]
  const exc = estText(arm.rates.per1000.excessive, 1)
  const d: PairedDiff | null | undefined = arm.vsBanOnly
  const ws = arm.rates.workerShifts
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: ARM_COLORS[arm.arm] }} />
        <h4 className="text-sm font-semibold text-ink">{meta.label}</h4>
      </div>
      <p className="mt-0.5 text-xs text-muted">{meta.description}</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted">Excessive-strain worker-shifts</dt>
          <dd className="mt-0.5">
            <span className="text-xl font-semibold text-ink">{exc.value}</span>
            <span className="text-sm text-muted"> per 1,000 {exc.detail && <span className="whitespace-nowrap">({exc.detail})</span>}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {arm.rates.per1000.excessive.count ?? '—'} of {num(ws)} worker-shifts; midday ban only {estLine(base?.rates.per1000.excessive, 1)}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted">Work delivered</dt>
          <dd className="mt-0.5">
            <span className="text-xl font-semibold text-ink">{num(v(arm.rates.perShift.workMin), 0)}</span>
            <span className="text-sm text-muted"> min per worker-shift</span>
            <span className="mt-0.5 block text-xs text-muted">
              <strong className="font-semibold text-ink">{signedPct(v(d?.workRelative), 1)}</strong> against the midday ban only
              {d?.workRelative?.ci95 ? ` (paired; 95 % CI ${num(d.workRelative.ci95[0] * 100, 1)} to ${num(d.workRelative.ci95[1] * 100, 1)} %)` : ''}; ban only{' '}
              {num(v(base?.rates.perShift.workMin), 0)} min
            </span>
          </dd>
        </div>
      </dl>
    </div>
  )
}

// ─── Trade-off chart ────────────────────────────────────────────────────────────────────────────────────────────────

interface DotProps {
  cx?: number
  cy?: number
  payload?: TradeoffPoint
}

function TradeoffDot({ cx = 0, cy = 0, payload }: DotProps) {
  if (!payload) return null
  const color = ARM_COLORS[payload.arm] ?? COLORS.context
  const baseline = payload.kind === 'baseline'
  return (
    <g>
      <circle cx={cx} cy={cy} r={7} fill={color} stroke="#ffffff" strokeWidth={2} />
      {baseline && (
        <text x={cx - 12} y={cy - 10} textAnchor="end" fontSize={12} fontWeight={600} fill={COLORS.ink}>
          {payload.label}
        </text>
      )}
    </g>
  )
}

function TradeoffChart({ file }: { file: CohortFile }) {
  const points = useMemo(() => tradeoffPoints(file.main.arms, TRADEOFF_ARMS), [file])
  const zill = points.filter((p) => p.kind === 'zill')
  const zeroBound = zill.find((p) => p.zero)?.excessiveCi?.[1]
  const maxY = Math.max(50, ...points.map((p) => p.excessiveCi?.[1] ?? p.excessive))
  const yMax = Math.ceil(maxY / 50) * 50
  const legend: LegendItem[] = points.map((p) => ({ label: p.label, color: ARM_COLORS[p.arm] ?? COLORS.context, shape: 'dot' }))
  legend.push({ label: '95 % interval (zero counts: one-sided upper bound)', color: COLORS.context, shape: 'errorbar' })
  const allZero = zill.length > 0 && zill.every((p) => p.zero)
  const zillAnchor = allZero ? Math.max(...zill.map((p) => p.work + (p.errWork[1] ?? 0))) : null
  const zillShifts = findArm(file.main.arms, 'zill_full')?.rates.workerShifts
  return (
    <ChartFrame
      title="The trade-off: work delivered against excessive strain"
      description="One point per policy arm, base case. Further right is more work; lower is fewer worker-shifts with excessive strain. No arm reaches the bottom-right corner."
      legend={legend}
      summary={`Scatter of work minutes per worker-shift against excessive-strain worker-shifts per 1,000 for ${points.map((p) => p.label).join(', ')}.`}
      height={330}
      table={
        <MiniTable
          caption="Work delivered and excessive strain by arm"
          head={['Arm', 'Work, min per worker-shift [95 % CI]', 'Excessive strain per 1,000 [95 % CI or bound]']}
          rows={points.map((p) => [
            p.label,
            `${num(p.work, 1)} ${p.workCi ? `[${num(p.workCi[0], 1)}, ${num(p.workCi[1], 1)}]` : ''}`,
            p.zero ? `0 (≤ ${num(p.excessiveCi?.[1], 1)})` : `${num(p.excessive, 1)} ${p.excessiveCi ? `[${num(p.excessiveCi[0], 1)}, ${num(p.excessiveCi[1], 1)}]` : ''}`,
          ])}
        />
      }
      footnote={
        <>
          Excessive strain: ground-truth core temperature ≥ 38.5 °C (≥ 38.0 °C if not acclimatised) for at least 10 minutes. Zill: Standard
          limits without a wearable sits on the Standard-limits point ({num(v(findArm(file.main.arms, 'zill_env')?.rates.perShift.workMin), 1)} min,{' '}
          {estLine(findArm(file.main.arms, 'zill_env')?.rates.per1000.excessive, 1)}); see the table.
        </>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 24, right: 24, bottom: 24, left: 8 }} accessibilityLayer>
          <CartesianGrid stroke={COLORS.grid} />
          <XAxis
            type="number"
            dataKey="work"
            domain={[0, 400]}
            ticks={[0, 100, 200, 300, 400]}
            {...AXIS}
            label={{ value: 'Work delivered, min per worker-shift', position: 'insideBottom', offset: -16, fill: COLORS.tick, fontSize: 12 }}
          />
          <YAxis
            type="number"
            dataKey="excessive"
            domain={[0, yMax]}
            width={48}
            {...AXIS}
            label={{ value: 'Excessive strain per 1,000', angle: -90, position: 'insideLeft', offset: 12, fill: COLORS.tick, fontSize: 12, style: { textAnchor: 'middle' } }}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={false}
            content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
              const p = tipRow<TradeoffPoint>(props)
              if (!p) return null
              return (
                <ChartTip
                  title={p.label}
                  lines={[
                    { label: 'min of work per worker-shift', value: `${num(p.work, 1)}${p.workCi ? ` [${num(p.workCi[0], 0)}, ${num(p.workCi[1], 0)}]` : ''}`, color: ARM_COLORS[p.arm], shape: 'dot' },
                    {
                      label: 'excessive-strain worker-shifts per 1,000',
                      value: p.zero ? `0 (≤ ${num(p.excessiveCi?.[1], 1)})` : `${num(p.excessive, 1)}${p.excessiveCi ? ` [${num(p.excessiveCi[0], 0)}, ${num(p.excessiveCi[1], 0)}]` : ''}`,
                    },
                  ]}
                />
              )
            }}
          />
          {points.map((p) => {
            const color = ARM_COLORS[p.arm] ?? COLORS.context
            return (
              <Scatter key={p.arm} name={p.label} data={[p]} fill={color} shape={(s: unknown) => <TradeoffDot {...(s as DotProps)} />} isAnimationActive={false}>
                <ErrorBar dataKey="errWork" direction="x" width={6} stroke={color} strokeWidth={1.5} />
                <ErrorBar dataKey="errExcessive" direction="y" width={6} stroke={color} strokeWidth={1.5} />
              </Scatter>
            )
          })}
          {zillAnchor !== null && (
            <Scatter
              data={[{ work: zillAnchor, excessive: 0 }]}
              fill="transparent"
              isAnimationActive={false}
              shape={(s: unknown) => {
                const { cx = 0, cy = 0 } = s as DotProps
                return (
                  <g>
                    <text x={cx + 10} y={cy - 26} fontSize={12} fontWeight={600} fill={COLORS.ink}>
                      Both Zill arms: 0 events in {num(zillShifts)}
                    </text>
                    <text x={cx + 10} y={cy - 11} fontSize={11} fill={COLORS.tick}>
                      worker-shifts (≤ {num(zeroBound, 0)} per 1,000, one-sided 95 %)
                    </text>
                  </g>
                )
              }}
            />
          )}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

// ─── Policy tables ──────────────────────────────────────────────────────────────────────────────────────────────────

function ArmCell({ arm }: { arm: ArmId }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: ARM_COLORS[arm] ?? COLORS.context }} />
      <span className="font-medium text-ink">{ARM_META[arm]?.label ?? arm}</span>
    </span>
  )
}

function Th({ children, start = false }: { children: ReactNode; start?: boolean }) {
  return (
    <th scope="col" className={`${TH} ${start ? 'text-start' : 'text-end'} align-bottom`}>
      {children}
    </th>
  )
}

function PolicyTable({ file }: { file: CohortFile }) {
  const arms = CLOSED_LOOP.map((id) => findArm(file.main.arms, id)).filter((a): a is CohortArm => !!a)
  const water = (e: Est | undefined): Est | undefined =>
    e && typeof e.value === 'number' ? { ...e, value: e.value / 1000, ci95: e.ci95 ? [e.ci95[0] / 1000, e.ci95[1] / 1000] : e.ci95 } : e
  return (
    <div>
      <SubHead>Outcomes per 1,000 worker-shifts, and the work they cost</SubHead>
      <TableFrame label="Policy comparison per 1,000 worker-shifts">
        <table className="w-full min-w-[72rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Closed-loop policy arms: worker-shifts with each ground-truth event per 1,000, with 95 % intervals, and work, rest and water per
            worker-shift.
          </caption>
          <thead>
            <tr>
              <Th start>Arm</Th>
              <Th>Excessive strain</Th>
              <Th>Severe (≥ 39.5 °C)</Th>
              <Th>Critical</Th>
              <Th>Dehydration &gt; 3 %</Th>
              <Th>Heat-symptom episodes</Th>
              <Th>First-aid evacuations</Th>
              <Th>Work, min</Th>
              <Th>Rest, min</Th>
              <Th>Water, L</Th>
              <Th>ADOSH zone compliance</Th>
            </tr>
          </thead>
          <tbody>
            {arms.map((a) => (
              <tr key={a.arm} className={a.arm.startsWith('zill') ? 'bg-shade-bg/40' : undefined}>
                <th scope="row" className={`${TD} text-start font-normal`}>
                  <ArmCell arm={a.arm} />
                  <span className="mt-0.5 block text-xs text-subtle">{num(a.rates.workerShifts)} worker-shifts</span>
                </th>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.excessive} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.severe} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.critical} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.dehydration} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.symptomaticEpisodes} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.per1000.evacuations} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.perShift.workMin} /></td>
                <td className={`${TD} text-end`}><EstValue est={a.rates.perShift.restMin} /></td>
                <td className={`${TD} text-end`}><EstValue est={water(a.rates.perShift.waterMl)} precision={2} /></td>
                <td className={`${TD} text-end`}>
                  <EstValue est={a.challenge?.zone?.compliantShare} scale={100} precision={1} unit="%" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <p className="mt-2 text-xs text-subtle">
        Events: worker-shifts with at least one ground-truth event per 1,000 (heat-symptom episodes: episodes per 1,000). Work, rest and water:
        means per worker-shift. Brackets: 95 % bootstrap interval; ≤: one-sided 95 % bound when none was observed. The midday break held in every arm.
      </p>
    </div>
  )
}

function PairedTable({ file }: { file: CohortFile }) {
  const arms = CLOSED_LOOP.filter((id) => id !== 'ban_only')
    .map((id) => findArm(file.main.arms, id))
    .filter((a): a is CohortArm => !!a && !!a.vsBanOnly)
  return (
    <div>
      <SubHead>Paired against the midday ban only (same worker-shifts)</SubHead>
      <TableFrame label="Paired differences against the midday ban only">
        <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Arm minus midday ban only over the same worker-shifts, with 95 % intervals.</caption>
          <thead>
            <tr>
              <Th start>Arm − midday ban only</Th>
              <Th>Δ excessive strain /1,000</Th>
              <Th>Δ dehydration /1,000</Th>
              <Th>Δ heat-symptom episodes /1,000</Th>
              <Th>Δ work, min</Th>
              <Th>Work, relative</Th>
              <Th>Δ rest, min</Th>
              <Th>Δ water, mL</Th>
            </tr>
          </thead>
          <tbody>
            {arms.map((a) => {
              const d = a.vsBanOnly as PairedDiff
              return (
                <tr key={a.arm}>
                  <th scope="row" className={`${TD} text-start font-normal`}>
                    <ArmCell arm={a.arm} />
                  </th>
                  <td className={`${TD} text-end`}><EstValue est={d.excessivePer1000} /></td>
                  <td className={`${TD} text-end`}><EstValue est={d.dehydrationPer1000} /></td>
                  <td className={`${TD} text-end`}><EstValue est={d.symptomaticEpisodesPer1000} /></td>
                  <td className={`${TD} text-end`}><EstValue est={d.workMinPerShift} /></td>
                  <td className={`${TD} text-end font-semibold`}><EstValue est={d.workRelative} scale={100} precision={1} unit="%" /></td>
                  <td className={`${TD} text-end`}><EstValue est={d.restMinPerShift} /></td>
                  <td className={`${TD} text-end`}><EstValue est={d.waterMlPerShift} precision={0} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}

// ─── Alarm burden ───────────────────────────────────────────────────────────────────────────────────────────────────

const BURDEN_ARMS: readonly ArmId[] = ['zill_full', 'zill_monitored', 'zill_env', 'shadow_zill_full', 'shadow_zill_monitored']

function BurdenTable({ file }: { file: CohortFile }) {
  const arms = BURDEN_ARMS.map((id) => findArm(file.main.arms, id)).filter((a): a is CohortArm => !!a && !!a.challenge)
  const ack = (a: CohortArm, role: string) => a.challenge?.burdenPerWorkerShift?.total?.[role]?.requiringAck
  return (
    <div>
      <SubHead>Alarm burden: individual alarms, exposure advisories and designed suppression, counted apart</SubHead>
      <p className="mb-2 max-w-prose text-sm text-muted">
        An individual alarm is about one worker. An exposure advisory is about site or crew conditions. When the plan already enforces an
        exposure advisory&apos;s action, the advisory is logged with a suppression marker and notified to nobody (ANSI/ISA-18.2 designed
        suppression); stop-level, individual, symptom, physiology, hydration and first-aid alerts are never suppressed.
      </p>
      <TableFrame label="Alarm burden by arm">
        <table className="w-full min-w-[64rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Alarms, advisories and suppressed advisories per worker-shift, and notifications needing an acknowledgement, by arm.</caption>
          <thead>
            <tr>
              <Th start>Arm</Th>
              <Th>Individual alarms ≥ HIGH /worker-shift</Th>
              <Th>Individual alarms ≥ STOP</Th>
              <Th>Exposure advisories ≥ HIGH /worker-shift</Th>
              <Th>Exposure advisories /crew-shift</Th>
              <Th>Suppressed advisories /worker-shift</Th>
              <Th>Needing ack /worker-shift: worker · supervisor · buddy</Th>
              <Th>Adherence</Th>
            </tr>
          </thead>
          <tbody>
            {arms.map((a) => {
              const c = a.challenge
              const ds = c?.ack?.designedSuppression
              return (
                <tr key={a.arm}>
                  <th scope="row" className={`${TD} text-start font-normal`}>
                    <ArmCell arm={a.arm} />
                    {a.shadow && <span className="mt-0.5 block text-xs text-subtle">nobody acts on it</span>}
                  </th>
                  <td className={`${TD} text-end`}><EstValue est={c?.individualAlarmsPerShift?.high} precision={2} /></td>
                  <td className={`${TD} text-end`}><EstValue est={c?.individualAlarmsPerShift?.stop} precision={2} /></td>
                  <td className={`${TD} text-end`}><EstValue est={c?.exposureAdvisoriesPerWorkerShift} precision={2} /></td>
                  <td className={`${TD} text-end tabular-nums`}>{num(c?.exposureAdvisoriesPerCrewShift, 2)}</td>
                  <td className={`${TD} text-end`}>
                    <EstValue est={c?.suppressedAdvisoriesPerWorkerShift} precision={2} />
                    {ds && ds.alerts > 0 && (
                      <span className="block text-xs text-subtle">
                        {num(ds.alerts)} alerts; {num(ds.lifted)} lifted by escalation
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-end whitespace-nowrap tabular-nums`}>
                    {num(ack(a, 'worker'), 2)} · {num(ack(a, 'supervisor'), 2)} · {num(ack(a, 'buddy'), 2)}
                  </td>
                  <td className={`${TD} text-end`}>
                    {a.shadow ? <span className="text-subtle">n/a</span> : <EstValue est={c?.adherence} scale={100} precision={1} unit="%" />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function CohortBody({ file }: { file: CohortFile }) {
  const base = findArm(file.main.arms, 'ban_only')
  const full = findArm(file.main.arms, 'zill_full')
  const mon = findArm(file.main.arms, 'zill_monitored')
  const site = findArm(file.main.arms, 'site_index')
  const s = file.spec
  const months = `${MONTHS[s.months[0]] ?? s.months[0]}–${MONTHS[s.months[s.months.length - 1]] ?? ''}`
  const facts: [string, ReactNode][] = [
    ['Weather', `Real hourly weather, ${months} ${s.year}, ${s.sites.length} Abu Dhabi sites`],
    ['Days', `${file.days.length} site-days: hottest, median and mildest terciles, ${s.daysPerStratum} days each per site`],
    ['Workforce', `${num(base?.rates.workerShifts)} worker-shifts per arm (${s.crewsPerSite} crew per site), shift ${s.shift.start}–${s.shift.end}`],
    ['Ground truth', 'A separate physiology and behaviour model decides what happens to each virtual worker; the engine never sees it'],
    ['Intervals', `95 % from ${num(file.metricParams?.bootstrapReplicates ?? 1000)} bootstrap replicates of whole site-days; zero counts carry the rule-of-three bound`],
    ['Versions', `back-test ${file.versions.backtest} · metrics ${file.versions.metrics} · world ${file.versions.worldsim}${file.versions.truth ? ` · ground truth ${file.versions.truth}` : ''}`],
  ]
  return (
    <div className="space-y-5">
      <Callout icon={FlaskConical} tone="caution" title="Simulated cohort: projections, not measured health outcomes">
        <p>{file.disclaimer}</p>
      </Callout>
      <dl className="grid gap-x-6 gap-y-2 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {facts.map(([k, val]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs font-medium text-muted">{k}</dt>
            <dd className="text-ink">{val}</dd>
          </div>
        ))}
      </dl>

      <div>
        <SubHead>The trade-off, stated plainly</SubHead>
        <div className="grid gap-3 lg:grid-cols-2">
          {full && <ArmHeadline arm={full} base={base} />}
          {mon && <ArmHeadline arm={mon} base={base} />}
        </div>
        <Callout icon={Scale} className="mt-3">
          <p>
            Both Zill arms removed the excessive-strain worker-shifts that the midday ban only left ({estLine(base?.rates.per1000.excessive, 1)} per
            1,000), and both cost about two-thirds of the work the midday ban allows. The site TWL index keeps almost all the work (
            {signedPct(v(site?.vsBanOnly?.workRelative), 1)}) and still leaves {estLine(site?.rates.per1000.excessive, 1)} per 1,000. Most of
            Zill&apos;s cost is set by the day plan (the NIOSH/ACGIH work/rest tables, the ADOSH rule pack and the ISO 7933 screen), not by
            alarms: see the <DocLink path="docs/dev/work-cost-drivers.md" label="work-cost driver analysis" />. Whether that price is right is a
            decision for the site and its occupational-health lead, and a pilot must measure it on real shifts.
          </p>
        </Callout>
      </div>

      <TradeoffChart file={file} />
      <PolicyTable file={file} />
      <PairedTable file={file} />
      <BurdenTable file={file} />
      <CohortDetection file={file} />
      <CohortVariants file={file} />
      <CohortFairness file={file} />

      <MethodPanel
        method={
          <>
            <p>
              A generated workforce (seed <Code>{s.workforceSeed}</Code>) works the selected site-days under each policy in a closed loop: the
              engine&apos;s plan and alerts change what the virtual workers do, and the ground-truth model decides their core temperature,
              hydration and symptoms. Shadow arms run the engine while everyone behaves as under the midday ban only, which measures detection
              without changing outcomes. Every arm sees the same days, workers and random streams (seed <Code>{s.seed}</Code>).
            </p>
            <p className="text-muted">
              Arms: midday ban only (reference), site TWL index, Zill Standard limits with and without a wearable, Zill Monitored mode, and three
              shadow arms. {file.runs.rows.length ? `${num(file.runs.rows.length)} site-day runs in this report.` : ''}
            </p>
          </>
        }
        caveats={[
          'The ground truth is itself a model (Gagge two-node physiology, behaviour rules): the results are only as good as its assumptions (SIMULATION.md).',
          `Zero events in ${num(full?.rates.workerShifts)} worker-shifts is not zero risk: the one-sided 95 % bound is ${num(full?.rates.per1000.excessive.upper95, 0)} per 1,000.`,
          'The work cost depends on the site plan, task windows and crew make-up of the synthetic workforce; real sites differ.',
          'Only a prospective pilot can show an effect on real heat illness (PILOT.md).',
        ]}
        script="scripts/validate/cohort.ts"
        file={file}
        docs={[
          { path: 'docs/VALIDATION-COHORT.md', label: 'VALIDATION-COHORT.md: methods and full results' },
          { path: 'docs/SIMULATION.md', label: 'SIMULATION.md: the simulated world and its assumptions' },
          { path: 'docs/PILOT.md', label: 'PILOT.md: what a pilot must measure' },
        ]}
        extra={
          <p className="text-xs text-muted">
            Cohort only: <Code>npx tsx scripts/validate/cohort.ts --medium</Code>
          </p>
        }
      />
    </div>
  )
}

export function CohortSection({ state }: { state: FileState<CohortFile> }) {
  const detail =
    state.status === 'ready'
      ? `${state.data.days.length} site-days · ${num(findArm(state.data.main.arms, 'ban_only')?.rates.workerShifts)} worker-shifts per arm · stamp ${state.data.stamp?.stamp ?? '—'}`
      : undefined
  return (
    <Section
      id={COHORT_SECTION_ID}
      title="4 · Simulated cohort"
      provenance="simulated"
      provenanceDetail={detail}
      description="A virtual workforce on real 2025 weather under each policy: what Zill would prevent, what it would cost in work, how well its individual alarms detect trouble, and how robust and fair the result is."
    >
      <FileGate
        state={state}
        label="Simulated cohort"
        missingHint="Until it runs, no simulated result is shown here: the cohort is the slowest validation step."
      >
        {(file) => <CohortBody file={file} />}
      </FileGate>
    </Section>
  )
}

