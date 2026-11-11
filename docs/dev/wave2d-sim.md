# Wave 2d — simulated world (sim-truth)

Owner: sim-truth. Scope: src/sim/truth.ts (+test), src/sim/backtest.ts (+test), src/sim/types.ts (SimBehaviour
.drinkLogging only), scripts/validate/compare-cohorts.ts (+ new scripts/validate/compare-cohorts.test.ts), and in
src/sim/worldsim.ts (+test) only the listed-order schedule, the drink-logging path and the reminder response. New
files: scripts/validate/drink-calibration.ts (reproduces the calibration), docs/dev/cohort-v0.2-medium.json (v0.2 report
snapshot). Not touched: src/engine/**, src/sim/metrics.ts, scripts/validate/cohort.ts. No full-cohort run (the
integration agent runs it).

Run history: a first run was stopped after ~40 min; its edits were reviewed and kept where correct. This run resumed on
2026-11-11, re-verified every number below, and replaced the simulator-side copy of the reminder rule (item 2).

## Status
- [x] 1 drinking model calibrated to its own anchor (habitualDrinkFraction 0.4 → 0.87); tercile ordering investigated
  (physiology + sampling noise, not a model error; evidence below)
- [x] 2 reminder response everywhere: the worker responds to the reminder the device shows (engine's own rule)
- [x] 3 drink-logging fidelity (behaviour.drinkLogging, default 1 / ×1)
- [x] 4 symmetric task windows (listed order honours earliestStart/latestEnd) — baseline definition change
- [x] 5 back-test variants (habitualDrinkFraction=1.0 and =0.4, drinkLogging=50%, drinkLogging=x1.5); arm table
- [x] 6 compare-cohorts "What changed between versions" section (+ tests)

Versions: WORLDSIM_VERSION 1.2.0 → 1.3.0; TRUTH_MODEL_VERSION (new export, sim/truth.ts) 1.2.0; BACKTEST_VERSION
1.1.0 → 1.2.0 (report `versions.truth` added). METRICS_VERSION unchanged (not mine).

## 1. Drinking model calibration (safety review MEDIUM)

Target (independent observation, never a Zill outcome): Bates & Schneider 2008 (J Occup Med Toxicol 3:21), mean fluid
intake 5.44 L per 12-h summer shift of UAE construction workers — the observation the model already cites for
traits.drinkBaselineMedianMlPerH.

Statistic: mean TRUE intake (truth.intakeMl) per worker-shift in the midday-ban-only arm (the arm closest to the
observed sites: no device), shift 05:00–17:00, worldsim 1.3.0 (task windows in the listed order).
Calibration set: every hot-tercile site-day of Jun–Sep 2025 at the five sites (200 of 610 season site-days; terciles
of shift-mean outdoor WBGT per site, as backtest.selectCohortDays), generated workforce zill-workforce-v1 with 3 crews
per site, seed zill-cohort-2025: 4,760 worker-shifts (no fasting workers in Jun–Sep 2025).
Method (fixed before any re-run, per the first run; reproduced in this run): regula falsi on behaviour.habitualDrinkFraction alone, every other parameter unchanged;
only the ban_only arm was run during the calibration (no Zill arm).

| habitualDrinkFraction | mean intake L / 12-h shift | water loss L | ban-only dehydration > 3 % / 1,000 |
|---|---|---|---|
| 0.4 (wave 2c / v0.2) | 4.010 | 4.33 | 315 |
| 0.87 (calibrated, rounded from 0.8675 → 5.437 L) | **5.447** | 4.40 | 145 |
| 1.0 (v0.1 floor) | 5.934 | 4.42 | 111 |

Medium cohort's own 15 hot site-days (1 crew per site, 111 worker-shifts): 5.56 L at 0.87 (0.4: 4.01 L; 1.0: 6.04 L) —
the backtest.test.ts guard checks this stays within 10 % of 5.44 L and that 0.4 stays below 85 % of it.

Why the floor and not the replacement fraction: the observed intake exceeds the model's own ban-only hot-shift water
loss (4.40 L). With the 0.4 floor, sweat replacement cannot reach it inside its literature range (50–80 %): every worker
at 80 % gives 4.47 L, at 100 % 5.02 L (same calibration set; runs made only to check this argument). The replacement
fraction keeps its literature value; the floor (earlier basis: IOM daily adequate intake, not a worksite observation)
is the calibrated parameter. Caveat (in DRINK_CALIBRATION): simulated ban-only workers work ~6 h of the 12-h shift and
the model has no obligatory urine loss, so matching total intake likely over-states drinking; that lowers dehydration
in every arm and narrows, never widens, the simulated dehydration benefit of Zill. The wave 2c reminder-replaces-drink
fix is kept (truth.drinkDecision: a followed reminder IS that minute's drink).

Code: truth.ts TRUTH_PARAMS.behaviour.habitualDrinkFraction 0.87, `export const DRINK_CALIBRATION` (target, statistic,
set, method, achieved, whyTheFloor, caveat; frozen), DRINK_MODEL_BASIS updated, `export const TRUTH_MODEL_VERSION =
'1.2.0'`. Reproduce: `npx tsx scripts/validate/drink-calibration.ts --mode=calibrate | eval | terciles` (new script;
ban_only only; eval at 0.87 re-run with the final worldsim 1.3.0: 5.447 L, 4,760 worker-shifts, ~20 s). Tests:
truth.test.ts (known answers at 0.87, calibration record), backtest.test.ts (guard on the medium hot days).

Reminder re-follow rule (truth 1.2.0, found while checking single scenarios): `TRUTH_PARAMS.behaviour
.reminderRefollowMin = 20` [ASSUMPTION] — a reminder still on screen after a followed one is not drunk again within
20 min (the device's own interval), `DrinkContext.minutesSinceFollowedReminder`, `export function drinkDecisionDetail(
state, traits, ctx, rng): DrinkOutcome` ({ ml, followedReminder }; drinkDecision = its volume, same draws). Why: when
the device's reminder is not cleared by a logged drink (drinkLogging < 1, or the engine ignoring the log — see open
issues), a per-minute response made simulated workers drink 250 mL a minute: 27.7 L per shift in the Zill arms of a
2-site-day check, a hyponatraemia-level artefact the truth model does not penalise, i.e. it would have inflated Zill's
dehydration benefit. With the rule: 8.9 L (ban only 5.6 L). The rule never binds for a device that clears the reminder
on the logged drink (next reminder due 20 min after it, the same condition), so fully logged consented workers are
unchanged.

### Inverted ban-only dehydration ordering by heat tercile (v0.2: hot 252 < median 270 < mild 324 per 1,000)

Finding: not a model error. It is physiology (WBGT terciles barely separate worker water loss) plus sampling noise.
Evidence (ban_only only, never a Zill arm; whole season: 610 site-days × 3 crews, 14,518 worker-shifts; ± = binomial SE):

| floor | stratum | water loss L | intake L | dehydration > 3 % / 1,000 |
|---|---|---|---|---|
| 0.4 | hot / median / mild | 4.33 / 4.28 / 4.13 | 4.01 / 3.97 / 3.82 | 315 / 318 / 313 (± 7) |
| 0.87 | hot / median / mild | 4.40 / 4.34 / 4.19 | 5.45 / 5.58 / 5.50 | 145 / 122 / 103 (± 5) |

- With the v0.2 model the season profile is FLAT (315/318/313): water loss differs by only 5 % between WBGT terciles
  within a site (WBGT ranks humid days high, while sweat loss follows dry heat, radiation and the work done, and the
  ban-only crew job is the same every day), and v0.2's sweat-paced drinking replaced a constant share of whatever was
  lost. The medium cohort's 252/270/324 lies within sampling noise of a flat profile: 111 worker-shifts per stratum,
  SE ≈ 42 per 1,000; 324 − 252 = 72 ≈ 1.2 SE of the difference. Re-running the medium days with the 1.3.0 schedule and
  the 0.4 floor gives 288/261/324 — the same days, a different order.
- Dehydration is monotone in each worker-shift's own water loss: by water-loss tercile 418/289/239 per 1,000 (0.4) and
  194/110/65 (0.87), whole season.
- Dry heat is where WBGT under-ranks sweat loss: Al Ain (inland, RH 23–28 %, Ta 38–40 °C) has the lowest WBGT and the
  highest water loss (5.3–5.7 L) and dehydration (482–516 per 1,000 at 0.4) of the five sites.
- The midday-ban calendar is NOT the explanation: on the whole season mild ban-season 312 vs mild off-season 314
  (0.4); the medium-cohort split (295 vs 360) was noise.
- With the calibrated floor (intake dominated by habit, nearly constant across strata) dehydration orders with heat:
  145 > 122 > 103.
Scripts (scratchpad, not in the repo): sim-truth/tercile-season.mts (whole season), tercile-midday.mts,
tercile-site.mts, loss-tercile.mts (medium days), calibrate-drink.mts (regula falsi / eval), medium-hot.mts.

## 2. Reminder response everywhere

worldsim no longer keeps a copy of the device's reminder rule. `export function drinkReminderShown(actsOnZill:
boolean, detail: Pick<WorkerStepDetail, 'drink'> | null): boolean` = actsOnZill && detail.drink.reminder === 'drink':
the device's own reminder from its latest step (engine agent's risk.WorkerStepDetail.drink, clinical.fluidStatus +
clinical.drinkReminderExposure: hot work and the 30 min after it, or rest/idle outside a cooled area at WBGT_eff ≥
25.6 °C). truth.drinkDecision responds to every reminder shown (work, rest, idle). Removed: the wave-2d-draft
`drinkReminderDue` / `DrinkReminderInput` (never released), WORLD_PARAMS.reminderAfterHotWorkMin (was the 1.2.0
simulator rule), the unused clinical.fluidStatus import. 'shade' reminders (fasting) are not drinks; the truth model
does not change behaviour on them.
Tests (worldsim.test.ts): known answers of drinkReminderShown; with spontaneous drinking off (floor 0, replacement 0,
compliance 1) every intake falls in a minute whose device showed 'drink', and reminders are followed while idle and at
rest; no intake at all under ban_only and shadow mode; idle workers in Al Ain shade drink more under zill_full than
ban_only before 06:00 (same random numbers).

## 3. Drink-logging fidelity

`SimBehaviour.drinkLogging: DrinkLogging` (sim/types.ts) = { loggedFraction, overReportFactor }, default { 1, 1 }
[ASSUMPTION: the behaviour before 1.3.0]. Each drink is logged with probability loggedFraction (one uniform from the new
per-worker stream `drinklog|date|id`, drawn only when 0 < p < 1, so the default draws nothing) and recorded as
round(ml × overReportFactor) [ENG: whole mL]. Only the device log changes (fluid caps, reminders, ISO 7933 water
credit); the true intake does not. makeSimConfig merges a partial setting; createWorld throws RangeError outside
0 ≤ loggedFraction ≤ 1, 0 < overReportFactor < ∞. `export function loggedDrinkMl(ml, logging, rng): number | null`.
Tests: known answers, truth identical under ban_only, 50 % share, ×1.5 volumes, determinism (twice; chunked = single
call), configs without the field.

## 4. Symmetric task windows (baseline definition change)

The listed-order schedule (ban_only, site_index, shadow) honours Task.earliestStart / latestEnd like the planner:
each minute the crew works the FIRST listed task with work left whose window is open [ENG: work-conserving listed
order — a crew waiting for a window does the next open task and returns when the earlier window opens]; work left when
a window closes is not done (deferred, as the planner defers it); no open task = idle, and idle minutes count toward a
pending statutory break [ENG] (the draft cancelled it, which let a crew waiting for a window resume work after a
shortened break: fixed, known-answer test). Sun tasks still pause for the midday break (the crew waits); site_index's
hourly ADOSH dose is unchanged. Without windows the schedule is the pre-1.3.0 one. `export function taskWindowMs(task, date, shiftStartT, shiftEndT): readonly
[number, number]` (missing/malformed bound = shift bound, as planner.ts). Effect: baseline crews no longer work
05:00–06:00 (most tasks open at 06:00), so every baseline number moves: compare-cohorts flags those rows as simulated-
world changes. Docs to update by their owners: SIMULATION.md §4 policy definitions.

## 5. Back-test (backtest.ts, BACKTEST_VERSION 1.2.0)

- Arms from one table (ARM_TABLE: id, policy, kind baseline|zill|shadow, wearable); ARM_IDS, CLOSED_LOOP_ARMS,
  `export const ZILL_ARMS`, SHADOW_ARMS and the variant arm sets derive from it. Adding zill_monitored is one row
  `{ id: 'zill_monitored', policy: 'zill_monitored', kind: 'zill', wearable: true }` (plus PolicyId). BacktestArm gains
  `kind` and `wearable`.
- Variants (defined before any run with them): habitualDrinkFraction=1.0 (v0.1 floor) and habitualDrinkFraction=0.4
  (v0.2 floor) on the closed-loop arms; drinkLogging=50% and drinkLogging=x1.5 on ban_only + the Zill arms.
- VariantArmSummary.baseVsBanOnly: the base case's paired arm − ban_only on the variant's site-days, so a variant's
  delta reads next to the base delta on the same worker-shifts. Report `versions.truth`.

## 6. compare-cohorts.ts

Generated "## What changed between versions" section (after the header table): module versions of both reports
(ground-truth version inferred from the world-simulation version for reports before backtest 1.2.0), VERSION_NOTES
for every version in between (an unknown version gets an explicit "no version note" line), design differences (spec,
metric parameters, arms, variants), and "Rows driven by the simulated world": every headline measure of every baseline
arm, flagged ⚑ when it moved (a baseline arm has no Zill in it, so the change is the simulated world's, or the metric
definitions' when the metric parameters or an outcome-scope metrics version changed — METRICS_SCOPE). The flag is
repeated on baseline rows of sections 1, 2, 3 and 6. Section 3.1 shows the dehydration / heat-symptom deltas next to the
drinking floors. Arms are read from the reports (a new arm needs no code change; label falls back to its id).
Tests: scripts/validate/compare-cohorts.test.ts, run with
`npx vitest run --config scripts/validate/lib/vitest.config.ts scripts/validate/compare-cohorts.test.ts`.
For this round: docs/dev/cohort-v0.2-medium.json is a byte-identical snapshot of the v0.2 report
(HEAD:public/data/validation/cohort.json), and the CLI defaults are now --before=docs/dev/cohort-v0.2-medium.json
--labels=v0.2,v0.3 --out=docs/dev/cohort-v0.2-vs-v0.3.md (the v0.1 → v0.2 document stays as it is). After the v0.3
cohort run: `npx tsx scripts/validate/compare-cohorts.ts`.

## Worldsim changes (local, for the integration agent)
Only these parts of src/sim/worldsim.ts changed:
- `listedOrderSchedule` (task windows) and new `export function taskWindowMs`.
- Drink path in `stepWorkerTruthAndEngine`: `reminder = ws.engine !== null && drinkReminderShown(w.actsOnZill,
  ws.detail)`; `truth.drinkDecisionDetail(…, { …, minutesSinceFollowedReminder })` and `WorkerSim.lastFollowedReminderT`
  (new field, −Infinity at start); logging through `loggedDrinkMl(ml, drinkLoggingOf(w.config), ws.rng.drinkLog)`;
  private `drinkLoggingOf`.
- `listedOrderSchedule`: idle minutes count toward a pending statutory break.
- `WorkerSim.rng.drinkLog` (stream `drinklog|date|id`; forks do not advance other streams).
- `DEFAULT_SIM_BEHAVIOUR.drinkLogging`, `makeSimConfig` merge, `SimConfigInput.behaviour.drinkLogging?: Partial`,
  createWorld range check.
- WORLD_PARAMS.reminderAfterHotWorkMin removed; clinical.fluidStatus import removed.
- Module header, WORLDSIM_VERSION 1.3.0 and its note.

## Open issues for other owners
- ENGINE (safety + simulation): clinical.hydrationChannel computes the fluid status on NO intakes when check-ins are
  not consented (`fluidStatus(input.consented ? input.intakes : [], …)`, pre-existing at HEAD). For those workers the
  new risk.WorkerStepDetail.drink.reminder is 'drink' every exposed minute and never clears after a logged drink, and
  the 1.42 L/h hourly cap (the over-drinking / hyponatraemia guard) never applies. kezad 2025-07-19, zill_full: the 5 of
  8 workers without check-in consent logged 120–245 drinks before the truth-side re-follow rule. Suggest: keep the
  device-local intake log for caps and reminder spacing whatever the check-in consent (it never leaves the device), or
  space reminders by the clock without the log.
- ENGINE (LOW, guidance): rest/idle reminders use the work rate (250 mL / 20 min = 0.75 L/h); a resting worker in hot
  shade (sweat ≈ 0.2–0.3 L/h) is asked for more than TB MED 507's easy-work guidance at low heat categories. Simulated
  Zill workers now drink ≈ 8.9 L per 12-h shift (2-site-day check) vs 5.6 L under the midday ban only.
- worldsim.test.ts "engine-owned resume … heldByRule" fails with the in-progress engine (passes with the HEAD engine and
  this role's worldsim: checked in a HEAD sandbox). The engine now holds regulation/environment stops itself, so the
  simulator's rule-hold path is never reached: integration agent (resume path owner).
- With the in-progress engine/planner the Zill arms barely work: zill_full on Al Ain 2025-07-24 (demo crew) 0 work
  minutes (HEAD engine: 182 worker-minutes); 2 hot site-days (kezad 2025-07-19, alain 2025-07-17, cohort crews): Zill
  59 work min/shift vs ban only 334 (v0.2 cohort: 131.6 vs 398.1): planner/engine owners to check.
- To include a new arm (zill_monitored): sim/types.ts PolicyId, metrics.ts:182 (engine-active policy list),
  scripts/validate/cohort.ts:288 (fairArms), worldsim policy handling (actsOnZill / planner basis).
- Docs owners: SIMULATION.md §3.3 (reminders follow the device's rule, rest/idle included; the "known gap" is closed),
  §4 (listed order within task windows), §5 (new variants), VALIDATION-COHORT.md items that say reminders are tied to
  hot work or that every drink is logged; the cohort document should show habitualDrinkFraction=1.0 next to the
  headline dehydration and heat-symptom deltas (backtest VariantArmSummary.baseVsBanOnly gives the base delta on the
  variant's site-days; compare-cohorts §3.1 renders it).
