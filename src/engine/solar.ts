/**
 * Solar geometry for the outdoor WBGT model: a port of the NOAA Solar Calculator (Meeus, "Astronomical Algorithms"),
 * returning the **apparent** (refraction-corrected) zenith that Liljegren's wbgt.c uses (docs/research/wbgt_liljegren.md
 * §10.2, decision D4). NOAA states the algorithm is "only valid for dates between 1901 and 2099".
 *
 * Verified against the oracle's `noaa_solar()` to ≤ 1e-9 and against NREL SPA (pvlib `nrel_numpy`) to ≤ 0.03° zenith
 * (§10.3; Abu Dhabi 2025: max 0.0159° zenith, 2.76e-4 cos z). Pure functions: the instant is always passed in as epoch
 * milliseconds (UTC).
 */

import { MINUTE_MS } from './time'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** Python-style floating modulo (result has the sign of the divisor), matching the oracle's `%`. */
function pyMod(x: number, m: number): number {
  const r = x % m
  return r < 0 ? r + m : r
}

/** Full NOAA solar-position result. Angles in degrees; `earthSunAu` in astronomical units. */
export interface SolarPosition {
  julianDay: number
  declinationDeg: number
  /** Equation of time, minutes. */
  eqOfTimeMin: number
  /** Hour angle in [−180, 180) degrees (negative before solar noon). */
  hourAngleDeg: number
  /** Geometric (unrefracted) zenith. */
  zenithDeg: number
  /** Atmospheric refraction added to the elevation (NOAA piecewise formula). */
  refractionDeg: number
  /** Apparent (refraction-corrected) zenith — the one Liljegren's model uses. */
  apparentZenithDeg: number
  /** Apparent elevation = 90° − apparent zenith. */
  apparentElevationDeg: number
  /** cos of the geometric zenith, clamped to [−1, 1]. */
  cosZenith: number
  /** cos of the apparent zenith (= sin of the apparent elevation). Use this in the WBGT model (D4). */
  cosApparentZenith: number
  /** Earth–Sun distance R (AU). */
  earthSunAu: number
}

/**
 * Julian Day of an epoch-ms instant: JD = unix_seconds/86400 + 2440587.5 (NOAA Solar Calculator; wbgt_liljegren.md
 * §10.2).
 */
export function julianDayFromEpochMs(tMs: number): number {
  return tMs / 86_400_000 + 2440587.5
}

/**
 * NOAA Solar Calculator (Meeus) position for a Julian Day at latitude (°N) / longitude (°E). Transcribed term by term
 * from wbgt_liljegren.md §10.2: geometric mean longitude/anomaly, eccentricity, equation of centre, apparent longitude,
 * corrected obliquity, declination, equation of time, true solar time, hour angle, zenith, then NOAA's piecewise
 * refraction (0 above 85°; Sæmundsson-type series above 5°; polynomial above −0.575°; −20.772/tan(el) below) and
 * cza = sin(el + refraction).
 */
export function solarPositionFromJulianDay(jd: number, latDeg: number, lonDeg: number): SolarPosition {
  const T = (jd - 2451545.0) / 36525.0
  const L0 = pyMod(280.46646 + T * (36000.76983 + T * 0.0003032), 360.0)
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
  const Cc =
    Math.sin(D2R * M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(D2R * 2 * M) * (0.019993 - 0.000101 * T) +
    Math.sin(D2R * 3 * M) * 0.000289
  const trueAnomaly = M + Cc
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(D2R * trueAnomaly))
  const omega = 125.04 - 1934.136 * T
  const lambda = L0 + Cc - 0.00569 - 0.00478 * Math.sin(D2R * omega)
  const eps0 = 23.0 + (26.0 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60.0) / 60.0
  const eps = eps0 + 0.00256 * Math.cos(D2R * omega)
  const decl = R2D * Math.asin(Math.sin(D2R * eps) * Math.sin(D2R * lambda))
  const y = Math.tan((D2R * eps) / 2.0) ** 2
  const eot =
    4.0 *
    R2D *
    (y * Math.sin(2 * D2R * L0) -
      2 * e * Math.sin(D2R * M) +
      4 * e * y * Math.sin(D2R * M) * Math.cos(2 * D2R * L0) -
      0.5 * y * y * Math.sin(4 * D2R * L0) -
      1.25 * e * e * Math.sin(2 * D2R * M))
  const tst = pyMod(pyMod(jd + 0.5, 1.0) * 1440.0 + eot + 4.0 * lonDeg, 1440.0)
  const ha = tst / 4.0 - 180.0
  let cz =
    Math.sin(D2R * latDeg) * Math.sin(D2R * decl) + Math.cos(D2R * latDeg) * Math.cos(D2R * decl) * Math.cos(D2R * ha)
  cz = Math.max(-1.0, Math.min(1.0, cz))
  const zen = R2D * Math.acos(cz)
  const elev = 90.0 - zen
  let refr: number
  if (elev > 85.0) {
    refr = 0.0
  } else {
    const te = Math.tan(D2R * elev)
    if (elev > 5.0) refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
    else if (elev > -0.575) refr = 1735.0 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))
    else refr = -20.772 / te
    refr /= 3600.0
  }
  const app = elev + refr
  return {
    julianDay: jd,
    declinationDeg: decl,
    eqOfTimeMin: eot,
    hourAngleDeg: ha,
    zenithDeg: zen,
    refractionDeg: refr,
    apparentZenithDeg: 90.0 - app,
    apparentElevationDeg: app,
    cosZenith: cz,
    cosApparentZenith: Math.sin(D2R * app),
    earthSunAu: R,
  }
}

