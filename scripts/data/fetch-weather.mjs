#!/usr/bin/env node
// Zill — reproducible download + cache of Open-Meteo weather data for back-testing and validation.
//
// Dependency-free Node >= 18 ESM (global fetch, node:crypto). Tested with Node 24.
//
//   node scripts/data/fetch-weather.mjs                       # everything (skips files that already exist)
//   node scripts/data/fetch-weather.mjs --only=archive        # one stage: archive | previous | validation | demo | manifest
//   node scripts/data/fetch-weather.mjs --force               # re-download even if files exist
//   node scripts/data/fetch-weather.mjs --delay=1500          # ms between API requests (default 1000)
//
// Output tree (relative to the project root), all JSON, compact (no whitespace):
//   public/data/weather/archive/<site>_<year>.json          Jun 1-Sep 30 local, 2020-2025, models era5 + ecmwf_ifs
//   public/data/weather/archive/musaffah_2025-11.json        November 2025 (source of the mild demo day)
//   public/data/weather/previous-runs/<site>_<year>.json    Jun 1-Sep 30 local, 2024-2025, lead day0..day3,
//                                                            models ecmwf_ifs025 + dwd_icon_seamless + ncep_gfs_seamless
//   public/data/weather/validation/<point>_2025.json         airport grid points (OMAA/OMAD/OMAL) for METAR comparison
//   public/data/weather/validation/<point>_2025_previous.json  same points, lead day0..day3 (forecast skill vs METAR)
//   public/data/weather/demo-days.json                       small bundle of notable days (+ lead 1-3 day forecasts)
//   public/data/weather/manifest.json                        file list, bytes, sha256, schema, models, period
//
// Data: Open-Meteo (https://open-meteo.com/), CC BY 4.0. Free tier is NON-COMMERCIAL only and limited to
// 600 calls/min, 5,000/hour, 10,000/day (weighted: >10 variables or >14 days count as fractional extra calls).
// A full run is 114 requests, ~1,984 weighted calls (logged from the X-RateLimit-Cost response header), ~6 min.
// Schema + conventions: docs/research/data_and_validation.md (section 8).

import { mkdir, readFile, writeFile, access, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "public", "data", "weather");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const FORCE = !!args.force;
const ONLY = args.only ? String(args.only).split(",") : null;
const DELAY_MS = Number(args.delay ?? 1000);
const UA = "zill-heat-strain-research/1.0 (Future Health Digital Innovation Challenge; non-commercial prototype)";

const TZ = "Asia/Dubai"; // UTC+4 all year, no DST
const UTC_OFFSET_S = 14400;

const SITES = [
  { id: "musaffah", name: "Musaffah industrial area", lat: 24.35, lon: 54.50, kind: "industrial" },
  { id: "kezad", name: "Khalifa Port / KEZAD", lat: 24.80, lon: 54.65, kind: "port-industrial" },
  { id: "ruwais", name: "Ruwais industrial city", lat: 24.11, lon: 52.73, kind: "industrial" },
  { id: "alain", name: "Al Ain", lat: 24.21, lon: 55.74, kind: "inland" },
  { id: "saadiyat", name: "Saadiyat Island", lat: 24.53, lon: 54.43, kind: "coastal-construction" },
];

// Validation points = airport METAR stations (IEM AE__ASOS metadata), used with cell_selection=nearest and =land.
const POINTS = [
  { id: "omaa", icao: "OMAA", name: "Abu Dhabi Intl (Zayed Intl) Airport", lat: 24.43, lon: 54.65, station: { lat: 24.433, lon: 54.6511, elevation_m: 27 } },
  { id: "omad", icao: "OMAD", name: "Al Bateen Executive Airport", lat: 24.43, lon: 54.46, station: { lat: 24.4283, lon: 54.4581, elevation_m: 3 } },
  { id: "omal", icao: "OMAL", name: "Al Ain Intl Airport", lat: 24.26, lon: 55.61, station: { lat: 24.2617, lon: 55.6092, elevation_m: 262 } },
];

