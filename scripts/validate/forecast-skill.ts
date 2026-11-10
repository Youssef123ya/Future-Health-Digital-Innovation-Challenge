/**
 * Forecast skill at lead days 1–3 (evidence class 2 "real-data exposure", docs/SIMULATION.md). Design:
 * docs/research/data_and_validation.md §10 B; previews in §6.4.
 *
 * A. Same-model skill — public/data/weather/previous-runs/{site}_{2024,2025}.json (Open-Meteo Previous Runs, Jun–Sep,
 *    five sites): each model's d1–d3 forecast against the same model's d0 (short-range proxy for the analysis), for WBGT
 *    and TWL in sun computed by the engine (indices.ts computeSiteHeat). Models: ecmwf_ifs025 (primary: the same IFS as
 *    the live forecast, at 0.25°), dwd_icon_seamless and ncep_gfs_seamless (comparison). Scores: bias, MAE, RMSE (with a
 *    day-block bootstrap 95 % interval), daily-max WBGT / daily-min TWL RMSE, POD/FAR/CSI for the ADOSH High zone and
 *    for WBGT ≥ RAL(115 W) ≈ 30.8 °C and ≥ 32.1 °C, zone confusion and dangerous misses, RMSE by local hour, and the
 *    persistence baseline (d0 24/48/72 h earlier) with the MSE skill score. Same-model scores leave out model bias.
 * B. Airport verification — public/data/weather/validation/*.json and public/data/obs/*.json (summer 2025): T, Td, wind
 *    and WBGT/TWL of the archive analyses and of the d0–d3 forecasts against METAR, with the WBGT/TWL reference built
 *    from METAR T/Td/wind and model radiation ("obs-met", §6.3; forecasts use the IFS 9 km archive radiation, §6.4).
 * Output: public/data/validation/forecast-skill.json. Run: `npm run validate` or `npx tsx scripts/validate/forecast-skill.ts`.
 */
import { parsePreviousRunsFile } from '../../src/data/weather'
import type { LeadDay, PreviousRunsModel, WeatherSeries } from '../../src/data/weather'
import { SITES } from '../../src/data/sites'
import type { SiteId } from '../../src/data/sites'
import { dewPointC } from '../../src/engine/psychro'
import { localParts } from '../../src/engine/time'
import type { EnvSample, Site } from '../../src/engine/types'
import { Provenance, codeStamp, isMainModule, timed, writeValidationJson, DATA_ATTRIBUTION } from './lib/io'
import type { CodeStamp, InputFileRecord } from './lib/io'
import { heatColumns, hourHeat, timeIndex } from './lib/heat'
import type { HeatColumns } from './lib/heat'
import { ADOSH_ZONES, WBGT_BANDS, WBGT_THRESHOLDS, adoshZoneIndex, wbgtBandIndex } from './lib/zones'
import { AIRPORTS, AIRPORT_PERIOD, airportFiles, airportSite, loadAirportAnalysis, loadMetar, metarUsable, modelThermoObsWindSample, obsMetSample } from './lib/airports'
import {
  ContingencyAccumulator,
  ErrorAccumulator,
  bootstrapRmseCi,
  categoricalScores,
  mseSkillScore,
  roundCategorical,
  roundOrNull,
  roundScores,
  roundTo,
} from './lib/stats'
import type { CategoricalScores, RoundedScores, SseBlock } from './lib/stats'
import { AIRPORT_FORECAST_PREVIEW, AIRPORT_PREVIEW_SOURCE, ANALYSIS_PREVIEW, SAME_MODEL_PREVIEW } from './lib/research'
import type { RunOptions } from './reference'

// ─────────────────────────────── Configuration ───────────────────────────────

export const SKILL_YEARS = [2024, 2025] as const
export const SKILL_MODELS: readonly PreviousRunsModel[] = ['ecmwf_ifs025', 'dwd_icon_seamless', 'ncep_gfs_seamless']
export const PRIMARY_MODEL: PreviousRunsModel = 'ecmwf_ifs025'
const LEADS = [1, 2, 3] as const
/** Day-block bootstrap replicates (data_and_validation.md §10 B.4). */
export const BOOTSTRAP_REPLICATES = 1000
/** Daytime hours (local, inclusive) for the airport daytime scores (data_and_validation.md §6.3: 07–18). */
const DAYTIME = { from: 7, to: 18 } as const

