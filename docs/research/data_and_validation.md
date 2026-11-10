# Zill — real-data pipeline and validation datasets

*Data endpoints, conventions, cached datasets, measured comparisons, licensing, and the validation design. Researched and checked by running the code on **2026-11-09**. Every number below that is not tagged as coming from documentation came from a request or calculation run that day.*

Tags used: **[VERIFIED]** = reproduced by a request or calculation · **[DOCS]** = quoted from the provider's documentation · **[INFERRED]** = reasoned from evidence, not stated by the provider · **[UNVERIFIED]** = could not be confirmed (see §11).

---

## 1. Summary (what the engine team needs)

| Topic | Decision or fact |
|---|---|
| Live forecast source | Open-Meteo Forecast API. In the UAE, `best_match` **is** ECMWF IFS HRES 9 km for every hour within the IFS horizon. Measured at Musaffah: 350 of 353 hourly T values were identical. Past the IFS horizon (about 15 days), `best_match` blends into GFS, which runs out to 16 days. Request `models=ecmwf_ifs` explicitly so the output is deterministic. [VERIFIED] |
| Variables for Liljegren WBGT | `temperature_2m, relative_humidity_2m, dew_point_2m, surface_pressure, wind_speed_10m, shortwave_radiation, direct_radiation, diffuse_radiation, direct_normal_irradiance, cloud_cover`, all available in Forecast, Archive (ERA5, IFS) and Previous Runs (IFS 0.25°, ICON, GFS). **There is no 2 m wind**: `wind_speed_2m` returns `null` with unit `"undefined"`. [VERIFIED] |
| Radiation convention | All radiation fields are the **mean over the preceding hour** `[t−1h, t)`. Request `*_instant` for values at `t`, or convert with the closed-form factor in §3.3. The factor reproduces the API's instant values to within 0.6 W/m² after the first daylight hour. [DOCS + VERIFIED] |
| Time | Use `timezone=Asia/Dubai`, which gives `utc_offset_seconds=14400` (UTC+4, no DST). Timestamps are local wall time without an offset suffix. The cached files store `t0_unix` (UTC epoch) and use an implicit 3600 s step. [VERIFIED] |
| Archive model for back-tests | Both models are stored. **ERA5** (0.25°) is homogeneous across 1940–present. **ECMWF IFS 9 km** is identical to archive `best_match` at these sites and is the same model as the live forecast. Against METAR, the two give similar WBGT skill (§6). [VERIFIED] |
| Forecast-skill data | Previous Runs API, leads d0–d3, summers 2024 and 2025. Primary model `ecmwf_ifs025`; comparison models `dwd_icon_seamless` and `ncep_gfs_seamless`. IFS **9 km** previous runs only start on **2025-10-01**. `best_match` previous runs mix models: d0 is IFS, d1+ is ICON. Do not use `best_match` for skill work. [VERIFIED] |
| ERA5 vs OMAA METAR, summer 2025 | Nearest ERA5 cell (24.50 N, 54.75 E), n = 2,927 h. **T: bias +0.13 °C, RMSE 1.25 °C, r 0.960. Td: bias +0.86 °C, RMSE 2.87 °C, r 0.822.** [VERIFIED] |
| Best forecast model for humidity (WBGT) in the UAE | ECMWF. Lead d1–d3 Td bias at OMAA: **GFS −3.1 to −4.0 °C** (dry), **ICON +2.1 to +2.3 °C** (humid), **IFS 0.25° −0.2 to 0.0 °C**. This propagates to a WBGT bias of −1.6 to −1.8 °C for GFS, +1.1 to +1.2 °C for ICON and −0.1 °C for IFS. [VERIFIED] |
| Licence | Data are CC BY 4.0, with the attribution link "Weather data by Open-Meteo.com". The free API is **non-commercial only**. The commercial plan with historical data and Previous Runs is **API Professional: €99/month or €1,099/year**. [DOCS] |
| Cached data | `public/data/weather/` holds **49 files, 26,601,610 bytes (25.37 MiB)**. `public/data/obs/` holds **6 files, 2,094,090 bytes (2.00 MiB)**. A full download costs about 1,984 weighted API calls (archive 527 + previous runs 1,046 + validation 94 + validation previous runs 314 + demo 3). The measured wall time was about 6 minutes; allow up to 10. [VERIFIED] |

---

## 2. Endpoints at a glance

| Purpose | Endpoint | Notes |
|---|---|---|
| Live forecast | `https://api.open-meteo.com/v1/forecast` | `forecast_days` 0–16 (default 7). The API returns `{"error":true,"reason":"Forecast days is invalid. Allowed range 0 to 16. Given 17."}` for 17. `past_days` is documented as 0–92, but `past_days=93` was accepted in a test. [VERIFIED] |
| Reanalysis / analysis archive | `https://archive-api.open-meteo.com/v1/archive` | `start_date` and `end_date` (yyyy-mm-dd) are required. Model parameter names all tested: `best_match, ecmwf_ifs, ecmwf_ifs_analysis_long_window, era5_seamless, era5, era5_land, era5_ensemble, cerra`. `cerra` returns "No data is available for this location" in the UAE because it covers Europe only. [VERIFIED] |
| Stitched past forecasts | `https://historical-forecast-api.open-meteo.com/v1/forecast` | Same parameters as the forecast endpoint. [DOCS] |
| Fixed-lead past forecasts | `https://previous-runs-api.open-meteo.com/v1/forecast` | Variables `<var>_previous_day1…7`. `<var>_previous_day0` is an alias of `<var>`. [VERIFIED] |
| Individual runs | `https://single-runs-api.open-meteo.com/v1/forecast?...&run=YYYY-MM-DDTHH:MM` | IFS HRES 9 km from 2024-03-14. Other models from 2026-04-02. [DOCS + VERIFIED] |
| Model freshness | `https://api.open-meteo.com/data/<model>/static/meta.json` | Gives `last_run_initialisation_time`, `last_run_availability_time`, `temporal_resolution_seconds`, `update_interval_seconds` and `data_end_time`. Works for `ecmwf_ifs, ecmwf_ifs025, ncep_gfs013, dwd_icon`. [VERIFIED] |
| METAR observations | `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py` | IEM. Throttled to one request per second per IP. [DOCS + VERIFIED] |
| Commercial | `customer-api.open-meteo.com` + `&apikey=` | "The server URL requires the prefix `customer-`". [DOCS] |

---

## 3. Forecast API (live product)

### 3.1 Request template (verified)

```
https://api.open-meteo.com/v1/forecast?latitude=24.35&longitude=54.50
  &hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,
          shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,cloud_cover,is_day
  &models=ecmwf_ifs&wind_speed_unit=ms&timezone=Asia%2FDubai&forecast_days=7
```

Response metadata at Musaffah: `latitude 24.358522, longitude 54.498936` (the IFS O1280 cell), `elevation 6`, `utc_offset_seconds 14400`, `timezone "Asia/Dubai"`, `timezone_abbreviation "GMT+4"`. [VERIFIED]

### 3.2 Variables, units and valid time

Units are from `hourly_units` in a live response with `wind_speed_unit=ms`. Valid-time conventions are from the hourly parameter table in the docs.

| Variable | Unit (API string) | Valid time | Notes |
|---|---|---|---|
| `temperature_2m` | `°C` | instant | |
| `relative_humidity_2m` | `%` | instant | integer values |
| `dew_point_2m` | `°C` | instant | |
| `surface_pressure` | `hPa` | instant | station-level pressure, not MSL. Use this for psychrometrics. |
| `wind_speed_10m` | `m/s` | instant | the default unit is km/h, so always send `wind_speed_unit=ms` |
| `shortwave_radiation` | `W/m²` | **preceding hour mean** | GHI |
| `direct_radiation` | `W/m²` | **preceding hour mean** | beam on the **horizontal** plane |
| `diffuse_radiation` | `W/m²` | **preceding hour mean** | DHI |
| `direct_normal_irradiance` | `W/m²` | **preceding hour mean** | DNI (see §3.3) |
| `cloud_cover` | `%` | instant | total |
| `is_day` | `""` (dimensionless) | instant | "1 if the current time step has daylight, 0 at night" |
| `wet_bulb_temperature_2m` | `°C` | instant | **psychrometric** wet bulb from the Stull formula (§3.4). It is **not** the natural wet-bulb Tnwb. |
| `*_instant` (e.g. `shortwave_radiation_instant`) | `W/m²` | instant | derived from the backward mean (§3.3) |
| `wind_speed_2m` | `"undefined"` | — | **not a valid variable**. Every value is `null`. [VERIFIED] |

Docs quote: "Solar radiation is averaged over the past hour. Use instant for radiation at the indicated time." Also: "By default, the Open-Meteo API provides backward-averaged solar radiation to simplify energy calculations." [DOCS]

### 3.3 Radiation: backward means, instant values and DNI

**Convention.** The value stamped at `t` is the mean over `[t−1 h, t)`. Evidence from the live forecast at Musaffah on 2026-11-09 at 08:00 local: `shortwave_radiation = 133` and `shortwave_radiation_instant = 205.1`. On a rising morning curve, the preceding-hour mean is smaller than the instant value at the end of the hour, which matches the convention. [VERIFIED]

**Backward-to-instant factor.** This is a port of Open-Meteo `Zensun.backwardsAveragedToInstantFactor` (commit `97132c5`). Use it with Spencer (1971) solar geometry.

