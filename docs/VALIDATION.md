# Zill — Validation: reference agreement and real-data evidence

This document reports the evidence that needs no simulation. It covers two of the three evidence classes defined in
`docs/SIMULATION.md`:

| Evidence class | Question | Section |
|---|---|---|
| **Reference agreement** | Does the engine compute the published models correctly? | §1 |
| **Real-data exposure** | How often do Abu Dhabi worksites reach each heat zone, and how well can that be forecast 1–3 days ahead? | §2, §3 |
| **Simulated cohort** | What could the warning policy change, under stated assumptions? | §5 → `docs/VALIDATION-COHORT.md` |

Nothing here is a health outcome. Hours in a heat zone describe the outdoor environment at a model grid cell, not how
many workers were exposed, and nothing here predicts heat illness in a person.

## How to regenerate

```
npm run validate            # = tsx scripts/validate/run-all.ts  (about 1 minute)
npx tsx scripts/validate/run-all.ts --docs-only     # re-render the tables below from the existing JSON
npx tsx scripts/validate/hours-in-zone.ts           # any single script can also run on its own
```

`run-all.ts` runs `reference.ts`, `hours-in-zone.ts`, `forecast-skill.ts` and, when it exists, `cohort.ts`. It writes
`public/data/validation/{reference,hours-in-zone,forecast-skill}.json` (each well under 1 MB) and then rewrites every
table between a `<!-- validate:begin:… -->` / `<!-- validate:end:… -->` marker pair in this file. Prose outside the
markers is hand-written; numbers inside them come from the JSON.

The outputs are deterministic. They contain no wall-clock time, the only resampling (the forecast-skill bootstrap) uses
the seeded generator in `src/sim/rng.ts`, and each JSON carries a stamp: the package version, a SHA-256 over the engine,
data, sim and validation sources, and a SHA-256 over every input file. Each input file is listed with its size and
SHA-256, and weather files are checked against `public/data/weather/manifest.json`.

---

## 1. Reference agreement

