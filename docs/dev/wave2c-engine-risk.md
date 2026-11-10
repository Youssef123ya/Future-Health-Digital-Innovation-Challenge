# Wave 2c — engine-risk notes

Scope: water-loss limit with logged drinking, the projection hold with an engine-owned resume check, the planner's
ISO 7933 screen (plan and monitor agree), the plan cap on the device, two performance fixes, and i18n phrases.
Files: `src/engine/risk.ts`, `phs.ts` (additive option), `planner.ts`, `clinical.ts` (local day only),
`src/i18n/messages.ts`, and their tests. `types.ts` is unchanged (no new ActionId: `rotate_task` already existed).

Status: DONE. `npx tsc --noEmit` clean; full suite 30 files / 1265 tests passed.

## 1. New and changed exports and fields

### phs.ts (additive; bit-identical when the option is absent)
- `export interface PhsProjectionOptions { lossThresholdG?: number }`
- `minutesToLimit(state, input, horizonMin, opts?, projection?: PhsProjectionOptions): PhsLimitProjection`
  - `lossThresholdG` replaces the drink-allowed water-loss threshold (g of cumulative water loss). It is used only
    when it is above the edition's drink-allowed D_max (5 % BM), and never while drinking is restricted (drink = 0 now
    or earlier in the exposure: ISO 3 % / 0.6 rule unchanged). The "already reached" check and the crossing detection
    both compare the cumulative loss with it. If both limits are already reached, 'rectal' is reported (the crossing
    minute of a custom threshold is not recorded).
  - Absent, non-finite or ≤ ISO → exactly the ISO code path (tested on every fixture vector, both option sets).

### risk.ts
- `WorkerContext.resumeTask?: Task | null`: the task the worker returns to after rest. If it is absent or null, the
  engine uses the current task, then the last task seen this shift. Its location is the current one when it is the
  current task, the last one seen for the last task, else sun/shade from `Task.inSun`.
- `WorkerContext.plannedWorkMinPerHour?: number`: the day plan's min/h for the current task. It sets
  `assessment.workMinPerHour = min(own allowance, planned)` and never raises it. When it binds below 60 and > 0 with a
  task, it adds `shade_breaks` and the info driver `work_rest_planned` (environment channel).
- `WorkerEngineState` gains (old serialised states still load; missing fields mean none):
  - `projectionHold: ProjectionHold | null`
  - `lastTask: { task: Task; location: WorkerLocation } | null`
  - `resumeBout: ResumeBout | null`
  - `dwellExProjection: DwellTrack`
- `export interface ProjectionHold { since; taskId: string | null; checkedT: number | null; checkedTaskId: string | null; resumeMin: number | null; estRestMin: number | null; infeasibleNow: boolean; estT: number | null; checkKey: string | null }`
- `export interface ResumeBout { taskId: string | null; releasedT: number }`
- `export interface DwellTrack { displayed: { level; since }; pending: { level; since } | null }`
- `WorkerStepDetail` gains:
  - `water: PhsWaterDetail | null`
  - `resume: ResumeDetail | null`
  - `plannedCapApplied: boolean`
- `export interface PhsWaterDetail { sweatLossL; creditedIntakeL; netLossPctBM; thresholdL; restricted }`. For the
  worker's device only (clinical). `sweatLossL` is the ISO 7933 cumulative water loss (sweat + respiration).
  `netLossPctBM` = sweat − max(credit, 0.4 × sweat) with drinking allowed, or sweat − credit while restricted. It can
  be negative (net gain).
- `export interface ResumeDetail { held; taskId; ready; boutMin; estRestMin; infeasibleNow }`. It is null when there
  is no hold, no release this step and no countdown. At the release step it is `{ held: false, ready: true,
  estRestMin: 0, boutMin: null }`.
- `PhsRecoveryDetail.blockedBy` keeps its type. 'dehydration' now means:
  - drinking allowed: "drink and rest". The restart is possible once net loss ≤ 2 % BM.
  - drinking restricted: no restart this shift (as before). This is now true from the minute the limit is reached,
    also when the 0.6 rule set it before the 3 % mark is crossed (a horizon-0 check missed that).
- `export const ENGINE_PHS_OPTIONS: Readonly<PhsOptions>`: the model options of the engine's PHS state
  (`{ model: '7933-2023', hcMode: 'tclIteration' }`).
- `export type PhsClimate = Pick<SiteHeat, 'taC' | 'rhPct' | 'mrtC' | 'mrtHumanShadeC' | 'wind2Ms'>`
- `export interface PhsInputSpec { climate; location; task: Task | null; clothing; massKg?; heightCm?; acclimatized; fasting? }`
- `export interface PhsInputs { input: PhsInput; applicable; verified; key }`
- `export function buildPhsInput(spec: PhsInputSpec): PhsInputs`: the engine's own PHS input builder, which the
  planner reuses.
