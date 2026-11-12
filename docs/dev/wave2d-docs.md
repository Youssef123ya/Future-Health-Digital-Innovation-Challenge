# Wave 2d docs role: notes (resume file)

Role: documentation owner (key 'docs'). Scope: docs/*.md except README.md, docs/dev (this file only),
docs/research, and the generated blocks of docs/VALIDATION-COHORT.md.

Started: 2026-11-11 (second run; the first run changed no file).

## Status per document

| Document | Status | Notes |
|---|---|---|
| ARCHITECTURE.md | done (first pass) | §1.5 bullet, §2 supervisor row, §4 module lines, §5 env row (budget, monitored), water-loss 7.5 % + logging rule, task hold block, day plan rewrite (per-member, screen 16 min, floor, phs_rest_limit, tests), plan basis block (rationale, conditions, fallback), conservative mode, console actions, drink reminders by exposure; §6 individual drivers, reasons, designed suppression, filters; §7 supervisor views + escalation timing; §8 five policies; §10 payload water 0. Cross-refs to fulfil: GOVERNANCE §10.2 (monitored sign-off), GOVERNANCE §2.2 (schedule disclosure), LIMITATIONS C-10 (drink reminders/over-drinking), VALIDATION-COHORT §8 (Al Ain phs_rest_limit), GOVERNANCE §13 (first-aider drink_water hint) |
| SCIENCE.md | todo | |
| GOVERNANCE.md | done (first pass) | generated tables regenerated with the Appendix A script (matrix G3 7 fields, grants G3/G5, fields waterMlPerHour, consent checkins retention, payload: console actions, water 0, 207 bytes) — aggregate blocks unchanged; status/§0 (no individual numbers, wearable decline, open items 19–21); §1 p1 + p4; §2.2 acclimatisation-schedule disclosure (ADOSH CoP §3.2(b)(i), TG Table 1 note b) + what stays on device; §2.3 check-in retention 30 d (2c code, doc was stale); §2.4 payload text; §3.1 leak filters; §3.4 supervisors, pooled phrases/allow-list, inference, monitored mode vs consent, designed suppression, escalated-from-raise accepted; §5.1 device-directed rest + wearable; C13; §10.2 monitored-mode OH sign-off [D] (not built); §10.3; §10.5; §10.6; §11 R2 R3 R8; §13 items 5/16/17/18 closed, 19–21 new; appendix date |
| SIMULATION.md | done (first pass) | §2.1 drinking row; §3 version table (1.3.0/1.4.0/truth 1.2.0); perf 1,037 s; §3.1 task windows (symmetric, baseline change), member layouts, statutory break idle; §3.2 engine-owned resume, plan rate/basis, cycle hysteresis; §3.3 calibration (DRINK_CALIBRATION), reminders while idle, re-follow 20 min, logging fidelity, v0.3 water, open over-drinking; §3.4 shadow; §4 zill_monitored + shadow arm + metrics 1.2.0 suppression; §5 versions, measures, new variants; §6. Cross-refs: LIMITATIONS S-08 + C-10 (over-drinking), VALIDATION-COHORT §3.9 (new section) |
| VALIDATION-COHORT.md (narrative) | done (first pass) | headline v0.3; §1 timing; §2.2 arms (+monitored, symmetric windows); §2.3 calibrated parameter; §2.4 alarm/advisory under suppression, suppressed advisory, supervisor acks; §3.7 rewritten (v0.3 numbers, monitored trade-off, over-drinking, Al Ain); §3.8 items 1/3/5 annotated; new §3.9 v0.2→v0.3 (world vs Zill); §4, §5 narrative v0.3; §6 fairness (Urdu 0 min, work clothes 49); §7; §8 open v0.3 + resolved in v0.3. Generated blocks untouched. Cross-refs: GOVERNANCE §5 and §10.2 (pay/assignment/evaluation) |
| LIMITATIONS.md | todo | |
| PILOT.md | todo | |

## Facts checked against code (source of truth)

(filled in as I go)

## Open issues for the orchestrator

(filled in as I go)
