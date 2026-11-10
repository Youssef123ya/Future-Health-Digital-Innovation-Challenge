/**
 * Preview numbers transcribed from docs/research/data_and_validation.md (§6.1, §6.3, §6.4, §6.5, §10 A.5) and the UAE
 * TWL field means from docs/research/twl_and_regulation.md §5, used ONLY as comparison columns. The previews were
 * computed in Python (thermofeel 2.3.0, radiation "configuration A": instant SSRD, instant cos z, fdir = DIR/GHI); the
 * engine uses "configuration B" (hour-mean GHI, cos z at t − 30 min, Liljegren fdir with the 0.85 cap). §6.5 measured
 * the effect of that choice: seasonal counts change by < 1 %, single hours by up to 2.7 °C (low sun).
 */

/** §6.5 hours-in-zone preview (mean per Jun–Sep season, 2020–2025; illustrative cut points 28/30/32/33 °C). */
export interface HoursPreviewRow {
  site: string
  model: 'era5' | 'ecmwf_ifs'
  p50: number
  p95: number
  max: number
  ge28: number
  ge30: number
  ge32: number
  ge33: number
  ge30OutsideBreak: number
}

export const HOURS_PREVIEW_SOURCE = 'docs/research/data_and_validation.md §6.5 (thermofeel 2.3.0, config A)'

export const HOURS_PREVIEW: readonly HoursPreviewRow[] = [
  { site: 'musaffah', model: 'era5', p50: 30.3, p95: 35.2, max: 39.9, ge28: 2397, ge30: 1621, ge32: 870, ge33: 595, ge30OutsideBreak: 1436 },
  { site: 'musaffah', model: 'ecmwf_ifs', p50: 30.2, p95: 34.5, max: 40.2, ge28: 2370, ge30: 1552, ge32: 736, ge33: 454, ge30OutsideBreak: 1368 },
  { site: 'kezad', model: 'era5', p50: 30.7, p95: 34.9, max: 39.6, ge28: 2598, ge30: 1804, ge32: 904, ge33: 590, ge30OutsideBreak: 1618 },
  { site: 'kezad', model: 'ecmwf_ifs', p50: 30.2, p95: 34.3, max: 38.6, ge28: 2313, ge30: 1561, ge32: 768, ge33: 453, ge30OutsideBreak: 1376 },
  { site: 'ruwais', model: 'era5', p50: 29.9, p95: 34.5, max: 39.5, ge28: 2188, ge30: 1425, ge32: 685, ge33: 431, ge30OutsideBreak: 1243 },
  { site: 'ruwais', model: 'ecmwf_ifs', p50: 29.8, p95: 34.4, max: 38.7, ge28: 2132, ge30: 1398, ge32: 638, ge33: 381, ge30OutsideBreak: 1218 },
  { site: 'alain', model: 'era5', p50: 28.3, p95: 33.9, max: 39.5, ge28: 1556, ge30: 987, ge32: 489, ge33: 278, ge30OutsideBreak: 808 },
  { site: 'alain', model: 'ecmwf_ifs', p50: 27.7, p95: 33.1, max: 38.7, ge28: 1374, ge30: 818, ge32: 336, ge33: 164, ge30OutsideBreak: 644 },
  { site: 'saadiyat', model: 'era5', p50: 30.7, p95: 35.0, max: 39.5, ge28: 2605, ge30: 1839, ge32: 911, ge33: 610, ge30OutsideBreak: 1653 },
  { site: 'saadiyat', model: 'ecmwf_ifs', p50: 30.6, p95: 34.4, max: 38.5, ge28: 2561, ge30: 1768, ge32: 829, ge33: 492, ge30OutsideBreak: 1584 },
]

/** §10 A.5: IFS hours with WBGT ≥ 30 °C per season 2020–2025. */
export const HOURS_GE30_BY_YEAR_PREVIEW: Readonly<Record<string, readonly number[]>> = {
  musaffah: [1595, 1598, 1330, 1705, 1643, 1442],
  kezad: [1597, 1552, 1327, 1688, 1693, 1509],
  ruwais: [1350, 1424, 1286, 1462, 1544, 1320],
  alain: [785, 786, 734, 827, 861, 912],
  saadiyat: [1764, 1809, 1511, 1943, 1907, 1677],
}

