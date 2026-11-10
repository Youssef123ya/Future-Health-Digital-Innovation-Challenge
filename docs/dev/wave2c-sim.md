# Wave 2c — sim-fixes

Owner: sim-fixes. Scope: src/sim/{truth,worldsim,types,scenarios,simdata}.ts (+tests), src/sim/metrics.ts (item 2 only),
src/state/{governanceStore,simStore}.ts (+tests, item 4). Not touched: src/engine/**, src/sim/backtest.ts, scripts/**,
docs/*.md, and the simulator's resume rule (WORLD_PARAMS.resumeMinMinutesToLimit / assessSnapshot), which is left for
the integration step.

## Status
- [x] 1 truthParams overrides
- [x] 2 structured truth events (onsetT, cluster)
- [x] 3 SimBehaviour.supervisorFollowThrough
- [x] 4 consent injection (worldsim + governanceStore wiring)
- [x] 5 site_index ADOSH hourly dose
- [x] 6 ShiftOutcome.idleMin
- [x] 7 drinking model fix
- [x] 8 idle share: causes found and documented; one sim artifact fixed (plan partial windows)
- WORLDSIM_VERSION 1.0.0 → 1.1.0 (mechanics changed, so stamps change)

## New fields and APIs

sim/types.ts
- `SimBehaviour.supervisorFollowThrough: number` (0–1): the probability that the supervisor's direct reassignment on a
  STOP is carried out. Default 1 (`DEFAULT_SIM_BEHAVIOUR`, `makeSimConfig`), which is the v0.1 behaviour.
- `WorldInjection` gains `{ kind: 'consent'; workerId: string; consent: ConsentState }`.
- `TruthSymptomCluster = 'heat_exhaustion' | 'cramps' | 'cns' | 'thirst'`.
- The truth `SimEvent` gains `onsetT?: number` and `cluster?: TruthSymptomCluster`. `onsetT` is when the condition
  started: it equals `t` for symptom onsets, and for excessive strain `t` is onset + 10 min. `cluster` is set on
  symptom_onset only. `detail` keeps its text, including the old "<cluster>: …" prefix.
- `ShiftOutcome.idleMin: number` (no task assigned). work + rest + idle = shift minutes. `idleMinutes()` is kept.

sim/worldsim.ts
- `CreateWorldOptions.truthParams?: DeepPartial<TruthParams>` is deep-merged at createWorld. The config-driven leaves win:
  behaviour.reminderCompliance = config.behaviour.compliance, wearable.minuteLossProb = disruptions.wearableDropout and
  wearable.noiseMultiplier = disruptions.ppgNoiseMultiplier. The overrides join the stamp hash only when given, so runs
  without them keep the same hash input. backtest.ts `truthOverridesApplied` now returns true, so the metabolic-spread
  and symptom-hazard sweeps run.
- `export function planWindowWorkMin(workMinPerHour, blockMin, minuteInBlock): number` is the plan partial-window rule
  (item 8).
- `WorkerSim` (internal, exported for inspection) gains `rosterProfile` (readonly, the roster at shift start); `profile`
  is now mutable (what the device's engine sees); `physioActive` and `checkinsConsented` are now mutable; it also gains
  `rng.supervisor`, and `pendingEnforce` becomes `'supervisor' | 'first_aider' | null`.
- Supervisor reassignment: `enforceRest(w, ws, t, by)`. A supervisor reassignment is carried out with probability
  supervisorFollowThrough. That takes one draw from the worker's own `supervisor|date|id` stream, made only when it would
  matter (the worker is not already resting). If it is not carried out, an `instruction` 'stop_work' is logged with
  followed false. A first aider's in-person reassignment is always carried out. With the default of 1, the logs are
  identical to v0.1.
- Consent injection (`applyConsent`): from that minute the engine sees the roster profile with the new consent.
  - Risk flags are used only while healthFlags is on (WorkerProfile contract). A re-grant restores the rostered flags
    [ASSUMPTION].
  - Wearable off: physioActive becomes false. No PPG samples and no physiology minute reach the engine, and risk.ts
    reports physiology as 'absent'.
  - Check-ins off: no prompted check-ins, any open prompt is withdrawn, and only in-person checks are used.
  - Fasting on the truth side stays with the roster (the worker still fasts). What the device knows about fasting
    follows the consented risk flags (`deviceFasting`).
  - The fairness subgroup uses the roster profile.
  - A non-boolean scope or an unknown worker throws RangeError.
- site_index: the hourly ADOSH dose is carried across task changes (see the assumptions below).

sim/truth.ts
- `TRUTH_PARAMS.behaviour.habitualDrinkFraction = 0.4` [ASSUMPTION].
- `export function spontaneousDrinkRateMlPerH(state, traits, onBreak = false): number`.
- `export const DRINK_MODEL_BASIS: string`.
- `drinkDecision` semantics changed (item 7). It still draws exactly two uniforms per call.

sim/metrics.ts
- `export function truthEventCluster(e: Extract<SimEvent, { kind: 'truth' }>): string` returns the structured `cluster`,
  falling back to the old detail prefix for logs written before 1.1.0. workerShiftRecords uses it, and uses
  `onsetT ?? t` for heatSymptomOnsetT.

state/governanceStore.ts
- `connectGovernanceToSim(sim, gov, opts?: GovernanceSimOptions)`, with
  `GovernanceSimOptions { deviceWorkerId?: () => string | null }`. The device world follows the ledger: whenever a
  worker's ledger consent differs from the device's, a 'consent' injection goes through `sim.inject`. This is checked
  after grant/revoke, on a new world (reset, reload, configure) and after a backward jump.
  - Omit the option in a single-tab app, where one world simulates every device.
  - In a multi-tab demo, pass it: it names only that tab's own phone, and returns null in a console tab.
  - Nothing is injected into a finished shift.
  - Device side only: syncBus `messageForInjection` returns null for 'consent' (its default branch), so nothing
    crosses the bus.
  - The ledger is seeded from `rosterProfile`.
- `export function sameConsentScopes(a: ConsentState, b: ConsentState): boolean` (ignores updatedAt).

## Assumptions and engineering choices (with basis)
- supervisorFollowThrough default 1 [ASSUMPTION]: it keeps the v0.1 behaviour. A value below 1 lets the compliance sweep
  test the assumption that matters, because the reassignment overrides a worker who does not comply.
- habitualDrinkFraction 0.4 [ASSUMPTION]: the drinking floor when not sweating is 0.4 × the individual baseline, about
  180 mL/h median. That matches the IOM (2004) adequate beverage intake for men (about 3.0 L/day, roughly 81 % of the
  3.7 L total-water AI) spread over about 16 waking hours.
- Spontaneous drinking target = max(habitual floor, replacement fraction × recent sweat rate) × thirst gain × break
  factor [ASSUMPTION].
  - Observed voluntary intake in the heat replaces about 50–80 % of sweat loss (involuntary dehydration: Greenleaf 1992;
    Sawka et al. 2007 ACSM; citations recalled, UNVERIFIED). The existing individual replacement fraction N(0.6, 0.15)
    carries this.
  - Intake guidance (NIOSH 2016: 1 cup every 15–20 min; TB MED 507 Table 3-2) is what the reminders ask for.
  - The Bates & Schneider 450 mL/h hot-shift observation is no longer applied as a floor during cooled rest.
- A followed reminder is the drink of that minute: it replaces the spontaneous drink instead of adding to it (bug fix).
- ADOSH dose: Σ minutes/allowance ≤ 1 per clock hour, with DOSE_EPS 1e-9 [ENG]. This is the same sum-of-fractions rule
  metrics.ts scores zone compliance with. A single-task hour keeps the W-minute work-first layout, and with W = 60
  everywhere (ban_only, shadow) the dose never binds. Check on the brief's example (musaffah 2025-07-12, default
  roster, site_index): the maximum crew-hour dose is now 1.000 (it was 1.56 at 10:00: 20 min moderate at 20/40 followed
  by 25 min light at 45/15). The moderate task now uses the whole budget of the 10:00 hour, and the light task starts at
  11:00.
- Plan partial window: a block's last partial 60-min window of r minutes gets floor(W·r/60) work minutes [ENG; plan
  fidelity, rounded down, protective].

## Item 7: drinking model results
The model and its parameter were decided before any re-run and were not tuned. Intake per worker in L/day (the fasting
persona W-D2D4 is excluded):

| scenario | policy | before: mean (median; min–max) | after: mean (median; min–max) | > 11.36 L, before → after | hydration channel HIGH/STOP level events, before → after |
|---|---|---|---|---|---|
| peak-day | ban_only | 5.15 (4.75; 0.75–12.75) | 3.80 (3.50; 0.50–9.00) | 1 → 0 | 0 → 0 |
| peak-day | zill_full | 9.62 (9.00; 5.75–18.25) | 6.48 (6.50; 2.25–10.75) | 2 → 0 | 4 → 0 |
| mild-day | ban_only | 6.55 (7.00; 2.75–10.50) | 3.22 (3.25; 1.25–4.25) | 0 → 0 | 0 → 0 |
| mild-day | zill_full | 10.15 (10.50; 6.50–13.75) | 6.30 (6.50; 3.75–8.75) | 4 → 0 | 4 → 0 |

Plausibility: intake is a few L/day, and nobody is above the 11.36 L/day cap (TB MED 507: 12 qt). Zill workers drink
about twice as much as the baseline because they follow reminders (NIOSH cadence) during exposure, which is the intended
intervention effect.

Side effect, not tuned away: the old 450 mL/h floor gave more than 100 % replacement at low and moderate sweat rates, so
it hid involuntary dehydration in the baseline arms. With the corrected model the baseline arms drink less and have more
dehydration ≥ 3 % events. Scenario totals, before → after:

| scenario | ban_only | site_index | Zill |
|---|---|---|---|
| peak-day | 6 → 6 | 2 → 4 | — |
| humid-day | 4 → 7 | 3 → 4 | — |
| mild-day | 1 → 2 | — | — |
| saadiyat-peak | 0 → 4 | 0 → 2 | — |
| shade-only | 1 → 10 | 2 → 9 | 0 → 1 |

The shade-only rise comes from long idle and rest bouts in a 45 °C shade canopy with no reminders. The device's reminder
gating requires hot work in the last 30 min, mirroring risk.ts isHotWork / sweatingSince (see open issues).

## Item 8: idle share findings
Scheduled no-task minutes by cause, as a share of worker-minutes (crew schedule at createWorld, before engine-driven
rest). "Slack" means the job is done or the job is shorter than the shift.

| scenario | ban_only: slack | site_index: slack | zill_full: before task windows | zill_full: slack | zill_full: deferred by plan |
|---|---|---|---|---|---|
| peak-day | 23.4 % | 0.4 % | 8.3 % | 0 | 0 |
| humid-day | 23.4 % | 3.2 % | 8.3 % | 0 | 0 |
| mild-day | 23.4 % | 23.4 % | 8.3 % | 17.2 % | 0 |
| saadiyat-peak | 22.9 % | 1.7 % | 4.2 % | 0 | 18.8 % |
| shade-only | 38.0 % | 31.7 % | 5.2 % | 0 | 67.7 % |

Causes:
1. Schedule coverage of the generated crews. This is the intended workload and is the same under every listed-order
   policy. Each generated crew has a fixed day's job of 300–480 crew-minutes on a 720-min shift (data/workforce.ts crew
   templates: for example musaffah-c1 has 360, alain-c2 has 300). Once the job is done, the crew is idle in the rest
   area. site_index stretches the job with zone cycles in hot hours, so its slack is smaller. This is not a sim artifact,
   so it is documented rather than changed. Share-of-shift statistics are diluted by this slack; use work minutes and the
   new `idleMin` to separate slack from protective rest.
2. The 05:00–06:00 hour under the plan policies. Almost every generated task has earliestStart 06:00, but the shift
   starts at 05:00.
   - The planner treats task windows as hard constraints.
   - The listed-order schedule (ban_only, site_index, shadow) ignores them and works from 05:00, in the coolest hour.
     It does the same as planner.ts's naive comparison plan.
   - This is a policy asymmetry: the baselines get about 60 min per worker-shift of extra cool work. It is not changed
     here because changing it would alter the baseline's documented definition (open issue).
3. Planner deferrals. This is engine behaviour, not a sim artifact. Tasks the planner cannot fit become no-task minutes
   while work remains. On shade-only, alain-c2 (very heavy kerb laying and heavy backfill) gets no work all day; on
   saadiyat-peak, saadiyat-c1's concrete pour is deferred. This explains most of the shade-only idle under Zill.
4. Plan schedules were not losing work; they were gaining it. The 60-min work-first layout gave a block's last partial
   window min(r, W) work minutes instead of W·r/60. For example, a 40-min block at 30 min/h worked 30 min, the mild-day
   demo crew had 480 min scheduled against 453 planned, and the peak-day demo crew had 135 against 127.5.
   - This is fixed by planWindowWorkMin. Scheduled work now equals the plan rounded down in every scenario:

     | scenario | scheduled / planned work min, by crew |
     |---|---|
     | peak-day | 127 / 127.5, 132 / 132.5 |
     | mild-day | 453 / 453.3, 360 / 360 |
     | saadiyat-peak | 75 / 75, 180 / 180 |
     | shade-only | 50 / 50, 0 / 0 |

   - The fix also removes hours where two short plan blocks exceeded both allowances, which matters for "plan and
     monitor agree".

## After numbers (all items; measured 2026-11-10 at about 22:56 local)
The ban_only and site_index rows do not depend on the engine. The Zill rows do, and other agents were changing the engine
at the same time (risk.ts, alerts.ts and clinical.ts were modified between 22:50 and 23:01). I re-ran everything at 23:02,
once tsc was clean and the full suite passed (30 files, 1261 tests), and got identical numbers. The engine's new resume
hold is not wired into worldsim yet (that is the integration step), so re-measure the Zill rows after integration.

| scenario | policy | work | rest | idle, before → after | intake L/day mean, before → after | dehyd ≥3 %, before → after |
|---|---|---|---|---|---|---|
| peak-day | ban_only | 56.7 % | 9.1 % | 34.1 → 34.1 % | 4.83 → 3.56 | 6 → 6 |
| peak-day | site_index | 44.5 % | 55.1 % | 0.5 → 0.5 % | 5.48 → 3.28 | 2 → 4 |
| peak-day | zill_env | 14.1 % | 77.5 % | 8.4 → 8.4 % | 9.02 → 6.08 | 0 → 0 |
| peak-day | zill_full | 14.1 % | 77.5 % | 8.4 → 8.4 % | 9.02 → 6.08 | 0 → 0 |
| humid-day | ban_only | 56.6 % | 12.2 % | 31.2 → 31.2 % | 4.31 → 3.03 | 4 → 7 |
| humid-day | site_index | 50.8 % | 45.2 % | 5.9 → 4.1 % | 4.50 → 2.72 | 3 → 4 |
| humid-day | zill_env | 15.4 % | 76.3 % | 8.3 → 8.3 % | 8.16 → 6.08 | 0 → 0 |
| humid-day | zill_full | 14.6 % | 77.1 % | 8.3 → 8.3 % | 7.94 → 5.84 | 0 → 0 |
| mild-day | ban_only | 64.6 % | 12.0 % | 23.4 → 23.4 % | 6.14 → 3.02 | 1 → 2 |
| mild-day | site_index | 64.6 % | 12.0 % | 23.4 → 23.4 % | 6.14 → 3.02 | 1 → 2 |
| mild-day | zill_env | 33.1 % | 46.5 % | 24.3 → 20.4 % | 9.52 → 5.91 | 0 → 0 |
| mild-day | zill_full | 33.1 % | 46.5 % | 24.3 → 20.4 % | 9.52 → 5.91 | 0 → 0 |
| saadiyat-peak | ban_only | 58.3 % | 18.8 % | 22.9 → 22.9 % | 6.17 → 4.79 | 0 → 4 |
| saadiyat-peak | site_index | 51.7 % | 46.5 % | 1.7 → 1.7 % | 6.29 → 4.21 | 0 → 2 |
| saadiyat-peak | zill_env | 17.0 % | 60.1 % | 22.9 → 22.9 % | 8.15 → 6.38 | 0 → 0 |
| saadiyat-peak | zill_full | 16.9 % | 60.2 % | 22.9 → 22.9 % | 8.19 → 6.40 | 0 → 0 |
| shade-only | ban_only | 51.0 % | 10.9 % | 38.0 → 38.0 % | 7.73 → 5.30 | 1 → 10 |
| shade-only | site_index | 49.3 % | 19.0 % | 32.7 → 31.7 % | 8.02 → 5.16 | 2 → 9 |
| shade-only | zill_env | 2.3 % | 46.2 % | 47.9 → 51.5 % | 7.17 → 3.63 | 0 → 1 |
| shade-only | zill_full | 2.3 % | 46.2 % | 47.9 → 51.5 % | 7.17 → 3.63 | 0 → 1 |

The intake means in this table include the fasting persona (0 L); the item 7 table excludes it. The Zill idle changes
come from engine rest during no-task minutes, not from the schedule: an idle minute counts as rest while the device shows
stop.

## Open issues for other owners
- docs/SIMULATION.md (docs owner): document supervisorFollowThrough, the consent injection, the drinking model
  (DRINK_MODEL_BASIS, habitualDrinkFraction), the site_index hourly dose and the plan partial-window rule.
- Integration and backtest owner: the four truthParams sweeps now run (truthOverridesApplied returns true). Stamps change,
  because WORLDSIM_VERSION is now 1.1.0 and config.behaviour.supervisorFollowThrough is part of the hashed config.
- Workforce and scenario design (orchestrator decision): task windows open at 06:00 but the default shift starts at
  05:00, and the planner respects windows while the naive listed order does not. Options: (a) the listed order honours
  earliestStart/latestEnd; (b) the default and scenario shifts start at 06:00; (c) keep it and report it. Each option
  changes the baseline arms.
- Engine (clinical/risk owner): reminders are tied to hot work (isHotWork / sweatingSince, mirrored by worldsim's
  reminderAfterHotWorkMin). Workers idle or resting under a hot shade canopy (shade-only) get no drink reminders, and with
  the corrected drinking model they dehydrate slowly.
- state/index.ts (state owner): `connectAppState` calls `connectGovernanceToSim(simStore, governanceStore)` without
  options, which is right for the single-tab app. In a multi-tab demo, pass `{ deviceWorkerId }` (the tab's phone, or
  null on a console tab).

## Before numbers (v0.1 code, measured 2026-11-10 before any change; scenario rosters, 05:00–17:00, trace 'none')
Shares are of on-shift worker-minutes (evacuated minutes excluded); idle means no task assigned (shift − work − rest).

| scenario | policy | work | rest | idle | intake L/day mean (min–max) | dehyd ≥3 % |
|---|---|---|---|---|---|---|
| peak-day | ban_only | 56.7 % | 9.1 % | 34.1 % | 4.83 (0.00–12.75) | 6 |
| peak-day | site_index | 44.5 % | 55.1 % | 0.5 % | 5.48 (0.00–13.00) | 2 |
| peak-day | zill_env | 13.3 % | 78.2 % | 8.4 % | 9.02 (0.00–18.25) | 0 |
| peak-day | zill_full | 13.3 % | 78.2 % | 8.4 % | 9.02 (0.00–18.25) | 0 |
| humid-day | ban_only | 56.6 % | 12.2 % | 31.2 % | 4.31 | 4 |
| humid-day | site_index | 50.6 % | 43.5 % | 5.9 % | 4.50 | 3 |
| humid-day | zill_env | 15.3 % | 76.3 % | 8.3 % | 8.16 | 0 |
| humid-day | zill_full | 14.5 % | 77.2 % | 8.3 % | 7.94 | 0 |
| mild-day | ban_only | 64.6 % | 12.0 % | 23.4 % | 6.14 (0.00–10.50) | 1 |
| mild-day | site_index | 64.6 % | 12.0 % | 23.4 % | 6.14 | 1 |
| mild-day | zill_env | 38.7 % | 36.9 % | 24.3 % | 9.52 | 0 |
| mild-day | zill_full | 38.7 % | 36.9 % | 24.3 % | 9.52 (0.00–13.75) | 0 |
| saadiyat-peak | ban_only | 58.3 % | 18.8 % | 22.9 % | 6.17 | 0 |
| saadiyat-peak | site_index | 51.7 % | 46.5 % | 1.7 % | 6.29 | 0 |
| saadiyat-peak | zill_env | 13.9 % | 63.2 % | 22.9 % | 8.15 | 0 |
| saadiyat-peak | zill_full | 13.8 % | 63.2 % | 22.9 % | 8.19 | 0 |
| shade-only | ban_only | 51.0 % | 10.9 % | 38.0 % | 7.73 | 1 |
| shade-only | site_index | 49.1 % | 18.2 % | 32.7 % | 8.02 | 2 |
| shade-only | zill_env | 2.3 % | 49.9 % | 47.9 % | 7.17 | 0 |
| shade-only | zill_full | 2.3 % | 49.9 % | 47.9 % | 7.17 | 0 |

Intake detail (the fasting persona W-D2D4 is excluded; it drinks 0 L because the whole shift falls inside fasting hours):

| scenario | policy | mean | median | min–max | > 11.36 L cap | dehyd ≥3 % events | max dehyd |
|---|---|---|---|---|---|---|---|
| peak-day | ban_only | 5.15 | 4.75 | 0.75–12.75 | 1 | 6 | 4.86 % |
| peak-day | zill_full | 9.62 | 9.00 | 5.75–18.25 | 2 | 0 | 2.79 % |
| mild-day | ban_only | 6.55 | 7.00 | 2.75–10.50 | 0 | 1 | 6.42 % |
| mild-day | zill_full | 10.15 | 10.50 | 6.50–13.75 | 4 | 0 | 2.20 % |
