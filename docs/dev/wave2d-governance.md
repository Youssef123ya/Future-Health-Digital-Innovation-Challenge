# Wave 2d: governance (notes)

Owner: governance. Files: src/engine/privacy.ts (+test), src/engine/alerts.ts (+test), src/state/selectors.ts (+test),
the `Alert` type in src/engine/types.ts (additive), phrases appended to src/i18n/messages.ts (console phrases only).

Status: DONE (2026-11-11, run 2). Owned tests: privacy 61, alerts 94, selectors 23 (177; was 114).

## Plan
1. Supervisor driver projection: generic `driver.<id>` phrase (no value/unit) unless the id is on the site allow-list;
   pooled "not cleared" and "device-directed rest" phrases with pooled ids and bases; default-deny for unknown ids.
2. One pooled supervisor action/field policy: hydration reminders, device-only prompts and the individual water figure
   are not shown to supervisors (fasting / over-drinking / consent inference); not-cleared workers always show the
   re-assignment action.
3. Alerts: individual reasons use the same pooled phrases (no numbers, no fasting wording); relabel only on a channel at
   the alert's level; designed suppression (ANSI/ISA-18.2) with stats; escalation out of suppression.
4. Selectors: AlertItem.basis / frame / suppressed, per-basis counts, localised console labels.
5. escalatedAt disclosure documented (vital interest) and pinned by a test.

