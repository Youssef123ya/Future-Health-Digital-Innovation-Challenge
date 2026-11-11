# Wave 2d — integration notes

Owner: integration. Scope: src/sim/** (worldsim, scenarios, types, truth, metrics, backtest, simdata + tests),
scripts/validate/**, public/data/validation/**, docs/dev/**, generated blocks of docs/VALIDATION-COHORT.md.

Status: DONE (2026-11-11). tsc clean; full suite 31 files / 1418 passed; validation suite 3 files / 28 passed.

## Plan
1. [x] History snapshots: public/data/validation/cohort.json -> docs/dev/cohort-v0.2-medium.json (byte-identical to the
   sim-truth snapshot); docs/dev/cohort-v0.1-medium.json -> public/data/validation/cohort-v0.1.json; v0.2 copy ->
   public/data/validation/cohort-v0.2.json.
2. [x] Per-member plans in worldsim (memberCaps: per-worker plan layout + plannedWorkMinPerHour; floor bouts).
3. [x] PolicyId 'zill_monitored' (planner planBasis + WorkerContext.planBasis), enumerations, PlanBasis unified.
4. [x] Engine-owned resume: delete worldsim.resumeTaskAllowed; check zone hours / compliance vs v0.2 (8 h, 97.8 %).
5. [x] Review sim-truth's worldsim edits.
6. [x] Re-run: full suite, validation suite, medium cohort v0.3 (+ variants), compare-cohorts v0.2->v0.3 and
   v0.1->v0.3, work-cost drivers (both Zill arms), scenario sanity (5 scenarios x 2 Zill arms).
7. [x] docs/dev/engine-api-wave2d.md.

## Progress log
- Task 1 done before any change.
- Code (worldsim 1.4.0): per-member plan layouts (CrewSim.memberPlans, WorkerSim.layout; planSchedule split into
  layPlan + statutoryBreaks); zill_monitored (sim/types.ts PolicyId + ZILL_POLICY_IDS / WEARABLE_POLICY_IDS /
  isZillPolicy / policyUsesWearable / policyPlanBasis; planner planBasis; CrewSim.planBasis -> WorkerContext.planBasis);
  resumeTaskAllowed deleted (rest episode ends when !needsRest && !detail.resume.held); dead WorkerSim.lastHotWorkT removed.
- metrics 1.2.0: designed-suppressed versions are not alarms; suppressed advisories (AlarmTimesByBasis.suppressed,
  WorkerShiftRecord.suppressedAdvisories, ChallengeMeasures.suppressedAdvisoriesPerWorkerShift);
  RunAlertSummary/AckSummary.designedSuppression; engineRuns via isZillPolicy.
- backtest 1.3.0: arms zill_monitored + shadow_zill_monitored (shadow kept: detection of monitored mode needs a world
  where nobody acts); Headline.suppressedAdvisoriesPerShift, supervisorAcksPerShift.
- cohort.ts: labels, fairness arm, challenge columns (suppressed advisories, supervisor acks), variant columns with the
  base delta on the same days (dehydration, heat-symptom).
- Tests: worldsim (resume rewritten: no rule-held minutes; per-member layout = caps; mild-day known answer 191 min;
  monitored kezad 2025-09-20; shadow monitored), backtest arms, metrics suppression (2 new).
- Smoke (scenarios, zill_full vs zill_monitored): peak 82.6 / 82.6 work min, mild 280.9 / 280.9, shade-only 0 / 0
  (planner phs_rest_limit: rest alone reaches the ISO 7933 margin in the 45 °C canopy -> no planned work).
  Monitored mode changes work only where a monitored block-hour has NIOSH binding below the pack/screen (kezad
  2025-09-20: 444 worker-minutes worked above the table guide while monitored).
- compare-cohorts: VERSION_NOTES worldsim 1.4.0 / metrics 1.2.0 / backtest 1.3.0, METRICS_SCOPE 1.2.0 = 'alarms';
  alarm section gains suppressed advisories and supervisor acks; tests updated (unknown-version cases now 1.9.0/1.10.0).
- scenario-sanity.ts rewritten (no resumeTaskAllowed mirror: rest episodes split by the engine's own holds; 'other'
  must be 0; task hold, monitored, suppressed advisories, members on caps; default 5 scenarios x zill_full,zill_monitored).
- work-cost-drivers.ts rewritten (both Zill arms; per-member scheduled work; §4 per-member plans replaces the obsolete
  crew-wide binding counterfactual; monitored block-hour wall minutes).
- docs/dev/engine-api-wave2d.md written (UI round API + role visibility table).
- Full suite after code changes: 31 files, 1418 passed. Validation suite 25 passed. tsc clean.

### Scenario sanity (worldsim 1.4.0; 16 workers except saadiyat 12)
| scenario | policy | work % | idle % | rest ep. % (asks: task-held / proj-held; other) | task hold % | monitored % | dehydr.-blocked % | ind. HIGH+ /w | ind. STOP+ /w | exp. adv. /w | suppressed /w | members on caps (sched. min) | work min/w | intake L/w |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| peak-day | zill_full | 11.6 | 22.4 | 11.1 (11.1: 9.7 / 0.4; 0) | 9.7 | 0 | 5.3 | 3.06 | 0.56 | 3.13 | 0 | 2 (0) | 82.6 | 7.41 |
| peak-day | zill_monitored | 11.6 | 22.4 | 11.1 (11.1: 9.7 / 0.4; 0) | 9.7 | 15.2 | 5.3 | 3.06 | 0.56 | 3.13 | 0 | 2 (0) | 82.6 | 7.41 |
| humid-day | zill_full | 12.2 | 19.5 | 19.9 (19.9: 8.9 / 7.3; 0) | 8.9 | 0 | 0 | 4.44 | 0.31 | 0.63 | 0.44 | 2 (5) | 88.1 | 6.59 |
| humid-day | zill_monitored | 12.2 | 19.8 | 17.9 (17.9: 7.6 / 6.6; 0) | 7.6 | 14.7 | 0 | 4.69 | 0.44 | 0.75 | 0.25 | 2 (5) | 87.8 | 6.56 |
| mild-day | zill_full | 39.0 | 44.3 | 8.5 (8.5: 0 / 7.7; 0) | 0 | 0 | 0.7 | 1.75 | 0.69 | 0 | 0 | 2 (245.5) | 280.9 | 7.95 |
| mild-day | zill_monitored | 39.0 | 44.3 | 8.5 (8.5: 0 / 7.7; 0) | 0 | 13.6 | 0.7 | 1.75 | 0.69 | 0 | 0 | 2 (245.5) | 280.9 | 7.95 |
| saadiyat-peak | zill_full | 16.6 | 31.3 | 1.8 (1.8: 0 / 1.8; 0) | 0 | 0 | 0 | 3.33 | 0.75 | 1.75 | 1.33 | 1 (75) | 119.2 | 7.90 |
| saadiyat-peak | zill_monitored | 16.6 | 31.3 | 1.8 (1.8: 0 / 1.8; 0) | 0 | 25.7 | 0 | 3.33 | 0.75 | 1.75 | 1.33 | 1 (75) | 119.2 | 7.90 |
| shade-only | zill_full | 0 | 63.3 | 24.9 (24.9: 0 / 0.8; 0) | 0 | 0 | 5.9 | 1.13 | 0.63 | 0.31 | 0 | 3 (0) | 0 | 12.22 |
| shade-only | zill_monitored | 0 | 63.3 | 24.9 (24.9: 0 / 0.8; 0) | 0 | 41.6 | 5.9 | 1.13 | 0.63 | 0.31 | 0 | 3 (0) | 0 | 12.22 |
Readings: 'other' rest-episode minutes are 0 in every run (no simulator resume rule). peak-day: the engine's task hold
covers 9.7 % of worker-minutes (v0.2: 10.4 % held by the simulator's own rule). shade-only: the plan warns
phs_rest_limit (rest alone reaches the ISO 7933 margin under the 45 °C canopy) and schedules no work (v0.2: 2.6 % work);
intake 12.2 L per worker-shift (idle-in-heat reminders at the work cadence; engine open issue). Monitored mode is in
force 14–42 % of worker-minutes but changes work only where a monitored block-hour has the NIOSH/ACGIH cap binding
below the rule pack and the ISO 7933 screen (none in these scenarios except a small humid-day effect).
- Invariants probe (review-2c/probes/sim-invariants.mts, copied with a policy switch): shadow == ban_only on truth
  (outcomes, per-minute trace, truth/task events) and chunked == single stepping hold for zill_full and zill_monitored
  on shade-only, mild-day, humid-day, peak-day.

## Deviations from the brief (with reasons)
1. Versions: WORLDSIM_VERSION 1.3.0 → 1.4.0, BACKTEST_VERSION 1.2.0 → 1.3.0, METRICS_VERSION 1.1.0 → 1.2.0 (sim-truth had
   bumped worldsim/backtest earlier in this round). Separate versions keep the simulated-world change (1.3.0, flagged on
   baseline rows by compare-cohorts) apart from the integration change (1.4.0: per-member plans, zill_monitored,
   engine-owned resume; baseline arms untouched).
2. Shadow arm shadow_zill_monitored added (decision asked for): monitored mode changes which limits enforce, and only a
   world where nobody acts can show whether that device still warns before the strain events (acting censors them).
   Base case only; the variants keep their shadow arms.
3. A rest episode ends when !needsRest(assessment) && !detail.resume.held — the engine's own hold flag is read
   explicitly (a held device also shows stop, so it adds no rule of the simulator's).
4. Member layouts: a crew block-hour without a matching MemberCapHour (start + task), and a task-block minute outside
   every block-hour, give such a member no work [ENG, protective]. Statutory break computed per worker on their own
   work minutes (the legal rule is per worker).
5. metrics 1.2.0 excludes still-suppressed alert versions from every alarm count, including the all-alarm (1.0.0)
   count, and from exposure advisories (governance open issue: burden from notified alerts); a lifted alert counts from
   its lift. Old reports had no suppression, so their numbers read the same.
6. PlanBasis: one declaration (planner.ts); risk.ts keeps its type-only re-export of that same type (other owners'
   tests import it from risk.ts). Sim code imports it from planner.ts.
7. "detail.environment.enforced decides whether the table cycle runs": no simulator code needed — the simulator keeps no
   copy of the table; the device's own workMinPerHour (which the cycle follows) includes the table cycle only while
   enforced. Documented in worldsim and tested (kezad 2025-09-20: monitored workers work above the table guide).
8. compare-cohorts.test.ts (sim-truth's new tests): two cases used metrics '1.2.0' as an "unknown version"; now a known
   alarm-scope version, so they use 1.9.0 / 1.10.0 and a case checks that 1.2.0 does not share outcome attribution.
9. cohort.ts variant tables gain Δ dehydration and Δ heat-symptom vs ban only with the base case's delta on the same
   days (sim-truth open issue); challenge table gains suppressed advisories and supervisor acks per worker-shift.
10. Removed the dead WorkerSim.lastHotWorkT (fed the simulator's reminder rule up to 1.2.0; the engine keeps its own).

## Findings while the v0.3 cohort ran (same 45 days; numbers final in the Results section)
- Plan level (zill_full, 45 crew-days): phs_rest_limit on 8 crew-days, all at Al Ain (shade rest area; 3 hot, 2 median,
  3 mild): rest alone reaches the ISO 7933 screen margin within the 05:00–17:00 shift, so the plan schedules no work
  there (4,320 crew-minutes deferred). That is most of the jump in deferred work (v0.2 37.5 → 129.7 min per
  worker-shift) and of the drop in incomplete work (218.4 → 113.2).
- Per-member plans: 63 of 333 members are on caps (scheduled 88.4 min each vs 158.3 for the other members); no crew-day
  has no acclimatised member. v0.2 bound every crew to the RAL (108 binding members).
- Execution: scheduled-but-not-worked 22.7 min/worker-shift (v0.2 11.5): projection rest episodes 15.2 (7.5), device
  work/rest cycle 5.4 (0.3; private factors are now device-directed rest instead of crew-wide binding).
- zill_monitored schedules more (149.7 vs 145.1 min) but delivers less (115.7 vs 122.4): more work is lost to
  projection holds (23.1 vs 15.2) and to device table cycles of workers whose device cannot confirm monitoring
  (8.7 vs 5.4). The monitored crew rate is planned near the reference worker's ISO 7933 margin; individual
  projections (own body, clothing, live climate) then hold more often, and every hold costs a ≥ 25-min resume check.

## Results (medium cohort v0.3: 45 site-days, 333 worker-shifts per arm, 1,860 runs, 1,037 s wall)
Stamp `zill@0.1.0+code.99c7f34e7c0f+inputs.08e6c3972293` (= the final code hash: checked after the run).
Generated: public/data/validation/cohort.json, the 11 generated blocks of docs/VALIDATION-COHORT.md,
docs/dev/cohort-v0.2-vs-v0.3.md, docs/dev/cohort-v0.1-vs-v0.3.md, docs/dev/work-cost-drivers.md (both Zill arms).
History for the evidence screen: public/data/validation/cohort-v0.1.json, cohort-v0.2.json.

| Arm | Work min/shift | vs ban only (paired) | vs site index (means) | Excessive /1,000 | Severe | Critical | Dehydration > 3 % | Heat-symptom episodes | Evacuations | Individual alarms ≥ high /ws | ≥ stop /ws | Supervisor acks /ws | Exposure advisories /ws | Suppressed advisories /ws | Zone compliance (unacclimatised zone h) | Water L/shift |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ban_only | 366.8 | — | +2.5 % | 114.1 | 24.0 | 21.0 | 96.1 | 237.2 | 21.0 | — | — | — | — | — | 45.6 % (40) | 5.55 |
| site_index | 358.0 | −2.4 % | — | 39.0 | 0 | 0 | 81.1 | 150.2 | 0 | — | — | — | — | — | 100.0 % (0) | 5.52 |
| zill_env | 122.9 | −66.5 % | −65.7 % | 0 | 0 | 0 | 0 | 6.0 | 3.0 | 2.76 | 0.94 | 3.60 | 0.98 | 0.44 | 100.0 % (0) | 7.95 |
| zill_full | 122.4 | −66.6 % | −65.8 % | 0 | 0 | 0 | 0 | 6.0 | 3.0 | 2.61 | 0.88 | 3.39 | 0.90 | 0.40 | 100.0 % (0) | 7.95 |
| zill_monitored | 115.7 | −68.5 % | −67.7 % | 0 | 0 | 0 | 0 | 6.0 | 3.0 | 2.35 | 0.86 | 3.02 | 0.64 | 0.29 | 100.0 % (0) | 7.63 |

v0.2 for reference: ban only 398.1 min / 87.1 / 9.0 / 6.0 / 282.3 / 303.3 / 6.0; site index 392.0 / 57.1 / 0 / 0 /
267.3 / 264.3 / 0; zill_full 131.6 (−66.9 %) / 0 / 0 / 0 / 9.0 / 9.0 / 9.0, individual ≥ high 2.60, ≥ stop 0.68,
supervisor acks 3.42, exposure advisories 2.00, zone 97.8 % (8 h), water 5.52 L.

- Zone check (task 4): zone compliance 97.8 % → 100.0 % and unacclimatised zone hours 8 → 0 in every Zill arm: no
  regression (ADOSH-unacclimatised members now get cap 0 in excluded zones, and the engine's task hold keeps a stopped
  worker off an excluded task). Nothing to report to the engine.
- Baseline rows moved with the simulated world (compare-cohorts ⚑): ban only excessive 87.1 → 114.1, severe 9 → 24,
  critical 6 → 21, evacuations 6 → 21 (task windows: baseline crews start at 06:00 and work later into hotter hours),
  dehydration 282 → 96 and heat-symptom 303 → 237 (calibrated drinking floor). Zill's paired Δ excessive grows
  −87.1 → −114.1 for the same reason (world change, not Zill).
- Strata (work vs ban only): hot zill_full 109.9 (−69.6 %), monitored 101.5 (−71.9 %); median 126.4 (−65.8 %) /
  117.9 (−68.1 %); mild 130.9 (−64.6 %) / 127.6 (−65.5 %).
- Alarms (zill_full): all alarms 6.56 → 4.16 /ws; individual ≥ high 2.60 → 2.61, ≥ stop 0.68 → 0.88; exposure
  advisories 2.00 → 0.90 /ws (5.13 → 3.78 /crew-shift); designed suppression 336 alerts (273 never notified, 63 lifted);
  alerts requiring ack 4.95 → 3.61 /ws; supervisor acks 3.42 → 3.39 /ws, of which individual 2.88; escalations
  417 /1,000.
- Shadow detection (excessive strain, individual ≥ high; positives 38/333): shadow_zill_full sensitivity by onset
  100 %, specificity 2.7 %, PPV (shift) 11.7 %, false alarms 1.90 /shift, lead 128 min; ≥ stop 97.4 % / 4.7 % / 11.9 % /
  0.97 / 108. shadow_zill_monitored: identical (monitored mode leaves the individual-alarm channels unchanged).
- Variants: drinking floor 1.0 → Zill Δ dehydration −72.1 (base −108.1 on the same days), floor 0.4 → −288.3;
  drink logging 50 % / ×1.5: no outcome change (Δ dehydration −108.1 = base); wearable dropout 20/50/100 %: zill_full
  work 109.1/109.4/109.3 vs 109.9 base hot days, monitored 100.1/99.7/99.9 vs 101.5; stale forecast lowest work
  (zill_full 106.5, monitored 97.1 on hot days). No variant gives a Zill excessive/severe event.
- Work-cost drivers (docs/dev/work-cost-drivers.md): zill_full scheduled 145.1, delivered 122.4, unscheduled deferred
  129.7 / incomplete 113.2; lost 22.7 (projection rest 15.2, device cycle 5.4); monitored scheduled 149.7, delivered
  115.7, lost 34.0 (projection 23.1, device cycle 8.7); monitored block-hours 98.2 wall min /ws; 63/333 members on caps
  (88.4 vs 158.3 min scheduled).

## Open issues for other owners
- PLANNER / orchestrator: phs_rest_limit removes all work on 8 of 9 Al Ain crew-days (shade rest area; rest alone
  reaches the ISO 7933 screen margin within 05:00–17:00 with no drinking credit) — the largest new work-cost driver
  (deferred 37.5 → 129.7 min /ws). Levers: cooled rest area, credited drinking within the 7.5 % ceiling, shorter shifts.
- PLANNER / engine: zill_monitored delivers less work than zill_full (115.7 vs 122.4). The monitored crew rate sits at
  the reference worker's ISO 7933 margin, so individual projections hold more (23.1 vs 15.2 min lost /ws) and devices
  that cannot confirm monitoring (no wearable or consent — private, so the plan cannot know) cut to the table (8.7 vs 5.4).
- ENGINE (confirms sim-truth's issue): Zill arms drink 7.95 L per shift (ban only 5.55 L) and 12.2 L in the shade-only
  scenario (idle in heat: reminders at the work cadence, 250 mL / 20 min; no hourly cap without check-in consent). The
  truth model does not penalise over-drinking, so the simulated dehydration benefit is likely over-stated.
- ALERTS / UX: supervisor acknowledgements stay at 3.39 per worker-shift (≈ 25 per crew-shift), 2.88 of them individual;
  designed suppression removes 0.40 exposure advisories per worker-shift.
- DOCS: SIMULATION.md §4 (zill_monitored, engine-owned resume, per-member layouts, cycle hysteresis), §5 (shadow monitored
  arm), VALIDATION-COHORT.md narrative (new arms and columns, metrics 1.2.0 alarm definition, baseline definition change
  of worldsim 1.3.0).
- UI: docs/dev/engine-api-wave2d.md.

## Review of sim-truth's worldsim edits (task 5)
Consistent with this round: the listed-order schedule honours task windows and counts idle minutes toward a pending
statutory break, as the plan layouts' statutoryBreaks does; the worker follows the device's own reminder
(detail.drink.reminder), delivered under every acting Zill policy (zill_monitored included; doc comment updated) and
never in shadow mode; drink logging changes only the device log. Changed here: the dead WorkerSim.lastHotWorkT (fed the
removed simulator reminder rule) is gone. Not changed: the 20-min re-follow rule lives in truth.ts and never binds for
a device that clears its reminder on a logged drink. Deviation 11: the cycle W is read while the worker works (for the
task); a cycle set at the task runs to the end of its window (hysteresis), because the resting assessment's monitoring
state can differ from the task's — reading it would flap (documented in worldsim updateEpisodes).