/** NOAA solar position at an epoch-ms instant (UTC). See `solarPositionFromJulianDay` (wbgt_liljegren.md §10.2). */
export function solarPosition(tMs: number, latDeg: number, lonDeg: number): SolarPosition {
  return solarPositionFromJulianDay(julianDayFromEpochMs(tMs), latDeg, lonDeg)
}

/**
 * Solar constant used by Liljegren's wbgt.c for the top-of-atmosphere irradiance, 1367 W/m² (wbgt_liljegren.md §4,
 * SOLAR_CONST; §11).
 */
export const SOLAR_CONSTANT_WM2 = 1367

/**
 * Top-of-atmosphere irradiance on a horizontal surface, TOA = 1367·max(cos z, 0)/R² [W/m²] (wbgt.c
 * `calc_solar_parameters`; wbgt_liljegren.md §11). The WBGT model additionally sets TOA = 0 when cos z < CZA_MIN
 * (0.00873); that cut-off is applied in wbgt.ts, not here.
 */
export function toaHorizontalWm2(cosZenith: number, earthSunAu: number): number {
  return (SOLAR_CONSTANT_WM2 * Math.max(cosZenith, 0)) / (earthSunAu * earthSunAu)
}

/** Solar geometry for an averaging window ending at `tEndMs`, evaluated at the window midpoint. */
export interface HourMeanSolarPosition extends SolarPosition {
  /** Instant at which the geometry was evaluated: tEndMs − avgMin/2. */
  tEvalMs: number
}

/**
 * Solar geometry for radiation averaged over (t_end − avg, t_end]: evaluate at **t_end − avg/2** (wbgt_liljegren.md
 * §13.3 step 1, decision D5). Open-Meteo radiation is the "preceding hour mean", so avgMin = 60 gives t_end − 30 min,
 * exactly wbgt.c's own convention (`minute − 0.5·avg`, §10.1). avgMin = 0 returns the instantaneous geometry. Never mix
 * hour-mean GHI with the instantaneous zenith at t_end (§13.5).
 */
export function hourMeanSolarPosition(
  tEndMs: number,
  latDeg: number,
  lonDeg: number,
  avgMin = 60,
): HourMeanSolarPosition {
  const tEvalMs = tEndMs - (avgMin / 2) * MINUTE_MS
  return { ...solarPosition(tEvalMs, latDeg, lonDeg), tEvalMs }
}

/** Mean solar elevation statistics over an interval (midpoint-rule samples of the apparent elevation). */
export interface DaylightMeanElevation {
  /** Mean sin(apparent elevation) over the sunlit samples only (0 when the sun is down throughout). */
  sunlitMeanSinElevation: number
  /** Fraction of the interval with the sun above the (apparent) horizon, 0–1. */
  sunlitFraction: number
  /**
   * Mean of max(sin(apparent elevation), 0) over the whole interval = sunlitMeanSinElevation × sunlitFraction. For an
   * hour-mean horizontal direct irradiance this is the divisor that recovers the hour-mean DNI when DNI is steady.
   */
  intervalMeanSinElevation: number
}

/**
 * Daylight-mean sin(elevation) over [tStartMs, tEndMs] with `samples` midpoint samples (the sunlit-only mean
 * cos(apparent zenith) of Kong & Huber's `coszda` / Hogan & Hirahara 2016; wbgt_liljegren.md §13.3 step 5). With a
 * 60-minute window and 60 samples it reproduces the oracle's `sunlit_mean_cos_zenith` (fixture fields
 * `cos_zenith_sunlit_mean_info`, `sunlit_fraction_info`). Used to relate hour-mean direct radiation to DNI; on hourly
 * data the WBGT itself changes ≤ 0.01 °C versus the midpoint geometry (§13.5), so the model keeps the midpoint.
 */
export function daylightMeanSinElevation(
  tStartMs: number,
  tEndMs: number,
  latDeg: number,
  lonDeg: number,
  samples = 60,
): DaylightMeanElevation {
  const n = Math.max(1, Math.floor(samples))
  const step = (tEndMs - tStartMs) / n
  let sum = 0
  let lit = 0
  for (let k = 0; k < n; k++) {
    const s = solarPosition(tStartMs + (k + 0.5) * step, latDeg, lonDeg).cosApparentZenith
    if (s > 0) {
      sum += s
      lit++
    }
  }
  const sunlitMeanSinElevation = lit > 0 ? sum / lit : 0
  const sunlitFraction = lit / n
  return { sunlitMeanSinElevation, sunlitFraction, intervalMeanSinElevation: sunlitMeanSinElevation * sunlitFraction }
}
