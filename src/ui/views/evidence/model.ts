/**
 * View-model mapping for the Evidence view: pure functions from the validation files to chart rows and table rows.
 * Nothing here computes a new statistic; every number is read from a file (ARCHITECTURE.md §1 principle 7).
 */
import type {
  ArmId,
  CohortArm,
  CohortFile,
  Est,
  ForecastFile,
  HoursByHour,
  HoursByMonth,
  HoursSite,
  WorkRestRow,
} from './types'

// ─── Labels ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SITE_IDS = ['musaffah', 'kezad', 'ruwais', 'alain', 'saadiyat'] as const
export type SiteId = (typeof SITE_IDS)[number]

const SITE_LABELS: Readonly<Record<string, string>> = {
  musaffah: 'Musaffah',
  kezad: 'KEZAD',
  ruwais: 'Ruwais',
  alain: 'Al Ain',
  saadiyat: 'Saadiyat',
  all: 'All five sites',
}

export function siteLabel(id: string): string {
  return SITE_LABELS[id] ?? id
}

export const MONTH_LABELS: Readonly<Record<number, string>> = {
  0: 'Whole season (Jun–Sep)',
  6: 'June',
  7: 'July',
  8: 'August',
  9: 'September',
}

export interface ArmMeta {
  label: string
  /** Short label for chart marks. */
  short: string
  kind: 'baseline' | 'zill' | 'shadow'
  description: string
}

/**
 * Arm names. The two Zill arms the challenge brief compares are Standard limits (`zill_full`: NIOSH/ACGIH tables, the
 * ADOSH rule pack and the ISO 7933 screen set the plan; wearable for consenting workers) and Monitored mode
 * (`zill_monitored`: the site opt-in where monitored, acclimatised workers are held to their own ISO 7933 projection).
 */
export const ARM_META: Readonly<Record<ArmId, ArmMeta>> = {
  ban_only: {
    label: 'Midday ban only',
    short: 'Midday ban only',
    kind: 'baseline',
    description: 'MoHRE midday break, statutory breaks and self-pacing. The reference arm.',
  },
  site_index: {
    label: 'Site TWL index',
    short: 'Site TWL index',
    kind: 'baseline',
    description: 'Midday ban plus ADOSH TWL zone work/rest cycles applied crew-wide from the hourly site forecast.',
  },
  zill_env: {
    label: 'Zill: Standard limits, no wearable',
    short: 'Standard, no wearable',
    kind: 'zill',
    description: 'Standard limits with the environment, projection and regulation channels only.',
  },
  zill_full: {
    label: 'Zill: Standard limits',
    short: 'Standard limits',
    kind: 'zill',
    description:
      'NIOSH/ACGIH work/rest tables, the ADOSH rule pack and the ISO 7933 screen set the plan; wearable for consenting workers.',
  },
  zill_monitored: {
    label: 'Zill: Monitored mode',
    short: 'Monitored mode',
    kind: 'zill',
    description:
      'Site opt-in: tables become a screen; a monitored, acclimatised worker is held to their own ISO 7933 projection.',
  },
  shadow_zill_env: {
    label: 'Shadow: Standard limits, no wearable',
    short: 'Shadow, no wearable',
    kind: 'shadow',
    description: 'Midday-ban behaviour; the engine runs and alerts but nobody acts on it.',
  },
  shadow_zill_full: {
    label: 'Shadow: Standard limits',
    short: 'Shadow, Standard',
    kind: 'shadow',
    description: 'Midday-ban behaviour; the engine runs and alerts but nobody acts on it.',
  },
  shadow_zill_monitored: {
    label: 'Shadow: Monitored mode',
    short: 'Shadow, Monitored',
    kind: 'shadow',
    description: 'Midday-ban behaviour; the engine runs and alerts but nobody acts on it.',
  },
}

export function armLabel(arm: string): string {
  return (ARM_META as Readonly<Record<string, ArmMeta>>)[arm]?.label ?? arm
}

export function findArm<T extends { arm: string }>(arms: readonly T[] | null | undefined, arm: ArmId): T | undefined {
  return arms?.find((a) => a.arm === arm)
}

