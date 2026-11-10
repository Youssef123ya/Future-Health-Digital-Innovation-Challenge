# Zill (ظل): context, competition, governance and commercial path

**Scope.** This brief covers the evidence base for Zill outside the physiology engine: who is harmed by heat, who the workers are and which languages they speak, who else is in the market, which laws and standards apply, what Future Health expects, and how Zill reaches a paid pilot. It maps onto the six judging criteria: health impact, technical depth, demo, responsible AI and governance, scalability, and commercial path. For exposure-limit equations (NIOSH/ACGIH/ISO 7243) see `limits_and_workrest.md`. For PHS/ISO 7933 see `phs_iso7933.md`. For WBGT see `wbgt_liljegren.md`.

**Status:** researched 2026-11-09. Unless stated otherwise, all web sources were accessed on 8–9 Nov 2026.
**Reproducible arithmetic:** Appendix A holds the script and its output. It covers the UN DESA extraction, the market-size pools, messaging cost and the pilot event counts, and it ran successfully on 2026-11-09.

**How to read the evidence tags** (the same convention as the sibling research files)

| Tag | Meaning |
|---|---|
| **[P]** | Verified against the primary document: a standard, regulator text, original paper or official dataset. |
| **[S]** | Secondary source: a law firm, the press, an aggregator or an NGO summary of a primary. It is named, and it is used only where the primary was paywalled or unreachable. |
| **[D]** | Derived by us from cited inputs, with the method shown in Appendix A. |
| **UNVERIFIED** | Could not be confirmed. Do not present it as fact. The attempts are listed in §7. |

Several government hosts were unreachable from our network: mohre.gov.ae, doh.gov.ae, uaelegislation.gov.ae, elaws.moj.gov.ae and normlex.ilo.org. They returned TLS resets or HTTP 403. Where a statement depends on those sites, the tag says how it was verified.

---

## 0. One-page summary (read this first)

1. **The burden is very large, and the Arab States are among the most exposed regions.**
   - Every year at least **2.41 billion workers** (over 70% of workers) are exposed to excessive heat [P, S1].
   - Excessive heat causes **22.85 million occupational injuries, 18,970 work-related deaths and 2.09 million DALYs** a year (2020 estimates) [P, S1].
   - **83.6%** of the Arab States workforce is exposed. The global figure is 71.0%, and Africa's is 92.9% [P, S2].
2. **Most heat harm happens outside heatwaves.** Globally, "nine out of ten worker exposures to excessive heat, and eight out of ten occupational injures [sic] linked to excessive heat, occur outside of a heatwave" [P, S2]. In the Arab States, **over 38%** of excessive-heat exposure occurred during heatwaves (defined as 3 or more days above 35 °C) [P, S2]. A heatwave-only or calendar-only alert therefore misses most of the risk.
3. **The UAE carries a specific burden.**
   - The UAE lost **1.5 billion potential labour hours** to heat in 2022, 350% more than in 1991–2000 [P, S5].
     - Construction accounted for **62.2%** of the hours lost.
     - The associated income loss was **US$18.2 bn**, equal to **3.6% of GDP** [P, S5].
   - ILO projections for the UAE in 2030 [P, S4]:
     - **2.6%** of total working hours lost to heat.
     - **7.6%** of hours lost in construction (assuming in-shade work).
     - The equivalent of **164,100** full-time jobs.
4. **The midday ban is necessary but not sufficient.**
   - UAE rule: no outdoor work under direct sun from **12:30 to 15:00**, between **15 June and 15 September**. 2026 was the 22nd year of the ban [S, S33].
   - In Kuwait, the risk of occupational injury still rose to **RR 1.44** at 39.4 °C (compared with 37.0 °C) *during* the midday-ban season [P, S16].
   - The UAE recorded **51.6 °C on 24 May 2025**, three weeks before the ban starts [S, S37].
   - In 2019 the ILO wrote that GCC midday bans "could be adjusted to reflect real-time temperature, humidity and workload for all outdoor worksites" [P, S4].
5. **Abu Dhabi already has a local standard that Zill can implement.**
   - The Thermal Work Limit (TWL) zones of ADPHC "Safety in Heat" set work-rest and hydration schedules [P, S27].
   - The 2008 programme cut heat-related cases at one company by **79.5%**, from 15.3 to 1.16 per 1,000 workers [P, S9].
   - Zill digitises and extends this standard. It does not invent a new one.
6. **Languages.**
   - ADPHC's 2025 materials are in **Arabic, English, Urdu, Hindi, Tagalog and Bengali** [P, S29].
   - The 2008 programme used **English, Arabic, Hindi, Urdu and Malayalam** [P, S9].
   - Migrant stock by origin, from UN DESA 2024 [P/D, S40]:
     - India **39.8%**, Bangladesh **12.6%**, Pakistan **11.4%**, Egypt **10.3%**, Philippines **6.5%**.
     - The total is 8,157,000 people.
   - Recommended launch set (§2.3): **Arabic, English, Hindi, Urdu, Bengali, Malayalam, Tagalog and Nepali**.
7. **Competitors sell physiology wearables to supervisors.**
   - Hardware costs hundreds of dollars per worker. Examples:
     - Hexoskin kit: US$849–899 [P, S52].
     - SlateSafety BAND V2: $821.85 in a Canadian retail listing [S, S49b].
     - Zephyr BioHarness 3 kit: $3,970 in one listing [S, S53].
   - No public material we found documents any of the following:
     - a worker UX in Arabic or South-Asian languages,
     - worker-controlled data governance,
     - rule packs for the UAE midday ban or the ADPHC TWL zones.
   - The free OSHA-NIOSH app uses the heat index and "is not receiving updates at this time" (page dated 3 Mar 2026) [P, S54].
8. **Governance hooks.**
   - Health and biometric data are *sensitive personal data* under the PDPL (Federal Decree-Law 45/2021) [S, S61, S62].
   - Health data that has its own legislation is excluded from the PDPL. The ICT-in-Health Law (Federal Law 2/2019) then applies, including its Article 13 localisation rule [S, S65, S66].
   - DoH Abu Dhabi has issued three relevant instruments:
     - **ADHICS V2** (May 2024) [P via index, S67].
     - The **Responsible AI Standard**, DoH/ST/DDGO/RAI/V1/2025 (Oct 2025) [P via index, S68].
     - The **Standard for Biomedical Research**, DoH/SD/HLSS/SBR/V1/2026 (Apr 2026) [P, S70].
   - Under the ILO code (1997), "continuous monitoring should be permitted only if required for health and safety", and monitoring data "should not be the only factors in evaluating worker performance" [P, S73].
9. **Stay a non-diagnostic occupational-safety tool.**
   - The EU MDR device definition includes "**prediction, prognosis**" of disease [P, S79]. Avoid individual disease-prediction claims, such as "predicts heat stroke" or "estimates core temperature".
   - The UAE regulator is the **Emirates Drug Establishment (EDE)**, under Federal Decree-Law No. 38 of 2024, in force since 2 Jan 2025 [S, S80, S81, S82].
   - Obtain a written qualification opinion before adding physiological alerts.
10. **Pilot.**
    - Design: one contractor, about 200 workers in 8 crews, a **10-week stepped-wedge** pilot in June–August 2027.
    - Report it as a feasibility pilot under CONSORT-SW and CONSORT-pilot [P, S91].
    - Clinic-confirmed heat illness is too rare to be the primary endpoint. At Abu Dhabi's 2008 baseline rate we would expect only **0.6–3.1** cases in 200 workers [D, Appendix A].
11. **Challenge dates (confirm today).**
    - Hack2skill lists [P, S87]:
      - Registration: **15 Oct–10 Nov 2026**.
      - Prototype submission: **20 Nov 2026**.
      - Evaluation: **20–30 Nov 2026**.
      - Awards at **GITEX, 7–11 Dec 2026**.
      - Prizes: **US$50k / 35k / 20k**, plus a readiness assessment and a "potential pathway beyond the Challenge".
    - The launch press release instead says applications close **15 Nov 2026** [P, S86].

---

## 1. Burden: why worker heat strain is a clinical and economic priority

### 1.1 ILO (April 2024), *Ensuring safety and health at work in a changing climate*: global figures [P, S1]

| Metric (verbatim where quoted) | Value | Location in report |
|---|---|---|
| Workers exposed to excessive heat | "every year at least **2.41 billion** workers are exposed to excessive heat (i.e., over 70 per cent of all workers)" | Ch. 1, p. 18 (PDF p. 25) |
| Change 2000→2020 | "a **34.7%** increase in the number of workers exposed to excessive heat" | p. 18 |
| Annual injuries / deaths / DALYs attributable to excessive heat | "**22.85 million** occupational injuries, **18,970** deaths and **2.09 million** disability-adjusted life years (DALYs)" | Key takeaways; p. 20 |
| Heat-attributable chronic kidney disease | "in 2020, there were an estimated **26.2 million** persons living with chronic kidney disease attributable to exposure to excessive heat at work", which is "**3 percent** of the total number of people living with chronic kidney disease" | p. 20, fn 5 |
| Injury exposure-response used | Injury risk "increased by **1%** for 1 °C increase in temperature above **20.9 °C** reference value and **17.4%** (RR 1.174, 95% CI: 1.057–1.291) during heatwaves", from Fatima et al. 2021 (22 studies, about 22 million injuries) | fn 3–4 |
| Physiology thresholds quoted | "If the body temperature rises above **38 °C**, physical and cognitive functions are impaired; if it rises above **40.6 °C** the risk of organ damage, loss of consciousness and, ultimately, death increases sharply (IPCC 2014)" | p. 18 |
| UAE programme cited | The UAE "Safety in the Heat" programme with ADPHC: "educating approximately **800,000** workers and employers" | p. 30 (PDF p. 37) |
| GCC legislation cited | Qatar: "Work must stop if the WBGT rises above **32.1 °C** (Ministerial Decision No.17)". UAE midday hours: "Ministerial Decree No. **401 of 2015** Concerning the Determination of Midday Working Hours". Bahrain and Kuwait: "oil and gas sector workers are not covered by the legislation" | pp. 23–25 (PDF pp. 30–32) |

The estimates use 2020 data. The July 2024 companion report says that "during 2020 alone, excessive heat was linked to 22.85 million injuries and 18,970 deaths" [P, S2].

### 1.2 ILO (July 2024), *Heat at work: Implications for safety and health*: regional figures and the heatwave split [P, S2, S3]

**Table 4 of the report** (share of workers exposed to excessive heat):

| Region | Global | Africa | Americas | **Arab States** | Asia & Pacific | Europe & Central Asia |
|---|---|---|---|---|---|---|
| % of workers exposed, 2020 | 71.0 | 92.9 | 70.0 | **83.6** | 74.7 | 29.0 |
| % change in exposure, 2000→2020 | 8.8 | 2.7 | 5.4 | 6.2 | 6.7 | 17.3 |

**Heatwaves compared with the rest of the season** (verbatim where quoted):

- "Nine out of ten worker exposures to excessive heat, and eight out of ten occupational injures [sic] linked to excessive heat, occur outside of a heatwave."
- In 2020, **231 million** workers were exposed to excessive heat during a heatwave, 66% more than in 2000 (139 million).
- "84 billion person-days of work exposed to excessive heat during heatwaves, accounting for **9.6 per cent** of all exposed person-days."
- **Arab States:** "over **38 per cent** of excessive heat exposure occurred during heatwaves, followed by Africa at 11.3 per cent."
  - The heatwave definition used was "three or more days with temperatures exceeding 35 °C".
  - Implication: in the Gulf, **about 62% of exposure is still outside heatwaves**, but heatwave days are a much larger share than elsewhere [D].
- In 2020, heatwaves caused 5.1 million injuries and "more than **4,200** deaths". That is 22.1% of heat-attributable injuries. "The risk of occupational injury on a heatwave day is over **230 per cent** higher compared to a regular hot day."
- "The Arab States and Africa regions have the highest proportion of occupational injuries attributable to excessive heat during heatwaves, at **1.7 per cent** in both regions."
- CKD: heat-attributable cases are "about 3 per cent of all chronic kidney disease cases, ranging from 3.34 per cent in Africa to 1.8 per cent in the Americas."
- Savings: OSH measures could save "over **US$361 billion** globally", equal to about 1.5% of GDP in low- and middle-income economies.
- Lesson 3 of the report: "The safety and health of workers should be protected during all periods of excessive heat, not only during heatwaves." The same lesson calls for a rights-based approach, including "the right to know about heat stress and the right to remove themselves from dangerous situations."

The report also gives a **hydration table** that the engine can use (Table 8, verbatim; simulated with the FAME Lab predicted heat strain model):

| WBGT (°C) | Low-intensity work (L/h) | Moderate (L/h) | High (L/h) |
|---|---|---|---|
| 25.0–28.0 | 0.35 | 0.55 | 0.65 |
| 28.0–29.4 | 0.40 | 0.55 | 0.70 |
| 29.5–30.9 | 0.40 | 0.60 | 0.75 |
| 31.0–32.4 | 0.45 | 0.65 | 0.80 |
| ≥32.5 | 0.50 | 0.70 | 0.85 |

- Work intensity follows ISO 7243:2017 Table 1.
- The simulated subject is 170 cm and 70 kg, wearing a hat, short-sleeve shirt and denim overalls.
- The band edges overlap at 28.0 and leave a gap between 29.4 and 29.5. **The engine should assign boundary values to the higher band** (a conservative choice of ours [D]).

### 1.3 ILO (2019), *Working on a warmer planet* [P, S4]

- **Global:** "in 2030, **2.2 per cent** of total working hours worldwide will be lost to high temperatures – a productivity loss equivalent to **80 million** full-time jobs". Global GDP falls by **US$2,400 billion**.
  - The ILO calls this conservative: it assumes 1.5 °C of warming and that agriculture and construction work happens in the shade.
- **Arab States:**
  - **0.4%** of working hours were lost in 1995, equal to about 90,000 full-time jobs.
  - The projection is **1.0%** in 2030, "almost **618,000** full-time jobs".
  - Construction is "expected to account for **40 per cent** of the total loss of working hours due to heat stress in 2030".
- **UAE row of Table 5.1:**

  | Year | Agriculture (shade) | Industry | Construction (shade) | Services | Total | FTE jobs |
  |---|---|---|---|---|---|---|
  | 1995 | 4.3% | 2.2% | 4.3% | 0.5% | **1.8%** | 21,100 |
  | 2030 (projection) | 7.6% | 4.6% | **7.6%** | 1.4% | **2.6%** | **164,100** |

  - "Bahrain and the United Arab Emirates are also expected to lose more than **2 per cent of their GDP** by 2030 as a result of heat stress."
  - Qatar is projected to lose 3.2%.
- **Box 5.1 (GCC):**
  - Construction was **23%** of GCC employment in 2017 (ILOSTAT).
  - In the GCC construction sector, "more than **95 per cent** of the workforce are migrant workers from low-wage Asian countries such as Pakistan, India, the Philippines, Bangladesh and Nepal".
  - On language: "Language barriers impede communication … They also make it harder for workers to report symptoms and raise concerns with their managers, or even just to explain that they need to take a break or drink some water."
  - The box cites Joshi et al. 2011: **17.6%** of surveyed Nepali migrant workers in Qatar, the UAE and Saudi Arabia reported heat-related illness [S, as cited].
  - On midday bans: "the current ban on outdoor midday work in the GCC countries could be adjusted to reflect real-time temperature, humidity and workload for all outdoor worksites."