**Method.** `scripts/validate/reference.ts` runs the engine on every oracle fixture in `fixtures/` with the same options
as the colocated unit test, and reports |engine − reference| per check. The tolerance of each check is the one its unit
test asserts (named in the JSON's `toleranceSource`). Two kinds of reference appear:

- *Reference implementations* (thermofeel 2.3.0, pythermalcomfort 4.8.1, the USARIEM ECTemp algorithm, the TWL oracle
  `scripts/oracles/twl_oracle.py`, `scripts/oracles/limits_oracle.py`). Agreement to 1e-6 or better shows a faithful
  port.
- *Published values* (ISO 7933 Annex F, Brake & Bates 2002 Table I and worked examples, Lemke & Kjellstrom 2012
  figures, the ACGIH TLV table, the NOAA heat-index chart, ASSP worked answers). These carry printing, rounding and
  digitising error, so their tolerances are looser and are stated per check.

<!-- validate:begin:reference-summary -->
**40 of 40 checks pass.** Stamp `zill@0.1.0+code.b262bcaa33a5+inputs.e0873b716f82`.

| Model | Checks passed | Values compared |
|---|---|---|
| Outdoor WBGT (Liljegren 2008) | 3 / 3 | 339 |
| Predicted Heat Strain (ISO 7933) | 13 / 13 | 494 |
| Thermal Work Limit (Brake & Bates 2002) | 10 / 10 | 407 |
| NIOSH REL/RAL and work–rest | 3 / 3 | 56 |
| ACGIH TLV Table 2 | 2 / 2 | 74 |
| NWS heat index | 2 / 2 | 198 |
| ECTemp (Buller 2013 / Looney 2018) | 2 / 2 | 3284 |
| PSI / aPSI (Moran 1998) | 1 / 1 | 19 |
| Heart-rate signal quality (Li 2009) | 1 / 1 | 15 |
| Human MRT (Di Napoli 2020) | 1 / 1 | 18 |
| Gagge two-node model (simulation truth) | 2 / 2 | 1302 |
<!-- validate:end:reference-summary -->

<!-- validate:begin:reference-checks -->
| Check | Reference | Cases | Quantity | max \\|Δ\\| | mean \\|Δ\\| | Tolerance | Pass |
|---|---|---|---|---|---|---|---|
| Globe, natural wet-bulb and psychrometric wet-bulb solvers, outdoor and indoor WBGT | thermofeel 2.3.0 (Liljegren et al. 2008 port), scripts/oracles/wbgt_liljegren_oracle.py | 20 | Tg, Tnwb, Tpsy, WBGT (outdoor and indoor formulas) (°C) | 4.9e-10 | 2.3e-10 | ≤ 1.0e-6 | yes |
| Full Open-Meteo pipeline: solar geometry, fdir, 10 m → 2 m wind, sun and reference-shade WBGT | thermofeel 2.3.0 + pvlib 0.16.1, scripts/oracles/wbgt_liljegren_oracle.py | 20 | Tg, Tnwb, Tpsy, WBGT in sun; Tg, Tnwb, WBGT in reference shade (°C) | 5.0e-10 | 2.2e-10 | ≤ 1.0e-6 | yes |
| Published Liljegren curves digitised from Lemke & Kjellstrom 2012 Figs 1–4 | published: Lemke & Kjellstrom 2012, Ind Health 50:267–278, Figs 1–4 (digitised; P 1013.25 hPa, fdir 0.8, cos z 1) | 99 | WBGT (°C) | 0.142 | 0.0454 | rms ≤ 0.15 | yes |
| Mean radiant temperature of a standing person (PHS radiant input) | thermofeel 2.3.0 calculate_mean_radiant_temperature (Di Napoli et al. 2020), scripts/oracles/mrt_human_oracle.py | 18 | MRT (°C) | 4.9e-10 | 2.6e-10 | ≤ 1.0e-6 | yes |
| End-of-run rectal, skin, core and equilibrium core temperatures | pythermalcomfort 4.8.1 phs (both editions), scripts/oracles/phs_oracle.py | 50 | t_re, t_sk, t_cr, t_cr_eq (°C) | 3.6e-14 | 1.2e-15 | ≤ 1.0e-6 | yes |
| Predicted sweat rate at the last minute | pythermalcomfort 4.8.1 phs (both editions), scripts/oracles/phs_oracle.py | 50 | SW_p (W/m²) | 1.2e-12 | 1.0e-13 | ≤ 1.0e-6 | yes |
| Cumulative water loss | pythermalcomfort 4.8.1 phs (both editions), scripts/oracles/phs_oracle.py | 50 | sweat_loss_g (g) | 6.5e-11 | 2.2e-12 | ≤ 1.0e-4 | yes |
| Allowed exposure times D_lim (rectal, dehydration 5 %/7.5 %, drink = 0 rule) | pythermalcomfort 4.8.1 phs (both editions), scripts/oracles/phs_oracle.py | 50 | D_lim,tre, D_lim,loss(95), D_lim,loss50 (min) | 0 | 0 | ≤ 0 | yes |
| ISO 7933:2004 Annex F rectal temperature | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | t_re at 480 min (°C) | 0.0501 | 0.0268 | ≤ 0.1 | yes |
| ISO 7933:2004 Annex F water loss | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | sweat loss at 480 min (g) | 2.96 | 1.2 | ≤ 3 | yes |
| ISO 7933:2004 Annex F D_lim | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | D_lim,tre, D_lim,loss50, D_lim,loss95 (min) | 1 | 0.0667 | ≤ 1 | yes |
| ISO 7933:2004 Annex F rectal temperature (2004 BASIC c_sp) | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | t_re at 480 min (°C) | 0.047 | 0.0261 | ≤ 0.05 | yes |
| ISO 7933:2004 Annex F water loss (2004 BASIC c_sp) | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | sweat loss at 480 min (g) | 0.393 | 0.221 | ≤ 0.4 | yes |
| ISO 7933:2004 Annex F D_lim (2004 BASIC c_sp) | published: ISO 7933:2004 Annex F published results (10 cases) | 10 | D_lim,tre, D_lim,loss50, D_lim,loss95 (min) | 0 | 0 | ≤ 0 | yes |
| ISO 7933:2023 Annex F rectal temperature | published: ISO 7933:2023 Annex F published results (5 cases) | 5 | t_re at 480 min (°C) | 0.0584 | 0.0251 | ≤ 0.1 | yes |
| ISO 7933:2023 Annex F water loss and final sweat rate | published: ISO 7933:2023 Annex F published results (5 cases) | 5 | relative error of sweat loss and SW_p (g/h) (relative) | 0.00537 | 0.00355 | ≤ 0.006 | yes |
| ISO 7933:2023 Annex F D_lim | published: ISO 7933:2023 Annex F published results (5 cases) | 5 | D_lim,loss (±3 min) and D_lim,tcr (±2 min) (min) | 3 | 1.2 | ≤ 3 | yes |
| TWL, 42 vectors (published, Abu Dhabi, edge, zone-boundary cases) | Reference implementation of Brake & Bates 2002 (scripts/oracles/twl_oracle.py; cross-checked by scripts/oracles/twl_independent_check.js) | 42 | TWL (W/m²) | 7.4e-6 | 8.6e-7 | ≤ 0.05 | yes |
| Skin temperature at the TWL solution | Reference implementation of Brake & Bates 2002 (scripts/oracles/twl_oracle.py; cross-checked by scripts/oracles/twl_independent_check.js) | 42 | t_sk (°C) | 5.0e-7 | 2.6e-7 | ≤ 0.001 | yes |
| Brake & Bates 2002 Table I conditions, engine vs reference implementation (75 cells × 2 variants) | Reference implementation of Brake & Bates 2002 (scripts/oracles/twl_oracle.py; cross-checked by scripts/oracles/twl_independent_check.js) | 75 | TWL (W/m²) | 4.8e-7 | 2.4e-7 | ≤ 0.001 | yes |
| Table I printed values, alt_1p8 variant (all 62 numeric cells) | published: Brake & Bates 2002, Appl Occup Environ Hyg 17(3):176–186, Table I (printed integers, apparently truncated) | 62 | TWL (W/m²) | 1.86 | 0.696 | ≤ 2.5 | yes |
| Table I printed values, physical variant (engine default), sweat-limited cells (x > 1.7) | published: Brake & Bates 2002, Appl Occup Environ Hyg 17(3):176–186, Table I (printed integers, apparently truncated) | 54 | TWL (W/m²) | 1.34 | 0.574 | ≤ 2.5 | yes |
| Table I printed values, physical variant, evaporation-limited cells (80 kPa block, WB 24–26 °C) | published: Brake & Bates 2002, Appl Occup Environ Hyg 17(3):176–186, Table I (printed integers, apparently truncated) | 8 | TWL (W/m²) | 10.1 | 3.71 | ≤ 11 | yes |
| B&B 2002 worked examples p.180–181 (110, 158 W/m²) | published: Brake & Bates 2002 (AEOH 17(3) text; Ann Occup Hyg 2002 Table 2) as printed | 2 | TWL (W/m²) | 0.711 | 0.486 | ≤ 1.5 | yes |
| B&B 2002 App. 2 "typically ≈ 220 W/m²" example | published: Brake & Bates 2002 (AEOH 17(3) text; Ann Occup Hyg 2002 Table 2) as printed | 1 | TWL (W/m²) | 3.01 | 3.01 | ≤ 6 | yes |
| AOH 2002 Table 2, high-wind cases (3.0 m/s) | published: Brake & Bates 2002 (AEOH 17(3) text; Ann Occup Hyg 2002 Table 2) as printed | 2 | TWL (W/m²) | 0.538 | 0.466 | ≤ 1.5 | yes |
| AOH 2002 Table 2, low-wind cases (0.2 m/s) | published: Brake & Bates 2002 (AEOH 17(3) text; Ann Occup Hyg 2002 Table 2) as printed | 2 | TWL (W/m²) | 7.64 | 6.63 | ≤ 9 | yes |
| NIOSH REL and RAL equations | NIOSH 2016-106 §8.1 equations, scripts/oracles/limits_oracle.py | 20 | REL, RAL (°C) | 0 | 0 | ≤ 1.0e-9 | yes |
| Published two-decimal REL/RAL worked answers (ASSP PSJ 2022) | published: ASSP Professional Safety Journal, Aug 2022 worked answers (2 decimals) | 4 | REL, RAL (°C) | 0.00467 | 0.00294 | ≤ 0.005 | yes |
| Allowed work fraction per hour (1-h TWA of WBGT_eff and M vs REL/RAL) | Independent solver in scripts/oracles/limits_oracle.py (NIOSH 2016 §8.1 + ACGIH 1-h TWA) | 8 | work fraction f and continuous-work margin (fraction / °C) | 5.7e-13 | 1.5e-13 | ≤ 1.0e-6 | yes |
| ACGIH Table 2 cells from the REL/RAL equations at the TWA metabolic rate | scripts/oracles/limits_oracle.py (pythermalcomfort-independent equation evaluation) | 16 | M_TWA (W), TLV and Action Limit (°C, unrounded) (W / °C) | 0 | 0 | ≤ 1.0e-9 | yes |
| Every published ACGIH Table 2 TLV and Action Limit cell, reproduced (rest 115 W, nearest 0.5 °C half-up) | published: ACGIH TLVs Heat Stress and Strain, Table 2 (as printed) | 16 | TLV and Action Limit, rounded (°C) | 0 | 0 | ≤ 0 | yes |
| NWS heat index algorithm (Steadman simple formula, Rothfusz regression, adjustments) | NWS/WPC heat index equation page (Rothfusz 1990 SR 90-23), scripts/oracles/limits_oracle.py; pythermalcomfort cross-check | 32 | heat index (°F / °C) | 5.0e-14 | 2.6e-15 | ≤ 1.0e-9 | yes |
| NOAA heat-index chart (NIOSH 2016 App. C), 135 printed cells | published: NIOSH 2016-106 Appendix C chart (adapted from NOAA) | 135 | heat index, whole °F (°F) | 1 | 0.0444 | ≤ 1 | yes |
| Minute-by-minute core-temperature estimate (Kalman filter) | USARIEM ECTemp algorithm (Buller 2013 Physiol Meas 34:781; Looney 2018), scripts/oracles/physio/ectemp_reference.py | 11 | estimated CT (°C) | 0 | 0 | ≤ 1.0e-9 | yes |
| Kalman variance of the estimate | USARIEM ECTemp algorithm (Buller 2013 Physiol Meas 34:781; Looney 2018), scripts/oracles/physio/ectemp_reference.py | 11 | variance (°C²) | 3.5e-18 | 1.2e-19 | ≤ 1.0e-12 | yes |
| Physiological Strain Index (Moran 1998) with bands, and adaptive PSI | Moran et al. 1998 Am J Physiol 275:R129; aPSI per US11564579B2; scripts/oracles/physio/ectemp_reference.py | 11 | PSI, aPSI, HRcrit, CTcrit (index / bpm / °C) | 4.8e-7 | 1.3e-7 | ≤ 1.0e-6 | yes |
| Minute heart-rate signal-quality index, validity, flags and noise scaling | Li, Mark & Clifford 2009 BioMed Eng Online 8:13 noise scaling; scripts/oracles/physio/ectemp_reference.py | 7 | SQI ψ, mean HR, R scale (index / bpm) | 3.3e-7 | 9.6e-8 | ≤ 1.0e-6 | yes |
| Two-node thermoregulation, 12 conditions × 9 durations × 12 outputs | pythermalcomfort 4.8.1 two_nodes_gagge (Gagge, Fobelets & Berglund 1986), scripts/oracles/gagge_oracle.py | 12 | core/skin temperature, blood flow, sweat, wettedness, heat fluxes (relative) | 1.1e-14 | 6.9e-17 | rel ≤ 1.0e-9 | yes |
| Simulation-truth human MRT from radiation fluxes | thermofeel 2.3.0 calculate_mean_radiant_temperature (Di Napoli et al. 2020) | 6 | MRT (°C) | 0 | 0 | ≤ 1.0e-9 | yes |
<!-- validate:end:reference-checks -->

**Reading the published-value checks.**

- *TWL, Table I.* The printed integers appear truncated. The `alt_1p8` reading reproduces all 62 printed cells within
  1.9 W/m². The engine's default `physical` reading agrees within 1.4 W/m² in the 54 sweat-limited cells and sits up to
  10.1 W/m² *below* the printed value in the 8 evaporation-limited cells of the 80 kPa block. Lower TWL means a
  stricter zone, so the deviation is protective.
- *TWL, AOH 2002 Table 2 low-wind cases.* The model reads 5.6–7.6 W/m² above the two printed 0.2 m/s values (possibly a
  pre-publication model version). Table I, the worked examples and the high-wind cases agree.
- *PHS, ISO 7933 Annex F.* With the engine defaults, the 2004 annex is matched within about 0.05 °C rectal
  temperature, 3 g of water and 1 minute of D_lim. With the 2004 BASIC program's specific-heat constant it matches to the printed
  precision. The 2023 annex is matched within its stated residuals.
- *WBGT, Lemke & Kjellstrom 2012.* The 99 points were digitised from figures, so part of the difference is digitising
  error.

Agreement with a reference implementation shows the code computes the published model. It does not show that the model
is accurate for a given worker or worksite (see §4 and `docs/LIMITATIONS.md` M-02).

---

## 2. Hours in each heat zone, 2020–2025

### 2.1 Method

- **Data.** `public/data/weather/archive/{site}_{2020…2025}.json`: hourly Open-Meteo archive values for 1 Jun 00:00 to
  30 Sep 23:00 local (2,928 h per season) at the five sites. **Primary:** ECMWF IFS 9 km analysis, the model of the
  live forecast (identical to Open-Meteo `best_match` at these sites). **Sensitivity:** ERA5 (0.25° reanalysis).
- **Engine.** Each hour runs through `indices.ts computeSiteHeat`: Liljegren WBGT in sun and in engineered shade
  (hour-mean radiation, solar geometry at the mid-point of the hour, 10 m → 2 m urban wind profile, 0.62 m/s floor),
  and TWL in sun (globe-field MRT) and in shade. The primary run applies **no site radiant allowance** (the
  meteorological exposure). A sensitivity run adds the per-site allowance for hot work surfaces (`sites.ts`, [ENG]).
- **WBGT bands.** Each edge is computed from the engine's own limit functions, for ordinary work clothes (ACGIH CAV 0,
  no hood, so WBGT_eff = WBGT). Lower edges are inclusive.

  | Band | Edge | Meaning | Basis |
  |---|---|---|---|
  | < 28.2 °C | REL(300 W) = 28.21 | below the REL for continuous moderate work (acclimatised) | NIOSH 2016 §8.1 |
  | 28.2–30.8 | RAL(115 W) = 30.84 | moderate work needs a work/rest cycle | NIOSH 2016 §8.1 |
  | 30.8–32.1 | 32.1 | resting in the same conditions exceeds the RAL: unacclimatised workers need cooled rest | NIOSH 2016 §8.1 |
  | 32.1–33.0 | REL(115 W) = 33.00 | above Qatar's stop-work WBGT (comparison only, not an Abu Dhabi rule) | Qatar MD 17/2021 Art. 4(9) |
  | ≥ 33.0 | — | resting in the same conditions exceeds even the REL | NIOSH 2016 §8.1 |