```ts
// Inputs: tEndUnix = timestamp at the END of the hour (UTC s); lat, lon in degrees; dt = 3600 s.
// Spencer (1971) as in pvlib 0.16.1: G = 2*PI/365*(doy-1), doy = UTC day-of-year of tEndUnix
//   decl[rad] = 0.006918 - 0.399912cosG + 0.070257sinG - 0.006758cos2G + 0.000907sin2G - 0.002697cos3G + 0.00148sin3G
//   eot[min]  = (1440/(2*PI)) * (0.0000075 + 0.001868cosG - 0.032077sinG - 0.014615cos2G - 0.040849sin2G)
export function backwardToInstantFactor(tEndUnix: number, lat: number, lon: number, declRad: number, eotMin: number, dt = 3600): number {
  const D = Math.PI / 180, eqt = eotMin / 60;
  const ut = (((tEndUnix % 86400) + 86400) % 86400) / 3600;          // UT hours
  const t1 = Math.PI / 2 - declRad;                                      // solar colatitude
  const p1 = -15 * (ut - 12 + eqt) * D;                                  // solar "longitude" at t_end
  const p10 = -15 * (ut - dt / 3600 - 12 + eqt) * D;                     // at t_start (p decreases with time)
  const t0 = (90 - lat) * D;                                             // colatitude of the point
  let p0 = lon * D;
  if (p0 < p1 - Math.PI) p0 += 2 * Math.PI;
  if (p0 > p1 + Math.PI) p0 -= 2 * Math.PI;
  const arg = -(Math.cos(t0) * Math.cos(t1)) / (Math.sin(t0) * Math.sin(t1));
  const carg = arg > 1 || arg < -1 ? Math.PI : Math.acos(arg);
  const sunrise = p0 + carg, sunset = p0 - carg;
  if (p10 < sunset || p1 > sunrise) return 0;                            // whole hour is night
  const pa = Math.min(sunrise, p10), pb = Math.max(sunset, p1);          // clip to daylight
  const F = (p: number) => Math.sin(t0) * Math.sin(t1) * Math.sin(p - p0) + p * Math.cos(t0) * Math.cos(t1);
  const zzBack = Math.abs((F(pa) - F(pb)) / (p10 - p1));                 // mean sin(elev) over the FULL hour (night = 0)
  const zzInst = Math.cos(t0) * Math.cos(t1) + Math.sin(t0) * Math.sin(t1) * Math.cos(p1 - p0);
  return zzBack <= 0 || zzInst <= 0 ? 0 : zzInst / zzBack;
}
// instant = backwardMean * factor   (the same factor applies to GHI, direct and diffuse)
```

**Test vector.** IFS archive cell at 24.358522 N, 54.498936 E, on 2025-07-15, local time UTC+4. Each entry is local hour: backward GHI → API instant → this formula. [VERIFIED]

`07: 69 → 117.1 → 116.5` · `08: 227 → 290.4 → 290.1` · `09: 423 → 490.7 → 490.5` · `10: 610 → 670.0 → 669.7` · `11: 761 → 804.1 → 804.0` · `12: 858 → 878.4 → 878.3` · `13: 890 → 884.8 → 884.7` · sunrise hour `06: 2 → 18.3 → 17.6`

Use a tolerance of ±1 % after the first daylight hour. Open-Meteo uses its own solar-position lookup, so it is not bit-identical to Spencer.

**DNI.** Port of `Zensun.calculateBackwardsDNI`. Take `direct_radiation` (horizontal, preceding-hour mean) and divide by the mean of sin(elevation) over the **sunlit part** of the hour only. The day length is shortened by 3° of hour angle on each side, and the divisor is floored at sin 3°, so `DNI = DIR_h / max(mean sin(elev) over the sunlit interval, sin 3°)`. The solar constant in that code is 1367.7 W/m². [VERIFIED source]

**Direct-beam fraction for Liljegren.** `fdir = direct_radiation / shortwave_radiation`. Both are backward means, so the instant factor cancels and either pair can be used. thermofeel clamps `fdir` to [0, 0.9] and sets it to 0 when the zenith angle is at or above 89.5°. [VERIFIED source, thermofeel 2.3.0]

**Is `direct_radiation` native model output or derived?** It depends on the model. Source at commit `97132c5`:

* **`ecmwf_ifs`** (the ECPDS IFS HRES domain, which maps `.ifs → .ecmwf_ifs`): native. `direct_radiation` maps to GRIB `fdir`.
* **`era5`**: native, from `total_sky_direct_solar_radiation_at_surface`.
* **`ecmwf_ifs025`** (open data): derived. Only `ssrd` (GHI) is ingested, so diffuse and direct come from the Razo–Müller–Witwer decomposition in `Zensun.calculateDiffuseRadiationBackwards`. The diffuse fraction is `kd = f(kt, aoi)`, a 10-term cubic polynomial. GHI counts as fully diffuse when sin(elev) ≤ 5/1367.7.

Since `best_match` in the UAE is `ecmwf_ifs`, the live direct radiation is native IFS. For forecast-skill work across models, compute `fdir` from GHI alone, using Liljegren's formula as in `wbgt_liljegren.md` D6. That keeps the inputs comparable between models with native and derived beam radiation. [VERIFIED source]

**ECPDS IFS HRES output steps** (`EcmwfEcpdsDomain.swift`):

* 00/12 UTC runs: hourly 0–90 h, then 3-hourly 93–144 h, then 6-hourly 150–360 h.
* 06/18 UTC runs: hourly 0–90 h, then 3-hourly 93–144 h.

So the live forecast is **natively hourly for the first 90 h**. Beyond that, Open-Meteo interpolates to hourly. [VERIFIED source]

### 3.4 Quantities Open-Meteo derives internally (Meteorology.swift, commit `97132c5`)

* **Wet bulb** (`wet_bulb_temperature_2m`) uses the Stull (2011) formula and returns `min(Tw, T)`:
  `Tw = T·atan(0.151977·√(RH+8.313659)) + atan(T+RH) − atan(RH−1.676331) + 0.00391838·RH^1.5·atan(0.023101·RH) − 4.686035`
  (atan in radians). Stated validity is RH 5–99 % and T −20 to 50 °C at sea-level pressure. It ignores pressure and is a **psychrometric** wet bulb, so it must not be used as Tnwb in `WBGT = 0.7·Tnwb + 0.2·Tg + 0.1·Ta`. [VERIFIED source]
* **RH ↔ dew point** use Magnus with β = 17.625 and λ = 243.04 °C:
  `RH = 100·exp(β·Td/(λ+Td)) / exp(β·T/(λ+T))`, clamped to [0, 100]. [VERIFIED source]
* **10 m → 2 m wind is not provided.** Common choices are listed below. Pick one in the engine and document it.
  * FAO-56 log law, as in Open-Meteo `scaleWindFactor`: `u2 = u10 · 4.87/ln(67.8·10 − 5.42) = 0.748·u10`.
  * Bröde log law with z0 = 0.01 m, as in thermofeel `scale_windspeed`: `u_h = u10·log10(h/0.01)/3`, which gives `u2 = 0.767·u10` and `u1.1 = 0.680·u10`.
  * KNMI/Liljegren power law with a Pasquill stability class, the thermofeel default: `u2 = u10·(2/10)^p`, floored at 0.13 m/s. The 10 m wind is first floored at 0.62 m/s. [VERIFIED source]

### 3.5 Models for the UAE

* Docs: *"Every forecast is built on a global backbone of DWD ICON, NOAA GFS and ECMWF IFS… 🌍 Everywhere else: Global models only… For each weather variable and forecast hour, the highest-resolution model takes precedence."* [DOCS]
* Measured on 2026-11-09 at Musaffah with `forecast_days=16`:
  * `best_match` equalled `ecmwf_ifs` for 350 of 353 hours, until IFS ended at 2026-11-23T16:00 local. The first difference was at 14:00 that day (a blending window).
  * `best_match` then continues to 2026-11-24T22:00 local. GFS also ends at 2026-11-24T22:00.
  * `ecmwf_ifs025` ends at 2026-11-23T18:00 and `icon_seamless` at 2026-11-16T04:00.
  * [VERIFIED]
* ECMWF open data: the 00/12 UTC runs output "0 to 144 by 3, 150 to 360 by 6" and the 06/18 UTC runs "0 to 144 by 3". IFS open data also exists at 0.1° "from 20 October 2026". ECMWF moved to an open-data policy on **1 October 2025** (Open-Meteo blog, 2025-10-01). [DOCS]
* Run-latency snapshot taken at about 03:13 UTC from `meta.json`, for the 2026-11-08 18 UTC runs. [VERIFIED]

  | Model | Available at | Latency | Time step | Update interval |
  |---|---|---|---|---|
  | `ecmwf_ifs` | 00:14 UTC | 6.24 h | 3600 s | 21600 s |
  | `ecmwf_ifs025` | 01:08 UTC | 7.14 h | **10800 s** (3-hourly, interpolated to hourly) | — |
  | `ncep_gfs013` | — | 5.41 h | — | — |
  | `dwd_icon` | — | 4.06 h | — | — |

* **Recommendation:** use `models=ecmwf_ifs` for days 0–7, which is also what the validation in §6 supports. If days 8–16 are shown, label them low confidence. The `best_match` tail is GFS, which has a strong dry bias here (§6.4).

