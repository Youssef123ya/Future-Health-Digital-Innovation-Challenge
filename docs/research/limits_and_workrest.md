# Occupational heat limits, metabolic classes, clothing, acclimatisation, work/rest and hydration

**Scope.** These are the exposure-limit rules that `src/engine/limits.ts` and parts of `clinical.ts` and `planner.ts` must
implement. The sources are NIOSH 2016, the ACGIH TLV, ISO 7243:2017, ISO 8996, TB MED 507 (2022), OSHA (heat-index risk
levels and the 2024 proposed rule) and the NWS heat index.

**Status:** researched 2026-11-09.
**Oracle:** `scripts/oracles/limits_oracle.py` → `fixtures/limits.json` (184 vectors, 71 self-checks, all passing).

**How to read the evidence tags**

| Tag | Meaning |
|---|---|
| **[P]** | Verified against the primary document. |
| **[S]** | Secondary reproduction (the primary is paywalled), named. |
| **[D]** | Derived by us, with the method stated. |
| **UNVERIFIED** | Could not be confirmed. The attempts are listed in §10. |

Units follow the engine convention: `C` = °C, `W` = whole-body metabolic rate in watts (not W/m²), `F` = °F.

---

## 0. Decisions for the engine (read this first)

1. **Use the equations, not the figures or the rounded tables.** Use RAL = 59.9 − 14.1·log10 M and REL = 56.7 − 11.5·log10 M,
   with M in W, in double precision.
   - These equations are identical to the ACGIH Action Limit and TLV, and to the ISO 7243:2017 reference equations. This is
     proven: they regenerate all 24 published cells of the ACGIH screening table exactly (§3.5).
   - The NIOSH figures are drawn up to about 1.3 °C *above* the RAL equation (§1.2), and OSHA's whole-degree table is
     inconsistently rounded (§6.2). Neither should be used. [corrected by fact-check: was "about 1.6 °C". An independent
     digitisation gives at most +1.34 °C for the 60-min RAL markers and +1.05 °C for the drawn 60-min RAL curve.]
2. **Choose the limit:** REL if the worker is acclimatised. Otherwise use RAL: unacclimatised, unknown status, currently
   acclimatising, returning after an absence, or carrying a health flag (this matches the ARCHITECTURE fail-safe defaults).
3. **WBGT_eff = WBGT + CAV**, using the ACGIH clothing table (§3.4). Add +1 °C for a hood. CAVs are **not additive**.
   - For completely encapsulating (Level A) or other unlisted vapour-barrier ensembles, the WBGT method does not apply. Fall
     back to PHS and physiological monitoring.
4. **Time base is one hour.** Use the time-weighted average (TWA) of WBGT_eff and of M over 60 min, with rest at **115 W**
   (the ACGIH basis).
   - Allowed work fraction *f* = the largest *f* ∈ [0,1] with `Limit(TWA_M(f)) ≥ TWA_WBGT(f)`, found by bisection (§3.6 and
     the code in §11).
   - The ACGIH 0.5 °C screening table is for display and screening only. ACGIH says it is "not intended to prescribe work and
     recovery periods".
5. **Use the full NWS heat index algorithm** (Rothfusz + both adjustments + simple formula, §8). Do not use pythermalcomfort's
   `heat_index_rothfusz`, which has no adjustments, old category boundaries, and returns NaN below 27 °C. Use the heat index
   only for OSHA/NWS risk communication and the OSHA proposed-rule triggers, never instead of WBGT limits.
6. **Fluid guidance comes from TB MED 507 (2022) Table 3-2**, with hard caps of **1½ qt/h (1.42 L/h)** and **12 qt/day
   (11.36 L/day)**. These are identical to the NIOSH cap of "48 oz (1½ quarts) per hour". The NIOSH everyday advice is
   **1 cup (8 oz ≈ 237 mL) every 15–20 min**.
7. **Acclimatisation:**
   - New workers start at ≤20 % of the usual exposure on day 1, adding ≤20 % per day (NIOSH).
   - Experienced or returning workers follow 50 / 60 / 80 / 100 % (NIOSH).
   - Treat as unacclimatised until the schedule completes. Our recommended decay rule is in §1.6. It is an engineering
     synthesis.
8. **NIOSH has no ceiling limit any more.** NIOSH 2016 removed the ceiling limits (§1.1). Do not implement a "NIOSH ceiling".
   Upper protective actions come from PHS, the ACGIH heat-strain limits (§3.8) and symptoms.

---

## 1. NIOSH 2016 — *Criteria for a Recommended Standard: Occupational Exposure to Heat and Hot Environments* (DHHS NIOSH Pub. 2016-106)

Primary document: the CDC PDF (192 pages, Feb 2016), downloaded and searched in full. All quotes in this section are **[P]**.

### 1.1 RAL and REL equations, and the removed ceiling

> "The RALs and RELs are represented by the following equations, where M represents the metabolic rate in Watts (W):
> RAL [°C-WBGT] = 59.9 − 14.1 log10 M [W]
> REL [°C-WBGT] = 56.7 − 11.5 log10 M [W]" — §8.1, p. 93

- **RAL** applies to unacclimatised workers (Figure 8-1). **REL** applies to acclimatised workers (Figure 8-2).
- Both assume "conventional one-layer work clothing ensemble consisting of not more than long-sleeved work shirts and
  trousers" (§1.1.1).
- Both are for a "standard man" of 70 kg and 1.8 m² (figure captions).
- "The estimates of both environmental and metabolic heat are expressed as 1-hour time-weighted averages (TWAs), as described
  by the American Conference of Governmental Industrial Hygienists (ACGIH) [ACGIH 2014]." (§1)

**Ceiling.** The 2016 document **removed** the ceiling limits:

> "During the 2014 peer review of the draft criteria document, concerns were expressed about the sufficiency of the scientific
> data to support the NIOSH ceiling limits for acclimatized and unacclimatized workers. In fact, many acclimatized workers live
> and work in temperatures above the ceiling limits without adverse health effects. Further consideration of the scientific
> data led to the decision to remove the ceiling limit recommendations from the document." (Executive Summary, p. vii; see
> also §8.1)

Historical context, for reference only. The 1986 criteria (Pub. 86-113, **[P]**) defined the Ceiling Limits as follows:

> "...total heat loads where a worker could not achieve thermal balance, but might sustain up to a 1 degree Celsius (1°C)
> rise in body temperature in less than 15 minutes, the Ceiling Limits were calculated using the heat balance equation."

The 1986 document gives no closed-form ceiling equation in the text.

**Reference values** (from the oracle, `niosh_ral_rel` group):

| M (W) | 100 | 115 | 117 | 180 | 233 | 300 | 348.9 | 415 | 465 | 520 | 580 | 600 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RAL °C | 31.70 | 30.84 | 30.74 | 28.10 | 26.52 | 24.97 | 24.05 | 22.99 | 22.29 | 21.60 | 20.94 | 20.73 |
| REL °C | 33.70 | 33.00 | 32.92 | 30.76 | 29.48 | 28.21 | 27.46 | 26.59 | 26.02 | 25.47 | 24.92 | 24.75 |

**Domain.** The NIOSH figures span 100–500 kcal/h (116–580 W). The ACGIH Figure 2 spans 100–600 W.
- Recommendation **[D]**: use M_eff = max(M, 115 W). Do not clamp the high end, because the equation keeps decreasing and so
  stays conservative. Flag M > 600 W as extrapolated.
- For Very Heavy work, ACGIH says screening is "not recommended" and a detailed analysis or physiological monitoring should be
  used instead.

### 1.2 The figures disagree with the equations: use the equations

The worked example in §1.1.3 reads its values off the figures:

> "a vertical line at 300 kcal·h-1 (348.9 W) intersects the 60 min·h-1 REL curve at a WBGT of 27.8°C (82°F)…
> If the 70-kg worker was unacclimatized, Figure 8-1 indicates … above a WBGT of 25°C (77°F)."

The equations give **27.46 °C (REL)** and **24.05 °C (RAL)** at 348.9 W. We extracted the marker coordinates from the PDF's
vector artwork **[D]**, using `pymupdf get_drawings()` and the axis tick-label positions:

| 60-min/h marker | ≈116 W | ≈231 W | ≈347 W | ≈463 W | ≈579 W |
|---|---|---|---|---|---|
| Fig 8-2 (REL) drawn | 33.02 | 29.75 | 27.95 | 25.99 | 25.07 |
| REL equation | 32.96 | 29.50 | 27.47 | 26.04 | 24.93 |
| Fig 8-1 (RAL) drawn † | 31.17 | 27.73 | ≈25.7 | ≈23.2 | ≈21.4 |
| RAL equation | 30.79 | 26.60 | 24.10 | 22.33 | 20.96 |

† Three RAL markers are text "x" glyphs, so their position carries about ±0.3 °C uncertainty.

[corrected by fact-check] An independent re-digitisation of the same PDF gives slightly lower values:
- Fig 8-1 markers: 31.09 / 27.63 / 25.45 / 22.95 / 21.18 °C.
- Fig 8-2 markers: 32.95 / 29.66 / 27.86 / 25.88 / 24.96 °C.

Method: the y-axis was calibrated on the 25–45 °C and 77–113 °F labels, which are exactly collinear and put the x-axis bar
at 20.0 ± 0.05 °C. The text-glyph markers were located by the centroid of their rendered ink.

So the drawn values in the table above are about 0.1 °C high for the vector markers and about 0.25 °C high for the glyph
markers, which is within the stated ±0.3 °C. The "20" axis label sits 0.14 °C below its true position, which probably
explains the offset. The largest RAL excess over the equation is therefore +1.34 °C (at 300 kcal/h), not 1.6 °C.
Evaluating the drawn Bézier curves themselves:
- the 60-min RAL curve lies 0.2 to 1.05 °C above the RAL equation;
- the 60-min REL curve lies within 0.2 °C of the REL equation.

The partial-hour curves (45/30/15 min of work per hour) are **graphical only**. No equations are published.
- The 1-h TWA method (rest at 115 W) lands between about 0.8 °C below and 0.5 °C above the digitised REL curves
  (TWA − curve ∈ [−0.8, +0.5] °C). [corrected by fact-check: was "within −0.4 to +0.8 °C", which reverses the sign.
  The dots tabulated below give TWA − dot = −0.82 to +0.37 °C. An independent digitisation gives −0.74 to +0.46 °C.]
- It lands about 0.3–1.8 °C *below* the RAL curves, which is more protective. This follows from the RAL figure being drawn
  above its own equation. [corrected by fact-check: was "0.4–1.75 °C". An independent digitisation gives 0.27–1.65 °C
  below the RAL dots and 0.26–1.80 °C below the drawn RAL curves.]

Digitised dots (REL figure, °C):

| M (W) | 45 min/h | 30 min/h | 15 min/h |
|---|---|---|---|
| 232 | 30.65 | 31.77 | 32.59 |
| 348 | 28.90 | 30.01 | 30.91 |
| 464 | 27.27 | 28.24 | 29.81 |
| 579 | 26.38 | 27.85 | 29.20 |

1-h TWA, REL, at f = 0.75 / 0.5 / 0.25:
- 232 W: 30.17 / 30.95 / 31.87
- 348 W: 28.39 / 29.51 / 30.96
- 464 W: 27.08 / 28.39 / 30.18
- 579 W: 26.05 / 27.49 / 29.52

### 1.3 Measurement, time weighting and the "two sequential measurements" rule

> "Hourly TWA WBGTs should be calculated for the combination of jobs (tasks), including all scheduled and unscheduled rest
> periods." (§1.1.2)

> "Environmental heat measurements should be made at least hourly, during the hottest portion of each work shift, during the
> hottest months of the year, and when a heat wave occurs or is predicted. If two such sequential measurements exceed the
> applicable RAL or REL, then work conditions should be modified … until two sequential measures are in compliance with the
> exposure limits" (§1.1.2)

> "Metabolic heat rates should be expressed as kilocalories per hour (kcal·h-1) or as watts (W) for a 1-hour TWA task basis
> that includes all activities engaged in during each period of analysis and all scheduled and nonscheduled rest periods
> (1 kcal·h-1 = 1.16 W)." (§1.1.3)

The exact IT conversion is 4186.8/3600 = 1.163 W. NIOSH's own example uses 300 kcal/h = 348.9 W, i.e. 1.163.

The "two sequential exceedances" rule maps naturally onto alert hysteresis in `alerts.ts`: escalate on two consecutive hourly
exceedances, and de-escalate only after two compliant readings.

### 1.4 Metabolic categories in NIOSH 2016

- **Table 1-1 is missing from the published PDF.** §1.1.3 says "For a short list of activities and the associated metabolic
  heat rate, see Table 1-1", but no Table 1-1 exists in the document. We searched all 192 pages and inspected page 36 by
  eye.
- NIOSH points users to the *Compendium of Physical Activities* (Ainsworth et al. 2011).
- **The usable category values** come from OSHA's *Heat Hazard Recognition* page **[S, U.S. government page]**. Its
  workload table sits next to the Table 2 and clothing table that are labelled "adapted from NIOSH guidelines (2016)".
  - The workload table itself has **no source line**. Its footnote reads "The above table assumes a 70-kg (154-pound)
    worker."
  - Its W values are identical to ACGIH TLV Table 3 (§3.7).

| Level | M (W) | Example activities (OSHA list) |
|---|---|---|
| Rest | 115 | sitting, thinking |
| Light | 180 | sitting with minimal hand/arm work, sewing, writing or drawing, driving a car, occasional or slow walking, stooping, crouching or kneeling, standing watch |
| Moderate | 300 | pushing/pulling light carts, hammering nails, picking fruit or vegetables, continuous normal walking, driving or operating mobile equipment, raking, mopping or vacuuming, scraping, painting or plastering, laundry/dry cleaning, tapping and drilling, machining, molding, packaging, laboratory work, cooking, general carpentry, using hand tools |
| Heavy | 415 | intense arm and trunk work, carrying loads, shoveling, sawing or heavy carpentry, roofing, pushing/pulling heavy carts or wheelbarrows, fast walking (>4 mph), landscaping, casting, manual raising/lowering loads, stacking lumber, truck and automobile repair, waxing/buffing by hand, welding, heavy item assembly, grinding and cutting, drilling rock or concrete, mixing cement, felling trees |
| Very heavy | 520 | any activity at near-maximum pace, climbing stairs/ladder/ramp, using an axe, intense shoveling or digging, sledgehammer use, stacking concrete, brick or stone masonry, firefighting, rapid marching or physical fitness training |

Other metabolic figures appear in NIOSH 2016:
- **Table 8-1** (adapted from DOD 2007) uses Easy 250 W, Moderate 425 W and Hard 600 W.
- **Table 5-1** compares ACGIH, AIHA, OSHA, ISO and NIOSH limits. Its NIOSH column is: Light 30 °C (<200 kcal/h, 233 W),
  Moderate 28 °C (201–300 kcal/h, 234–349 W), Heavy 26 °C (301–400 kcal/h, 350–465 W), Very heavy 25 °C (401–500 kcal/h,
  466–580 W).
- **Erratum in the source:** §8.5.1 states the ACGIH work loads as "<180 kcal·h-1 … 180–300 … 300–415 … >520 kcal·h-1".
  Those are ACGIH's **watt** values (Table 3), mislabelled as kcal/h.

### 1.5 Clothing in NIOSH 2016

> "When a two-layer clothing ensemble is worn, the RAL and REL should be lowered by 2°C (3.8°F). When a partially air and/or
> vapor impermeable ensemble or heat reflective or protective aprons, leggings, gauntlets, etc., are worn, the RAL and REL
> should be lowered 4°C (7.2°F). These suggested corrections … are scientific judgments that have not been substantiated by
> controlled laboratory studies or long-term workplace experience." (§3.3)

The source has a typo here: 2 °C is a 3.6 °F difference, not 3.8 °F.

> "In those workplaces where a vapor and air impermeable encapsulating ensemble must be worn, the WBGT is not the appropriate
> measurement… the adjusted dry bulb air temperature (tadb) must be measured… Where the tadb exceeds approximately 20°C (68°F),
> physiologic monitoring (core body temperature and/or pulse rate) is required." (§3.3)

NIOSH Table 3-2, "Clothing adjustment factors (°C-WBGT)", adapted from Bernard/ACGIH 2014:

| Clothing | Previous | 2006 |
|---|---|---|
| Work clothing (baseline) | 0 | 0 |
| Cloth coveralls | 3.5 | 0 |
| Double-layer cloth clothing | 5 | 3 |
| SMS coveralls | – | 0.5 |
| Polyolefin coveralls | – | 1 |
| Limited-use vapor-barrier coveralls | – | 11 |

### 1.6 Acclimatisation (NIOSH Table 4-1, §4.1.5, §6.2.3)

> "Gradually increase exposure time in hot environmental conditions over a period of 7 to 14 days.
> For new workers, the schedule should be no more than 20% of the usual duration of work in the hot environment on day 1 and a
> no more than 20% increase on each additional day.
> For workers who have had previous experience with the job, the acclimatization regimen should be no more than 50% of the
> usual duration of work in the hot environment on day 1, 60% on day 2, 80% on day 3, and 100% on day 4.
> The time required for non–physically fit individuals to develop acclimatization is about 50% greater than for the physically
> fit." (Table 4-1)

> "Maintaining acclimatization: Can be maintained for a few days of non-heat exposure. Absence from work in the heat for a week
> or more results in a significant loss in the beneficial adaptations… Can be regained in 2 to 3 days upon return to a hot
> job… Air conditioning will not affect acclimatization." (Table 4-1)