- **ADOSH TWL zones.** `regulation.ts twlZone` (ADOSH-SF TG v4.0 Table 1): High ≤ 115 < Medium ≤ 140 < Low W/m²,
  boundaries resolved to the more protective zone.
- **Midday break.** `regulation.ts isMiddayBreak` (MoHRE MR 44/2022): 15 Jun–15 Sep inclusive, 12:30 ≤ local time <
  15:00. On hourly data the 13:00 and 14:00 samples fall inside the window.
- **Hour of day** is the local hour of the sample time. Temperature and humidity are instantaneous at that time, and
  radiation is the mean over the preceding hour.

<!-- validate:begin:hours-headline -->
- Mean over the five sites (IFS analysis, Jun–Sep 2020–2025): **1070 h per season at WBGT ≥ RAL(115 W) ≈ 30.8 °C** (37 % of the 2928 hours), of which 390 h at ≥ REL(115 W) ≈ 33.0 °C, where even an acclimatised worker at rest exceeds the REL.
- ADOSH High zone (TWL ≤ 115 W/m²): 59 h per season with the TWL in sun and 0 h in engineered shade. The TWL zones are reached far less often than the WBGT limits.
- **84 % of the hours at WBGT ≥ 30.8 °C and 74 % of the ADOSH High-zone hours fall outside the midday-break window** (12:30–15:00, 15 Jun–15 Sep).
- Allowed work over the 07–17 h shift (NIOSH 1-h TWA, work in sun): moderate work under the REL 41.5 min/h with rest in a cooled cabin (WBGT 25 °C) vs 30.5 min/h with rest in shade; heavy work under the RAL 20.6 vs 9.5 min/h.
<!-- validate:end:hours-headline -->

### 2.2 Mean hours per season, by site (IFS analysis)

<!-- validate:begin:hours-sites -->
| Site | p50 | p95 | max | WBGT < 28.2 | WBGT 28.2–30.8 | WBGT 30.8–32.1 | WBGT 32.1–33.0 | WBGT ≥ 33.0 | ADOSH High (sun) | Medium (sun) | High (shade) | Days with High | Longest run ≥ 30.8 (h) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Musaffah | 30.2 | 34.6 | 39.9 | 642 | 1115 | 457 | 259 | 455 | 83 | 120 | 0 | 38 | 60 |
| KEZAD | 30.2 | 34.3 | 38.4 | 695 | 1041 | 448 | 293 | 452 | 50 | 92 | 0 | 25 | 61 |
| Ruwais | 29.8 | 34.3 | 38.5 | 861 | 1028 | 433 | 234 | 372 | 64 | 99 | 0 | 30 | 47 |
| Al Ain | 27.7 | 33.2 | 38.5 | 1617 | 701 | 284 | 159 | 168 | 28 | 58 | 0 | 16 | 13 |
| Saadiyat | 30.6 | 34.5 | 38.4 | 442 | 1147 | 532 | 305 | 502 | 72 | 125 | 0 | 35 | 60 |
<!-- validate:end:hours-sites -->

Hours at WBGT ≥ 30.8 °C in each season (IFS analysis), for year-to-year context. Do not tune thresholds on a single
year.

<!-- validate:begin:hours-by-year -->
| Site | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|
| Musaffah | 1168 | 1174 | 995 | 1260 | 1281 | 1148 |
| KEZAD | 1195 | 1180 | 992 | 1306 | 1307 | 1178 |
| Ruwais | 983 | 1091 | 921 | 1078 | 1198 | 964 |
| Al Ain | 616 | 559 | 539 | 609 | 618 | 720 |
| Saadiyat | 1333 | 1337 | 1125 | 1472 | 1445 | 1319 |
<!-- validate:end:hours-by-year -->

### 2.3 When the hours occur

Mean over the five sites, hours per season at each local hour:

<!-- validate:begin:hours-by-hour -->
| Local hour | mean WBGT (°C) | h ≥ 30.8 per season | h ≥ 33.0 | mean TWL sun (W/m²) | ADOSH High h (sun) |
|---|---|---|---|---|---|
| 00:00 | 28.1 | 9 | 0 | 260 | 0.0 |
| 01:00 | 27.7 | 7 | 0 | 264 | 0.0 |
| 02:00 | 27.4 | 6 | 0 | 269 | 0.0 |
| 03:00 | 27.0 | 5 | 0 | 274 | 0.0 |
| 04:00 | 26.8 | 4 | 0 | 278 | 0.0 |
| 05:00 | 26.7 | 4 | 0 | 281 | 0.0 |
| 06:00 | 26.4 | 2 | 0 | 287 | 0.0 |
| 07:00 | 27.3 | 7 | 0 | 275 | 0.0 |
| 08:00 | 29.1 | 30 | 3 | 242 | 0.8 |
| 09:00 | 30.8 | 60 | 17 | 211 | 4.8 |
| 10:00 | 31.9 | 84 | 33 | 187 | 10.2 |
| 11:00 | 32.5 | 100 | 46 | 171 | 11.8 |
| 12:00 | 32.9 | 108 | 58 | 161 | 12.0 |
| 13:00 | 33.0 | 110 | 62 | 159 | 10.1 |
| 14:00 | 32.9 | 108 | 60 | 166 | 6.4 |
| 15:00 | 32.5 | 104 | 51 | 178 | 2.2 |
| 16:00 | 32.0 | 92 | 35 | 195 | 0.6 |
| 17:00 | 31.3 | 77 | 18 | 217 | 0.0 |
| 18:00 | 30.3 | 53 | 4 | 241 | 0.0 |
| 19:00 | 29.4 | 31 | 0 | 258 | 0.0 |
| 20:00 | 29.1 | 21 | 0 | 261 | 0.0 |
| 21:00 | 29.0 | 20 | 0 | 259 | 0.0 |
| 22:00 | 28.7 | 17 | 0 | 257 | 0.0 |
| 23:00 | 28.4 | 12 | 0 | 258 | 0.0 |
<!-- validate:end:hours-by-hour -->

Mean over the five sites, hours per season in each month:

<!-- validate:begin:hours-by-month -->
| Month | WBGT < 28.2 | WBGT 28.2–30.8 | WBGT 30.8–32.1 | WBGT 32.1–33.0 | WBGT ≥ 33.0 | ADOSH High (sun) | Medium (sun) |
|---|---|---|---|---|---|---|---|
| Jun | 290 | 234 | 91 | 56 | 49 | 6.2 | 12.0 |
| Jul | 158 | 257 | 123 | 75 | 131 | 16.9 | 32.3 |
| Aug | 151 | 249 | 132 | 69 | 144 | 23.2 | 36.1 |
| Sep | 252 | 266 | 85 | 50 | 66 | 12.8 | 18.3 |
<!-- validate:end:hours-by-month -->

### 2.4 Most high-heat hours fall outside the midday break

