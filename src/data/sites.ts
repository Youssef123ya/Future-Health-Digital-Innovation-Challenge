/**
 * The five Abu Dhabi sites Zill is demonstrated on, with the exact coordinates used to build the cached weather archive
 * (public/data/weather, scripts/data/fetch-weather.mjs) and the Open-Meteo grid cells those coordinates resolve to
 * (docs/research/data_and_validation.md §4.2).
 *
 * Site properties that no standard fixes (radiant boost, presence of a WBGT meter) are engineering/scenario choices,
 * tagged [ENG], each with its rationale, and always resolved in the worker-protective direction.
 */
import type { Site } from '../engine/types'

/** Site identifier (the closed set of demo sites; matches the cached weather file names). */
export type SiteId = Site['id']

/** Grid cell returned by Open-Meteo for a requested point (data_and_validation.md §8 `Grid`). */
export interface GridCellInfo {
  lat: number
  lon: number
  /** 90 m DEM height of the *requested* point, used by Open-Meteo for downscaling (data_and_validation.md §4.2). */
  elevationM: number
  cellSelection: 'land' | 'nearest'
}

/** Data provenance and rationale for a site's engineering parameters. */
export interface SiteDataInfo {
  /** ECMWF IFS HRES 9 km (O1280) land cell — the model behind the live forecast and the replay archive. */
  ifsCell: GridCellInfo
  /** ERA5 0.25° land cell (homogeneous reanalysis 1940–present). */
  era5Cell: GridCellInfo
  /** Nearest airport METAR station used to validate the model data, if any (data_and_validation.md §6). */
  metarIcao?: 'OMAA' | 'OMAD' | 'OMAL'
  /** Caveats about the grid cell. */
  gridNote?: string
  /** Why `radiantBoostC` has its value ([ENG]). */
  radiantBoostRationale: string
  /** Why `hasWbgtMeter` has its value ([ENG] scenario assumption). */
  wbgtMeterRationale: string
  /** Why the site is (or is not) classed as coastal. */
  coastalRationale: string
}

/**
 * Radiant-boost rationale shared by all sites [ENG]. The Liljegren (2008) outdoor WBGT model assumes the ground is at air
 * temperature with a fixed albedo of 0.45, so it is "likely optimistic over hot sand or asphalt"; ground 20 K hotter
 * than air would add about 0.7–0.9 °C to WBGT in the inland and coastal noon cases (docs/research/wbgt_liljegren.md §18).
 * No standard fixes a site correction, so Zill adds a per-site allowance to the modelled globe temperature: 0 °C over
 * open ground, up to 2 °C for steel and asphalt yards (at the WBGT weight of 0.2 on the globe term this is ≤ 0.4 °C of
 * WBGT — a partial, not full, correction for a 20 K hot surface). A pilot replaces it with on-site globe measurements.
 * The allowance never applies on top of a measured WBGT (a meter already sees the site's radiant field).
 */
export const RADIANT_BOOST_BASIS =
  '[ENG] allowance for hot work surfaces; Liljegren 2008 assumes ground at air temperature (wbgt_liljegren.md §18)'

/**
 * Rest-area rationale [ENG scenario assumption]: ADOSH-SF CoP 11.0 v4.0 §3.2(c) lists "cooled and air-conditioned rest
 * areas" as an engineering control and §3.2(b)(vii) requires cooled shelter during the midday break, so the industrial,
 * port and construction sites are modelled with air-conditioned rest cabins. The Al Ain site models mobile road and
 * landscaping crews with shade canopies only, to show how much rest-area cooling changes the safe work time.
 */
export const REST_AREA_BASIS =
  'ADOSH-SF CoP 11.0 v4.0 §3.2(c) cooled and air-conditioned rest areas; §3.2(b)(vii) cooled shelter in the midday break'

/**
 * The five demo sites. Coordinates are those requested from Open-Meteo for every cached file; `kind` maps the cached
 * file's kind ("port-industrial" → port, "coastal-construction" → construction) onto the Site contract.
 */
export const SITES: readonly Site[] = [
  {
    id: 'musaffah',
    name: 'Musaffah industrial area',
    nameAr: 'منطقة مصفح الصناعية',
    lat: 24.35,
    lon: 54.5,
    kind: 'industrial',
    coastal: true,
    radiantBoostC: 1.5,
    hasWbgtMeter: false,
    restArea: 'cooled_cabin',
  },
  {
    id: 'kezad',
    name: 'Khalifa Port / KEZAD',
    nameAr: 'ميناء خليفة / كيزاد',
    lat: 24.8,
    lon: 54.65,
    kind: 'port',
    coastal: true,
    radiantBoostC: 2,
    hasWbgtMeter: true,
    restArea: 'cooled_cabin',
  },
  {
    id: 'ruwais',
    name: 'Ruwais industrial city',
    nameAr: 'مدينة الرويس الصناعية',
    lat: 24.11,
    lon: 52.73,
    kind: 'industrial',
    coastal: true,
    radiantBoostC: 2,
    hasWbgtMeter: true,
    restArea: 'cooled_cabin',
  },
  {
    id: 'alain',
    name: 'Al Ain',
    nameAr: 'العين',
    lat: 24.21,
    lon: 55.74,
    kind: 'inland',
    coastal: false,
    radiantBoostC: 1,
    hasWbgtMeter: false,
    restArea: 'shade',
  },
  {
    id: 'saadiyat',
    name: 'Saadiyat Island',
    nameAr: 'جزيرة السعديات',
    lat: 24.53,
    lon: 54.43,
    kind: 'construction',
    coastal: true,
    radiantBoostC: 0.5,
    hasWbgtMeter: false,
    restArea: 'cooled_cabin',
  },
] as const

