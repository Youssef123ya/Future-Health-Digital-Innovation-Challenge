# Zill — Architecture

Zill (ظل, Arabic for "shade") is an early-warning system for heat strain in outdoor and industrial workers. It is built for
Future Health Digital Innovation Challenge 07, *Climate-Resilient Worker Health*. This document defines the system's
principles, module boundaries, contracts and the logic behind each warning. Contributors follow it, and the judges' technical
documentation is built from it.

## 1. Principles (non-negotiable)

1. **Worker protection before productivity.** No feature optimises output at the expense of a protective action. The
   planner may reschedule work, but it never removes rest that a protective rule requires.
2. **Every number traces to a standard.** Every threshold and model comes from a published standard or regulation:
   - ISO 7243 (WBGT), with Liljegren 2008 for outdoor WBGT
   - ISO 7933 Predicted Heat Strain (PHS)
   - ISO 8996 metabolic rates
   - NIOSH 2016 exposure limits (REL for acclimatised workers, RAL for unacclimatised workers)
   - ACGIH clothing adjustments
   - Thermal Work Limit (TWL; Brake & Bates 2002), the index of Abu Dhabi's ADOSH-SF CoP 11.0 *Safety in the Heat*
     v4.0 and its Technical Guideline (ADPHC, 15 July 2024)
   - the UAE MoHRE midday break (Ministerial Resolution 44/2022)
   - Buller 2013 core-temperature estimate from heart rate (ECTemp)
   - Moran 1998 Physiological Strain Index (PSI)
   - ACSM 2023 exertional heat illness consensus, ILCOR/TB MED 507/NIOSH first aid

   Every rule records its `basis` string, which the UI shows to the user. Zill introduces no new opaque score.
   Engineering choices that no standard fixes (tie-breaking at a boundary, a dwell time) are tagged `[ENG]` in code and
   resolved in the protective direction.
3. **Fail-safe.** A missing, stale or poor-quality input can only make the result more conservative, never less.
   No sensor can talk a worker out of a rest break: the physiology channel can raise the level but never lower it.
4. **Symptoms override models.** Any red-flag symptom immediately triggers EMERGENCY. The response is
   *cool first, transport second*, and someone calls 998. Symptom- and physiology-driven levels latch: they clear only
   when a first aider or supervisor marks the case resolved after a symptom-free re-check, and after T2/T3 the
   worker does no more hot work that day.
5. **Privacy by architecture, not by policy.** Individual physiological and health data stays on the worker's device.
   Information leaves the device only as "level + action". The rules below are enforced in code and covered by tests:
   - Supervisors see what to do, never clinical detail.
   - Clinical detail reaches occupational health only when a case is escalated and the worker has consented.
   - Employers and regulators see only aggregates, with small cells suppressed.
   - Requests for prohibited purposes (performance, discipline, insurance, immigration) are refused and the
     refusal is logged.
6. **Regulatory floor.** Zill never recommends less protection than the law requires. That means the UAE midday
   break (15 Jun–15 Sep inclusive, 12:30–15:00) and the ADOSH TWL zone controls (work/rest cycles, no unacclimatised
   workers and no lone work in the Medium and High zones). Regulation is held as data in a jurisdiction rule pack, so
   another emirate's rules (for example Sharjah OSHJ-CoP-33) are a configuration change, not a code change.
7. **Honest evidence.** Every metric states its data source: a reference implementation, real weather, archived
   forecasts, or a simulated cohort. Model projections are labelled as projections.
8. **Claims discipline.** Zill is occupational-safety decision support. It does not diagnose, it does not "predict
   heat stroke", and it does not "measure core temperature". The heart-rate model output is an *estimated strain
   indicator* shown with its uncertainty band, only to the worker and, after a consented escalation, to occupational
   health.

## 2. System context

| Actor | Device | Sees | Never sees |
|---|---|---|---|
| Worker | Phone or band (installable offline web app) | own level, actions, countdown, own data, who accessed it | other workers' data |
| Buddy | Phone | partner's level and a buddy-check prompt | partner's clinical data |
| Crew supervisor | Tablet or phone | crew board: name, level, action, ack status; site forecast; planner | heart rate, core temperature, risk flags, symptoms |
| First aider | Phone | active stop and emergency cases, protocol, location; reported symptoms once a case is escalated (vital interest) | history, physiology, risk flags (medical data stays with staff bound by medical secrecy, ILO code §8.2) |
| Occupational health nurse | Console | escalated cases with consented clinical detail | non-escalated workers |
| HSE manager | Console | site aggregates, compliance, incidents (suppressed below k) | individual records |
| Regulator (ADPHC / ADOSH) | Console | multi-site aggregates, hours in each zone, compliance (k-suppressed) | any individual record |
| Employer HR | — | nothing individual: access is refused by policy and the refusal is logged | everything individual |