> "The minimum exposure time for achieving heat acclimatization is at least 2 hours per day, which may be broken into 1-hour
> exposures" (§4.1.5)

The MSHA schedules are reproduced in NIOSH Table 8-2:
- **New miner:** 50, 60, 70, 80, 90, 100 % over days 1–6.
- **Acclimatised miner returning from ≥9 consecutive days of leave:** 50, 60, 90, 100 % over days 1–4.

Other sources on acclimatisation and its decay:

| Source | Statement | Tag |
|---|---|---|
| ACGIH | A worker "can be considered acclimatized" with "a recent history of heat-stress exposures of at least two continuous hours (e.g., 5 of the last 7 days to 10 of 14 days)". Loss "begins when the activity … is discontinued, and a noticeable loss occurs after four days and may be completely lost in three to four weeks." | §3.3 |
| TB MED 507 | Benefits retained "about 1 week and lost within 1 month". | §5.5 |
| OSHA proposed rule | Returning employees: "away … for more than 14 days". | §6.3 |

**Recommended engine rule [D] (engineering synthesis, conservative):**
- Absence of 4 days or more: apply the experienced / returning schedule 50 / 60 / 80 / 100 %.
- Absence of 21 days or more, or unknown history: apply the new-worker schedule 20 / 40 / 60 / 80 / 100 %.
- During either schedule, use the RAL.

### 1.7 Hydration (exact wording)

> "Providing adequate amounts of cool (i.e., less than 15°C [59°F]), potable water near the work area and encouraging all
> workers that have been in the heat for up to 2 hours and involved in moderate work activities to drink a cup of water
> (about 8 oz.) every 15 to 20 minutes. Individual, not communal, drinking cups should be provided. During prolonged sweating
> lasting more than 2 hours, workers should be provided with sports drinks that contain balanced electrolytes … as long as the
> concentration of electrolytes/carbohydrates does not exceed 8% by volume." (§1.7.3(g))

NIOSH *Heat Stress — Hydration* fact sheet, DHHS (NIOSH) Pub. **2017-126**, **[P]**:

> "When working in the heat, drink 1 cup (8 ounces) of water every 15–20 minutes. This translates to ¾–1 quart (24–32 ounces)
> per hour." … "**Do not drink more than 48 oz (1½ quarts) per hour!** Drinking too much water or other fluids … can cause a
> medical emergency because the concentration of salt in the blood becomes too low." … "NIOSH does not recommend taking salt
> tablets."

**Hourly and daily maxima in the criteria document.** Table 8-1, footnote (adapted from DOD 2007):

> "Fluid intake should not exceed 1.5 qt·h-1; daily fluid intake generally should not exceed 12 quarts."

**Hyponatremia.**
- §4.1.4 defines it as Na⁺ "<135 mmol·L-1 (mild)" and "severe hyponatremia as a plasma Na+ concentration of 120 mmol·L-1".
  §9.4.3 says "<136 mEq·L-1", which is an internal inconsistency in the source.
- The listed risk factors are: "exercise duration of >4 hours", female sex, low body mass, "excessive consumption of water
  (>1.5 L·h-1)", NSAIDs, and extreme heat.
- Dehydration (§9.4.3): tolerance deteriorates beyond 1.5–2 % of body weight lost. Above 5 % it "may lead to collapse".
  Sweat production "may reach 6 to 8 liters in a workday".

Conversions: 8 US fl oz = 236.6 mL; 24–32 oz = 0.710–0.946 L; 48 oz = 1½ qt = 1.4195 L.

### 1.8 Heat Alert Program elements

The **trigger** is stated in two slightly different ways. Use the §6.2.6 wording, because it is the more specific of the two.

> §1.7.4: "A heat wave is indicated when the daily maximum temperature exceeds 35°C (95°F) or when the daily maximum
> temperature exceeds 32°C (90°F) and is 5°C (9°F) or more above the maximum reached on the preceding days."
>
> §6.2.6(1)(d): "a Heat Alert would be declared if the area weather forecast for the next day predicts a maximum air
> temperature of at least 35°C (95°F) or if a maximum temperature of 32°C (90°F) is predicted and is 5°C (9°F) higher than the
> temperature reached on any of the preceding three days."

**Annual preparation** (§6.2.6(1)): each spring, set up a Heat Alert Committee (healthcare provider, industrial hygienist or
safety professional, safety engineer, operations engineer, manager). The committee:
- (a) arranges training;
- (b) has supervisors reverse winterisation, and check fountains, fans and air conditioners;
- (c) readies first-aid facilities;
- (d) sets the declaration criteria.

**During a Heat Alert** (§6.2.6(2), verbatim headings):
- (a) postpone non-urgent tasks;
- (b) increase the number of workers per team and introduce new workers gradually;
- (c) increase rest allowances, with recovery in air-conditioned rest places;
- (d) turn off unnecessary heat sources;
- (e) remind workers to drink water in small amounts frequently, weigh before and after the shift, and drink enough to
  maintain body weight;
- (f) monitor environmental heat at job sites and resting places;
- (g) check workers' core temperature during the most severe exposure;
- (h) take extra caution on the first day of a shift change (acclimatisation lost over the weekend);
- (i) send any worker with signs of a heat disorder for medical evaluation, with written permission required to return;
- (j) restrict overtime;
- (k) suspend piece-rate payment.

### 1.9 Work/rest guidance in NIOSH 2016

- **Figures 8-1 and 8-2.** RAL and REL curves for 60, 45, 30 and 15 min of work per hour. They are graphical only (see §1.2).
  > "When working for shorter intervals, workers may be able to work in higher temperatures… RALs and RELs take work/rest
  > schedules into consideration so are shown for 60, 45, 30, and 15 minute time periods of work" (§8.1)
- **Table 6-2 (adapted from EPA 1993), normal work clothing.** This is indexed by an *adjusted air temperature* in °F, not by
  WBGT.
  - Adjustments: full sun +13°; partly cloudy +7°; shade or night 0. Per RH: 10 % −8°, 20 % −4°, 30 % 0, 40 % +3°,
    50 % +6°, 60 % +9°.
  - Assumptions: workers fit, rested, fully hydrated, under 40, at 30 % RH, with perceptible air movement.
  - Rows, as minutes work/rest per hour, "Normal" meaning no restriction:

    | °F | Light | Moderate | Heavy |
    |---|---|---|---|
    | 90–94 | Normal | Normal | Normal |
    | 95 | Normal | Normal | 45/15 |
    | 96 | Normal | Normal | 45/15 |
    | 97 | Normal | Normal | 40/20 |
    | 98 | Normal | Normal | 35/25 |
    | 99 | Normal | Normal | 35/25 |
    | 100 | Normal | 45/15 | 30/30 |
    | 101 | Normal | 40/20 | 30/30 |
    | 102 | Normal | 35/25 | 25/35 |
    | 103 | Normal | 30/30 | 20/40 |
    | 104 | Normal | 30/30 | 20/40 |
    | 105 | Normal | 25/35 | 15/45 |
    | 106 | 45/15 | 20/40 | Caution |
    | 107 | 40/20 | 15/45 | Caution |
    | 108 | 35/25 | Caution | Caution |
    | 109 | 30/30 | Caution | Caution |
    | 110 | 15/45 | Caution | Caution |
    | 111–112 | Caution | Caution | Caution |

    "Caution" means "High levels of heat stress; consider rescheduling activities."
- **Table 6-3 (EPA 1993), chemical-resistant suits** (Tyvek, gloves, boots, respirator; heat-acclimatised workers). Indexed by
  air temperature and Full sun / Partly cloudy / No sun:

  | °F | Light (sun / partly / none) | Moderate (sun / partly / none) | Heavy (sun / partly / none) |
  |---|---|---|---|
  | 75 | Normal / Normal / Normal | Normal / Normal / Normal | 35/25 / Normal / Normal |
  | 80 | 30/30 / Normal / Normal | 20/40 / Normal / Normal | 10/50 / 40/20 / Normal |
  | 85 | 15/45 / 40/20 / Normal | 10/50 / 25/35 / Normal | Caution / 15/45 / 40/20 |
  | 90 | Caution / 15/45 / 40/20 | Caution / Caution / 25/35 | Stop work / Caution / 15/45 |
  | 95 | Stop work / Stop work / 15/45 | Stop work in every column | Stop work in every column |

- **Table 8-1 (adapted from DOD 2007, i.e. the older TB MED 507).** Superseded by TB MED 507 (2022); see §5.6 for the
  differences.

Engine use: implement the TWA method, which is the NIOSH/ACGIH computational basis. Tables 6-2 and 6-3 are a heuristic for
air-temperature-only fallback displays. Do not use them as the primary rule.

### 1.10 Physiological monitoring in NIOSH 2016

- Table 9-1: "Heat strain is indicated by a sustained HR > 180 bpm minus the worker's age".
- §9.4.1, Brouha recovery: P1 = pulse counted 30 s – 1 min, P2 = 1.5–2 min, P3 = 2.5–3 min of seated recovery.
  > "If the oral temperature exceeds 37.5°C (99.5°F), the P1 exceeds 110 beats per minutes (bpm), and/or the P1–P3 is fewer
  > than 10 bpm, the heat and work stress is assumed to be above acceptable values."
- Fuller & Smith pattern:
  - P3 ≤ 90 bpm: satisfactory.
  - P3 ≈ 90 and P1−P3 ≈ 10: high work intensity but little temperature rise.
  - P3 > 90 and P1−P3 < 10: "the stress (heat + work) is too high".
- Core temperature: the WHO recommendation is that deep body temperature should not exceed 38 °C (oral 37.5 °C) under
  prolonged daily work in heat. Oral temperature is "usually lower than deep body temperature by about 0.55°C (0.8°F)".
- Thermal Work Limit, as cited by NIOSH: a limiting sustainable metabolic rate with core < 38.2 °C and sweat rate < 1.2 kg/h.
- Heat tolerance test (Moran 2007): heat intolerance if rectal temperature > 38.5 °C or HR > 145 bpm after 120 min at 40 °C
  and 40 % RH.

---

## 2. (Reserved for the ISO 7243 cross-reference — see §4)

## 3. ACGIH TLV® for Heat Stress and Heat Strain

**Status of the sources.** The ACGIH booklet is paywalled. We used:
- **[P]** The ACGIH TLV text itself (booklet pages 211–220, an edition no later than 2016: the scan is dated 2017-01-19 and
  it cites ISO 7933:2004).
  It is posted by Cal/OSHA in its indoor-heat rulemaking docket (`dir.ca.gov/dosh/doshreg/Heat-illness-prevention-indoors/heat-tlv.pdf`).
- **[S]** CCOHS, *Hot Environments – Assessment and Control Measures*, which reproduces the **2026 TLVs® and BEIs®**
  (pp. 239 and 242).
- **[S]** LBNL ES&H Manual, Chapter 40, which reproduces the 2016 TLVs.
- **[S]** ASSP *Professional Safety*, Aug 2022, which reproduces the 2021 TLVs.

### 3.1 TLV and Action Limit equations (confirmed identical to NIOSH)

The TLV booklet presents the TLV (solid line) and Action Limit (broken line) only as **Figure 2** (WBGT_eff against metabolic
rate, 100–600 W). It gives no equation in the text.

ASSP 2022 states "TLV = 56.7 − 11.5 × log10M and AL = 59.9 − 14.1 × log10M". It adds that the AL and TLV are "identical to
values of the NIOSH recommended alert limit and recommended exposure limit. They are also identical to the ISO reference
limits (WBGTref) for unacclimatized and acclimatized persons." **[S]**

**[D] Proof.** Using these equations with the construction rule in the Table 2 notes (§3.5) reproduces **every one of the 24
published cells** of ACGIH Table 2. This is asserted in the oracle (`acgih_*` checks).

- TLV = REL ↔ acclimatised.
- Action Limit = RAL ↔ unacclimatised. The AL "represents conditions for which a heat stress management program should be
  considered."
- The TLV goal is "to maintain body core temperature within + 1°C of normal (37°C)".

### 3.2 Decision logic (TLV Figure 1, paraphrased)

1. Does the clothing allow air and water-vapour movement?
   - No: go to physiological monitoring.
2. Are the Table 2 screening criteria exceeded?
   - No, and below the AL: little risk.
   - Above the AL but below the TLV: general controls (Table 5).
3. If the TLV screening criteria are exceeded, run a detailed analysis: a TWA of WBGT_eff and M against Figure 2, then a
   rational model such as ISO 7933 PHS.
   - If no data are available for the analysis: go to physiological monitoring (Table 4).
4. If heat strain is excessive: job-specific controls.

### 3.3 Acclimatisation (TLV text, [P])

> "With a recent history of heat-stress exposures of at least two continuous hours (e.g., 5 of the last 7 days to 10 of 14
> days), a worker can be considered acclimatized for the purposes of the TLV®. Its loss begins when the activity under those
> heat stress conditions is discontinued, and a noticeable loss occurs after four days and may be completely lost in three to
> four weeks. Because acclimatization is to the level of the heat stress exposure, a person will not be fully acclimatized to a
> sudden higher level; such as during a heat wave."

### 3.4 Clothing Adjustment Values (CAV / CAF)

**2026 table** (ACGIH 2026 p. 239, as reproduced by CCOHS) **[S]**, "Clothing Adjustment Values (CAV) added to WBGT to estimate
WBGTeff":

| Clothing type | CAV °C | Tag |
|---|---|---|
| Short sleeves and pants of woven material | **−1** | [S] only, 2026 |
| Work clothes (long sleeve shirt and pants) | 0 | [P] older edition and [S] |
| Cloth (woven material) coveralls | 0 | [P] and [S] |
| SMS (spunbond-meltblown-spunbond) polypropylene coveralls | 0.5 | [P] and [S] |
| Polyolefin coveralls | 1 | [P] and [S] |
| Double-layer woven clothing | 3 | [P] and [S] |
| Limited-use vapour-barrier coveralls | 11 | [P] and [S] |
| Adding a hood (full head and neck covering; not face) | **+1** | [S] 2026, plus primary research below |

Notes to the table:
1. "These values are not to be used for completely encapsulating suits, often called Level A as defined by OSHA."
2. "CAVs are not additive for multiple layers."
3. "Coveralls assume that only undergarments are worn underneath, not a second layer of clothing."
4. "There is no evidence to suggest that respirators or face coverings add to the heat stress burden."

The older edition (Cal/OSHA copy) has only the six rows marked [P], with notes 1–3 worded as: "These values must not be used
for completely encapsulating suits, often called Level A. Clothing Adjustment Factors cannot be added for multiple layers. The
coveralls assume that only modesty clothing is worn underneath, not a second layer of clothing."

**Primary research behind the values** **[P]** (PubMed abstracts):
- Bernard et al. 2005, *J Occup Environ Hyg* 2:251–256: cotton coveralls 0, Tyvek 1424 +1, NexGen +2, Tychem QC +10.
  Only the vapour barrier interacted with humidity.
- Bernard et al. 2008, *JOEH* 5:1–5: the CAF does not change with metabolic rate. Tychem QC measured 7.5, but 10 was kept "to
  account for the effects of humidity".
- Ashley & Bernard 2008, *JOEH* 5:59–62: "a clothing adjustment of 1 degrees C for hoods". Flame-retardant coveralls (INDURA
  cotton, Nomex) = 0 °C.
- ACGIH later set the vapour-barrier value at 11.

**Engine:**
- WBGT_eff = WBGT + CAV(ensemble) + (hood ? 1 : 0).
- An ensemble that is not listed, or a Level A suit, gives `wbgtMethodApplicable = false` (use PHS and the physiological
  channel).
- Default when clothing is unknown: "cloth coveralls" (CAV 0), per the ARCHITECTURE. It does not change WBGT_eff relative to
  work clothes.

### 3.5 Table 2 — screening criteria (WBGT_eff, °C)

Values are identical in the Cal/OSHA-hosted [P] text, CCOHS (2026) [S] and LBNL (2016) [S].

| Allocation of work in a cycle of work and recovery | TLV Light | TLV Mod | TLV Heavy | TLV V.Heavy | AL Light | AL Mod | AL Heavy | AL V.Heavy |
|---|---|---|---|---|---|---|---|---|
| 75 to 100 % | 31.0 | 28.0 | – | – | 28.0 | 25.0 | – | – |
| 50 to 75 % | 31.0 | 29.0 | 27.5 | – | 28.5 | 26.0 | 24.0 | – |
| 25 to 50 % | 32.0 | 30.0 | 29.0 | 28.0 | 29.5 | 27.0 | 25.5 | 24.5 |
| 0 to 25 % | 32.5 | 31.5 | 30.5 | 30.0 | 30.0 | 29.0 | 28.0 | 27.0 |

The notes under the table, verbatim:
- "WBGT values are expressed to the nearest 0.5°C."
- "**The thresholds are computed as a TWA-Metabolic Rate where the metabolic rate for rest is taken as 115 W and work is the
  representative (mid-range) value of Table 3. The time base is taken as the proportion of work at the upper limit of the
  percent work range (e.g., 50% for the range of 25 to 50%).**"
- "If work and rest environments are different, hourly time-weighted averages (TWA) WBGT should be calculated and used. TWAs
  for work rates should also be used when the work demands vary within the hour, but note that the metabolic rate for rest is
  already factored into the screening limit."
- "Values … assume 8-hour workdays in a 5-day workweek with conventional breaks…"
- "Because of the physiological strain associated with Heavy and Very Heavy work among less fit workers regardless of WBGT,
  criteria values are not provided for continuous work and for up to 25% rest in an hour for Very Heavy. The screening criteria
  are not recommended, and a detailed analysis and/or physiological monitoring should be used."