// Everything the Liljegren WBGT needs from a weather model (2 m wind is NOT available from Open-Meteo:
// wind_speed_2m returns null; derive it from wind_speed_10m).
const VARS = [
  "temperature_2m", "relative_humidity_2m", "dew_point_2m", "surface_pressure", "wind_speed_10m",
  "shortwave_radiation", "direct_radiation", "diffuse_radiation", "direct_normal_irradiance", "cloud_cover",
];
const VAR_META = {
  temperature_2m: { unit: "°C", valid: "instant", desc: "Air temperature at 2 m" },
  relative_humidity_2m: { unit: "%", valid: "instant", desc: "Relative humidity at 2 m" },
  dew_point_2m: { unit: "°C", valid: "instant", desc: "Dew point at 2 m" },
  surface_pressure: { unit: "hPa", valid: "instant", desc: "Surface (station-level) pressure, not MSL" },
  wind_speed_10m: { unit: "m/s", valid: "instant", desc: "Wind speed at 10 m (wind_speed_unit=ms)" },
  shortwave_radiation: { unit: "W/m²", valid: "preceding_hour_mean", desc: "Global horizontal irradiance (GHI), mean of the hour ending at the timestamp" },
  direct_radiation: { unit: "W/m²", valid: "preceding_hour_mean", desc: "Direct (beam) irradiance on the HORIZONTAL plane, preceding-hour mean" },
  diffuse_radiation: { unit: "W/m²", valid: "preceding_hour_mean", desc: "Diffuse horizontal irradiance (DHI), preceding-hour mean" },
  direct_normal_irradiance: { unit: "W/m²", valid: "preceding_hour_mean", desc: "Direct normal irradiance (DNI) = direct_radiation / daylight-mean cos(zenith) over the hour (zenith capped at 87°)" },
  cloud_cover: { unit: "%", valid: "instant", desc: "Total cloud cover" },
};

const ARCHIVE_YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
const ARCHIVE_MODELS = ["era5", "ecmwf_ifs"]; // ecmwf_ifs == archive best_match at these sites (verified 2020 & 2025)
const PREV_YEARS = [2024, 2025]; // Previous Runs archive starts Jan-Mar 2024 for the models below
const PREV_MODELS = ["ecmwf_ifs025", "dwd_icon_seamless", "ncep_gfs_seamless"];
const PREV_LEADS = [0, 1, 2, 3];
const LEAD_DEFINITION = "dN = value for the same valid time taken from runs issued ~24*N h earlier. Open-Meteo builds each dN series by discarding the first 24*N h of every run and stitching steps 24N..24N+(update interval-1) h of successive runs (6-hourly global models: d1 = leads 24-29 h, d2 = 48-53 h, d3 = 72-77 h). d0 = the plain variable = most recent run (leads 0-5 h), i.e. a short-range/analysis proxy.";
const VALIDATION_YEAR = 2025;
// cell_selection=land returned the same grid cells as =nearest for all three airports (checked 2026-11-09),
// so only the nearest-cell variants are stored.
const VALIDATION_VARIANTS = [
  { key: "era5@nearest", model: "era5", cell: "nearest" },
  { key: "era5_land@nearest", model: "era5_land", cell: "nearest" },
  { key: "era5_seamless@nearest", model: "era5_seamless", cell: "nearest" },
  { key: "ecmwf_ifs@nearest", model: "ecmwf_ifs", cell: "nearest" },
];
const VALIDATION_VARS = ["temperature_2m", "dew_point_2m", "relative_humidity_2m", "wind_speed_10m", "surface_pressure", "pressure_msl", "shortwave_radiation", "direct_radiation", "cloud_cover"];

// Demo days use the IFS 9 km archive: same model as the live forecast (best_match = ecmwf_ifs in the UAE) and
// comparable skill to ERA5 vs METAR (see docs/research/data_and_validation.md, section 5).
const DEMO_MODEL = "ecmwf_ifs";
const DEMO_FORECAST_MODEL = "ecmwf_ifs025";
const DEMO_SITES = ["musaffah", "saadiyat"];
const DEMO_SEASON_YEAR = 2025;
const NOVEMBER = { site: "musaffah", year: 2025, start: "2025-11-01", end: "2025-11-30" };
// Fixed picks chosen OFFLINE with the full Liljegren WBGT (thermofeel 2.3.0 oracle on the ecmwf_ifs archive, summer 2025;
// see docs/research/data_and_validation.md section 6). The proxy above cannot see sun/wind effects, so the true
// peak-WBGT day is pinned here for reproducibility.
const EXTRA_DEMO_DAYS = [
  { site: "musaffah", date: "2025-08-01", tag: "peak_wbgt_liljegren", why: "Rank 1 of 122 summer-2025 days by daily-max Liljegren WBGT at Musaffah (40.2 °C; thermofeel 2.3.0 oracle, ecmwf_ifs archive)" },
  { site: "saadiyat", date: "2025-07-21", tag: "peak_wbgt_liljegren", why: "Rank 1 of 122 summer-2025 days by daily-max Liljegren WBGT at Saadiyat (38.5 °C; thermofeel 2.3.0 oracle, ecmwf_ifs archive)" },
];

