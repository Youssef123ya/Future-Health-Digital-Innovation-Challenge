# Physiological strain monitoring and clinical safety rules (Zill research spec)

Status: research spec for the TypeScript engine. Retrieved and verified 2026-11-09.
Scope: (1) ECTemp heart-rate-to-core-temperature Kalman filter, (2) Physiological Strain Index (PSI) and adaptive PSI,
(3) wearable heart-rate signal quality and fail-safe design, (4) exertional heat illness recognition, first aid, cooling,
escalation, UAE emergency numbers and a pictogram yes/no check-in, (5) urine-colour hydration self-check,
(6) individual risk factors, (7) fluid caps and electrolytes. Section 10 (last) holds the transcribable constants and rules.

## 0. How to read this document

Evidence tags used throughout:

| Tag | Meaning |
|---|---|
| [VP] | Verified against a primary source (paper abstract or full text, official code, standard, regulator or government page, patent text). |
| [VS] | Verified only through a reputable secondary source (the primary is paywalled or was not retrievable). |
| [ENG] | Engineering choice made for Zill. It is not taken from a source. An occupational physician must review it before deployment. |
| [UNVERIFIED] | Could not be verified. Do not ship this as fact. What was tried is recorded next to it. |

Citation keys in square brackets (for example [B13]) resolve in Section 9.

Clinical governance: the triage, cooling and escalation rules below are decision support for workers, buddies, supervisors
and first aiders. A UAE-licensed occupational physician (medical director) must sign them off before field use. Zill
must never diagnose, and it must never use an algorithmic output to talk anyone out of calling 998.

## 1. Executive summary (engineering view)

1. ECTemp is a scalar extended Kalman filter (EKF) on 1-minute mean heart rate (HR). The random-walk state has
   process SD gamma = 0.022 degC/min. The observation is HR = -4.5714 CT^2 + 384.4286 CT - 7887.1, with observation
   SD sigma = 18.88 bpm. Initialization is CT0 = 37.1 degC and v0 = 0 [B13][USARIEM-JS]. The Python oracle reproduces
   the author's own JavaScript bit for bit (581/581 minutes, max |dCT| = 0) (Section 10.12).
2. Reported accuracy (Buller 2013, N = 83 validation, more than 52,000 minutes): bias -0.03 +/- 0.32 degC, 95% limits
   of agreement (LoA) +/-0.63 degC, RMSE 0.30 +/- 0.13 degC [B13][P165]. Independent and occupational validations are
   in Section 2.5. Group-level accuracy is good. **Individual-level accuracy is poor**, and **sensitivity at high core
   temperature is poor**: sensitivity was 48% at an estimated temperature (Tc-est) above 39.0 degC and 4% above
   39.5 degC [dK22]. ECTemp alone flagged only 23.3% of 30 exertional heat illness (EHI) cases among 5,080 recruits
   [B25]. In Zill, ECTemp may only escalate risk. It is never a reason to de-escalate.
3. ECTemp is covered by US patents held by the US Army (US 10,702,165 B2, estimated expiry 2033-12-16; sigmoid
   refinement US 12,426,839 B2, estimated expiry 2042-02-04). aPSI is covered by US 11,564,579 B2. USARIEM says
   commercial use needs a licence [USARIEM-JS]. Legal review is required (Section 2.1).
4. PSI = 5(CTt - CT0)/(39.5 - CT0) + 5(HRt - HR0)/(180 - HR0) [M98]. Bands: 0-2 no/little, 3-4 low, 5-6 moderate,
   7-8 high, 9-10 very high [VS, Moran Table 1 as reproduced in P579].
5. Wrist photoplethysmography (PPG) HR is device- and activity-dependent. Mean absolute error ranged from 4.5 to
   14 bpm across 10 devices. Ambient heat at 36 degC did not degrade accuracy, but intermittent movement did [Ge26].
   Arm-intensive work is the worst case [Gi17]. The signal-quality index (SQI) works per minute: plausible range
   40-200 bpm [E22], at least 80% valid samples [Pt12], a max/min ratio below 2.2 per 10-s segment
   [Or15, VS], and flatline rejection [ENG]. SQI-scaled observation noise uses R = R0 exp(psi^-2 - 1) [Li09].
   Fusion is final = max(environment, physio-if-valid, symptoms).
6. Heat stroke is CNS dysfunction (confusion, odd or aggressive behaviour, slurred speech, ataxia, seizure, collapse
   or coma) during or after work in heat. When in doubt, call 998 and cool immediately [OSHA-FA][NIOSH-ILL][TBMED].
   Cold-water immersion (CWI) is the best cooling method, at 1-26 degC neck-down until core temperature is below
   39 degC [ILCOR19]. Cool first and transport second, aiming for below 39.2 degC within 30 min of collapse [NATA15-ES].
   Tarp-assisted cooling (TACO) achieves 0.14-0.17 degC/min [Lu16][Ho17].
7. UAE emergency numbers: ambulance 998, police 999, Civil Defence 997 (also coastguard 996, search and rescue 995,
   electricity 991; AD999 app; SMS 5999 in Abu Dhabi for people of determination) [UAE, page updated 01 Oct 2026].
8. Fluid caps: no more than 1.5 US quarts (1.42 L) per hour and no more than 12 quarts (11.36 L) per day [TBMED][NIOSH16].
   The usual target is 1 cup (237 mL) every 15-20 min, which is 0.71-0.95 L/h [NIOSH16]. Use sports drinks for
   prolonged sweating [NIOSH16]. Salt tablets are not recommended [TBMED][NIOSH16].
9. Risk factors become boolean flags that switch on a conservative mode or occupational-health review. US Army
   doctrine states that scoring risk factors "is not recommended" because there is not enough evidence for a
   quantitative matrix [TBMED].

## 2. ECTemp: estimating core temperature from sequential heart rate

### 2.1 Provenance, licensing and intellectual property

- Primary paper: Buller MJ, Tharion WJ, Cheuvront SN, Montain SJ, Kenefick RW, Castellani J, Latzka WA, Roberts WS,
  Richter M, Jenkins OC, Hoyt RW. Physiol Meas 2013;34(7):781-798 [B13]. The IOP full text is paywalled. The equations
  below come from (a) the author's own JavaScript on the USARIEM site, whose header reads "Adapted from ... (Matlab
  Function Appendix)", and (b) the patent text [P165] [VP].
- Official code: `https://usariem.health.mil/assets/js/estimateTcore.js` (author "Mark J. Buller"; SHA-256 of the
  retrieved file `32639495a82251e09aa159daa7204efd82b1d083db2e008356145284d79acf9c`). The page's demo driver
  `core_temp_try_out.js` uses `var v0=0` and the input default `value="37.1"` [USARIEM-JS] [VP].
- USARIEM page disclaimers: "for demonstration purposes only". Also: "To obtain functions for Academic or personal use or
  licensing for commercial use please contact" the USARIEM webmaster [USARIEM-JS] [VP].
- Patents (Google Patents status lines; Google states these are "not a legal conclusion") [VP]:
  - US 10,702,165 B2, "Estimation of human core temperature based on heart rate system and method". Inventor
    M. J. Buller. Assignee US Department of the Army. Priority 2012-12-20; granted 2020-07-07. Active, anticipated
    expiry 2033-12-16. Claim 1 recites a mobile device with "a heart rate monitor having a plurality of electrodes"
    that calculates CT "using an extended Kalman filter", "wherein the initial core body temperature is set by the
    processor based solely on the first heart rate of the person". Dependent claim 3 adds an alarm when CT exceeds "a
    predetermined threshold".
  - US 12,426,839 B2, "Method for estimating core body temperature". Inventors Buller and Looney. Priority 2019-02-07;
    granted 2025-09-30. Adjusted expiry 2042-02-04. Covers the EKF "based on a sigmoid model". The initial CT is set
    from the first HR or from a predetermined resting CT.
  - US 11,564,579 B2, adaptive PSI. Inventor Buller. Priority 2016-04-15; granted 2023-01-31. Adjusted expiry 2038-02-25.
  - Patents are territorial; these are US patents. Whether UAE or GCC equivalents exist was not checked [UNVERIFIED].
    Action: obtain legal review and contact USARIEM licensing before commercial use, especially of any US-facing build.

### 2.2 Exact model (Buller 2013, quadratic version) [VP]

Time step: one minute. State: core temperature CT (degC). Observation: mean HR over the minute (beats/min).

Time (process) model, with a1 = 1 and a0 = 0:
```
CT_t = a1 * CT_{t-1} + a0 + w,   w ~ N(0, gamma^2),   gamma = 0.022 degC  => gamma^2 = 0.000484 degC^2 per minute
```
Observation model:
```
HR_t = b2*CT_t^2 + b1*CT_t + b0 + e,   e ~ N(0, sigma^2)
b2 = -4.5714,  b1 = 384.4286,  b0 = -7887.1,  sigma = 18.88 bpm  => sigma^2 = 356.4544 bpm^2
```
EKF recursion (equation numbers as in the official JS; the patent numbers them 1-6):
```
CT_pred = a*CT_{t-1}                                    (3)   a = 1
v_pred  = a^2 * v_{t-1} + gamma^2                       (4)
c_t     = 2*b2*CT_pred + b1   (= -9.1428*CT_pred + 384.4286)   (5)  linearisation dHR/dCT at CT_pred
k_t     = v_pred*c_t / (c_t^2*v_pred + sigma^2)         (6)
CT_t    = CT_pred + k_t*(HR_t - (b2*CT_pred^2 + b1*CT_pred + b0))   (7)
v_t     = (1 - k_t*c_t) * v_pred                        (8)
```
- Initialization: CT0 = 37.1 degC and v0 = 0 in the official app [USARIEM-JS]. The 2013 validation used each study's
  observed initial CT with v0 = 0, "indicating high confidence in these values" [P165].
- Sampling: "The extended Kalman Filter model was developed using data with one minute intervals. Where data had
  sampling rates more frequent than the one minute intervals the mean of all values occurring in that minute was used.
  Where the sampling rate was greater than one minute, values were linearly interpolated" [P165].
- Training data: 17 volunteers in a 24-h military field exercise (air 24-36 degC, 42-97% RH, CT 36.0-40.0 degC).
  Validation: N = 83 across 9 laboratory and field studies covering combinations of temperature, hydration, clothing
  and acclimation [B13]. The development data came from "seventeen male U.S. Army volunteers (age=23+/-4 years ...)",
  with HR from an Equivital EQ02 chest monitor and CT from an ingested Jonah thermometer pill [P165].
- Naming pitfall: in the official JS the variables named `gamma` and `sigma` hold the variances (0.022^2 and 18.88^2).
  In the paper and patent, gamma and sigma are SDs. Port the variances.
- Patent inconsistency: the patent text prints "gamma^2 = 0.0222" in one place, but its simplified Eq. 2 adds 0.000484,
  which is 0.022^2, matching the JS. The patent also shows gamma = 0.024 (the "original" variance in the elite-runner
  figure) and gamma = 0.043 (learned from elite-runner data) as alternative embodiments [P165]. Zill uses 0.022, as the
  official code does.

### 2.3 Model behaviour the port must reproduce (computed by the oracle) [VP numerics, Section 10.12]

Observation model HR(CT) and slope (dHR/dCT, bpm per degC):

| CT degC | HR quadratic | slope quad | HR sigmoid | slope sigmoid |
|---|---|---|---|---|
| 36.0 | 27.8 | 55.29 | 44.3 | 9.78 |
| 36.5 | 54.3 | 50.72 | 52.5 | 24.23 |
| 37.0 | 78.5 | 46.15 | 68.6 | 39.53 |
| 37.5 | 100.4 | 41.57 | 90.8 | 47.58 |
| 38.0 | 120.1 | 37.00 | 114.6 | 46.31 |
| 38.5 | 137.4 | 32.43 | 136.1 | 39.03 |
| 39.0 | 152.5 | 27.86 | 153.4 | 29.89 |
| 39.5 | 165.3 | 23.29 | 166.2 | 21.50 |
| 40.0 | 175.8 | 18.72 | 175.2 | 14.84 |
| 40.5 | 184.0 | 14.15 | 181.3 | 9.98 |
| 41.0 | 189.9 | 9.57 | 185.4 | 6.59 |

Steady-state CT for a constant HR (the filter converges here), from the inverse observation model:

| HR | 45 | 60 | 70 | 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150 | 160 | 170 | 180 | 190 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CT quad | 36.32 | 36.61 | 36.82 | 37.03 | 37.26 | 37.49 | 37.74 | 38.00 | 38.28 | 38.58 | 38.91 | 39.28 | 39.71 | 40.24 | 41.01 |
| CT sigm | 36.07 | 36.76 | 37.03 | 37.27 | 37.48 | 37.69 | 37.90 | 38.12 | 38.35 | 38.60 | 38.89 | 39.24 | 39.69 | 40.38 | 42.07 |

Edge cases:
- The quadratic vertex is at CT = 42.047 degC, where HR = 194.96 bpm. A HR at or above about 195 bpm has no real
  inverse. The filter keeps pushing CT up, slowly: 30 min at 200 bpm takes CT from 37.1 to 38.63 degC (quadratic).
  Above the vertex the slope c becomes negative and updates would run backwards. Guard: if c <= 0, skip the
  measurement update [ENG]. The sigmoid has no real inverse at HR >= 193 or HR <= 41.