### 1.4 Lancet Countdown

- **UAE Data Sheet 2023** (2022 data) [P, S5]:
  - **1.5 billion** potential labour hours were lost to heat exposure in 2022, an increase of **350%** from 1991–2000 (indicator 1.1.4).
  - "Construction workers were hit the hardest, seeing **62.2%** of the potential hours lost and **69.5%** of the potential income losses in 2022."
  - The potential income loss was **US$18.2 billion**, "equivalent to **3.6% of GDP**" (indicator 4.1.3).
  - Average summer temperatures over 2018–2022 were **1.3 °C** above the 1986–2005 baseline.
- **Global, 2025 report** (2024 data):
  - "a record **639 billion** potential hours of lost labour productivity in 2024".
  - Income losses were "US$1.09 trillion (almost 1 percent of global GDP)" [P, press release S6].
- **Global, 2026 report** (2025 data):
  - **573 billion** potential work hours were lost in 2025, with US$1.07 trillion in income losses [P, data explorer S7].
- A **newer UAE-specific sheet** for 2024–2026 could not be retrieved. The country-resources page lists a UAE sheet but no file link, so the UAE numbers above remain the 2023 sheet.

### 1.5 Peer-reviewed evidence from the GCC and UAE (all [P], verified on PubMed with abstracts read)

| Study | Setting and n | Key quantitative finding | Why it matters for Zill |
|---|---|---|---|
| Flouris et al. 2018, *Lancet Planet Health* 2:e521–31 [S8] | Meta-analysis of 111 studies, 30 countries, 447 million workers | <ul><li>One shift under heat stress (WBGT above **22.0 or 24.8 °C**, depending on work intensity) made heat strain **4.01×** more likely (95% CI 2.45–6.58).</li><li>Core temperature rose **+0.7 °C** (0.4–1.0).</li><li>**35%** (31–39) of workers had heat strain.</li><li>**30%** (21–39) reported productivity loss.</li><li>**15%** (11–19) of those working in heat at least 6 h/day, 5 days/week, 2 months/year had kidney disease or AKI.</li></ul> | Headline clinical-relevance numbers. The ILO 2024 report reuses them. |
| Joubert, Thomsen & Harrison 2011, *AJPH* 101:395–8 [S9] | Abu Dhabi HAAD "Safety in the Heat", 2008. 465 companies, **814,996** workers, 6,254 sites | <ul><li>Company 1 (1,371 workers): heat-related treatment and emergency cases fell **79.5%**, from 15.3 to 1.16 per 1,000 workers (2008→2009).</li><li>Company 2 (51 million work-hours): serious cases fell **50%**, from 0.08 to 0.04 per 100,000 h.</li><li>Cost: **US$436,882**, under US$0.50 per person covered.</li><li>Materials were in **English, Arabic, Hindi, Urdu and Malayalam**.</li><li>Most helpful materials: posters 97.4%, pictorial pamphlet 89.5%, urine-colour posters 87.7%.</li></ul> | <ul><li>A local proof that education plus TWL scheduling works.</li><li>Gives baseline incidence for pilot sizing.</li><li>Shows low-literacy pictorial formats work.</li><li>Two-company before/after only, with no control group.</li></ul> |
| Bates & Schneider 2008, *J Occup Med Toxicol* 3:21 [S10] | UAE construction workers, May 2006, 3 consecutive 12-h shifts | <ul><li>Average fluid intake **5.44 L** per 12-h shift.</li><li>No rise in core temperature or heart rate when workers could self-pace and drink.</li><li>"WBGT … inappropriate for use in Gulf conditions, however TWL was found to be a valuable tool".</li></ul> | <ul><li>Supports TWL as the primary local index.</li><li>Self-pacing is protective.</li></ul> |
| Bates, Miller & Joubert 2010, *Ann Occup Hyg* 54:137–43 [S11] | Expatriate manual workers at 4 Middle East sites | "a high proportion were still found to be inadequately hydrated both on presentation for work and throughout the shift" | <ul><li>Supports a pre-shift hydration check (urine colour).</li><li>Environmental indices assume workers are hydrated.</li></ul> |
| Ahmed et al. 2020, *Ind Health* 58:170–81 [S12] | UAE construction site (Sharjah team) | WBGT exceeded the TLV. By TWL the site was in the "Acclimatization Zone". Radiant load dominated. | Local corroboration that TWL and WBGT disagree, so Zill must show which index drives each decision. |
| Bendak et al. 2022, *J Safety Res* 81:197–202 [S13] | 120 construction workers, Dubai | <ul><li>Reaction time was worse in summer, and worsened more during the first 5.5 h of a summer shift.</li><li>Accidents trended up in summer.</li></ul> | Links heat to injury risk, not only to heat illness. |
| Al-Bouwarthan et al. 2020, *IJERPH* 17:3775 [S14] | 65 construction workers, Al-Ahsa (Saudi Arabia), June→September 2016 | <ul><li>**18%** incidence of kidney injury (ACR ≥30 mg/g) across one summer.</li><li>Risk factors: dehydration, short sleep and obesity.</li></ul> | Kidney injury is a measurable within-season harm. |
| Alahmad et al. 2023, *Occup Environ Med* 80:347–52 [S16] | Kuwait MoH occupational injuries, summers 2015–2019 | <ul><li>Compared with 37.0 °C, a 39.4 °C day carried **RR 1.44** (1.34–1.53).</li><li>40 °C: RR 1.48. 41 °C: RR 1.44.</li><li>Authors: "'Calendar-based' regulations may be inadequate".</li></ul> | Best GCC evidence that midday bans leave residual risk. |
| Pradhan et al. 2019, *Cardiology* 143:37–48 [S15] | Nepali migrant workers in Qatar, deaths 2009–2017 (FEPB records) | <ul><li>Death rate **150/100,000** per year.</li><li>CVD share of deaths: **22%** in the cool season versus **58%** in the hot season.</li><li>"As many as **200** of the 571 CVD deaths … could have been prevented".</li></ul> | Heat and cardiovascular mortality in young migrants. Cause-of-death data are weak, so treat with care (§1.7). |
| Ioannou et al. 2021, *IJERPH* 18:6303 [S17] | 518 shifts, 238 workers in Cyprus, Greece, **Qatar** and Spain, with continuous core temperature | <ul><li>Where self-pacing is limited, heat stress drives strain.</li><li>Hydration, work-rest cycles and ventilated clothing mitigated strain.</li></ul> | Supports the interventions Zill prescribes. |
| ILO/ADLSA/SC Qatar field study 2019 (FAME Lab) [P, S18, S19] | More than 5,500 work hours, a World Cup stadium site and a farm | <ul><li>Mean core temperature during work was 37.3 °C (range 36.7–39.2 °C).</li><li>"**one in three** workers performed up to five per cent of their job while hyperthermic (core temperature 38.0-38.4 °C)", which can be up to 30 minutes per shift.</li><li>Construction workers spent 0–3% of the shift hyperthermic; farm workers 8%.</li><li>The best strategy was **750 ml of water every hour**, plus about 1 tablespoon of salt per shift, plus water sprinkling.</li></ul> | <ul><li>Gives a concrete hydration prescription.</li><li>Supports self-pacing.</li><li>Informed Qatar's Ministerial Decision No. 17 of 2021.</li></ul> |

### 1.6 Kidney injury among heat-exposed workers

- **15%** of workers who typically work in heat had kidney disease or AKI (meta-analysis of 10 studies, 21,721 workers) [P, S8].
- **26.2 million** people live with CKD attributable to workplace heat, about **3%** of all CKD [P, S1, S2].
- One Saudi summer produced an **18%** incidence of kidney injury among construction workers [P, S14].
- The ILO describes CKD of unknown aetiology spreading "in hot, rural regions of the Americas, Africa, the Middle East and India". Over 20,000 deaths within a decade are estimated for Central America alone (Ramirez-Rubio 2013, as cited) [P, S1].
- **Design implication:** hydration and rest prescriptions are kidney-protective as well as heatstroke-protective. Zill should log hydration prompts and acknowledgements. It should **not** make kidney-diagnostic claims (§4.5).

### 1.7 Migrant-worker deaths: careful sourcing (what each number does and does not show)

| Source | What it measures | Numbers | Caveats | OK to cite in the pitch? |
|---|---|---|---|---|
| ILO 2021, *One is too many* (Qatar, 2020 data) [P, S20] | Occupational injuries in the WURQ registry | <ul><li>Detailed information on **50** fatal occupational injuries, **506** severe and **37,601** mild-to-moderate.</li><li>ADLSA/MOPH's final determination: **66** fatal occupational injuries in 2020.</li></ul> | <ul><li>"it is currently not possible to safely present a categorical figure."</li><li>Death certificates often say "cardiac arrest" or "natural causes".</li><li>Heat-related deaths are hard to diagnose post-mortem.</li></ul> | Yes, as a Qatar registry figure with its caveat |
| Pradhan et al. 2019 [P, S15] | Deaths of Nepali workers in Qatar, from Nepal's FEPB records | 150/100,000/yr; about 200 CVD deaths plausibly preventable | Causes poorly recorded; ecological design | Yes, with the "likely" wording |
| Vital Signs Partnership 2022 [S, S22] | Estimated deaths of South and Southeast Asian migrants across the GCC | "as many as **10,000** … appear to die every year in the Gulf, with **more than half** of those deaths effectively unexplained" | Assembled from fragmented government, RTI and informal data. Not specific to heat or to work. | Only as "NGO estimate of all-cause deaths" |
| Amnesty International 2021, *In the prime of their lives* (MDE 22/4614/2021) [P, S23] | Qatar's failure to investigate migrant deaths | Numbers not verified here; the report page excerpt carried none | — | Cite as qualitative only |
| HRW, 8 Aug 2024 [P, S24] | Interviews: 90 workers (May 2023), 15 in the UAE and KSA (Sept 2023), 8 in the UAE and Qatar (July 2024) | No death count | <ul><li>Workers reported fainting and vomiting.</li><li>A foreman threatened "three days' wage deduction" for slowing down in the heat.</li></ul> | Yes, for worker experience and the risk of disciplinary misuse |
| The Guardian, Feb 2021, "6,500 migrant workers died in Qatar since 2010" | Widely reported as all-cause deaths among nationals of 5 South Asian countries. That description is itself **UNVERIFIED**. | **UNVERIFIED here** (page could not be fetched) | Reportedly an all-cause figure, not a heat or work count | **Do not use** as a heat-death figure |

**Rule for the team:** we found **no verified statistic of heat-related deaths among UAE workers**. Do not claim one.

- Use heat-related illness instead. **3,017** heat-related illnesses were reported in Abu Dhabi in 2010, "most" work-related, according to HAAD's Joubert as quoted in *The National* on 27 May 2011 [S, S36].
- Or use the injury and labour-loss estimates above.

### 1.8 Local heat context

- The UAE hit **51.6 °C** at Sweihan (Al Ain) on **24 May 2025**. That is the highest May temperature since NCM records began in 2003; the previous May record was 50.2 °C in 2009 [S, NCM via Gulf Today/Dawn, S37]. It came **before** the 15 June start of the midday ban.
- Qatar's Ministerial Decision No. 17 (2021) is the evidence-based GCC precedent.
  - Initial patient visits for heat-related illness at Qatar Red Crescent clinics fell **58%** in summer 2021, the first summer after the decision. This comes from Figure 7 of the July 2024 ILO report, redrawn from ILO 2021. The same report's text says hospitalisations linked to workplace heat stress were "reduced by more than half" [P, S2 Fig. 7; S20].
  - It is the only GCC rule that stops work on **WBGT > 32.1 °C** at any time of day.

---

## 2. The workforce and the languages needed on Abu Dhabi sites

### 2.1 Size of the workforce

**Abu Dhabi (SCAD, released 30 June 2025, 2024 data)** [P, S44]:

| Indicator | Value |
|---|---|
| Population | **4,135,985** (+7.5% on the revised 2023 figure of 3,847,585) |
| Male | **2,767,060** (67%) |
| Labour force | Release: "over 3.4 million people as part of the workforce", up 9.1%. Census dashboard: "Labour Force **2.76M** Employees". The two figures differ; both are reproduced. |
| Collar split | "44.8 per cent white-collar and **55.2 per cent blue-collar** workers" |
| Construction output | AED 107.4 bn, "contributing **9.1 per cent** to GDP" |

SCAD does not publish a citizen/non-citizen split.

**UAE (FCSC Labour Force Survey via GLMM; page titled 2023)** [S, S47]. Share of employed people by economic activity:

| Activity | Share of employed | Of which men |
|---|---|---|
| Construction | **16.5%** | 20.4% |
| Wholesale and retail | 15.8% | — |
| Manufacturing | 8.6% | — |
| Administrative and support | 7.6% | — |
| Transport and storage | 5.7% | — |
| Mining and quarrying | 4.4% | — |
| Agriculture | 1.5% | — |
| Electricity and similar | 0.7% | — |

Since 2020, these publications no longer split by nationality.

**MoHRE private-sector registrations (Labour Market Information System, compiled by GLMM)** [S, S45, S46]:

| Scope | Construction | All activities |
|---|---|---|
| UAE, 2022 | **1,386,498** | 5,477,366 |
| UAE, 2019 | 1,641,724 | 5,094,783 |
| Abu Dhabi emirate, 2019 | **420,654** | 1,381,819 |

- Abu Dhabi in 2019, by activity:
  - Mining and quarrying: 51,537.
  - Manufacturing: 94,154.
  - Transport, storage and communications: 92,700.
  - Business activities: 223,812.
  - Trade and repair: 219,403.
- Construction is about **30.4%** of Abu Dhabi's MoHRE-registered workforce (2019) and about **25.3%** of the UAE's (2022) [D, Appendix A].
- Caveats:
  - These counts are registrations, not survey estimates, and are not comparable with FCSC totals.
  - We believe they exclude employers not registered with MoHRE, such as most free-zone and government entities. That scope is **UNVERIFIED**.

### 2.2 Who the workers are (nationality)

- **UN DESA International Migrant Stock 2024 (destination: UAE)**: **8,157,000** international migrants at mid-2024 (5,491,000 men, 2,666,000 women) [P/D, S40; extracted by script, Appendix A].

  | Rank | Origin | Mid-2024 | Share |
  |---|---|---|---|
  | 1 | India | 3,248,545 | **39.8%** |
  | 2 | Bangladesh | 1,024,949 | **12.6%** |
  | 3 | Pakistan | 932,356 | **11.4%** |
  | 4 | Egypt | 841,883 | **10.3%** |
  | 5 | Philippines | 528,527 | **6.5%** |
  | 6 | Indonesia | 298,351 | 3.7% |
  | 7 | Yemen | 192,423 | 2.4% |
  | 8 | Jordan | 158,125 | 1.9% |
  | 9 | Sudan | 124,677 | 1.5% |
  | 10 | Sri Lanka | 112,759 | 1.4% |

