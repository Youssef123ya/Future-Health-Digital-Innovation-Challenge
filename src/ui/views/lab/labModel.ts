/**
 * Pure view-model helpers of the Simulation lab: policy metadata, the day picker, chart rows from packed or live traces,
 * run-length segments for the level and activity lanes, and number formatting. No React, no stores (tested in
 * labModel.test.ts). Everything rendered from these rows is SIMULATED COHORT data and may carry ground truth.
 */
import { RISK_LEVELS, type RiskLevel } from '../../../engine/types'
import { ECTEMP_DISPLAY, ectempDisplayBand } from '../../../engine/physio'
import { MINUTE_MS, formatLocalHhmm } from '../../../engine/time'
import type { WorkerLocation } from '../../../engine/risk'
import { getSite, isSiteId, type SiteId } from '../../../data/sites'
import { archivePeriodFor, previousRunsYearFor } from '../../../data/weather'
import { epochFromLocal } from '../../../engine/time'
import { SCENARIOS, type ScenarioId } from '../../../sim/scenarios'
import { POLICY_IDS, type PolicyId, type TruthEventKind, type WorkerMinute } from '../../../sim/types'
import type { DaySource, LabEventMarker, LabRunWorker, PackedTraces, PolicyRunResult, PolicySummary } from './labTypes'

// ─────────────────────────────── Policies ───────────────────────────────

export interface PolicyMeta {
  name: string
  /** What protects the worker (docs/SIMULATION.md §4). */
  description: string
}

/** Policy names and what protects the worker under each (docs/SIMULATION.md §4; dev/engine-api-wave2d.md §1). */
export const POLICY_META: Readonly<Record<PolicyId, PolicyMeta>> = {
  ban_only: {
    name: 'Midday ban only',
    description: 'MoHRE midday break, statutory breaks and self-pacing. The baseline: no Zill.',
  },
  site_index: {
    name: 'Site index rules',
    description: 'Ban only plus ADOSH TWL zone work/rest cycles applied crew-wide from the hourly site forecast.',
  },
  zill_env: {
    name: 'Zill without wearables',
    description: 'Day plan with its ISO 7933 screen, personal environment, projection and regulation channels, check-ins, buddy escalation.',
  },
  zill_full: {
    name: 'Zill with wearables',
    description: 'Zill without wearables plus the physiology channel for workers who consented and wear a band.',
  },
  zill_monitored: {
    name: 'Zill monitored mode',
    description:
      'Site opt-in with occupational-health sign-off: WBGT tables screen; an acclimatised, monitored worker’s own ISO 7933 projection and strain criteria enforce, with table fallback in the same minute.',
  },
}

/** Policy order of every comparison (sim/types.ts POLICY_IDS). */
export function sortPolicies(policies: readonly PolicyId[]): PolicyId[] {
  return [...policies].sort((a, b) => POLICY_IDS.indexOf(a) - POLICY_IDS.indexOf(b))
}

// ─────────────────────────────── Days ───────────────────────────────

/** A cached demo day (public/data/weather/demo-days.json, minimal fields). */
export interface DemoDayOption {
  siteId: SiteId
  date: string
  tags: string[]
  why: string[]
}

/** One entry of the lab's day picker. */
export interface DayOption {
  key: string
  source: DaySource
  siteId: SiteId
  date: string
  label: string
  detail: string
  group: 'scenario' | 'demo'
}