/** Yes/no events verified in the same-model skill. */
export type SkillEventId = 'adosh_high' | 'wbgt_ge_ral115' | 'wbgt_ge_qatar_stop'

export const SKILL_EVENTS: readonly { id: SkillEventId; label: string; basis: string }[] = [
  { id: 'adosh_high', label: 'ADOSH High zone (TWL ≤ 115 W/m², sun)', basis: 'ADOSH-SF TG v4.0 Table 1 via regulation.ts twlZone' },
  { id: 'wbgt_ge_ral115', label: `WBGT ≥ RAL(115 W) = ${WBGT_THRESHOLDS.ral115.toFixed(2)} °C`, basis: 'NIOSH 2016 §8.1 via limits.ts ralC' },
  { id: 'wbgt_ge_qatar_stop', label: `WBGT ≥ ${WBGT_THRESHOLDS.qatarStop} °C (Qatar stop-work value)`, basis: 'Qatar MD 17/2021 Art. 4(9) via regulation.ts' },
]

function isEvent(id: SkillEventId, wbgtC: number, twlWm2: number): boolean {
  if (id === 'adosh_high') return adoshZoneIndex(twlWm2) === 0
  if (id === 'wbgt_ge_ral115') return wbgtC >= WBGT_THRESHOLDS.ral115
  return wbgtC >= WBGT_THRESHOLDS.qatarStop
}

// ─────────────────────────────── Report contract ───────────────────────────────

export interface LeadSkill {
  lead: 1 | 2 | 3
  wbgt: RoundedScores & { rmseCi95: [number, number]; dailyMaxBias: number; dailyMaxRmse: number; skillVsPersistence: number | null }
  twl: RoundedScores & { rmseCi95: [number, number]; dailyMinBias: number; dailyMinRmse: number; skillVsPersistence: number | null }
  events: { id: SkillEventId; scores: CategoricalScores }[]
  /** Rows: verifying (d0) zone [high, medium, low]; columns: forecast zone. */
  adoshConfusion: number[][]
  /** Rows: verifying WBGT band; columns: forecast band (lib/zones.ts order). */
  wbgtBandConfusion: number[][]
  /** Forecast ≥ 2 zones/bands below the verifying one (ADOSH: forecast Low when d0 is High). */
  dangerousMisses: { adosh: number; wbgtBands: number }
  rmseByLocalHour: { wbgt: number[]; twl: number[] }
}

export interface PersistenceSkill {
  lagH: 24 | 48 | 72
  wbgt: RoundedScores
  twl: RoundedScores
  events: { id: SkillEventId; scores: CategoricalScores }[]
  dangerousMisses: { adosh: number; wbgtBands: number }
}

export interface ModelSkill {
  model: PreviousRunsModel
  primary: boolean
  grids: { site: SiteId; lat: number; lon: number; elevationM: number }[]
  leads: LeadSkill[]
  persistence: PersistenceSkill[]
}

export interface AirportAnalysisRow {
  icao: string
  model: 'era5' | 'ecmwf_ifs'
  n: number
  t: RoundedScores
  td: RoundedScores
  rh: RoundedScores
  wind: RoundedScores
  wbgtAll: RoundedScores
  wbgtDaytime: RoundedScores
  wbgtTTdOnly: RoundedScores
  twlAll: RoundedScores
}

export interface AirportForecastRow {
  icao: string
  model: PreviousRunsModel
  lead: LeadDay
  n: number
  t: RoundedScores
  td: RoundedScores
  wbgt: RoundedScores
  twl: RoundedScores
}

export interface ForecastSkillReport {
  schema: 'zill.validation.forecast_skill/v1'
  evidenceClass: 'real_data_exposure'
  title: string
  generatedBy: 'scripts/validate/forecast-skill.ts'
  command: string
  stamp: CodeStamp
  provenance: { inputs: InputFileRecord[]; manifestMismatches: string[]; attribution: typeof DATA_ATTRIBUTION }
  config: {
    years: number[]
    sites: SiteId[]
    models: readonly PreviousRunsModel[]
    primaryModel: PreviousRunsModel
    leadDefinition: string
    reference: string
    events: typeof SKILL_EVENTS
    wbgtBands: string[]
    adoshZones: readonly string[]
    bootstrap: { replicates: number; block: string; seedPrefix: string }
    engine: string
    notes: string[]
  }
  sameModel: ModelSkill[]
  airports: { period: typeof AIRPORT_PERIOD; method: string; analysis: AirportAnalysisRow[]; forecast: AirportForecastRow[] }
  researchComparison: {
    sameModel: { source: string; rows: { model: PreviousRunsModel; lead: number; ours: Record<string, number | null>; preview: Record<string, number | null> }[] }
    airports: { source: string; rows: { icao: string; model: string; lead: number | 'analysis'; variable: string; ours: [number, number]; preview: [number, number] }[] }
  }
  headline: Record<string, number | string | null>
}