The midday break protects outdoor workers for 2.5 hours a day on 93 days. Most hours at or above RAL(115 W) occur in
the morning, the late afternoon, the evening, and on season days outside the break dates:

<!-- validate:begin:hours-midday -->
| Site | ADOSH High h/season | outside break | share outside | WBGT ≥ 30.8 h/season | outside break | share outside | of which on dates outside 15 Jun–15 Sep |
|---|---|---|---|---|---|---|---|
| Musaffah | 83 | 60 | 72 % | 1171 | 990 | 85 % | 19 % |
| KEZAD | 50 | 38 | 77 % | 1193 | 1012 | 85 % | 20 % |
| Ruwais | 64 | 50 | 78 % | 1039 | 870 | 84 % | 17 % |
| Al Ain | 28 | 16 | 58 % | 610 | 454 | 74 % | 18 % |
| Saadiyat | 72 | 55 | 77 % | 1339 | 1156 | 86 % | 19 % |
| All sites | 59 | 44 | 74 % | 1070 | 896 | 84 % | 19 % |
<!-- validate:end:hours-midday -->

This is the gap Zill's environment, regulation and projection channels address. The ban is a floor, not a complete
control.

### 2.5 Planning insight: cooled rest versus rest in shade

`limits.ts allowedWorkFraction` gives the largest work fraction *f* per hour with
Limit(*f*·M_work + (1 − *f*)·115 W) ≥ *f*·WBGT_sun + (1 − *f*)·WBGT_rest (the NIOSH/ACGIH 1-hour TWA). Work is in direct
sun. Rest is either in an air-conditioned cabin, at the WBGT shown in the stamp line below (`risk.ts COOLED_REST`, or
25 °C [ENG] when the engine does not export it; ADOSH-SF CoP 11.0 §3.2(c) "cooled and air-conditioned rest areas"), or
in the modelled engineered-shade WBGT. Cells show the mean allowed work minutes per hour over all Jun–Sep hours
2020–2025 at the five sites. "(x % none)" is the share of hours in which no work is allowed at all.

<!-- validate:begin:hours-work-hour -->
| Local hour | moderate REL, cabin | moderate REL, shade | heavy REL, cabin | heavy REL, shade | moderate RAL, cabin | moderate RAL, shade | heavy RAL, cabin | heavy RAL, shade |
|---|---|---|---|---|---|---|---|---|
| 05:00 | 57 | 53 | 52 | 45 | 43 | 33 | 33 | 24 |
| 06:00 | 58 | 54 | 53 | 47 | 44 | 35 | 34 | 26 |
| 07:00 | 56 | 51 | 50 | 43 | 41 | 31 | 31 | 23 |
| 08:00 | 51 | 44 | 43 | 35 | 33 | 23 | 25 | 16 |
| 09:00 | 45 | 36 | 37 | 28 | 28 | 17 (6 % none) | 21 | 12 (6 % none) |
| 10:00 | 40 | 31 | 33 | 23 | 25 | 13 (6 % none) | 19 | 9 (6 % none) |
| 11:00 | 38 | 27 | 31 | 20 | 24 | 11 (8 % none) | 19 | 8 (8 % none) |
| 12:00 | 36 | 24 | 30 | 18 | 23 | 9 (12 % none) | 18 | 7 (12 % none) |
| 13:00 | 36 | 23 | 30 | 17 | 23 | 8 (17 % none) | 18 | 6 (17 % none) |
| 14:00 | 36 | 23 | 30 | 17 | 23 | 8 (20 % none) | 18 | 6 (20 % none) |
| 15:00 | 37 | 23 | 31 | 17 | 24 | 8 (22 % none) | 18 | 6 (22 % none) |
| 16:00 | 39 | 26 | 32 | 19 | 25 | 9 (20 % none) | 19 | 6 (20 % none) |
| 17:00 | 42 | 29 | 35 | 21 | 26 | 10 (20 % none) | 20 | 7 (20 % none) |
| 18:00 | 46 | 33 | 38 | 24 | 29 | 12 (18 % none) | 22 | 8 (18 % none) |
| 19:00 | 50 | 37 | 41 | 27 | 32 | 14 (18 % none) | 24 | 9 (18 % none) |
<!-- validate:end:hours-work-hour -->

The same, averaged over the 07–17 h shift, by month and by site:

<!-- validate:begin:hours-work-month -->
| Month (07–17 h) | moderate REL, cabin | moderate REL, shade | heavy REL, cabin | heavy REL, shade | moderate RAL, cabin | moderate RAL, shade | heavy RAL, cabin | heavy RAL, shade |
|---|---|---|---|---|---|---|---|---|
| Jun–Sep | 41.5 | 30.5 | 34.7 | 23.3 | 26.6 | 13.5 (12 % none) | 20.6 | 9.5 (12 % none) |
| Jun | 43.5 | 35.2 | 36.1 | 27.0 | 27.8 | 16.7 (3 % none) | 21.3 | 11.9 (3 % none) |
| Jul | 39.5 | 26.0 | 32.8 | 19.3 | 25.0 | 9.6 (19 % none) | 19.4 | 6.6 (19 % none) |
| Aug | 39.4 | 26.0 | 33.0 | 19.7 | 25.3 | 10.3 (22 % none) | 19.6 | 7.2 (22 % none) |
| Sep | 43.7 | 35.2 | 36.8 | 27.7 | 28.6 | 17.6 (5 % none) | 22.0 | 12.6 (5 % none) |
<!-- validate:end:hours-work-month -->

<!-- validate:begin:hours-work-site -->
| Site (07–17 h, Jun–Sep) | moderate REL, cabin | moderate REL, shade | heavy REL, cabin | heavy REL, shade | moderate RAL, cabin | moderate RAL, shade | heavy RAL, cabin | heavy RAL, shade |
|---|---|---|---|---|---|---|---|---|
| Musaffah | 40.2 | 28.2 | 33.5 | 21.2 | 25.6 | 11.4 (14 % none) | 19.8 | 7.9 (14 % none) |
| KEZAD | 40.2 | 27.7 | 33.5 | 20.9 | 25.7 | 11.1 (16 % none) | 19.9 | 7.8 (16 % none) |
| Ruwais | 41.6 | 30.6 | 34.7 | 23.3 | 26.7 | 13.4 (13 % none) | 20.6 | 9.5 (13 % none) |
| Al Ain | 46.2 | 40.2 | 39.1 | 32.3 | 30.5 | 22.1 | 23.4 | 16.0 |
| Saadiyat | 39.2 | 25.9 | 32.5 | 19.0 | 24.7 | 9.3 (18 % none) | 19.2 | 6.4 (18 % none) |
| All sites | 41.5 | 30.5 | 34.7 | 23.3 | 26.6 | 13.5 (12 % none) | 20.6 | 9.5 (12 % none) |
<!-- validate:end:hours-work-site -->

**Reading.** In the Gulf summer, shade alone often exceeds the resting limit. In July and August the shade WBGT passes
RAL(115 W) in about one daytime hour in five (the "none" share), so for unacclimatised workers or workers in
conservative mode (RAL) a work/rest cycle with shade rest allows little or no work. Over the 07–17 h shift a cooled
rest area roughly doubles the work minutes per hour the RAL allows, and adds about 11 minutes per hour under the REL.
The cabin value is never taken above the outdoor shade WBGT, as in `risk.ts`. Two qualifications apply. In-season, outdoor work in direct sun is banned at 13:00
and 14:00 whatever these numbers say. And the ADOSH TWL work/rest cycles (e.g. 20/40 for heavy work in the High zone)
apply on top of the NIOSH result.

### 2.6 TWL plausibility check against UAE field studies

Mean modelled TWL at the hours sampled by the Curtin/HAAD field studies (all five sites, IFS analysis), next to the
published field values (`docs/research/twl_and_regulation.md` §5):

<!-- validate:begin:hours-twl -->
| Site, period | 08:00 sun / shade | 12:00 sun / shade | 14:00 sun / shade | 16:00 sun / shade |
|---|---|---|---|---|
| All sites, Jun–Sep (model) | 242 / 281 | 161 / 270 | 166 / 266 | 196 / 268 |
| All sites, June (model) | 243 / 290 | 173 / 281 | 179 / 278 | 206 / 281 |
| Bates & Schneider 2008, May 2006 (measured) | 237.7 | 194.8 | 189.3 | 230.6 |
| Miller et al. 2011, summers 2007–08 (measured means) | 140–200 | 140–200 | 140–200 | 140–200 |

| Site | days with a 07–17 h TWL in sun < 140 W/m² | < 115 W/m² |
|---|---|---|
| Musaffah | 53 % | 31 % |
| KEZAD | 40 % | 20 % |
| Ruwais | 42 % | 25 % |
| Al Ain | 30 % | 13 % |
| Saadiyat | 50 % | 28 % |
| All sites | 43 % | 23 % |
<!-- validate:end:hours-twl -->