- Low HR drives CT down (30 min at 45 bpm gives 36.58 degC, quadratic). "The quadratic version of the algorithm does
  not adequately predict CBT under 36.0 degC" [E22]. Clamp displayed values to 35.5-42.0 degC [ENG]. Physio rules use
  only the high side.
- With v0 = 0 the filter trusts CT0 completely at first. The steady-state effective time constant is 19-31 min for
  CT 37.0-39.0 degC (quadratic), with a gain of about 0.00113-0.00115 degC per bpm of innovation:

  | CT degC | 37.0 | 37.5 | 38.0 | 38.5 | 39.0 | 39.5 | 40.0 |
  |---|---|---|---|---|---|---|---|
  | tau quad (min) | 18.6 | 20.6 | 23.2 | 26.5 | 30.8 | 36.9 | 45.9 |
  | tau sigmoid (min) | 21.7 | 18.0 | 18.5 | 22.0 | 28.7 | 39.9 | 57.8 |

- Minutes to reach a threshold from CT0 = 37.1 and v0 = 0 at constant HR (quadratic):

  | HR | 38.0 | 38.4 | 38.5 | 39.0 |
  |---|---|---|---|---|
  | 140 | 37 | 69 | 91 | never |
  | 150 | 31 | 48 | 55 | never |
  | 160 | 27 | 40 | 44 | 79 |
  | 170 | 24 | 34 | 38 | 58 |

  ECTemp is a slow, smoothed signal by design. An agricultural-worker validation discarded the first 30 min of each
  shift "given reported algorithm [convergence] times" [E22]. Zill treats the first 30 min after any (re)initialization
  as warm-up: ECTemp may not escalate during warm-up [ENG, anchored on E22].

### 2.4 Data handling for the port [VP unless tagged]

1. Aggregate to 1-minute means before filtering [P165]. **Never feed 1-s or 5-s samples as separate observations.**
   sigma = 18.88 bpm was learned for 1-minute means. Feeding 60 observations per minute would over-weight HR roughly
   60-fold and make CT track HR far too fast [ENG reasoning].
2. Missing or invalid minute: do the time update only (CT unchanged, v += 0.000484). This is standard Kalman practice
   and the fixture "missing_20_34" demonstrates it [ENG]. The 2013 paper has no explicit missing-data rule [P165].
3. Sparse devices (HR interval longer than 1 min): the patent linearly interpolated [P165]. Interpolate only across gaps
   of 5 min or less; treat longer gaps as missing [ENG]. Egbert 2022 imputed only gaps of 1 min or less, using the median
   of the 5 samples before and the 5 after, and excluded longer gaps [E22].
4. Gap longer than 30 min, or a device swap: re-initialize at the default CT0 and v0, then apply a new 30-min warm-up
   [ENG]. Because ECTemp can only escalate (Section 4.3), a restart can delay escalation but can never lower risk.
5. Pre-filter used in the occupational validation [E22]: drop HR below 40 or above 200 bpm, apply a 5-point rolling
   median, then take 1-minute averages. Zill's SQI in Section 4.2 generalizes this.

### 2.5 Reported accuracy and validations (all Bland-Altman against ingestible pill or rectal temperature)

| Study | Population / setting | Bias +/- SD (degC) | 95% LoA | RMSE | Notes |
|---|---|---|---|---|---|
| Buller 2013 [B13][P165] | Development n=17 field; validation N=83, 9 studies, more than 52,000 min | -0.03 +/- 0.32 | +/-0.63 | 0.30 +/- 0.13 | Literature rectal vs oesophageal LoA averages +/-0.58. Hydrated baseline condition 0.31 +/- 0.36 (LoA +/-0.71). MOPP-IV road march -0.28 +/- 0.34 (LoA +/-0.67). "At low work rates the model significantly underestimates ... at very high work rates the model significantly overestimates" [P165] |
| Buller 2015 [B15] | 27 soldiers in chem/bio PPE, 45-90 min | 0.02 | +/-0.48 | 0.21 | Hotter participants averaged 140 bpm and reached about 39 degC |
| Looney 2018 [L18] | 16 volunteers, sleep and inactivity | sigmoid -0.04 +/- 0.26; quadratic -0.19 +/- 0.29 | - | 0.26 vs 0.35 | The sigmoid "corrects lower CT estimates while producing nearly identical estimates ... at higher CT" |
| Hunt 2019 [H19] | 8 males, EOD suits, WBGT 20.9 and 29.0 degC, work and recovery | 0.01 | +/-0.64 | 0.32 | By gastrointestinal temperature (TGI) band: 37.0-37.5: 0.08 +/- 0.58; 37.5-38.0: -0.02 +/- 0.69; 38.0-38.5: -0.07 +/- 0.63; above 38.5: **-0.32 +/- 0.56**. "An ECTemp limit of 38.4 degC ... would protect the majority ... (> 39.0 degC)" |
| Buller 2020 [B20] | 21 Royal Marines, 14.5 km loaded march, 16 degC | HOT group -0.10 +/- 0.37 (up to 40.0) | - | 0.37 +/- 0.13 | WARM group overestimated: +0.34 +/- 0.40. A correction based on skin-temperature entropy at 20 min gave 0.00 +/- 0.29 |
| de Korte 2022 [dK22] | 101 elite athletes (49 M / 52 F), 31.6 degC / 74% RH, 44 +/- 10 min | 0.15 +/- 0.29 | +/-0.45 (as reported) | 0.35 +/- 0.18 | Sigmoid version, CT0 = 37.0, v0 = 0.02. Sensitivity 73-96% and specificity 72-93% for thresholds 37.75-38.75; **sensitivity 50-0% for thresholds above 39.0** (48% at 39.0, 4% at 39.5) |
| Egbert 2022 [E22] | 35 pear and apple harvesters (WA, USA), 13,413 min | -0.14 | +/-0.76 | - | Individual biases -0.006 to -0.75. Tympanic + 0.27 degC start: -0.09 (+/-0.90). PSI from ECTemp: bias -0.29 (LoA +/-1.59) |
| Peggen 2024 [P24] | 18 walkers aged 56 +/- 16, 30-50 km, 22 to 29 degC | 0.09 | +/-0.44 | - | Correlation r = 0.28. Individual bias -0.45 to +0.62. Only 3 of 18 had bias below 0.1 |
| Falcone 2024 [F24] | 13 workers (6 F), age 47 +/- 4, 32 degC | - | - | Buller 0.34 +/- 0.16 vs biphasic 0.28 +/- 0.12 (NS) | Valid only up to about 38 degC |
| Lignier 2026 [Lg26] | Construction workers, Midwest USA; Polar H10 n=102, Garmin Instinct 2 (PPG) n=60 | Garmin -0.09 +/- 0.28; Polar -0.16 +/- 0.30 | Garmin -0.63 to +0.45 | 0.28 / 0.32 | 2022 ECTemp version, CT0 = 37.1, v0 = 0.01. PPG vs chest HR bias 1.6 +/- 4.9 bpm. Peak pill 39.1 degC or lower, so validity above that is unknown. Authors advise group-level use |

Detection performance (what matters for alerts):
- Buller 2025, 5,080 Marine recruits, 30 EHI cases [B25] [VP]. aPSI flagged 86.7% of cases and single-point skin
  temperature 83.3% (about 35-min alert time, about 15% false positives). PSI flagged 63.3%, the core-skin
  difference 60%, and **ECTemp only 23.3%**. aPSI missed 2 febrile viral infections and 2 heat-exhaustion cases with
  field rectal temperature below 39 degC.
- Buller 2022, 1,806 soldiers, 3,422 high-risk datasets, 6 heat-stroke cases with rectal temperature above 41 degC
  [B22] [VP]. ECTemp was 39.2-40.8 degC in the cases. ECTemp plus a gait-instability index flagged all 6 at least
  3.5 min before collapse, with 6.1% false positives (209) and no false negatives. Sensors were chest-worn.
- Atkinson 2026 [A26] [VP]: ECTemp rose faster in 7 heat-stroke cases than in 21 matched controls (P = 0.001). HR and
  skin temperature were higher from the second quartile of the march onward.

### 2.6 Refinements

1. Sigmoid (generalized logistic) observation model (Looney 2018; patent eq. 10) [VP constants; derivative re-derived
   and checked]:
   ```
   HR = A + (K - A) / (1 + Q*exp(-B*(CT - M)))^(1/nu)
   A = 41, K = 193 (K - A = 152), Q = 0.06, B = 0.89, M = 37.84 degC, nu = 0.07
   dHR/dCT = (K-A)*Q*B/nu * e * (1 + Q*e)^(-(1/nu) - 1),  e = exp(-B*(CT - M))
           = 8.1168/0.07 * e * (1 + 0.06 e)^(-15.2857)       (matches the patent's eq. 11 constants)
   inverse (A < HR < K): CT = M - ln( (((K-A)/(HR-A))^nu - 1) / Q ) / B
   ```
   Time update and sigma are unchanged (gamma^2 = 0.000484, sigma = 18.88) [P839]. In the patent's own split, the
   development data gave quadratic -0.15 +/- 0.29 [-0.72, 0.42] vs sigmoid 0.00 +/- 0.28 [-0.55, 0.55], and the
   validation data gave quadratic -0.22 +/- 0.30 [-0.81, 0.37] vs sigmoid -0.13 +/- 0.26 [-0.64, 0.38] [P839]. The
   analytic derivative matches a finite difference to 2.4e-7.
2. Initial core temperature options found in the literature:

   | Option | CT0 | v0 | Source |
   |---|---|---|---|
   | Official default | 37.1 | 0 | [USARIEM-JS] |
   | 2022 ECTemp (sigmoid), elite athletes | 37.0 | 0.02 | [dK22] |
   | 2022 ECTemp, construction workers | 37.1 | 0.01 | [Lg26] |
   | Measured start (research) | observed | 0 | [P165] |
   | Tympanic + 0.27 degC | measured | - | [E22] (bias -0.09 but wider LoA +/-0.90) |
   | Biphasic model | 37.43 (group mean at rest) | 0 | [F24] |

   **"Looney et al. adaptive initial core temperature" [UNVERIFIED].** No paper with this method was found. Searches
   covered PubMed (Looney DP [au] with core temperature), Crossref and the web. Related items found: (a) Looney 2018
   [L18], the sigmoid model for resting CT; (b) the patent claims that set the initial CT "based solely on the first
   heart rate" [P165][P839], with no formula disclosed in the retrieved text; (c) an MSSE 2021 abstract, "Improved Heart
   Rate-based Core Body Temperature Predictions Using Simple Time Series Adjustments" (Looney, Doughty, Holden,
   Vangala, McClung, Santee, Pryor, Pryor, Potter; MSSE 53(8S):363) [L21], whose content was not retrievable.
   Zill default: CT0 = 37.1 and v0 = 0. Do not implement HR-derived initialization: it is unvalidated here and is
   claimed in the US patents.
3. Biphasic Kalman filter (Falcone 2024, Italian workers including women) [F24]. It uses separate rising and falling
   models, switched at a fixed 115 bpm after 3 consecutive 30-s averages above or below the threshold. It reported
   gamma (SD) of 0.016 rising and 0.011 falling, and sigma of 14.081 and 8.692. **Do not implement.** As extracted, the
   rising-phase equation (HR = -35.3 CT^2 + 2678 CT - 50060) gives about 722 bpm at 37.4 degC, which suggests a typo in
   the source or the extraction. It is also validated only up to about 38 degC with n = 13.
4. Multi-model Kalman filters (Zhao and Bergmann 2025) [Z25]: within-dataset RMSE 0.38-0.41 degC, but cross-dataset
   RMSE 0.88 degC (state-specific) and 1.56 degC (clustered). This is a warning about generalization; not for Zill v1.
5. Multi-sensor Kalman filter (skin temperature, heat flux and HR at the chest; Welles 2018): RMSE 0.18 degC in 8
   volunteers [W18]. This is a future option if a chest heat-flux sensor is ever used.

### 2.7 Limitations that drive Zill's fail-safe rules