### 3.6 Time conventions

* `timezone=Asia/Dubai` gives ISO timestamps such as `"2025-06-01T00:00"` (local, no suffix) and `utc_offset_seconds = 14400`. Docs: *"DST changes within the requested range are ignored"*. This does not matter here because the UAE has no DST. [DOCS + VERIFIED]
* In the archive and Previous Runs APIs, `start_date` and `end_date` are local dates when a timezone is set. The first timestamp returned was `YYYY-06-01T00:00` local, which is 20:00 UTC on 31 May. [VERIFIED]
* The METAR time axis is UTC. The match `model_local − 4 h = METAR UTC` was checked by lagged RMSE: the minimum is at lag 0 for every station and model (§6.2). [VERIFIED]

### 3.7 CORS, rate limits and call weighting

* **CORS:** `curl -I` without an `Origin` header returns **no** ACAO header. With `Origin:` (which browsers always send cross-origin), every Open-Meteo host returns the headers below. This was checked on api, archive-api, previous-runs-api, historical-forecast-api and single-runs-api. An OPTIONS preflight to api.open-meteo.com returned 200 with the same headers. [VERIFIED]

  ```
  access-control-allow-origin: *
  access-control-allow-methods: GET, POST, OPTIONS
  access-control-max-age: 600
  access-control-expose-headers: x-ratelimit-cost, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-window, retry-after
  ```

  IEM also sends `Access-Control-Allow-Origin: *`. [VERIFIED]
* **Free tier** (Terms, quoted): *"Less than 10'000 API calls per day, 5'000 per hour and 600 per minute."* The pricing table also lists **300,000 calls / month**. Response headers show `X-RateLimit-Limit: 600.0` and `X-RateLimit-Window: 60`. [DOCS + VERIFIED]
* **Weighting:** *"Requests for data covering more than 10 weather variables or extending over a period of more than 2 weeks for a single location are considered multiple API calls… 2 weeks of data with 15 weather variables will be calculated as 1.5 API calls, while 4 weeks of data equals 3.0 API calls."* [DOCS]
  Every `X-RateLimit-Cost` header observed fits **`cost = max(1, (n_vars × n_models / 10) × max(1, n_days / 14))`**. Examples: 10 vars × 122 days = 8.714; 40 × 122 = 34.857; 9 × 122 = 7.84; 13 × 1 = 1.3; 1 × 1 = 1.0. [VERIFIED, empirical]

---

## 4. Historical data

### 4.1 Historical Weather (archive) API

**Datasets** ([DOCS], quoted table):

| Model param | Dataset | Resolution | Temporal | Coverage | Update |
|---|---|---|---|---|---|
| `ecmwf_ifs` | ECMWF IFS (assembled by Open-Meteo from 0z, 6z, 12z and 18z runs, "employing the most up-to-date version of IFS") | 9 km | hourly | 2017 → present | "Every 6 hours with no delay" |
| `era5` | ERA5 | 0.25° (~25 km) | hourly | 1940 → present | "Daily with 5 days delay" |
| `era5_land` | ERA5-Land | 0.1° (~11 km) | hourly | 1950 → present | 5 days delay |
| `era5_seamless` | ERA5-Land T/RH/Td merged with ERA5 wind and radiation | — | hourly | — | — |
| `era5_ensemble` | ERA5 ensemble | 0.5° | 3-hourly | 1940 → present | 5 days delay |
| `cerra` | CERRA | 5 km, Europe only | hourly | 1985 → June 2021 | — |
| `ecmwf_ifs_analysis_long_window` | IFS assimilation | 9 km | 6-hourly | 2024 → present | 2 days delay |

Docs: *"The default Best Match combines IFS HRES, ERA5 and ERA5-Land seamlessly."*

**Measured behaviour** [VERIFIED]:

* Archive `best_match` at Musaffah is **identical** to `ecmwf_ifs`:
  * 2,928 of 2,928 hourly T and GHI values in the full summers of 2020 and 2023;
  * every value for 2025-07-15 (all 13 variables tested);
  * 2,928 of 2,928 values in summer 2025, where Previous Runs `best_match` d0 equals archive `ecmwf_ifs`.

  Against `era5`, only 84 of 2,928 T values matched in 2020.
* **Latency:** at 2026-11-09 03:13 UTC, the last non-null value for `era5` and `era5_land` was 2026-11-03T23:00 UTC, a delay of about 5 days and 4 hours. `ecmwf_ifs` and `best_match` extended to 2026-11-09T23:00 UTC. **The last day or so of the IFS archive is therefore forecast, not analysis.**
* **Variable availability** for the 10 WBGT variables, tested at Musaffah on 2025-07-15:

| model | T, RH, Td | surface_pressure | wind_speed_10m | GHI, direct, diffuse, DNI | cloud_cover |
|---|---|---|---|---|---|
| `best_match` / `ecmwf_ifs` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `era5` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `era5_land` | ✔ | **null** | **null** | **null** | **null** |
| `era5_seamless` | ✔ (from ERA5-Land) | ✔ | ✔ | ✔ | ✔ |
| `ecmwf_ifs_analysis_long_window` | ✔ | ✔ | ✔ | **null** | ✔ |

### 4.2 Grid cells chosen at the Zill sites

The archive uses the default `cell_selection=land`. The returned `elevation` is the 90 m DEM height of the *requested* point, which Open-Meteo uses for downscaling. [VERIFIED]

| Site (requested) | ERA5 cell | IFS 9 km cell | DEM elev | Note |
|---|---|---|---|---|
| musaffah 24.35, 54.50 | 24.25, 54.50 | 24.358522, 54.498936 | 6 m | `land` and `nearest` are identical |
| kezad 24.80, 54.65 | 24.75, 54.75 | **24.710016, 54.694534** | **0 m** | The point is on water in the DEM. **IFS `nearest` is a sea cell** at 24.7803, 54.6566: on 2025-07-15 at 14:00 it gave T = 35.3 °C, against 42.4 °C in the `land` cell. Keep `land`, and consider moving the KEZAD coordinate onto land. |
| ruwais 24.11, 52.73 | 24.00, 52.75 | 24.077328, 52.738853 | 12 m | IFS sea cell would give 34.5 °C against 40.1 °C on land |
| alain 24.21, 55.74 | 24.25, 55.75 | 24.217924, 55.723408 | 275 m | |
| saadiyat 24.53, 54.43 | 24.50, 54.50 | 24.49912, 54.423077 | 6 m | The IFS land cell is about 3.5 km south of the requested point |

### 4.3 Historical Forecast API

This API gives continuous series built by stitching "each run's first few hours". Docs: *"Coverage starts around 2022."* [DOCS]

Per-model "Available since" (docs table): IFS HRES 9 km **2017-01-01** (hourly) · IFS 0.25° **2024-02-03** (3-hourly) · IFS 0.4° 2022-11-07 · AIFS 0.25° 2025-02-20 · GFS 0.11° **2021-03-23** · ICON global 0.1° **2022-11-24** · UKMO Global 10 km 2022-03-01 · ARPEGE World 2024-01-02 · GEM Global 2022-11-23 · CMA GRAPES 2023-12-31 · BOM ACCESS-G 2024-01-01 (no updates since 2025-06-26).

Measured: on 2025-07-15 at Musaffah, `historical-forecast` `best_match` returned the same T, Td and GHI as archive `ecmwf_ifs`. [VERIFIED]

### 4.4 Previous Runs API (fixed lead times)

**Variables** ([DOCS], UI list, each available for Day 0–7):

* temperature_2m, relative_humidity_2m, dew_point_2m, apparent_temperature
* precipitation, rain, showers, snowfall, weather_code
* pressure_msl, surface_pressure, cloud_cover
* wind_speed_10m, wind_direction_10m
* shortwave/direct/diffuse/DNI/GTI radiation, their `*_instant` variants, and terrestrial radiation
* wind speed and direction at 80, 100, 120, 180 and 200 m

`temperature_2m_previous_day0` is accepted and returned as `temperature_2m`. [VERIFIED]

**Lead definition** (Open-Meteo blog, 2024-04-19): *"it doesn't entail retrieving a single weather model run from 24 hours ago. Instead, the initial 24 hours of each weather model run are disregarded. In models updating every 3 hours, time steps 24, 25, and 26 are utilized… Previous day 3 = 72, 73 and 74."*

For 6-hourly global models, this means **d1 = leads 24–29 h, d2 = 48–53 h, d3 = 72–77 h, and d0 = leads 0–5 h**, a short-range proxy for the analysis. [DOCS + INFERRED for 6-hourly]

**Coverage** ([DOCS]): *"Most models are archived from January 2024… GFS 2 m temperature — available from March 2021; JMA GSM and MSM — available from 2018."*

Measured first day with data, by bisection at Musaffah. This assumes no gaps; dates are UTC. [VERIFIED]

| model | variable | first day with data |
|---|---|---|
| `best_match` | T d1 | 2024-01-19 (12 h on that day) |
| `dwd_icon_seamless` | T d1 | 2024-01-19 |
| `ncep_gfs_seamless` | DNI d1 | 2024-01-19 |
| `ncep_gfs_seamless` | T d1 | **2021-03-24** |
| `ecmwf_ifs025` | T d1 | **2024-02-04** |
| `ecmwf_ifs025` | DNI d3 | **2024-03-08** |
| `ecmwf_aifs025_single` | T d1 | 2025-02-18 |
| `ecmwf_ifs` (9 km) | T d1 | **2025-10-01**. d0 exists for all dates because it comes from the archive. |