**Reading.** At midday and early afternoon the modelled full-sun TWL (≈ 160–170 W/m²) falls inside Miller et al.'s
summer band of 140–200 W/m². The modelled shade TWL (≈ 265–280 W/m²) lies above it. That is the expected ordering:
field workers were partly shaded and exposed to real wind, while the model's sun value assumes full sun. Bates &
Schneider's May values sit above the modelled June means at midday, as expected for a cooler month. At 08:00 the
modelled sun TWL (≈ 240 W/m²) is close to Bates & Schneider's 237.7 W/m² but above Miller et al.'s band. The model
finds days with a daytime TWL below 140 and below 115 W/m² more often than the field studies' "occasionally" (table
above). That fits its full-sun assumption and the analyses' low wind.

This is a plausibility check, not a validation. The field data come from other years and months (May 2006,
summers 2007–2008), from worksites rather than grid cells, and from Calor heat-stress monitors with measured wind. TWL is
very sensitive to wind speed.

### 2.7 Uncertainty: model choice, radiant allowance and an observational anchor

<!-- validate:begin:hours-sensitivity -->
| Site | h ≥ 30.8 IFS | ERA5 | ERA5 − IFS | IFS + site radiant allowance | allowance effect |
|---|---|---|---|---|---|
| Musaffah | 1171 | 1270 | +8.4 % | 1356 | +15.8 % |
| KEZAD | 1193 | 1374 | +15.2 % | 1437 | +20.5 % |
| Ruwais | 1039 | 1081 | +4.0 % | 1280 | +23.2 % |
| Al Ain | 610 | 784 | +28.5 % | 683 | +11.8 % |
| Saadiyat | 1339 | 1402 | +4.7 % | 1404 | +4.9 % |
<!-- validate:end:hours-sensitivity -->

ERA5 gives more hours at or above 30.8 °C than the IFS analysis at every site: 4–15 % more at the coastal sites and
about 29 % more at Al Ain. The per-site radiant allowance adds 5–23 %. Both are reported, never tuned.

**Observational anchor (2025, airports).** Hours per WBGT band at the three airports, over the hours with a METAR, from
METAR temperature, dew point and wind with IFS radiation ("obs-met"), against model-only WBGT:

<!-- validate:begin:hours-anchor -->
| Airport | Source | matched h | WBGT < 28.2 | WBGT 28.2–30.8 | WBGT 30.8–32.1 | WBGT 32.1–33.0 | WBGT ≥ 33.0 | h ≥ 30.8 | ADOSH High (sun) |
|---|---|---|---|---|---|---|---|---|---|
| OMAA | METAR (obs-met) | 2927 | 850 | 1089 | 399 | 242 | 347 | 988 | 38 |
| OMAA | IFS 9 km model only | 2927 | 968 | 934 | 342 | 224 | 459 | 1025 | 112 |
| OMAA | ERA5 model only | 2927 | 746 | 1023 | 366 | 238 | 554 | 1158 | 113 |
| OMAD | METAR (obs-met) | 2927 | 558 | 1029 | 491 | 269 | 580 | 1340 | 128 |
| OMAD | IFS 9 km model only | 2927 | 742 | 978 | 377 | 261 | 569 | 1207 | 136 |
| OMAD | ERA5 model only | 2927 | 535 | 1112 | 471 | 260 | 549 | 1280 | 87 |
| OMAL | METAR (obs-met) | 2927 | 1557 | 698 | 300 | 176 | 196 | 672 | 30 |
| OMAL | IFS 9 km model only | 2927 | 1640 | 669 | 292 | 167 | 159 | 618 | 21 |
| OMAL | ERA5 model only | 2927 | 1454 | 713 | 305 | 190 | 265 | 760 | 47 |
<!-- validate:end:hours-anchor -->

Model-only IFS WBGT gets the count of hours at or above 30.8 °C within about ±10 % of the METAR-based count; ERA5
over-counts by up to about 17 %. The ADOSH High-zone count is far less robust. At OMAA the IFS analysis gives about
three times the METAR-based count, because it under-reads the wind there by about 1.2 m/s and TWL falls steeply as wind
drops (protective at that airport). At OMAL it gives fewer High-zone hours than the METAR-based count (not protective).

### 2.8 Agreement with the research preview

`docs/research/data_and_validation.md` §6.5 previewed the same statistics in Python (thermofeel 2.3.0, with a slightly
different radiation pre-processing). The engine reproduces it:

<!-- validate:begin:hours-research -->
| Site | Model | p50 (ours / preview) | p95 | max | h ≥ 30 | h ≥ 32 | h ≥ 33 | h ≥ 30 outside break |
|---|---|---|---|---|---|---|---|---|
| Musaffah | ERA5 | 30.4 / 30.3 | 35.3 / 35.2 | 40.1 / 39.9 | 1615 / 1621 | 877 / 870 | 609 / 595 | 1430 / 1436 |
| Musaffah | IFS 9 km | 30.2 / 30.2 | 34.6 / 34.5 | 39.9 / 40.2 | 1551 / 1552 | 743 / 736 | 455 / 454 | 1367 / 1368 |
| KEZAD | ERA5 | 30.6 / 30.7 | 35.0 / 34.9 | 39.9 / 39.6 | 1786 / 1804 | 918 / 904 | 618 / 590 | 1600 / 1618 |
| KEZAD | IFS 9 km | 30.2 / 30.2 | 34.3 / 34.3 | 38.4 / 38.6 | 1561 / 1561 | 776 / 768 | 453 / 453 | 1377 / 1376 |
| Ruwais | ERA5 | 29.9 / 29.9 | 34.6 / 34.5 | 39.6 / 39.5 | 1422 / 1425 | 691 / 685 | 439 / 431 | 1241 / 1243 |
| Ruwais | IFS 9 km | 29.8 / 29.8 | 34.3 / 34.4 | 38.5 / 38.7 | 1402 / 1398 | 635 / 638 | 373 / 381 | 1223 / 1218 |
| Al Ain | ERA5 | 28.2 / 28.3 | 34.1 / 33.9 | 39.6 / 39.5 | 996 / 987 | 514 / 489 | 307 / 278 | 816 / 808 |
| Al Ain | IFS 9 km | 27.7 / 27.7 | 33.2 / 33.1 | 38.5 / 38.7 | 819 / 818 | 348 / 336 | 168 / 164 | 646 / 644 |
| Saadiyat | ERA5 | 30.7 / 30.7 | 35.1 / 35.0 | 39.8 / 39.5 | 1829 / 1839 | 924 / 911 | 629 / 610 | 1644 / 1653 |
| Saadiyat | IFS 9 km | 30.6 / 30.6 | 34.5 / 34.4 | 38.4 / 38.5 | 1759 / 1768 | 838 / 829 | 504 / 492 | 1574 / 1584 |
<!-- validate:end:hours-research -->

<!-- validate:begin:hours-stamp -->
Stamp `zill@0.1.0+code.b262bcaa33a5+inputs.7b48c4cb3d30` · cooled rest WBGT 25 °C (engine/risk.ts COOLED_REST.wbgtC).
<!-- validate:end:hours-stamp -->

---

## 3. Forecast skill at lead days 1–3

### 3.1 Method

- **Same-model skill.** `public/data/weather/previous-runs/{site}_{2024,2025}.json` (Open-Meteo Previous Runs, Jun–Sep,
  five sites). Each model's d1–d3 forecast is scored against the same model's d0, a short-range proxy for the analysis.
  This isolates how fast error grows with lead time. **Primary model:** `ecmwf_ifs025`, the same IFS as the live
  forecast but on a 0.25° grid. **Comparison models:** `dwd_icon_seamless` and `ncep_gfs_seamless`. WBGT and TWL (in
  sun) come from `computeSiteHeat` for every hour.
- **Scores.** Bias, MAE and RMSE, with a 95 % interval from a day-block bootstrap (1,000 replicates of whole site-days).
  Also: daily-max WBGT and daily-min TWL RMSE; POD, FAR, CSI and the Peirce score for the ADOSH High zone and for WBGT ≥
  30.8 °C and ≥ 32.1 °C; zone confusion matrices; "dangerous misses" (forecast at least two zones or bands below the
  verifying one). The baseline is persistence: d0 24, 48 or 72 h earlier, matched to d1, d2 and d3. The MSE skill score
  is computed on the same hours.
- **Airport verification.** Summer 2025 at OMAA, OMAD and OMAL. Each routine METAR at HH:00 UTC is paired with the model
  value at the same instant (n ≈ 2,927 h per airport). The WBGT/TWL reference ("obs-met") uses METAR temperature, dew
  point and 10 m wind with model radiation and surface pressure. The analyses use their own radiation; the forecasts use
  the IFS 9 km archive radiation.

