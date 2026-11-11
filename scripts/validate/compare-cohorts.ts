/**
 * Before/after comparison of two simulated-cohort reports (cohort.json schema, scripts/validate/cohort.ts) as Markdown.
 * Every number is read from the two files; nothing is typed by hand. Fields that the older report does not have (the
 * alarm basis split of metrics 1.1.0) are shown as "n/a".
 *
 *   npx tsx scripts/validate/compare-cohorts.ts [--before=docs/dev/cohort-v0.2-medium.json]
 *       [--after=public/data/validation/cohort.json] [--out=docs/dev/cohort-v0.2-vs-v0.3.md] [--labels=v0.2,v0.3]
 *
 * Snapshots of earlier reports: docs/dev/cohort-v0.1-medium.json (v0.1) and docs/dev/cohort-v0.2-medium.json (v0.2, the
 * report at the commit before wave 2d); v0.1 → v0.2 was generated with --before=docs/dev/cohort-v0.1-medium.json
 * --labels=v0.1,v0.2 --out=docs/dev/cohort-v0.1-vs-v0.2.md.
 *
 * The generated "What changed between versions" section lists the module versions of both reports with their version
 * notes ({@link VERSION_NOTES}), the cohort-design, metric-parameter and variant differences, and flags every row that a
 * change of the SIMULATED WORLD drives: a baseline arm (midday ban only, site TWL index) has no Zill in it, so any change
 * in its numbers comes from the simulated world (or a metric definition), never from Zill. Arms are read from the
 * reports, so a new arm appears without a code change (its label falls back to its id).
 *
 * Evidence class: SIMULATED COHORT (docs/SIMULATION.md §6): projections under stated assumptions, never measured
 * health outcomes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { mdTable } from './lib/docs'
import { isMainModule, repoPath } from './lib/io'

/** Loose view of a cohort report: both schema generations are read through optional fields. */
type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const ARM_LABEL: Record<string, string> = {
  ban_only: 'Midday ban only',
  site_index: 'Site TWL index',
  zill_env: 'Zill (no wearable)',
  zill_full: 'Zill (with wearable)',
  zill_monitored: 'Zill (monitored mode)',
  shadow_zill_env: 'Shadow: Zill (no wearable)',
  shadow_zill_full: 'Shadow: Zill (with wearable)',
  shadow_zill_monitored: 'Shadow: Zill (monitored mode)',
}
const TARGET_LABEL: Record<string, string> = {
  excessive_strain: 'Excessive strain',
  severe_strain: 'Severe strain',
  critical: 'Critical',
  dehydration_3pct: 'Dehydration > 3 %',
  heat_symptoms: 'Heat symptoms (truth)',
  symptomatic: 'Symptomatic event (log)',
}
const ROLES = ['worker', 'buddy', 'supervisor', 'first_aider', 'occ_health']
/** Marker of a baseline-arm row whose numbers changed between the reports (simulated world or metric definitions). */
export const WORLD_FLAG = '⚑'

/**
 * Version notes of the modules whose versions cohort reports carry — text only (every number of the document is read
 * from the reports). Keep in step with WORLDSIM_VERSION (src/sim/worldsim.ts), TRUTH_MODEL_VERSION (src/sim/truth.ts),
 * METRICS_VERSION (src/sim/metrics.ts) and BACKTEST_VERSION (src/sim/backtest.ts).
 */
export const VERSION_NOTES: Readonly<Record<VersionKey, Readonly<Record<string, string>>>> = {
  worldsim: {
    '1.1.0':
      'wave 2c: structured truth events, supervisor follow-through, consent changes on the device, ADOSH hourly dose in the site TWL index, idle minutes, plan partial windows; a followed drink reminder replaces that minute’s spontaneous drink.',
    '1.2.0': 'engine-owned resume (projection hold), the day plan’s ISO 7933 screen on the forecast climate, plan block-hour execution layout, device work/rest cycles aligned with plan block-hours.',
    '1.3.0':
      'wave 2d: the listed-order schedule (midday ban only, site TWL index, shadow) honours task windows like the planner — a baseline definition change (no work before the windows open, work left when a window closes is deferred, idle minutes count toward the statutory break); the worker responds to the reminder the device shows (the engine’s rule: rest and idle in heat included); drink-logging fidelity (default: every drink logged exactly).',
    '1.4.0':
      'wave 2d (integration): members on an acclimatisation schedule follow their own per-member plan caps (the others the crew layout; floored bouts); the monitored-mode policy (zill_monitored: planner and devices on the monitored plan basis); the engine owns every resume decision (the simulator’s own check of the task to resume is gone). Baseline arms are not touched by this version.',
  },
  truth: {
    '1.1.0': 'wave 2c drinking model: sweat-paced spontaneous drinking with a habitual floor of 0.4 × the individual baseline (it was a 450 mL/h floor).',
    '1.2.0': 'wave 2d: habitual drinking floor calibrated to the observed hot-shift intake (5.44 L per 12-h shift, Bates & Schneider 2008): 0.4 → 0.87; a drink reminder left on screen is followed at most once per 20 min.',
  },
  metrics: {
    '1.1.0': 'alarms split by basis: headline detection on individual alarms (≥ high and ≥ stop), exposure advisories reported separately, alert burden by basis and role.',
    '1.2.0': 'designed suppression (ANSI/ISA-18.2): an alert version logged under designed suppression is not an alarm or an exposure advisory; suppressed advisories are counted per worker-shift.',
  },
  backtest: {
    '1.1.0': 'supervisor follow-through variant; ground-truth parameter sweeps run.',
    '1.2.0': 'arms from one table; drinking-floor (1.0, 0.4) and drink-logging (50 %, ×1.5) variants; base-case delta on each variant’s site-days; report versions.truth.',
    '1.3.0': 'arms zill_monitored (monitored plan basis) and shadow_zill_monitored; headline suppressed advisories and supervisor acknowledgements per worker-shift.',
  },
}
type VersionKey = 'worldsim' | 'truth' | 'metrics' | 'backtest'
/**
 * What each metrics version changed: 'alarms' = alarm, burden and detection measures only; 'outcomes' = rates, work or
 * water too. A version missing here counts as 'outcomes' (the cautious reading).
 */