export const DETECTION_TARGET_LABELS: Readonly<Record<string, string>> = {
  excessive_strain: 'Excessive strain',
  severe_strain: 'Severe strain (≥ 39.5 °C)',
  critical: 'Critical (≥ 40 °C or CNS signs)',
  dehydration_3pct: 'Dehydration > 3 %',
  heat_symptoms: 'Heat symptoms (ground truth: exhaustion, cramps, CNS)',
  symptomatic: 'Symptomatic event (log: T2+ check-in or first aid)',
}

export function targetLabel(id: string): string {
  return DETECTION_TARGET_LABELS[id] ?? id.replace(/_/g, ' ')
}

export const MODEL_LABELS: Readonly<Record<string, string>> = {
  ecmwf_ifs025: 'ECMWF IFS 0.25°',
  dwd_icon_seamless: 'DWD ICON',
  ncep_gfs_seamless: 'NCEP GFS',
  ecmwf_ifs: 'ECMWF IFS 9 km',
  era5: 'ERA5 reanalysis',
}

export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id
}

export const AIRPORT_LABELS: Readonly<Record<string, string>> = {
  OMAA: 'OMAA Abu Dhabi Intl (≈ Musaffah, KEZAD)',
  OMAD: 'OMAD Al Bateen (≈ Saadiyat)',
  OMAL: 'OMAL Al Ain Intl (≈ Al Ain)',
}

// ─── Real-weather exposure ──────────────────────────────────────────────────────────────────────────────────────────

export type BandKey = 'wbgtBands' | 'adoshSun'

/** Stacked-bar row: one category with one numeric field per band (b0 … bN−1) and the row total. */
export type StackRow = { key: string; label: string; total: number } & Record<`b${number}`, number>

function stackRow(key: string, label: string, values: readonly number[]): StackRow {
  const row = { key, label, total: 0 } as StackRow
  values.forEach((v, i) => {
    row[`b${i}`] = v
    row.total += v
  })
  return row
}

/**
 * Mean hours per season in each band for the five sites of one weather run. ADOSH zones are stored high → low in the
 * file; `lowFirst` reverses them so a stack always runs from the least to the most severe band.
 */
export function bandRowsBySite(sites: readonly HoursSite[], key: BandKey, run = 'ifs'): StackRow[] {
  return SITE_IDS.flatMap((id) => {
    const s = sites.find((x) => x.site === id && x.run === run)
    if (!s) return []
    const values = key === 'adoshSun' ? [...s.meanSeason.adoshSun].reverse() : s.meanSeason.wbgtBands
    return [stackRow(id, siteLabel(id), values)]
  })
}

/** Hours per season in each band at each local clock hour (05:00–20:00 by default) for one site. */
export function bandRowsByHour(rows: readonly HoursByHour[], site: string, key: BandKey, from = 5, to = 20): StackRow[] {
  return rows
    .filter((r) => r.site === site && r.hour >= from && r.hour <= to)
    .sort((a, b) => a.hour - b.hour)
    .map((r) => stackRow(String(r.hour), String(r.hour).padStart(2, '0'), key === 'adoshSun' ? [...r.adoshSun].reverse() : r.wbgtBands))
}

/** Hours per season in each band by calendar month for one site. */
export function bandRowsByMonth(rows: readonly HoursByMonth[], site: string, key: BandKey): StackRow[] {
  return rows
    .filter((r) => r.site === site)
    .sort((a, b) => a.month - b.month)
    .map((r) => stackRow(String(r.month), MONTH_LABELS[r.month]?.slice(0, 3) ?? String(r.month), key === 'adoshSun' ? [...r.adoshSun].reverse() : r.wbgtBands))
}

export interface WorkRestPair {
  id: string
  label: string
  work: WorkRestRow['work']
  limit: WorkRestRow['limit']
  shade: number | null
  cabin: number | null
  shadeZeroShare: number | null
  cabinZeroShare: number | null
  /** [shade, cabin] for a range bar (the dumbbell's connector). */
  range: [number, number]
}

const WORK_LIMIT_ORDER: readonly { work: WorkRestRow['work']; limit: WorkRestRow['limit']; label: string }[] = [
  { work: 'moderate', limit: 'REL', label: 'Moderate work, acclimatised (REL)' },
  { work: 'heavy', limit: 'REL', label: 'Heavy work, acclimatised (REL)' },
  { work: 'moderate', limit: 'RAL', label: 'Moderate work, unacclimatised (RAL)' },
  { work: 'heavy', limit: 'RAL', label: 'Heavy work, unacclimatised (RAL)' },
]