<!-- validate:begin:skill-headline -->
- Same-model WBGT error of the primary model (IFS 0.25°, five sites, Jun–Sep 2024–2025): RMSE **0.81 / 1.00 / 1.19 °C at d1 / d2 / d3** (24 h persistence 1.68 °C; MSE skill vs persistence 0.77 at d1). Daily-max RMSE 0.99 / 1.15 / 1.27 °C.
- WBGT ≥ RAL(115 W) is forecast well (CSI 0.86 / 0.82 / 0.79). The rarer ADOSH High zone is harder: d1 POD 0.63, FAR 0.43, CSI 0.43 (TWL RMSE 20.5 W/m² at d1).
- Against METAR at the airports (bias / RMSE, d1, obs-met reference): OMAA -0.12 / 1.24, OMAD -0.36 / 1.18, OMAL -0.49 / 1.30 °C WBGT. GFS is too dry for humidity: d1 dew-point bias -3.1, -4.9, -3.1 °C.
<!-- validate:end:skill-headline -->

### 3.2 Same-model skill

<!-- validate:begin:skill-same-model -->
| Model | Lead | WBGT bias / MAE / RMSE (°C) | RMSE 95 % CI | daily-max RMSE | MSE skill vs persistence | TWL bias / MAE / RMSE (W/m²) | daily-min RMSE | MSE skill vs persistence |
|---|---|---|---|---|---|---|---|---|
| IFS 0.25° (primary) | d1 | -0.05 / 0.57 / 0.81 | 0.78–0.83 | 0.99 | 0.77 | -0.1 / 13.9 / 20.5 | 26.9 | 0.72 |
| IFS 0.25° (primary) | d2 | -0.02 / 0.72 / 1.00 | 0.97–1.03 | 1.15 | 0.76 | -1.1 / 17.0 / 24.5 | 31.1 | 0.72 |
| IFS 0.25° (primary) | d3 | 0.00 / 0.86 / 1.19 | 1.15–1.23 | 1.27 | 0.70 | -2.1 / 19.6 / 28.0 | 32.9 | 0.66 |
| IFS 0.25° persistence | 24 h | -0.01 / 1.24 / 1.68 |  |  |  | 0.0 / 28.2 / 38.9 |  |  |
| IFS 0.25° persistence | 48 h | -0.01 / 1.55 / 2.03 |  |  |  | 0.0 / 34.6 / 46.3 |  |  |
| IFS 0.25° persistence | 72 h | -0.02 / 1.67 / 2.18 |  |  |  | 0.3 / 36.4 / 48.4 |  |  |
| ICON | d1 | 0.16 / 0.59 / 0.83 | 0.80–0.86 | 0.96 | 0.68 | -3.7 / 15.2 / 21.5 | 26.2 | 0.64 |
| ICON | d2 | 0.16 / 0.72 / 1.02 | 0.99–1.05 | 1.21 | 0.68 | -3.1 / 18.4 / 25.8 | 31.8 | 0.64 |
| ICON | d3 | 0.16 / 0.82 / 1.14 | 1.10–1.17 | 1.28 | 0.65 | -2.5 / 20.5 / 28.8 | 34.4 | 0.58 |
| ICON persistence | 24 h | -0.01 / 1.07 / 1.46 |  |  |  | 0.1 / 26.5 / 36.0 |  |  |
| ICON persistence | 48 h | -0.02 / 1.35 / 1.80 |  |  |  | 0.2 / 32.3 / 42.9 |  |  |
| ICON persistence | 72 h | -0.03 / 1.43 / 1.92 |  |  |  | 0.5 / 33.7 / 44.6 |  |  |
| GFS | d1 | -0.25 / 0.54 / 0.78 | 0.75–0.81 | 1.00 | 0.62 | 4.5 / 13.3 / 20.4 | 29.7 | 0.52 |
| GFS | d2 | -0.31 / 0.70 / 1.00 | 0.97–1.03 | 1.23 | 0.57 | 5.6 / 16.8 / 24.8 | 35.4 | 0.45 |
| GFS | d3 | -0.28 / 0.78 / 1.10 | 1.06–1.15 | 1.29 | 0.55 | 5.1 / 17.9 / 25.9 | 35.9 | 0.44 |
| GFS persistence | 24 h | 0.00 / 0.91 / 1.27 |  |  |  | 0.0 / 20.9 / 29.6 |  |  |
| GFS persistence | 48 h | 0.00 / 1.12 / 1.53 |  |  |  | -0.1 / 24.5 / 33.6 |  |  |
| GFS persistence | 72 h | -0.01 / 1.21 / 1.65 |  |  |  | 0.1 / 25.7 / 34.8 |  |  |
<!-- validate:end:skill-same-model -->

### 3.3 Zone exceedance

<!-- validate:begin:skill-events -->
| Model | Lead | Event (verified against d0) | base rate | POD | FAR | CSI | Peirce |
|---|---|---|---|---|---|---|---|
| IFS 0.25° | d1 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.63 | 0.43 | 0.43 | 0.61 |
| IFS 0.25° | d1 | WBGT ≥ RAL(115 W) = 30.84 °C | 36.6 % | 0.93 | 0.08 | 0.86 | 0.88 |
| IFS 0.25° | d1 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 23.2 % | 0.89 | 0.11 | 0.80 | 0.86 |
| IFS 0.25° | d2 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.57 | 0.53 | 0.34 | 0.55 |
| IFS 0.25° | d2 | WBGT ≥ RAL(115 W) = 30.84 °C | 36.6 % | 0.91 | 0.11 | 0.82 | 0.85 |
| IFS 0.25° | d2 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 23.2 % | 0.88 | 0.14 | 0.77 | 0.83 |
| IFS 0.25° | d3 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.51 | 0.57 | 0.31 | 0.49 |
| IFS 0.25° | d3 | WBGT ≥ RAL(115 W) = 30.84 °C | 36.6 % | 0.90 | 0.13 | 0.79 | 0.82 |
| IFS 0.25° | d3 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 23.2 % | 0.86 | 0.17 | 0.74 | 0.81 |
| IFS 0.25° persistence | 24 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.28 | 0.72 | 0.16 | 0.26 |
| IFS 0.25° persistence | 24 h | WBGT ≥ RAL(115 W) = 30.84 °C | 36.7 % | 0.83 | 0.16 | 0.72 | 0.74 |
| IFS 0.25° persistence | 48 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.20 | 0.80 | 0.11 | 0.17 |
| IFS 0.25° persistence | 48 h | WBGT ≥ RAL(115 W) = 30.84 °C | 36.8 % | 0.80 | 0.20 | 0.66 | 0.68 |
| IFS 0.25° persistence | 72 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 2.9 % | 0.18 | 0.81 | 0.10 | 0.16 |
| IFS 0.25° persistence | 72 h | WBGT ≥ RAL(115 W) = 30.84 °C | 36.9 % | 0.78 | 0.22 | 0.64 | 0.65 |
| ICON | d1 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 4.9 % | 0.69 | 0.39 | 0.48 | 0.67 |
| ICON | d1 | WBGT ≥ RAL(115 W) = 30.84 °C | 44.2 % | 0.94 | 0.11 | 0.84 | 0.85 |
| ICON | d1 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 28.1 % | 0.93 | 0.12 | 0.82 | 0.88 |
| ICON | d2 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 4.9 % | 0.62 | 0.44 | 0.42 | 0.59 |
| ICON | d2 | WBGT ≥ RAL(115 W) = 30.84 °C | 44.2 % | 0.93 | 0.13 | 0.82 | 0.82 |
| ICON | d2 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 28.1 % | 0.90 | 0.14 | 0.78 | 0.84 |
| ICON | d3 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 4.9 % | 0.58 | 0.48 | 0.38 | 0.56 |
| ICON | d3 | WBGT ≥ RAL(115 W) = 30.84 °C | 44.2 % | 0.92 | 0.15 | 0.79 | 0.79 |
| ICON | d3 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 28.1 % | 0.90 | 0.17 | 0.76 | 0.82 |
| ICON persistence | 24 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 4.9 % | 0.40 | 0.60 | 0.25 | 0.36 |
| ICON persistence | 24 h | WBGT ≥ RAL(115 W) = 30.84 °C | 44.4 % | 0.85 | 0.15 | 0.74 | 0.73 |
| ICON persistence | 48 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 4.9 % | 0.32 | 0.68 | 0.19 | 0.29 |
| ICON persistence | 48 h | WBGT ≥ RAL(115 W) = 30.84 °C | 44.5 % | 0.81 | 0.19 | 0.68 | 0.66 |
| ICON persistence | 72 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 5.0 % | 0.30 | 0.69 | 0.18 | 0.27 |
| ICON persistence | 72 h | WBGT ≥ RAL(115 W) = 30.84 °C | 44.7 % | 0.80 | 0.20 | 0.67 | 0.64 |
| GFS | d1 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.4 % | 0.41 | 0.57 | 0.26 | 0.40 |
| GFS | d1 | WBGT ≥ RAL(115 W) = 30.84 °C | 32.6 % | 0.88 | 0.05 | 0.84 | 0.86 |
| GFS | d1 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 18.8 % | 0.83 | 0.09 | 0.77 | 0.82 |
| GFS | d2 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.4 % | 0.27 | 0.73 | 0.15 | 0.26 |
| GFS | d2 | WBGT ≥ RAL(115 W) = 30.84 °C | 32.6 % | 0.86 | 0.07 | 0.81 | 0.83 |
| GFS | d2 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 18.8 % | 0.79 | 0.12 | 0.71 | 0.76 |
| GFS | d3 | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.4 % | 0.27 | 0.74 | 0.15 | 0.25 |
| GFS | d3 | WBGT ≥ RAL(115 W) = 30.84 °C | 32.6 % | 0.85 | 0.09 | 0.79 | 0.82 |
| GFS | d3 | WBGT ≥ 32.1 °C (Qatar stop-work value) | 18.8 % | 0.78 | 0.15 | 0.69 | 0.74 |
| GFS persistence | 24 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.5 % | 0.15 | 0.85 | 0.08 | 0.14 |
| GFS persistence | 24 h | WBGT ≥ RAL(115 W) = 30.84 °C | 32.7 % | 0.86 | 0.14 | 0.76 | 0.80 |
| GFS persistence | 48 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.5 % | 0.12 | 0.88 | 0.07 | 0.11 |
| GFS persistence | 48 h | WBGT ≥ RAL(115 W) = 30.84 °C | 32.8 % | 0.83 | 0.17 | 0.71 | 0.75 |
| GFS persistence | 72 h | ADOSH High zone (TWL ≤ 115 W/m², sun) | 1.5 % | 0.10 | 0.90 | 0.05 | 0.09 |
| GFS persistence | 72 h | WBGT ≥ RAL(115 W) = 30.84 °C | 33.0 % | 0.82 | 0.18 | 0.69 | 0.73 |

