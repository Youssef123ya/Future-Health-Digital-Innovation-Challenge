# Zill — Path to pilot and commercial plan

This document sets out who would buy Zill and why, what it costs to run, and how a first pilot (Zill-AD1) would test it
in the 2027 heat season. It is written for:
- the Challenge judges, on criteria 5 ("Scalability and deployment readiness") and 6 ("Commercial viability and path to
  pilot") [P, S86, S87];
- reviewers at the Department of Health – Abu Dhabi (DoH) and the Abu Dhabi Public Health Centre (ADPHC);
- employers considering a pilot.

**Status:** plan, 10 November 2026. Nothing here has yet been agreed with a contractor, an ethics committee or a
regulator. Prices are hypotheses to test, not market facts. Governance and the employer contract terms are in
`docs/GOVERNANCE.md`.

**How to read the tags**

| Tag | Meaning |
|---|---|
| **[P]** | Verified against the primary document. |
| **[S]** | Verified only from a named secondary source. |
| **[D]** | Our derivation or design proposal. Arithmetic is in `docs/research/context_and_commercial.md` Appendix A or shown here. |
| **[DOCS]** | Quoted from a provider's own documentation (`docs/research/data_and_validation.md` §7). |
| **[ASSUMPTION]** | A modelling input we chose. Change it and the result changes. |
| **UNVERIFIED** | Could not be confirmed. Do not present it as fact. |

Source keys (S1, S9, S70 …) refer to the reference list in `docs/research/context_and_commercial.md` §8.

---

## 0. Summary

- **The problem.**
  - Excessive heat injures and kills workers at scale, and most of the harm happens outside heatwaves [P, S1, S2].
  - The UAE midday break is necessary but does not cover the whole risk.
  - Abu Dhabi already has a local standard, the ADOSH/ADPHC Thermal Work Limit (TWL) zones. Its 2008 programme cut heat
    cases at one company by 79.5 % [P, S9].
  - Zill turns that standard into live, multilingual instructions for each crew and worker.
- **The buyers.**
  - Main contractors and developers come first; the budget holder is the HSE director.
  - Oil and gas, facilities management, logistics and government programmes follow.
  - Insurers are excluded as customers for individual data.
- **The offer.**
  - It works without wearables: site weather or a site meter, work context, and worker-reported symptoms.
  - It is free to workers. Employers pay per worker-month during the heat season, plus a possible site fee.
  - Our cost model (§4.3) shows two things. Routine messages must go through the installed app rather than paid
    messaging. And at single-site scale the price must be about US$3–6 per worker-month, not US$1.5.
- **The pilot, Zill-AD1.**
  - One contractor, about 200 workers in 8 crews, with a 10-week stepped-wedge design from 1 June to 9 August 2027.
  - The endpoints measure feasibility:
    - rest-prescription adherence (primary);
    - alert lead time;
    - false-alarm rate;
    - acceptability;
    - data quality;
    - safety events.
  - Heat-illness incidence cannot be an endpoint. We expect only 0.6–3.1 clinic cases in 200 workers [D].
- **Approvals.**
  - Ethics review under the DoH Standard for Biomedical Research.
  - Consent documents in Arabic and English, collected by research staff (never supervisors), with an impartial witness
    for workers who cannot read.
  - A DPIA, a written qualification opinion from the Emirates Drug Establishment, and an elected worker safety committee.
- **The timeline.**
  - GITEX in December 2026.
  - Protocol and DPIA in January–February 2027.
  - Ethics review in February–April.
  - Site set-up in May.
  - Pilot from June to August.
  - Report in October 2027.
- **What would justify a scaled trial** (progression criteria) [D]:
  - at least 70 % of workers active each week;
  - at least 80 % adherence to rest prescriptions;
  - technical false alarms at most 10 % of escalations;
  - zero governance breaches;
  - at least 75 % of respondents rating Zill "acceptable" or better.

---

## 1. The problem

**The scale of heat harm.**
- At least **2.41 billion workers** (over 70 %) are exposed to excessive heat each year.
- Excessive heat causes **22.85 million occupational injuries, 18,970 work-related deaths and 2.09 million DALYs** a year
  (2020 estimates) [P, S1].
- **83.6 %** of the Arab States workforce is exposed, against 71.0 % globally [P, S2].

**Most harm happens outside heatwaves.** In the ILO's words, "nine out of ten worker exposures to excessive heat, and
eight out of ten occupational injur[ies] linked to excessive heat, occur outside of a heatwave" [P, S2]. Alerts tied
only to heatwaves or to the calendar therefore miss most of the risk.

**The UAE's burden.**
- The UAE lost **1.5 billion potential labour hours** to heat in 2022, 350 % more than in 1991–2000.
- Construction accounted for **62.2 %** of those hours.
- The income loss was **US$18.2 bn**, equal to 3.6 % of GDP [P, S5].

**The midday break is necessary but not sufficient.** Outdoor work in direct sun is banned from 12:30 to 15:00 between
15 June and 15 September.
- In Kuwait, occupational injury risk still rose to RR 1.44 at 39.4 °C (compared with 37.0 °C) *during* the
  midday-ban season [P, S16].
- The UAE recorded 51.6 °C on 24 May 2025, three weeks before the ban began [S, S37].
- In 2019 the ILO wrote that GCC midday bans "could be adjusted to reflect real-time temperature, humidity and workload
  for all outdoor worksites" [P, S4].

**Abu Dhabi already has the standard.**
- ADOSH-SF CoP 11.0 *Safety in the Heat* v4.0 and its Technical Guideline (ADPHC, 15 July 2024) set TWL zones with
  work/rest and water schedules [P, `twl_and_regulation.md` §2].
- The 2008 programme cut heat-related cases at one company from 15.3 to 1.16 per 1,000 workers [P, S9].
- Zill digitises and extends this standard. It does not invent a new one.
- We found no current public TWL forecast in Abu Dhabi. This is UNVERIFIED only in that an app that search engines do
  not index could exist.

**The market gap.**
- Competitors sell physiological wearables to supervisors, at hundreds of dollars per worker:
  - Hexoskin, US$849–899 per kit [P, S52];
  - SlateSafety BAND V2, US$821.85 [S, S49b];
  - Zephyr BioHarness 3 kit, US$3,970 [S, S53].
- No public material we found documents a worker interface in Arabic or South-Asian languages, worker-controlled data
  governance, or rule packs for the UAE midday break and the ADPHC TWL zones (research §0 item 7).
- The free OSHA-NIOSH app uses the heat index and "is not receiving updates at this time" [P, S54].

---

## 2. Buyers

| Segment | Why now | Budget owner and entry wedge |
|---|---|---|
| **Main contractors and developers** (construction) | <ul><li>16.5 % of UAE employment [S, S47].</li><li>62.2 % of the UAE's heat-related lost hours [P, S5].</li><li>420,654 MoHRE-registered construction workers in Abu Dhabi (2019) [S, S45].</li><li>Midday-break fines of AED 5,000 per worker [S, S32].</li></ul> | <ul><li>HSE director.</li><li>Wedge: a MoHRE/ADPHC compliance log and a documented heat programme. Fewer heat incidents is the hypothesis the pilot starts to test, not a claim.</li><li>Developers can require Zill of subcontractors through tender HSE plans.</li></ul> |
| **Oil and gas, energy, utilities** | <ul><li>ADNOC's "Beat the Heat" programme, unified flags, and "piloting wearable sensors" (2025) [P, S38].</li><li>The Department of Energy's annual energy-sector heat campaign [P, S39].</li></ul> | <ul><li>Corporate OH and HSE.</li><li>Wedge: a governance-first complement or alternative to wearable pilots.</li></ul> |
| **Facilities management, landscaping, cleaning** | Large outdoor maintenance workforces. Headcount is not isolated in public statistics [S, S45]. | <ul><li>Contract HSE manager.</li><li>Priced per site.</li></ul> |
| **Logistics and last-mile delivery** | MoHRE provides rest stations for riders during the ban; the reported count of "12,000+" is unverified [S]. | <ul><li>Fleet operators and platforms.</li><li>Integration through WhatsApp.</li></ul> |
| **Government and municipal programmes** | ADPHC owns *Safety in Heat*, which has reached more than 9 million people [P, S29]. | <ul><li>A co-branded public good: the ADPHC rule pack plus anonymised heat-risk maps.</li><li>Grant or programme funding.</li></ul> |

**Excluded customers and uses.** Insurers are excluded as customers for individual-level data. Disciplinary use and HR
performance use are excluded too (`docs/GOVERNANCE.md` §5).

---

## 3. Value per stakeholder

| Stakeholder | What they get | How the pilot tests it |
|---|---|---|
| **Worker** | <ul><li>Their own level and plain instructions in their language, with voice and pictograms.</li><li>A countdown to the next break, a water schedule, an SOS button and a buddy.</li><li>Their health data stays on their phone, and they can see who looked at their data.</li><li>Free of charge.</li></ul> | Acceptability survey and focus groups; weekly active share; comprehension test |
| **Buddy** | A prompt to check on a partner who has not responded to an alert. | Buddy-check response times (app log) |
| **Crew supervisor** | <ul><li>A crew board showing who must rest now, for how long, and how much water.</li><li>A forecast strip, a break planner and acknowledgements.</li><li>No clinical data.</li></ul> | Adherence (rest started within 10 min); supervisor interviews |
| **First aider and OH nurse** | <ul><li>Early escalation with the worker's location, and the protocol: cool first, call 998.</li><li>OH also gets consented clinical detail for escalated cases.</li></ul> | Time from escalation to first-aid contact; first-aider review of each escalation (false alarms, positive predictive value) |
| **HSE manager** | <ul><li>Site aggregates and a compliance log for the midday break and the ADOSH zone controls.</li><li>Evidence for the heat stress programme the CoP requires where 35 °C or more is foreseeable.</li><li>Prompts for incident notification.</li></ul> | Completeness of the compliance log; HSE interview; willingness to pay |
| **Employer / contractor** | <ul><li>A documented, standards-based heat programme.</li><li>Rest planned into the schedule ahead of time, from the forecast.</li><li>Less exposure to midday-break fines.</li><li>Fewer unplanned stoppages from heat illness, which is a hypothesis the pilot tests.</li></ul> | Minutes lost per 1,000 worker-hours; prescribed rest minutes (a productivity cost) |
| **Developer / client** | Evidence of subcontractor heat compliance for tender HSE plans. | Interviews alongside the letter of intent (not measured in the pilot) |
| **Regulator (ADPHC / ADOSH)** | <ul><li>k-suppressed multi-site aggregates: hours in each TWL zone, and compliance.</li><li>A digital form of its own standard.</li></ul> | Regulator feedback on the aggregate report format |
| **DoH / Future Health** | Low-cost environmental and worker-reported sensing. This matches the 2026 theme "To Sense is to Predict", which names individual sensing, population sensing and low-cost sensing [S, S85]. | Feasibility evidence and effect-size inputs for a scaled study |

---

## 4. Pricing hypothesis and unit economics

### 4.1 Price and cost benchmarks

| Product or input | Price | Unit | Tag |
|---|---|---|---|
| Mitti (by SafetyCulture), HSE inspection SaaS, Premium | US$24 billed annually / US$29 billed monthly | per seat per month | [P, S55] |
| Connecteam, frontline workforce app | US$29/month for the first 30 users, then US$0.50–4.20 per extra user per month | per company plus per user | [S, S56] |
| Kenzen, heat wearable | Subscription "per worker per month"; amount not public | per worker per month | [S, S48] |
| SlateSafety BAND V2 | US$821.85 per device, plus annual portal access (price not public) | per device | [S, S49b] |
| Hexoskin | US$849–899 per kit | per worker | [P, S52] |
| Kestrel 5400 WBGT/TWL meter | US$479–629 | per site instrument | [P, S57] |
| Twilio SMS, UAE | <ul><li>US$0.1176 per outbound segment.</li><li>Alphanumeric sender ID registration is mandatory.</li><li>US$225 set-up plus US$115/month per international sender ID.</li></ul> | per message | [P, S59; S59b via search] |
| WhatsApp Business Platform | <ul><li>Priced per message.</li><li>From 1 Oct 2026, utility templates inside an open service window are charged at regular rates.</li><li>1,000 free service messages per month per number.</li><li>UAE per-message rates not retrieved. The third-party figure of US$0.0157 per utility message is **UNVERIFIED**.</li></ul> | per message | [P, S58] |
| Open-Meteo API Standard | €29/month or €319/year | 1M calls/month; commercial licence; Forecast API | [DOCS] |
| Open-Meteo API Professional | €99/month or €1,099/year | 5M calls/month; adds historical weather, historical forecast, previous model runs, ensemble | [DOCS] |

### 4.2 Pricing hypothesis [D]

These tiers are to be tested in willingness-to-pay interviews during the pilot. They are not market facts.

- **Site tier.** Priced per site per month. It covers forecast and meter ingest, the rule engine, the supervisor console
  and the compliance logs. The price is to be set from interviews; the nearest benchmark is US$24–29 per HSE seat per
  month (Mitti Premium) [P, S55].
- **Crew tier.** Priced per active worker per month during the heat season (May–October). We model US$1.5, US$3 and US$6.
  That range sits between frontline apps (US$0.50–4.20 per user) [S, S56] and HSE seats (US$24) [P, S55].
- **Wearable-ready enterprise tier.** The customer brings its own devices, and the price is quoted per deal. This tier is
  offered only after the regulatory gate in `docs/GOVERNANCE.md` §9.
- **Workers never pay.** Under ILO C155 Art. 21, OSH measures must not cost workers anything [S, S74].

### 4.3 Cost to serve one 200-worker site for one season [D]

**Inputs**

| Input | Value | Tag |
|---|---|---|
| Workers per site | 200 | [ASSUMPTION] (pilot size) |
| Season | 6 months (May–October) | [ASSUMPTION] (research §6.3) |
| Shifts per worker per month | 26 | [ASSUMPTION] (research Appendix A) |
| Messages per worker per shift | 3 | [ASSUMPTION] (research Appendix A) |
| WhatsApp utility message | US$0.0157 | UNVERIFIED third-party rate |
| SMS segment | US$0.1176. Non-Latin scripts use 2 segments, because UCS-2 segments hold 70 characters (67 when concatenated). | [P, S59, S59c] |
| SMS sender ID | US$225 set-up + US$115/month | [P, S59b via search] |
| Share of messages that are critical and also sent by SMS | 5 % | [ASSUMPTION] |
| Share of workers reached through the installed Zill app, at no per-message cost ("app-first" mix) | 80 % | [ASSUMPTION] |
| Weather API | Open-Meteo API Standard, €29/month | [DOCS] |
| Site meter | Kestrel 5400, US$479–629, one-off | [P, S57] |

**Results** (468 messages per worker per season = 3 × 26 × 6)

| Cost item | Per site-season | Per worker-season |
|---|---:|---:|
| Messaging: all by WhatsApp | US$1,470 | US$7.35 |
| Messaging: all by SMS, Latin script | US$11,008 | US$55.04 |
| Messaging: all by SMS, non-Latin script | US$22,014 | US$110.07 |
| Critical alerts duplicated by SMS (5 %, non-Latin) | US$1,101 | US$5.50 |
| SMS sender ID | US$915 in season 1, US$690 after | US$4.58 / US$3.45 |
| Weather API (€29 × 6) | €174 | €0.87 |
| Site meter (one-off, if Zill supplies it) | US$479–629 | US$2.40–3.15 |
| Optional wearable for every worker (one-off) | US$164,370 | US$821.85 (≈ US$274 a season if a device lasts 3 seasons [ASSUMPTION]) |

**Direct cost to serve and break-even price**

These figures exclude weather, hosting, support, sales and phones.

| Channel mix | Season 1 (with sender-ID set-up and a US$479 meter) | Later seasons | Break-even price per worker-month (season 1 / later) |
|---|---:|---:|---:|
| WhatsApp-first, critical alerts also by SMS | US$19.82 | US$16.30 | US$3.30 / US$2.72 |
| App-first (80 % in-app), WhatsApp for the rest, critical alerts by SMS | US$13.94 | US$10.42 | US$2.32 / US$1.74 |
| SMS only (non-Latin) | US$117.04 | US$113.52 | US$19.51 / US$18.92 |

Revenue per worker-season at US$1.5, US$3 and US$6 per worker-month is US$9, US$18 and US$36. For a 200-worker site
that is US$1,800, US$3,600 and US$7,200.

**What this shows** [D]:
1. **Messaging is the largest variable cost.** Per worker-season, SMS costs 7.5× (Latin script) to 15× (non-Latin) as
   much as WhatsApp. Hence the research recommendation: WhatsApp first, SMS only for critical alerts (§6.3). Routine
   prompts should go through the installed app, which works offline and has no per-message cost.
2. **US$1.5 per worker-month does not cover direct costs** at a single 200-worker site in any mix we modelled.
   - US$3 covers the app-first mix, but not WhatsApp-first in season 1.
   - US$6 covers both.
   - The pilot interviews should therefore test US$3–6 per worker-month and/or a site fee.
3. **Fixed costs fall with scale.**
   - One weather plan and one sender ID can serve many sites. Sharing a sender ID across customers must be checked
     against UAE registration rules [ASSUMPTION].
   - At an hourly forecast refresh per site [ASSUMPTION], a site makes about 720 requests a month against the Standard
     plan's 1M calls. Open-Meteo's call-counting rules have not been verified and must be checked against the plan
     terms before scaling.
4. **Wearables cost 23–91 times the software revenue per worker-season** (US$821.85 against US$9–36). They stay
   optional and separately priced. The environment-first core is the default.
5. **WhatsApp prices are moving** [P, S58]. Utility templates inside an open service window became chargeable on
   1 Oct 2026 (they had been free since 1 Jul 2025), and AED billing has been available since 1 Apr 2026. Re-price
   before each season.

### 4.4 Weather data licensing

- **The free tier cannot be used.** Open-Meteo's free API is for non-commercial use only. Its terms list "Commercial
  products" and "Websites or apps that have subscriptions" as commercial [DOCS]. Any employer pilot is commercial use.
- **Plans.**
  - **API Standard** (€29/month) covers live forecasts.
  - **API Professional** (€99/month) is required for "Historical, climate, ensemble, and satellite radiation APIs"
    [DOCS]. The pilot's forecast-skill evaluation needs previous model runs. We therefore plan Professional for the pilot
    months and Standard for routine deployments [D].
- **Attribution.** "Weather data by Open-Meteo.com" (CC BY 4.0), a licence link, and the Copernicus/ECMWF attribution
  must appear wherever weather data is shown. The data layer exports these strings (`src/data/weather.ts`).
- **Paid plans target 99.9 % uptime** [DOCS].
- **National Center of Meteorology (NCM).** No public developer API is documented (UNVERIFIED).

### 4.5 Market size

These pools are illustrative upper bounds [D, research Appendix A]. Each assumes 100 % penetration and 6 billing months.
They are not forecasts.

| Pool | Workers | US$1.5 per worker-month | US$3 | US$6 |
|---|---:|---:|---:|---:|
| Abu Dhabi construction (2019) | 420,654 [S, S45] | US$3.8 M | US$7.6 M | US$15.1 M |
| UAE construction (2022) | 1,386,498 [S, S45/S46] | US$12.5 M | US$25.0 M | US$49.9 M |

The oil and gas, energy, facilities management, logistics and municipal segments come on top; their headcounts are not
isolated in public statistics. Arab States construction is projected to employ 8.6 million workers by 2030 [P, S4].

### 4.6 Beachhead and expansion [D]

1. **Abu Dhabi first.** The ADOSH TWL standard exists, and the `abu-dhabi` rule pack already encodes it with the MoHRE
   midday break. It is covered by 173 tests for TWL and the rule packs.
2. **The other emirates next.**
   - The `sharjah` pack (OSHJ-CoP-33 v2) is encoded.
   - Dubai Municipality's guideline is verified only at V2.0; V3.0 could not be retrieved.
3. **Then the GCC.**
   - The `qatar` pack (Ministerial Decision 17/2021) is encoded.
   - Saudi Arabia's heat-index tiers are documented in the research but not yet a pack.

---

## 5. Pilot design: Zill-AD1

### 5.1 Objectives

- **Primary.** Can Zill's rest prescriptions be delivered and followed in a working Abu Dhabi contractor? This is
  measured as adherence.
- **Secondary.** Estimate alert lead time, the false-alarm rate, acceptability, data quality, safety events, reach and
  equity, and governance performance. Use the results to size a scaled effectiveness trial and to test willingness to
  pay.
- **Not an objective.** Showing that Zill reduces heat illness (§5.6).

### 5.2 Setting and participants

- **Setting.** One contractor in Abu Dhabi with about 200 outdoor or industrial workers in 8 crews of about 25, defined
  by foreman. Prefer a site that has, or can install, a WBGT/TWL meter.
- **Eligibility** [D]. Adult workers on the contractor's payroll assigned to the participating crews.
- **Consent model** [D; the ethics committee decides]:
  - Zill's crew-level functions are delivered to every worker in a crew once it crosses over: the supervisor console,
    crew alerts and site flag boards. These functions implement controls the employer must already apply.
  - Individual research data (check-ins, surveys, linked app logs) is collected only from workers who consent.
  - Workers who do not consent are counted only in crew-level, k-suppressed totals.

### 5.3 Design: a cluster-randomised stepped wedge

The design follows Hussey & Hughes 2007 and Hemming 2015 and 2018 [P, S91]. The 8 crews form 4 groups of 2, and the
order in which groups start Zill is randomised.

| Group | Wk 1 | Wk 2 | Wk 3 | Wk 4 | Wk 5 | Wk 6 | Wk 7 | Wk 8 | Wk 9 | Wk 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| A (2 crews) | U | U | **Z** | **Z** | **Z** | **Z** | **Z** | **Z** | **Z** | **Z** |
| B (2 crews) | U | U | U | U | **Z** | **Z** | **Z** | **Z** | **Z** | **Z** |
| C (2 crews) | U | U | U | U | U | U | **Z** | **Z** | **Z** | **Z** |
| D (2 crews) | U | U | U | U | U | U | U | U | **Z** | **Z** |

U = usual care; Z = Zill. Example dates: 1 June – 9 August 2027.

**Exposure** [D]:
- 40 of the 80 crew-weeks are under Zill.
- That gives about 6,000 worker-shifts with Zill and 6,000 without, out of 12,000 in total (200 workers × 10 weeks × 6
  shifts).

**Why a stepped wedge.**
- Every crew receives Zill, which makes the design acceptable to the employer and the workers.
- Common period effects are modelled directly (§5.7).

**Usual care.** The MoHRE midday break, the contractor's HSE heat plan, and ADPHC materials.

**Intervention.**
- The `abu-dhabi` rule pack: ADOSH-SF CoP 11.0 v4.0 TWL zones plus the MoHRE midday break. The research calls these
  AE-AZ-ADPHC-TWL and AE-MOHRE-MIDDAY.
- Inputs from the site meter and the forecast.
- Multilingual prompts: in-app first, WhatsApp second, SMS for critical alerts.
- Tap check-ins for symptoms.
- The supervisor console.
- Escalation to the first aider.

**Not included.**
- Wearables (`docs/GOVERNANCE.md` §9).
- Voice check-ins. They are not built (the prototype's voice is output only) and would need their own DPIA entry.

**Shadow mode during usual care** [D]. For crews still on usual care, Zill runs in shadow mode on environmental and roster
data only, with no personal health data. It records what it *would* have prescribed. That lets lead time and technical
false alarms be compared across periods, computed with the same pure functions the simulation uses (`docs/SIMULATION.md`
§4–5).

**Period effects and contamination.**
- The midday break starts on 15 June. That is the first day of week 3, the week group A starts Zill. Summer heat also
  rises through the pilot. Both are common to all crews, so fixed period effects in the analysis absorb them.
- Crews on one site share HSE staff and can see each other's flag boards. Contamination will be recorded.
- Fallback design: a controlled before–after study with a second site (research §6.5).

### 5.4 Endpoints, fixed before the start

| Endpoint | Definition | Source | Role |
|---|---|---|---|
| **Adherence** | % of Zill rest prescriptions started within 10 minutes and completed for at least the prescribed duration | Supervisor confirmation + app log | **Primary (feasibility)** |
| **Alert lead time** [D] | <ul><li>(a) *Event lead time*: minutes from the first individual Zill alert at HIGH or above (an alert about that worker, `Alert.basis` individual; ARCHITECTURE §6) to the onset of a later symptomatic event in the same shift (a T2+ check-in or a first-aid case). Exposure advisories, which describe site or crew conditions, are not counted here; they are reported with the alert burden. The lead time from any alert at HIGH or above, worker or crew, is reported alongside for comparison with the simulated cohort's v0.1 definition.</li><li>(b) *Forecast lead time*: hours between the planner's advance warning and the first hour the site meter confirms the Medium or High TWL zone.</li><li>Reported as median and interquartile range.</li></ul> | App log, clinic log, site meter | Secondary |
| **False-alarm rate** | <ul><li>*Technical*: % of zone escalations later traced to a sensor or forecast error.</li><li>*Clinical*: % of symptom escalations the first aider judges not heat-related.</li><li>Also: the positive predictive value of symptom escalations, and alerts per worker-shift (alert burden), split into individual alerts and exposure advisories by recipient role.</li></ul> | First-aider review form; meter log | Secondary |
| **Acceptability** | <ul><li>Worker survey and focus groups in 4 or more languages, run by research staff, never supervisors.</li><li>Supervisor and HSE interviews.</li></ul> | Research staff | Secondary |
| **Data quality** [D] | <ul><li>Share of decisions made with a valid site meter reading.</li><li>Share made on a stale forecast (> 6 h) or the conservative default.</li><li>Sync completeness: payloads received ÷ expected.</li><li>Check-in response rate.</li><li>Message delivery rate by channel.</li><li>Translation comprehension (ANSI Z535.3: at least 85 % correct and under 5 % critical confusion).</li></ul> | App and gateway logs; comprehension test | Secondary |
| **Safety events** | <ul><li>Heat-related first-aid and clinic visits per 1,000 worker-shifts, using standard case definitions.</li><li>Serious adverse events, such as heat stroke or hospital transfer.</li><li>Any instance of Zill showing less protection than the law or the HSE plan requires (target 0).</li></ul> | Site clinic log; safety monitor; audit | Safety |
| **Reach and equity** | <ul><li>Weekly active share by language group.</li><li>Alert, false-alarm and adherence rates by language group and age band.</li></ul> | App | Secondary |
| **Symptom reports** | Heat-symptom check-ins per 1,000 worker-shifts | App | Secondary |
| **Lost work time** | <ul><li>Minutes lost to heat illness per 1,000 worker-hours.</li><li>Prescribed rest minutes, reported as a productivity cost.</li></ul> | Clinic log + Zill | Secondary |
| **Governance** | <ul><li>Attempted out-of-scope data requests (target: 0 disclosed).</li><li>Audit chain verified against every published anchor.</li></ul> | Audit log (`docs/GOVERNANCE.md` §6) | Secondary |

### 5.5 Precision

These figures come from research Appendix A and assume the worst case, p = 0.5 [D].

| Rest prescriptions observed | 95 % CI half-width for adherence | With design effect 2 |
|---:|---:|---:|
| 100 | ± 9.8 percentage points | ± 13.9 |
| 300 | ± 5.7 | ± 8.0 |
| 1,000 | ± 3.1 | ± 4.4 |

### 5.6 Why incidence cannot be the endpoint

- **At the 2008 Abu Dhabi baseline** (15.3 cases per 1,000 workers per year) [P, S9], 200 workers would produce
  **0.59** expected clinic cases if cases are spread across the year (10 of 52 weeks). If all the year's cases fell
  inside the pilot window, they would produce **3.06** [D].
- **At the post-programme rate** (1.16 per 1,000), the expectation is 0.04–0.23 cases [D].
- **The chance of seeing no cases at all** is 0.05 at the upper baseline figure and 0.79 at the upper post-programme
  figure [D].
- The pilot therefore estimates rates with 95 % confidence intervals and does not test effectiveness. A future
  effectiveness trial will need many sites, and the pilot data will set its size.
- The simulation cannot fill this gap either. It shows mechanisms and sensitivity, not real-world benefit
  (`docs/SIMULATION.md` §6).

### 5.7 Analysis and progression

- **Model.** Mixed-effects models with fixed period effects and a random crew effect [P, S91].
- **Reporting.** Under the CONSORT stepped-wedge extension and the CONSORT pilot extension [P, S91].
- **Registration.** The protocol and the analysis plan are registered before the first worker is enrolled [D].
- **Progression criteria for a scaled trial** [D, research §6.5]:
  - at least 70 % of workers active each week;
  - at least 80 % rest-prescription adherence;
  - technical false alarms at most 10 % of escalations;
  - zero governance breaches;
  - at least 75 % of respondents rating Zill "acceptable" or better.

### 5.8 Safety monitoring

- **Independent monitor.** A site physician independent of the sponsor acts as safety monitor. The monitor reviews every
  serious event and can recommend a pause.
- **No loss of protection.**
  - Zill never permits work that the law or the HSE plan forbids; the regulatory floor is enforced in code.
  - The HSE plan stays in force in both arms.
- **Heat-stroke protocol.** Cool first, transport second. Someone calls 998 (police 999, fire 997) [P, S93].
- **Incident notification.** Notifiable incidents are reported under ADOSH-SF Mechanism 11.0 on Form G: within 24 h for
  fatalities and within 3 working days for other serious incidents (`twl_and_regulation.md`; who files is an open
  decision in `docs/GOVERNANCE.md` §13).
- **Stopping rules** [D]. Zill delivery pauses in either of these cases:
  - a serious adverse event is plausibly linked to a Zill failure, such as a missed or late escalation;
  - a governance breach discloses individual data outside its permitted scope.

  It resumes only after review by the safety monitor, the DPO and the ethics committee.

### 5.9 Data management

- Hosting in the UAE, with no offshore copies.
- A DPIA (`docs/GOVERNANCE.md` §11).
- A pseudonymised analysis dataset held by research staff.
- Aggregates suppressed below k.
- Retention as approved by the ethics committee.
- All access logged in the hash-chained audit log.

---

## 6. Ethics, approvals and worker representation

| Requirement | What we will do | Basis |
|---|---|---|
| **Ethics approval** | <ul><li>Submit to the facility research ethics committee and to the DoH-IRB (ADHRTC) at the same time.</li><li>The DoH Medical Research Department gives pathway guidance within 5 working days of a preliminary application.</li><li>The committee sets the review tier (Exempt, Expedited or Full). "Research involving vulnerable populations … is rarely exempt", so we plan for Expedited or Full review.</li></ul> | DoH SBR 2026 [P, S70] |
| **Workers as vulnerable participants** | <ul><li>Supervisors never obtain consent.</li><li>Trained research staff take consent (§3.11.2.5).</li><li>The committee includes members experienced with migrant worker populations.</li></ul> | DoH SBR 2026 [P, S70] |
| **Consent documents** | <ul><li>Arabic and English with the same text (§3.5.3.2.4).</li><li>Authenticated translations into Hindi, Urdu, Malayalam, Bengali, Tagalog and Nepali.</li><li>Clear, practical, non-technical and non-exculpatory wording.</li><li>An impartial witness signs for anyone who cannot read.</li><li>Free to decline or withdraw, with no consequence.</li></ul> | DoH SBR 2026 [P, S70]; ILO code §5.13 [P, S73] |
| **Consent records in Zill** | <ul><li>`createConsentReceipt()` records the notice version, the language, the method (including a witnessed mark with the witness id) and the collector, which can never be a supervisor.</li><li>The current translations are machine drafts and are not deployable until reviewed (`docs/GOVERNANCE.md` §4.7).</li></ul> | `src/engine/privacy.ts` |
| **Data protection** | <ul><li>A DPIA (PDPL Art. 21).</li><li>ADHICS-aligned controls (SBR §3.1.2.4).</li><li>Data leaves the UAE only under MD 51/2021, encrypted and from a DoH-IRB-approved study (SBR §3.3.1.1.11.3).</li><li>Compliance with the DoH Responsible AI Standard (SBR §3.1.2.3).</li></ul> | [S, S63]; [P, S70] |
| **Insurance** | <ul><li>Insurance is mandatory for interventional clinical trials (SBR §3.7). A non-interventional, minimal-risk pilot may not need it.</li><li>A stepped wedge *assigns* the intervention, so the committee may class it as interventional. We will budget for insurance until the committee decides [D].</li></ul> | DoH SBR 2026 [P, S70] |
| **Regulatory qualification** | <ul><li>A written qualification memo to the Emirates Drug Establishment (EDE), using the intended-purpose wording.</li><li>No physiological alerting in the pilot.</li></ul> | `docs/GOVERNANCE.md` §9 |
| **Employer agreement** | <ul><li>Purpose limitation and the excluded uses (clauses C1–C12).</li><li>Prescribed rest is paid (C161 Art. 12).</li><li>Free to workers (C155 Art. 21).</li><li>The employer keeps every legal duty.</li></ul> | `docs/GOVERNANCE.md` §5.3 |
| **Worker representation** | <ul><li>An elected site worker safety committee, consulted before launch.</li><li>An independent ombudsperson channel in the workers' languages [D].</li><li>The committee receives the audit-log anchors and the governance report.</li></ul> | ILO code §12.2 [P, S73]. Trade unions are "banned or restricted" in Gulf states [P, S24], hence this substitute mechanism. |
| **Emergency pathway** | Suspected heat stroke: first aid and cooling, then an ambulance on 998. | [P, S93] |

---

## 7. Integrations

| Integration | Purpose | State of the prototype | Pilot plan |
|---|---|---|---|
| **Site WBGT/TWL meters**: Kestrel 5400 (WBGT and TWL, Bluetooth LiNK) [P, S57]; SlateSafety BEACON (estimated WBGT, heat index) [P, S49]; TWL-1S meters [P, S60] | Ground truth for the TWL rule pack | <ul><li>A meter reading is used if it is no more than 15 minutes old and passes plausibility ranges [ENG].</li><li>Source priority: meter, then forecast, then archive, then cached forecast, then a conservative default.</li><li>Each assessment records the source and whether it is stale (`dataQuality`).</li></ul> | One meter at the pilot site, read through the vendor's export or a Bluetooth gateway [D] |
| **Weather forecasts**: Open-Meteo (ECMWF IFS) | Forecast input and the planner | Cached archive and live forecast, with attribution strings | Paid Professional plan for the pilot months (§4.4) |
| **Worker channel**: the installed offline web app; WhatsApp Business Platform [P, S58]; SMS through Twilio or a local aggregator [P, S59] | Alerts and check-ins | <ul><li>Offline-capable web app.</li><li>Eight languages with right-to-left support.</li><li>Speech output.</li></ul> | <ul><li>App first, WhatsApp second, SMS for critical alerts.</li><li>Register the sender ID early (lead time).</li><li>Message templates in eight languages.</li></ul> |
| **HSE platforms**, e.g. Mitti/SafetyCulture "integrations" [P, S55] | Incident and first-aid logs, inspections | — | Export by CSV or API, k-suppressed aggregates only (`docs/GOVERNANCE.md` §7) |
| **Crew roster / HR system** | Pseudonym → name, crew, site, days on site | Synthetic workforce (`src/data/workforce.ts`) | <ul><li>Import from the contractor's roster.</li><li>Nothing flows back to HR except compliance aggregates (k = 10).</li></ul> |
| **Site flag boards** | Physical mirror of the zone status | — | Match the Dubai Municipality four-colour scheme [P, S31] and ADNOC's flag system [P, S38] |
| **Wearables** (optional, later): SlateSafety API [P, S49]; Kenzen planned open APIs as of 2020 [S, S48] | Optional physiological context | Physiology models built in `src/engine/physio.ts`, consent-gated, processed on the device | **Not in the pilot.** Requires the regulatory gate and a USARIEM licence (`docs/GOVERNANCE.md` §9). |
| **Regulator reporting** | Multi-site aggregates (hours in each TWL zone, compliance) and Form G prompts | Engine support: k = 10 aggregates (`aggregateFor()`) and `heatIncidentNotification()`. The regulator view is specified in ARCHITECTURE §9. | Agree the report format with ADPHC/ADOSH |

---

## 8. Deployment architecture and scaling

- **Edge-first.** The engine is pure TypeScript, with no DOM or network access. The same code runs on a phone, a site
  gateway or a server (ARCHITECTURE §3). Individual physiology and health data are processed on the worker's phone.
- **Offline by design.**
  - The phone keeps computing from cached forecasts and, failing those, from a conservative per-site default.
  - Missing data only makes results more conservative. A forecast older than 6 h lowers confidence; one older than 24 h
    adds a 1 °C WBGT margin (ARCHITECTURE §5).
  - During a network outage the phone keeps alerting the worker locally. Only actions that go through the supervisor are
    delayed (`docs/SIMULATION.md` §5).
- **Sync.** The prototype uses a BroadcastChannel inside the browser (message schema: ARCHITECTURE §10). Production uses
  a site gateway (MQTT or HTTPS) with an SMS fallback. The routine payload is about 224 bytes, so bandwidth and the SMS fallback stay cheap
  (`docs/GOVERNANCE.md` §2.4).
- **Hosting.**
  - A UAE cloud region, for example Azure UAE North or UAE Central (research §4.1). Microsoft co-created the Challenge.
  - HTTPS throughout, because the hash-chained audit log needs a secure context.
  - ADHICS-aligned controls for DoH-licensed partners.
- **Per-jurisdiction rule packs.** Regulation is held as data, so adding a jurisdiction is a configuration change, not a
  code change (ARCHITECTURE §1 principle 6). Three packs are encoded and tested:
  - `abu-dhabi`: ADOSH-SF CoP 11.0 v4.0 and the MoHRE midday break;
  - `sharjah`: OSHJ-CoP-33 v2 and the midday break;
  - `qatar`: Ministerial Decision 17/2021, on UTC+3.
- **Multi-tenant** [D]. One tenant per employer. Aggregates never cross tenants, except in regulator reports.
- **What drives cost as Zill scales.**
  - Messages, which scale per worker (§4.3).
  - The weather plan and the sender ID, which are per account and can be shared.
  - Meters, one per site.
  - Support and translation upkeep.

---

## 9. Timeline to the June 2027 season

| When | Milestone | Gate or dependency |
|---|---|---|
| 20 Nov 2026 | Prototype submission; evaluation runs 20–30 Nov [P, S87] | The launch press release says applications close on 15 Nov [P, S86]. Confirm the deadline. |
| 7–11 Dec 2026 | Awards at GITEX; seek a contractor letter of intent | The readiness package (table below) |
| Jan–Feb 2027 | <ul><li>Protocol and DPIA.</li><li>Employer agreement.</li><li>EDE qualification memo.</li><li>Native-speaker review and authenticated translation of the consent documents begin.</li></ul> | Signed letter of intent |
| Feb–Apr 2027 | Ethics committee and DoH-IRB review; DoH pathway guidance within 5 working days of the preliminary application [P, S70] | A complete submission |
| Mar–Apr 2027 [D] | <ul><li>Hosting in the UAE.</li><li>Paid Open-Meteo plan.</li><li>SMS sender-ID registration and WhatsApp templates.</li><li>Meter purchase.</li></ul> | Sender-ID lead time |
| May 2027 | <ul><li>Site set-up and baseline.</li><li>Translations final and comprehension-tested.</li><li>Worker committee consulted.</li><li>Consent sessions run by research staff.</li><li>Supervisor and first-aider training.</li><li>Shadow-mode dry run [D].</li></ul> | Ethics approval |
| 1 Jun – 9 Aug 2027 | The pilot (the midday break starts on 15 June) | — |
| Sep 2027 | Analysis | — |
| Oct 2027 | Report, decision against the progression criteria, and a plan for a scaled trial in 2028 | — |

**Critical path.** Ethics approval must arrive by the end of April 2027. If it slips, we have three options [D]:
1. Start later. The ban runs to 15 September, so a later start keeps the 10 weeks inside the hot season.
2. Shorten the steps.
3. Switch to the controlled before–after fallback.

**Readiness package for GITEX.** The research lists these items for a "pathway beyond the Challenge" (§5) [D].

| Item | State on 10 Nov 2026 |
|---|---|
| Pilot protocol formatted for a DoH ethics committee | Design in §5; needs formatting to the committee's template |
| DPIA draft | Outline in `docs/GOVERNANCE.md` §11 |
| Regulatory qualification memo | Intended-purpose wording ready (`docs/GOVERNANCE.md` §9); memo not yet written |
| A named contractor willing to sign a letter of intent | Not yet |
| Data-residency plan for the UAE | Outline in `docs/GOVERNANCE.md` §2.3 |
| Evidence that the rule packs reproduce the ADPHC tables exactly | Done in the prototype: 173 tests across `src/engine/twl.test.ts` and `src/engine/regulation.test.ts` |

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| No contractor signs a letter of intent | Approach main contractors through GITEX and Future Health. Offer a waived or nominal fee for the pilot season in exchange for willingness-to-pay interviews and a data-access agreement [D]. |
| Ethics review takes longer than planned | Send the preliminary application to the DoH in January for pathway guidance. Use the fallbacks in §9. |
| The ethics committee classes the pilot as interventional | Budget for trial insurance (§6). |
| Workers fear surveillance and do not take part | <ul><li>Governance by design: health data stays on the phone, and there are no wearables.</li><li>Research staff take consent.</li><li>The worker committee and the non-retaliation clause.</li><li>Free to workers.</li></ul> |
| Low literacy, or a language not understood | <ul><li>Eight languages, voice, pictograms and colour.</li><li>Comprehension testing and authenticated translations before deployment.</li></ul> |
| Workers without a smartphone or data | <ul><li>The employer provides devices and data (C155 Art. 21).</li><li>WhatsApp and SMS fallbacks.</li><li>Crew-level alerts through the supervisor and the flag boards.</li></ul> |
| Poor connectivity on site | Offline-first operation on the phone, a site gateway, and SMS fallback for critical alerts. |
| Alert fatigue | <ul><li>Crew bundling, dwell time and hysteresis, and repeat suppression (ARCHITECTURE §6).</li><li>Alerts per worker-shift are monitored.</li><li>Thresholds change only through change control (`docs/GOVERNANCE.md` §10.6).</li></ul> |
| A missed or late escalation | <ul><li>Fail-safe defaults; symptoms override models; the regulatory floor.</li><li>The independent safety monitor and the stopping rules (§5.8).</li></ul> |
| Meter or forecast failure | <ul><li>The source hierarchy and the conservative default, with a +1 °C margin when data is stale.</li><li>Meter maintenance.</li><li>The data-quality endpoint (§5.4).</li></ul> |
| Weather licence breach | Buy a paid Open-Meteo plan before any employer use; the free tier is non-commercial. Show attribution wherever weather data appears. |
| Messaging costs above plan, or WhatsApp price changes | <ul><li>App first; SMS only for critical alerts.</li><li>Track cost per worker-shift during the pilot.</li><li>Re-price each season (§4.3).</li></ul> |
| Classification as a medical device | <ul><li>The intended-purpose statement and claims discipline.</li><li>No physiological alerting in the pilot.</li><li>The written EDE qualification memo (`docs/GOVERNANCE.md` §9).</li></ul> |
| Patents on ECTemp and aPSI | <ul><li>No wearable channel in the pilot.</li><li>No commercial wearable tier without a USARIEM licence and legal review.</li></ul> |
| Contamination between crews, or period effects | Fixed period effects in the analysis; contamination recorded; the before–after fallback. |
| Uncertainty over which law applies | Design to satisfy both the PDPL and the ICT Health Law, and obtain a written opinion from counsel (`docs/GOVERNANCE.md` §13). |
| The employer misuses data | <ul><li>Prohibited purposes are refused in code and logged.</li><li>Contract penalties and a right to terminate.</li><li>Reporting to the worker committee.</li></ul> |

---

## 11. KPIs

| Area | KPI | Target |
|---|---|---|
| **Feasibility** (progression criteria) [D] | Weekly active workers | ≥ 70 % |
| | Rest-prescription adherence | ≥ 80 % |
| | Technical false alarms | ≤ 10 % of escalations |
| | Governance breaches | 0 |
| | Acceptability | ≥ 75 % of respondents rate Zill "acceptable" or better |
| **Safety** | Instances of Zill showing less protection than the law or the HSE plan requires | 0 |
| | Serious adverse events reviewed by the safety monitor | 100 % |
| | Heat-related first-aid and clinic visits per 1,000 worker-shifts | Reported with a 95 % CI (no target; not powered) |
| **Alerting quality** | Alert lead time (event and forecast) | Reported as median and IQR |
| | Positive predictive value of symptom escalations; alerts per worker-shift | Reported |
| **Data quality** | Decisions with a valid meter reading; decisions on stale or default input; sync completeness; delivery by channel | Targets to be fixed in the protocol |
| **Governance** | Attempted out-of-scope requests | 0 disclosed |
| | Audit chain verified against every published anchor | 100 % |
| **Equity** | Weekly active, alert and adherence rates by language group and age band | Gaps reported to the worker committee |
| **Commercial** [D] | Contractor letter of intent | Signed by February 2027 |
| | Willingness to pay at US$3 and US$6 per worker-month, and for a site fee | Tested with the pilot employer and at least two other contractors |
| | Measured cost to serve per worker-season, against the model in §4.3 | Within the modelled range, or the model is re-run |
| | Pilot employer converts to a paid second season | Yes / no |

---

## 12. Open decisions

1. **Consent model in a cluster design.** Should crew-level Zill functions reach workers who decline research
   consent? The ethics committee decides (§5.2).
2. **Insurance.** Is the stepped wedge "interventional" in the sense of SBR §3.7? The ethics committee decides (§6).
3. **Controller identity.** Who is the controller in the pilot, the sponsor or the employer, and on what processor
   terms (`docs/GOVERNANCE.md` §13 item 13)?
4. **Weather plan.** Professional for the pilot months (needed for previous model runs) or Standard only (§4.4).
5. **Sender ID.** Can one Zill-wide alphanumeric sender ID serve all customers under UAE registration rules, or does
   each customer need its own (§4.3)?
6. **Price points to test.** We propose US$3–6 per worker-month and/or a site fee, because US$1.5 does not cover direct
   costs at single-site scale (§4.3).
7. **Voice check-ins.** They are proposed in the research pilot design but not built. They need an implementation and a
   DPIA entry before use (§5.3).
8. **Rule-pack naming.** The research names two packs (AE-AZ-ADPHC-TWL and AE-MOHRE-MIDDAY). The code has a single
   `abu-dhabi` pack that contains both. This document uses the code name.
