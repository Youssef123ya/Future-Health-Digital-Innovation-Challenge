# Zill — Science and evidence

Zill combines weather, work context, an optional heart-rate stream and worker check-ins into one protective level for
each worker: `safe < caution < high < stop < emergency`. The worker app shows `safe` as "Low risk". This document
covers each scientific model in the engine: what it computes, the evidence that the code computes it correctly, the
engineering choices made where no standard decides, and what we could not verify. Assumptions and limitations are
kept in a separate register, [LIMITATIONS.md](LIMITATIONS.md). The design principles are in
[ARCHITECTURE.md](ARCHITECTURE.md).

**Who this is for.** Challenge judges (clinicians, health-technology engineers and regulators) and maintainers.

**Status on 11 November 2026.**
- **Engine modules.** Complete and tested. At wave 1 (10 November 2026) 869 automated tests in 15 test files passed. On
  11 November 2026 the whole repository has 1,273 tests in 30 test files, all passing (`npx vitest run`).
- **Integration layer.** `engine/indices.ts`, `engine/risk.ts`, `engine/alerts.ts` and `engine/planner.ts` combine the
  modules. They are unit-tested and run end to end in the world simulation (SIMULATION.md). §2.9 covers how the engine
  uses the PHS projection during a shift. §3 is the fusion design written before the integration; ARCHITECTURE.md §5–6
  describe the implemented rules.
- **Validation pipeline.** `npm run validate` regenerates `public/data/validation/*.json` (ARCHITECTURE.md §8): reference
  agreement, hours in each zone and forecast skill ([VALIDATION.md](VALIDATION.md)), and the simulated cohort
  ([VALIDATION-COHORT.md](VALIDATION-COHORT.md)).

Every number below comes from the unit tests, the reference fixtures in `fixtures/` or the research notes in
`docs/research/`. The one exception is the calibration against the simulated cohort in §2.9, which is labelled as a
simulated result.

**What Zill does not claim.** Zill is decision support for occupational safety. It does not diagnose. It does not
"predict heat stroke". It does not "measure core temperature". Each model output is labelled for what it is:
- PHS outputs are projections for an average person.
- ECTemp is an estimated strain indicator, shown with its uncertainty band.
- WBGT and TWL describe the environment, not the person.

### How to read this document

| Tag or term | Meaning |
|---|---|
| **[ENG]** | An engineering choice that no standard fixes. It is always resolved in the direction that protects the worker. Clinical [ENG] values need sign-off by a UAE-licensed occupational physician (LIMITATIONS C-01). |
| **[ASSUMPTION]** | A behaviour parameter of the simulated cohort (docs/SIMULATION.md). The engine never uses it. |
| **UNVERIFIED** | A value or wording we could not check against its primary source. It is kept, marked `UNVERIFIED` in the code, and listed in this document. |
| **Exact port** | The TypeScript reproduces a reference implementation to floating-point rounding. The references are pythermalcomfort, thermofeel, the USARIEM code and the repository's own oracles. |
| **Published values** | The output agrees with numbers printed in a standard or a paper. This is the stronger check, but printed numbers are often rounded. |

A reference such as `wbgt_liljegren.md §11` points to a research note in `docs/research/`. Test counts in §2 are per
test file and come from the 10 November 2026 run; several files have gained tests since.

---

## 1. The evidence chain on one page

Each step in the chain answers one question:

```
weather → heat indices → exposure limits → personal projection → physiology → symptoms → fused level
```

| Step | Question it answers | Model and module | Passes on | Effect on the level |
|---|---|---|---|---|
| 1 Weather | What are the conditions at this site, now and over the next hours? | The best available source, in priority order: site WBGT meter, Open-Meteo ECMWF IFS forecast, ERA5/IFS archive, cached forecast, conservative design-day default (`data/weather.ts`) | `EnvSample` with its source, age, confidence and a stale-data margin | Missing or old data adds margin and never removes it |
| 2 Heat indices | How heat-stressful is the workplace, in sun and in shade? | Liljegren WBGT with NOAA solar geometry (`wbgt.ts`, `solar.ts`, `psychro.ts`); Thermal Work Limit (`twl.ts`); NWS heat index, for communication only (`limits.ts`) | WBGT (sun and shade), globe and wet-bulb temperatures, mean radiant temperature (MRT), 2 m wind, TWL | None directly |
| 3 Exposure limits | How many minutes per hour may this task be done here, and what does the law require? | NIOSH REL/RAL at ISO 8996/ACGIH metabolic rates with ACGIH clothing adjustments (`limits.ts`); ADOSH TWL zones and the MoHRE midday break (`regulation.ts`) | Allowed work fraction, zone controls, regulatory stop | Sets floors: never less protection than the law requires |
| 4 Personal projection | If this worker carries on as now, how long until an ISO 7933 limit is reached? | ISO 7933:2023 Predicted Heat Strain (PHS), advanced one minute at a time per worker (`phs.ts`); used by `risk.ts` and the planner (§2.9) | Minutes until rectal temperature t_re reaches 38 °C, or until the water-loss limit (which credits logged drinking, §2.9) | Can raise the level; a near-limit stop is held until a resume check passes |
| 5 Physiology (opt-in) | Does the worker's heart rate suggest high strain? | ECTemp core-temperature estimate, Physiological Strain Index (PSI), sustained-HR rule, signal-quality gate (`physio.ts`) | T1/T2 floors, check-in prompts | Can raise the level, never lower it |
| 6 Symptoms | What does the worker or a buddy report? | Triage table with red flags, urine colour, fluid caps (`clinical.ts`) | Tiers T0–T3, first-aid actions | T3 forces EMERGENCY |
| 7 Fused level | What should happen now? | Maximum over the available channels (`risk.ts`; rules in ARCHITECTURE §5, design notes in §3) | Level, actions, work minutes per hour, minutes to limit, water per hour | A channel without usable inputs is never read as reassurance |

Three rules run through the whole chain.

1. **Each step can add protection; none can remove it.** The fused level is the maximum over the channels. A channel
   whose inputs are missing, stale, not consented or of poor quality reports `available: false` and drops out. It does
   not count as a "safe" vote.
2. **Two independent heat-stress methods are kept, and the stricter wins.** The environment channel uses WBGT with
   NIOSH/ACGIH limits. The regulation channel uses TWL with the ADOSH zones. Keeping both matters because TWL is
   reported to be less conservative than the WBGT/TLV method (§2.5).
3. **Population models first, the individual second.** Steps 2–4 use standards built for the average worker, or for
   95 % of the exposed population. Steps 5–6 personalise the result, and only upwards.

---

## 2. Model specifications

Every model below is described under the same headings: purpose, inputs, key equations, constants and provenance,
implementation notes, verification, [ENG] decisions and UNVERIFIED items.

### 2.1 Outdoor and shade WBGT (Liljegren et al. 2008) — `engine/wbgt.ts`, `engine/psychro.ts`

**Purpose.** WBGT (ISO 7243) is the index behind the NIOSH and ACGIH exposure limits. Most sites have no WBGT meter, so
Zill estimates WBGT from standard weather variables using the Liljegren et al. (2008) model, "Modeling the wet bulb
globe temperature using standard meteorological measurements" (J Occup Environ Hyg 5:645–655). The code is ported
from thermofeel 2.3.0 `liljegren.py`, which matches Liljegren's own `wbgt.c` to within 2.2e-12 °C in float64.

**Inputs** (`EnvSample`):

| Field | Meaning | Unit |
|---|---|---|
| `taC` | Air temperature | °C |
| `tdC` (preferred) or `rhPct` | Dew point, or relative humidity | °C or % |
| `pHpa` | Surface pressure | hPa |
| `wind10Ms` | Wind speed at 10 m | m/s |
| `ghiWm2` | Global horizontal irradiance | W/m² |
| `radiationWindowMin` | Averaging window of the radiation fields | min |
| `directWm2` (optional) | Direct radiation; sensitivity check only | W/m² |
| `radiantBoostC` (optional) | Extra radiant load from hot work surfaces | °C |
| `measuredWbgtC` (optional) | Site WBGT meter reading | °C |

The site's latitude and longitude are also needed.

**Outputs** (`WbgtComponents`):
- the exposure WBGT `wbgtC`, which is the meter reading if there is one and the model value otherwise;
- `wbgtModelC` and the shade WBGT `wbgtShadeC`;
- the 2-inch globe temperature `tgC`, the natural wet bulb `tnwbC`, the psychrometric wet bulb `tpwbC` and the globe MRT
  `mrtC`;
- the 2 m wind `wind2Ms` and the apparent cos zenith;
- the list of fail-safe substitutions made (`defaults`).

**Key equations.** Temperatures are in kelvin inside the solvers. Sources: wbgt_liljegren.md §7–9 and §11–13.

```
WBGT_sun   = 0.7·T_nwb + 0.2·T_g + 0.1·T_a                 ISO 7243, via Lemke & Kjellstrom 2012 Eq. 1
WBGT_shade = 0.7·T_nwb + 0.3·T_g   with solar S = 0        Eq. 2

Globe (D = 0.0508 m), T_sfc = T_a, properties at T_ref = (T_g + T_a)/2:
  T_g = [ ½(ε_a·T_a⁴ + ε_sfc·T_sfc⁴) − h_g/(σ·ε_g)·(T_g − T_a)
          + S/(2σ·ε_g)·(1 − α_g)·(f_dir·(1/(2·cos z) − 1) + 1 + α_sfc) ]^¼

Natural wet bulb (wick D = 0.007 m, L = 0.0254 m):
  T_w   = T_a − λ/RATIO·(e_w − e_a)/(P − e_w)·(Pr/Sc)^0.56 + F_atm/h_w
  F_atm = σ·ε_w·(½(ε_a·T_a⁴ + ε_sfc·T_sfc⁴) − T_w⁴)
          + (1 − α_w)·S·((1 − f_dir)(1 + D/4L) + f_dir·(tan z/π + D/4L) + α_sfc)
  The psychrometric wet bulb uses the same wick balance with the radiation term switched off.

Solver:     x ← 0.9·x + 0.1·F(x); stop when |F(x) − x| < 0.02 K; at most 500 iterations; flagged bisection fallback
Beam split: S* = min(GHI/TOA, 0.85);  GHI_used = S*·TOA;  f_dir = clamp(exp(3 − 1.34·S* − 1.65/S*), 0, 0.9)
            f_dir = 0 when cos z < 0.00873 (sun within 0.5° of the horizon)
Wind:       u10 ≥ 0.62 m/s;  u2 = max(u10·(2/10)^p, 0.13) m/s, where p comes from the SRDT stability class (urban exponents)
```

**Constants and provenance.** Every constant is the Liljegren `wbgt.c` value as used by thermofeel 2.3.0. The test
suite checks them against the fixture's `constants` block (`LILJEGREN` in `wbgt.ts`).