// ─────────────────────────────── Same-model accumulation ───────────────────────────────

/** Per-model, per-lead accumulators. */
class LeadAcc {
  wbgt = new ErrorAccumulator()
  twl = new ErrorAccumulator()
  wbgtMatched = new ErrorAccumulator()
  twlMatched = new ErrorAccumulator()
  dailyMax = new ErrorAccumulator()
  dailyMin = new ErrorAccumulator()
  events = new Map<SkillEventId, ContingencyAccumulator>(SKILL_EVENTS.map((e) => [e.id, new ContingencyAccumulator()]))
  adosh = ADOSH_ZONES.map(() => ADOSH_ZONES.map(() => 0))
  bands = WBGT_BANDS.map(() => WBGT_BANDS.map(() => 0))
  dangerous = { adosh: 0, wbgtBands: 0 }
  byHourWbgt = Array.from({ length: 24 }, () => new ErrorAccumulator())
  byHourTwl = Array.from({ length: 24 }, () => new ErrorAccumulator())
  blocksWbgt: SseBlock[] = []
  blocksTwl: SseBlock[] = []
}

class PersistenceAcc {
  wbgt = new ErrorAccumulator()
  twl = new ErrorAccumulator()
  events = new Map<SkillEventId, ContingencyAccumulator>(SKILL_EVENTS.map((e) => [e.id, new ContingencyAccumulator()]))
  dangerous = { adosh: 0, wbgtBands: 0 }
}

/** Illustrative ≥ 30 / ≥ 32 °C contingency for the comparison with the research preview only. */
class PreviewEventAcc {
  ge30 = new ContingencyAccumulator()
  ge32 = new ContingencyAccumulator()
}

function scoreEvents(m: Map<SkillEventId, ContingencyAccumulator>): { id: SkillEventId; scores: CategoricalScores }[] {
  return SKILL_EVENTS.map((e) => ({ id: e.id, scores: roundCategorical(categoricalScores(m.get(e.id) ?? new ContingencyAccumulator())) }))
}

/**
 * Add one site-season of a model: forecast leads 1–3 against d0, and the persistence baseline (d0 at t − 24·lag h).
 */
