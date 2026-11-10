#!/usr/bin/env node
// Zill — fetch METAR observations from the Iowa Environmental Mesonet (IEM) ASOS/METAR archive.
//
// Dependency-free Node >= 18 ESM (uses global fetch). Tested with Node 24.
//
//   node scripts/data/fetch-obs.mjs            # download (skips files that already exist)
//   node scripts/data/fetch-obs.mjs --force    # re-download everything
//
// Output (relative to the project root):
//   public/data/obs/<ICAO>_<start>_<end>_metar_routine.csv   raw IEM CSV, UTC timestamps (provenance copy)
//   public/data/obs/<ICAO>_<year>_summer.json                parsed routine METARs (schema zill.obs.metar/v1)
//
// Service documentation: https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help
// IEM enforces a 1 request/second per-IP throttle (changelog 2026-04-21) and returns 429/503 when
// overloaded, so requests are sequential with >= 1.5 s spacing and retried with back-off.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "public", "data", "obs");
const FORCE = process.argv.includes("--force");
const UA = "zill-heat-strain-research/1.0 (Future Health Digital Innovation Challenge; data pipeline)";

// Stations: metadata from https://mesonet.agron.iastate.edu/geojson/network/AE__ASOS.geojson
const STATIONS = [
  { icao: "OMAA", name: "Abu Dhabi International (Zayed International) Airport", lat: 24.433, lon: 54.6511, elevation_m: 27, nearestSite: "kezad/musaffah (validation point)" },
  { icao: "OMAD", name: "Abu Dhabi Al Bateen Executive Airport", lat: 24.4283, lon: 54.4581, elevation_m: 3, nearestSite: "saadiyat" },
  { icao: "OMAL", name: "Al Ain International Airport", lat: 24.2617, lon: 55.6092, elevation_m: 262, nearestSite: "alain" },
];

// Summer window in local time (Asia/Dubai = UTC+4, no DST): 1 Jun 00:00 -> 1 Oct 00:00 local,
// i.e. 31 May 20:00Z -> 30 Sep 20:00Z. We request whole UTC days around it and keep everything.
const WINDOWS = [{ year: 2025, sts: "2025-05-31T00:00Z", ets: "2025-10-01T00:00Z" }];

const KT_TO_MS = 0.514444; // 1 knot = 1852 m / 3600 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => access(p).then(() => true, () => false);