- **Indian government count:** **4,344,008** overseas Indians in the UAE (4,326,248 non-resident Indians and 17,760 persons of Indian origin), "as of January 2026". This is above UN DESA's figure; the methods differ [P, S41].
- **Kerala, the source of Malayalam speakers:**
  - Kerala has an estimated **2.2 million** emigrants. **38.6%** of them live in the UAE (40.2% of men, 31.6% of women) [P, S42; Kerala Migration Survey 2023].
  - Caveat: the PDF is marked "Draft Report not to be quoted".
  - Derived: about 0.85 million Keralite emigrants in the UAE [D].
- **Nepal, the source of Nepali speakers:**
  - The UAE was the **top destination** for Nepal's 839,266 labour permits in FY2024/25 [S, S43].
  - Reported flows to the UAE are about 201,148 new permits, or 274,590 including renewals.
  - UN DESA's **26,097** Nepalis in the UAE is therefore very likely an undercount [D].

### 2.3 Languages for safety communication (evidence → recommendation)

| Evidence | Languages |
|---|---|
| ADPHC Safety in Heat 2025 awareness package: "35 awareness materials … in six or more languages", **884,200** distributed [P, S29] | Arabic, English, Urdu, Hindi, Tagalog, Bengali |
| ADPHC programme page roll-ups [P, S26]; ADPHC "other languages" tips poster rendered and inspected [P, S28] | Arabic, English, Urdu, Hindi, Bengali, Tagalog |
| HAAD Safety in the Heat 2008 worker and supervisor materials [P, S9] | English, Arabic, Hindi, Urdu, **Malayalam** |
| MoHRE call centre answers in "20 languages, including three main languages" (2023) [S, MoHRE 2023 release per search snippet] | Languages not listed (**UNVERIFIED**) |
| Nationality mix (§2.2) | Indian languages (Hindi, Malayalam, Tamil and others), Bengali, Urdu, Punjabi and Pashto (Pakistan), Arabic (Egypt, Yemen, Sudan, Jordan), Tagalog, Nepali, Sinhala, Indonesian |

**Recommended launch set for Zill (8 languages):**

1. Arabic
2. English
3. Hindi
4. Urdu
5. Bengali
6. Malayalam
7. Tagalog/Filipino
8. Nepali

Tier 2: Tamil, Pashto, Sinhala, Punjabi. Arabic and English are mandatory for DoH research consent forms (§4.6).

Rationale for the eight:

- ADPHC's current six, plus Malayalam (the HAAD 2008 set and the Kerala corridor), plus Nepali (Nepal's top destination).
- Hindi and Urdu are close in their spoken form but use different scripts. Ship both scripts and **voice audio**.

**Low-literacy UX requirements** (supported by evidence):

- Pictograms, plus a colour-coded flag scheme mirroring site flags.
  - Dubai Municipality: green, yellow, amber, red [P, S31].
  - ADNOC: a "unified flag system" [P, S38].
- Short voice notes in the worker's language.
- A urine-colour self-check.
  - 87.7% of HAAD users rated urine-colour posters helpful [P, S9].
  - The ILO recommends urine colour charts [P, S2].
- Tap-only symptom reporting.
- No literacy assumption at consent: the DoH standard requires an **impartial witness** when a participant cannot read [P, S70].
- No official statistic on literacy among UAE migrant workers was found (**UNVERIFIED**). Design for low literacy regardless.

---

## 3. Competitive landscape

### 3.1 Products

| Product | What it does (verified) | Public price | Gaps relative to Zill (from public materials, Nov 2026) |
|---|---|---|---|
| **Kenzen** | <ul><li>Arm-worn device. Sensors: "heart rate, activity, skin and ambient temperatures".</li><li>"real-time prediction of core body temperature".</li><li>Alerts: vibration and an iOS/Android app for the worker, a web dashboard for the supervisor.</li><li>"Sold as a subscription … per worker per month" [S, S48, 15 May 2020].</li><li>As of Nov 2026, kenzen.com presents the company as a "global occupational health and safety professional services company" with a "Heat Stress & Illness" service [P, S48b]. Current product status is unclear.</li></ul> | Not public | <ul><li>Physiology claim (core-temperature prediction) carries medical-device exposure.</li><li>Supervisor-centric.</li><li>No GCC languages, UAE rules or worker data governance documented.</li></ul> |
| **SlateSafety** | <ul><li>BAND V2: a "physiological monitoring device which assesses safety and sends real-time alerts", covering heat illness, fall, no-movement and SOS.</li><li>BEACON V3 environmental sensor: ambient temperature, **estimated WBGT** and heat index.</li><li>Web platform and "SlateSafety Go" apps, configurable thresholds, SOC-2, API [P, S49].</li></ul> | <ul><li>BAND V2 **$821.85** each (Levitt-Safety, a Canadian retailer; currency not stated) [S, S49b].</li><li>Distributor listings say "Annual Portal Access" is required per device; price not shown (**UNVERIFIED**).</li></ul> | <ul><li>Per-worker hardware plus subscription.</li><li>Cloud dependency.</li><li>No Arabic or South-Asian UX documented.</li><li>No UAE rule mapping.</li><li>No "not a medical device" statement found.</li></ul> |
| **Epicore Biosystems (Connected Hydration)** | <ul><li>A single-use sweat patch plus a reusable module. Measures "sweat loss, electrolyte loss, temperature, thermal flux, and motion".</li><li>Haptic "hydrate" alerts.</li><li>Bluetooth to a phone app, then to the cloud.</li><li>Coin battery lasting more than 1,000 h [S, S50b; P, S50].</li></ul> | Not public | <ul><li>Consumable cost per shift.</li><li>Needs a phone in Bluetooth range.</li><li>Hydration only; no work-rest scheduling or UAE rules.</li></ul> |
| **Zephyr BioHarness 3** | <ul><li>Chest-strap monitor: HR (0–240 bpm ±1), respiration, activity, posture.</li><li>"Estimated core body … temperature 91° to 106° F ± 2° (33° to 41° C)" [S, S53].</li><li>Core temperature estimated from heart rate by the ECTemp algorithm, developed by USARIEM and licensed to Zephyr. Air Force users reported identifying and mitigating "over 30 cases of heat stress" [S, army.mil, 24 Apr 2017].</li></ul> | Kit **$3,970** (RAE listing; currency not stated) [S, S53] | <ul><li>Research and military grade.</li><li>Costly.</li><li>Chest strap is a comfort and acceptance barrier in heat.</li></ul> |
| **Equivital EQ02+ LifeMonitor / Black Ghost** | <ul><li>Core temperature from an ingestible capsule (reading every 15 s), or a software estimate "instead of the pill".</li><li>Heat strain index levels 1–12, with a prediction 15 min ahead.</li><li>Targets first responders and the military [P, S51].</li></ul> | Not public | <ul><li>Military and first-responder focus.</li><li>Clinical-grade sensing.</li><li>No worker UX for migrant workforces.</li></ul> |
| **Hexoskin** | Smart-shirt physiological monitoring (ECG, respiration, activity) | Smart Kit **US$849**; Pro Kit **US$899**; shirts $199/$249; device $650 [P, S52] | Research and wellness focus; garment per worker |
| **OSHA-NIOSH Heat Safety Tool** | <ul><li>Free app showing a real-time **heat index** for the user's location.</li><li>Hourly forecast with risk levels and precautions; symptoms and first aid; English and Spanish.</li><li>"**is not receiving updates at this time**" (page dated 3 Mar 2026) [P, S54].</li></ul> | Free | <ul><li>Heat index only, not WBGT or TWL.</li><li>US thresholds, no Gulf languages, no worker–supervisor loop.</li><li>Not maintained.</li></ul> |
| **TWL meters and stations** (Kestrel 5400; Scarlet Tech TWL-1S) | <ul><li>Kestrel 5400 measures WBGT **and TWL** and links to a phone over Bluetooth [P, S57].</li><li>TWL-1S displays a work-rest schedule and hydration plan with colour backlight, and triggers "a remote pager" [P, S60].</li></ul> | Kestrel 5400 **$479–629** on the vendor site [P, S57] | Site instruments only: no worker messaging, symptom loop or governance. These are **integration partners**, not competitors. |

### 3.2 Regional programmes and rules that Zill must map to

| Jurisdiction or programme | Rule or content (verified) | Tag |
|---|---|---|
| **UAE federal (MoHRE) midday break**, "Occupational Heat Stress Prevention Policy" | <ul><li>No work "under direct sunlight and in open areas from **12:30pm to 3pm** daily between **June 15 and September 15**".</li><li>Fine of "**Dh5,000 per worker**", up to "**Dh50,000** in cases involving multiple workers"; possible file suspension or downgrade in the MoHRE tier system.</li><li>Employers must provide "shaded rest areas suitable for the number of workers", cold water, "hydration products such as electrolytes", fans or mechanical cooling, and first aid.</li><li>Exemptions: repairs to essential services (water, electricity, telecoms), traffic-critical work and permit-bound work.</li><li>Reporting line: 600590000.</li></ul> | [S, S32, Khaleej Times 6 Jul 2026] |
| — status and history | <ul><li>2026 was the 22nd year of the ban (in effect 15 Jun–15 Sep 2026) [S, S33].</li><li>2025 compliance: 99% (MoHRE release title, 15 Sep 2025) [P (title only), S35].</li><li>Legal basis cited by the ILO: Ministerial Decree No. 401 of 2015 [P, S2].</li><li>Press coverage of the 2025–2026 announcements also lists technically uninterruptible work as exempt, such as asphalt laying or concrete pouring that cannot be postponed. This rests on search snippets; the MoHRE releases (S34) were unreachable [S].</li></ul> | [S]/[P] |
| **Abu Dhabi: ADPHC "Safety in Heat"** | <ul><li>Programme aimed at managers, supervisors, workers and trainers.</li><li>Restates the 12:30–15:00 midday rule.</li><li>Publishes the **TWL working-zone sheet** (§3.3), a bilingual document titled "OSHAD_Heatstress_Technical_Info_Sheet3", created June 2020 [P, S26, S27].</li><li>11-year cumulative reach: ">**9 million** individuals" through **22,164** awareness and inspection visits (21 Sep 2025) [P, S29].</li></ul> | [P] |
| **Abu Dhabi OSH framework (OSHAD-SF), CoP 11.0 "Safety in the Heat"** | <ul><li>Secondary sources cite version 3.1.</li><li>*The National* (2011) reported HAAD planning to give TWL legal force: "A TWL below 115 is regarded as unsafe"; at that level, 20 min of work then 40 min of rest, and 600 ml of water every half hour [S, S36].</li></ul> | Code text **UNVERIFIED** (not retrieved) |
| **Sharjah: OSHJ-CoP-33 "Safety in Heat"**, Version 2 Rev 0, July 2024 | Four TWL zones with interventions, hydration and work-rest (§3.3) | [P, S30] |
| **Dubai Municipality**, DM-HSD-GU38-MHSW2, *Technical Guidelines for Management of Heat Stress at Work* | <ul><li>V2.0 (8 Oct 2019), heat-index risk levels:<ul><li>"Up to 34 ºC: Low risk (caution)"</li><li>"35 to 39 ºC: Moderate"</li><li>"40 to 45 ºC: High"</li><li>"46 ºC and above: Very high"</li></ul></li><li>Risk changes may be communicated "through telecommunication/mobile messaging or using flag system (… red for very high risk, amber for high risk, yellow for medium risk and green for low or no risk)".</li><li>Core-temperature targets during rest, verbatim: "less than or equal to 38.5 ºC for acclimatized and less than or equal to 38 ºC for acclimatized workers". The second "acclimatized" is presumably a typo for "unacclimatized".</li><li>V3.0 (May 2024) exists, but its URL now redirects; thresholds not re-verified.</li></ul> | [P, S31] |
| **Qatar**, Ministerial Decision No. 17 (May 2021) | <ul><li>No outdoor work "between **10:00 and 15:30** from **1 June to 15 September**".</li><li>"all work must stop when the wet-bulb globe temperature (WBGT) exceeds **32.1°**", regardless of time.</li><li>Annual health checks and mandatory risk assessments.</li></ul> | [P, S21]. The ILO April 2024 report writes "10 a.m. and 3 p.m.", but ILO's 2021 news and the July 2024 ILO report both say 15:30 ("3:30 p.m."). The decision text itself was not retrieved. |
| **Saudi Arabia** | <ul><li>Outdoor work prohibited **12:00–15:00, 15 June–15 September** (Ministerial Resolution 3337 of 2014; MHRSD with the National Council for OSH).</li><li>Heat-index tiers, as summarised by the ILO:<ul><li>25–29 °C: low risk.</li><li>30–38 °C: moderate; **25%** of work time on breaks.</li><li>39–51 °C: high; **50%**.</li><li>≥52 °C: extreme; **75%**.</li><li>Work suspended at HI ≥ **56 °C**.</li></ul></li><li>Hydration every 15–20 min.</li></ul> | [P (ILO summary), S2] / [S, S94] |
| **Bahrain** | No outdoor work 12:00–16:00, 1 July–31 August (Order No. 3 of 2013). Oil and gas and emergency maintenance are excluded. | [P, S2] |
| **ADNOC** | <ul><li>"Heat stress is an occupational health risk across ADNOC's operations".</li><li>Annual "**Beat the Heat**" campaign and a "**unified flag system**".</li><li>"In 2025 … piloting **wearable sensors** to detect early signs of heat strain."</li></ul> | [P, S38] |
| **Abu Dhabi Department of Energy** | <ul><li>Annual Safety in Heat campaign for energy-sector facilities and project sites.</li><li>About 70 workshops over three months, plus site visits (25 Jun 2026).</li></ul> | [P, S39] |

### 3.3 Port-ready TWL rule tables (verbatim sources and engine conventions)

**A. ADPHC (Abu Dhabi) "Thermal Work Limit – Working Zones"** [P, S27]. Text transcribed from the rendered PDF:

| Zone (printed) | TWL (W/m², printed) | Interventions (verbatim) | Rehydration (per h) | Work-rest (min) |
|---|---|---|---|---|
| **Low Risk / Unrestricted Zone** | "TWL: 140 - 220 <" | "No limits on self-paced work for educated, hydrated workers." | Light work: "600 ml - 1 Litre / hr" | "Safe for all continuous self-paced work" |
| **Medium Risk / Cautionary Zone** | "TWL: 115 – 140" | <ul><li>"Cautionary zone indicates situations in which environmental conditions require additional precautions."</li><li>"Practicable Engineering control measures to reduce heat stress should be implemented, e.g. provide shade, improve ventilation, etc."</li><li>"Working alone to be avoided"</li><li>"No unacclimatised person to work"</li><li>"Ensure adequate fluid intakes appropriate for type of work"</li></ul> | <ul><li>Light work: "1 -1.2 Litres / hr"</li><li>Heavy work: "> 1.2 Litres / hr *"</li></ul> | <ul><li>Light: "Safe for continuous self-paced light work"</li><li>Heavy: "Continuous paced work 45 work - 15 rest"</li></ul> |
| **High Risk Zone** | "TWL: < 115" | <ul><li>"Strict Work/Rest cycling required"</li><li>"No person to work alone"</li><li>"No unacclimatised person to work"</li><li>"High Risk induction required emphasising hydration and identifying signs of heat strain"</li><li>"Provide personal water bottle (2 litre capacity) on-site at all times"</li></ul> | All work: ">1.2 Litres / hr *" | <ul><li>Light work: "45 work – 15 rest"</li><li>Heavy work: "20 work - 40 rest"</li></ul> |