/** §6.4 same-model WBGT skill preview (5 sites × summers 2024–2025, ≈ 29,280 h per lead). */
export const SAME_MODEL_PREVIEW = {
  source: 'docs/research/data_and_validation.md §6.4 (same-model skill table)',
  ecmwf_ifs025: [
    { lead: 1, bias: -0.05, mae: 0.57, rmse: 0.82, dailyMaxRmse: 1.05, ge30: { pod: 0.93, far: 0.07, csi: 0.87 }, ge32: { pod: 0.9, far: 0.1, csi: 0.82 } },
    { lead: 2, bias: -0.02, mae: 0.73, rmse: 1.01, dailyMaxRmse: 1.22, ge30: { pod: 0.93, far: 0.09, csi: 0.85 }, ge32: { pod: 0.89, far: 0.13, csi: 0.78 } },
    { lead: 3, bias: 0.01, mae: 0.87, rmse: 1.2, dailyMaxRmse: 1.33, ge30: { pod: 0.91, far: 0.11, csi: 0.82 }, ge32: { pod: 0.87, far: 0.17, csi: 0.74 } },
  ],
  persistence24h: { bias: -0.01, mae: 1.25, rmse: 1.7 },
  dwd_icon_seamless: { rmse: [0.83, 1.02, 1.14], dailyMaxRmse: [0.97, 1.21, 1.28] },
  ncep_gfs_seamless: { rmse: [0.78, 1.0, 1.1], dailyMaxRmse: [1.02, 1.24, 1.3] },
} as const

/** [bias, RMSE] pairs for d0, d1, d2, d3. */
type LeadPairs = readonly (readonly [number, number])[]

/** §6.4 airport forecast table (bias / RMSE vs METAR, d0 → d3; WBGT reference = obs-met with IFS 9 km radiation). */
export const AIRPORT_FORECAST_PREVIEW: Readonly<Record<string, Readonly<Record<string, { t: LeadPairs; td: LeadPairs; wbgt: LeadPairs }>>>> = {
  OMAA: {
    ecmwf_ifs025: {
      t: [[-0.35, 1.54], [-0.6, 1.83], [-0.68, 1.97], [-0.75, 2.13]],
      td: [[-0.15, 2.57], [-0.17, 3.02], [-0.14, 3.33], [0.0, 3.73]],
      wbgt: [[-0.01, 1.05], [-0.1, 1.26], [-0.1, 1.36], [-0.05, 1.44]],
    },
    dwd_icon_seamless: {
      t: [[-0.1, 1.09], [-0.19, 1.27], [-0.1, 1.29], [0.03, 1.42]],
      td: [[1.9, 3.52], [2.34, 4.14], [2.31, 4.21], [2.08, 4.28]],
      wbgt: [[1.01, 1.57], [1.17, 1.79], [1.19, 1.85], [1.13, 1.85]],
    },
    ncep_gfs_seamless: {
      t: [[-0.69, 2.13], [-0.77, 2.29], [-0.52, 2.3], [-0.35, 2.35]],
      td: [[-2.35, 3.91], [-3.14, 4.79], [-3.72, 5.47], [-4.03, 5.98]],
      wbgt: [[-1.29, 1.89], [-1.64, 2.26], [-1.75, 2.44], [-1.79, 2.56]],
    },
  },
  OMAD: {
    ecmwf_ifs025: {
      t: [[-1.14, 1.66], [-1.15, 1.82], [-1.25, 1.95], [-1.28, 2.06]],
      td: [[0.26, 2.25], [0.14, 2.59], [0.29, 2.84], [0.38, 3.21]],
      wbgt: [[-0.29, 1.05], [-0.33, 1.19], [-0.28, 1.27], [-0.24, 1.35]],
    },
    dwd_icon_seamless: {
      t: [[-0.64, 1.33], [-0.71, 1.48], [-0.6, 1.48], [-0.47, 1.53]],
      td: [[1.16, 2.93], [1.54, 3.41], [1.52, 3.44], [1.36, 3.52]],
      wbgt: [[0.25, 1.22], [0.4, 1.36], [0.42, 1.38], [0.41, 1.43]],
    },
    ncep_gfs_seamless: {
      t: [[-0.49, 1.88], [-0.56, 2.04], [-0.32, 2.12], [-0.14, 2.19]],
      td: [[-4.09, 5.22], [-4.87, 6.11], [-5.39, 6.75], [-5.7, 7.2]],
      wbgt: [[-2.08, 2.46], [-2.43, 2.86], [-2.52, 3.01], [-2.55, 3.12]],
    },
  },
  OMAL: {
    ecmwf_ifs025: {
      t: [[-0.73, 1.39], [-0.95, 1.71], [-0.96, 1.81], [-0.98, 1.94]],
      td: [[-0.44, 2.92], [-0.47, 3.48], [-0.66, 3.88], [-0.54, 4.14]],
      wbgt: [[-0.35, 1.16], [-0.46, 1.31], [-0.49, 1.44], [-0.48, 1.54]],
    },
    dwd_icon_seamless: {
      t: [[0.03, 1.13], [-0.01, 1.41], [0.07, 1.49], [0.14, 1.53]],
      td: [[1.17, 3.39], [1.52, 4.27], [1.43, 4.44], [1.17, 4.54]],
      wbgt: [[0.57, 1.35], [0.74, 1.58], [0.73, 1.66], [0.67, 1.69]],
    },
    ncep_gfs_seamless: {
      t: [[-0.55, 2.14], [-0.69, 2.31], [-0.53, 2.32], [-0.33, 2.33]],
      td: [[-2.55, 4.19], [-3.08, 4.89], [-3.66, 5.47], [-3.91, 5.87]],
      wbgt: [[-1.12, 1.78], [-1.34, 2.01], [-1.46, 2.15], [-1.45, 2.21]],
    },
  },
}