**Support matrix for the 10 WBGT variables at d0–d3**, checked on 2024-06-15 and 2025-07-15. [VERIFIED]

* `ecmwf_ifs025`, `dwd_icon_seamless` (alias `icon_seamless`) and `ncep_gfs_seamless` (alias `gfs_seamless`): all variables at all leads, both summers. Every cached file has 2,928 of 2,928 non-null values.
* `ecmwf_ifs`: d0 only before 2025-10-01.
* `ecmwf_aifs025_single`: no data in summer 2024.
* `ukmo_global_deterministic_10km`: patchy.
* `meteofrance_arpege_world`: `wind_speed_10m` d1–d3 are null.

**`best_match` caveat:** in summer 2025 at Musaffah, `best_match` d0 matched archive `ecmwf_ifs` in 2,928 of 2,928 hours, while `best_match` d1 and d3 matched `dwd_icon_seamless` in 2,928 of 2,928. Mixing models across leads confounds skill, so **use one explicit model**. [VERIFIED]

### 4.5 Single Runs API (an option for evaluating the production model)

* Docs: *"ECMWF IFS HRES at native 9 km resolution is available from March 14, 2024 (IFS Cycle 49R1 hindcasts). From May 12, 2026 06 UTC, runs use the updated IFS Cycle 50R1."* Other models are available from 2026-04-02. IFS HRES runs 4× daily (00, 06, 12, 18 UTC) out to 15 days.
* Verified request: `run=2024-07-14T00:00&models=ecmwf_ifs&forecast_days=4`. It returned 96 hourly steps for all 10 variables at a cost of 1.0. Radiation is null at step 0, as expected for a preceding-hour mean.
* A run that is not available returns `{"reason":"The requested model run is not available. Model: …","error":true}`.
* This is the only way to score **IFS HRES 9 km** at lead 1–3 days for summers 2024 and 2025. Summer 2026 is also covered by `ecmwf_ifs` Previous Runs. [VERIFIED]

---

## 5. Observations: IEM ASOS/METAR

**Station metadata** ([VERIFIED], `https://mesonet.agron.iastate.edu/geojson/network/AE__ASOS.geojson`):

| ICAO | name | lon, lat | elev | archive from |
|---|---|---|---|---|
| OMAA | Abu Dhabi (Zayed Intl) | 54.6511, 24.4330 | 27 m | 1983-01-01 |
| OMAD | Abu Dhabi (Al Bateen) | 54.4581, 24.4283 | 3 m | 1982-12-31 |
| OMAL | Al Ain | 55.6092, 24.2617 | 262 m | 1994-03-07 |
| QGX | Al Dhafra air base, near Musaffah | 54.55, 24.25 | 23 m | 2009-02-10 → **2025-05-22** (ended) |

**Working request** (used by `scripts/data/fetch-obs.mjs`):

```
https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=OMAA
  &data=tmpf&data=dwpf&data=relh&data=drct&data=sknt&data=gust&data=alti&data=mslp&data=vsby
  &data=skyc1&data=skyl1&data=skyc2&data=skyl2&data=wxcodes&data=metar
  &sts=2025-05-31T00:00Z&ets=2025-10-01T00:00Z&tz=Etc%2FUTC&format=onlycomma&latlon=yes&elev=yes
  &missing=M&trace=T&direct=no&report_type=3
```

**Service rules** ([DOCS], asos.py help):

* `report_type`: `1` (HFMETAR), `3` (Routine), `4` (Specials).
* *"a 1 second per-IP throttle is now in place"* (changelog 2026-04-21).
* *"a practical limit of 1,000 station years"*. Larger requests get HTTP 422.
* HTTP 429 means the rate limit was exceeded and 503 means the server is overloaded.
* `data=tmpc/dwpc` also worked, although the help lists only `tmpf`/`dwpf`.

**Results** [VERIFIED]:

* 2,951 routine reports per station from 2025-05-31T00Z to 2025-09-30T23Z, all on the hour.
* **2,927 of 2,928** local summer hours are present at each station. One hour is missing at all three: 2025-09-24T03:00Z.
* No duplicates.
* Max T: OMAA 47 °C, OMAD 47 °C, OMAL 48 °C. Max Td: 31 °C at OMAA and OMAD, 29 °C at OMAL.

**Quirks:**

* METAR T and Td are **integer °C**. The script parses the `TT/DD` group, and the quantisation standard deviation is 1/√12 = 0.289 °C.
* The `Q` group is **QNH**, not MSLP. Model MSLP − QNH was +0.31 hPa at OMAA and −1.82 hPa at OMAL (262 m), as expected from the ISA-versus-actual reduction.
* METAR wind is a 10 m, 2-minute mean in knots. The script converts it with × 0.514444.

**Terms** (IEM disclaimer, quoted): *"The materials found on this website are in the public domain and may be used freely by anyone for any lawful purpose… Attributing the Iowa Environmental Mesonet of Iowa State University would be appreciated."* There is no warranty.

---

## 6. Measured comparisons

The calculations use Python in the project venv: thermofeel 2.3.0, pvlib 0.16.1 and numpy. The scripts are `validate_metar.py`, `lag_check.py`, `backtest_preview.py` and `config_sensitivity.py`. They are not in the repo, because this task could only write the files it names; they are kept in the session scratchpad. The method is fully specified here so it can be re-implemented, or the owner of `scripts/oracles/` can move the scripts there.

**Matching:** routine METAR at HH:00 UTC is paired with the model value at the same UTC instant. The error is model − obs. The window is Jun 1 00:00 to Sep 30 23:00 local, 2025, giving n = 2,927 matched hours.

### 6.1 Reanalysis/analysis vs METAR, summer 2025 (required: ERA5 at OMAA)

**OMAA (24.43, 54.65)**:

| Archive model (cell) | T bias | T RMSE | T r | Td bias | Td RMSE | Td r | RH bias / RMSE | Wind bias / RMSE (m/s) |
|---|---|---|---|---|---|---|---|---|
| **ERA5 nearest (24.50, 54.75)** | **+0.13** | **1.25** | 0.960 | **+0.86** | **2.87** | 0.822 | +2.1 / 9.6 % | −0.53 / 1.44 |
| ERA5-Land and ERA5-Seamless (24.40, 54.70) | −0.37 | 2.41 | 0.933 | −0.56 | 3.51 | 0.735 | +1.7 / 13.9 % | (ERA5) −0.53 / 1.44 |
| IFS 9 km (24.4288, 54.6532) | −0.40 | 1.83 | 0.952 | −0.16 | 2.85 | 0.832 | +2.5 / 11.0 % | −1.16 / 1.65 |

* Means over matched hours: observed T 35.63 °C and Td 21.42 °C; ERA5 T 35.76 °C and Td 22.28 °C.
* `cell_selection=land` returned the same cells as `nearest` at all three airports.
* The integer METAR quantisation contributes 0.289 °C in quadrature. Removing it lowers the ERA5 T RMSE from 1.25 to 1.22 °C.

**OMAD (24.43, 54.46) and OMAL (24.26, 55.61)**, same method:

| Station | Model | T bias / RMSE | Td bias / RMSE | Wind bias / RMSE |
|---|---|---|---|---|
| OMAD | ERA5 | −0.50 / 1.20 | +0.58 / 2.60 | +0.72 / 1.39 |
| OMAD | IFS 9 km | −0.59 / 1.68 | −0.41 / 2.50 | −0.58 / 1.15 |
| OMAD | ERA5-Land | −0.68 / 1.81 | −0.34 / 2.79 | — |
| OMAL | ERA5 | −0.83 / 1.47 | +1.41 / 3.83 | −0.49 / 1.45 |
| OMAL | IFS 9 km | −0.63 / 1.43 | −0.63 / 2.97 | −0.66 / 1.47 |
| OMAL | ERA5-Land | −1.51 / 2.15 | −0.53 / 3.51 | — |

**Reading:** ERA5-Land is worst at these coastal and desert airports, so do not use it. ERA5 has the lowest T RMSE on the coast. IFS has the lowest Td RMSE at two of the three stations and is best inland at OMAL. Both models underestimate wind at OMAA. Because higher wind lowers Liljegren WBGT in sun, an under-read wind pushes WBGT up.

### 6.2 Diurnal structure and time-alignment check

Bias by local hour at OMAA, T in °C:

* ERA5: −0.9 at 02–04 h, +1.6 at 16–17 h.
* IFS 9 km: **−2.6 at 04 h, +1.8 at 14–15 h**. The diurnal range is too large, which is a coastal-cell effect.
* IFS Td: −3.1 at 15 h. The model's sea-breeze moistening is weak.
* Daytime (07–18 h) vs night: IFS T +0.87 / −1.67; ERA5 T +0.61 / −0.35.
* Peak hours (10–16 h): IFS T bias **+1.47** (RMSE 1.93); ERA5 +0.73 (1.42).

**Lag test**, T RMSE for model(t + lag) against obs(t), lags −3 to +3 h. The minimum is at **lag 0** for every station and model. For OMAA ERA5: −1 h 1.76, **0 h 1.26**, +1 h 1.54. [VERIFIED]

