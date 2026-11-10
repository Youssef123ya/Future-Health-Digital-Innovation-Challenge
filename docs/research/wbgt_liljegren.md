# Liljegren (2008) outdoor WBGT: port-ready specification for the Zill engine

*Zill (ظل) heat-strain early-warning platform. Challenge 07, Climate-Resilient Worker Health. Research note, 2026-11-09.*

**What this is.** A transcription-grade specification of the Liljegren et al. (2008) WBGT model, as implemented in
thermofeel 2.3.0 (our oracle) and in Liljegren's original C code. It covers the Open-Meteo input mapping, oracle test
vectors (`fixtures/wbgt_liljegren.json`, produced by `scripts/oracles/wbgt_liljegren_oracle.py`), and the verification
evidence. All numbers below were produced or checked in this session unless they are marked **UNVERIFIED** or
**secondary**.

---

## 0. Decisions for the TypeScript engine (summary)

| # | Decision | Value / rule |
|---|---|---|
| D1 | Physics core | Port thermofeel's `liljegren.py` exactly. It equals Liljegren's `wbgt.c` to ≤ 2.2e-12 °C in float64 (§15.1). |
| D2 | Solver | Damped fixed point: `x ← 0.9·x + 0.1·F(x)`. Stop when `|F(x) − x| < 0.02 K` and return `F(x)`. **MAX_ITER = 500**, not the C's 50. If it fails to converge, use a bisection fallback and set a flag (§7.4). |
| D3 | Combination | Outdoor (sun): `WBGT = 0.7·Tnwb + 0.2·Tg + 0.1·Ta`. Shade: run the model with GHI = 0, then `0.7·Tnwb + 0.3·Tg` (§9). |
| D4 | Solar geometry | NOAA Solar Calculator algorithm, using the **apparent** (refraction-corrected) zenith. It agrees with pvlib SPA to ≤ 0.016° zenith over 2025 (§10). |
| D5 | Hour-mean radiation | Open-Meteo radiation is the mean over (t−1 h, t], so evaluate the zenith at **t − 30 min** (the C code's own convention). If cos z < 0.00873, set fdir = 0 (§13.3). |
| D6 | Direct fraction | Use Liljegren's formula: `S* = min(GHI/TOA, 0.85)`, `GHI_used = S*·TOA`, `fdir = clamp(exp(3 − 1.34 S* − 1.65/S*), 0, 0.9)`. Use Open-Meteo's direct/GHI ratio only as a sensitivity check (§11). |
| D7 | Wind | Floor the 10 m wind at 0.62 m/s (thermofeel/KNMI). Convert to 2 m with the urban stability-class power law. Internal floor is 0.13 m/s (§12). |
| D8 | Humidity | Compute RH from `dew_point_2m` with Liljegren's esat. Clamp RH to [1, 100] %; RH = 0 gives NaN (§13.2). |
| D9 | BoM formula | Use it for display and comparison only, **never for risk decisions**. In Abu Dhabi data it overestimates by up to about 7 °C, worst at night (§17). |
| D10 | Tests | Exact port: tolerance 1e-6 °C against the fixtures. Different solver: 0.03 °C. Solar port against SPA: cos z within 5e-4 (§16). |

---

## 1. Sources and provenance

| Source | Status in this session |
|---|---|
| Liljegren JC, Carhart RA, Lawday P, Tschopp S, Sharp R. *Modeling the wet bulb globe temperature using standard meteorological measurements.* J Occup Environ Hyg 2008;5(10):645-655. doi:10.1080/15459620802310770, PMID 18668404 | **Paywalled**: Taylor & Francis returned HTTP 403, and Semantic Scholar lists it as `CLOSED`. Only the PubMed abstract was read (quoted below). Paper equation numbers and tables are **UNVERIFIED**. |
| Liljegren's C code, *WBGT, Version 1.1*, © 2008 UChicago Argonne LLC (`wbgt.c.original` in github.com/mdljts/wbgt) | Read in full. SHA-256 of the file read: `1bd6bd3a8365225dc9f872e8674c5f76b6fcd62a6edda08df087010e44617d90`. The mirror's `wbgt.c` differs only by float→double, ANSI prototypes and no `main()`. |
| thermofeel 2.3.0 (ECMWF), `thermofeel/liljegren.py` and `thermofeel.py` | Read in full and executed (oracle). |
| OSHA Outdoor WBGT Calculator (JavaScript port of the C by A. Tustin, OSHA, 2017) | Source read, not executed. Constants and logic match the C. |
| PyWBGT (Kong & Huber, Cython), HeatStress R package (Casanueva; Lemke VBA lineage) | Source read. Used for documenting differences. |
| Kong Q, Huber M. Earth's Future 2022, doi:10.1029/2021EF002334 | **Not accessed** (Wiley and ESSOAr returned 403). Their method is documented here from their public code. |
| Kong Q, Huber M. GeoHealth 2024, doi:10.1029/2024GH001068 (PMC11439757) | Read (open access). |
| Lemke B, Kjellstrom T. Ind Health 2012;50:267-278 | Read (open access). Figures 1–4 digitized for §15.4. |
| EPA-454/R-99-005 (2000), *Meteorological Monitoring Guidance for Regulatory Modeling Applications*, §6.2.5 and Tables 6-2 and 6-7 | Read. Primary source for the wind tables. |
| Open-Meteo docs and `Zensun.swift` (open-meteo GitHub) | Read. |
| Australian BoM thermal-stress page | Read; text quoted verbatim in §17. |
| NOAA GML Solar Calculator details page | Read. Equations follow the NOAA spreadsheet (after Meeus); our port is verified against SPA (§10). |

Abstract (PubMed, verbatim excerpt): the model "is composed of separate submodels of the natural wet bulb and globe
temperatures that are based on fundamental principles of heat and mass transfer, has no site-dependent parameters, and
achieves an accuracy of better than 1 degree C based on comparisons with wet bulb globe temperature measurements at all
depots."

Lemke & Kjellstrom 2012 (secondary, about Liljegren's validation): "the difference between the two varied by less than
1°C for 95% of the time, except in some locations where they attributed the difference to equipment problems."

**Not done:** compiling and running the original C. This was blocked by the session's permission policy. Equivalence
was instead established against an independent line-by-line Python transliteration of the C, written for this work and
embedded in the oracle script, and against the OSHA JS port by reading it.

---

## 2. Model overview

Two steady-state sensor energy balances are solved by fixed-point iteration, then combined:

* **Globe** (black sphere, D = 0.0508 m, i.e. a 2-inch globe, not the 150 mm ISO globe; see §18). It absorbs half-sky longwave from the sky
  (emissivity ε_a) and half from the ground (at T_sfc = T_a). It absorbs shortwave (direct, diffuse and
  ground-reflected) and loses heat by longwave emission and forced convection.
* **Natural wet bulb** (wetted wick, a cylinder D = 7 mm, L = 25.4 mm). Same radiation environment plus evaporative
  cooling. Mass transfer follows the Chilton–Colburn analogy with exponent 0.56 (Bedingfield & Drew).
* **Psychrometric wet bulb**: the wick equation with radiation switched off (`rad = 0`).
* **WBGT_outdoor** = 0.7 Tnwb + 0.2 Tg + 0.1 Ta.

## 3. Inputs and units

| Symbol | Meaning | Unit | Notes |
|---|---|---|---|
| Ta | air temperature at 2 m | °C (K internally: `tk = Ta + 273.15`) | |
| RH | relative humidity | % (`rh = RH/100` internally) | Clamp to [1, 100] |
| P | **surface** pressure | hPa (mb) | Not MSL. Used in density, (P − e_w) and diffusivity. |
| u2 | wind speed at 2 m | m/s | From 10 m by §12 |
| S | global horizontal irradiance (GHI) | W m⁻² | After the normsolar cap (§11) |
| fdir | direct-beam fraction of S | 0–1 | Clamped to [0, 0.9]; 0 when cza < CZA_MIN |
| cza | cosine of the solar zenith angle | – | Apparent zenith; evaluated at mid-interval |

thermofeel public API: `calculate_wbgt_liljegren(t2_k[K], rh[%], pressure[hPa], va[10 m, m/s], ssrd[W/m²], fdir[0-1],
cossza, wind_scaling="liljegren") → K`. The internal solvers `liljegren.solve_globe(...)` and
`liljegren.solve_wetbulb(..., rad)` take `rh` as a fraction and `speed` at 2 m, and return °C.

## 4. Constants (identical in `wbgt.c` and thermofeel)

| Name | Value | Meaning |
|---|---|---|
| STEFANB | 5.6696e-8 W m⁻² K⁻⁴ | Stefan–Boltzmann (as coded; CODATA is 5.670374e-8) |
| Cp | 1003.5 J kg⁻¹ K⁻¹ | specific heat of dry air |
| M_AIR, M_H2O | 28.97, 18.015 g mol⁻¹ | molar masses |
| R_GAS | 8314.34 J kmol⁻¹ K⁻¹ | |
| R_AIR | R_GAS/M_AIR = 286.998274076631 | J kg⁻¹ K⁻¹ |
| Pr | Cp/(Cp + 1.25·R_AIR) = 0.736650093046073 | Prandtl number (Eucken) |
| RATIO | Cp·M_AIR/M_H2O = 1613.7327227310575 | psychrometric grouping |
| EMIS_GLOBE, ALB_GLOBE, D_GLOBE | 0.95, 0.05, 0.0508 m | globe |
| EMIS_WICK, ALB_WICK, D_WICK, L_WICK | 0.95, 0.4, 0.007 m, 0.0254 m | wick; D/(4L) = 0.0688976377952756 |
| EMIS_SFC, ALB_SFC | 0.999, 0.45 | ground (fixed; T_sfc = Ta) |
| CZA_MIN | 0.00873 | cos(89.5°) |
| MIN_SPEED | 0.13 m/s | floor inside both Reynolds numbers and after the 10→2 m conversion |
| CONVERGENCE | 0.02 K | |
| MAX_ITER | **500 (thermofeel)**; 50 (C, OSHA) | |
| Damping | new weight 0.1 (`x ← 0.9x + 0.1F`) | |
| SOLAR_CONST | 1367 W m⁻² | C only (fdir/TOA); thermofeel leaves fdir to the caller |
| NORMSOLAR_MAX | 0.85 | C only |
| MIN_WIND_10M | 0.62 m/s | thermofeel ("KNMI"); see §12 |

## 5. Thermophysical property functions (T in K, P in hPa)

```
esat(T)       = 1.004 * 6.1121 * exp(17.502 * (T - 273.15) / (T - 32.18))          [hPa]  Buck (1981) + 1.004 enhancement
dew_point(e)  = 273.15 + 240.97 * z / (17.502 - z),  z = ln(e / (6.1121*1.004))       [K]    exact inverse of esat
viscosity(T)  = 2.6693e-6 * sqrt(M_AIR*T) / (3.617^2 * omega),
                omega = (T/97 - 2.9)/0.4 * (-0.034) + 1.048                           [kg m-1 s-1]  BSL p.23
thermal_cond(T) = (Cp + 1.25*R_AIR) * viscosity(T)                                   [W m-1 K-1]   Eucken
diffusivity(T,P) = 3.640e-4 * (T/sqrt(132*647.3))^2.334 * (36.4*218)^(1/3)
                   * (132*647.3)^(5/12) * sqrt(1/M_AIR + 1/M_H2O) / (P/1013.25) * 1e-4   [m2 s-1]  BSL p.505
evap(T)       = (313.15 - T)/30 * (-71100) + 2.4073e6                                 [J kg-1]  (see quirk Q1)
emis_atm(T,rh)= 0.575 * (rh*esat(T))^0.143                                            Oke 2nd ed. p.373
density(T,P)  = P*100 / (R_AIR*T)                                                     [kg m-3]
```

Spot values from the fixture's `property_functions` (T = 303.15 K, P = 1013.25 hPa):

| Quantity | Value |
|---|---|
| esat | 42.6048337558 hPa |
| viscosity | 1.85844638032e-5 kg m⁻¹ s⁻¹ |
| thermal_cond | 0.0253166457216 W m⁻¹ K⁻¹ |
| diffusivity | 2.69108534818e-5 m² s⁻¹ |
| evap | 2,383,600 J kg⁻¹ |
| h_sphere at u = 1 m/s | 16.233687621 W m⁻² K⁻¹ |
| h_cylinder at u = 1 m/s | 34.1889724975 W m⁻² K⁻¹ |

**Quirk Q1 (inherited by every port).** The latent-heat line has the wrong slope sign. It uses the correct steam-table
values at 40 °C (2.4073e6) and the correct 30 K difference (71,100 J/kg), but λ *increases* with T. The error is
−5.74 % at 10 °C, −2.91 % at 25 °C, −1.95 % at 30 °C, 0 at 40 °C and +0.99 % at 45 °C. thermofeel, OSHA JS,
HeatStress R and PyWBGT (`1665134.5 + 2370·T`, the same line) all carry it.

On a 1,680-case grid, correcting it changes Tnwb by −0.38 to +0.05 °C and WBGT by −0.27 to +0.04 °C. For Ta 35–50 °C
the WBGT change is only −0.17 to +0.04 °C. The reference model is therefore slightly *conservative*.
**Recommendation: keep it**, for oracle parity and fidelity with the validated model, and document it. Whether the
paper's printed equation has the same sign is **UNVERIFIED** (paywall).

## 6. Convective heat-transfer correlations

```
Sphere (globe, BSL p.409):  Re = max(u, 0.13) * density(T,P) * D_GLOBE / viscosity(T)
                            Nu = 2.0 + 0.6 * sqrt(Re) * Pr^0.3333
                            h_g = Nu * thermal_cond(T) / D_GLOBE
Cylinder (wick, Bedingfield & Drew eqn 32):
                            Re = max(u, 0.13) * density(T,P) * D_WICK / viscosity(T)
                            Nu = 0.281 * Re^(1-0.4) * Pr^(1-0.56)        (= 0.281 Re^0.6 Pr^0.44)
                            h_w = Nu * thermal_cond(T) / D_WICK
```

Use the exponent `0.3333` literally, not 1/3, to keep parity.

## 7. Globe temperature

### 7.1 Energy balance as solved (T in K)

```
Tsfc = Ta
eps_a = emis_atm(Ta, rh)
beam = (fdir > 0) ? fdir * (1/(2*cza) - 1) : 0          // thermofeel guard; C has no guard (0*inf -> NaN at cza=0)
Tg_new = [ 0.5*(eps_a*Ta^4 + EMIS_SFC*Tsfc^4)
           - h_g(Tref,P,u2)/(STEFANB*EMIS_GLOBE) * (Tg_prev - Ta)
           + S/(2*STEFANB*EMIS_GLOBE) * (1 - ALB_GLOBE) * (beam + 1 + ALB_SFC) ]^0.25
Tref = 0.5*(Tg_prev + Ta)
```

Physically, the solar term equals ¼·DNI + ½·DIF + ½·α_sfc·GHI per unit sphere area, because
`S·fdir/(2·2cza) = DNI/4` with DNI = fdir·S/cza. This form is numerically robust if a DNI is ever supplied directly.

### 7.2 Iteration (identical in C and thermofeel)

```
Tg_prev = Ta                                  // initial guess
for iter = 1..MAX_ITER:
    Tref = 0.5*(Tg_prev + Ta)
    Tg_new = F(Tg_prev)                       // §7.1
    if |Tg_new - Tg_prev| < 0.02: return Tg_new - 273.15      // return the UNDAMPED value
    Tg_prev = 0.9*Tg_prev + 0.1*Tg_new
return NaN   // C returns -9999 and calc_wbgt status -1
```

Because the stop test is on |F(x) − x| < 0.02 K, the returned value sits within about 0.02 K of the exact root. A
different root-finder (Brent, Newton) will therefore differ from the oracle by up to about 0.02 K. Replicate the loop
exactly for 1e-6 parity.

### 7.3 Iteration counts (measured)

On a 7,500-case grid restricted to the 4,500 physically consistent inputs (GHI ≤ 0.85·1367·cza/0.983²):

* Globe: median 20 iterations, maximum 49.
* Natural wet bulb: median 13, maximum 59 (at Ta 50 °C, RH 95 %, u2 0.13, GHI 1000).

The original MAX_ITER = 50 would fail 1 physical case, and 140 cases on the full grid (all calm wind with low sun).
**Use 500.**

### 7.4 Non-convergence

thermofeel returned NaN for Tnwb in 9 of 7,500 grid cases. All were physically impossible: GHI 800–1000 W/m² at
cza = 0.1 (TOA is only about 137 W/m²), calm wind, Tg 130–176 °C. The damped iteration falls into a period-2 cycle.
A bracketing root still exists (for example Tnwb = 55.90 °C for Ta 46, RH 70, u 0.13, S 1000, fdir 0.9, cza 0.1,
found by bisection).

Engine rule: apply the solar cap (§11), which makes such inputs impossible. If NaN still occurs, bisect
`F(x) − x` to 1e-4 K and set `solverFallback = true`. Starting brackets are a recommendation, not from the sources;
widen them if there is no sign change:

* wick: [Tdew − 15 K, Ta + 60 K];
* globe: [Ta − 20 K, Ta + 120 K].

## 8. Natural and psychrometric wet bulb

```
Tsfc = Ta;  sza = acos(cza)  (thermofeel: cza_safe = cza > CZA_MIN ? cza : 1, so tan stays finite; fdir is 0 there)
eair = rh * esat(Ta);  Tw_prev = dew_point(eair)            // initial guess = dew point
loop as in §7.2 with:
    Tref = 0.5*(Tw_prev + Ta)
    h_w  = h_cylinder(Tref, P, u2)
    Fatm = STEFANB*EMIS_WICK*( 0.5*(eps_a*Ta^4 + EMIS_SFC*Tsfc^4) - Tw_prev^4 )
         + (1 - ALB_WICK)*S*( (1-fdir)*(1 + D/(4L)) + fdir*(tan(sza)/PI + D/(4L)) + ALB_SFC )
    ewick = esat(Tw_prev)
    Sc   = viscosity(Tref) / (density(Tref,P) * diffusivity(Tref,P))
    Tw_new = Ta - evap(Tref)/RATIO * (ewick - eair)/(P - ewick) * (Pr/Sc)^0.56 + (Fatm/h_w) * rad
rad = 1 -> natural wet bulb Tnwb;  rad = 0 -> psychrometric wet bulb Tpsy
```

Note: the beam term on the vertical wick is `DNI·sin(θ)/π`, since `fdir·S·tan θ = DNI·cos θ·tan θ`. At high sun the
wick sees little beam radiation.

At night the sign of Fatm depends on conditions:

* It can be negative (net longwave loss to a cold, dry sky), and then Tnwb falls slightly below Tpsy. Fixture
  `cool_night`: Tnwb 15.03, Tpsy 15.17 °C.
* On warm humid nights it is usually positive, because the evaporatively cooled wick is colder than its surroundings.
  Fixture `night_humid` trace: Fatm = +24.5 W/m² at convergence.

## 9. WBGT combination

Formulas as stated in Lemke & Kjellstrom 2012 (Eqs 1–2, citing Parsons 2003). ISO 7243 itself is paywalled and was not
read directly.

* "outdoors (in conditions of direct short wave radiation): WBGTod = 0.7 Tnwb + 0.2 Tg + 0.1 Ta"
* "indoors or outdoors in the shade (no direct short wave radiation): WBGTid = 0.7 Tnwb + 0.3 Tg"

**Shade with this model:** keep the same Ta, RH, P and u2 (computed from the real sky). Set S = 0, so fdir is
irrelevant, and apply the indoor formula. The OSHA calculator defines shade the same way ("solar irradiance = 0") but
keeps the 0.7/0.2/0.1 weights. The two formulas differ by 0.1·(Ta − Tg), which is 0.01–0.26 °C across the fixture's
`shade_variant` records.

Design caveat: with S = 0 the globe still sees the cold open sky (ε_a < 1), so Tg_shade falls up to 2.63 K below Ta in
dry air (fixture). Under a solid shade structure, the sky is blocked by a roof at about Ta or hotter. Setting
Tg_shade = max(Tg(S=0), Ta) would raise the indoor-formula WBGT by up to 0.3 × 2.63 ≈ 0.8 °C. Consider it as a
conservative option for engineered shade; it is not part of the reference model.

Caveat (secondary, Lemke & Kjellstrom 2012): indoors, "the Liljegren results are about 5% less than that using the
Bernard method". They attribute this to low indoor wind ("As indoor wind speeds are expected to be lower than 3 m/s,
Liljegren's formula underestimates the Tnwb indoors").

## 10. Solar geometry

### 10.1 What the C does

`calc_wbgt` centres the averaging window:

```
hour_gmt = hour - gmt + (minute - 0.5*avg)/60
```

It then calls Nels Larson's (PNNL 1992) low-precision Astronomical-Almanac algorithm. This algorithm *adds refraction*
to the altitude ("to match Michalsky's sunae program"), and sets `cza = cos(90° − elev_refracted)`. Larson against SPA
over Abu Dhabi 2025: maximum zenith error 0.0118°.

### 10.2 Port: NOAA Solar Calculator algorithm

The algorithm is based on Meeus. NOAA states the spreadsheets are "only valid for dates between 1901 and 2099". Input:
UTC instant, latitude (°N), longitude (°E).

```
JD  = unix_seconds/86400 + 2440587.5
T   = (JD - 2451545)/36525
L0  = mod(280.46646 + T*(36000.76983 + 0.0003032*T), 360)          // geom mean longitude [deg]
M   = 357.52911 + T*(35999.05029 - 0.0001537*T)                      // geom mean anomaly [deg]
e   = 0.016708634 - T*(0.000042037 + 0.0000001267*T)
C   = sin(M)*(1.914602 - T*(0.004817 + 0.000014*T)) + sin(2M)*(0.019993 - 0.000101*T) + sin(3M)*0.000289
nu  = M + C;   R = 1.000001018*(1 - e^2)/(1 + e*cos(nu))            // Earth-Sun distance [AU]
Om  = 125.04 - 1934.136*T
lam = L0 + C - 0.00569 - 0.00478*sin(Om)                             // apparent longitude
eps = 23 + (26 + (21.448 - T*(46.815 + T*(0.00059 - 0.001813*T)))/60)/60 + 0.00256*cos(Om)
dec = asin(sin(eps)*sin(lam))
y   = tan(eps/2)^2
EoT = 4*deg( y*sin(2L0) - 2e*sin(M) + 4e*y*sin(M)*cos(2L0) - 0.5y^2*sin(4L0) - 1.25e^2*sin(2M) )   // minutes
TST = mod( frac(JD + 0.5)*1440 + EoT + 4*lon, 1440 )                 // true solar time [min]
H   = TST/4 - 180                                                    // hour angle [deg]
cosz= sin(lat)sin(dec) + cos(lat)cos(dec)cos(H);  zen = acos(clamp(cosz,-1,1));  el = 90 - zen
refraction [deg] = (el > 85) ? 0 :
   (el > 5)      ? (58.1/t - 0.07/t^3 + 0.000086/t^5)/3600, t = tan(el) :
   (el > -0.575) ? (1735 + el*(-518.2 + el*(103.4 + el*(-12.79 + el*0.711))))/3600 :
                   (-20.772/tan(el))/3600
cza = sin(el + refraction)                // cos(apparent zenith): use this in the model
```

All angles are in degrees inside trig calls via `deg2rad`. Reference implementation: `noaa_solar()` in the oracle
script.

### 10.3 Verification against pvlib

Compare with `pvlib.solarposition.get_solarposition(times, lat, lon, altitude=0, pressure=101325, temperature=15,
method="nrel_numpy")`, which is NREL SPA. Results for Abu Dhabi, 2025, hourly, 4,421 sun-up hours:

| Comparison | Maximum difference |
|---|---|
| NOAA zenith vs SPA | 0.0159° |
| NOAA cos z vs SPA | 2.76e-4 |
| NOAA apparent zenith vs SPA, elevation > 5° | 0.0163° |
| Larson vs SPA | 0.0118° |

A 10-minute run gave the same figures (0.0161° and 0.0118°). There are 12 point vectors in the fixture `solar_cases`,
including Sydney, Phoenix and Tromsø to catch sign errors. Acceptance for the TS port: cos z within 1e-9 of the
fixture's NOAA values, and |Δzenith| ≤ 0.03° against SPA.

## 11. Direct-beam fraction from GHI (C `calc_solar_parameters`)

```
TOA = 1367 * max(cza,0) / R^2 ;  if cza < 0.00873: TOA = 0
if TOA > 0:
    S* = min(GHI/TOA, 0.85)          // NORMSOLAR_MAX: guards calibration error / inconsistent inputs
    GHI_used = S* * TOA              // NOTE: the C *replaces* GHI when GHI/TOA > 0.85
    fdir = S* > 0 ? clamp(exp(3 - 1.34*S* - 1.65/S*), 0, 0.9) : 0
else:
    GHI_used = GHI                   // unchanged: low-sun/night GHI is treated as diffuse
    fdir = 0
```

* The formula increases monotonically on (0, 0.85]. Its unconstrained maximum is at S* = 1.1097, so fdir reaches the
  0.9 clamp at S* ≥ 0.8251; the unclamped value at 0.85 is 0.9230.
* Sample values: fdir(0.2) = 0.0040, fdir(0.3) = 0.0549, fdir(0.5) = 0.3791, fdir(0.7) = 0.7444.
* thermofeel leaves fdir to the caller. It only clamps to [0, 0.9] and zeroes fdir when cza < CZA_MIN, and it never
  rescales GHI.
* The cap keeps the beam term bounded: implied DNI = fdir·GHI/cza ≤ 0.9·0.85·1367/R² ≈ 1046 W/m². This prevents
  the 1/(2cza) term from blowing up at low sun, and it is why the cap is recommended (D6).

**Alternatives.**

* (a) Open-Meteo `direct_radiation/shortwave_radiation`. This may be model-native or estimated by Open-Meteo using
  the Razo–Müller–Witwer decomposition (per `Zensun.swift`), depending on the NWP model; which applies for UAE
  "best_match" is **UNVERIFIED**.
* (b) thermofeel `approximations.approximate_fdir_disc` / `_erbs`.

On two clear July 2025 days, (a) changed WBGT by ≤ 0.17 °C relative to Liljegren's formula (§13.5).

If (a) is ever used, enforce the same bound: `fdir ≤ 0.765·TOA/GHI`.

Physics note: at high sun, a *lower* fdir (dust or haze) raises Tg and Tnwb, because the sphere and the vertical wick
take more from diffuse light than from an overhead beam.

## 12. Wind: minimum speed and the 10 m → 2 m conversion

**Stability class** (C `stab_srdt`, EPA-454/R-99-005 Table 6-7 "Key to Solar Radiation Delta-T (SRDT) Method").
`daytime = cza > 0`. Use GHI_used for the radiation column. LSRDT `[row][col]`; class 1–6 = A–F:

| u10 (m/s) | Day S ≥ 925 | 675 ≤ S < 925 | 175 ≤ S < 675 | S < 175 | Night dT < 0 (col 5) | Night dT ≥ 0 (col 6, C only) |
|---|---|---|---|---|---|---|
| < 2 | 1 | 1 | 2 | 4 | 5 | 6 |
| 2 – < 3 (night: 2 – < 2.5) | 1 | 2 | 3 | 4 | 5 | 6 |
| 3 – < 5 (night: ≥ 2.5) | 2 | 2 | 3 | 4 | 4 | 4 |
| 5 – < 6 | 3 | 3 | 4 | 4 | – | – |
| ≥ 6 | 3 | 4 | 4 | 4 | – | – |

Night rows use the bins < 2, 2–< 2.5 and ≥ 2.5. thermofeel always uses col 5, which suits urban exponents since E and F
are both 0.30.

**Quirk Q2 (inherited).** EPA Table 6-7 night row "2.0–2.5" reads **D, E**; the C and thermofeel use E, F. With urban
exponents this means 0.30 instead of 0.25 (u2 8 % lower at night in that band). Measured WBGT effect ≤ 0.012 °C.
Keep for parity.

**Power law** (EPA Table 6-2, matches the C arrays exactly): `u2 = max(u10 · (2/10)^p, 0.13)`

| Class | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| urban p | 0.15 | 0.15 | 0.20 | 0.25 | 0.30 | 0.30 |
| (2/10)^p | 0.78552 | 0.78552 | 0.72478 | 0.66874 | 0.61703 | 0.61703 |
| rural p (C only) | 0.07 | 0.07 | 0.10 | 0.15 | 0.35 | 0.55 |

**Floors.**

* C: 0.13 m/s at 2 m, both after conversion and inside both Reynolds numbers.
* thermofeel: additionally `u10 = max(u10, 0.62)` *before* conversion, which it attributes to KNMI. The KNMI report
  TR-26-04 was not retrieved, so the KNMI attribution is **UNVERIFIED**. The resulting 2 m floor is 0.487 m/s
  (day, class A), 0.415 (day, class D) or 0.383 (night, class E).
* OSHA: v2 = v10·(2/10)^0.24 (factor 0.67959), then a 1 mph (0.44704 m/s) floor "to account for the fact that
  outdoor workers are always moving".
* Kong & Huber 2024: "prior studies frequently assume a minimum wind speed of 1 m/s" for labour-loss studies.

**Sensitivity.** In strong sun, WBGT rises steeply below about 1 m/s. Fixture `inland_noon_low_wind_0p5`: 37.64 °C
with the KNMI floor; the original C pipeline without the floor gives +0.67 °C. In Lemke Fig. 3 (S = 500), WBGT is
30.75 at 0.2 m/s, 29.03 at 0.5 and 28.07 at 1.0.

**Recommendation D7:** use the thermofeel floor and urban exponents everywhere. Urban gives the lower daytime 2 m wind,
so it is conservative. Consider showing a "calm-air" upper bound (u2 = 0.13) as a secondary flag.

## 13. Mapping Open-Meteo hourly data into the model

### 13.1 Request

```
https://api.open-meteo.com/v1/forecast?latitude=24.4539&longitude=54.3773
  &hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,
          shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,cloud_cover
  &wind_speed_unit=ms&timezone=GMT
```

The same variables are served by `historical-forecast-api.open-meteo.com` for back-tests. Use GMT/UTC timestamps:
the UAE (GST, UTC+4) has no DST, but UTC avoids ambiguity.

### 13.2 Per-variable treatment

Open-Meteo definitions, verbatim: radiation is "Preceding hour mean"; met variables are "Instant".

| Open-Meteo variable | Valid time | Use |
|---|---|---|
| `temperature_2m` (°C) | instant at t | Ta |
| `dew_point_2m` (°C, 0.1 resolution) | instant | **RH = 100·esat(Td)/esat(Ta)** with §5 esat (the 1.004 cancels), clamped to [1, 100]. Then `dew_point(eair)` inside the model returns Td exactly. |
| `relative_humidity_2m` (%) | instant, integer | Fallback only. Measured sensitivity is 0.17–0.44 °C Tnwb per 1 % RH, so integer rounding (±0.5 %) gives ±0.08–0.22 °C Tnwb (±0.06–0.15 °C WBGT). |
| `surface_pressure` (hPa) | instant | P (not `pressure_msl`) |
| `wind_speed_10m` (with `wind_speed_unit=ms`) | instant | u10 → §12 |
| `shortwave_radiation` (W/m²) | "Shortwave solar radiation as average of the preceding hour" | GHI for (t−1 h, t] |
| `direct_radiation`, `diffuse_radiation`, `direct_normal_irradiance` | preceding-hour mean | Sensitivity and QA only (§11) |
| `*_instant` radiation variables | instant | Open-Meteo derives them as mean × sin(el)_instant / sin(el)_hour-mean (`backwardsAveragedToInstantFactor`). Not independent information. |
| `cloud_cover` (%) | instant | Not a model input (GHI already includes clouds). Use for QA and UI only. |

### 13.3 Hour-averaged radiation and low sun

1. For a record stamped t (end of hour), evaluate solar geometry at **t_eval = t − 30 min**. This is exactly the C
   convention (`minute − 0.5·avg`, avg = 60).
2. Compute cza and R from NOAA (§10) at t_eval, then TOA, S*, GHI_used and fdir from §11.
3. If cza < 0.00873 (sun at or below 89.5° at mid-hour, which includes the sunrise and sunset hours where GHI is a few
   W/m²), set fdir = 0 and keep GHI as diffuse. The model then has no cza dependence (no 1/cza or tan θ terms).
4. At night (GHI = 0) all shortwave terms vanish. The longwave terms make Tg slightly less than Ta.
5. Optional refinement: the sunlit-only mean cos z over the hour (Kong & Huber's `coszda`; Hogan & Hirahara 2016).
   On hourly data it changed WBGT by ≤ 0.01 °C relative to the midpoint (§13.5), so it is not needed.

### 13.4 Reference pipeline (TypeScript-style pseudo-code)

```ts
function wbgtFromOpenMeteo(rec, lat, lon, opts = { avgMin: 60 }) {
  const Ta = rec.temperature_2m;
  const RH = clamp(100 * esat(rec.dew_point_2m + 273.15) / esat(Ta + 273.15), 1, 100); // fallback: rec.relative_humidity_2m
  const P  = rec.surface_pressure;
  const tEval = rec.timeUtc - opts.avgMin / 2 * 60_000;
  const sun = noaaSolar(julianDay(tEval), lat, lon);
  const cza = sun.cosApparentZenith;
  const toa = cza >= CZA_MIN ? 1367 * cza / (sun.R * sun.R) : 0;
  const ghi = Math.max(0, rec.shortwave_radiation);
  let ghiUsed = ghi, fdir = 0;
  if (toa > 0) {
    const s = Math.min(ghi / toa, 0.85); ghiUsed = s * toa;
    fdir = s > 0 ? clamp(Math.exp(3 - 1.34 * s - 1.65 / s), 0, 0.9) : 0;
  }
  const u10 = Math.max(rec.wind_speed_10m, 0.62);                          // KNMI floor (thermofeel)
  const cls = stabilityClass(cza > 0, u10, ghiUsed);                       // §12 table
  const u2  = Math.max(u10 * Math.pow(0.2, URBAN_EXP[cls - 1]), 0.13);
  const fd  = cza < CZA_MIN ? 0 : clamp(fdir, 0, 0.9);
  const Tg   = solveGlobe(Ta + 273.15, RH / 100, P, u2, ghiUsed, fd, cza);      // °C
  const Tnwb = solveWetBulb(Ta + 273.15, RH / 100, P, u2, ghiUsed, fd, cza, 1);
  return { Tg, Tnwb, Tpsy: solveWetBulb(..., 0), wbgt: 0.1 * Ta + 0.2 * Tg + 0.7 * Tnwb, u2, cza, fdir: fd, ghiUsed };
}
```

The Python reference is `run_full_case()` in the oracle script. Its output equals thermofeel's public API exactly
(checked to < 1e-9 °C).

### 13.5 Measured effect of timing and fdir choices

Two Open-Meteo days were tested: 2025-07-15 at Abu Dhabi city and at Madinat Zayed, 24 h each.

| Variant | Max \|ΔWBGT\| vs V1 |
|---|---|
| V1 (adopted): hour-mean GHI, cza at t − 30 min, Liljegren fdir and cap | – |
| V2: sunlit-mean cza over the hour | ≤ 0.01 °C |
| V3: Open-Meteo direct/GHI as fdir | ≤ 0.17 °C |
| V4: `shortwave_radiation_instant` with instantaneous cza at t | ≤ 0.42 °C |
| V5: V4 with Open-Meteo instant direct fraction (difference from V4) | ≤ 0.18 °C |

V4 differs mainly by a 30-minute radiation timing shift: it is higher in the morning ramp and lower in the afternoon.
Daily maxima were 36.37 (V1) and 36.57 (V4) at Abu Dhabi, and 35.48 and 35.49 at Madinat Zayed.

V4 is acceptable if the product needs every variable aligned at t. In that case use the instant cza at t; never mix
hour-mean GHI with instantaneous cza.

## 14. thermofeel vs original C: differences and what we follow

| # | Item | `wbgt.c` v1.1 | thermofeel 2.3.0 | Measured impact | Follow |
|---|---|---|---|---|---|
| 1 | Precision | `float` storage | float64 | WBGT ≤ 0.019 °C (p99 0.0002) | float64 |
| 2 | MAX_ITER | 50 → −9999, status −1 | 500 → NaN | C fails 1 of 4,500 physical (140 of 7,500 total) grid cases | 500 + fallback |
| 3 | Solar position | internal Larson + refraction, window-centred | caller supplies cossza | Larson vs SPA ≤ 0.012° | NOAA, apparent, t − 30 min |
| 4 | fdir | internal formula (§11) | caller supplies; clamp [0, 0.9]; 0 if cza < CZA_MIN | – | C formula, computed in our pipeline |
| 5 | GHI cap | GHI → S*·TOA when GHI/TOA > 0.85 | none | only when GHI > 0.85·TOA (fixture `solar_cap_cloud_enhancement`) | apply (C) |
| 6 | Wind floor | 0.13 m/s only | + u10 ≥ 0.62 | low-wind sun: C up to +0.67 °C (u10 0.5) | thermofeel |
| 7 | Night stability column | dT selects col 5 or 6 | always col 5 | none for urban | thermofeel |
| 8 | Rural exponents | available | urban only | rural is less conservative by day | urban |
| 9 | Radiation used for stability | GHI after cap | `ssrd` as passed | none if GHI_used is passed | pass GHI_used |
| 10 | 0·∞ at cza = 0, fdir = 0 | NaN → −9999 | guarded | edge only | guard |
| 11 | Tpsy | output | internal (`solve_wetbulb(rad=0)`) | – | expose |
| 12 | Inherited | Q1 latent-heat slope; Q2 night SRDT row; T_sfc = Ta; fixed albedo 0.45; esat ×1.004 | same | Q1 ≤ 0.27 °C; Q2 ≤ 0.012 °C | keep |

Other ports, for awareness only (do **not** follow):

* **PyWBGT.** Pressure-dependent esat enhancement (1.0007 + 3.46e-6 P) and an ice branch. EMIS_SFC taken as 1. No
  0.13 floor in Re. Brent solver with xtol 0.001 K. Sunlit-mean cos z, and fdir from the Liljegren formula using that
  mean.
* **HeatStress R.** Fixed fdir 0.8, P 1010, albedo 0.4, globe 0.05 m, min wind 0.1, `optimize()`, Sc at Ta.
* **OSHA JS.** Faithful core; wrapper uses p = 0.24, a 1 mph floor and clear-sky GHI = max(910·cza − 30, 0)
  (Kasten–Czeplak).

## 15. Verification and sanity checks

All of these are reproduced by the oracle script, which exits with code 1 on failure. Acceptance criteria are hard-coded
in `ACCEPT`.

1. **thermofeel ≡ C algorithm.**
   * Independent transliteration in float64 with MAX_ITER 500: max |Δ| = 2.16e-12 °C over 7,500 grid cases, and
     ≤ 2.3e-13 °C on core cases.
   * Property functions: relative difference ≤ 1e-12.
   * `wind_speed_2m` against C `est_wind_speed` (urban): exactly 0 difference.
   * The thermofeel docstring's "bit-for-bit" claim is thus confirmed at machine precision.
2. **Float32 original semantics** (assignment rounding emulated): WBGT max 0.0189 °C, p99 0.00015 °C vs thermofeel.
3. **Solar:** see §10.3 (PASS).
4. **Independently published values (Lemke & Kjellstrom 2012, Figs 1–4, Liljegren series).** 100 points were digitized
   from the open-access PDF at 400 dpi, with ±0.05 °C reading uncertainty.
   * **Geometry-free point** (Fig. 1, S = 0; Ta 30 °C, RH 55 %, u2 1 m/s): thermofeel **24.822 °C** vs published
     **24.83 °C** (Δ −0.008 °C). It is insensitive to pressure: 24.818 at 1010 hPa.
   * **Solar-dependent points.** The figure's geometry is not stated. Assuming fdir = 0.8 and cos z = 1 (fdir 0.8 is
     the `propDirect` of the Lemke VBA lineage, inferred from the HeatStress R port), and with no fitting, thermofeel
     reproduces all four series. Excluding the single point below Liljegren's 0.13 m/s floor (u = 0.1 m/s,
     +0.54 °C): **rms 0.056 °C, max 0.142 °C over 99 points.**
   * Per figure (rms / max in °C): Fig. 1 solar 0.078 / 0.142; Fig. 2 RH 0.051 / 0.089; Fig. 3 wind 0.042 / 0.090
     (29 points, u ≥ 0.2; 0.106 rms with the 0.1 m/s point); Fig. 4 Ta 0.048 / 0.097.
   * HeatStress-style constants (albedo 0.4, globe 0.05 m, 1010 hPa) fit worse (rms 0.157, bias −0.15). Liljegren's
     own fdir formula with any single cos z also fits poorly (rms ≥ 0.93). This *suggests* the figures were produced
     with the original constants and a fixed direct fraction (an inference). **Agreement: PASS.**
5. **BoM formula transcription.**
   * BoM's own worked example, Brisbane 29.4 °C / 59 % ("a WBGT of about 30°C"): 30.08 °C.
   * Lemke Fig. 1 ABM line at 30 °C / 55 %: about 30.1, vs 30.09 computed.
6. **Not available:** NWS documentation does not provide Liljegren values. The NWS operational WBGT uses the Dimiceli
   et al. globe method (per Clark & Konrad 2020, secondary). Kong & Huber 2022 tables were not accessible.

## 16. Oracle fixtures

`python scripts/oracles/wbgt_liljegren_oracle.py [--out PATH]` takes about 6 s, needs no network, and requires numpy,
thermofeel 2.3.0 and pvlib. It writes `fixtures/wbgt_liljegren.json` (about 110 KiB).

**Units:** °C unless a key ends in `_K`; RH %; hPa; m/s; W/m²; time in UTC ISO-8601. `null` means not applicable or
not converged.

| Key | Content | How to test |
|---|---|---|
| `meta` | versions, units, conventions, `tolerances`, `acceptance`, `failures` (must be `[]`) | – |
| `constants` | every constant in §4 plus the LSRDT table and exponents | exact |
| `property_functions[10]` | T ∈ {283.15 … 323.15} K × P ∈ {1013.25, 980}: esat, viscosity, thermal_cond, diffusivity, evap, emis_atm (rh 0.3/0.7), dew_point(½esat), h_sphere and h_cylinder at u 0.13/1/4 (12 significant figures) | rel ≤ 1e-10 |
| `core_cases[20]` | `inputs{ta_c, rh_pct, p_hpa, u2_ms, ghi_wm2, fdir_supplied, cos_zenith}`, `preprocessing.fdir_used`, `intermediates{eair_hPa, tdew_c, emis_atm}`, `outputs{tg_c, tnwb_c, tpsy_c, wbgt_outdoor_c, wbgt_indoor_formula_c}`, `iterations{tg, tnwb, tpsy}` | 1e-6 °C; iterations exact if ported exactly |
| `iteration_traces` | first 3 and last iterations (prev, Tref, h, Fatm, ewick, Sc, new, in K) for two cases | debugging |
| `wind_cases[45]` | u10, GHI, cza → class, exponent, u2 (no floor), u2 with KNMI floor (API), rural variants | 1e-9 m/s |
| `fdir_cases[17]` | TOA, GHI → clearness, GHI_used, fdir | 1e-9 |
| `solar_cases[12]` | site, UTC → NOAA (declination, EoT, hour angle, zenith, refraction, apparent zenith, cos values, R), pvlib SPA, Larson | NOAA port 1e-9; vs SPA ≤ 0.03° |
| `full_cases[20]` | Open-Meteo-like records (see below) | see below |
| `formula_cases[6]` | (Tnwb, Tg, Ta) → outdoor and indoor WBGT | 1e-9 |
| `bom_approximation_cases_NOT_LILJEGREN[8]` | (Ta, RH) → e, WBGT_BoM | 1e-9 |
| `sanity_checks` | grid cross-check statistics, solar-vs-SPA statistics, Lemke digitized data with thermofeel predictions | – |

A `full_cases` record contains:

* `inputs`: lat, lon, `time_end_utc`, `avg_minutes`, ta_c, rh_pct *or* td_c, p_hpa, u10_ms, `wind_height_m`, ghi_wm2,
  optionally direct_wm2.
* `derived`: rh_used_pct, `time_eval_utc`, julian_day, zenith_deg, apparent_zenith_deg, cos_zenith, earth_sun_au,
  toa_wm2, clearness_before_cap, ghi_used_wm2, fdir, u10_after_floor_ms, daytime, stability_class, wind_exponent,
  u2_ms, plus informational cos_zenith_sunlit_mean_info and sunlit_fraction_info.
* `outputs`: tg_c, tnwb_c, tpsy_c, wbgt_c (thermofeel public API).
* `shade_variant`, `bom_approximation_NOT_LILJEGREN`, `original_c_pipeline_reference` (Larson, no KNMI floor,
  MAX_ITER 50), `sensitivity_fdir_openmeteo`, and `checks`.

Full cases cover:

* Inland noon at 46.2 °C/13 % (Open-Meteo snapshot), the same hour with u10 0.5, and the Abu Dhabi peak snapshot at
  11:00 GST.
* Humid coastal morning 35 °C/70 %; night 33 °C/60 %; calm humid night (u10 0.3); winter noon 25 °C; winter night
  18 °C.
* Shamal winds of 6 and 10 m/s; dust with GHI 350; haze with GHI 600.
* Sunrise hour (mid-hour sun below the horizon), low sun at 19:00.
* Al Ain at 965 hPa, Ruwais 40 °C/60 %, Liwa 48 °C/6 %, a solar-cap case (GHI 1150), spring and autumn.

Example: `inland_summer_noon_extreme` gives cza 0.99923, fdir 0.7335, u2 1.084 m/s, Tg 63.80, Tnwb 25.85, Tpsy 22.40,
**WBGT 35.48 °C**.

## 17. Australian BoM approximation (separately labelled; not Liljegren)

BoM text, verbatim: "WBGT = 0.567 × Ta + 0.393 × e + 3.94" with "e = rh / 100 × 6.105 × exp ( 17.27 × Ta / ( 237.7 +
Ta ) )" (Ta in °C, e in hPa, rh in %). BoM's own caveats: it "does not take into account variations in the intensity of
solar radiation or of windspeed, and assumes a moderately high radiation level in light wind conditions… The
approximation will also overestimate night-time and early morning conditions when the sun is low or below the
horizon."