| Quantity | Value |
|---|---|
| σ (Stefan–Boltzmann, as coded; kept for oracle parity) | 5.6696e-8 W m⁻² K⁻⁴ |
| c_p (specific heat of dry air) | 1003.5 J kg⁻¹ K⁻¹ |
| Globe emissivity / albedo / diameter | 0.95 / 0.05 / 0.0508 m |
| Wick emissivity / albedo / diameter / length | 0.95 / 0.4 / 0.007 m / 0.0254 m |
| Ground emissivity / albedo | 0.999 / 0.45 |
| Cap on GHI/TOA (normsolar) / cap on f_dir | 0.85 / 0.9 |
| Minimum air speed | 0.13 m/s |
| Convergence threshold | 0.02 K |
| Maximum iterations | 500 (thermofeel; the C code's 50 fails on calm, low-sun cases) |
| 10 m wind floor | 0.62 m/s (thermofeel) |

Saturation vapour pressure is Buck 1981 with the 1.004 enhancement factor (`liljegrenEsatHpa`). RH is computed from the
Open-Meteo dew point and clamped to [1, 100] %.

**Implementation notes.**
- **Solar geometry.** The sun's position is evaluated at the middle of the radiation averaging window (§2.2).
- **Shade.** Shade WBGT uses the same air temperature, humidity, pressure and 2 m wind as the sun case, with solar
  radiation set to zero.
- **Site meter.** A meter reading (`measuredWbgtC`) becomes the exposure WBGT as given. The model value is kept, and
  the difference `measuredMinusModelC` is reported so that a large meter-versus-model gap can be flagged. `wbgt.ts`
  applies no plausibility check to the reading. The shade WBGT is always the model value.
- **BoM formula.** The Australian Bureau of Meteorology formula is implemented only as a labelled comparator
  (`bomApproxWbgtNotForAlerts`) and never drives an alert. On a humid Abu Dhabi night it reads 34.47 °C against
  Liljegren's 28.24 °C (fixture `night_humid_no_sun`).
- **Globe MRT.** `globeMrtC` inverts Liljegren's own globe balance:
  `T_mrt⁴ = T_g⁴ + h_sphere/(σ·0.95)·(T_g − T_a)`. The result is the MRT of a black globe, which is an upper bound on a
  standing person's MRT in the same radiation field (about 94 °C against 74 °C in full sun, phs_iso7933.md §10.3).
  Do not use the ISO 7726 constants for a 0.15 m globe on this 2-inch globe: they mis-read by 3–12 °C.

**Verification.**

| Check | Reference | Result |
|---|---|---|
| Thermophysical property functions (10 rows) | `fixtures/wbgt_liljegren.json` (thermofeel 2.3.0) | ≤ 1e-10 relative |
| 20 core cases: T_g, T_nwb, T_psy and both WBGT formulas | same | max error 3.7e-10 / 4.9e-10 / 4.5e-10 / 4.9e-10 °C (tolerance 1e-6 °C); iteration counts identical |
| 20 Open-Meteo-style full cases through `wbgtComponents` (reference shade) | same | max error 4.9e-10 (T_g), 5.0e-10 (T_nwb), 4.6e-10 (T_psy), 4.5e-10 (WBGT) and 4.6e-10 °C (reference shade); derived geometry, clearness, f_dir and wind within 1e-9; TOA and GHI_used within 1e-8 W/m² |
| Wind (45 cases), beam split (17), WBGT weighting (6), BoM comparator (8) | same | within 1e-9 |
| Open-Meteo direct/GHI sensitivity variant (3 cases) | same | within 1e-6 °C |
| thermofeel against the Liljegren C code | independent float64 transliteration (wbgt_liljegren.md §15) | max 2.16e-12 °C over 7,500 grid cases |
| Independent published values | Lemke & Kjellstrom 2012, Figs 1–4: 99 digitised points with u ≥ 0.13 m/s. The figures' geometry is not stated; it was inferred as f_dir 0.8 and cos z = 1 | rms 0.056 °C, max 0.142 °C. The point that needs no solar geometry: 24.822 °C against 24.83 °C published |
| Worked example | `inland_summer_noon_extreme` (inland, 46.2 °C, 13 % RH) | WBGT 35.48 °C (T_g 63.80, T_nwb 25.85, T_psy 22.40) |
| Globe MRT against the model's own radiation forcing (full cases) | the model | max 0.069 °C (tolerance 0.1 °C) |
| Tests | `wbgt.test.ts` (39), `psychro.test.ts` (10) | all pass |

The MRT tolerance is 0.1 °C instead of the research note's 0.04 °C. The globe's 0.02 K stopping threshold is amplified
2–4 times when the balance is inverted at shamal wind speeds.

**[ENG] decisions** (all protective):
- **Engineered shade** (on by default): `T_g,shade = max(T_g(S = 0), T_a)`. A solid roof close to air temperature
  replaces the cold open sky that the reference model assumes. This adds up to +0.8 °C to shade WBGT. Setting
  `engineeredShade: false` reproduces the reference shade exactly.
- **Radiant boost for hot work surfaces.** The globe temperature is raised by exactly `radiantBoostC`. The long-wave load
  that holds the globe at that temperature is also applied to the wick, so T_nwb and MRT rise consistently. The boost
  also applies in shade by default. The per-site values (0.5–2.0 °C) are scenario assumptions documented in
  `data/sites.ts`.
- **Radiation averaging window.** 60 min for forecast, archive and cached sources; 0 (instantaneous) for site sensors
  unless the caller states otherwise.
- **Unknown pressure → 1013.25 hPa.** Modelled WBGT rises with pressure (by +0.005 to +0.15 °C between 965 and
  1013 hPa), so this default errs high at near-sea-level sites.
- **Urban wind exponents.** The rural exponents give lower daytime WBGT.
- **Solver.** 500 iterations, with a flagged bisection fallback.

**UNVERIFIED.**
- **Latent-heat slope sign** (quirk Q1). The sign is kept for parity with the reference. It changes WBGT by −0.17 to
  +0.04 °C at T_a 35–50 °C, so the reference is slightly conservative. We could not check whether the paper prints
  the same sign.
- **KNMI attribution** of the 0.62 m/s 10 m wind floor.
- **ISO 7243 wording.** The formulas were taken via Lemke & Kjellstrom 2012.
- **Open-Meteo direct radiation.** Which model supplies `direct_radiation` for the UAE is unknown. The direct/GHI
  variant is therefore a sensitivity check and never drives alerts.
- **Lemke figure geometry.** Inferred, not stated in the paper.
- **Original C binary.** Not run.

### 2.2 Solar geometry and Open-Meteo hour-mean radiation — `engine/solar.ts`, `data/weather.ts`

**Purpose.** The globe and wick balances need the sun's position and the split of radiation into direct and diffuse
parts. Open-Meteo radiation fields are means over the preceding hour, so the solar geometry must match that hour.
Mixing an hour-mean irradiance with an instantaneous zenith is the error that wbgt_liljegren.md §13.5 warns against.

**Inputs.** Time as epoch milliseconds (UTC); latitude and longitude in degrees. For radiation: `ghiWm2` and
`radiationWindowMin`.

**Key equations.**

```
Apparent zenith z:  NOAA Solar Calculator (Meeus) with atmospheric refraction; valid 1901–2099
TOA = 1367·max(cos z, 0)/R²   W/m², R = Earth–Sun distance in AU (the Liljegren TOA is 0 when cos z < 0.00873)
Hour-mean sample ending at t: evaluate the geometry at t − window/2, i.e. t − 30 min for raw Open-Meteo hourly data
Instantaneous value at t from the preceding-hour mean:
    I(t) = mean · cos z(t) / (hour mean of max(cos z, 0)),   0 when the sun is down, capped at the TOA value
```

**Data contract.**
- **Timestamps.** `EnvSample.t` is the end of the hour over which radiation was averaged.
- **Averaging window.** `radiationWindowMin` is 60 for raw Open-Meteo hourly values and 0 for instantaneous values (site
  sensors, minute-interpolated samples). When it is absent, it is 0 for `site_sensor` and 60 for every other source
  (`types.ts`).
- **Minute values.** The data layer's minute samplers (`interpolateEnv`, `sampleAt`, `resolveEnvironment`) turn
  hourly means into instantaneous minute values. Within each hour they weight radiation by cos zenith, which amounts
  to a constant clearness index for the hour. Energy is conserved exactly, but values can step at hour boundaries.
  These samples carry `radiationWindowMin = 0`, and the geometry is evaluated at t (`solarGeometryTime`).

**Forecast request.**
- **Model.** Open-Meteo Forecast API with `models=ecmwf_ifs`. In the UAE, `best_match` is ECMWF IFS HRES 9 km within
  the IFS horizon: at Musaffah, 350 of 353 hourly temperatures were identical.
- **Other settings.** `timezone=Asia/Dubai` (UTC+4, no DST), the 10 WBGT variables, and `cell_selection=land`.
- **Wind.** The API has no 2 m wind, so the WBGT model converts the 10 m wind (§2.1).

**Verification.**

| Check | Reference | Result |
|---|---|---|
| NOAA port, all fields of 12 fixture solar cases | oracle `noaa_solar()` | within 1e-9 |
| NOAA against NREL SPA (pvlib `nrel_numpy`), Abu Dhabi 2025 | pvlib | max 0.0159° zenith and 2.76e-4 in cos z (tolerance 0.03° and 5e-4) |
| Hour-mean geometry at t_end − 30 min | derived geometry of the 20 full cases | reproduced (fixture tolerance 1e-9) |
| Instantaneous value from the hour mean, against Open-Meteo `shortwave_radiation_instant` | Musaffah IFS cell, 2025-07-15 (data_and_validation.md §3.3) | max error 0.82 % at 07:00; ≤ 0.08 % from 08:00 to 13:00. The sunrise hour (06:00) gives 15.5 against 18.3 W/m² (−15 %); it is outside the research note's tolerance and carries little energy |
| Minute disaggregation, Musaffah, summer 2025 (175,621 minutes) | energy balance and physical bounds | every sunlit hour's mean reproduced to 1e-6 W/m² (more than 1,500 hours); 0 negative or NaN values; 0 minutes with radiation while cos z ≤ 0 (80,131 night minutes); peak below 1,100 W/m² |
| Tests | `solar.test.ts` (12), `weather.test.ts` (40) | all pass |

**[ENG] decisions.**
- **Site pyranometers** are treated as instantaneous unless their averaging window is stated.
- **Missing solar radiation.** The data layer's clear-sky estimate is the site's 95th-percentile clear-sky index
  (0.710–0.728, derived from the cached archive) multiplied by TOA at every sun angle. This over-estimates morning and
  evening sun, which is the protective direction.

**Caveats.**
- **Direct-radiation source.** See §2.1.
- **Two copies of the NOAA algorithm.** One is in `solar.ts`; the other is a private port in `weather.ts` that can be
  replaced through `CosZenithFn`. Both transcribe wbgt_liljegren.md §10.2. The integration layer should pass the
  `solar.ts` function to the data layer so that only one is used.

### 2.3 Predicted Heat Strain, ISO 7933:2023 — `engine/phs.ts`

**Purpose.** PHS models the rectal temperature, sweat rate and water loss of an *average* worker under a given climate,
metabolic rate and clothing. It also gives the allowable exposure times D_lim (ISO 7933 Annex B). Zill uses PHS for
the projection channel: the minutes left until an ISO limit if the current activity continues.

**Inputs** (`PhsInput`):

| Field | Meaning | Unit |
|---|---|---|
| `tdbC` | Air temperature | °C |
| `trC` | Mean radiant temperature | °C |
| `vMs` | Air speed at the body: the 2 m wind, not the 10 m wind | m/s |
| `rhPct` or `paKpa` | Relative humidity, or water vapour pressure | % or kPa |
| `metabolicWm2`, `wmeWm2` | Metabolic rate and external work, per m² of DuBois body area | W/m² |
| `clo`, `iMst`, `aP`, `fR` | Clothing insulation; moisture permeability (default 0.38); reflective fraction (0 for ordinary clothing); reflection coefficient | — |
| `posture` | Standing, sitting or crouching | — |
| `acclimatized` | Whether the worker is acclimatised | true/false |
| `drink` | 1 = can drink freely; 0 = restricted (for example while fasting) | — |
| `massKg`, `heightM` | Body mass and height | kg, m |

Walking speed and direction are optional.

**Outputs.**
- `PhsResult`: t_re, t_sk, t_cr, sweat rate, water loss, the D_lim values, validity flags and the model state.
- From the stepper: `minutesToLimit` returns `{minutes, binding: 'rectal' | 'dehydration'}`.

**Key equations.** ISO 7933 Annex E, in 1-minute steps (phs_iso7933.md §4). Heat flows are in W/m².

```
Heat balance:        S = M − W − C_res − E_res − C − R − E
Required evaporation: E_req = M − dS_eq − W − C_res − E_res − C − R;  w_req = E_req/E_max;  SW_req = E_req/r_req
Predicted sweat:     SW_p follows SW_req with a 10-min exponential lag and is capped at SW_max
                     SW_max (2023 edition) = 400 W/m² unacclimatised, 500 W/m² acclimatised (no longer scaled with M)
                     maximum skin wettedness w_max = 0.85 unacclimatised, 1.0 acclimatised
Core equilibrium:    t_cr,eq = 0.0036·M + 36.6 °C, reached with a 10-min lag; skin temperature lags by 3 min
Convection:          h_c = max(z, 2.38·|t_cl − t_a|^0.25),  z = 3.5 + 5.2·v_r (v_r ≤ 1 m/s), else 8.7·v_r^0.6
Body heat capacity:  c_sp = 58.15·W_b/A_Du   W·min·m⁻²·K⁻¹
Limits:              D_lim,tcr  = first minute with t_re ≥ 38.0 °C
                     D_lim,loss = first minute with water loss ≥ D_max,
                                  D_max = 5 % of body mass (drink = 1) or 3 % (drink = 0)
Initial state:       t_sk 34.1 °C;  t_cr = t_re = t_cr,eq = 36.8 °C;  skin–core weighting α = 0.3
```

The radiating fraction of the body surface is 0.77 standing, 0.70 sitting and 0.67 crouching.

**Constants and provenance.** The code is a port of the pythermalcomfort 4.8.1 kernel (`_phs_optimized_scalar`), which
transcribes the ISO 7933 Annex E program. The research team re-implemented the kernel independently in Python; it
matched pythermalcomfort on every fixture vector with a maximum relative difference of 5.2e-15.

Validity limits for the 2023 edition, inclusive, as implemented by pythermalcomfort 4.8.1:

| Variable | Range |
|---|---|
| Air temperature t_a | 15–50 °C |
| t_r − t_a | 0–60 °C |
| Air speed v | 0–3 m/s |
| Vapour pressure p_a | 0.5–4.5 kPa |
| Metabolic rate M | 56–250 W/m² |
| Clothing | 0.1–1.0 clo |

The ISO 8996 "very high" work class (290 W/m²) is outside the 2023 range for M. Impermeable or fully reflective
clothing is outside the scope of the 2023 edition.

**Implementation notes.**

*Running the model through a shift*
- **Continuous stepper.** `phsStep(state, input, minutes)` advances one state per worker. Under constant inputs, any
  split of a run into chunks gives exactly the same state as one continuous run. Three details make this work:
  - The 2023 minute-1 skin-temperature override applies only at the start of exposure. pythermalcomfort re-applies it
    on every call, so its chained calls drift from a continuous run.
  - Limits are tracked in absolute minutes since the exposure started.
  - D_lim is `null` when a limit is not reached. pythermalcomfort returns the run length instead.
- **Limits latch.** Once t_re reaches 38 °C, or water loss reaches its limit, `minutesToLimit` returns 0 for the rest of
  the exposure, even if t_re falls again during rest. ISO 7933:2023 clause 5 warns that the model "does not enable
  users to determine validly the duration of time needed for an average person whose rectal temperature has risen to
  38 °C or more to recover". Rest therefore never "earns back" exposure time. When both limits fall on the same
  minute, the result is reported as `rectal` [ENG]. When the engine passes a higher drink-allowed water-loss threshold
  for logged drinking (`PhsProjectionOptions.lossThresholdG`, §2.9), the cumulative loss is compared with that
  threshold instead of the recorded 5 % crossing; without the option the code path is exactly ISO 7933.
- **Display rule.** A trajectory after the first D_lim is never shown as meaningful, because the model has no
  physiological ceiling: t_re reaches 44–49 °C in fixture vectors AD03 and AD23.

*Modelling choices*
- **Choice of convection rule (`hcMode`).**
  - **Default, `tclIteration`.** h_c is re-evaluated from the clothing-surface temperature inside its own iteration, as
    jsthermalcomfort does. This reproduces ISO 7933:2023 Annex F case 3 (high radiant load, 0.1 m/s): t_re 38.69 °C
    and D_lim,tcr 151 min, against 38.7 °C and 149 min published.
  - **`pythermalcomfort`.** pythermalcomfort fixes h_c once per call. This mode is kept to match the oracle. On case 3
    it gives 38.198 °C and 275 min, which errs in the unsafe direction.
  - **When they differ.** At air speeds of 0.5 m/s or more, typical in Abu Dhabi, h_c = z and the two rules agree
    exactly. They can differ at low air speed under very high radiant load (fixture AD14, v = 0.2 m/s: 43.17 against
    43.19 °C).
- **No free drinking (drink = 0).** The 2023 readings disagree:

  | Reading | Rule | Fixture AD15: D_lim,loss |
  |---|---|---|
  | pythermalcomfort (engine default, `drink0Mode: 'pythermalcomfort'`) | 3 % threshold, then a 0.6 time factor | 71.4 min |
  | MATLAB 2023 and LTH FDIS transcriptions (`threshold3PctOnly`) | 3 % threshold only | 119 min |

  Research §6.4 recommends the 3 %-only reading. The engine keeps the double reduction because it is more
  conservative, and offers `threshold3PctOnly` as an option. This path matters for workers who are fasting.
  - **Sticky restriction [ENG].** After any minute with drink = 0, the restricted criterion applies for the rest of the
    exposure.
  - **Look-ahead.** Under the 0.6 rule, the limit can fall before the 3 % threshold is actually crossed. `phsRun` and
    `minutesToLimit` therefore project ahead at constant inputs, up to minute (elapsed + horizon)/0.6.
  - **E10 blind spot closed.** In pythermalcomfort's 2004 path, vector E10 reaches its threshold only after the
    480-min run, so pythermalcomfort reports the run length (480 min). Zill finds the limit at 296.4 min
    (0.6 × 494).
- **Reflective-clothing trap.** pythermalcomfort's 2023 defaults (a_p 0.54, f_r 0.42) imply partly reflective clothing,
  with an emissivity of 0.759. In an Abu Dhabi sun case they lower the 8-h t_re from 39.88 to 38.76 °C and lengthen
  D_lim,tre from 35 to 43 min. Both errors are in the unsafe direction. Zill passes `aP = 0` and a neutral `fR`, which
  gives no reflective credit, for all its clothing ensembles.
- **Clothing inputs.** These come from `CLOTHING[id].phs` in `limits.ts`:

  | Ensemble | Insulation / i_mst | Status |
  |---|---|---|
  | Work clothes, cloth coveralls | 0.6 clo / 0.38 | Verified |
  | FR, SMS and polyolefin coveralls | 1.0 clo / 0.38 | UNVERIFIED; the protective end of the documented range; at the 1.0 clo validity limit |
  | Double layer | 1.0 clo | The summed value (about 1.1 clo) exceeds the validity bound, so it is capped and flagged |
  | Vapour-barrier coveralls | — | `applicable: false`: PHS is not run, and physiological monitoring is advised |

- **MRT input.** PHS needs the MRT of a person. The value currently available is the 2-inch globe MRT from §2.1. It is
  an upper bound and therefore conservative. The alternative recommended by phs_iso7933.md §10 is a human MRT computed
  from the radiation components (Di Napoli 2020). The choice is still open for the integration layer (LIMITATIONS
  M-05). PHS validity caps t_r − t_a at 60 °C.
- **Edition.** ISO 7933:2023 is the default. Its foreword lists one technical change: SW_max "is no longer adjusted for
  metabolic rate". Fixtures AD19 and AD01 run the same case under each edition (sun, 165 W/m², 0.6 clo,
  acclimatised):
  - 2004: sweating is capped; t_re after 480 min is 41.50 °C and D_lim,tre is 43 min.
  - 2023: t_re is 37.74 °C, and D_lim,loss is 190 min.

  The 2004 edition can still be selected, for regression against its normative Annex F.
