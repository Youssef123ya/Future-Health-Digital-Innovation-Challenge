/**
 * Evidence headline for the overview: the few numbers a reviewer needs first, read defensively from the validation
 * outputs in public/data/validation (written by scripts/validate): hours-in-zone.json (real weather, IFS analysis),
 * forecast-skill.json (archived forecasts), reference.json (reference implementations) and cohort.json (simulated
 * cohort). Pure parsing (unit-tested with fixtures); a file with an unexpected shape yields null and the section says the
 * evidence is unavailable instead of showing a wrong number.
 */

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Json | null => (isObj(v) ? v : null)
const pair = (v: unknown): [number, number] | null => {
  if (!Array.isArray(v) || v.length !== 2) return null
  const a = num(v[0])
  const b = num(v[1])
  return a === null || b === null ? null : [a, b]
}

/** Real-weather exposure headline (hours-in-zone.json `headline`). */
export interface HoursHeadline {
  /** Share of the hours at WBGT ≥ RAL(115 W) ≈ 30.8 °C that fall outside the midday-break window. */
  shareHighHeatOutsideBreak: number
  /** Share of the ADOSH High-zone hours (TWL ≤ 115 W/m², sun) outside the midday-break window. */
  shareAdoshHighOutsideBreak: number
  /** Mean hours per season at WBGT ≥ RAL(115 W), mean over the five sites. */
  hoursAtOrAboveRal: number
  hoursPerSeason: number
  /** Allowed work, moderate work under the REL, rest in a cooled cabin vs in shade (min/h, 07–17 h). */
  moderateRelCabinMinPerHour: number
  moderateRelShadeMinPerHour: number
  /** WBGT of the cooled rest area assumed, °C. */
  cooledRestWbgtC: number | null
}

export function parseHoursHeadline(json: unknown): HoursHeadline | null {
  const h = obj(obj(json)?.headline)
  if (!h) return null
  const out = {
    shareHighHeatOutsideBreak: num(h.shareWbgtGeRal115OutsideMiddayBreak),
    shareAdoshHighOutsideBreak: num(h.shareAdoshHighOutsideMiddayBreak),
    hoursAtOrAboveRal: num(h.meanSiteHoursGeRal115PerSeason),
    hoursPerSeason: num(h.hoursPerSeason),
    moderateRelCabinMinPerHour: num(h.dayShiftModerateRelCabinMinPerHour),
    moderateRelShadeMinPerHour: num(h.dayShiftModerateRelShadeMinPerHour),
  }
  if (Object.values(out).some((v) => v === null)) return null
  return { ...(out as { [K in keyof typeof out]: number }), cooledRestWbgtC: num(h.cooledRestWbgtC) }
}

/** Archived-forecast skill headline (forecast-skill.json `headline`), lead day 1 of the primary model. */
export interface ForecastHeadline {
  model: string
  /** RMSE of next-day hourly WBGT (°C) against the model's own short-range run. */
  wbgtRmseD1: number
  /** RMSE of a 24-hour persistence forecast (°C), the no-skill reference. */
  persistenceRmse: number
  /** RMSE of next-day TWL (W/m²). */
  twlRmseD1: number | null
}

export function parseForecastHeadline(json: unknown): ForecastHeadline | null {
  const h = obj(obj(json)?.headline)
  if (!h) return null
  const wbgt = num(h.wbgtRmseD1)
  const persistence = num(h.persistence24hWbgtRmse)
  if (wbgt === null || persistence === null) return null
  return { model: typeof h.primaryModel === 'string' ? h.primaryModel : 'ecmwf_ifs025', wbgtRmseD1: wbgt, persistenceRmse: persistence, twlRmseD1: num(h.twlRmseD1) }
}

/** Reference agreement summary (reference.json `summary`). */
export interface ReferenceHeadline {
  checks: number
  passed: number
  models: number
}