function accumulateSiteSeason(
  d0: HeatColumns,
  leads: Record<1 | 2 | 3, HeatColumns>,
  acc: Record<1 | 2 | 3, LeadAcc>,
  pers: Record<1 | 2 | 3, PersistenceAcc>,
  preview: Record<1 | 2 | 3, PreviewEventAcc>,
): void {
  const refIndex = timeIndex(d0.t)
  for (const lead of LEADS) {
    const f = leads[lead]
    const a = acc[lead]
    const p = pers[lead]
    const pv = preview[lead]
    const lagMs = lead * 24 * 3_600_000
    const dayMaxF = new Map<number, number>()
    const dayMaxR = new Map<number, number>()
    const dayMinF = new Map<number, number>()
    const dayMinR = new Map<number, number>()
    const dayBlocksW = new Map<number, SseBlock>()
    const dayBlocksT = new Map<number, SseBlock>()
    for (let i = 0; i < f.n; i++) {
      const j = refIndex.get(f.t[i])
      if (j === undefined) continue
      const fw = f.wbgtC[i]
      const rw = d0.wbgtC[j]
      const ft = f.twlWm2[i]
      const rt = d0.twlWm2[j]
      a.wbgt.add(fw, rw)
      a.twl.add(ft, rt)
      a.byHourWbgt[d0.hour[j]].add(fw, rw)
      a.byHourTwl[d0.hour[j]].add(ft, rt)
      const day = d0.dayIndex[j]
      const bw = dayBlocksW.get(day) ?? { sse: 0, n: 0 }
      bw.sse += (fw - rw) ** 2
      bw.n++
      dayBlocksW.set(day, bw)
      const bt = dayBlocksT.get(day) ?? { sse: 0, n: 0 }
      bt.sse += (ft - rt) ** 2
      bt.n++
      dayBlocksT.set(day, bt)
      dayMaxF.set(day, Math.max(dayMaxF.get(day) ?? Number.NEGATIVE_INFINITY, fw))
      dayMaxR.set(day, Math.max(dayMaxR.get(day) ?? Number.NEGATIVE_INFINITY, rw))
      dayMinF.set(day, Math.min(dayMinF.get(day) ?? Number.POSITIVE_INFINITY, ft))
      dayMinR.set(day, Math.min(dayMinR.get(day) ?? Number.POSITIVE_INFINITY, rt))
      for (const e of SKILL_EVENTS) a.events.get(e.id)?.add(isEvent(e.id, fw, ft), isEvent(e.id, rw, rt))
      const zf = adoshZoneIndex(ft)
      const zr = adoshZoneIndex(rt)
      a.adosh[zr][zf]++
      if (zf - zr >= 2) a.dangerous.adosh++
      const bf = wbgtBandIndex(fw)
      const br = wbgtBandIndex(rw)
      a.bands[br][bf]++
      if (br - bf >= 2) a.dangerous.wbgtBands++
      pv.ge30.add(fw >= 30, rw >= 30)
      pv.ge32.add(fw >= 32, rw >= 32)
      // Persistence: d0 at t − lag (same season file) as the forecast for t.
      const k = refIndex.get(d0.t[j] - lagMs)
      if (k !== undefined) {
        const pw = d0.wbgtC[k]
        const pt = d0.twlWm2[k]
        p.wbgt.add(pw, rw)
        p.twl.add(pt, rt)
        a.wbgtMatched.add(fw, rw)
        a.twlMatched.add(ft, rt)
        for (const e of SKILL_EVENTS) p.events.get(e.id)?.add(isEvent(e.id, pw, pt), isEvent(e.id, rw, rt))
        if (adoshZoneIndex(pt) - zr >= 2) p.dangerous.adosh++
        if (br - wbgtBandIndex(pw) >= 2) p.dangerous.wbgtBands++
      }
    }
    for (const [day, v] of dayMaxF) {
      const r = dayMaxR.get(day)
      if (r !== undefined) a.dailyMax.add(v, r)
    }
    for (const [day, v] of dayMinF) {
      const r = dayMinR.get(day)
      if (r !== undefined) a.dailyMin.add(v, r)
    }
    a.blocksWbgt.push(...dayBlocksW.values())
    a.blocksTwl.push(...dayBlocksT.values())
  }
}

// ─────────────────────────────── Airports ───────────────────────────────

const tdOf = (s: EnvSample): number => s.tdC ?? dewPointC(s.taC, s.rhPct)
const isDaytime = (t: number): boolean => {
  const h = localParts(t).hour
  return h >= DAYTIME.from && h <= DAYTIME.to
}