Notes printed on the sheet (verbatim):

- Self-paced work: "workers must be allowed to adjust their work rate according to workplace conditions".
- Paced work: "the work rate is not under the worker's control".
- Unacclimatised workers: "new workers or those who have been off work for more than **14 days** due to illness or on vacation leave (in a cool climate area)".
- Light work: "sitting or standing, light arm work".
- Heavy work: "carrying, climbing, lifting, pushing, whole-body work".
- The asterisk: "At high workloads and or thermal stress, sweat rates exceed 1.2 Litres / hr. Increasing fluid intake much above this level is not practical due to gastric discomfort as the upper limit for gastric emptying and fluid absorption is ~ 1.5 Litres / hr …"

Engine conventions [D]:

- Read "140 - 220 <" as **TWL ≥ 140** (that is, 140–220 and above).
- Boundaries are not specified, so apply them conservatively:
  - High if TWL < 115.
  - Medium if 115 ≤ TWL ≤ 140.
  - Low if TWL > 140.

**B. Sharjah OSHJ-CoP-33 v2 (July 2024), Table 3** [P, S30]:

| Zone | TWL | Interventions (verbatim excerpts) | Rehydration (per h) | Work-rest (min) |
|---|---|---|---|---|
| High Risk | "<115" | "No ordinary work allowed"; "Work limited to essential maintenance or rescue operations" | **1.5 L** | Self-paced light 45/15; self-paced heavy **20/40** |
| Medium Risk | "115 to 140" | <ul><li>"Any practical intervention to reduce heat stress should be implemented".</li><li>"Acclimatised employees not allowed to work". This appears to be a typo for "un-acclimatised" (compare the ADPHC sheet); **UNVERIFIED**.</li><li>"No person to work alone".</li></ul> | **1.2 L** | Light: continuous self-paced. Heavy: **40/20** |
| Low Risk | "140 to 220" | "No limit on self-paced work for educated self-paced workers"; "… allowed to work, but not alone" | **1 L** | All continuous self-paced light and heavy work |
| Unrestricted | ">220" | "No limits on work due to thermal stress" | **0.5 L** | Continuous paced light and heavy work |

The code defines TWL inputs as dry-bulb temperature, wet-bulb temperature, globe temperature (°C) and wind speed (m/s). It assumes workers are "hydrated and acclimatised … and are self-paced". The original TWL index is Brake & Bates 2002, *Appl Occup Environ Hyg* 17:176–86 [P, S92].

**Differences the engine must handle:**

- ADPHC has 3 zones and Sharjah has 4.
- In the high-risk zone, ADPHC allows work under strict cycling, while Sharjah allows no ordinary work.
- Medium-zone heavy work is 45/15 paced (ADPHC) versus 40/20 self-paced (Sharjah).
- Hydration targets differ: >1.2 versus 1.5 L/h, and 1–1.2 versus 1.2 L/h.

Therefore rule packs must be **jurisdiction-selectable and versioned**. Abu Dhabi sites default to ADPHC.

**C. Rule-pack data** for transcription into TypeScript. Values come from the sources above; boundary handling is our conservative choice [D].

```json
{
  "AE-MOHRE-MIDDAY-2026": {
    "source": "MoHRE Occupational Heat Stress Prevention Policy (22nd year, 2026); Khaleej Times 2026-07-06; ILO 2024 citing MD 401/2015",
    "timezone": "Asia/Dubai (UTC+4, no DST)",
    "season": {"start": "06-15", "end": "09-15", "inclusive": true},
    "window": {"start": "12:30", "end": "15:00"},
    "applies_to": "work under direct sunlight and in open areas",
    "exemptions": ["essential-service fault repair (water, electricity, telecom)", "traffic-critical work", "permit-bound work", "technically uninterruptible work e.g. asphalt/concrete (press coverage; snippet-level)"],
    "employer_duties": ["shaded rest areas sized to workforce", "cold water", "electrolytes", "fans/mechanical cooling", "first aid"],
    "penalty_aed": {"per_worker": 5000, "max": 50000}
  },
  "AE-AZ-ADPHC-TWL": {
    "source": "ADPHC Thermal Work Limit - Working Zones (OSHAD tech info sheet 3, 2020/2021)",
    "zones": [
      {"id": "HIGH",   "twl_lt": 115, "light_work_rest": [45, 15], "heavy_work_rest": [20, 40], "fluid_l_per_h": ">1.2", "no_lone_work": true, "no_unacclimatised": true, "personal_bottle_l": 2},
      {"id": "MEDIUM", "twl_gte": 115, "twl_lte": 140, "light": "continuous self-paced OK", "heavy_or_paced_work_rest": [45, 15], "fluid_l_per_h": {"light": [1.0, 1.2], "heavy": ">1.2"}, "avoid_lone_work": true, "no_unacclimatised": true},
      {"id": "LOW",    "twl_gt": 140, "rule": "no limits on self-paced work for educated, hydrated workers", "fluid_l_per_h": {"light": [0.6, 1.0]}}
    ],
    "unacclimatised_days_off": 14
  },
  "AE-SHJ-OSHJ-COP33-V2": {
    "source": "Sharjah SPSA OSHJ-CoP-33 Safety in Heat v2 Rev0 (Jul 2024) Table 3",
    "zones": [
      {"id": "HIGH",         "twl_lt": 115, "ordinary_work": false, "light_work_rest": [45, 15], "heavy_work_rest": [20, 40], "fluid_l_per_h": 1.5},
      {"id": "MEDIUM",       "twl_gte": 115, "twl_lte": 140, "heavy_work_rest": [40, 20], "fluid_l_per_h": 1.2, "no_lone_work": true},
      {"id": "LOW",          "twl_gt": 140, "twl_lte": 220, "fluid_l_per_h": 1.0},
      {"id": "UNRESTRICTED", "twl_gt": 220, "fluid_l_per_h": 0.5}
    ]
  },
  "AE-DU-DM-HI-V2": {
    "source": "Dubai Municipality DM-HSD-GU38-MHSW2 V2.0 (2019)",
    "levels": [
      {"id": "LOW_CAUTION", "hi_c_lte": 34, "flag": "green"},
      {"id": "MODERATE", "hi_c_gt": 34, "hi_c_lte": 39, "flag": "yellow"},
      {"id": "HIGH", "hi_c_gt": 39, "hi_c_lte": 45, "flag": "amber"},
      {"id": "VERY_HIGH", "hi_c_gt": 45, "flag": "red"}
    ]
  },
  "QA-MOL-MD17-2021": {"source": "ILO Qatar 2021-05-27", "season": {"start": "06-01", "end": "09-15"}, "window": {"start": "10:00", "end": "15:30"}, "stop_all_work_if_wbgt_c_gt": 32.1},
  "SA-MHRSD-3337": {"source": "ILO Heat at work 2024 (summary)", "season": {"start": "06-15", "end": "09-15"}, "window": {"start": "12:00", "end": "15:00"},
    "hi_tiers": [{"hi_c": [25, 29], "risk": "low"}, {"hi_c": [30, 38], "risk": "moderate", "break_fraction": 0.25}, {"hi_c": [39, 51], "risk": "high", "break_fraction": 0.50}, {"hi_c_gte": 52, "risk": "extreme", "break_fraction": 0.75}], "suspend_if_hi_c_gte": 56}
}
```

Engine rule [D]: **the most protective applicable rule wins.** For example, the midday window overrides a "LOW" TWL. Zill must never relax a legal minimum.

### 3.4 Gap analysis: where Zill wins

| Gap in the market (evidence) | Zill response |
|---|---|
| **Worker governance.** Vendors market dashboards to safety leaders [P, S49]. The ILO code says monitoring data must not be the sole basis for performance evaluation and that workers' representatives should be consulted "before the introduction of any electronic monitoring" [P, S73]. HRW documents threatened wage deductions for slowing down [P, S24]. | <ul><li>Worker-first data model: the worker sees and controls personal data.</li><li>The employer sees crew-level actions only.</li><li>Contractual ban on disciplinary and insurer use (§6.2).</li></ul> |
| **Multilingual, low-literacy UX.** No public evidence of Arabic or South-Asian-language worker interfaces in any vendor listed. ADPHC already needs 6+ languages [P, S29]. | <ul><li>8 launch languages with voice and pictograms.</li><li>WhatsApp delivery (no app install).</li></ul> |
| **Offline operation.** Epicore needs a phone over Bluetooth [S, S50b]. SlateSafety and Kenzen are cloud SaaS [P, S49; S, S48]. | <ul><li>Rule engine runs on-device or on a site gateway from cached forecasts and TWL station input.</li><li>SMS and flag fallback.</li><li>The DM guideline explicitly endorses mobile messaging plus flags [P, S31].</li></ul> |
| **Local rules.** No vendor documents MoHRE midday, ADPHC TWL or OSHJ-CoP-33 logic. The NIOSH app uses US heat-index thresholds [P, S54]. | <ul><li>Versioned rule packs (§3.3).</li><li>Audit trail of which rule fired.</li><li>Exportable compliance evidence for MoHRE and ADPHC inspections.</li></ul> |
| **Cost.** Wearables cost $479–3,970 per unit plus subscriptions (§3.1). | <ul><li>Software-first.</li><li>A wearable is optional, and Zill integrates rather than sells hardware.</li></ul> |

---

## 4. Governance: data protection, health regulation, AI, worker rights and device status

### 4.1 UAE data protection

**Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data (PDPL).**

- **Status and basic facts:**
  - In force since **2 January 2022**; the UAE Data Office is the federal regulator [P, S64].
  - As of March 2026 the PDPL was "expected to be fully enforceable once the executive regulations are in place" [S, S61].
  - Our searches found conflicting claims that the executive regulations had been issued in 2026, citing three different and mutually inconsistent decision numbers. Status of the executive regulations: **UNVERIFIED; treat as pending**.
- **Scope exclusions**, per secondary summaries (official text blocked):
  - Government data and entities.
  - Security and judicial data.
  - "Health personal data that has legislation regulating its protection and processing".
  - Free-zone entities with their own laws, such as ADGM and DIFC [S, S61, S62].
- **Sensitive personal data** covers data revealing "race, ethnicity, political or philosophical views, religious beliefs, criminal records, **biometric data**, or any data related to the **health** of such person" [S, S62].
  - Biometric data is "Personal Data resulting from Processing, using a specific technique, relating to the physical, physiological or behavioral characteristics of a Data Subject …" [S, S62].
  - **Every Zill symptom report and every wearable signal is sensitive data.**
- **Consent:**
  - Must be "specific, informed and unambiguous", given "by a statement or by a clear affirmative action in writing or electronic form".
  - "The data controller must be able to prove that the data subject gave consent."
  - "Data subjects may withdraw their consent at any time" [S, S62].
- **Processing without consent** (Article 4 per secondary sources). Permitted cases include:
  - public interest;
  - legal claims;
  - **"occupational or preventive medicine"**;
  - public health;
  - scientific or statistical studies;
  - "exercising legally established rights in the field of employment";
  - performance of a contract [S, S61].
  - There is **no legitimate-interests basis** [S, S62].
- **DPO:** required where processing involves large amounts of sensitive data or poses high risk. The DPO may be external and need not be based in the UAE [S, S62].
- **DPIA (Article 21):** required before processing that uses new technologies with high privacy risk. Two named cases:
  - "systematic and comprehensive assessment of the personal aspects" by automated processing, including profiling (21(2)(a));
  - "a large volume of Sensitive Personal Data" (21(2)(b)) [S, S63].
  - **A Zill deployment triggers a DPIA.**
- **Breaches:** must be notified to the Data Office and to affected data subjects. "There is no materiality threshold for triggering the requirement to notify a data subject" [S, S62].
- **Cross-border transfers:** permitted to "adequate" jurisdictions. The list was not yet published at the time of the cited summary. Otherwise controls are to be set in the regulations [S, S62].

**Federal Law No. 2 of 2019 on the Use of ICT in Health Fields (the ICT Health Law).**

- **Scope:** "all Information and Communication Technology (ICT) methods and uses in the health fields in the State, including the Free Zones" [S, Al Tamimi via search; u.ae S64].
  - Health data is defined as health information given a "visual, audible or readable indication" [S, S66].
- **Localisation (Article 13):** health data relating to health services provided in the UAE may not be stored, processed, generated or transferred outside the UAE except as permitted [S, S65, S66].
- **Ministerial Decision No. 51 of 2021** sets exceptions, each with conditions such as consent, encryption, anonymisation and a local copy [S, S65]:
  - treatment abroad;
  - lab samples;
  - scientific research (health-authority approval, encryption, anonymisation);
  - insurance;
  - cooperation with the state;
  - pharmacovigilance;
  - online health;
  - patient request.
  - Emirate health authorities may approve further transfers if a local copy is kept [S, S65].
- **Which regime applies to Zill?** This is our analysis and needs legal confirmation [D]:
  - If Zill is deployed **inside a DoH-licensed occupational health service or a DoH-approved study**, worker health data is plainly "health data" under the ICT Health Law. Article 13 localisation then applies, along with ADHICS (below).
  - If deployed as **employer occupational-safety software**, the PDPL's sensitive-data rules apply. It is unsettled whether the ICT Health Law also applies.
  - **Design to satisfy both:**
    - host in the UAE (e.g., Azure UAE North, Dubai, or UAE Central, Abu Dhabi) [P, Microsoft Learn regions list];
    - consent-first, with a separate legal basis documented;
    - DPIA;
    - encryption;
    - no offshore copies without a Ministerial Decision 51/2021 basis.

### 4.2 Abu Dhabi Department of Health instruments

| Instrument | Key facts | How it touches Zill |
|---|---|---|
| **ADHICS: Abu Dhabi Healthcare Information and Cyber Security Standard, V2** | <ul><li>Document DOH/SD/ICSO/ADHICS/V2/2024, published May 2024, effective August 2024.</li><li>Applies to any health-sector "entity" that stores or processes health information from Abu Dhabi.</li><li>Covers entity-owned systems and their use of third-party systems.</li><li>[P via search index of the DoH PDF, S67; the DoH host was unreachable for direct download.]</li></ul> | Any DoH-licensed partner (site clinic, OH provider, research facility) will require ADHICS-aligned controls from Zill as a third-party system. |
| **DoH Policy on the Use of AI in the Healthcare Sector** (2018) | <ul><li>"the region's first emirate-level AI governance framework".</li><li>Six principles: "transparency, user assistance, safety and security, privacy, ethics, and accountability".</li><li>Requires governance structures, plus "regular audits of AI functionality with reporting obligations to DOH" [S, S69].</li></ul> | Applies to DoH-licensed entities and to users of Abu Dhabi patient or population data for AI [S, S69]. |
| **DoH Responsible AI Standard** | <ul><li>DoH/ST/DDGO/RAI/V1/2025. New. Published and effective **October 2025**; revision due October 2026.</li><li>Owner: Data and Digital Governance Office.</li><li>Sets "minimum requirements to operationalizing responsible AI across healthcare eco-system in Abu Dhabi".</li><li>Applies to "the DoH and all licensed healthcare entities".</li><li>Points cybersecurity to ADHICS [P via search index, S68].</li><li>Adds "updated technical and data privacy conditions … transparency and explainability requirements" [S, S69].</li></ul> | <ul><li>Clause-level text was **not retrieved** (UNVERIFIED).</li><li>The Biomedical Research standard requires compliance with it for any DoH-approved study [P, S70 §3.1.2.3].</li><li>So the Zill pilot must comply.</li></ul> |
| **DoH Standard for Biomedical Research** | <ul><li>DoH/SD/HLSS/SBR/V1/2026, **April 2026**; revision Sept 2026 [P, S70].</li><li>Scope includes "non-interventional clinical research, observational studies, registries".</li><li>"Other Clinical Research" includes "Research Projects on humans that involve … collecting personal health data on individuals, such as health survey projects".</li></ul> | <ul><li>A Zill pilot that collects worker symptom data is in scope.</li><li>Pilot requirements are in §4.6.</li></ul> |