| Limitation | Evidence | Consequence for Zill |
|---|---|---|
| Beta-blockers and other HR-suppressing states (sinus bradycardia, hypothyroidism, pacemaker) | NIOSH: "Medications (e.g., beta blockers) or pre-existing medical conditions (e.g., sinus bradycardia, hypothyroidism, pacemaker) can suppress heart rate" [NIOSH16]. Bisoprolol 5 mg lowered HR by 19 +/- 8 to 22 +/- 10 bpm at the aerobic and anaerobic thresholds [Wo03]. Beta-blockade cut exercise HR from 134 to 107 bpm [Pc90]. A 15-27 bpm offset makes the quadratic model underestimate steady-state CT by 0.39-0.92 degC (oracle) | Users who flag HR-suppressing medication get ECTemp and PSI turned off (display and escalation). They are protected by the environmental and symptom channels |
| Underestimation at high CT | Bias -0.32 above 38.5 degC [H19]. Sensitivity 48% at 39.0 [dK22]. 23.3% EHI detection [B25] | ECTemp thresholds sit conservatively low (38.0/38.4/39.0). ECTemp below threshold never lowers risk |
| Overestimation at moderate or very high work, hydrated or cool conditions | WARM group +0.34 [B20]. Hydrated baseline +0.31 [P165]. ECTemp counted more workers above 38.5 than the pill did (34% vs 17%) [E22] | Accept the extra false alarms. The alert copy says "check yourself", not "you are overheating" |
| Fever, infection, stress, caffeine, dehydration | The patent says the effect of "elevated heart rate from sustained psychological stress ... is unknown" and that diet and caffeine effects are "likely ... outweighed" by activity and thermoregulation [P165]. Fever cases were missed by aPSI [B25] | Recent febrile illness is a risk flag (Section 7). Physio alerts are not diagnostic |
| Passive heat exposure (rest in heat) | The model is built on exercise HR-CT coupling. The patent lists "passive heating and cooling" among later adjustments [P839] | Do not show or escalate on ECTemp while the activity level is "resting" for more than 60 min [ENG] |
| Population | Development data were young US soldiers. Validations cover athletes, soldiers, some older walkers and US farm and construction workers. Few women; no Gulf migrant-worker data | Individual bias can reach about +/-0.7 degC [E22][P24]. Present ECTemp only as an estimate with its band (value +/-0.6 degC) or as a coarse category, never as a bare precise number [ENG] |
| PPG input | PPG adds error (bias 1.6 +/- 4.9 bpm vs chest strap in construction work) [Lg26] | SQI gating (Section 4) |

## 3. Physiological Strain Index (PSI) and adaptive PSI

### 3.1 PSI (Moran, Shitzer, Pandolf 1998) [VP formula]

```
PSI_t = 5*(Tre_t - Tre_0)/(39.5 - Tre_0) + 5*(HR_t - HR_0)/(180 - HR_0)
```
- Tre_t and HR_t are "simultaneous measurements taken at any time during the exposure", and Tre_0 and HR_0 "are the
  initial measurements". The ranges assumed are 36.5-39.5 degC (3 degC rise) and 60-180 bpm (120 bpm rise), with equal
  weights. It was applied to data from 100 men walking at 1.34 m/s and 2% grade for 120 min at 40 degC and 40% RH, and
  tested on a separate set of 7 men in protective clothing, where it "differentiated significantly (P < 0.05) between
  the two climates" [M98].
- It was later extended to hypohydration [M98b], to women vs men of matched fitness [M99], and to ages 50-70 [M02].
- Category bands (Moran 1998 Table 1, as reproduced in the USARIEM aPSI patent) [VS: the original full text is
  paywalled; P579 reproduces "Table 1 shows the original PSI levels ... according to Moran et al. (1998)"]:

| PSI | 0-2 | 3-4 | 5-6 | 7-8 | 9-10 |
|---|---|---|---|---|---|
| Strain | no/little | low | moderate | high | very high |

- Continuous values: the table lists integers only. Zill maps conservatively with ceil(): above 2 is low, above 4
  moderate, above 6 high, above 8 very high [ENG]. PSI can exceed 10: "It has been found in the past that it is
  possible to exceed a PSI of 10" [P579]. Log the raw value and clamp the display to 0-10 [ENG].
- With ECTemp: CT_0 is the ECTemp value at shift start (37.1 by default). HR_0 is resting HR, for example the lowest
  5-min mean while seated before work [ENG]. Egbert imputed HR_0 from the first 5 min using a regression [E22]. PSI from
  ECTemp had bias -0.29 and LoA +/-1.59 PSI units against pill-based PSI [E22].
- Known failure: PSI reads "too high" in elite athletes (11.4 +/- 0.8) and "too low" in encapsulated PPE (7.6 +/- 2.0)
  at similar HR of about 180 bpm. This is why aPSI was created [B23].

### 3.2 Adaptive PSI (aPSI) [VP equation from P579; performance from B25]

```
aPSI = 5*(CT_t - CT_rest)/(CT_crit - CT_rest) + 5*(HR_t - HR_rest)/(HR_crit - HR_rest)
HR_crit = 0.90 * (220 - age)
CT_crit = 39.5 + ((CT_t - Tsk_t) - 4) / 4        (Tsk = skin temperature)
If only HR is available (no Tsk): CT computed from HR and CT_crit = 39.5 degC  [P579]
```
- With a core-skin gradient of 4 degC, CT_crit is 39.5. With a gradient of 0 (skin as hot as core, as in encapsulation)
  it is 38.5. With a gradient of 8 it is 40.5.
- aPSI detected 86.7% of EHI cases with about 35-min lead time and about 15% false positives [B25]. It needs chest skin
  temperature: the studies used chest-worn monitors, and the patent says skin temperature "is modified based on the
  location of the sensor" without giving the correction. **Do not use wrist skin temperature in aPSI** [ENG]. Without a
  validated chest Tsk, aPSI reduces to PSI with HR_crit = 0.9 x (220 - age).

### 3.3 HR-only occupational criteria (useful when CT is unreliable) [VP, NIOSH16]

- "Heat strain is indicated by a sustained HR > 180 bpm minus the worker's age."
- Brouha recovery test (seated, after a work cycle): P1 is the pulse from 30 s to 1 min, P3 from 2.5 to 3 min. Stress
  is "above acceptable values" if oral temperature exceeds 37.5 degC, P1 exceeds 110 bpm, and/or P1 - P3 is fewer than
  10 bpm. Fuller and Smith variant: P3 of 90 bpm or less is satisfactory; P3 above 90 with P1 - P3 below 10 means the
  stress "is too high".
- Brouha averages for fit young workers: about 110 bpm for an 8-h shift, 140 bpm for no more than 4 h, 160 bpm for no
  more than 2 h.
- WHO limit cited by NIOSH: deep body temperature "should not ... exceed 38 degC" under prolonged daily work and heat.

## 4. Wearable signal quality and fail-safe design

### 4.1 Evidence on wrist-PPG HR accuracy

- Three error sources are "diverse skin types, motion artifacts, and signal crossover". Bent et al. found "no
  statistically significant difference in accuracy across skin tones", but error during activity was about 30% higher
  than at rest [Be20] [VP]. A 60-person, 7-device study found higher error with male sex, higher BMI, darker skin and
  walking; 6 of 7 devices had median HR error below 5% while cycling [Sh17] [VP]. The skin-tone evidence is mixed;
  test in the target workforce.
- Concordance with ECG: chest strap rc = 0.996, Apple Watch 0.92, TomTom 0.83, Garmin 0.81, Scosche 0.75, Fitbit 0.67.
  "None of the devices was accurate during elliptical trainer use with arm levers (all rc < 0.80)". "Electrode-containing
  chest monitors should be used when accurate HR measurement is imperative" [Gi17] [VP]. Lifting, hammering and
  shovelling are arm-intensive, so expect the worst-case accuracy.
- Heat: across 10 devices in 23, 36 and 10 degC chambers, "the climate conditions did not significantly affect the
  measurement accuracy"; intermittent walking increased error. MAE was 4.5-14 bpm and MAPE 5.5-16% [Ge26] [VP]. NIOSH
  warns that with chest straps, "data loss can occur when contact with skin is lost during exertion or excessive
  sweating" [NIOSH16].
- Field occupational data: a Garmin PPG watch vs a Polar H10 chest strap on construction workers gave bias
  1.6 +/- 4.9 bpm (LoA -8.1 to 11.3). ECTemp from the two sources differed by 0.03 +/- 0.06 degC [Lg26] [VP].
- Accuracy targets: the Consumer Technology Association recommends MAPE below 10% (ANSI/CTA-2065) [CTA] [VS, review
  PMC9871762]. INTERLIVE gives a validation checklist [Mu21].

### 4.2 Minute-level SQI (port-ready; per wearable, per minute)

Inputs per minute: raw HR samples (t, bpm), an optional device contact or quality flag, and the device's nominal sample
interval Δs.

| Rule | Threshold | Basis |
|---|---|---|
| R1 plausibility | 40 <= HR <= 200 bpm, otherwise the sample is invalid | [E22] worker validation exclusion rule [VP] |
| R2 contact | Device contact or quality flag false: the sample is invalid | Device-specific [ENG] |
| R3 harmonic or jump | Within each fixed 10-s segment [0,10), [10,20) ... [50,60): if max/min >= 2.2, every sample in the segment is invalid | Orphanidou 2015 feasibility rule "max to min beat-to-beat interval ratio < 2.2" [Or15, VS via CinC 2024]. Also catches PPG double- or half-rate locking |
| R4 flatline | At least 10 samples in the minute, all identical: every sample is invalid | [ENG] (stuck sensor or repeated last value) |
| R5 coverage | psi = n_valid / round(60/Δs), capped at 1. The minute is valid if psi >= 0.80 | "Most investigators ... require at least 80% normal R-R intervals" [Pt12] (analogy) |
| R6 noise scaling | For valid minutes, R = sigma^2 x exp(psi^-2 - 1) (1.0 at psi = 1; 1.755 at psi = 0.8) | Li, Mark, Clifford 2009 eq. 13, R = R0 exp(psi^-2 - 1); below psi_t the filter "is not updated" (psi_t = 0.5 there) [Li09][VP]. Zill uses psi_t = 0.80 [ENG] |
| R7 minute HR | Mean of the valid samples | [P165] |
| R8 channel validity | At least 10 of the last 15 minutes valid, AND warm-up of 30 min complete, AND no HR-suppressing-medication flag | [ENG], warm-up per [E22] |

Other SQIs exist for raw PPG waveforms: template matching [Or15], with PPG sensitivity and specificity of 91% and 95%,
and skewness, which was best among 8 SQIs [El16]. Use them only if raw PPG is available. Consumer health platforms
usually expose only HR samples.

### 4.3 Fail-safe architecture (normative)

1. Final level = max(environmental level, physio floor if the physio channel is valid, symptom check-in level). An
   invalid, missing or stale physio channel contributes nothing. It can never lower the level [ENG; principle of the
   task brief].
2. The physio channel can only raise the level. Below-threshold ECTemp or PSI is never shown as "safe". The UI shows
   "Body signals: no warning". When the channel is invalid it shows "Body signals unavailable - using weather and work"
   [ENG].
3. A sustained implausible HR (more than 200 bpm for 2 min or more with good contact) does not feed ECTemp. It prompts
   a symptom check-in and a buddy check, so the signal is not silently discarded [ENG].
4. HR-suppressing medication flag: ECTemp, PSI and HR rules are disabled for that worker [NIOSH16][Wo03] [ENG policy].
5. Escalation from the physio channel triggers human checks (symptom check-in plus buddy). It never auto-calls 998,
   because CT estimates cannot detect CNS dysfunction. Calls are driven by the symptom and buddy items [ENG; B25
   sensitivity data].
6. If a prompted check-in goes unanswered for 5 min while the final level is T1 or above, notify the buddy, then the
   supervisor [ENG].

## 5. Exertional heat illness: recognition, first aid, escalation

### 5.1 Sources and their status