function airportVerification(prov: Provenance): { analysis: AirportAnalysisRow[]; forecast: AirportForecastRow[] } {
  const analysis: AirportAnalysisRow[] = []
  const forecast: AirportForecastRow[] = []
  for (const a of AIRPORTS) {
    const metar = loadMetar(prov, a)
    const site: Site = airportSite(a, metar.lat, metar.lon)

    // Archive analyses vs METAR (obs-met reference with the same model's radiation and pressure).
    let ifsArchive: WeatherSeries | null = null
    for (const model of ['era5', 'ecmwf_ifs'] as const) {
      const series = loadAirportAnalysis(prov, a, model === 'era5' ? 'era5@nearest' : 'ecmwf_ifs@nearest')
      if (model === 'ecmwf_ifs') ifsArchive = series
      const acc = {
        t: new ErrorAccumulator(),
        td: new ErrorAccumulator(),
        rh: new ErrorAccumulator(),
        wind: new ErrorAccumulator(),
        wbgtAll: new ErrorAccumulator(),
        wbgtDay: new ErrorAccumulator(),
        wbgtTTd: new ErrorAccumulator(),
        twl: new ErrorAccumulator(),
      }
      for (const s of series.samples) {
        const o = metar.byTime.get(s.t)
        if (!metarUsable(o)) continue
        acc.t.add(s.taC, o.taC)
        acc.td.add(tdOf(s), o.tdC)
        if (o.rhPct !== null) acc.rh.add(s.rhPct, o.rhPct)
        acc.wind.add(s.wind10Ms, o.windMs)
        const ref = hourHeat(obsMetSample(o, s), site, 'none')
        const mod = hourHeat(s, site, 'none')
        const ttd = hourHeat(modelThermoObsWindSample(s, o), site, 'none')
        acc.wbgtAll.add(mod.wbgtC, ref.wbgtC)
        if (isDaytime(s.t)) acc.wbgtDay.add(mod.wbgtC, ref.wbgtC)
        acc.wbgtTTd.add(ttd.wbgtC, ref.wbgtC)
        acc.twl.add(mod.twlWm2, ref.twlWm2)
      }
      analysis.push({
        icao: a.icao,
        model,
        n: acc.t.n,
        t: roundScores(acc.t.scores()),
        td: roundScores(acc.td.scores()),
        rh: roundScores(acc.rh.scores(), 1),
        wind: roundScores(acc.wind.scores()),
        wbgtAll: roundScores(acc.wbgtAll.scores()),
        wbgtDaytime: roundScores(acc.wbgtDay.scores()),
        wbgtTTdOnly: roundScores(acc.wbgtTTd.scores()),
        twlAll: roundScores(acc.twl.scores(), 1),
      })
    }
    if (ifsArchive === null) throw new Error(`no IFS archive at ${a.icao}`)

    // Forecast leads vs METAR; WBGT/TWL reference = obs-met with the IFS 9 km archive radiation (§6.4).
    const ifsByT = new Map<number, EnvSample>()
    for (const s of ifsArchive.samples) ifsByT.set(s.t, s)
    const refHeat = new Map<number, { wbgtC: number; twlWm2: number }>()
    const prevJson = prov.readJson(airportFiles(a).previous)
    for (const model of SKILL_MODELS) {
      for (const lead of [0, 1, 2, 3] as const) {
        const series = parsePreviousRunsFile(prevJson, model, lead)
        const acc = { t: new ErrorAccumulator(), td: new ErrorAccumulator(), wbgt: new ErrorAccumulator(), twl: new ErrorAccumulator() }
        for (const s of series.samples) {
          const o = metar.byTime.get(s.t)
          const rad = ifsByT.get(s.t)
          if (!metarUsable(o) || rad === undefined) continue
          let ref = refHeat.get(s.t)
          if (ref === undefined) {
            ref = hourHeat(obsMetSample(o, rad), site, 'none')
            refHeat.set(s.t, ref)
          }
          const mod = hourHeat(s, site, 'none')
          acc.t.add(s.taC, o.taC)
          acc.td.add(tdOf(s), o.tdC)
          acc.wbgt.add(mod.wbgtC, ref.wbgtC)
          acc.twl.add(mod.twlWm2, ref.twlWm2)
        }
        forecast.push({
          icao: a.icao,
          model,
          lead,
          n: acc.t.n,
          t: roundScores(acc.t.scores()),
          td: roundScores(acc.td.scores()),
          wbgt: roundScores(acc.wbgt.scores()),
          twl: roundScores(acc.twl.scores(), 1),
        })
      }
    }
  }
  return { analysis, forecast }
}

// ─────────────────────────────── Run ───────────────────────────────

/**
 * Compute same-model and airport forecast skill and (by default) write public/data/validation/forecast-skill.json.
 * Basis: data_and_validation.md §10 B (design), Wilks 2011 (scores), regulation.ts / limits.ts (event thresholds).
 */