## Reproduction (before the fix)
- privacy-fasting2.mts: fasting vs non-fasting at the water-loss limit. Supervisor drivers differ ("no more heat work
  this shift" vs "drink and rest ... (rest 0 % done ...)"), alert reason "about 14 min to the water-loss limit",
  supervisor drivers carry "(321 W)" and personal-limit margins; actions differ (drink_water/electrolytes vs
  rotate_task/symptom_checkin) and waterMlPerHour 0 vs 709.76.
- relabel-dwell.mts: env stop, then a dwell-held stop with projection caution re-labels A-1 individual (bug).

## Progress log
- Run 1 (interrupted after ~40 min) left, in the tree: privacy.ts supervisor driver/action projection (POOLED_DRIVERS,
  SUPERVISOR_DRIVER_RULES, supervisorDriver(s), notClearedForHeatWork, DEVICE_ONLY_ACTIONS, supervisorActions,
  SYNC_WATER_NOT_SENT_ML, waterMlPerHour out of SUPERVISOR_VIEW, escalatedAt docs); alerts.ts reasons through
  supervisorDriver, consoleActions/reasonKey/frame on alerts, individualCauseAt relabel, designed suppression with
  stats; types.ts Alert.consoleActions/reasonKey/frame/suppression + AlertSuppression; messages.ts CONSOLE_PHRASES (8
  languages) + consolePhrase(); 4 test expectations updated. No new tests, selectors untouched.
- Run 2 (resumed 2026-11-11): verified the tree (3 owned test files pass, 114 tests); privacy-fasting2 probe: alert
  reasons now identical ("Not cleared …") for fasting and non-fasting; projected drivers differ only by the pooled
  device-directed-rest (fasting puts the worker in conservative mode) and the env picture that follows from it.
- Run 2 changes so far:
  - types.ts: AlertSuppressionReason pooled to 'action_in_force' (a 'monitored_screen' reason on a published alert
    would reveal monitored mode, i.e. wearable consent and no stricter personal mode); Alert.actions documented as the
    worker's own list (consoles use consoleActions).
  - alerts.ts: DesignedSuppressionCause ('plan_in_force' | 'monitored_screen') kept on AlertRecord.suppressionCause
    (engine state only); stats {alerts, stillSuppressed, lifted}; crew-bundling window counts from notifiedAt (a lifted
    alert was dropped from a crew alert when it was older than 5 min); PRIVATE_FACTOR_TEXT_PATTERN (fasting, consent,
    wearable) + supervisorSafeText() used for reasons (CLINICAL_TEXT_PATTERN unchanged: i18n tests rely on it and
    worker-only fasting phrases contain "Fasting").
  - selectors.ts: SelectorInput.lang (+ selectorInput 3rd arg); AlertItem basis/basisLabel/frame/frameLabel/reasonKey/
    reasonText/suppressed/suppressedLabel; console actions only; alertCounts() + SupervisorBoard.alertCounts/
    suppressedAlerts + CrewBoard.alertCounts; caseIndex skips suppressed alerts; localised location words, no-data
    notice and withheld-reason fallback (CONSOLE_PHRASES).
  - NEXT: tests (alerts suppression/relabel/patterns; privacy matrix/fasting/consent/escalatedAt; selectors), then
    suppressed-label wording in messages.ts (pooled).
  - privacy.ts: SUPERVISOR_FIXED_DIRECTION (work_rest_cycle always 'raises' for supervisors: its 'info' direction under
    monitored mode would reveal monitored mode).
  - Tests added: privacy.test.ts (+17: rule coverage, explicit site allow-list, digit matrix, known answers, pooled
    phrases, supervisor actions + order, fasting vs drinking identical projection/payload/buddy card, consent declined
    vs consented identical, engine run at the water-loss limit = the HIGH probe); alerts.test.ts (+28: designed
    suppression incl. every never-suppress class, escalation out, lift on individual basis / condition end, dwell keeps,
    bundling after lift, no "eased" after a suppressed alert, stats; relabel probe case; private-factor filter;
    private drivers give no number/word/id; fasting vs drinking identical alert + console notifications).
  - NEXT: selectors tests (AlertItem fields, counts, localisation, suppressed list, escalatedAt timing).
- Run 2, final: selectors tests added (+12: alert item known answers en/ar/hi/bn, older producers, filtered reasons,
  suppressed flag never shows its cause and is not a case, alertCounts, console phrases in every language, board
  counts + suppressed list + console language, first-aider location words + no-data notice, escalatedAt disclosure
  timing); property test strengthened (no digits outside site drivers, no device-only actions, both text filters);
  SUPERVISOR_FIELDS oracle without waterMlPerHour. Individual reason refresh test. Probes re-run: relabel-dwell keeps
  A-1 exposure; privacy-fasting2 gives the same pooled reason for both workers.

## Decisions (with reasons)
- Pooled suppression reason on published alerts ('action_in_force'); cause only in engine state.
- PRIVATE_FACTOR_TEXT_PATTERN beside CLINICAL_TEXT_PATTERN (the latter unchanged: i18n tests use it, and worker-only
  fasting phrases contain "Fasting").
- caseIndex ignores suppressed alerts (nobody was asked to acknowledge them).
- acclimatization_budget_exhausted is an individual driver (a personal allowance, not site heat; pooled reason).
- work_rest_cycle direction fixed to 'raises' for supervisors (monitored mode inference).
- Device-only actions (drink_water, electrolytes, symptom_checkin, buddy_check) never on consoles or in the payload;
  rotate_task added for every not-cleared worker; payload waterMlPerHour constant 0 (legacy key).

## Open issues for other owners
- docs: ARCHITECTURE §7 escalation/disclosure-timing paragraph (wording in the final report); §6 designed suppression
  and close "Open: an individual projection reason can contain the projected minutes"; §3 payload water key constant;
  GOVERNANCE §13 items 16 and 18 closed.
- sim/metrics: carry AlertStats.designedSuppression into RunAlertSummary and the cohort tables; count alarms as notified
  alerts (exclude still-suppressed ones).
- engine: RiskAssessment.confidence carries the wearable-signal penalty (consented band only) into the sync payload: a
  weak consent side channel; suggest a console confidence without the physiology penalty.
- UI: pass uiStore.language to selectorInput; render AlertItem labels; never render Alert.actions on consoles.
- governance review: the first aider sees the worker's actions (minus confidential), so drink_water absent at a stop can
  reveal fasting to the responder (vital-interest role); accepted for now.
