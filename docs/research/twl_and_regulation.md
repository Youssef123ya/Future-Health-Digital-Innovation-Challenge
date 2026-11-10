# Thermal Work Limit (TWL) and the Abu Dhabi / UAE occupational-heat rules

*Zill research note: port-ready specification and regulatory digest. Compiled 2026-11-09.*

Companion artefacts:
- Oracle (reference implementation and validator): `scripts/oracles/twl_oracle.py`
- Fixture (42 vectors, plus the full reproduction of the paper's Table I): `fixtures/twl.json`
- Reproduce: `python scripts/oracles/twl_oracle.py`. The script uses only the standard library. It exits with code 0 only when every pre-registered acceptance check passes; the run on 2026-11-09 passed 9/9. The ninth check (globe→MRT vs pythermalcomfort) is skipped automatically if that package is absent.

Labels used in this note: **[P]** primary source (standard, regulator document or original paper), **[S]** reputable secondary source (news agency, law firm, peer-reviewed review), **[V]** vendor material, **UNVERIFIED** means it could not be confirmed (the attempts made are stated).

---

## 0. TL;DR for the engineering team

1. **TWL is a closed-form heat balance solved by a 1-D root find.** The unknown is mean skin temperature. The core temperature is fixed at 38.2 °C and sweat is capped at 0.67 kg m⁻² h⁻¹. TWL equals core-to-skin heat flow divided by (1 − respiratory fraction). Every equation is in §1.4 and the solver in §1.5.
2. **Inputs:** dry bulb, **psychrometric (aspirated) wet bulb** or any other humidity measure converted to vapour pressure, **mean radiant temperature** (or globe temperature converted with ISO 7726), wind speed clamped to [0.2, 4] m/s, barometric pressure (kPa), and clothing (default Icl 0.35 clo, icl 0.45). Do **not** feed natural wet bulb from the WBGT model into TWL.
3. **The paper contains a typo-level ambiguity** in the sweat-efficiency equation (§1.6). We default to the **"physical"** reading. It is continuous, conservative and consistent with the paper's own text and with UAE field data. It reproduces 54/62 of the paper's numeric Table I cells within 1.4 W/m² and all 62 within +1.3/−10.1 W/m². The alternative "1.8" reading reproduces all 62 within ±1.9 W/m² but gives much higher TWL in dry, windy Abu Dhabi conditions. Both are in the fixture.
4. **We found no open-source TWL implementation** (GitHub repository search, the HeatStress R package, pythermalcomfort 4.8.1 and thermofeel 2.3.0 were all checked). As far as we could find, the oracle in this repo is the only openly licensed implementation. A proprietary but source-visible calculator by Point Health (© 2021, contact G. Bates) is live at https://www.pointhealth.com.au/TWL/ and uses a different, EESAM-based formulation (§1.9) [corrected by fact-check].
5. **Abu Dhabi zones** (ADOSH-SF Technical Guideline *Safety in the Heat* v4.0, 15 July 2024, Table 1): **High Risk TWL < 115**, **Medium Risk (Cautionary) 115–140**, **Low Risk (Unrestricted) 140–220 <**. The work/rest and water schedules are in §2.3 and §6. The CoP gives the 35 °C trigger: any worksite that "has, or it is reasonably foreseeable to have, a temperature at or above 35 degrees Celsius at any time during a work shift" must run a heat stress program.
6. **UAE federal midday break:** **15 June – 15 September, 12:30–15:00**, outdoor work under direct sun or in open places prohibited (Ministerial Resolution No. 44 of 2022). Fine **AED 5,000 per worker, capped at AED 50,000**. 2026 was the 22nd consecutive year, announced 8 June 2026. Qatar adds a **WBGT > 32.1 °C stop-work rule at any time** (Ministerial Decision 17/2021).

---

## 1. TWL — port-ready algorithm

### 1.1 Definition and primary sources

- **[P] Brake DJ, Bates GP (2002).** "Limiting Metabolic Rate (Thermal Work Limit) as an Index of Thermal Stress." *Appl Occup Environ Hyg* 17(3):176–186. doi:[10.1080/104732202753438261](https://doi.org/10.1080/104732202753438261).
  - The publisher copy is paywalled. The full text was read from a copy with the "Downloaded by: [Curtin University Library] 18 March 2008" stamp, publicly hosted in the TWL-meter vendor's research library ([Scarlet Tech research articles](https://legacy.scarlet-tech.com/download-file/research-articles/)).
  - All equations below are from its **Appendix 1, "Derivation of TWL"**.
- Definition (abstract, verbatim): *"TWL is defined as the limiting (or maximum) sustainable metabolic rate that euhydrated, acclimatized individuals can maintain in a specific thermal environment, within a safe deep body core temperature (< 38.20°C) and sweat rate (< 1.2 kg/hr⁻¹)."*
- *"The index is designed specifically for self-paced workers and does not rely on estimation of actual metabolic rates."* Self-paced workers are *"those who can and do regulate their own work rate, are not subject to excessive peer or supervisor pressure or monetary incentives, and are well educated about the issues of working in heat"*.
- **[P] Brake R, Bates G (2002).** "A valid method for comparing rational and empirical heat stress indices." *Ann Occup Hyg* 46(2):165–174. doi:[10.1093/annhyg/mef030](https://doi.org/10.1093/annhyg/mef030). This is a scanned copy from the same library. It fixes the standard TWL clothing: *"Thermal work limit, or TWL (Brake and Bates, 2002), using 0.35 clo, 0.45 vapour permeation ratio and a 0.73 posture factor."*
- **[P] Miller VS, Bates GP (2007).** "The Thermal Work Limit Is a Simple Reliable Heat Index for the Protection of Workers in Thermally Stressful Environments." *Ann Occup Hyg* 51(6):553–561. doi:[10.1093/annhyg/mem035](https://doi.org/10.1093/annhyg/mem035) ([PDF copy](https://www.hqinc.net/wp-content/uploads/2012/05/ANNOHBatesThermalWorkLimitWBGT2007.pdf)).
  - *"TWL uses five environmental parameters (dry bulb, wet bulb and globe temperatures, wind speed and atmospheric pressure) and accommodates for clothing factors to arrive at a prediction of a safe maximum continuously sustainable metabolic rate (W m⁻²)."*
  - *"…the TWL algorithm allows for core temperature to reach a maximum of 38.2°C."*

### 1.2 Inputs

| Input | Unit | Notes |
|---|---|---|
| `tdb` dry bulb | °C | — |
| humidity | — | **Psychrometric (aspirated / thermodynamic) wet bulb** in the original. This is not natural wet bulb.<br>Evidence:<br>• Australian mine practice uses aspirated psychrometers.<br>• The Calor HSM and Kestrel 5400 measure RH and compute WB **[V]**.<br>• Kapanowski's (2018) TWL validation states it used *"psychrometric wet bulb (Tpwb)"* **[S]**.<br>• Miller & Bates' chamber "wet bulb ≈ 28 °C at 38–40 °C and 45 % RH" matches psychrometric WB.<br>Internally only the vapour pressure `pa` is used, so the engine may pass RH or dew point instead (`pa = RH/100·psat(tdb)`). |
| `tr` mean radiant temperature | °C | Table I of the paper is specified in MRT ("MRT = DB + 2 °C" etc.). The paper says only that *"trad is a function of both globe temperature and wind speed"* and does not give the globe→MRT equation.<br>We use **ISO 7726:1998 Annex B** (§1.7). |
| `v` wind speed over the skin | m/s | *"In the TWL formulation, wind speed has a minimum value of 0.2 m/s … Under TWL, wind speed is also limited to 4 m/s."* Clamp to [0.2, 4]. |
| `P` barometric pressure | kPa | Enters `hc`, `he` and the psychrometric equation. |
| `Icl` intrinsic clothing insulation | clo | Default **0.35** (worked example; AOH 2002). |
| `icl` clothing vapour permeation efficiency | — | Default **0.45**. *"cannot exceed 1.0"*. |

### 1.3 Constants and assumptions (all from Brake & Bates 2002 unless marked)

| Symbol | Value | Source / wording |
|---|---|---|
| `tcore` | **38.2 °C** | *"The limiting deep body core temperature in the standard TWL formulation is 38.2°C, although this is adjustable."* |
| `Srmax` | **0.67 kg m⁻² h⁻¹** | *"maximum sweat rate (which is adjustable) is restricted to 0.67 kg/m⁻²/hr⁻¹ (1.2 liters per hour for a standard person)"*; standard person 70 kg, **1.8 m²** |
| λ | **2430 kJ/kg** | *"λ = 2430 kJ/kg @ 30°C [ASHRAE Eq. 14]"* → λ·Sr [W/m²] = 675·Sr [kg m⁻² h⁻¹] |
| `fr` posture factor | **0.73** | *"typically 0.73 for a standing person"* |
| LR Lewis ratio | **16.5 K/kPa** | ASHRAE eq. 27 |
| skin wettedness | max 1 | *"the assumption of fully wet skin is a reasonable maximum value"* |
| external work `W` | 0 | *"the W term is usually assumed to be zero"* |
| conduction, storage | 0 | steady state |
| valid TWL range | **60–380 W/m²** | *"The valid range for TWL is from resting (60 W/m²) to 380 W/m²"* |
| validity limits | — | *"TWL is not valid where the dew point temperature of the ambient air is above the skin or clothing temperature"*; not valid for impermeable / encapsulating clothing |
| thermoregulatory-signal range | 36–39.5 °C | *"The acceptable range for the thermoregulatory signal in the model is from 36°C to 39.5°C"*. With tcore = 38.2 this is always satisfied for tsk between 16.2 and 51.2 °C. |
| psychrometric coefficient `A` | 0.000644 K⁻¹ (P in kPa) | **Our choice, not in the paper** (the paper says only "standard … psychrometric" equations). This is the mine-ventilation convention and the best fit to Table I (§1.8). |
| `psat` | Tetens 0.6105·exp(17.27 t/(t+237.3)) kPa | **Our choice.** Fits Table I better than Hyland-Wexler or Buck (§1.8). |

### 1.4 Equations

Here `tsk` is the trial mean skin temperature (°C), `ta = tdb`, `tr` is MRT, and `pa` and `P` are in kPa. Bracketed labels are the paper's own citations: [EESAM] = *Environmental Engineering in South African Mines* (1989), ch. 20; [ASHRAE] = 1997 Fundamentals SI, ch. 8.

1. **Ambient vapour pressure** (our psychrometric choice): `pa = psat(twb) − 0.000644 · P · (tdb − twb)`.
2. **Thermoregulatory signal** (Cabanac): `tΣ = 0.1·tsk + 0.9·tcore`.
3. **Physiological core-to-skin conductance** (curve fitted to Wyndham's data, Fig. 1): `Kcs = 84 + 72·tanh[1.3·(tΣ − 37.9)]` W m⁻² K⁻¹.
4. **Core-to-skin heat flow** [EESAM eq. 23]: `H = Kcs·(tcore − tsk)` W m⁻².
5. **Sweat rate** (curve fitted to Fig. 2): `Sr = 0.42 + 0.44·tanh[1.16·(tΣ − 37.4)]` kg m⁻² h⁻¹, then clamp `0 ≤ Sr ≤ Srmax = 0.67`. Sweat as heat: `λSr = 675·Sr` W m⁻².
6. **Convective coefficient** [EESAM eq. 13]: `hc = 0.608·P^0.6·V^0.6` W m⁻² K⁻¹, with V clamped to [0.2, 4].
7. **Radiative coefficient** [EESAM eq. 9]: `hr = 4.61·[1 + (tr + tsk)/546]^3` W m⁻² K⁻¹. Nude radiation is `R = hr·fr·(tsk − tr)` [EESAM eq. 8].
8. **Combined coefficient and operative temperature** [ASHRAE eqs. 9, 8]: `h = fr·hr + hc` and `to = (fr·hr·tr + hc·ta)/h`.
   - The paper prints `h = hr + hc`, but states that for a nude body `C + R = h(tskin − toper)`. That identity holds only if the radiative term carries `fr`.
   - Table I is reproduced only with `fr·hr`: without `fr`, block A errors rise to a mean of −1.5 W/m².
9. **Clothing, sensible heat** [ASHRAE eq. 47; Table II]:
   - `fcl = 1 + 0.3·Icl`
   - `Rcl = 0.155·Icl` m² K W⁻¹
   - `Fcle = fcl/(1 + fcl·h·Rcl)`
   - `C + R = Fcle·h·(tsk − to)`
10. **Evaporative coefficient** [EESAM eq. 17]: `he = 1587·hc·P/(P − pa)^2` W m⁻² kPa⁻¹. This is ≈ 16.5·hc at P ≈ 100 kPa.
11. **Clothing, evaporative** [ASHRAE Table II]:
    - `Recl = Rcl/(LR·icl)`; set to 0 if Icl = 0
    - `Fpcl = 1/(1 + fcl·he·Recl)`
    - `Emax = Fpcl·fcl·he·(psat(tsk) − pa)` (fully wet skin, w = 1)
12. **Actual evaporation** (Fig. 3, Kerslake / Galimidi & Stewart). With `x = λSr/Emax` (default **"physical"** reading, see §1.6):
    - `x < 0.46`: `E = λSr` (zone A: no dripping, 100 % efficient)
    - `0.46 ≤ x ≤ 1.7`: `E = λSr·exp[−0.4127·(x − 0.46)^1.168]` (zone B: dripping, skin not fully wet)
    - `x > 1.7`: `E = Emax` (zone C: fully wet, dripping)
    - If `Emax ≤ 0` (pa ≥ psat(tsk)), set `E = 0` and flag invalid (dew point at or above skin temperature).
13. **Skin heat balance**: `H = (C + R) + E`.
    - The paper writes "H = Esk". Read in context ("heat flow core to skin equals heat flow skin to environment"), this is the total skin loss.
14. **Respiration** [ASHRAE eq. 26]: `B = 0.0014·M·(34 − ta) + 0.0173·M·(5.87 − pa)`.
15. **TWL**: `M = H + B`, so **`TWL = M = H / [1 − 0.0014·(34 − ta) − 0.0173·(5.87 − pa)]`** (W/m²).

Useful derived outputs:
- Predicted sweat rate at the limit: `Sr` (kg m⁻² h⁻¹), or `Sr·1.8` L/h for a standard 1.8 m² person.
- Skin wettedness: `w = E/Emax`.

### 1.5 Solution procedure

The paper says only: *"There will then be a unique mean skin temperature and metabolic rate that provides a heat balance. This can be solved by iteration."* Our deterministic version follows.

```
f(tsk) = H(tsk) − [(C+R)(tsk) + E(tsk)]        // decreasing in tsk over the physiological range
t_hi  = tcore − 1e-6
if f(t_hi) >= 0:          // skin gains net heat even at core temperature
    TWL = 0; flag NO_ROOT_NET_HEAT_GAIN
else:
    scan t = t_hi downward in steps of 0.05 K, stopping at 20 °C, for the first t with f(t) >= 0
    if none found:  TWL = H(20)/den; flag NO_ROOT_ABOVE_20C_SKIN   // very cool conditions (> valid range)
    else: bisect [t, t+0.05] until width < 1e-10 K (at most 200 iterations); tsk* = midpoint
          TWL = H(tsk*) / den,  den = 1 − 0.0014(34 − tdb) − 0.0173(5.87 − pa)
flags: TWL < 60 → BELOW_VALID_RANGE_60; TWL > 380 → ABOVE_VALID_RANGE_380;
       dewpoint(pa) >= tsk* → DEWPOINT_AT_OR_ABOVE_SKIN_TEMP_INVALID;
       v < 0.2 or v > 4 → WIND_CLAMPED_*;  tdb > 44 → BACKSTOP_DB_GT_44C;  twb > 32 → BACKSTOP_WB_GT_32C
```

Notes:
- `H(tsk)` peaks at ≈ 347 W/m² near tsk ≈ 31.3 °C [corrected by fact-check], so the warm-skin root is the physiologically relevant one. Scanning down from `tcore` finds it first. In all hot cases tested, tsk* lies between 33.2 and 38.2 °C.
- Scanning down from `tcore` always returns the warm-skin root. A plain bisection over [20, 38.2] would converge to a spurious low-skin-temperature root if one existed (H and the heat loss both rise with tsk below ~31 °C). We did not observe such a case, but the downward scan removes the risk.
- Port tolerance: the TypeScript engine should match the fixture to ±0.05 W/m² (TWL) and ±0.001 K (tsk).
- Port check: an independent JavaScript transcription of §1.4–§1.5, written from this document alone, reproduced all 42 fixture vectors to ≤ 3×10⁻⁵ W/m² and ≤ 1×10⁻⁶ K. The residual comes from the 6-decimal rounding of the fixture inputs.

### 1.6 The printed sweat-efficiency equation: the one real ambiguity

The paper prints the zone-B expression as **`E = λSr·exp[−0.4127 × (1.8·λSr/Emax − 0.46)^1.168]`**, with the zone tests written on λSr/Emax. The PDF page image was checked, so this is not a text-extraction artefact.

**Read literally, it is self-inconsistent.**
- It gives efficiency 0.88 at x = 0.46 (it should be 1), and E = 0.48·Emax at x = 1.7, where it then jumps to Emax.
- It reproduces the paper's own Table I with rms error **≈ 46 W/m²** when solved with the §1.5 procedure (≈ 43 W/m² with a plain bisection on [20, 38.2]). The literal form is discontinuous, so the root depends on the search [corrected by fact-check].
- The paper's verbal description of Figure 3 says efficiency = 1 up to x = 0.46 and *"a fully wet skin (w = 1) only occurs when the actual sweat rate is about 170 percent (x-value = 1.7, y-value = 1/1.7 = 0.6)"*. Without the 1.8, the constants satisfy this almost exactly: exp[−0.4127·1.24^1.168] = **0.588264**, vs 1/1.7 = 0.588235, a difference of 2.8×10⁻⁵ [corrected by fact-check]. The constants were evidently fitted to that form.

There are two consistent readings:

| Variant | Zone-B formula | Table I (62 numeric cells) | Dry / windy Abu Dhabi | Status |
|---|---|---|---|---|
| **physical** (default) | `E = λSr·exp[−0.4127(x−0.46)^1.168]` with `x = λSr/Emax` | mean +0.03, rms 1.87, range −10.1 to +1.3 W/m². The 54 cells whose solution has x > 1.7 agree within 1.34. The 8 low-x cells (80 kPa block, WB 24–26) range from 0.4 above to 10.1 below the printed values. | Lower, conservative TWL | Continuous; matches the paper's text; consistent with UAE field data (below) |
| **alt_1p8** | `X = 1.8x` for the zone tests *and* the exponent; `E = 1.8·λSr·exp[−0.4127(X−0.46)^1.168]` | mean +0.69, rms 0.85, max abs 1.86 | Up to ~63 W/m² higher in the fixture vectors, e.g. 46 °C / 12 % RH / MRT 70 / 2 m/s: 206 vs 253; 47 °C / 10 % / MRT 70 / 3 m/s: 212 vs 275 | Reproduces Table I; may reflect the authors' VBA (sweat per person vs per m²) |

UAE field check, using the Calor HSM readings of Bates & Schneider 2008 (Table 3, May 2006, 4 time slots, mean inputs, 150 mm globe assumed):

| Time | Published mean TWL | Published range | physical | alt_1p8 |
|---|---|---|---|---|
| 08:00 | 237.7 | 179–284 | 256 | 277 |
| 12:00 | 194.8 | 151–225 | 210 | 248 |
| 14:00 | 189.3 | 122–240 | 225 | 280 |
| 16:00 | 230.6 | 187–279 | 286 | 337 |

- alt_1p8 at the mean inputs **exceeds the largest TWL observed in that time slot in 3 of 4 slots**. The physical variant stays within or just above the observed ranges.
- Means of a non-linear function are not the function of the means, so this is indicative only.
- **Recommendation:** implement `physical` (the safer and better-documented reading) and keep `alt_1p8` behind a flag for comparison with commercial meters. Both values are in every fixture vector (`twl_w_m2`, `twl_alt_1p8_w_m2`).
- The two variants differ only when the physical solution has x < 1.7, i.e. low humidity, high wind or both.

### 1.7 Helper choices (not specified by the paper)

**Globe → MRT, ISO 7726:1998 Annex B.**
- `tr = [(tg+273.15)^4 + hcg/(εσ)·(tg − ta)]^0.25 − 273.15`, with `hcg = max(1.4·(|tg−ta|/D)^0.25, 6.3·v^0.6/D^0.4)`, ε = 0.95 and σ = 5.67e-8.
- Verified to < 1e-6 °C against `pythermalcomfort.environment.mean_radiant_tmp(..., standard="ISO")`.
- **Pass the actual globe diameter `D`:**
  - 0.15 m for a standard globe
  - **0.0508 m for the Liljegren-model globe** (thermofeel/WBGT pipeline)
  - ~0.025 m only for a raw reading from an uncorrected 25 mm globe. The Kestrel 5400 has a 25 mm globe, but its displayed Tg is already *"converted to Tg equivalent for standard 6 in|150 mm globe"* (Kestrel 5400 data sheet and manual). Feed Kestrel output with D = 0.15 m, or MRT is double-corrected (82.6 °C instead of 67.1 °C in the example below) [corrected by fact-check].
- With the same 50 °C reading at 40 °C air and 1 m/s, a 150 mm globe gives MRT 67.1 °C (TWL 143) and a 25 mm globe gives 82.6 °C (TWL 98). See fixture `GLOBE-150MM` and `GLOBE-25MM`.

**Instrument globes:**
- The Calor HSM globe size used in the original studies is **UNVERIFIED** (searched; not published).
- Scarlet TWL-1S uses a 7.5 cm globe with a vendor correction **[V]**.

**Wet bulb.** If only RH or dew point is available, use `pa` directly. Compute psychrometric WB (by inverting eq. 1) only for the WB > 32 °C backstop.

### 1.8 Validation results

All values come from `scripts/oracles/twl_oracle.py` (physical variant unless noted).

**Brake & Bates 2002, Table I.**
- The table has 75 cells: 62 numeric and 13 "n/p" ("heat stress too extreme even for (continuous) light work. Permit required").
- There are three blocks:
  - A: MRT = DB+2, 0.2 m/s, 101 kPa, Icl 0.45 / icl 0.45
  - B: MRT = DB, 0.5 m/s, 115 kPa, 0.69 / 0.40
  - C: MRT = DB+3, 1.5 m/s, 80 kPa, 0.35 / 0.45
- alt_1p8: max abs error 1.86, mean +0.69, rms 0.85. 45/62 cells equal `floor(model)`, which suggests the printed values are truncated rather than rounded.
- physical: as above.
- Every n/p cell computes **< 99.73 W/m²** (maximum 99.7235) [corrected by fact-check], while the smallest printed number is 103. The n/p cut-off is therefore consistent with 100 W/m², but it is not stated.

Examples (worked examples from the text plus the AOH 2002 tables):

| Example (source) | Published | Oracle (physical) |
|---|---|---|
| 30 WB, 40 DB, 40 globe, 100 kPa, 0.2 m/s, Icl 0.35/icl 0.45 (B&B 2002 p.180) | 110 | **110.7** |
| Same, wind 0.7 m/s (p.181) | 158 | **158.3** |
| "typically 26 °C WB, 35 °C DB and globe, 0.5 m/s, 100 kPa" (App. 2) | ≈ 220 | **217.0** |
| AOH 2002 T2-B: hot dry (DB = MRT = WB+10), 28 WB, 3 m/s | 243 | 243.5 |
| AOH 2002 T2-D: hot humid (DB = MRT = WB+3), 28 WB, 3 m/s | 263 | 263.4 |
| AOH 2002 T2-A: hot dry, 0.2 m/s | 132 | 139.6 (+7.6) |
| AOH 2002 T2-C: hot humid, 0.2 m/s | 154 | 159.6 (+5.6) |

- AOH 2002 Table 1 ("max WB for 140 W/m²"): the model is 0.3–0.5 °C higher than published (27.97/32.36/29.37/33.17 vs 27.5/32.0/29.0/32.9).
- The low-wind AOH gap is not explained by pressure, posture factor or clothing. That paper was in press before the AEOH paper and may reflect an earlier model version (**UNVERIFIED**).

**Miller & Bates 2007 Table 2** (11 chamber sessions at 0.12 clo):
- The oracle is +4.6 to +7.7 W/m² higher (mean +6.8) when MRT = DB, P = 101.3 and icl = 0.45 are assumed.
- Globe, pressure and icl were not reported, so this is a loose check only.

**Sensitivity**, around DB 40, RH 40 %, MRT 65, 1 m/s (TWL 148):
- DB +1 °C → 134
- MRT +5 °C → 135
- wind 2 m/s → 181
- RH 50 % → 105

This is consistent with the paper's warning that *"relatively small errors in measuring the individual environmental parameters can generate errors up to 20 W/m² in the calculated limiting metabolic rate"*.

**Published examples exist.** The paper's Table I and worked examples are the gold standard here, and no other independent numerical TWL dataset with fully specified inputs was found.

### 1.9 Open implementations and instruments

- **None open-source** (checked 2026-11-09):
  - GitHub repository search for "thermal work limit", "thermal-work-limit", "TWL heat stress", "brake bates heat": 0 relevant hits
  - HeatStress R package ([anacv/HeatStress](https://github.com/anacv/HeatStress)): no TWL function (it has WBGT Liljegren/Bernard, HI, humidex, etc.)
  - pythermalcomfort 4.8.1 and thermofeel 2.3.0: no TWL
- The 2002 paper states that an *"interactive desktop version of the TWL model, developed in Microsoft Excel using Visual Basic for Applications, is available from the authors"*.
- Commercial implementations:
  - Calor Heat Stress Meter (used in all UAE studies)
  - **Kestrel 5400**: *"measure and calculate TWL using the algorithm developed by Derrick John Brake in … [his PhD thesis]"*. Presets: work clothes 0.50 clo / VPF 0.40; work clothes + coveralls 0.96 / 0.39 ([Kestrel TWL statement, 2024](https://cdn.shopify.com/s/files/1/0209/2718/files/5400_TWL_Statement.pdf) **[V]**)
  - Scarlet TWL-1S (marketed as endorsed by DOH/OSHAD **[V]**)
  - Columbia Weather Systems **[V]**
- The historic HAAD calculator (www.haad-safe.ae, cited by Miller et al. 2011; a HAAD webpage is cited by Ahmed et al. 2020) is defunct: the domain no longer resolves. The **Point Health calculator cited by Miller et al. 2011 is live** at https://www.pointhealth.com.au/TWL/ (folder dated 2026-04-17; "TWL provided by Aqualyte") [corrected by fact-check].
  - Its client-side source (`twl_class.js`, © 2021 Point Health, contact gbates@pointhealth.com.au, all rights reserved) is a different, EESAM-style formulation:
    - skin temperature set from metabolic rate, Ts = 36.45 − 0.004M − 0.00002M²
    - conductance 70 + 64·tanh(1.1(tΣ − 37.9))
    - sweat 0.74 + 0.74·tanh(1.19(tΣ − 37.5)) L/h, capped at 1.2 and floored at 0.6 L/h
    - no respiratory term
    - defaults icl 0.6, 0.35 clo, 101 kPa
    - no 4 m/s cap
  - It does share several of the oracle's choices:
    - zone-B efficiency exp[−0.4127(x − 0.46)^1.168] with no 1.8 factor in the exponent (the "physical" reading), after dividing the per-person sweat rate by 1.8 m²
    - pa = psat(WB) − 0.000644·P·(DB − WB) with P in kPa
    - the 0.73 posture factor applied to hr
    - TWL truncated with `parseInt`
    - zones on half-open intervals (< 115 / < 140 / < 220)
  - Its outputs were not computed here: running third-party code was blocked in this environment.
- ADOSH TG v4.0 §2.2(c) refers to an *"online Thermal Work Limit calculator available at:"* but **the URL is blank** in the July 2024 PDF.

### 1.10 Known limitations to surface in the product

- The model assumes self-paced, educated, hydrated, **acclimatized** workers. Unacclimatized workers are handled by zone rules (§2), not by the algorithm.
- Miller & Bates 2007: lack of acclimatization *"may reduce this [TWL] by up to 25%"*.
- **Independent validation is mixed.**
  - Kapanowski (2018, USF MSPH thesis [S]; 494 progressive-heat-stress trials) found *"At the threshold, the TWL had a 7% probability of being unsustainable compared to the threshold probability of 1% for the TLV and REL"*.
  - Bernard, Ashley & Kapanowski (2022, *Ann Work Expo Health* 66(8):1081–1085, doi:[10.1093/annweh/wxac029](https://doi.org/10.1093/annweh/wxac029)) report P(uncompensable) at the TWL limit of 0.14 (work clothes / particle barrier) and 0.22 (water / vapour barrier). This comes from the search-result abstract; the full text was not retrieved.
  - TWL is less conservative than WBGT/TLV. For a clinical-safety product, consider a margin or showing both.
- Not valid for encapsulating or impermeable clothing.

---

## 2. Abu Dhabi: ADOSH-SF (formerly OSHAD-SF) *Safety in the Heat*

### 2.1 Documents and versions (latest as of 2026-11-09)

| Document | Version | Date | URL |
|---|---|---|---|
| **ADOSH-SF CoP 11.0 – Safety in the Heat** | **4.0** | **15 July 2024** | [PDF](https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Codes-of-Practise/11---Safety-in-the-Heat-v31-English.pdf) **[P]** (the file name says "v31" but the content is Version 4.0) |
| **ADOSH-SF Technical Guideline – Safety in the Heat** | **4.0** | **15 July 2024** | [PDF](https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Technical-Guidelines/Safety-in-the-Heat--Eng.pdf) **[P]** (listed on [ADPHC Technical Guidelines](https://www.adphc.gov.ae/en/Legislation/Technical-Guidelines) as "V 4.0, 15 July 2024") |
| ADOSH-SF Mechanism 11.0 – Incident Notification, Investigation and Reporting | 4.0 | 15 July 2024 | [PDF](https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Mechanisms/11---Incident-Notification-Eng.pdf) **[P]** |
| ADPHC "Thermal Work Limit – Working Zones" bilingual sheet | n/d | — | [Ther-Bi.pdf](https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/Safety-in-Heat/Ther-Bi.pdf) **[P]** (identical wording to TG Table 1) |

- v4.0 amendment record: *"System acronym updated from OSHAD-SF to ADOSH-SF"*, *"Change from OSHAD to ADPHC"*, *"Change from HAAD to DOH"*, *"Minor editorial changes throughout the document without changing requirements."*
- Earlier versions (OSHAD-SF CoP/TG v3.0 2016, v3.1; EHS RI-CoP 11.0 ~2012) were **not retrieved**. The ADPHC site serves only v4.0, and third-party copies were blocked.

### 2.2 Scope and trigger (CoP 11.0 v4.0, verbatim)

- §1(a): applies to *"all employers within the Emirate of Abu Dhabi that have employees working in high temperature environments. High temperature environments includes both weather (working outside in summer months) and site operations (furnaces, ovens, and other high temperature operations)."*
- §1(b): if requirements conflict with another regulator, *"employers are required to follow the more stringent requirement."*
- **§3.1.1(e), the 35 °C trigger:** *"Any worksite that has, or it is reasonably foreseeable to have, a temperature at or above 35 degrees Celsius at any time during a work shift, shall implement an effective heat stress program, unless they can document through risk assessments and Thermal Work Limit (TWL) that there is no risk to employees."*
- §3.1.1(f): *"Employer shall implement a process for assessing the environmental conditions and comparing it to the TWL heat stress index and implementation of the requirements of the relevant work zone control measures"*.
- TG §2.1(a): *"The Thermal Work Limit (TWL), which has been validated for Gulf conditions, is the heat stress index that has been researched and adopted by within the Emirate of Abu Dhabi …"*
- TG §2.1(b): *"TWL is calculated from environmental parameters assuming that employees are well hydrated and acclimatized to the conditions and are self-paced."*
- **Measurement (TG §2.2(a)):** dry bulb (°C), wet bulb ("determined by the humidity/evaporation", °C), globe temperature ("determined by the radiant heat", °C), wind speed (m/s). Pressure is not listed.
- **Alternative indices:** none. CoP v4.0 and TG v4.0 name **only TWL**; WBGT is not mentioned (both full texts were searched). Whether earlier versions allowed WBGT is **UNVERIFIED**.

### 2.3 TWL zones: exact official table (TG v4.0 Table 1, read from the PDF page image)

Header: **"Thermal Work Limit – Working Zones. Control Interventions, Rest-Work and Rehydration Schedules"**

**Low Risk — Unrestricted Zone (printed as "TWL: 140 - 220 <")**
- Interventions: *"**No limits on self-paced work**ᵃ for educated, hydrated workers."*
- Rehydration schedule (per hr): *"Light Work 600 ml - 1 Litre / hr"*
- Work-rest schedule (minutes): *"Safe for **all** continuous **self-paced** workᵃ"*

**Medium Risk — Cautionary Zone (printed as "TWL: 115 – 140")**
- Interventions:
  - *"**Cautionary zone indicates situations in which environmental conditions require additional precautions.**"*
  - *"Practicable Engineering control measures to reduce heat stress should be implemented e.g. provide shade, improve ventilation etc."*
  - *"Working alone to be avoided"*
  - *"No unacclimatised person to workᵇ"*
  - *"Ensure adequate fluid intakes appropriate for type of work"*
- Light work: rehydration *"1 -1.2 Litres / hr"*; work-rest *"Safe for continuous self-paced light workᵃ"*
- Heavy work: rehydration *"> 1.2 Litres / hr \*"*; work-rest *"**Continuous paced work** 45 work - 15 rest"*

**High Risk Zone (printed as "TWL: < 115")**
- Interventions:
  - *"**Strict Work/Rest cycling required**"*
  - *"No person to work alone"*
  - *"No unacclimatised person to workᵇ"*
  - *"High Risk induction required emphasising hydration and identifying signs of heat strain"*
  - *"Provide personal water bottle (2 litre capacity) on-site at all times"*
- Rehydration: *"All Work >1.2 Litres / hr \*"*
- Work-rest: *"Light workᶜ 45 work – 15 rest"*; *"Heavy workᵈ 20 work - 40 rest"*

Notes (verbatim):
- ᵃ *"Self-paced work - workers must be allowed to adjust their work rate according to environmental conditions. Paced work is when the work rate is not under the worker's control"*
- ᵇ *"Unacclimatised workers are defined as new workers or those who have been off work for more than 14 days due to illness or on vacation leave (in a cool climate area)"*
- ᶜ *"Light work – sitting or standing, light arm work"*
- ᵈ *"Heavy work – carrying, climbing, lifting, pushing, whole-body work"*
- \* *"At high workloads and or thermal stress, sweat rates exceed 1.2 Litres / hr. Increasing fluid intake much above this level is not practical due to gastric discomfort as the upper limit for gastric emptying and fluid absorption is ~ 1.5 Litres / hr so control solutions to improve thermal conditions should be implemented in addition to providing adequate hydration to replace sweat lost."*

**Boundary values: sources disagree.**
- The official table prints shared endpoints (115 and 140) with no inclusivity. The low zone is printed "140 - 220 <", i.e. ≥ 140, merging the original "140–220" and ">220" bands.
- The original protocols use **four** zones:
  - Brake & Bates 2002 Table II: "<115 (or DB > 44°C or WB > 32°C) Withdrawal / 115 to 140 Buffer / 140 to 220 Acclimatization / >220 Unrestricted"
  - Miller & Bates 2007 Table 6: same numbers, "Restricted access … Buffer … Acclimatization … Unrestricted"
- 4cRisk / Burke & Hokins (QMIHSC 2013 [S]) and THORZT use integer bands: **"≥ 220 / 140 – 219 / 116 – 139 / ≤ 115"**. This puts exactly 115 in withdrawal, whereas ADOSH puts 115 in Medium.
- Sharjah's OSHJ-GL-15 (Sep 2021) uses "<115 / 115 to 140 / 140 to 220 / >220". GL-15 was superseded on 3 Jul 2024 by **OSHJ-CoP-33 Version 2 Rev 0**: the guideline became a code of practice, and its TWL table, including the typo below, is unchanged [corrected by fact-check]. It has **different schedules**: 1.5 / 1.2 / 1 / 0.5 L/h, and heavy work in the medium zone at "40 mins work, 20 mins rest". It also contains a typo: "Acclimatised employees not allowed to work" in the medium zone.
- A vendor table ([Scarlet Tech](https://legacy.scarlet-tech.com/download-file/research-articles/) [V], citing *"Working in Heat Procedures and Training Manual (Abu Dhabi Ministry of Labour, 2009)"*) gives the 4-zone variant with ">220: 0.6~1 Liter/hr".
- **Port decision:** half-open intervals, `HIGH: TWL < 115`, `MEDIUM: 115 ≤ TWL < 140`, `LOW: TWL ≥ 140`. Compare the unrounded value. This follows ADOSH's literal "< 115" and agrees with Burke at 140. Given ±20 W/m² measurement uncertainty, the 115.0 edge case is immaterial, but it is documented.

### 2.4 Original "backstop" rules (not in ADOSH v4.0)

- Brake & Bates 2002: *"Workers are also withdrawn (or subject to a permit system) whenever the dry bulb temperature exceeds 44°C, irrespective of the TWL"*. The reason given is that 44 °C *"is close to the skin temperature at which several authors have found exposed skin discomfort or burning to commence"*.
- Also: *"when the wet bulb temperature exceeds 32°C, irrespective of the TWL"*. The reason given is that *"relatively small errors in measuring the individual environmental parameters can generate errors up to 20 W/m²"*. The WB limit *"does not replace the TWL limit but adds a further 'backstop'"*.
- Recommendation: offer these as an optional, conservative overlay (`zone_with_bb2002_backstops` in the fixture).
- Abu Dhabi inland summer air temperatures often exceed 44 °C. Enabling this overlay will flag many hours HIGH that pure ADOSH would class lower. This is a product decision.

### 2.5 Heat stress program (CoP 11.0 v4.0 §3.2(b), verbatim summary)

Employers *"shall develop a worksite specific heat stress program that shall consist of, but not be limited to"* the following elements:

- (i) *"acclimatization program for new employees, employees that have been on vacation, and employees that are moving from a worksite that has climate control to a worksite that has high temperatures with an allowance of **5-7 days** for acclimatization before starting hard work in a hot environment"*
- (ii) *"process for assessing environmental conditions utilizing the Thermal Work Limit (TWL) to determine work/rest breaks and water consumption requirements"*
- (iii) *"system to communicate current environmental conditions to employees"*. Zill fits here.
- (iv) communication to employees, returnees and visitors
- (v) *"provision of appropriate amounts of potable drinking water close to the worksite and appropriate electrolyte replacement drinks … and implement **programmed drinking where appropriate every hour**"*
- (vi) *"appropriate clothing (e.g. lightweight, cotton, light-colored, loose-fitting - unless using machinery) and personal protective equipment including a large personal water container (of **at least one litre** in size). Shared drinking cups, water bottles, or other such devices are not allowed"*
- (vii) *"design and placement of shade and cooling shelters for employees working outside during summer months and appropriate cooled accommodation / shelter for the summer months during the midday break periods set by the Ministry of Labour"*
- (viii) schedule physical activity in the coolest part of the day
- (ix) pre-employment screening and medical clearance (CoP 5.0)
- (x) *"pre-job training (inductions) … and a **permit to work system** in extreme high temperature and humidity environments that includes the **TWL High Risk Zone**"*
- (xi) audit and inspection
- (xii) training
- (xiii) *"investigation and reporting of heat injuries and illness"* (Mechanism 11.0)

Other v4.0 clauses:
- §3.2(c) engineering controls: insulation, shaded work areas, *"cooled and air-conditioned rest areas with water or electrolyte drinks"*, exhaust ventilation, fans *"to increase airflow across the skin"*, cooled air
- §3.2(e) *"Employees shall not work alone in heat stress areas"* (CoP 30.0)
- §3.2(g) refillable containers *"taped with the date … cleaned and refilled daily"*
- §3.2(h) urine charts
- §3.2(i) *"a cooler area to rest during breaks"*
- §3.1.1(g) *"adhere to the UAE Ministry of Labour requirements for a midday break"*
- §3.1.1(h) meals with electrolytes and calories
- §3.1.1(i) educate on alcohol, tea, coffee and caffeinated drinks
- §3.1.1(k) *"allowance is made for self-pacing of work and appropriate rest breaks"*

### 2.6 Acclimatization (TG v4.0 §3 and §5.1)

TG table, "courtesy of the National Safety Council". Activity as % of full work assignment:

| Day | Experienced employee | New employee |
|---|---|---|
| 1 | 50 % | 20 % |
| 2 | 60 % | 40 % |
| 3 | 80 % | 60 % |
| 4 | 100 % | 80 % |
| 5 | 100 % | 100 % |

Re-acclimatization (days away → exposure sequence, % of full assignment):

| Absence (days) | Illness (days) | Sequence |
|---|---|---|
| < 4 | — | 100 % |
| 4–5 | 1–3 | R/E (reduced expectations), then 100 % |
| 6–12 | 4–5 | 80, 100 % |
| 12–20 | 6–8 | 60, 80, 100 % |
| > 20 | > 8 | 50, 60, 80, 100 % |

- TG §5.1: *"It takes over two weeks to become fully acclimatized; however adaptation is rapid in the first few days."*
- TG App. 1: *"Report non-acclimatization to supervisor (if you have been away from work for more than 14 days) and try to acclimatize for 5-7 days before starting hard work"*.
- Original protocol (B&B 2002): *"The acclimatization period lasts for the first 7 calendar days back at work after being away for more than 14 days."*

### 2.7 Water and hydration

- CoP §2(d)(ii): train on *"the importance of drinking water (**at least 2 litres every 2-3 hours**) and the addition of a little extra salt to meals"*.
- TG §5.2: *"as a guideline you should be drinking **4-6 liters of water per day** while in the Gulf region (2 liters every 2-3 hours)"*.
- TG §5.6: *"salt tablets are not permitted"*; *"a fluid with 4% or less sugar is recommended"*; electrolyte drink *"at every second drink (i.e. one for one with water)"*.
- TG App. 4 hydration testing (urine specific gravity):
  - Limits: *"At the start of the shift Not more than 1.015"*; *"Other times e.g. end of shift Not more than 1.029"*
  - Actions:
    - 1.000–1.015 normal
    - 1.016–1.020 and 1.021–1.029 alert: extra fluids, and for the higher band rehydrate *"every 15 to 20 minutes during the shift"*
    - **≥ 1.030 action**: *"Remove employee from hot workplace … Recheck SG in 4 hours"*
  - Failed test: *"DO NOT let them proceed to work station … Re-test after one hour and continue until correctly hydrated (SG<1.015)."*
- TG App. 3 protocol (flowchart):
  - *"Worked in withdrawal zone (<115) \*("Permit to work in heat" must be completed prior)"* → develop symptoms → dehydration test → Fail *"S.G ≥ 1.030"* (re-test before next shift) or Pass *"S.G. ≤ 1.025"* (return next shift)
  - Symptoms → call the emergency number → medical centre
  - Return-to-work: *"dehydration testing 1st 3 days back at work"*

### 2.8 First aid, emergency and reporting

- CoP §3.1.1(l): immediate access to medical attention per *"CoP 4.0 - First Aid and Medical Emergency Treatment"*; incidents reported per *"Element 7 - Monitoring, Investigation and Reporting"*.
- CoP §3.2(j): *"Ensure first aid or medical treatment is readily available …; ensure fellow employees and/or supervisors know how to call for additional emergency medical assistance … or has symptoms of heat stroke."*
- CoP §2(f): first aiders trained on heat illness types and treatment.
- TG §4 gives symptoms and first aid for heat rash, cramps, syncope, exhaustion and stroke. Heat stroke: *"Call emergency contact number and notify supervisor; Move the sick employee to a cool shaded area; Cool the employee … Soaking their clothes with water; Spraying, sponging, or showering them with water; and Fanning their body."*
- TG App. 6 checklist: *"Is there a first aid trained provider onsite (response within 3 minutes)?"*
- **Mechanism 11.0 v4.0 notification:** serious incidents go to the sector regulatory authority on Form G *"within: (i) 24 hrs. for fatalities; or (ii) 3 working days for other serious incidents"*. Heat illness is not named in Schedules A–C. Our interpretation: a heat case meeting Schedule B is notifiable, i.e. *"immediate medical treatment … as an in-patient in a hospital"*, *"loss of consciousness and/or requiring resuscitation"*, or unable to work the next shift.
- Record keeping (CoP §4): program activities, training, facilities, evaluations, *"records of heat stress related incidents"*.

### 2.9 ADPHC "Safety in Heat" programme

- Programme page: [ADPHC Safety in Heat](https://www.adphc.gov.ae/en/Public-Health-Programs/Injury-Prevention/Safety-in-Heat) **[P]**. It provides downloadable kits:
  - managers/supervisors guide and poster
  - worker leaflet and manual
  - heat-prevention tips
  - heat-illness flyer and poster
  - "Drink enough water"
  - dehydration guidance
  - the bilingual TWL sheet
  - roll-ups in Arabic, English, Urdu, Hindi, Bengali and Tagalog
- Contact: safetyinheat@adphc.gov.ae (on the TWL sheet).
- 2025 press release (Abu Dhabi Media Office, 21 Sep 2025 **[P]**):
  - 11th year
  - *"more than 9 million"* reached through *"22,164 awareness and inspection visits"*
  - 35 materials, 884,200 distributed
  - languages: Arabic, English, Urdu, Hindi, Tagalog, Bengali
- Origins: HAAD's Safety in the Heat programme was running by 2008–2009 (Joubert et al. 2011, §5: 465 companies, 814,996 heat-exposed workers, 6,254 sites reached). ADPHC counts the 2025 season as the programme's 11th year under its current form.
- **Public TWL / heat-index forecast service: none found.**
  - Checked: the ADPHC programme page, TG v4.0 (calculator URL blank), the 2025 press releases, and the historic haad.ae Safety-in-Heat pages (archived 2013; defunct).
  - *The National* (27 Jun 2011) planned to publish a daily TWL reading during the 2011 midday-break season [S].
  - Treat "no current public TWL forecast in Abu Dhabi" as a market gap. It is **UNVERIFIED** only to the extent that a non-indexed app could exist.

---

## 3. Federal UAE: MoHRE midday break

| Item | Rule | Source |
|---|---|---|
| Legal basis | **Ministerial Resolution No. 44 of 2022** on Occupational Health and Safety and Labour Accommodation. Shade obligation in **Article 11 of Administrative Decision No. 19 of 2023**. | The u.ae working-hours page [P] cites MR 44/2022 as the instrument banning direct outdoor work 12:30–15:00 from 15 June to 15 September. The same basis appears on the MoHRE midday-break page (seen via the search index only; mohre.gov.ae refused connections from this environment) and in Middle East Briefing, 19 Jun 2024 [S]. The article number inside MR 44/2022 is **UNVERIFIED** (u.ae and government.ae PDFs returned 404 or certificate errors). |
| Dates / hours | **15 June – 15 September** each year, **12:30–15:00**, daily | u.ae [P]; WAM via Sharjah24, 8 Jun 2026 [S] |
| Scope | Work *"under direct sunlight and in open areas will be prohibited daily from 12:30 pm until 3:00 pm"* (2026 wording) | WAM/Sharjah24 [S] |
| 2025 / 2026 | 2025: 21st year (Khaleej Times, 3 Jun 2025). 2026: 22nd year, *"effective from 15th June until 15th September 2026"* (WAM, 8 Jun 2026). Compliance *"exceeding 99%"*. | [S] |
| Exemptions (paraphrased from the WAM 2026 release) | (1) Work that must continue for technical reasons, e.g. asphalt laying and concrete pouring where interruption or postponement is not feasible.<br>(2) Work needed to prevent hazards or repair faults affecting the wider community (water supply, electricity, traffic movement, other essential services).<br>(3) Activities requiring permits from competent government authorities because of their impact on public life and traffic flow. | WAM 2026 [S]; same three categories in Khaleej Times 2025 and Middle East Briefing 2024 |
| Conditions for exempt work / employer duties | Shaded rest areas; cooling equipment such as fans; adequate (cold) drinking water; hydration supplements including salts and other locally approved products; adequate comfort facilities and first-aid equipment; parasols / sun shades | WAM 2026; Gulf News 14 Jun 2023 [S] (paraphrased) |
| Penalty | **AED 5,000 per worker, up to AED 50,000** when multiple workers are involved | Khaleej Times 3 Jun 2025; Middle East Briefing 2024 [S] (consistent across years; the statutory schedule itself was not retrieved) |
| Daily hours during the break period | *"The decision limits daily working hours to eight"*; extra hours are overtime | Gulf News 14 Jun 2023 [S] (a 2026 restatement was not found) |
| General labour law | Normal hours **8 h/day or 48 h/week** (Federal Decree-Law 33/2021, Art. 17); overtime ≤ **2 h/day**; break entitlement *"if he works five consecutive hours"*, breaks *"not … less than one hour"*; Ramadan −2 h/day | u.ae working-hours page [P] |
| Reporting | MoHRE call centre **600590000**, website, app | WAM 2026 [S] |

ADOSH CoP 11.0 requires Abu Dhabi employers to follow the midday break (§3.1.1(g)) and to provide cooled shelter during it (§3.2(b)(vii)).

---

## 4. Regional comparators

| Country | Instrument | Period | Hours | Extra rule / penalty | Source |
|---|---|---|---|---|---|
| **Qatar** | Ministerial Decision **No. 17 of 2021** | **1 June – 15 September** | **10:00–15:30** | **Art. 4(9): "stop the work in workplaces where the WBGT index rises beyond 32.1 °C"**, at any time.<br>Annual free health checks; risk assessment with workers; training by May; cool water; shaded rest; light clothing.<br>**Art. 6:** workers *"have the right to stop working"* if heat threatens health, without dismissal.<br>Art. 7: workplace closure; Art. 8: oil & gas excluded. | [ILO unofficial translation](https://www.ilo.org/sites/default/files/wcmsp5/groups/public/%40arabstates/%40ro-beirut/documents/legaldocument/wcms_794551.pdf) [P]; [ILO news 27 May 2021](https://www.ilo.org/resource/news/new-legislation-qatar-provides-greater-protection-workers-heat-stress) |
| **Saudi Arabia** | MHRSD with the National Council for OSH (annual) | 15 June – 15 September (2025 & 2026) | 12:00–15:00 | Older reports: SAR 3,000–10,000 per violation, multiplied by workers; up to 30-day closure (**not confirmed for 2026**). Hotline 19911. | ARY News 15 Jun 2026; Al Riyadh Daily (SPA text) [S]; Gulf News / Middle East Eye (fines, older) [S] |
| **Kuwait** | PAM, Ministerial Resolution **No. 3 of 2026** | 1 June – 31 August | 11:00–16:00 | Exemptions need prior approval of Labour Inspection. Older reports: KD 100 per worker on repeat violation. | Arab Times 20 May 2026 [S]; Gulf News (older) [S] |
| **Oman** | Labour Law Art. 16; MoL Decision **286/2008** | June–August | 12:30–15:30 | RO 500–1,000; licence annulment on repeat. Hotline 80077000. | Oman Observer 31 May 2026 [S] |
| **Bahrain** | New MoL decision 2026 (reported as Decision (5) of 2026), repealing Ministerial Decision **No. 3 of 2013** | **15 June – 31 August** | 12:00–16:00 | Labour Law (Law 36/2012) penalties. Exemptions: oil & gas, utilities, security / rescue, emergency maintenance (with notice). 99.98 % compliance 2026. | DLA Piper 15 May 2026; GDN / News of Bahrain [S] |
| UAE – Sharjah (emirate code of practice) | SPSA **OSHJ-CoP-33 v2 Rev 0 (3 Jul 2024)**, which replaced OSHJ-GL-15 v1 (Sep 2021) [corrected by fact-check] | follows MoHRE | follows MoHRE | 4-zone TWL table with different water and work-rest values (§2.3) | [CoP-33 PDF](https://mc.spsa.shj.ae/Media/documents/j3comnEiUeCQ3emVuS2OQ_Safety%20in%20Heat%20OSHJ-COP-33.pdf); [GL-15 PDF](https://mc.spsa.shj.ae/media/documents/81dU0d270WoEGwprenKA_OSHJ-GL-15%20Safety%20in%20Heat%20Version%201%20English.pdf) [P] |

A 2026 scoping review notes that the calendar-based midday ban *"is found only in Gulf countries"* (Buqammaz et al., *Curr Environ Health Rep* 2026, doi:[10.1007/s40572-026-00525-x](https://doi.org/10.1007/s40572-026-00525-x)) [S].

---

## 5. Occupational heat illness data: Abu Dhabi / UAE

- **Shanks & Papworth 2001** (*Occup Med*, PMID 11235827) [P]: *"Three hundred and forty-five labourers presented to the Accident and Emergency Hospital in Abu Dhabi with heatstroke during a 3 month summer period."* There was no significant predictive association with daily maximum temperature or humidity.
- **HAAD figures** reported in *The National* (27 May 2011) [S]:
  - 3,017 heat-related illnesses were reported in Abu Dhabi in 2010; Joubert (HAAD) said most were work-related.
  - On TWL monitoring: *"We've rarely reached the withdrawal zone here"*; conditions were mostly in the buffer zone.
  - Draft high-risk rules at the time: 600 mL every half-hour; 20 min work / 40 min rest.
- *The National* (27 Jun 2011) [S]: 817 heat-exhaustion cases in 2010 vs 763 in 2009 (attribution unclear); Rashid Hospital (Dubai) treated 23 cases between 21 May and 26 June 2011.
- **Joubert, Thomsen, Harrison 2011** (HAAD; *Am J Public Health* 101(3):395–398; doi:[10.2105/AJPH.2009.189563](https://doi.org/10.2105/AJPH.2009.189563); PMC3036673) [P]:
  - Programme reach: 465 companies, 814,996 heat-exposed workers, 6,254 work and labour-residence sites.
  - Over 2008–2009 at two companies: *"one of which reported a combined 79.5% decrease in cases (15.3 vs 1.16 cases per 1000 workers) while the other experienced a 50% reduction in serious cases (0.08–0.04 cases per 100 000 work hours)."*
- **HAAD/UAEU-commissioned TWL field research (Curtin University):**
  - **Bates & Schneider 2008** (*J Occup Med Toxicol* 3:21, open access) [P]: UAE construction, May 2006, 22 workers, Calor HSM.
    - TWL by time of day: 237.7 / 194.8 / 189.3 / 230.6 W/m² (08/12/14/16 h); lowest ≈ 120 W/m² at DB > 50 °C.
    - No physiological strain; WBGT "consistently exceeded 27.5 °C". The authors concluded WBGT is *"inappropriate for use in Gulf conditions, however TWL was found to be a valuable tool"*.
  - **Bates, Miller, Joubert 2010** (*Ann Occup Hyg* 54(2):137–143) [P]: four UAE sites — two construction sites (July–August), a dockyard (September) and an aluminium smelter (December). Hypohydration (Usg ≥ 1.026) in ~**31 %** and **27 %** of samples at the two construction sites, and 15 % and 14 % at the industrial sites. Hydration did not change much over the shift.
  - **Miller, Bates, Schneider, Thomsen 2011** (*Ann Occup Hyg* 55(5):548–555) [P]: 150 workers, Abu Dhabi and Dubai, 2007–2008.
    - Mean TWL at each time of day *"all fell between 140 and 200 W m⁻²"*, with days below 140 and occasionally below 115.
    - Working heart rate 88–102 bpm; >92 % (AM) and >88 % (PM) self-regulated below ~110 bpm. This is evidence of self-pacing.
    - Winter TWL > 300.
  - The "ICOH 2012" HAAD paper named in the brief was **not located** (searched ICOH 2012 Cancún abstracts via web search, Europe PMC and PubMed; **UNVERIFIED**). The closest item: Joubert, "Health Authority Abu Dhabi Safety in the Heat Programme – From Research to Implementation and Beyond", GCC OHS Conference, January 2010 (ResearchGate listing only).
- **Ahmed et al. 2020** (*Ind Health* 58(2):170–181; PMC7118060) [P]: one UAE construction site, 200 workers, measured 12:00–15:00.
  - TWL 117–163 (location A), 168–292 (B), 176–226 (C) W/m², via a "TWL calculator".
  - Caveat: the authors used **natural** wet bulb (HS-32 monitor), which is not TWL's input.
- **Recent and other:**
  - Al Hurini et al. 2024 (*Cureus*, PMC11688620) [P]: self-report survey of 397 UAE adults; 86.4 % reported heat exhaustion. These are self-reported symptoms, not clinical diagnoses.
  - Case report of heat exhaustion mimicking STEMI (*Cureus* 2022).
  - Gomes et al. 2002 (*Occup Med*): Dubai foundry heat and noise.
  - Teyton et al. 2025 (*GeoHealth*, PMC12207249) [S]: only **1** of 12 Arabian-Peninsula heat-health epidemiology studies (2010–2024) included the UAE. Systematic, current UAE occupational heat-illness surveillance data are **not publicly available** (searched PubMed and Europe PMC).

---

## 6. Port-ready rules

### 6.1 TWL computation (engine contract)

```
INPUT  tdb[°C], humidity{twb_psychrometric[°C] | rh[%] | pa[kPa]}, mrt[°C] (or tg[°C] + globe_d[m]),
       wind[m/s], p[kPa], icl=0.35, icl_perm=0.45, tcore=38.2, sr_max=0.67, variant="physical"
PRE    v = clamp(wind, 0.2, 4.0); pa from humidity (Tetens psat; A = 0.000644; P in kPa)
       if tg given: mrt = ISO7726(tg, tdb, wind, D=globe_d, eps=0.95)   // D=0.0508 for Liljegren globe
CORE   §1.4 eqs 2–15, solver §1.5
OUTPUT twl[W/m2] (0 if NO_ROOT_NET_HEAT_GAIN), tsk, sweat L/h (=Sr·1.8), flags[], zone
TEST   fixtures/twl.json → |Δtwl| ≤ 0.05 W/m2, |Δtsk| ≤ 0.001 K for every vector (variant physical);
       twl_alt_1p8_w_m2 for the flag-gated alternative
```

### 6.2 Zones and controls (ADOSH-SF TG v4.0 Table 1; classify on the unrounded TWL)

| Zone | Condition | Must show | Water (per hr) | Work-rest |
|---|---|---|---|---|
| **HIGH** | `twl < 115` | "Strict work/rest cycling required"; no lone work; **no unacclimatised workers**; High Risk induction; **2 L personal bottle on site**; **permit to work** (CoP 3.2(b)(x); TG App. 3 "Permit to work in heat") | all work **> 1.2 L/h** | light **45 work / 15 rest**; heavy **20 work / 40 rest** |
| **MEDIUM** | `115 ≤ twl < 140` | Additional precautions; engineering controls (shade, ventilation); avoid lone work; **no unacclimatised workers**; adequate fluids | light **1–1.2 L/h**; heavy **> 1.2 L/h** | light: continuous self-paced; heavy: **45 work / 15 rest** ("continuous paced work") |
| **LOW** | `twl ≥ 140` | "No limits on self-paced work for educated, hydrated workers" | light work **0.6–1 L/h** (only row printed) | "safe for all continuous self-paced work" |

LOW sub-band (informational, original protocol):
- `140 ≤ twl < 220`: "Acclimatization" zone. *"Workers with uncertain acclimatization status should not work alone in this zone"* (M&B 2007).
- `twl ≥ 220`: "Unrestricted".

Optional backstop overlay (B&B 2002; M&B 2007; not ADOSH): `tdb > 44 °C OR twb_psychrometric > 32 °C → HIGH`.

Unacclimatised means *"new workers or those who have been off work for more than 14 days due to illness or on vacation leave (in a cool climate area)"*.
- Acclimatization allowance: **5–7 days** (CoP).
- Ramp per the TG table: new 20/40/60/80/100 %; experienced 50/60/80/100/100 %.

Always-on messages:
- *"at least 2 litres every 2-3 hours"*; 4–6 L/day
- personal container ≥ 1 L (2 L in High)
- no shared cups
- programmed drinking hourly
- no lone work in heat stress areas
- 1.5 L/h is the practical ceiling for fluid absorption. Beyond that, improve conditions.

### 6.3 Calendar (Asia/Dubai, UTC+4, no DST)

| Rule | Window | Applies |
|---|---|---|
| UAE midday break (MR 44/2022) | **Jun 15 – Sep 15 inclusive, 12:30 ≤ t < 15:00**, every day | Outdoor work under direct sun / open places prohibited, except listed exemptions (technical asphalt/concrete; emergency utility/traffic repairs; permit-required works) with shade, cooling, cold water, salts/electrolytes and first aid |
| ADOSH heat-stress-program trigger | any shift where air temperature ≥ **35 °C** is reasonably foreseeable | Heat stress program + TWL assessment (CoP 3.1.1(e)) |
| ADOSH training | within **10 days** of starting employment **and** before the summer months | CoP 2(d) |
| ADOSH awareness | "throughout the summer months, as defined by Ministry of Labour Decree's" | Use the Jun 15 – Sep 15 window |
| Hydration test limits | start of shift SG ≤ 1.015; other times ≤ 1.029; ≥ 1.030 remove and recheck in 4 h | TG App. 4 |
| Incident notification (Mechanism 11.0) | fatality **24 h**; other serious incidents **3 working days** (Form G) | Serious heat illness (in-patient, loss of consciousness, cannot work next shift) |
| Regional | Qatar Jun 1–Sep 15 10:00–15:30 **plus WBGT > 32.1 °C stop at any time**; KSA Jun 15–Sep 15 12:00–15:00; Kuwait Jun 1–Aug 31 11:00–16:00; Oman Jun 1–Aug 31 12:30–15:30; Bahrain Jun 15–Aug 31 12:00–16:00 (2026) | For multi-country users |

---

## 7. Sources (all accessed 2026-11-09)

Primary:
- Brake & Bates 2002 AEOH ([doi](https://doi.org/10.1080/104732202753438261); text via [Scarlet Tech library](https://legacy.scarlet-tech.com/download-file/research-articles/))
- Brake & Bates 2002 AOH ([doi](https://doi.org/10.1093/annhyg/mef030))
- Miller & Bates 2007 ([doi](https://doi.org/10.1093/annhyg/mem035))
- Bates & Schneider 2008 ([doi](https://doi.org/10.1186/1745-6673-3-21))
- Bates, Miller & Joubert 2010 ([doi](https://doi.org/10.1093/annhyg/mep076))
- Miller et al. 2011 ([doi](https://doi.org/10.1093/annhyg/mer012))
- Joubert et al. 2011 ([doi](https://doi.org/10.2105/AJPH.2009.189563))
- Shanks & Papworth 2001 (PMID 11235827)
- Ahmed et al. 2020 ([PMC7118060](https://pmc.ncbi.nlm.nih.gov/articles/PMC7118060/))
- ADOSH-SF CoP 11.0 v4.0, TG v4.0, Mechanism 11.0 v4.0 and the ADPHC TWL sheet (URLs in §2.1)
- Abu Dhabi Media Office 21 Sep 2025 ([link](https://www.mediaoffice.abudhabi/en/health/abu-dhabi-public-health-centre-celebrates-11-years-of-safeguarding-workers-during-summer-season-through-safety-in-heat-programme/))
- u.ae working hours ([link](https://u.ae/en/information-and-services/jobs/sector-of-employment/employment-in-the-private-sector/working-hours))
- Qatar MD 17/2021 (ILO unofficial translation, link in §4)
- Sharjah OSHJ-GL-15 (link in §4)

Secondary:
- WAM via Sharjah24, 8 Jun 2026 ([link](https://sharjah24.ae/en/Articles/2026/06/08/KMR16))
- Khaleej Times, 3 Jun 2025 ([link](https://www.khaleejtimes.com/uae/uae-midday-break-2025-june-15-to-september-15))
- Gulf News, 14 Jun 2023 ([link](https://gulfnews.com/uae/uae-3-month-midday-break-for-workers-begins-june-15-1.96393725))
- Gulf News 2026, 22nd year ([link](https://gulfnews.com/uae/government/midday-outdoor-work-ban-returns-across-uae-for-22nd-year-1.500567381))
- Middle East Briefing, 19 Jun 2024 ([link](https://middleeastbriefing.com/news/uae-midday-break-for-open-air-workers-begins-june-15-employer-obligations))
- Arab Times, 20 May 2026 ([link](https://www.arabtimesonline.com/news/kuwait-bans-outdoor-work-during-peak-summer-hours-from-june-to-august/))
- Oman Observer, 31 May 2026 ([link](https://www.omanobserver.om/article/1190457/oman/mol-announces-mid-day-break-as-temperatures-rise-near-to-50c))
- DLA Piper, Bahrain 15 May 2026 ([link](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/minister-issues-new-summer-midday-outdoor-work-ban-in-bahrain))
- DLA Piper, Saudi 18 Jun 2026 ([link](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/saudi-arabia-enforces-seasonal-midday-work-ban-to-protect-workers))
- ARY News, Saudi 2026 ([link](https://arynews.tv/saudi-arabia-announces-duration-of-mid-day-work-ban))
- *The National*, 27 May 2011 ([link](https://www.thenationalnews.com/uae/officials-to-set-legal-limit-for-working-in-the-heat-1.593060)) and 27 Jun 2011 ([link](https://www.thenationalnews.com/uae/health/thermal-work-limit-a-real-measure-of-stress-1.424865))
- Kapanowski 2018 thesis ([USF](https://digitalcommons.usf.edu/etd/7533/))
- Bernard, Ashley & Kapanowski 2022 ([doi](https://doi.org/10.1093/annweh/wxac029))
- Burke & Hokins 2013 ([QMIHSC](https://www.qmihsconference.org.au/wp-content/uploads/qmihsc-2013-concurrent-burke_hokins.pdf))
- Teyton et al. 2025 ([doi](https://doi.org/10.1029/2024GH001277))
- Buqammaz et al. 2026 ([doi](https://doi.org/10.1007/s40572-026-00525-x))
- [Wikipedia: Thermal work limit](https://en.wikipedia.org/wiki/Thermal_work_limit)

Vendor:
- Kestrel 5400 TWL statement ([PDF](https://cdn.shopify.com/s/files/1/0209/2718/files/5400_TWL_Statement.pdf))
- Scarlet Tech "Heat Stress and TWL" (in the Scarlet library above)
- Columbia Weather "Thermal Work Limit" ([PDF](https://columbiaweather.com/resources/thermal-work-limit.pdf))

## 8. UNVERIFIED / open items

1. Psychrometric coefficient and saturation formula used by the TWL authors: not stated. A = 0.000644 with Tetens was chosen by best fit to Table I.
2. Globe diameter and globe→MRT method of the Calor HSM used in the UAE studies: not published.
3. Cause of the 5.6–7.6 W/m² gap at 0.2 m/s in Brake & Bates 2002 AOH Table 2, and of the ~+7 W/m² gap in the Miller & Bates 2007 chamber values.
4. Article number of the midday-break provision inside MR 44/2022 (the u.ae and government.ae PDFs returned 404 or certificate errors; mohre.gov.ae refused connections).
5. 2026 confirmation of the AED 5,000 / 50,000 fines and the 8-hour cap (the latest explicit statements found are from 2025 and 2023 respectively).
6. Saudi and Kuwaiti fine amounts for 2026.
7. Earlier OSHAD-SF CoP/TG versions (v3.x) and whether they allowed WBGT. The ICOH 2012 HAAD TWL paper.
8. Any non-indexed public TWL forecast or app in Abu Dhabi.

---

## Independent verification (fact-check)

*Independent fact-check, 2026-11-09.*

**What was checked**
- Every numeric threshold, equation, table value, date, penalty and regulatory requirement above was checked against sources located independently of this note's citations.
- Regulator and agency documents:
  - the ADPHC listing pages and PDFs (CoP 11.0, TG, Mechanism 11.0, the bilingual TWL sheet)
  - the u.ae working-hours page
  - the ILO translation of Qatar MD 17/2021
  - Sharjah SPSA PDFs
  - the WAM text (via Sharjah24)
- Papers:
  - Brake & Bates 2002 AEOH, full text, with equations and Table I read from the rendered page images
  - Brake & Bates 2002 AOH (scanned pages)
  - Miller & Bates 2007; Bates & Schneider 2008; Bates, Miller & Joubert 2010; Miller et al. 2011
  - Kapanowski 2018 (thesis); PubMed and PMC abstracts; Crossref
- Vendor documents: Kestrel and Scarlet.

**Computational checks**
- The oracle was re-run.
- A separate JavaScript implementation was written from Appendix 1. It recomputes pa and MRT from raw inputs and uses its own root search (0.01 K scan + bisection to 1e-12 K). It reproduced every fixture vector and statistic listed in the table below.
- Three fixture vectors were evaluated term by term ("by hand").
- The literal-reading, posture-factor and saturation-formula alternatives were re-run.

**Verdicts**

| Verdict | Count |
|---|---|
| Claims checked | 119 |
| CONFIRMED | 106 |
| CORRECTED | 8 (fixed inline, marked "[corrected by fact-check]") |
| UNVERIFIABLE | 5 |

[S] means confirmed only by a reputable secondary source; [V] means vendor material.

| # | Claim (section) | Verdict | Source URL | Note |
|---|---|---|---|---|
| A1 | TWL definition: limiting sustainable metabolic rate of euhydrated, acclimatized workers; core < 38.20 °C; sweat < 1.2 kg/h; self-paced design (§1.1) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | Abstract verbatim (full text: Scarlet-library copy, Curtin stamp 18 Mar 2008). |
| A2 | Self-paced worker definition quote (§1.1) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | Verbatim; the sentence continues "…and the importance of self-pacing". |
| A3 | Citations AEOH 17(3):176–186; AOH 46(2):165–174; Ann Occup Hyg 51(6):553–561 (§1.1) | CONFIRMED | https://pubmed.ncbi.nlm.nih.gov/11871754/ | PMIDs 11871754, 12074026, 17878259. |
| A4 | AOH 2002: TWL "using 0.35 clo, 0.45 vapour permeation ratio and a 0.73 posture factor" (§1.1) | CONFIRMED | https://doi.org/10.1093/annhyg/mef030 | Scanned p.167. |
| A5 | M&B 2007 quotes: "five environmental parameters…", "core temperature to reach a maximum of 38.2°C", acclimatization "may reduce this by up to 25%" (§1.1, §1.10) | CONFIRMED | https://doi.org/10.1093/annhyg/mem035 | pp.554–555. |
| A6 | tcore 38.2 °C "adjustable"; Srmax 0.67 kg m⁻² h⁻¹ = 1.2 L/h; standard person 70 kg, 1.8 m² (§1.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | pp.178, 183; 0.67 × 1.8 = 1.206 L/h. |
| A7 | λ = 2430 kJ/kg at 30 °C [ASHRAE Eq. 14], so λSr = 675·Sr (§1.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.185; 2430×1000/3600 = 675. |
| A8 | fr 0.73 (standing), LR 16.5, W = 0, fully wet skin as the limit, steady state (§1.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | pp.183–184, verbatim. |
| A9 | Valid range 60–380 W/m²; invalid if the ambient dew point is above skin/clothing temperature; invalid for impermeable/encapsulating clothing (§1.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.180, verbatim. |
| A10 | Signal range 36–39.5 °C, i.e. tsk 16.2–51.2 °C at tcore 38.2 (§1.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.178; (36−34.38)/0.1 = 16.2, (39.5−34.38)/0.1 = 51.2. |
| A11 | B = 0.0014M(34−ta) + 0.0173M(5.87−pa) [ASHRAE 26], hence TWL = H/(1 − …) (§1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.183; algebra checked. |
| A12 | R = hr·fr(tsk−tr) [EESAM 8]; hr = 4.61[1+(tr+tsk)/546]³ [EESAM 9]; hc = 0.608P^0.6V^0.6 [EESAM 13]; wind min 0.2 and max 4 m/s quotes (§1.2, §1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.183, verbatim. |
| A13 | Paper prints h = hr + hc (and toper without fr); the C+R identity needs fr·hr; without fr, block-A mean error ≈ −1.5 W/m² (§1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.184. Independent run: block-A mean +0.52 with fr, −1.45 without. |
| A14 | fcl = 1+0.3Icl; Rcl = 0.155Icl; Fcle = fcl/(1+fcl·h·Rcl); C+R = Fcle·h(tsk−to) (§1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.184. The paper cites Rcl as ASHRAE Eq. 41 and C+R as Table III, so the bracket "[ASHRAE eq. 47; Table II]" is incomplete; the formulas are right. |
| A15 | he = 1587·hc·P/(P−pa)² ≈ 16.5hc; Recl = Rcl/(LR·icl) with icl "cannot exceed 1.0"; Fpcl; Emax at w = 1 (§1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.184, verbatim. |
| A16 | H = Kcs(tcore−tsk); tΣ = 0.1tsk+0.9tcore; Kcs = 84+72tanh[1.3(tΣ−37.9)]; Sr = 0.42+0.44tanh[1.16(tΣ−37.4)] (§1.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | pp.184–185, verbatim. |
| A17 | Printed zone-B equation E = λSr·exp[−0.4127(1.8λSr/Emax − 0.46)^1.168], with zone tests on λSr/Emax (§1.6) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | Checked on the rendered page image (p.185). |
| A18 | Literal reading gives efficiency 0.88 at x = 0.46 and E = 0.48·Emax at x = 1.7 (§1.6) | CONFIRMED | (computed) | 0.8795 and 0.4823. |
| A19 | Literal reading fits Table I with rms 43 W/m² (§1.6) | CORRECTED | (computed; inputs from https://doi.org/10.1080/104732202753438261) | 46.2 W/m² with the note's own §1.5 solver at any scan step; 42.9 only with a plain bisection on [20, 38.2]. The literal form is discontinuous. Fixed inline and in the oracle docstring. |
| A20 | Figure 3 text: w = 1 at x = 1.7 ("y-value = 1/1.7 = 0.6"); dripping starts at x = 0.46 (§1.6) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.179, verbatim. |
| A21 | exp[−0.4127·1.24^1.168] = 0.58826 = 1/1.7 "to 5 decimals" (§1.6) | CORRECTED | (computed) | 0.588264 vs 0.588235 (difference 2.8×10⁻⁵). The conclusion (constants fitted to the form without 1.8) stands. Fixed inline and in the oracle docstring. |
| A22 | H = Esk, M = H + B, TWL = M; "unique mean skin temperature… solved by iteration"; Excel/VBA version "available from the authors" (§1.4, §1.5, §1.9) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | pp.185–186, verbatim. |
| A23 | Table I: 75 cells (62 numeric, 13 n/p); block parameters A/B/C; every value in the oracle's `TABLE_I`; n/p definition (§1.8) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.181, compared cell by cell. |
| A24 | Physical variant: mean +0.03, rms 1.87, range −10.1 to +1.3; 54 cells with x > 1.7 within 1.34; 8 low-x cells (80 kPa, WB 24–26) from +0.4 to −10.1 (§0, §1.6) | CONFIRMED | (computed) | Independent JS: 0.0277 / 1.8706 / −10.103 to +1.336; same 8 cells. |
| A25 | alt_1p8: mean +0.69, rms 0.85, max abs 1.86; 45/62 floor matches (§1.6, §1.8) | CONFIRMED | (computed) | 0.6906 / 0.8472 / 1.8614; 45 floor and 25 round matches. |
| A26 | Every n/p cell computes < 99.72 W/m² (§1.8) | CORRECTED | (computed) | The maximum is 99.7235 (block A, DB 40, WB 30), so the bound is < 99.73. Fixed inline. |
| A27 | Smallest printed Table I value is 103 (§1.8) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | Block A, DB 38, WB 30. |
| A28 | Worked examples: 110 W/m² (40 DB, 30 WB, 40 globe, 100 kPa, 0.2 m/s, 0.35/0.45) and 158 at 0.7 m/s; oracle 110.7 / 158.3 (§1.8) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | pp.180–181; JS 110.71 / 158.26. |
| A29 | App. 2 "typically 26 °C WB, 35 °C DB and globe, 0.5 m/s … 100 kPa" ≈ 220; oracle 217.0 (§1.8) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.186; JS 216.99. The paper equates this condition to 28.7 °C WBGT. |
| A30 | AOH Table 2: 132/243/154/263 at 28 WB (hot dry DB = MRT = WB+10; hot humid +3); oracle 139.6/243.5/159.6/263.4 (§1.8) | CONFIRMED | https://doi.org/10.1093/annhyg/mef030 | p.171; JS identical. AOH Fig. 3 states 100 kPa, which supports the P = 100 assumption. |
| A31 | AOH Table 1 (max WB at 140 W/m²): 27.5/32.0/29.0/32.9; model 27.97/32.36/29.37/33.17 (§1.8) | CONFIRMED | https://doi.org/10.1093/annhyg/mef030 | p.171; gaps 0.27–0.47 °C. |
| A32 | M&B 2007 Table 2 (11 sessions, 0.12 clo); oracle +4.6 to +7.7 (mean +6.8) (§1.8) | CONFIRMED | https://doi.org/10.1093/annhyg/mem035 | All 11 rows match; JS +4.64 to +7.71, mean +6.76. |
| A33 | Chamber "38–40 °C, WB 28 °C (45 % RH)" is consistent with psychrometric WB (§1.2) | CONFIRMED | https://doi.org/10.1093/annhyg/mem035 | Psychrometric RH at WB 28: 47.2 / 43.8 / 40.6 % at 38 / 39 / 40 °C. |
| A34 | Kapanowski 2018: "psychrometric wet bulb (Tpwb)"; 494 trials; "7% probability … 1% for the TLV and REL" (§1.2, §1.10) | CONFIRMED | https://digitalcommons.usf.edu/etd/7533/ | 190+119+91+94 = 494 (thesis pp.9–10, CDC Stacks copy). The 2022 paper uses 480 trials. |
| A35 | Kapanowski Table I: woven clothing 0.61 clo, 0.38 (fixture `CLO-WOVEN-0.61-0.38`) | CONFIRMED | https://digitalcommons.usf.edu/etd/7533/ | The 0.38 is labelled "Permeability Index (im)"; using it as icl is an approximation. |
| A36 | Bernard, Ashley & Kapanowski 2022, 66(8):1081–1085: P(uncompensable) at the TWL limit 0.14 and 0.22 (§1.10) | CONFIRMED | https://pubmed.ncbi.nlm.nih.gov/35488373/ | Abstract verbatim; the WBGT-based limits give 0.01. |
| A37 | TWL humidity input is psychrometric WB, not natural WB (§0, §1.2) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | Further primary evidence: p.180 derives WB with "standard psychrometric equations". |
| A38 | Kestrel 5400 computes WB from RH (§1.2) | CONFIRMED [V] | https://www.instrumentchoice.com.au/cdn/shop/files/Kestrel_5400_Data_Sheet_1.pdf | Data sheet: "Wet Bulb Temperature – Psychrometric", inputs temperature, RH and pressure. |
| A39 | Calor HSM measures RH and computes WB (§1.2) | UNVERIFIABLE | https://doi.org/10.1186/1745-6673-3-21 | No Calor specification found. Bates & Schneider say the HSM "determine[d] wet (WB) and dry bulb" and that RH was calculated. |
| A40 | A = 0.000644 with Tetens 0.6105 fits Table I better than Hyland–Wexler or Buck (§1.3, §8) | CONFIRMED | (computed) | alt_1p8 rms 0.847 (Tetens) vs 1.028 (Buck), 1.040 (H–W), 1.674 (A = 0.000662). Point Health's code also uses 0.000644·P (kPa). |
| A41 | H(tsk) peaks at ≈ 346 W/m² near tsk ≈ 31 °C (§1.5) | CORRECTED | (computed) | The peak is 347.3 W/m² at tsk 31.32 °C. Fixed inline. |
| A42 | In hot cases tsk* lies between 33.2 and 38.2 °C (§1.5) | CONFIRMED | (computed) | Fixture 35.20–37.65 °C; Table I + text examples 34.86–37.56 °C. |
| A43 | The downward scan removes the spurious-root risk; none observed (§1.5) | CONFIRMED | (computed) | Physical variant, 12,058 grid cases (DB 26–50, RH 5–100 %, MRT−DB 0–30, 0.2–4 m/s, 80–115 kPa): scan vs plain bisection max difference 5×10⁻⁹ W/m². |
| A44 | Oracle exits 0 with 9/9 checks; fixture reproducible (header) | CONFIRMED | scripts/oracles/twl_oracle.py | Re-run 2026-11-09: 9/9, exit 0; numeric values identical to the committed fixture. |
| A45 | Independent transcription reproduces all 42 vectors to ≤ 3×10⁻⁵ W/m² and ≤ 1×10⁻⁶ K (§1.5) | CONFIRMED | (computed) | Fact-check JS: ≤ 7.4×10⁻⁶ W/m² and ≤ 5×10⁻⁷ K, both variants. |
| A46 | Fixture spot check by hand | CONFIRMED | fixtures/twl.json | BB2002-TEXT-1, AD-INLAND-MIDDAY-WINDY, GLOBE-150MM: H − (C+R+E) ≈ 10⁻⁵ W/m² at the fixture tsk; TWL 110.711 / 206.306 / 142.559, matching the fixture. |
| A47 | alt_1p8 is up to ~63 W/m² higher; 206 vs 253 and 212 vs 275 (§1.6) | CONFIRMED | fixtures/twl.json | 206.3 / 252.6 and 212.4 / 275.1; maximum gap 62.7. |
| A48 | Variants differ only when the physical solution has x < 1.7; physical is never higher (§1.6) | CONFIRMED | (analysis) | For x > 1.7 both give E = Emax; for x ≤ 1.7, E_alt ≥ E_phys. |
| A49 | UAE field check: physical 256/210/225/286, alt 277/248/280/337; alt exceeds the slot maximum in 3 of 4 slots (§1.6) | CONFIRMED | https://doi.org/10.1186/1745-6673-3-21 | Reproduced with P = 101.3 kPa and a 150 mm globe. The pressure is not stated in §1.6; P = 100 gives values ≤ 0.6 lower. The inputs match B&S Table 3. |
| A50 | Sensitivity at DB 40, RH 40 %, MRT 65, 1 m/s: 148 → 134 (DB+1), 135 (MRT+5), 181 (2 m/s), 105 (RH 50 %) (§1.8) | CONFIRMED | (computed) | 148.2 / 134.4 / 134.6 / 181.0 / 104.8. "DB +1" holds RH at 40 %, so pa rises; at constant pa the result is 143.8. |
| A51 | 50 °C globe, 40 °C air, 1 m/s: 150 mm gives MRT 67.1 and TWL 143; 25 mm gives 82.6 and 98 (§1.7) | CONFIRMED | (computed) | 67.10 / 142.6 and 82.62 / 97.7. |
| A52 | ISO 7726:1998 Annex B globe→MRT formula; agrees with pythermalcomfort to < 1e-6 (§1.7) | CONFIRMED | https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort | ISO text is paywalled. pythermalcomfort 4.8.1's ISO branch is identical term for term, and the oracle check is 0.0. The standard-globe forced constant 6.3/(0.15^0.4·0.95·σ) = 2.50×10⁸. |
| A53 | Liljegren globe D = 0.0508 m (§1.7) | CONFIRMED | https://github.com/ecmwf/thermofeel | thermofeel 2.3.0 `liljegren.py`: `D_GLOBE = 0.0508`. |
| A54 | "~0.025 m for Kestrel-type meters" (§1.7) | CORRECTED | https://cdn.shopify.com/s/files/1/0344/1457/files/Kestrel_5400_Meter_Manual.pdf | Kestrel converts its 25 mm globe reading "to Tg equivalent for standard 6 in / 150 mm globe" (data sheet; manual p.21), so use D = 0.15 m. Fixed inline and in the `GLOBE-25MM` description; fixture regenerated. |
| A55 | Scarlet TWL-1S uses a 7.5 cm globe with a vendor correction (§1.7) | UNVERIFIABLE | https://scarlet-tech.com/wp-content/uploads/2026/08/scarlettech-TWL-1S-brochure-260810.pdf | The official brochure is silent. 75 mm appears only in reseller and user-guide snippets (pages blocked); the correction method was not found. |
| A56 | No open-source TWL in GitHub repository search, HeatStress R, pythermalcomfort 4.8.1 or thermofeel 2.3.0 (§0, §1.9) | CONFIRMED | https://github.com/anacv/HeatStress | GitHub API searches: 0 relevant hits; `HeatStress/R` has no TWL function; a grep of both Python packages found none. |
| A57 | "the oracle in this repo is the only open implementation" (§0) | CORRECTED | https://www.pointhealth.com.au/TWL/ | A public, source-visible but proprietary calculator exists. Fixed inline. |
| A58 | HAAD and Point Health online TWL calculators are defunct (§1.9) | CORRECTED | https://www.pointhealth.com.au/TWL/ | haad-safe.ae no longer resolves, but the Point Health calculator is live. Fixed inline with formulation details. |
| A59 | Kestrel statement (2024-02-05): Brake-thesis algorithm; presets 0.50/0.40 and 0.96/0.39 (§1.9) | CONFIRMED [V] | https://cdn.shopify.com/s/files/1/0209/2718/files/5400_TWL_Statement.pdf | Verbatim. |
| A60 | Scarlet TWL-1S "endorsed by DOH/OSHAD"; vendor 4-zone table citing the 2009 Abu Dhabi MoL manual with ">220: 0.6~1 Liter/hr" (§1.9, §2.3) | CONFIRMED [V] | https://legacy.scarlet-tech.com/download-file/research-articles/ | "Heat Stress and TWL" pp.6–8. |
| B1 | CoP 11.0 v4.0, 15 July 2024 (file name "v31"); TG v4.0 15 July 2024; Mechanism 11.0 v4.0 15 July 2024 (§2.1) | CONFIRMED | https://www.adphc.gov.ae/en/Legislation/Code-of-Practices | ADPHC listing pages and PDF footers. |
| B2 | v4.0 amendment-record wording (§2.1) | CONFIRMED | https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Codes-of-Practise/11---Safety-in-the-Heat-v31-English.pdf | CoP p.11. The TG record lacks the HAAD→DOH line. |
| B3 | CoP §1(a) scope; §1(b) "follow the more stringent requirement" (§2.2) | CONFIRMED | (CoP PDF, B2) | p.3, verbatim. |
| B4 | CoP §3.1.1(e): 35 °C trigger, verbatim (§0, §2.2, §6.3) | CONFIRMED | (CoP PDF, B2) | p.6, verbatim. |
| B5 | CoP §3.1.1(f), (g), (h), (i), (k), (l) (§2.2, §2.5, §2.8) | CONFIRMED | (CoP PDF, B2) | pp.6–7. |
| B6 | TG §2.1(a)/(b) quotes; §2.2(a) four parameters with no pressure; §2.2(c) calculator URL blank (§1.9, §2.2) | CONFIRMED | https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Technical-Guidelines/Safety-in-the-Heat--Eng.pdf | pp.3–4, verbatim. |
| B7 | Only TWL is named; WBGT is absent from CoP and TG v4.0 (§2.2) | CONFIRMED | (CoP and TG PDFs) | Full-text search found no "WBGT". |
| B8 | TG Table 1: zone labels and ranges ("140 - 220 <", "115 – 140", "< 115"), all interventions, water rates, work-rest (45/15, 20/40), notes a–d and * (§2.3, §6.2) | CONFIRMED | (TG PDF, B6) | p.5, rendered page image; every cell matches. |
| B9 | ADPHC TWL sheet has "identical wording to TG Table 1" (§2.1) | CONFIRMED | https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/Safety-in-Heat/Ther-Bi.pdf | True for the English side. The Arabic side differs in two medium-zone cells: "لا يجوز لأي شخص أن يعمل وحده" (no person may work alone) vs "Working alone to be avoided", and heavy work "العمل الذاتي المستمر" (continuous self-paced) vs "Continuous paced work". |
| B10 | B&B 2002 Table II zones (<115 or DB > 44 or WB > 32 / 115–140 / 140–220 / > 220) and M&B 2007 Table 6 (§2.3) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | AEOH p.185; M&B p.560, verbatim. |
| B11 | Burke & Hokins 2013 and THORZT integer bands ≥ 220 / 140–219 / 116–139 / ≤ 115 (§2.3) | CONFIRMED | https://www.qmihsconference.org.au/wp-content/uploads/qmihsc-2013-concurrent-burke_hokins.pdf | THORZT via its vendor page [V]. |
| B12 | Sharjah GL-15: zones, 1.5/1.2/1/0.5 L/h, medium-zone heavy work 40/20, the "Acclimatised…" typo (§2.3) | CONFIRMED | https://mc.spsa.shj.ae/media/documents/81dU0d270WoEGwprenKA_OSHJ-GL-15%20Safety%20in%20Heat%20Version%201%20English.pdf | p.7, verbatim. |
| B13 | Sharjah instrument is "OSHJ-GL-15 v1 (Sep 2021)", an "emirate guideline" (§2.3, §4) | CORRECTED | https://mc.spsa.shj.ae/Media/documents/j3comnEiUeCQ3emVuS2OQ_Safety%20in%20Heat%20OSHJ-COP-33.pdf | Superseded 3 Jul 2024 by OSHJ-CoP-33 v2 Rev 0, now a code of practice, with an identical TWL table. Fixed inline. |
| B14 | Half-open zone convention: < 115; 115 ≤ x < 140; ≥ 140 (§2.3, §6.2) | CONFIRMED | https://www.pointhealth.com.au/TWL/ | A design choice. It matches the authors' public calculator (`calc.js`: < 115 / < 140 / < 220, applied to the truncated TWL, which is equivalent for integer thresholds). |
| B15 | Backstop quotes: DB > 44 °C (skin discomfort), WB > 32 °C, "errors up to 20 W/m²", "backstop" (§2.4) | CONFIRMED | https://doi.org/10.1080/104732202753438261 | p.186, verbatim. |
| B16 | Abu Dhabi inland summer air temperatures often exceed 44 °C (§2.4) | CONFIRMED [S] | https://en.aletihad.ae/news/uae/4582482/ncm--highest-temperature-recorded-in-uae-friday-was-50-1-c-i | NCM bulletins: inland forecasts 44–48 °C; Sweihan daily maxima 47–51 °C in July 2025/2026. |
| B17 | CoP §3.2(b)(i)–(xiii): 5–7 days; TWL for breaks and water; communicate conditions; programmed drinking hourly; container ≥ 1 L; no shared cups; midday-break shelter; permit to work including the TWL High Risk Zone (§2.5) | CONFIRMED | (CoP PDF, B2) | pp.7–8, verbatim. ADPHC now lists CoP 5.0 (cited in (ix)) as cancelled, replaced by the DoH Occupational Health Screening and Medical Surveillance Standard. |
| B18 | CoP §3.2(c), (e) (CoP 30.0), (g), (h), (i), (j); §4 record keeping (§2.5, §2.8) | CONFIRMED | (CoP PDF, B2) | pp.8–10, verbatim. |
| B19 | Acclimatization table (NSC) and re-acclimatization table (§2.6, §6.2) | CONFIRMED | (TG PDF, B6) | p.6; all cells match. |
| B20 | TG §5.1 "over two weeks"; TG App. 1 "more than 14 days … 5-7 days"; B&B "first 7 calendar days … away for more than 14 days" (§2.6) | CONFIRMED | (TG PDF, B6) | TG pp.10, 13; AEOH p.186. |
| B21 | CoP §2(d)(ii) "at least 2 litres every 2-3 hours"; TG §5.2 "4-6 liters … per day"; TG §5.6 no salt tablets, ≤ 4 % sugar, electrolyte at every second drink (§2.7) | CONFIRMED | (CoP and TG PDFs) | Verbatim. |
| B22 | TG App. 4: SG ≤ 1.015 at start of shift, ≤ 1.029 at other times; alert bands; ≥ 1.030 remove and recheck in 4 h; failed test re-tested after 1 h until SG < 1.015 (§2.7, §6.3) | CONFIRMED | (TG PDF, B6) | pp.18–19, verbatim. |
| B23 | TG App. 3 flowchart: withdrawal zone (<115) with permit; fail SG ≥ 1.030; pass SG ≤ 1.025; dehydration testing on the first 3 days back (§2.7) | CONFIRMED | (TG PDF, B6) | p.17, rendered page image. |
| B24 | First aid: CoP §3.1.1(l), §3.2(j), §2(f); TG §4.5 heat-stroke steps; App. 6 "response within 3 minutes" (§2.8) | CONFIRMED | (CoP and TG PDFs) | Verbatim. |
| B25 | Mechanism 11.0: Form G within 24 h for fatalities and 3 working days for other serious incidents; Schedule B wording; heat illness not named in Schedules A–C (§2.8, §6.3) | CONFIRMED | https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/PDF/OSHAD-SF/Mechanisms/11---Incident-Notification-Eng.pdf | Verbatim. Schedule C item 12 covers only "eye affections from the heat and light". |
| B26 | CoP §2(d) training within 10 days and before summer; §2(c) awareness "as defined by Ministry of Labour Decree's" (§6.3) | CONFIRMED | (CoP PDF, B2) | p.4, verbatim. |
| B27 | ADPHC Safety in Heat kits and roll-up languages; safetyinheat@adphc.gov.ae (§2.9) | CONFIRMED | https://www.adphc.gov.ae/en/Public-Health-Programs/Injury-Prevention/Safety-in-Heat | The email is on the TWL sheet. The page also lists a trainer manual. |
| B28 | Media Office, 21 Sep 2025: 11th year; > 9 million reached; 22,164 visits; 35 materials; 884,200 distributed; six languages (§2.9) | CONFIRMED | https://www.mediaoffice.abudhabi/en/health/abu-dhabi-public-health-centre-celebrates-11-years-of-safeguarding-workers-during-summer-season-through-safety-in-heat-programme/ | Verbatim. |
| B29 | Earlier versions not retrieved; "EHS RI-CoP 11.0 ~2012" (§2.1) | UNVERIFIABLE | — | A "CoP 11.0 Safety in Heat V2.1" dated April 2013 is listed on Scribd; not retrieved. |
| C1 | MR 44/2022: outdoor work under direct sun or in open places banned 12:30–15:00, 15 Jun–15 Sep (§3) | CONFIRMED | https://u.ae/en/information-and-services/jobs/sector-of-employment/employment-in-the-private-sector/working-hours | u.ae [P]. |
| C2 | Shade obligation in Art. 11 of Administrative Decision 19/2023 (§3) | CONFIRMED [S] | https://middleeastbriefing.com/news/uae-midday-break-for-open-air-workers-begins-june-15-employer-obligations | Secondary source only. The decision text was not retrieved (mohre.gov.ae refused connections). |
| C3 | 2026: 22nd consecutive year, "effective from 15th June until 15th September 2026", 2026 wording on direct sunlight and open areas, compliance "exceeding 99%", announced 8 Jun 2026 (§0, §3) | CONFIRMED | https://sharjah24.ae/en/Articles/2026/06/08/KMR16 | WAM text verbatim; Emirates247 (8 Jun 2026) concurs. |
| C4 | 2025 was the 21st year (§3) | CONFIRMED [S] | https://www.khaleejtimes.com/uae/uae-midday-break-2025-june-15-to-september-15 | Khaleej Times, 3 Jun 2025. |
| C5 | Three exemption categories; duties for exempt work (shade, fans, cold water, salts/hydration supplements, comfort facilities, first aid, parasols) (§3, §6.3) | CONFIRMED | https://sharjah24.ae/en/Articles/2026/06/08/KMR16 | Plus Gulf News, 14 Jun 2023. |
| C6 | Fine AED 5,000 per worker, up to AED 50,000 (§0, §3) | CONFIRMED [S] | https://www.khaleejtimes.com/uae/uae-midday-break-2025-june-15-to-september-15 | Also Middle East Briefing 2024. The WAM 2026 release does not restate fines; the statutory text was not retrieved. |
| C7 | "The decision limits daily working hours to eight" (§3) | CONFIRMED [S] | https://gulfnews.com/uae/uae-3-month-midday-break-for-workers-begins-june-15-1.96393725 | Gulf News, 14 Jun 2023. |
| C8 | 8 h/day or 48 h/week (FDL 33/2021 Art. 17); overtime ≤ 2 h/day; break after 5 consecutive hours, ≥ 1 h; Ramadan −2 h/day (§3) | CONFIRMED | (u.ae, C1) | Verbatim. |
| C9 | MoHRE call centre 600590000 (§3) | CONFIRMED | https://sharjah24.ae/en/Articles/2026/06/08/KMR16 | — |
| D1 | Qatar MD 17/2021: Art. 2 (1 Jun–15 Sep, 10:00–15:30); Art. 4(9) stop work if WBGT > 32.1 °C; Art. 4 duties; Art. 6 right to stop without dismissal; Art. 7 closure; Art. 8 oil and gas excluded (§0, §4) | CONFIRMED | https://www.ilo.org/sites/default/files/wcmsp5/groups/public/%40arabstates/%40ro-beirut/documents/legaldocument/wcms_794551.pdf | Verbatim. ILO news item dated 27 May 2021. |
| D2 | Saudi Arabia: 15 Jun–15 Sep 2026, 12:00–15:00; hotline 19911 (§4) | CONFIRMED [S] | https://arynews.tv/saudi-arabia-announces-duration-of-mid-day-work-ban | ARY News, 15 Jun 2026. |
| D3 | Saudi older fines SAR 3,000–10,000 per worker, up to 30-day closure; not confirmed for 2026 (§4) | CONFIRMED [S] | https://www.arabnews.com/node/376192 | Older reports only, as the note says. |
| D4 | Kuwait MR 3/2026: 1 Jun–31 Aug, 11:00–16:00; exemptions need prior Labour Inspection approval (§4) | CONFIRMED [S] | https://www.arabtimesonline.com/news/kuwait-bans-outdoor-work-during-peak-summer-hours-from-june-to-august/ | Arab Times, 20 May 2026. |
| D5 | Kuwait older fine KD 100 per worker (§4) | CONFIRMED [S] | https://gulfnews.com/world/gulf/kuwait/kuwait-breaches-of-outdoor-noon-work-ban-exposed-1.89425550 | Some outlets report KD 100–200 per worker. |
| D6 | Oman: Labour Law Art. 16 and Decision 286/2008; Jun–Aug, 12:30–15:30; RO 500–1,000; licence annulment; hotline 80077000 (§4, §6.3) | CONFIRMED [S] | https://www.omanobserver.om/article/1190457/oman/mol-announces-mid-day-break-as-temperatures-rise-near-to-50c | Oman Observer, 31 May 2026. |
| D7 | Bahrain: 2026 decision (No. 5 of 2026) repealing MD 3/2013; 15 Jun–31 Aug, 12:00–16:00; exemptions; 99.98 % compliance (§4, §6.3) | CONFIRMED [S] | https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/minister-issues-new-summer-midday-outdoor-work-ban-in-bahrain | DLA Piper gives no decision number; "No. 5" and 99.98 % come from GDN / Daily Tribune. |
| D8 | Buqammaz et al. 2026: the calendar ban "is found only in Gulf countries" (§4) | UNVERIFIABLE | https://doi.org/10.1007/s40572-026-00525-x | Citation confirmed (Curr Environ Health Rep 13:9, 3 Mar 2026). The full text is paywalled and the abstract has no such sentence. |
| E1 | Shanks & Papworth 2001: 345 labourers with heatstroke over 3 summer months; no predictive association with temperature or humidity (§5) | CONFIRMED | https://pubmed.ncbi.nlm.nih.gov/11235827/ | Occup Med 51(1):45–49; verbatim. |
| E2 | The National, 27 May 2011: 3,017 illnesses in 2010, most work-related; "We've rarely reached the withdrawal zone here"; 600 ml every half-hour; 20/40 (§5) | CONFIRMED [S] | https://www.thenationalnews.com/uae/officials-to-set-legal-limit-for-working-in-the-heat-1.593060 | Verbatim. |
| E3 | The National, 27 Jun 2011: 817 (2010) vs 763 (2009); Rashid Hospital 23 cases (21 May–26 Jun); daily TWL publication (§2.9, §5) | CONFIRMED [S] | https://www.thenationalnews.com/uae/health/thermal-work-limit-a-real-measure-of-stress-1.424865 | Verbatim; the figures are unattributed in the article. |
| E4 | Joubert, Thomsen & Harrison 2011 (AJPH 101(3):395–398): 465 companies, 814,996 workers, 6,254 sites; "79.5% decrease … (15.3 vs 1.16 …)"; 50 % fall (0.08–0.04 per 100 000 h) (§2.9, §5) | CONFIRMED | https://pmc.ncbi.nlm.nih.gov/articles/PMC3036673/ | Verbatim. 15.3 → 1.16 is a 92.4 % fall; the inconsistency is in the source abstract. |
| E5 | Bates & Schneider 2008 (JOMT 3:21): May 2006, 22 workers, Calor meter; TWL 237.7/194.8/189.3/230.6 with ranges; ≈ 120 W/m² at DB > 50 °C; WBGT > 27.5 °C; conclusion quote (§1.6, §5) | CONFIRMED | https://doi.org/10.1186/1745-6673-3-21 | Verbatim. |
| E6 | Bates, Miller & Joubert 2010 (AOH 54(2):137–143): four sites (construction Jul–Aug, dockyard Sep, smelter Dec); Usg ≥ 1.026 in 31 % / 27 % vs 15 % / 14 % of samples (§5) | CONFIRMED | https://doi.org/10.1093/annhyg/mep076 | Verbatim. |
| E7 | Miller et al. 2011 (AOH 55(5):548–555): 150 subjects, Abu Dhabi and Dubai 2007–08; mean TWL 140–200; HR 88–102; > 92 % / > 88 %; winter > 300 (§5) | CONFIRMED | https://doi.org/10.1093/annhyg/mer012 | Verbatim; 88–102 bpm is the morning range (afternoon 93–102). |
| E8 | ICOH 2012 HAAD paper not located; Joubert GCC OHS Conference, January 2010 listing (§5) | UNVERIFIABLE | — | Not re-searched beyond the note's own attempt. |
| E9 | Ahmed et al. 2020 (Ind Health 58(2):170–181): one site, 200 workers, 12:00–15:00; TWL 117–163 / 168–292 / 176–226; natural WB from an HS-32 monitor; "TWL calculator" (§5) | CONFIRMED | https://pmc.ncbi.nlm.nih.gov/articles/PMC7118060/ | Verbatim. |
| E10 | Al Hurini et al. 2024: 397 adults; 86.4 % self-reported heat exhaustion (§5) | CONFIRMED | https://pmc.ncbi.nlm.nih.gov/articles/PMC11688620/ | Ajman convenience sample; the paper's conclusion section says 86.8 %. |
| E11 | Cureus 2022 heat-exhaustion-mimicking-STEMI case; Gomes et al. 2002, Dubai foundry heat and noise (§5) | CONFIRMED | https://pubmed.ncbi.nlm.nih.gov/36415364/ | Egaimi et al., Cureus 14(10):e30495 (Ras Al Khaimah); Gomes et al., Occup Med 52(3):121–128 (PMID 12063357). |
| E12 | Teyton et al. 2025: 12 studies (2010–2024 window), UAE n = 1 (§5) | CONFIRMED | https://pmc.ncbi.nlm.nih.gov/articles/PMC12207249/ | GeoHealth 9(7):e2024GH001277. |
| F1 | §6.1–§6.3 port-ready rules restate the values above (zones, water, work-rest, backstops, calendar windows, SG limits, notification times) | CONFIRMED | (rows above) | Cross-checked. No discrepancies other than the corrections listed. |

### Additional findings for the engineering team

These are not errors in the note.

1. **The authors' own public calculator supports the default "physical" reading.** The live Point Health TWL calculator (© 2021 Point Health, contact gbates@pointhealth.com.au) does the following:
   - computes the zone-B efficiency as exp[−0.4127(x − 0.46)^1.168], with no 1.8 factor in the exponent, after converting the per-person sweat rate to W/m² by dividing by 1.8 m²
   - uses A = 0.000644 with P in kPa
   - applies the posture factor to hr
   - truncates TWL with `parseInt`, consistent with the 45/62 floor matches
   - classifies on half-open intervals

   This supports both the default variant and the note's hypothesis that the printed "1.8" is a per-person/per-m² artefact. Its outputs will still differ from the oracle: it is a different, EESAM-style formulation with Ts(M), its own curves, no respiratory term, icl 0.6 and no 4 m/s cap. Do not use it as a fixture source.

2. **The Arabic and English sides of the ADPHC bilingual TWL sheet differ in the medium zone (B9).** The Arabic is stricter on lone working, and it says self-paced where the English says paced for heavy work. Zill shows Arabic text, so take wording from the English TG v4.0 Table 1, which is the governing document, and flag the discrepancy to ADPHC.

3. **alt_1p8 port detail.** §1.6 gives only the zone-B formula for `alt_1p8`. The oracle (`_heat_terms`) uses:
   - E = 1.8·λSr when X < 0.46
   - 1.8·λSr·exp[−0.4127(X − 0.46)^1.168] when 0.46 ≤ X ≤ 1.7
   - Emax when X > 1.7
   - then E = min(E, Emax)

   Port exactly this to match `twl_alt_1p8_w_m2`.

4. **Kestrel and other instruments (A54).** Never apply a small-globe correction to a Tg that the instrument has already converted to a 150 mm-globe equivalent. For any meter, confirm from its manual whether the displayed Tg is raw or standard-equivalent.

5. **CoP 5.0** (cited in CoP 11.0 §3.1.1(c) and §3.2(b)(ix)) is listed by ADPHC as cancelled and replaced by the DoH Occupational Health Screening and Medical Surveillance Standard.

### Scripts re-run and edits

- **`scripts/oracles/twl_oracle.py`, re-run 2026-11-09:** 9/9 checks passed, exit 0.
- **Script edits:**
  - two docstring statements (A19, A21)
  - the `GLOBE-25MM` vector description, which called the 25 mm case "Kestrel-size" (A54)
- **Fixture:** `fixtures/twl.json` was regenerated. Apart from `generated_utc`, the only difference from the previous fixture is that one description string. All numeric expected values are unchanged.
- **Independent JavaScript check:** run from a scratch directory and not committed. It reproduced the fixture to ≤ 7.4×10⁻⁶ W/m² (TWL) and ≤ 5×10⁻⁷ K (tsk) for both variants.