### 4.3 UAE AI principles

- **The UAE Charter for the Development & Use of AI** (UAE AI Office, July 2024) [P, S71]. Its 12 principles:
  1. Strengthening Human-Machine Ties.
  2. Safety.
  3. Algorithmic Bias.
  4. Data Privacy.
  5. Transparency.
  6. **Human Oversight**: "the irreplaceable value of human judgment and human oversight over AI … to correct any errors or biases".
  7. Governance and Accountability.
  8. Technological Excellence.
  9. Human Commitment.
  10. Peaceful Coexistence with AI.
  11. Promoting AI Awareness for an Inclusive Future.
  12. Commitment to Treaties and Applicable Laws.
- **UAE AI Ethics Principles and Guidelines** (Minister of State for AI, Dec 2022): voluntary and non-binding. The principle list varies across summaries; the exact list is **UNVERIFIED** [S, S72].
- **Zill mapping:**
  - Human oversight: the supervisor or first-aider confirms every escalation, and the worker can always self-declare stopping.
  - Algorithmic bias: report alert rates by language, nationality group and age band in the pilot.
  - Transparency: every prescription shows the rule and input that triggered it.
  - Data privacy: see §4.1.

### 4.4 ILO conventions and worker rights for workplace biometric monitoring

- **The 2022 decision on fundamental principles.** The 110th International Labour Conference (10 June 2022) made "a safe and healthy working environment" a fundamental principle and right at work, and designated **C155** and **C187** as fundamental conventions [P, S76]. All member states must respect and promote the principle regardless of ratification [P, S76].
- **C155** (Occupational Safety and Health, 1981). Text verified from secondary reproductions [S, S74]:
  - **Article 13** protects a worker "who has removed himself from a work situation which he has reasonable justification to believe presents an imminent and serious danger to his life or health" from undue consequences.
  - **Article 19(f)**: workers report imminent danger, and the employer cannot require a return while the danger continues.
  - **Article 21**: "Occupational safety and health measures shall not involve any expenditure for the workers."
  - → Zill must be **free to workers**, provide on employer-paid devices or data, and support a self-declared "I am stopping".
- **C161** (Occupational Health Services, 1985), **Article 12**: "The surveillance of workers' health in relation to work shall involve no loss of earnings for them, shall be free of charge and shall take place as far as possible during working hours" [S, S75 copy of text].
  - → Prescribed rest must be **paid time**. Put this in the employer contract.
- **ILO code of practice, *Protection of workers' personal data* (1997)** [P, S73], verbatim:

  | Clause | Text |
  |---|---|
  | 5.4 | "Personal data collected in connection with technical or organizational measures to ensure the security and proper operation of automated information systems should not be used to control the behaviour of workers." |
  | 5.5 | "Decisions concerning a worker should not be based solely on the automated processing of that worker's personal data." |
  | 5.6 | "Personal data collected by electronic monitoring should not be the only factors in evaluating worker performance" |
  | 5.13 | "Workers may not waive their privacy rights." |
  | 6.7 | Medical data only "in conformity with national legislation, medical confidentiality and the general principles of occupational health and safety, and only as needed" for fitness for employment, OSH requirements and social benefits. |
  | 6.14(1) | Monitored workers "should be informed in advance of the reasons for monitoring, the time schedule, the methods and techniques used and the data to be collected", and the employer "must minimize the intrusion". |
  | 6.14(3) | "Continuous monitoring should be permitted only if required for health and safety or the protection of property." |
  | 8.2 | Medical data "should be stored only by personnel bound by rules on medical secrecy and should be maintained apart from all other personal data." |
  | 10.1 | No communication to third parties "without the worker's explicit consent" unless one of the listed exceptions applies, including "to prevent serious and imminent threat to life or health". |
  | 10.2 | No communication "for commercial or marketing purposes" without consent. |
  | 10.8–10.9 | The employer receives only conclusions relevant to the employment decision, with "no information of a medical nature". |
  | 12.2 | Workers' representatives are informed and consulted "before the introduction of any electronic monitoring of workers' behaviour". |

- **UAE ratification status:**
  - The UAE describes nine ratified ILO conventions. HRW (2006) lists them as C1, C29, C81, C89, C100, C105, C111, C138 and C182 [S, S78].
  - The UAE ratified the **2014 Protocol to C29** on **15 January 2026** [P, S77].
  - C155, C187 and C161 are **not** among the nine listed. NORMLEX was unreachable to confirm, so this is **UNVERIFIED**.
  - Trade unions are "banned or restricted" in Gulf states [P, S24].
  - Zill therefore needs a **substitute voice mechanism**: an elected worker safety committee per site, plus an independent ombudsperson channel in workers' languages. This is our design proposal [D].
- **Acceptance evidence:**
  - OSH professionals named "employee privacy/confidentiality of collected data" as a top barrier to adopting wearables (952 respondents) [P, S89].
  - Employee acceptance is highest for safety use cases. Acceptance improves when employees are involved in choosing devices and "adequately informing them about data use" (1,273 respondents) [P, S90].

### 4.5 Is Zill a regulated medical device in the UAE? Intended-purpose framing

- **Regulator and law** [S, S80, S81, S82]:
  - The **Emirates Drug Establishment (EDE)** was established by Federal Decree-Law No. 28 of 2023 (date reported as 25 or 29 Sept 2023).
  - EDE is the federal regulator under **Federal Decree-Law No. 38 of 2024** on medical products, the pharmacy profession and pharmaceutical establishments.
    - It is in force from **2 January 2025** and replaces Federal Law No. 8 of 2019.
    - Grace period of one year; fines up to AED 1 million.
  - MOHAP services were transferred to EDE; secondary sources report completion on 29 Dec 2025.
  - The SaMD definition and classification rules sit under the 2024 law. The UAE uses four risk classes (I–IV) [S, S81].
  - The verbatim statutory definition could not be retrieved (portal blocked): **UNVERIFIED**.
- **Reference definition.** EU MDR Art. 2(1) covers "software … intended by the manufacturer … for … diagnosis, **prevention, monitoring, prediction, prognosis**, treatment or alleviation of disease" [P, S79]. Wellness apps "without diagnostic capabilities" typically need no approval in the UAE [S, S81].
- **US comparator.** The FDA revised its *General Wellness: Policy for Low Risk Devices* guidance on **6 Jan 2026**, superseding the 2019 version. It now expressly includes wearables that monitor physiological characteristics when the intended use is wellness only [S, S83].
- **Our recommended intended-purpose statement** [D], to be used verbatim in the product, contracts and pitch:
  > *Zill is occupational safety software. It helps employers and workers apply the heat-stress controls set out in UAE occupational safety rules: the MoHRE midday break, and ADPHC/OSHAD Thermal Work Limit work-rest and hydration schedules. It converts site environmental measurements and forecasts into work-rest and hydration schedules. It delivers multilingual safety instructions. It records worker-reported symptoms in order to trigger the employer's first-aid and escalation procedure. Zill does not diagnose, treat, monitor or predict any disease or medical condition in an individual, and it is not a substitute for first aid or medical care.*
- **Claims to avoid:**
  - "predicts heat stroke" or "detects heat exhaustion";
  - "estimates core body temperature";
  - "screens fitness for work";
  - "prevents kidney disease";
  - any individual risk score presented as a medical risk.
- **Claims that are fine:**
  - "implements ADPHC TWL work-rest schedules";
  - "schedules rest and hydration";
  - "escalates symptom reports to your first-aider";
  - "compliance log for the MoHRE midday break".
- **Wearable add-ons** (adapting alerts to individual HR or skin temperature) move Zill toward "monitoring/prediction". Before doing so:
  1. use only hardware already cleared by the FDA or carrying a CE mark for that purpose;
  2. obtain a written EDE qualification and classification opinion;
  3. if needed, run it as a DoH-approved study.

  This is our recommendation [D].

### 4.6 What a pilot needs (checklist)

1. **Ethics approval under the DoH Standard for Biomedical Research (2026)** [P, S70]:
   - Submit to the facility REC/IRB and the DoH-IRB (ADHRTC) concurrently.
   - Within 5 working days of a preliminary application, "the DoH Medical Research Department will provide guidance … on the correct pathway".
   - The REC sets the review tier: Exempt, Expedited or Full.
     - "Research involving vulnerable populations … is rarely exempt."
     - "Minimal risk" means harms "not greater than those ordinarily encountered in daily life".
2. **Workers count as vulnerable participants.** The DoH definition covers people who may be influenced by "a retaliatory response from senior members of a hierarchy". Examples include "members of a group with a hierarchical structure" and "unemployed or impoverished individuals" [P, S70].
   - So **supervisors must not obtain consent**.
   - For public-health studies without clinical interventions, consent may be taken by **trained research staff** [P, S70 §3.11.2.5].
   - The REC must include members experienced with such populations [P, S70].
3. **Consent documents:**
   - Drafts "must be provided in both **Arabic and English** languages, and both should have same text" [P, S70 §3.5.3.2.4].
   - Add the 6 worker languages, with authenticated translations; supportive documents must be in English or carry an authenticated English translation.
   - Language must be "clear, practical, and understandable … non-technical and non-exculpatory".
   - An **impartial witness** signs if the participant cannot read [P, S70].
   - Offer a free choice to decline or withdraw with no consequence. This follows the ILO code: workers may not waive privacy rights; no disciplinary use [P, S73].
4. **Data:**
   - DPIA under PDPL Art. 21 [S, S63].
   - ADHICS-aligned controls; the standard cites them [P, S70 §3.1.2.4].
   - Any data leaving the UAE must follow Ministerial Decision 51/2021, be encrypted, and come only from DoH-IRB-approved studies; global studies must remove PHI/PII [P, S70 §3.3.1.1.11.3].
   - Comply with the Responsible AI Standard [P, S70 §3.1.2.3].
5. **Insurance:**
   - "for interventional clinical trials, insurance is mandatory" [P, S70 §3.7].
   - A non-interventional, minimal-risk feasibility pilot may not need trial insurance. Confirm with the REC.
6. **Employer agreement:**
   - Purpose limitation and **no disciplinary, insurer or recruitment use** (§6.2).
   - Prescribed rest is paid (C161 Art. 12).
   - Devices are employer-funded and free to workers (C155 Art. 21).
   - The employer keeps all legal duties: Zill **never** relaxes the midday ban or the HSE plan.
7. **Worker voice:** a site safety committee with elected worker members, consulted before launch (ILO code 12.2) [P, S73].
8. **Emergency pathway:** suspected heatstroke → first aid, cooling and an ambulance on **998** (police 999, fire 997) [P, S93].

---

## 5. Future Health, a global initiative by Abu Dhabi

- **What it is** [P, S84]:
  - Launched on **2 Nov 2025** by the Department of Health – Abu Dhabi, "under the directives of" H.H. Sheikh Khaled bin Mohamed bin Zayed (Crown Prince of Abu Dhabi).
  - It turns Abu Dhabi Global Health Week into a "year-round platform of international health collaboration, action and innovation".
  - Four themes:
    - Longevity and Precision Health;
    - **Health System Resilience and Sustainability**;
    - Digital Health and AI;
    - Investment in Life Sciences.
  - Components: an annual summit (announced for 7–9 Apr 2026, ADNEC), co-created programmes "to test and scale solutions", research programmes, global dialogues and impact reports.
  - Partners:
    - Founding partners: M42, Mubadala Bio, PureHealth and the Institute for Healthier Living Abu Dhabi (IHLAD).
    - Strategic partner: Mediclinic.
    - Thematic partner: Burjeel Holdings.
- **2026 theme: "To Sense is to Predict"** (announced 17 Mar 2026) [S, S85].
  - It describes a shift from reactive treatment to prevention through continuous monitoring and integrated data.
  - It names both **individual sensing (wearables)** and **population-level sensing**, which "analyzes community behaviors and environmental conditions".
  - It names low-cost sensing for resource-limited settings.
  - Zill fits as environmental plus worker-reported sensing, delivered at low cost.
- **The Digital Innovation Challenge 2026** [P, S86, S87]:
  - Co-creators: **Inception42, MBZUAI and Microsoft**.
  - Three focus areas (Fertility, Population Health, Wellbeing), with "10 challenge statements".
  - Judging criteria (unweighted, in this order):
    1. Health impact and clinical relevance.
    2. Technical depth and architecture.
    3. Working solution and demonstration quality.
    4. Responsible AI, safety, and data governance.
    5. Scalability and deployment readiness.
    6. Commercial viability and path to pilot.
  - Prizes: **US$105,000** in total (50,000 / 35,000 / 20,000).
  - Selected teams get "technical and clinical expertise across Abu Dhabi's health and innovation ecosystem". Strong solutions may receive "further validation, incubation, piloting and scale".
  - Hack2skill also lists "readiness assessment" and "potential pathway beyond the Challenge".
  - The statement text for Challenge 07, "Climate-Resilient Worker Health", was **not rendered** on the page we could access (only the Fertility statements appeared): **UNVERIFIED**. Transcribe it from the official page.
- **The previous Future Health Challenge, run with MIT Solve** (Feb–May 2026):
  - Title: "Building Anticipatory Health Systems through Population Sensing".
  - US$300,000 prize pool; 393 submissions from 68 countries; winners in May 2026 [S, S88].
  - It shows the initiative funds sensing-led prevention.
- **What "a pathway beyond the Challenge" implies for Zill** [D]:
  - The next gates are a **readiness assessment, validation, incubation, piloting, then scale**.
  - Have these ready by GITEX:
    1. The pilot protocol (§6.5), formatted for a DoH REC.
    2. A DPIA draft.
    3. A regulatory-qualification memo using the §4.5 wording.
    4. A named contractor willing to sign a letter of intent.
    5. A UAE data-residency plan (Microsoft, a co-creator, operates Azure UAE North and UAE Central).
    6. Evidence the rule packs reproduce ADPHC tables exactly (unit tests).

---

## 6. Commercial path

### 6.1 Buyers (who pays, and why now)

