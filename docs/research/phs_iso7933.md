# ISO 7933 Predicted Heat Strain (PHS): port-ready specification for Zill

Status: research spec for the TypeScript engine. Last verified on 2026-11-09 against pythermalcomfort 4.8.1, thermofeel 2.3.0, numpy 2.5.4 and Python 3.12.10.
Companion files:
- `scripts/oracles/phs_oracle.py` regenerates the oracle file. It is deterministic: two runs give the same SHA-256.
- `fixtures/phs.json` holds 50 single-run vectors, 4 piecewise chains, 2 full minute-by-minute traces and 5 globe-to-MRT examples.

Evidence labels used throughout:
- **[P]** primary. Text read in the official ISO/NSAI/iTeh previews of ISO 7933:2004 and ISO 7933:2023.
- **[S]** secondary. Code transcriptions of Annex E, the pythermalcomfort source/issues, and the R package `comf`.
- **[V]** verified numerically by us in `phs_oracle.py`.
- **[U]** unverified. The full standards are paywalled, so we could not check the printed text.

---

## 0. Summary for engineers

1. **Port target.** Port the `pythermalcomfort.models.phs` kernel (`_phs_optimized_scalar`). Section 4 gives the full pseudocode. We re-implemented it in pure Python from that pseudocode (`phs_reference` in the oracle script). On every fixture vector it reproduces pythermalcomfort 4.8.1 to a **maximum relative difference of 5.2e-15**. On 300 random cases spanning both editions, all postures, walking and drink 0/1, the maximum absolute difference was 1.3e-9 on `evap_load_wm2_min` and ≤ 7e-11 on the other outputs. D_lim values were identical. [V]
2. **Units.** The engine should take M in **W/m² of DuBois area**. pythermalcomfort takes `met` and multiplies by **58.15**. Pressures are in kPa, temperatures in °C, and the time step is **1 minute** with an integer duration.
3. **Edition.** Use **ISO 7933:2023** (`model = "7933-2023"`). The official list of changes in the 2023 foreword has only two items [P]:
   - "The maximum sweat rate SW_max described in B.4 has been corrected, i.e. it is no longer adjusted for metabolic rate."
   - A caution about unsteady conditions.

   pythermalcomfort's 2023 path also changes `fcl`, `hc`, the reflective-clothing formula, the minute-1 skin temperature, D_max and the defaults (section 5).
4. **Trap: the pythermalcomfort 2023 defaults are not neutral.** The defaults `a_p = 0.54`, `f_r = 0.42` give a clothing emissivity of 0.759, which means partly reflective clothing. For ordinary clothing, always pass **`a_p = 0`**. In the Abu Dhabi sun case (AD02 vs AD18), the defaults:
   - lower the 8-h t_re from 39.88 to 38.76 °C;
   - lengthen D_lim,tre from 35 to 43 min.

   Both errors are in the unsafe direction. [V]
5. **Trap: D_lim semantics.** `d_lim_*` are counted **from the start of the call**. When a limit is not reached, they **fall back to `duration`**. In a chained run, `d_lim_t_re = 1` means "already above 38 °C at the start of this segment". The engine must track limits in absolute shift minutes and return "not reached" explicitly. [V]
6. **Trap: drink = 0 under 2023 is penalised twice in pythermalcomfort.** It uses a 3 % body-mass threshold **and then** multiplies by 0.6. Case AD15: 71.4 min versus 119 min for the 3 % threshold alone. The Annex E transcriptions use the 3 % threshold only (section 6.4). Drink = 0 matters for workers who are fasting. [V][S]
7. **Decision needed: the convective coefficient (`hc`) under 2023.** pythermalcomfort fixes `hc = max(z, 2.38·|tr+0.1−tdb|^0.25)` for the whole run.
   - With that choice, ISO 7933:2023 Annex F case 3 (high radiant load, 0.1 m/s) is off by **−0.50 °C t_re**, and D_lim,tcr is **275 min vs 149 min published**, which is unsafe.
   - Re-evaluating `hc` from the converging `t_cl` inside the t_cl iteration, as jsthermalcomfort does, reproduces case 3: 38.69 °C and 151 min (published 38.7 °C, 149 min).
   - In typical Abu Dhabi cases with v ≥ 0.5 m/s, `hc = z` and the two choices give identical results.

   Recommendation: make this a switch. Default to the ISO-faithful `tclIteration`. Use `pythermalcomfort` mode for oracle-parity tests. Both expected values are in the fixtures (`variants["reference:hc_tcl_iter"]`). [V]
8. **Validity limits as implemented by pythermalcomfort 4.8.1 for 2023 (inclusive):**
   - 15 ≤ tdb ≤ 50 °C
   - 0 ≤ tr−tdb ≤ 60 °C
   - 0 ≤ v ≤ 3 m/s
   - 0.5 ≤ p_a ≤ 4.5 kPa
   - **56 ≤ M ≤ 250 W/m²**
   - 0.1 ≤ clo ≤ 1.0

   The ISO 8996 "very high" class (290 W/m²) is outside this range. Impermeable or vapour-barrier suits are outside the 2023 scope [P]. Section 4.6 explains why the M limit is still [U].
9. **Piecewise shifts.** pythermalcomfort accepts 7 state kwargs: `t_sk, t_cr, t_re, t_cr_eq, t_sk_t_cr_wg, sweat_rate_watt, evap_load_wm2_min`. Chaining is exact for 2004. Under 2023 it is *not* identical to a continuous run, because the minute-1 skin override is re-applied at every call. Do the work/rest arithmetic in your own minute loop (section 11).
10. **MRT from a 2-inch Liljegren globe.** Do **not** use `thermofeel.calculate_mrt_from_bgt`. It assumes a **0.15 m** globe and a **10 m** wind that it rescales by 0.6805 to 1.1 m. With 2 m wind passed in, it under-reads by 9–10 °C (section 10). Invert the globe with Liljegren's own convection coefficient, or better, compute a human MRT directly from the radiation inputs.

---

## 1. Sources and provenance

