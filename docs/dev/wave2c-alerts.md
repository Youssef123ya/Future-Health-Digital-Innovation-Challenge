# Wave 2c: alerts (notes)

Owner: alerts. Scope: src/engine/alerts.ts (+test), the `Alert` interface in src/engine/types.ts,
src/state/selectors.ts `caseIndex` (+test).

## Status
- [x] 1 `Alert.basis` ('exposure' | 'individual') and a site/crew-framed exposure reason
- [x] 2 `escalatedAt` / `acks` on the published alert
- [x] 3 `AlertStats.byBasis`
- [x] 4 copy-on-write state (cloneJson removed)
- [x] 5 `selectors.caseIndex` uses `escalatedAt` / `acks`, with the old inference kept as a fallback
- [x] 6 tests (alerts.test.ts 38 → 58, selectors.test.ts 10 → 13)

## New fields and their meaning

### types.ts
- `type AlertBasis = 'exposure' | 'individual'`.
- `Alert.basis?: AlertBasis`, `Alert.acks?: Array<{ role; t }>` and `Alert.escalatedAt?: number` are optional on
  `Alert`, so other producers and fixtures (e.g. sim/metrics.test.ts) still type-check. Consumers should treat a
  missing basis as 'individual'.
- `EngineAlert` (alerts.ts) makes `basis` and `acks` required. Every alert this engine publishes has them; `acks` is
  `[]` until the first acknowledgement.

### basis
- 'individual' when any of these holds:
  - the case is clinical (symptoms/physiology at the level, hydration at ≥ stop, emergency);
  - no channel explains the level (protective: unknown is never shown as a site condition);
  - any channel at the alert level is outside {environment, regulation};
  - a raising driver in `INDIVIDUAL_DRIVER_IDS` (clinical_latch, no_hot_work_today, phs_limit_reached,
    phs_recovery_review_required) sits on a channel at the level;
  - the new alert carries a clinical latch from the alert it supersedes.
- 'exposure' otherwise: only the environment and regulation channels drive the level, i.e. shared site conditions and
  the task, clothing and regulation rules.
- Only channels AT the alert level count, because they are what raises the assessment to that level. Example:
  environment stop + projection high gives an exposure stop.
- Sticky individual [ENG, protective]: an exposure alert that stays open at the same level is re-labelled individual
  when an individual cause joins at that level. Its reason is replaced by the individual reason and it is published in
  `updated`. No notification is sent and routing does not change. An open alert never goes back to exposure; the next
  alert (escalation or de-escalation) is classified afresh.
- Crew alerts are always exposure. Bundling eligibility is `basis === 'exposure' && level ∈ {high, stop}`, the same
  rule as before plus the defensive driver-id check. If an alert is re-labelled before the end of its batch, its
  supervisor message is still sent, individually, so it is never lost.
- `assessmentBasis(a: RiskAssessment): AlertBasis` (exported) gives the basis an alert raised from `a` would have
  (without a carried latch).
- `Notification.basis` is the alert's basis when the notification was sent.

### Exposure reason (`alert.reason`, the supervisor-facing text)
- Site heat (environment frame), with the work minutes floored as in the action phrase:
  - "Site heat: too hot for this work now" at ≥ stop or 0 min/h;
  - "Site heat: work/rest W/R in effect" when 0 < W < 60;
  - "Site heat: heat controls in effect" at high with W ≥ 60;
  - "Site heat: close to the limit for this work" at caution.
- Site rule (regulation frame): "Site rule: <regulation driver text>", e.g. "Site rule: Midday work ban in force
  (…)". Without a usable driver: "Site rule: a heat-work regulation applies now".
- The risk engine's most important usable exposure driver picks the frame. `reasonKey` stays `driver.<id>`, or
  `reason.heat_exposure` / `reason.regulation` when no usable driver exists.
- The exposure reason is refreshed together with `workMinPerHour` whenever the open alert's actions change, so its
  numbers match the action phrase.
- Crew alerts: "<site heat with the crew's strictest work/rest | first member's site rule> (N workers)". The count
  and the strictest work/rest are updated when a member joins. `AlertRecord.exposureFrame` stores the frame.
- Individual alerts keep their earlier non-clinical reason unchanged: a projection driver text, a WBGT text for
  mixed cases, or "Personal check flagged on the worker's device" / "First-aid check needed" for clinical cases. The
  same wording is used for every personal channel, so neither the reason nor the basis tells them apart.