### 6.3 What T/Td/wind errors do to WBGT

The comparison is Liljegren WBGT (thermofeel `calculate_wbgt_liljegren`, `wind_scaling="liljegren"`) computed two ways:

* **model-only**: all inputs from the model.
* **obs-met**: METAR T, Td (converted to RH with Magnus 17.625/243.04) and 10 m wind, with the **same** model radiation and pressure.

Radiation is converted to instant with §3.3, and cos z is the instant value at t (pvlib SPA).

| Station | Model | WBGT bias / RMSE, all hours | Daytime 07–18 | Error from T/Td alone |
|---|---|---|---|---|
| OMAA | ERA5 | +0.51 / 1.17 °C | +0.75 / 1.31 | +0.38 / 1.01 |
| OMAA | IFS 9 km | **−0.01 / 1.08** | +0.44 / 1.13 | −0.23 / 0.95 |
| OMAD | ERA5 | −0.10 / 0.95 | −0.12 / 1.04 | −0.04 / 0.86 |
| OMAD | IFS 9 km | −0.33 / 1.06 | +0.05 / 1.02 | −0.46 / 0.99 |
| OMAL | ERA5 | +0.13 / 1.20 | +0.34 / 1.23 | +0.04 / 1.09 |
| OMAL | IFS 9 km | −0.41 / 1.17 | −0.17 / 1.10 | −0.52 / 1.12 |

Obs-met WBGT at OMAA: p50 29.7 °C, p95 33.9 °C, maximum 38.4–38.5 °C. Liljegren never failed to converge (0 NaN).

**Takeaway:** analysis-quality inputs carry about **±1.0–1.2 °C RMSE** of WBGT error, before any forecast error. Zone boundaries need a margin of that size.

### 6.4 Forecast skill preview (Previous Runs, summer 2025, airports)

All values are bias / RMSE in °C against METAR, for d0 → d1 → d2 → d3. The WBGT reference is obs-met with radiation from the IFS 9 km archive. All grids use `cell_selection=land`, the production default.

| Station | Model (grid) | T | Td | WBGT |
|---|---|---|---|---|
| OMAA | `ecmwf_ifs025` (24.50, 54.75) | −0.35/1.54 → −0.60/1.83 → −0.68/1.97 → −0.75/2.13 | −0.15/2.57 → −0.17/3.02 → −0.14/3.33 → 0.00/3.73 | **−0.01/1.05 → −0.10/1.26 → −0.10/1.36 → −0.05/1.44** |
| OMAA | `dwd_icon_seamless` (24.375, 54.625) | −0.10/1.09 → −0.19/1.27 → −0.10/1.29 → +0.03/1.42 | **+1.90/3.52 → +2.34/4.14 → +2.31/4.21 → +2.08/4.28** | +1.01/1.57 → +1.17/1.79 → +1.19/1.85 → +1.13/1.85 |
| OMAA | `ncep_gfs_seamless` (24.426, 54.727) | −0.69/2.13 → −0.77/2.29 → −0.52/2.30 → −0.35/2.35 | **−2.35/3.91 → −3.14/4.79 → −3.72/5.47 → −4.03/5.98** | −1.29/1.89 → −1.64/2.26 → −1.75/2.44 → −1.79/2.56 |
| OMAD | `ecmwf_ifs025` (24.50, 54.50) | −1.14/1.66 → −1.15/1.82 → −1.25/1.95 → −1.28/2.06 | +0.26/2.25 → +0.14/2.59 → +0.29/2.84 → +0.38/3.21 | −0.29/1.05 → −0.33/1.19 → −0.28/1.27 → −0.24/1.35 |
| OMAD | `dwd_icon_seamless` (24.375, 54.50) | −0.64/1.33 → −0.71/1.48 → −0.60/1.48 → −0.47/1.53 | +1.16/2.93 → +1.54/3.41 → +1.52/3.44 → +1.36/3.52 | +0.25/1.22 → +0.40/1.36 → +0.42/1.38 → +0.41/1.43 |
| OMAD | `ncep_gfs_seamless` (24.308, 54.609)† | −0.49/1.88 → −0.56/2.04 → −0.32/2.12 → −0.14/2.19 | −4.09/5.22 → −4.87/6.11 → −5.39/6.75 → −5.70/7.20 | −2.08/2.46 → −2.43/2.86 → −2.52/3.01 → −2.55/3.12 |
| OMAL | `ecmwf_ifs025` (24.25, 55.50) | −0.73/1.39 → −0.95/1.71 → −0.96/1.81 → −0.98/1.94 | −0.44/2.92 → −0.47/3.48 → −0.66/3.88 → −0.54/4.14 | −0.35/1.16 → −0.46/1.31 → −0.49/1.44 → −0.48/1.54 |
| OMAL | `dwd_icon_seamless` (24.25, 55.625) | +0.03/1.13 → −0.01/1.41 → +0.07/1.49 → +0.14/1.53 | +1.17/3.39 → +1.52/4.27 → +1.43/4.44 → +1.17/4.54 | +0.57/1.35 → +0.74/1.58 → +0.73/1.66 → +0.67/1.69 |
| OMAL | `ncep_gfs_seamless` (24.308, 55.664) | −0.55/2.14 → −0.69/2.31 → −0.53/2.32 → −0.33/2.33 | −2.55/4.19 → −3.08/4.89 → −3.66/5.47 → −3.91/5.87 | −1.12/1.78 → −1.34/2.01 → −1.46/2.15 → −1.45/2.21 |

† With `cell_selection=land`, GFS moved the OMAD point about 18 km onto the mainland. Representativeness error is part of these numbers, as it would be in production.

**Same-model skill.** The table below scores each lead against the same model's d0 for WBGT. It pools 5 sites × summers 2024 and 2025, about 29,280 hours. Zone exceedance uses illustrative cutpoints.

| Model | Lead | Hourly WBGT bias / MAE / RMSE | Daily-max RMSE | ≥ 30 °C POD / FAR / CSI | ≥ 32 °C POD / FAR / CSI |
|---|---|---|---|---|---|
| `ecmwf_ifs025` | d1 | −0.05 / 0.57 / **0.82** | 1.05 | 0.93 / 0.07 / 0.87 | 0.90 / 0.10 / 0.82 |
| `ecmwf_ifs025` | d2 | −0.02 / 0.73 / **1.01** | 1.22 | 0.93 / 0.09 / 0.85 | 0.89 / 0.13 / 0.78 |
| `ecmwf_ifs025` | d3 | +0.01 / 0.87 / **1.20** | 1.33 | 0.91 / 0.11 / 0.82 | 0.87 / 0.17 / 0.74 |
| `ecmwf_ifs025` | 24 h persistence | −0.01 / 1.25 / 1.70 | — | — | — |
| `dwd_icon_seamless` | d1 / d2 / d3 | RMSE 0.83 / 1.02 / 1.14 | 0.97 / 1.21 / 1.28 | | |
| `ncep_gfs_seamless` | d1 / d2 / d3 | RMSE 0.78 / 1.00 / 1.10 | 1.02 / 1.24 / 1.30 | | |

Same-model scores leave out model bias, so they are optimistic. The METAR table above shows the bias.

### 6.5 Hours-in-zone preview 2020–2025

This uses Liljegren WBGT from thermofeel 2.3.0, as a reference for the TS engine. The cutpoints (28/30/32/33 °C) are **illustrative only, not Zill zone thresholds**. Values are the mean per Jun–Sep season (2,928 h). "max" is the maximum over the six seasons.

| Site | Model | p50 | p95 | max | h ≥ 28 | h ≥ 30 | h ≥ 32 | h ≥ 33 | h ≥ 30 outside midday break* |
|---|---|---|---|---|---|---|---|---|---|
| musaffah | ERA5 | 30.3 | 35.2 | 39.9 | 2,397 | 1,621 | 870 | 595 | 1,436 |
| musaffah | IFS 9 km | 30.2 | 34.5 | 40.2 | 2,370 | 1,552 | 736 | 454 | 1,368 |
| kezad | ERA5 | 30.7 | 34.9 | 39.6 | 2,598 | 1,804 | 904 | 590 | 1,618 |
| kezad | IFS 9 km | 30.2 | 34.3 | 38.6 | 2,313 | 1,561 | 768 | 453 | 1,376 |
| ruwais | ERA5 | 29.9 | 34.5 | 39.5 | 2,188 | 1,425 | 685 | 431 | 1,243 |
| ruwais | IFS 9 km | 29.8 | 34.4 | 38.7 | 2,132 | 1,398 | 638 | 381 | 1,218 |
| alain | ERA5 | 28.3 | 33.9 | 39.5 | 1,556 | 987 | 489 | 278 | 808 |
| alain | IFS 9 km | 27.7 | 33.1 | 38.7 | 1,374 | 818 | 336 | 164 | 644 |
| saadiyat | ERA5 | 30.7 | 35.0 | 39.5 | 2,605 | 1,839 | 911 | 610 | 1,653 |
| saadiyat | IFS 9 km | 30.6 | 34.4 | 38.5 | 2,561 | 1,768 | 829 | 492 | 1,584 |