- `export function creditedIntakeL(intakes, fromT, toT, workerId?): number`: 0.8 × Σ over local clock hours of
  min(logged, FLUID.HOURLY_CAP_L).
- `export function cooledCabinTwlWm2(pHpa): number`: the COOLED_REST cabin TWL, memoised by pressure in whole Pa.
- `RISK_THRESHOLDS.hydrationCredit` and `RISK_THRESHOLDS.resume` (section 2).
- New driver ids in `RISK_DRIVER_IDS`:
  - projection channel: `phs_resume_hold`, `task_not_feasible_now`, `phs_work_bout`
  - hydration channel (worker only): `phs_water_credit`, `phs_drink_to_restart`
  - environment channel: `work_rest_planned`
- Changed texts:
  - `phs_limit_reached`, water-loss limit: "Heat-strain model: the water-loss limit is reached" with drinking allowed.
    The "for this shift" wording is kept while drinking is restricted.
  - `phs_recovery_review_required`, blocked by water with drinking allowed: "Heat-strain limit reached: drink and rest:
    the water-loss limit is not yet restored; work resumes only after … (outstanding)". The "no more heat work this
    shift" wording is kept only while drinking is restricted.
- `assessSnapshot` honours a projection hold in `partialState`: its resume check runs at once against `ctx.resumeTask`
  or `ctx.task`.

### planner.ts
- `PlannerHour.climate?: PhsClimate`. A `SiteHeat` is assignable. It enables the screen. If no hour has a complete
  climate, the warning is `'phs_screen_unavailable'` and `CrewPlan.phsScreen` is null.
- `export const PHS_SCREEN = { referenceMassKg: 75, referenceHeightCm: 175, highFromMin: 15, minBoutMin: 10, maxPasses: 4, basis }`
- `export type PlanLimitedBy = 'none' | 'niosh_acgih' | 'rule_pack' | 'phs'`
- `export interface PhsTaskHour { allowedMin; phsWorkMin: number | null; workMin; limitedBy }`
- `BlockHour` gains:
  - `startT`
  - `boutMin`: the execution layout, ceil(workMin) minutes of work at the start of the block-hour
  - `phsWorkMinPerHour: number | null`
  - `limitedBy`
- `CrewPlan.phsScreen: { reference: { massKg; heightCm; acclimatized }; passes; hours: Array<{ hour; byTask: Record<taskId, PhsTaskHour> }> } | null`
- `RestCycle.source` adds `'phs'`. The rest text reads "(ISO 7933 heat-strain screen)".
- `PlanWarningCode` adds `'phs_not_feasible'`, with hours and mitigation hints (lighter task or rotation, cooling
  garment, cooler hour), and `'phs_screen_unavailable'`.
- `PlanBlock.workMinPerHour` is now the screened rate. `BlockHour.allowedWorkMinPerHour` remains the NIOSH/ACGIH +
  rule-pack allowance. `CrewPlan.allowance` remains the pre-screen matrix.

### clinical.ts
- `export function localDayStartMs(t): number`: Asia/Dubai arithmetic. It replaces `time.startOfLocalDay` in
  `todaysCheckins`, `fluidStatus` and `episodeBefore`. Results are identical (tested over midnight edges and fractional
  ms). It throws on non-finite input, as before.

### i18n/messages.ts
- `DriverPhrases` adds `resume_check`, `task_too_hot`, `work_bout`, `drinks_counted` and `drink_to_restart`, in all 8
  languages. Non-English strings are machine-assisted drafts, as for the whole catalogue (`reviewStatus`).
- `DRIVER_PHRASE` maps the 6 new ids. `work_rest_planned` reuses the existing `work_rest` phrase.

## 2. Constants and basis