- **Inputs outside the validity limits** are computed and flagged (`phsValidity`); they never return NaN. Inputs that
  cannot be computed at all (non-finite values, mass ≤ 0, clo ≤ 0, and similar) throw an error.

**Verification.**

| Check | Reference | Result |
|---|---|---|
| 50 vectors in both editions, plus variants and chained runs | `fixtures/phs.json` (pythermalcomfort 4.8.1, unrounded) | worst error: temperatures 3.6e-14 °C (tolerance 1e-6), α 2.6e-15 (1e-8), predicted sweat rate SW_p 1.2e-12 W/m² (1e-6), water loss 6.5e-11 g (1e-4), evaporative load 1.3e-9 W·min/m² (1e-3). Every D_lim is identical, including the drink = 0 values 71.39999999999999 (AD15) and 145.79999999999998 (E09). One deliberate difference: E10, above |
| `tclIteration` and `threshold3PctOnly` variants | fixture `variants` (reference implementation) | match |
| ISO 7933:2004 Annex F, 10 cases (normative) | published values | Engine defaults: t_re within 0.050 °C, water within 2.96 g, D_lim,tre exact, D_lim,loss50 and D_lim,loss95 within 1 min. With the 2004 BASIC body-heat constant (57.83): t_re within 0.047 °C (exact at the published 0.1 °C), water within 0.39 g, every D_lim to the minute |
| ISO 7933:2023 Annex F, 5 cases (informative) | published values, taken from pythermalcomfort issue #217 (UNVERIFIED against the PDF) | within 0.1 °C (t_re), 0.6 % (water and final sweat rate), 3 min (D_lim,loss) and 2 min (D_lim,tcr). The residual of about 0.5 % in water appears in every implementation and is unexplained. Case 3: 38.69 °C, 151 min, 281 min and 6,437 g, against 38.7, 149, 280 and 6,419 published |
| Chunked stepping | CHAIN-A (1 × 120 = 2 × 60 = arbitrary chunks); CHAIN-B (work 60 / rest 15, twice) | bit-identical |
| Speed | one 480-min run; one 120-min projection | median 0.331 ms; median 0.084 ms |
| Tests | `phs.test.ts` (84) | all pass |

**[ENG] decisions:**
- the drink restriction is sticky;
- the default `fR` is neutral, so there is no reflective credit;
- equal minutes resolve to `rectal`;
- limits latch;
- the E10 look-ahead;
- `tclIteration` and the pythermalcomfort drink-0 reading are the defaults, chosen because both are conservative.

