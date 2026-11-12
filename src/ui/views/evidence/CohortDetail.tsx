import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge } from '../../components'
import { ARM_COLORS } from './palette'
import {
  detectionFor,
  FAIRNESS_DIMENSIONS,
  fairnessCells,
  fairnessValueLabel,
  leadBins,
  SMALL_GROUP_SHIFTS,
  valueRange,
  variantRows,
  type AlarmLevel,
  type LeadBinRow,
  type VariantRow,
} from './derive'
import { estLine, num, pct } from './format'
import { ARM_META, findArm, targetLabel } from './model'
import { Segmented, SubHead, TableFrame, TD, TH } from './parts'
import type { ArmId, CohortFile, FairnessCell } from './types'
import { AXIS, COLORS, ChartFrame, ChartTip, EstValue, MiniTable, SelectField, tipRow } from './ui'

// ─── Shadow-mode detection ──────────────────────────────────────────────────────────────────────────────────────────

const SHADOW_OPTIONS: readonly { id: ArmId; label: string }[] = [
  { id: 'shadow_zill_full', label: 'Standard limits' },
  { id: 'shadow_zill_monitored', label: 'Monitored mode' },
  { id: 'shadow_zill_env', label: 'No wearable' },
]

export function CohortDetection({ file }: { file: CohortFile }) {
  const available = SHADOW_OPTIONS.filter((o) => findArm(file.main.arms, o.id))
  const [armId, setArmId] = useState<ArmId>(available[0]?.id ?? 'shadow_zill_full')
  const [level, setLevel] = useState<AlarmLevel>('high')
  const arm = findArm(file.main.arms, armId)
  const rows = useMemo(() => detectionFor(arm, level), [arm, level])
  const [target, setTarget] = useState('excessive_strain')
  const focus = rows.find((r) => r.target === target) ?? rows[0]
  const bins = useMemo(() => leadBins(focus), [focus])
  const exc = rows.find((r) => r.target === 'excessive_strain')
  const color = ARM_COLORS[armId] ?? COLORS.series[0]
  if (!available.length) return null
  return (
    <div className="space-y-3">
      <SubHead
        aside={
          <div className="flex flex-wrap items-end gap-2">
            <Segmented label="Shadow arm" value={armId} options={available} onChange={(id) => setArmId(id as ArmId)} />
            <Segmented label="Individual alarms at" value={level} options={[{ id: 'high', label: '≥ HIGH' }, { id: 'stop', label: '≥ STOP' }]} onChange={(id) => setLevel(id as AlarmLevel)} />
          </div>
        }
      >
        Shadow-mode detection: individual alarms against ground-truth events
      </SubHead>
      <p className="max-w-prose text-sm text-muted">
        In shadow mode the engine runs and alerts but nobody acts on it, so the ground truth is the midday-ban-only world. Only individual
        alarms count here; exposure advisories and suppressed advisories are reported in the burden table above.
        {exc && (
          <>
            {' '}
            For excessive strain, {num(exc.positives)} of {num(exc.workerShifts)} worker-shifts had the event; the first alarm came before onset
            in {pct(exc.sensitivityBeforeOnset.value, 0)} of them, a median {num(exc.leadTime.medianMin, 0)} min ahead. The price is a low
            specificity ({pct(exc.specificity.value, 1)}): alarms came in {num(exc.warnedShifts)} worker-shifts, so only {pct(exc.ppvShift.value, 1)} of
            warned worker-shifts had the event, with {num(exc.falseAlarmsPerShift.value, 2)} false alarms per worker-shift.
          </>
        )}
      </p>
      <TableFrame label="Shadow-mode detection by ground-truth target">
        <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Sensitivity, specificity, positive predictive value, false alarms and lead time of individual alarms by target.</caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-start`}>Ground-truth target</th>
              <th scope="col" className={`${TH} text-end`}>Positives</th>
              <th scope="col" className={`${TH} text-end`}>Sensitivity, warned by onset</th>
              <th scope="col" className={`${TH} text-end`}>Specificity</th>
              <th scope="col" className={`${TH} text-end`}>PPV per shift</th>
              <th scope="col" className={`${TH} text-end`}>PPV per alarm (±2 h)</th>
              <th scope="col" className={`${TH} text-end`}>False alarms /worker-shift</th>
              <th scope="col" className={`${TH} text-end`}>Median lead, min (IQR)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.target} className={r.target === focus?.target ? 'bg-canvas' : undefined}>
                <th scope="row" className={`${TD} text-start font-medium text-ink`}>{targetLabel(r.target)}</th>
                <td className={`${TD} text-end tabular-nums`}>
                  {num(r.positives)}
                  <span className="block text-xs text-subtle">of {num(r.workerShifts)}</span>
                </td>
                <td className={`${TD} text-end`}><EstValue est={r.sensitivityBeforeOnset} scale={100} precision={1} unit="%" /></td>
                <td className={`${TD} text-end`}><EstValue est={r.specificity} scale={100} precision={1} unit="%" /></td>
                <td className={`${TD} text-end`}><EstValue est={r.ppvShift} scale={100} precision={1} unit="%" /></td>
                <td className={`${TD} text-end`}><EstValue est={r.ppvAlarm} scale={100} precision={1} unit="%" /></td>
                <td className={`${TD} text-end`}><EstValue est={r.falseAlarmsPerShift} precision={2} /></td>
                <td className={`${TD} text-end tabular-nums`}>
                  {num(r.leadTime.medianMin, 0)}
                  <span className="block text-xs text-subtle">
                    {r.leadTime.p25Min !== null ? `${num(r.leadTime.p25Min, 0)}–${num(r.leadTime.p75Min, 0)}` : '—'} · n {num(r.leadTime.n)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <ChartFrame
        title="How far ahead the first alarm came"
        description={`${targetLabel(focus?.target ?? target)}: positive worker-shifts by minutes from the first individual alarm (${level === 'high' ? '≥ HIGH' : '≥ STOP'}) to the ground-truth onset, ${ARM_META[armId]?.label}.`}
        actions={
          <SelectField label="Target" value={focus?.target ?? target} options={rows.map((r) => ({ id: r.target, label: targetLabel(r.target) }))} onChange={setTarget} className="w-64" />
        }
        summary={`Column chart of lead-time bins for ${targetLabel(focus?.target ?? target)}.`}
        height={220}
        table={<MiniTable caption="Lead-time bins" head={['Lead time, min', 'Worker-shifts']} rows={bins.map((b) => [b.label, num(b.n)])} />}
        footnote="Lead time counts positives warned by the onset; an excessive-strain onset is confirmed 10 minutes after it starts. Ground-truth onsets are simulated."
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bins} margin={{ top: 18, right: 12, bottom: 22, left: 4 }} barCategoryGap="30%" accessibilityLayer>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS} label={{ value: 'Minutes from first alarm to onset', position: 'insideBottom', offset: -14, fill: COLORS.tick, fontSize: 12 }} />
            <YAxis allowDecimals={false} width={36} {...AXIS} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
              content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
                const b = tipRow<LeadBinRow>(props)
                return b ? <ChartTip title={`${b.label} min`} lines={[{ label: 'positive worker-shifts', value: num(b.n), color, shape: 'rect' }]} /> : null
              }}
            />
            <Bar dataKey="n" fill={color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
              <LabelList dataKey="n" position="top" fill={COLORS.ink} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  )
}

// ─── Sensitivity and robustness variants ────────────────────────────────────────────────────────────────────────────

const VARIANT_ARMS: readonly { id: ArmId; label: string }[] = [
  { id: 'zill_full', label: 'Standard limits' },
  { id: 'zill_monitored', label: 'Monitored mode' },
]

const DRINK_FACTORS = new Set(['habitualDrinkFraction', 'drinkLogging'])

export function CohortVariants({ file }: { file: CohortFile }) {
  const [group, setGroup] = useState<'sensitivity' | 'robustness'>('sensitivity')
  const [arm, setArm] = useState<ArmId>('zill_full')
  const variants = group === 'sensitivity' ? file.sensitivity : file.robustness
  const rows = useMemo(() => variantRows(variants, arm), [variants, arm])
  const all = useMemo(() => variantRows([...file.sensitivity, ...file.robustness], arm), [file, arm])
  const excRange = valueRange(all.map((r) => r.excessive?.value))
  const relRange = valueRange(all.map((r) => r.workRelative?.value))
  const label = VARIANT_ARMS.find((a) => a.id === arm)?.label ?? arm
  return (
    <div className="space-y-3">
      <SubHead
        aside={
          <div className="flex flex-wrap items-end gap-2">
            <Segmented label="Sweep" value={group} options={[{ id: 'sensitivity', label: `Sensitivity (${file.sensitivity.length})` }, { id: 'robustness', label: `Robustness (${file.robustness.length})` }]} onChange={(id) => setGroup(id as 'sensitivity' | 'robustness')} />
            <Segmented label="Zill arm" value={arm} options={VARIANT_ARMS} onChange={(id) => setArm(id as ArmId)} />
          </div>
        }
      >
        Sensitivity sweeps and robustness
      </SubHead>
      <p className="max-w-prose text-sm text-muted">
        Each variant changes one assumption of the simulated world (or breaks one part of the system) on the hottest tercile&apos;s site-days, with
        values fixed before any run. Across all {all.length} variants, Zill {label} had{' '}
        {excRange && excRange[0] === 0 && excRange[1] === 0 ? 'no excessive-strain worker-shift in any variant' : `${num(excRange?.[0], 1)}–${num(excRange?.[1], 1)} excessive-strain worker-shifts per 1,000`}{' '}
        and delivered {relRange ? `${num(-relRange[1] * 100, 0)}–${num(-relRange[0] * 100, 0)} %` : '—'} less work than the midday ban only on the
        same days: the trade-off holds under every assumption tried. Drinking-model and drink-logging variants are marked.
      </p>
      <TableFrame label={`${group === 'sensitivity' ? 'Sensitivity' : 'Robustness'} variants, Zill ${label}`}>
        <table className="w-full min-w-[66rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Per variant: Zill excessive strain and work, paired differences against the midday ban only and against the base case.</caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-start`}>Variant</th>
              <th scope="col" className={`${TH} text-end`}>Worker-shifts</th>
              <th scope="col" className={`${TH} text-end`}>Zill: excessive /1,000</th>
              <th scope="col" className={`${TH} text-end`}>Zill: work, min</th>
              <th scope="col" className={`${TH} text-end`}>Work vs ban only (paired)</th>
              <th scope="col" className={`${TH} text-end`}>Δ excessive vs ban only /1,000</th>
              <th scope="col" className={`${TH} text-end`}>Midday ban only: excessive /1,000</th>
              <th scope="col" className={`${TH} text-end`}>Zill vs base case: work, min</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: VariantRow) => (
              <tr key={r.id}>
                <th scope="row" className={`${TD} text-start font-normal`}>
                  <span className="font-medium text-ink">{r.label}</span>
                  {DRINK_FACTORS.has(r.factor) && (
                    <Badge size="sm" tone="info" className="ms-2">
                      Drinking
                    </Badge>
                  )}
                  {!r.supported && <span className="mt-0.5 block text-xs text-stop">Not run: the simulation cannot apply it</span>}
                  {r.note && <span className="mt-0.5 block max-w-sm text-xs text-subtle">{r.note}</span>}
                </th>
                <td className={`${TD} text-end tabular-nums`}>{num(r.workerShifts)}</td>
                <td className={`${TD} text-end`}><EstValue est={r.excessive} /></td>
                <td className={`${TD} text-end`}><EstValue est={r.workMin} /></td>
                <td className={`${TD} text-end font-semibold`}><EstValue est={r.workRelative} scale={100} precision={1} unit="%" /></td>
                <td className={`${TD} text-end`}><EstValue est={r.dExcessive} /></td>
                <td className={`${TD} text-end`}><EstValue est={r.banOnlyExcessive} /></td>
                <td className={`${TD} text-end`}><EstValue est={r.vsBaseWork} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <p className="text-xs text-subtle">
        Variants run on the {file.spec.sweepStrata?.join(', ') ?? 'hot'} tercile only, so their midday-ban rates are higher than the base case&apos;s. &ldquo;vs
        base case&rdquo; compares the variant with the unchanged world on the same worker-shifts.
      </p>
    </div>
  )
}

