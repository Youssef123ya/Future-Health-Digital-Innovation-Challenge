# Wave 2c — integration notes

Owner: integration. Scope: src/sim/worldsim.ts, src/sim/metrics.ts, src/sim/backtest.ts, scripts/validate/cohort.ts,
src/state/** and tests; generated blocks of docs/VALIDATION-COHORT.md; new scripts under scripts/validate/.

Status: DONE. `npx tsc --noEmit` clean; `npx vitest run` 30 files / 1273 passed; validation suite 17/17 passed.

## 1. What changed

### worldsim 1.2.0 (src/sim/worldsim.ts)
- Planner gets `climate: hh` (the forecast hour's SiteHeat) in every PlannerHour, so planner.ts runs its ISO 7933 screen
  (plans no longer carry `phs_screen_unavailable`).
- planSchedule follows the plan's own execution layout per block-hour (BlockHour.startT / boutMin / wallMin: work first,
  then rest), which is what the screen simulated. `planWindowWorkMin` stays exported as the fallback for a block without
  block-hours.
- The device knows the assignment: `ctx.resumeTask` = this minute's scheduled task, else the next scheduled one (manual
  task under a manual assignment); `ctx.plannedWorkMinPerHour` = the plan block's rate inside plan task blocks (work and
  rest minutes). resumeTask is passed in every engine-on policy (shadow too).
- Resume rule (engine-owned): `WORLD_PARAMS.resumeMinMinutesToLimit`, `resumeCheckEveryMin`, `RestEpisode.nextCheckT` and
  the 5-min assessSnapshot loop with its 25-min margin are removed. A rest episode ends when the device no longer asks for
  rest (the engine holds a projection stop until its own resume check passes) AND the device's own assessment of the
  resume task is not stopped by the regulation or environment channel (`resumeTaskAllowed`, no margin; see deviation 1).
  One compliance draw per episode, as before.
- [ASSUMPTION] `detail.resume.infeasibleNow`: the worker keeps resting; the alert engine notifies the supervisor (stop with
  task_not_feasible_now + rotate_task); no reassignment is modelled unless the scenario has one (a later plan block with
  another task, a scripted or UI task change), which then becomes the resume task.
- Device work/rest cycles are aligned with plan block-hours: `export function deviceCycleWorkMin(deviceW, plannedRate,
  bhWall)` = null (no cut) when the device allows at least the plan's rate, else floor(W × wall / 60); outside a plan,
  60-min windows from the episode start as before.
- WorkerSim gains `resumeTask` and `plannedRate`; CrewSim gains planNext / planRate / planBhStart / planBhWall.

### Integration fix in src/engine/alerts.ts (not my file; small, protective-neutral)
- An open exposure alert is re-labelled 'individual' only when a channel actually drives the level
  (`info.driving.length > 0`). Cause: during risk.ts's de-escalation dwell every channel can compute safe (worker resting
  in the cabin) while the displayed level is held; basisOf() then returned 'individual' ("no channel explains the level")
  and the sticky rule re-labelled ~85 % of exposure alerts just before they resolved (peak-day: 123 of 144 worker alerts;
  after the fix: 2). New alerts with no driving channel stay individual (protective). Routing is unchanged (basis never
  enters routing). Test added in alerts.test.ts.

### metrics 1.1.0 (src/sim/metrics.ts)
- `alarmTimesByBasis(events, minLevel)`: individual alarms (first individual version at ≥ level, so a re-labelled alert
  counts from the re-label; any scope; missing basis = individual) and exposure advisories (worker-scope alerts never
  individual at ≥ level; crew bundles not double-counted).
- WorkerShiftRecord += `individualAlarmTimes {high, stop}`, `exposureAdvisories`. `recordAlarmTimes(r, set, level)`.
- `detectionSummary(..., minLevel = 'high', horizonMin = 120, alarmSet = 'individual')`; DetectionSummary += alarmSet. The
  all-alarm summary keeps its 1.0.0 bootstrap keys (its numbers are reproducible).
- RunAlertSummary += workerShifts, crewShifts, exposureAdvisoriesToSupervisor (distinct exposure alerts ≥ high notified to
  a supervisor), notificationsByBasisRole (sent / requiring ack), byBasis. `runAlertSummary(result, minLevel, { crews })`.
- ChallengeMeasures += individualAlarmsPerShift {high, stop}, exposureAdvisoriesPerWorkerShift,
  exposureAdvisoriesPerCrewShift, burdenPerWorkerShift (basis × role, plus total), eventLeadTimeAllAlarms;
  `eventLeadTime` now uses individual alarms. FairnessCell += individualAlarmsPerShift; sensitivityExcessive uses
  individual alarms. Old all-alarm fields are kept.

### backtest 1.1.0 (src/sim/backtest.ts)
- New sensitivity variant `supervisorFollowThrough=0.5` (closed-loop arms; defined before running) [ASSUMPTION].
- truthParams sweeps (metabolic spread, symptom hazard) now run: verified supported automatically (test asserts it).
- ArmSummary.detection = individual ≥ high (headline); += detectionStop (individual ≥ stop), detectionAllAlarms (1.0.0
  definition). Headline += individualAlarmsPerShift, individualStopAlarmsPerShift, exposureAdvisoriesPerShift.

### Reports and scripts
- scripts/validate/cohort.ts: challenge block shows individual alarms (≥ high; ≥ stop) and exposure advisories (per
  worker-shift; per crew-shift), plus a second table in the same generated block: notifications per worker-shift by basis
  and role. Detection block: individual alarms at ≥ high and ≥ stop. Variant/fairness columns relabelled.
- scripts/validate/compare-cohorts.ts (new): docs/dev/cohort-v0.1-vs-v0.2.md generated from the two JSON files.
- scripts/validate/scenario-sanity.ts (new): per-minute classification of scenario runs.
- scripts/validate/work-cost-drivers.ts (new): docs/dev/work-cost-drivers.md (what drives the Zill work cost).
- public/data/validation/cohort.json and the generated blocks of docs/VALIDATION-COHORT.md regenerated (medium mode).

## 2. Deviations from the brief (with reasons)
1. Resume rule: besides "device below stop", the episode waits until risk.assessSnapshot of the resume task shows no
   regulation/environment stop (no margin; projection channel excluded, the engine's hold owns it). Found by the first
   v0.2 cohort: with the loop removed entirely, ADOSH-unacclimatised workers flapped (stop → rest → dwell → resume → stop)
   and accumulated sun minutes in excluded zones: unacclimatised zone worker-hours 7 → 39, zone compliance 97.8 → 90.0 %.
   With the check: 8 h and 97.8 %. Decided in the worker-protective direction; the engine should own it (open issue).
2. alerts.ts integration fix (above).
3. Planner climate + BlockHour layout + cycle alignment: engine-risk's integration notes 1, 2 and 6, needed for
   "plan and monitor agree". boutMin = ceil(workMin) may exceed the plan's workMin by < 1 min per block-hour; the
   worldsim test that encoded the old floor layout was updated (expectation of old behaviour).
4. selectors.test.ts 'an escalated stop stays escalated after a late acknowledgement' depended on one random ack draw
   (> 2 min); the shared ack stream draws differently now. It now uses slow responders (medians 8–10 min) and steps until
   the late ack. Intent unchanged; no safety assertion weakened.
5. eventLeadTime and fairness sensitivity switched to individual alarms (old values kept in *AllAlarms fields).
6. Exposure advisories per crew-shift = distinct exposure alerts notified to a supervisor (handles bundling).
7. The burden table lives inside the existing cohort-challenge block (no new doc marker: I may not edit outside blocks).

## 3. Results

### Medium cohort v0.1 → v0.2 (45 site-days, 333 worker-shifts per arm; full tables in docs/dev/cohort-v0.1-vs-v0.2.md)
- Work min/shift: zill_full 121.1 → 131.6 (vs ban only −69.6 % → −66.9 %); hot −71.3 → −68.6 %, median −71.2 → −65.7 %,
  mild −66.3 → −66.5 %. Rest 493 → 369 min/shift.
- zill_full events /1,000: excessive 0 → 0, severe 0 → 0, critical 0 → 0, dehydration 0 → 9.0, heat-symptom episodes
  6.0 → 9.0, evacuations 3.0 → 9.0 (1 → 3 worker-shifts: heat-exhaustion onsets while resting/idle, not work through a hold).
- ban_only /1,000: excessive 66.1 → 87.1, dehydration 51.1 → 282.3, heat-symptom episodes 168.2 → 303.3 (sim-fixes
  drinking model: water 6.1 → 3.9 L/shift). Zill's Δ vs ban only grows accordingly; not comparable with v0.1 there.
- Alarms (zill_full): all ≥ high 7.06 → 6.56 /worker-shift; individual ≥ high 2.60, ≥ stop 0.68; exposure advisories
  2.00 /worker-shift, 5.13 /crew-shift; alerts requiring ack 5.76 → 4.95; notifications 16.30 → 13.30 /worker-shift.
  Requiring-ack notifications /worker-shift: worker 4.57, supervisor 3.42, buddy 0.39, first aider 0.03, OH 0.02.
- Shadow detection (shadow_zill_full, excessive strain): v0.1 all ≥ high sens 100 %, spec 0 %, PPV(shift) 6.6 %, FA 2.76,
  lead 156 → v0.2 individual ≥ high 96.6 % / 3.3 % / 9.0 % / 1.98 / 168; individual ≥ stop 93.1 % / 7.9 % / 9.4 % / 0.97 / 126.
- Zone compliance 97.8 → 97.8 % (unacclimatised zone hours 7 → 8); midday 100 → 100 %; adherence 73.8 → 70.6 %.

### What drives the work cost (docs/dev/work-cost-drivers.md)
- Crew job 398.9 min/worker-shift (ban only delivers 398.1). The Zill plan schedules 143.2: 218.4 incomplete (the
  allowed rates do not fit the job into 05:00–17:00 with 06:00 task windows) and 37.5 deferred. Execution loses only
  11.5 of the scheduled minutes (projection rest 7.5, regulation 2.3, evacuated 0.8, other 0.9).
- Task wall-min per worker-shift by limiter: NIOSH/ACGIH 240.0 at a 41 % work share, ISO 7933 screen 61.1 at 23 %, rule
  pack 22.9 at 59 %, none 16.9 at 100 %.
- All 45 crew-days bind to the NIOSH RAL + the next-stricter tier (108/333 members not acclimatised or conservative).
  Counterfactual without them: 178.7 vs 139.2 min scheduled per worker (crew-day mean).
- Planned rate (min/h) by WBGT_eff at the work location: heavy 24 (< 28 °C) → 15 (≥ 33 °C); moderate 36 → 14; light 56 → 21.
  Standards-driven (NIOSH/ACGIH TWA at the RAL; ISO 7933) plus planner design (crew-wide binding; work only in shift and
  task windows). Not a bug; nothing tuned.

### Scenario sanity (zill_full, 16 workers; scripts/validate/scenario-sanity.ts), before integration → after
| scenario | work % | idle % | rest-episode % (after: device asks; rule-held reg/env; other) | sim-blocked % | hold % | dehydration-blocked % | not feasible % |
|---|---|---|---|---|---|---|---|
| peak-day | 14.1 → 14.9 | 8.4 → 8.4 | 17.4 → 17.2 (6.8; 10.4/0; 0) | 9.0 → 0 | 8.0 → 0.8 | 0 → 5.6 | 6.8 → 0.6 |
| mild-day | 33.1 → 43.7 | 20.4 → 30.0 | 38.0 → 10.8 (8.6; 0/2.1; 0) | 2.8 → 0 | 35.1 → 8.2 | 0.2 → 0.2 | 32.7 → 7.3 |
| shade-only | 2.3 → 2.6 | 51.5 → 51.5 | 31.1 → 30.9 (30.9; 0/0; 0) | 0 → 0 | 1.9 → 1.9 | 12.1 → 12.2 | 1.9 → 1.9 |
Individual alarms per worker (after): HIGH+ 1.44 / 2.75 / 2.31, STOP+ 0.31 / 0.69 / 1.19; exposure advisories HIGH+
6.31 / 0.06 / 0.38. ("before" sim-blocked = rest-episode minutes with the device below stop, i.e. the old margin.)
- peak-day dehydration-blocked: W-D2D4 (fasting persona, drink-restricted, ISO drink = 0 rule, blocked 07:01 → end) and
  W-D2E5 (no check-in consent → no water credit; ISO 5 % at 16:25).
- shade-only: 11/16 workers reach the ISO water-loss limit 13:30–16:11 while idle/resting in the 45 °C canopy (PHS sweat
  3.6–4.4 L; credit 1.6–2.4 L for the 6 consenting, 0 for 5 without consent; reminders gated on hot work).
- Quick re-stops (≤ 15 min after an episode ended) before the rule check: 4/27, 6/21, 1/18 episodes.

### Performance
Fresh tsx process, 30 workers × 720 min, zill_full, best of 3: 1067 ms (2025-08-01; runs 1425/1118/1067; repeat best
1072), 1145 ms (2025-11-26). In-suite best 975 ms. Cohort medium: 1260 runs, 220 s CPU, 227 s wall.

## 4. Open issues for other owners
- risk.ts owner: move the regulation/environment resume check into the engine (a hold for task-dependent stops: ADOSH
  exclusion, heat stop band, acclimatisation budget, midday break), like the projection hold; then drop resumeTaskAllowed.
- Planner owner / orchestrator decision: crew-wide binding to the strictest member drives all crews to the RAL + stricter
  tier (counterfactual +28 % scheduled work without the binding members); jobs left incomplete (218 min/worker-shift); no
  work outside 06:00 task windows; boutMin = ceil(workMin) can exceed NIOSH/ADOSH allowances by < 1 min per partial
  block-hour (floor would be protective).
- clinical/risk owner: idle workers in hot shade get no drink reminders (shade-only water-loss blocks); fasting persona
  blocked for the whole shift by the drink = 0 0.6 rule from 07:01 on peak-day.
- Alarm burden: Zill arms 6.6 alarms (all) / 2.6 individual ≥ high per worker-shift, 3.4 supervisor acks per worker-shift,
  escalations ~384 /1,000 worker-shifts; exposure advisories 5.1 per crew-shift are the site-level-notice candidates.
- Docs owner: VALIDATION-COHORT.md narrative (§2.4 definitions, §3.3–3.4 readings, §4 new variant and sweeps now run, §8),
  SIMULATION.md (worldsim 1.2.0 resume rule, plan layout, cycles, resumeTask/plannedWorkMinPerHour, infeasibleNow
  assumption), PILOT.md §5.4 (a) (event lead time on individual alarms), engine-api docs (new exports).
- state/selectors: AlertItem.basis still missing (alerts agent's open issue); not done here.

## 5. Provenance
Final cohort.json stamp `zill@0.1.0+code.70c2fd8ca722+inputs.08e6c3972293` (= current code hash); a third, final run
was identical to the second apart from the stamp (deterministic). docs/dev/cohort-v0.1-vs-v0.2.md regenerated from it.