export function runForecastSkill(opts: RunOptions = {}): ForecastSkillReport {
  const log = opts.log ?? true
  const prov = new Provenance()
  const t0 = performance.now()

  const sameModel: ModelSkill[] = []
  const previewAcc = new Map<PreviousRunsModel, Record<1 | 2 | 3, PreviewEventAcc>>()
  const accs = new Map<PreviousRunsModel, { leads: Record<1 | 2 | 3, LeadAcc>; pers: Record<1 | 2 | 3, PersistenceAcc>; grids: ModelSkill['grids'] }>()
  for (const m of SKILL_MODELS) {
    accs.set(m, {
      leads: { 1: new LeadAcc(), 2: new LeadAcc(), 3: new LeadAcc() },
      pers: { 1: new PersistenceAcc(), 2: new PersistenceAcc(), 3: new PersistenceAcc() },
      grids: [],
    })
    previewAcc.set(m, { 1: new PreviewEventAcc(), 2: new PreviewEventAcc(), 3: new PreviewEventAcc() })
  }
  for (const site of SITES) {
    for (const year of SKILL_YEARS) {
      const json = prov.readJson(`public/data/weather/previous-runs/${site.id}_${year}.json`)
      for (const m of SKILL_MODELS) {
        const st = accs.get(m)
        const pv = previewAcc.get(m)
        if (!st || !pv) continue
        const series = ([0, 1, 2, 3] as const).map((lead) => parsePreviousRunsFile(json, m, lead))
        const g = series[0].grid
        if (g && !st.grids.some((x) => x.site === site.id)) st.grids.push({ site: site.id, lat: g.lat, lon: g.lon, elevationM: g.elevationM })
        const heat = series.map((s) => heatColumns(s.samples, site, 'none'))
        accumulateSiteSeason(heat[0], { 1: heat[1], 2: heat[2], 3: heat[3] }, st.leads, st.pers, pv)
      }
    }
  }
  const tSame = performance.now()

  for (const m of SKILL_MODELS) {
    const st = accs.get(m)
    if (!st) continue
    const leads: LeadSkill[] = LEADS.map((lead) => {
      const a = st.leads[lead]
      const p = st.pers[lead]
      const ws = a.wbgt.scores()
      const ts = a.twl.scores()
      const dmax = a.dailyMax.scores()
      const dmin = a.dailyMin.scores()
      const ciW = bootstrapRmseCi(a.blocksWbgt, BOOTSTRAP_REPLICATES, `validate:forecast-skill:${m}:d${lead}:wbgt`)
      const ciT = bootstrapRmseCi(a.blocksTwl, BOOTSTRAP_REPLICATES, `validate:forecast-skill:${m}:d${lead}:twl`)
      return {
        lead,
        wbgt: {
          ...roundScores(ws),
          rmseCi95: [roundTo(ciW[0], 3), roundTo(ciW[1], 3)],
          dailyMaxBias: roundTo(dmax.bias, 2),
          dailyMaxRmse: roundTo(dmax.rmse, 2),
          skillVsPersistence: roundOrNull(mseSkillScore(a.wbgtMatched.mse(), p.wbgt.mse()), 3),
        },
        twl: {
          ...roundScores(ts, 1),
          rmseCi95: [roundTo(ciT[0], 1), roundTo(ciT[1], 1)],
          dailyMinBias: roundTo(dmin.bias, 1),
          dailyMinRmse: roundTo(dmin.rmse, 1),
          skillVsPersistence: roundOrNull(mseSkillScore(a.twlMatched.mse(), p.twl.mse()), 3),
        },
        events: scoreEvents(a.events),
        adoshConfusion: a.adosh,
        wbgtBandConfusion: a.bands,
        dangerousMisses: { ...a.dangerous },
        rmseByLocalHour: { wbgt: a.byHourWbgt.map((x) => roundTo(x.scores().rmse, 2)), twl: a.byHourTwl.map((x) => roundTo(x.scores().rmse, 1)) },
      }
    })
    const persistence: PersistenceSkill[] = LEADS.map((lead) => {
      const p = st.pers[lead]
      return {
        lagH: (lead * 24) as 24 | 48 | 72,
        wbgt: roundScores(p.wbgt.scores()),
        twl: roundScores(p.twl.scores(), 1),
        events: scoreEvents(p.events),
        dangerousMisses: { ...p.dangerous },
      }
    })
    sameModel.push({ model: m, primary: m === PRIMARY_MODEL, grids: st.grids, leads, persistence })
  }

  const airports = airportVerification(prov)
  const tAir = performance.now()

  // Comparison with the research preview (thermofeel, config A).
  const sameRows: ForecastSkillReport['researchComparison']['sameModel']['rows'] = []
  for (const m of SKILL_MODELS) {
    const ms = sameModel.find((x) => x.model === m)
    const pv = previewAcc.get(m)
    if (!ms || !pv) continue
    for (const l of ms.leads) {
      const ge30 = categoricalScores(pv[l.lead].ge30)
      const ge32 = categoricalScores(pv[l.lead].ge32)
      const ours: Record<string, number | null> = {
        bias: l.wbgt.bias,
        mae: l.wbgt.mae,
        rmse: l.wbgt.rmse,
        dailyMaxRmse: l.wbgt.dailyMaxRmse,
        ge30Pod: roundOrNull(ge30.pod, 2),
        ge30Far: roundOrNull(ge30.far, 2),
        ge30Csi: roundOrNull(ge30.csi, 2),
        ge32Pod: roundOrNull(ge32.pod, 2),
        ge32Far: roundOrNull(ge32.far, 2),
        ge32Csi: roundOrNull(ge32.csi, 2),
      }
      let preview: Record<string, number | null> = {}
      if (m === 'ecmwf_ifs025') {
        const p = SAME_MODEL_PREVIEW.ecmwf_ifs025[l.lead - 1]
        preview = { bias: p.bias, mae: p.mae, rmse: p.rmse, dailyMaxRmse: p.dailyMaxRmse, ge30Pod: p.ge30.pod, ge30Far: p.ge30.far, ge30Csi: p.ge30.csi, ge32Pod: p.ge32.pod, ge32Far: p.ge32.far, ge32Csi: p.ge32.csi }
      } else {
        const p = SAME_MODEL_PREVIEW[m]
        preview = { rmse: p.rmse[l.lead - 1], dailyMaxRmse: p.dailyMaxRmse[l.lead - 1] }
      }
      sameRows.push({ model: m, lead: l.lead, ours, preview })
    }
    if (m === 'ecmwf_ifs025') {
      const p24 = ms.persistence[0]
      sameRows.push({
        model: m,
        lead: 0,
        ours: { persistence24hBias: p24.wbgt.bias, persistence24hMae: p24.wbgt.mae, persistence24hRmse: p24.wbgt.rmse },
        preview: { persistence24hBias: SAME_MODEL_PREVIEW.persistence24h.bias, persistence24hMae: SAME_MODEL_PREVIEW.persistence24h.mae, persistence24hRmse: SAME_MODEL_PREVIEW.persistence24h.rmse },
      })
    }
  }
  const airportRows: ForecastSkillReport['researchComparison']['airports']['rows'] = []
  for (const r of airports.forecast) {
    const pv = AIRPORT_FORECAST_PREVIEW[r.icao]?.[r.model]
    if (!pv) continue
    for (const [variable, ours, prev] of [
      ['t', r.t, pv.t[r.lead]],
      ['td', r.td, pv.td[r.lead]],
      ['wbgt', r.wbgt, pv.wbgt[r.lead]],
    ] as const) {
      if (prev) airportRows.push({ icao: r.icao, model: r.model, lead: r.lead, variable, ours: [ours.bias, ours.rmse], preview: [prev[0], prev[1]] })
    }
  }
  for (const p of ANALYSIS_PREVIEW) {
    const r = airports.analysis.find((x) => x.icao === p.icao && x.model === p.model)
    if (!r) continue
    for (const [variable, ours, prev] of [
      ['t', r.t, p.t],
      ['td', r.td, p.td],
      ['wind', r.wind, p.wind],
      ['wbgt_all', r.wbgtAll, p.wbgtAll],
      ['wbgt_daytime', r.wbgtDaytime, p.wbgtDay],
      ['wbgt_t_td_only', r.wbgtTTdOnly, p.wbgtTTdOnly],
    ] as const) {
      airportRows.push({ icao: p.icao, model: p.model, lead: 'analysis', variable, ours: [ours.bias, ours.rmse], preview: [prev[0], prev[1]] })
    }
  }

  // Headline (primary model).
  const prim = sameModel.find((x) => x.model === PRIMARY_MODEL)
  const ev = (l: LeadSkill | undefined, id: SkillEventId): CategoricalScores | undefined => l?.events.find((e) => e.id === id)?.scores
  const headline: Record<string, number | string | null> = { primaryModel: PRIMARY_MODEL }
  for (const lead of LEADS) {
    const l = prim?.leads.find((x) => x.lead === lead)
    headline[`wbgtRmseD${lead}`] = l?.wbgt.rmse ?? null
    headline[`wbgtDailyMaxRmseD${lead}`] = l?.wbgt.dailyMaxRmse ?? null
    headline[`twlRmseD${lead}`] = l?.twl.rmse ?? null
    headline[`wbgtGeRal115CsiD${lead}`] = ev(l, 'wbgt_ge_ral115')?.csi ?? null
    headline[`adoshHighPodD${lead}`] = ev(l, 'adosh_high')?.pod ?? null
    headline[`adoshHighFarD${lead}`] = ev(l, 'adosh_high')?.far ?? null
    headline[`adoshHighCsiD${lead}`] = ev(l, 'adosh_high')?.csi ?? null
    headline[`wbgtSkillVsPersistenceD${lead}`] = l?.wbgt.skillVsPersistence ?? null
  }
  headline.persistence24hWbgtRmse = prim?.persistence[0]?.wbgt.rmse ?? null
  for (const icao of ['OMAA', 'OMAD', 'OMAL']) {
    const r = airports.forecast.find((x) => x.icao === icao && x.model === PRIMARY_MODEL && x.lead === 1)
    headline[`airport${icao}WbgtBiasD1`] = r?.wbgt.bias ?? null
    headline[`airport${icao}WbgtRmseD1`] = r?.wbgt.rmse ?? null
    const g = airports.forecast.find((x) => x.icao === icao && x.model === 'ncep_gfs_seamless' && x.lead === 1)
    headline[`airport${icao}GfsTdBiasD1`] = g?.td.bias ?? null
  }

  const report: ForecastSkillReport = {
    schema: 'zill.validation.forecast_skill/v1',
    evidenceClass: 'real_data_exposure',
    title: 'Forecast skill of WBGT and TWL at lead days 1–3, Abu Dhabi, Jun–Sep 2024–2025',
    generatedBy: 'scripts/validate/forecast-skill.ts',
    command: 'npm run validate',
    stamp: codeStamp(prov.inputsSha256()),
    provenance: { inputs: prov.records(), manifestMismatches: prov.manifestMismatches(), attribution: DATA_ATTRIBUTION },
    config: {
      years: [...SKILL_YEARS],
      sites: SITES.map((s) => s.id),
      models: SKILL_MODELS,
      primaryModel: PRIMARY_MODEL,
      leadDefinition:
        'dN = value for the same valid time from runs issued ~24·N h earlier (Open-Meteo Previous Runs; 6-hourly models: d1 = leads 24–29 h). d0 = most recent run (leads 0–5 h), a short-range proxy for the analysis.',
      reference: 'Same-model: the model\'s own d0. Persistence: d0 at t − 24·N h. Airports: METAR (obs-met WBGT/TWL with model radiation).',
      events: SKILL_EVENTS,
      wbgtBands: WBGT_BANDS.map((b) => b.label),
      adoshZones: ADOSH_ZONES,
      bootstrap: { replicates: BOOTSTRAP_REPLICATES, block: 'site-day (resample whole local days of one site, with replacement)', seedPrefix: 'validate:forecast-skill' },
      engine: 'indices.ts computeSiteHeat per hour (Liljegren WBGT in sun; TWL in sun), no site radiant allowance',
      notes: [
        'Same-model scores measure how fast forecast error grows with lead time; they exclude the model\'s own bias and are therefore optimistic. The airport section shows the bias against observations.',
        'ecmwf_ifs025 is the same IFS model as the live forecast but on a 0.25° grid, 3-hourly and interpolated to hourly; the production 9 km model (ecmwf_ifs) has Previous Runs only from 2025-10-01.',
        'Airport verification covers three airports and one summer (2025); the airports stand in for the sites only approximately (station notes: OMAA ↔ musaffah/kezad, OMAD ↔ saadiyat, OMAL ↔ alain).',
        'METAR temperatures are integers (±0.5 °C quantisation, about 0.29 °C RMS) and METAR carries no radiation, so the WBGT/TWL reference uses model radiation.',
      ],
    },
    sameModel,
    airports: {
      period: AIRPORT_PERIOD,
      method:
        'Routine METAR at HH:00 UTC matched to the model value at the same instant (n ≈ 2,927 h per airport). Error = model − observation. WBGT/TWL reference = engine heat indices from METAR T, Td and 10 m wind with model radiation and surface pressure: the same model\'s fields for the analyses (§6.3), the IFS 9 km archive for the forecasts (§6.4). "T/Td only" keeps the model T/Td and uses the METAR wind.',
      analysis: airports.analysis,
      forecast: airports.forecast,
    },
    researchComparison: {
      sameModel: { source: SAME_MODEL_PREVIEW.source, rows: sameRows },
      airports: { source: AIRPORT_PREVIEW_SOURCE, rows: airportRows },
    },
    headline,
  }
  if (opts.write ?? true) {
    const bytes = writeValidationJson('forecast-skill', report)
    if (log) console.log(`[forecast] same-model ${(tSame - t0).toFixed(0)} ms · airports ${(tAir - tSame).toFixed(0)} ms · forecast-skill.json ${(bytes / 1024).toFixed(1)} KiB`)
  }
  if (log && prov.manifestMismatches().length > 0) console.warn(`[forecast] manifest mismatches: ${prov.manifestMismatches().join(', ')}`)
  return report
}

if (isMainModule(import.meta.url)) {
  const { ms } = timed(() => runForecastSkill())
  console.log(`[forecast] done in ${(ms / 1000).toFixed(1)} s`)
}