## 3. Layers

```
┌──────────────────────── Worker device (edge) ───────────────────────┐
│ Environment input (site WBGT meter → forecast → cached → default) │
│ engine/*  (pure TypeScript, no DOM, no network)                   │
│   heat indices → channels → fusion → alert policy                 │
│ physiology (ECTemp, PSI) stays on device; check-ins stay on device│
│ outbound: {pseudonym, level, actions, workMinPerHour, ack}        │
└───────────────┬──────────────────────────────────────────────────────┘
                │ sync bus (prototype: BroadcastChannel + in-memory;
                │  production: site gateway, MQTT/HTTPS, SMS fallback)
┌───────────────▼─────────────── Views (role-projected) ───────────────┐
│ Supervisor console · First aider · Occupational health · HSE ·     │
│ Regulator · Governance centre · Simulation lab · Evidence          │
└──────────────────────────────────────────────────────────────────────┘
```

The prototype runs entirely in the browser as a static, installable, offline-capable web app. `engine/` is pure TypeScript
with no DOM or network access, so the same code can run on a phone, a site gateway, or a server. The sync bus and its
message schema are in §10.

## 4. Repository layout and ownership

```
src/
  engine/            pure domain logic (no React, no fetch, no Date.now() — time is passed in)
    types.ts         shared contracts (this file is the source of truth for names)
    time.ts          Abu Dhabi local time helpers (UTC+4, no DST)
    units.ts         conversions
    psychro.ts       saturation vapour pressure (Liljegren and Tetens forms), RH/dew point
    solar.ts         solar position (NOAA), cos zenith, extraterrestrial irradiance
    wbgt.ts          Liljegren outdoor WBGT (globe, natural and psychrometric wet bulb), shade WBGT, globe MRT
    phs.ts           ISO 7933 Predicted Heat Strain (run + stateful stepper)
    twl.ts           Thermal Work Limit
    limits.ts        ISO 8996 classes, NIOSH REL/RAL, ACGIH clothing adjustments, work–rest TWA, heat index, TB MED 507 fluids
    regulation.ts    jurisdiction rule packs: UAE midday break, ADOSH-SF CoP 11.0 v4.0 TWL zones and controls
    physio.ts        ECTemp Kalman filter, PSI, HR signal-quality index, sustained-HR rule
    clinical.ts      symptom check-in triage, red flags, urine colour, fluid caps, risk-flag handling
    indices.ts       EnvSample → SiteHeat (WBGT sun/shade, TWL sun/shade, heat index, human MRT for PHS)
    risk.ts          channel evaluation + fusion → RiskAssessment (dwell, projection hold and resume check)
    alerts.ts        alert policy: escalation, alert basis, ack timeouts, escalation record, crew bundling
    planner.ts       forecast-aware work/rest schedule with an ISO 7933 screen, rotation, water logistics
    privacy.ts       role/purpose projections, consent checks, k-suppression, hash-chained audit log
  data/              sites, weather loading (cached JSON → live Open-Meteo → fallback), synthetic workforce
  sim/               seeded RNG, contracts (types.ts), Gagge ground truth, world simulation, scenarios, back-test, metrics
  i18n/              messages (en, ar, hi, ur, ml, bn, tl, ne), RTL handling, speech
  ui/                React views and components
  state/             zustand stores (simulation clock, world state, role, language), governance ledger, cross-tab sync bus (§10)
scripts/
  oracles/           Python scripts that generate reference vectors from pythermalcomfort / thermofeel
  data/              weather and observation download scripts (Node, dependency-free)
  validate/          tsx scripts that regenerate every evidence number → public/data/validation/*.json
fixtures/            oracle vectors (JSON) consumed by unit tests
public/data/         cached weather archive, archived forecasts, observations, validation outputs
docs/                ARCHITECTURE, SCIENCE, SIMULATION, GOVERNANCE, PILOT, LIMITATIONS, VALIDATION, research notes
```