Lemke & Kjellstrom (2012) wrote that "the ABM formula does not match our criteria for validity", that the formula was
derived for indoor conditions (Gagge & Nishi: 0.567 Ta + 0.216 ρ + 3.38), and that "the Australian Bureau of
Meteorology formula quoted on their web site is incorrect". Kong & Huber (2022) recommend discontinuing sWBGT; this
comes from the indexed abstract (secondary), since the full text was not accessed.

In our Abu Dhabi runs it exceeded Liljegren by up to about 7 °C at night (fixture `night_humid_no_sun`: 34.47 vs
28.24 °C) and agreed only by coincidence at the dry inland noon (35.43 vs 35.48). **Do not use it for alerts.**

## 18. Limitations and open items

* **T_sfc = Ta and fixed albedo 0.45** (no site-dependent parameters, by design). This is an illustration only, not
  part of the model: ground 20 K hotter than air would add about 0.7–0.9 °C to WBGT in the inland and coastal noon
  cases. The model is therefore likely optimistic over hot sand or asphalt.
* **2-inch globe.** Lemke & Kjellstrom (2012): "Non-standard 50 mm diameter globes reach equilibrium more quickly, but
  give a slightly smaller equilibrium temperature" than the standard 150 mm globe. The modelled Tg follows the 2-inch
  instrument.