export const WORK_LIMIT_OPTIONS = WORK_LIMIT_ORDER.map((o) => ({ id: `${o.work}_${o.limit}`, label: o.label }))

/** Shade-versus-cabin pairs of allowed work minutes per hour (day shift) for one site and month (0 = season). */
export function workRestPairs(rows: readonly WorkRestRow[], site: string, month: number): WorkRestPair[] {
  const pick = (work: string, limit: string, rest: string) =>
    rows.find((r) => r.site === site && r.month === month && r.work === work && r.limit === limit && r.rest === rest)
  return WORK_LIMIT_ORDER.map(({ work, limit, label }) => {
    const shade = pick(work, limit, 'shade')
    const cabin = pick(work, limit, 'cabin')
    const s = shade?.meanMinPerHour ?? null
    const c = cabin?.meanMinPerHour ?? null
    return {
      id: `${work}_${limit}`,
      label,
      work,
      limit,
      shade: s,
      cabin: c,
      shadeZeroShare: shade?.zeroShare ?? null,
      cabinZeroShare: cabin?.zeroShare ?? null,
      range: [Math.min(s ?? 0, c ?? 0), Math.max(s ?? 0, c ?? 0)],
    }
  })
}

/** Allowed work minutes per hour by local hour for one work/limit combination (all sites), cabin and shade. */
export function workRestByHour(rows: readonly WorkRestRow[], workLimitId: string): { hour: number; label: string; cabin: number | null; shade: number | null }[] {
  const [work, limit] = workLimitId.split('_')
  const hours = [...new Set(rows.map((r) => r.hour).filter((h): h is number => typeof h === 'number'))].sort((a, b) => a - b)
  return hours.map((hour) => {
    const at = (rest: string) =>
      rows.find((r) => r.hour === hour && r.work === work && r.limit === limit && r.rest === rest)?.meanMinPerHour ?? null
    return { hour, label: String(hour).padStart(2, '0'), cabin: at('cabin'), shade: at('shade') }
  })
}

// ─── Forecast skill ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LeadSeriesRow {
  lead: number
  label: string
  /** RMSE per model id, plus `persistence` for the primary model's same-lag persistence. */
  [series: string]: number | string | null | [number, number]
}

/** RMSE by lead day for every model plus the primary model's persistence baseline (24·N h), for WBGT or TWL. */
export function rmseByLead(file: ForecastFile, variable: 'wbgt' | 'twl'): LeadSeriesRow[] {
  const leads = [...new Set(file.sameModel.flatMap((m) => m.leads.map((l) => l.lead)))].sort((a, b) => a - b)
  const primary = file.sameModel.find((m) => m.primary) ?? file.sameModel[0]
  return leads.map((lead, i) => {
    const row: LeadSeriesRow = { lead, label: `Day ${lead}` }
    for (const m of file.sameModel) {
      const l = m.leads.find((x) => x.lead === lead)
      row[m.model] = l ? l[variable].rmse : null
      const c = l?.[variable].rmseCi95
      if (m === primary && l && c) row.primaryErr = [l[variable].rmse - c[0], c[1] - l[variable].rmse]
    }
    const p = primary?.persistence.find((x) => x.lagH === 24 * lead) ?? primary?.persistence[i]
    row.persistence = p ? p[variable].rmse : null
    return row
  })
}

// ─── Simulated cohort ───────────────────────────────────────────────────────────────────────────────────────────────

export interface TradeoffPoint {
  arm: ArmId
  label: string
  kind: ArmMeta['kind']
  work: number
  workCi: [number, number] | null
  excessive: number
  excessiveCi: [number, number] | null
  /** Zero events: the interval is the one-sided rule-of-three bound [0, u]. */
  zero: boolean
  /** Error-bar offsets [below, above] for recharts ErrorBar. */
  errWork: [number, number]
  errExcessive: [number, number]
}

/** Offsets of an interval from its point estimate, clamped at zero ([value − lo, hi − value]). */
export function errorOffsets(value: number, interval: readonly number[] | null | undefined): [number, number] {
  if (!interval || interval.length < 2) return [0, 0]
  return [Math.max(0, value - interval[0]), Math.max(0, interval[1] - value)]
}