/** §6.1 (T, Td, wind) and §6.3 (WBGT) analysis-vs-METAR preview, summer 2025: [bias, RMSE] pairs. */
export interface AnalysisPreviewRow {
  icao: 'OMAA' | 'OMAD' | 'OMAL'
  model: 'era5' | 'ecmwf_ifs'
  t: readonly [number, number]
  td: readonly [number, number]
  wind: readonly [number, number]
  wbgtAll: readonly [number, number]
  wbgtDay: readonly [number, number]
  wbgtTTdOnly: readonly [number, number]
}

export const ANALYSIS_PREVIEW: readonly AnalysisPreviewRow[] = [
  { icao: 'OMAA', model: 'era5', t: [0.13, 1.25], td: [0.86, 2.87], wind: [-0.53, 1.44], wbgtAll: [0.51, 1.17], wbgtDay: [0.75, 1.31], wbgtTTdOnly: [0.38, 1.01] },
  { icao: 'OMAA', model: 'ecmwf_ifs', t: [-0.4, 1.83], td: [-0.16, 2.85], wind: [-1.16, 1.65], wbgtAll: [-0.01, 1.08], wbgtDay: [0.44, 1.13], wbgtTTdOnly: [-0.23, 0.95] },
  { icao: 'OMAD', model: 'era5', t: [-0.5, 1.2], td: [0.58, 2.6], wind: [0.72, 1.39], wbgtAll: [-0.1, 0.95], wbgtDay: [-0.12, 1.04], wbgtTTdOnly: [-0.04, 0.86] },
  { icao: 'OMAD', model: 'ecmwf_ifs', t: [-0.59, 1.68], td: [-0.41, 2.5], wind: [-0.58, 1.15], wbgtAll: [-0.33, 1.06], wbgtDay: [0.05, 1.02], wbgtTTdOnly: [-0.46, 0.99] },
  { icao: 'OMAL', model: 'era5', t: [-0.83, 1.47], td: [1.41, 3.83], wind: [-0.49, 1.45], wbgtAll: [0.13, 1.2], wbgtDay: [0.34, 1.23], wbgtTTdOnly: [0.04, 1.09] },
  { icao: 'OMAL', model: 'ecmwf_ifs', t: [-0.63, 1.43], td: [-0.63, 2.97], wind: [-0.66, 1.47], wbgtAll: [-0.41, 1.17], wbgtDay: [-0.17, 1.1], wbgtTTdOnly: [-0.52, 1.12] },
]

export const AIRPORT_PREVIEW_SOURCE = 'docs/research/data_and_validation.md §6.1, §6.3 and §6.4 (thermofeel 2.3.0, config A; n = 2,927 h)'

/**
 * Published UAE field TWL (W/m²) by local time of day, for the plausibility comparison
 * (docs/research/twl_and_regulation.md §5).
 */
export const UAE_FIELD_TWL = {
  batesSchneider2008: {
    citation: 'Bates & Schneider 2008, J Occup Med Toxicol 3:21 — UAE construction, May 2006, 22 workers (Calor HSM)',
    month: 'May 2006',
    byHour: { 8: 237.7, 12: 194.8, 14: 189.3, 16: 230.6 } as Readonly<Record<number, number>>,
    lowest: 120,
  },
  miller2011: {
    citation: 'Miller, Bates, Schneider, Thomsen 2011, Ann Occup Hyg 55(5):548–555 — 150 workers, Abu Dhabi and Dubai, summers 2007–2008',
    meanBandWm2: [140, 200] as const,
    note: 'mean TWL at each time of day "all fell between 140 and 200 W m⁻²", with days below 140 and occasionally below 115',
  },
} as const