// ─── Fairness ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function CohortFairness({ file }: { file: CohortFile }) {
  const [dimension, setDimension] = useState(FAIRNESS_DIMENSIONS[0].id)
  const cells = useMemo(() => {
    const get = (arm: ArmId) => fairnessCells(file, arm, dimension)
    const full = get('zill_full')
    const mon = get('zill_monitored')
    const ban = get('ban_only')
    const shadow = get('shadow_zill_full')
    const find = (list: readonly FairnessCell[], value: string) => list.find((c) => c.value === value)
    return full.map((c) => ({ value: c.value, full: c, mon: find(mon, c.value), ban: find(ban, c.value), shadow: find(shadow, c.value) }))
  }, [file, dimension])
  return (
    <div className="space-y-3">
      <SubHead aside={<SelectField label="Group by" value={dimension} options={FAIRNESS_DIMENSIONS} onChange={setDimension} className="w-48" />}>
        Fairness: the same measures by worker group
      </SubHead>
      <TableFrame label="Outcomes and work by worker group">
        <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Excessive strain per 1,000 and work per worker-shift by group, for the midday ban only and both Zill arms, with shadow-mode sensitivity.</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={`${TH} text-start align-bottom`}>Group</th>
              <th scope="col" rowSpan={2} className={`${TH} text-end align-bottom`}>Worker-shifts</th>
              <th scope="colgroup" colSpan={3} className={`${TH} border-s text-center`}>Excessive strain /1,000</th>
              <th scope="colgroup" colSpan={3} className={`${TH} border-s text-center`}>Work, min per worker-shift</th>
              <th scope="col" rowSpan={2} className={`${TH} border-s text-end align-bottom`}>Adherence, Standard</th>
              <th scope="col" rowSpan={2} className={`${TH} text-end align-bottom`}>Shadow sensitivity (positives)</th>
            </tr>
            <tr>
              <th scope="col" className={`${TH} border-s text-end`}>Ban only</th>
              <th scope="col" className={`${TH} text-end`}>Standard</th>
              <th scope="col" className={`${TH} text-end`}>Monitored</th>
              <th scope="col" className={`${TH} border-s text-end`}>Ban only</th>
              <th scope="col" className={`${TH} text-end`}>Standard</th>
              <th scope="col" className={`${TH} text-end`}>Monitored</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((c) => {
              const small = c.full.workerShifts < SMALL_GROUP_SHIFTS
              return (
                <tr key={c.value}>
                  <th scope="row" className={`${TD} text-start font-medium text-ink`}>
                    {fairnessValueLabel(c.value)}
                    {small && <span className="mt-0.5 block text-xs font-normal text-subtle">too few to compare</span>}
                  </th>
                  <td className={`${TD} text-end tabular-nums`}>{num(c.full.workerShifts)}</td>
                  <td className={`${TD} border-s border-s-line text-end tabular-nums`}>{num(c.ban?.excessivePer1000, 1)}</td>
                  <td className={`${TD} text-end tabular-nums`}>{num(c.full.excessivePer1000, 1)}</td>
                  <td className={`${TD} text-end tabular-nums`}>{num(c.mon?.excessivePer1000, 1)}</td>
                  <td className={`${TD} border-s border-s-line text-end tabular-nums`}>{num(c.ban?.workMinPerShift, 0)}</td>
                  <td className={`${TD} text-end tabular-nums`}>{num(c.full.workMinPerShift, 0)}</td>
                  <td className={`${TD} text-end tabular-nums`}>{num(c.mon?.workMinPerShift, 0)}</td>
                  <td className={`${TD} border-s border-s-line text-end tabular-nums`}>{pct(c.full.adherence, 0)}</td>
                  <td className={`${TD} text-end tabular-nums`}>
                    {c.shadow?.sensitivityExcessive === null || c.shadow?.sensitivityExcessive === undefined ? '—' : pct(c.shadow.sensitivityExcessive, 0)}
                    <span className="ms-1 text-xs text-subtle">({num(c.shadow?.positivesExcessive)})</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableFrame>
      <p className="max-w-prose text-xs text-subtle">
        Groups are not balanced: language, clothing and the wearable follow crews and sites, so a difference mixes the site&apos;s weather and tasks
        with the group itself. Work differences by acclimatisation are by design (personal caps for workers on an acclimatisation schedule). Groups
        under {SMALL_GROUP_SHIFTS} worker-shifts are flagged. Midday ban only, all groups: {estLine(findArm(file.main.arms, 'ban_only')?.rates.per1000.excessive, 1)} per 1,000;
        a zero in a Zill column is &ldquo;none observed&rdquo;, not &ldquo;none possible&rdquo;.
      </p>
    </div>
  )
}