* **Validation domain.** Liljegren validated at US Army depots; there is no Gulf-climate validation in the sources
  read. The expected accuracy (±1 °C) is the paper's claim, from the abstract.
* **UNVERIFIED:**
  * paper equation and table content;
  * KNMI TR-26-04 (source of the 0.62 m/s floor);
  * ISO 7243 wording (formulas taken via Lemke & Kjellstrom);
  * which Open-Meteo model supplies `direct_radiation` for the UAE;
  * the geometry assumed for Lemke's figures (inferred).
* **Not run:** the original C binary (permission denied). Equivalence rests on the transliteration and on reading the
  OSHA port.

## 19. References

1. Liljegren JC et al. J Occup Environ Hyg 2008;5:645-655. https://doi.org/10.1080/15459620802310770 (abstract: https://pubmed.ncbi.nlm.nih.gov/18668404/)
2. Liljegren JC. WBGT v1.1 C source (Argonne, 2008), mirror: https://github.com/mdljts/wbgt (`src/wbgt.c.original`)
3. thermofeel 2.3.0: https://github.com/ecmwf/thermofeel (`thermofeel/liljegren.py`)
4. OSHA Outdoor WBGT Calculator: https://www.osha.gov/heat-exposure/wbgt-calculator
5. Kong Q, Huber M. Earth's Future 2022. https://doi.org/10.1029/2021EF002334; code: https://github.com/QINQINKONG/PyWBGT
6. Kong Q, Huber M. GeoHealth 2024. https://doi.org/10.1029/2024GH001068
7. Lemke B, Kjellstrom T. Ind Health 2012;50:267-278. https://www.jstage.jst.go.jp/article/indhealth/50/4/50_MS1352/_pdf
8. US EPA. EPA-454/R-99-005 (2000). https://www.epa.gov/sites/default/files/2020-10/documents/mmgrma_0.pdf
9. Casanueva A. HeatStress R package: https://github.com/anacv/HeatStress
10. Australian Bureau of Meteorology, Thermal Comfort: https://www.bom.gov.au/info/thermal_stress/
11. Open-Meteo API docs: https://open-meteo.com/en/docs; `Zensun.swift`: https://github.com/open-meteo/open-meteo
12. NOAA GML Solar Calculator: https://gml.noaa.gov/grad/solcalc/calcdetails.html
13. pvlib-python 0.16.1, `pvlib.solarposition.get_solarposition(method="nrel_numpy")`