- ACSM Expert Consensus Statement on Exertional Heat Illness (Roberts, Armstrong, Sawka, Yeargin, Heled, O'Connor),
  Curr Sports Med Rep 2023;22(4):134-149 [ACSM23]. **Full text is paywalled** (the Ovid DOI target returned HTTP 402).
  The abstract was verified: EHS is "a true medical emergency"; "stopping activity (body heat generation), and providing
  rapid total body cooling are essential for survival"; "time is tissue"; there is a "synchronized chain of survival".
  The 2021 version (Curr Sports Med Rep 2021;20(9):470-484) carries a 2023 erratum. A 2023 letter by Casa and 14
  co-authors records that the corrigendum notes "one author cast a dissenting vote" on four issues [Casa23]. The ACSM
  numeric recommendations were therefore not transcribed. Every number below comes from open primary sources: NIOSH,
  OSHA, TB MED 507, ILCOR, IOC, the NATA executive summary and peer-reviewed trials.
- US Army TB MED 507 (12 April 2022) [TBMED], NIOSH 2016 Criteria Document [NIOSH16], the CDC/NIOSH illness page (last
  reviewed 3 Mar 2026) [NIOSH-ILL], OSHA's first-aid page [OSHA-FA], the ILCOR First Aid CoSTR (2 Nov 2019) [ILCOR19],
  the IOC prehospital EHS statement [IOC21], the NATA 2015 position statement and executive summary [NATA15][NATA15-ES],
  and the Sharjah SPSA code OSHJ-CoP-33 (v2, 3 Jul 2024) [SPSA24].
- Local precedent: Abu Dhabi's "comprehensive, multimedia, economical education and awareness" programme, Safety in
  the Heat, reached "465 companies employing 814 996 heat-exposed workers across 6254 work and labor residence sites".
  One company reported "a combined 79.5% decrease in cases (15.3 vs 1.16 cases per 1000 workers)" over 2008-2009 [J11].

### 5.2 Spectrum of heat illness (worker-facing summary plus first-aider actions)

| Condition | Key signs (sources) | First aid (sources) | Zill level |
|---|---|---|---|
| Heat rash (miliaria) | "Red clusters of pimples or small blisters", on the neck, upper chest, groin, under the breasts and in elbow creases [NIOSH-ILL]. It impairs sweating and increases heat storage [TBMED 4-3e] | Cooler, less humid place; "Keep the rash area dry"; powder; "Don't use ointments and cream" [NIOSH-ILL] | T1 |
| Heat cramps (EAMC) | "Muscle cramps", "Pain or spasms in the abdomen, arms, or legs" [NIOSH-ILL] | "Drink water and have a snack or a drink that replaces carbohydrates and electrolytes ... every 15 to 20 minutes"; "Avoid salt tablets"; get medical help if the worker "has heart problems", "is on a low sodium diet", or "has cramps that do not subside within 1 hour" [NIOSH-ILL]. No resumption of strenuous work "for several hours or longer after heat cramps go away" [SPSA24] | T1, or T2 if heart disease, a low-sodium diet, or cramps lasting 60 min or more |
| Heat syncope | "Fainting (short duration)", dizziness, light-headedness on standing [NIOSH-ILL]. "When syncope occurs during or after work, it may indicate a mild, moderate, or severe form of exertional heat illness"; rule out cardiac and other causes [TBMED 4-3c] | "Sit or lie down in a cool place"; "Slowly drink water, clear juice, or a sports drink" [NIOSH-ILL] | T2. T3 if not fully alert |
| Heat exhaustion | Headache, nausea, dizziness, weakness, irritability, thirst, heavy sweating, elevated body temperature, decreased urine output [NIOSH-ILL]. Core above 38 degC with organ-system dysfunction but no CNS injury [NIOSH16 glossary]. TB MED adds transient ataxia and transient mildly impaired cognition, and warns that the distinction between heat exhaustion, heat injury and heat stroke "can be challenging even for the best clinicians" [TBMED 4-4] | "Take worker to a clinic or emergency room for medical evaluation and treatment"; "Call 911 if medical care is unavailable"; stay with the worker; cool them; frequent sips [NIOSH-ILL]. Heat-exhaustion patients "generally demonstrate rapid improvement (within the first hour) ... those failing to respond ... should be evacuated" [TBMED 5-1b] | T2. T3 if not improving or worsening |
| Exertional heat injury | Sustained mild confusion or disorientation plus vital-organ injury; laboratory evaluation needed, with "re-evaluation necessary on the following day" [TBMED 4-5] | Medical care | T3 (confusion means emergency) |
| Exertional heat stroke (EHS) | "Profound central nervous system (CNS) dysfunction (for example, delirium, agitation, inappropriate aggressiveness, convulsions or coma) ... in the presence of severe hyperthermia"; often defined as rectal temperature above 104 degF (40 degC), "although reliance on a specific rectal temperature value is not advised" [TBMED 4-6]. IOC: "generally >= 40.5 degC" [IOC21]. NATA: CNS dysfunction plus core above 105 degF (40.5 degC) [NATA15-ES]. NIOSH: "Confusion, altered mental status, slurred speech", loss of consciousness, "Hot, dry skin or profuse sweating", seizures [NIOSH-ILL] | Call emergency services, stay with the worker, cool immediately: "With a cold water or ice bath, if possible", wet skin, cold wet cloths, soak clothing, circulate air, ice or cold cloths on head, neck, armpits and groin [NIOSH-ILL]. OSHA: "call 911 immediately and cool the worker with ice or cold water until help arrives"; "When in doubt, cool the worker and call 911" [OSHA-FA] | T3 |
| Exertional rhabdomyolysis | "Muscle cramps/pain", "Abnormally dark (tea or cola-colored) urine", weakness, exercise intolerance, can be asymptomatic [NIOSH-ILL]. Brown (cola-coloured) urine "indicates the need for IV fluid intervention" [TBMED 5-4c] | "Stop activity", drink water, "Seek immediate care at the nearest medical facility", ask for a creatine kinase test [NIOSH-ILL] | T2 plus medical facility in the same shift |
| Exercise-associated hyponatremia (EAH) | Serum Na below 135 mmol/L during or up to 24 h after activity [WMS19]. Symptoms "may include acute mental status changes, seizures, coma, headache, confusion, visual disturbances/changes, nausea, and recurrent vomiting"; extremity edema. It occurs mainly in people "drinking water well above 1 1/2 quarts per hour". "Lack of urination is not a reliable indicator" [TBMED 5-4b]. It overlaps with heat exhaustion and EHS [WMS19] | "If EAH is suspected, restrict fluids", get a point-of-care sodium test, document fluid intake [TBMED 5-4b] | T2 with no plain water. T3 if confused or seizing |

Red flags, any of which means T3 (emergency 998 now):
- Confusion or disorientation.
- Strange, irrational or aggressive behaviour.
- Slurred speech, or stumbling and inability to walk straight.
- Collapse with incomplete recovery.
- Seizure, unresponsiveness or coma.
- Recurrent vomiting.
- Chest pain or breathing difficulty.

Sources: [NIOSH-ILL][TBMED Table 5-1: "persistent mental status changes", "delirium", "inappropriate behavior or
aggressiveness", "convulsions and/or seizures", "coma", "recurrent vomiting", "loss of bowel control", "flaccid muscles
or persistent rigidity", "weak or rapid pulse"][OSHA-FA]. Chest pain is a general emergency criterion and is not taken
from the heat sources [ENG]. A sudden collapse can also be cardiac: "medical providers must first exclude any cardiac
cause" [IOC21][TBMED Table 5-3].

### 5.3 Cooling: cool first, transport second

- Principle: "Delay in cooling is the single most important factor leading to death or residual serious disability ...
  Do not delay cooling for want of rectal temperature" [TBMED 5-1b]. Organ damage, morbidity and mortality rise
  significantly when cooling is delayed beyond 30 min, which is "faster than the average EMS transport and ED evaluation
  window" [Bv18]. Race-medicine series report "100% survival" when athletes are cooled "within the first 30 min of
  collapse, using whole-body cold water immersion on site" [IOC21]. The NATA rule is that a suspected EHS patient is
  cooled by CWI before EMS transport, with the goal of getting core temperature "below 102.5 degF [39.2 degC] within 30
  minutes of collapse" [NATA15-ES].
- ILCOR recommendation (weak recommendation, very low certainty) [ILCOR19] [VP]: "We recommend immediate active cooling
  using whole body (neck down) water immersion techniques (1-26 degC; 33.8-78.8 degF)" "until a core body temperature of
  less than 39 degC (102.2 degF) is reached". "Where water immersion is not available, any other active cooling
  technique" should be started. The meta-analysis found no single water-temperature band clearly faster within 1-17 degC
  [D20].
- Temperature measurement: ILCOR states that "core temperature measurement should be available in first aid settings"
  where heat-stroke risk is high, and that peripheral readings are "an unreliable indication of core temperature
  cooling" [ILCOR19].
- Cooling rates:

| Method | Rate | Source |
|---|---|---|
| Ice-water immersion (about 36 degF / 2 degC) | 0.25-0.50 degF/min (0.14-0.28 degC/min) | [TBMED 5-1b] |
| CWI, NATA estimate when rectal temperature is unavailable | about 0.37 degF/min (0.21 degC/min), "1 degF every three minutes" | [NATA15-ES] |
| Cooling-rate classification | "Ideal" 0.155 degC/min or more; "acceptable" 0.078-0.154 degC/min | McDermott 2009 [McD09] [VS via later J Athl Train papers] |
| TACO, 2.1 degC water | 0.14 +/- 0.06 degC/min (passive 0.04) | [Lu16] |
| Tarp-assisted cooling, 9.2 degC water | 0.17 +/- 0.07 degC/min (passive 0.04) | [Ho17] |
| Continuous cold-water dousing on a litter (113 EHS patients) | about 0.10 degF/min (0.056 degC/min) | [TBMED 5-1b] |
| Iced sheets, re-iced every 3 min | about 0.06 degF/min (0.033 degC/min); "a drop of 1.2 degF over 20 minutes could be life-saving" | [TBMED 5-1b, Table 5-2] |
| Ice packs to neck, axilla and groin vs passive | Mean difference 0.02 degC/min (95% CI -0.03 to 0.07), not significant; packs to cheeks, palms and soles: 0.18 (0.12-0.24) | [ILCOR19] |
| Rotating ice-water towels | Change every 1-2 min | [IOC21] |

- Stopping and overcooling: trained staff continue "until mental status returns to normal and body core temperature is
  102 degF [38.9 degC]", then check rectal temperature every 5 min [TBMED]. The IOC and ILCOR targets are below
  39 degC. Rectal temperature is the only valid field measure; "Do not rely on ear, forehead, armpit, or oral" readings
  [TBMED]. Lay rescuers cannot measure it.
- Lay-rescuer protocol for Zill [ENG, built from the above]:
  1. Call 998 and alert the first aider and supervisor.
  2. Move the worker to shade and strip outer clothing.
  3. Use whatever is available, best first: (a) tub or TACO tarp with ice water, neck-down, water stirred; (b) continuous
     cold-water dousing plus fanning; (c) rotating ice-water towels every 1-2 min plus ice packs (including cheeks,
     palms and soles).
  4. Continue until EMS takes over. Without a thermometer, stop full ice-water immersion after about 15 min or when the
     worker becomes alert and oriented, whichever is first, then continue dousing and fanning. ILCOR: where core
     temperature is unknown, cooling "should be continued until there has been resolution of symptoms or for a
     reasonable amount of time, such as 15 minutes" [ILCOR19]. At about 0.2 degC/min, 15 min gives about 3 degC of
     cooling [NATA15-ES rate]. ILCOR listed overcooling and hypothermia as outcomes, but "Included studies did not
     report significant hypothermia or thermal injuries during cold-water immersion across the recommended temperature
     ranges" [ILCOR19].
  5. Give oral fluids only if the worker is fully alert and not vomiting. If they are not alert, use the recovery
     position [TBMED].
- Site heat-stroke kit (employer readiness) [ENG from TBMED Table 5-2, IOC21]: a tarp or tub; an ice chest filled
  "1/3 cool water and 2/3 ice"; "5 per anticipated heat casualty" sheets or towels soaking in it, re-wetted "every 3
  minutes" in use; a water source; and a fan. Post the 998 instructions in the site's working languages [SPSA24
  signage requirement].

### 5.4 When to call emergency services (998)

Call 998 immediately (T3) for:
- Any red flag in Section 5.2.
- Recurrent vomiting or inability to drink.
- A heat-exhaustion picture that worsens at any time, or does not clearly improve by the re-check. Zill's re-check is
  at 30 min [ENG]; TB MED's outer limit is "within the first hour" [TBMED 5-1b], and Sharjah requires calling EMS "if
  the employee does not respond to initial first aid treatment" [SPSA24].
- Heat-exhaustion signs where no clinic is reachable ("Call 911 if medical care is unavailable") [NIOSH-ILL].
- Suspected hyponatremia with confusion or seizure [TBMED].
- Chest pain or breathing difficulty [ENG].
- Doubt: "When in doubt, call 911!" [OSHA-FA].

### 5.5 UAE emergency numbers [VP, official portal u.ae, "Last updated 01 Oct 2026"]

| Service | Number |
|---|---|
| Ambulance | 998 |
| Police (also general emergencies, "from anywhere in the UAE") | 999 |
| Fire Department (Civil Defence) | 997 |
| Coastguard | 996 |
| Search and Rescue | 995 |
| Electricity failure | 991 |
| Abu Dhabi app | AD999 (fire, ambulance, SOS button) |
| Abu Dhabi, people of determination | SMS 5999 for medical emergencies |

The Sharjah code tells employers to "dial 999 for medical assistance" for heat stroke [SPSA24]. Zill's emergency
screen calls 998 first and offers 999 as a fallback [ENG]. Re-verify the numbers at each release.

### 5.6 Pictogram-friendly yes/no symptom check-in (design)

Design principles (cited):
- Pair pictures with spoken words. "Patients with very low literacy skills can be helped by spoken directions plus
  pictures". Use simple captions, include the target audience in design, and evaluate with and without pictures [Ho06].
- Locally co-designed pictograms beat generic ones. At follow-up, 20 of 23 local pictograms met "the ANSI criterion of
  >= 85% comprehension", against 11 of 23 USP pictograms [DE01].
- Acceptance test: ANSI Z535.3 requires at least 85% correct comprehension with fewer than 5% critical confusions
  [CPSC] [VS]. Test method: ISO 9186-1:2014. The standard is paywalled, so its pass threshold was not verified
  [UNVERIFIED].
- Regulators require heat training "in languages and in a format that employees understand" and a buddy system [SPSA24].
  NIOSH's buddy system watches for "weakness, unsteady gait, irritability, disorientation, changes in skin color, or
  general malaise" [NIOSH16].

UI [ENG]:
- One item per screen, with a big pictogram and an audio prompt that auto-plays in the worker's language.
- Two large answer buttons: YES (filled icon plus colour plus spoken "yes") and NO, fixed in the same positions on every
  screen. Avoid gestures with cultural meanings, such as thumbs.
- Any T3 answer jumps straight to the emergency screen. Remaining items can be skipped.
- Candidate languages to user-test in Abu Dhabi: Arabic, English, Hindi, Urdu, Malayalam, Tamil, Bengali, Nepali,
  Tagalog, Pashto, Sinhala. These are examples, not a verified census.

| ID | Who | Prompt (plain words; translate and back-translate) | Pictogram concept | YES gives | Basis |
|---|---|---|---|---|---|
| B_CONFUSED | Buddy | "Is your coworker confused, acting strange or angry, or not answering normally?" | Head with question marks next to a worried helper | T3 | [NIOSH-ILL][TBMED T5-1, 4-6][OSHA-FA] |
| B_SPEECH_GAIT | Buddy | "Is their speech slurred, or are they stumbling or unable to walk straight?" | Wavy speech bubble; zig-zag footprints | T3 | [NIOSH-ILL][TBMED 4-4][OSHA-FA] |
| B_UNRESPONSIVE | Buddy | "Did they collapse and not wake up fully, shake or fit, or not respond?" | Person lying down with motion lines | T3 | [NIOSH-ILL][TBMED T5-1] |
| S_CHEST | Self | "Chest pain, hard to breathe, or heart racing strangely?" | Hand on chest; lungs | T3 | [ENG][TBMED T5-3][IOC21] |
| S_VOMIT_REPEAT | Self | "Vomited more than once, or cannot keep water down?" | Person vomiting, "x2" | T3 | [TBMED T5-1] |
| S_FAINTED | Self | "Did you faint or black out, even for a moment?" | Person falling | T2 (T3 if any buddy item is YES) | [NIOSH-ILL][TBMED 4-3c] |
| S_DIZZY | Self | "Dizzy or light-headed?" | Head with spiral | T2 | [NIOSH-ILL][TBMED T5-1] |
| S_HEADACHE | Self | "Headache?" | Head with lightning bolt | T2 | [NIOSH-ILL][TBMED T5-1] |
| S_NAUSEA | Self | "Feeling sick in the stomach?" | Hand on stomach, green face | T2 | [NIOSH-ILL][TBMED T5-1] |
| S_WEAK | Self | "Very tired or weak, more than usual?" | Drooping person; low battery | T2 | [NIOSH-ILL][TBMED T5-1] |
| S_URINE_BROWN | Self | "Is your urine brown, like tea or cola?" | Brown cup next to a cola bottle | T2 plus clinic in the same shift | [NIOSH-ILL][TBMED 5-4c] |
| S_OVERDRINK_SX | Self (or auto from the water log) | "Have you drunk a lot of water (more than about 1.5 L in the last hour) AND have headache, vomiting, or swollen hands?" | Many bottles plus swollen hand | T2 and stop plain water | [TBMED 5-4b, 3-7h] |
| S_CRAMPS | Self | "Painful muscle cramps?" | Leg with lightning | T1 (T2 if heart problems, low-salt diet, or cramps lasting 60 min or more) | [NIOSH-ILL][SPSA24] |
| S_RASH | Self | "Itchy red rash or prickly skin?" | Skin with red dots | T1 | [NIOSH-ILL][TBMED 4-3e] |
| S_URINE_DARK | Self | "Is your urine dark yellow (picture 5-8)?" | 8-colour strip | T1 at 7-8; advice at 5-6 (Section 6) | [McK15][NIOSH16 App B] |
| S_THIRST | Self | "Very thirsty?" | Dry mouth plus cup | T0 (drink-water advice) | [ENG] |

Mapping logic [ENG unless cited]:
1. Level = max over all YES items. The T0-T3 actions are:
   - T0, continue with precautions.
   - T1, stop strenuous work, rest in shade or a cool area, drink water plus a snack or electrolyte drink, notify the
     supervisor, re-check at 15 and 30 min.
   - T2, stop work, call the first aider now, cool, give sips if alert, stay with the worker, arrange medical evaluation
     the same day [NIOSH-ILL], no return to hot work today, re-check at 15 and 30 min.
   - T3, call 998, start cooling now, stay with the worker, alert the supervisor and first aider [OSHA-FA][NIOSH-ILL].
2. Escalate to T3 if any item worsens or a new red flag appears at a re-check [TBMED 5-1b][OSHA-FA]. Escalate T2 to T3
   if the worker is not clearly improving at 30 min. The 30-min figure is Zill's default; TB MED's outer limit is 60
   min [TBMED 5-1b][SPSA24].
3. Cramps lasting 60 min or more escalate to T2 [NIOSH-ILL].
4. Prompted check-ins fire at every rest break when the environmental level is high, whenever the physio channel
   escalates, and on demand. A buddy check is prompted every 60 min (30 min at the highest environmental level) [ENG].
5. "No answer" never means "no symptoms" (Section 4.3).
6. Decision-table test vectors are in Section 10.11.

## 6. Hydration self-assessment: urine colour

Evidence [VP]:
- Armstrong 1994: urine colour (8-shade chart) "was strongly correlated" with specific gravity and osmolality. It "may
  be used in athletic/industrial settings or field studies, where close estimates of Usg or Uosm are acceptable, but
  should not be utilized in laboratories" [Ar94].
- Armstrong 1998: urine colour "tracked changes in body water as effectively as (or better than)" osmolality, specific
  gravity, urine volume and plasma indices (9 men; 5.2% body-mass loss) [Ar98].
- McKenzie 2015: after exercise in 36 degC heat, "a urine color of 5 or greater identified BML >= 2% with 88.9%
  sensitivity and 84.8% specificity" (AUC 0.951; 22 men) [McK15].
- Kavouras 2016 (210 children aged 8-14): "the optimal self-assessed UC threshold for hypohydration was >= 4". Children's
  self-assessment accuracy was 67-78% [Kv16].
- Perrier 2016: about 1.1 L/day more fluid lightens 24-h urine by 2 shades; about 1.1 L/day less darkens it by 2 shades
  [Pe16].
- Reference values: free-living, euhydrated, active men averaged colour >= 4 (morning range 4-6) and "rarely (0-2% of
  measurements) achieved ... color of 1". "The first morning urine sample was more concentrated" [Ar10].
