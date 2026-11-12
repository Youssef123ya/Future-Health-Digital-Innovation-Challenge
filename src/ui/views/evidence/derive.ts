/**
 * More view-model mapping for the Evidence view (reference groups, TWL plausibility, forecast events, airports,
 * detection, variants, fairness). Pure functions; every number is read from a validation file, none is computed anew
 * beyond grouping and picking (ARCHITECTURE.md §1 principle 7).
 */
import { toleranceUse } from './format'
import type {
  AirportStats,
  ArmId,
  CohortArm,
  CohortFile,
  CohortVariant,
  DetectionRow,
  Est,
  EventScores,
  FairnessCell,
  ForecastFile,
  HoursFile,
  ReferenceCheck,
  ReferenceFile,
} from './types'

// ─── Reference agreement ────────────────────────────────────────────────────────────────────────────────────────────

/** The metric a check is judged on: the RMS for 'rms' checks, else the largest absolute difference. */
export function comparedDiff(c: ReferenceCheck): number {
  return c.toleranceKind === 'rms' && typeof c.rmsDiff === 'number' ? c.rmsDiff : c.maxAbsDiff
}

export interface ReferenceGroup {
  model: string
  label: string
  checks: readonly ReferenceCheck[]
  passed: number
  total: number
  /** Values compared over all checks of the model. */
  values: number
  pass: boolean
  /** Largest share of its tolerance any check of the model uses (null when none can be computed). */
  worstUse: number | null
  implementations: number
  publishedSets: number
}

/** Checks grouped by model, in the summary's order (models missing from the summary follow in file order). */
export function referenceGroups(file: ReferenceFile): ReferenceGroup[] {
  const summary = file.summary?.models ?? []
  const order = [...new Set([...summary.map((m) => m.model), ...file.checks.map((c) => c.model)])]
  return order.flatMap((model) => {
    const checks = file.checks.filter((c) => c.model === model)
    if (!checks.length) return []
    const meta = summary.find((m) => m.model === model)
    const uses = checks.map((c) => toleranceUse(comparedDiff(c), c.tolerance)).filter((u): u is number => u !== null)
    return [
      {
        model,
        label: meta?.label ?? model,
        checks,
        passed: checks.filter((c) => c.pass).length,
        total: checks.length,
        values: checks.reduce((sum, c) => sum + (c.nValues || 0), 0),
        pass: checks.every((c) => c.pass),
        worstUse: uses.length ? Math.max(...uses) : null,
        implementations: checks.filter((c) => c.kind === 'reference_implementation').length,
        publishedSets: checks.filter((c) => c.kind === 'published_values').length,
      },
    ]
  })
}

// ─── Real-weather exposure: TWL plausibility ────────────────────────────────────────────────────────────────────────

export interface TwlPoint {
  hour: number
  label: string
  sun: number | null
  shade: number | null
  /** Bates & Schneider 2008 field mean at this clock hour (May 2006, UAE construction), when published. */
  field: number | null
}

/** Modelled mean TWL in sun and shade at the field studies' clock hours, beside the published field means. */
export function twlPoints(file: HoursFile, site: string, period: 'jun_sep' | 'june'): TwlPoint[] {
  const row = file.twlPlausibility?.rows.find((r) => r.site === site && r.period === period)
  const published = file.twlPlausibility?.published.batesSchneider2008.byHour ?? {}
  return (row?.byHour ?? []).map((h) => {
    const f = published[String(h.hour)]
    return {
      hour: h.hour,
      label: `${String(h.hour).padStart(2, '0')}:00`,
      sun: h.twlSunMean,
      shade: h.twlShadeMean,
      field: typeof f === 'number' ? f : null,
    }
  })
}

// ─── Forecast skill: events and airports ────────────────────────────────────────────────────────────────────────────

export const EVENT_SHORT: Readonly<Record<string, string>> = {
  adosh_high: 'ADOSH High zone (TWL ≤ 115 W/m²)',
  wbgt_ge_ral115: 'WBGT ≥ RAL(115 W), 30.8 °C',
  wbgt_ge_qatar_stop: 'WBGT ≥ 32.1 °C (Qatar stop value)',
}