| Source | What we used it for | Level |
|---|---|---|
| ISO 7933:2023 free previews (NSAI I.S. EN ISO 7933:2023 sample; iTeh sample of ISO 7933:2023) | Foreword change list, Scope, Table 1 symbols/units, clause 5 WARNING, Formulas (1),(4)–(8), annex titles/status | [P] |
| ISO 7933:2004 iTeh sample | Foreword, Scope, Table 1 symbols/units (Fr = "emissivity of the reflective clothing"), Formulas (1)–(11), NOTE "1 W·m⁻² … 2,67 g·h⁻¹ for a standard subject (1,8 m²)" | [P] |
| pythermalcomfort 4.8.1 `models/phs.py` (venv) | The algorithm we port, read line by line, plus helpers (`p_sat`, `met_to_w_m2 = 58.15`, `_valid_range`) | [S] (library) |
| pythermalcomfort tests (`tests/test_phs.py`) and validation table `ts_phs.json` (FedericoTartarini/validation-data-comfort-models v1.1.0). The repository has moved from CenterForTheBuiltEnvironment/pythermalcomfort to pythermalcomfort/pythermalcomfort; GitHub redirects | Reference cases and tolerances | [S] |
| pythermalcomfort issue #217 (MATLAB `PHS79332023`, ISO 2023 Annex F table), discussion #223, issue #225 | 2023 Annex E details and Annex F results. The maintainer read the printed 2004/2023 PDFs for `hc` and the minute-1 override (2026-08-18) | [S] |
| R package `comf`: `calcIso7933.R` (transcription of the 2004 Annex E BASIC) and dataset `dfISO7933AppF` (2004 Annex F) | 2004 code (e.g. `spHeat = 57.83·W/ADu`, `hc` from the current t_sk each minute) and the 2004 annex values | [S] |
| `gunteralce.github.io/phs` `PHS.js` (linked from Lund University's climate-lab tools page). It describes itself as "based on … Annex E in ISO/FDIS 7933" | Independent transcription of the FDIS-era code | [S] |
| jsthermalcomfort `src/models/phs.js` (official JS port) | 2023 `hc` evaluated inside the t_cl iteration; no minute-1 override; M limits interpreted in W | [S] |
| LSI-Lastem note "GIDAS TEA: compliance with ISO 7933:2023" | Vendor summary: 50 % criterion removed; SW_max not a function of M | [S] (vendor) |
| thermofeel 2.3.0 (`calculate_mrt_from_bgt`, `liljegren.py`) | Globe and MRT assumptions | [S] (library) |

Paywall note: we could not open the full texts of ISO 7933:2004, ISO 7933:2023, ISO 7726, ISO 8996 and ISO 9920. Every number below that comes only from code transcriptions is labelled [S] or [U].

---

## 2. Inputs, units and defaults

### 2.1 pythermalcomfort `phs()` signature (4.8.1)

`phs(tdb, tr, v, rh, met, clo, posture, wme=0, round_output=True, model="7933-2023", **kwargs)`

| Input | Unit | Meaning | Default 2004 | Default 2023 | Notes for the port |
|---|---|---|---|---|---|
| `tdb` | °C | air temperature t_a | required | required | |
| `tr` | °C | mean radiant temperature t_r | required | required | Human MRT (section 10) |
| `v` | m/s | air velocity v_a at the body | required | required | Not the 10 m wind |
| `rh` | % | relative humidity | required | required | Converted to p_a [kPa]. 2004: `p_sat(tdb)/1000·rh/100`, where `p_sat` is the Hyland-Wexler form (section 4.1). 2023: `0.6105·exp(17.27·tdb/(tdb+237.3))·rh/100` **[Δ]** |
| `met` | met | metabolic rate | required | required | M [W/m²] = met × **58.15** |
| `clo` | clo | static (basic) clothing insulation I_cl | required | required | I_cl,st [m²K/W] = 0.155·clo |
| `posture` | – | "standing", "sitting" or "crouching" | required | required | A_r/A_Du = 0.77 / 0.70 / 0.67 |
| `wme` | met | effective mechanical power W | 0 | 0 | W [W/m²] = wme × 58.15 |
| `i_mst` | – | static moisture permeability index i_m,st | 0.38 | 0.38 | |
| `a_p` | – | fraction of the body covered by reflective clothing A_p | 0.54 | 0.54 | **Use 0 for ordinary clothing** |
| `f_r` | – | 2004: emissivity of the reflective clothing. 2023: reflection coefficient | **0.97** | **0.42** | Has no effect when `a_p = 0` **[Δ]** |
| `drink` | – | 1 = can drink freely, 0 = cannot | 1 | 1 | |
| `weight` | kg | body mass W_b | 75 | 75 | Must satisfy 0 < W_b ≤ 1000 |
| `height` | m | body height | 1.8 | 1.8 | Not validated. 0 causes a division by zero |
| `walk_sp` | m/s | walking speed v_w | 0 | 0 | 0 means "not entered". It is then estimated from M |
| `theta` | ° | angle between walking direction and wind | 0 | 0 | 0 means "direction not entered" |
| `acclimatized` | – | 100 = acclimatized, 0 = not | 100 | 100 | Other values raise an error |
| `duration` | min | number of 1-minute steps | 480 | 480 | Integer |
| `t_sk` | °C | initial mean skin temperature | 34.1 | 34.1 | State |
| `t_cr` | °C | initial core temperature | 36.8 | 36.8 | State |
| `t_re` | °C | initial rectal temperature | = t_cr | 36.8 | State **[Δ]** |
| `t_cr_eq` | °C | initial core temperature as f(M) | = t_cr | 36.8 | State **[Δ]** |
| `t_sk_t_cr_wg` | – | initial skin–core weighting α | 0.3 | 0.3 | State, in [0, 1] |
| `sweat_rate_watt` | W/m² | initial predicted sweat rate SW_p | 0 | 0 | State, ≥ 0 |
| `evap_load_wm2_min` | W·min/m² | initial accumulated water-loss load ΣSW | 0 | 0 | State, ≥ 0 |
| `limit_inputs` | bool | NaN outside the Table A.1 limits | True | True | |
| `round_output` | bool | round to 1 dp (α to 2 dp) | True | True | Use False when chaining |

### 2.2 Outputs (dataclass `PHS`)

| Output | Unit | Meaning |
|---|---|---|
| `t_re`, `t_sk`, `t_cr`, `t_cr_eq` | °C | state at the last minute |
| `t_sk_t_cr_wg` | – | α at the last minute |
| `d_lim_t_re` | min | first minute of **this call** with t_re ≥ 38 °C, else `duration` |
| `d_lim_loss_50` | min | 2004: first minute with water loss ≥ D_max50 (7.5 % W_b). 2023: identical to `d_lim_loss_95` **[Δ]**. Multiplied by 0.6 when drink = 0, see 4.4. Else `duration` |
| `d_lim_loss_95` | min | first minute with water loss ≥ D_max95 (5 % W_b, or 3 % in 2023 when drink = 0). Else `duration` |
| `sweat_rate_watt` | W/m² | SW_p at the last minute |
| `sweat_loss_g` | g | cumulative whole-body water loss (sweat + respiratory evaporation), including any carried-over load |
| `evap_load_wm2_min` | W·min/m² | cumulative ΣSW. Carry this to the next call |

Rounding: `numpy.around` rounds half-to-even on the binary value. Do **not** compare a port with these rounded values using `Math.round` (half-up). For example, 37.55 → 37.5 in numpy and 37.6 with `Math.round(x*10)/10`. jsthermalcomfort documents the same ±0.1 discrepancy. Always compare unrounded outputs.

---

## 3. Constants

| Symbol / code name | Value | Where |
|---|---|---|
| met → W/m² | 58.15 | pythermalcomfort `met_to_w_m2` |
| DuBois area A_Du | 0.202·W_b^0.425·H^0.725 [m²]. Gives **1.937871486** for 75 kg / 1.8 m | all transcriptions |
| `sp_heat` (c_sp, heat for 1 °C body-mean increase, per m², per minute) | **58.15·W_b/A_Du** = 2250.536 W·min·m⁻²·K⁻¹ (75 kg, 1.8 m) | pythermalcomfort. See 6.2: the 2004 BASIC uses **57.83** (= 3470/60) and the 2023 MATLAB uses 3490/60 = 58.167 |
| exponential-averaging constants | k_tcr,eq = exp(−1/10), k_tsk = exp(−1/3), k_SW = exp(−1/10) | all |
| A_r/A_Du | standing 0.77, sitting 0.70, crouching 0.67 | all |
| static boundary-layer insulation I_a,st | 0.111 m²K/W | all |
| clo → m²K/W | 0.155 | all |
| Lewis-type constant in R_t,dyn | 16.7 (K/kPa) | all |
| im_dyn cap | 0.9 | all |
| v_r cap in Corr_cl | 3 m/s. Corr_Ia uses the **uncapped** v_r | all |
| walking-speed cap | 1.5 m/s. The speed estimated from M is capped at 0.7 m/s | all |
| π | **3.14159** (literal, not Math.PI) | all. With θ = 90°, v_r = 0.4999987, not 0.5 (vector AD08) |
| Stefan–Boltzmann | 5.67e-8 | all |
| Kelvin offset in h_r | **273** (not 273.15) | all |
| emissivity of non-reflective clothing ε_cl | 0.97 | all |
| t_re limit | 38.0 °C | all (Annex B) [S] |
| w_max | 0.85 if not acclimatized, 1.0 if acclimatized | all |
| SW_max | 2004: (M−32)·A_Du clamped to [250, 400], ×1.25 if acclimatized. 2023: 400 not acclimatized, 500 acclimatized [W/m²] **[Δ]** | |
| D_max | 2004: D_max50 = 0.075·W_b·1000 g, D_max95 = 0.05·W_b·1000 g. 2023: one D_max = 0.05·W_b·1000 g (drink = 1) or 0.03·W_b·1000 g (drink = 0) **[Δ]** | |
| f_cl | 2004: 1 + 0.3·clo. 2023: 1 + 0.28·clo **[Δ]** ([U] for the printed 2023 text) | |
| water-loss conversion | SW_tot,g = ΣSW·2.67·A_Du/1.8/60 [g]. 2.67 g/h per W/m² for a 1.8 m² person [P, 2004 NOTE]. This implies a latent heat ≈ 2427 J/g | all |
| convergence tolerances | t_cl and t_cr: stop when \|Δ\| ≤ 0.001 °C. Damped update x ← (x + x_new)/2 | all |

---

## 4. Algorithm (language-neutral pseudocode)

Markers: `[2004]` and `[2023]` mark edition-specific lines. `[PYTC]` marks a pythermalcomfort-specific guard or choice. Variable names follow the pythermalcomfort source so that a port can be diffed against it.

### 4.1 Pre-processing (wrapper)

```
model ∈ {"7933-2004", "7933-2023"}                      else error
M   = met * 58.15                                        # W/m2
W   = wme * 58.15                                        # W/m2
if model == 2023: p_a = 0.6105*exp(17.27*tdb/(tdb+237.3)) * rh/100      [2023][PYTC]
else:             p_a = p_sat_HW(tdb)/1000 * rh/100                      [2004][PYTC]
    # p_sat_HW(t), t >= 0 degC, T = t + 273.15:
    #   exp(-5800.2206/T + 1.3914993 - 0.048640239*T + 0.41764768e-4*T^2
    #       - 0.14452093e-7*T^3 + 6.5459673*ln T)   [Pa]
    # (below 0 degC the ice-branch coefficients apply; irrelevant here)
acclimatized ∈ {0, 100}; drink ∈ {0, 1}; 0 < weight <= 1000             else error
sweat_rate_watt >= 0; evap_load_wm2_min >= 0; 0 <= t_sk_t_cr_wg <= 1    else error
if t_re    is None: t_re    = t_cr     # 2004 default; 2023 default is 36.8
if t_cr_eq is None: t_cr_eq = t_cr     # 2004 default; 2023 default is 36.8
f_r default: 0.97 [2004], 0.42 [2023]
```
The ISO programs themselves take p_a in kPa directly. The RH conversion is a pythermalcomfort wrapper choice.

### 4.2 Per-run quantities (computed once per call, i.e. per constant-condition segment)

```
a_dubois = 0.202 * weight^0.425 * height^0.725
sp_heat  = 58.15 * weight / a_dubois                     [PYTC; 2004 BASIC: 57.83; see 6.2]
d_lim_t_re = d_lim_loss_50 = d_lim_loss_95 = 0
if [2023]: d_max_50 = d_max_95 = (drink==0 ? 0.03 : 0.05) * weight * 1000      # g
else [2004]: d_max_50 = 0.075*weight*1000 ; d_max_95 = 0.05*weight*1000
def_dir   = (theta != 0) ? 1 : 0
def_speed = (walk_sp == 0) ? 0 : 1
a_r_du = {standing:0.77, sitting:0.70, crouching:0.67}[posture]
if [2004]: sw_max = clamp((M - 32) * a_dubois, 250, 400); if acclimatized==100: sw_max *= 1.25
if [2023]: sw_max = (acclimatized==0) ? 400 : 500                         # W/m2
w_max  = (acclimatized==0) ? 0.85 : 1
i_cl_st = 0.155 * clo                                                     # m2K/W
fcl     = [2023] 1 + 0.28*clo   |  [2004] 1 + 0.3*clo
i_a_st  = 0.111
i_tot_st = i_cl_st + i_a_st / fcl
# relative air velocity and walking speed
if def_speed > 0:
    if def_dir == 1: v_r = |v - walk_sp * cos(3.14159 * theta / 180)|    # unidirectional
    elif v < walk_sp: v_r = walk_sp                                       # omnidirectional
    else:             v_r = v
else:
    walk_sp = min(0.0052 * (M - 58), 0.7)       # estimate; negative if M < 58 (harmless, see 4.7)
    v_r = v
v_ux   = min(v_r, 3)        # (code: if v_r > 3 then 3)
w_a_ux = min(walk_sp, 1.5)
corr_cl = min(1, 1.044 * exp((0.066*v_ux - 0.398)*v_ux + (0.094*w_a_ux - 0.378)*w_a_ux))
corr_ia = min(1, exp((0.047*v_r - 0.472)*v_r + (0.117*w_a_ux - 0.342)*w_a_ux))   # NOTE v_r, not v_ux
corr_tot = (clo <= 0.6) ? ((0.6 - clo)*corr_ia + clo*corr_cl)/0.6 : corr_cl
i_tot_dyn = i_tot_st * corr_tot
i_a_dyn   = corr_ia * i_a_st
i_cl_dyn  = i_tot_dyn - i_a_dyn / fcl
corr_e = (2.6*corr_tot - 6.5)*corr_tot + 4.9
im_dyn = min(i_mst * corr_e, 0.9)
r_t_dyn = i_tot_dyn / im_dyn / 16.7                                       # m2*kPa/W
# respiratory exchanges (W/m2)
t_exp = 28.56 + 0.115*tdb + 0.641*p_a
c_res = 0.001516 * M * (t_exp - tdb)
e_res = 0.00127  * M * (59.34 + 0.53*tdb - 11.63*p_a)
# forced-convection floor
z = (v_r > 1) ? 8.7 * v_r^0.6 : 3.5 + 5.2*v_r
# convective coefficient (see 6.1 for the ISO-faithful 2023 alternative)
if [2004]: hc_dyn = 2.38 * |t_sk_initial - tdb|^0.25       [PYTC: fixed for the whole call]
if [2023]: hc_dyn = 2.38 * |(tr + 0.1) - tdb|^0.25         [PYTC: fixed for the whole call]
hc_dyn = max(hc_dyn, z)
aux_r = 5.67e-8 * a_r_du
f_cl_r = [2023] (1 - a_p)*0.97 + a_p*(1 - f_r)    |    [2004] (1 - a_p)*0.97 + a_p*f_r
t_cr_eq_m = 0.0036 * M + 36.6                    # (MATLAB-2023 uses 0.0036*(M-55)+36.8; diff 0.002 degC)
t_sk_eq_cl_base = 12.165 + 0.02017*tdb + 0.04361*tr + 0.19354*p_a - 0.25315*v + 0.005346*M
t_sk_eq_nu_base = 7.191  + 0.064*tdb   + 0.061*tr   + 0.198*p_a   - 0.348*v
```
Note: the skin-temperature regressions use the air velocity `v`, not `v_r`.

### 4.3 Minute loop

```
for time = 1 .. duration:
    # values at the start of the minute
    t_sk0 = t_sk; t_re0 = t_re; t_cr0 = t_cr; t_cr_eq0 = t_cr_eq; wg0 = t_sk_t_cr_wg

    # core temperature as a function of M, and the heat stored for it
    t_cr_eq     = t_cr_eq0 * exp(-1/10) + t_cr_eq_m * (1 - exp(-1/10))
    d_stored_eq = sp_heat * (t_cr_eq - t_cr_eq0) * (1 - wg0)                  # W/m2 (per minute)

    # steady-state skin temperature (uses t_re at the start of the minute)
    t_sk_eq_cl = t_sk_eq_cl_base + 0.51274 * t_re
    t_sk_eq_nu = t_sk_eq_nu_base + 0.616   * t_re
    if   clo >= 0.6: t_sk_eq = t_sk_eq_cl
    elif clo <= 0.2: t_sk_eq = t_sk_eq_nu
    else:            t_sk_eq = t_sk_eq_nu + 2.5 * (t_sk_eq_cl - t_sk_eq_nu) * (clo - 0.2)

    t_sk = t_sk0 * exp(-1/3) + t_sk_eq * (1 - exp(-1/3))
    if time == 1 and [2023]: t_sk = t_sk_eq          # [2023] minute-1 override (absent in 2004)

    p_sk = 0.6105 * exp(17.27 * t_sk / (t_sk + 237.3))                       # kPa

    # clothing surface temperature: damped fixed point
    t_cl = tr + 0.1
    loop:
        [ISO-faithful 2023 option, 6.1: hc_dyn = max(2.38*|t_cl - tdb|^0.25, z)]
        h_r    = f_cl_r * aux_r * ((t_cl + 273)^4 - (tr + 273)^4) / (t_cl - tr)
        t_cl_n = (fcl*(hc_dyn*tdb + h_r*tr) + t_sk/i_cl_dyn) / (fcl*(hc_dyn + h_r) + 1/i_cl_dyn)
        if |t_cl - t_cl_n| <= 0.001: break            # keep t_cl (OLD iterate) and this h_r
        t_cl = (t_cl + t_cl_n) / 2

    convection = fcl * hc_dyn * (t_cl - tdb)                                 # W/m2 (loss > 0)
    radiation  = fcl * h_r    * (t_cl - tr)                                  # W/m2 (loss > 0)

    e_max = (p_sk - p_a) / r_t_dyn                                           # W/m2
    if e_max == 0: e_max = 0.001                                             [PYTC guard]
    e_req = M - d_stored_eq - W - c_res - e_res - convection - radiation
    w_req = e_req / e_max

    if   e_req <= 0:   e_req = 0; sw_req = 0
    elif e_max <= 0:   e_max = 0; sw_req = sw_max
    elif w_req >= 1.7: sw_req = sw_max                 # (ISO code also sets w_req = 1.7; unused)
    else:
        r_req = (w_req > 1) ? (2 - w_req)^2 / 2 : 1 - w_req^2 / 2
        r_req = max(0.05, r_req)                                             [PYTC floor]
        sw_req = min(e_req / r_req, sw_max)

    # predicted sweat rate (10-min lag) and predicted evaporation
    sweat_rate_watt = sweat_rate_watt * exp(-1/10) + sw_req * (1 - exp(-1/10))
    if sweat_rate_watt <= 0:
        e_p = 0; sweat_rate_watt = 0
    else:
        k  = e_max / max(sweat_rate_watt, 1e-6)                              [PYTC epsilon]
        w_p = (k >= 0.5) ? -k + sqrt(k*k + 2) : 1
        w_p = min(w_p, w_max)
        e_p = w_p * e_max

    d_storage = e_req - e_p + d_stored_eq                                    # W/m2

    # core temperature: implicit in alpha, damped fixed point
    t_cr_new = t_cr0
    loop:
        t_sk_t_cr_wg = clamp(0.3 - 0.09*(t_cr_new - 36.8), 0.1, 0.3)
        t_cr = d_storage/sp_heat + t_sk0*wg0/2 - t_sk*t_sk_t_cr_wg/2
        t_cr = (t_cr + t_cr0*(1 - wg0/2)) / (1 - t_sk_t_cr_wg/2)
        if |t_cr - t_cr_new| <= 0.001: break     # keep this t_cr and the wg computed from t_cr_new
        t_cr_new = (t_cr_new + t_cr) / 2

    # rectal temperature
    t_re = t_re0 + (2*t_cr - 1.962*t_re0 - 1.31) / 9
    if d_lim_t_re == 0 and t_re >= 38: d_lim_t_re = time

    # water loss: sweat plus respiratory evaporation
    evap_load_wm2_min += sweat_rate_watt + e_res
    sw_tot_g = evap_load_wm2_min * 2.67 * a_dubois / 1.8 / 60
    if d_lim_loss_50 == 0 and sw_tot_g >= d_max_50: d_lim_loss_50 = time
    if d_lim_loss_95 == 0 and sw_tot_g >= d_max_95: d_lim_loss_95 = time
```

Physical reading of the core step:
- The body-mean temperature is t_b = (1−α/2)·t_cr + (α/2)·t_sk, where α is the fraction of body mass at skin temperature.
- Each minute, t_b rises by d_storage/sp_heat.
- The t_cr update solves this for t_cr, with α a function of t_cr (0.3 at ≤ 36.8 °C, falling by 0.09 per °C, floor 0.1). The LTH PHS.js comments give the same reading. [S]

### 4.4 After the loop

```
if drink == 0:                         # both editions in pythermalcomfort
    d_lim_loss_95 = d_lim_loss_95 * 0.6        # (= 3 % / 5 %)
    d_lim_loss_50 = d_lim_loss_95
if d_lim_loss_50 == 0: d_lim_loss_50 = duration
if d_lim_loss_95 == 0: d_lim_loss_95 = duration
if d_lim_t_re    == 0: d_lim_t_re    = duration
return t_re, t_sk, t_cr, t_cr_eq, t_sk_t_cr_wg, sweat_rate_watt, evap_load_wm2_min,
       sw_tot_g, d_lim_loss_50, d_lim_loss_95, d_lim_t_re
```
In the 2004 BASIC code (comf transcription), the `DRINK = 0` line sits **inside** the minute loop. It therefore multiplies by 0.6 again every minute after the limit is reached. pythermalcomfort moved it outside the loop, with a source comment saying so. In 2023, pythermalcomfort *also* uses the 3 % threshold, so it applies the 3 % / 5 % reduction twice (see 6.4).

### 4.5 Output assembly (wrapper)

- When `limit_inputs` is true and any check in 4.6 fails, **all** outputs are NaN.
- When `round_output` is true, every output is rounded to 1 dp, except `t_sk_t_cr_wg`, which is rounded to 2 dp.

### 4.6 Applicability limits (ISO 7933 Annex A, Table A.1, as implemented)

| Quantity | 2004 (pythermalcomfort) | 2023 (pythermalcomfort) | Remarks |
|---|---|---|---|
| t_a | 15–50 °C | 15–50 °C | |
| t_r − t_a | 0–60 °C | 0–60 °C | Applies to the difference, not to t_r (issue #225) |
| v_a | 0–3 m/s | 0–3 m/s | The air speed input, not v_r |
| p_a | 0–4.5 kPa | **0.5**–4.5 kPa | |
| M | **100–450 W/m²** | **56–250 W/m²** | [U]. pythermalcomfort derived the 2023 values from "100–450 W" ÷ 1.8 m². jsthermalcomfort instead checks M·A_Du against 100–450 **W** for both editions. The CBE tool docs say "1.7 to 6.8 met". The sources disagree and the printed tables could not be checked |
| I_cl | 0.1–1.0 clo | 0.1–1.0 clo | |

All bounds are inclusive. A web-search snippet attributed this sentence to the prEN ISO 7933 catalogue page: "When one or more parameters are outside this range, this model should be used with care and special attention given to the people exposed." We could not open that page to confirm it [U]. For a safety product, our recommendation is to still compute, but flag the result as "extrapolated" and degrade to conservative advice. Do not silently NaN.

### 4.7 Edge cases and numerical notes for the port

- **Iteration caps.** pythermalcomfort's two `while True` loops have no cap. A NaN input, `weight = 1e-300` or `height = -1` makes them spin forever (issue #524). Add a cap of 1000 iterations (jsthermalcomfort uses 1000) and reject NaN or infinite inputs up front. The maximum observed over all 50 vectors was **17** t_cl iterations and **13** t_cr iterations. [V]
- **Division by zero.** `i_mst = 0` (im_dyn), `height = 0` (a_dubois) and `clo` values that make `i_cl_dyn = 0` all divide by zero. In pythermalcomfort's parallel path these return uninitialised memory (issue #523). Validate: i_mst > 0, height > 0, clo ≥ 0.1.
- **h_r form.** `((t_cl+273)^4 − (tr+273)^4)/(t_cl − tr)` is safe because t_cl starts at tr + 0.1 and converges geometrically (it never becomes exactly tr). The algebraically identical `(a²+b²)(a+b)`, with a = t_cl+273 and b = tr+273, avoids cancellation. It changes results only at the ~1e-13 level. Keep the original form if you want bit-level parity.
- **Negative E_max.** E_max < 0 when p_a > p_sk, i.e. condensation. If E_req > 0, then SW_req = SW_max and E_max is set to 0, which gives E_p = 0. If E_req ≤ 0, E_max stays negative, k < 0.5 gives w_p = 1, and E_p = w_max·E_max < 0, i.e. a heat gain. This branch is unreachable inside the p_a ≤ 4.5 kPa limit at normal skin temperatures.
- **r_req floor.** The 0.05 floor on r_req is active only for 1.6838 < w_req < 1.7, where the ISO code would give 0.045–0.05. It can only matter when E_req/r_req < SW_max, i.e. E_req < ~25 W/m². In practice it has no effect.
- **Walking-speed estimate.** walk_sp = 0.0052·(M − 58) is negative for M < 58. The corrections are then slightly > 1, but `min(…, 1)` caps them. This is harmless.
- **θ = 0 cannot express a tailwind.** θ = 0 means "direction not entered", which selects the omnidirectional rule v_r = max(v, v_w). Use θ = 180 for walking into the wind (v_r = v + v_w).
- **Non-physical t_re after a limit.** t_re keeps rising after a limit is crossed because the model has no physiological ceiling. AD03 reaches t_re = 44.4 °C and AD23 reaches 48.9 °C. Report D_lim and do not display t_re trajectories after the limit as meaningful. The 2023 WARNING [P] also says the model cannot validly predict recovery once t_re ≥ 38 °C.
- **Floating point.** JS and Python both use IEEE-754 doubles. Ulp-level differences in `exp`, `pow` and `sqrt` stay at ~1e-12 after 480 minutes. D_lim can only flip if a threshold crossing sits within ~1e-9 of the limit. Every vector carries `d_lim_margins`; the smallest margin in the fixtures is 1.9e-4 °C (ISO2023-F03, the minute before crossing). Use `inputs.met_wm2` directly: 230/58.15·58.15 is not exactly 230.

---

## 5. ISO 7933:2004 vs ISO 7933:2023: all differences

| # | Item | 2004 | 2023 | Evidence |
|---|---|---|---|---|
| 1 | SW_max | (M−32)·A_Du clamped to [250, 400] W/m², ×1.25 if acclimatized | 400 W/m² not acclimatized, 500 W/m² acclimatized | Foreword [P]: "SW_max described in B.4 has been corrected, i.e. it is no longer adjusted for metabolic rate". Values from MATLAB #217, LTH JS ("SWmax = 400" then ×1.25) and pythermalcomfort [S]. The LSI-Lastem note writes "400 g/h … 500 g/h", which is a units slip; the code is in W/m² |
| 2 | Water-loss criterion | D_max50 = 7.5 % W_b (mean subject) and D_max95 = 5 % W_b (95 %). Outputs Dlimloss50 and Dlimloss95. drink = 0: Dlimloss95 × 0.6 | One D_max: 5 % W_b (drink = 1) or 3 % W_b (drink = 0). Output D_lim,loss only (95 %) | 2023 Table 1 [P] lists only "D_lim,loss allowable exposure time for water loss, 95 % of the working population" and "D_max". 2004 Table 1 [P] lists D_max50 and D_max95. Percentages from code [S] |
| 3 | Rectal-temperature limit name | D_lim tre | D_lim,tcr ("allowable exposure time for heat storage") | Table 1 of both editions [P]. Threshold t_re ≥ 38 °C in every code [S] |
| 4 | Reflective clothing | ε = (1−A_p)·0.97 + A_p·F_r. F_r = "emissivity of the reflective clothing". Default F_r = 0.97, i.e. neutral | ε = (1−A_p)·0.97 + A_p·(1−F_r). F_r = "reflection coefficients for different special materials" | Definitions [P]. Formula from MATLAB #217 and pythermalcomfort [S]. See 6.3 |
| 5 | Convective coefficient | 2.38·\|t_sk − t_a\|^0.25, floor z. The BASIC recomputes it every minute from the current t_sk; pythermalcomfort computes it once from the initial t_sk | 2.38·\|t_cl − t_a\|^0.25, floor z. pythermalcomfort uses t_cl = t_r + 0.1, once | Maintainer's reading of both printed PDFs (#217/#223) [S]. Placement within the loop is [U]. See 6.1 |
| 6 | Skin temperature at minute 1 | exponential lag from t_sk0 | t_sk = t_sk,eq at minute 1 | Maintainer's reading of the 2023 Annex E (fixed in pythermalcomfort v4.4.1) and MATLAB #217 [S] |
| 7 | Clothing area factor | 1 + 0.3·I_cl | 1 + 0.28·I_cl (pythermalcomfort and MATLAB #217) | [U]. The ISO/FDIS-based LTH JS still uses 0.3 |
| 8 | Caution | – | Clause 5 WARNING on unsteady conditions and recovery (verbatim in 11.1) | [P] |
| 9 | Scope / applicability | 2004 Introduction: "not applicable to cases where special protective clothing (reflective clothing, active cooling and ventilation, impermeable, with personal protective equipment) is worn" | 2023 Scope: "not applicable to cases where special protective clothing (e.g. fully reflective clothing, active cooling and ventilation, impermeable coveralls) is worn". Predicts for "an average person"; D_lim protects 95 % of the exposed population | [P] |
| 10 | Annex status | Annex F (examples) **normative** | Annex F **informative**. Annex E (program) informative in both | Tables of contents [P] |
| 11 | Validity limits | M 100–450 (unit see 4.6), p_a 0–4.5 kPa | M 56–250 W/m² (pythermalcomfort), p_a 0.5–4.5 kPa | [S]/[U] |
| 12 | Annex F metabolic-rate unit | W/m² | **W** (e.g. 300 W, converted with A_Du = 1.938 m²) | #217 table [S] |
| 13 | Annex F radiant input | t_r given | globe temperature t_g (D = 0.15 m) converted with the ISO 7726 forced-convection formula | #217 [S]. Our reproduction of the published t_r (52.0, 74.6) confirms 1.1e8, ε_g = 0.95, 273 [V] |
| 14 | pythermalcomfort-only defaults | t_re0 = t_cr0, t_cr_eq0 = t_cr0, p_a from Hyland-Wexler, f_r = 0.97 | t_re0 = t_cr_eq0 = 36.8, p_a from Magnus, **f_r = 0.42** | library [S] |

Practical effect for Abu Dhabi (fixture AD19 vs AD01: sun, 165 W/m², 0.6 clo, acclimatized):
- **2004:** SW_max = 322 W/m², so sweating is capped. Result: t_re(480) = **41.50 °C**, D_lim,tre = **43 min**.
- **2023:** SW_max = 500 W/m². Result: t_re = **37.74 °C**, D_lim,tre not reached in 480 min, D_lim,loss = 190 min.

Item 1 is by far the largest practical change. At 230 W/m², the 2004 SW_max is 479.6 W/m², so the two editions converge (D_lim,tre 35 min in both; AD20 vs AD02). [V]

---

## 6. Where pythermalcomfort deviates from the ISO code transcriptions (and what to do)

### 6.1 `hc` under 2023 (biggest issue)
- **pythermalcomfort:** `hc = max(z, 2.38·|tr + 0.1 − tdb|^0.25)`, computed once before the minute loop.
- **jsthermalcomfort (official JS port):** recomputes `hc = max(z, 2.38·|t_cl − tdb|^0.25)` inside the t_cl iteration.
- **MATLAB #217 and LTH FDIS JS:** `hc = max(z, 2.38·|t_sk − tdb|^0.25)` every minute.

Results against ISO 7933:2023 Annex F [V], published values in brackets:

| Annex F case | t_r (°C) | pythermalcomfort t_re / D_lim,tcr / SW_tot,g | `hc` in t_cl iteration | `hc` from t_sk each minute |
|---|---|---|---|---|
| 3 (t_a 30, t_g 45, 0.1 m/s, 0.8 clo, A_p 0.3, F_r 0.85) | 52.01 [52.0] | 38.20 / 275 / 6148 [38.7 / 149 / 6419] | 38.69 / 151 / 6437 | 38.71 / 149 / 6449 |

In cases 1, 2, 4 and 5, all three choices are identical because `hc = z`. Recommendation:
- Implement `hcMode = "tclIteration"` as the Zill default (ISO-annex-faithful, matches the 2023 formula the maintainer read).
- Keep `"pythermalcomfort"` for parity tests.
- The tcl_iter oracle values are under `variants["reference:hc_tcl_iter"]` for every 2023 vector.
- Robustness: `z ≥ 3.5` and the natural term exceeds z only when |t_cl − t_a| > 4.7 °C, so the non-smooth point of |Δ|^0.25 is never active.

In the 2004 path, pythermalcomfort's "once from the initial t_sk" and the BASIC's "every minute" gave identical results in all 10 Annex F cases, because z dominates.

### 6.2 Body specific heat constant
- pythermalcomfort: 58.15·W_b/A_Du. This is its `met_to_w_m2`, and corresponds to c_p,b = 3489 J/(kg·K).
- 2004 BASIC (comf transcription and LTH PHS.js): **57.83**·W_b/A_Du, i.e. c_p,b = 3470 J/(kg·K).
- MATLAB-2023: 3490/60.

With 57.83, our reference reproduces **all 10 ISO 7933:2004 Annex F cases exactly**: t_re to the published 0.1 °C, every D_lim to the minute, water loss within 0.39 g. With 58.15, pythermalcomfort is within 0.1 °C, 3.0 g and 1 min. [V] For 2023 the printed constant is [U]. Our recommendation: keep 58.15 for parity. The difference is ≤ 3 g and ≤ 1 min.

### 6.3 Reflective-clothing parameters
The 2004 default `f_r = 0.97` makes ε = 0.97 whatever the value of A_p. pythermalcomfort's 2023 default `f_r = 0.42` is the value its `f_r_garments` table lists for "Cotton with aluminium paint", used as a reflection coefficient. Combined with A_p = 0.54, this gives ε_cl,r = 0.759.

pythermalcomfort's own table `f_r_garments` lists "reflection coefficients", for example glossy aluminium foil 0.04–0.19. These look like **emissivities**: plugging 0.04 into the 2023 formula gives ε ≈ 0.96, i.e. "not reflective", which is physically backwards. Under the 2023 formula, a reflective material needs F_r near 1; the Annex F examples use F_r = 0.85. The printed 2023 Annex D table is [U].

**Zill:** `a_p = 0` for every ordinary, coverall and FR ensemble. Reflective PPE is outside the 2023 scope anyway ("fully reflective clothing").

### 6.4 drink = 0
| Path | Threshold | Post-factor | AD15 (sun, 165 W/m², drink = 0) |
|---|---|---|---|
| pythermalcomfort 2023 | 3 % (2250 g) | ×0.6 | **71.4 min** |
| MATLAB 2023 / LTH FDIS JS | 3 % (2250 g) | none | **119 min** (`variants["reference:drink0_threshold_3pct_without_x0.6"]`) |
| pythermalcomfort 2004 (E09) | 5 % (3750 g) | ×0.6 | 145.8 min |

The 2004 ×0.6 rule has a blind spot. If 5 % is never reached within the run, D_lim stays 0 and falls back to `duration`, even when 3 % was crossed. Vector E10 has a total loss of 3647 g < 3750 g, so it reports 480 min. Recommendation for Zill under 2023: use the 3 % threshold directly, with no ×0.6.

### 6.5 Minute-1 override and chaining
The 2023 override is applied at minute 1 of **every call** (section 11). In a continuous simulation it should apply only at the first minute of exposure.

### 6.6 Other pythermalcomfort-only guards
These have no effect on any fixture vector, but port them for parity:
- `e_max == 0 → 0.001`
- `r_req ≥ 0.05`
- `max(sweat_rate_watt, 1e-6)` in k

### 6.7 Could we use jsthermalcomfort directly?
Not as a drop-in. Its `phs.js` (main branch, read 2026-11-09) differs from pythermalcomfort 4.8.1 under 2023 in three ways:
- it re-evaluates `hc` inside the t_cl iteration (the ISO-faithful variant above);
- it has **no** minute-1 skin override;
- it checks the metabolic-rate limit as M·A_Du against 100–450 W.

It would therefore not reproduce the `engine = "pythermalcomfort"` 2023 vectors exactly. Treat it as a second reference, not as the oracle.

---

## 7. ISO reference cases

### 7.1 ISO 7933:2004 Annex F (10 cases, `model = "7933-2004"`)
Published values come from the R `comf` dataset `dfISO7933AppF` [S]. These are the same cases as pythermalcomfort's `ts_phs.json`, which uses rounded RH (e.g. 33.85 %). Our fixtures instead compute RH so that p_a equals the published kPa exactly (e.g. RH = 33.859464 % for 2.5 kPa at 40 °C). Common inputs: 480 min, 75 kg, 1.8 m, drink 1, A_p 0.54, F_r 0.97, i_mst 0.38.

| Case | Accl | Posture | t_a | p_a | t_r | v_a | M | I_cl | θ / v_w | Published t_re / SW_tot,g / D_lim,tre / D50 / D95 | pythermalcomfort 4.8.1 (unrounded) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | yes | std | 40 | 2.5 | 40 | 0.3 | 150 | 0.5 | – | 37.5 / 6168 / 480 / 439 / 298 | 37.522 / 6168.9 / 480 / 439 / 298 |
| 2 | yes | std | 35 | 4.0 | 35 | 0.3 | 150 | 0.5 | – | 39.8 / 6935 / 74 / 385 / 256 | 39.767 / 6937.3 / 74 / 385 / 256 |
| 3 | yes | std | 30 | 3.0 | 50 | 0.3 | 150 | 0.5 | – | 37.7 / 7166 / 480 / 380 / 258 | 37.737 / 7165.8 / 480 / 380 / 258 |
| 4 | no | std | 28 | 3.0 | 58 | 0.3 | 150 | 0.5 | – | 41.2 / 5807 / 57 / 466 / 314 | 41.170 / 5807.3 / 57 / 466 / 314 |
| 5 | no | sit | 35 | 3.0 | 35 | 1.0 | 150 | 0.5 | – | 37.6 / 3892 / 480 / 480 / 463 | 37.571 / 3892.4 / 480 / 480 / 463 |
| 6 | yes | sit | 43 | 3.0 | 43 | 0.3 | 103 | 0.5 | – | 37.3 / 6763 / 480 / 401 / 271 | 37.289 / 6763.5 / 480 / 401 / 271 |
| 7 | no | std | 35 | 3.0 | 35 | 0.3 | 206 | 0.5 | – | 39.2 / 7236 / 70 / 372 / 247 | 39.201 / 7237.9 / 70 / **371** / 247 |
| 8 | no | std | 34 | 3.0 | 34 | 0.3 | 150 | 1.0 | – | 41.0 / 5548 / 67 / 480 / 318 | 41.024 / 5551.0 / 67 / 480 / **317** |
| 9 | yes | std | 40 | 3.0 | 40 | 0.3 | 150 | 0.4 | – | 37.5 / 6684 / 480 / 407 / 276 | 37.470 / 6685.3 / 480 / 407 / 276 |
| 10 | yes | std | 40 | 3.0 | 40 | 0.3 | 150 | 0.4 | 90° / 1.0 | 37.6 / 5379 / 480 / 480 / 339 | 37.550 (numpy rounds to 37.5) / 5380.2 / 480 / 480 / 339 |

Worst |Δ| for pythermalcomfort: t_re 0.1 (rounding), water loss 2.96 g, D_lim 1 min. With `sp_heat = 57.83` the result is exact (6.2). Note that the `ts_phs.json` expected values were generated by an older pythermalcomfort version; for example, case 1 water loss there is 6166.4 g. The fixtures use 4.8.1 outputs.

### 7.2 ISO 7933:2023 Annex F (5 working conditions, `model = "7933-2023"`)
Inputs and published results come from the issue #217 table [S]. Common: 75 kg, 1.8 m, 480 min, drink 1. Metabolic rate in W ÷ A_Du = 1.937871 m². t_r from t_g with ISO 7726 forced convection (D = 0.15 m, ε_g = 0.95). SW_p in g/h = SW_p[W/m²]·2.67·A_Du/1.8.

| WC | Accl | Posture | t_a / t_g / v_a / RH | M (W) | I_cl | A_p / F_r | Published t_r / SW_p g/h / SW_tot g / t_re / D_lim,loss / D_lim,tcr | pythermalcomfort 4.8.1 | `hc` in t_cl iteration |
|---|---|---|---|---|---|---|---|---|---|
| 1 | yes | std | 40/40/0.3/35 | 300 | 0.5 | 0/0 | 40.0 / 813 / 6538 / 37.6 / 280 / – | 40.00 / 816 / 6557 / 37.54 / 281 / – | same |
| 2 | no | std | 35/35/0.1/60 | 300 | 0.5 | 0/0 | 35.0 / 633 / 6345 / 40.8 / 250 / 62 | 35.00 / 633 / 6376 / 40.80 / 252 / 62 | same |
| 3 | no | std | 30/45/0.1/35 | 300 | 0.8 | 0.3/0.85 | 52.0 / 764 / 6419 / 38.7 / 280 / 149 | 52.01 / 742 / 6148 / **38.20** / 296 / **275** | 52.01 / 765 / 6437 / 38.69 / 281 / 151 |
| 4 | no | std | 30/30/1.0/45 | 450 | 0.5 | 0/0 | 30.0 / 547 / 4593 / 38.0 / 400 / – | 30.00 / 544 / 4573 / 37.95 / 397 / – | same |
| 5 | yes | sit | 35/50/1.0/30 | 250 | 1.0 | 0.2/0.85 | 74.6 / 718 / 5813 / 37.5 / 310 / – | 74.57 / 721 / 5844 / 37.51 / 313 / – | same |

Residual differences of up to about 0.5 % in water loss and 3 min in D_lim,loss remain, even where `hc` plays no role. They are not explained by any variant we tried:
- sp_heat 57.83 / 58.15 / 3490/60
- Magnus vs Hyland-Wexler p_a
- with or without the minute-1 override
- t_cr,eq = 0.0036(M−55)+36.8

The MATLAB author in #217 reports the same residuals. Treat them as the irreducible tolerance of this annex. Tolerances in pythermalcomfort's own CI for these cases are rel 2.5 % (water), 0.3 °C and 10 min.

Note on pythermalcomfort's 2023 tests:
- Case 3 is marked xfail with t_r = 54.2. That value looks like the natural-convection globe formula; the forced formula gives 52.0.
- Cases 1, 2 and 4 are run with the reflective defaults (A_p 0.54, F_r 0.42), whereas the annex uses A_p = 0.

Our fixtures use the annex inputs.

---

## 8. Oracle fixtures (`fixtures/phs.json`)

Regenerate with:

```
"<venv>\Scripts\python.exe" scripts\oracles\phs_oracle.py
```

Run time is about 2 s once numba has compiled; the first run takes about 8 s.

Before writing, the script asserts:
- reference implementation == pythermalcomfort to a relative difference < 1e-9 for every vector and every chain;
- the ISO 2004 annex is reproduced within 0.1 °C, 10 g and 1 min, and exactly with sp_heat 57.83 (6.2);
- recommended-semantics chaining equals a single call for constant conditions, including absolute D_lim.

### 8.1 Top-level schema (`schema_version` 1.0.0)
| Key | Content |
|---|---|
| `environment` | python, numpy, pythermalcomfort, thermofeel and platform versions |
| `units` | units of every input and output field |
| `conventions` | meaning of `outputs` vs `outputs_rounded_pythermalcomfort`, `validity`, `variants`, and recommended port tolerances |
| `self_checks` | max reference-vs-pythermalcomfort relative difference (5.24e-15), ISO 2004 worst deviations for pythermalcomfort and for sp_heat 57.83, max iterations (17 for t_cl, 13 for t_cr) |
| `pythermalcomfort_4_8_1_defaults` | default kwargs per edition |
| `chaining_state_variables` | the 7 state keys |
| `vectors[]` | single runs (8.2) |
| `chains[]` | piecewise runs (section 11) |
| `traces[]` | per-minute intermediates for `ISO2004-F01` and `AD01`, 480 rows each, 12 significant digits. Fields: minute, t_cr_eq, d_stored_eq, t_sk_eq, t_sk, p_sk, hc_dyn, t_cl, h_r, convection, radiation, e_max, e_req, w_req, sw_req, sweat_rate_watt, w_p, e_p, d_storage, t_sk_t_cr_wg, t_cr, t_re, evap_load_wm2_min, sweat_loss_g |
| `mrt_from_globe` | section 10 examples |

### 8.2 Vector record
Each vector contains:
- `id` and `group`. Groups: `iso_7933_2004_annex_f` (10), `iso_7933_2023_annex_f` (5), `abu_dhabi` (23), `edge` (12).
- `description` and `engine` (`"pythermalcomfort"`).
- `inputs`: **every** pythermalcomfort argument written out explicitly (no hidden defaults), plus engine-native `met_wm2`, `wme_wm2` and `p_a_kpa`.
- `outputs`: unrounded.
- `outputs_rounded_pythermalcomfort`.
- `validity`: `failing[]`, `within_limits`, and `pythermalcomfort_limit_inputs_true_returns_null`.
- `derived`: every per-run constant from 4.2, plus max iterations. Use it to unit-test the pre-loop block.
- `d_lim_margins`: the threshold distance at the crossing minute and the minute before.
- `variants` (2023 only):
  - `reference:hc_tcl_iter`;
  - `reference:drink0_threshold_3pct_without_x0.6` when drink = 0.
- For 2004 annex vectors: `variants["reference:sp_heat_57.83_(2004_BASIC)"]`.
- For ISO vectors: `iso_published` and `delta_vs_iso_published`.

All vectors are run with `limit_inputs = False`. The validity flags say what `limit_inputs = True` would have done. Recommended port tolerances: temperatures 1e-6 °C, α 1e-8, SW 1e-6 W/m², water 1e-4 g, D_lim exact.

### 8.3 Abu Dhabi scenarios (2023 unless noted)
Common inputs:
- conditions: sun = t_a 44, t_r 60, RH 20 % (p_a 1.819 kPa), v 0.5; shade = t_r 44;
- clothing: a_p 0, i_mst 0.38;
- subject: 75 kg, 1.8 m, drink 1, standing;
- initial state at the defaults.

These are design scenarios for testing, not measurements.

| ID | Case | t_re end | D_lim,tre | D_lim,loss | Water (g) | Validity |
|---|---|---|---|---|---|---|
| AD01 | 165 W/m², 0.6 clo, 480 min | 37.74 | – | 190 | 9913 | ok |
| AD02 | 230 W/m², 0.6 clo, 480 | 39.88 | **35** | 163 | 11632 | ok |
| AD03 | 290 W/m², 0.6 clo, 480 | 44.38 (non-physical) | 22 | 160 | 11774 | **M > 250** |
| AD04 | 165, coveralls 1.0 clo, 480 | 38.28 | 186 | 166 | 11319 | ok |
| AD05 | 230, 1.0 clo, **not acclimatized**, 120 | 40.61 | 29 | – | 2214 | ok |
| AD06 | 230, 0.6 clo, not acclimatized, 120 | 39.92 | 27 | – | 2210 | ok |
| AD07 | 165, walking 1.0 m/s, θ = 0 (v_r = 1.0), 120 | 37.96 | – | – | 1749 | ok |
| AD08 | 165, walking 1.0 m/s, θ = 90 (v_r = 0.4999987), 120 | 37.85 | – | – | 1947 | ok |
| AD09 | 165, 60 min | 37.73 | – | – | 1002 | ok |
| AD10 | 100 W/m², 480 | 37.37 | – | 244 | 7555 | ok |
| AD11 | rest 65 W/m², sitting, shade, 60 | 37.21 | – | – | 375 | ok |
| AD12 | t_a 48, t_r 70, RH 15, 230, 120 | 40.29 | 25 | – | 2751 | ok |
| AD13 | t_a 36, t_r 50, RH 60, 230, 480 | 41.79 | 35 | 164 | 11501 | ok |
| AD14 | v 0.2 m/s, 230, 480 (`hc`-sensitive) | 43.17 (tcl: 43.19) | 31 | 161 | 11672 | ok |
| AD15 | drink 0, 165, 480 | 37.74 | – | 71.4 (no-×0.6: 119) | 9913 | ok |
| AD16 | 62 kg / 1.68 m, 230, 480 | 39.92 | 32 | 154 (D_max 3100 g) | 10210 | ok |
| AD17 | 230, coveralls 1.0 clo, 480 | 41.88 | 36 | 162 | 11655 | ok |
| AD18 | AD02 with the **reflective defaults** a_p 0.54 / f_r 0.42 | 38.76 | 43 | 164 | 11599 | ok |
| AD19–22 | AD01, 02, 04, 06 under 2004 | 41.50 / 40.39 / 42.03 / 40.16 | 43 / 35 / 47 / 26 | 243 / 168 / 243 / – | | ok |
| AD23 | AD17 with i_mst 0.25 (sensitivity only) | 48.9 (non-physical) | 24 | 161 | 11683 | ok |

"–" means not reached within the run; pythermalcomfort then returns `duration`. The edge vectors E01–E12 cover:
- E_req ≤ 0 (no sweating);
- nude branch (0.15 clo);
- crouching;
- θ = 180;
- w_req ≥ 1.7;
- v = 2 m/s (z = 8.7·v^0.6);
- the 1-minute runs that show the 2023 minute-1 override (E07: t_sk 20 → 34.92) vs the 2004 lag (E08: 24.23);
- drink = 0 under 2004 (E09, E10);
- a carried-over warm start (E11);
- wme ≠ 0 (E12).

---

## 9. Converting Zill inputs to PHS inputs

### 9.1 Workload classes (ISO 8996 classification)

| Zill class | M [W/m²] | `met` for pythermalcomfort (÷58.15) | Absolute W for 75 kg / 1.80 m (×1.9379 m²) | Inside the 2023 limit (56–250 W/m², pythermalcomfort)? | Default walk_sp estimate (0.0052·(M−58), cap 0.7) |
|---|---|---|---|---|---|
| Resting | 65 | 1.1178 | 126 W | yes | 0.036 m/s |
| Low | 100 | 1.7197 | 194 W | yes | 0.218 m/s |
| Moderate | 165 | 2.8375 | 320 W | yes | 0.556 m/s |
| High | 230 | 3.9553 | 446 W | yes (just below 450 W if the limit is really in W) | 0.700 m/s |
| Very high | 290 | 4.9871 | 562 W | **no**. Flag as extrapolation | 0.700 m/s |

Rules:
- PHS M is per m² of DuBois area [P, Table 1 of both editions: "M metabolic rate W·m⁻²"]. If a source gives total watts, divide by the worker's own A_Du, not by 1.8. The 2023 Annex F gives M in W.
- `wme = 0` unless external work is significant [P: "In most industrial situations, the effective mechanical power is small and can be ignored, i.e. W = 0"].
- Posture: standing for most site work, crouching for floor-level tasks, sitting for drivers, operators and rest.
- Walking at a known speed: pass `walk_sp` (m/s) and θ.
  - θ = 0 selects the omnidirectional rule v_r = max(v, v_w).
  - θ = 180 is walking into the wind.
  - Walking does **not** add metabolic cost inside PHS. Include it in M.
- The class values 65/100/165/230/290 W/m² are the ISO 8996 class means as supplied by the team. We checked them only against a secondary source quoting the ISO 8996 classification; the ISO 8996:2021 tables are [U].

### 9.2 Clothing ensembles

| Ensemble | `clo` (I_cl, static) | `i_mst` | `a_p` / `f_r` | Basis and caveats |
|---|---|---|---|---|
| Light work clothes (shirt + trousers + underwear + socks + shoes) | **0.6** (0.57 short sleeves, 0.61 long sleeves) | 0.38 | 0 / – | pythermalcomfort `clo_typical_ensembles`: "Trousers, short-sleeve shirt, socks, shoes, underwear: 0.57"; "Trousers, long-sleeve shirt: 0.61" (ASHRAE 55 values) [S] |
| Coveralls over underwear | ≈ 0.6 (garment 0.49 + underwear 0.04 + socks 0.02–0.03 + shoes 0.02) | 0.38 | 0 / – | pythermalcomfort `clo_individual_garments` "Coveralls: 0.49", added by the ASHRAE summation rule [S] |
| Coveralls over work clothes | **≈ 1.0** (upper validity bound) | 0.38 | 0 / – | Simple garment summation gives ≈ 0.61 + 0.49 = 1.1 clo, which is above the 1.0 clo validity limit. Use 1.0 and flag the run as at or above the limit. Prefer a measured ensemble value |
| FR coveralls (cotton-FR, aramid) | as for coveralls, 0.6–1.0 depending on what is worn under them | 0.38 unless measured | 0 / – (non-aluminised FR is not reflective) | No verified ISO 9920 value for FR fabrics was found [U]. Prefer manikin data (ASTM F1291 for I_cl, ASTM F2370 for R_et → i_m). AD23 shows the sensitivity: i_mst 0.38 → 0.25 shortens D_lim,tre from 36 to 24 min |
| Aluminised or reflective PPE | – | – | – | Outside the 2023 scope ("fully reflective clothing") [P] |
| Vapour-barrier, impermeable or encapsulating suits | **do not run PHS** | – | – | Outside the scope of both editions [P]: "impermeable coveralls". In the dynamic correction, i_m·Corr_E can reach the 0.9 cap and does not represent impermeable layers. Fall back to WBGT with clothing adjustment values (ISO 7243 / ACGIH; values not reproduced here) and/or physiological monitoring |

Clothing above 1.0 clo is outside the validated range. The dynamic corrections (Corr_cl, Corr_Ia, Corr_E) are internal; always pass **static** clo.

---

## 10. Mean radiant temperature for PHS from a globe temperature

### 10.1 ISO 7726 globe equations, and how they depend on diameter
The ISO 7726 forced-convection form (pythermalcomfort `mean_radiant_tmp(..., standard="ISO")` [S]; the original standard is paywalled) is:

```
h_cg,forced  = 6.3 * v_a^0.6 / D^0.4                   [W/m2K]
h_cg,natural = 1.4 * (|t_g - t_a| / D)^0.25
t_r = [ (t_g + 273)^4 + h_cg / (eps_g * sigma) * (t_g - t_a) ]^0.25 - 273
    # forced form written with constants: (t_g+273)^4 + 1.1e8 * v_a^0.6 / (eps_g * D^0.4) * (t_g - t_a)
```
Here 1.1e8 ≈ 6.3/5.67e-8. ISO practice takes the larger of the two h values (pythermalcomfort does). The ISO 7933:2023 Annex F used the forced form with D = 0.15 m, ε_g = 0.95, 1.1e8 and 273. Our recomputation of the published t_r values (52.0 and 74.6) confirms this [V].

Diameter dependence: the convective term scales as D^−0.4. Going from a 0.15 m globe to a **2-inch (0.0508 m)** globe multiplies it by (0.15/0.0508)^0.4 = **1.5420**. The constant becomes:
- 1.1e8/(0.95·0.0508^0.4) = **3.81e8**, versus 2.47e8 for D = 0.15 m.

### 10.2 What `thermofeel.calculate_mrt_from_bgt` assumes (read from the source)
`f = 1.1e8·v^0.6/(0.95·0.15^0.4)`, so it assumes **D = 0.15 m** and ε_g = 0.95. It uses Kelvin inputs. The wind argument is documented as **10 m wind** and is rescaled internally to 1.1 m with `scale_windspeed(va, 1.1)`, a log law with z0 = 0.01 m: factor log10(110)/3 = 0.6805.

By contrast, thermofeel's Liljegren solver (`liljegren.py`) models a **0.0508 m** globe:
- ε_g 0.95, albedo 0.05;
- convection h = Nu·k/D with Nu = 2 + 0.6·Re^0.5·Pr^0.3333;
- Re floored at a speed of 0.13 m/s;
- 2 m wind;
- iteration tolerance 0.02 K.

`calculate_mrt_from_bgt` is therefore not the inverse of the Liljegren globe.

### 10.3 Numerical comparison (fixture `mrt_from_globe`, Liljegren globe solved by thermofeel)

Conditions: t_a 44 °C, RH 20 %, 950 W/m², direct-beam fraction 0.85, cos z 0.95, 1005 hPa.

| 2 m wind | t_g (2-inch) | Globe MRT actually forced in the model | (a) Invert with Liljegren h, **recommended** | (b) ISO forced, D = 0.0508 | (c) ISO max(nat, forced), D = 0.0508 | (d) ISO forced, D = 0.15 (wrong) | (e) `calculate_mrt_from_bgt` with 2 m wind (wrong) | (g) Human MRT, same radiation (Di Napoli 2020) |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 66.63 | 94.33 | 94.35 | 98.22 | 98.50 | 88.04 | 83.93 | 74.07 |
| 1.0 | 62.54 | 94.33 | 94.36 | 101.82 | 102.16 | 89.44 | 84.37 | 74.07 |
| 2.0 | 58.73 | 94.33 | 94.37 | 105.92 | 106.32 | 91.37 | 85.34 | 74.07 |

Reading:
1. If t_g comes from the **Liljegren model**, recover MRT by inverting the Liljegren balance with its own h:

   ```
   T_mrt^4 = T_g^4 + h_sphere(T_ref, p, v) / (sigma * eps_g) * (T_g - T_a)
   ```

   with σ = 5.6696e-8, ε_g = 0.95, D = 0.0508 and T_ref = (T_g + T_a)/2 in K. This returns the model's radiative forcing to within 0.04 °C. The ISO formula at the correct diameter over-reads by 4–12 °C, because ISO's h at D = 0.0508 m is 13.7–31.4 W/m²K versus Liljegren's 11.7–22.3. The wrong diameter or the thermofeel function under-reads by 3–10 °C.
2. **Simpler and better:** skip the globe and compute the globe MRT straight from the radiation the Liljegren model already uses:

   ```
   T_mrt,g^4 = 0.5*(eps_a*T_a^4 + eps_sfc*T_sfc^4) + S*(1 - a_g)/(2*sigma*eps_g) * (f_dir*(1/(2 cos z) - 1) + 1 + a_sfc)
   ```

3. A black-globe MRT is not a **human** MRT. In the same radiation field, a standing person (shortwave absorptivity 0.7, projected-area factor; thermofeel `calculate_mean_radiant_temperature`, Di Napoli et al. 2020) has MRT ≈ **74 °C**, against 94 °C for the black globe. PHS needs the human MRT. The PHS validity also caps t_r − t_a at 60 °C. Recommendation: feed PHS the human MRT computed from the radiation components; the radiation inputs are the MRT research task's call. Use globe inversion only when a measured globe is all you have, and then use the diameter-specific formula (and ideally a field calibration, since small globes are biased in sun; pythermalcomfort's docstring cites Teitelbaum et al. 2022 on ping-pong-ball globes).
4. Air speed for PHS: v_a is the air speed at the body. Use the 2 m wind (or the 1.1 m wind), never the raw 10 m wind.

---

## 11. Piecewise simulation across a shift

### 11.1 What the standard says
ISO 7933:2023 clause 5 [P], verbatim:

> "WARNING — The model has not been extensively validated for conditions with unsteady environmental parameters, metabolic rate and/or clothing and therefore must be used cautiously in cases where these parameters vary substantially with time. It does not enable users to determine validly the duration of time needed for an average person whose rectal temperature has risen to 38 °C or more to recover a rectal temperature of 36,8 °C."

The Annex E programs read the "primary parameters" inside the minute loop. The comf transcription notes they were "originally in the for loop", and the LTH JS recomputes the step constants whenever a parameter changes. The reference program is therefore designed for minute-by-minute variable conditions with a continuous state [S].

### 11.2 Does pythermalcomfort carry state between calls?
Yes. Since the `evap_load_wm2_min` / `sweat_rate_watt` API was added, which is present in 4.8.1, the following **7 state variables** fully define the continuous state. Pass them from one call's output to the next call's kwargs with `round_output=False`:

| State | Unit | Note |
|---|---|---|
| `t_sk` | °C | also sets the 2004 `hc` for the next call |
| `t_cr` | °C | |
| `t_re` | °C | |
| `t_cr_eq` | °C | |
| `t_sk_t_cr_wg` | – | α |
| `sweat_rate_watt` | W/m² | SW_p, which carries the 10-min sweating lag |
| `evap_load_wm2_min` | W·min/m² | cumulative water-loss load. `sweat_loss_g` is derived from it |

**Not** carried, so the engine must track them:
- elapsed shift minutes;
- whether and when t_re ≥ 38 °C and water loss ≥ D_max were first reached;
- the 2023 "exposure has started" flag.

Pitfalls of chaining with pythermalcomfort [V]:
1. `d_lim_*` restart at each call and fall back to that call's `duration`. In the work/rest example, segment 2 returns `d_lim_t_re = 1.0` (already above 38) and `d_lim_loss_95 = 15.0` (not reached).
2. **2023:** the minute-1 override is re-applied at the first minute of every call. Chained ≠ continuous:
   - constant conditions, 2×60 vs 120 min: t_re differs by −2.85e-4 °C;
   - work/rest: +0.035 °C after the first rest and +0.049 °C at 150 min.

   2004 chaining is exact (Δ = 0).
3. drink = 0: ×0.6 is applied per call to call-relative minutes.
4. 2004 `hc` is evaluated from the t_sk at the start of the call. No effect when z dominates.

### 11.3 Worked example (fixture `chains`, sun AD02 inputs; rest in shade)
Shift: [work 60 min: t_a 44, t_r 60, RH 20, v 0.5, 230 W/m², standing, 0.6 clo] → [rest 15 min: t_r 44, 65 W/m², sitting] → work 60 → rest 15. Model 2023.

| Segment end (min) | pythermalcomfort chained t_re / t_sk / water (g) | Recommended continuous t_re / t_sk / water (g) |
|---|---|---|
| 60 (work) | 38.268 / 36.729 / 1211.0 | 38.268 / 36.729 / 1211.0 |
| 75 (rest) | 38.068 / 35.109 / 1518.6 | 38.033 / 35.099 / 1508.9 |
| 135 (work) | 38.665 / 36.937 / 2876.2 | 38.649 / 36.928 / 2871.0 |
| 150 (rest) | 38.419 / 35.292 / 3183.5 | 38.371 / 35.276 / 3169.1 |

Recommended continuous run (minute-1 override at shift start only, absolute limits):
- t_re first reaches **38 °C at minute 35**, in the first work bout;
- the 5 % water-loss limit (3750 g) is not reached in 150 min;
- maximum t_re is 38.651 °C;
- t_re every 15 min: 37.521, 37.926, 38.122, 38.268, 38.033, 38.175, 38.399, 38.538, 38.649, 38.371.

Comparators:
- Continuous work without rest, 150 min: t_re 38.90 °C, 3444 g.
- A single call with time-weighted-average inputs (M 197 W/m², t_r 56.8 °C): t_re 37.91 °C and D_lim **not reached**. TWA averaging hides the 38 °C exceedance and is not conservative. Do not use it. ISO 7933 does not prescribe it.

Under 2004 the chained and continuous runs are identical: t_re 38.526 °C at 150 min, first ≥ 38 °C at minute 35.

The fixture also contains `CHAIN-A-*`: one 120-min call vs 2×60. The script asserts that the recommended continuous semantics equal the single call, including absolute D_lim.

### 11.4 Recommended engine design
```
state = {t_sk:34.1, t_cr:36.8, t_re:36.8, t_cr_eq:36.8, wg:0.3, sw_p:0, evap_load:0,
         minute:0, t_re_limit_minute:null, loss_limit_minute:null}
for each segment (or each minute) with conditions c:
    K = precompute(c, subject)          # section 4.2: everything that depends only on c
    repeat c.duration times:
        state = step(state, c, K, minute1Override = (model==2023 && state.minute==0))
        state.minute += 1
        if state.t_re >= 38 and t_re_limit_minute is null: t_re_limit_minute = state.minute
        if water_g(state) >= D_max and loss_limit_minute is null: loss_limit_minute = state.minute
```
- Report D_lim as absolute minutes from shift start, or "not reached".
- Under 2023 with drink = 0, use the 3 % threshold without ×0.6 (6.4).
- Treat any prediction of cooling during rest after t_re ≥ 38 °C as **not validated**. Do not let rest periods "earn back" exposure time unless clinically reviewed.
- When conditions change hourly, recompute K per hour. The minute loop itself is unchanged.

---

## 12. Open items (UNVERIFIED) and what we tried

1. **Printed Table A.1 metabolic-rate limits** (W or W/m²; 2004 vs 2023). Tried: ISO, NSAI and iTeh previews (they stop before Annex A), the CBE docs ("1.7 to 6.8 met"), pythermalcomfort #225, jsthermalcomfort. Still unresolved.
2. **Placement of the 2023 `hc`** (once vs inside the iteration) and **f_cl = 1 + 0.28·I_cl**. The maintainer read the printed PDF for the formula only. Our Annex F case 3 test supports "inside the iteration".
3. **2023 Annex D reflection-coefficient table and the meaning of F_r.** See 6.3.
4. **2023 Annex F values** come from the issue #217 table, not from the PDF. **2004 Annex F values** come from the `comf` dataset, not from the PDF. pythermalcomfort's reproduction of both supports them.
5. **ISO 7726 formulas** come from the pythermalcomfort implementation and our reproduction of the ISO 7933:2023 Annex F t_r values, not from ISO 7726 itself.
6. **Clothing values for FR coveralls and their i_m.** No verified source found. Use manikin data.
7. **Origin of the ~0.5 % residual between every implementation and the 2023 Annex F.** Unexplained (7.2).

---

## 13. References
- ISO 7933:2023, *Ergonomics of the thermal environment — Analytical determination and interpretation of heat stress using calculation of the predicted heat strain*, 3rd ed., ISO, Geneva, 2023-07. Free previews: https://i2.saiglobal.com/mpc2v/preview/1286994572502.pdf?sku=864072_SAIG_NSAI_NSAI_3318355 (NSAI) and https://cdn.standards.iteh.ai/samples/78240/548d42efc3624279b143a0fc88770868/ISO-7933-2023.pdf (iTeh). Full text paywalled.
- ISO 7933:2004, 2nd ed., 2004-08-15. Preview: https://cdn.standards.iteh.ai/samples/37600/3e30c84e89c74eb58490bd6ad84256cc/ISO-7933-2004.pdf. Full text paywalled.
- pythermalcomfort 4.8.1 source, `pythermalcomfort/models/phs.py`. Repository: https://github.com/pythermalcomfort/pythermalcomfort (tests: `tests/test_phs.py`). Issues and discussions: #217 https://github.com/pythermalcomfort/pythermalcomfort/issues/217, #223 https://github.com/pythermalcomfort/pythermalcomfort/discussions/223, #225, #523, #524.
- Validation table: https://raw.githubusercontent.com/FedericoTartarini/validation-data-comfort-models/v1.1.0/ts_phs.json
- jsthermalcomfort `src/models/phs.js`: https://github.com/FedericoTartarini/jsthermalcomfort
- R package comf, `calcIso7933.R` and `dfISO7933AppF`: https://github.com/cran/comf
- PHS.js (ISO/FDIS 7933 Annex E-based), linked from Lund University climate-lab tools: https://gunteralce.github.io/phs/ ; https://www.design.lth.se/english/the-department/research-laboratories/aerosol-climate-laboratory/climate/tools/
- LSI-Lastem, "Update of the GIDAS TEA: compliance with the new ISO 7933:2023 standard": https://www.lsi-lastem.com/wp-content/uploads/GIDAS-TEA_-compliance-with-the-new-ISO-7933_2023-standard.pdf
- thermofeel 2.3.0 (ECMWF), `thermofeel.py` (`calculate_mrt_from_bgt`, `calculate_mean_radiant_temperature`) and `liljegren.py`. Liljegren J.C. et al. (2008) J. Occup. Environ. Hyg. 5:645–655, doi:10.1080/15459620802310770. Di Napoli C. et al. (2020) Int. J. Biometeorol., doi:10.1007/s00484-020-01900-5.
- Malchaire J. et al. (2001) "Development and validation of the predicted heat strain model", Ann. Occup. Hyg. 45(2):123–135 (background; not used for numbers).
- Huang Q., Li J. (2020) "The Effects of the Dynamic Thermophysical Properties of Clothing and the Walking Speed Input Parameter on the Heat Strain of a Human Body Predicted by the PHS Model", Int. J. Environ. Res. Public Health 17(18):6475, doi:10.3390/ijerph17186475, https://pmc.ncbi.nlm.nih.gov/articles/PMC7558563/ (secondary confirmation of the Corr_tot and Corr_Ia exponent forms; 1.044 = e^0.043).