export const METRICS_SCOPE: Readonly<Record<string, 'alarms' | 'outcomes'>> = { '1.1.0': 'alarms', '1.2.0': 'alarms' }
const COMPONENT: Record<VersionKey, string> = {
  backtest: 'Back-test design and report schema',
  metrics: 'Metric definitions',
  worldsim: 'World simulation (simulated world: mechanics, schedules)',
  truth: 'Ground-truth model (simulated world: physiology, behaviour)',
}
/** Reports before backtest 1.2.0 carry no truth version: it follows from the world-simulation version. */
const TRUTH_FROM_WORLDSIM: Record<string, string> = { '1.0.0': '1.0.0', '1.1.0': '1.1.0', '1.2.0': '1.1.0' }

const NA = 'n/a'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const f = (x: unknown, d: number): string => (isNum(x) ? x.toFixed(d) : NA)
const pct = (x: unknown, d = 1): string => (isNum(x) ? `${(100 * x).toFixed(d)} %` : NA)
const val = (e: J | null | undefined): number | null => (e && isNum(e.value) ? e.value : null)
/** "a → b" with a signed difference when both are numbers. */
const arrow = (a: number | null, b: number | null, d: number, unit = ''): string => {
  if (a === null && b === null) return NA
  const s = `${f(a, d)}${a !== null ? unit : ''} → ${f(b, d)}${b !== null ? unit : ''}`
  return a !== null && b !== null ? `${s} (${b - a >= 0 ? '+' : ''}${(b - a).toFixed(d)})` : s
}
const arrowPct = (a: number | null, b: number | null, d = 1): string => arrow(a === null ? null : 100 * a, b === null ? null : 100 * b, d, ' %')
const armOf = (r: J, arm: string): J | undefined => (r.main?.arms ?? []).find((a: J) => a.arm === arm)
const leadText = (l: J | null | undefined): string => (!l ? NA : l.n === 0 ? '— (n = 0)' : `${f(l.medianMin, 0)} (n = ${l.n})`)
const label = (arm: string): string => ARM_LABEL[arm] ?? arm
const signed = (x: number | null, d: number): string => (x === null ? NA : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`)
const cmpVersion = (a: string, b: string): number => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

// ─────────────────────────────── Arms (data-driven) ───────────────────────────────

/** An arm of either report: baseline (no Zill), Zill (closed loop) or shadow. */
export interface ArmInfo {
  arm: string
  kind: 'baseline' | 'zill' | 'shadow'
}

/**
 * The arms of both reports, in the after report's order then any arm only the before report has. Kind from the arm
 * summary (`shadow`, `policy`): a policy whose id does not start with "zill" is a baseline.
 */
export function reportArms(before: J, after: J): ArmInfo[] {
  const out = new Map<string, ArmInfo>()
  for (const r of [after, before]) {
    const ids: string[] = [...(r.arms ?? []), ...(r.main?.arms ?? []).map((a: J) => a.arm)]
    for (const arm of ids) {
      if (out.has(arm)) continue
      const s = armOf(r, arm)
      const shadow = s?.shadow === true || (s === undefined && arm.startsWith('shadow_'))
      const policy = String(s?.policy ?? arm)
      out.set(arm, { arm, kind: shadow ? 'shadow' : policy.startsWith('zill') ? 'zill' : 'baseline' })
    }
  }
  return [...out.values()]
}

// ─────────────────────────────── What changed ───────────────────────────────

/** One module's versions in the two reports. */
export interface VersionRow {
  key: VersionKey
  component: string
  before: string | null
  after: string | null
  /** True when the version was not in the report but follows from another (truth from worldsim). */
  inferred: [boolean, boolean]
  changed: boolean
  /** Version notes of every version after `before` up to and including `after`. */
  notes: string[]
}

/**
 * Version notes of `key` for the versions in (from, to], oldest first (empty when unchanged or either is unknown). A
 * target version without a note in {@link VERSION_NOTES} gets an explicit "no version note" line, so a version bump
 * never passes silently.
 */
export function notesBetween(key: VersionKey, from: string | null, to: string | null): string[] {
  if (from === null || to === null || cmpVersion(to, from) <= 0) return []
  const notes = Object.keys(VERSION_NOTES[key])
    .filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, to) <= 0)
    .sort(cmpVersion)
    .map((v) => `${v}: ${VERSION_NOTES[key][v]}`)
  if (!(to in VERSION_NOTES[key])) notes.push(`${to}: (no version note in scripts/validate/compare-cohorts.ts VERSION_NOTES — read the module's version comment)`)
  return notes
}

/** Module versions of both reports (truth inferred from the world-simulation version for reports before backtest 1.2.0). */
export function versionRows(before: J, after: J): VersionRow[] {
  const get = (r: J, key: VersionKey): [string | null, boolean] => {
    const v = r.versions?.[key]
    if (typeof v === 'string') return [v, false]
    if (key === 'truth' && typeof r.versions?.worldsim === 'string' && TRUTH_FROM_WORLDSIM[r.versions.worldsim]) return [TRUTH_FROM_WORLDSIM[r.versions.worldsim], true]
    return [null, false]
  }
  return (['worldsim', 'truth', 'metrics', 'backtest'] as const).map((key) => {
    const [b, bi] = get(before, key)
    const [a, ai] = get(after, key)
    return { key, component: COMPONENT[key], before: b, after: a, inferred: [bi, ai], changed: b !== a, notes: notesBetween(key, b, a) }
  })
}

/** A baseline-arm measure in the two reports. */
export interface BaselineShift {
  arm: string
  measure: string
  before: number | null
  after: number | null
  /** The value changed beyond floating-point noise (both present), or exists in only one report. */
  moved: boolean
}

const BASELINE_MEASURES: readonly { measure: string; get: (a: J | undefined) => number | null }[] = [
  { measure: 'Work min/shift', get: (a) => val(a?.rates?.perShift?.workMin) },
  { measure: 'Rest min/shift', get: (a) => val(a?.rates?.perShift?.restMin) },
  { measure: 'Water mL/shift', get: (a) => val(a?.rates?.perShift?.waterMl) },
  { measure: 'Excessive strain /1,000', get: (a) => val(a?.rates?.per1000?.excessive) },
  { measure: 'Severe strain /1,000', get: (a) => val(a?.rates?.per1000?.severe) },
  { measure: 'Dehydration > 3 % /1,000', get: (a) => val(a?.rates?.per1000?.dehydration) },
  { measure: 'Heat-symptom episodes /1,000', get: (a) => val(a?.rates?.per1000?.symptomaticEpisodes) },
]
const moved = (a: number | null, b: number | null): boolean => (a === null) !== (b === null) || (a !== null && b !== null && Math.abs(b - a) > 1e-9 * Math.max(1, Math.abs(a)))

/** Every headline measure of every baseline arm in the two reports, with whether it moved. */
export function baselineShifts(before: J, after: J): BaselineShift[] {
  const out: BaselineShift[] = []
  for (const { arm, kind } of reportArms(before, after)) {
    if (kind !== 'baseline') continue
    for (const m of BASELINE_MEASURES) {
      const b = m.get(armOf(before, arm))
      const a = m.get(armOf(after, arm))
      out.push({ arm, measure: m.measure, before: b, after: a, moved: moved(b, a) })
    }
  }
  return out
}

/** Keys of two plain objects whose JSON differs (missing keys count as different). */
function changedKeys(a: J | undefined, b: J | undefined): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).sort()
}

