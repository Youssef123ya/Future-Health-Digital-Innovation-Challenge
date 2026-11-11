# Engine API — waves 2c and 2d (for the UI round)

What a screen needs from the engine, the state selectors and the simulator after waves 2c and 2d: every export added or
changed that a screen reads, one line of meaning each, and who may see it. The source is authoritative; module notes
with the reasoning are in docs/dev/wave2c-*.md and wave2d-*.md. Earlier API: engine-api-wave1.md, -wave2a.md, -wave2b.md.

Roles: **W** worker (own device), **B** buddy, **S** supervisor console, **FA** first aider, **OH** occupational health,
**Lab** simulation/evidence screens only (ground truth, never an operational view).

## 0. Who may see what (rules for every screen)

| Data | W | B | S | FA | OH | Notes |
|---|---|---|---|---|---|---|
| Level, actions shown on the device, own countdown | own | partner level + buddy check | level + console actions | case | case | S/console actions = `privacy.supervisorActions` (no drink, electrolytes, check-in or buddy prompts) |
| `RiskAssessment.drivers` / channel drivers | own, full text | — | `privacy.supervisorDrivers` only | case view | clinical only with consent | S sees generic `driver.<id>` phrases or one of two pooled phrases; numbers only for site drivers on the allow-list |
| Individual numbers (minutes to limit, rest estimate, bout minutes, W/m², personal limit, water) | own | never | never | never | clinical, with consent | pooled or phrase substitutes only |
| `detail.environment` (basis, monitored, enforced, fallbackReason) | own | never | never | never | never | `fallbackReason` reveals consent or health status |
| `detail.resume` (holds, estRestMin, boutMin, nextCheckT) | own | never | never (pooled "not cleared") | never | never | |
| `detail.water`, `detail.drink`, hydration drivers | own | never | never | never | clinical, with consent | reveal fasting, drinking, consent |
| Day plan: blocks, block-hours, member caps, notes, warnings | own schedule | — | yes | — | yes | caps show the operational constraint only, never the history or the reason |
| `Alert` raw (actions, reason) | own case | — | never raw: use `AlertItem` | via projection | via projection | consoles render `AlertItem` (console actions, filtered reason) |
| `AlertItem.basis`, `frame`, `suppressed` | — | — | yes | yes | yes | one suppression wording for both causes |
| Per-worker `confidence` | own | — | do not show yet | — | — | open issue: carries the wearable-loss penalty (consent side channel) |
| Ground truth (`WorkerView.truth`, `WorkerMinute`) | — | — | — | — | — | Lab only |

Supervisor texts and fields never carry clinical detail (physiology, symptoms, hydration, fasting, extra-care mode,
consent state) or individual numbers; alerts carry level + console actions + a non-clinical reason (ARCHITECTURE §1.5,
§7; GOVERNANCE §2).

## 1. Policies (src/sim/types.ts)

- `PolicyId` += `'zill_monitored'`: zill_full on a site that opted in to the monitored plan basis (occupational-health
  sign-off); `POLICY_IDS` lists it (URL `?policy=`, sync bus).
- `ZILL_POLICY_IDS`, `WEARABLE_POLICY_IDS`; `isZillPolicy(p)`, `policyUsesWearable(p)` (zill_full, zill_monitored),
  `policyPlanBasis(p): PlanBasis` ('monitored' only for zill_monitored).
- Back-test arms (src/sim/backtest.ts, 1.3.0): `zill_monitored`, `shadow_zill_monitored` (detection of monitored mode);
  labels "Zill (monitored mode)", "Shadow: Zill (monitored mode)".

## 2. Day plan (src/engine/planner.ts)

- `PlanBasis = 'tables' | 'monitored'` — one declaration (planner.ts); risk.ts re-exports the same type.
- `PlanDayInput.planBasis?` (default 'tables'); `DayPlan.planBasis`, `DayPlan.notes: string[]`.
- `MONITORED_PLAN { note, basis[] }`: crew/day note of a monitored plan (ISO 7243:2017, ACGIH TLV decision flow,
  NIOSH 2016-106).