/** Parses demo-days.json defensively into {@link DemoDayOption}s (unknown sites and malformed rows are skipped). */
export function parseDemoDays(json: unknown): DemoDayOption[] {
  const days = (json as { days?: unknown } | null)?.days
  if (!Array.isArray(days)) return []
  const out: DemoDayOption[] = []
  for (const d of days as Array<Record<string, unknown>>) {
    const site = (d?.site as { id?: unknown } | undefined)?.id
    const date = d?.date
    if (typeof site !== 'string' || !isSiteId(site) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const tags = Array.isArray(d.tag) ? d.tag : Array.isArray(d.tags) ? d.tags : []
    out.push({ siteId: site, date, tags: tags.filter((x): x is string => typeof x === 'string'), why: Array.isArray(d.why) ? d.why.filter((x): x is string => typeof x === 'string') : [] })
  }
  return out
}

/** Key of a day source (form state, data cache). */
export function dayKey(source: DaySource): string {
  return source.kind === 'scenario' ? `scenario:${source.scenarioId}` : `site:${source.siteId}:${source.date}`
}

/** Key of the day picker's "another archived day" entry. */
export const CUSTOM_DAY_KEY = 'custom'

/** First and last dates the custom day picker accepts (data/weather.ts archivePeriodFor). */
export const ARCHIVE_DATE_RANGE = { min: '2020-06-01', max: '2025-11-30' } as const

/**
 * Validation message for a custom site-day, or null when cached weather exists: the season archive covers Jun–Sep
 * 2020–2025 at every site and November 2025 at Musaffah (data/weather.ts archivePeriodFor).
 */
export function archiveDayError(siteId: SiteId, date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick a date.'
  const noon = epochFromLocal(`${date}T12:00`)
  if (!Number.isFinite(noon)) return 'Pick a valid date.'
  if (archivePeriodFor(siteId, noon) === null) {
    return siteId === 'musaffah'
      ? 'Weather is cached for June–September 2020–2025 and November 2025 at Musaffah.'
      : 'Weather is cached for June–September 2020–2025 at this site.'
  }
  return null
}

/** True when an archived engine forecast exists for the date (Jun–Sep 2024–2025); otherwise the run uses the analysis as a perfect forecast. */
export function hasArchivedForecast(date: string): boolean {
  const noon = epochFromLocal(`${date}T12:00`)
  return Number.isFinite(noon) && previousRunsYearFor(noon) !== null
}

/** "2025-08-01" → "Fri 1 Aug 2025" (UTC calendar date, no time zone shift). */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const TAG_TEXT: Readonly<Record<string, string>> = {
  peak_wbgt_proxy: 'peak shade-WBGT proxy',
  peak_wbgt_liljegren: 'peak WBGT',
  most_humid: 'most humid',
  hottest_dry_bulb: 'hottest air temperature',
  mild_november: 'mild November day',
}

/** Day picker entries: the named scenarios first, then the cached demo days no scenario uses. */
export function dayOptions(demoDays: readonly DemoDayOption[]): DayOption[] {
  const scen: DayOption[] = SCENARIOS.map((s) => ({
    key: dayKey({ kind: 'scenario', scenarioId: s.id }),
    source: { kind: 'scenario', scenarioId: s.id },
    siteId: s.siteId,
    date: s.date,
    label: s.title,
    detail: `${getSite(s.siteId).name} · ${formatDate(s.date)}`,
    group: 'scenario',
  }))
  const used = new Set(SCENARIOS.map((s) => `${s.siteId}|${s.date}`))
  const demo: DayOption[] = demoDays
    .filter((d) => !used.has(`${d.siteId}|${d.date}`))
    .map((d) => ({
      key: dayKey({ kind: 'site-day', siteId: d.siteId, date: d.date }),
      source: { kind: 'site-day', siteId: d.siteId, date: d.date },
      siteId: d.siteId,
      date: d.date,
      label: `${getSite(d.siteId).name}: ${d.tags.map((t) => TAG_TEXT[t] ?? t.replace(/_/g, ' ')).join(', ') || 'demo day'}`,
      detail: `${formatDate(d.date)} · ${d.why[0] ?? 'Cached demo day'}`,
      group: 'demo',
    }))
  return [...scen, ...demo]
}

/** The scenario id of a day source, or null for a demo day. */
export function scenarioOf(source: DaySource): ScenarioId | null {
  return source.kind === 'scenario' ? source.scenarioId : null
}

/** A fresh random seed ("lab-" + 6 hex digits). */
export function randomSeed(rand: () => number = Math.random): string {
  return `lab-${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`
}

// ─────────────────────────────── Chart rows ───────────────────────────────

/** One minute of the truth-vs-estimate charts. */
export interface TruthRow {
  t: number
  /** Simulated ground-truth core temperature, °C. */
  core: number | null
  /** ECTemp estimate centre (display rounding), °C. */
  ect: number | null
  /** ECTemp display band [low, high], °C (engine/physio.ts ectempDisplayBand, ±0.6 °C). */
  ectBand: [number, number] | null
  hrTrue: number | null
  hrMeas: number | null
  dehy: number | null
  wbgt: number | null
  level: RiskLevel | null
  working: boolean | null
  location: WorkerLocation | null
}

const LOCATIONS: readonly WorkerLocation[] = ['sun', 'shade', 'indoor_cool']
const num = (v: number): number | null => (Number.isFinite(v) ? v : null)

function band(ect: number | null): { ect: number | null; ectBand: [number, number] | null } {
  if (ect === null) return { ect: null, ectBand: null }
  const b = ectempDisplayBand(ect, { channelValid: true })
  return b ? { ect: b.centreC, ectBand: [b.lowC, b.highC] } : { ect: null, ectBand: null }
}

/** Chart rows of one worker from a packed run trace, every `step` minutes (rows without data are dropped). */
export function rowsFromPacked(p: PackedTraces, workerIndex: number, step = 1): TruthRow[] {
  const rows: TruthRow[] = []
  if (workerIndex < 0 || workerIndex >= p.workerIds.length) return rows
  const base = workerIndex * p.nMinutes
  for (let m = 0; m < p.nMinutes; m += Math.max(1, step)) {
    const i = base + m
    const core = num(p.coreTrueC[i])
    if (core === null) continue
    const lv = p.level[i]
    const loc = p.location[i]
    rows.push({
      t: p.t0 + m * MINUTE_MS,
      core,
      ...band(num(p.ectempC[i])),
      hrTrue: num(p.hrTrueBpm[i]),
      hrMeas: num(p.hrMeasuredBpm[i]),
      dehy: num(p.dehydrationPct[i]),
      wbgt: num(p.wbgtEffC[i]),
      level: lv < RISK_LEVELS.length ? RISK_LEVELS[lv] : null,
      working: p.working[i] === 0 ? false : p.working[i] === 1 ? true : null,
      location: loc < LOCATIONS.length ? LOCATIONS[loc] : null,
    })
  }
  return rows
}

/** Chart rows from the live world's per-minute trace (state/selectors.ts selectLabTrace). */
export function rowsFromMinutes(minutes: readonly WorkerMinute[]): TruthRow[] {
  return minutes.map((m) => ({
    t: m.t,
    core: m.coreTrueC,
    ...band(m.ectempC),
    hrTrue: m.hrTrueBpm,
    hrMeas: m.hrMeasuredBpm,
    dehy: m.dehydrationPct,
    wbgt: m.wbgtEffC,
    level: m.level,
    working: m.working,
    location: m.location,
  }))
}

/** A run of equal values over [from, to) (epoch ms). */
export interface Segment<T> {
  from: number
  to: number
  value: T
}

/**
 * Run-length segments of a per-minute value (null values break runs and are not emitted). Each row covers
 * [t, t + stepMs); a time gap larger than one step also breaks the run.
 */
export function segmentsOf<T>(rows: readonly TruthRow[], pick: (r: TruthRow) => T | null, stepMs = MINUTE_MS): Segment<T>[] {
  const out: Segment<T>[] = []
  let cur: Segment<T> | null = null
  for (const r of rows) {
    const v = pick(r)
    if (v === null) {
      cur = null
      continue
    }
    if (cur && cur.value === v && r.t <= cur.to) {
      cur.to = r.t + stepMs
    } else {
      cur = { from: r.t, to: r.t + stepMs, value: v }
      out.push(cur)
    }
  }
  return out
}

/** What the worker was doing in a minute (activity lane). */
export type Activity = 'work_sun' | 'work_shade' | 'rest'

export function activityOf(r: TruthRow): Activity | null {
  if (r.working === null) return null
  if (!r.working) return 'rest'
  return r.location === 'sun' ? 'work_sun' : 'work_shade'
}

export const ACTIVITY_TEXT: Readonly<Record<Activity, string>> = {
  work_sun: 'Working in sun',
  work_shade: 'Working in shade',
  rest: 'Resting or idle',
}

/**
 * Minutes with no valid wearable reading while the device should have one (ECTemp/HR gaps), as segments. Only for
 * workers whose device receives wearable data (`expected`).
 */
export function wearableGaps(rows: readonly TruthRow[], expected: boolean, stepMs = MINUTE_MS): Segment<true>[] {
  if (!expected) return []
  return segmentsOf(rows, (r) => (r.core !== null && r.hrMeas === null ? true : null), stepMs)
}

/** True when any row carries a measured heart rate (the device received wearable data). */
export function hasWearableData(rows: readonly TruthRow[]): boolean {
  return rows.some((r) => r.hrMeas !== null)
}

/** Share of rows (with ground truth) whose truth lies inside the ECTemp band; null without estimates. */
export function bandCoverage(rows: readonly TruthRow[]): { inside: number; total: number } | null {
  let inside = 0
  let total = 0
  for (const r of rows) {
    if (r.core === null || r.ectBand === null) continue
    total++
    if (r.core >= r.ectBand[0] && r.core <= r.ectBand[1]) inside++
  }
  return total ? { inside, total } : null
}

/** Where the truth sits against the estimate band: 'inside', 'above', 'below', or null without an estimate. */
export function bandPosition(core: number | null, band: { lowC: number; highC: number } | null): 'inside' | 'above' | 'below' | null {
  if (core === null || band === null) return null
  if (core > band.highC) return 'above'
  if (core < band.lowC) return 'below'
  return 'inside'
}

/** Rows on the local `everyMin`-minute grid (plus the last row) for the accessible data tables. UAE time is UTC+4, so the UTC grid is the local grid. */
export function sampleRows(rows: readonly TruthRow[], everyMin = 30): TruthRow[] {
  return rows.filter((r, i) => i === rows.length - 1 || Math.round(r.t / MINUTE_MS) % everyMin === 0)
}

/** The row with the highest simulated core temperature (first one on ties), or null. */
export function peakRow(rows: readonly TruthRow[]): TruthRow | null {
  let best: TruthRow | null = null
  for (const r of rows) if (r.core !== null && (best === null || best.core === null || r.core > best.core)) best = r
  return best
}

/** The row at (or the last row before) time t, by binary search on the time-sorted rows; null before the first row. */
export function rowAt(rows: readonly TruthRow[], t: number): TruthRow | null {
  let lo = 0
  let hi = rows.length - 1
  let found: TruthRow | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].t <= t) {
      found = rows[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** First time the displayed level reached `min` or above, or null. */
export function firstLevelAtLeast(rows: readonly TruthRow[], min: RiskLevel): number | null {
  const k = RISK_LEVELS.indexOf(min)
  for (const r of rows) if (r.level !== null && RISK_LEVELS.indexOf(r.level) >= k) return r.t
  return null
}

/** Events of a worker within ±`windowMin` minutes of t. */
export function eventsNear(events: readonly LabEventMarker[], t: number, windowMin = 2): LabEventMarker[] {
  const w = windowMin * MINUTE_MS
  return events.filter((e) => Math.abs(e.t - t) <= w)
}

/** Ground-truth event kinds with chart labels (SIMULATION.md §2.4). */
export const TRUTH_EVENT_META: Readonly<Record<TruthEventKind, { short: string; label: string }>> = {
  symptom_onset: { short: 'Symptom onset', label: 'Symptom onset (simulated)' },
  dehydration_3pct: { short: 'Dehydration > 3 %', label: 'Body-mass loss passed 3 %' },
  excessive_strain: { short: 'Excessive strain', label: 'Core ≥ 38.5 °C (38.0 °C if unacclimatised) for 10 min' },
  severe_strain: { short: 'Severe strain', label: 'Core reached 39.5 °C' },
  critical: { short: 'Critical', label: 'Core reached 40.0 °C or CNS signs' },
}

/** Hourly x-axis ticks between t0 and tEnd (every `everyH` hours). */
export function hourTicks(t0: number, tEnd: number, everyH = 2): number[] {
  const out: number[] = []
  const h = 60 * MINUTE_MS
  for (let t = Math.ceil(t0 / h) * h; t <= tEnd; t += everyH * h) out.push(t)
  return out
}

/** Y-axis domain of the core-temperature chart: always shows the 38.5–40 °C criteria; widens for extreme data. */
export function coreDomain(rows: readonly TruthRow[]): [number, number] {
  let lo = 36.5
  let hi = 40.5
  for (const r of rows) {
    if (r.core !== null) {
      lo = Math.min(lo, r.core)
      hi = Math.max(hi, r.core)
    }
    if (r.ectBand) {
      lo = Math.min(lo, r.ectBand[0])
      hi = Math.max(hi, r.ectBand[1])
    }
  }
  return [Math.floor(lo * 2) / 2, Math.ceil(hi * 2) / 2]
}

/** Y-axis domain of the heart-rate chart. */
export function hrDomain(rows: readonly TruthRow[]): [number, number] {
  let lo = 60
  let hi = 180
  for (const r of rows) {
    for (const v of [r.hrTrue, r.hrMeas]) {
      if (v === null) continue
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }
  return [Math.floor(lo / 20) * 20, Math.ceil(hi / 20) * 20]
}

/** ECTemp display half-width (engine/physio.ts ECTEMP_DISPLAY, ≈ Buller 2013 limits of agreement). */
export const ECTEMP_HALF_WIDTH_C = ECTEMP_DISPLAY.HALF_WIDTH_C

// ─────────────────────────────── Formatting ───────────────────────────────

export const hhmm = (t: number): string => formatLocalHhmm(t)

/** Value with fixed decimals, or the no-data dash. */
export function fixed(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

/** Minutes as hours with one decimal ("5.2 h"). */
export function hours(min: number | null | undefined, digits = 1): string {
  return min === null || min === undefined || !Number.isFinite(min) ? '—' : `${(min / 60).toFixed(digits)} h`
}

/** Followed / instructions as a whole percentage, or null without instructions. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null
}

/** Signed difference text against a baseline ("+3", "−16", "±0"); precision decimals. */
export function deltaText(value: number, base: number, precision = 0): string {
  const d = value - base
  const r = Number(d.toFixed(precision))
  if (r === 0) return '±0'
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(precision)}`
}

/** Each value as a fraction of the largest (0 when all are 0) — the comparison meters' widths. */
export function shareOfMax(values: readonly (number | null)[]): number[] {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const max = Math.max(0, ...finite)
  return values.map((v) => (max > 0 && v !== null && Number.isFinite(v) ? Math.max(0, v) / max : 0))
}

// ─────────────────────────────── Policy comparison ───────────────────────────────

export type MetricGroup = 'harm' | 'work' | 'alerts'

/** One row of the policy comparison (cards and table). */
export interface MetricDef {
  id: string
  group: MetricGroup
  label: string
  /** What the number counts (table caption, tooltip). */
  hint: string
  value: (s: PolicySummary) => number | null
  /** Display precision of the value and its delta. */
  precision: number
  unit?: string
  /** Secondary text under the value (workers affected, per worker-shift), or null. */
  detail?: (s: PolicySummary) => string | null
  /** Direction that is better for the worker; 'none' = context only (no judgement implied). */
  better: 'lower' | 'higher' | 'none'
}

export const METRIC_GROUP_TEXT: Readonly<Record<MetricGroup, { title: string; note: string }>> = {
  harm: { title: 'Simulated harm', note: 'Ground-truth events of the virtual workers; lower is better.' },
  work: { title: 'Work, rest and water', note: 'Totals over all worker-shifts of the day.' },
  alerts: { title: 'Alerts and adherence', note: 'What the engine raised and how instructions were followed.' },
}

const workersText = (n: number): string => `${n} ${n === 1 ? 'worker' : 'workers'}`
const perShift = (total: number, s: PolicySummary, unitDiv: number, digits: number, unit: string): string | null =>
  s.workers > 0 ? `${(total / unitDiv / s.workers).toFixed(digits)} ${unit} per worker-shift` : null

/** The comparison metrics in display order (labRun.ts summariseRun; sim/metrics.ts definitions). */
export const METRICS: readonly MetricDef[] = [
  { id: 'excessive', group: 'harm', label: 'Excessive heat strain', hint: 'Events of core ≥ 38.5 °C (38.0 °C if unacclimatised) for 10 min', value: (s) => s.excessive.events, precision: 0, detail: (s) => workersText(s.excessive.workers), better: 'lower' },
  { id: 'severe', group: 'harm', label: 'Severe strain', hint: 'Events of core reaching 39.5 °C', value: (s) => s.severe.events, precision: 0, detail: (s) => workersText(s.severe.workers), better: 'lower' },
  { id: 'critical', group: 'harm', label: 'Critical', hint: 'Events of core reaching 40.0 °C or CNS signs', value: (s) => s.critical.events, precision: 0, detail: (s) => workersText(s.critical.workers), better: 'lower' },
  { id: 'dehydration', group: 'harm', label: 'Dehydration over 3 %', hint: 'Workers whose body-mass loss passed 3 %', value: (s) => s.dehydration.workers, precision: 0, unit: 'workers', better: 'lower' },
  { id: 'symptoms', group: 'harm', label: 'Heat-symptom episodes', hint: 'Episodes of heat-exhaustion, cramp or CNS signs', value: (s) => s.heatSymptomEpisodes, precision: 0, detail: (s) => (s.evacuations > 0 ? `${s.evacuations} ended the shift in first aid` : 'none ended the shift'), better: 'lower' },
  { id: 'core385', group: 'harm', label: 'Time at core ≥ 38.5 °C', hint: 'Worker-minutes with simulated core temperature at or above 38.5 °C', value: (s) => s.minutesCoreAbove385, precision: 0, unit: 'min', detail: (s) => (Number.isFinite(s.peakCoreC) ? `peak ${s.peakCoreC.toFixed(1)} °C` : null), better: 'lower' },
  { id: 'work', group: 'work', label: 'Work delivered', hint: 'Working minutes over all worker-shifts', value: (s) => s.workMin / 60, precision: 1, unit: 'h', detail: (s) => perShift(s.workMin, s, 60, 1, 'h'), better: 'higher' },
  { id: 'rest', group: 'work', label: 'Rest', hint: 'Cycle rest, breaks and instructed rest', value: (s) => s.restMin / 60, precision: 1, unit: 'h', detail: (s) => perShift(s.restMin, s, 60, 1, 'h'), better: 'none' },
  { id: 'water', group: 'work', label: 'Water drunk', hint: 'True intake of all workers', value: (s) => s.waterMl / 1000, precision: 1, unit: 'L', detail: (s) => perShift(s.waterMl, s, 1000, 1, 'L'), better: 'none' },
  { id: 'midday', group: 'work', label: 'Sun work in the midday break', hint: 'Minutes worked in the sun inside the MoHRE midday break window (target 0)', value: (s) => s.middayViolationMin, precision: 0, unit: 'min', better: 'lower' },
  { id: 'alerts', group: 'alerts', label: 'Alerts raised', hint: 'Distinct alerts at any level (0 when the engine does not run)', value: (s) => s.alerts.raised, precision: 0, detail: (s) => `${s.alerts.alarms} reached High or above`, better: 'none' },
  { id: 'notifications', group: 'alerts', label: 'Notifications sent', hint: 'Messages delivered to workers, buddies, supervisors and responders', value: (s) => s.alerts.notifications, precision: 0, detail: (s) => `${s.alerts.exposureToSupervisor} exposure advisories reached a supervisor`, better: 'lower' },
  { id: 'suppressed', group: 'alerts', label: 'Advisories suppressed by design', hint: 'Exposure advisories whose action the plan already enforces: logged and notified to nobody (ANSI/ISA-18.2)', value: (s) => s.alerts.suppressed, precision: 0, better: 'none' },
  { id: 'adherence', group: 'alerts', label: 'Instructions followed', hint: 'Rest, stop and drink instructions the virtual workers followed', value: (s) => percent(s.adherence.followed, s.adherence.instructions), precision: 0, unit: '%', detail: (s) => (s.adherence.instructions > 0 ? `${s.adherence.followed} of ${s.adherence.instructions}` : 'no instructions issued'), better: 'higher' },
]

/** Value text of a metric ("—" without a value). */
export function metricText(m: MetricDef, s: PolicySummary): string {
  const v = m.value(s)
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(m.precision)
}

/** The baseline run of a comparison: the midday-ban-only policy when it ran, else null. */
export function baselineOf(results: readonly PolicyRunResult[]): PolicyRunResult | null {
  return results.find((r) => r.policy === 'ban_only') ?? null
}

/**
 * One factual sentence comparing the Zill policy with the fewest excessive-strain events against the midday ban
 * alone, or null without both. Wording stays a projection (no outcome claim).
 */
export function comparisonHeadline(results: readonly PolicyRunResult[]): string | null {
  const base = baselineOf(results)
  const zill = results.filter((r) => r.policy !== 'ban_only' && r.policy !== 'site_index')
  if (!base || zill.length === 0) return null
  const best = [...zill].sort((a, b) => a.summary.excessive.events - b.summary.excessive.events || b.summary.workMin - a.summary.workMin)[0]
  const b = base.summary
  const z = best.summary
  const workPct = b.workMin > 0 ? Math.round(((z.workMin - b.workMin) / b.workMin) * 100) : null
  const work = workPct === null ? '' : workPct === 0 ? ', with the same work delivered' : `, with ${Math.abs(workPct)} % ${workPct < 0 ? 'less' : 'more'} work delivered`
  return `${POLICY_META[best.policy].name}: ${z.excessive.events} excessive-strain ${z.excessive.events === 1 ? 'event' : 'events'} and ${z.dehydration.workers} ${z.dehydration.workers === 1 ? 'worker' : 'workers'} over 3 % dehydration, against ${b.excessive.events} and ${b.dehydration.workers} under the midday ban only${work}.`
}

// ─────────────────────────────── Worker explorer ───────────────────────────────

/** Total ground-truth harm events of a worker (symptom onsets excluded). */
export function harmEvents(w: LabRunWorker): number {
  return w.events.excessive_strain + w.events.severe_strain + w.events.critical + w.events.dehydration_3pct
}

/**
 * The worker to open first: the one with the highest simulated core temperature under the first (baseline) policy of
 * the run, so the explorer starts on the most instructive trace; null without workers.
 */
export function defaultWorkerId(results: readonly PolicyRunResult[]): string | null {
  const first = results[0]
  if (!first || first.workers.length === 0) return null
  return [...first.workers].sort((a, b) => b.maxCoreC - a.maxCoreC || harmEvents(b) - harmEvents(a))[0].id
}

/** Minutes the worker's device showed `min` or above. */
export function minutesAtLeast(w: LabRunWorker, min: RiskLevel): number {
  const k = RISK_LEVELS.indexOf(min)
  return RISK_LEVELS.reduce((acc, lv, i) => (i >= k ? acc + (w.minutesByLevel[lv] ?? 0) : acc), 0)
}

/** Overall progress of an experiment (0–1) from the worker's per-policy progress message. */
export function overallProgress(p: { phase: 'loading' | 'running'; policyIndex: number; policyCount: number; fraction: number } | null): number {
  if (!p || p.policyCount <= 0) return 0
  if (p.phase === 'loading') return 0
  return Math.min(1, Math.max(0, (p.policyIndex + Math.min(1, Math.max(0, p.fraction))) / p.policyCount))
}