/** The generated "What changed between versions" section (pure). */
export function whatChanged(before: J, after: J, labels: [string, string]): string {
  const [L0, L1] = labels
  const out: string[] = ['## What changed between versions', '']
  const rows = versionRows(before, after)
  const v = (x: string | null, inferred: boolean): string => (x === null ? NA : inferred ? `${x} (inferred from the world-simulation version)` : x)
  out.push(
    mdTable(
      ['Component', L0, L1, 'Changed'],
      rows.map((r) => [r.component, v(r.before, r.inferred[0]), v(r.after, r.inferred[1]), r.changed ? 'yes' : 'no']),
    ),
  )
  const notes = rows.flatMap((r) => r.notes.map((n) => `- ${r.component} ${n}`))
  if (notes.length) out.push('', 'Version notes (scripts/validate/compare-cohorts.ts VERSION_NOTES):', '', ...notes)

  const specKeys = changedKeys(before.spec, after.spec)
  const metricKeys = changedKeys(before.metricParams, after.metricParams)
  const ids = (r: J): string[] => (r.variants ?? []).map((x: J) => String(x.id))
  const added = ids(after).filter((x) => !ids(before).includes(x))
  const removed = ids(before).filter((x) => !ids(after).includes(x))
  const arms = reportArms(before, after)
  const armsAdded = arms.filter((a) => !armOf(before, a.arm)).map((a) => label(a.arm))
  out.push(
    '',
    mdTable(
      ['Design item', 'Difference'],
      [
        ['Cohort design (spec)', specKeys.length ? `changed: ${specKeys.join(', ')}` : 'same'],
        ['Metric parameters', metricKeys.length ? `changed: ${metricKeys.join(', ')}` : 'same'],
        ['Arms', armsAdded.length ? `added in ${L1}: ${armsAdded.join(', ')}` : 'same'],
        ['Variants', added.length || removed.length ? [added.length ? `added: ${added.join(', ')}` : '', removed.length ? `removed: ${removed.join(', ')}` : ''].filter(Boolean).join('; ') : 'same'],
      ],
    ),
  )

  const shifts = baselineShifts(before, after)
  const movedRows = shifts.filter((s) => s.moved)
  const world = rows.filter((r) => (r.key === 'worldsim' || r.key === 'truth') && r.changed)
  // Baseline measures are outcome measures: metric definitions explain them only if a metrics version in between
  // changed outcome definitions (METRICS_SCOPE) or the metric parameters changed.
  const m = rows.find((r) => r.key === 'metrics')
  const metricVersions = m && m.before !== null && m.after !== null ? Object.keys(METRICS_SCOPE).filter((x) => cmpVersion(x, m.before as string) > 0 && cmpVersion(x, m.after as string) <= 0) : []
  // A metrics version this script does not know (not in METRICS_SCOPE) counts as an outcome change.
  const unknownMetrics = m !== undefined && m.changed && (m.before === null || m.after === null || !(m.after in METRICS_SCOPE))
  const metricsChanged = metricKeys.length > 0 || unknownMetrics || metricVersions.some((x) => METRICS_SCOPE[x] === 'outcomes')
  const worldText = world.length ? world.map((r) => `${r.key === 'worldsim' ? 'world simulation' : 'ground-truth model'} ${r.before ?? NA} → ${r.after ?? NA}`).join(', ') : 'no simulated-world version change'
  out.push('', '### Rows driven by the simulated world', '')
  if (movedRows.length > 0) {
    out.push(
      `${movedRows.length} of ${shifts.length} baseline-arm measures changed. A baseline arm has no Zill in it, so these changes come from the simulated world (${worldText})${metricsChanged ? ' or from the metric definitions' : ''}, not from Zill — and part of every Zill arm’s change is the same world change. Read Zill against the midday ban only through the paired differences (section 3), which compare arms within one report’s world. Rows marked ${WORLD_FLAG} below are baseline arms whose numbers changed.`,
    )
  } else if (world.length > 0) {
    out.push(`The simulated world changed (${worldText}) but no baseline-arm measure moved: the change did not reach the baseline arms.`)
  } else {
    out.push('Same simulated world and no baseline-arm measure moved: changes in the Zill arms come from Zill (engine and planner) or from the metric definitions.')
  }
  out.push(
    '',
    mdTable(
      ['Baseline arm', 'Measure', `${L0} → ${L1}`, 'Driven by'],
      shifts.map((s) => [label(s.arm), s.measure, arrow(s.before, s.after, 1), s.moved ? `${WORLD_FLAG} simulated world${metricsChanged ? ' or metric definitions' : ''}` : 'unchanged']),
    ),
  )
  return out.join('\n')
}