- `DEVICE_REST_NOTE`: neutral crew note "devices may direct extra rest for some members; the reasons stay on the device".
- `CrewPlan.planBasis` (falls back to 'tables' with no acclimatised member or no climate), `CrewPlan.notes`.
- `CrewPlan.memberCaps: Record<workerId, MemberCapHour[]>`: personal caps of members on an acclimatisation schedule,
  one per crew task block-hour; the other members follow the crew layout.
- `MemberCapHour { startT, hour, taskId, wallMin, workMinPerHour, boutMin, limitedBy }`: the member's rate (≤ crew
  rate; 0 or ≥ 10) and whole-minute bout at the start of the block-hour; `limitedBy` 'crew' | 'acclimatization' |
  'phs' (never which acclimatisation rule).
- `CrewPlan.memberWorkMin: Record<workerId, number>`: scheduled work per member (crew layout or own caps).
- `BlockHour.boutMin` is now floored (≤ the allowance); `BlockHour.monitored`: the crew rate here omits the NIOSH/ACGIH
  cap (monitored basis, every device able to confirm monitoring); `BlockHour.allowedWorkMinPerHour` is then the pack
  value, `nioshWorkMinPerHour` still reported (the device's table fallback).
- `CrewBinding`: `limit` 'REL' when the crew has a known acclimatised member, else 'RAL'; `nonAcclimatizedMemberIds`,
  `adoshUnacclimatizedMemberIds`, `unknownMemberIds`, `crewSize`; `conservative` and `stricterTier` removed;
  `binding.text` names the members on a schedule, never "a stricter personal limit". `HourOutlook.binding` lost
  `stricterTier`.
- `PlanWarningCode` += `'phs_rest_limit'` (rest alone reaches the ISO 7933 screen margin: no work planned; mitigations
  cooled rest area, logged drinking, shorter shift); `'rest_exceeds_limit'` may name one member (`workerIds`);
  `'acclimatization_ramp'` no longer shows exposure minutes or percentages.
- `CrewPlan.phsScreen` += `verificationCuts`, `restLimitT`; `PHS_SCREEN` += `endMarginMin: 1`, `projectionEveryMin`,
  `maxPasses` 32 (wave 2c added `PlannerHour.climate`, `PlanLimitedBy`, `PhsTaskHour`, `BlockHour.startT /
  boutMin / phsWorkMinPerHour / limitedBy`, `phs_not_feasible`).
- The naive comparison plan honours task windows.
- UI: show `memberCaps` / `memberWorkMin` for members on a schedule, `CrewPlan.notes`, `DayPlan.notes`,
  `BlockHour.monitored`; S and OH may see these, W sees own schedule.

## 3. Device context and step detail (src/engine/risk.ts)

Context (set by the caller; the simulator sets them from the plan):
- `WorkerContext.resumeTask?` (2c): the task to return to after rest (resume checks, task hold).
- `WorkerContext.plannedWorkMinPerHour?` (2c): the plan's rate for this task-hour — the member's own cap where the
  plan has one; never raises the device's own limit.
- `WorkerContext.planBasis?` (2d): the crew plan's basis; absent = 'tables' (bit-identical).

`WorkerStepDetail` (W only unless noted):
- `environment: EnvironmentDetail { basis, monitored, enforced, workMinPerHour, fallbackReason }` (always present):
  `monitored` = monitored mode in force this step; `enforced` = the WBGT table cycle limits work (always under
  'tables'); `workMinPerHour` = the table cycle (a guide while monitored); `fallbackReason` 'consent' | 'data' |
  'model' | 'status' — device only.
- `resume: ResumeDetail | null` { `held`, `heldBy: ('projection' | 'regulation' | 'environment')[]`, `taskId`,
  `ready`, `boutMin`, `estRestMin`, `infeasibleNow`, `nextCheckT` }: active holds after the step (projection = ISO
  7933 resume check; regulation/environment = task hold of the task to resume), the release step (`ready`), the
  bout countdown, no release possible now (`infeasibleNow`: rest > 60 min, or acclimatisation budget used up), and
  the earliest check that could release (`null` = none this shift; the midday-break end for a midday hold).
- `water: PhsWaterDetail | null` { `sweatLossL`, `creditedIntakeL`, `netLossPctBM`, `thresholdL`, `restricted`,
  `extended`, `capped` }: water balance behind the ISO 7933 water-loss limit; `extended` = logged drinking lifts it
  above 5 % (electrolytes advised), `capped` = at the 7.5 % ceiling. Clinical: W only.
- `drink: DrinkReminderDetail { exposed, exposure, reminder, nextReminderAtMs, locationWbgtEffC }` (always present):
  `reminder` 'drink' (250 mL due now) | 'shade' (fasting: rest-in-shade guidance) | null; exposure 'hot_work' (and
  30 min after) | 'heat_rest' (rest/idle outside a cooled area at WBGT_eff ≥ 25.6 °C) | null. W only.
- `plannedCapApplied` (2c): the plan's rate lowered the work minutes.
- `phsRecovery` (pending reviewed restart; `blockedBy` 'dehydration' = drink and rest, or no restart this shift while
  drinking is restricted).
- State (serialisable): `taskHold`, `monitorValidT`, `lastHotWorkT`, `dwellExTaskHold` (2d); `projectionHold`,
  `lastTask`, `resumeBout`, `dwellExProjection` (2c).
- `FluidIntake.loggedAt?` (types.ts): drinks credit only within 15 min of their stated time; the engine stamps a log
  without one with the receiving step.

## 4. Driver ids and phrases

New in 2d (risk.ts `RISK_DRIVER_IDS`; English phrase key in i18n/messages.ts `DriverPhrases`; supervisor rule in
privacy.ts `SUPERVISOR_DRIVER_RULES`):

| id | channel | W text (gist) | phrase key | supervisor |
|---|---|---|---|---|
| `wbgt_screen_monitored` | environment | WBGT above the table limit: own ISO 7933 projection and wearable monitoring in use | `monitored` | pooled "Device-directed rest" |
| `monitoring_fallback_tables` | environment | monitored mode does not apply now (reason): the table limits apply again | `monitor_off` | pooled "Device-directed rest" |
| `resume_hold_regulation` | regulation | rest before going back: heat-zone rules / WBGT stop limit / midday ban until HH:MM | `rule_hold` | pooled "Not cleared for heat work now" |
| `resume_hold_environment` | environment | rest before going back: the heat-exposure limit does not allow it now | `heat_hold` | pooled "Not cleared for heat work now" |
| `phs_no_drink_no_restart` | hydration | not drinking (fasting): no more heat work this shift | `fasting_no_restart` | withheld |

New in 2c: `phs_resume_hold`, `task_not_feasible_now`, `phs_work_bout`, `phs_water_credit`, `phs_drink_to_restart`,
`work_rest_planned` (phrases `resume_check`, `task_too_hot`, `work_bout`, `drinks_counted`, `drink_to_restart`;
`work_rest_planned` reuses `work_rest`). `work_rest_cycle` is 'info' while monitored ("Work/rest guide: …"); supervisors
always see it as 'raises'. `phs_limit_reached` / `phs_recovery_review_required` texts are identical for fasting and
other workers.

Privacy projection (privacy.ts): `supervisorDriverRule(id)` → 'site' (text and numbers kept) | 'phrase' (generic
`driver.<id>` phrase, no value/unit) | 'not_cleared_for_heat_work' | 'device_directed_rest' (pooled) | 'withhold';
`supervisorDriver(d)`, `supervisorDrivers(ds)`, `notClearedForHeatWork(ds)`, `POOLED_DRIVERS`, `POOLED_DRIVER_IDS`,
`SITE_SENSOR_DRIVER_IDS`. Unknown ids are withheld (default deny).

Console phrases (messages.ts `CONSOLE_PHRASES`, `consolePhrase(lang, id)`, 8 languages): `not_cleared`, `device_rest`,
`frame_heat`, `frame_rule`, `basis_exposure`, `basis_individual`, `suppressed`, `reason_*`, `reason_withheld`,
`location_sun | shade | indoor_cool`, `no_task`, `no_data`.

## 5. Alerts and console models

types.ts `Alert`:
- `basis?: 'exposure' | 'individual'` (2c; missing = individual), `acks?`, `escalatedAt?` (2c).
- 2d: `consoleActions?: ActionId[]` (what consoles may show; `actions` is the worker's own list), `reasonKey?`,
  `frame?: 'heat' | 'rule'`, `suppression?: { reason: 'action_in_force'; t; liftedAt? }` (designed suppression,
  ANSI/ISA-18.2: logged, notified to nobody until lifted; one published reason for both causes).

alerts.ts: `isAlertSuppressed(a)`, `DESIGNED_SUPPRESSION_MAX_LEVEL` ('high': stop, emergency, individual, symptom,
physiology, hydration and first-aid alerts are never suppressed), `AlertStats.designedSuppression { alerts,
stillSuppressed, lifted }`, `PRIVATE_FACTOR_TEXT_PATTERN`, `supervisorSafeText(text)`; an open alert is re-labelled
individual only for a cause at its own level.

state/selectors.ts:
- `SelectorInput.lang?`, `selectorInput(sim, consent?, lang?)` — pass the UI language.
- `AlertItem` += `reasonText`, `reasonKey?`, `basis`, `basisLabel`, `frame?`, `frameLabel?`, `suppressed`,
  `suppressedLabel?`; `AlertItem.actions` = console actions. `alertItem(a, lang?)`, `alertBasisOf(a)`.
- `AlertCounts { exposure, individual, suppressed }`, `alertCounts(items)`; `CrewBoard.alertCounts`,
  `SupervisorBoard.alertCounts`, `SupervisorBoard.suppressedAlerts` (listed apart, never their cause; not cases).
- `CrewBoard.plan: CrewPlan | null` carries `memberCaps`, `memberWorkMin`, `notes`, `planBasis`.
- `locationText(lang, location)`, `caseLocation(view, wv, lang?)` (first aider's location words).
- Sync payload (privacy.ts `payloadForSync`): `actions` = console actions; `waterMlPerHour` is always
  `SYNC_WATER_NOT_SENT_ML` (0, legacy v1 key); `SUPERVISOR_VIEW` no longer contains `waterMlPerHour`.
- Never render `Alert.actions` or a raw `Alert` on a console.

## 6. Simulator and Lab (src/sim)

- worldsim 1.4.0: `WorkerSim.layout: PlanLayout { work, reason, rate }` (the worker's own schedule: member caps or the
  crew layout), `CrewSim.memberPlans`, `CrewSim.planBasis`; the engine owns every resume decision (a rest episode
  ends when the device neither asks for rest nor holds); `drinkReminderShown(actsOnZill, detail)`,
  `taskWindowMs(...)`, `loggedDrinkMl(...)` (1.3.0).
- `WorldView.plan` is the `DayPlan` (member caps included); `WorkerView.detail` is the device detail (W and
  consented clinical views only); `WorkerView.truth` is Lab only.
- metrics 1.2.0: `WorkerShiftRecord.suppressedAdvisories`, `ChallengeMeasures.suppressedAdvisoriesPerWorkerShift`,
  `RunAlertSummary.designedSuppression`, `AlarmTimesByBasis.suppressed`; a suppressed alert version is not an alarm.
- backtest 1.3.0: `Headline.suppressedAdvisoriesPerShift`, `Headline.supervisorAcksPerShift`;
  `VariantArmSummary.baseVsBanOnly` (1.2.0).
- Evidence screen history: public/data/validation/cohort-v0.1.json and cohort-v0.2.json (earlier medium cohorts) next
  to cohort.json (v0.3); docs/dev/cohort-v0.2-vs-v0.3.md and cohort-v0.1-vs-v0.3.md.

## 7. Open points for the UI round

- Do not show per-worker `confidence` on consoles until the engine offers a console confidence without the wearable
  penalty (governance open issue).
- The first aider's projected actions are the worker's actions minus confidential ones: an absent `drink_water` at a
  stop can hint at fasting (accepted for the vital-interest role; needs an explicit decision).
- `detail.environment.fallbackReason`, `detail.water`, `detail.drink`, `monitoring_fallback_tables` text: worker device
  only.