**Conventions**
- Units are encoded in property names: `C`, `Pct`, `Hpa`, `Ms`, `Wm2`, `W`, `Kg`, `Cm`, `Min`, `Ml`, `Bpm`.
- Timestamps are epoch milliseconds in UTC. Local time is always Asia/Dubai (UTC+4, no DST).
- The engine has no hidden clocks or randomness. Simulations use the seeded RNG in `sim/rng.ts`.
- Tests sit next to the code as `*.test.ts`. Reference tests read `fixtures/*.json` and assert the tolerances
  documented in `docs/SCIENCE.md`.
- No `any` in exported engine APIs. Every exported function has a TSDoc comment that cites its `basis`.

## 5. Risk channels and fusion (`engine/risk.ts`)

Each channel returns `{level, available, drivers[]}`. The final level is the **maximum** across channels. Symptoms can
force EMERGENCY. Levels: `safe < caution < high < stop < emergency`.

| Channel | Inputs | Logic (summary) | Basis |
|---|---|---|---|
| environment | WBGT (sun/shade), task metabolic rate, clothing, acclimatisation, conservative mode | WBGT_eff = WBGT + CAV(ensemble) + 1 °C if hooded (CAVs are not additive). Limit = REL (acclimatised) or RAL (unacclimatised, acclimatising, or conservative mode). The allowed work fraction *f* is the largest *f* with Limit(*f*·M_work + (1−*f*)·115 W) ≥ *f*·WBGT_work + (1−*f*)·WBGT_rest (1-h time-weighted averages). WBGT_rest is the site's rest area: an air-conditioned cabin (ADOSH CoP 11.0 §3.2(c); fixed cabin WBGT [ENG]) or, where only shade exists, the modelled shade WBGT — in the Gulf summer shade alone often exceeds the resting limit, so cooled rest is what makes work/rest cycles feasible. *f* ≥ 1 with ≥ 1 °C margin → safe; *f* ≥ 1 within 1 °C, or *f* ≥ 0.75 → caution; 0.25 ≤ *f* < 0.75 → high; *f* < 0.25 → stop (heavy outdoor work deferred; light tasks only) | NIOSH 2016 §8.1, ACGIH TLV, ISO 7243:2017 |
| regulation | date/time, TWL, outdoor-in-sun flag, acclimatisation | Midday break (15 Jun–15 Sep inclusive, 12:30 ≤ local time < 15:00) and the task is outdoors in the sun → stop (`midday_break`). ADOSH TWL zones: Low (TWL > 140 W/m²) → safe; Medium (115–140) → caution, heavy work 45 min work/15 min rest, no lone work; High (< 115) → high, light work 45/15, heavy work 20/40, no lone work. High zone work also needs a permit to work. An ADOSH-unacclimatised worker (new, or off work > 14 days, during the first 7 days back) in the Medium or High zone → stop for that worker (reassign). A TWL exactly on 115 or 140 resolves to the more protective zone [ENG] | MoHRE MR 44/2022; ADOSH-SF CoP 11.0 v4.0 + TG Table 1 |
| projection | running PHS state per worker (human MRT; cabin conditions while resting in a cooled area); logged intake (needs `checkins` consent); the task the worker returns to; the day plan's work minutes | Minutes until an ISO 7933:2023 limit (rectal temperature 38.0 °C, or the water-loss limit) at the current activity, re-projected every 5 min: > 90 → safe, 45–90 → caution, 15–45 → high, < 15 → stop. Below 15 min the stop is **held** until the engine's resume check passes; this is the channel's hysteresis (details below). Once a limit is reached the channel stays at stop: ISO 7933 cannot validly model recovery, so rest never "earns back" exposure automatically. Work resumes only after a human-reviewed recovery (≥ 30 min rest in a cooled area or ≥ 45 min in shade, a symptom-free check-in, and sign-off by a first aider or supervisor), after which PHS restarts from a conservative post-rest state [ENG]. The water-loss limit counts logged drinking (details below). Inputs outside the model's validity range lower the confidence and are logged | ISO 7933:2023 clause 5 and Annex B; ANSI/ISA-18.2 (alarm deadband); phs_iso7933.md §11.4 |
| physiology | ECTemp estimate, PSI, sustained HR, signal quality | Evaluated only when the channel is valid: consented, ≥ 10 of the last 15 minutes valid, 30-min warm-up done, no `hr_suppressing_medication` flag. Sustained for 5 valid minutes: T1 (→ high) at ECTemp ≥ 38.4 °C (≥ 38.0 °C in conservative mode), PSI > 6, or HR > 180 − age; T2 (→ stop) at ECTemp ≥ 39.0 °C or PSI > 8. ECTemp ≥ 38.0 °C or PSI > 4 only prompts a check-in. Physiology never triggers a 998 call by itself | Buller 2013; Hunt 2019; Moran 1998; NIOSH 2016 |
| symptoms | latest check-in (self or buddy) and follow-ups | Triage table (`physio_and_clinical.md` §10.7), mapped with `TIER_TO_LEVEL`: T3 red flags (confusion, slurred speech, unsteady walking, collapse, seizure, chest pain, repeated vomiting) → emergency; T2 (fainted, dizziness, headache, nausea, weakness, brown urine, over-drinking with symptoms, cramps ≥ 60 min) → stop + first aider + no hot work today; T1 (cramps, heat rash) → high. T2 not improving at 30 min → T3. An unanswered prompt after 5 min notifies the buddy, then the supervisor | ACSM 2023, ILCOR, TB MED 507, NIOSH 2016 |
| hydration | urine colour, logged intake | Urine shade 1–3 OK; 4 drink more (driver only); 5–6 → caution; 7–8 → high. Intake above the hourly cap (1.42 L/h) stops reminders and shows "slow down"; above the daily cap (11.36 L) → high; above a cap with symptoms → stop with `restrict_fluids` (suspected hyponatraemia) | Armstrong 8-shade chart; TB MED 507 (2022); NIOSH 2016 |