Dangerous misses (forecast at least two zones or bands below the verifying d0 value):

| Model | Lead | ADOSH: forecast Low while d0 is High (h) | WBGT: forecast ≥ 2 bands below d0 (h) |
|---|---|---|---|
| IFS 0.25° | d1 | 110 of 834 (13 %) | 163 of 29280 (0.6 %) |
| IFS 0.25° | d2 | 157 of 834 (19 %) | 273 of 29280 (0.9 %) |
| IFS 0.25° | d3 | 190 of 834 (23 %) | 390 of 29280 (1.3 %) |
| ICON | d1 | 117 of 1422 (8 %) | 122 of 29280 (0.4 %) |
| ICON | d2 | 192 of 1422 (14 %) | 285 of 29280 (1.0 %) |
| ICON | d3 | 275 of 1422 (19 %) | 363 of 29280 (1.2 %) |
| GFS | d1 | 147 of 423 (35 %) | 239 of 29280 (0.8 %) |
| GFS | d2 | 208 of 423 (49 %) | 391 of 29280 (1.3 %) |
| GFS | d3 | 216 of 423 (51 %) | 453 of 29280 (1.5 %) |
<!-- validate:end:skill-events -->

### 3.4 Error by local hour (primary model)

<!-- validate:begin:skill-by-hour -->
| Lead | 00:00 | 03:00 | 06:00 | 09:00 | 12:00 | 15:00 | 18:00 | 21:00 |
|---|---|---|---|---|---|---|---|---|
| d1 WBGT RMSE | 0.80 | 0.77 | 0.89 | 0.90 | 0.89 | 0.67 | 0.62 | 0.64 |
| d2 WBGT RMSE | 0.95 | 1.05 | 1.20 | 1.08 | 1.09 | 0.85 | 0.72 | 0.78 |
| d3 WBGT RMSE | 1.20 | 1.25 | 1.45 | 1.30 | 1.28 | 0.92 | 0.85 | 0.98 |
<!-- validate:end:skill-by-hour -->

### 3.5 Airport verification against METAR

Archive analyses (§6.1/§6.3 of the research note), bias / RMSE (model − observation):

<!-- validate:begin:skill-airport-analysis -->
| Airport | Analysis | n | T bias / RMSE | Td bias / RMSE | wind bias / RMSE (m/s) | WBGT all hours | WBGT 07–18 h | WBGT from T/Td only | TWL (W/m²) |
|---|---|---|---|---|---|---|---|---|---|
| OMAA | ERA5 | 2927 | +0.13 / 1.26 | +0.86 / 2.87 | -0.53 / 1.44 | +0.51 / 1.18 | +0.76 / 1.32 | +0.38 / 1.01 | -12.6 / 28.5 |
| OMAA | IFS 9 km | 2927 | -0.40 / 1.83 | -0.16 / 2.85 | -1.16 / 1.65 | -0.01 / 1.07 | +0.43 / 1.11 | -0.23 / 0.95 | -10.7 / 27.5 |
| OMAD | ERA5 | 2927 | -0.50 / 1.20 | +0.58 / 2.60 | +0.72 / 1.39 | -0.10 / 0.95 | -0.11 / 1.04 | -0.04 / 0.86 | 9.7 / 27.8 |
| OMAD | IFS 9 km | 2927 | -0.59 / 1.68 | -0.41 / 2.50 | -0.58 / 1.15 | -0.33 / 1.06 | +0.05 / 1.01 | -0.46 / 0.99 | 0.6 / 25.6 |
| OMAL | ERA5 | 2927 | -0.83 / 1.47 | +1.40 / 3.83 | -0.49 / 1.45 | +0.13 / 1.20 | +0.34 / 1.24 | +0.04 / 1.09 | -3.7 / 24.1 |
| OMAL | IFS 9 km | 2927 | -0.63 / 1.43 | -0.63 / 2.97 | -0.66 / 1.47 | -0.41 / 1.17 | -0.18 / 1.09 | -0.52 / 1.12 | 2.2 / 21.8 |
<!-- validate:end:skill-airport-analysis -->

Forecasts, bias / RMSE for d0 → d1 → d2 → d3:

<!-- validate:begin:skill-airport-forecast -->
| Airport | Model | T (°C) d0 → d3 | Td (°C) d0 → d3 | WBGT (°C) d0 → d3 | TWL (W/m²) d0 → d3 |
|---|---|---|---|---|---|
| OMAA | IFS 0.25° | -0.35 / 1.54 → -0.60 / 1.83 → -0.68 / 1.97 → -0.75 / 2.14 | -0.15 / 2.57 → -0.17 / 3.02 → -0.14 / 3.33 → +0.00 / 3.73 | -0.02 / 1.03 → -0.12 / 1.24 → -0.12 / 1.34 → -0.07 / 1.42 | -8 / 25 → -8 / 29 → -9 / 31 → -11 / 33 |
| OMAA | ICON | -0.10 / 1.09 → -0.19 / 1.27 → -0.10 / 1.29 → +0.02 / 1.42 | +1.90 / 3.52 → +2.34 / 4.14 → +2.31 / 4.22 → +2.08 / 4.28 | +1.03 / 1.58 → +1.20 / 1.81 → +1.22 / 1.87 → +1.16 / 1.86 | -30 / 43 → -34 / 48 → -34 / 49 → -32 / 48 |
| OMAA | GFS | -0.69 / 2.13 → -0.77 / 2.29 → -0.52 / 2.30 → -0.35 / 2.35 | -2.35 / 3.91 → -3.14 / 4.79 → -3.72 / 5.47 → -4.03 / 5.98 | -1.27 / 1.88 → -1.62 / 2.26 → -1.73 / 2.43 → -1.76 / 2.56 | 20 / 36 → 25 / 41 → 27 / 45 → 27 / 47 |
| OMAD | IFS 0.25° | -1.14 / 1.66 → -1.15 / 1.82 → -1.25 / 1.95 → -1.28 / 2.06 | +0.26 / 2.25 → +0.14 / 2.59 → +0.29 / 2.84 → +0.38 / 3.21 | -0.32 / 1.04 → -0.36 / 1.18 → -0.31 / 1.26 → -0.27 / 1.34 | 2 / 26 → 2 / 29 → 0 / 30 → -1 / 33 |
| OMAD | ICON | -0.64 / 1.33 → -0.71 / 1.48 → -0.60 / 1.48 → -0.47 / 1.53 | +1.16 / 2.93 → +1.54 / 3.41 → +1.52 / 3.44 → +1.36 / 3.52 | +0.25 / 1.21 → +0.39 / 1.36 → +0.42 / 1.38 → +0.41 / 1.43 | -2 / 32 → -6 / 35 → -6 / 35 → -5 / 37 |
| OMAD | GFS | -0.49 / 1.88 → -0.56 / 2.04 → -0.32 / 2.12 → -0.14 / 2.19 | -4.09 / 5.22 → -4.87 / 6.11 → -5.39 / 6.75 → -5.70 / 7.20 | -2.07 / 2.46 → -2.43 / 2.86 → -2.51 / 3.01 → -2.55 / 3.12 | 45 / 58 → 50 / 64 → 52 / 67 → 52 / 69 |
| OMAL | IFS 0.25° | -0.73 / 1.39 → -0.95 / 1.71 → -0.96 / 1.82 → -0.98 / 1.94 | -0.44 / 2.92 → -0.47 / 3.48 → -0.66 / 3.88 → -0.54 / 4.14 | -0.38 / 1.15 → -0.49 / 1.30 → -0.52 / 1.43 → -0.51 / 1.53 | 2 / 22 → 2 / 23 → 2 / 25 → 2 / 27 |
| OMAL | ICON | +0.03 / 1.13 → -0.01 / 1.40 → +0.07 / 1.49 → +0.15 / 1.53 | +1.17 / 3.39 → +1.53 / 4.27 → +1.43 / 4.44 → +1.17 / 4.54 | +0.56 / 1.35 → +0.73 / 1.57 → +0.73 / 1.65 → +0.66 / 1.68 | -17 / 34 → -21 / 39 → -21 / 40 → -20 / 40 |
| OMAL | GFS | -0.55 / 2.14 → -0.69 / 2.31 → -0.53 / 2.32 → -0.33 / 2.33 | -2.55 / 4.19 → -3.08 / 4.89 → -3.66 / 5.47 → -3.91 / 5.87 | -1.12 / 1.79 → -1.34 / 2.02 → -1.46 / 2.17 → -1.45 / 2.23 | 12 / 30 → 14 / 32 → 15 / 34 → 15 / 35 |
<!-- validate:end:skill-airport-forecast -->