- "Table 2 is intended as an initial screening tool … the table is more protective than the TLV® or Action Limit (Figure 2).
  Because the values are more protective, they are not intended to prescribe work and recovery periods."

**[D] Construction, reproduced exactly:** `M_TWA = f·M_cat + (1−f)·115`, with f ∈ {1.00, 0.75, 0.50, 0.25}. Then compute TLV
or AL at M_TWA and round to the nearest 0.5.

Raw values before rounding (TLV / AL, °C):

| f | Light (180 W) | Moderate (300) | Heavy (415) | Very heavy (520) |
|---|---|---|---|---|
| 1.00 | 30.76 / 28.10 | 28.21 / 24.97 | 26.59 / 22.99 † | 25.47 / 21.60 † |
| 0.75 | 31.24 / 28.68 | 29.05 / 26.00 | 27.59 / 24.21 | 26.55 / 22.93 † |
| 0.50 | 31.76 / 29.32 | 30.05 / 27.23 | 28.83 / 25.73 | 27.93 / 24.63 |
| 0.25 | 32.34 / 30.03 | 31.31 / 28.77 | 30.49 / 27.77 | 29.85 / 26.98 |

† Published cell blank: screening "not recommended". The engine must return `screeningAvailable: false`, not the computed
number.

**Screening lookup rule [D]:**
- Allocation = the first row from the top (75–100 %, then 50–75 %, and so on) whose cell is not null and is ≥ WBGT_eff.
- If even the 0–25 % cell is below WBGT_eff: "exceeds all screening criteria → detailed analysis / physiological monitoring".
- This matches the CCOHS worked examples:
  - 27.0 °C, unacclimatised, moderate → 25–50 %.
  - 28 + 3 (double layer) = 31 °C, acclimatised, moderate → 0–25 %.
  - 33 °C → above all values.

### 3.6 Allowed work fraction from the equations (what the engine uses)

```
g(f) = Limit( f·M_work + (1−f)·M_rest ) − ( f·WBGT_eff,work + (1−f)·WBGT_eff,rest ),   M_rest = 115 W
f* = 1               if g(1) ≥ 0                  (continuous work OK; margin = g(1))
f* = 0               if g(0) < 0                  (even resting exceeds the limit)
f* = root of g       otherwise (bisection on [0,1])
```

Why the root is unique: `Limit = a − b·log10(M)` is convex in M, and M_TWA is linear in f, so g is convex in f. A convex g
with g(0) ≥ 0 > g(1) has exactly one root.

Bisection details:
- Keep the invariant g(lo) ≥ 0 > g(hi).
- Use 50 iterations, or stop when hi − lo < 1e-9.
- Return `lo`, the feasible side.

Edge cases:
- If WBGT_rest > WBGT_work, use the measured values. This is conservative, and the algorithm stays correct because of
  convexity.
- Non-finite inputs → throw (the caller applies the fail-safe default).

Oracle examples (`allowed_work_fraction` group, rest 115 W):

| Case | Work / rest WBGT_eff °C | M_work W | Acclimatised | f* | min/h |
|---|---|---|---|---|---|
| TLV(f=0.75) consistency | 29.0509 / 29.0509 | 300 | yes | 0.7496 | 45.0 |
| continuous OK | 27 / 27 | 300 | yes | 1 (margin 1.21 °C) | 60 |
| sun 30 / shade 28 | 30 / 28 | 300 | no | 0.2808 | 16.8 |
| heavy | 31 / 27 | 415 | yes | 0.4828 | 29.0 |
| very heavy | 33 / 29 | 520 | yes | 0.2387 | 14.3 |
| rest above RAL(115) = 30.84 | 34 / 34 | 180 | no | 0 | 0 |
| shaded/AC rest | 32 / 25 | 300 | yes | 0.6388 | 38.3 |
| light | 31 / 31 | 180 | yes | 0.8724 | 52.3 |

### 3.7 Table 3 — metabolic rate categories ([P]; identical in ASSP 2022 / ACGIH 2021)

| Category | M [W] | Examples |
|---|---|---|
| Rest | 115 | Sitting |
| Light | 180 | Sitting with light manual work with hands or hands and arms, and driving. Standing with some light arm work and occasional walking. |
| Moderate | 300 | Sustained moderate hand and arm work, moderate arm and leg work, moderate arm and trunk work, or light pushing and pulling. Normal walking. |
| Heavy | 415 | Intense arm and trunk work, carrying, shoveling, manual sawing; pushing and pulling heavy loads; and walking at a fast pace. |
| Very Heavy | 520 | Very intense activity at fast to maximum pace. |

> "\* The effect of body weight on the estimated metabolic rate can be accounted for by multiplying the estimated rate by the
> ratio of actual body weight divided by 70 kg (154 lb)."

The ASSP 2022 worked answers, reproduced in the oracle: 180 W × 110/70 = 282.86 W; 415 W × 87/70 = 515.79 W.

### 3.8 Table 4 — Guidelines for Limiting Heat Strain ([P], verbatim)

> "One or more of the following measures may mark excessive heat strain, and an individual's exposure to heat stress should be
> discontinued when any of the following occur:
> • Sustained (several minutes) heart rate is in excess of 180 bpm (beats per minute) minus the individual's age in years
>   (e.g., 180- age), for individuals with assessed normal cardiac performance; or
> • Body core temperature is greater than 38.5°C (101.3°F) for medically selected and acclimatized personnel; or greater than
>   38°C (100.4°F) in unselected, unacclimatized workers; or
> • Recovery heart rate at one minute after a peak work effort is greater than 120 bpm; or
> • There are symptoms of sudden and severe fatigue, nausea, dizziness, or lightheadedness.
> An individual may be at greater risk of heat-related disorders if:
> • Profuse sweating is sustained over hours; or
> • Weight loss over a shift is greater than 1.5% of body weight; or
> • 24-hour urinary sodium excretion is less than 50 mmoles"

Further statements:
- "EMERGENCY RESPONSE: If a worker appears to be disoriented or confused, suffers inexplicable irritability, malaise, or
  chills, the worker should be removed for rest in a cool location … Absent medical advice to the contrary, treat this as an
  emergency with immediate transport to a hospital."
- Heat stroke: "body core temperature is greater than 40°C (104°F)".
- Pregnancy: "During the first trimester of pregnancy, a sustained core temperature greater than 39°C may endanger the fetus."

### 3.9 Table 5 — heat-stress management program (selected, [P])

- "Encourage drinking small volumes (approximately 1 cup) of cool, palatable water (or other acceptable fluid replacement
  drink) about every 20 minutes".
- Report symptoms, self-limitation of exposure, co-worker observation, and counselling for those on medications.
- "Adjust expectations of those returning to work after absence from hot exposure situations".
- Pre-placement screening.
- The program is triggered by "1) heat stress levels that exceed the Action Limit or 2) work in clothing ensembles that limit
  heat loss".

### 3.10 Legacy ACGIH (1992) table, historical only

This is the OSHA Technical Manual from before 2017, archived 2015. **Do not use.**

TLV by work/rest regimen, for acclimatised workers in light summer clothing (°C WBGT):

| Regimen | Light | Moderate | Heavy |
|---|---|---|---|
| Continuous | 30.0 | 26.7 | 25.0 |
| 75 % work, 25 % rest | 30.6 | 28.0 | 25.9 |
| 50 % work, 50 % rest | 31.4 | 29.4 | 27.9 |
| 25 % work, 75 % rest | 32.2 | 31.1 | 30.0 |

The legacy clothing corrections were *subtracted from the limit*: cotton coveralls −2, winter clothing −4, permeable water
barrier −6. OSHA's current OTM page (revised 2017-09-15) no longer reproduces the ACGIH tables, citing copyright.

---

## 4. ISO 7243:2017 — WBGT heat stress assessment (third edition, 2017-08; replaces ISO 7243:1989)

**[P] Verified from the official iTeh/ISO preview** (clauses 1–9):

- **Formulae.** Without solar load, WBGT = 0.7 t_nw + 0.3 t_g (1). With solar load, WBGT = 0.7 t_nw + 0.2 t_g + 0.1 t_a (2).
- **Clothing.** WBGT_eff = WBGT + CAV (3). The reference clothing is cotton work clothes, I_cl = 0.6 clo and i_m = 0.38.
  > "For clothing ensembles for which the CAV cannot be determined, this document shall not be used and a detailed analysis of
  > the heat stress, using ISO 7933, shall be carried out."
- **Exposure.** "The WBGT reference values (exposure limits) presented correspond to levels of sustained exposure for up to
  8 h."
- **Time weighting, §9.2.** "The time base T for the calculation of the mean values is a period of about 1 h":
  `p̄ = (p1·t1 + p2·t2 + … + pn·tn) / (t1 + t2 + … + tn)` (4), with `t1 + t2 + … = T = 1 h` (5). This applies to t_a, t_nw,
  t_g or WBGT.
