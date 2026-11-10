/**
 * Hourly heat indices from cached weather series, through the engine's own pipeline (indices.ts computeSiteHeat:
 * Liljegren WBGT in sun and engineered shade, TWL in sun and shade, NWS heat index). Nothing here re-implements a model.
 *
 * Radiant boost: by default the scripts evaluate the meteorological exposure with NO site radiant allowance
 * (`radiantBoostC: 0` on the sample), which is what the research previews computed (data_and_validation.md §6.5) and
 * what a weather-only regulator view shows. The site allowance (sites.ts radiantBoostC, [ENG]) is a sensitivity run.
 */
import { computeSiteHeat } from '../../../src/engine/indices'
import { localParts } from '../../../src/engine/time'
import type { EnvSample, Site } from '../../../src/engine/types'

/** Radiant-boost handling for a run. */
export type BoostMode = 'none' | 'site'

/** Column store of hourly heat indices for one location and model. */
export interface HeatColumns {
  n: number
  /** Epoch ms (UTC) of each hour (instantaneous T/RH; radiation averaged over the preceding hour). */
  t: Float64Array
  /** Local (Asia/Dubai) hour of day 0–23. */
  hour: Uint8Array
  /** Local month 1–12. */
  month: Uint8Array
  /** Local calendar day key index (days since the first sample's local day). */
  dayIndex: Uint16Array
  wbgtC: Float64Array
  wbgtShadeC: Float64Array
  twlWm2: Float64Array
  twlShadeWm2: Float64Array
  taC: Float64Array
  rhPct: Float64Array
}

/** Heat indices of one sample. */
export interface HourHeat {
  wbgtC: number
  wbgtShadeC: number
  twlWm2: number
  twlShadeWm2: number
}

/**
 * Engine heat indices of one sample at a site (computeSiteHeat). With `boost = 'none'` the sample's radiant boost is
 * forced to 0; with 'site' the site's configured allowance applies (computeSiteHeat default when the sample has none).
 */
export function hourHeat(sample: EnvSample, site: Site, boost: BoostMode = 'none'): HourHeat {
  const env: EnvSample = boost === 'none' ? { ...sample, radiantBoostC: 0 } : { ...sample, radiantBoostC: undefined }
  const h = computeSiteHeat(env, site)
  return { wbgtC: h.wbgtC, wbgtShadeC: h.wbgtShadeC, twlWm2: h.twlWm2, twlShadeWm2: h.twlShadeWm2 }
}

/** Compute {@link HeatColumns} for an hourly series (samples in time order). */
export function heatColumns(samples: readonly EnvSample[], site: Site, boost: BoostMode = 'none'): HeatColumns {
  const n = samples.length
  const cols: HeatColumns = {
    n,
    t: new Float64Array(n),
    hour: new Uint8Array(n),
    month: new Uint8Array(n),
    dayIndex: new Uint16Array(n),
    wbgtC: new Float64Array(n),
    wbgtShadeC: new Float64Array(n),
    twlWm2: new Float64Array(n),
    twlShadeWm2: new Float64Array(n),
    taC: new Float64Array(n),
    rhPct: new Float64Array(n),
  }
  if (n === 0) return cols
  const first = localParts(samples[0].t)
  const day0 = Date.UTC(first.year, first.month - 1, first.day)
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    const lp = localParts(s.t)
    const h = hourHeat(s, site, boost)
    cols.t[i] = s.t
    cols.hour[i] = lp.hour
    cols.month[i] = lp.month
    cols.dayIndex[i] = Math.round((Date.UTC(lp.year, lp.month - 1, lp.day) - day0) / 86_400_000)
    cols.wbgtC[i] = h.wbgtC
    cols.wbgtShadeC[i] = h.wbgtShadeC
    cols.twlWm2[i] = h.twlWm2
    cols.twlShadeWm2[i] = h.twlShadeWm2
    cols.taC[i] = s.taC
    cols.rhPct[i] = s.rhPct
  }
  return cols
}

/** Index of each sample time, for matching two series on the same UTC hours. */
export function timeIndex(t: ArrayLike<number>): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < t.length; i++) m.set(t[i], i)
  return m
}