function interval(e: Est | undefined): [number, number] | null {
  return e?.ci95 && e.ci95.length >= 2 ? [e.ci95[0], e.ci95[1]] : null
}

/**
 * Work delivered against excessive-strain worker-shifts per arm, with 95 % intervals. A zero count takes its rule-of-
 * three bound as the interval, so a Zill arm is drawn as "0, at most u", never as a certain zero.
 */
export function tradeoffPoints(arms: readonly CohortArm[], ids: readonly ArmId[]): TradeoffPoint[] {
  return ids.flatMap((id) => {
    const a = findArm(arms, id)
    const work = a?.rates.perShift.workMin
    const exc = a?.rates.per1000.excessive
    if (!a || !work || !exc || typeof work.value !== 'number' || typeof exc.value !== 'number') return []
    const zero = exc.count === 0 && typeof exc.upper95 === 'number'
    const excessiveCi: [number, number] | null = zero ? [0, exc.upper95 as number] : interval(exc)
    const workCi = interval(work)
    return [
      {
        arm: id,
        label: ARM_META[id].label,
        kind: ARM_META[id].kind,
        work: work.value,
        workCi,
        excessive: exc.value,
        excessiveCi,
        zero,
        errWork: errorOffsets(work.value, workCi),
        errExcessive: errorOffsets(exc.value, excessiveCi),
      },
    ]
  })
}

// ─── Version history (v0.1 → v0.2 → v0.3) ───────────────────────────────────────────────────────────────────────────

export interface VersionRowDef {
  id: string
  /** `baseline` rows have no Zill in them: a change between versions comes from the simulated world. */
  group: 'zill' | 'baseline'
  arm: ArmId
  label: string
  precision: number
  format?: 'number' | 'percent' | 'signed' | 'signedPercent'
  read: (arm: CohortArm) => number | null | undefined
}

export interface VersionRow {
  id: string
  group: VersionRowDef['group']
  arm: ArmId
  label: string
  precision: number
  format: NonNullable<VersionRowDef['format']>
  values: (number | null)[]
  /** Per version: a baseline row whose value changed from the previous version (driven by the simulated world). */
  worldChanged: boolean[]
}

const v = (e: Est | undefined | null) => (e && typeof e.value === 'number' ? e.value : null)