**UNVERIFIED** (marked in the code):
- Values printed in ISO 7933:2023 that we could not read in the original:
  - the body-heat constant c_sp: 58.15 is kept for parity; the 2004 BASIC program uses 57.83 and MATLAB-2023 uses
    3490/60;
  - the clothing area factor f_cl = 1 + 0.28·I_cl;
  - the M validity range (56–250 W/m² is pythermalcomfort's reading);
  - the meaning of F_r and the Annex D table;
  - where h_c is evaluated in the loop.
- The 2023 Annex F values themselves, which come from the issue #217 table.
- The clothing values for FR coveralls.

### 2.4 Exposure limits: ISO 8996, NIOSH REL/RAL, ACGIH clothing and the allowed work fraction — `engine/limits.ts`

**Purpose.** Combine the environment, the task and the worker into an hourly work allowance that respects the
NIOSH/ACGIH exposure limits. This module also holds the reference tables that later steps use for hydration and
communication.

**Inputs.**
- WBGT at work and at rest (°C).
- The task's work class or metabolic rate (ISO 8996).
- The clothing ensemble, and whether a hood is worn.
- Body mass.
- Acclimatisation history (`daysOnSite`, `daysAwayRecent`, `experiencedInHeat`) and conservative mode.

**Key equations.**

```
RAL = 59.9 − 14.1·log10 M   unacclimatised; equals the ACGIH Action Limit       °C-WBGT_eff, M in W
REL = 56.7 − 11.5·log10 M   acclimatised; equals the ACGIH TLV                 NIOSH 2016 §8.1; = ISO 7243:2017 Annex A
M_eff = max(M, 115 W); no ceiling limit (NIOSH 2016 removed it)
WBGT_eff = WBGT + CAV(ensemble) + 1 °C if hooded                ACGIH 2026 Table 1; ISO 7243:2017 Formula 3; CAVs not additive
Allowed work fraction f = the largest f in [0, 1] with
    Limit(f·M_work + (1 − f)·M_rest) ≥ f·WBGT_eff,work + (1 − f)·WBGT_eff,rest     1-h TWA; M_rest = 115 W; rest in shade
workMinPerHour = 60·f
```

**Metabolic rates.** ACGIH Table 3 gives representative rates of 115 W (rest), 180 W (light), 300 W (moderate),
415 W (heavy) and 520 W (very heavy). The ISO 8996:2004 classes are 65/100/165/230/290 W/m², which is
115/180/295/415/520 W for 1.8 m² of body area. Rates are scaled by body mass as M·mass/70 (ACGIH Table 3 footnote).

**Clothing adjustment values (CAV).**

| Ensemble | CAV |
|---|---|
| Work clothes | 0 °C |
| Cloth coveralls | 0 °C |
| FR coveralls (Ashley & Bernard 2008) | 0 °C |
| SMS polypropylene coveralls | +0.5 °C |
| Polyolefin coveralls | +1 °C |
| Double-layer woven clothing | +3 °C |
| Limited-use vapour-barrier coveralls | +11 °C |

The WBGT method does not apply to Level A encapsulating suits, and physiological monitoring is advised with
vapour-barrier coveralls. ACGIH's −1 °C row for short sleeves is held as data but never applied.

**Acclimatisation** (`assessAcclimatization`). The share of the usual hot-work exposure allowed each day ramps up as
follows:

| Worker | Ramp |
|---|---|
| New worker (no previous hot season), absent 21 days or more, or history unknown | 20 / 40 / 60 / 80 / 100 % |
| Experienced worker absent 4–20 days | 50 / 60 / 80 / 100 / 100 % |
| Experienced worker absent less than 4 days | no ramp: acclimatisation is retained |

The worker's status follows the ramp:
- `unacclimatized` on days 1–7 of a stretch (ADOSH: a new worker, or off work for more than 14 days);
- `acclimatizing` while the ramp runs (the new-worker ramp runs through day 14);
- `acclimatized` after that.

The REL applies only to an acclimatised worker who is not in conservative mode. Everyone else gets the RAL.

**Hydration recommendation.**

```
recommendWaterMlPerHour = min( hourly cap 1.42 L/h,
                               remaining allowance under 11.36 L/day,
                               max( NIOSH floor ≈ 710 mL/h (1 cup every 20 min),
                                    TB MED 507 Table 3-2 value,
                                    ILO 2024 Table 8 value,
                                    PHS sweat rate,
                                    regulatory minimum ) )
```

The hyponatraemia caps (TB MED 507 2022; NIOSH 2017-126) beat every other term, including any regulatory figure above
1.42 L/h.

**Reference and communication tables.** These are also in this module, but none of them replaces the WBGT limits:
- the NWS heat index, using the full Rothfusz algorithm with both adjustments, for risk communication only;
- the TB MED 507 (2022) heat categories and water tables;
- ILO 2024 Table 8;
- the NIOSH heat-alert trigger;
- the OSHA proposed-rule triggers (proposed, not in force);
- the Bröde 2018 work-capacity curves (reference only);
- the ACGIH heat-strain limits, including a sustained heart rate of 180 − age.

**Implementation notes.**
- **Equations, not figures.** The code uses the equations rather than the NIOSH figures or rounded tables. The NIOSH
  figures are drawn up to 1.34 °C above the RAL equation, and OSHA's table is rounded inconsistently.
- **Solving for f.** The allowed-work function g(f) is convex, so bisection finds its unique root. The work and rest
  rates are each raised to at least 115 W before averaging. This is slightly more protective and keeps g convex.
- **High work rates.** Above 600 W the equation is extrapolated, and the result is flagged.
- **Bad inputs.** Functions throw on non-finite input, so the caller must apply the fail-safe defaults first.

**Verification.**

| Check | Reference | Result |
|---|---|---|
| RAL/REL at 12 rates | `fixtures/limits.json` | bit-exact (tolerance 1e-9) |
| ASSP 2022 published worked answers (2 decimal places) | ASSP | within 0.0047 °C, the rounding of the publication |
| ACGIH Table 2 screening criteria | published table | all 26 non-blank cells (13 TLV and 13 Action Limit) reproduced exactly after rounding half-up to 0.5 °C |
| Allowed work fraction, 8 cases | fixture | error ≤ 3.4e-11 in f, workMinPerHour and margin (tolerance 1e-6); the binding constraint matches in all 8 cases. Example: moderate work (300 W), RAL, sun 30 °C, shade 28 °C → f = 0.2808 (16.85 min/h) |
| Time-weighted averages, kcal/h → W, CAV and WBGT_eff, work-capacity curves | fixture | error 0 |
| NWS heat index, every branch | fixture (NWS algorithm) | error ≤ 8.6e-14. The bare Rothfusz value is within 2e-5 °C of pythermalcomfort. On the NOAA chart (135 cells), bare Rothfusz matches 129 cells exactly and all 135 within 1 °F; the full NWS algorithm matches 133/135 within 1 °F |
| Tests | `limits.test.ts` (207) | all pass |

**[ENG] decisions:**
- body-mass scaling only goes up (factor max(1, mass/70)), so a lighter worker is never credited with a lower rate;
- a metabolic-rate override is converted at 1.8 m²;
- a rate on a shared ISO 8996 class boundary goes to the higher class;
- the decay rule is stricter than the ADOSH TG re-acclimatisation table, and a test proves it is never less protective;
- `unacclimatized` lasts for days 1–7, the upper end of ADOSH's 5–7 days;
- a CAV is never negative;
- gaps between the printed Dubai Municipality heat-index bands go to the higher level.

**UNVERIFIED:**
- **ACGIH 2026 additions** (CAV −1 °C for short sleeves, +1 °C for a hood). These were seen only in the CCOHS
  reproduction of the paywalled booklet. Ashley & Bernard 2008 supports the hood value.
- **ISO 7243:2017 Annex A values.** Secondary source: Brimicombe et al. 2024.
- **ISO 8996:2021 Table A.1 ranges.** Not checked. The engine uses the 2004 Table A.2 classes, via the secondary
  source Foster et al. 2020.
- **ACGIH equations.** They are not printed in the booklet text. Their equality with the NIOSH equations rests on ASSP
  2022 and on the exact reproduction of Table 2.
- **PHS clothing values** for FR, SMS and polyolefin coveralls.

### 2.5 Thermal Work Limit (Brake & Bates 2002) — `engine/twl.ts`

**Purpose.** TWL is "the limiting (or maximum) sustainable metabolic rate that euhydrated, acclimatized individuals can
maintain in a specific thermal environment, within a safe deep body core temperature (< 38.20°C) and sweat rate
(< 1.2 kg/hr)" (Brake & Bates, Appl Occup Environ Hyg 2002;17(3):176–186). It is the index used by Abu Dhabi's ADOSH-SF
CoP 11.0 *Safety in the Heat* v4.0 and its Technical Guideline (15 July 2024), so it drives the regulation channel.

**Inputs.**

| Input | Notes |
|---|---|
| Dry-bulb temperature `tdbC` (°C) | — |
| Humidity | Psychrometric (aspirated) wet bulb, RH or vapour pressure. Never the natural wet bulb |
| Radiant temperature | MRT, or a globe temperature with its real diameter: 0.0508 m for the Liljegren globe; 0.15 m for a standard globe or a Kestrel 5400 reading |
| Wind (m/s) | Clamped to 0.2–4 m/s |
| Pressure | kPa |
| Clothing | Defaults: insulation I_cl 0.35 clo, vapour permeation 0.45 |

**Key equations.** Brake & Bates 2002 Appendix 1; research §1.4–1.6. The model solves for the mean skin temperature
t_sk at the limit, with core temperature t_core = 38.2 °C.

```
t_Σ  = 0.1·t_sk + 0.9·t_core;   K_cs = 84 + 72·tanh(1.3·(t_Σ − 37.9));   core-to-skin flow = K_cs·(t_core − t_sk)
S_r  = clamp(0.42 + 0.44·tanh(1.16·(t_Σ − 37.4)), 0, 0.67) kg m⁻² h⁻¹;   λS_r = 675·S_r W/m²
h_c  = 0.608·P^0.6·v^0.6;   h_r = 4.61·(1 + (t_r + t_sk)/546)³ × posture factor 0.73;   f_cl = 1 + 0.3·I_cl
E_max = f_pcl·f_cl·h_e·(p_sk,s − p_a),   h_e = 1587·h_c·P/(P − p_a)²
x = λS_r/E_max:  zone A (x < 0.46):        E = λS_r
                 zone B (0.46 ≤ x ≤ 1.7):  E = λS_r·exp[−0.4127·(x − 0.46)^1.168]
                 zone C (x > 1.7):         E = E_max
Root: core-to-skin flow = dry loss (C + R) + evaporative loss E
TWL = K_cs·(t_core − t_sk) / [1 − 0.0014·(34 − t_a) − 0.0173·(5.87 − p_a)]
```

**Solver.**
- The code scans t_sk downward from t_core in 0.05 K steps, as far as 20 °C, for the first root on the warm-skin side,
  then bisects to 1e-10 K.
- If the skin gains heat even at core temperature, TWL = 0 and the result is flagged `NO_ROOT_NET_HEAT_GAIN`.
- Zone thresholds are compared with the unrounded value. The display uses `floor`, because the printed tables appear to
  be truncated.

**Constants and provenance.**

| Constant | Value | Source |
|---|---|---|
| Core temperature t_core | 38.2 °C | B&B 2002 App. 1 |
| Maximum sweat rate S_r,max | 0.67 kg m⁻² h⁻¹ (1.2 L/h for a standard 1.8 m² person) | B&B 2002 App. 1 |
| Latent heat λ | 2430 kJ/kg | B&B 2002 App. 1 |
| Posture factor | 0.73 | B&B 2002 App. 1 |
| Lewis ratio | 16.5 K/kPa | B&B 2002 App. 1 |
| Wind limits | 0.2–4 m/s | B&B 2002 App. 1 |
| Valid range | 60–380 W/m² | B&B 2002 App. 1 |
| Psychrometer coefficient | 0.000644 K⁻¹ (P in kPa) | Not printed in the paper; fitted to Table I |
| Saturation vapour pressure | Tetens formula | Not printed in the paper; fitted to Table I |

**The zone-B ambiguity.** The paper prints the zone-B expression as `E = λS_r·exp[−0.4127·(1.8·λS_r/E_max − 0.46)^1.168]`.
Read literally, it is inconsistent with itself:
- efficiency is 0.88 at x = 0.46, where it should be 1;
- E jumps at x = 1.7;
- it reproduces the paper's own Table I with an rms error of about 46 W/m².

There are two consistent readings.
- **`physical` (Zill's default): no 1.8 factor.**
  - It is continuous.
  - It matches the paper's description of Figure 3: efficiency is 1 up to x = 0.46, and the skin is fully wet at
    x = 1.7, where efficiency is 1/1.7. Without the factor, exp[−0.4127·1.24^1.168] = 0.588264, against
    1/1.7 = 0.588235.
  - It matches the zone-B form in the authors' public Point Health calculator.
  - It gives lower, more protective TWL in dry, windy conditions.
- **`alt_1p8`: the 1.8 factor applied to the zone tests and to the exponent.**
  - It reproduces Table I more closely.
  - It reads up to about 63 W/m² higher in dry, windy Abu Dhabi conditions: 206 against 253 W/m² at 46 °C, 12 % RH,
    MRT 70 °C and 2 m/s; 212 against 275 W/m² at 47 °C, 10 % RH, MRT 70 °C and 3 m/s.
  - In a UAE field check (Bates & Schneider 2008, mean Calor HSM readings), it exceeds the largest TWL actually
    observed in 3 of the 4 time slots.

The two readings differ only when x < 1.7, which means low humidity, high wind or both. Zill uses `physical`, and a test
proves that it is never above `alt_1p8`.

**Verification.**

| Check | Reference | Result |
|---|---|---|
| 42 reference vectors, both readings | `fixtures/twl.json` (repository oracle, `scripts/oracles/twl_oracle.py`) | max error 7.4e-6 W/m² (tolerance ±0.05); skin temperature 5.0e-7 K (±0.001); heat-balance terms within 1e-4; flags identical in 42/42 |
| Brake & Bates 2002 Table I: 75 cells (62 numeric, 13 "n/p") | oracle, both readings | max error 4.8e-7 W/m² |
| Same table, against the printed values | published | `physical`: the 54 zone-C cells within 1.34 W/m²; all 62 between −10.1 and +1.3 W/m²; mean +0.03, rms 1.87. The 8 low-x zone-B cells range from +0.4 to −10.1. `alt_1p8`: max 1.86, mean +0.69, rms 0.85; 45 of 62 cells equal floor(model). All 13 "n/p" cells compute below 99.73 W/m² |
| Worked examples | B&B 2002 text and Appendix 2 | 110.7 (published 110), 158.3 (158), 217.0 (about 220) |
| AOH 2002, high-wind cases | published | within 0.54 W/m². The low-wind cases are +5.6 and +7.6 W/m² off; the cause is unexplained (UNVERIFIED) |
| Sensitivity around 40 °C dry bulb, 40 % RH, MRT 65 °C, 1 m/s (TWL 148) | research §1.8 | reproduced: dry bulb +1 °C → 134; MRT +5 °C → 135; wind 2 m/s → 181; RH 50 % → 105 |
| Globe → MRT conversion (ISO 7726) | pythermalcomfort `mean_radiant_tmp(standard="ISO")` (research §1.7) | within 1e-6 °C. A 50 °C globe at 40 °C air and 1 m/s gives an MRT of 67.1 °C for a 150 mm globe and 82.6 °C for a 25 mm globe |
| Tests | `twl.test.ts` (108) | all pass |

We found no other open-source TWL implementation (research §1.9). The repository oracle is the reference
implementation, and the paper's Table I and worked examples are the standard to meet.

**[ENG] decisions.**
- `physical` is the default reading.
- A non-finite input returns NaN with the flag `INVALID_INPUT`, which the regulation layer maps to the most protective
  zone.
- Zone boundaries are resolved protectively (§2.6).
- Brake & Bates's withdrawal backstops (dry bulb > 44 °C, wet bulb > 32 °C) are reported as advisory flags only,
  because they are not part of ADOSH v4.0.

**Scope.**
- **Who the model is for.** It assumes self-paced, educated, hydrated, acclimatised workers in permeable clothing.
  Unacclimatised workers are handled by the zone rules instead; a lack of acclimatisation "may reduce this [TWL] by up
  to 25%" (Miller & Bates 2007).
- **Where it does not apply.** Encapsulating clothing, or a dew point at or above skin temperature.
- **Independent validation is mixed.** Kapanowski (2018) found a 7 % probability that work at the TWL threshold is
  unsustainable, against 1 % for the TLV and REL. Bernard et al. (2022) report a probability of uncompensable heat
  stress of 0.14–0.22 at the TWL limit.

**UNVERIFIED:**
- the psychrometer coefficient and saturation formula the authors used (Zill's are fitted);
- the globe size of the Calor HSM meter used in the UAE studies;
- the cause of the 5.6–7.6 W/m² low-wind gap against AOH 2002 Table 2, and of the gap of about +7 W/m² against Miller &
  Bates 2007.

### 2.6 Jurisdiction rule packs: ADOSH and MoHRE — `engine/regulation.ts`

**Purpose.** Hold the law as data and compute the regulatory floor that Zill never goes below. There are three packs:
`abu-dhabi` (the default), `sharjah` and `qatar`. When more than one rule applies, the most protective wins (ADOSH CoP
11.0 §1(b): "follow the more stringent requirement").

**Abu Dhabi pack.** Sources: ADOSH-SF CoP 11.0 *Safety in the Heat* and Technical Guideline v4.0 (ADPHC, 15 July 2024),
TG Table 1; MoHRE Ministerial Resolution No. 44 of 2022.

| Zone (TWL, W/m²) | Level | Light work | Heavy work | Water (L/h) | Unacclimatised workers | Lone work |
|---|---|---|---|---|---|---|
| Low: TWL > 140 | safe | continuous | continuous | 0.6–1.0 | allowed | allowed |
| Medium: 115 < TWL ≤ 140 | caution | continuous | 45 min work / 15 min rest | light 1.0–1.2; heavy > 1.2 | not allowed: `stop` for that worker, who is reassigned | not allowed |
| High: TWL ≤ 115 | high | 45 / 15 | 20 / 40 | > 1.2 | not allowed: `stop` for that worker | not allowed; the pack also sets permit-to-work |

- **Midday break.** From 15 June to 15 September inclusive, between 12:30 and 15:00 local time (12:30 ≤ t < 15:00,
  UTC+4), outdoor work in direct sun or in open places gives `stop` with the action `midday_break`. The exemptions
  listed in the rule (asphalt and concrete work, essential repairs, permitted works) are stored as data and never
  applied automatically.
- **Heat-stress programme.** Required when a shift's temperature reaches 35 °C or more (CoP §3.1.1(e)).
- **Acclimatisation.** "Unacclimatised workers are defined as new workers or those who have been off work for more than
  14 days due to illness or on vacation leave (in a cool climate area)" (TG Table 1 note b). The CoP allows 5–7 days of
  acclimatisation (§3.2(b)(i)). `regulatoryFloor` treats `acclimatizing` workers as unacclimatised. The TG ramps are
  20/40/60/80/100 % for new workers and 50/60/80/100/100 % for experienced workers; the pack also holds the TG's
  re-acclimatisation table.
- **Incident notification** (Mechanism 11.0, Form G). A fatality within 24 h; other serious incidents within 3 working
  days.
- **Penalty** for breaching the midday break. AED 5,000 per worker, up to AED 50,000. This comes from secondary
  sources.

**Other packs** (a configuration change, not a code change).
- **Sharjah:** OSHJ-CoP-33 v2 Rev 0 (3 July 2024), Table 3, with four zones:

  | Zone (TWL, W/m²) | Rule | Water (L/h) |
  |---|---|---|
  | High: < 115 | No ordinary work, so the level is `stop` | 1.5 |
  | Medium: 115–140 | Heavy work 40 min work / 20 min rest | 1.2 |
  | Low: 140–220 | — | 1.0 |
  | Unrestricted: > 220 | — | 0.5 |

  The federal midday break applies as in Abu Dhabi.
- **Qatar:** Ministerial Decision No. 17 of 2021.
  - Outdoor work is banned from 1 June to 15 September, 10:00–15:30 Doha time (UTC+3).
  - Work stops whenever WBGT is above 32.1 °C (strictly above).
  - The decision was read in the ILO's unofficial translation.

**Implementation notes.**
- **Exact boundary values [ENG].** A TWL exactly on 115 or 140 goes to the more protective zone (High ≤ 115 < Medium
  ≤ 140 < Low). The research oracle and twl_and_regulation.md §6.2 use half-open intervals instead (115 = Medium,
  140 = Low). No fixture vector sits exactly on a boundary.
- **Water.** The packs' water bands are reported, but the 1.42 L/h hourly cap (§2.4, §2.8) always wins. Sharjah's
  High zone, for example, prints 1.5 L/h.
- **Time zone.** Each pack applies its own time zone. The UAE packs use Asia/Dubai, UTC+4 with no daylight saving
  (`time.ts`).

**Verification.** No numeric oracle applies. The 65 tests in `regulation.test.ts` check boundaries and data integrity:
- the midday-break minute and date boundaries (12:29 → false, 12:30 → true, 14:59 → true);
- the zone boundaries (114.99, 115, 140 and others);
- every pack can be looked up by its id and is deeply frozen;
- zones are ascending, contiguous and never less protective as TWL falls;
- every driver cites its basis.

**[ENG] decisions:**
- **Boundaries.** Exact boundary values go to the more protective zone.
- **ADOSH Low zone, heavy work.** TG Table 1 prints no water row for this case, so the light-work band (0.6–1.0 L/h) is
  used as the minimum. The PHS sweat rate may raise it.
- **Lone work.** ADOSH's "working alone to be avoided" is applied as no lone work.
- **Sharjah High zone.** It also bars unacclimatised workers and lone work.
- **Fail-safes.**
  - `isMiddayBreak(NaN)` and `heatStressProgramRequired(NaN)` return true.
  - A missing WBGT under a pack with a WBGT stop rule gives `caution` + `check_sensor`.
  - A non-finite TWL goes to the most protective zone.
  - Fractional days round up.

**UNVERIFIED:**
- the article number of the midday-break provision within MR 44/2022;
- the midday-break window itself against the MoHRE primary page, which could not be reached. The window was taken
  from Aletihad (2024) and the search-indexed title of MoHRE's 2025 news item;
- the AED 5,000/50,000 penalty, which comes from secondary sources, with no 2026 confirmation found;
- two Sharjah readings. Medium's printed "Acclimatised employees not allowed to work" is read as *un*-acclimatised.
  Low's "… allowed to work, but not alone" is read as applying to unacclimatised workers;
- the Qatar decision (ILO unofficial translation).

Not transcribed: Sharjah's acclimatisation definition, notification duty and heat-programme trigger; Qatar's
hydration, notification and acclimatisation rules.

### 2.7 Physiology: ECTemp, PSI and the signal-quality index — `engine/physio.ts`

**Purpose.** With the worker's consent, the heart-rate (HR) stream from a wrist wearable is processed on the device. It
becomes two indicators: an estimated core temperature (ECTemp), which is a strain indicator, and the Physiological
Strain Index (PSI). This channel can raise the level. It never lowers it, never produces T3 and never triggers a 998
call by itself, because a core-temperature estimate cannot detect central-nervous-system dysfunction.

**Inputs.**
- Raw HR samples with a skin-contact flag (`HrRawSample`: `tSec`, `bpm`, `contactOk`), or 1-minute summaries.
- A seated resting baseline HR, if one was captured.
- Age, consent and risk flags. The flag `hr_suppressing_medication` switches off every HR rule.

**Key equations.**

```
ECTemp (Buller et al. 2013, Physiol Meas 34:781–798; constants verbatim from USARIEM estimateTcore.js):
  a scalar extended Kalman filter on 1-min mean HR
  time update:   CT⁻ = CT_{t−1};   v⁻ = v_{t−1} + γ²,                       γ = 0.022 °C per minute
  observation:   HR = −4.5714·CT² + 384.4286·CT − 7887.1,                    σ = 18.88 bpm
  measurement:   c = dHR/dCT at CT⁻;   k = v⁻·c / (c²·v⁻ + σ²·R);   CT = CT⁻ + k·(HR − HR(CT⁻));   v = (1 − k·c)·v⁻
  start:         CT0 = 37.1 °C, v0 = 0. A missing or invalid minute is a time update only, as is c ≤ 0 (beyond the vertex)
  optional sigmoid observation model (US 12,426,839 B2):
                 HR = 41 + (193 − 41)/(1 + 0.06·e^(−0.89·(CT − 37.84)))^(1/0.07)

Minute signal-quality index ψ = the share of expected samples that are valid:
                 40–200 bpm, skin contact, max/min ratio < 2.2 in each 10-s segment, no flatline
                 the minute is valid when ψ ≥ 0.80;   noise scale R = exp(ψ⁻² − 1), infinite below 0.80

PSI (Moran 1998):  PSI = 5·(CT_t − CT_0)/(39.5 − CT_0) + 5·(HR_t − HR_0)/(180 − HR_0),  displayed on 0–10
```

**When the channel counts** (ARCHITECTURE §5; physio_and_clinical.md §10.5). The channel is valid only when all four
conditions hold:
- the worker has consented and a wearable is paired;
- no `hr_suppressing_medication` flag is set;
- the 30-minute warm-up is complete;
- at least 10 of the last 15 minutes are valid.

**Escalation floors.** Each condition must hold over the 5 most recent valid minutes in the 15-minute window. Invalid
minutes neither count nor reset the run [ENG], so a dropout cannot postpone an escalation.

| Floor | Trigger | Result |
|---|---|---|
| Advisory | ECTemp ≥ 38.0 °C or PSI > 4 | Prompts a check-in only |
| T1 | ECTemp ≥ 38.4 °C (≥ 38.0 °C in conservative mode), PSI > 6, or HR > 180 − age | `high`: rest in shade, cool down, drink, check-in, buddy check |
| T2 | ECTemp ≥ 39.0 °C or PSI > 8 | `stop`, first aider now, no more hot work today |

**Other rules.**
- **Unknown age.** Age 50 is assumed, which sets the HR limit at 130 bpm. Age 50 is the NIOSH 2016 boundary for extra
  medical evaluation [ENG].
- **Implausibly high HR.** HR above 200 bpm with good contact for 2 consecutive minutes adds an information driver, a
  check-in prompt and a buddy check, even when the channel is otherwise invalid. Consent is still required.
- **Display.** The worker sees ECTemp only as "≈ x ± 0.6 °C", reflecting Buller 2013's limits of agreement of
  ±0.63 °C. The value is clamped to 35.5–42.0 °C and hidden during warm-up, while the channel is invalid, and when the
  HR-suppressing medication flag is set.
- **Gaps in the HR stream.** A gap of up to 5 missing minutes is interpolated afterwards, using the larger of the two
  neighbouring noise scales. A gap of more than 30 minutes re-initialises the filter and restarts the warm-up.
- **PSI baseline.** HR0 is the seated pre-work baseline if there is one; otherwise it is the first 5 usable minutes of
  the shift. No screen captures a seated baseline yet. PSI is invalid when CT0 ≥ 39.5 °C or HR0 ≥ 180 bpm.
- **PSI bands.** 0–2 no/little, 3–4 low, 5–6 moderate, 7–8 high, 9–10 very high. UNVERIFIED: this table was checked
  only through its reproduction in US 11,564,579 B2.
- **aPSI.** The adaptive PSI is implemented for reference only and is not used by the channel.

**Accuracy reported for the published model.** Zill did not re-measure these figures.
- **Buller 2013** (validation group N = 83, more than 52,000 minutes): bias −0.03 ± 0.32 °C; 95 % limits of agreement
  ±0.63 °C; RMSE 0.30 ± 0.13 °C.
- **Individual accuracy is poor, and so is sensitivity at high core temperature.** Sensitivity was 48 % for estimates
  above 39.0 °C and 4 % above 39.5 °C (de Korte et al. 2022). ECTemp alone flagged 23.3 % of 30 exertional heat illness
  cases among 5,080 recruits (physio_and_clinical.md ref. B25).
- **Wrist PPG heart rate is less accurate than a chest strap.** Mean absolute error ranged from 4.5 to 14 bpm across 10
  devices. In construction work, bias against a chest strap was 1.6 ± 4.9 bpm.

**Verification.**

| Check | Reference | Result |
|---|---|---|
| ECTemp, 1,642 minute-steps over 11 vectors (both observation models; missing minutes; a ψ = 0.85 vector with scaled noise; published initial-state variants) | `fixtures/physio/physio_fixtures.json` (Python oracle that reproduces the USARIEM JavaScript bit for bit, 581/581 minutes) | max error in CT 0 for both models (tolerance 1e-9 °C); variance 0 (quadratic) and 3.5e-18 (sigmoid) (tolerance 1e-12); the streaming tracker also 0 |
| PSI, aPSI, signal-quality index | fixtures rounded to 6 decimals | errors 4.8e-7, 4.1e-7 and 3.3e-7 (tolerance 1e-6); every PSI band, minute validity and flag matches |
| Channel floors | oracle vectors in `clinical_rules_fixtures.json` (7) and the physio_and_clinical.md §10.11 inline vectors | tiers reproduced |
| Properties | — | an invalid channel never raises or lowers the level; a valid channel never lowers it and never reaches T3 |
| Tests | `physio.test.ts` (60) | all pass |

**Intellectual property.** Three US patents cover these methods:
- ECTemp: US 10,702,165 B2 (US Army; estimated expiry 16 December 2033);
- its sigmoid refinement: US 12,426,839 B2 (estimated expiry 4 February 2042);
- aPSI: US 11,564,579 B2 (adjusted expiry 25 February 2038).

USARIEM states that commercial use needs a licence. Legal review is required before any commercial deployment
(LIMITATIONS P-07).

**[ENG] decisions** (these need occupational-physician sign-off):
- the ECTemp floors 38.0, 38.4 and 39.0 °C;
- the ψ threshold of 0.80;
- the 30-minute warm-up;
- the 5-minute and 30-minute gap rules;
- the age-50 default;
- the reading of "sustained" given above.

**UNVERIFIED:**
- the Moran 1998 PSI band table;
- the Orphanidou ratio of 2.2, from secondary sources only;
- whether UAE or GCC equivalents of the US patents exist.

### 2.8 Clinical rules: triage, cooling and fluids — `engine/clinical.ts`

**Purpose.** Turn check-ins (from the worker, a buddy, the supervisor or a first aider), urine colour and logged
drinks into a tier from T0 to T3, with first-aid actions. Symptoms override models (ARCHITECTURE principle 4). These
are occupational first-aid and safety rules. They do not diagnose: a "suspected" condition triggers a human check and
first aid.

**Inputs.**
- A `Checkin`: symptoms, urine colour on a 1–8 scale, and the trend at a follow-up check.
- The earlier check-ins of the same episode.
- Logged drinks (`FluidIntake`).
- Risk flags, consent and fasting status.

**Triage table** (physio_and_clinical.md §10.7; each YES answer sets a tier, and the final tier is the maximum):

| Tier → level | Symptoms | Actions |
|---|---|---|
| **T3 → emergency** | confusion, slurred speech, unsteady walking, collapse or unresponsive, seizure, chest pain, repeated vomiting | call 998, cool first, stay with the worker, first aider |
| **T2 → stop** | fainted (now alert), dizziness, headache, nausea, weakness or fatigue, brown urine, cramps lasting 60 min or more, over-drinking with symptoms (suspected hyponatraemia, `restrict_fluids`) | first aider now, no more hot work today |
| **T1 → high** | cramps, heat rash, very dark urine (shade 7–8) | rest in shade, cool down, tell the supervisor |
| **T0** | thirst | drink advice |

"Over-drinking with symptoms" means having drunk a lot together with headache, nausea or swollen hands.

**Timing rules.**
- **Re-checks** at +15 and +30 minutes, then every 15 minutes.
- **Escalation to T3.** A T2 case that is not clearly improving at 30 minutes, or any worsening, becomes T3. A missing
  trend at the re-check counts as not improving.
- **Episodes.** An episode is one worker's symptomatic check-ins on the same local day, linked by gaps of 60 minutes or
  less [ENG].
- **Unanswered prompts.** The buddy is notified at 5 minutes and the supervisor at 10 minutes; the 10-minute step is
  [ENG].
- **Who may report.** Check-ins from a buddy, supervisor or first aider are always used, because of the worker's vital
  interest. The worker's own check-ins are used only with the `checkins` consent.

**Cooling protocol for T3** (`COOLING_PROTOCOL`; built [ENG] from ILCOR 2019, TB MED 507 2022, IOC 2021, OSHA and NATA):
1. Call 998 and alert the first aider and the supervisor.
2. Move the worker to shade and remove outer clothing.
3. Cool now, best method first: immersion in cold water or a tarp (TACO), neck down, water 1–26 °C, kept stirred.
4. If immersion is impossible: continuous cold-water dousing with fanning, or ice-water towels changed every 1–2 min
   plus ice packs.
5. Keep cooling until the ambulance team takes over. Without a thermometer, stop ice-water immersion after about
   15 min, or as soon as the worker is alert and oriented.
6. Give sips only if the worker is fully alert and not vomiting. Never leave the worker alone.

The principle is cool first, transport second: "Do not delay cooling for want of rectal temperature" (TB MED 507
§5-1b). Harm rises when cooling is delayed beyond 30 minutes (NATA).

**Urine colour** (Armstrong 8-shade chart):

| Shade | Reading | Tier |
|---|---|---|
| 1–3 | OK | T0 |
| 4 | Drink more (a driver only) | T0 |
| 5–6 | Probably dehydrated. McKenzie 2015: shade ≥ 5 identified a body-mass loss of 2 % or more with 88.9 % sensitivity and 84.8 % specificity | T0; T1 if still ≥ 5 at the next reading |
| 7–8 | Very dark | T1 |
| Brown, red or cola | Not a hydration colour (possible rhabdomyolysis) | T2 |

**Fluids.**
- **Caps.** The hourly cap is 1.5 US quarts (1.4195 L/h) and the daily cap is 12 quarts (11.356 L) (TB MED 507 2022;
  NIOSH).
- **Reminders.** 250 mL every 20 minutes. Electrolyte drinks are advised after 120 minutes of sweating; salt tablets are
  not.
- **Fasting.** No drink reminders during fasting hours. First aid for symptomatic tiers overrides the fast.
- **Over the hourly cap.** Reminders stop and the message is "slow down".
- **Over the daily cap.** The level is `high`.
- **Over a cap with symptoms.** The level is `stop`, with `restrict_fluids`.
- **After reported over-drinking.** No drink advice at any tier.

**Risk flags and conservative mode.**
- **Flags are never scored.** They are booleans, never added up: US Army doctrine (TB MED 507) states that scoring risk
  factors "is not recommended".
- **What switches conservative mode on:** any flag except `oh_review_required`; the first 14 days on the job; a return
  after 7 or more days away; heat rash reported today.
- **What conservative mode changes:**
  - the RAL replaces the REL, and the next-stricter work/rest tier applies;
  - the ECTemp T1 floor drops to 38.0 °C;
  - check-ins every 30 minutes from `caution`;
  - a buddy is mandatory.
- **`hr_suppressing_medication`** switches off all HR rules.
- **`oh_review_required`** prompts a confidential occupational-health review instead of an automatic rule.

**Verification.**
- **Oracle fixtures.** `fixtures/physio/clinical_rules_fixtures.json` (from `scripts/oracles/physio/clinical_rules.py`)
  holds the triage, urine, fluid-cap, fusion and physiology-floor vectors. physio_and_clinical.md §10.11 adds inline
  vectors.
- **Fluid caps.** Computed from the exact US quart and fluid-ounce definitions, they equal the oracle constants bit for
  bit.
- **Tests.** `clinical.test.ts` (65) all pass. They include a check that no text claims diagnosis, heat-stroke
  prediction or core-temperature measurement.

**[ENG] decisions** (all need occupational-physician sign-off):
- the 30-minute re-check;
- the 60-minute episode link;
- the 10-minute escalation to the supervisor;
- the 250 mL / 20-minute reminder;
- cramps count as T2 when a cramps medical risk or `oh_review_required` is present;
- reports by others are used without the worker's check-in consent;
- the hydration channel keeps the day's latest urine reading, with no age-out.

**UNVERIFIED:**
- **ACSM 2023.** The full text is paywalled, its numeric cooling targets were not transcribed, and one co-author
  dissented.
- **AHA/Red Cross 2024 First Aid Guidelines.** The heat section was not retrieved.
- **ADPHC 2026 hydration advice.** Taken from a press report.
- **The number 998.** Verified on u.ae (page updated 1 October 2026); it must be re-verified at every release.

### 2.9 The projection during a shift: water-loss limit, hold and the planner screen — `engine/risk.ts`, `engine/planner.ts`

**Purpose.** §2.3 shows that the PHS kernel is computed correctly. This section covers how the engine turns it into
decisions during a working day, and what the simulated cohort shows about the projection. The full rules are in
ARCHITECTURE §5; this section gives their derivation and evidence.

**Water-loss limit with logged drinking** (`RISK_THRESHOLDS.hydrationCredit`, `creditedIntakeL`; the additive `phs.ts`
option `PhsProjectionOptions.lossThresholdG`).

- **What ISO 7933 fixes.** Annex B limits the cumulative water loss: D_max = 5 % of body mass when the worker can drink
  freely and 3 % when drinking is restricted (§2.3). ISO 7933's limits are set to protect 95 % of the exposed
  population (Scope; LIMITATIONS M-07). The drink-allowed limit is set on the loss itself: ISO 7933 has no input for
  what the worker actually drank.
- **The engine's reading** [ENG]. Read together, the two limits imply that free drinking replaces about 40 % of the
  loss: a 5 % loss with 40 % replaced leaves the 3 % net loss that is the limit without drinking (1 − 3/5 = 0.4,
  `isoImpliedReplacement`). This is the engine's interpretation of how the two ISO limits relate, not a figure printed
  in ISO 7933. The ACSM 2007 fluid-replacement position stand points the same way: it advises against losing more than
  2 % of body mass.
- **The criterion.** The net loss, sweat loss − max(C, 0.4 × sweat loss), must stay at or below 3 % of body mass, where
  C is the credited intake. Expressed on the cumulative sweat loss, the limit is max(5 % BM, 3 % BM + C). It stays at
  ISO's 5 % until the credited drinking exceeds what ISO already assumes (C > 2 % BM, because 0.4 × 5 % = 2 %); beyond
  that it is ISO's drink-restricted 3 % applied to the loss that drinking did not replace. For the 75-kg reference
  worker of the tests the limit is 3.75 L without credit, and it rises above 3.75 L only after more than 1.5 L has been
  credited (`risk.test.ts` known answers: limit = max(3.75, 2.25 + C) L).
- **The credit.** C = 0.8 × Σ over local clock hours of min(logged intake that hour, 1.42 L), counted from the shift
  start.
  - Factor 0.8 [ENG]: self-reported intake may over-state what was drunk.
  - The hourly cap (1.5 US qt ≈ 1.42 L, TB MED 507 2022) is the hyponatraemia cap of §2.8, so drinking beyond it earns
    no credit.
  - Intake logs are hydration data, so they count only with the `checkins` consent, as in the hydration channel.
- **Why it is never less protective than ISO 7933 when nothing is logged.**
  - With no logs, or without consent, C = 0 and the limit is exactly ISO's 5 % (`phs.test.ts` › "absent, NaN, or
    at/below the ISO 5 % value → bit-identical to ISO 7933 for every fixture vector"; `risk.test.ts` › "no logs →
    exactly ISO 7933: threshold 5 % of body mass …", which also shows that logs without consent change nothing).
  - Logged drinking moves the limit only after the credited intake exceeds the replacement ISO already assumes, and the
    criterion is then still an ISO limit (3 %), applied to the unreplaced loss.
  - The credit is discounted (0.8) and capped per hour, and projections assume no further drinking.
  - While drinking is restricted (drink = 0 now or earlier in the exposure, for example while fasting), nothing is
    credited and ISO's 3 % criterion with the 0.6 rule applies unchanged (`risk.test.ts` › "fasting (drink = 0): the ISO
    drink-restricted criterion is unchanged by logged drinks").
- **What it does relax.** Once a worker has drunk more than ISO assumes, the device no longer ends heat work at a 5 %
  sweat loss. With drinking allowed, a reached water-loss limit may also restart after the reviewed recovery once the
  net loss is ≤ 2 % of body mass [ENG: a 1 % deadband below the 3 % criterion] (`risk.test.ts` › "a reached water-loss
  limit is recoverable by drinking: blocked while net > 2 % of body mass, then the reviewed restart"). Both rely on
  self-reported intake (LIMITATIONS M-22).

**Hold and resume check** (`RISK_THRESHOLDS.resume`). The rules are in ARCHITECTURE §5. The basis is alarm management
(ANSI/ISA-18.2): an alarm's clear point sits a deadband away from its set point. The projection stop sets below 15 min
and clears only when the task the worker returns to projects at least 25 min from the worker's current state, which
leaves a minimum useful bout of 10 min [ENG]. The check is an ISO 7933 projection at that task's metabolic rate,
clothing and location. The hold applies only before a limit is reached; a reached limit still needs the reviewed
recovery, because ISO 7933:2023 clause 5 says recovery after the limit cannot be modelled validly. If 60 min of rest
would not pass the check, the task is reported as not feasible now instead of keeping the worker waiting without an
explanation. Tests: `risk.test.ts` › "holds stop through rest until the resume check projects ≥ 25 min; monotone rest
estimate; ≥ 10-min bouts (no flapping)" and "infeasible now: even 60 min of rest would not pass → task_not_feasible_now
+ rotate_task; a lighter resume task releases".

**Planner screen** (`PHS_SCREEN`). The planner runs the same projection over the planned day, block-hour by block-hour,
for a reference worker [ENG]: 75 kg and 1.75 m, the task's clothing, the least-acclimatised known crew member, and
drinking allowed with the ISO 5 % criterion (no logs exist at plan time). The rule for each task-hour is in ARCHITECTURE
§5. Its purpose is that plan and monitor agree: following the plan at the planned conditions never triggers a
projection stop for the reference worker (`planner.test.ts` › "following the plan exactly at constant conditions never
triggers a projection stop for the reference worker").
- **Observation, not tuned** (engine owner's synthetic cases, `docs/dev/wave2c-engine-risk.md` §6). PHS rest in the
  air-conditioned cabin levels off at t_re ≈ 37.1–37.2 °C after about 60 min, and with 45-min rests t_re at the end of
  each hour creeps up by about 0.07 °C per hour. Heavy work in FR coveralls in direct sun therefore screens to about
  10–30 min of work per hour even on mild days.
- **In the simulated cohort** (`docs/dev/work-cost-drivers.md`, generated): per worker-shift, the screen set the planned
  rate in 61 of 341 task wall-minutes, at a 23 % work share. NIOSH/ACGIH allowances set it in 240 wall-minutes, at a
  41 % work share. The standards' allowances, not the screen, set most of the plan.

**Calibration against the simulated ground truth** [simulated cohort; VALIDATION-COHORT §3.5].
- **Method.** In the shadow arms the engine runs but nobody acts on it. Every 5th working minute, the engine's projected
  minutes to its ISO 7933 limit is compared with whether the Gagge ground truth reaches core ≥ 38.0 °C or ≥ 3 %
  dehydration within the bin's window.
- **Result, v0.2 cohort** (stamp `zill@0.1.0+code.70c2fd8ca722+inputs.08e6c3972293`). The projection had already
  reached its limit in 49 % of samples (10,880 of 22,338). The ground truth reached its limit within 15 min in 8.4 % of
  those. Across all bins the share is 8.4–12.6 %, roughly the same whatever the projected minutes. In v0.1 (stamp
  `zill@0.1.0+code.5c82cd69d232+inputs.08e6c3972293`) the figures were 52 % (12,244 of 23,719) and 5.2 %, with 4.3–10.3 %
  across bins.
- **Reading.** Against this ground truth the projection is strongly conservative: it reaches its limit long before the
  virtual worker does. It also does not discriminate: the projected minutes do not rank when the ground-truth limit
  comes.
- **Why** (design reasons; their separate shares have not been measured):
  - ISO 7933's limits are set to protect 95 % of the exposed population, while each virtual worker is one individual
    with hidden traits;
  - the projection assumes the current activity continues unchanged for up to 120 min, while the virtual workers
    self-pace and take breaks;
  - a reached limit stays at 0 for the rest of the exposure (ISO 7933:2023 clause 5), while the ground truth can cool
    down;
  - PHS and Gagge's two-node model differ in structure. How far they differ at identical inputs has not been measured in
    this repository.
- **The rise from 5.2 % to 8.4 %** is consistent with the corrected ground-truth drinking model (SIMULATION.md §3.3). It
  makes ≥ 3 % dehydration more common in the midday-ban-only behaviour that shadow mode reproduces: 282 against 51
  worker-shifts per 1,000. The share of samples at 0 changed little (52 % → 49 %).
- **Consequence for claims.** Minutes-to-limit is a conservative screening projection for an average person. It is not
  a forecast of when a particular worker will overheat, and Zill does not present it as one.

---

## 3. Fusion design (ARCHITECTURE §5–6)

This section was written as the design before `indices.ts`, `risk.ts` and `alerts.ts` existed. They now exist, are
unit-tested and run end to end in the world simulation. ARCHITECTURE §5–6 describe the implemented rules, including
what the design below did not yet have: the projection hold and resume check, the water-loss limit with logged
drinking (§2.9), the day-plan cap, the alert basis and the escalation record. Where this section and ARCHITECTURE
differ, ARCHITECTURE and the code are authoritative. The shared contract, `TIER_TO_LEVEL` and `maxLevel` in
`types.ts`, is tested: `clinical.test.ts` › "fusion vectors (§10.6) through the shared TIER_TO_LEVEL / maxLevel
contract" checks that the result is the maximum over the available channels and that a missing channel never lowers
anything, and `risk.test.ts` › "level = max over available channels (unless held); …" checks the same in the engine.

**From samples to indices** (`indices.ts`): `EnvSample` → `HeatIndices`, using `wbgtComponents` (§2.1), `computeTwl`
(§2.5) and `heatIndexNwsC` (§2.4). The wave-1 notes set these requirements:
- **TWL input.** TWL takes a psychrometric wet bulb, RH or vapour pressure, never the natural wet bulb. Pressure is
  `pHpa/10` kPa. The radiant input is an MRT, or `tgC` with the real globe diameter (0.0508 m). The raw wind is passed
  in, because the model clamps it to 0.2–4 m/s itself.
- **PHS input.** PHS takes the 2 m wind as the air speed at the body, `aP = 0`, and the clothing values from
  `CLOTHING[id].phs`. PHS is skipped when that ensemble is marked not applicable.
- **Clothing.** `WBGT_eff = wbgtEffectiveC(wbgtC, task.clothing ?? worker.clothing, task.hood)`.
- **Stale-data margin.** The data layer's stale margin (`ResolvedEnvironment.wbgtMarginC`) is added to WBGT_eff.
- **Radiant boost.** The radiant boost applies only to the modelled globe. It is never added to a measured WBGT.

**Channels.** Each channel returns `{level, available, drivers[]}`.

| Channel | Level rule (design) | Basis |
|---|---|---|
| environment | Uses f from §2.4, with the REL (acclimatised) or RAL (unacclimatised, acclimatising or conservative mode): f ≥ 1 with ≥ 1 °C margin → safe; f ≥ 1 within 1 °C, or f ≥ 0.75 → caution; 0.25 ≤ f < 0.75 → high; f < 0.25 → stop (heavy outdoor work deferred; light tasks only) | NIOSH 2016 §8.1, ACGIH TLV, ISO 7243:2017 |
| regulation | `regulatoryFloor` (§2.6): midday break while working outdoors in the sun → stop; ADOSH zone level and controls; an unacclimatised worker in the Medium or High zone → stop for that worker | MoHRE MR 44/2022; ADOSH-SF CoP 11.0 v4.0 + TG Table 1 |
| projection | `minutesToLimit` (§2.3) at the current activity: > 90 min → safe; 45–90 → caution; 15–45 → high; < 15 or already exceeded → stop. A stop below 15 min is held until the resume check passes; the water-loss limit credits logged drinking (§2.9). Inputs outside the validity range lower the confidence and are logged | ISO 7933:2023; ANSI/ISA-18.2 |
| physiology | `physiologyLevel` (§2.7); raises only | Buller 2013; Hunt 2019; Moran 1998; NIOSH 2016 |
| symptoms | `symptomsChannel` (§2.8) through `TIER_TO_LEVEL` (T1 → high, T2 → stop, T3 → emergency) | ACSM 2023, ILCOR, TB MED 507, NIOSH 2016 |
| hydration | `hydrationChannel` (§2.8): urine shade 5–6 → caution, 7–8 → high; over the daily cap → high; over a cap with symptoms → stop + `restrict_fluids` | Armstrong chart; TB MED 507 (2022); NIOSH 2016 |

**Fusion.**
- **Final level.** The maximum over the available channels. A T3 symptom forces `emergency`.
- **Unavailable channels.** A channel without usable inputs drops out and lowers the confidence instead of the level.
- **Conservative mode** switches on the stricter limits of §2.8.
- **Actions** follow from the level and the channels that drove it. Three examples:
  - an environment-driven `high` gives `shade_breaks` with work minutes per hour, plus `drink_water` and `rotate_task`;
  - a projection-driven `stop` gives `rest_shade_now` and `cool_down`;
  - `emergency` gives `call_998`, `cool_first` and `stay_with_worker`.
- **Water per hour** combines the ADOSH zone band, the PHS sweat rate and the NIOSH cadence floor, under the 1.42 L/h
  cap (§2.4).

**Alert policy** (`alerts.ts`, design):
- **Escalation.** Escalate at once. De-escalate only after 10 minutes below the threshold, plus a hysteresis margin
  (implemented for the projection channel as the resume check, §2.9).
- **Latching.** A `stop` or `emergency` driven by symptoms or physiology latches until a first aider or supervisor
  resolves the case after a symptom-free re-check. After T2 or T3, the worker does no more hot work that day.
- **Crew alerts.** When the environment or regulation channel moves several workers to the same level, one crew alert
  replaces many individual ones.
- **Repeat suppression.** The same level and actions are not repeated to a worker within 20 minutes unless the level
  rises.
- **Acknowledgement.** A `stop` not acknowledged within 2 minutes escalates to the supervisor and the buddy. An
  `emergency` goes immediately to the supervisor, the first aider and occupational health, with the 998 prompt.

---

## 4. Traceability: rule → standard → code → test

Test references give the test file and the opening words of the `describe` or `it` title, so they can be found with
grep.

| Rule | Standard or clause | Module · function | Test (file › block or case) |
|---|---|---|---|
| Outdoor and shade WBGT weighting | ISO 7243, via Lemke & Kjellstrom 2012 Eqs 1–2 | `wbgt.ts` · `wbgtOutdoorC`, `wbgtIndoorC` | `wbgt.test.ts` › "WBGT weighting (ISO 7243 via Lemke & Kjellstrom 2012 Eqs 1–2)" |
| Globe and wick energy balances | Liljegren et al. 2008; thermofeel 2.3.0 | `wbgt.ts` · `globeTemperature`, `naturalWetBulb`, `psychrometricWetBulb` | `wbgt.test.ts` › "globe and wet-bulb solvers: 20 core cases (exact port, ≤ 1e-6 °C)" |
| Solver: 500 iterations and fallback | wbgt_liljegren.md D2 | `wbgt.ts` · solver | `wbgt.test.ts` › "MAX_ITER = 500 and the bisection fallback (§7.3–7.4, D2)" |
| Beam split with the 0.85 cap | Liljegren `wbgt.c` (D6) | `wbgt.ts` · `liljegrenDirectBeam` | `wbgt.test.ts` › "direct-beam fraction with the 0.85 normsolar cap (§11, D6)" |
| 10 m → 2 m wind | Liljegren 2008, EPA stability classes, thermofeel floor (D7) | `wbgt.ts` · `wind2mFrom10m` | `wbgt.test.ts` › "wind: SRDT stability class and the 10 m → 2 m power law (§12)" |
| Engineered shade [ENG] | ISO 7243 indoor formula; wbgt_liljegren.md §9 | `wbgt.ts` · `wbgtComponents` | `wbgt.test.ts` › "shade WBGT (§9)" |
| Full pipeline from an Open-Meteo record | Liljegren 2008 | `wbgt.ts` · `wbgtComponents` | `wbgt.test.ts` › "wbgtComponents: 20 Open-Meteo-style full cases (exact port, ≤ 1e-6 °C)" |
| Published WBGT values | Lemke & Kjellstrom 2012 Figs 1–4 | `wbgt.ts` | `wbgt.test.ts` › "independent published values: Lemke & Kjellstrom (2012)" |
| BoM formula never used for alerts | wbgt_liljegren.md §17 | `wbgt.ts` · `bomApproxWbgtNotForAlerts` | `wbgt.test.ts` › "BoM shade approximation — labelled comparator only (§17)" |
| RH from dew point, clamped | Liljegren esat (D8) | `psychro.ts` · `rhFromDewPointPct` | `psychro.test.ts` › "RH from dew point (D8, §13.2)" |
| Apparent solar zenith | NOAA Solar Calculator (Meeus) | `solar.ts` · `solarPosition` | `solar.test.ts` › "NOAA solar position port (wbgt_liljegren.md §10.2)" |
| Hour-mean geometry at t − 30 min | Open-Meteo radiation convention; `wbgt.c` (D5) | `solar.ts` · `hourMeanSolarPosition`; `weather.ts` · `solarGeometryTime` | `solar.test.ts` › "hour-mean radiation geometry (D5, §13.3)" |
| Instantaneous radiation from hourly means | Open-Meteo backward-averaging construction | `weather.ts` · `instantFromHourMean`, `interpolateEnv` | `weather.test.ts` › "minute-level interpolation" |
| PHS kernel and D_lim | ISO 7933:2023 Annex B/E; pythermalcomfort 4.8.1 | `phs.ts` · `phsRun`, `phsStep` | `phs.test.ts` › "PHS vs pythermalcomfort 4.8.1 (fixtures/phs.json, unrounded outputs)" |
| PHS published cases | ISO 7933:2004 Annex F (normative), 2023 Annex F (informative) | `phs.ts` · `phsRun` | `phs.test.ts` › "ISO 7933 Annex F published cases" |
| h_c inside the t_cl iteration | ISO 7933:2023 Annex F case 3 | `phs.ts` · `hcMode: 'tclIteration'` | `phs.test.ts` › "2023 Annex F case 3 (high radiant load, 0.1 m/s) needs tclIteration" |
| drink = 0: 3 % threshold with the 0.6 factor | ISO 7933 (pythermalcomfort reading); phs_iso7933.md §6.4 | `phs.ts` · `drink0Mode`, `minutesToLimit` | `phs.test.ts` › "resolves the drink = 0 × 0.6 rule by looking past the horizon (AD15: 71.4 min …)" |
| Limits latch | ISO 7933:2023 clause 5 WARNING | `phs.ts` · `minutesToLimit` | `phs.test.ts` › "counts down in absolute time and latches once reached (AD02: D_lim,tcr 35 min)" |
| Chunked stepping equals a continuous run | phs_iso7933.md §11.4 | `phs.ts` · `phsStep` | `phs.test.ts` › "PHS stepper: chunked stepping equals one continuous run" |
| Validity flags | ISO 7933 Annex A Table A.1, as in pythermalcomfort | `phs.ts` · `phsValidity` | `phs.test.ts` › "phsValidity (ISO 7933 Annex A Table A.1, as pythermalcomfort 4.8.1)" |
| Custom water-loss threshold: bit-identical to ISO when absent or ≤ 5 % | ISO 7933:2023 Annex B | `phs.ts` · `minutesToLimit` (`PhsProjectionOptions.lossThresholdG`) | `phs.test.ts` › "absent, NaN, or at/below the ISO 5 % value → bit-identical to ISO 7933 for every fixture vector" |
| Water-loss limit with logged drinking: max(5 %, 3 % + credit), credit 0.8 × hourly-capped logs [ENG] | ISO 7933:2023 Annex B; ACSM 2007; TB MED 507 (2022) hourly cap | `risk.ts` · `RISK_THRESHOLDS.hydrationCredit`, `creditedIntakeL` | `risk.test.ts` › "creditedIntakeL: 0.8 × Σ per local clock hour …"; "logged drinking: threshold max(5 %, 3 % + credit) …"; "no logs → exactly ISO 7933 …"; "fasting (drink = 0) …" |
| Projection hold; release at 15 + 10 min; not feasible now [ENG] | ANSI/ISA-18.2; ISO 7933:2023 | `risk.ts` · `RISK_THRESHOLDS.resume` | `risk.test.ts` › "holds stop through rest until the resume check projects ≥ 25 min …"; "infeasible now: …" |
| Day-plan cap never raises the work minutes | ARCHITECTURE §1.1 | `risk.ts` · `WorkerContext.plannedWorkMinPerHour` | `risk.test.ts` › "caps workMinPerHour at the planned value (never raises it), with shade_breaks and an info driver" |
| Planner ISO 7933 screen: plan and monitor agree [ENG reference worker] | ISO 7933:2023 | `planner.ts` · `PHS_SCREEN` | `planner.test.ts` › "following the plan exactly at constant conditions never triggers a projection stop for the reference worker" |
| REL/RAL equations | NIOSH 2016 §8.1 (= ACGIH TLV/AL = ISO 7243:2017 Annex A) | `limits.ts` · `relC`, `ralC`, `exposureLimitC` | `limits.test.ts` › "NIOSH REL / RAL (NIOSH 2016 §8.1)" |
| REL only for acclimatised workers outside conservative mode | NIOSH 2016; ARCHITECTURE §5 | `limits.ts` · `selectExposureLimit` | `limits.test.ts` › "selects REL only for an acclimatised worker outside conservative mode" |
| Effective metabolic rate ≥ 115 W | ACGIH rest basis | `limits.ts` · `exposureLimitC` | `limits.test.ts` › "clamps M below 115 W to 115 W (protective) and RAL is below REL" |
| Clothing adjustment and hood | ACGIH 2026 Table 1; ISO 7243:2017 Formula 3 | `limits.ts` · `clothingAdjustmentC`, `wbgtEffectiveC` | `limits.test.ts` › "engine ensembles: never negative, not additive, hood +1, FR = 0, unknown → cloth coveralls" |
| Allowed work fraction (1-h TWA) | NIOSH 2016 §8.1, ACGIH TLV; ISO 7243:2017 Formula 4 | `limits.ts` · `allowedWorkFraction`, `twa` | `limits.test.ts` › "allowed work fraction (1-h TWA vs REL/RAL)"; "spec example: moderate 300 W, RAL, sun 30 °C / shade 28 °C → f = 0.2808" |
| ACGIH screening table (display only) | ACGIH Table 2 | `limits.ts` · `acgihScreeningCell` | `limits.test.ts` › "ACGIH Table 2 screening criteria" |
| Metabolic rate and body-mass scaling | ISO 8996:2004 Table A.2; ACGIH Table 3 | `limits.ts` · `taskMetabolicW`, `workClassForWm2` | `limits.test.ts` › "task metabolic rate: ACGIH watts, mass scaling never below 70 kg, 75 kg fail-safe default" |
| Acclimatisation ramps and status | NIOSH 2016 Table 4-1; ADOSH TG v4.0 §3 and Table 1 note b | `limits.ts` · `assessAcclimatization` | `limits.test.ts` › "acclimatisation"; "is never less protective than the ADOSH TG re-acclimatisation table" |
| Heat index, for communication only | NWS full algorithm | `limits.ts` · `heatIndexNwsC` | `limits.test.ts` › "NWS heat index" |
| Water recommendation under the caps | TB MED 507 (2022) Table 3-2; NIOSH 2017-126; ILO 2024 Table 8 | `limits.ts` · `recommendWaterMlPerHour` | `limits.test.ts` › "hydration" |
| TWL heat balance | Brake & Bates 2002 App. 1 | `twl.ts` · `computeTwl` | `twl.test.ts` › "computeTwl vs fixtures/twl.json reference vectors"; "Brake & Bates 2002 Table I (75 cells: 62 numeric, 13 "n/p")"; "published worked examples" |
| `physical` reading is the more protective | B&B 2002 text on Fig. 3 | `twl.ts` · `TwlVariant` | `twl.test.ts` › "the physical reading is never above alt_1p8" |
| TWL wind clamp, valid range and no-root case | B&B 2002 | `twl.ts` · `computeTwl` | `twl.test.ts` › "edge cases" |
| Globe → MRT conversion | ISO 7726:1998 Annex B | `twl.ts` · `globeToMrtIso7726` | `twl.test.ts` › "psychrometric and radiant helpers" |
| ADOSH zones; boundaries → more protective [ENG] | ADOSH-SF TG v4.0 Table 1 | `regulation.ts` · `twlZone` | `regulation.test.ts` › "twlZone — ADOSH-SF TG v4.0 Table 1 (High < 115, Medium 115–140, Low > 140; boundaries → more protective)" |
| Zone controls | TG Table 1 and note b | `regulation.ts` · `regulatoryFloor` | `regulation.test.ts` › "regulatoryFloor — Abu Dhabi (ADOSH-SF v4.0 + MoHRE midday break)"; "unacclimatised in the Medium zone → stop; the federal midday break applies" |
| Midday break | MoHRE MR 44/2022 | `regulation.ts` · `isMiddayBreak` | `regulation.test.ts` › "isMiddayBreak — UAE MoHRE Ministerial Resolution 44/2022 (15 Jun–15 Sep inclusive, 12:30 ≤ t < 15:00)" |
| Heat-stress programme at ≥ 35 °C | ADOSH CoP 11.0 §3.1.1(e) | `regulation.ts` · `heatStressProgramRequired` | `regulation.test.ts` › "heat-stress programme trigger" |
| Other jurisdictions | OSHJ-CoP-33 v2 Table 3; Qatar MD 17/2021 | `regulation.ts` · `getRulePack` | `regulation.test.ts` › "Sharjah pack …"; "Qatar pack …" |
| ECTemp Kalman filter | Buller 2013; USARIEM estimateTcore.js | `physio.ts` · `ectempStep`, `ectempRun` | `physio.test.ts` › "ECTemp reference vectors (physio_fixtures.json, CT ≤ 1e-9 °C, v ≤ 1e-12)" |
| ECTemp gap and warm-up rules [ENG] | physio_and_clinical.md §10.2 | `physio.ts` · `ectempUpdate`, `ectempWarmupDone` | `physio.test.ts` › "ECTemp tracker gap rules (§10.2)" |
| ECTemp shown only with a ±0.6 °C band | Buller 2013 limits of agreement ±0.63 °C | `physio.ts` · `ectempDisplayBand` | `physio.test.ts` › "ECTemp display band (§10.2 rule 4)" |
| PSI | Moran 1998 | `physio.ts` · `psiMoran` | `physio.test.ts` › "PSI and aPSI (§10.3; tolerance 1e-6)" |
| Signal-quality index | Li, Mark & Clifford 2009; Orphanidou 2015; ≥ 80 % coverage | `physio.ts` · `minuteSqi`, `sqiRScale` | `physio.test.ts` › "minute SQI (§10.4)" |
| Physiology floors, sustained 5 valid minutes, validity | Buller 2013; Hunt 2019; Moran 1998; NIOSH 2016 (§10.5) | `physio.ts` · `physiologyLevel` | `physio.test.ts` › "physiologyLevel (§10.5 floors; …)"; "is unavailable (never reassurance) when not consented, medicated, warming up or < 10 of 15 minutes valid" |
| HR > 180 − age; unknown age → 50 | ACGIH Table 4; NIOSH 2016 | `physio.ts` · `physiologyLevel`; `limits.ts` · `sustainedHrLimitBpm` | `physio.test.ts` › "unknown age uses the protective NIOSH age-50 HR limit (130 bpm)"; `limits.test.ts` › "ACGIH Table 4 sustained HR limit is 180 − age" |
| Symptom triage tiers and time rules | ACSM 2023, ILCOR, TB MED 507, NIOSH 2016 (§10.7) | `clinical.ts` · `triage` | `clinical.test.ts` › "triage: clinical_rules_fixtures triage vectors (§10.7)"; "triage: §10.11 inline vectors and time rules" |
| Unanswered prompts escalate | physio_and_clinical.md §4.3 item 6 | `clinical.ts` · `promptTimeout` | `clinical.test.ts` › "promptTimeout (§4.3 item 6)" |
| Cooling protocol | ILCOR 2019; TB MED 507; IOC 2021; OSHA; NATA | `clinical.ts` · `COOLING_PROTOCOL`, `FIRST_AID` | `clinical.test.ts` › "first-aid protocol data (§10.10)" |
| Urine colour | Armstrong chart; McKenzie 2015; Kavouras 2016 | `clinical.ts` · `urineAssessment` | `clinical.test.ts` › "urineAssessment (§10.8; fixture urine vectors)" |
| Fluid caps 1.42 L/h and 11.36 L/day | TB MED 507 (2022); NIOSH 2016 | `clinical.ts` · `fluidCapCheck`, `fluidStatus` | `clinical.test.ts` › "fluid caps (§10.8; fixture fluid vectors)" |
| Conservative mode; flags never summed | TB MED 507; physio_and_clinical.md §7, §10.9 | `clinical.ts` · `conservativeMode`, `physioDisabled` | `clinical.test.ts` › "conservative mode and risk flags (§10.9, §7)" |
| Fusion: maximum over available channels | ARCHITECTURE §5; physio_and_clinical.md §10.6 | `types.ts` · `maxLevel`, `TIER_TO_LEVEL`; `risk.ts` | `clinical.test.ts` › "fusion vectors (§10.6) through the shared TIER_TO_LEVEL / maxLevel contract"; `risk.test.ts` › "level = max over available channels (unless held); …" |
| Alert basis never changes routing | ARCHITECTURE §6 | `alerts.ts` · `assessmentBasis` | `alerts.test.ts` › "routing does not depend on the basis: the same level reaches the same roles on the same channels" |
| Fail-safe environment chain | ARCHITECTURE §1.3, §5 | `weather.ts` · `resolveEnvironment` | `weather.test.ts` › "resolveEnvironment" |
| No diagnostic or predictive claims | ARCHITECTURE §1.8 | `basis` and `text` strings | `limits.test.ts` › "basis strings make no diagnostic or predictive claims"; `clinical.test.ts` › "claims discipline" |

---

## 5. How fail-safe defaults enter each model

ARCHITECTURE principle 3 says that a missing, stale or poor-quality input can only make the result more conservative.
The table shows where each default is applied. Defaults in the data layer are logged as drivers with
`direction: 'raises'`. Defaults inside an engine function are listed in its output: `defaults` in `wbgtComponents`,
`flags` in `computeTwl`, `validity` in PHS, and `available` and `reason` in the physiology channel.

| Model or layer | Missing or poor input | Fail-safe behaviour | Where | Evidence |
|---|---|---|---|---|
| Environment source | No usable source | Sources are tried in order: sensor (≤ 15 min old, plausible) → live forecast → archive → cached forecast → conservative default. The default is the site's 95th-percentile design hour, 0.5 m/s wind and clear sky, with +1 °C margin and low confidence | `weather.ts` · `resolveEnvironment`, `conservativeDefaultSample` | `weather.test.ts` › "follows the EnvSource priority …" |
| Environment age | Data ≥ 6 h old; ≥ 24 h old, or of unknown age | Confidence lowered at ≥ 6 h. At ≥ 24 h, +1 °C on WBGT_eff and low confidence. Archived day-N forecasts count as 24·N h old. Both boundaries resolve protectively | `weather.ts` · `resolveEnvironment` (`wbgtMarginC`) | `weather.test.ts` › "applies the staleness rules: ≥ 6 h lowers confidence, ≥ 24 h adds a 1 °C WBGT margin (boundaries protective)" |
| Site sensor | Stale or implausible reading | Ignored; the next source is used and a sensor check is requested (`check_sensor`) | `weather.ts` | `weather.test.ts` › "ignores a stale or implausible sensor, falls back, and asks for a sensor check" |
| WBGT: wind | Unknown wind | 0.5 m/s in the data layer. The WBGT model then raises any 10 m wind below 0.62 m/s to its floor | `weather.ts`; `wbgt.ts` (`wind_unknown_floor`) | `weather.test.ts` › "substitutes 0.5 m/s for unknown wind and clear sky for unknown solar"; `wbgt.test.ts` › "measured WBGT and fail-safe defaults" |
| WBGT: solar | Unknown radiation | Data layer: clear sky = site 95th-percentile clear-sky index × TOA. The internal fallback in `wbgtComponents` (Kasten–Czeplak, `solar_unknown_clear_sky`) reads lower; see LIMITATIONS D-11 | `weather.ts` · `clearSkyGhiWm2`; `wbgt.ts` | as above |
| WBGT: pressure | Unknown pressure | The site's summer median (data layer); 1013.25 hPa inside `wbgtComponents` [ENG], which errs high near sea level | `weather.ts`; `wbgt.ts` (`pressure_unknown_standard`) | `wbgt.test.ts` › "measured WBGT and fail-safe defaults" |
| WBGT: temperature or humidity | Missing | No safe default exists, so `wbgtComponents` throws. The data layer must supply its conservative default first | `wbgt.ts` | same block |
| WBGT: shade | Rest-area roof | Shade globe never below air temperature; radiant boost also applied in shade [ENG] | `wbgt.ts` | `wbgt.test.ts` › "shade WBGT (§9)" |
| WBGT: radiation timing | Averaging window not stated | 60 min for modelled sources; 0 for site sensors | `wbgt.ts` | `wbgt.test.ts` › "site sensors default to instantaneous geometry; forecasts to the preceding hour" |
| Exposure limit | Acclimatisation unknown | Treated as unacclimatised → RAL; unknown history restarts the new-worker ramp | `limits.ts` · `selectExposureLimit`, `assessAcclimatization` | `limits.test.ts` › "absence of 21+ days or unknown history restarts the new-worker ramp (fail-safe)" |
| Exposure limit | Clothing unknown | Cloth coveralls (CAV 0). The ACGIH −1 °C credit for short sleeves is never applied, and a CAV is never negative | `limits.ts` · `clothingAdjustmentC` | `limits.test.ts` › "engine ensembles: never negative, not additive, …" |
| Exposure limit | Body size unknown | 75 kg and 175 cm; mass scaling never goes below the 70 kg reference | `limits.ts` · `taskMetabolicW` | `limits.test.ts` › "task metabolic rate: … 75 kg fail-safe default" |
| Exposure limit | Metabolic rate below 115 W, or above 600 W | Raised to 115 W; above 600 W the equation is extrapolated and flagged | `limits.ts` | `limits.test.ts` › "clamps M below 115 W …"; "reports the continuous-work margin and the extrapolation flag" |
| PHS | Input outside Table A.1 | Computed and flagged; confidence is lowered (design) | `phs.ts` · `phsValidity` | `phs.test.ts` › "outside Table A.1 it still computes (flagged), never NaN" |
| PHS | Impermeable clothing | PHS is not run (`applicable: false`); physiological monitoring advised; WBGT limit with CAV +11 °C | `limits.ts` · `CLOTHING` | `limits.test.ts` › "clothing adjustment (ACGIH 2026 Table 1)" |
| PHS | Drinking restricted at any point | Restricted criterion for the rest of the exposure; the more conservative drink = 0 reading by default | `phs.ts` | `phs.test.ts` › "is chunk-invariant … drink = 0" |
| PHS | Limit reached | Latches at 0 minutes for the rest of the exposure | `phs.ts` · `minutesToLimit` | `phs.test.ts` › "counts down in absolute time and latches once reached" |
| TWL | Non-finite input | NaN with `INVALID_INPUT` → most protective zone | `twl.ts`; `regulation.ts` · `twlZone` | `twl.test.ts` › "non-finite inputs give NaN + INVALID_INPUT (fail-safe), malformed shapes throw"; `regulation.test.ts` › "a non-finite TWL resolves to the most protective zone (fail-safe)" |
| TWL zones | TWL exactly 115 or 140 | More protective zone [ENG] | `regulation.ts` · `twlZone` | `regulation.test.ts` › "twlZone — …" |
| Regulation | Unknown time | Treated as inside the midday-break window | `regulation.ts` · `isMiddayBreak` | `regulation.test.ts` › "… an unknown time is treated as inside the window (fail-safe)" |
| Regulation | Missing WBGT under a WBGT stop rule (Qatar) | `caution` + `check_sensor` | `regulation.ts` · `regulatoryFloor` | `regulation.test.ts` › "missing WBGT cannot be read as compliance → caution + check_sensor (fail-safe)" |
| Regulation | Midday-break exemption claimed | Never applied automatically | `regulation.ts` | rule data |
| Physiology | Not consented, HR-suppressing medication, warm-up, < 10 of 15 minutes valid | Channel unavailable; it is never read as reassurance | `physio.ts` · `physioChannelStatus` | `physio.test.ts` › "is unavailable (never reassurance) when …" |
| Physiology | Dropouts within the window | They neither count nor reset the sustained run | `physio.ts` · `physiologyLevel` | `physio.test.ts` › "requires 5 sustained valid minutes; an invalid minute neither counts nor resets the run" |
| Physiology | Age unknown | Age 50 → HR limit 130 bpm | `physio.ts` | `physio.test.ts` › "unknown age uses the protective NIOSH age-50 HR limit (130 bpm)" |
| Physiology | Gap > 30 min, or a bare state | Filter re-initialised and warm-up restarted | `physio.ts` · `ectempUpdate` | `physio.test.ts` › "a gap of exactly 30 missing minutes keeps the filter; 31 re-initialises …"; "accepts a bare EctempState and restarts the warm-up from it (fail-safe)" |
| Symptoms | Prompt unanswered | Buddy notified at 5 min, supervisor at 10 min [ENG] | `clinical.ts` · `promptTimeout` | `clinical.test.ts` › "promptTimeout (§4.3 item 6)" |
| Symptoms | Re-check without a trend | Counts as not improving (T2 → T3 at 30 min) | `clinical.ts` · `triage` | `clinical.test.ts` › "triage: §10.11 inline vectors and time rules" |
| Hydration | Logged intake over a cap | Caps win over every other water figure, including a regulatory band above 1.42 L/h | `clinical.ts`; `limits.ts` | `clinical.test.ts` › "intake: daily cap → high; hourly cap → "slow down" …" |
| Fusion | Any channel unavailable | Drops out; it never lowers the level (design; the contract is tested) | `types.ts` · `maxLevel`; `risk.ts` | `clinical.test.ts` › "max over available channels; missing channels never lower anything" |

---

## 6. Reference fixtures, tolerances and how to reproduce

ARCHITECTURE §4 says that reference tests read `fixtures/*.json` and assert the tolerances documented here.

| Fixture | Generator | Test file | Quantity | Tolerance | Worst error achieved |
|---|---|---|---|---|---|
| `fixtures/wbgt_liljegren.json` | `scripts/oracles/wbgt_liljegren_oracle.py` (thermofeel 2.3.0, pvlib) | `wbgt.test.ts`, `psychro.test.ts`, `solar.test.ts` | T_g, T_nwb, T_psy, WBGT | 1e-6 °C | 5.0e-10 °C |
| | | | Property functions | 1e-10 relative | ≤ 1e-10 |
| | | | 2 m wind, f_dir, NOAA solar fields | 1e-9 | within |
| | | | Solar against NREL SPA | 0.03° zenith, 5e-4 cos z | 0.0159°, 2.76e-4 |
| | | | Globe MRT against the radiation-field MRT | 0.1 °C | 0.069 °C |
| `fixtures/phs.json` | `scripts/oracles/phs_oracle.py` (pythermalcomfort 4.8.1) | `phs.test.ts` | Temperatures | 1e-6 °C | 3.6e-14 °C |
| | | | α, SW_p, water loss, evaporative load | 1e-8, 1e-6 W/m², 1e-4 g, 1e-3 W·min/m² | 2.6e-15, 1.2e-12, 6.5e-11, 1.3e-9 |
| | | | D_lim | exact | exact (E10 is a deliberate deviation) |
| `fixtures/limits.json` | `scripts/oracles/limits_oracle.py` | `limits.test.ts` | Limits, TWA, CAV, heat index | per vector (default 1e-9) | 0 to 8.6e-14 |
| | | | Allowed work fraction | 1e-6 | 3.4e-11 |
| `fixtures/twl.json` | `scripts/oracles/twl_oracle.py` | `twl.test.ts` | TWL | ±0.05 W/m² | 7.4e-6 W/m² |
| | | | Skin temperature | ±0.001 K | 5.0e-7 K |
| `fixtures/physio/physio_fixtures.json` | `scripts/oracles/physio/ectemp_reference.py`, `compare_js.py` | `physio.test.ts` | ECTemp CT; variance | 1e-9 °C; 1e-12 | 0; 3.5e-18 |
| | | | PSI, aPSI, SQI ψ | 1e-6 | 4.8e-7, 4.1e-7, 3.3e-7 |
| `fixtures/physio/clinical_rules_fixtures.json` | `scripts/oracles/physio/clinical_rules.py` | `clinical.test.ts`, `physio.test.ts` | Tiers, codes, actions | exact | exact |

**How to reproduce.**
- `npx vitest run` runs every test.
- `npx vitest run src/engine/<module>.test.ts` runs one module's tests. Some tests print the worst errors they observe,
  for example `[phs accuracy]`, `[wbgt]` and `[twl]`.
- The Python oracles in `scripts/oracles/` regenerate the fixtures. They need pythermalcomfort 4.8.1, thermofeel 2.3.0,
  numpy and pvlib.
- The cached weather and observation files are under `public/data/`. `scripts/data/` re-downloads them.

---

## 7. Key sources

Full references are in the research notes. The sources most cited here are:

- **WBGT:** Liljegren JC et al. 2008, J Occup Environ Hyg 5:645–655; thermofeel 2.3.0; Lemke B & Kjellstrom T 2012;
  ISO 7243:2017.
- **PHS and MRT:** ISO 7933:2004 and ISO 7933:2023; pythermalcomfort 4.8.1; ISO 7726:1998.
- **Metabolic rates:** ISO 8996:2004 and 2021.
- **Exposure limits:** NIOSH 2016 Criteria for a Recommended Standard (Pub. 2016-106); ACGIH TLV 2026 (via CCOHS);
  ASSP 2022.
- **TWL:** Brake DJ & Bates GP 2002, Appl Occup Environ Hyg 17(3):176–186, and Ann Occup Hyg 46(2):165; Miller & Bates
  2007; Bates & Schneider 2008; Kapanowski 2018; Bernard, Ashley & Kapanowski 2022, Ann Work Expo Health
  66(8):1081–1085.
- **Regulation:** ADOSH-SF CoP 11.0 *Safety in the Heat* v4.0 and Technical Guideline v4.0 (ADPHC, 15 July 2024); UAE
  MoHRE Ministerial Resolution No. 44 of 2022; SPSA OSHJ-CoP-33 v2 Rev 0 (2024); Qatar Ministerial Decision No. 17 of
  2021.
- **Physiology:** Buller MJ et al. 2013, Physiol Meas 34:781–798, and the USARIEM estimateTcore.js; Looney DP et al.
  2018, J Meas Phys Behav 1:79; Moran DS et al. 1998 (Physiological Strain Index); Li, Mark & Clifford 2009 (signal
  quality).
- **Clinical:** TB MED 507 (2022); NIOSH 2017-126; ILCOR 2019 CoSTR (first-aid cooling); IOC consensus, Hosokawa et
  al. 2021, Br J Sports Med 55:1405; McKenzie et al. 2015, J Athl Train 50:1306; Armstrong et al. 1994, Int J Sport
  Nutr 4:265.
- **Weather and solar:** Open-Meteo (CC BY 4.0, ECMWF IFS and ERA5); NOAA Solar Calculator (Meeus).