export interface EventLeadRow {
  lead: number
  label: string
  forecast: EventScores | null
  persistence: EventScores | null
  csiForecast: number | null
  csiPersistence: number | null
}

/** Event scores of one model by lead day, beside the same-lag persistence of that model (24·N h). */
export function eventRows(file: ForecastFile, modelId: string, eventId: string): EventLeadRow[] {
  const model = file.sameModel.find((m) => m.model === modelId)
  if (!model) return []
  return model.leads.map((l) => {
    const forecast = l.events.find((e) => e.id === eventId)?.scores ?? null
    const p = model.persistence.find((x) => x.lagH === 24 * l.lead)
    const persistence = p?.events.find((e) => e.id === eventId)?.scores ?? null
    return {
      lead: l.lead,
      label: `Day ${l.lead}`,
      forecast,
      persistence,
      csiForecast: forecast?.csi ?? null,
      csiPersistence: persistence?.csi ?? null,
    }
  })
}

export interface AirportRow {
  key: string
  icao: string
  model: string
  kind: 'analysis' | 'forecast'
  n: number
  tBias: number | null
  tdBias: number | null
  wbgtBias: number | null
  wbgtRmse: number | null
  twlBias: number | null
  twlRmse: number | null
}

const pick = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Airport verification rows per airport: the analyses (no lead) first, then every forecast model at one lead day. */
export function airportRows(file: ForecastFile, lead: number): AirportRow[] {
  const map =
    (kind: AirportRow['kind']) =>
    (a: AirportStats): AirportRow => {
      const wbgt = a.wbgt ?? a.wbgtAll
      const twl = a.twl ?? a.twlAll
      return {
        key: `${kind}:${a.icao}:${a.model}:${a.lead ?? 'a'}`,
        icao: a.icao,
        model: a.model,
        kind,
        n: a.n,
        tBias: pick(a.t?.bias),
        tdBias: pick(a.td?.bias),
        wbgtBias: pick(wbgt?.bias),
        wbgtRmse: pick(wbgt?.rmse),
        twlBias: pick(twl?.bias),
        twlRmse: pick(twl?.rmse),
      }
    }
  const analysis = (file.airports?.analysis ?? []).map(map('analysis'))
  const forecast = (file.airports?.forecast ?? []).filter((a) => a.lead === lead).map(map('forecast'))
  const icaos = [...new Set([...analysis, ...forecast].map((r) => r.icao))]
  return icaos.flatMap((icao) => [...analysis.filter((r) => r.icao === icao), ...forecast.filter((r) => r.icao === icao)])
}

// ─── Simulated cohort: detection, variants, fairness ────────────────────────────────────────────────────────────────

export type AlarmLevel = 'high' | 'stop'

/** Shadow-mode detection rows of one arm for individual alarms at ≥ HIGH or ≥ STOP, in the canonical target order. */
export function detectionFor(arm: CohortArm | undefined, level: AlarmLevel): DetectionRow[] {
  const rows = (level === 'stop' ? arm?.detectionStop : arm?.detection) ?? []
  const rank = (t: string) => {
    const i = (TARGET_ORDER as readonly string[]).indexOf(t)
    return i < 0 ? TARGET_ORDER.length : i
  }
  return [...rows].sort((a, b) => rank(a.target) - rank(b.target))
}

export const TARGET_ORDER = ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'heat_symptoms', 'symptomatic'] as const

export interface LeadBinRow {
  key: string
  label: string
  n: number
}

/** Lead-time histogram bins ("0–15", …, "≥ 120" minutes). */
export function leadBins(row: DetectionRow | undefined): LeadBinRow[] {
  return (row?.leadTime.bins ?? []).map((b) => ({
    key: String(b.fromMin),
    label: b.toMin === null ? `≥ ${b.fromMin}` : `${b.fromMin}–${b.toMin}`,
    n: b.n,
  }))
}