- **Metabolic rate, §9.3.** Formula (4) is applied using the mean value of each class from Table E.1.
  > "When there is doubt with regard to the metabolic rate value to be adopted, the reference value to be used is that
  > corresponding to the higher metabolic rate, if all measurement or estimation is impossible."

  [corrected by fact-check: the quote previously stopped before the qualifying clause "if all measurement or estimation
  is impossible", which limits when the higher class must be used.]
- **Clothing over time, §9.4.** "If the clothing varies throughout the exposure, the time weighted average, WBGTeff values
  shall be used according to Formula (4)."
- **Spatial, §9.1.**
  > "The WBGT values should normally be measured at the position of the abdomen (ISO 7726) of those exposed to the heat. When
  > parameters in the space surrounding these people are not homogeneous, measurement should be made at the position where
  > heat stress is highest."

  So the 2017 main text has **no head / abdomen / ankle weighting**.
- **Spatial weighting in ISO 7243:1989** (legacy, as described by Parsons 2006, *Ind Health* 44:368 [S]):
  `WBGT = (WBGT_head + 2·WBGT_abdomen + WBGT_ankles)/4`. In that edition, time weighting was over one hour "calculated from the
  beginning of a period of work".
- **Annexes:**
  - A (informative): reference values.
  - B (normative): instruments.
  - C: alternative globes.
  - D: prediction of t_nw.
  - E (informative): metabolic rate.
  - F (informative): CAVs.

  The Foreword says Annex A now gives "additional exposure limits … in Figure A.1, together with reference equations".

**Annex A equations.** These are 56.7 − 11.5·log10 M (acclimatised) and 59.9 − 14.1·log10 M (unacclimatised), with M in W.
- [S] Confirmed by ASSP 2022, which calls them "identical" to NIOSH and ACGIH.
- **[S] UNVERIFIED (stated only in a search-engine snippet):** a validity range of "115 < M < 520 W".

**Annex A Table A.1, reference values by class** **[S]** (reproduced in Brimicombe et al., *Int J Biometeorol* 2024,
doi:10.1007/s00484-024-02783-6):

| Class (W) | Acclimatised °C | Unacclimatised °C | Equation acclimatised / unacclimatised [D] |
|---|---|---|---|
| 0 Resting (115) | 33 | 32 | 33.00 / 30.84 |
| 1 Low (180) | 30 | 29 | 30.76 / 28.10 |
| 2 Moderate (300) | 28 | 26 | 28.21 / 24.97 |
| 3 High (415) | 26 | 23 | 26.59 / 22.99 |
| 4 Very high (520) | 25 | 20 | 25.47 / 21.60 |

The tabulated unacclimatised values do not follow the equation. Classes 0–2 are 0.9–1.2 °C *higher* than the equation
(less protective), class 3 matches, and class 4 is 1.6 °C lower. They are carried over from the 1989 table.

The **ISO 7243:1989 table** (Parsons 2006 [S]), "allowing for a maximum rectal temperature of 38°C". Brackets give the value
"with sensible air movement":

| M (W/m²) | Acclimatised °C | Unacclimatised °C |
|---|---|---|
| < 65 | 33 | 32 |
| 65–130 | 30 | 29 |
| 130–200 | 28 | 26 |
| 200–260 | 25 (26) | 22 (23) |
| > 260 | 23 (25) | 18 (20) |

**Engine:** use the equations, which ISO itself gives, and treat the tables as display only.

**Annex E (metabolic classes) and Annex F (CAV values): UNVERIFIED.** The standard is paywalled and no reliable full
reproduction was found.
- For CAVs, use the ACGIH table (§3.4). Some secondary snippets suggest Table F.1 includes more vapour-barrier rows (apron 4,
  vapour-barrier coveralls without hood 10, with hood 11, vapour barrier over coveralls 12, hood +1). These are **not
  verified; do not transcribe**.
- For the classes, use §5.

**pythermalcomfort `work_capacity_iso`** uses `34.9 − M/46`. This is *not* an ISO equation. It is a linear fit used by Bröde
et al. 2018 (*Int J Biometeorol* 62:331), and is roughly the 1989 acclimatised "no air movement" column. `work_capacity_niosh`
interpolates linearly between REL(M) (100 %) and REL(117 W) (0 %). Both are reproduced in the oracle. They are productivity
estimates, not exposure limits.

---

## 5. ISO 8996 — metabolic rate

### 5.1 ISO 8996:2021 (third edition, 2021-12) — what is verified **[P]** (official preview, clauses 1–7)

- Foreword:
  > "The metabolic rate associated with a given task and estimated using the methods described in this document is expressed
  > in watts." … "At level 1, Screening, the method classifying metabolic rate according to occupation has been removed".
- §4: "If the task does not involve displacements, the metabolic rate will not vary as a function of the size and the weight
  of the subject. If it involves displacements, then the weight of the person shall be taken into account (see Annex B)."
  ISO 7243, 7730, 7933 and 11079 still work in W·m⁻².
- §6: "Table A.1 defines five classes of metabolic rate: resting, low, moderate, high and very high. For each class, a range
  of metabolic rate values is given as well as a number of examples. These activities are supposed to include short rest
  pauses." … "it should only be used for classification purposes without interpolation between the four categories."
- Table 1, uncertainty of each level:

  | Level | Method | Uncertainty |
  |---|---|---|
  | 1 | Screening | "very great risk of error" |
  | 2 | Observation | ±20 % |
  | 3A | Heart rate | ±10–15 % |
  | 4 | Expertise (oxygen consumption, doubly labelled water, direct calorimetry) | ±5 % |

  Heavy clothing can raise metabolic rate by "20 % or more".
- **The numeric ranges of the 2021 Table A.1: UNVERIFIED** (paywalled).

### 5.2 ISO 8996:2004 Table A.2 — classification by kind of activity **[S]**

Reproduced in Foster, Hodder, Lloyd & Havenith, *Front Physiol* 2020;11:541483, which cites ISO 2004. The resting row is also
seen in snippets of the standard.

| Class | Mean W·m⁻² (range) | Mean W, 1.8 m² (range) | Examples (condensed) |
|---|---|---|---|
| 0 Resting | 65 (55–70) | 115 (100–125) | resting, sitting at ease |
| 1 Low | 100 (70–130) | 180 (125–235) | light manual or bench work (writing, assembly, inspection); driving / pedals; light machining; walking ≤ 2.5 km/h |
| 2 Moderate | 165 (130–200) | 295 (235–360) | sustained hand/arm work (hammering nails, filing); off-road operation of lorries, tractors, construction equipment; intermittent handling of moderately heavy material; weeding, picking; pushing light carts or wheelbarrows; walking 2.5–5.5 km/h |
| 3 High | 230 (200–260) | 415 (360–465) | intense arm and trunk work; carrying heavy material; shovelling; sledgehammer work; sawing; digging; pushing heavily loaded carts; walking 5.5–7 km/h |
| 4 Very high | 290 (> 260) | 520 (> 465) | very intense activity at fast to maximum pace; working with an axe; intense shovelling or digging; climbing stairs, ramp or ladder; running; walking > 7 km/h |

**Body surface area assumption** (ISO 8996:2004 introduction, **[P]** preview): the tables concern an "average" individual.
- Man: 30 years, 70 kg, 1.75 m, body surface area **1.8 m²**.
- Woman: 30 years, 60 kg, 1.70 m, **1.6 m²**.

The W column is copied as tabulated in the source. It equals the W·m⁻² value × 1.8 m² to within 3 W and is usually rounded
to the nearest 5 W (165 × 1.8 = 297 → 295), but not always: 260 × 1.8 = 468 is tabulated as 465. [corrected by fact-check:
the text previously said the column was simply "× 1.8 m², rounded".]

DuBois: `A_Du = 0.202 · m^0.425 · h^0.725` (m in kg, h in m). This gives 1.844 m² for 70 kg / 1.75 m. It is pythermalcomfort's
`body_surface_area` default.

**Mapping used by the other standards.** ACGIH Table 3, the OSHA *Heat Hazard Recognition* workload table and ISO 7243:2017
Table A.1 use 115 / 180 / **300** / 415
/ 520 W. ACGIH computed its Table 2 with **300 W**, not 295. Use 300 W wherever results must match ACGIH, NIOSH or ISO 7243
tables.

**Differences between example lists:**

| Task | ISO 8996:2004 | OSHA workload table |
|---|---|---|
| Sledgehammer | High | Very heavy |
| Welding | not listed | Heavy |
| Driving or operating mobile equipment | Low (driving vehicle in normal conditions) | Moderate |
| Off-road operation of construction equipment | Moderate | — |

The OSHA list (§1.4) is the most useful for construction, industry and logistics. Typical Zill tasks:
- **Light (180 W):** driving a car or van, inspection.
- **Moderate (300 W):** forklift or other mobile-equipment operation, general carpentry, packaging, scraping, painting.
  [corrected by fact-check: forklift was listed under Light. The OSHA list (§1.4) puts "driving or operating mobile
  equipment" under Moderate. ISO 8996:2004 puts off-road operation of lorries, tractors or construction equipment under
  Moderate. ISO 7243:2017 §9.3 says to use the higher class when in doubt and measurement or estimation is impossible.]
- **Heavy (415 W):** carrying loads, rebar or concrete work, roofing, welding.
- **Very heavy (520 W):** masonry, intense digging, ladder climbing.

---

## 5bis. US Army TB MED 507 — *Heat Stress Control and Heat Casualty Management* (12 April 2022) **[P]**

The govinfo PDF (81 pages) supersedes TB MED 507/AFPAM 48-152(I) of 7 March 2003.

### 5.3 Heat categories and WBGT

- WBGT: "**WBGT, °F = 0.7(Twb) + 0.2(Tbg) + 0.1(Tdb)**" (para 2-2d).
  > "No other heat stress index or scale should be used in place of the WBGT."

  > "It is neither technically nor scientifically feasible to accurately forecast WBGT. As a result, measured WBGT is best"
  > (para 2-2e)

  The second statement is relevant to Zill's forecast-based estimates: label them as estimates.
- Hot-weather guidance threshold: "~75 °F" air temperature (para 3-3a). Above WBGT 90 °F, "training may require extreme
  modifications or temporary suspension".
- Categories (Figure 3-3), °F with exact °C bounds:

| CAT | Flag | WBGT °F (as printed) | Engine interval °F | Lower bound °C |
|---|---|---|---|---|
| 1 | white | 78–81.9 | [78, 82) | 25.556 |
| 2 | green | 82–84.9 | [82, 85) | 27.778 |
| 3 | yellow | 85–87.9 | [85, 88) | 29.444 |
| 4 | red | 88–89.9 | [88, 90) | 31.111 |
| 5 | black | > 90 | ≥ 90 | 32.222 |

- Sports-medicine categories, for >800 W "high-risk" events: white < 50 °F, green 50–64.4, yellow 64.5–73.4, red 73.5–82.4,
  black > 82.4.
- Edge case: the printed bands leave gaps (81.9–82, 89.9–90) and an ambiguous "> 90". Use half-open intervals and convert
  °C → °F first, using exact `°F = 1.8·°C + 32`.

### 5.4 Table 3-2 — Fluid replacement and work-rest (training; heat-acclimatised; OCP uniform)

| CAT | WBGT °F | Easy 250 W | Moderate 425 W | Heavy 600 W | Very heavy 800 W |
|---|---|---|---|---|---|
| 1 | 78–81.9 | NL · ½ qt/h | NL · ¾ | 40/20 · ¾ | 20/40 · 1 |
| 2 | 82–84.9 | NL · ½ | NL · ¾ | 30/30 · 1 | 15/45 · 1 |
| 3 | 85–87.9 | NL · ¾ | NL · ¾ | 30/30 · 1 | 10/50 · 1 |
| 4 | 88–89.9 | NL · ¾ | 50/10 · ¾ | 20/40 · 1 | 10/50 · 1 |
| 5 | > 90 | NL · 1 | 20/40 · 1 | 15/45 · 1 | 10/50 · 1 |

Work-rest is minutes of work / minutes of rest per hour. "NL = no limit to work per hour (up to 4 continuous hours)."

Example tasks:
- Easy: weapon maintenance, marksmanship training, drill and ceremony.
- Moderate: patrolling with a 30-lb load, low and high crawl, digging a defensive position.
- Heavy: patrolling with a 45-lb load, four-person litter carry (180 lb), jogging 4 mph.
- Very heavy: two-person litter carry (150 lb), moving under direct fire, obstacle course.

Notes (verbatim):
- "The work-rest times and fluid replacement volumes will sustain performance and hydration for at least 4 hours of work in
  the specified heat category."
- "Fluid needs can vary based on individual differences (± ¼ qt/hr) and exposure to full sun or full shade (± ¼ qt/hr)."
- "Rest means minimal physical activity (sitting or standing) accomplished in shade if possible."
- "**CAUTION: Hourly fluid intake should not exceed 1½ qt.**"
- "**CAUTION: Daily fluid intake should not exceed 12 qt.**"
- "If wearing heavy protective clothing (CBRN, JSLIST), add 10 °F to WBGT index for easy work and 20 °F to WBGT index for
  moderate and heavy work."

**Table 3-3, continuous work** (minutes of work · qt/h):

| CAT | Easy | Moderate | Heavy | Very heavy |
|---|---|---|---|---|
| 1 | NL · ½ | NL · ¾ | 110 · ¾ | 45 · ¾ |
| 2 | NL · ½ | NL · 1 | 70 · 1 | 40 · 1 |
| 3 | NL · ¾ | NL · 1 | 60 · 1 | 25 · 1 |
| 4 | NL · ¾ | 180 · 1¼ | 50 · 1¼ | 20 · 1¼ |
| 5 | NL · 1 | 70 · 1½ | 45 · 1½ | 20 · 1½ |

Litres: ½ qt = 0.473 L; ¾ = 0.710; 1 = 0.946; 1¼ = 1.183; 1½ = 1.420; 12 qt = 11.36 L.

### 5.5 Fluid caps, hyponatremia and acclimatisation in TB MED 507

**Fluid caps and hyponatremia:**
- Table 3-6: "Do not exceed 1½ quarts per hour or 12 quarts per day".
  > "The stomach empties less than 1½ quarts per hour; thus, drinking more than this may result in bloating and increases
  > hyponatremia risk. … Do not exceed 12 quarts per day unless 24-hour urine assessment measures still suggest inadequacy."
- Para 3-7h:
  > "Most cases of hyponatremia (that is, serum sodium < 135 mmol/L) in the military are due to overhydration/water
  > intoxication rather than electrolyte depletion. To prevent this aspect of the problem, water doctrine recommendations are to
  > not exceed intakes of 1½ quarts per hour or 12 quarts per 24 hours (or 4 full hydration systems)."
- High-risk situations (para 3-7i): the early heat season before acclimatisation, restricted food, multi-day red or black
  CAT, and a command emphasis on drinking.
- Mitigation: replace 2 qt/day of water with an electrolyte beverage. "If Service members substantially overconsume fluids
  (beyond sweat losses) over an extended period of 4 hours or more while not replacing their salt losses, they can develop
  hyponatremia" (para 2-3f).
- Dehydration raises core temperature by about 0.36 °F per 1 % body-mass loss, and heart rate by about 5 bpm per 1 %
  (para 2-3f). Guidance counts as effective when within ±2 % of body weight over 4 h (para 3-6f).
- Water should be cooled to 50–60 °F (Table 3-6).

**Acclimatisation (Table 2-1, para 2-5):**
- "Try to achieve between 4 to 14 days of heat exposures."
- "Try to achieve ≥ 100 minutes of daily heat exposure; use work-rest cycles at start."
- "If heat exposure is discontinued, benefits are retained for about 1 week and lost within 1 month."
- "Optimal heat acclimatization takes approximately 10 days."
- Typical body core temperature and heart rate responses fall by "~2 °F and 40 beats per minute" after acclimatisation.

**Core temperature endpoints used for doctrine** (Heat Strain Decision Aid): 101.3 °F (38.5 °C) for the work-rest tables and
104 °F (40 °C) for continuous work under compensable heat stress (para 3-2f).

### 5.6 Change from the DOD 2003/2007 table reproduced in NIOSH 2016 Table 8-1

| CAT | Easy (2007 → 2022) | Moderate (2007 → 2022) | Hard (2007 → 2022) |
|---|---|---|---|
| 2 | — | 50/10 → **NL** | — |
| 3 | — | 40/20 → **NL** | — |
| 4 | — | 30/30 → **50/10** | — |
| 5 | 50/10 → **NL** | — | 10/50 → **15/45** |

The 2022 edition also adds the Very heavy (800 W) column. Port the **2022** values.

---

## 6. OSHA

### 6.1 Heat-index risk levels (OSHA-NIOSH Heat Safety Tool basis)

NIOSH 2016 Appendix C Table C-1 ("Adapted from OSHA [2012c]") **[P]**:

| Heat index | Risk level | Protective measure |
|---|---|---|
| Less than 91 °F (33 °C) | Lower (caution) | Basic health and safety planning |
| 91 °F to 103 °F (33–39 °C) | Moderate | Implement precautions and heighten awareness |
| 103 °F to 115 °F (39–46 °C) | High | Additional precautions to protect workers |
| Greater than 115 °F (46 °C) | Very high to extreme | Even more aggressive protective measures |

- Engine intervals **[D]**: < 91 lower; [91, 103) moderate; **[103, 115] high**; > 115 very high to extreme. 103 is listed in
  two bands and is resolved upward. "Greater than 115" excludes 115.
- "Since heat index values were devised for shady, light wind conditions, exposure to full sunshine can increase heat index
  values by up to 15°F." (NIOSH App C). NWS gives the same figure.
- **App status [P]** (CDC page, last reviewed 2026-03-03):
  > "The OSHA-NIOSH Heat Safety Tool App is not receiving updates at this time." … "NIOSH and OSHA are currently considering
  > new scientific data related to the HI levels."

  The labels the current app displays are UNVERIFIED (§10).
- Evidence that the "lower" band is not safe: Tustin et al., *MMWR* 2018;67(26):733–737.
  > "Heat Index was <91°F (32.8°C) in 12 of 25 cases, including six of 14 fatalities"

  The authors proposed an 85 °F screening threshold.

### 6.2 OSHA *Heat Hazard Recognition* page (accessed 2026-11-09) **[S, U.S. government]**

**Table 2, "Heat stress recommendations, adapted from NIOSH guidelines (2016)"**, effective WBGT:

| Workload | Action limit, unacclimatised | TLV, acclimatised |
|---|---|---|
| Light | 28 °C | 30 °C |
| Moderate | 25 °C | 28 °C |
| Heavy | 23 °C | 26 °C |
| Very heavy | 21 °C | 25 °C |

These are whole-degree simplifications of RAL/REL at 180 / 300 / 415 / 520 W. The equation values are 28.10 / 30.76,
24.97 / 28.21, 22.99 / 26.59 and 21.60 / 25.47. The rounding is **neither a consistent floor nor a consistent round**
(30.76 → 30 but 24.97 → 25). Compute from the equations.

**Table 1, simplified**, effective WBGT:

| Effective WBGT | Unacclimatised | Acclimatised |
|---|---|---|
| < 70 °F (21 °C) | low risk | low risk |
| 70–77 °F (21–25 °C) | strenuous work possibly unsafe | low risk |
| > 77 °F (25 °C) | high risk with strenuous work | strenuous work possibly unsafe |

**Clothing adjustment factors on the same page:** work clothes 0; cloth coveralls 0; SMS 0.5 °C; polyolefin 1 °C; double-layer
3 °C; limited-use vapour-barrier 11 °C. These are added to the measured WBGT.

### 6.3 Proposed federal rule — *Heat Injury and Illness Prevention in Outdoor and Indoor Work Settings*

RIN 1218-AD39; NPRM 89 FR 70698, 30 Aug 2024; proposed 29 CFR 1910.148; regulatory text read in full **[P]**.

**Triggers:**
- "*Initial heat trigger* means a heat index of 80 °F or a wet bulb globe temperature equal to the NIOSH Recommended Alert
  Limit (RAL)."
- "*High heat trigger* means a heat index of 90 °F or a wet bulb globe temperature equal to the NIOSH Recommended Exposure
  Limit (REL)."
- Heat index means "the National Weather Service heat index".
- The employer picks one metric. If none is identified, the heat-index triggers apply. Requirements apply "at or above" the
  trigger.

**At or above the initial trigger (§(e)):**
- potable water "suitably cool … sufficient quantity to provide access to **1 quart of drinking water per employee per hour**";
- outdoor break areas with shade (not shade from equipment) or air conditioning; indoor break areas air-conditioned or with
  increased air movement;
- indoor work-area controls;
- above 102 °F ambient, fans must be evaluated against humidity;
- acclimatisation (below);
- paid rest breaks "if needed to prevent overheating";
- two-way communication;
- cooling PPE maintained.

**Acclimatisation (§(e)(7)), option (B):**
- New employees: "no more than: 20% of a normal work shift exposure duration on the first day of work, 40% on the second day
  of work, 60% of the third day of work, and 80% on the fourth day of work."
- Returning after "more than 14 days" away: "50% … first day … 60% on the second day of work, and 80% of the third day".
- Option (A) for either group: apply the high-heat measures during the first week.
- Exception: the employee "consistently worked under the same or similar conditions … within the prior 14 days".

**At or above the high trigger (§(f)):**
- "a minimum **15-minute paid rest break at least every two hours**". A meal break may count. Donning and doffing time and
  walking to the break area do not count.
- Observation by a mandatory buddy system, or by a supervisor with "no more than 20 employees observed per supervisor".
  Lone workers must be contacted "at least every two hours".
- Hazard alert before the shift.
- Warning signs where indoor ambient temperature "regularly exceed[s] 120 °F".

**Exemptions:**
- no reasonable expectation of exposure at or above the initial trigger;
- "Short duration employee exposures … of 15 minutes or less in any 60-minute period";
- emergency response;
- indoor areas where air conditioning "consistently keeps the ambient temperature below 80 °F";
- telework;
- sedentary indoor work.

Other provisions: heat illness and emergency procedures (relieve from duty, monitor, do not leave the person alone, cool them,
call EMS), training, and recordkeeping.

**Status as of November 2026 [P]** (reginfo.gov Unified Agenda XML, run date 2026-11-08, publication shown as "2026"):

| Date | Event |
|---|---|
| 08/30/2024 | NPRM |
| 01/14/2025 | Comment period closed |
| 06/16/2025 – 07/02/2025 | Informal public hearing |
| 10/30/2025 | Post-hearing comment period, as extended (90 FR 46110), ended |
| 12/2026 | **Next action: Supplemental NPRM** |
| 10/2027 | **Final Action** |

The rule is in the Proposed Rule Stage, priority "Economically Significant". **No federal heat standard is in force.**
- OSHA enforces through the General Duty Clause.
- It re-issued its heat National Emphasis Program (CPL 03-00-024) on **10 April 2026, for five years (through 2031)**
  (Littler, 16 Apr 2026 **[S]**; the primary directive was checked by the fact-check, see §10 item 8). Heat-priority
  days are a heat index of 80 °F or more, with inspections on NWS heat
  warning/advisory days.

How the WBGT trigger depends on M: the high trigger is WBGT ≥ REL(M) and the initial trigger is WBGT ≥ RAL(M). For example,
at 300 W the initial trigger is 24.97 °C and the high trigger 28.21 °C. How OSHA intends M to be determined is not in the
regulatory text: UNVERIFIED (preamble not reviewed).

---

## 7. (merged into §5bis)

## 8. NWS heat index (Rothfusz regression with adjustments) **[P]**

Source: the WPC page "The Heat Index Equation" (last modified 2022-05-12) and the WPC calculator JavaScript.

```
Step 1 (always):  HI_s = 0.5 * { T + 61.0 + [(T - 68.0) * 1.2] + (RH * 0.094) }     // = 1.1 T - 10.3 + 0.047 RH
Step 2:           if HI_s >= 80 °F:  HI = Rothfusz(T, RH) + adjustment;  else HI = HI_s
Rothfusz (°F):    HI = -42.379 + 2.04901523*T + 10.14333127*RH - .22475541*T*RH - .00683783*T*T
                       - .05481717*RH*RH + .00122874*T*T*RH + .00085282*T*RH*RH - .00000199*T*T*RH*RH
Low-RH:  if RH < 13 % and 80 <= T <= 112 °F:  HI -= [(13-RH)/4] * SQRT{[17-ABS(T-95.)]/17}
High-RH: if RH > 85 % and 80 <= T <= 87 °F:   HI += [(RH-85)/10] * [(87-T)/5]
```

- T is in °F and RH in %. For °C, use `T_F = 1.8·T_C + 32` and `HI_C = (HI_F − 32)/1.8`. Do not round intermediate values.
- Text quoted: "In practice, the simple formula is computed first and the result averaged with the temperature." The 0.5
  factor in the printed simple formula *is* that averaging. **Do not average a second time.**
- **Threshold edge case:** the equation page says "80 degrees F or higher". The WPC calculator JavaScript uses
  `if (hifinal > 79.0)` (and `RH <= 13`).
  - The engine uses the text rule (≥ 80).
  - Fixture `hi_nws_threshold_variant_78F_86`: T = 78, RH = 86 gives 79.542 (text rule) or 80.426 (JS rule).
- The calculator returns HI = T for T ≤ 40 °F. The calculator's °C path averages the °C temperature into the simple formula,
  which is a bug. Do not copy either behaviour.
- "The Rothfusz regression is not valid for extreme temperature and relative humidity conditions beyond the range of data
  considered by Steadman."
- Low-RH adjustment magnitude: up to 3.25 °F (1.81 °C) at T = 95 °F and RH = 0. It is zero at T = 112 °F, so there is no
  discontinuity at 112 → 113 °F.
- NWS classification (weather.gov, [P]): Caution 80–90 °F; Extreme Caution 90–103; Danger 103–124; Extreme Danger ≥ 125.
- **pythermalcomfort `heat_index_rothfusz` (v4.8.1, source read):**
  - It is the same polynomial with °C coefficients rounded to about 7 significant figures. Over 27–50 °C × 0–100 % RH it
    equals the bare °F polynomial converted to °C within **1.4 × 10⁻⁵ °C**.
  - It has **no adjustments and no simple-formula branch**, and returns NaN for t_db < 27 °C.
  - Its categories are 27 / 32 / 41 / 54 °C, the *older* NWS bands. 41 °C = 105.8 °F, against today's Danger threshold of
    103 °F.
  - The oracle asserts equality within 2e-5 °C.
  - The full NWS result minus pythermalcomfort spans **−1.81 °C** (35 °C, RH 0 %: low-RH adjustment) to **+1.07 °C**
    (27 °C, RH 100 %: high-RH adjustment). Examples: −0.21 °C at 42 °C / 10 %, and +0.26 °C at 28 °C / 90 %.
- **Cross-check against the NOAA chart** printed in NIOSH App C (135 cells, transcribed in the oracle):
  - The bare Rothfusz polynomial rounds to the chart within ±1 °F in **135/135** cells (exact in 129).
  - The full NWS algorithm is within ±1 °F in 133/135 cells. The exceptions are 80 °F / 95 % and 80 °F / 100 % RH, where the
    high-RH adjustment adds 1.4–2.1 °F that the chart omits.
  - Also note that the chart's °C labels contain five typos:
    - in the body: "130(50)" should read 130(54), "112(46)" should read 112(44), and "108(43)" should read 108(42);
    - in the column header: "92(34)" should read 92(33), and "110(47)" should read 110(43).

    The °F values, which the oracle uses, are unaffected. [corrected by fact-check: only the first typo was listed.]
- Abu Dhabi-type values (oracle):

  | Air temperature / RH | HI °C | HI °F | NWS category | OSHA level |
  |---|---|---|---|---|
  | 45 °C / 15 % | 44.45 | 112.0 | Danger | High |
  | 40 °C / 45 % | 51.34 | 124.4 | Danger | Very high/extreme |
  | 33 °C / 75 % | 45.72 | 114.3 | Danger | High |

---

## 9. Oracle and fixtures

Run with `python scripts/oracles/limits_oracle.py`, using the project venv (Python 3.12.10, numpy 2.5.4, pythermalcomfort 4.8.1).

It writes `fixtures/limits.json` with these top-level keys: `schema_version`, `units`, `conventions`, `constants` (all tables
below), `summary`, `checks` (71, all must be `pass: true`), and `vectors` (184).

Each vector has the form `{id, group, fn, inputs, expected, tol, source, note}`.

| group | n | What it pins |
|---|---|---|
| niosh_ral_rel | 16 | RAL/REL at 12 rates, plus 4 ASSP-published answers |
| acgih_screening_table | 16 | each Table 2 cell: M_TWA, raw TLV/AL, rounded value, published value, `screeningAvailable` |
| allowed_work_fraction | 8 | the bisection solver |
| twa, metabolic_scaling, units | 6 | ISO Formula (4), body mass / 70 kg, kcal/h → W |
| clothing | 5 | WBGT_eff and the resulting ACGIH screening row |
| work_capacity_pythermalcomfort | 16 | `work_capacity_niosh` and `work_capacity_iso` (reference only) |
| heat_index_nws | 24 | °F and °C inputs, every branch, threshold variant, pythermalcomfort comparison |
| heat_index_chart_crosscheck | 8 | NOAA chart cells |
| osha_table2_reference | 4 | OSHA whole-degree table against the equations |
| tbmed507 | 25 | category boundaries (°F and °C), table lookups with litres |
| hydration | 1 | caps in litres |
| osha_hi_risk | 9 | risk-level boundaries |
| osha_nprm | 10 | heat-index and WBGT(M) triggers |
| acclimatization | 36 | 6 schedules × days 1, 2, 3, 4, 5, 7 |

Tolerances: closed forms 1e-9; the bisection solver 1e-6; published 2-dp answers 0.005; categorical results exact.

---

## 10. Uncertainties and UNVERIFIED items (what was tried)

1. **ACGIH 2026 additions (CAV −1 for short sleeves, +1 hood).** These are seen only in the CCOHS reproduction of the 2026
   booklet. The booklet is paywalled; the Cal/OSHA-hosted text is an older edition without them. The hood +1 is supported by
   Ashley & Bernard 2008 (primary).
2. **ISO 7243:2017 Annex A Table A.1 values.** These come from a secondary source (Brimicombe et al. 2024). Annex E (metabolic
   table) and Annex F (CAVs) are not verified. Only the official preview (clauses 1–9) was read. A full copy hosted by a
   third-party institution was deliberately not used.
3. **ISO 8996:2021 Table A.1 numeric ranges.** These are not verified. The 2004 Table A.2 values come from Foster et al. 2020
   (secondary). The 2021 foreword confirms the switch to watts and the five classes.
4. **Current OSHA-NIOSH Heat Safety Tool labels.** OSHA app and guide pages returned 404 or 403 to automated fetching. The
   levels given are those in NIOSH 2016 Table C-1, adapted from OSHA 2012. OSHA's per-level text ("Using the Heat Index:
   A Guide for Employers", for example water quantities) was not retrieved.
5. **NIOSH 2016 Table 1-1** is referenced in the text but absent from the published PDF. The OSHA *Heat Hazard Recognition*
   workload table is used instead. It has no source line, but its values equal ACGIH Table 3: 115 / 180 / 300 / 415 / 520 W.
6. **The NIOSH figures disagree with the NIOSH equations** (§1.2). This is a [D] finding from the vector artwork. The
   equations are authoritative in the text.
7. **OSHA NPRM.** The method for determining M under the WBGT trigger, and any preamble tables, were not reviewed. The
   supplemental NPRM (agenda date 12/2026) may change triggers or breaks.
8. **NEP re-issue date (10 April 2026).** This comes from a law-firm summary (Littler). The OSHA directive PDF was not
   re-fetched. [Resolved by fact-check against the primary directive CPL 03-00-024 (signature and effective date
   April 10, 2026):
   - it is "operative for no more than five years from the effective date";
   - "A heat priority day occurs when the heat index for the day is expected to be 80°F or more";
   - "programmed inspections shall occur on any day that the NWS has announced a heat warning or advisory for the local
     area".]
9. **The ACGIH equations themselves** are not printed in the booklet text (Figure 2 only). Equality with NIOSH is established
   by ASSP 2022 and by exact reproduction of Table 2. The ACGIH Documentation was not accessed.

---

## 10b. Sources

**Primary sources (read):**
- NIOSH (2016). *Criteria for a Recommended Standard: Occupational Exposure to Heat and Hot Environments.* DHHS (NIOSH)
  Pub. 2016-106. https://www.cdc.gov/niosh/docs/2016-106/pdfs/2016-106.pdf
- NIOSH (1986). *Criteria for a Recommended Standard: Occupational Exposure to Hot Environments, Revised Criteria 1986*
  (86-113). https://stacks.cdc.gov/view/cdc/11174
- NIOSH (2017). *Heat Stress — Hydration*, Pub. 2017-126. https://stacks.cdc.gov/view/cdc/45851
- ACGIH. *Heat Stress and Heat Strain* TLV text (booklet pp. 211–220, an edition no later than 2016), as posted by Cal/OSHA.
  https://www.dir.ca.gov/dosh/doshreg/Heat-illness-prevention-indoors/heat-tlv.pdf
- ISO 7243:2017 official preview (iTeh): https://cdn.standards.iteh.ai/samples/67188/5a4c5553da5945aa872478c36755cded/ISO-7243-2017.pdf
- ISO 8996:2021 official preview: https://cdn.standards.iteh.ai/samples/74443/186e4b0c383146d49b904be84cac03dd/ISO-8996-2021.pdf
- ISO 8996:2004 official preview: https://cdn.standards.iteh.ai/samples/34251/6e86660ba4c34454a663c07f87194375/ISO-8996-2004.pdf
- HQDA (2022). TB MED 507, *Heat Stress Control and Heat Casualty Management*, 12 April 2022.
  https://www.govinfo.gov/content/pkg/GOVPUB-D101-PURL-gpo216616/pdf/GOVPUB-D101-PURL-gpo216616.pdf
- OSHA (2024). NPRM, *Heat Injury and Illness Prevention in Outdoor and Indoor Work Settings*, 89 FR 70698.
  https://www.govinfo.gov/content/pkg/FR-2024-08-30/pdf/2024-14824.pdf
- reginfo.gov Unified Agenda, RIN 1218-AD39 (XML, run 2026-11-08).
  https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=202510&RIN=1218-AD39
- NWS/WPC. *The Heat Index Equation*: https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
- NWS/WPC. Heat index calculator (JavaScript): https://www.wpc.ncep.noaa.gov/html/heatindex.shtml
- NWS. Heat index categories: https://www.weather.gov/ama/heatindex
- CDC/NIOSH. OSHA-NIOSH Heat Safety Tool page (reviewed 2026-03-03): https://www.cdc.gov/niosh/heat-stress/communication-resources/app.html
- Bernard TE et al. (2005). *JOEH* 2(5):251–6 (PMID 15804982).
- Bernard TE et al. (2008). *JOEH* 5(1):1–5 (PMID 17999329).
- Ashley CD & Bernard TE (2008). *JOEH* 5(1):59–62 (PMID 18041645).
- Tustin AW et al. (2018). *MMWR* 67(26):733–737 (PMC6048976).

**Secondary sources:**
- CCOHS, *Hot Environments – Assessment and Control Measures* (reproduces ACGIH 2026 Tables 1 and 2).
  https://www.ccohs.ca/oshanswers/phys_agents/heat/heat_control.html
- LBNL ES&H Manual, Chapter 40 (reproduces ACGIH 2016 Table 2). https://ehs.lbl.gov/resource/esh-manual-pub-3000/ch40/
- ASSP *Professional Safety*, Aug 2022, Math Toolbox (TLV/AL equations; ACGIH 2021 Tables 1–3).
  https://www.assp.org/docs/default-source/psj-articles/mt_0822.pdf
- OSHA, *Heat Hazard Recognition*: https://www.osha.gov/heat-exposure/hazards
- OSHA Technical Manual Sec. III Ch. 4 (current, revised 2017-09-15): https://www.osha.gov/otm/section-3-health-hazards/chapter-4
- OSHA Technical Manual Sec. III Ch. 4, pre-2017 version, archived 2015 (legacy ACGIH 1992 tables).
- Brimicombe C et al. (2024). *Int J Biometeorol*, doi:10.1007/s00484-024-02783-6 (ISO 7243:2017 Table A.1).
- Parsons K (2006). *Ind Health* 44:368–379 (ISO 7243:1989 table and weighting).
- Foster J, Hodder SG, Lloyd AB, Havenith G (2020). *Front Physiol* 11:541483 (ISO 8996:2004 Table A.2).
- Bröde P et al. (2018). *Int J Biometeorol* 62:331–345 (pythermalcomfort work-capacity functions).
- Littler (2026-04-16), *OSHA Updates and Extends its Heat Program for Five More Years*.
  https://www.littler.com/news-analysis/asap/osha-updates-and-extends-its-heat-program-five-more-years

---

## 11. Port-ready constants (TypeScript)

```ts
// ===== src/engine/limits.ts — constants (basis strings in comments) =====

/** NIOSH 2016-106 §8.1 (= ACGIH AL/TLV = ISO 7243:2017 Annex A). WBGT_eff limit [°C] = a − b·log10(M_W). */
export const NIOSH_LIMITS = {
  ral: { a: 59.9, b: 14.1 }, // unacclimatised (Recommended Alert Limit / ACGIH Action Limit)
  rel: { a: 56.7, b: 11.5 }, // acclimatised  (Recommended Exposure Limit / ACGIH TLV)
} as const;
export const REST_METABOLIC_W = 115;          // ACGIH Table 2 basis (pythermalcomfort uses 117)
export const MIN_METABOLIC_W = 115;           // clamp: M_eff = max(M, 115)
export const MAX_PLOTTED_METABOLIC_W = 600;   // ACGIH Fig 2 x-axis end (NIOSH figs end at 580 W)

/** ACGIH TLV Table 3 representative rates [W], 70 kg worker. Body-mass scaling: M × massKg / 70. */
export const ACGIH_METABOLIC_W = { rest: 115, light: 180, moderate: 300, heavy: 415, veryHeavy: 520 } as const;

/** ACGIH TLV Table 2 screening criteria [°C WBGT_eff]; null = "not recommended" (blank in booklet). */
export const ACGIH_SCREENING_ROWS = [
  { allocation: '75-100', workFraction: 1.0 },
  { allocation: '50-75',  workFraction: 0.75 },
  { allocation: '25-50',  workFraction: 0.5 },
  { allocation: '0-25',   workFraction: 0.25 },
] as const;
export const ACGIH_SCREENING_C = {
  tlv: {                 // acclimatised
    '75-100': { light: 31.0, moderate: 28.0, heavy: null, veryHeavy: null },
    '50-75':  { light: 31.0, moderate: 29.0, heavy: 27.5, veryHeavy: null },
    '25-50':  { light: 32.0, moderate: 30.0, heavy: 29.0, veryHeavy: 28.0 },
    '0-25':   { light: 32.5, moderate: 31.5, heavy: 30.5, veryHeavy: 30.0 },
  },
  actionLimit: {         // unacclimatised
    '75-100': { light: 28.0, moderate: 25.0, heavy: null, veryHeavy: null },
    '50-75':  { light: 28.5, moderate: 26.0, heavy: 24.0, veryHeavy: null },
    '25-50':  { light: 29.5, moderate: 27.0, heavy: 25.5, veryHeavy: 24.5 },
    '0-25':   { light: 30.0, moderate: 29.0, heavy: 28.0, veryHeavy: 27.0 },
  },
} as const;

/** Clothing adjustment values [°C] added to WBGT (ACGIH 2026 Table 1 via CCOHS). Not additive; not for Level A. */
export const CLOTHING_CAV_C = {
  shortSleevesPantsWoven: -1,           // 2026 only (secondary)
  workClothesLongSleeves: 0,
  clothCoveralls: 0,
  smsPolypropyleneCoveralls: 0.5,
  polyolefinCoveralls: 1,
  doubleLayerWoven: 3,
  limitedUseVapourBarrierCoveralls: 11,
} as const;
export const HOOD_ADDITION_C = 1;       // ACGIH 2026; Ashley & Bernard 2008
/** NIOSH 2016 §3.3 alternative: lower the RAL/REL (not additive with CAVs). */
export const NIOSH_LIMIT_CORRECTION_C = { twoLayer: -2, partiallyImpermeableOrAprons: -4 } as const;

/** ISO 8996:2004 Table A.2 (secondary). W at 1.8 m². ISO 8996:2021 is in W; numeric 2021 ranges unverified. */
export const ISO8996_2004_CLASSES = [
  { cls: 0, name: 'resting',  meanWm2: 65,  rangeWm2: [55, 70],   meanW: 115, rangeW: [100, 125] },
  { cls: 1, name: 'low',      meanWm2: 100, rangeWm2: [70, 130],  meanW: 180, rangeW: [125, 235] },
  { cls: 2, name: 'moderate', meanWm2: 165, rangeWm2: [130, 200], meanW: 295, rangeW: [235, 360] },
  { cls: 3, name: 'high',     meanWm2: 230, rangeWm2: [200, 260], meanW: 415, rangeW: [360, 465] },
  { cls: 4, name: 'veryHigh', meanWm2: 290, rangeWm2: [260, Infinity], meanW: 520, rangeW: [465, Infinity] },
] as const;
export const STANDARD_BSA_M2 = { male70kg175cm: 1.8, female60kg170cm: 1.6 } as const; // ISO 8996:2004
// DuBois: A = 0.202 * kg^0.425 * m^0.725

/** TB MED 507 (12 Apr 2022). Category lower bounds in °F (half-open); convert °C→°F exactly first. */
export const TBMED507_CAT_LOWER_F = { 1: 78, 2: 82, 3: 85, 4: 88, 5: 90 } as const; // 0 if < 78
export const TBMED507_WORK_W = { easy: 250, moderate: 425, heavy: 600, veryHeavy: 800 } as const;
/** Table 3-2: [workMin, restMin] per hour (null = no limit, up to 4 continuous h) and water qt/h. */
export const TBMED507_T32 = {
  1: { easy: [null, 0.5],  moderate: [null, 0.75],     heavy: [[40, 20], 0.75], veryHeavy: [[20, 40], 1] },
  2: { easy: [null, 0.5],  moderate: [null, 0.75],     heavy: [[30, 30], 1],    veryHeavy: [[15, 45], 1] },
  3: { easy: [null, 0.75], moderate: [null, 0.75],     heavy: [[30, 30], 1],    veryHeavy: [[10, 50], 1] },
  4: { easy: [null, 0.75], moderate: [[50, 10], 0.75], heavy: [[20, 40], 1],    veryHeavy: [[10, 50], 1] },
  5: { easy: [null, 1],    moderate: [[20, 40], 1],    heavy: [[15, 45], 1],    veryHeavy: [[10, 50], 1] },
} as const;
/** Table 3-3: continuous work limit [min] (null = no limit) and water qt/h. */
export const TBMED507_T33 = {
  1: { easy: [null, 0.5],  moderate: [null, 0.75], heavy: [110, 0.75], veryHeavy: [45, 0.75] },
  2: { easy: [null, 0.5],  moderate: [null, 1],    heavy: [70, 1],     veryHeavy: [40, 1] },
  3: { easy: [null, 0.75], moderate: [null, 1],    heavy: [60, 1],     veryHeavy: [25, 1] },
  4: { easy: [null, 0.75], moderate: [180, 1.25],  heavy: [50, 1.25],  veryHeavy: [20, 1.25] },
  5: { easy: [null, 1],    moderate: [70, 1.5],    heavy: [45, 1.5],   veryHeavy: [20, 1.5] },
} as const;
export const TBMED507_PROTECTIVE_CLOTHING_ADD_F = { easy: 10, moderateOrHeavy: 20 } as const; // CBRN/JSLIST
export const TBMED507_WATER_VARIATION_QT_PER_H = 0.25; // ± individual; ± sun/shade

/** Hydration (NIOSH 2016 §1.7.3; NIOSH 2017-126; TB MED 507 Tables 3-2/3-6). */
export const HYDRATION = {
  cupMl: 236.5882365,                 // 8 US fl oz
  cupIntervalMin: [15, 20],           // "1 cup … every 15–20 minutes"
  typicalLPerH: [0.7097647, 0.9463529], // ¾–1 qt (24–32 oz) per hour
  maxLPerH: 1.4195294,                // 1½ qt = 48 oz (NIOSH fact sheet; TB MED 507)
  maxLPerDay: 11.356235,              // 12 qt (TB MED 507; NIOSH Table 8-1 footnote)
  waterMaxTempC: 15,                  // NIOSH: cool water < 15 °C (59 °F); TB MED: 50–60 °F
  electrolyteDrinkAfterH: 2,          // NIOSH: sweating > 2 h → sports drink, ≤ 8 % electrolytes/carbohydrate
  oshaNprmWaterLPerEmployeeH: 0.946352946, // 1 qt/employee/hour (proposed 1910.148(e)(2))
  hyponatremiaSodiumMmolL: 135,       // < 135 mmol/L (NIOSH §4.1.4; TB MED 507 §3-7h)
} as const;
export const US_QUART_L = 0.946352946;
export const US_FL_OZ_ML = 29.5735295625;
export const KCAL_PER_H_TO_W = 1.163; // 4186.8/3600 (NIOSH text rounds to 1.16)

/** Acclimatisation: max fraction of usual exposure duration by day (1-based); beyond end → 1.0. */
export const ACCLIMATIZATION_SCHEDULES = {
  nioshNewWorker: [0.2, 0.4, 0.6, 0.8, 1.0],        // ≤20 % day 1, ≤+20 %/day; 7–14 days overall
  nioshExperienced: [0.5, 0.6, 0.8, 1.0],
  mshaNewMiner: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  mshaReturningAfter9Days: [0.5, 0.6, 0.9, 1.0],
  oshaNprmNew: [0.2, 0.4, 0.6, 0.8, 1.0],           // option (B), first week
  oshaNprmReturningOver14Days: [0.5, 0.6, 0.8, 1.0],// option (B)
} as const;
export const ACCLIMATIZATION_FACTS = {
  acgihAcclimatizedDefinition: { minContinuousH: 2, examples: ['5 of last 7 days', '10 of 14 days'] },
  acgihNoticeableLossAfterDays: 4, acgihCompleteLossWeeks: [3, 4],
  nioshSignificantLossAfterDays: 7, nioshRegainDays: [2, 3], nioshMinDailyExposureH: 2,
  nioshUnfitExtraTimeFraction: 0.5, tbmedRetainedDays: 7, tbmedLostWithinDays: 30, tbmedOptimalDays: 10,
  // Zill engineering rule [D]: absence ≥4 d → experienced schedule; ≥21 d or unknown → new-worker schedule; RAL meanwhile.
} as const;

/** ACGIH TLV Table 4 — discontinue exposure if any is met. */
export const HEAT_STRAIN_LIMITS = {
  sustainedHrBpm: (ageYears: number) => 180 - ageYears, // "several minutes", normal cardiac performance
  coreTempSelectedAcclimatizedC: 38.5,
  coreTempUnselectedUnacclimatizedC: 38.0,
  recoveryHr1MinBpm: 120,             // > 120 bpm one minute after peak effort
  symptoms: ['sudden severe fatigue', 'nausea', 'dizziness', 'lightheadedness'],
  greaterRisk: { shiftWeightLossPct: 1.5, urinarySodium24hMmol: 50, profuseSweatingHours: true },
  heatStrokeCoreC: 40.0,
  pregnancyFirstTrimesterSustainedCoreC: 39.0,
  tlvGoalCoreRiseC: 1.0,              // within +1 °C of 37 °C
} as const;
/** NIOSH 2016 §9.4.1 Brouha / Fuller & Smith (P1 = 30 s–1 min, P3 = 2.5–3 min seated recovery). */
export const RECOVERY_HR = { oralTempC: 37.5, p1MaxBpm: 110, p1MinusP3MinBpm: 10, p3SatisfactoryBpm: 90 } as const;

/** NIOSH 2016 Heat Alert Program trigger (§6.2.6(1)(d)). */
export const HEAT_ALERT = { forecastMaxC: 35, altForecastMaxC: 32, altRiseOverPrecedingC: 5, precedingDays: 3 } as const;

/** NWS heat index (°F, %RH). */
export const NWS_HI = {
  simple: { c: 0.5, t0: 61.0, tRef: 68.0, tGain: 1.2, rh: 0.094 }, // HI_s = 0.5*(T+61+(T−68)*1.2+RH*0.094)
  regressionThresholdF: 80,                                       // use regression if HI_s >= 80 (JS: > 79)
  rothfusz: [-42.379, 2.04901523, 10.14333127, -0.22475541, -0.00683783,
             -0.05481717, 0.00122874, 0.00085282, -0.00000199],    // 1,T,RH,T·RH,T²,RH²,T²RH,T·RH²,T²RH²
  lowRh:  { rhBelow: 13, tMinF: 80, tMaxF: 112 },  // subtract ((13−RH)/4)*sqrt((17−|T−95|)/17)
  highRh: { rhAbove: 85, tMinF: 80, tMaxF: 87 },   // add ((RH−85)/10)*((87−T)/5)
  categoriesF: { caution: 80, extremeCaution: 90, danger: 103, extremeDanger: 125 },
  fullSunAddUpToF: 15,                              // statement (NWS, NIOSH App C), not part of the formula
} as const;

/** OSHA heat-index risk levels (NIOSH 2016 Table C-1): <91 lower; [91,103) moderate; [103,115] high; >115 very high. */
export const OSHA_HI_RISK_F = { moderateFrom: 91, highFrom: 103, veryHighAbove: 115 } as const;

/** OSHA NPRM 89 FR 70698 (proposed; NOT in force; supplemental NPRM scheduled 12/2026). */
export const OSHA_NPRM = {
  initialTriggerHiF: 80, highTriggerHiF: 90,        // or WBGT ≥ RAL(M) / ≥ REL(M); "at or above"
  restBreak: { minMin: 15, everyMin: 120, paid: true },
  maxObservedPerSupervisor: 20, loneWorkerContactEveryMin: 120,
  shortExposureExemptMinPer60: 15, acExemptBelowF: 80, fanEvaluationAboveF: 102, warningSignIndoorAboveF: 120,
  returningAbsenceDays: 14,
} as const;
```

**Reference algorithms** (port these; the oracle has vectors for each):

```ts
/** Pure equations (fixture group niosh_ral_rel tests these unclamped, e.g. M = 100 W → RAL 31.70). */
export const ralC = (mW: number) => NIOSH_LIMITS.ral.a - NIOSH_LIMITS.ral.b * Math.log10(mW);
export const relC = (mW: number) => NIOSH_LIMITS.rel.a - NIOSH_LIMITS.rel.b * Math.log10(mW);
/** Engine policy: limit for a worker = equation at max(M, 115 W); RAL unless acclimatised (fail-safe). */
export const limitC = (mW: number, acclimatized: boolean) =>
  (acclimatized ? relC : ralC)(Math.max(mW, MIN_METABOLIC_W));

/** ISO 7243 Formula (4): Σ p_i t_i / Σ t_i (T ≈ 60 min). */
export function twa(values: number[], minutes: number[]): number { /* throw if lengths differ or Σt ≤ 0 */ }

/** Largest f∈[0,1] with Limit(f·Mw+(1−f)·Mr) ≥ f·Ww+(1−f)·Wr. g is convex → unique root; bisection 50 iters, return lo. */
export function allowedWorkFraction(wWorkC: number, wRestC: number, mWorkW: number, acclimatized: boolean,
                                    mRestW = REST_METABOLIC_W): { f: number; marginAtFullWorkC: number } {
  const lim = acclimatized ? relC : ralC;
  const g = (f: number) => lim(f * mWorkW + (1 - f) * mRestW) - (f * wWorkC + (1 - f) * wRestC);
  const g1 = g(1);
  if (g1 >= 0) return { f: 1, marginAtFullWorkC: g1 };
  if (g(0) < 0) return { f: 0, marginAtFullWorkC: g1 };
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (g(mid) >= 0) lo = mid; else hi = mid; }
  return { f: lo, marginAtFullWorkC: g1 };
}

/** ACGIH Table 2 cell construction (for tests): round(lim(f·M + (1−f)·115) to nearest 0.5, half-up). */
export const roundHalfUpToHalf = (x: number) => Math.floor(x * 2 + 0.5) / 2;

/** NWS heat index, °F in/out (text threshold rule). */
export function heatIndexNwsF(tF: number, rh: number): number {
  const s = 0.5 * (tF + 61.0 + (tF - 68.0) * 1.2 + rh * 0.094);
  if (s < 80) return s;
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = NWS_HI.rothfusz;
  let hi = c1 + c2 * tF + c3 * rh + c4 * tF * rh + c5 * tF * tF + c6 * rh * rh
         + c7 * tF * tF * rh + c8 * tF * rh * rh + c9 * tF * tF * rh * rh;
  if (rh < 13 && tF >= 80 && tF <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tF - 95)) / 17);
  else if (rh > 85 && tF >= 80 && tF <= 87) hi += ((rh - 85) / 10) * ((87 - tF) / 5);
  return hi;
}
export const tbmed507Category = (wbgtF: number) =>
  wbgtF >= 90 ? 5 : wbgtF >= 88 ? 4 : wbgtF >= 85 ? 3 : wbgtF >= 82 ? 2 : wbgtF >= 78 ? 1 : 0;
export const oshaHiRisk = (hiF: number) =>
  hiF > 115 ? 'veryHighToExtreme' : hiF >= 103 ? 'high' : hiF >= 91 ? 'moderate' : 'lowerCaution';
export const oshaNprmTriggerHi = (hiF: number) => (hiF >= 90 ? 'high' : hiF >= 80 ? 'initial' : 'none');
```


---

## Independent verification (fact-check)

**Date:** 2026-11-09. **Scope:** every numeric threshold, equation, table value, date, penalty and regulatory requirement
above.

### How the check was done

**Sources.** Every source was located and read again from scratch; the document's own citations were not relied on.
- PDFs were downloaded and their text extracted: NIOSH 2016-106, NIOSH 86-113, NIOSH 2017-126, the Cal/OSHA copy of the
  ACGIH TLV, TB MED 507 (2022), the OSHA NPRM, the 2026 OSHA heat NEP directive, the ISO 7243:2017 / 8996:2021 /
  8996:2004 previews, ASSP 2022 and Parsons 2006.
- Tables were checked cell by cell on rendered page images: ACGIH Table 2, TB MED 507 Tables 3-2 and 3-3 and Fig. 3-3,
  and NIOSH Tables 3-2, 4-1, 5-1, 6-2, 6-3, 8-1 and 8-2.
- The rest was read from HTML or APIs: the WPC page and calculator JavaScript, NWS, CDC, CCOHS, LBNL, the OSHA pages,
  reginfo.gov, the Federal Register API, PubMed (E-utilities), PMC (Tustin 2018, Brimicombe 2024) and Frontiers
  (Foster 2020).

**Independent recomputation.** A standalone script was written from scratch. It does not import the oracle.
- It uses its own RAL/REL, heat-index and TB MED code, and `scipy.optimize.brentq` instead of bisection for the
  allowed work fraction.
- It recomputed every number printed in this document and every one of the 184 vectors in `fixtures/limits.json` from
  their inputs.
- It parsed the NOAA chart in NIOSH App. C directly from the PDF text.
- Result: **749 / 749 checks passed**.

**Oracle re-run.** `python scripts/oracles/limits_oracle.py` was re-run in the project venv. It reported "184 vectors,
71 checks passed". The regenerated `fixtures/limits.json` is identical to the committed file except for
`generated_utc`. **No fixture or script value was wrong, so the oracle was not changed.**

**Hand spot-checks** (paper arithmetic):
- `ral_rel_300W`: 59.9 − 14.1 × 2.477121 = 24.97259, and 56.7 − 11.5 × 2.477121 = 28.21311.
- `acgih_t2_50-75_heavy`:
  - M = 0.75 × 415 + 0.25 × 115 = 340 W.
  - REL(340) = 27.58799, which rounds to 27.5 (published 27.5).
  - RAL(340) = 24.20615, which rounds to 24.0 (published 24.0).
- `awf_mod_unaccl_sun30_shade28`: at f = 0.2808, M_TWA = 166.95 W, so RAL = 28.5616. The TWA WBGT is
  0.2808 × 30 + 0.7192 × 28 = 28.5616, so g ≈ 0.
- `hi_nws_threshold_variant_78F_86`: simple = 0.5 × (78 + 61 + 12 + 8.084) = 79.542.
- `hi_nws_abudhabi_104F_45`: the nine Rothfusz terms sum to 124.4208 °F.
- `fluid_caps`: 1.5 × 0.946352946 = 1.4195294 L, and 12 × 0.946352946 = 11.356235 L.
- `tbmed_cat_31.1C`: 31.1 °C = 87.98 °F, which is below 88, so CAT 3.
- `wc_iso_30C_300W`: (32.3565 − 30) / (32.3565 − 28.3783) × 100 = 59.235 %.

**Digitisation of NIOSH Figs 8-1 / 8-2** (re-run independently).
- The y-axis was calibrated on the 25–45 °C and 77–113 °F labels. These are exactly collinear, and they place the
  x-axis bar at 20.0 ± 0.05 °C.
- Vector markers and dots were taken from `get_drawings()`. Text-glyph markers were located by the centroid of their
  rendered ink at 1200 dpi. The drawn Bézier curves were also evaluated.

### Summary

- 154 claims checked: 143 CONFIRMED, 7 CORRECTED, 4 UNVERIFIABLE.
- All corrections are marked "[corrected by fact-check]" in the body.
- None of the corrections changes an engine constant or a fixture value.

The 7 corrections:
1. The RAL-figure excess over the equation is about 1.3 °C, not 1.6 °C (§0, §1.2).
2. The sign of the REL TWA-vs-curve range was reversed (§1.2).
3. The RAL TWA-vs-curve range is about 0.3–1.8 °C (§1.2).
4. The ISO 7243 §9.3 quote was missing its qualifier (§4).
5. The ISO 8996 W column is not a strict ×1.8 rounding (§5.2).
6. Forklift operation moved from Light to Moderate (§5).
7. The NOAA chart has five °C typos, not one (§8).

### Sources used (short names in the table)

| Short name | URL |
|---|---|
| NIOSH 2016 | https://www.cdc.gov/niosh/docs/2016-106/pdfs/2016-106.pdf (page numbers = printed pages) |
| NIOSH 1986 | https://stacks.cdc.gov/view/cdc/11174/cdc_11174_DS1.pdf |
| NIOSH 2017-126 | https://www.cdc.gov/niosh/docs/2017-126/pdfs/2017-126.pdf |
| ACGIH (Cal/OSHA) | https://www.dir.ca.gov/dosh/doshreg/Heat-illness-prevention-indoors/heat-tlv.pdf |
| CCOHS | https://www.ccohs.ca/oshanswers/phys_agents/heat/heat_control.html |
| LBNL | https://ehs.lbl.gov/resource/esh-manual-pub-3000/ch40/ |
| ASSP 2022 | https://www.assp.org/docs/default-source/psj-articles/mt_0822.pdf |
| ISO 7243 preview | https://cdn.standards.iteh.ai/samples/67188/5a4c5553da5945aa872478c36755cded/ISO-7243-2017.pdf |
| ISO 8996:2021 preview | https://cdn.standards.iteh.ai/samples/74443/186e4b0c383146d49b904be84cac03dd/ISO-8996-2021.pdf |
| ISO 8996:2004 preview | https://cdn.standards.iteh.ai/samples/34251/6e86660ba4c34454a663c07f87194375/ISO-8996-2004.pdf |
| Foster 2020 | https://www.frontiersin.org/articles/10.3389/fphys.2020.541483/full |
| Brimicombe 2024 | https://pmc.ncbi.nlm.nih.gov/articles/PMC11599290/ |
| Parsons 2006 | https://www.jstage.jst.go.jp/article/indhealth/44/3/44_3_368/_pdf |
| TB MED 507 | https://www.govinfo.gov/content/pkg/GOVPUB-D101-PURL-gpo216616/pdf/GOVPUB-D101-PURL-gpo216616.pdf (printed pages) |
| OSHA NPRM | https://www.govinfo.gov/content/pkg/FR-2024-08-30/pdf/2024-14824.pdf |
| reginfo | https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=202510&RIN=1218-AD39 |
| 90 FR 46110 | https://www.federalregister.gov/documents/2025/09/25/2025-18670 (read via https://www.federalregister.gov/api/v1/documents/2025-18670.json) |
| OSHA NEP 2026 | https://www.osha.gov/sites/default/files/enforcement/directives/CPL_03-00-024_0.pdf |
| Littler | https://www.littler.com/news-analysis/asap/osha-updates-and-extends-its-heat-program-five-more-years |
| OSHA hazards | https://www.osha.gov/heat-exposure/hazards |
| OSHA OTM | https://www.osha.gov/otm/section-3-health-hazards/chapter-4 |
| WPC equation | https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml |
| WPC calculator | https://www.wpc.ncep.noaa.gov/html/heatindex.shtml |
| NWS AMA | https://www.weather.gov/ama/heatindex |
| CDC app page | https://www.cdc.gov/niosh/heat-stress/communication-resources/app.html |
| Tustin 2018 | https://pmc.ncbi.nlm.nih.gov/articles/PMC6048976/ |
| PubMed | https://pubmed.ncbi.nlm.nih.gov/15804982/ , https://pubmed.ncbi.nlm.nih.gov/17999329/ , https://pubmed.ncbi.nlm.nih.gov/18041645/ |
| pythermalcomfort | pythermalcomfort 4.8.1, installed source read (https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort) |

### Claim-by-claim table

| Claim | Verdict | Source URL | Note |
|---|---|---|---|
| §1.1 RAL = 59.9 − 14.1·log10 M; REL = 56.7 − 11.5·log10 M; M in W (§8.1, p. 93) | CONFIRMED | NIOSH 2016 | Verbatim on p. 93. |
| §1.1 Ceiling limits removed (Executive Summary p. vii; §8.1) | CONFIRMED | NIOSH 2016 | Quote verbatim on p. vii; §8.1 (p. 96) repeats the removal. |
| §1.1 1986 ceiling definition (1 °C rise in < 15 min, heat balance equation); no closed-form ceiling equation | CONFIRMED | NIOSH 1986 | Verbatim in Ch. I, Section 1 (PDF p. 13). A text search found no log-form limit equations ("59.9", "56.7", "log"). |
| §1.1 One-layer clothing assumption (§1.1.1); "standard man" 70 kg, 1.8 m²; 1-h TWAs "as described by ACGIH [2014]" | CONFIRMED | NIOSH 2016 | pp. 2, 94–95; Glossary. |
| §1.1 Reference-value table (RAL/REL at 12 rates, 24 numbers) | CONFIRMED | NIOSH 2016 | Recomputed independently; all within ±0.005. |
| §1.1 NIOSH figures span 100–500 kcal/h (116–580 W); ACGIH Fig. 2 spans 100–600 W | CONFIRMED | NIOSH 2016; ACGIH (Cal/OSHA) | Axis labels read on both figures. |
| §1.2 Worked example: 300 kcal/h (348.9 W) → 27.8 °C (82 °F) from Fig. 8-2 and 25 °C (77 °F) from Fig. 8-1; the equations give 27.46 / 24.05 | CONFIRMED | NIOSH 2016 | §1.1.3, p. 4. |
| §1.2 Digitised 60-min marker table and REL partial-hour dots | CONFIRMED (within stated ±0.3 °C) | NIOSH 2016 | Independent values are 0.08–0.11 °C lower for vector markers and dots, and about 0.25 °C lower for glyph markers. The "20" label is offset 0.14 °C. A note was added under the table. |
| §0, §1.2 "NIOSH figures are drawn up to about 1.6 °C above the RAL equation" | CORRECTED | NIOSH 2016 | Max +1.34 °C for the 60-min markers (at 300 kcal/h). The drawn 60-min RAL curve is +0.19 to +1.05 °C above the equation; the 60-min REL curve is within +0.2 °C of its equation. Text now reads "about 1.3 °C". |
| §1.2 "1-h TWA lands within −0.4 to +0.8 °C of the digitised REL curves" | CORRECTED | NIOSH 2016 | The sign was reversed. TWA − curve is −0.82 to +0.37 °C with the document's own dots, and −0.74 to +0.46 °C independently. Text now reads [−0.8, +0.5]. |
| §1.2 "1-h TWA lands 0.4–1.75 °C below the RAL curves" | CORRECTED | NIOSH 2016 | 0.27–1.65 °C below the RAL dots and 0.26–1.80 °C below the drawn curves. Text now reads "about 0.3–1.8 °C". |
| §1.2 1-h TWA REL values at f = 0.75 / 0.5 / 0.25 for 232 / 348 / 464 / 579 W | CONFIRMED | (equations) | All 12 recomputed. |
| §1.2, §1.9 Partial-hour curves are graphical only; §8.1 quote "When working for shorter intervals…" | CONFIRMED | NIOSH 2016 | p. 93. |
| §1.3 §1.1.2 quotes (hourly TWA WBGT including rest; measure at least hourly; two sequential measurements) | CONFIRMED | NIOSH 2016 | p. 3. |
| §1.3 "1 kcal·h-1 = 1.16 W"; exact 4186.8/3600 = 1.163; 300 kcal/h = 348.9 W | CONFIRMED | NIOSH 2016 | p. 4; arithmetic is exact. |
| §1.4 Table 1-1 is referenced but absent from the PDF | CONFIRMED | NIOSH 2016 | A programmatic inventory of every "Table X-Y" string in all 192 pages finds "Table 1-1" only in the referring sentence (p. 4). |
| §1.4 NIOSH points to the Ainsworth et al. 2011 Compendium | CONFIRMED | NIOSH 2016 | p. 4. |
| §1.4 OSHA workload table: 115/180/300/415/520 W, 70-kg footnote, no source line, example activities; neighbouring Table 2 and clothing table say "adapted from NIOSH guidelines (2016)" | CONFIRMED [S] | OSHA hazards | — |
| §1.4 Table 8-1 uses Easy 250 / Moderate 425 / Hard 600 W, "Adapted from DOD [2007]" | CONFIRMED | NIOSH 2016 | p. 104. NIOSH's reference list has no DOD 2007 entry, only DOD [2003] (TB MED 507/AFPAM 48-152(I)). "The older TB MED 507" is plausible but cannot be shown from NIOSH itself. |
| §1.4 Table 5-1 NIOSH column: 30 / 28 / 26 / 25 °C with kcal/h and W ranges | CONFIRMED | NIOSH 2016 | p. 70. The table title is "Comparison of WBGT exposure limits for acclimatized workers". |
| §1.4 §8.5.1 erratum (ACGIH watt values printed as kcal/h) | CONFIRMED | NIOSH 2016 | p. 101. |
| §1.5 Clothing corrections: −2 °C "(3.8°F)" and −4 °C (7.2 °F); 3.8 is a typo for 3.6 | CONFIRMED | NIOSH 2016 | §3.3, p. 16. |
| §1.5 Encapsulating ensembles: use t_adb; physiological monitoring above about 20 °C (68 °F) | CONFIRMED | NIOSH 2016 | p. 16. |
| §1.5 NIOSH Table 3-2 CAFs (previous 0 / 3.5 / 5; 2006 values 0 / 0 / 3 / 0.5 / 1 / 11) | CONFIRMED | NIOSH 2016 | p. 19. The SMS row reads "Spunbound melt-blown synthetic (SMS) coveralls". |
| §1.6 Table 4-1 acclimatisation wording (7–14 days; ≤20 % on day 1 then ≤20 % more per day; 50/60/80/100 %; 50 % longer if unfit; maintenance, one week, 2–3 days, air conditioning) | CONFIRMED | NIOSH 2016 | p. 34. The ≤20 %/day maximum reaches 100 % on day 5, while the plan spans 7–14 days. The TypeScript schedule encodes the maximum. |
| §1.6 Minimum 2 h/day, may be split into 1-h exposures (§4.1.5) | CONFIRMED | NIOSH 2016 | p. 32. |
| §1.6 MSHA schedules (new miner 50→100 % over 6 days; returning after ≥9 consecutive days of leave 50/60/90/100 %) | CONFIRMED | NIOSH 2016 | Table 8-2, p. 105. |
| §1.6, §3.3 ACGIH acclimatisation definition and loss (2 h; 5 of 7 or 10 of 14 days; 4 days; 3–4 weeks) | CONFIRMED | ACGIH (Cal/OSHA) | p. 211, verbatim. |
| §1.6 TB MED: benefits retained about 1 week, lost within 1 month | CONFIRMED | TB MED 507 | Table 2-1, p. 12. |
| §1.6 OSHA NPRM: returning employees away "more than 14 days" | CONFIRMED | OSHA NPRM | (e)(7)(ii). |
| §1.7 §1.7.3(g) quote (< 15 °C [59 °F]; up to 2 h of moderate work; a cup of about 8 oz every 15–20 min; individual cups; sweating > 2 h → sports drinks ≤ 8 % by volume) | CONFIRMED | NIOSH 2016 | pp. 9–10. |
| §1.7 NIOSH 2017-126 quotes (1 cup / 8 oz every 15–20 min; ¾–1 qt [24–32 oz] per h; at most 48 oz [1½ qt] per h; low blood-salt warning; no salt tablets) | CONFIRMED | NIOSH 2017-126 | "DHHS (NIOSH) Publication No. 2017-126". |
| §1.7 Table 8-1 footnote: ≤ 1.5 qt/h; daily intake generally ≤ 12 qt | CONFIRMED | NIOSH 2016 | p. 104. |
| §1.7 Hyponatremia: < 135 mmol/L mild and 120 mmol/L severe (§4.1.4); "< 136 mEq/L" (§9.4.3) is inconsistent | CONFIRMED | NIOSH 2016 | pp. 30, 118. The < 136 mEq/L figure also appears in §4.2.3 (p. 57). |
| §1.7 Hyponatremia risk factors (> 4 h, female sex, low body mass, > 1.5 L/h water, NSAIDs, extreme heat) | CONFIRMED | NIOSH 2016 | p. 30. The source also lists "pre-exercise hydration", which this document omits. |
| §1.7 Dehydration: tolerance falls beyond 1.5–2 %; > 5 % may lead to collapse; sweat 6–8 L per workday | CONFIRMED | NIOSH 2016 | §9.4.3, p. 118. |
| §1.7 Conversions: 236.6 mL; 0.710–0.946 L; 1.4195 L | CONFIRMED | (arithmetic, 1 US qt = 0.946352946 L) | — |
| §1.8 Heat-alert trigger: §1.7.4 and §6.2.6(1)(d) (35 °C [95 °F]; or 32 °C [90 °F] and 5 °C [9 °F] above any of the preceding 3 days) | CONFIRMED | NIOSH 2016 | pp. 10, 81. |
| §1.8 Heat Alert Committee members, tasks (a)–(d), and the 11 actions (a)–(k) during an alert | CONFIRMED | NIOSH 2016 | §6.2.6, pp. 80–81. |
| §1.9 Table 6-2: all rows, sun/cloud/RH adjustments, assumptions, "Caution" footnote, EPA 1993 | CONFIRMED | NIOSH 2016 | p. 76, checked cell by cell. |
| §1.9 Table 6-3: 5 temperatures × 9 columns; Tyvek, gloves, boots, respirator; acclimatised workers | CONFIRMED | NIOSH 2016 | p. 77, checked cell by cell. |
| §1.10 Table 9-1: sustained HR > 180 bpm minus age | CONFIRMED | NIOSH 2016 | p. 120. |
| §1.10 Brouha P1/P2/P3 timing; oral > 37.5 °C, P1 > 110 bpm, P1 − P3 < 10 bpm | CONFIRMED | NIOSH 2016 | §9.4.1, p. 116. |
| §1.10 Fuller & Smith: P3 ≤ 90; P3 ≈ 90 with P1 − P3 ≈ 10; P3 > 90 with P1 − P3 < 10 | CONFIRMED | NIOSH 2016 | p. 116. |
| §1.10 WHO: deep body 38 °C (oral 37.5 °C); oral reads about 0.55 °C (0.8 °F) lower | CONFIRMED | NIOSH 2016 | §9.4.2, pp. 116–117. |
| §1.10 Thermal Work Limit: core < 38.2 °C, sweat < 1.2 kg/h | CONFIRMED | NIOSH 2016 | p. 75. |
| §1.10 Moran 2007 heat tolerance test: intolerant if T_re > 38.5 °C or HR > 145 bpm after 120 min at 40 °C, 40 % RH | CONFIRMED | NIOSH 2016 | p. 80. |
| §3 Cal/OSHA copy: booklet pp. 211–220, scan dated 2017-01-19, cites ISO 7933:2004 | CONFIRMED | ACGIH (Cal/OSHA) | PDF CreationDate is 2017-01-19. |
| §3 CCOHS reproduces ACGIH 2026 (CAV p. 239, screening p. 242); LBNL reproduces the 2016 Table 2; ASSP reproduces the 2021 Table 3 | CONFIRMED [S] | CCOHS; LBNL; ASSP 2022 | — |
| §3.1 The booklet gives TLV/AL only as Figure 2, with no equation in the text | CONFIRMED | ACGIH (Cal/OSHA) | p. 213. |
| §3.1 ASSP: TLV = 56.7 − 11.5·log10M and AL = 59.9 − 14.1·log10M, "identical" to NIOSH and the ISO WBGTref | CONFIRMED [S] | ASSP 2022 | — |
| §3.1 AL "should be considered" wording; TLV goal "within +1°C of normal (37°C)" | CONFIRMED | ACGIH (Cal/OSHA) | p. 211. |
| §3.2 Decision logic (Figure 1) | CONFIRMED | ACGIH (Cal/OSHA) | The paraphrase is faithful. The booklet's first question reads "air or water vapor movement". |
| §3.4 2026 CAV table (−1 / 0 / 0 / 0.5 / 1 / 3 / 11; hood +1) and its four notes | CONFIRMED [S] | CCOHS | Verbatim, including "There is no evidence to suggest that respirators or face coverings add to the heat stress burden". |
| §3.4 Older edition: six rows, and the note wording | CONFIRMED | ACGIH (Cal/OSHA) | Table 1, p. 214. |
| §3.4 Bernard 2005: 0 / +1 / +2 / +10; only the vapour barrier interacts with humidity | CONFIRMED | PubMed | PMID 15804982. |
| §3.4 Bernard 2008: CAF independent of metabolic rate; Tychem QC measured 7.5, 10 kept for humidity | CONFIRMED | PubMed | PMID 17999329. |
| §3.4 Ashley & Bernard 2008: hood +1 °C; flame-retardant coveralls 0 °C | CONFIRMED | PubMed | PMID 18041645. |
| §3.5 Table 2: 24 published cells and 8 blanks | CONFIRMED | ACGIH (Cal/OSHA); CCOHS; LBNL | p. 215, checked on the rendered scan. The three sources are identical. |
| §3.5 Table 2 notes (nearest 0.5 °C; rest 115 W; mid-range rate; upper limit of range; TWA; 8-h day, 5-day week; Very Heavy not recommended; not for prescribing work and recovery) | CONFIRMED | ACGIH (Cal/OSHA) | p. 215, verbatim. |
| §3.5 Construction rule reproduces all 24 cells; raw-value table (32 numbers) | CONFIRMED | (independent recomputation) | No raw value is within 0.001 °C of a rounding tie, so the rounding mode does not matter. |
| §3.5 CCOHS examples: 27.0 °C, unacclimatised, moderate → 25–50 %; 28 + 3 = 31 → 0–25 %; 33 → above all values | CONFIRMED [S] | CCOHS | The 26.75 °C TWA example was recomputed (CCOHS prints only the inputs as text). |
| §3.6 Root is unique (g is convex) and the bisection invariant holds | CONFIRMED | (mathematics) | If g(0) ≥ 0 > g(1) and g is convex, then g < 0 beyond the first root. |
| §3.6 Example table: 8 cases (f, min/h, margin 1.21 °C) | CONFIRMED | (independent brentq) | f agrees to within 5e-5. |
| §3.7 Table 3: 115/180/300/415/520 W, examples, body-weight footnote | CONFIRMED | ACGIH (Cal/OSHA); ASSP 2022 | p. 216. |
| §3.7 ASSP answers: 282.86 W, 515.79 W; TLV(270) = 28.74, TLV(481) = 25.86, AL(270) = 25.62, AL(115) = 30.84 | CONFIRMED [S] | ASSP 2022 | Recomputed. |
| §3.8 Table 4: 180 − age; > 38.5 °C (101.3 °F) for selected acclimatised workers; > 38 °C (100.4 °F) unselected; recovery HR > 120 bpm; symptoms; > 1.5 % weight loss; < 50 mmol urinary Na per 24 h | CONFIRMED | ACGIH (Cal/OSHA) | p. 218, verbatim. |
| §3.8 Emergency response; heat stroke > 40 °C (104 °F); first trimester sustained core > 39 °C | CONFIRMED | ACGIH (Cal/OSHA) | pp. 218, 220. |
| §3.9 Table 5 items (about 1 cup about every 20 min; returning workers; pre-placement screening; programme triggers) | CONFIRMED | ACGIH (Cal/OSHA) | pp. 218–219. |
| §3.10 Legacy TLV table (30.0 / 26.7 / 25.0 … 32.2 / 31.1 / 30.0) | CONFIRMED [S] | Parsons 2006 | Table 6 is labelled "From ACGIH (1996)". The 2015 OTM archive could not be fetched (web.archive.org is blocked for the fetch tool), so the "ACGIH 1992" label was not checked; the values are identical. |
| §3.10 Legacy corrections subtracted from the limit: cotton coveralls −2, winter clothing −4, water barrier −6 | CONFIRMED [S] | Parsons 2006 | p. 375. |
| §3.10 Current OTM chapter "Updated: September 15, 2017"; no ACGIH tables; copyright statement | CONFIRMED | OSHA OTM | — |
| §4 ISO 7243:2017 third edition (2017-08) replaces ISO 7243:1989 | CONFIRMED | ISO 7243 preview | — |
| §4 Formulae (1) and (2); WBGT_eff = WBGT + CAV (3); reference clothing 0.6 clo, i_m 0.38 | CONFIRMED | ISO 7243 preview | — |
| §4 "For clothing ensembles for which the CAV cannot be determined … ISO 7933" | CONFIRMED | ISO 7243 preview | Clause 7. |
| §4 "sustained exposure for up to 8 h" | CONFIRMED | ISO 7243 preview | Clause 4. |
| §4 §9.2: time base about 1 h; Formula (4); Formula (5), T = 1 h | CONFIRMED | ISO 7243 preview | — |
| §4 §9.3 "When there is doubt … higher metabolic rate" | CORRECTED | ISO 7243 preview | The quote stopped before the qualifier "if all measurement or estimation is impossible". The full sentence is now quoted inline. |
| §4 §9.4 (clothing TWA); §9.1 (abdomen, or where heat stress is highest); no head/abdomen/ankle weighting in clauses 1–9 | CONFIRMED | ISO 7243 preview | — |
| §4 ISO 7243:1989 weighting (head + 2·abdomen + ankles)/4; 1-h TWA "calculated from the beginning of a period of work" | CONFIRMED [S] | Parsons 2006 | p. 371. |
| §4 Annex designations A–F (B normative, the rest informative); Foreword: Figure A.1 "together with reference equations" | CONFIRMED | ISO 7243 preview | — |
| §4 Annex A equations equal NIOSH/ACGIH, with M in W | CONFIRMED [S] | ASSP 2022 | Annex A itself is paywalled. Consistent with class 0: 33.00 = REL(115). |
| §4 Annex A validity range "115 < M < 520 W" | UNVERIFIABLE | — | Paywalled. A search found no primary or reputable secondary text. It was correctly not used. |
| §4 Table A.1: 33/32, 30/29, 28/26, 26/23, 25/20 °C at 115/180/300/415/520 W | CONFIRMED [S] | Brimicombe 2024 | Table 1, which cites ISO 7243:2017. |
| §4 Table A.1 vs equations: classes 0–2 are 0.9–1.2 °C higher, class 3 matches, class 4 is 1.6 °C lower | CONFIRMED | (computed) | Differences: +1.16 / +0.90 / +1.03 / +0.01 / −1.60. Classes 3–4 equal the 1989 "sensible air movement" values in brackets. |
| §4 ISO 7243:1989 table: values, bracketed values, 38 °C rectal basis | CONFIRMED [S] | Parsons 2006 | Table 1. |
| §4 Annex E and Annex F contents | UNVERIFIABLE | — | Paywalled; agrees with the document. |
| §4 pythermalcomfort: `work_capacity_iso` = 34.9 − M/46 with rest 117 W; `work_capacity_niosh` interpolates between REL(M) and REL(117 W) | CONFIRMED | pythermalcomfort | models/work_capacity_*.py. |
| §4 34.9 − M/46 "is a linear fit used by Bröde et al. 2018" | UNVERIFIABLE | https://doi.org/10.1007/s00484-017-1346-9 | Paywalled; only the pythermalcomfort docstring attributes it. The remark "roughly the 1989 acclimatised no-air-movement column" is confirmed by computation: 32.4/31.0/28.4/25.9/23.6 against 33/30/28/25/23. |
| §5.1 ISO 8996:2021 third edition (2021-12); Foreword quotes (watts; level-1 occupation method removed) | CONFIRMED | ISO 8996:2021 preview | — |
| §5.1 §4: displacements → body weight; ISO 7243/7730/7933/11079 use W·m⁻² | CONFIRMED | ISO 8996:2021 preview | — |
| §5.1 §6: five classes; short rest pauses; "without interpolation between the four categories" | CONFIRMED | ISO 8996:2021 preview | — |
| §5.1 Table 1 uncertainties: "very great risk of error" / ±20 % / ±10–15 % / ±5 % | CONFIRMED | ISO 8996:2021 preview | Table 1 also lists 3B accelerometry ("high risk of error"), which the document omits. |
| §5.1 Heavy clothing raises metabolic rate "by 20 % or more" | CONFIRMED | ISO 8996:2021 preview | — |
| §5.1 ISO 8996:2021 Table A.1 numeric ranges | UNVERIFIABLE | — | Paywalled; agrees with the document. |
| §5.2 ISO 8996:2004 Table A.2: means, ranges and examples in W·m⁻² and W | CONFIRMED [S] | Foster 2020 | Table 1; every number matches. The source line reads "ISO, 2004". |
| §5.2 "Average" individual: man 30 y, 70 kg, 1.75 m, 1.8 m²; woman 30 y, 60 kg, 1.70 m, 1.6 m² | CONFIRMED | ISO 8996:2004 preview | Introduction. |
| §5.2 "The W column is the W·m⁻² value × 1.8 m², rounded" | CORRECTED | Foster 2020 | 260 × 1.8 = 468 is tabulated as 465; nearest-5 rounding would give 470. The values are as tabulated, not a strict rounding rule. |
| §5.2 DuBois A = 0.202·m^0.425·h^0.725 gives 1.844 m² at 70 kg, 1.75 m; it is the pythermalcomfort default | CONFIRMED | pythermalcomfort | `utilities.body_surface_area` returns 1.8438. |
| §5 ACGIH Table 2 was computed with 300 W, not 295 W | CONFIRMED | (reproduction) | With 295 W the 75–100 % moderate TLV cell would be REL(295) = 28.30, which rounds to 28.5 instead of the published 28.0. |
| §5 Example-list differences (sledgehammer High vs Very heavy; welding; driving; off-road equipment) | CONFIRMED | Foster 2020; OSHA hazards | — |
| §5 Typical task mapping: forklift → Light (180 W) | CORRECTED | OSHA hazards; Foster 2020; ISO 7243 preview | Moved to Moderate. OSHA lists "driving or operating mobile equipment" under Moderate, and ISO 7243 §9.3 says to take the higher class when in doubt. |
| §5bis TB MED 507 dated 12 April 2022; supersedes the 7 March 2003 edition; 81 pages | CONFIRMED | TB MED 507 | — |
| §5.3 WBGT °F = 0.7Twb + 0.2Tbg + 0.1Tdb (para 2-2d); "No other heat stress index…"; WBGT not accurately forecastable (para 2-2e) | CONFIRMED | TB MED 507 | p. 7. |
| §5.3 "~75 °F" threshold; WBGT > 90 °F may need "extreme modifications or temporary suspension" (para 3-3a) | CONFIRMED | TB MED 507 | p. 17. |
| §5.3 Heat categories (Fig. 3-3) and lower bounds 25.556 / 27.778 / 29.444 / 31.111 / 32.222 °C | CONFIRMED | TB MED 507 | p. 20. |
| §5.3 Sports-medicine categories for > 800 W continuous events (< 50; 50–64.4; 64.5–73.4; 73.5–82.4; > 82.4 °F) | CONFIRMED | TB MED 507 | Fig. 3-3. |
| §5.4 Table 3-2: 20 work/rest and water cells; 250/425/600/800 W; definition of NL | CONFIRMED | TB MED 507 | p. 18, checked cell by cell on the rendered page. |
| §5.4 Table 3-2 notes (≥ 4 h; ±¼ qt/h twice; rest in shade; ≤ 1½ qt/h; ≤ 12 qt/day; CBRN/JSLIST +10 °F easy, +20 °F moderate and heavy) and example tasks | CONFIRMED | TB MED 507 | p. 18. |
| §5.4 Table 3-3: 20 cells | CONFIRMED | TB MED 507 | p. 19. |
| §5.4 Litres: 0.473 / 0.710 / 0.946 / 1.183 / 1.420 L; 12 qt = 11.36 L | CONFIRMED | (arithmetic) | — |
| §5.5 Table 3-6: ≤ 1½ qt/h and ≤ 12 qt/day; stomach-emptying note; cool water to 50–60 °F | CONFIRMED | TB MED 507 | p. 30. |
| §5.5 Para 3-7h: < 135 mmol/L; 1½ qt/h; 12 qt per 24 h; 4 hydration systems; substitute 2 qt of electrolyte beverage | CONFIRMED | TB MED 507 | p. 32. |
| §5.5 Para 3-7i high-risk situations | CONFIRMED | TB MED 507 | p. 32. |
| §5.5 Para 2-3f: overconsumption for ≥ 4 h → hyponatremia; about 0.36 °F and 5 bpm per 1 % body-weight loss | CONFIRMED | TB MED 507 | p. 9. |
| §5.5 Para 3-6f: guidance effective if within ±2 % of body weight over 4 h | CONFIRMED | TB MED 507 | p. 27. |
| §5.5 Table 2-1 (4–14 days; ≥ 100 min/day; retained about 1 week, lost within 1 month); optimal about 10 days; responses fall by about 2 °F and 40 bpm (para 2-5) | CONFIRMED | TB MED 507 | pp. 11–12. |
| §5.5 Heat Strain Decision Aid endpoints: 101.3 °F for the work-rest tables (CHS and UCHS); 104 °F for continuous work (CHS) (para 3-2f) | CONFIRMED | TB MED 507 | p. 16. |
| §5.6 2007 → 2022 work/rest changes; new Very heavy column | CONFIRMED | NIOSH 2016; TB MED 507 | Water volumes are unchanged between the two tables. |
| §6.1 Table C-1 levels (< 91; 91–103; 103–115; > 115 °F), °C equivalents and measures; "Adapted from OSHA [2012c]" | CONFIRMED | NIOSH 2016 | App. C, p. 159. |
| §6.1 Engine intervals (103 resolved upward; 115 in High) | CONFIRMED | NIOSH 2016 | A design choice consistent with Table C-1. |
| §6.1 Full sunshine can raise heat index values by up to 15 °F | CONFIRMED | NIOSH 2016; NWS AMA | p. 158. |
| §6.1 CDC app page: app not receiving updates; agencies considering new HI data; reviewed 2026-03-03 | CONFIRMED | CDC app page | — |
| §6.1 Tustin 2018: HI < 91 °F in 12 of 25 cases, including 6 of 14 deaths; 85 °F screening threshold | CONFIRMED | Tustin 2018 | — |
| §6.2 OSHA Table 2 (28/30, 25/28, 23/26, 21/25 °C) and caption | CONFIRMED [S] | OSHA hazards | — |
| §6.2 OSHA rounding is neither floor nor round (30.76 → 30; 24.97 → 25) | CONFIRMED | (computed) | Also 26.59 → 26, 22.99 → 23 and 21.60 → 21. |
| §6.2 OSHA Table 1 bands (< 70 °F; 70–77 °F; > 77 °F) | CONFIRMED [S] | OSHA hazards | — |
| §6.2 OSHA clothing factors: 0 / 0 / 0.5 / 1 / 3 / 11 °C | CONFIRMED [S] | OSHA hazards | — |
| §6.3 RIN 1218-AD39; NPRM 89 FR 70698, 30 Aug 2024; proposed 29 CFR 1910.148 | CONFIRMED | OSHA NPRM | — |
| §6.3 Trigger definitions (HI 80 °F or WBGT = RAL; HI 90 °F or WBGT = REL); "heat index" means the NWS heat index; employer picks one metric, otherwise HI; "at or above" | CONFIRMED | OSHA NPRM | Paragraphs (b), (d)(4), (e)(1), (f)(1). |
| §6.3 Initial-trigger requirements: 1 qt per employee per hour, "suitably cool"; shade (not from equipment) or AC; indoor break areas; indoor controls; fan evaluation above 102 °F; paid breaks if needed; two-way communication; cooling PPE | CONFIRMED | OSHA NPRM | (e)(2)–(10). |
| §6.3 Acclimatisation option (B): 20/40/60/80 % for new employees, 50/60/80 % for those away > 14 days; option (A); 14-day exception | CONFIRMED | OSHA NPRM | (e)(7), verbatim. |
| §6.3 High-trigger requirements: 15-min paid break at least every 2 h; a meal break may count; donning/doffing and walking excluded; buddy system or ≤ 20 per supervisor; lone-worker contact every 2 h; hazard alert; signs where indoor ambient regularly exceeds 120 °F | CONFIRMED | OSHA NPRM | (f)(2)–(5). |
| §6.3 Exemptions: no reasonable expectation; ≤ 15 min in any 60 min; emergency response; AC keeps < 80 °F; telework; sedentary indoor work | CONFIRMED | OSHA NPRM | (a)(2)(i)–(vi). |
| §6.3 Other provisions: emergency response, training, recordkeeping | CONFIRMED | OSHA NPRM | (g)–(i). |
| §6.3 Timetable: NPRM 08/30/2024; comments closed 01/14/2025; hearing 06/16–07/02/2025; post-hearing comments ended 10/30/2025 (90 FR 46110); supplemental NPRM 12/2026; Final 10/2027; Proposed Rule Stage; Economically Significant | CONFIRMED | reginfo; 90 FR 46110 | The agenda lists only the hearing start date. The 07/02/2025 end date comes from 90 FR 46110 ("from June 16 through July 2, 2025"). |
| §6.3 No federal heat standard in force; enforcement through the General Duty Clause | CONFIRMED | OSHA NEP 2026 | The directive cites OSH Act §5(a)(1). |
| §6.3 Heat NEP CPL 03-00-024 re-issued 10 April 2026 for five years (to 2031); heat-priority day = HI ≥ 80 °F; inspections on NWS heat warning/advisory days | CONFIRMED | OSHA NEP 2026; Littler | Now verified against the primary directive (previously [S]). |
| §6.3 WBGT triggers at 300 W: 24.97 / 28.21 °C | CONFIRMED | (equations) | — |
| §8 WPC page (modified 2022-05-12): Rothfusz coefficients, both adjustments and their conditions, simple formula, "computed first and the result averaged with the temperature", "80 degrees F or higher", validity sentence | CONFIRMED | WPC equation | Raw HTML read. |
| §8 HI_s = 1.1T − 10.3 + 0.047RH; the 0.5 factor is the averaging, so do not average twice | CONFIRMED | WPC calculator | The JavaScript computes hitemp = 61 + (T − 68)·1.2 + 0.094·RH, then hifinal = 0.5·(T + hitemp). |
| §8 JavaScript uses `hifinal > 79.0` and `RH <= 13`; returns HI = T for T ≤ 40 °F; the °C path averages the °C temperature | CONFIRMED | WPC calculator | In `heat1_c`, fptemp is the °C input. |
| §8 Fixture at 78 °F / 86 %: 79.542 (text rule) vs 80.426 (JavaScript rule) | CONFIRMED | (recomputed) | — |
| §8 Low-RH adjustment is at most 3.25 °F (1.81 °C), at 95 °F and RH 0, and is zero at 112 °F | CONFIRMED | (algebra) | — |
| §8 NWS categories: 80–90 / 90–103 / 103–124 / ≥ 125 °F | CONFIRMED | NWS AMA | — |
| §8 pythermalcomfort: within 1.4e-5 °C of the bare polynomial; no adjustments; NaN below 27 °C; bands 27/32/41/54 °C; 41 °C = 105.8 °F | CONFIRMED | pythermalcomfort | Max deviation 1.36e-5 °C on a 0.25 °C × 0.5 % grid. |
| §8 NWS − pythermalcomfort ranges from −1.81 °C (35 °C, 0 %) to +1.07 °C (27 °C, 100 %); −0.21 at 42 °C/10 %; +0.26 at 28 °C/90 % | CONFIRMED | (recomputed) | −1.806 and +1.067. |
| §8 NOAA chart cross-check: Rothfusz within ±1 °F in 135/135 cells (129 exact); full NWS 133/135; misses at 80 °F / 95 % and 100 % (adjustment 1.4–2.1 °F) | CONFIRMED | NIOSH 2016 | App. C p. 158, parsed from the PDF text. The oracle's transcription matches all 135 cells. |
| §8 Chart typo "130(50)" should read 130(54) | CORRECTED | NIOSH 2016 | Incomplete: there are five °C typos (130(50), 112(46), 108(43), and header labels 92(34), 110(47)). |
| §8 Abu Dhabi examples (44.45 °C / 112.0 °F; 51.34 / 124.4; 45.72 / 114.3) and their categories | CONFIRMED | (recomputed) | 124.4 °F falls in the printed 124–125 gap and resolves to Danger under the ≥ 125 rule. |
| §9 Oracle writes 184 vectors and 71 self-checks, all passing; group counts; Python 3.12.10, numpy 2.5.4, pythermalcomfort 4.8.1 | CONFIRMED | (re-run 2026-11-09) | The regenerated fixture is identical to the committed one apart from `generated_utc`. |
| §9 Fixture values | CONFIRMED | (independent recomputation) | All 184 vectors recomputed with independent code (749/749 checks), plus the hand spot-checks above. |
| §11 Constants: NIOSH_LIMITS; rest/min 115 W; plot max 600 W; ACGIH_METABOLIC_W; ACGIH_SCREENING_C; CLOTHING_CAV_C; hood +1; NIOSH_LIMIT_CORRECTION_C; ISO8996_2004_CLASSES; STANDARD_BSA_M2; TBMED507_* tables and add-ons; HYDRATION; US_QUART_L; US_FL_OZ_ML; KCAL_PER_H_TO_W; ACCLIMATIZATION_*; HEAT_STRAIN_LIMITS; RECOVERY_HR; HEAT_ALERT; NWS_HI; OSHA_HI_RISK_F; OSHA_NPRM | CONFIRMED | (sources in the rows above) | Every literal was cross-checked against the rows above. The quart and fluid-ounce factors are exact. |
| §11 Reference algorithms: ralC/relC/limitC, twa, allowedWorkFraction, roundHalfUpToHalf, heatIndexNwsF, tbmed507Category, oshaHiRisk, oshaNprmTriggerHi | CONFIRMED | (logic reviewed against the sources) | heatIndexNwsF uses the text rule (≥ 80; RH < 13), as documented. It matches the oracle. |