**Projection channel: hold, resume check and water-loss limit** (`RISK_THRESHOLDS.projection`, `.resume`,
`.hydrationCredit`, `.recovery` in `risk.ts`).
- **Hold.** When the projection at the current activity drops below 15 min (and no limit is reached yet), the channel
  goes to stop with `rest_shade_now` and `cool_down` and holds stop through the rest. Resting alone does not release it.
- **Resume check (the hysteresis).** Every projection cycle the engine projects, from the worker's current PHS state,
  the task the worker will return to: `WorkerContext.resumeTask`, else the current task, else the last task seen this
  shift, with that task's metabolic rate, clothing and location. The hold releases when that task reaches no limit
  within 25 min (`highFromMin` 15 + `resume.minBoutMin` 10 [ENG], an ANSI/ISA-18.2 deadband between alarm set and
  clear) and the current activity is itself out of the stop band. A rested worker is therefore not stopped again within
  10 min at constant conditions. At the release the displayed level drops at once to what the other channels show:
  the release is not delayed by the 10-min dwell of §6, while the other channels keep their own dwell.
- **Rest estimate and "not feasible now".** While held, the engine simulates rest at the place the worker already rests
  (else the site's rest area: the cooled cabin or shade) in 5-min steps up to 60 min [ENG], and the driver says about
  how many more minutes of rest are needed. If even 60 min would not pass the check, the hold is `infeasibleNow`: the
  driver `task_not_feasible_now` ("Current task is too hot to resume now: a lighter or cooler task is needed") and the
  action `rotate_task` are added, so the open stop alert that the supervisor sees asks for another task. The full
  estimate is recomputed at most every 15 min while the worker keeps resting at the same place; it counts down in
  between [ENG: performance].
- **Bout countdown.** After a release, while the resumed task projects 15–45 min, the worker's device shows "About N min
  of work left before the next rest", N = floor(minutes − 15) (`phs_work_bout`).
- **Water-loss limit with logged drinking.** ISO 7933 sets the drink-allowed limit at a cumulative water loss of 5 % of
  body mass. The engine keeps 5 % as the floor and raises it only for credited drinking: limit = max(5 % BM,
  3 % BM + C), where C = 0.8 × Σ over local clock hours of min(logged intake that hour, 1.42 L) since the shift start
  (`creditedIntakeL`; credit factor 0.8 [ENG]). The same rule reads: the net loss, sweat − max(C, 0.4 × sweat), must stay
  ≤ 3 % BM. Intake logs are hydration data, so they count only with the `checkins` consent. With no logs or no consent
  the limit is exactly ISO 7933. Projections assume no further drinking. While drinking is restricted (drink = 0 now
  or earlier in the exposure, e.g. fasting) the ISO 3 % criterion with its 0.6 rule applies unchanged, nothing is
  credited, and a reached limit ends heat work for the shift. With drinking allowed, a reached water-loss limit may
  restart after the reviewed recovery once logged drinking brings the net loss to ≤ 2 % BM [ENG: 1 % deadband]; until
  then the worker's device says "drink and rest". The derivation is in SCIENCE §2.9.
- **What stays on the worker's device.** Water figures appear only in worker-only hydration drivers
  (`phs_water_credit`, `phs_drink_to_restart`). The projection drivers name no clinical detail, but some carry a minute
  count in their text (GOVERNANCE §13 item 16).

**Day plan and the device** (`planner.ts` `PHS_SCREEN`; `WorkerContext.plannedWorkMinPerHour`).
- **Allowances.** The planner plans each crew for its strictest member (`bindingOf`): the NIOSH RAL when any member is
  not acclimatised or is in conservative mode, else the REL, and the pack's next-stricter work/rest tier when any member
  is in conservative mode. The ADOSH zone controls of the rule pack also apply.
- **ISO 7933 screen.** Given the forecast climate, the planner screens every task-hour with the engine's own PHS inputs
  (`buildPhsInput`, `ENGINE_PHS_OPTIONS`) for a reference worker [ENG]: 75 kg and 1.75 m, the task's clothing (else the
  crew's worst), the least-acclimatised known member, drinking allowed with the ISO 5 % criterion. Each block-hour is
  simulated as it will
  be executed: the work bout first (`BlockHour.startT`, `boutMin` = ceil(planned work) minutes), then rest at the site's
  rest area. A task-hour keeps the largest W′ ≤ W, in 5-min steps, for which the projection at the end of the bout is
  ≥ 15 min, the resting projection right after it is ≥ 15 min, and no limit falls in the rest that follows until the
  next bout (or the shift end) plus 15 min. W′ below 10 min means no work that hour (`phs_not_feasible`, with hints:
  a lighter task or rotation, a cooling garment, a cooler hour). The schedule is then re-placed with the lowered caps,
  at most 4 times; caps only go down. `BlockHour.limitedBy` records what set the minutes (`none`, `niosh_acgih`,
  `rule_pack` or `phs`). Without a forecast climate the plan carries `phs_screen_unavailable` and is not screened.
- **Plan cap on the device.** While a worker is in a plan task block, the device receives the block's rate as
  `plannedWorkMinPerHour`. It caps `workMinPerHour` and never raises it; when it binds, the info driver
  `work_rest_planned` and `shade_breaks` are added. Plan and monitor therefore agree: following the plan at the planned
  conditions gives no projection stop for the reference worker (`planner.test.ts` › "following the plan exactly at
  constant conditions never triggers a projection stop for the reference worker"). A real worker differs from the
  reference worker, and real conditions differ from the forecast, so the device can still stop them.

**Conservative mode** (any risk flag except `oh_review_required`, the first 14 days on the job, a return after ≥ 7 days
away, or heat rash reported today): RAL instead of REL, the next-stricter work/rest tier, ECTemp T1 at 38.0 °C,
check-ins every 30 min from `caution`, buddy mandatory. Risk flags are booleans and are never summed into a score.
Driver texts that a supervisor can see never name the reason (no "RAL", "conservative" or flag wording).

**Fail-safe defaults** (applied by the data layer and the engine, and logged as drivers with `direction: 'raises'`):
- Unknown wind → 0.5 m/s at 10 m (WBGT then applies the Liljegren 0.62 m/s floor; WBGT and TWL are protective under
  this default, while the PHS projection is not monotonic in wind when air is hotter than skin).
- Unknown solar → clear-sky estimate (the more protective of the engine and data-layer clear-sky models).
- Unknown acclimatisation → unacclimatised.
- Unknown clothing → cloth coveralls (CAV 0). The ACGIH −1 °C credit for short sleeves is never applied.
- Unknown body size → 75 kg, 1.75 m.
- Stale forecast older than 6 h → confidence lowered; if older than 24 h → add 1 °C WBGT margin.
- Physiology signal unusable → physiology channel unavailable (never treated as reassurance).

**Actions** are derived from the level and the channels that drove it. Examples:
- Environment-driven high → `shade_breaks` with workMinPerHour, plus `drink_water`, `rotate_task`.
- Projection-driven stop → `rest_shade_now` + `cool_down`; a hold whose task is not feasible now adds `rotate_task`.
- Day plan binding below the device's own allowance → `shade_breaks` with the plan's work minutes.
- Emergency → `call_998`, `cool_first`, `stay_with_worker`.

The water recommendation follows the ADOSH zone guidance (Low zone light work 0.6–1.0 L/h, Medium zone light work
1.0–1.2 L/h, Medium heavy work and High zone > 1.2 L/h) and the PHS sweat rate, with a floor of the NIOSH cadence (one
cup every 15–20 min) and a hard cap at 1.42 L/h to prevent hyponatraemia. Reminders are 250 mL every 20 min,
electrolyte drinks after 2 h of sweating (no salt tablets), and no drink reminders during fasting hours.

## 6. Alert policy (`engine/alerts.ts`)

- **Escalate immediately; de-escalate only after a dwell period.** Default: 10 minutes below the threshold, plus a
  hysteresis margin. The dwell is applied once, in `risk.ts` (the displayed level); the alert engine is called with
  `deescalationDwellMin: 0` so alerts do not wait a second time. The hysteresis margin of the projection channel is its
  resume check (§5): a projection stop is held until the task to resume projects at least 25 min to the limit
  (15 + 10 min), and that release is not delayed again by the dwell. Symptom- and physiology-driven `stop`/`emergency`
  levels do not decay on their own: they latch until a first aider or supervisor resolves the case after a
  symptom-free re-check.
- **Alert basis: exposure or individual** (`Alert.basis`). Every alert says whether it describes a shared condition or
  this worker. Only the channels *at the alert's level* count, because they are what raised it.
  - `exposure`: only the environment and regulation channels drive the level, i.e. site heat, the task, the clothing
    and the regulation rules. Example: environment at stop with the projection at high gives an exposure stop.
  - `individual`: any other channel at the level (projection, physiology, symptoms, hydration); a clinical case; a
    raising individual driver (`clinical_latch`, `no_hot_work_today`, `phs_limit_reached`,
    `phs_recovery_review_required`); a clinical latch carried over from the alert it supersedes; or no channel that
    explains the level (protective: an unknown cause is never shown as a site condition).
  - **Sticky individual** [ENG, protective]. An open exposure alert is re-labelled individual when an individual channel
    joins at its level, and it never goes back to exposure while it stays open. The re-label needs a channel that
    actually drives the level: a level held only by the dwell (every channel already back to safe) keeps its basis.
    Without that condition most exposure alerts were re-labelled just before they resolved (found by the simulated
    cohort, VALIDATION-COHORT §3.8). The next alert is classified afresh.
  - **Routing never depends on the basis** (`alerts.test.ts` › "routing does not depend on the basis"). Crew alerts are
    always exposure.
  - **Reasons.** An exposure alert carries a site- or crew-framed reason: "Site heat: work/rest 30/30 in effect", "Site
    heat: too hot for this work now", or "Site rule: <regulation text>". An individual alert keeps its non-clinical
    reason. Alerts driven by the physiology, symptoms or hydration channels share one wording ("Personal check flagged
    on the worker's device"; "First-aid check needed" at stop), so neither the reason nor the basis says which of them
    is involved; a projection-driven alert names the heat-strain model. A missing basis (older producers) is read as
    individual, so the exposure share is never overstated.
  - `AlertStats.byBasis` counts alerts, notifications, acknowledgement requests and unacknowledged alerts per basis.
- **Durable escalation record.** `escalatedAt` is set once, at the first of: a stop-acknowledgement timeout, an emergency,
  or routing to the first aider or occupational health. A symptom- or physiology-driven stop is therefore escalated from
  the moment it is raised, because the first aider is routed at once. `escalatedAt` survives a late acknowledgement and
  resolution. High reminders, the offline SMS, supervisor routing, crew bundling and acknowledgements do not set it.
  `acks` lists every permitted acknowledgement in order, with role and time only; `ack` keeps the first counted one.
  The role views' case index (`state/selectors.ts caseIndex`) reads both.
- **Crew bundling.** When the environment or regulation channel drives several workers to the same level (an exposure
  alert at high or stop), one crew alert is raised instead of N individual alerts. Its reason names the shared
  condition (for site heat, with the crew's strictest work/rest) and the member count. This prevents alert fatigue. An
  alert re-labelled individual within its own batch is still sent to the supervisor, individually.
- **Repeat suppression.** The same worker does not get the same level and actions again within 20 minutes unless the
  level escalates.
- **Acknowledgement and routing.**
  - worker: every alert; supervisor: at high or above (individual alerts, or the crew alert for exposure alerts at high
    or stop) and every stop and emergency
  - stop not acknowledged within 2 min → escalates to the supervisor and the buddy
  - symptom- or physiology-driven stop (or a symptomatic hydration stop) → first aider at once
  - emergency → supervisor + first aider + occupational health immediately, with the 998 prompt
  - device offline → SMS fallback
- Every alert carries non-clinical `reason` text that is safe for supervisors: no physiology, symptoms, hydration,
  risk flags or conservative-mode wording. As a defensive filter, a driver text or id matching `CLINICAL_TEXT_PATTERN`
  is never used in a reason. Open: an individual projection reason can contain the projected minutes (GOVERNANCE §13
  item 16).

## 7. Governance model (`engine/privacy.ts`)

- **Consent scopes** (all opt-in and revocable at any time):
  - `wearable`
  - `healthFlags`
  - `checkins`
  - `shareWithMedicOnEscalation`
  - `aggregateStatistics`

  Core safety alerting uses only environment and work context. A grant or revocation applies to the next projection,
  payload and aggregate, and it also reaches the engine on the worker's device: without `wearable` the physiology
  channel is not evaluated; without `checkins` the worker's own check-ins and logged drinks are not used (no water
  credit, §5; buddy and first-aider reports still count); without `healthFlags` risk flags are not used (prototype
  wiring in §10).
- **Projection** `project(record, role, purpose, consent)` returns only the fields permitted by the role × purpose matrix.
  - A prohibited purpose is always refused, whatever the role.
  - Every call appends to the audit log (`projectAndLog`). The prototype views re-log an unchanged access at most every
    15 simulated minutes (§10).
- **Aggregates** `aggregate(records, k)` suppress any cell with fewer than k individuals: k = 5 for the HSE manager,
  k = 10 for the regulator and employer HR. Complementary suppression stops a hidden cell from being recovered by
  subtraction.
- **Audit log**: append-only, with a SHA-256 hash chain (Web Crypto). The worker can see "who saw my data".
  `verify()` detects tampering.
- **Retention**:
  - raw HR and ECTemp traces: on device, purged after 24 h
  - level history: pseudonymous, 30 days
  - aggregates: retained

## 8. Simulation and validation

- **Ground truth** (`sim/truth.ts`): individual physiology driven by actual conditions and hidden factors the engine cannot
  see. These include individual metabolic variation, fitness, true hydration behaviour, latent illness and microclimate
  radiant boost. Heart rate is generated from a cardiovascular model that is *different* from the ECTemp observation model,
  which avoids circularity.
- **Shadow mode**: the engine raises alerts but nobody acts on them. This yields detection metrics: sensitivity, PPV,
  lead time, false alarms per worker-shift, and calibration of minutes-to-limit. Detection counts individual alarms
  (§6 alert basis); exposure advisories are counted separately as alert burden.
- **Closed loop**: alerts are followed with realistic compliance. This yields projected outcomes per 1,000 worker-shifts
  (excessive-strain events, severe events, rest minutes, water), compared across four policies:
  - midday ban only
  - site-level index rules
  - Zill without wearables
  - Zill with wearables
- **Robustness**: wearable dropout (0/20/50/100%), noise from dust and motion, environment sensor failure, stale forecast,
  network outage. Behaviour assumptions (compliance, self-report, supervisor follow-through) and ground-truth parameters
  are swept (SIMULATION.md §5).
- **Fairness**: the metrics above broken down by acclimatisation, age band, clothing/PPE, body size and language support.
- **Real-data evidence (no simulation)**:
  - agreement with the reference implementations
  - hours in each zone for 2020–2025 at five Abu Dhabi sites, including the share of high-risk hours outside the midday ban
  - forecast skill at lead days 1–3, using archived forecasts

All evidence numbers are regenerated by `npm run validate` into `public/data/validation/*.json`, which the Evidence view
renders.

## 9. Views

| Route | Purpose |
|---|---|
| `#/` | Overview: the problem, how Zill works, live/replay status of the five Abu Dhabi sites |
| `#/supervisor` | Crew board, site forecast strip, alert feed with acks, break and rotation planner, water logistics, sensor/network health |
| `#/worker/:id` | Phone UI: language, level card (pictogram + colour + text + voice), countdown, hydration, check-in, SOS, buddy, privacy |
| `#/medic` | Escalations, consented clinical trends, first-aid protocol, incident log |
| `#/regulator` | Multi-site aggregates with k-suppression, zone hours, compliance |
| `#/governance` | Consent ledger, role × purpose matrix, audit chain verifier, data-flow inspector, prohibited-purpose demo |
| `#/lab` | Scenario controls and live truth-vs-estimate charts |
| `#/evidence` | Validation results with data provenance |

## 10. Sync between devices and consoles (`state/syncBus.ts`)

In the prototype every role runs in a browser tab. A tab holds its own copy of the deterministic world and talks to the
other tabs over `BroadcastChannel('zill')`; in production the same messages would travel through a site gateway
(MQTT/HTTPS, with the SMS fallback). Nothing in this section changes what leaves a worker's device (§1 principle 5).

**Envelope.** `{ v: 1, id: "<origin>#<seq>", origin, seq, msg }` (`SYNC_BUS_VERSION`, `SyncEnvelope`).

| Message (`msg.kind`) | Direction | Keys besides `kind` | Notes |
|---|---|---|---|
| `payload` | worker → console | `payload` | Exactly `privacy.payloadForSync` output, the 10-key "level + action" record (GOVERNANCE §2.4). Sent on change, else every 5 simulated minutes (`PAYLOAD_HEARTBEAT_MIN` [ENG]). |
| `worker_ack` | worker → console | `workerId`, `alertId`, `t` | The worker acknowledged an alert. |
| `checkin_done` | worker → console | `workerId`, `t`, `level` | A check-in happened, with the resulting level only. Answers and symptoms never leave the device. |
| `ack` | console → worker | `alertId`, `role`, `actorId`, `t` | A buddy, supervisor, first aider or OH acknowledgement. |
| `resolve` | console → worker | `workerId`, `alertId`, `by`, `actorId`, `t` | A first aider, supervisor or OH resolved the case. |
| `reassign` | console → worker | `workerId`, `taskId`, `location`, `actorId`, `t` | A new task or location. |
| `clock` | control | `scenarioId`, `policy`, `seed`, `t`, `playing`, `speed` | Lets a follower tab replay the same world. Re-sent every 15 simulated minutes while playing (`CLOCK_HEARTBEAT_MIN` [ENG]). |

**Guarantees** (`syncBus.test.ts`).
- Every message is checked against its exact key list (`SYNC_MESSAGE_KEYS`) on send and again on receipt, and scanned
  recursively for forbidden keys (`SYNC_FORBIDDEN_KEYS`: every clinical projection field plus the raw on-device and
  ground-truth keys). A buggy sender therefore cannot push anything clinical across.
- A bus ignores its own envelopes and duplicates. Changes applied from the bus are marked `origin: 'remote'` in the
  stores and are never re-broadcast.
- Without `BroadcastChannel` the bus does nothing, and every tab still works on its own.

**Leader and follower.** One tab leads (`shareClock`) and broadcasts its clock; the other tabs follow (`followClock`).
A follower re-syncs when its world differs from the leader's by more than 3 simulated minutes while playing
(`SIM_CLOCK.followToleranceMin` [ENG]), or by any amount while paused. The world is deterministic for a scenario,
policy and seed, the store steps only whole minutes and the world simulation is chunking-invariant, so two tabs at the
same minute hold the same world. A backward jump rebuilds the world and replays the earlier injections (t < target).

**Divergence after a device-side check-in.** Check-in content never leaves the device tab, by design. After a check-in
on the worker's phone, a console tab's own world no longer matches the device for that worker. The crew board
compensates: it applies the device's newer payload (level, actions, work minutes, water, acknowledgement) and marks the
row `source: 'remote'`. The console's local alert list for that worker can still differ from the device's. Inbound
acknowledgements, resolutions and reassignments are applied to each tab's own world as remote injections.

**Consent reaches the device engine** (`governanceStore.connectGovernanceToSim`). Whenever a worker's consent in the
governance ledger differs from what their simulated device uses (after a grant or revocation, on a new world, or after a
backward jump), a `{ kind: 'consent' }` injection is applied to the world from that minute. The on-device engine then
stops (or resumes) using heart-rate data, the worker's own check-ins and drink logs, or health flags (§7). The injection
stays on the device side: it is not a bus message, so nothing about consent or health crosses to a console. Nothing is
injected into a finished shift. A single-tab app omits the option `deviceWorkerId`, because its one world simulates
every device; a multi-tab demo passes it so that only the phone tab injects.

**Audit de-duplication** (`governanceStore`, `AUDIT_RELOG_MS`). The selectors run on every render and return the audit
drafts of `privacy.project()` and `aggregateFor()`. The hooks append them after render, de-duplicated per actor,
purpose and subject: an access is logged again only when its decision, fields or reason change, after 15 simulated
minutes (`AUDIT_RELOG_MS` [ENG]), or after a rewind. Each appended entry is the one `projectAndLog()` would append.
The prohibited-request demo always logs. Audit times are simulated time, never the wall clock.