export function parseReferenceSummary(json: unknown): ReferenceHeadline | null {
  const s = obj(obj(json)?.summary)
  if (!s) return null
  const checks = num(s.checks)
  const passed = num(s.passed)
  if (checks === null || passed === null) return null
  return { checks, passed, models: Array.isArray(s.models) ? s.models.length : 0 }
}

/** Arms shown on the overview: both Zill plan bases against the two baselines. */
export const OVERVIEW_ARMS = ['ban_only', 'site_index', 'zill_full', 'zill_monitored'] as const
export type OverviewArm = (typeof OVERVIEW_ARMS)[number]

export const ARM_LABELS: Readonly<Record<OverviewArm, string>> = {
  ban_only: 'Midday ban only',
  site_index: 'ADOSH TWL zones (site index)',
  zill_full: 'Zill · standard limits',
  zill_monitored: 'Zill · monitored mode',
}

/** One cohort arm as charted on the overview. */
export interface CohortArmRow {
  arm: OverviewArm
  label: string
  zill: boolean
  workerShifts: number
  /** Worker-shifts with ≥ 1 excessive-strain event in the simulated ground truth, per 1,000. */
  excessivePer1000: number
  excessiveCi: [number, number] | null
  /** One-sided 95 % rule-of-three bound when the count is zero (3/n × 1,000). */
  excessiveUpper95: number | null
  excessiveCount: number
  /** Work minutes per worker-shift. */
  workMin: number
  workCi: [number, number] | null
}

export interface CohortHeadline {
  arms: CohortArmRow[]
  siteDays: number | null
  sites: number | null
  /** Relative change in work minutes, Zill standard limits vs the midday ban only (e.g. −0.67). */
  workChangeVsBan: number | null
  disclaimer: string | null
}

export function parseCohortHeadline(json: unknown): CohortHeadline | null {
  const root = obj(json)
  const list = obj(root?.main)?.arms
  if (!root || !Array.isArray(list)) return null
  const rows: CohortArmRow[] = []
  for (const arm of OVERVIEW_ARMS) {
    const a = list.map(obj).find((x) => x?.arm === arm && x.shadow !== true)
    const rates = obj(a?.rates)
    const exc = obj(obj(rates?.per1000)?.excessive)
    const work = obj(obj(rates?.perShift)?.workMin)
    const shifts = num(rates?.workerShifts)
    const excValue = num(exc?.value)
    const workValue = num(work?.value)
    if (shifts === null || excValue === null || workValue === null) return null
    rows.push({
      arm,
      label: ARM_LABELS[arm],
      zill: arm.startsWith('zill'),
      workerShifts: shifts,
      excessivePer1000: excValue,
      excessiveCi: pair(exc?.ci95),
      excessiveUpper95: num(exc?.upper95),
      excessiveCount: num(exc?.count) ?? Math.round((excValue * shifts) / 1000),
      workMin: workValue,
      workCi: pair(work?.ci95),
    })
  }
  const ban = rows.find((r) => r.arm === 'ban_only')
  const zill = rows.find((r) => r.arm === 'zill_full')
  const spec = obj(root.spec)
  return {
    arms: rows,
    siteDays: Array.isArray(root.days) ? root.days.length : null,
    sites: Array.isArray(spec?.sites) ? spec.sites.length : null,
    workChangeVsBan: ban && zill && ban.workMin > 0 ? zill.workMin / ban.workMin - 1 : null,
    disclaimer: typeof root.disclaimer === 'string' ? root.disclaimer : null,
  }
}

/** "84 %" from 0.837 (rounded to whole percent by default). */
export function formatShare(share: number, digits = 0): string {
  return `${(share * 100).toFixed(digits)} %`
}

/** Events per 1,000 as charted: "0 (≤ 9)" for a zero count with its rule-of-three bound, else the rounded rate. */
export function formatRate(row: Pick<CohortArmRow, 'excessivePer1000' | 'excessiveUpper95' | 'excessiveCount'>): string {
  if (row.excessiveCount === 0 && row.excessiveUpper95 !== null) return `0 (≤ ${Math.round(row.excessiveUpper95)})`
  return String(Math.round(row.excessivePer1000))
}
