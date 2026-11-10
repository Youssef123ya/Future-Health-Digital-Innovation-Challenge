/**
 * Airport verification helpers: METAR observations (public/data/obs/*_2025_summer.json, IEM) matched to the model cells
 * of public/data/weather/validation/*.json, and the "obs-met" reference sample.
 *
 * Method (docs/research/data_and_validation.md §6, "Matching" and §6.3): routine METARs at HH:00 UTC are paired with the
 * model value at the same UTC instant over 1 Jun 00:00 – 30 Sep 23:00 local, 2025. The obs-met reference uses METAR air
 * temperature, dew point and 10 m wind with the MODEL's radiation and surface pressure (METAR has no radiation, and QNH
 * is sea-level pressure). Heat indices come from the engine (lib/heat.ts → indices.ts computeSiteHeat), so the
 * reference and the model are processed identically.
 */
import { parseMetarFile, parseValidationPointFile } from '../../../src/data/weather'
import type { MetarObservation, ValidationModelKey, ValidationPointId, WeatherSeries } from '../../../src/data/weather'
import { getSite } from '../../../src/data/sites'
import type { SiteId } from '../../../src/data/sites'
import { rhFromDewPointPct } from '../../../src/engine/psychro'
import type { EnvSample, Site } from '../../../src/engine/types'
import type { Provenance } from './io'

/** One validation airport. */
export interface AirportDef {
  pointId: ValidationPointId
  icao: 'OMAA' | 'OMAD' | 'OMAL'
  /** Zill sites this airport stands in for (station note in the METAR file). */
  represents: readonly SiteId[]
}

/** The three validation airports (data_and_validation.md §5–6; station notes in public/data/obs/*.json). */
export const AIRPORTS: readonly AirportDef[] = [
  { pointId: 'omaa', icao: 'OMAA', represents: ['musaffah', 'kezad'] },
  { pointId: 'omad', icao: 'OMAD', represents: ['saadiyat'] },
  { pointId: 'omal', icao: 'OMAL', represents: ['alain'] },
]

/** Repository paths of an airport's files. */
export function airportFiles(a: AirportDef): { analysis: string; previous: string; metar: string } {
  return {
    analysis: `public/data/weather/validation/${a.pointId}_2025.json`,
    previous: `public/data/weather/validation/${a.pointId}_2025_previous.json`,
    metar: `public/data/obs/${a.icao}_2025_summer.json`,
  }
}

/**
 * A Site-shaped location for an airport so the engine pipeline can run there: the station coordinates (for solar
 * geometry), no radiant allowance, no meter. The `id` is the first represented site (used only as a label).
 */
export function airportSite(a: AirportDef, lat: number, lon: number): Site {
  const base = getSite(a.represents[0])
  return { ...base, name: a.icao, lat, lon, radiantBoostC: 0, hasWbgtMeter: false }
}

/** METAR observations of an airport indexed by UTC epoch ms (routine reports on the hour only). */
export function loadMetar(prov: Provenance, a: AirportDef): { byTime: Map<number, MetarObservation>; lat: number; lon: number; elevationM: number; n: number } {
  const m = parseMetarFile(prov.readJson(airportFiles(a).metar))
  const byTime = new Map<number, MetarObservation>()
  for (const o of m.observations) if (o.t % 3_600_000 === 0) byTime.set(o.t, o)
  return { byTime, lat: m.lat, lon: m.lon, elevationM: m.elevationM, n: m.observations.length }
}

/** Analysis series of one archive model at an airport cell. */
export function loadAirportAnalysis(prov: Provenance, a: AirportDef, model: ValidationModelKey): WeatherSeries {
  return parseValidationPointFile(prov.readJson(airportFiles(a).analysis), model)
}

/** True when a METAR report has the fields the obs-met reference needs (T, Td and wind). */
export function metarUsable(o: MetarObservation | undefined): o is MetarObservation & { taC: number; tdC: number; windMs: number } {
  return o !== undefined && o.taC !== null && o.tdC !== null && o.windMs !== null
}

/**
 * The obs-met sample: METAR T, Td (RH from Td) and 10 m wind, with the model sample's radiation and surface pressure
 * (data_and_validation.md §6.3). Calm (0 m/s) is kept: the WBGT model applies its own 0.62 m/s floor.
 */
export function obsMetSample(o: MetarObservation & { taC: number; tdC: number; windMs: number }, model: EnvSample): EnvSample {
  const s: EnvSample = {
    t: model.t,
    taC: o.taC,
    tdC: o.tdC,
    rhPct: rhFromDewPointPct(o.taC, o.tdC),
    pHpa: model.pHpa,
    wind10Ms: o.windMs,
    ghiWm2: model.ghiWm2,
    source: 'archive',
    radiantBoostC: 0,
  }
  if (model.directWm2 !== undefined) s.directWm2 = model.directWm2
  if (model.diffuseWm2 !== undefined) s.diffuseWm2 = model.diffuseWm2
  if (model.dniWm2 !== undefined) s.dniWm2 = model.dniWm2
  if (model.radiationWindowMin !== undefined) s.radiationWindowMin = model.radiationWindowMin
  return s
}

/**
 * The "T/Td error alone" sample: the model's T and Td with the METAR wind and the model's radiation and pressure
 * (data_and_validation.md §6.3 last column).
 */
export function modelThermoObsWindSample(model: EnvSample, o: MetarObservation & { windMs: number }): EnvSample {
  return { ...model, wind10Ms: o.windMs, radiantBoostC: 0 }
}

/** Local window of the matching: 1 Jun 00:00 – 30 Sep 23:00 Asia/Dubai, 2025 (the validation files' time axis). */
export const AIRPORT_PERIOD = { start: '2025-06-01T00:00', end: '2025-09-30T23:00', timezone: 'Asia/Dubai' } as const