### escalatedAt (durable, set once)
- Set at the first of:
  - a stop-acknowledgement timeout (worker or crew alert);
  - an emergency (raised: first aider + occupational health are routed at once; or its re-notification);
  - routing to the first aider or occupational health (`ESCALATION_ROUTING_ROLES`). This covers a symptom- or
    physiology-driven stop at raise.
- Kept when the status goes back from 'escalated' to 'acknowledged', and after resolution.
- NOT set by: a high reminder, the offline SMS, supervisor routing or crew bundling, or any acknowledgement.
- A first-aider hand-over (a first aider acknowledging without engine routing) is visible in `acks`.
- Semantic change for the privacy owner: a clinical stop is now "escalated" from the moment it is raised, because the
  first aider is routed at raise. caseIndex therefore releases reported symptoms to the paged first aider at once
  (vital interest), and occupational health sees the case (clinical detail only with consent). Before, this happened
  only after the 2-min stop timeout or a first-aider-first acknowledgement.

### acks
- Every permitted acknowledgement, in order, counted or not, with role and time only. For example, the worker's own
  acknowledgement of an emergency is recorded but not counted.
- `ack` still keeps the first counted acknowledgement.
- Late acknowledgements of resolved alerts are recorded. Refused acknowledgements (role not permitted) are not.
- `AlertRecord.acks` mirrors it (worldsim reads `rec.acks`).

### AlertStats.byBasis
- `byBasis: Record<AlertBasis, BasisCounts>` with `BasisCounts = { alerts, notifications, notificationsRequiringAck,
  unacknowledged }`.
- Alerts count by the basis of their latest version. Notifications count by the basis they carried when sent; if
  that is missing, by their alert's basis.
- A missing basis counts as 'individual', so the exposure share is never overstated.
- The existing fields are unchanged, and `alerts`, `notifications` and `unacknowledged` equal the sums of the two
  buckets.

## Routing table: unchanged
Basis never enters a routing decision. Every notification target, channel, `requiresAck` flag and timer is as before:
- worker always;
- supervisor at ≥ high (individual, or crew-bundled for exposure alerts at high or stop) and every stop/emergency;
- buddy on a stop-acknowledgement timeout and every emergency;
- first aider on symptom/physiology-driven (or symptomatic hydration) stops and every emergency;
- occupational health on every emergency;
- SMS fallback when offline;
- timers: stop → supervisor + buddy; emergency → voice re-notification + siren; high → reminder.

Tests: 'routing does not depend on the basis' compares the full routing shape (role, id, channel, requiresAck, kind)
of exposure vs projection-driven alerts at caution, high and stop, for workers with and without a buddy, at raise and
after the timers. The only routing-adjacent change is protective: an alert re-labelled within its own batch is
notified to the supervisor individually instead of possibly being bundled.

## How the UI should present exposure vs individual alerts
- Exposure: show it as a site or crew condition, not a personal warning.
  - Supervisor board: group by crew/site, e.g. a "Site condition" chip, the work/rest in effect, and one
    acknowledgement for the crew alert. Worker device: "Site heat" framing; the same actions apply to everyone on that
    task.
  - Exposure alerts are the candidates for a future site-level notice (wave2b open issue), but routing stays as it is
    until that is decided.
- Individual: show it as being about this worker. Use a person-level card with the name, level, actions and the
  non-clinical reason. Never show or guess which personal channel is involved. The basis is the only signal, and it
  does not say which one.