| Segment | Evidence of need | Budget owner and entry wedge |
|---|---|---|
| **Main contractors and developers** (construction) | <ul><li>Construction is 16.5% of UAE employment [S, S47] and 62.2% of UAE heat-related lost labour hours [P, S5].</li><li>Abu Dhabi has 420,654 MoHRE-registered construction workers [S, S45].</li><li>Midday-ban fines are AED 5,000 per worker [S, S32].</li></ul> | <ul><li>HSE director.</li><li>Wedge: "MoHRE/ADPHC compliance log plus fewer heat incidents".</li><li>Developers can mandate Zill on subcontractors in tender HSE plans.</li></ul> |
| **Oil and gas, energy, utilities** | <ul><li>ADNOC: "Beat the Heat", unified flags, "piloting wearable sensors" (2025) [P, S38].</li><li>DoE: an annual energy-sector heat campaign [P, S39].</li><li>Bahrain and Kuwait laws exclude oil and gas workers from the midday ban [P, S1], so risk-based control matters even more there.</li></ul> | <ul><li>Corporate OH and HSE.</li><li>Wedge: a governance-first complement or alternative to wearable pilots.</li></ul> |
| **Facilities management, landscaping, cleaning** | Large outdoor maintenance workforces. Exact headcount not isolated in public statistics; MoHRE "business activities" in Abu Dhabi = 223,812 (2019) [S, S45]. | <ul><li>Contract HSE manager.</li><li>Priced per site.</li></ul> |
| **Logistics and last-mile delivery** | MoHRE provides rest stations for delivery riders during the ban: "12,000+ air-conditioned rest stations" (2026) per WhatsOn [S, unverified count]. | <ul><li>Fleet operators and platforms.</li><li>Rider app integration via WhatsApp.</li></ul> |
| **Government and municipal programmes** | <ul><li>ADPHC owns Safety in Heat (>9 million reached) [P, S29].</li><li>Municipal outdoor works.</li></ul> | <ul><li>A co-branded public good: ADPHC rule pack plus anonymised heat-risk maps.</li><li>Grant or programme funding.</li></ul> |

**Insurers are excluded as customers for individual-level data.** Disciplinary and HR performance use is also excluded.

### 6.2 Excluded uses, and why (put these in contracts and in the pitch)

**Prohibited uses:**