\* The MoHRE midday break runs 12:30–15:00 from 15 June to 15 September. It covers the 13:00 and 14:00 instants on 93 days, so at most 186 hourly instants per season fall inside it. At Musaffah (IFS), **about 88 % of hours at or above 30 °C fall outside the break window**. The dates and hours are confirmed by Aletihad (2024 edition) and by the title of MoHRE's 2025 news item; mohre.gov.ae itself was unreachable from this environment. See §11.

**Structural uncertainty:** IFS gives 2 % (Ruwais) to 17 % (Al Ain) fewer hours at or above 30 °C than ERA5. Report both models.

**Sensitivity to radiation pre-processing.** Script `config_sensitivity.py`. It compares two configurations over all 10 site–model pairs, 2020–2025:

* **A**, used above: instant SSRD, instant cos z, `fdir = DIR/GHI`.
* **B**, the engine spec in `wbgt_liljegren.md` D5/D6: hour-mean GHI, cos z at t − 30 min, and Liljegren `fdir` with the S* ≤ 0.85 cap.

Results:

* Seasonal counts of hours at or above 30 °C change by at most **15 h**, under 1 %. For example, Musaffah IFS goes from 1,552 to 1,551.
* The mean WBGT difference is within **±0.03 °C**.
* Individual hours differ more: p95 |B − A| is 0.37–0.45 °C and the maximum is **2.7 °C**.
* The large differences sit in low-sun hours. The mean |B − A| is about 0.5 °C at 07–08 h and the maximum is at the 19:00 sunset hour. Between 11 and 13 h the difference stays at or below 0.4 °C.
* Aggregate hours-in-zone numbers are therefore robust to this choice. Hour-level oracle tests must use the engine's exact configuration.

### 6.6 Demo-day check

`demo-days.json` ranks days with a proxy and then checks them against full Liljegren on the IFS 2025 archive.

| Day | Tags | Liljegren daily max | Rank of 122 |
|---|---|---|---|
| musaffah 2025-08-01 | peak proxy, peak Liljegren | 40.2 °C | **1** |
| musaffah 2025-09-09 | most humid | 39.3 °C | 2 |
| musaffah 2025-07-26 | hottest dry-bulb (48.6 °C) | 37.9 °C | 5 |
| saadiyat 2025-08-01 | peak proxy, most humid | 37.8 °C | 3 |
| saadiyat 2025-07-21 | peak Liljegren (fixed offline pick) | 38.5 °C | **1** |
| saadiyat 2025-07-29 | hottest dry-bulb (46.3 °C) | 35.1 °C | **40** |

The Saadiyat hottest dry-bulb day ranks 40th: the hottest day by thermometer is not the most dangerous. 2025-08-01 was a real event. METAR OMAD at 09–10Z reported **40/31**, a Stull wet bulb of about 33.1 °C at RH 61 %. OMAA at 08Z reported 44/28, a wet bulb of about 32.2 °C.

---

## 7. Licensing, attribution and pricing

* **Open-Meteo**:
  * Terms: *"You may only use the free API services for non-commercial purposes… You accept to the CC-BY 4.0 licence."*
  * Commercial use includes *"Websites or apps that have subscriptions or display advertisements; Commercial products or promotional activities; Undisclosed research at commercial entities."*
  * Non-commercial examples include *"Public research conducted at public institutions; Use in educational content."*
  * A hackathon prototype with no ads or subscriptions plausibly falls within non-commercial use. Any employer or pilot deployment is commercial. This is an interpretation, not legal advice.
* **Required attribution** (licence page): *"You must include a link next to any location Open-Meteo data are displayed, for example: `<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>`"*. CC BY 4.0 also requires a licence link and an indication of changes.
* **Open-Meteo citation:** Zippenfenig, P. (2023). Open-Meteo.com Weather API [Computer software]. Zenodo. https://doi.org/10.5281/ZENODO.7970649
* **ERA5 / ERA5-Land (C3S):**
  * The CDS catalogue API lists `license: CC-BY-4.0` for both.
  * DOIs: ERA5 single levels 10.24381/cds.adbb2d47; ERA5-Land 10.24381/cds.e2161bac.
  * Attribution (ECMWF Confluence, updated 2025-07-03): *"[Generated using/Contains modified] Copernicus Climate Change Service information [year]."* plus the disclaimer *"Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains."*
  * The Copernicus licence PDF linked from Open-Meteo's licence page returns `NoSuchKey`.
* **ECMWF open data:** *"Their use is governed by the Creative Commons CC-BY-4.0 licence"* plus the ECMWF Terms of Use.
* **DWD ICON:** CC BY, per Open-Meteo's licence page. **NOAA GFS:** see weather.gov/disclaimer. **IEM:** public-domain statement, attribution appreciated (§5).
* **Suggested footer:** "Weather data by Open-Meteo.com (CC BY 4.0) — ECMWF IFS (CC BY 4.0); contains modified Copernicus Climate Change Service information 2026. Observations: Iowa Environmental Mesonet, Iowa State University. Data re-packaged by Zill."
* **Pricing.** From the Stripe pricing table embedded in open-meteo.com/en/pricing, fetched 2026-11-09. VAT is not shown. [DOCS]

  | Plan | Price | Calls / month | Includes |
  |---|---|---|---|
  | **API Standard** | **€29/month** or **€319/year** | 1M | Commercial licence; Forecast, Air-Quality, Marine, Flood, Elevation and Geocoding APIs |
  | **API Professional** | **€99/month** or **€1,099/year** | 5M | Adds Historical Weather, Historical Forecast, Previous Model Runs, Single Runs, Ensemble, Climate and Seasonal APIs |
  | **API Enterprise** | Contact | 50M | 3 keys, 3 support hours/month |

  * Docs: *"Historical, climate, ensemble, and satellite radiation APIs require the Professional API Plan or higher."*
  * Paid plans target 99.9 % uptime. *"Until it is available, monthly limits are not enforced."*

---

## 8. Cached data: layout and exact JSON schema

```
public/data/
  weather/
    archive/{musaffah,kezad,ruwais,alain,saadiyat}_{2020..2025}.json   30 files, ~224-228 KiB each (Jun 1-Sep 30 local)
    archive/musaffah_2025-11.json                                       November 2025 (mild demo day source), 59 KiB
    previous-runs/{site}_{2024,2025}.json                               10 files, ~1.36 MiB each (Jun 1-Sep 30 local)
    validation/{omaa,omad,omal}_2025.json                              airport cells: era5, era5_land, era5_seamless, ecmwf_ifs (@nearest)
    validation/{omaa,omad,omal}_2025_previous.json                     airport cells: d0-d3 of ecmwf_ifs025, dwd_icon_seamless, ncep_gfs_seamless
    demo-days.json                                                      7 days, 43 KiB
    manifest.json                                                       path, bytes, sha256, schema, models, period for every file
  obs/
    {OMAA,OMAD,OMAL}_2025-05-31_2025-10-01_metar_routine.csv            raw IEM CSV (UTC), provenance copy
    {OMAA,OMAD,OMAL}_2025_summer.json                                  parsed routine METARs
```

All JSON files are compact (no whitespace). Missing values are `null`. Values are exactly as the API returned them and are never rounded again. A full scan found no nulls in any archive, previous-runs or demo array. The only nulls are these:

* In `validation/*_2025.json`, the `era5_land@nearest` block has all-null wind, pressure, radiation and cloud cover (2,928 of 2,928), because ERA5-Land does not provide them.
* The METAR files are missing one hour (§5).