async function fetchText(url, { tries = 6 } = {}) {
  let wait = 3000;
  for (let i = 1; i <= tries; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA } });
    } catch (e) {
      if (i === tries) throw e;
      console.warn(`  network error (${e.message}); retry ${i}/${tries - 1} in ${wait / 1000}s`);
      await sleep(wait); wait *= 2; continue;
    }
    if (res.ok) return res.text();
    if ([429, 500, 502, 503, 504].includes(res.status) && i < tries) {
      const ra = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait;
      console.warn(`  HTTP ${res.status}; retry ${i}/${tries - 1} in ${ms / 1000}s`);
      await sleep(ms); wait *= 2; continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}\n${(await res.text()).slice(0, 400)}`);
  }
}

function iemUrl(icao, sts, ets) {
  const p = new URLSearchParams();
  p.append("station", icao);
  for (const d of ["tmpf", "dwpf", "relh", "drct", "sknt", "gust", "alti", "mslp", "vsby", "skyc1", "skyl1", "skyc2", "skyl2", "wxcodes", "metar"]) p.append("data", d);
  p.append("sts", sts);
  p.append("ets", ets);
  p.append("tz", "Etc/UTC");
  p.append("format", "onlycomma");
  p.append("latlon", "yes");
  p.append("elev", "yes");
  p.append("missing", "M");
  p.append("trace", "T");
  p.append("direct", "no");
  p.append("report_type", "3"); // 3 = routine METAR only (4 = SPECI, 1 = HFMETAR US-only)
  return `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${p.toString()}`;
}

// Minimal RFC-4180-ish CSV line splitter (IEM 'onlycomma' output has no quoted commas in these columns,
// but the METAR column may in principle contain commas; handle quotes defensively).
function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}

const num = (s) => (s === undefined || s === "M" || s === "" || s === "null" ? null : Number(s));
const round = (x, d) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// METAR temperature group "TT/DD" with optional M prefix for negatives, e.g. "34/25", "M01/M05", "34/".
function parseTempGroup(metar) {
  const m = metar.match(/\s(M?\d{2})\/(M?\d{2})?(?=\s|$)/);
  if (!m) return { t: null, td: null };
  const conv = (s) => (s ? (s.startsWith("M") ? -Number(s.slice(1)) : Number(s)) : null);
  return { t: conv(m[1]), td: conv(m[2]) };
}
const parseQnh = (metar) => { const m = metar.match(/\sQ(\d{4})(?=\s|$)/); return m ? Number(m[1]) : null; };
const parseCavok = (metar) => /\sCAVOK(?=\s|$)/.test(metar);

function parseIemCsv(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const header = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const metar = f[idx.metar] ?? "";
    const validUtc = f[idx.valid].replace(" ", "T") + "Z"; // IEM 'valid' is in the requested tz (Etc/UTC)
    const g = parseTempGroup(" " + metar);
    const tmpf = num(f[idx.tmpf]); const dwpf = num(f[idx.dwpf]);
    rows.push({
      valid_utc: validUtc,
      // Exact METAR integer degC when the group parses; else fall back to IEM degF converted.
      temp_c: g.t ?? (tmpf === null ? null : round((tmpf - 32) / 1.8, 1)),
      dewpoint_c: g.td ?? (dwpf === null ? null : round((dwpf - 32) / 1.8, 1)),
      rh_pct: round(num(f[idx.relh]), 1),
      wind_dir_deg: num(f[idx.drct]),
      wind_speed_ms: round(num(f[idx.sknt]) === null ? null : num(f[idx.sknt]) * KT_TO_MS, 2),
      gust_ms: round(num(f[idx.gust]) === null ? null : num(f[idx.gust]) * KT_TO_MS, 2),
      qnh_hpa: parseQnh(" " + metar) ?? (num(f[idx.alti]) === null ? null : round(num(f[idx.alti]) * 33.8639, 1)),
      visibility_km: num(f[idx.vsby]) === null ? null : round(num(f[idx.vsby]) * 1.609344, 1), // IEM vsby is statute miles
      cavok: parseCavok(" " + metar),
      wx: f[idx.wxcodes] === "M" ? null : f[idx.wxcodes],
      sky1: f[idx.skyc1] === "M" ? null : f[idx.skyc1],
      metar,
    });
  }
  return rows;
}

function toLocalIso(utcIso, offsetSeconds = 14400) {
  const t = Date.parse(utcIso) + offsetSeconds * 1000;
  return new Date(t).toISOString().slice(0, 16); // naive local wall time
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let first = true;
  const summary = [];
  for (const w of WINDOWS) {
    for (const st of STATIONS) {
      const tag = `${w.sts.slice(0, 10)}_${w.ets.slice(0, 10)}`;
      const csvPath = join(OUT_DIR, `${st.icao}_${tag}_metar_routine.csv`);
      const jsonPath = join(OUT_DIR, `${st.icao}_${w.year}_summer.json`);
      const url = iemUrl(st.icao, w.sts, w.ets);
      let csv;
      if (!FORCE && (await exists(csvPath))) {
        console.log(`skip download (exists): ${csvPath}`);
        csv = await readFile(csvPath, "utf8");
      } else {
        if (!first) await sleep(1500);
        first = false;
        console.log(`GET ${url}`);
        csv = await fetchText(url);
        if (!csv.startsWith("station,valid")) throw new Error(`Unexpected IEM response for ${st.icao}: ${csv.slice(0, 200)}`);
        await writeFile(csvPath, csv);
      }
      if (!FORCE && (await exists(jsonPath))) { console.log(`skip parse (exists): ${jsonPath}`); summary.push({ icao: st.icao, csvPath, jsonPath }); continue; }
      const rows = parseIemCsv(csv);
      const cols = {};
      for (const k of Object.keys(rows[0] ?? {})) if (k !== "metar") cols[k] = rows.map((r) => r[k]);
      cols.valid_local = rows.map((r) => toLocalIso(r.valid_utc));
      const onHour = rows.filter((r) => r.valid_utc.slice(14, 16) === "00").length;
      const doc = {
        schema: "zill.obs.metar/v1",
        station: { icao: st.icao, name: st.name, lat: st.lat, lon: st.lon, elevation_m: st.elevation_m, network: "AE__ASOS", note: st.nearestSite },
        source: {
          provider: "Iowa Environmental Mesonet (IEM), Iowa State University — ASOS/METAR archive",
          request_url: url,
          fetched_at: new Date().toISOString(),
          report_types: "3 = routine METAR only (SPECI excluded)",
          raw_csv: csvPath.slice(ROOT.length + 1).replace(/\\/g, "/"),
        },
        time: {
          basis: "valid_utc is the METAR observation time in UTC (ISO 8601, Z). valid_local = UTC+4 (Asia/Dubai, no DST), naive wall time.",
          window_utc: [w.sts, w.ets],
        },
        units: {
          temp_c: "°C — integer precision (METAR TT/DD group); quantisation ±0.5 °C",
          dewpoint_c: "°C — integer precision (METAR TT/DD group)",
          rh_pct: "% — computed by IEM from the integer T/Td",
          wind_dir_deg: "degrees true (null = VRB or calm)",
          wind_speed_ms: "m/s (converted from knots × 0.514444), 10 m anemometer, 2-min mean (METAR convention)",
          gust_ms: "m/s",
          qnh_hpa: "hPa — QNH from METAR Q group (sea-level-reduced; NOT surface pressure)",
          visibility_km: "km (IEM statute miles × 1.609344)",
          cavok: "boolean",
          wx: "present-weather codes (e.g. HZ, DU, BR, FG)",
          sky1: "lowest cloud layer cover code (FEW/SCT/BKN/OVC)",
        },
        stats: { n_reports: rows.length, n_on_the_hour: onHour, first: rows[0]?.valid_utc, last: rows.at(-1)?.valid_utc },
        columns: cols,
      };
      await writeFile(jsonPath, JSON.stringify(doc));
      console.log(`wrote ${jsonPath}  (${rows.length} routine reports, ${onHour} on the hour)`);
      summary.push({ icao: st.icao, csvPath, jsonPath, n: rows.length });
    }
  }
  console.log("done:", JSON.stringify(summary.map((s) => ({ icao: s.icao, n: s.n })), null, 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
