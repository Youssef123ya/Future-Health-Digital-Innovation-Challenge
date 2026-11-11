# Wave 2d — engine notes

Owner: engine. Files: src/engine/risk.ts, risk.test.ts, clinical.ts, clinical.test.ts, FluidIntake in
src/engine/types.ts (additive), src/i18n/messages.ts (5 phrases; its tests unchanged). limits.ts / phs.ts: not changed.

Status: DONE (2026-11-11, two sessions; the first was interrupted after ~40 min, its edits were reviewed and kept).
`npx tsc --noEmit` clean. My files: risk.test.ts 98/98, clinical.test.ts 72/72, i18n.test.ts 66/66. Full suite:
1392/1393 — the one failure is worldsim.test.ts `heldByRule > 0`, an expected consequence of task 2 (see open issues).

## 1. Exports and fields (new or changed)

### risk.ts
- `export type { PlanBasis }` — re-export of planner.ts `PlanBasis = 'tables' | 'monitored'` (type-only import; no
  runtime cycle).
- `WorkerContext.planBasis?: PlanBasis` (absent → 'tables', bit-identical to the engine before wave 2d).
- `export type MonitoringFallbackReason = 'consent' | 'data' | 'model' | 'status'`
- `export interface EnvironmentDetail { basis: PlanBasis; monitored: boolean; enforced: boolean; workMinPerHour: number | null; fallbackReason: MonitoringFallbackReason | null }`
  → `WorkerStepDetail.environment` (always present). `enforced` = the table work/rest cycle limits work minutes.
- `export type TaskHoldChannel = 'regulation' | 'environment'`
- `export type TaskHoldCause = 'midday_break' | 'heat_zone' | 'wbgt_stop' | 'exposure_limit' | 'exposure_budget'`
- `export interface TaskHold { since; taskId: string | null; heldBy: TaskHoldChannel[]; causes: TaskHoldCause[]; checkedT: number | null; checkedTaskId: string | null; nextCheckT: number | null; infeasible: boolean }`
- `export type ResumeHolder = 'projection' | TaskHoldChannel`
- `ResumeDetail` gains `heldBy: ResumeHolder[]` and `nextCheckT: number | null` (the later of the active holds' next
  checks; null = no release this shift). `held` = heldBy not empty. `infeasibleNow` also when the budget is used up.
- `export interface DrinkReminderDetail { exposed: boolean; exposure: HeatExposure; reminder: DrinkReminder; nextReminderAtMs: number | null; locationWbgtEffC: number }`
  → `WorkerStepDetail.drink` (always present). The simulator's reminder is `reminder === 'drink'`.
- `PhsWaterDetail` gains `extended: boolean` (credit above ISO 5 %) and `capped: boolean` (at the 7.5 % ceiling).
- `WorkerEngineState` gains `taskHold: TaskHold | null`, `monitorValidT: number | null`, `lastHotWorkT: number | null`,
  `dwellExTaskHold: DwellTrack` (older serialised states load: missing = none / the fused track).
- `RISK_THRESHOLDS.hydrationCredit` gains `maxLossFraction` (0.075) and `maxLogDelayMin` (15); `.resume` gains
  `outOfScopeBasis`; new `.taskHold { checkEveryStep, basis }` and `.monitoring { recentWindowMin: 5, minValidInWindow: 4, basis }`.
- `creditedIntakeL(intakes, fromT, toT, workerId?)`: unchanged signature; only drinks with |loggedAt − t| ≤ 15 min.
- `RISK_DRIVER_IDS` += `wbgt_screen_monitored`, `monitoring_fallback_tables`, `resume_hold_environment` (environment),
  `resume_hold_regulation` (regulation), `phs_no_drink_no_restart` (hydration, worker only).