```ts
type Num = number | null;
type SiteId = "musaffah" | "kezad" | "ruwais" | "alain" | "saadiyat";
type WbgtVar = "temperature_2m" | "relative_humidity_2m" | "dew_point_2m" | "surface_pressure" | "wind_speed_10m"
  | "shortwave_radiation" | "direct_radiation" | "diffuse_radiation" | "direct_normal_irradiance" | "cloud_cover";
type Lead = "d0" | "d1" | "d2" | "d3";

interface TimeAxis {               // identical in every weather file
  timezone: "Asia/Dubai"; utc_offset_seconds: 14400;
  start_local: string;             // "2025-06-01T00:00"  (local wall time, no offset)
  end_local: string;               // "2025-09-30T23:00"
  t0_unix: number;                 // UTC epoch seconds of index 0, e.g. 1748721600 = 2025-05-31T20:00Z
  step_seconds: 3600; n: number;   // n = 2928 for Jun 1-Sep 30, 720 for November
  rule: string;                    // time[i] = t0_unix + i*3600; radiation[i] = mean over [time[i]-1h, time[i])
}
interface VarMeta { unit: string; valid: "instant" | "preceding_hour_mean"; desc: string }
interface Grid { lat: number; lon: number; elevation_m: number; cell_selection: "land" | "nearest" }
interface SourceNote { provider: string; licence: string; attribution_html: string; underlying: Record<string, string>; changes: string; api?: string }

interface ArchiveBlock { grid: Grid; request_url: string; fetched_at: string;
  null_counts: Record<WbgtVar, number>; columns: Record<WbgtVar, Num[]> }            // arrays have length n
interface ArchiveFile {
  schema: "zill.weather.archive/v1";
  site: { id: SiteId; name: string; lat: number; lon: number; kind: string };
  period: { start_date: string; end_date: string };                                 // local dates, inclusive
  time: TimeAxis; variables: Record<WbgtVar, VarMeta>;
  models: { era5: ArchiveBlock; ecmwf_ifs: ArchiveBlock };
  source: SourceNote;
}

interface PreviousRunsBlock { grid: Grid; request_url: string; fetched_at: string;
  non_null_counts: Record<WbgtVar, Record<Lead, number>>; columns: Record<WbgtVar, Record<Lead, Num[]>> }
interface PreviousRunsFile {
  schema: "zill.weather.previous_runs/v1";
  site?: { id: SiteId; name: string; lat: number; lon: number; kind: string };      // previous-runs/*
  point?: ValidationPointFile["point"];                                             // validation/*_previous.json
  period: { start_date: string; end_date: string }; time: TimeAxis;
  leads: { days: [0, 1, 2, 3]; definition: string };
  variables: Record<WbgtVar, VarMeta>;
  models: { ecmwf_ifs025: PreviousRunsBlock; dwd_icon_seamless: PreviousRunsBlock; ncep_gfs_seamless: PreviousRunsBlock };
  source: SourceNote;
}

type ValVar = "temperature_2m" | "dew_point_2m" | "relative_humidity_2m" | "wind_speed_10m" | "surface_pressure"
  | "pressure_msl" | "shortwave_radiation" | "direct_radiation" | "cloud_cover";
interface ValidationPointFile {
  schema: "zill.weather.validation_point/v1";
  point: { id: "omaa" | "omad" | "omal"; icao: string; name: string; lat: number; lon: number;
           station: { lat: number; lon: number; elevation_m: number } };
  period: { start_date: string; end_date: string }; time: TimeAxis; variables: Record<ValVar, VarMeta>;
  models: Record<"era5@nearest" | "era5_land@nearest" | "era5_seamless@nearest" | "ecmwf_ifs@nearest",
                 { model: string; grid: Grid; request_url: string; fetched_at: string;
                   null_counts: Record<ValVar, number>; columns: Record<ValVar, Num[]> }>;  // era5_land: wind/pressure/radiation all null
  source: SourceNote;
}

interface DemoDay {
  id: string;                      // "<site>_<YYYY-MM-DD>"
  site: { id: SiteId; name: string; lat: number; lon: number; kind: string };
  date: string; tags: string[];    // peak_wbgt_proxy | most_humid | hottest_dry_bulb | peak_wbgt_liljegren | mild_november
  why: string[];
  summary: { date: string; tmax_c: number; tmin_c: number; td_mean_c: number; td_max_c: number; rh_min_pct: number;
             rh_max_pct: number; ghi_max_wm2: number; daytime_cloud_mean_pct: number; tw_stull_max_c: number;
             wbgt_shade_proxy_daylight_max_c: number; wbgt_shade_proxy_max_hour_local: string };  // proxy = ranking only
  analysis: { model: "ecmwf_ifs"; grid: Grid; from: string; t0_local: string; t0_unix: number; step_seconds: 3600; n: 24;
              hourly: Record<WbgtVar, Num[]> };                                       // index h = local h:00
  forecast: { model: "ecmwf_ifs025"; grid: Grid; from: string; leads: Record<"d1" | "d2" | "d3", Record<WbgtVar, Num[]>> };
}
interface DemoDaysFile { schema: "zill.weather.demo_days/v1"; generated_at: string; timezone: "Asia/Dubai";
  utc_offset_seconds: 14400; selection: { season: string; analysis_model: string; forecast_model: string; wbgt_proxy: string; rules: string[] };
  time_rule: string; variables: Record<WbgtVar, VarMeta>; days: DemoDay[]; source: SourceNote }

interface MetarFile {
  schema: "zill.obs.metar/v1";
  station: { icao: string; name: string; lat: number; lon: number; elevation_m: number; network: "AE__ASOS"; note: string };
  source: { provider: string; request_url: string; fetched_at: string; report_types: string; raw_csv: string };
  time: { basis: string; window_utc: [string, string] };
  units: Record<string, string>;
  stats: { n_reports: number; n_on_the_hour: number; first: string; last: string };
  columns: { valid_utc: string[]; valid_local: string[]; temp_c: Num[]; dewpoint_c: Num[]; rh_pct: Num[];
             wind_dir_deg: Num[]; wind_speed_ms: Num[]; gust_ms: Num[]; qnh_hpa: Num[]; visibility_km: Num[];
             cavok: boolean[]; wx: (string | null)[]; sky1: (string | null)[] };   // valid_utc like "2025-06-01T00:00Z"
}
interface Manifest { schema: "zill.weather.manifest/v1"; generated_at: string; generator: string; file_count: number;
  total_bytes: number; attribution_html: string; licence: string;
  files: { path: string; bytes: number; sha256: string; schema: string | null; models: string[] | null; period: unknown }[] }
```

**Index arithmetic:**

```ts
const i = (Date.parse("2025-08-01T14:00:00+04:00") / 1000 - f.time.t0_unix) / 3600;
// For a whole local day d: i0 = (Date.parse(`${d}T00:00:00+04:00`)/1000 - t0_unix)/3600, then slice(i0, i0+24).
```

**Demo-day ranking proxy.** It is called `wbgt_shade_proxy` and is **not** a WBGT for display: `0.7·min(Tw_Stull, Ta) + 0.3·Ta`. It has no sun or wind term, so it reads low in direct sun. Use the engine's Liljegren value for anything shown to users.

---

## 9. Scripts

```bash
node scripts/data/fetch-weather.mjs                         # all stages: archive, previous, validation, demo, manifest
node scripts/data/fetch-weather.mjs --only=archive          # one or more stages, comma-separated
node scripts/data/fetch-weather.mjs --force --delay=1500    # re-download; ms between requests (default 1000)
node scripts/data/fetch-obs.mjs [--force]                   # METAR OMAA/OMAD/OMAL, Jun-Sep 2025 (local window inside UTC days)
```

* **Dependency-free Node ESM.** Uses only global `fetch`, `node:fs/promises`, `node:crypto` and `node:path`. Tested on Node 24.22.1.
* **Idempotent.** A second run made **0 API requests** and only regenerated `manifest.json`.
* **Polite.** Requests are sequential with a ≥ 1 s gap (≥ 1.5 s for IEM). HTTP 429/5xx are retried with `Retry-After` or exponential back-off, up to 6 tries.
* **Validated on download.**
  * `utc_offset_seconds === 14400`.
  * The first timestamp is `start_dateT00:00`.
  * The length is `(days)·24` and the steps are hourly.
  * Every variable is present with length `n`.
  * The script throws on any API error.
* **Recorded per block:** the request URL, fetch time, grid cell and null counts.
* **Measured run cost.** Weighted calls are read from `X-RateLimit-Cost`.

  | Stage | Requests | Weighted calls | Time |
  |---|---|---|---|
  | Archive | 62 | 527.1 | 62 s |
  | Previous runs | 30 | 1,045.7 | 280 s |
  | Validation | 12 | 94.1 | 11 s |
  | Validation previous runs | 9 | 313.7 | 18 s, probably served from cache |
  | Demo | 1 | 3.0 | 1 s |
  | **Total** | **114** | **≈ 1,984** | **about 6 min** |

  `fetch-obs.mjs` makes 3 IEM requests; a forced re-run took 8.3 s.

  The total is under the free-tier daily cap (10,000) and the per-hour cap (5,000).

---

## 10. Recommended validation design

### A. Hours-in-zone back-test, 2020–2025 (archive)

1. **Inputs:** `archive/{site}_{year}.json` for both `era5` and `ecmwf_ifs`. Run the TS engine end to end and compute hourly WBGT and zone for every site, year and model (2 × 30 × 2,928 = 175,680 hours).
2. **Oracle agreement (unit and integration test).** Feed identical pre-processed inputs to thermofeel 2.3.0 `calculate_wbgt_liljegren`. The inputs are those listed in §6.3: instant SSRD from §3.3, `fdir = DIR/GHI`, instant cos z and the same wind scaling.
   * Proposed acceptance: |ΔWBGT| ≤ 0.1 °C for ≥ 99.9 % of hours, and the same zone for ≥ 99.5 % of hours. Reference numbers are in §6.5.
3. **Outputs per site and season:**
   * hours per zone, by month and by local hour
   * days with at least one hour in the top zone
   * the longest consecutive run in the upper zones
   * the night-time WBGT minimum, which indicates recovery
   * hours in the upper zones that fall outside the MoHRE midday break window
4. **Uncertainty to report:**
   * (a) the structural spread between ERA5 and IFS (2–17 % in the preview)
   * (b) the observational anchor: at OMAA, OMAD and OMAL in 2025, compare hours-in-zone from model-only WBGT against obs-met WBGT (§6.3)
   * (c) sensitivity to wind scaling (Liljegren, Bröde or FAO), to radiation handling (instant vs mid-hour), and to the 0.62 m/s wind floor
5. **Inter-annual context.** Rank the six seasons. In the preview (IFS, hours with WBGT ≥ 30 °C), 2022 is the least severe season at all five sites. 2023 or 2024 is the most severe at the four coastal sites, and 2025 at Al Ain. Per-site values for 2020–2025:
   * musaffah 1,595 / 1,598 / 1,330 / 1,705 / 1,643 / 1,442
   * kezad 1,597 / 1,552 / 1,327 / 1,688 / 1,693 / 1,509
   * ruwais 1,350 / 1,424 / 1,286 / 1,462 / 1,544 / 1,320
   * alain 785 / 786 / 734 / 827 / 861 / 912
   * saadiyat 1,764 / 1,809 / 1,511 / 1,943 / 1,907 / 1,677

   Avoid tuning thresholds on a single year.

