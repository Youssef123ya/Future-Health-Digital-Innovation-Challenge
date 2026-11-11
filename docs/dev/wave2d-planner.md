# Wave 2d — planner notes

Owner: planner. Files: src/engine/planner.ts, src/engine/planner.test.ts (and src/engine/planner.*.test.ts).

Status: DONE (2026-11-11). Tests: src/engine/planner.test.ts (22) + src/engine/planner.wave2d.test.ts (17), all passing; tsc clean.

## Plan
1. Per-member acclimatisation: crew rate for acclimatised members (REL, base tier, acclimatised PHS reference);
   personal caps for members on an acclimatisation schedule (RAL, ADOSH note b exclusion, exposure ramp,
   unacclimatised PHS reference), never above the crew rate. Conservative mode and fasting leave the planner.
2. boutMin = floor (protective); invariant boutMin <= allowance x wall / 60.
3. PlanBasis 'tables' | 'monitored' (default 'tables').
4. suggestShiftStart / naive comparison for both bases.
5. Screen guarantee: convergence loop + verification pass; engine-aligned minute timeline (no PHS minute at the
   shift-start step); end-of-bout projection >= highFromMin + 1; idle/rest segments screened ('phs_rest_limit').

## Progress log
- Read wave2c-engine-risk.md §3, work-cost-drivers.md, planner.ts, planner.test.ts, the review probes.
- Reproduced: plan-follow2 (32 shade rest-only counter-examples: rest alone reaches the 5 % water-loss limit, no
  warning), plan-trace (33 C/40 %/800, shade, FR heavy: 4 passes, hold 15:28 at rest, water-loss limit 15:42),
  screen-replica (device 9w/50r/15w projects 14 where the screen's 10w/50r/15w projects 15).

## Design decisions (before any re-run)
- Device emulation in the screen: S_0 = init(input at minute 0) with no step (risk.ts steps no PHS minute at the
  shift-start step); S_T = step(S_{T-1}, input(a(T), c(T))). Projections as the device makes them: at every change
  of the activity key and every RISK_THRESHOLDS.projection.everyMin (5) minutes, counted down in between; every
  minute must keep the countdown >= highFromMin + 1 [ENG margin]; horizon 15 + 1 + 5 - 1 = 20 min suffices.
- Rest runs (after a bout, idle stretches) are checked the same way through the next bout (or the shift end).
- Convergence: place -> screen pass (cuts) -> re-place until no cap falls (caps only fall; bound 32 [ENG] as a
  safety net), then a verification pass zeroes any segment still failing (warning phs_not_feasible).
- Rest alone from the shift start failing (water loss is cumulative, work only adds strain) means no plan can be
  followed without a device stop: all work 0 + 'phs_rest_limit' (cooled rest area, logged drinking, shorter shift).
- Crew rate for acclimatised members (REL, base tier, acclimatised reference, their mass/clothing); members on an
  acclimatisation schedule (status != acclimatized, unknown included) get memberCaps: min(crew rate, RAL with own
  mass/clothing, ADOSH note b exclusion -> 0, ramp budget ceil(f x 480) - 1 min (risk.ts stops at >= budget),
  unacclimatised-reference screen). limitedBy 'crew' | 'acclimatization' | 'phs' (no history, no reason).
- Monitored basis: crew rate (acclimatised members only) = rule pack + screen; NIOSH value still reported.

## Progress log (implementation)
- planner.ts rewritten: per-member caps, PlanBasis/MONITORED_PLAN/DEVICE_REST_NOTE, device-emulating screen
  (screenModel/stepTrack/screenPass/verifyLayout/restOnlyFailure), floor bouts, phs_rest_limit. tsc clean.
- Probes after the change: plan-follow2 / own compare probe: every remaining stop is a rest-only case (phs_rest_limit,
  no work; first device stop = reported minute + 1); all other old counter-examples now 0 stops / 0 holds
  (e.g. shade FR very heavy 30 C/50 %/600: old 11 stop min from 06:14, new 0; plan-trace case converges in 7 passes).
- Member caps followed minute by minute: 0 stops / 0 holds (the crew layout would hold them).
- Finding: clinical.conservativeMode includes new_worker_14d / returning_after_absence (history), so the device puts
  nearly every member on a schedule in conservative mode (RAL + next-stricter ADOSH tier). Decision [deviation]:
  acclimatisation-schedule caps (and the crew rate of a crew with no acclimatised member) include the next-stricter
  tier — status-based, no private input; reproduces the old crew numbers for crews of new workers exactly.
- Monitored basis falls back to the tables without climate data or for clothing outside ISO 7933 (crew note).

## Resumed run (2026-11-11, second session)
- State found: planner.ts rewritten (tsc clean), planner.test.ts untouched (5 old-behaviour tests failing).
- Verified against the engine: minute-0 init without a PHS step (risk.ts ~1865), projection due at key change / 5 min /
  limit latched, key = task|location|clothing|hood|drink (climate-independent), task hold only starts while on a
  stopped task (risk.ts ~2100), hot-work count = Σ bouts (−1 when the first bout starts at minute 0), stop at
  count >= f x 480 -> member budget ceil(f x 480) - 1 is exact.
- plan-follow2 on the current tree: every shade case is rest-only (phs_rest_limit, no work); cooled cabin: 0 stops;
  days=2 cases show held=720 because the probe follows the CREW layout (ADOSH zone exclusion -> task hold); the member
  must follow memberCaps (0 in excluded hours). plan-trace case: 7 passes, 0 stops, 0 holds.
- TODO this session: unknown members via assessAcclimatization fail-safe path (ramp day 1); ramp warning without the
  minutes (history); outlook stricter tier for crews with no acclimatised member; tests (update 5, add new);
  monitored end-to-end follow (WorkerContext.planBasis exists in risk.ts).
- Code changes this session: unknown members -> assessAcclimatization unknown-history path (status unacclimatised,
  ADOSH note b, ramp 0.2 -> budget 95 min); ramp warning without minutes/fraction (history); outlook uses the
  next-stricter tier when some crew has no acclimatised member (HEAD parity for crews of new workers); naive plan
  honours task windows (work-conserving listed order, as worldsim listedOrderSchedule; principle 6); monitored rate
  per task-hour only where every device can confirm monitoring (monitoredHour: not the warm-up hour, ECTemp 30 min
  after a new shift; clothing ISO 7933 applicable AND verified; inputs within ISO 7933 validity for the reference and
  every acclimatised member at every 5-min point) -> BlockHour.monitored; per-member rest_exceeds_limit warning.
- HEAD parity (scratchpad planner2d/cmp-head.mts, HEAD tree via git archive): all-unacclimatised crews of new /
  acclimatising / returning workers -> identical blocks, allowances, outlook. Stricter only in fail-safe edge cases:
  empty crew, all-unknown crew, new-employee day 14 (HEAD: base tier there).
- Engine change seen at 02:06 (engine agent, risk.ts E2): a resting worker whose device shows stop is task-held; with
  a member at cap 0 this agrees with the plan (the hold is at rest, never during planned work).
- Probes after the changes: tables 80 cases + monitored 80 cases (2-member crew, ref follows the crew layout, newcomer
  its caps): 0 projection stops, 0 holds during planned work, 0 verification cuts; rest-limit cases warn 1 min before
  the device's first stop.

## Outcome (final)
### Exports added / changed (planner.ts)
- `type PlanBasis = 'tables' | 'monitored'`; `PlanDayInput.planBasis?`; `DayPlan.planBasis`, `DayPlan.notes`.
- `MONITORED_PLAN { note, basis[] }`, `DEVICE_REST_NOTE`.
- `CrewPlan.planBasis`, `.notes`, `.memberCaps: Record<workerId, MemberCapHour[]>`, `.memberWorkMin: Record<workerId, number>`,
  `phsScreen.verificationCuts`, `phsScreen.restLimitT`.
- `MemberCapHour { startT, hour, taskId, wallMin, workMinPerHour, boutMin, limitedBy }`, `MemberCapLimitedBy = 'crew' |
  'acclimatization' | 'phs'` (one entry per crew task block-hour, block order).
- `BlockHour.boutMin` = floor (was ceil); `BlockHour.monitored: boolean`.
- `PlanWarningCode` adds `'phs_rest_limit'`; `'rest_exceeds_limit'` can now name one member (workerIds).
- `PHS_SCREEN` adds `endMarginMin: 1`, `projectionEveryMin`; `maxPasses` 4 -> 32 (safety net).
- `CrewBinding` loses `conservative`, `stricterTier`; `HourOutlook.binding` loses `stricterTier` (no reader outside planner).
- Naive comparison plan honours task windows (work-conserving listed order, as worldsim listedOrderSchedule).

### Deviations
- Personal caps and the crew rate of a crew with no acclimatised member include the next-stricter tier (status-based):
  the device applies it to members on a schedule (conservativeMode history reasons), and HEAD parity for crews of new
  workers needs it. Stricter than HEAD only for: empty crew, all-unknown crew, new-employee day 14.
- Monitored rate per task-hour only where every device can confirm monitoring (warm-up hour, verified clothing, ISO 7933
  validity) — mirrors risk.ts phsModelOk / monitoring conditions; otherwise the device holds or directs rest.
- Unknown members: ramp day 1 (unknown-history path) instead of no ramp.
- Ramp warning text without minutes/fraction (history). Rest-only limit -> no work planned for the crew/member.
- Existing tests updated (old crew-wide RAL, conservative, unknown worker, property limit, reference worker, ceil bout,
  3 naive expectations); no safety assertion weakened (never-removes-rest property gained invariants).

### Open issues (other owners)
- Sim: execute memberCaps for members on a schedule (boutMin per block-hour, cap rate as plannedWorkMinPerHour); pass
  WorkerContext.planBasis from the crew plan; worldsim docstring "(that naive plan still ignores the windows)" and
  worldsim.test.ts comment "BlockHour.boutMin = ceil(workMin)" are outdated (assertions still hold).
- scripts/validate/work-cost-drivers.ts §4 (crew-wide binding counterfactual) is obsolete: binding.limit 'RAL' now
  means "no acclimatised member"; report memberCaps/memberWorkMin and BlockHour.monitored instead.
- risk.ts declares an identical PlanBasis "until planner.ts exports it": it can import type from planner (test asserts
  mutual assignability).
- Supervisor UI: show memberCaps/memberWorkMin, CrewPlan.notes, DayPlan.notes; binding.text wording changed.
- Shade-only hot days with long shifts: rest alone hits the ISO 7933 water-loss margin -> phs_rest_limit, no planned
  work (devices would stop resting workers anyway); levers are cooled rest, logged drinking, shorter shifts.
- All-unacclimatised crews keep the HEAD crew rate (as asked), so the crew layout can include ADOSH-excluded hours in
  which every member's cap is 0; memberWorkMin shows the real work.