/** All site ids in display order. */
export const SITE_IDS: readonly SiteId[] = SITES.map((s) => s.id)

/**
 * Grid cells and parameter rationale per site. Grid cells are transcribed from docs/research/data_and_validation.md §4.2
 * and match the `grid` blocks of the cached archive files (cell_selection=land, the Open-Meteo default).
 */
export const SITE_DATA_INFO: Readonly<Record<SiteId, SiteDataInfo>> = {
  musaffah: {
    ifsCell: { lat: 24.358522, lon: 54.498936, elevationM: 6, cellSelection: 'land' },
    era5Cell: { lat: 24.25, lon: 54.5, elevationM: 6, cellSelection: 'land' },
    metarIcao: 'OMAA',
    gridNote: '`land` and `nearest` cell selection are identical here.',
    radiantBoostRationale:
      '1.5 °C [ENG]: mixed steel-fabrication and asphalt/concrete yards with some workshop shade; between open ground (0) and full steel/asphalt yards (2).',
    wbgtMeterRationale:
      'No meter [ENG]: small and medium workshops typically rely on forecasts; demonstrates the forecast → archive → default chain.',
    coastalRationale:
      'Low-lying (DEM 6 m) beside the Musaffah channel; one of the "four coastal sites" of the inter-annual analysis (data_and_validation.md §10 A).',
  },
  kezad: {
    ifsCell: { lat: 24.710016, lon: 54.694534, elevationM: 0, cellSelection: 'land' },
    era5Cell: { lat: 24.75, lon: 54.75, elevationM: 0, cellSelection: 'land' },
    metarIcao: 'OMAA',
    gridNote:
      'The requested point (24.80, 54.65) is water in the Open-Meteo DEM (elevation 0 m). IFS `nearest` returns a sea cell ' +
      '(24.7803, 54.6566) that read 35.3 °C against 42.4 °C in the land cell on 2025-07-15 14:00, so cell_selection=land is ' +
      'kept and picks the land cell 24.710, 54.695 (about 10 km SSE). Moving the KEZAD coordinate onto land is an open item.',
    radiantBoostRationale:
      '2 °C [ENG]: asphalt/concrete container yard, steel container stacks and quay; top of the 0–2 °C range (protective).',
    wbgtMeterRationale:
      'Meter present [ENG]: large port operators run on-site heat-stress monitoring; demonstrates measured-WBGT fusion (ISO 7243).',
    coastalRationale: 'Port on the Gulf shore (DEM 0 m).',
  },
  ruwais: {
    ifsCell: { lat: 24.077328, lon: 52.738853, elevationM: 12, cellSelection: 'land' },
    era5Cell: { lat: 24, lon: 52.75, elevationM: 12, cellSelection: 'land' },
    gridNote: 'An IFS sea cell would read 34.5 °C against 40.1 °C on land (2025-07-15), so the land cell is used.',
    radiantBoostRationale:
      '2 °C [ENG]: process plant with steel structures, hot pipework and concrete pads; top of the range (protective).',
    wbgtMeterRationale:
      'Meter present [ENG]: petrochemical operators typically run on-site heat-stress monitoring; demonstrates measured-WBGT fusion.',
    coastalRationale: 'Industrial city on the Gulf coast of Al Dhafra (DEM 12 m).',
  },
  alain: {
    ifsCell: { lat: 24.217924, lon: 55.723408, elevationM: 275, cellSelection: 'land' },
    era5Cell: { lat: 24.25, lon: 55.75, elevationM: 275, cellSelection: 'land' },
    metarIcao: 'OMAL',
    radiantBoostRationale:
      '1 °C [ENG]: road works on fresh asphalt (2) mixed with landscaping on open ground (0); the site value leans protective.',
    wbgtMeterRationale: 'No meter [ENG]: dispersed municipal road and landscaping crews rely on forecasts.',
    coastalRationale: 'Inland oasis city at 275 m, about 120 km from the coast: hotter and drier than the coastal sites.',
  },
  saadiyat: {
    ifsCell: { lat: 24.49912, lon: 54.423077, elevationM: 6, cellSelection: 'land' },
    era5Cell: { lat: 24.5, lon: 54.5, elevationM: 6, cellSelection: 'land' },
    metarIcao: 'OMAD',
    gridNote: 'The IFS land cell is about 3.5 km south of the requested point.',
    radiantBoostRationale:
      '0.5 °C [ENG]: open sand plots (0) with concrete slabs and rebar mats that heat up in the sun.',
    wbgtMeterRationale:
      'No meter [ENG]: demonstrates forecast-driven planning on a construction site (and the Saadiyat demo days).',
    coastalRationale: 'Island site on the Gulf (DEM 6 m); humid sea-breeze regime.',
  },
}

/** True when `id` is one of the five site ids. */
export function isSiteId(id: string): id is SiteId {
  return (SITE_IDS as readonly string[]).includes(id)
}

/** Look up a site by id; throws on an unknown id (a programming error, never a runtime data condition). */
export function getSite(id: SiteId): Site {
  const site = SITES.find((s) => s.id === id)
  if (!site) throw new Error(`Unknown site id: ${id}`)
  return site
}