- Missing basis (older producers): render as individual.
- `AlertItem` (selectors.ts) does not yet carry `basis` (outside this role's scope): see open issues.
- Localisation: `reasonKey` stays the driver key. The UI can compose the localised frame label ("Site heat" / "Site
  rule") from the basis plus `reasonKey`, and take the work/rest numbers from the action phrase or `workMinPerHour`.

## Copy-on-write (performance)
- `cloneJson` is removed. `begin()` shallow-copies the top-level state.
  - `alertsW` / `workersW` / `crewOpenW` / `suppressedW` copy a container once per call.
  - `recW(id)` / `trackW(workerId)` copy a record or track (deeply, since they are small) on its first write in the
    call. Unchanged records are shared with the input.
  - Published alerts are fresh deep copies (`copyAlert`), so callers may mutate them freely.
- Refused or no-op `acknowledge` / `resolve` return the input state object unchanged.
- Measured with the scratch bench: synthetic 33 workers × 720 min with acks, alert engine only:
  - original: 144–152 ms;
  - copy-on-write: 34–40 ms (≈ 4×).
- worldsim, 30 workers × 720 min zill_full, A/B with alternating fresh processes, 3 runs each (noisy hybrid CPU; the
  third run in each process is always slow):
  - run 1: 1827–1875 ms (orig) vs 1560–1616 ms (new);
  - run 2: 2123–2433 ms vs 1302–1503 ms;
  - best: 1827 vs 1302 ms (≈ −15 to −35 % of a simulated Zill day).
  - The in-suite perf test printed a best of 2193 ms, against 2.80–3.19 s reported in wave 2b.
- Tests:
  - a scripted sequence and 3 random streams run every processAssessments / acknowledge / resolve / tick call on a
    deep-frozen input, so any in-place write throws, and check that the input is JSON-identical afterwards;
  - the same calls run on JSON clones (the old semantics), and the results must be byte-identical;
  - a mutation check on a scratch copy confirmed that the frozen test catches missed copies (crewOpen delete, prune of
    `told`, suppressed push, joinCrew, timers, alerts map, acknowledge).

## Deviations from the brief (with reasons)
- `basis`, `acks` and `escalatedAt` are optional on `Alert` and required only on `EngineAlert`. A required field
  would break other producers and fixtures (sim/metrics.test.ts builds `Alert` objects).
- Added the sticky-individual re-label (exposure → individual in place, never back while open). Without it, an open
  exposure alert would keep a site-condition label after the PHS projection joins it at the same level, e.g. env high
  + projection high, or a midday-ban stop that continues on the projection.
- The exposure reason is refreshed whenever the open alert's actions (and `workMinPerHour`) are refreshed, so its
  work/rest numbers match the action phrase.
- The crew alert shows the strictest member work/rest. On join, the crew's `workMinPerHour` becomes the minimum
  including the joining member (protective). Before, it stayed at the creation-time value.
- A refused or no-op `acknowledge` / `resolve` returns the input state object instead of a deep clone; nothing is
  mutated.
- `escalatedAt` is also set on crew alerts at the crew stop-acknowledgement timeout (same event type).

## Open issues for other owners
- state/selectors (`alertItem`): add `basis` to `AlertItem` (privacy-safe) so supervisor and first-aider views can
  present exposure vs individual. The first-aider candidate pre-selection (~L548) still uses `escalatedTo` routing;
  it could use `escalatedAt`.
- privacy: confirm the semantic change that a symptom/physiology-driven stop is escalated from raise (the first aider
  is routed at once). The first aider then sees reported symptoms at once, and OH sees the case (clinical detail only
  with consent).
- sim/metrics (`RunAlertSummary` / `ackSummary`): carry `alertStats.byBasis` through to the cohort tables, so the
  burden can be reported as exposure vs individual (specificity analysis, site-notice decision).
- i18n: localise the exposure frame labels ("Site heat", "Site rule") and the `reason.heat_exposure` /
  `reason.regulation` keys.
- orchestrator (docs/dev/engine-api-*.md): list the new exports (below).

## Exports added or changed
- types.ts:
  - `export type AlertBasis = 'exposure' | 'individual'`;
  - `Alert.basis?: AlertBasis`, `Alert.acks?: Array<{ role: Role; t: number }>`, `Alert.escalatedAt?: number`.
- alerts.ts:
  - `export const EXPOSURE_CHANNELS: readonly ChannelId[]` (environment, regulation);
  - `export const INDIVIDUAL_CHANNELS: readonly ChannelId[]` (projection, physiology, symptoms, hydration);
  - `export const INDIVIDUAL_DRIVER_IDS: readonly string[]`;
  - `export const ESCALATION_ROUTING_ROLES: readonly Role[]` (first_aider, occ_health);
  - `BUNDLE_CHANNELS` (now the same array as `EXPOSURE_CHANNELS`, same value);
  - `export type ExposureFrame = 'heat' | 'rule'`;
  - `export interface BasisCounts { alerts; notifications; notificationsRequiringAck; unacknowledged }`;
  - `Notification.basis: AlertBasis` (new, required);
  - `EngineAlert { basis: AlertBasis; acks: Array<{ role; t }>; memberIds? }`;
  - `AlertRecord.exposureFrame?: ExposureFrame`;
  - `AlertStats.byBasis: Record<AlertBasis, BasisCounts>`;
  - `export function assessmentBasis(a: RiskAssessment): AlertBasis`.
- selectors.ts: `caseIndex` / `caseStatus` signatures unchanged; escalation now from `escalatedAt` / `acks` (private
  `isEscalated`, legacy fallback).