### clinical.ts
- `FLUID.EXPOSED_REST_WBGT_C = (78 − 32) × 5/9` (25.56 °C), `FLUID.REMINDER_AFTER_HOT_WORK_MIN = 30`.
- `export type HeatExposure = 'hot_work' | 'heat_rest' | null`; `export interface DrinkExposureInput { hotWorkNow; minutesSinceHotWork: number | null; restingOutsideCooled; wbgtC }`;
  `export function drinkReminderExposure(input: DrinkExposureInput): HeatExposure` (pure).
- `export type DrinkReminder = 'drink' | 'shade' | null`.
- `FluidContext.exposed?: boolean`, `HydrationChannelInput.exposed?: boolean` (absent = exposed: old behaviour).
- `FluidStatus` gains `exposed: boolean`, `reminder: DrinkReminder`; `sendDrinkReminders` now also needs `exposed`.

### types.ts
- `FluidIntake.loggedAt?: number` (absent = logged at t in creditedIntakeL; the worker engine stamps a log it receives
  without one with the receiving step).

### i18n/messages.ts
- `DriverPhrases` += `rule_hold`, `heat_hold`, `monitored`, `monitor_off`, `fasting_no_restart` (8 languages);
  `DRIVER_PHRASE` maps the 5 new driver ids.

## 2. Driver ids and texts (for the governance agent; supervisor projection is theirs)
| id | channel | direction | text |
|---|---|---|---|
| wbgt_screen_monitored | environment | raises | WBGT is above the table limit: your own heat-strain projection (ISO 7933) and wearable monitoring are in use |
| work_rest_cycle (monitored) | environment | info | Work/rest guide: about N min work per hour, rest {in the air-conditioned rest area / in shade} the remainder |
| monitoring_fallback_tables | environment | raises (info if the table level ≤ caution) | status: "Monitored mode does not apply to you now (personal heat plan): …"; consent: "Wearable monitoring is off (consent, wearable or setting): …"; model: "The heat-strain model does not cover this work or clothing: …"; data: "Wearable data is not valid (too few good minutes): …" — each ends "the table work/rest limits apply again". DEVICE ONLY (reveals consent/health status). |
| resume_hold_regulation | regulation | raises | "Rest before going back to this task: the heat-zone rules do not allow it now" / "… WBGT is above the stop-work limit" / "Midday work ban: rest until it ends at HH:MM" |
| resume_hold_environment | environment | raises | Rest before going back to this task: the heat-exposure limit does not allow it now |
| acclimatization_budget_exhausted (hold) | environment | raises | re-used from the task to resume |
| phs_no_drink_no_restart | hydration | info | Not drinking (fasting): the water-loss allowance without drinking is used up and rest does not restore it, so no more heat work this shift (worker only) |
| phs_limit_reached | projection | raises | identical fasting / not fasting: "Heat-strain model: the water-loss limit is reached" or "… the body-heat limit for this shift is reached" |
| phs_recovery_review_required | projection | raises | identical fasting / not fasting: "Heat-strain limit reached: work resumes only after 30 min rest in a cooled area (45 min in shade), a clear check-in and sign-off by a first aider or supervisor (outstanding …; the water-loss limit is not yet restored)"; basis R.basis for both |
| phs_water_credit | hydration | info | "Logged drinks counted: water-loss limit X L (net loss Y % of body mass)[: add an electrolyte drink | : at the 7.5 % ceiling, add an electrolyte drink]" (worker only) |

## 3. Constants and basis
| Constant | Value | Tag / basis |
|---|---|---|
| monitoring.minValidInWindow / recentWindowMin | 4 of 5 min | [ENG] recent-data validity; plus the physiology channel itself valid (30-min warm-up, ≥ 10 of 15) |
| hydrationCredit.maxLossFraction | 0.075 | ISO 7933:2004 D_max50 [ASSUMPTION, protective: sodium losses and 8-h D_max validity not covered beyond it] |
| hydrationCredit.maxLogDelayMin | 15 (either side) | [ENG] no back-dated or pre-logged credit |
| FLUID.EXPOSED_REST_WBGT_C | 25.56 °C | TB MED 507 (2022) heat category 1 lower bound, 78 °F, exact conversion |
| FLUID.REMINDER_AFTER_HOT_WORK_MIN | 30 | [ENG] the simulator's former rule ("hot work within the last 30 min") |
| taskHold.checkEveryStep | true | [ENG] deterministic stops; release adds the ISO 7933 resume check (≥ 25 min) |