- Sharing individual worker data with insurers (health, life, workers' compensation, employer liability).
- Use in discipline, pay, attendance, performance ranking or termination.
- Use in recruitment, fitness-for-hire, visa or sponsorship decisions.
- Sale or marketing use.

**Why:**

1. **Law and standards.**
   - The ILO code 5.4–5.6, 6.14 and 10.1–10.2 bar behaviour control, solely automated decisions, monitoring-only performance evaluation, and third-party or commercial disclosure without explicit consent [P, S73].
   - The PDPL requires data to be "collect[ed] … only for specific and clearly defined purposes" and bars incompatible further processing [S, S61].
   - The health-data localisation rules limit flows to insurers outside the UAE [S, S65].
2. **Validity of consent.**
   - The DoH treats workers in hierarchies as vulnerable, because of the risk of a "retaliatory response" [P, S70].
   - Consent cannot launder a coercive use, and "workers may not waive their privacy rights" [P, S73].
3. **Safety.**
   - Zill's core signal is **voluntary symptom reporting**. If reports can cost wages or jobs, workers will under-report. HRW records threatened wage deductions for slowing down in the heat [P, S24].
   - Privacy is a top barrier to adopting wearables [P, S89]. Acceptance depends on informing workers about data use [P, S90].
   - Any disciplinary or insurer use directly degrades the clinical signal Zill depends on. This is our inference [D].
4. **Commercial safeguards** (design proposal [D]):
   - Employers see **crew-level** actions and aggregates. Suppress any group smaller than 10 workers.
   - Individual data is visible only to the worker and the designated first-aider or OH professional (ILO 8.2 separation).
   - Audit logs, plus an annual report to the site worker committee.
   - Contractual penalties, with the right to terminate on misuse.

### 6.3 Pricing benchmarks

| Product | Price | Unit | Tag |
|---|---|---|---|
| Mitti (by SafetyCulture), HSE inspection SaaS: Premium | **$24** billed annually / **$29** billed monthly | per seat per month | [P, S55] |
| Mitti: Free | $0 | up to 10 users | [P, S55] |
| Connecteam, frontline workforce app | $29/month for the first 30 users, then **$0.50–4.20** per extra user per month depending on hub and tier | per company plus per user | [S, S56] |
| Kenzen, heat wearable | "subscription … per worker per month"; amount not public | per worker per month | [S, S48] |
| SlateSafety BAND V2 | $821.85 per device, plus required annual portal access (price not public) | per device | [S, S49b] |
| Hexoskin | $849–899 per kit | per worker | [P, S52] |
| Zephyr BioHarness 3 | $3,970 per kit | per worker | [S, S53] |
| Kestrel 5400 WBGT/TWL meter | $479–629 | per site instrument | [P, S57] |
| Twilio SMS, UAE | **$0.1176 per segment** outbound; alphanumeric sender ID registration mandatory ("unregistered … will be blocked"); **$225** setup plus **$115/month** per international sender ID | per message | [P, S59; S59b via search] |
| WhatsApp Business Platform | Per-message pricing (marketing, utility, authentication, service). **From 1 Oct 2026**, utility templates inside an open customer-service window are charged at regular rates (free since 1 Jul 2025). **1,000 free service messages per month** per number. AED billing available since 1 Apr 2026. UAE per-message rates not retrieved; the third-party figure of US$0.0157 per utility message is **UNVERIFIED**. | per message | [P, S58] |

**Zill pricing hypothesis** [D] (to test in pilot willingness-to-pay interviews; not a market fact):

- **Site tier.** Priced per site per month. Includes forecast and station ingest, the rule engine, the supervisor console and compliance logs.
- **Crew tier.** Priced per active worker per month during the heat season (May–Oct). Benchmarked between frontline apps ($0.5–4.2 per user) and HSE seats ($24 per seat). We model $1.5 / $3 / $6 per worker per month.
- **Wearable-ready enterprise tier.** Bring your own device; quoted per deal.
- **Messaging cost** for 3 messages per worker per shift, 26 shifts per month, over 6 months [D, Appendix A]:
  - about **US$7.35** per worker per season on WhatsApp (using the unverified rate);
  - about **US$55** on Latin-script SMS;
  - about **US$110** on non-Latin SMS, because UCS-2 segments hold 70 characters (67 when concatenated) [P, S59c].
  - → **WhatsApp-first, with SMS reserved for critical alerts.**

### 6.4 Integrations

| Integration | Purpose | Notes |
|---|---|---|
| Site WBGT/TWL stations: Kestrel 5400 (WBGT plus TWL, Bluetooth LiNK) [P, S57]; SlateSafety BEACON (estimated WBGT, heat index) [P, S49]; TWL-1S meters [P, S60] | Ground-truth inputs for the TWL rule packs (§3.3) | <ul><li>Display which instrument and timestamp drove each decision.</li><li>Fall back to forecast-derived estimates when no station is present.</li></ul> |
| Weather and forecast: UAE NCM | Forecast inputs | NCM publishes WMO WIS2 metadata for surface observations. No public developer API is documented (**UNVERIFIED**). |
| Smart PPE and wearables (optional), via vendor APIs (SlateSafety API [P, S49]; Kenzen planned open APIs as of 2020 [S, S48]) | Optional physiological context | Triggers the regulatory gate in §4.5 |
| WhatsApp Business Platform [P, S58]; SMS (Twilio or a local aggregator) [P, S59] | Worker channel; no app install required | Sender-ID registration lead time; message templates in 8 languages |
| HSE platforms (e.g., Mitti/SafetyCulture Premium "integrations" [P, S55]) | Incident and first-aid logs, inspections | Export via CSV or API; aggregates only (§6.2) |
| Site flag boards | Physical mirror of zone status | Matches the DM four-colour scheme [P, S31] and ADNOC's flag system [P, S38] |

### 6.5 Concrete pilot design: Zill-AD1 (one contractor, about 200 workers, June–August)

- **Design:** a cluster-randomised **stepped-wedge** feasibility study [P, S91: Hussey & Hughes 2007; Hemming 2015, 2018; Eldridge 2016].
  - 8 crews of about 25 workers each, defined by foreman.
  - Weeks 1–2: all crews on usual care.
  - The intervention then starts in random order, 2 crews every 2 weeks:
    - Group A at week 3;
    - Group B at week 5;
    - Group C at week 7;
    - Group D at week 9.
  - Total **10 weeks**, e.g., 1 Jun–9 Aug 2027.
  - Why stepped-wedge: every crew gets Zill, which is acceptable to the employer and workers. Period effects (rising summer heat, the midday ban starting 15 June) are modelled with fixed period effects.
  - Fallback: a controlled before–after design with a second site.
- **Usual care:** the MoHRE midday break, the contractor's HSE heat plan, and ADPHC materials.
- **Intervention:**
  - Zill rule pack AE-AZ-ADPHC-TWL plus AE-MOHRE-MIDDAY.
  - Station plus forecast inputs.
  - Multilingual WhatsApp prompts.
  - Tap or voice symptom check-ins.
  - A supervisor console.
  - Escalation to the first-aider.
- **Outcomes** (defined before the start):

  | Outcome | Definition | Source |
  |---|---|---|
  | Adherence to rest prescriptions (primary feasibility) | % of Zill rest prescriptions started within 10 minutes and completed for ≥ the prescribed duration | Supervisor confirmation plus app log |
  | False-alarm rate | <ul><li>Technical: % of zone escalations later traced to sensor or forecast error.</li><li>Clinical: % of symptom escalations judged non-heat-related by the first-aider.</li><li>Also report the PPV of symptom escalations.</li></ul> | First-aider review form |
  | Symptom reports | Heat-symptom check-ins per 1,000 worker-shifts | App |
  | First-aid cases | Heat-related first-aid or clinic visits per 1,000 worker-shifts, using standard case definitions | Site clinic log |
  | Lost work time | Minutes lost to heat illness per 1,000 worker-hours; also prescribed rest minutes (a productivity cost) | Clinic plus Zill |
  | Reach and equity | Weekly active % by language group; alert rates by language and age | App |
  | Acceptability | Worker survey and focus groups in 4 or more languages | Research staff |
  | Governance | Count of attempted out-of-scope data requests (target 0 disclosed) | Audit log |

- **Why not a clinical primary endpoint** [D, Appendix A]:
  - At the 2008 Abu Dhabi baseline (15.3 cases per 1,000 workers per year) [P, S9], 200 workers produce **0.59–3.06** expected cases, depending on how many of the year's cases fall in the window.
  - After the programme (1.16 per 1,000), expect **0.04–0.23** cases.
  - The pilot therefore estimates rates with 95% CIs rather than testing effectiveness.
  - With about 300 prescriptions, the adherence estimate has a 95% CI half-width of about **±5.7 percentage points**, or about ±8.0 with a design effect of 2.
- **Analysis:**
  - Mixed models with fixed period effects and a random crew effect.
  - Report under CONSORT-SW and the CONSORT pilot extension [P, S91].
- **Proposed progression criteria** for a scaled trial [D]:
  - ≥70% weekly active workers;
  - ≥80% rest-prescription adherence;
  - technical false alarms ≤10% of escalations;
  - zero governance breaches;
  - acceptability ≥ "acceptable" for ≥75% of respondents.
- **Safety:**
  - An independent site physician acts as safety monitor.
  - Zill never permits work that the law or HSE plan forbids.
  - Heatstroke protocol includes calling 998.
- **Approvals:** follow the §4.6 checklist.
- **Timeline** [D]:

  | When | Step |
  |---|---|
  | Dec 2026 | GITEX; partner letter of intent |
  | Jan–Feb 2027 | Protocol and DPIA |
  | Feb–Apr 2027 | REC/DoH-IRB review; DoH pathway guidance within 5 working days of the preliminary application [P, S70] |
  | May 2027 | Site set-up, baseline, translations |
  | Jun–Aug 2027 | Pilot |
  | Sep 2027 | Analysis |
  | Oct 2027 | Report |

### 6.6 Market sizing (cited counts; revenue pools are illustrative)

- **Cited counts:**
  - UAE private-sector construction: **1,386,498** workers (2022) [S, S45/S46].
  - Abu Dhabi construction: **420,654** (2019) [S, S45].
  - UAE construction: **16.5%** of employed people (FCSC) [S, S47].
  - GCC construction: **23%** of employment (2017) [P, S4].
  - Arab States construction is projected to employ **8.6 million** workers by 2030, 14% of employment [P, S4].
  - Abu Dhabi blue-collar share of the labour force: **55.2%** [P, S44].
- **Illustrative heat-season software revenue pools** [D, Appendix A]. These assume 100% penetration and 6 billing months, so they are upper bounds, not forecasts:

  | Pool | Workers | $1.5 per worker-month | $3 | $6 |
  |---|---|---|---|---|
  | Abu Dhabi construction | 420,654 | US$3.8 M | US$7.6 M | US$15.1 M |
  | UAE construction | 1,386,498 | US$12.5 M | US$25.0 M | US$49.9 M |

  - Oil and gas, energy, FM, logistics and municipal segments come on top. Their headcounts are not isolated in public statistics.
- **Beachhead logic** [D]:
  - Abu Dhabi first, because ADPHC's TWL standard already exists and is localised in the rule pack.
  - Then the other emirates, using the Sharjah and Dubai packs.
  - Then the GCC: Qatar's WBGT rule and Saudi Arabia's heat-index tiers are already encoded in §3.3.

---

## 7. Uncertainty register (UNVERIFIED items and what we tried)

| Item | Status | What we tried |
|---|---|---|
| Verbatim PDPL article text (Art. 2 health exclusion, Art. 4 exceptions, Art. 6 consent) | Secondary only | uaelegislation.gov.ae returned 403; government.ae had a TLS name mismatch; the u.ae PDF returned 404. Used Hunton, Reina/Primerus 2026 and Modulos. |
| PDPL executive regulations issued? | Conflicting; treated as pending | Vendor blogs cite three inconsistent decision numbers. |
| ICT Health Law verbatim (definitions, Art. 13, retention) | Secondary only | elaws.moj.gov.ae refused the connection; Al Tamimi returned 307; PwC and Taylor Wessing returned 403. Used Trowers and CMS. |
| ADHICS V2 and the DoH Responsible AI Standard: clause text | Cover and scope only, via search index | doh.gov.ae TLS handshake reset, with both curl/schannel and Python/OpenSSL. |
| OSHAD-SF CoP 11.0 "Safety in the Heat" text and version | Not retrieved | Searches found only secondary references (v3.1). Used the ADPHC TWL sheet, which carries the PDF title "OSHAD_Heatstress_Technical_Info_Sheet3". |
| Dubai Municipality guideline V3.0 (May 2024) thresholds | Only V2.0 (2019) verified | The V3 URL now redirects to the DM homepage; PreventionWeb returned 403. |
| Sharjah CoP "Acclimatised employees not allowed to work" | Probable typo for "unacclimatised" | Compared with the ADPHC sheet. |
| UAE ratification of C155, C187, C161 | Not among the 9 listed; NORMLEX blocked | HRW 2006 list; UAE embassy statement of 9 conventions; ILO news on P029 (2026). |
| Challenge 07 statement text | Not rendered | Hack2skill page showed only the Fertility statements; no Devpost listing found. |
| Final application deadline (10 vs 15 Nov 2026) | Conflict | Hack2skill says registration closes 10 Nov and prototype is due 20 Nov; the press release says applications close 15 Nov. |
| WhatsApp UAE per-message rates | Third-party only | Meta's rate card is interactive or a download; not retrieved. |
| Kenzen current product status and price | Unclear | kenzen.com now presents as a services firm. An unattributed blog's $300 device plus $35–50 per month estimate is **not usable**. |
| Lancet Countdown UAE sheet after 2023 | Not found | The country page lists the UAE but no file; URL guesses returned 404. |
| *The Guardian* "6,500 deaths" | Not fetched | Site blocked for our fetcher. Do not cite. |
| MoHRE 2025 and 2026 releases (exemption list, "20 languages", 99% compliance) | Snippet or title level | mohre.gov.ae refused the connection; used Khaleej Times and Emirates 24\|7. |
| Literacy rates of UAE migrant workers | No source found | — |
| MoHRE LMIS scope (free-zone and government exclusion) | Assumption | GLMM notes do not state the scope explicitly. |

---

## 8. Sources

Type tags: P = primary; S = secondary. All accessed 8–9 Nov 2026 unless dated otherwise.

| ID | Source | Type |
|---|---|---|
| S1 | ILO (2024). *Ensuring safety and health at work in a changing climate*. Global report. Geneva. https://www.ilo.org/media/569136/download | P |
| S2 | ILO (July 2024). *Heat at work: Implications for safety and health. A global review of the science, policy and practice*. https://www.ilo.org/sites/default/files/2024-07/ILO_OSH_Heatstress-R16.pdf (publication page https://www.ilo.org/publications/heat-work-implications-safety-and-health) | P |
| S3 | ILO News, 25 Jul 2024, "More workers than ever are losing the fight against heat stress". https://www.ilo.org/resource/news/more-workers-ever-are-losing-fight-against-heat-stress | P |
| S4 | ILO (2019). *Working on a warmer planet: The impact of heat stress on labour productivity and decent work*. https://www.ilo.org/wcmsp5/groups/public/---dgreports/---dcomm/---publ/documents/publication/wcms_711919.pdf | P |
| S5 | Lancet Countdown. *United Arab Emirates Data Sheet 2023*. https://climahealth.info/wp-content/uploads/2024/01/UAE_v1.pdf | P |
| S6 | EurekAlert (29 Oct 2025). Lancet Countdown 2025 report release. https://www.eurekalert.org/news-releases/1103937 | P (press release) |
| S7 | Lancet Countdown Data Explorer, 2026 visual summary. https://data.lancetcountdown.org/data-explorer/visual-summary | P |
| S8 | Flouris AD, et al. *Lancet Planet Health* 2018;2(12):e521–e531. doi:10.1016/S2542-5196(18)30237-7. PMID 30526938 | P |
| S9 | Joubert D, Thomsen J, Harrison O. *Am J Public Health* 2011;101(3):395–398. doi:10.2105/AJPH.2009.189563. PMC3036673 | P |
| S10 | Bates GP, Schneider J. *J Occup Med Toxicol* 2008;3:21. doi:10.1186/1745-6673-3-21 | P |
| S11 | Bates GP, Miller VS, Joubert DM. *Ann Occup Hyg* 2010;54(2):137–43. doi:10.1093/annhyg/mep076 | P |
| S12 | Ahmed HO, et al. *Ind Health* 2020;58(2):170–181. doi:10.2486/indhealth.2018-0259 | P |
| S13 | Bendak S, et al. *J Safety Res* 2022;81:197–202. doi:10.1016/j.jsr.2022.02.011 | P |
| S14 | Al-Bouwarthan M, et al. *Int J Environ Res Public Health* 2020;17(11):3775. doi:10.3390/ijerph17113775 | P |
| S15 | Pradhan B, et al. *Cardiology* 2019;143(1):37–48. doi:10.1159/000500853 | P |
| S16 | Alahmad B, et al. *Occup Environ Med* 2023;80(6):347–352. doi:10.1136/oemed-2022-108697 | P |
| S17 | Ioannou LG, et al. *Int J Environ Res Public Health* 2021;18(12):6303. doi:10.3390/ijerph18126303 | P |
| S18 | ILO/ADLSA/Supreme Committee (2019). *Assessment of occupational heat strain and mitigation strategies in Qatar – key findings* (FAME Lab). Mirror: https://heathealth.info/wp-content/uploads/wcms_723545.pdf | P |
| S19 | ILO News, 11 Oct 2019, "Study identifies effective mitigation strategies to keep workers safe from heat stress". https://www.ilo.org/resource/news/study-identifies-effective-mitigation-strategies-keep-workers-safe-heat | P |
| S20 | ILO (2021). *One is too many: The collection and analysis of data on occupational injuries in Qatar*. https://www.ilo.org/sites/default/files/wcmsp5/groups/public/%40arabstates/%40ro-beirut/%40ilo-qatar/documents/publication/wcms_828395.pdf | P |
| S21 | ILO News, 27 May 2021, "New legislation in Qatar provides greater protection to workers from heat stress". https://www.ilo.org/beirut/countries/qatar/qatar-office/WCMS_794475/lang--en/index.htm | P |
| S22 | FairSquare / Vital Signs Partnership (10 Mar 2022). *The deaths of migrants in the Gulf*. https://fairsq.org/urgent-call-for-action-on-migrant-worker-deaths-in-the-gulf/ | S |
| S23 | Amnesty International (26 Aug 2021). *"In the prime of their lives"*, MDE 22/4614/2021. https://www.amnesty.org/en/documents/mde22/4614/2021/en/ | P (NGO) |
| S24 | Human Rights Watch (8 Aug 2024). "Gulf States: Inadequate Heat Protection Putting Workers in Peril". https://www.hrw.org/news/2024/08/08/gulf-states-inadequate-heat-protection-putting-workers-peril | P (NGO) |
| S25 | Business & Human Rights Resource Centre (2023). Vital Signs, *Killer Heat*. https://www.business-humanrights.org/en/latest-news/killer-heat-the-impact-of-extreme-temperatures-and-climate-change-on-migrant-workers-in-the-gulf/ | S |
| S26 | ADPHC. *Safety in Heat* programme page. https://www.adphc.gov.ae/en/Public-Health-Programs/Injury-Prevention/Safety-in-Heat | P |
| S27 | ADPHC. *Thermal Work Limit – Working Zones* (bilingual PDF; metadata title "OSHAD_Heatstress_Technical_Info_Sheet3_E&A", created 2020-06-10, modified 2021-06-10). https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/Safety-in-Heat/Ther-Bi.pdf | P |
| S28 | ADPHC. *General tips poster – other languages*. https://www.adphc.gov.ae/-/media/Project/ADPHC/ADPHC/Safety-in-Heat/GTips-O.pdf | P |
| S29 | Abu Dhabi Media Office (21 Sep 2025). "ADPHC celebrates 11 years of safeguarding workers … Safety in Heat programme". https://www.mediaoffice.abudhabi/en/health/abu-dhabi-public-health-centre-celebrates-11-years-of-safeguarding-workers-during-summer-season-through-safety-in-heat-programme/ | P |
| S30 | Sharjah Prevention & Safety Authority. *OSHJ-CoP-33 Safety in Heat*, Version 2 Rev 0, Jul 2024. https://mc.spsa.shj.ae/Media/documents/j3comnEiUeCQ3emVuS2OQ_Safety%20in%20Heat%20OSHJ-COP-33.pdf | P |
| S31 | Dubai Municipality. *DM-HSD-GU38-MHSW2 Technical Guidelines for Management of Heat Stress at Work*, V2.0 (8 Oct 2019), GHHIN mirror: https://heathealth.info/wp-content/uploads/DM-HSD-GU38-MHSW2_Technical-Guidelines-for-Management-of-Heat-Stress-at-.pdf. V3 (moved): https://www.dm.gov.ae/wp-content/uploads/2024/07/DM-HSD-GU38-MHSW2_Technical-Guidelines-for-Management-of-Heat-Stress-at-Work_V3.pdf | P |
| S32 | Khaleej Times (6 Jul 2026). "UAE midday break: Violators face up to Dh50,000 fine, file suspension, legal action". https://www.khaleejtimes.com/uae/midday-break-violators-dh50000-fine-suspension-legal-action | S |
| S33 | Emirates 24\|7 (8 Jun 2026). "UAE implements midday work ban to protect workers from heat stress". https://www.emirates247.com/uae/uae-implements-midday-work-ban-to-protect-workers-from-heat-stress/2357 | S |
| S34 | MoHRE (3 Jun 2025). "MoHRE to implement Midday Break for the 21st consecutive year…". https://mohre.gov.ae/en/media-center/news/3/6/2025/mohre-to-implement-midday-break-for-the-21st-consecutive-year-from-15-june-to-15-september-2025 (unreachable; snippet only) | P (snippet) |
| S35 | MoHRE (15 Sep 2025). "Occupational Heat Stress Prevention Policy for 2025 concludes today with 99% compliance rate". https://mohre.gov.ae/en/media-center/news/15/9/2025/mohre-occupational-heat-stress-prevention-policy-for-2025-concludes-today-with-99-compliance-rate (title only) | P (title) |
| S36 | *The National* (27 May 2011). "Officials to set legal limit for working in the heat". https://www.thenationalnews.com/uae/officials-to-set-legal-limit-for-working-in-the-heat-1.593060 | S |
| S37 | Dawn/AFP, citing NCM (24 May 2025). "UAE hits record May temperature of 51.6C". https://www.dawn.com/news/1913179/uae-hits-record-may-temperature-of-516c | S |
| S38 | ADNOC *Sustainability Report 2025*, Occupational health, p. 37. https://reports.adnoc.ae/e/sustainability-report-2025-mobile/dhBH1X5o33 | P |
| S39 | Abu Dhabi Media Office (25 Jun 2026). DoE annual Safety in Heat campaign. https://www.mediaoffice.abudhabi/en/energy/abu-dhabi-department-of-energy-annual-safety-in-heat-campaign-reinforces-safe-working-practices-across-energy-sector-facilities/ | P |
| S40 | UN DESA Population Division (2024). *International Migrant Stock 2024: Destination and origin* (POP/DB/MIG/Stock/Rev.2024), Table 1. https://www.un.org/development/desa/pd/sites/www.un.org.development.desa.pd/files/undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx | P |
| S41 | Ministry of External Affairs, India. *Population of Overseas Indians* (as of January 2026). https://www.mea.gov.in/population-of-overseas-indians.htm | P |
| S42 | IIMAD/GIFT. *Kerala Migration Survey 2023* (PDF marked "Draft Report not to be quoted"). https://iimad.org/wp-content/uploads/2024/06/KMS-2023-Report.pdf | P (draft) |
| S43 | Himal Press, citing Nepal DoFE, FY2024/25 labour permits. https://en.himalpress.com/839266-received-labor-permits-for-foreign-employment-in-2024-25/ | S |
| S44 | SCAD (30 Jun 2025). "Abu Dhabi population in 2024 grows 7.5% to reach 4.14m". https://scad.gov.ae/w/abu-dhabi-population-in-2024-grows-7-5-to-reach-4-14m. Census dashboard: https://census.scad.gov.ae/home/population | P |
| S45 | GLMM, compiling MoHRE LMIS data. "UAE: Total labour force in the private sector by economic activity and Emirate (2019)". https://gulfmigration.grc.net/uae-total-labour-force-in-the-private-sector-by-economic-activity-and-emirate-2019/ | S (compiles P) |
| S46 | GLMM, compiling MoHRE LMIS data. "UAE: Total labour force in the private sector by economic activity (2017–2022)". https://gulfmigration.grc.net/uae-total-labour-force-in-the-private-sector-by-economic-activity-2017-2022/ | S |
| S47 | GLMM, compiling FCSC data. "UAE: Percentage distribution of employed population … by sex and economic activity" (page title 2023). https://gulfmigration.grc.net/uae-percentage-distribution-of-employed-population-aged-15-and-above-by-sex-and-sector-of-economic-activity-2022-2-2/ | S |
| S48 | T&D World (15 May 2020). "Kenzen launches body heat sensor system for worker safety". https://www.tdworld.com/electric-utility-operations/article/21131444/kenzen-launches-body-heat-sensor-system-for-worker-safety. S48b: https://kenzen.com/ (accessed 9 Nov 2026) | S / P |
| S49 | SlateSafety. https://slatesafety.com/. S49b: Levitt-Safety listing, https://www.levitt-safety.com/Marques/Slate-Safety/Catalogue/Fast-Track/Heat-Stress | P / S |
| S50 | Epicore Biosystems. http://epicorebiosystems.com/. S50b: Notebookcheck (27 Jun 2024), https://www.notebookcheck.net/Epicore-Biosystems-unveils-Connected-Hydration-wearable-to-monitor-worker-hydration-for-heat-safety.853288.0.html | P / S |
| S51 | Equivital. "Heat stress monitoring". https://equivital.com/heat-stress-monitoring | P |
| S52 | Hexoskin Support. "How much does Hexoskin cost?" https://support.hexoskin.com/how-much-does-hexoskin-cost | P |
| S53 | RAE Systems BioHarness 3 kit listing. https://rae-gasmonitors.com/rae-039-bh01-001.html. US Army (24 Apr 2017), "Airmen dodge 30 heat stress cases with USARIEM's ECTemp algorithm", https://www.army.mil/article/186577/airmen_dodge_30_heat_stress_cases_with_usariems_ectemp_algorithm | S |
| S54 | CDC/NIOSH. "Heat Safety Tool App (OSHA-NIOSH)", updated 3 Mar 2026. https://www.cdc.gov/niosh/heat-stress/communication-resources/app.html | P |
| S55 | Mitti (by SafetyCulture). Pricing. https://mitti.com/pricing/ (redirected from safetyculture.com/pricing) | P |
| S56 | Hivedesk. "Connecteam review 2026". https://www.hivedesk.com/connecteam-review | S |
| S57 | Kestrel Instruments. Kestrel 5400 Heat Stress Tracker. https://kestrelmeters.com/kestrel-5400-heat-stress-tracker | P |
| S58 | Meta for Developers. "Pricing on the WhatsApp Business Platform". https://developers.facebook.com/docs/whatsapp/pricing | P |
| S59 | Twilio. SMS pricing, UAE. https://www.twilio.com/en-us/sms/pricing/ae. S59b: Twilio Support, "How to register your Alphanumeric Sender ID in UAE", https://support.twilio.com/hc/en-us/articles/360046382293. S59c: Twilio Docs, "How long can a message be?", https://www.twilio.com/docs/glossary/what-sms-character-limit | P |
| S60 | Scarlet Tech. "Heat stress and thermal work limit". https://scarlet-tech.com/heat-stress-and-thermal-work-limit/ | P (vendor) |
| S61 | Reina Consulting (Mar 2026). "UAE Data Privacy Law" (hosted by Primerus). https://www.primerus.com/sites/default/files/2026-03/UAE%20Data%20Privacy%20Law.pdf | S |
| S62 | Hunton Andrews Kurth. "Data Protection in the UAE – Game Changing Federal UAE Data Law". https://www.hunton.com/insights/legal/data-protection-in-the-uae-game-changing-federal-uae-data-law | S |
| S63 | Modulos Docs. "UAE PDPL – security breaches, DPIA and cross-border transfers". https://docs.modulos.ai/frameworks/uae-pdpl/security-breaches-dpia-and-cross-border-transfers | S |
| S64 | UAE Government portal. "Data protection laws". https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws | P |
| S65 | CMS (22 Jun 2021). "UAE health data – new data transfer permissions". https://cms.law/en/are/legal-updates/uae-health-data-new-data-transfer-permissions | S |
| S66 | Trowers & Hamlins (29 Nov 2021). "ICT health data law". https://www.trowers.com/insights/ict-health-data-law | S |
| S67 | DoH Abu Dhabi. ADHICS V2 (DOH/SD/ICSO/ADHICS/V2/2024). https://www.doh.gov.ae/-/media/78A323607B4C4ACAA58D0C9ACCFB3D59.ashx (seen via search index only) | P (index) |
| S68 | DoH Abu Dhabi. Responsible AI Standard (DoH/ST/DDGO/RAI/V1/2025). https://www.doh.gov.ae/-/media/B84FF5DD027846699C51F36C439A580F.ashx (seen via search index only) | P (index) |
| S69 | International Bar Association (11 May 2026). "How is AI in healthcare being regulated in the UAE?" https://www.ibanet.org/ai-healthcare-regulation-uae | S |
| S70 | DoH Abu Dhabi. *Standard for Biomedical Research*, DoH/SD/HLSS/SBR/V1/2026 (Apr 2026), copy hosted by NYU Abu Dhabi. https://nyuad.nyu.edu/content/dam/nyuad/research/hrpp/standard-operating-procedures/ad-doh-rec-procedures.PDF | P |
| S71 | UAE AI Office (Jul 2024). *The UAE Charter for the Development & Use of Artificial Intelligence*. https://ai.gov.ae/wp-content/uploads/2024/07/UAEAI-Methaq-EN2-3.pdf | P |
| S72 | Library of Congress *In Custodia Legis* blog (Dec 2024). "AI regulations in the GCC member states, part one". https://blogs.loc.gov/law/2024/12/falqs-ai-regulations-in-the-gulf-cooperation-council-member-states-part-one/ | S |
| S73 | ILO (1997). *Protection of workers' personal data. An ILO code of practice*. https://www.ilo.org/public/libdoc/ilo/1997/97B09_118_engl.pdf | P |
| S74 | ILO C155, Occupational Safety and Health Convention 1981 (text reproduced by the University of Minnesota Human Rights Library). https://hrlibrary.umn.edu/instree/n6ccoshwe.html | S (copy of P) |
| S75 | ILO C161, Occupational Health Services Convention 1985 (text copy). https://lankalaw.net/wp-content/uploads/2024/12/C161-Occupational-Health-Services-Convention-1985.pdf | S (copy of P) |
| S76 | ILO News (10 Jun 2022). "International Labour Conference adds safety and health to Fundamental Principles and Rights at Work". https://www.ilo.org/resource/news/ilc/110/international-labour-conference-adds-safety-and-health-fundamental | P |
| S77 | ILO News (Jan 2026). "United Arab Emirates ratifies Protocol to Convention No. 29…". https://www.ilo.org/resource/news/united-arab-emirates-ratifies-protocol-convention-no-29-reaffirming-its | P |
| S78 | Human Rights Watch (2006). *Building Towers, Cheating Workers*, ch. 7 (ratifications). https://www.hrw.org/reports/2006/uae1106/7.htm. UAE Embassy, human rights page: https://www.uae-embassy.org/discover-uae/society/human-rights | S |
| S79 | Regulation (EU) 2017/745 (MDR), Art. 2(1). https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0745 | P |
| S80 | Pinsent Masons Out-Law. "UAE pharmaceutical law: 10 things businesses should know". https://www.pinsentmasons.com/en-gb/out-law/analysis/uae-pharmaceutical-law-10-things-businesses-should-know | S |
| S81 | Muhami (20 Jan 2026). "SaMD regulation in the UAE: a quick guide". https://muhami.ae/articles/samd-regulation-in-the-uae-a-quick-guide/ | S |
| S82 | Baker McKenzie (21 Feb 2024). "UAE: New Emirates Drug Corporation … replaces MOHAP as federal regulator of all medical products". https://healthcarelifesciences.bakermckenzie.com/2024/02/21/uae-new-emirates-drug-corporation-soon-to-be-operational-replaces-mohap-as-federal-regulator-of-all-medical-products/ | S |
| S83 | Cooley (20 Jan 2026). "FDA opens aperture for wearables in latest General Wellness guidance". https://www.cooley.com/news/insight/2026/2026-01-20-fda-opens-aperture-for-wearables-in-latest-general-wellness-guidance | S |
| S84 | Abu Dhabi Media Office (2 Nov 2025). "Department of Health launches Future Health – A Global Initiative by Abu Dhabi…". https://www.mediaoffice.abudhabi/en/health/under-the-directives-of-khaled-bin-mohamed-bin-zayed-department-of-health-launches-future-health-a-global-initiative-by-abu-dhabi-to-transform-abu-dhabi-global-health-week-into-a-year-round-global-platform/ | P |
| S85 | ARY News (17 Mar 2026). "Abu Dhabi's Future Health Initiative unveils 2026 theme". https://arynews.tv/abu-dhabi-future-health-initiative-unveils-2026-theme | S |
| S86 | Zawya/Business Wire (Oct 2026). "Future Health launches global Challenge to move health innovation towards real-world application". https://www.zawya.com/en/press-release/companies-news/future-health-launches-global-challenge-to-move-health-innovation-towards-real-world-application-1680763 | P (press release) |
| S87 | Hack2skill. "Future Health Digital Innovation Challenge". https://hack2skill.com/event/futurehealthchallenge/ | P |
| S88 | Gulf News. "$300,000 up for grabs as Abu Dhabi, MIT Solve launch global health challenge". https://gulfnews.com/uae/health/300000-up-for-grabs-as-abu-dhabi-mit-solve-launch-global-health-challenge-1.500433217. DoH news on winners: https://www.doh.gov.ae/en/news/future-health-and-mit-solve-announce-global-winners-of-future-health-challenge | S |
| S89 | Schall MC Jr, Sesek RF, Cavuoto LA. *Hum Factors* 2018;60(3):351–362. doi:10.1177/0018720817753907 | P |
| S90 | Jacobs JV, et al. *Appl Ergon* 2019;78:148–156. doi:10.1016/j.apergo.2019.03.003 | P |
| S91 | Hussey MA, Hughes JP. *Contemp Clin Trials* 2007;28:182–91. Hemming K, et al. *BMJ* 2015;350:h391. Hemming K, et al. *BMJ* 2018;363:k1614 (CONSORT stepped-wedge extension). Eldridge SM, et al. *BMJ* 2016;355:i5239 (CONSORT pilot extension) | P |
| S92 | Brake DJ, Bates GP. "Limiting metabolic rate (thermal work limit) as an index of thermal stress". *Appl Occup Environ Hyg* 2002;17(3):176–86. PMID 11871754 | P |
| S93 | UAE Government portal. "Handling emergencies" (998 ambulance, 999 police, 997 fire). https://u.ae/en/information-and-services/justice-safety-and-the-law/handling-emergencies | P |
| S94 | People Matters ME. "Saudi Arabia enforces midday outdoor work ban until September 15". https://me.peoplemattersglobal.com/news/wellbeing/saudi-arabia-enforces-midday-outdoor-work-ban-until-september-15-50323 | S |

Also used:

- Microsoft Learn, "List of Azure regions" (UAE North = Dubai, UAE Central = Abu Dhabi), https://learn.microsoft.com/en-us/azure/reliability/regions-list [P].
- CESLAM, Nepal labour migration news (UAE share of permits) [S].
- WhatsOn (Jun 2026), "UAE to enforce midday work ban from next week" (count of delivery-rider rest stations, seen via search snippet only), https://whatson.ae/?p=390839 [S, UNVERIFIED count].

---

## Appendix A. Reproducible arithmetic

**Script:** `zill_context_calcs.py`, standard library only. The UN DESA step is optional and needs pandas and openpyxl. Run it with the project venv:

```
python -I zill_context_calcs.py [undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx]
```

```python
"""Zill - reproducible arithmetic behind docs/research/context_and_commercial.md
Every INPUT below is a cited figure (see the markdown for sources) or an explicitly
labelled ASSUMPTION. Nothing here is new data; it is arithmetic on cited inputs."""
import math, sys

UAE_CONSTRUCTION_MOHRE_2022 = 1_386_498   # MoHRE LMIS via GLMM (S46)
UAE_CONSTRUCTION_MOHRE_2019 = 1_641_724   # (S45/S46)
AD_CONSTRUCTION_MOHRE_2019 = 420_654      # (S45)
AD_PRIVATE_TOTAL_MOHRE_2019 = 1_381_819   # (S45)
UAE_PRIVATE_TOTAL_MOHRE_2022 = 5_477_366  # (S46)
JOUBERT_BASELINE_PER_1000 = 15.3          # (S9) cases/1000 workers/yr, 2008
JOUBERT_POST_PER_1000 = 1.16              # (S9) 2009
TWILIO_UAE_SMS_USD_PER_SEGMENT = 0.1176   # (S59)

PRICE_PWPM_USD = [1.5, 3.0, 6.0]          # ASSUMPTION
HEAT_SEASON_MONTHS = 6                    # ASSUMPTION (May-Oct)
WA_UTILITY_USD_PER_MSG = 0.0157           # UNVERIFIED third-party rate
MSGS_PER_WORKER_PER_SHIFT = 3             # ASSUMPTION
SHIFTS_PER_MONTH = 26                     # ASSUMPTION
SMS_SEGMENTS_GSM7, SMS_SEGMENTS_UCS2 = 1, 2
PILOT_WORKERS, PILOT_WEEKS = 200, 10

def market_sizing():
    for label, n in [("Abu Dhabi construction (2019)", AD_CONSTRUCTION_MOHRE_2019),
                     ("UAE construction (2022)", UAE_CONSTRUCTION_MOHRE_2022)]:
        print(label, n, [round(n * p * HEAT_SEASON_MONTHS / 1e6, 1) for p in PRICE_PWPM_USD])

def messaging_costs():
    msgs = MSGS_PER_WORKER_PER_SHIFT * SHIFTS_PER_MONTH * HEAT_SEASON_MONTHS
    print(msgs, msgs * WA_UTILITY_USD_PER_MSG,
          msgs * SMS_SEGMENTS_GSM7 * TWILIO_UAE_SMS_USD_PER_SEGMENT,
          msgs * SMS_SEGMENTS_UCS2 * TWILIO_UAE_SMS_USD_PER_SEGMENT)

def pilot_event_counts():
    for rate in (JOUBERT_BASELINE_PER_1000, JOUBERT_POST_PER_1000):
        full = PILOT_WORKERS * rate / 1000.0
        print(full * PILOT_WEEKS / 52.0, full, math.exp(-full))

def pilot_precision():
    for n in (100, 300, 1000):
        for deff in (1.0, 2.0):
            print(n, deff, 1.96 * math.sqrt(0.25 * deff / n))

def undesa(path):  # UN DESA Table 1: col1=destination, col5=origin, col6=origin code, col14=both sexes 2024
    import pandas as pd
    df = pd.read_excel(path, sheet_name="Table 1", header=None, skiprows=11)
    uae = df[df[1].astype(str).str.strip() == "United Arab Emirates"]
    total = float(uae[uae[5].astype(str).str.strip() == "World"][14].iloc[0])
    c = uae[pd.to_numeric(uae[6], errors="coerce") < 900].copy()   # country-level origins only
    c[14] = pd.to_numeric(c[14], errors="coerce")
    for _, r in c.sort_values(14, ascending=False).head(10).iterrows():
        print(str(r[5]).strip(), int(r[14]), round(100 * r[14] / total, 1))

if __name__ == "__main__":
    market_sizing(); messaging_costs(); pilot_event_counts(); pilot_precision()
    if len(sys.argv) > 1: undesa(sys.argv[1])
```

(The listing above is condensed. The full script with formatted printing produced the output below.)

**Output of the full script** (run 2026-11-09 with the project venv, exit code 0):

```
== 1. Illustrative revenue pools (software-only, heat-season billing) ==
UAE construction change 2019->2022: -15.5%
Abu Dhabi construction share of Abu Dhabi private-sector workforce (2019): 30.4%
UAE construction share of UAE private-sector workforce (2022): 25.3%
  Abu Dhabi construction (2019)    n=  420,654  $1.5 -> US$3.8M | $3.0 -> US$7.6M | $6.0 -> US$15.1M
  UAE construction (2022)          n=1,386,498  $1.5 -> US$12.5M | $3.0 -> US$25.0M | $6.0 -> US$49.9M
  (each cell = workers x price x 6 months; 100% penetration, i.e. an upper bound)

== 2. Messaging cost per worker per heat season ==
  messages/worker/season = 3 x 26 x 6 = 468
  WhatsApp utility @ $0.0157/msg (UNVERIFIED rate): US$7.35
  SMS, Latin script, 1 segment @ $0.1176: US$55.04
  SMS, non-Latin script, 2 segments: US$110.07
  SMS/WhatsApp cost ratio (Latin): 7.5x ; (non-Latin): 15.0x

== 3. Expected heat-illness clinic cases in a 200-worker pilot ==
  baseline (2008)         : expected cases 0.59 (pro-rata 10 wk) to 3.06 (all annual cases in window); P(0 cases | upper) = 0.05
  post-programme (2009)   : expected cases 0.04 (pro-rata 10 wk) to 0.23 (all annual cases in window); P(0 cases | upper) = 0.79
  -> clinic-confirmed heat illness is too rare in n=200 to be a powered endpoint; use process/feasibility outcomes.

== 4. Precision of feasibility proportions (e.g., rest-prescription adherence) ==
  worker-shifts in a 10-week, 200-worker pilot (6 shifts/wk): 12,000
  n=  100 prescriptions, DEFF=1: 95% CI half-width <= +/-9.8 percentage points
  n=  100 prescriptions, DEFF=2: 95% CI half-width <= +/-13.9 percentage points
  n=  300 prescriptions, DEFF=1: 95% CI half-width <= +/-5.7 percentage points
  n=  300 prescriptions, DEFF=2: 95% CI half-width <= +/-8.0 percentage points
  n= 1000 prescriptions, DEFF=1: 95% CI half-width <= +/-3.1 percentage points
  n= 1000 prescriptions, DEFF=2: 95% CI half-width <= +/-4.4 percentage points

== 5. UN DESA International Migrant Stock 2024: destination UAE, top origins ==
  total mid-2024 = 8,157,000
   1. India                    3,248,545   39.8%
   2. Bangladesh               1,024,949   12.6%
   3. Pakistan                   932,356   11.4%
   4. Egypt                      841,883   10.3%
   5. Philippines                528,527    6.5%
   6. Indonesia                  298,351    3.7%
   7. Yemen                      192,423    2.4%
   8. Jordan                     158,125    1.9%
   9. Sudan                      124,677    1.5%
  10. Sri Lanka                  112,759    1.4%
  (Nepal: 26,097 - likely undercount vs Nepal DoFE permit flows; see markdown)
```