### B. Forecast skill at lead 1–3 days (Previous Runs, 2024–2025)

1. **Data:** `previous-runs/{site}_{year}.json` (d0–d3) and `validation/*_previous.json`.
   * The primary model is `ecmwf_ifs025`. It is the same IFS as production, but at 0.25° and 3-hourly then interpolated to hourly.
   * Optional extension for the exact production model: IFS HRES 9 km from the Single Runs API (2024-03-14 →), or from Previous Runs for summer 2026 (`ecmwf_ifs` has d1+ from 2025-10-01).
2. **References:**
   * (i) the same model's d0, which isolates error growth with lead time
   * (ii) obs-met WBGT at the three airports (METAR T/Td/wind plus IFS archive radiation)
   * (iii) the IFS and ERA5 archive at the sites
3. **Metrics, by lead and by local hour:**
   * hourly and daily-max WBGT bias, MAE and RMSE
   * zone exceedance per Zill threshold: POD = H/(H+M), FAR = F/(H+F), CSI = H/(H+F+M), plus Peirce or Heidke
   * the full zone confusion matrix, with a separate count of **dangerous misses** (forecast ≥ 2 zones below the verifying zone)
   * skill against baselines: SS = 1 − MSE_f/MSE_ref, with 24 h persistence and an hour-of-day climatology from 2020–2023 to avoid leakage
4. **Statistics:** use a day-block bootstrap (resample whole days, 1,000 replicates) for confidence intervals, because errors are autocorrelated.
5. **Operational outputs:**
   * a lead-dependent uncertainty band for the UI, sized from the RMSE by lead and hour (preview IFS RMSE 0.82, 1.01, 1.20 °C for d1, d2, d3)
   * the rule "forecast within 1 RMSE below a threshold ⇒ show 'possible'"
   * the preview shows GFS cannot serve as the humidity source (d1–d3 Td bias −3.1 to −5.7 °C at the three airports)

### C. Monte Carlo worker cohort

1. **Cohort:** N ≈ 10,000 synthetic workers per site-season. Sample:
   * job metabolic class
   * clothing (clo and moisture permeability)
   * acclimatisation (yes/no, including new arrivals)
   * body mass and height
   * drinking access
   * shift pattern (with and without the midday break)
   * the rest-cycle policy Zill recommends

   The physiology research sets the distributions. Do not hard-code guesses.
2. **Physiology oracle:** `pythermalcomfort.models.phs`, which implements ISO 7933:2004/2023. Chain hourly segments by passing the previous results. Outputs are `t_re`, `sweat_loss_g`, `d_lim_t_re` and `d_lim_loss_50/95`.
   * Mean radiant temperature comes from the Liljegren globe temperature via thermofeel `calculate_mrt_from_bgt`.
   * Respect the PHS applicability limits: 15 < tdb < 50 °C, 0 < tr − tdb < 60 °C, 0 < v < 3 m/s, 0.1 < clo < 1, and 1.7 < met < 7.5 (2004 version).
   * Track the NaNs that `limit_inputs=True` produces. On Musaffah's hottest hours Ta reaches 48.6 °C, close to the 50 °C limit.
3. **Decision test:**
   * Make Zill decisions from **forecast** weather (d1–d3) and from **analysis** weather (d0 or archive).
   * Simulate outcomes on "truth" weather: the archive, perturbed by the measured analysis-vs-METAR error. Sample whole-day residual vectors by hour of day, so that the diurnal error structure in §6.2 is kept.
   * Outcomes: the share of worker-shifts exceeding PHS limits, exposure-hours above the limits, missed-alert rate, and unnecessary stop-work hours (the productivity cost).
   * Report Monte Carlo confidence intervals and the trade-off curve between harm and productivity.

---

## 11. Could not verify, and caveats

* **MoHRE primary page** (mohre.gov.ae) refused connections from this environment. The midday-break window (15 Jun–15 Sep, 12:30–15:00) comes from Aletihad's 2024 article (*"between 12:30 and 3:00 pm"*, *"from June 15 until September 15"*) and from the search-indexed title of MoHRE's 2025 news item. **UNVERIFIED against the primary source.**
* **Open-Meteo pricing.**
  * Read from the Stripe pricing-table JSON that the pricing page loads.
  * VAT treatment is not stated.
  * The price of the "API Professional (10 million calls)" add-on is not shown (amount null).
* **Copernicus licence link** on Open-Meteo's licence page is broken (`NoSuchKey`). The licence was confirmed through the CDS catalogue API (`CC-BY-4.0`) and ECMWF Confluence.
* **Lead windows for 6-hourly models** (d1 = 24–29 h and so on) are **inferred** from Open-Meteo's 3-hourly example. They are not documented explicitly.
* **Previous Runs coverage dates** come from bisection at a single point and assume no gaps.
* **Provenance of the IFS 9 km archive, 2017–2024.** It is described as "assembled by Open-Meteo… employing the most up-to-date version of IFS", and Single Runs from 2024-03-14 are "Cycle 49R1 hindcasts". Whether 2017–2024 values are hindcasts or operational output is **not documented**, which affects homogeneity.
* **Rate-limit formula** (§3.7) is empirical. `past_days=93` was accepted although the documented maximum is 92.
* **Forecast skill preview** uses `ecmwf_ifs025`, not the production IFS HRES 9 km (see 10.B.1).
* **WBGT numbers** in §6.3–6.6 depend on the pre-processing listed in the scripts: thermofeel defaults, instant SSRD and instant cos z. The final engine may differ slightly.
* **DWD and NOAA attribution wording** was not checked beyond Open-Meteo's licence page.
* **Open-Meteo 0.1° IFS.** ECMWF publishes 0.1° IFS open data from 2026-10-20. Whether Open-Meteo exposes it as a separate model was not checked.
* **Representativeness.** No public station exists near Musaffah after QGX ended (2025-05-22), and none near Ruwais or KEZAD. Validation is therefore anchored at three airports.

---

## 12. Sources

* Open-Meteo docs (fetched 2026-11-09):
  * [Forecast API](https://open-meteo.com/en/docs)
  * [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
  * [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)
  * [Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api)
  * [Single Runs API](https://open-meteo.com/en/docs/single-runs-api)
  * [Terms](https://open-meteo.com/en/terms)
  * [Licence](https://open-meteo.com/en/licence)
  * [Pricing](https://open-meteo.com/en/pricing)
* Open-Meteo blog:
  * [Weather Forecasts From Previous Model Runs (2024-04-19)](https://openmeteo.substack.com/p/weather-forecasts-from-previous-model-runs)
  * [ECMWF transitions to open data (2025-10-01)](https://openmeteo.substack.com/p/ecmwf-transitions-to-open-data)
* Open-Meteo source at commit `97132c51bbb138c0041ebbbe6570e4140943eb03`:
  * [Meteorology.swift](https://github.com/open-meteo/open-meteo/blob/97132c51bbb138c0041ebbbe6570e4140943eb03/Sources/App/Helper/Meteorology.swift)
  * [Zensun.swift](https://github.com/open-meteo/open-meteo/blob/97132c51bbb138c0041ebbbe6570e4140943eb03/Sources/App/Helper/Solar/Zensun.swift)
  * [DirectNormalIrradiance.swift](https://github.com/open-meteo/open-meteo/blob/97132c51bbb138c0041ebbbe6570e4140943eb03/Sources/App/Helper/Solar/DirectNormalIrradiance.swift)
* ECMWF:
  * [Open data](https://www.ecmwf.int/en/forecasts/datasets/open-data)
  * [How to acknowledge and cite CDS data (Confluence)](https://confluence.ecmwf.int/display/CKB/How+to+acknowledge+and+cite+a+Climate+Data+Store+%28CDS%29+catalogue+entry+and+the+data+published+as+part+of+it)
  * [CDS catalogue: ERA5 single levels](https://cds.climate.copernicus.eu/api/catalogue/v1/collections/reanalysis-era5-single-levels)
  * [CDS catalogue: ERA5-Land](https://cds.climate.copernicus.eu/api/catalogue/v1/collections/reanalysis-era5-land)
* IEM:
  * [asos.py help](https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help)
  * [AE__ASOS network GeoJSON](https://mesonet.agron.iastate.edu/geojson/network/AE__ASOS.geojson)
  * [Disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php)
* Midday break:
  * [Aletihad, 31 May 2024](https://en.aletihad.ae/news/uae/4489967/mohre-implements-midday-break-from-june-15-to-september-15) (secondary)
  * [MoHRE 2025 news item](https://mohre.gov.ae/en/media-center/news/3/6/2025/mohre-to-implement-midday-break-for-the-21st-consecutive-year-from-15-june-to-15-september-2025) (unreachable; title only)
* Methods: Stull, R. (2011) *J. Appl. Meteor. Climatol.* 50, 2267–2269, doi:10.1175/JAMC-D-11-0143.1; Liljegren, J. C. et al. (2008) *J. Occup. Environ. Hyg.* 5, 645–655, doi:10.1080/15459620802310770 (as implemented in thermofeel 2.3.0); Spencer, J. W. (1971) *Search* 2(5), 172 (as implemented in pvlib 0.16.1); ISO 7933 PHS (as implemented in pythermalcomfort 4.8.1).