## 4. Behaviour summary
- **Monitored mode.** Valid for a worker at minute t only if: planBasis 'monitored'; acclimatisation status
  'acclimatized' and not conservative; consent.wearable ∧ hasWearable ∧ !physioDisabled; physiology channel valid and
  ≥ 4 of the last 5 minutes SQI-valid (one record per minute, last wins); ISO 7933 applicable, verified clothing values
  and inputs within the validity range for the current activity. While valid: table result computed and shown;
  above the table limit the environment level is capped at caution with `wbgt_screen_monitored` (raises), the cycle is
  an info guide, no `shade_breaks` from it, and `workMinPerHour` is not limited by the table (regulation, plan and
  projection still apply). The acclimatisation budget stop and all other channels are unchanged. A lapse after a valid
  minute this shift restores the table level in the same step with `monitoring_fallback_tables`.
- **Task hold.** E1: the current task drives a regulation/environment stop. E2: a resting worker whose device shows
  stop (previous displayed level ≥ stop in this shift, or an active projection hold) has a resume task stopped by those
  channels (the former worldsim resumeTaskAllowed). While resting the held channels stay at stop (resume_hold_* drivers,
  rest_shade_now, rotate_task / midday_break / acclimatization_plan). Release (resting): the resume task at the current
  conditions is free of those stops, the resting activity is too, and its ISO 7933 resume check passes (≥ 25 min) → the
  level drops at once to max(computed, the other channels' own dwell track) and the bout countdown starts; a failing
  check hands over to a projection hold (rest estimate, infeasible flag); a resume task outside the ISO 7933 scope ends
  the hold without the shortcut (normal dwell). At a task the hold follows that task's live stops and forces nothing;
  at a task free of them it ends without the shortcut (the normal dwell is the anti-chatter deadband). Midday break:
  nextCheckT = break end; budget used up: nextCheckT null, infeasibleNow, no release this shift for hot work.
- **Dwell tracks.** dwellExProjection (no projection channel) and dwellExTaskHold (all channels) both use the live
  regulation/environment levels, with task-held channels capped at HIGH; a projection release drops the fused track to
  dwellExProjection and also short-circuits dwellExTaskHold; a task release drops to dwellExTaskHold.
- **Drink reminders.** Exposed = hot work now or within 30 min after it, or resting/idle (no task) outside
  `indoor_cool` at WBGT_eff (location WBGT, resting clothing, data margin) ≥ 25.56 °C. Same cadence and caps.
  Fasting: no drink reminder, reminder 'shade' while exposed (existing `fasting_no_drink_reminders` driver).
- **Water credit.** Threshold min(7.5 %, max(5 %, 3 % + credit)) of body mass; electrolytes action and text while above
  5 %; a drink logged in a step counts from the next step for the limit check, hold releases and the reviewed restart
  (the projection shown already uses it); a limit reached before that drink starts the reviewed recovery.
- **Out-of-scope PHS paths.** resumePasses returns `unchecked` (never ok) for an out-of-scope target; the projection
  hold then ends without the release shortcut (dwell); a current activity out of scope ends the hold the same way.

## 5. Tests added
- risk.test.ts: monitored mode (6: constants; cap + info guide + channels unchanged; warm-up; 6 lapse causes in the
  same step; dropout falls back at the 2nd missing minute and recovers at the 4th valid one, SQI-invalid minutes;
  conservative / unacclimatised / vapour barrier never monitored), recorded-fixture bit identity (planBasis absent and
  'tables', 14 runs each, sha256 of every step assessment), task hold (10: constants; ADOSH zone exclusion + release +
  no flapping; table stop; midday break release at 15:00; E2 projection + midday; handover to a projection hold;
  rotation ends the hold with the dwell; budget no release; new shift and old states), out-of-scope paths (3), drink
  reminders (3), privacy wording fasting vs not (1), water credit (7: constants; ceiling + electrolytes; ±15 min log
  window; receipt stamping; drink never skips the review; drink never releases a projection hold in its step).
- clinical.test.ts: drinkReminderExposure known answers, fluidStatus exposed/absent/cap, fasting 'shade', channel pass-through (5).
- 4 existing tests updated by the first session (expectations of old behaviour, no safety assertion weakened): budget
  rest now held at stop; threshold formula with the ceiling; drink-restricted wording moved to the hydration channel;
  "blocked while net > 2 %" allows the drink-logging step (the drink counts from the next step).

## 6. Performance (fresh tsx process, 33 workers × 720 min, zill_full)
- Before any wave-2d change: 1620 / 1280 / 1259 ms (2025-08-01).
- After: 2025-08-01 1888 / 1507 / 1445 ms; 2025-11-26 1889 / 1488 / 1418 ms (first run ≤ 2.5 s). In-suite worldsim
  perf test: best 1183 ms (30 workers). The simulator still runs its own resumeTaskAllowed snapshot; deleting it saves time.

## 7. Deviations from the brief
- Monitoring "data" validity also requires the physiology channel itself to be valid (30-min ECTemp warm-up, ≥ 10 of
  15 valid minutes), not only 4 of the last 5 minutes: physiological monitoring cannot enforce before it is valid
  (protective). Monitored mode therefore starts 30 min into a shift.
- loggedAt: creditedIntakeL treats absent loggedAt as logged at t (as briefed), but the worker engine stamps a log it
  receives without loggedAt with the receiving step (protective: closes back-dating by callers that omit it). The
  15-min window is two-sided (a drink logged > 15 min ahead of its stated time is not credited either).
- Task hold extended beyond "current task drives the stop" with E2 (resting at stop, resume task stopped) so the
  worldsim check can be deleted without losing coverage; the release also needs the projection resume check (no
  flapping through the projection channel); at a task the hold ends without the dwell shortcut (anti-chatter).
- Task-held channels count at most HIGH in the auxiliary dwell tracks, so a release right after a live stop at the
  task de-escalates to HIGH and dwells from there (protective; not specified).
- Individual numbers stay in three worker-device projection texts (phs_minutes_to_limit, phs_resume_hold,
  phs_work_bout, and "rest N % done") as well as in value/unit: they appear in the recorded bit-identity fixture and
  supervisors receive the pooled / phrase substitutes from privacy.ts (governance). Texts are identical for fasting and
  other workers.
- PlanBasis: imported (type only) from planner.ts and re-exported by risk.ts.

## 8. Open issues for other owners
- worldsim.test.ts (integration): 'a rest episode ends when … no regulation/environment rule stops the resume task'
  now fails on `heldByRule > 0` (0 by design: the engine holds stop itself, so the simulator copy never fires). Delete
  resumeTaskAllowed and turn that count into an expectation of 0 (or drop it). Rest episodes asked only by a rest
  action below stop (e.g. urine) are not covered by E2; the simulator may keep the check for those or accept them.
- governance (privacy.ts / alerts.ts): driver ids above; `monitoring_fallback_tables` and `wbgt_screen_monitored` must
  not show the reason; the 'electrolytes' action now also appears with extended water credit (a hydration prompt:
  device only); a monitored worker's environment level can differ from crewmates' (caution vs stop) — pool it.
- UI / simulator: `detail.environment.enforced` says whether the table cycle limits work; `detail.resume.heldBy` and
  `nextCheckT` give the holds; `detail.drink.reminder` drives reminders (worldsim 1.3.0 already uses it).
- Resume target location: a resume task that is not the current or last task is placed by Task.inSun (sun/shade); an
  indoor cooled task given only as resumeTask cannot release a budget hold until the worker starts it (then the normal
  dwell applies). A Task 'indoor' attribute would fix this.