### 3.6 Agreement with the research preview

<!-- validate:begin:skill-research -->
| Model | Lead | RMSE ours / preview | daily-max RMSE ours / preview | CSI ≥ 30 °C ours / preview | CSI ≥ 32 °C ours / preview |
|---|---|---|---|---|---|
| IFS 0.25° | d1 | 0.81 / 0.82 | 0.99 / 1.05 | 0.87 / 0.87 | 0.81 / 0.82 |
| IFS 0.25° | d2 | 1 / 1.01 | 1.15 / 1.22 | 0.85 / 0.85 | 0.78 / 0.78 |
| IFS 0.25° | d3 | 1.19 / 1.2 | 1.27 / 1.33 | 0.82 / 0.82 | 0.74 / 0.74 |
| ICON | d1 | 0.83 / 0.83 | 0.96 / 0.97 | 0.88 / — | 0.82 / — |
| ICON | d2 | 1.02 / 1.02 | 1.21 / 1.21 | 0.86 / — | 0.79 / — |
| ICON | d3 | 1.14 / 1.14 | 1.28 / 1.28 | 0.83 / — | 0.76 / — |
| GFS | d1 | 0.78 / 0.78 | 1 / 1.02 | 0.86 / — | 0.78 / — |
| GFS | d2 | 1 / 1 | 1.23 / 1.24 | 0.82 / — | 0.72 / — |
| GFS | d3 | 1.1 / 1.1 | 1.29 / 1.3 | 0.81 / — | 0.7 / — |

Largest |ours − preview| over the airport tables (bias and RMSE): T 0.01, Td 0.01, WBGT 0.03, wind 0.00 (°C or m/s).
<!-- validate:end:skill-research -->

<!-- validate:begin:skill-stamp -->
Stamp `zill@0.1.0+code.b262bcaa33a5+inputs.14a8c8caf989`.
<!-- validate:end:skill-stamp -->

### 3.7 What this means for the product

- **Uncertainty band.** Size the forecast band from the RMSE by lead day: about ±0.8 / ±1.0 / ±1.2 °C WBGT at
  d1 / d2 / d3 from same-model error. Against observations the d1 error is about 1.2–1.3 °C RMSE at the airports
  (§3.5), because the analysis itself carries about 1.0–1.2 °C before any forecast error. A forecast within one RMSE
  below a threshold should read "possible".
- **TWL zones need a margin.** The ADOSH High zone is rare (about 3 % of hours) and wind-sensitive. Its d1 CSI is far
  below that of the WBGT thresholds, and some High-zone hours are forecast as Low. A forecast TWL within about one TWL
  RMSE (≈ 20 W/m² at d1) above 115 W/m² should be treated as possibly High.
- **Use ECMWF for humidity.** GFS is several degrees too dry in dew point and ICON too humid, which moves WBGT by about
  −1.1 to −2.6 °C (GFS) and +0.3 to +1.2 °C (ICON) at the airports. Neither should be the humidity source.
- **Forecasts beat persistence.** The d1–d3 WBGT forecasts keep most of their skill against persistence. A
  forecast-aware planner is worth having.

---

## 4. Caveats

- **Grid cells are not stations, and stations are not worksites.** The archive is an analysis (IFS) or a reanalysis
  (ERA5) on a 9 km or 0.25° grid. It misses the local microclimate of a yard, a deck or a street canyon: hot surfaces,
  shelter, sea breeze. The site radiant allowance is an [ENG] assumption, not a measurement.
- **Airports only.** The observational checks use three airports and one summer. The airports stand in for the sites
  only approximately: OMAA for Musaffah and KEZAD, OMAD for Saadiyat, OMAL for Al Ain, and none for Ruwais. METAR
  temperatures are whole degrees (about 0.29 °C RMS quantisation), and METAR has no radiation, so the WBGT/TWL reference
  borrows model radiation.
- **Not the production model.** `ecmwf_ifs025` is the IFS at 0.25°, 3-hourly, interpolated to hourly. The production
  IFS 9 km has Previous Runs only from 1 Oct 2025, so its skill can first be measured in summer 2026. Same-model scores
  leave out model bias and are optimistic. d0 is a short-range forecast, not the truth.
- **TWL plausibility limits.** The UAE field TWL values come from other years and months, from worksites, and from
  instruments with measured wind. TWL is very sensitive to wind, and the analyses under-read wind at OMAA. The
  comparison in §2.6 is a sanity check, not a validation of TWL at Abu Dhabi sites.
- **WBGT model limitations.** Liljegren's model was validated at US sites, with about ±1 °C expected accuracy; no Gulf
  validation exists (`LIMITATIONS.md` M-02). The engine's wind profile (urban power law, 0.62 m/s floor), the
  engineered-shade assumption, ground temperature equal to air temperature, and the hour-mean radiation handling each
  shift single hours by tenths of a degree, and occasionally by up to 2.7 °C near sunrise or sunset. Seasonal counts
  move by less than 1 % (research note §6.5). The engine uses modelled WBGT where a site meter is absent. The model is
  an index of the environment, not a measurement of any worker's strain.
- **Thresholds are context, not verdicts.** The band edges assume ordinary work clothes and the ACGIH resting rate.
  Coveralls, FR clothing or a hood raise WBGT_eff (`limits.ts` CAVs). The 32.1 °C value is Qatar's rule, shown for
  comparison only.
- **Exposure, not outcomes.** Hours in a zone count environmental conditions. They are not worker-hours of exposure,
  not incidence, and not a prediction of heat illness.

---

## 5. Simulated cohort

The simulated-cohort results (closed-loop policy comparison, shadow-mode detection, robustness and fairness, all
projections under stated assumptions) are in **`docs/VALIDATION-COHORT.md`**. They are generated by
`scripts/validate/cohort.ts`, which `npm run validate` runs when present.

---

## 6. Provenance and data licences

- Weather data by [Open-Meteo.com](https://open-meteo.com/), CC BY 4.0. ERA5 contains modified Copernicus Climate
  Change Service information. ECMWF IFS open data via Open-Meteo. DWD ICON and NCEP GFS via Open-Meteo Previous Runs.
- METAR observations from the Iowa Environmental Mesonet (IEM), Iowa State University.
- Each JSON's `provenance.inputs` lists every file read, with its size and SHA-256. `manifestMismatches` must be empty.
- JSON schemas: `zill.validation.reference/v1`, `zill.validation.hours_in_zone/v1` and
  `zill.validation.forecast_skill/v1`. Their TypeScript contracts are the exported `ReferenceReport`,
  `HoursInZoneReport` and `ForecastSkillReport` interfaces in `scripts/validate/`.