export interface VariantRow {
  id: string
  label: string
  group: CohortVariant['group']
  factor: string
  note: string | null
  supported: boolean
  siteDays: number
  workerShifts: number | null
  excessive: Est | null
  workMin: Est | null
  dExcessive: Est | null
  workRelative: Est | null
  banOnlyExcessive: Est | null
  vsBaseExcessive: Est | null
  vsBaseWork: Est | null
}

/** One row per variant for one arm: rates, the paired difference against the midday ban only and against the base case. */
export function variantRows(variants: readonly CohortVariant[], arm: ArmId): VariantRow[] {
  return variants.map((v) => {
    const a = v.arms.find((x) => x.arm === arm)
    const bo = v.arms.find((x) => x.arm === 'ban_only')
    return {
      id: v.id,
      label: v.label,
      group: v.group,
      factor: v.factor,
      note: v.note,
      supported: v.supported,
      siteDays: v.siteDays,
      workerShifts: a?.headline.workerShifts ?? null,
      excessive: a?.headline.excessivePer1000 ?? null,
      workMin: a?.headline.workMinPerShift ?? null,
      dExcessive: a?.vsBanOnly?.excessivePer1000 ?? null,
      workRelative: a?.vsBanOnly?.workRelative ?? null,
      banOnlyExcessive: bo?.headline.excessivePer1000 ?? null,
      vsBaseExcessive: a?.vsBase?.excessivePer1000 ?? null,
      vsBaseWork: a?.vsBase?.workMinPerShift ?? null,
    }
  })
}

/**
 * A zero-based value axis with clean ticks (steps of 1, 2, 2.5 or 5 × 10ⁿ) covering `max`, about `count` intervals.
 * Non-positive or missing maxima give a 0–1 axis.
 */
export function niceAxis(max: number | null | undefined, count = 5): { max: number; ticks: number[] } {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toFixed(10)))
  return { max: ticks[ticks.length - 1], ticks }
}

/** [min, max] of the present values; null when none is present. */
export function valueRange(values: readonly (number | null | undefined)[]): [number, number] | null {
  const xs = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : null
}

export const FAIRNESS_DIMENSIONS: readonly { id: string; label: string }[] = [
  { id: 'acclimatization', label: 'Acclimatisation' },
  { id: 'ageBand', label: 'Age band' },
  { id: 'bmiBand', label: 'BMI band' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'language', label: 'App language' },
  { id: 'wearable', label: 'Wearable' },
]

const FAIRNESS_VALUES: Readonly<Record<string, string>> = {
  acclimatized: 'Acclimatised',
  acclimatizing: 'Acclimatising',
  unacclimatized: 'Not acclimatised',
  work_clothes: 'Work clothes',
  coveralls: 'Cloth coveralls',
  cloth_coveralls: 'Cloth coveralls',
  fr_coveralls: 'FR coveralls',
  '<30': 'Under 30',
  '45+': '45 and over',
  '<25': 'Under 25',
  '30+': '30 and over',
  vapour_barrier: 'Vapour barrier',
  yes: 'Wearable',
  no: 'No wearable',
  true: 'Wearable',
  false: 'No wearable',
  en: 'English',
  ar: 'Arabic',
  hi: 'Hindi',
  ur: 'Urdu',
  bn: 'Bengali',
  ml: 'Malayalam',
  ne: 'Nepali',
  ta: 'Tamil',
  tl: 'Filipino',
  fil: 'Filipino',
}

export function fairnessValueLabel(value: string): string {
  return FAIRNESS_VALUES[value] ?? value.replace(/_/g, ' ').replace(/^(\d+)-(\d+)$/, '$1–$2')
}

/** Fewer worker-shifts than this in a group: rates are shown but flagged as too few to compare. [ENG] reading aid. */
export const SMALL_GROUP_SHIFTS = 30

/** Fairness cells of one arm and dimension, in file order. */
export function fairnessCells(file: CohortFile, arm: ArmId, dimension: string): readonly FairnessCell[] {
  return file.main.fairness.find((f) => f.arm === arm)?.cells.filter((c) => c.dimension === dimension) ?? []
}