const API = {
  archive: "https://archive-api.open-meteo.com/v1/archive",
  previous: "https://previous-runs-api.open-meteo.com/v1/forecast",
};

const SOURCE_NOTE = {
  provider: "Open-Meteo.com",
  licence: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
  attribution_html: "<a href=\"https://open-meteo.com/\">Weather data by Open-Meteo.com</a>",
  underlying: {
    era5: "ERA5 hourly reanalysis, Copernicus Climate Change Service (C3S) — contains modified Copernicus Climate Change Service information",
    era5_land: "ERA5-Land, Copernicus Climate Change Service (C3S)",
    era5_seamless: "ERA5-Land (T/RH/Td) merged with ERA5 (wind, radiation, pressure), C3S",
    ecmwf_ifs: "ECMWF IFS HRES 9 km (O1280) analysis/short-range series assembled by Open-Meteo, ECMWF data CC BY 4.0",
    ecmwf_ifs025: "ECMWF IFS 0.25° open data (3-hourly output interpolated to hourly by Open-Meteo), CC BY 4.0",
    dwd_icon_seamless: "DWD ICON global/EU/D2 seamless (global ~11 km at these sites), CC BY 4.0",
    ncep_gfs_seamless: "NOAA NCEP GFS 0.11°/0.25° seamless (US Government open data)",
  },
  changes: "Re-packaged into column arrays; values not modified.",
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => access(p).then(() => true, () => false);
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
let totalCost = 0;
let requestCount = 0;
let lastRequestAt = 0;

async function getJson(url, { tries = 6 } = {}) {
  const gap = Date.now() - lastRequestAt;
  if (lastRequestAt && gap < DELAY_MS) await sleep(DELAY_MS - gap);
  let wait = 5000;
  for (let i = 1; i <= tries; i++) {
    lastRequestAt = Date.now();
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    } catch (e) {
      if (i === tries) throw e;
      console.warn(`  network error (${e.message}); retry ${i}/${tries - 1} in ${wait / 1000}s`);
      await sleep(wait); wait *= 2; continue;
    }
    const cost = Number(res.headers.get("x-ratelimit-cost") ?? 0);
    if (res.ok) {
      totalCost += cost; requestCount++;
      const j = await res.json();
      if (j.error) throw new Error(`API error: ${j.reason} :: ${url}`);
      return { json: j, cost };
    }
    const body = await res.text();
    if ([429, 500, 502, 503, 504].includes(res.status) && i < tries) {
      const ra = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait;
      console.warn(`  HTTP ${res.status} (${body.slice(0, 120)}); retry ${i}/${tries - 1} in ${ms / 1000}s`);
      await sleep(ms); wait *= 2; continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 400)}`);
  }
}

function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  return u.toString().replace(/%2C/g, ","); // keep commas readable in logged/stored URLs
}

// Validate the time axis returned in local ISO (timezone=Asia/Dubai) and convert to t0 + step.
function checkTimeAxis(j, startDate, endDate) {
  if (j.utc_offset_seconds !== UTC_OFFSET_S) throw new Error(`unexpected utc_offset_seconds ${j.utc_offset_seconds}`);
  const t = j.hourly.time;
  const t0 = Date.parse(`${t[0]}:00+04:00`);
  const expectedN = Math.round((Date.parse(`${endDate}T00:00:00+04:00`) - Date.parse(`${startDate}T00:00:00+04:00`)) / 3600000) + 24;
  if (t[0] !== `${startDate}T00:00`) throw new Error(`time axis starts at ${t[0]}, expected ${startDate}T00:00`);
  if (t.length !== expectedN) throw new Error(`time axis length ${t.length}, expected ${expectedN}`);
  for (let i = 1; i < t.length; i++) {
    if (Date.parse(`${t[i]}:00+04:00`) - Date.parse(`${t[i - 1]}:00+04:00`) !== 3600000) throw new Error(`non-hourly step at ${t[i - 1]} -> ${t[i]}`);
  }
  return { start_local: t[0], end_local: t.at(-1), t0_unix: t0 / 1000, step_seconds: 3600, n: t.length };
}

const nullCount = (a) => a.reduce((n, x) => n + (x === null ? 1 : 0), 0);

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const s = JSON.stringify(obj);
  await writeFile(path, s);
  return Buffer.byteLength(s);
}

const siteMeta = (s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, kind: s.kind });
const timeDoc = (axis) => ({
  timezone: TZ, utc_offset_seconds: UTC_OFFSET_S, ...axis,
  rule: "time[i] (UTC epoch s) = t0_unix + i*step_seconds; local wall time = UTC+4 (no DST). Radiation at index i is the mean over [time[i]-1h, time[i]).",
});

// ---------------------------------------------------------------------------------------------
// Stage (a): ARCHIVE — Historical Weather API
// ---------------------------------------------------------------------------------------------
async function fetchArchiveBlock(lat, lon, start, end, model, vars = VARS, cell = "land") {
  const url = buildUrl(API.archive, {
    latitude: lat, longitude: lon, start_date: start, end_date: end, hourly: vars, models: model,
    timezone: TZ, wind_speed_unit: "ms", cell_selection: cell,
  });
  const { json: j, cost } = await getJson(url);
  const axis = checkTimeAxis(j, start, end);
  const columns = {}; const nulls = {};
  for (const v of vars) {
    const a = j.hourly[v];
    if (!a || a.length !== axis.n) throw new Error(`variable ${v} missing or wrong length for ${model}`);
    columns[v] = a; nulls[v] = nullCount(a);
  }
  return {
    axis, cost,
    block: {
      grid: { lat: j.latitude, lon: j.longitude, elevation_m: j.elevation, cell_selection: cell },
      request_url: url, fetched_at: new Date().toISOString(), null_counts: nulls, columns,
    },
  };
}

async function stageArchive() {
  const jobs = [];
  for (const site of SITES) for (const year of ARCHIVE_YEARS) jobs.push({ site, year, start: `${year}-06-01`, end: `${year}-09-30`, file: join(OUT, "archive", `${site.id}_${year}.json`) });
  const nov = SITES.find((s) => s.id === NOVEMBER.site);
  jobs.push({ site: nov, year: NOVEMBER.year, start: NOVEMBER.start, end: NOVEMBER.end, file: join(OUT, "archive", `${nov.id}_${NOVEMBER.start.slice(0, 7)}.json`) });
  for (const job of jobs) {
    if (!FORCE && (await exists(job.file))) { console.log(`skip (exists) ${rel(job.file)}`); continue; }
    const models = {}; let axis;
    for (const m of ARCHIVE_MODELS) {
      const r = await fetchArchiveBlock(job.site.lat, job.site.lon, job.start, job.end, m);
      axis = r.axis; models[m] = r.block;
      console.log(`  archive ${job.site.id} ${job.start}..${job.end} ${m}: grid ${r.block.grid.lat},${r.block.grid.lon} nulls=${Object.values(r.block.null_counts).reduce((a, b) => a + b, 0)} cost=${r.cost.toFixed(2)}`);
    }
    const doc = {
      schema: "zill.weather.archive/v1",
      site: siteMeta(job.site),
      period: { start_date: job.start, end_date: job.end },
      time: timeDoc(axis),
      variables: Object.fromEntries(VARS.map((v) => [v, VAR_META[v]])),
      models,
      source: { api: "Open-Meteo Historical Weather API (archive-api.open-meteo.com/v1/archive)", ...SOURCE_NOTE },
    };
    const bytes = await writeJson(job.file, doc);
    console.log(`wrote ${rel(job.file)} (${(bytes / 1024).toFixed(0)} KiB)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Stage (b): PREVIOUS RUNS — fixed lead-time offsets day0..day3
// ---------------------------------------------------------------------------------------------
const leadName = (v, d) => (d === 0 ? v : `${v}_previous_day${d}`);

async function fetchPreviousBlock(lat, lon, start, end, model, vars = VARS, leads = PREV_LEADS) {
  const hourly = vars.flatMap((v) => leads.map((d) => leadName(v, d)));
  const url = buildUrl(API.previous, {
    latitude: lat, longitude: lon, start_date: start, end_date: end, hourly, models: model,
    timezone: TZ, wind_speed_unit: "ms", cell_selection: "land",
  });
  const { json: j, cost } = await getJson(url);
  const axis = checkTimeAxis(j, start, end);
  const columns = {}; const coverage = {};
  for (const v of vars) {
    columns[v] = {}; coverage[v] = {};
    for (const d of leads) {
      const a = j.hourly[leadName(v, d)];
      if (!a || a.length !== axis.n) throw new Error(`variable ${leadName(v, d)} missing or wrong length for ${model}`);
      columns[v][`d${d}`] = a; coverage[v][`d${d}`] = axis.n - nullCount(a);
    }
  }
  return {
    axis, cost,
    block: {
      grid: { lat: j.latitude, lon: j.longitude, elevation_m: j.elevation, cell_selection: "land" },
      request_url: url, fetched_at: new Date().toISOString(), non_null_counts: coverage, columns,
    },
  };
}

async function stagePrevious() {
  for (const site of SITES) for (const year of PREV_YEARS) {
    const file = join(OUT, "previous-runs", `${site.id}_${year}.json`);
    if (!FORCE && (await exists(file))) { console.log(`skip (exists) ${rel(file)}`); continue; }
    const start = `${year}-06-01`; const end = `${year}-09-30`;
    const models = {}; let axis;
    for (const m of PREV_MODELS) {
      const r = await fetchPreviousBlock(site.lat, site.lon, start, end, m);
      axis = r.axis; models[m] = r.block;
      const minCov = Math.min(...Object.values(r.block.non_null_counts).flatMap((o) => Object.values(o)));
      console.log(`  previous ${site.id} ${year} ${m}: grid ${r.block.grid.lat},${r.block.grid.lon} min non-null=${minCov}/${axis.n} cost=${r.cost.toFixed(2)}`);
    }
    const doc = {
      schema: "zill.weather.previous_runs/v1",
      site: siteMeta(site),
      period: { start_date: start, end_date: end },
      time: timeDoc(axis),
      leads: {
        days: PREV_LEADS,
        definition: LEAD_DEFINITION,
      },
      variables: Object.fromEntries(VARS.map((v) => [v, VAR_META[v]])),
      models,
      source: { api: "Open-Meteo Previous Runs API (previous-runs-api.open-meteo.com/v1/forecast)", ...SOURCE_NOTE },
    };
    const bytes = await writeJson(file, doc);
    console.log(`wrote ${rel(file)} (${(bytes / 1024).toFixed(0)} KiB)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Stage (validation): airport grid points for the METAR comparison
// ---------------------------------------------------------------------------------------------
async function stageValidation() {
  const start = `${VALIDATION_YEAR}-06-01`; const end = `${VALIDATION_YEAR}-09-30`;
  for (const p of POINTS) {
    const pointMeta = { id: p.id, icao: p.icao, name: p.name, lat: p.lat, lon: p.lon, station: p.station };
    // (1) reanalysis / analysis variants at the airport grid point
    const file = join(OUT, "validation", `${p.id}_${VALIDATION_YEAR}.json`);
    if (!FORCE && (await exists(file))) {
      console.log(`skip (exists) ${rel(file)}`);
    } else {
      const variants = {}; let axis;
      for (const v of VALIDATION_VARIANTS) {
        const r = await fetchArchiveBlock(p.lat, p.lon, start, end, v.model, VALIDATION_VARS, v.cell);
        axis = r.axis; variants[v.key] = { model: v.model, ...r.block };
        console.log(`  validation ${p.id} ${v.key}: grid ${r.block.grid.lat},${r.block.grid.lon} elev ${r.block.grid.elevation_m} cost=${r.cost.toFixed(2)}`);
      }
      const doc = {
        schema: "zill.weather.validation_point/v1",
        point: pointMeta,
        period: { start_date: start, end_date: end },
        time: timeDoc(axis),
        variables: Object.fromEntries(VALIDATION_VARS.map((v) => [v, VAR_META[v] ?? { unit: "hPa", valid: "instant", desc: "Mean sea-level pressure" }])),
        models: variants,
        source: { api: "Open-Meteo Historical Weather API (archive-api.open-meteo.com/v1/archive)", ...SOURCE_NOTE },
      };
      const bytes = await writeJson(file, doc);
      console.log(`wrote ${rel(file)} (${(bytes / 1024).toFixed(0)} KiB)`);
    }
    // (2) lead day0..day3 forecasts at the same airport point (forecast skill vs METAR)
    const pfile = join(OUT, "validation", `${p.id}_${VALIDATION_YEAR}_previous.json`);
    if (!FORCE && (await exists(pfile))) { console.log(`skip (exists) ${rel(pfile)}`); continue; }
    const models = {}; let axis;
    for (const m of PREV_MODELS) {
      const r = await fetchPreviousBlock(p.lat, p.lon, start, end, m);
      axis = r.axis; models[m] = r.block;
      console.log(`  validation-previous ${p.id} ${m}: grid ${r.block.grid.lat},${r.block.grid.lon} cost=${r.cost.toFixed(2)}`);
    }
    const doc = {
      schema: "zill.weather.previous_runs/v1",
      point: pointMeta,
      period: { start_date: start, end_date: end },
      time: timeDoc(axis),
      leads: { days: PREV_LEADS, definition: LEAD_DEFINITION },
      variables: Object.fromEntries(VARS.map((v) => [v, VAR_META[v]])),
      models,
      source: { api: "Open-Meteo Previous Runs API (previous-runs-api.open-meteo.com/v1/forecast)", ...SOURCE_NOTE },
    };
    const bytes = await writeJson(pfile, doc);
    console.log(`wrote ${rel(pfile)} (${(bytes / 1024).toFixed(0)} KiB)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Stage (c): DEMO DAYS
// ---------------------------------------------------------------------------------------------
// Ranking proxy only (NOT the Zill WBGT): shade WBGT screening estimate WBGT_shade = 0.7*Tw + 0.3*Ta, i.e. the
// WBGT formula with Tnwb ~ psychrometric wet bulb and Tglobe ~ Ta (no solar/wind term, so it under-reads in sun).
// Tw from Stull (2011, doi:10.1175/JAMC-D-11-0143.1), valid RH 5-99 %, Ta -20..50 degC, sea-level pressure.
const stullTw = (t, rh) => t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331)
  + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
const wbgtShade = (t, rh) => (t === null || rh === null ? null : 0.7 * Math.min(stullTw(t, rh), t) + 0.3 * t);
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

function dailyStats(block, axis) {
  const c = block.columns; const days = [];
  for (let i0 = 0; i0 + 24 <= axis.n; i0 += 24) {
    const idx = [...Array(24).keys()].map((k) => i0 + k);
    const date = new Date((axis.t0_unix + i0 * 3600 + UTC_OFFSET_S) * 1000).toISOString().slice(0, 10);
    const T = idx.map((i) => c.temperature_2m[i]); const RH = idx.map((i) => c.relative_humidity_2m[i]);
    const TD = idx.map((i) => c.dew_point_2m[i]); const G = idx.map((i) => c.shortwave_radiation[i]); const CC = idx.map((i) => c.cloud_cover[i]);
    const W = idx.map((k, h) => wbgtShade(T[h], RH[h]));
    const TW = idx.map((k, h) => (T[h] === null || RH[h] === null ? null : Math.min(stullTw(T[h], RH[h]), T[h])));
    const day = idx.map((_, h) => G[h] !== null && G[h] > 0);
    let wMax = -Infinity; let wHour = null;
    W.forEach((w, h) => { if (day[h] && w !== null && w > wMax) { wMax = w; wHour = h; } });
    const valid = (a) => a.filter((x) => x !== null);
    const mean = (a) => { const v = valid(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    days.push({
      date, i0,
      tmax_c: Math.max(...valid(T)), tmin_c: Math.min(...valid(T)), td_mean_c: r1(mean(TD)), td_max_c: Math.max(...valid(TD)),
      rh_min_pct: Math.min(...valid(RH)), rh_max_pct: Math.max(...valid(RH)), ghi_max_wm2: Math.max(...valid(G)),
      daytime_cloud_mean_pct: r1(mean(CC.filter((_, h) => day[h]))),
      tw_stull_max_c: r1(Math.max(...valid(TW))),
      wbgt_shade_proxy_daylight_max_c: r1(wMax), wbgt_shade_proxy_max_hour_local: wHour === null ? null : `${String(wHour).padStart(2, "0")}:00`,
    });
  }
  return days;
}

function sliceDay(block, i0) {
  return Object.fromEntries(VARS.map((v) => [v, block.columns[v].slice(i0, i0 + 24)]));
}

async function forecastLeadsForDay(site, date) {
  // Prefer the cached previous-runs file (summers); otherwise fetch just that day.
  const year = Number(date.slice(0, 4));
  const file = join(OUT, "previous-runs", `${site.id}_${year}.json`);
  if (PREV_YEARS.includes(year) && date.slice(5, 7) >= "06" && date.slice(5, 7) <= "09" && (await exists(file))) {
    const doc = JSON.parse(await readFile(file, "utf8"));
    const b = doc.models[DEMO_FORECAST_MODEL];
    const i0 = Math.round((Date.parse(`${date}T00:00:00+04:00`) / 1000 - doc.time.t0_unix) / 3600);
    const leads = {};
    for (const d of [1, 2, 3]) leads[`d${d}`] = Object.fromEntries(VARS.map((v) => [v, b.columns[v][`d${d}`].slice(i0, i0 + 24)]));
    return { model: DEMO_FORECAST_MODEL, grid: b.grid, from: rel(file), leads };
  }
  const r = await fetchPreviousBlock(site.lat, site.lon, date, date, DEMO_FORECAST_MODEL, VARS, [1, 2, 3]);
  const leads = {};
  for (const d of [1, 2, 3]) leads[`d${d}`] = Object.fromEntries(VARS.map((v) => [v, r.block.columns[v][`d${d}`]]));
  return { model: DEMO_FORECAST_MODEL, grid: r.block.grid, from: r.block.request_url, leads };
}

async function stageDemo() {
  const file = join(OUT, "demo-days.json");
  if (!FORCE && (await exists(file))) { console.log(`skip (exists) ${rel(file)}`); return; }
  const picks = [];
  for (const siteId of DEMO_SITES) {
    const site = SITES.find((s) => s.id === siteId);
    const f = join(OUT, "archive", `${siteId}_${DEMO_SEASON_YEAR}.json`);
    if (!(await exists(f))) throw new Error(`demo needs ${rel(f)} — run --only=archive first`);
    const doc = JSON.parse(await readFile(f, "utf8"));
    const block = doc.models[DEMO_MODEL];
    const stats = dailyStats(block, doc.time);
    const top = (key) => stats.reduce((a, b) => (b[key] > a[key] ? b : a));
    const rules = [
      { tag: "peak_wbgt_proxy", key: "wbgt_shade_proxy_daylight_max_c", why: (d) => `Highest daylight shade-WBGT screening proxy of summer ${DEMO_SEASON_YEAR}: ${d.wbgt_shade_proxy_daylight_max_c} °C at ${d.wbgt_shade_proxy_max_hour_local} local (ranking only; full Liljegren WBGT in sun is higher)` },
      { tag: "most_humid", key: "td_mean_c", why: (d) => `Highest daily-mean dew point of summer ${DEMO_SEASON_YEAR}: ${d.td_mean_c} °C` },
      { tag: "hottest_dry_bulb", key: "tmax_c", why: (d) => `Highest air temperature of summer ${DEMO_SEASON_YEAR}: ${d.tmax_c} °C (contrast: dry heat vs humid heat)` },
    ];
    for (const rule of rules) {
      const d = top(rule.key);
      const existing = picks.find((p) => p.site.id === siteId && p.date === d.date);
      if (existing) { existing.tags.push(rule.tag); existing.why.push(rule.why(d)); continue; }
      picks.push({ site, date: d.date, tags: [rule.tag], why: [rule.why(d)], summary: d, block, archiveFile: rel(f) });
    }
    for (const x of EXTRA_DEMO_DAYS.filter((e) => e.site === siteId)) {
      const existing = picks.find((p) => p.site.id === siteId && p.date === x.date);
      if (existing) { existing.tags.push(x.tag); existing.why.push(x.why); continue; }
      const d = stats.find((s) => s.date === x.date);
      if (!d) throw new Error(`extra demo day ${x.date} not in ${rel(f)}`);
      picks.push({ site, date: d.date, tags: [x.tag], why: [x.why], summary: d, block, archiveFile: rel(f) });
    }
  }
  // Mild November day: lowest daylight WBGT proxy among mostly clear days (daytime mean cloud <= 30 %).
  {
    const site = SITES.find((s) => s.id === NOVEMBER.site);
    const f = join(OUT, "archive", `${site.id}_${NOVEMBER.start.slice(0, 7)}.json`);
    if (!(await exists(f))) throw new Error(`demo needs ${rel(f)} — run --only=archive first`);
    const doc = JSON.parse(await readFile(f, "utf8"));
    const block = doc.models[DEMO_MODEL];
    const stats = dailyStats(block, doc.time);
    const clear = stats.filter((d) => d.daytime_cloud_mean_pct !== null && d.daytime_cloud_mean_pct <= 30);
    const pool = clear.length ? clear : stats;
    const d = pool.reduce((a, b) => (b.wbgt_shade_proxy_daylight_max_c < a.wbgt_shade_proxy_daylight_max_c ? b : a));
    picks.push({ site, date: d.date, tags: ["mild_november"], why: [`Mildest mostly-clear November ${NOVEMBER.year} day (lowest daylight shade-WBGT proxy ${d.wbgt_shade_proxy_daylight_max_c} °C)`], summary: d, block, archiveFile: rel(f) });
  }
  const days = [];
  for (const p of picks) {
    const fc = await forecastLeadsForDay(p.site, p.date);
    const { i0, ...summary } = p.summary;
    days.push({
      id: `${p.site.id}_${p.date}`, site: siteMeta(p.site), date: p.date, tags: p.tags, why: p.why, summary,
      analysis: { model: DEMO_MODEL, grid: p.block.grid, from: p.archiveFile, t0_local: `${p.date}T00:00`, t0_unix: Date.parse(`${p.date}T00:00:00+04:00`) / 1000, step_seconds: 3600, n: 24, hourly: sliceDay(p.block, i0) },
      forecast: fc,
    });
    console.log(`  demo ${p.site.id} ${p.date} [${p.tags.join(",")}]`);
  }
  const doc = {
    schema: "zill.weather.demo_days/v1",
    generated_at: new Date().toISOString(),
    timezone: TZ, utc_offset_seconds: UTC_OFFSET_S,
    selection: {
      season: `${DEMO_SEASON_YEAR}-06-01..${DEMO_SEASON_YEAR}-09-30 local, sites ${DEMO_SITES.join(", ")}; plus November ${NOVEMBER.year} at ${NOVEMBER.site}`,
      analysis_model: DEMO_MODEL,
      forecast_model: `${DEMO_FORECAST_MODEL} (Previous Runs API leads d1..d3 for the same valid hours)`,
      wbgt_proxy: "Ranking proxy only, NOT the Zill WBGT: shade WBGT screening estimate = 0.7*Tw + 0.3*Ta (°C), Tw = Stull (2011) psychrometric wet bulb from Ta and RH (capped at Ta); no solar or wind term, so it under-reads WBGT in direct sun. Daily max over hours with shortwave_radiation > 0.",
      rules: ["peak_wbgt_proxy = max daylight shade-WBGT proxy", "most_humid = max daily-mean dew point", "hottest_dry_bulb = max daily Tmax", "peak_wbgt_liljegren = fixed offline pick (EXTRA_DEMO_DAYS) = rank 1 by daily-max Liljegren WBGT", "mild_november = min daylight shade-WBGT proxy among days with daytime mean cloud cover <= 30 %"],
    },
    time_rule: "hourly arrays have 24 entries, index h = local hour h:00 (Asia/Dubai, UTC+4). Radiation at h is the mean over [h-1, h).",
    variables: Object.fromEntries(VARS.map((v) => [v, VAR_META[v]])),
    days,
    source: SOURCE_NOTE,
  };
  const bytes = await writeJson(file, doc);
  console.log(`wrote ${rel(file)} (${(bytes / 1024).toFixed(0)} KiB, ${days.length} days)`);
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else if (e.name.endsWith(".json") && e.name !== "manifest.json") out.push(p);
  }
  return out.sort();
}

async function stageManifest() {
  const files = [];
  let total = 0;
  for (const p of await walk(OUT)) {
    const buf = await readFile(p);
    const st = await stat(p);
    let schema = null; let models = null; let period = null;
    try { const j = JSON.parse(buf.toString("utf8")); schema = j.schema ?? null; models = j.models ? Object.keys(j.models) : null; period = j.period ?? null; } catch { /* ignore */ }
    files.push({ path: rel(p).replace(/^public\//, ""), bytes: st.size, sha256: createHash("sha256").update(buf).digest("hex"), schema, models, period });
    total += st.size;
  }
  const manifest = {
    schema: "zill.weather.manifest/v1",
    generated_at: new Date().toISOString(),
    generator: "scripts/data/fetch-weather.mjs",
    file_count: files.length, total_bytes: total,
    attribution_html: SOURCE_NOTE.attribution_html, licence: SOURCE_NOTE.licence,
    files,
  };
  await writeJson(join(OUT, "manifest.json"), manifest);
  console.log(`manifest: ${files.length} data files, ${(total / 1048576).toFixed(2)} MiB (+ manifest.json)`);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  await mkdir(OUT, { recursive: true });
  const t0 = Date.now();
  const stages = [["archive", stageArchive], ["previous", stagePrevious], ["validation", stageValidation], ["demo", stageDemo], ["manifest", stageManifest]];
  for (const [name, fn] of stages) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`== stage ${name}`);
    await fn();
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${requestCount} API requests, weighted cost ${totalCost.toFixed(1)} calls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