// ─────────────────────────────── The document ───────────────────────────────

/** "backtest / metrics / worldsim / truth" of one report; a truth version inferred from the world simulation in brackets. */
function versionsText(r: J): string {
  const v = (x: unknown): string => (typeof x === 'string' ? x : NA)
  const truth = typeof r.versions?.truth === 'string' ? r.versions.truth : TRUTH_FROM_WORLDSIM[r.versions?.worldsim] ? `(${TRUTH_FROM_WORLDSIM[r.versions.worldsim]})` : NA
  return `${v(r.versions?.backtest)} / ${v(r.versions?.metrics)} / ${v(r.versions?.worldsim)} / ${truth}`
}

/** Markdown comparison of two cohort reports (pure). */
export function compareCohorts(before: J, after: J, labels: [string, string] = ['v0.1', 'v0.2']): string {
  const [L0, L1] = labels
  const out: string[] = []
  const wsOf = (r: J): number => r.main?.arms?.[0]?.rates?.workerShifts ?? 0
  const sameDays = JSON.stringify((before.days ?? []).map((d: J) => `${d.siteId}|${d.date}`)) === JSON.stringify((after.days ?? []).map((d: J) => `${d.siteId}|${d.date}`))
  const arms = reportArms(before, after)
  const CLOSED = arms.filter((a) => a.kind !== 'shadow').map((a) => a.arm)
  const SHADOW = arms.filter((a) => a.kind === 'shadow').map((a) => a.arm)
  const ALL = arms.map((a) => a.arm)
  const isBaseline = (arm: string): boolean => arms.find((a) => a.arm === arm)?.kind === 'baseline'
  const movedArms = new Set(baselineShifts(before, after).filter((s) => s.moved).map((s) => s.arm))
  /** Arm label, flagged when it is a baseline arm whose numbers changed (simulated world). */
  const rowLabel = (arm: string): string => (movedArms.has(arm) ? `${label(arm)} ${WORLD_FLAG}` : label(arm))
  const flagNote = (): void => {
    if (movedArms.size > 0) out.push('', `${WORLD_FLAG} Baseline arm whose numbers changed between the reports: driven by the simulated world (see “What changed between versions”), not by Zill.`)
  }
  out.push(`# Simulated cohort: ${L0} vs ${L1}`)
  out.push('')
  out.push(
    `Generated by \`npx tsx scripts/validate/compare-cohorts.ts\` from two cohort reports. Every number below is read from those files; nothing is typed by hand. Simulated cohort: projections under stated assumptions (docs/SIMULATION.md §6), not measured health outcomes. Arrows read ${L0} → ${L1} (difference in brackets).`,
  )
  out.push('')
  out.push(
    mdTable(
      ['Item', L0, L1],
      [
        ['Generated by', `\`${before.generatedBy ?? NA}\``, `\`${after.generatedBy ?? NA}\``],
        ['Stamp', `\`${before.stamp?.stamp ?? NA}\``, `\`${after.stamp?.stamp ?? NA}\``],
        ['Versions (back-test / metrics / world simulation / ground truth)', versionsText(before), versionsText(after)],
        ['Mode, seed', `${before.spec?.mode}, \`${before.spec?.seed}\``, `${after.spec?.mode}, \`${after.spec?.seed}\``],
        ['Cohort site-days', String((before.days ?? []).length), `${(after.days ?? []).length}${sameDays ? ' (the same site-days)' : ' (different site-days)'}`],
        ['Worker-shifts per base arm', String(wsOf(before)), String(wsOf(after))],
        ['Site-day runs', String(before.runs?.rows?.length ?? NA), String(after.runs?.rows?.length ?? NA)],
      ],
    ),
  )

  // 0. What changed between versions (generated).
  out.push('', whatChanged(before, after, labels))

  // 1. Work delivered.
  out.push('', '## 1. Work delivered (base case)', '')
  out.push(
    mdTable(
      ['Arm', 'Work min/shift', 'Work vs midday ban only', 'Rest min/shift', 'Water mL/shift'],
      CLOSED.map((arm) => {
        const a = armOf(before, arm)
        const b = armOf(after, arm)
        return [
          rowLabel(arm),
          arrow(val(a?.rates?.perShift?.workMin), val(b?.rates?.perShift?.workMin), 1),
          arm === 'ban_only' ? '—' : arrowPct(val(a?.vsBanOnly?.workRelative), val(b?.vsBanOnly?.workRelative)),
          arrow(val(a?.rates?.perShift?.restMin), val(b?.rates?.perShift?.restMin), 1),
          arrow(val(a?.rates?.perShift?.waterMl), val(b?.rates?.perShift?.waterMl), 0),
        ]
      }),
    ),
  )
  flagNote()

  // 2. By heat tercile.
  out.push('', '## 2. By heat tercile (base case)', '')
  const stratumRows: string[][] = []
  let stratumFlag = false
  for (const s of after.main?.byStratum ?? []) {
    const s0 = (before.main?.byStratum ?? []).find((x: J) => x.stratum === s.stratum)
    for (const arm of CLOSED) {
      const a = (s0?.arms ?? []).find((x: J) => x.arm === arm)
      const b = (s.arms ?? []).find((x: J) => x.arm === arm)
      if (!a && !b) continue
      const keys = ['workMinPerShift', 'excessivePer1000', 'dehydrationPer1000']
      const flag = isBaseline(arm) && keys.some((k) => moved(val(a?.headline?.[k]), val(b?.headline?.[k])))
      stratumFlag ||= flag
      stratumRows.push([
        `${s.stratum} (${s.siteDays} site-days)`,
        flag ? `${label(arm)} ${WORLD_FLAG}` : label(arm),
        arrow(val(a?.headline?.workMinPerShift), val(b?.headline?.workMinPerShift), 1),
        arm === 'ban_only' ? '—' : arrowPct(val(a?.vsBanOnly?.workRelative), val(b?.vsBanOnly?.workRelative)),
        arrow(val(a?.headline?.excessivePer1000), val(b?.headline?.excessivePer1000), 1),
        arrow(val(a?.headline?.dehydrationPer1000), val(b?.headline?.dehydrationPer1000), 1),
      ])
    }
  }
  out.push(mdTable(['Stratum', 'Arm', 'Work min/shift', 'Work vs ban only', 'Excessive strain /1,000', 'Dehydration > 3 % /1,000'], stratumRows))
  if (stratumFlag) out.push('', `${WORLD_FLAG} Baseline arm whose numbers changed in this stratum: driven by the simulated world, not by Zill.`)

  // 3. Outcomes.
  out.push('', '## 3. Outcomes per 1,000 worker-shifts (base case)', '')
  out.push('Worker-shifts with at least one event per 1,000 (heat-symptom episodes: episodes per 1,000).', '')
  const r1000 = (r: J | undefined, k: string): number | null => val(r?.rates?.per1000?.[k])
  out.push(
    mdTable(
      ['Arm', 'Excessive strain', 'Severe strain', 'Critical', 'Dehydration > 3 %', 'Heat-symptom episodes', 'First-aid evacuations'],
      CLOSED.map((arm) => {
        const a = armOf(before, arm)
        const b = armOf(after, arm)
        return [rowLabel(arm), ...['excessive', 'severe', 'critical', 'dehydration', 'symptomaticEpisodes', 'evacuations'].map((k) => arrow(r1000(a, k), r1000(b, k), 1))]
      }),
    ),
  )
  flagNote()
  out.push('', 'Paired differences against the midday ban only on the same worker-shifts (per 1,000):', '')
  out.push(
    mdTable(
      ['Arm − ban only', 'Δ excessive', 'Δ severe', 'Δ dehydration', 'Δ heat-symptom episodes'],
      CLOSED.filter((x) => x !== 'ban_only').map((arm) => {
        const a = armOf(before, arm)?.vsBanOnly
        const b = armOf(after, arm)?.vsBanOnly
        return [label(arm), ...['excessivePer1000', 'severePer1000', 'dehydrationPer1000', 'symptomaticEpisodesPer1000'].map((k) => arrow(val(a?.[k]), val(b?.[k]), 1))]
      }),
    ),
  )
  const floors = [...(after.sensitivity ?? [])].filter((x: J) => x.factor === 'habitualDrinkFraction').sort((x: J, y: J) => Number(y.value) - Number(x.value))
  if (floors.length > 0) {
    out.push('', `### 3.1 Dehydration and heat-symptom deltas next to the drinking floors (${L1} only)`, '')
    out.push(
      `The base case drinks at the calibrated habitual floor (sim/truth.ts DRINK_CALIBRATION); the floor variants bracket it (1.0 = the v0.1 floor, 0.4 = the v0.2 floor). Each row: arm − midday ban only, paired, per 1,000 worker-shifts, on the variants’ site-days (${floors[0].siteDays} site-days); the base row is the base case on those same site-days.`,
      '',
    )
    // Base ban-only rate on the variants' site-days = variant rate − (variant − base), both paired on the same worker-shifts.
    const ban0 = (floors[0].arms ?? []).find((x: J) => x.arm === 'ban_only')
    const banRate = val(ban0?.headline?.dehydrationPer1000)
    const banDelta = val(ban0?.vsBase?.dehydrationPer1000)
    const banBase = banRate !== null && banDelta !== null ? banRate - banDelta : null
    const floorRows: string[][] = []
    for (const arm of CLOSED.filter((x) => x !== 'ban_only')) {
      const baseRef = floors.map((v: J) => (v.arms ?? []).find((x: J) => x.arm === arm)?.baseVsBanOnly).find((x: J | undefined) => x)
      floorRows.push([label(arm), 'Base case (calibrated floor)', signed(val(baseRef?.dehydrationPer1000), 1), signed(val(baseRef?.symptomaticEpisodesPer1000), 1), f(banBase, 1)])
      for (const v of floors) {
        const x = (v.arms ?? []).find((y: J) => y.arm === arm)
        const ban = (v.arms ?? []).find((y: J) => y.arm === 'ban_only')
        floorRows.push([label(arm), v.label, signed(val(x?.vsBanOnly?.dehydrationPer1000), 1), signed(val(x?.vsBanOnly?.symptomaticEpisodesPer1000), 1), f(val(ban?.headline?.dehydrationPer1000), 1)])
      }
    }
    out.push(mdTable(['Arm − ban only', 'Drinking floor', 'Δ dehydration > 3 %', 'Δ heat-symptom episodes', 'Ban-only dehydration > 3 % (this floor)'], floorRows))
  }

  // 4. Alarm burden.
  out.push('', '## 4. Alarm burden (base case)', '')
  out.push(
    `${L0} reports have no alarm basis (metrics ${before.versions?.metrics}): their alarm count is every distinct alert at ≥ high covering the worker (worker alerts and the crew alerts that bundle them). ${L1} keeps that count for comparison and splits individual alarms (about this worker) from exposure advisories (site or crew conditions).`,
    '',
  )
  // Supervisor notifications requiring an acknowledgement per worker-shift (metrics ≥ 1.1.0 burden; n/a before).
  const supAcks = (a: J | undefined): number | null => {
    const x = a?.challenge?.burdenPerWorkerShift?.total?.supervisor?.requiringAck
    return isNum(x) ? x : a?.challenge?.burdenPerWorkerShift ? 0 : null
  }
  const ackPer = (r: J, arm: string, k: string): number | null => {
    const a = armOf(r, arm)
    const n = a?.rates?.workerShifts
    const x = a?.challenge?.ack?.[k]
    return isNum(n) && n > 0 && isNum(x) ? x / n : null
  }
  out.push(
    mdTable(
      ['Arm', 'All alarms ≥ high /worker-shift', 'Individual alarms ≥ high /worker-shift', 'Individual alarms ≥ stop /worker-shift', 'Exposure advisories ≥ high /worker-shift', 'Exposure advisories ≥ high /crew-shift', 'Suppressed advisories ≥ high /worker-shift', 'Supervisor acks /worker-shift', 'Alerts /worker-shift', 'Alerts requiring ack /worker-shift', 'Notifications /worker-shift', 'Acknowledged share'],
      ALL.map((arm) => {
        const a = armOf(before, arm)
        const b = armOf(after, arm)
        return [
          label(arm),
          arrow(val(a?.challenge?.alarmsPerShift), val(b?.challenge?.alarmsPerShift), 2),
          arrow(val(a?.challenge?.individualAlarmsPerShift?.high), val(b?.challenge?.individualAlarmsPerShift?.high), 2),
          arrow(val(a?.challenge?.individualAlarmsPerShift?.stop), val(b?.challenge?.individualAlarmsPerShift?.stop), 2),
          arrow(val(a?.challenge?.exposureAdvisoriesPerWorkerShift), val(b?.challenge?.exposureAdvisoriesPerWorkerShift), 2),
          arrow(isNum(a?.challenge?.exposureAdvisoriesPerCrewShift) ? a.challenge.exposureAdvisoriesPerCrewShift : null, isNum(b?.challenge?.exposureAdvisoriesPerCrewShift) ? b.challenge.exposureAdvisoriesPerCrewShift : null, 2),
          arrow(val(a?.challenge?.suppressedAdvisoriesPerWorkerShift), val(b?.challenge?.suppressedAdvisoriesPerWorkerShift), 2),
          arrow(supAcks(a), supAcks(b), 2),
          arrow(ackPer(before, arm, 'alerts'), ackPer(after, arm, 'alerts'), 2),
          arrow(ackPer(before, arm, 'requiringAck'), ackPer(after, arm, 'requiringAck'), 2),
          arrow(ackPer(before, arm, 'notifications'), ackPer(after, arm, 'notifications'), 2),
          arrowPct(isNum(a?.challenge?.ack?.acknowledgedShare) ? a.challenge.ack.acknowledgedShare : null, isNum(b?.challenge?.ack?.acknowledgedShare) ? b.challenge.ack.acknowledgedShare : null),
        ]
      }),
    ),
  )
  const burdenRows: string[][] = []
  for (const arm of ALL) {
    const bp = armOf(after, arm)?.challenge?.burdenPerWorkerShift
    if (!bp || armOf(after, arm)?.challenge?.ack?.notifications === 0) continue
    for (const basis of ['individual', 'exposure', 'total']) burdenRows.push([label(arm), basis, ...ROLES.map((role) => (bp[basis]?.[role] ? `${f(bp[basis][role].requiringAck, 2)} (${f(bp[basis][role].sent, 2)})` : '0'))])
  }
  if (burdenRows.length) {
    out.push('', `### 4.1 Notifications per worker-shift by basis and recipient (${L1} only)`, '')
    out.push('Notifications that require an acknowledgement (all notifications in brackets).', '')
    out.push(mdTable(['Arm', 'Basis', 'Worker', 'Buddy', 'Supervisor', 'First aider', 'Occupational health'], burdenRows))
  }

  // 5. Detection.
  out.push('', '## 5. Shadow-mode detection', '')
  out.push(
    `Shadow arms: the engine runs and alerts, nobody acts on it, so the ground truth equals the midday-ban-only arm. "${L0} all ≥ high" and "${L1} all ≥ high" use the same definition (every alarm); "${L1} individual" counts individual alarms only (the ${L1} headline).`,
    '',
  )
  const detRows: string[][] = []
  for (const arm of SHADOW) {
    const a = armOf(before, arm)
    const b = armOf(after, arm)
    for (const target of Object.keys(TARGET_LABEL)) {
      const sets: [string, J | undefined][] = [
        [`${L0} all ≥ high`, (a?.detectionAllAlarms ?? a?.detection ?? []).find((d: J) => d.target === target && (d.alarmSet ?? 'all') === 'all')],
        [`${L1} all ≥ high`, (b?.detectionAllAlarms ?? []).find((d: J) => d.target === target)],
        [`${L1} individual ≥ high`, (b?.detection ?? []).find((d: J) => d.target === target && d.alarmSet === 'individual')],
        [`${L1} individual ≥ stop`, (b?.detectionStop ?? []).find((d: J) => d.target === target)],
      ]
      for (const [setLabel, d] of sets) {
        detRows.push([
          label(arm),
          TARGET_LABEL[target],
          setLabel,
          d ? `${d.positives}/${d.workerShifts}` : NA,
          pct(val(d?.sensitivityBeforeOnset)),
          pct(val(d?.sensitivityInShift)),
          pct(val(d?.specificity)),
          pct(val(d?.ppvShift)),
          pct(val(d?.ppvAlarm)),
          f(val(d?.falseAlarmsPerShift), 2),
          leadText(d?.leadTime),
        ])
      }
    }
  }
  out.push(mdTable(['Shadow arm', 'Target', 'Alarms', 'Positives', 'Sensitivity (by onset)', 'Sensitivity (in shift)', 'Specificity', 'PPV (shift)', 'PPV (alarm, ±2 h)', 'False alarms /shift', 'Median lead time, min'], detRows))
  out.push('', 'Event lead time (PILOT.md §5.4 (a): first alarm ≥ high before a symptomatic event) in the closed-loop and shadow arms:', '')
  out.push(
    mdTable(
      ['Arm', `${L0} (all alarms)`, `${L1} (all alarms)`, `${L1} (individual alarms)`],
      ALL.filter((arm) => !isBaseline(arm)).map((arm) => {
        const a = armOf(before, arm)?.challenge
        const b = armOf(after, arm)?.challenge
        return [label(arm), leadText(a?.eventLeadTimeAllAlarms ?? a?.eventLeadTime), leadText(b?.eventLeadTimeAllAlarms), leadText(b?.eventLeadTime)]
      }),
    ),
  )

  // 6. Compliance.
  out.push('', '## 6. Zone and midday-break compliance, adherence (base case)', '')
  out.push(
    mdTable(
      ['Arm', 'ADOSH zone compliant share', 'Zone worker-hours checked', 'Zone excess min', 'Unacclimatised zone hours', 'Midday break compliant share', 'Midday violation min', 'Adherence'],
      CLOSED.map((arm) => {
        const a = armOf(before, arm)?.challenge
        const b = armOf(after, arm)?.challenge
        return [
          rowLabel(arm),
          arrowPct(val(a?.zone?.compliantShare), val(b?.zone?.compliantShare)),
          arrow(isNum(a?.zone?.workerHours) ? a.zone.workerHours : null, isNum(b?.zone?.workerHours) ? b.zone.workerHours : null, 0),
          arrow(isNum(a?.zone?.excessMin) ? a.zone.excessMin : null, isNum(b?.zone?.excessMin) ? b.zone.excessMin : null, 1),
          arrow(isNum(a?.zone?.unacclimatizedHours) ? a.zone.unacclimatizedHours : null, isNum(b?.zone?.unacclimatizedHours) ? b.zone.unacclimatizedHours : null, 0),
          arrowPct(val(a?.midday?.compliantShare), val(b?.midday?.compliantShare)),
          arrow(isNum(a?.midday?.violationMin) ? a.midday.violationMin : null, isNum(b?.midday?.violationMin) ? b.midday.violationMin : null, 0),
          arrowPct(val(a?.adherence), val(b?.adherence)),
        ]
      }),
    ),
  )
  flagNote()

  // 7. Variants.
  out.push('', '## 7. Sensitivity and robustness variants', '')
  const vBefore = new Map((before.variants ?? []).map((v: J) => [v.id, v]))
  const summaries = (r: J): J[] => [...(r.sensitivity ?? []), ...(r.robustness ?? [])]
  const sumBefore = new Map(summaries(before).map((v: J) => [v.id, v]))
  const zf = (v: J | undefined): J | undefined => (v?.arms ?? []).find((a: J) => a.arm === 'zill_full')
  out.push(
    mdTable(
      ['Variant', `Run in ${L0} (runs)`, `Run in ${L1} (runs)`, 'Zill (with wearable): work min/shift', 'Zill (with wearable): work vs ban only', 'Zill (with wearable): Δ excessive vs ban only /1,000'],
      (after.variants ?? [])
        .filter((v: J) => v.group !== 'base')
        .map((v: J) => {
          const v0 = vBefore.get(v.id) as J | undefined
          const s1 = summaries(after).find((x: J) => x.id === v.id)
          const s0 = sumBefore.get(v.id) as J | undefined
          return [
            v.label,
            v0 ? `${v0.supported ? 'yes' : 'no'} (${v0.runs})` : 'not defined',
            `${v.supported ? 'yes' : 'no'} (${v.runs})`,
            arrow(val(zf(s0)?.headline?.workMinPerShift), val(zf(s1)?.headline?.workMinPerShift), 1),
            arrowPct(val(zf(s0)?.vsBanOnly?.workRelative), val(zf(s1)?.vsBanOnly?.workRelative)),
            arrow(val(zf(s0)?.vsBanOnly?.excessivePer1000), val(zf(s1)?.vsBanOnly?.excessivePer1000), 1),
          ]
        }),
    ),
  )
  out.push('')
  return out.join('\n')
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name: string, dflt: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
  const path = (p: string): string => (isAbsolute(p) ? p : repoPath(p))
  const before = JSON.parse(readFileSync(path(arg('before', 'docs/dev/cohort-v0.2-medium.json')), 'utf8')) as J
  const after = JSON.parse(readFileSync(path(arg('after', 'public/data/validation/cohort.json')), 'utf8')) as J
  const labels = arg('labels', 'v0.2,v0.3').split(',') as [string, string]
  const outPath = arg('out', 'docs/dev/cohort-v0.2-vs-v0.3.md')
  writeFileSync(path(outPath), compareCohorts(before, after, labels), 'utf8')
  console.log(`[compare-cohorts] wrote ${outPath}`)
}