- NIOSH 2016 Appendix B uses a 6-shade chart: the top 3 shades are labelled "HYDRATED", the bottom 3 "DEHYDRATED", with
  "URGENT: Drink more water" at the boundary. Table B-1 lists diet, drug and disease causes of abnormal colour [NIOSH16].
- Limitations:
  - Urine indices "lag behind during periods of rapid body fluid turnover" [Po01], so pale urine right after heavy
    drinking can falsely reassure.
  - B-complex vitamins colour urine (yellow or orange); rifampin, phenazopyridine, senna and others change its colour
    [NIOSH16 Table B-1].
  - Urine indices have limited value in older people because their concentrating capacity declines [Pe16].
- Workplace context: expatriate manual workers in the Middle East were often "inadequately hydrated both on presentation
  for work and throughout the shift" [Ba10]. An Australian mining protocol used specific-gravity limits of 1.022 at
  start of shift and 1.030 at end of shift [BB03].

Zill mapping (Armstrong 8-shade; worker taps the closest swatch under daylight or white light) [ENG built on the cited
thresholds]:

| Shade | Code | Advice | Floor |
|---|---|---|---|
| 1-3 | U_OK | "Good. Keep drinking regularly." | T0 |
| 4 | U_DRINK_MORE | "Drink a cup of water now and at every break." (children's threshold >= 4 [Kv16]; adults often show 4 when euhydrated [Ar10]) | T0 |
| 5-6 | U_DEHYDRATED | "You are probably low on water (>= 2% body weight lost [McK15]). Drink 1 cup every 15-20 min, rest in shade. Check again at your next toilet visit." If it is still 5 or more, raise to T1 | T0, T1 if persistent |
| 7-8 | U_VERY_DARK | Rest, cool, drink, tell the supervisor. Any symptom: run the check-in | T1 |
| Brown, red or cola | U_BROWN_RED | Not a hydration colour. Possible rhabdomyolysis or blood: medical facility now [NIOSH-ILL][TBMED] | T2 |

Never drive drink advice above the fluid caps in Section 8. Show the vitamin, first-morning and older-adult caveats in the
help text.

## 7. Individual risk factors and handling (no numeric scores)

Doctrine [VP, TBMED 4-2]: "while the presence of more than one individual or environmental risk factor logically implies
greater risk, the desire to 'score' risk factors or assign cumulative risk is not recommended. Presently, there is not
enough evidence to justify a quantitative heat illness risk management matrix." The TB MED 507 Table 4-1 lists:
- Congenital: anhidrosis, ectodermal dysplasia.
- Functional: very heavy exertion, lack of heat acclimatization, low physical fitness, excess body composition, low
  work efficiency.
- Acquired: prior heat illness, fever or infection, medications, burn graft, miliaria rubra or sunburn, dehydration,
  alcohol use, sleep deprivation, supplement use.
- Environmental: high WBGT, clothing and equipment, lack of air movement, lack of shade, previous-day heat stress, access
  to air conditioning.

Among about 2,500 EHS cases in US service members from 2008 to 2014, "20% suffered a prior exertional heat illness; 30%
were diagnosed with at least one infection 2 months before or within 7 days after the EHS; and 33% were taking at least
one medication in the 2 weeks leading up to the EHS" [TBMED].

| Factor | Evidence | Zill handling |
|---|---|---|
| Prior heat illness | Prior EHI is in 20% of EHS cases [TBMED]. "A history of heat-related illness increases the risk of a repeat occurrence" [NIOSH16]. US Army personnel hospitalized for heat illness had 40% higher all-cause mortality than appendicitis controls [W07] | OH review flag plus conservative mode. Prior EHS: medical clearance before return to hot work [TBMED 5-5] |
| Medications | TB MED Table 4-2 and NIOSH Table 4-2 list anticholinergics, antihistamines, antipsychotics, tricyclics, stimulants (amphetamines and ADHD drugs, cocaine, ecstasy, ephedra, pseudoephedrine), lithium, diuretics, beta-blockers, ACE inhibitors and ARBs, alcohol, and photosensitizers. NIOSH also lists calcium-channel blockers, phenothiazines, barbiturates, haloperidol and laxatives. CDC (page dated 18 Sep 2025) adds SSRIs and SNRIs, antiseizure drugs, nitrates, antiplatelets, NSAIDs and levothyroxine, and advises patients to "avoid abruptly stopping any medications without having a plan in place" [CDC-MED] | The worker self-declares "I take medicine that may affect heat" without naming the drug. That turns on conservative mode, OH or pharmacist review, and the message "Do not stop your medicine; ask your doctor". **HR-suppressing drugs (beta-blockers etc.) disable ECTemp, PSI and HR rules** (Section 4.3) |
| Obesity / high body mass | "Heat disorders occur 3.5 times more frequently in the obese than in lean individuals" [NIOSH16]. "Excess body composition" is a functional factor [TBMED] | OH review only. Not employer-visible. Never a numeric input [ENG, ethics] |
| Low fitness | Low fitness is listed in [TBMED Table 4-1]. Fit workers acclimatize faster; significant acclimatization takes 3-5 days [TBMED App C] | Conservative mode during the first 14 days, or by OH decision |
| Not acclimatized (new, or returning after 1 week or more) | "Almost half of heat-related deaths occur on a worker's first day on the job" and "Over 70 percent ... during a worker's first week" [OSHA-NW, citing Tustin 2018]. Rule of 20%: 20% of normal duration on day 1, then +20% per day [OSHA-NW]. NIOSH says lack of acclimatization "has been shown to be a major factor" [NIOSH16] | Conservative mode for 14 days. Acclimatization plan per the environment and schedule spec |
| Recent febrile or GI illness | 30% of EHS cases had an infection within 2 months before or 7 days after. "EHS victims may be sick the day prior". GI illness causes dehydration "with proportionally larger electrolyte losses" [TBMED]. NIOSH says "low-grade infection, diarrhea, sleepless night, alcohol ingestion" may temporarily contraindicate exposure [NIOSH16]. aPSI missed febrile cases [B25] | Pre-shift question: fever, vomiting or diarrhoea in the last 3 days? YES turns on conservative mode, and the supervisor or OH decides on hot work today. The 3-day window is [ENG] |
| Alcohol | Alcohol before or during work in heat "should not be permitted" [NIOSH16]. "All alcohol-containing beverages ... should therefore be avoided" when training in heat [TBMED] | Optional pre-shift question (alcohol in the last 24 h); YES turns on conservative mode |
| Sleep deprivation | Evidence is mixed. Three nights at about 2 h of sleep did "not alter thermal strain" [Mo13]. 24 h without sleep raised symptom perception but caused no thermoregulatory change [Re18]. TB MED: "may or may not impair thermoregulation, but it may weaken resistance" [TBMED]. NIOSH lists a "sleepless night" [NIOSH16] | Optional pre-shift question; conservative mode. Tell users the evidence is weak |
| Age | Older workers have a "more sluggish response of the sweat glands" and reduced skin blood flow [NIOSH16]. Medical evaluation may include extra testing for workers "over 50 years of age or those younger than 50 years of age with underlying cardiac risk factors" [NIOSH16] | Age 50 or over: OH review recommended. Conservative mode at OH discretion |
| Religious fasting (Ramadan) | Gulf aluminium-smelter workers fasting in Ramadan showed rising HR and urine specific gravity in the first 4 h of the shift [Mj19]. Fasters "are undoubtedly dehydrating" in daylight. Headaches, irritability, sleep deprivation and lassitude are common. "Several categories of people are exempt or can postpone" [Le03]. The UAE cuts private-sector hours by 2 h/day in Ramadan [MOHRE26] | Self-declared "fasting today" turns on conservative mode. No drink reminders during declared fasting hours; emphasize shade, rest and cooling, and heavy work early or after iftar where possible. Symptoms always override: "first aid comes first". Zill gives no religious rulings [ENG] |
| Heat rash or sunburn | Impairs sweating [TBMED 4-2g] | Conservative mode for the day (captured by the check-in) |
| Supplements and stimulants | Listed in [TBMED Table 4-2][CDC-MED] | Covered by the medicine question |
| Sickle-cell trait | Exertional collapse with sickle-cell trait (ECAST) is a distinct collapse type ("Conscious, can talk", early in training) [TBMED Table 5-3]; also a rhabdomyolysis factor [TBMED Table 4-5] | OH awareness only |

Conservative mode effects [ENG]:
1. ECTemp "stop and cool" threshold drops from 38.4 to 38.0 degC.
2. Check-ins are prompted every 30 min when the environmental level is at least "caution".
3. A buddy is mandatory.
4. The environment engine applies the next-stricter work/rest tier. Interface owned by the environment spec.

Data protection: store flags as booleans with consent, never as diagnoses. Make flags visible only to the worker and OH,
and show supervisors only the resulting actions [ENG].

## 8. Fluid intake caps, hyponatremia prevention and electrolytes

| Item | Value | Source |
|---|---|---|
| Hourly cap | "CAUTION: Hourly fluid intake should not exceed 1 1/2 qt" = 1.4195 L/h | [TBMED Tables 3-2, 3-3] [VP]; same in [NIOSH16] (table adapted from DOD: "Fluid intake should not exceed 1.5 qt-h-1") |
| Daily cap | "CAUTION: Daily fluid intake should not exceed 12 qt" = 11.356 L/day. "Circumstances requiring more than 12 quarts per day are possible but rare" | [TBMED Table 3-6 note] |
| Rationale | "The stomach empties less than 1 1/2 quarts per hour; thus, drinking more than this may result in bloating and increases hyponatremia risk." For a 176-lb person, a body-water gain of 2 qt (+2.5% body weight) lowers sodium below 135 mmol/L, and 3 qt below 130 | [TBMED] |
| Typical intake | "Workers in heat <2 hours and involved in moderate work activities should drink 1 cup (8 oz.) of water every 15-20 minutes" = 0.237 L per cup, 0.71-0.95 L/h. "During prolonged sweating lasting several hours, they should drink sports drinks containing balanced electrolytes." Water should be below 15 degC (59 degF) | [NIOSH16 Executive Summary] |
| Military tables | 0.5-1.5 qt/h by heat category and work rate, +/- 0.25 qt/h for individual variation and for sun or shade | [TBMED Tables 3-2, 3-3] |
| Abu Dhabi guidance (ADPHC, June 2026) | "Drink at least one litre of water before starting work", "at least two litres every two to three hours", carry a 2-L container; increase salt intake in summer. Zill interprets the salt advice as dietary salt, never tablets [TBMED][NIOSH16] | Gulf News report [VS, ADPHC26] |
| Sharjah code | 4-6 L/day normally; "2 (two) litres every 2-3 hours may be required" in extreme heat; avoid caffeinated drinks | [SPSA24] |
| Field observation | Miners averaged 0.8 L/h (range 0.3-1.5) under WBGT above 28 degC | [BB03] |
| Rehydrating an alert heat casualty | "Thirsty and alert patients can be given oral fluids (initially 1 quart per 30 minutes)" | [TBMED 5-1b] (first-aider use only; not with suspected EAH) |

Electrolytes [VP, TBMED 3-7 unless noted]:
- Sweat sodium is 0.75-1.50 g per quart. Typical daily losses are 3-10 g sodium and 0.5-2.0 g potassium. Reference
  intakes are 3.6-5.0 g/day sodium and 2.5-3.2 g/day potassium.
- "Salting food to taste" covers extra needs. "Salt tablets are not recommended as their misuse has resulted in
  gastrointestinal discomfort and incapacitating nausea." NIOSH says salt tablets "can irritate the stomach and should not
  be used" and that drinks with "approximately 20 mEq/L sodium" (about 460 mg/L) replenish sodium [NIOSH16].
- Sports drink per quart: sodium 0.3-0.7 g, potassium 0.08-0.20 g, carbohydrate 50-100 g. Per litre that is Na
  0.32-0.74 g (13.8-32.2 mmol/L), K 0.085-0.21 g (2.2-5.4 mmol/L), and 5.3-10.6% carbohydrate (computed).
- "Most cases of hyponatremia ... are due to overhydration/water intoxication". In high-risk situations, substitute
  "2 quarts of water each day with 2 quarts of an electrolyte-rich beverage". High-risk situations: early heat season
  before acclimatization, restricted food, multi-day red or black heat categories, and "command emphasis on drinking".
- Hyponatremia prevention in Zill [ENG within the caps]:
  - The default drink reminder is 250 mL every 20 min (0.75 L/h) while working in heat.
  - Suggest an electrolyte drink after about 2 h of continuous sweating, or at meals.
  - Never prompt drinking when the rolling 60-min logged intake exceeds 1.42 L. Show "Slow down - too much water can be
    dangerous. Eat salty food or use an electrolyte drink."
  - Over 11.36 L/day: warn and notify the supervisor (T1).
  - Over the cap with headache, vomiting, swelling or confusion: start the hyponatremia path (Section 5.2).
  - Suppress reminders during declared fasting hours.

## 9. References (all accessed 2026-11-09)

- [B13] Buller MJ, Tharion WJ, Cheuvront SN, et al. Estimation of human core temperature from sequential heart rate observations. Physiol Meas 2013;34(7):781-798. doi:10.1088/0967-3334/34/7/781. PMID 23780514. https://pubmed.ncbi.nlm.nih.gov/23780514/
- [USARIEM-JS] USARIEM, Core Body Temperature Estimation From Heart Rate (page last modified 11/5/2026) and estimateTcore.js / core_temp_try_out.js. https://usariem.health.mil/index.cfm/research/products/cbt_algorithm ; https://usariem.health.mil/assets/js/estimateTcore.js
- [P165] US 10,702,165 B2. https://patents.google.com/patent/US10702165B2/en
- [P839] US 12,426,839 B2. https://patents.google.com/patent/US12426839B2/en
- [P579] US 11,564,579 B2. https://patents.google.com/patent/US11564579B2/en
- [B15] Buller MJ, Tharion WJ, Duhamel CM, Yokota M. Ergonomics 2015;58(11):1830-1841. doi:10.1080/00140139.2015.1036792. PMID 25967760.
- [L18] Looney DP, Buller MJ, Gribok AV, et al. Estimating resting core temperature using heart rate. J Meas Phys Behav 2018;1(2):79-86. doi:10.1123/jmpb.2017-0003 (abstract via Crossref).
- [L21] Looney DP, et al. MSSE 2021;53(8S):363. doi:10.1249/01.mss.0000763472.48142.3b (title only; content not retrieved).
- [H19] Hunt AP, Buller MJ, Maley MJ, Costello JT, Stewart IB. Mil Med Res 2019;6:20. doi:10.1186/s40779-019-0208-7. PMID 31196190.
- [B20] Buller MJ, Davey T, Fallowfield JL, et al. Physiol Meas 2020;41(6):065011. PMID 32408286.
- [B22] Buller M, Fellin R, Bursey M, et al. Br J Sports Med 2022;56(8):446-451. PMID 35022161.
- [dK22] de Korte JQ, Veenstra BJ, van Rijswick M, et al. Front Sports Act Living 2022;4:882254. PMID 35813051. https://www.frontiersin.org/articles/10.3389/fspor.2022.882254/full
- [E22] Egbert J, Krenz J, Sampson PD, et al. Arch Environ Occup Health 2022;77(10):809-818. PMID 35114899; PMC9346099.
- [B23] Buller MJ, Atkinson E, Driver K, et al. Physiol Meas 2023;44(10). doi:10.1088/1361-6579/acf991. PMID 37703905.
- [F24] Falcone T, Del Ferraro S, Molinaro V, Zollo L, Lenzuni P. Front Public Health 2024;12:1219595. PMID 38528868. https://pmc.ncbi.nlm.nih.gov/articles/PMC10961439/
- [P24] Peggen MAG, Bongers CCWG, de Korte JQ, et al. J Therm Biol 2024;125:103982. PMID 39383600.
- [B25] Buller MJ, Atkinson EY, Akana ME, et al. Physiol Meas 2025;46(11). doi:10.1088/1361-6579/ae05ae. PMID 40930133.
- [Z25] Zhao Y, Bergmann JHM. Physiol Meas 2025;46(10). PMID 41038236.
- [A26] Atkinson E, Charkoudian N, Driver K, et al. Med Sci Sports Exerc 2026;58(8):1797-1804. PMID 41917769.
- [Lg26] Lignier MJ, Tourula E, Raef JM, et al. Environ Res Commun 2026;8(6):065044. doi:10.1088/2515-7620/ae7bc5. https://pmc.ncbi.nlm.nih.gov/articles/PMC13280436/
- [W18] Welles AP, Xu X, Santee WR, et al. Comput Biol Med 2018;99:1-6. PMID 29803944.
- [M98] Moran DS, Shitzer A, Pandolf KB. A physiological strain index to evaluate heat stress. Am J Physiol 1998;275(1):R129-R134. PMID 9688970.
- [M98b] Moran DS, Montain SJ, Pandolf KB. Am J Physiol 1998;275(3):R854-R860. PMID 9728084.
- [M99] Moran DS, Shapiro Y, Laor A, Izraeli S, Pandolf KB. Am J Physiol 1999;276(6):R1798-R1804. PMID 10362762.
- [M02] Moran DS, Kenney WL, Pierzga JM, Pandolf KB. Am J Physiol Regul Integr Comp Physiol 2002;282(4):R1063-R1069. PMID 11893610.
- [NIOSH16] NIOSH. Criteria for a Recommended Standard: Occupational Exposure to Heat and Hot Environments. Jacklitsch B, Williams WJ, Musolin K, Coca A, Kim J-H, Turner N. DHHS (NIOSH) Publication No. 2016-106. https://www.cdc.gov/niosh/docs/2016-106/pdfs/2016-106.pdf
- [NIOSH-ILL] CDC/NIOSH. Heat-related illnesses (last reviewed 3 Mar 2026). https://www.cdc.gov/niosh/heat-stress/about/illnesses.html
- [OSHA-FA] OSHA. Heat - Heat-related illnesses and first aid. https://www.osha.gov/heat-exposure/illness-first-aid
- [OSHA-NW] OSHA. Heat - Protecting new workers. https://www.osha.gov/heat-exposure/protecting-new-workers
- [TBMED] Headquarters, Department of the Army. TB MED 507, Heat Stress Control and Heat Casualty Management, 12 April 2022. https://www.govinfo.gov/content/pkg/GOVPUB-D101-PURL-gpo216616/pdf/GOVPUB-D101-PURL-gpo216616.pdf
- [ACSM23] Roberts WO, Armstrong LE, Sawka MN, Yeargin SW, Heled Y, O'Connor FG. ACSM Expert Consensus Statement on Exertional Heat Illness: Recognition, Management, and Return to Activity. Curr Sports Med Rep 2023;22(4):134-149. PMID 37036463 (abstract only; paywalled).
- [Casa23] Casa DJ, Szymanski MR, Jardine JF, et al. Letter on the 2023 ACSM Expert Consensus Statement on Exertional Heat Illness. Curr Sports Med Rep 2023;22(9):336-337. doi:10.1249/JSR.0000000000001100.
- [NATA15] Casa DJ, DeMartini JK, Bergeron MF, et al. NATA Position Statement: Exertional Heat Illnesses. J Athl Train 2015;50(9):986-1000. PMID 26381473.
- [NATA15-ES] NATA. "NATA Reissues Executive Summary of New Exertional Heat Illnesses Position Statement". https://www.nata.org/press-release/nata-reissues-executive-summary-new-exertional-heat-illnesses-position-statement
- [ILCOR19] ILCOR First Aid Task Force. CoSTR: First aid cooling techniques for heat stroke and exertional hyperthermia (2 Nov 2019). https://costr.ilcor.org/document/first-aid-cooling-techniques-for-heat-stroke-and-exertional-hyperthermia
- [D20] Douma MJ, Aves T, Allan KS, et al. Resuscitation 2020;148:173-190. PMID 31981710.
- [IOC21] Hosokawa Y, Racinais S, Akama T, et al. Br J Sports Med 2021;55(24):1405-1410. PMID 33888465; PMC8639927.
- [Bv18] Belval LN, Casa DJ, Adams WM, et al. Consensus Statement - Prehospital Care of Exertional Heat Stroke. Prehosp Emerg Care 2018;22(3):392-397. PMID 29336710 (abstract).
- [McD09] McDermott BP, Casa DJ, Ganio MS, et al. J Athl Train 2009;44(1):84-93. PMID 19180223 (thresholds via later citing papers [VS]).
- [Lu16] Luhring KE, Butts CL, Smith CR, et al. J Athl Train 2016;51(11):946-951. PMID 27874299.
- [Ho17] Hosokawa Y, Adams WM, Belval LN, Vandermark LW, Casa DJ. Ann Emerg Med 2017;69(3):347-352. PMID 27865532.
- [WMS19] Bennett BL, Hew-Butler T, Rosner MH, Myers T, Lipman GS. Wilderness Environ Med 2020;31(1):50-62. PMID 32044213.
- [UAE] UAE Government portal, Handling emergencies (last updated 01 Oct 2026). https://u.ae/en/information-and-services/justice-safety-and-the-law/safety/handling-emergencies
- [ADPHC26] Gulf News, "Abu Dhabi identifies five signs of heat stress and four key preventive measures as midday work ban takes effect" (updated 14 Jun 2026) [secondary report of ADPHC guidance].
- [SPSA24] Sharjah Prevention and Safety Authority. Code of Practice, Safety in Heat, OSHJ-CoP-33, Version 2 Rev 0, 3 Jul 2024. https://mc.spsa.shj.ae/Media/documents/j3comnEiUeCQ3emVuS2OQ_Safety%20in%20Heat%20OSHJ-COP-33.pdf
- [J11] Joubert D, Thomsen J, Harrison O. Safety in the Heat (Abu Dhabi). Am J Public Health 2011;101(3):395-398. PMID 21307373.
- [Ba10] Bates GP, Miller VS, Joubert DM. Ann Occup Hyg 2010;54(2):137-143. PMID 19959561.
- [BB03] Brake DJ, Bates GP. Occup Environ Med 2003;60(2):90-96. PMID 12554834.
- [Ar94] Armstrong LE, Maresh CM, Castellani JW, et al. Int J Sport Nutr 1994;4(3):265-279. PMID 7987361.
- [Ar98] Armstrong LE, et al. Int J Sport Nutr 1998;8(4):345-355. PMID 9841955.
- [Ar10] Armstrong LE, Pumerantz AC, Fiala KA, et al. Int J Sport Nutr Exerc Metab 2010;20(2):145-153. PMID 20479488.
- [McK15] McKenzie AL, Munoz CX, Armstrong LE. J Athl Train 2015;50(12):1306-1309. PMID 26642041.
- [Kv16] Kavouras SA, et al. Eur J Nutr 2016;55(3):907-915. PMID 25905541.
- [Pe16] Perrier ET, et al. Eur J Nutr 2016;55(5):1943-1949. PMID 26286348.
- [Po01] Popowski LA, et al. Med Sci Sports Exerc 2001;33(5):747-753. PMID 11323543.
- [CDC-MED] CDC. Heat and Medications - Guidance for Clinicians (page dated 18 Sep 2025). https://www.cdc.gov/heat-health/hcp/clinical-guidance/heat-and-medications-guidance-for-clinicians.html
- [W07] Wallace RF, Kriebel D, Punnett L, Wegman DH, Amoroso PJ. Environ Res 2007;104(2):290-295. PMID 17306249.
- [Mo13] Moore JP, Harper Smith AD, Di Felice U, Walsh NP. Eur J Appl Physiol 2013;113(9):2353-2360. PMID 23760736.
- [Re18] Relf R, et al. J Sports Sci 2018;36(3):348-355. PMID 28337936.
- [Mj19] Manjunath G, Aravindhakshan R, Varghese S. East Mediterr Health J 2019;25(1):34-39. PMID 30919923.
- [Le03] Leiper JB, Molla AM. Eur J Clin Nutr 2003;57 Suppl 2:S30-38. PMID 14681711.
- [MOHRE26] MOHRE news, 12 Feb 2026: reduction of private-sector working hours by two hours daily during Ramadan. https://mohre.gov.ae/en/media-center/news/12/2/2026/reduction-of-working-hours-for-private-sector-employees-by-two-hours-daily-during-the-holy-month-of
- [Wo03] Wonisch M, Hofmann P, Fruhwald FM, et al. Eur J Cardiovasc Prev Rehabil 2003;10(4):296-301. PMID 14555886.
- [Pc90] Pescatello LS, Mack GW, Leach CN Jr, Nadel ER. Med Sci Sports Exerc 1990;22(2):222-228. PMID 2355819.
- [Be20] Bent B, Goldstein BA, Kibbe WA, Dunn JP. NPJ Digit Med 2020;3:18. PMID 32047863.
- [Gi17] Gillinov S, Etiwy M, Wang R, et al. Med Sci Sports Exerc 2017;49(8):1697-1703. PMID 28709155.
- [Sh17] Shcherbina A, Mattsson CM, Waggott D, et al. J Pers Med 2017;7(2):3. PMID 28538708.
- [Ge26] Gielen J, Van Oost CN, Debard G, et al. JMIR Form Res 2026;10:e85186. PMID 41701929.
- [Mu21] Muhlen JM, Stang J, Lykke Skovgaard E, et al. Br J Sports Med 2021;55(14):767-779. PMID 33397674.
- [CTA] ANSI/CTA-2065 (paywalled); MAPE < 10% as reported in https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9871762/ [VS].
- [Or15] Orphanidou C, Bonnici T, Charlton P, et al. IEEE J Biomed Health Inform 2015;19(3):832-838. PMID 25069129; rule values via https://eprints.whiterose.ac.uk/id/eprint/222014/1/CinC2024-270.pdf [VS].
- [Li09] Li Q, Mark RG, Clifford GD. BioMed Eng Online 2009;8:13 (eq. 13). PMID 19586547; PMC2728101.
- [El16] Elgendi M. Bioengineering (Basel) 2016;3(4):21. PMID 28952584.
- [Pt12] Peltola MA. Front Physiol 2012;3:148. PMID 22654764.
- [Ho06] Houts PS, Doak CC, Doak LG, Loscalzo MJ. Patient Educ Couns 2006;61(2):173-190. PMID 16122896.
- [DE01] Dowse R, Ehlers MS. Patient Educ Couns 2001;45(2):87-99. PMID 11687321.
- [CPSC] US CPSC contractor report citing ANSI Z535.3 criteria (>= 85% correct, < 5% critical confusions) [VS].

## 10. Port-ready parameters and rules

All values are normative for engine v1 unless tagged [ENG]; [ENG] values are tunable defaults that need clinical
sign-off. Units: degC, beats/min (bpm), litres, minutes.

### 10.1 ECTemp constants

```ts
// Buller 2013 / USARIEM estimateTcore.js (verbatim values)
export const ECTEMP = {
  A: 1.0,                    // state transition
  GAMMA_SD: 0.022,           // degC per 1-min step
  GAMMA2: 0.022 ** 2,        // 0.000484 (JS variable named "gamma"); compute it, see note below
  B0: -7887.1, B1: 384.4286, B2: -4.5714,   // HR = B2*CT^2 + B1*CT + B0
  SIGMA_SD: 18.88,           // bpm
  SIGMA2: 18.88 ** 2,        // 356.4544 (JS variable named "sigma"); compute it, see note below
  CT0_DEFAULT: 37.1,         // degC (official app default)
  V0_DEFAULT: 0.0,           // degC^2
  STEP_MIN: 1,               // minutes; filter MUST run on 1-min means
  VERTEX_CT: 42.0471,        // -B1/(2*B2); slope c <= 0 beyond -> skip update
  VERTEX_HR: 194.962,
} as const;
// Optional sigmoid observation model (US12426839B2 eq.10; Looney 2018) - same GAMMA2/SIGMA2
export const ECTEMP_SIGMOID = { A: 41, K: 193, Q: 0.06, B: 0.89, M: 37.84, NU: 0.07 } as const;
```
Floating-point note (checked in Node 24): `0.022 ** 2` evaluates to 0.00048399999999999995, not the literal 0.000484.
`18.88 ** 2` evaluates to 356.45439999999996, not 356.4544. The official JS computes `Math.pow(0.022,2)` and
`Math.pow(18.88,2)`. Compute the squares, do not type the literals, so the port stays bit-identical to the official
code and the fixtures. Literals would differ by about 1e-17 relative, which is still inside the 1e-9 test tolerance.

### 10.2 ECTemp step (pseudo-TS; identical arithmetic order to the official JS)

```ts
function ectempStep(ctPrev: number, vPrev: number, hr: number | null, rScale = 1): {ct: number; v: number} {
  const ctPred = ECTEMP.A * ctPrev;
  const vPred = ECTEMP.A ** 2 * vPrev + ECTEMP.GAMMA2;
  if (hr === null || !Number.isFinite(rScale)) return { ct: ctPred, v: vPred };      // missing / invalid minute
  const c = 2 * ECTEMP.B2 * ctPred + ECTEMP.B1;                                       // dHR/dCT at ctPred
  if (c <= 0) return { ct: ctPred, v: vPred };                                        // [ENG] beyond vertex guard
  const k = (vPred * c) / (c ** 2 * vPred + ECTEMP.SIGMA2 * rScale);
  const ct = ctPred + k * (hr - (ECTEMP.B2 * ctPred ** 2 + ECTEMP.B1 * ctPred + ECTEMP.B0));
  const v = (1 - k * c) * vPred;
  return { ct, v };
}
// Sigmoid variant: replace h(ct) and c with
//   e = exp(-B*(ct-M)); h = A + (K-A)/(1+Q*e)**(1/NU); c = (K-A)*Q*B/NU * e * (1+Q*e)**(-(1/NU)-1)
```

Rules:
1. Aggregate to 1-min means (Section 10.4), then call `ectempStep` once per minute in order. If a minute is missing,
   pass `hr = null`.
2. Interpolate gaps of 5 min or less linearly [ENG][P165]. Longer gaps are null minutes.
3. Gaps longer than 30 min, device swaps or a new shift: re-init (CT0_DEFAULT, V0_DEFAULT) and restart the 30-min
   warm-up [ENG][E22].
4. Display: show ECTemp as a band, for example "about 38.2 (+/-0.6)". The +/-0.6 approximates the Buller 2013 LoA
   (+/-0.63). Clamp the display to [35.5, 42.0]. Never display during warm-up, while the channel is invalid, or when
   the worker has the HR-suppressing-medication flag.

### 10.3 PSI and aPSI

```ts
psi = 5*(ct - ct0)/(39.5 - ct0) + 5*(hr - hr0)/(180 - hr0);     // invalid if ct0 >= 39.5 or hr0 >= 180
// band (ceil mapping, [ENG]): psi<=2 none_little | <=4 low | <=6 moderate | <=8 high | >8 very_high
apsi = 5*(ct - ctRest)/(ctCrit - ctRest) + 5*(hr - hrRest)/(hrCrit - hrRest);
hrCrit = 0.90*(220 - age);  ctCrit = tskChest == null ? 39.5 : 39.5 + ((ct - tskChest) - 4)/4;
```
- ct0 is the ECTemp value at shift start. hr0 is the lowest 5-min mean HR seated before work, or the first 5 min if
  that is unavailable [ENG][E22].
- Compute PSI only while the physio channel is valid. Log the raw value and clamp the display to 0-10.
- Use aPSI only with a validated chest skin-temperature sensor. Otherwise use PSI.

### 10.4 Minute SQI

```ts
const SQI = { HR_MIN: 40, HR_MAX: 200, SEG_S: 10, RATIO_MAX: 2.2, FLAT_MIN_SAMPLES: 10, PSI_MIN: 0.80 } as const;
// per minute: samples[] = {tSec in [0,60), bpm, contactOk}
// valid_i = contactOk && HR_MIN <= bpm <= HR_MAX
// for each segment [0,10),[10,20)...: if (count>=2 && max/min >= 2.2) mark all samples in segment invalid
// if (n >= 10 && all bpm identical) mark all invalid            (flatline)
// psi = min(1, nValid / round(60/expectedIntervalS)); minuteValid = psi >= 0.80
// hrMinute = mean(valid bpm); rScale = minuteValid ? Math.exp(psi**-2 - 1) : Infinity
// channelValid = (>= 10 of last 15 minutes valid) && warmupDone(30 min) && !hrSuppressingMedFlag
```

### 10.5 Physio escalation floors (only when `channelValid`) [ENG thresholds anchored on cited data]

| Condition (sustained 5 consecutive valid minutes [ENG]) | Floor | Anchor |
|---|---|---|
| ECTemp >= 38.0 | Advisory: prompt a check-in (no level change) | WHO/NIOSH 38 degC limit [NIOSH16] |
| ECTemp >= 38.4 (>= 38.0 in conservative mode) | T1 | Hunt 2019 limit of 38.4 [H19] |
| ECTemp >= 39.0 | T2 | Underestimation at high CT [H19][dK22]; NIOSH hyperthermia classes (38.5-39.5 moderate/heat exhaustion) [NIOSH16] |
| PSI > 4 (moderate) | Advisory | [M98] |
| PSI > 6 (high) | T1 | [M98] |
| PSI > 8 (very high) | T2 | [M98] |
| HR > 180 - age | T1 | NIOSH "sustained HR > 180 bpm minus the worker's age" [NIOSH16] |
| Optional recovery test at a seated break: P1 (30-60 s) > 110 bpm or P1 - P3 (150-180 s) < 10 bpm | T1 (extend the rest) | Brouha [NIOSH16] |

Physio floors never trigger an automatic 998 call. A T2 floor prompts an immediate symptom check-in and buddy check, and
alerts the first aider.

### 10.6 Fusion

```ts
finalLevel = Math.max(envLevel, physioFloor ?? envLevel, symptomLevel ?? envLevel);   // T0=0 ... T3=3
```
- An invalid or missing channel is null, so it cannot lower anything.
- Levels decay only by explicit human action: a supervisor or first aider marks "resolved", plus a repeat check-in with
  no symptoms [ENG].
- After T2 or T3: no return to hot work that day. After EHS: medical clearance [TBMED 5-5][NIOSH-ILL].

### 10.7 Symptom triage table (YES gives the level; final = max)

| Item | Level | Extra action |
|---|---|---|
| B_CONFUSED, B_SPEECH_GAIT, B_UNRESPONSIVE, S_CHEST, S_VOMIT_REPEAT | T3 | Call 998, cool now, stay with the worker |
| S_FAINTED, S_DIZZY, S_HEADACHE, S_NAUSEA, S_WEAK | T2 | First aider now, medical evaluation the same day |
| S_URINE_BROWN | T2 | Medical facility in the same shift (creatine kinase test) |
| S_OVERDRINK_SX | T2 | STOP plain water (suspected hyponatremia) |
| S_CRAMPS | T1, or T2 if heart disease, low-sodium diet, or cramps >= 60 min | Water plus snack or electrolyte every 15-20 min; no salt tablets; no strenuous work for several hours |
| S_RASH | T1 | Cool, dry area |
| S_URINE_DARK (7-8) | T1 | Section 10.8 |
| S_THIRST | T0 | Drink advice |

Time rules:
- Re-check at +15 and +30 min.
- Any worsening or a new T3 item gives T3.
- T2 not clearly improving at 30 min gives T3. 30 min is [ENG]; the cited outer limit is 60 min [TBMED].
- An unanswered prompt after 5 min notifies the buddy, then the supervisor [ENG].

### 10.8 Urine colour and fluids

```ts
urine(shade 1..8, brownRedCola): brownRedCola -> T2 | 1-3 OK | 4 DRINK_MORE | 5-6 DEHYDRATED (T1 if persists) | 7-8 T1
const FLUID = {
  HOURLY_CAP_L: 1.4195294,  // 1.5 US qt [TBMED][NIOSH16]
  DAILY_CAP_L: 11.356235,   // 12 US qt [TBMED][NIOSH16]
  CUP_L: 0.2365882,         // 8 US fl oz; "1 cup every 15-20 min" = 0.71-0.95 L/h [NIOSH16]
  REMINDER_L: 0.25, REMINDER_EVERY_MIN: 20,   // [ENG] 0.75 L/h
  ELECTROLYTE_AFTER_MIN: 120,                 // "prolonged sweating lasting several hours" [NIOSH16]; [ENG] value
} as const;
// rolling60 > HOURLY_CAP_L -> stop reminders + "slow down" message; today > DAILY_CAP_L -> warn + T1 notify
// over cap AND (headache|vomiting|swelling|confusion) -> hyponatremia path (T2; confusion/seizure -> T3)
// fastingNow -> no drink reminders
```

### 10.9 Risk flags (booleans only, never summed)

- `priorHeatIllness`, `heatMedication`, `hrSuppressingMedication`, `recentFebrileOrGI_3d`, `newOrReturningWorker_14d`,
  `alcohol_24h`, `poorSleep`, `fastingToday`, `heatRashOrSunburnToday`, `ohReviewRequired` (age >= 50, obesity,
  prior EHS, cardiac disease, sickle-cell trait; set by occupational health).
- Any flag except `ohReviewRequired` sets `conservativeMode = true`.
- `hrSuppressingMedication` sets `physioDisabled = true`.
- Conservative-mode effects: ECTemp T1 threshold 38.0; check-ins every 30 min from env level "caution"; buddy
  mandatory; next-stricter environment tier.

### 10.10 Emergency constants (UAE)

```ts
export const UAE_EMERGENCY = { AMBULANCE: "998", POLICE: "999", CIVIL_DEFENCE: "997", COASTGUARD: "996",
  SEARCH_RESCUE: "995", ELECTRICITY: "991", AD_SMS_PEOPLE_OF_DETERMINATION: "5999", AD_APP: "AD999" } as const;
// verified at u.ae "Last updated 01 Oct 2026"; re-verify each release
```

Cooling instructions for the T3 screen, in order:
1. Call 998.
2. Shade and remove clothing.
3. Ice-water immersion or tarp (neck-down; water 1-26 degC; stir).
4. Otherwise continuous cold-water dousing plus fan, or rotating ice-water towels every 1-2 min plus ice packs.
5. Keep cooling until EMS arrives. Without a thermometer, stop ice-water immersion after about 15 min or when
   symptoms resolve [ILCOR19: "for a reasonable amount of time, such as 15 minutes"].
6. Fluids only if fully alert. Never leave the worker alone.

Sources: [ILCOR19][TBMED][IOC21][OSHA-FA][NATA15-ES].

### 10.11 Test vectors (inline excerpt; full set in the fixtures listed in Section 10.12)

ECTemp, quadratic, CT0 = 37.1, v0 = 0, constant HR = 150 bpm:

| Minute | CT | v | CT (sigmoid) | v (sigmoid) |
|---|---|---|---|---|
| 1 | 37.1040984872 | 0.0004826592 | 37.1043857913 | 0.0004828492 |
| 2 | 37.1122322845 | 0.0009613346 | 37.1131251556 | 0.0009622468 |
| 10 | 37.2974244028 | 0.0043970644 | 37.3260852271 | 0.0043961658 |
| 30 | 37.9952213426 | 0.0091149215 | 38.1469575591 | 0.0080608259 |
| 60 | 38.5680548322 | 0.0119378445 | 38.6546743355 | 0.0104271586 |
| 120 | 38.8637955223 | 0.0138412717 | 38.8648770183 | 0.0124243818 |

Mixed shift profile. Per-minute HR = [75] x 10, then 135 + 10 sin(i/7) for i = 0..44, then [95] x 15, then [160] x 30,
then 100 - 0.5 i for i = 0..19. Each value is rounded to 3 decimals. Quadratic results (sigmoid in brackets):
- min 1: 37.0995051173 (37.1001293559)
- min 11: 37.1077237858 (37.1415611798)
- min 30: 37.8006011281 (37.9619341442)
- min 60: 37.9398546515 (38.0714538989)
- min 100: 38.6971497670 (38.7692293422)
- min 120: 37.8853754175 (37.9563707404)

The same profile with minutes 21-35 missing (null): CT holds at 37.4551614866 while v grows from 0.0071636465 by
0.000484 per minute, reaching 0.0144236465 at minute 35. At minute 36 (HR 130.833) CT = 37.5079241755 and
v = 0.0138841581. Minute 120 CT = 37.8763480900.

With psi = 0.85 every minute (rScale = 1.4682673689): minute 100 CT = 38.5912184742; minute 120 CT = 37.9389992082.

Edge cases:
- 30 min at 200 bpm gives CT = 38.6318095827 (quadratic).
- 30 min at 45 bpm gives CT = 36.5809911061 (quadratic).

PSI:
- (CT 38.4, HR 150, CT0 37.1, HR0 70) gives 6.344697, "high".
- (39.0, 165, 37.0, 70) gives 8.318182, "very high".
- (38.0, 140, 36.9, 80) gives 5.115385, "moderate".
- (37.8, 120, 37.1, 75) gives 3.601190, "low".

aPSI:
- (CT 38.4, HR 150, CTrest 37.1, HRrest 70, age 30): no Tsk gives 6.668729. Tsk 37.4 gives CTcrit 38.75 and 7.899790.
- (39.0, 160, 37.0, 70, age 45, Tsk 36.0) gives CTcrit 39.25 and 9.587302.

SQI (1 Hz, age 40):
- Clean minute: psi 1.0, valid, rScale 1.0.
- 25% missing: psi 0.75, invalid.
- 6-s double-rate lock: psi 0.8333, valid, rScale 1.552707 (segment dropped).
- 5-s half-rate lock: psi 0.8333, valid.
- 60-s flatline: psi 0, invalid.
- 20 s of lost contact: psi 0.6667, invalid.
- 215 bpm at 5-s interval: psi 0, invalid.

Triage:
- No symptoms gives T0. Thirst only gives T0.
- Rash gives T1. Cramps give T1; cramps for 60 min, or with heart disease, give T2.
- Headache plus dizzy gives T2. Fainted but alert gives T2. Fainted plus confused gives T3.
- Buddy reports slurred speech: T3. Repeated vomiting: T3.
- Brown urine: T2. Over-drinking with symptoms: T2 (plus confusion: T3).
- Chest pain: T3.
- Heat-exhaustion symptoms not improving at 30 min: T3; improving: stays T2.
- Cramps worsening: T3.

Physio:
- ECTemp 38.45 / PSI 6.4 / HR 150 at age 35 gives floor T1.
- ECTemp 39.05 / PSI 8.6 gives T2.
- Invalid channel gives no floor.
- ECTemp 38.1 in conservative mode gives T1.

Fusion:
- env 2, physio null, symptom null gives 2.
- env 0, physio 1 gives 1.
- env 1, symptom 3 gives 3.

### 10.12 Reference code and fixtures (reproducible, standard library only)

- `scripts/research/physio_clinical/ectemp_reference.py`
  is the ECTemp (quadratic and sigmoid), PSI/aPSI, SQI and steady-state oracle. It writes `out/physio_fixtures.json`
  and `out/js_crosscheck_input.json`.
- `scripts/research/physio_clinical/crosscheck_js.mjs` runs the official USARIEM `estimateTcore.js` (not bundled) in Node on the same HR series.
  `scripts/research/physio_clinical/compare_js.py` compares the two: 581 minutes, worst |dCT| = 0.0 and worst |dV| = 0.0, PASS.
- `scripts/research/physio_clinical/clinical_rules.py` is the triage, urine, fluid-cap, physio-floor and fusion oracle. It writes
  `out/clinical_rules_fixtures.json`.
- `scripts/research/physio_clinical/spec_pseudocode_check.mjs` is a plain-JS transcription of the Section 10 pseudo-code. Run
  against the fixtures, it gives: ECTemp 1,642 minute-steps (quadratic and sigmoid) with worst |dCT| = 0; PSI, aPSI,
  SQI and fusion PASS.
- The committed outputs are in `fixtures/physio/` (copy `out/*.json` there after a re-run).
- Re-run sequence, from `scripts/research/physio_clinical/` (venv Python, Node 24):
  1. `python -I ectemp_reference.py`
  2. `node crosscheck_js.mjs <estimateTcore.js> out/js_crosscheck_input.json out/js_crosscheck_output.json`
  3. `python -I compare_js.py`
  4. `python -I clinical_rules.py`
  5. `node spec_pseudocode_check.mjs out/physio_fixtures.json out/clinical_rules_fixtures.json`
- Suggested TS test tolerances: CT 1e-9 degC, v 1e-12, PSI 1e-6.

### 10.13 Open items and UNVERIFIED list

1. "Looney et al. adaptive initial core temperature": not found (Section 2.6). The MSSE 2021 abstract content was not
   retrieved.
2. The full text of ACSM 2023 is paywalled. Its numeric cooling targets were not transcribed, and one co-author
   dissented.
3. The Moran 1998 PSI band table was verified only through its reproduction in US11564579B2.
4. The McDermott 2009 cooling-rate classes (0.155 and 0.078 degC/min) and the Orphanidou rule values (40-180 bpm, 3-s
   gap, ratio 2.2) were verified only through secondary sources.
5. The ISO 9186-1 pass threshold was not verified.
6. The heat section of the AHA/Red Cross 2024 First Aid Guidelines was not retrieved (HTTP 403).
7. The ADPHC 2026 hydration advice comes from a press report. Obtain the ADPHC "Safety in the Heat" document and Abu
   Dhabi EHS RI-CoP 11.0 text.
8. The biphasic Kalman filter coefficients look inconsistent (Section 2.6 item 3).
9. Whether UAE or GCC equivalents of the US ECTemp and aPSI patents exist was not checked.
10. Every [ENG] threshold needs prospective validation in Gulf outdoor workers: ECTemp floors 38.0/38.4/39.0, psi_t
    0.80, warm-up 30 min, the 30-min re-check, and the 250 mL / 20 min reminder. The about-15-min immersion without a
    thermometer is ILCOR's example ("such as 15 minutes").