export const VERSION_ROWS: readonly VersionRowDef[] = [
  { id: 'zf.work', group: 'zill', arm: 'zill_full', label: 'Work delivered, min per worker-shift', precision: 1, read: (a) => v(a.rates.perShift.workMin) },
  { id: 'zf.workRel', group: 'zill', arm: 'zill_full', label: 'Work vs midday ban only (paired)', precision: 1, format: 'signedPercent', read: (a) => v(a.vsBanOnly?.workRelative) },
  { id: 'zf.rest', group: 'zill', arm: 'zill_full', label: 'Protective rest, min per worker-shift', precision: 1, read: (a) => v(a.rates.perShift.restMin) },
  { id: 'zf.water', group: 'zill', arm: 'zill_full', label: 'Water drunk, L per worker-shift', precision: 2, read: (a) => { const w = v(a.rates.perShift.waterMl); return w === null ? null : w / 1000 } },
  { id: 'zf.exc', group: 'zill', arm: 'zill_full', label: 'Excessive strain per 1,000 worker-shifts', precision: 1, read: (a) => v(a.rates.per1000.excessive) },
  { id: 'zf.dExc', group: 'zill', arm: 'zill_full', label: 'Δ excessive strain vs midday ban only (paired)', precision: 1, format: 'signed', read: (a) => v(a.vsBanOnly?.excessivePer1000) },
  { id: 'zf.dehyd', group: 'zill', arm: 'zill_full', label: 'Dehydration > 3 % per 1,000', precision: 1, read: (a) => v(a.rates.per1000.dehydration) },
  { id: 'zf.symp', group: 'zill', arm: 'zill_full', label: 'Heat-symptom episodes per 1,000', precision: 1, read: (a) => v(a.rates.per1000.symptomaticEpisodes) },
  { id: 'zf.evac', group: 'zill', arm: 'zill_full', label: 'First-aid evacuations per 1,000', precision: 1, read: (a) => v(a.rates.per1000.evacuations) },
  { id: 'zf.alarms', group: 'zill', arm: 'zill_full', label: 'Every alert ≥ HIGH covering the worker, per worker-shift', precision: 2, read: (a) => v(a.challenge?.alarmsPerShift) },
  { id: 'zf.ind', group: 'zill', arm: 'zill_full', label: 'Individual alarms ≥ HIGH per worker-shift', precision: 2, read: (a) => v(a.challenge?.individualAlarmsPerShift?.high) },
  { id: 'zf.expo', group: 'zill', arm: 'zill_full', label: 'Exposure advisories ≥ HIGH per worker-shift', precision: 2, read: (a) => v(a.challenge?.exposureAdvisoriesPerWorkerShift) },
  { id: 'zf.supp', group: 'zill', arm: 'zill_full', label: 'Suppressed advisories per worker-shift (logged, not sent)', precision: 2, read: (a) => v(a.challenge?.suppressedAdvisoriesPerWorkerShift) },
  { id: 'zf.zone', group: 'zill', arm: 'zill_full', label: 'ADOSH zone compliance (worker-hours)', precision: 1, format: 'percent', read: (a) => v(a.challenge?.zone?.compliantShare) },
  { id: 'zf.unacc', group: 'zill', arm: 'zill_full', label: 'Unacclimatised worker-hours in excluding zones', precision: 0, read: (a) => a.challenge?.zone?.unacclimatizedHours ?? null },
  { id: 'zf.adh', group: 'zill', arm: 'zill_full', label: 'Adherence to device instructions', precision: 1, format: 'percent', read: (a) => v(a.challenge?.adherence) },
  { id: 'bo.work', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: work, min per worker-shift', precision: 1, read: (a) => v(a.rates.perShift.workMin) },
  { id: 'bo.water', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: water, L per worker-shift', precision: 2, read: (a) => { const w = v(a.rates.perShift.waterMl); return w === null ? null : w / 1000 } },
  { id: 'bo.exc', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: excessive strain per 1,000', precision: 1, read: (a) => v(a.rates.per1000.excessive) },
  { id: 'bo.sev', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: severe strain per 1,000', precision: 1, read: (a) => v(a.rates.per1000.severe) },
  { id: 'bo.dehyd', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: dehydration > 3 % per 1,000', precision: 1, read: (a) => v(a.rates.per1000.dehydration) },
  { id: 'bo.symp', group: 'baseline', arm: 'ban_only', label: 'Midday ban only: heat-symptom episodes per 1,000', precision: 1, read: (a) => v(a.rates.per1000.symptomaticEpisodes) },
  { id: 'si.work', group: 'baseline', arm: 'site_index', label: 'Site TWL index: work, min per worker-shift', precision: 1, read: (a) => v(a.rates.perShift.workMin) },
  { id: 'si.exc', group: 'baseline', arm: 'site_index', label: 'Site TWL index: excessive strain per 1,000', precision: 1, read: (a) => v(a.rates.per1000.excessive) },
  { id: 'si.zone', group: 'baseline', arm: 'site_index', label: 'Site TWL index: ADOSH zone compliance', precision: 1, format: 'percent', read: (a) => v(a.challenge?.zone?.compliantShare) },
]

/** True when two version values differ at the row's display precision (tiny float noise is not a change). */
export function valuesDiffer(a: number | null, b: number | null, precision: number): boolean {
  if (a === null || b === null) return false
  const f = 10 ** (precision + 1)
  return Math.round(a * f) !== Math.round(b * f)
}

/**
 * The before/after table across cohort versions. A baseline arm contains no Zill, so any change in a baseline row
 * between consecutive versions is flagged as driven by the simulated world (world simulation, ground-truth model or
 * metric definitions), not by Zill; scripts/validate/compare-cohorts.ts applies the same rule.
 */
export function versionRows(reports: readonly (CohortFile | null | undefined)[], defs: readonly VersionRowDef[] = VERSION_ROWS): VersionRow[] {
  return defs.map((def) => {
    const values = reports.map((r) => {
      const arm = r ? findArm(r.main.arms, def.arm) : undefined
      const value = arm ? def.read(arm) : null
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    })
    const worldChanged = values.map(
      (value, i) => def.group === 'baseline' && i > 0 && valuesDiffer(values[i - 1], value, def.precision),
    )
    return { id: def.id, group: def.group, arm: def.arm, label: def.label, precision: def.precision, format: def.format ?? 'number', values, worldChanged }
  })
}