| Constant | Value | Basis |
|---|---|---|
| hydrationCredit.creditFactor | 0.8 | [ENG] self-reported intake may over-state what was drunk |
| hydrationCredit.hourlyCapL | FLUID.HOURLY_CAP_L (1.42 L) | TB MED 507 (2022) hourly cap; per local clock hour |
| hydrationCredit.isoLossFraction | 0.05 | ISO 7933:2023 Annex B drink-allowed D_max (the threshold floor) |
| hydrationCredit.netLossFraction | 0.03 | ISO 7933 drink-restricted D_max applied to net loss; ACSM 2007 |
| hydrationCredit.isoImpliedReplacement | 0.4 | 5 % sweat ≈ 3 % net ⇒ 1 − 3/5 |
| hydrationCredit.restartNetLossFraction | 0.02 | [ENG] restart deadband 1 % BM below the 3 % criterion |
| resume.minBoutMin | 10 | [ENG] shortest useful work bout; release at 15 + 10 = 25 min (ANSI/ISA-18.2 deadband) |
| resume.restStepMin / restMaxMin | 5 / 60 | [ENG] rest estimate grid and horizon ("not feasible now" beyond) |
| resume.estimateEveryMin | 15 | [ENG] performance: full estimate at most every 15 min while resting unchanged; it counts down in between (exact at constant conditions); the release check runs every projection cycle |
| PHS_SCREEN reference worker | 75 kg / 1.75 m, task clothing (else the crew's worst-CAV clothing), least-acclimatised known member (else acclimatised), drink allowed, ISO 5 % | [ENG] per brief |
| PHS_SCREEN.maxPasses | 4 | [ENG] re-placement passes with lowered allowances; always ends cut-consistent |
| cooled-cabin TWL memo | pressure rounded to whole Pa; TWL computed at the rounded pressure | [ENG] < 0.001 W/m² vs exact (tested); zone thresholds are 115/140 W/m² |

## 3. Behaviour summary

- **Water credit.** Threshold = max(5 % BM, 3 % BM + C). C counts from the shift start and needs `consent.checkins`
  (intake logs are hydration data). With no logs or no consent the result is exactly ISO 7933. Drinking restricted
  means ISO 3 % / 0.6 is unchanged. Projections assume no further intake. A logged drink that leaves the threshold
  above ISO forces a fresh projection.
- **Hold.** Minutes < 15 at the current activity (not a reached limit) puts the projection channel at stop
  (rest_shade_now, cool_down) until the resume check passes. The check runs every projection cycle and needs ≥ 25 min
  for the resume task from the current state (its metabolic rate, clothing and location). The current activity must
  also be out of the stop band.
  - The rest estimate simulates rest at the place where the worker already rests (not the sun), else at the site's
    rest area (COOLED_REST or shade).
  - `infeasibleNow` adds `task_not_feasible_now` and `rotate_task`.
  - The release drops the displayed level at once, to max(computed, other channels' own dwell track).
  - After the release, `phs_work_bout` shows "About N min of work left before the next rest", N = floor(minutes − 15),
    while the resumed task projects 15–45 min.
  - Measured in a synthetic hot case (38 °C, FR heavy work): hold → about 15–25 min cabin rest → 11-min bouts, and the
    rest estimate counts down by 5 per check. Very heavy FR work at 46 °C is infeasible (flag set). A lighter
    resumeTask releases the hold within one cycle.
- **Planner screen.** Each block-hour is simulated as: work bout first, then rest. The engine's minute convention is
  kept: the activity at minute T uses the climate at T. Each task-hour keeps the largest W' ≤ W (5-min steps) with:
  - the end-of-bout projection at the task ≥ 15;
  - the resting projection right after the bout ≥ 15;
  - no limit within the following rest until the next planned bout (or shift end) + 15 min.

  The two rest checks go beyond the brief. Without them a shade-only site stopped the device at rest because the water
  loss neared 5 %. W' < 10 means 0 (`phs_not_feasible`). The schedule is then re-placed with the lowered caps (≤ 4
  passes) and the last pass's cuts are kept.
  - Test: following the plan minute by minute through the engine at constant conditions gives 0 projection-stop
    minutes and 0 hold minutes, with ≥ 15 min at work, for three cases (cabin 38 °C, cabin 33 °C, shade 32 °C).
  - Working the unscreened allowance in the same cases gives hundreds of stop minutes.

## 4. Integration notes for the simulator (worldsim owner)

1. **Planner climate.** Build `PlannerHour` with `climate: hh` (the hourly `SiteHeat` already in `heatByHour`).
   Without it the plan carries `phs_screen_unavailable` and no screen runs.
2. **Execution layout.** To follow the plan exactly, use each block's `hours[]`: in each block-hour, work during
   `[startT, startT + boutMin min)` and rest in the rest area until `startT + wallMin min`. The current `planSchedule`
   rule ("60-min windows from the block start, work first W") differs for blocks that do not start on the hour, and
   it over-works partial windows (min(W, wall) instead of the planned work).
3. **`plannedWorkMinPerHour`.** Pass `block.workMinPerHour` while the worker is in a task block (work and rest
   minutes). Omit it in idle blocks and under non-plan policies.
4. **`resumeTask`.** Pass the worker's scheduled task:
   - the current block's task, also during its rest minutes;
   - else the next scheduled task (for example after the midday break);
   - for manual assignments, the manual task;
   - omit it otherwise (the engine falls back to the current task, then the last task seen).
5. **What replaces `WORLD_PARAMS.resumeMinMinutesToLimit` (25).** The engine-owned hold. A resting worker resumes
   when the device no longer shows stop (`assessment.level` below stop, or `detail.resume?.held === false`). Remove
   the `assessSnapshot(scheduled task) ≥ 25 min` resume rule: it is redundant, the same 25 min
   (highFromMin + resume.minBoutMin) and costs extra projections. If it is kept, it still agrees, because the snapshot
   honours the hold.
6. **Device work/rest cycles.** `ws.cycle` starts at the episode start. For plan-monitor agreement, align it with the
   plan's block-hours, or skip device cycles while following a plan block.
7. **Water-limit recovery.** `phsRecovery.blockedBy === 'dehydration'` with `detail.water.restricted === false` now
   clears once logged drinking brings the net loss to ≤ 2 % BM. Sign-off scheduling "when restartable" works
   unchanged. Intakes must be passed to the engine (`inputs.intake`) to count.
8. **Performance** (fresh Node process, tsx, 33 workers × 720 min, zill_full, default roster):
   - 2025-08-01: ≈ 1.50 s
   - 2025-11-26: ≈ 1.70 s (≈ 2.0 s before the estimate cadence)
   - in-suite worldsim perf test: best 1964 ms
   - the cooled-cabin TWL memo cut its cost to ≈ 3 ms per day
   - planDay with the screen: ≈ 20 ms per crew-day (cold process)

## 5. Deviations from the brief

- `limitedBy` uses `'rule_pack'` (not 'adosh'), because packs can be Abu Dhabi, Sharjah or Qatar. `'none'` is added
  for 60 min/h.
- Planner checks are stronger than "projection ≥ 15 at the bout end and no limit within the hour": the two
  rest-projection checks were added (see section 3), because the brief's criterion alone let the device stop at rest.
- The layout is per block-hour (one bout per task segment of a clock hour). For hour-aligned blocks this equals one
  bout per hour.
- Re-placement passes (≤ 4) move cut work to later hours. Caps only go down.
- The rest estimate uses the place where the worker already rests (shade or cabin) when resting, else `ctx.restArea`.
- The release also requires the current activity's projection to be ≥ 15 (no toggling while still at the task).
- `detail.resume` is non-null at the release step (`ready: true`).
- The rest estimate is fully recomputed at most every 15 min and counts down in between (performance).
- Drink-restricted restart block: blocked from the limit minute when the reached limit is the water-loss one (fixes
  a horizon-0 miss under the 0.6 rule).
- Extra outputs: `detail.plannedCapApplied`, `PhsWaterDetail.restricted`, hydration drivers `phs_water_credit` and
  `phs_drink_to_restart` (worker only), and the `work_rest_planned` info driver.

## 6. Open issues for other owners

- **privacy.ts.** `drivers_nonclinical` copies projection-driver *texts* verbatim and strips only value/unit when
  minutesToLimit is not released. Texts with numbers reach supervisors:
  - existing: "about N min to the … limit";
  - new: the bout countdown and the rest estimate (brief wording).

  Suggest replacing projection texts with the `driver.<id>` phrase when minutesToLimit is withheld. Also, the
  drink-restricted wording "no more heat work this shift" against "drink and rest" lets a supervisor infer a drinking
  restriction (fasting); review it.
- **worldsim.ts.** Items 1–7 in section 4. Simulated drinking (~8.5–9 L/day through `truth.drinkDecision`) is still
  the simulator's issue. The engine now credits logs, but the 11.36 L daily cap (clinical.ts) still raises the
  hydration channel.
- **Science/docs (docs/*.md not edited here).**
  - ARCHITECTURE §5/§6 should describe the water credit, the hold (resume check as the hysteresis) and the plan cap.
  - Observation: PHS rest in the COOLED_REST cabin plateaus at t_re ≈ 37.1–37.2 °C after ~60 min. With 45-min rests,
    t_re at the hour's end creeps up about 0.07 °C/h. So heavy FR work in direct sun screens to about 10–30 min/h even
    on mild days. This is a property of the engine's PHS projection (the planner now reflects it). Not tuned.
- **Planner (future).** The greedy per-hour W' (as specified) front-loads work. A smoothing pass could raise daily
  totals. Not done: it is not a protective change.
- **alerts.ts.** A hold keeps stop through the rest, so the alert stays open until the release. When the task is
  infeasible, `task_not_feasible_now` (raises) with `rotate_task` becomes the stop reason. Its text is
  supervisor-safe and passes CLINICAL_TEXT_PATTERN.
