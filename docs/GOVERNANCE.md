# Zill — Governance: data protection, responsible AI and worker rights

This document explains how Zill handles workers' data, which uses it refuses, how those refusals are enforced, and which
laws and standards the design answers to. It is written for the Challenge judges (criterion 4, "Responsible AI, safety,
and data governance"), for reviewers at the Department of Health – Abu Dhabi (DoH) and the Abu Dhabi Public Health Centre
(ADPHC), and for employers considering a deployment.

**Status:** working prototype, 10 November 2026. Sections 2–7 describe controls that run in code today
(`src/engine/privacy.ts`, 38 passing tests). Contract clauses, processes and open decisions are marked as such. This
document is not legal advice. The legal mapping in §8 needs confirmation by UAE counsel before a pilot.

**How to read the tags**

| Tag | Meaning |
|---|---|
| **[P]** | Verified against the primary document (standard, law, regulator text) in our research notes. |
| **[S]** | Verified only from a named secondary source (law firm, press, aggregator); the primary was unreachable. |
| **[D]** | Our design proposal or derivation. Not a legal requirement. |
| **[ENG]** | An engineering choice that no standard fixes, resolved in the worker-protective direction. |
| **UNVERIFIED** | Could not be confirmed. Do not present it as fact. |
| **Code** | Enforced in `src/engine/privacy.ts` and covered by tests. |
| **Contract** | To be written into the employer agreement. |
| **Process** | An organisational control: people, training, review. |

Source keys (S24, S61, S73 …) refer to the reference list in `docs/research/context_and_commercial.md` §8. Tables marked
*generated* were produced from the code by the script in Appendix A, not typed by hand.

---

## 0. Summary

- **Core safety alerting uses no health data and needs no consent.** It works from site weather and work context only.
  Its legal basis is the employer's duty under the UAE midday-break rule and the ADOSH heat code, plus the PDPL's
  "occupational or preventive medicine" exception [S, S61]. Every use of health data is opt-in, scope by scope, and the
  worker can revoke it at any time.
- **Health data stays on the worker's phone.** Routinely, only a 10-key "level + action" record leaves the device. It
  carries a pseudonym, not a name, and no clinical field (224 bytes in the example in §2.4).
- **Access follows a role × purpose matrix.** 8 roles × 9 purposes = 72 cells. Each cell has a written reason and a
  basis, and `project()` enforces it. Supervisors never see clinical detail. Occupational health (OH) sees clinical
  detail only for an escalated case, and only if the worker agreed to share it.
- **Four purposes are refused for every role, whatever the consent:** performance management, disciplinary action,
  insurance underwriting, and immigration or visa decisions. Each refusal is logged. The employer contract repeats these
  bans and attaches penalties and a right to terminate.
- **Every access attempt is logged.** Allowed and refused attempts both go into an append-only log, hash-chained with
  SHA-256. Workers can see who looked at their data. The latest hash is published to the site worker committee, which
  makes a rewritten or truncated log detectable.
- **Employers, HSE and regulators see aggregates only.** The minimum cell size is k = 5 for HSE managers and k = 10 for
  regulators and employer HR. Complementary suppression stops anyone recovering a hidden cell by subtraction.
- **Zill is occupational-safety software, not a medical device.** It does not diagnose, does not predict heat stroke and
  does not measure core temperature. Physiological alerting stays out of production until the Emirates Drug Establishment
  (EDE) has given a written qualification opinion.
- **Prototype test evidence** (`src/engine/privacy.test.ts`):
  - the matrix gives the oracle's answer in all 18,432 situations tested; the oracle was derived separately from the brief;
  - 0 clinical leaks to supervisors across 3,000 random worker snapshots;
  - 0 recoverable hidden cells across 400 random tables;
  - 66 of 66 single-field forgeries of the audit log were caught at the exact entry.
- **Main open decisions (§13):**
  - break-glass access for OH;
  - k for HSE managers;
  - who anchors the audit head;
  - which law applies: the PDPL, the ICT Health Law, or both;
  - two open privacy gaps on supervisor screens: minute counts in projection texts, and a fasting worker's 0 mL/h water
    figure (items 16 and 18).

---

## 1. Principles

1. **Protection only.** Zill data exists to keep the worker safe. It is never used to rank, pay, discipline, insure,
   recruit or deport a worker (§5). *Code + Contract.*
2. **Privacy by architecture, not by policy.** Individual physiological and health data is processed on the worker's own
   device. The network sees "level + action" (ARCHITECTURE §1 principle 5). *Code.*
3. **Purpose limitation in code.** Every request names a role and one of nine purposes, and the matrix decides what is
   released (§3). This is how the PDPL rule that data be collected "only for specific and clearly defined purposes"
   [S, S61] becomes a software rule. *Code.*
4. **Minimisation.**
   - The supervisor sees what to do, never the medical reason.
   - The sync payload rounds water to 10 mL and floors work minutes [ENG].
   - Raw physiology is purged after 24 h [ENG].

   This follows the ILO code: the employer "must minimize the intrusion" (§6.14(1)) [P, S73]. *Code.*
5. **Consent where consent is real; legal duty where consent is not needed.** Core safety alerting needs no consent.
   Health-data processing is opt-in. A hierarchical superior may never collect the consent. The DoH SBR 2026 sets this
   rule for research [P, S70], and Zill applies it to every deployment [D]. *Code + Process.*
6. **Medical separation.** Clinical detail is held only by staff bound by medical secrecy, kept apart from other
   personal data (ILO code §8.2) [P, S73]. The employer receives conclusions, never medical information (§10.8–10.9).
   *Code + Contract.*
7. **Fail-safe and non-punitive.**
   - Missing or stale data makes Zill more conservative.
   - No sensor can talk a worker out of a rest break (ARCHITECTURE §1 principle 3).
   - A worker who stops work because of the heat is protected. The basis is ILO C155 Art. 13 [S, S74]; UAE ratification
     is UNVERIFIED.

   *Code + Contract.*
8. **Transparency and contestability.** Every level shows its drivers and the standard behind them. Every access
   decision states its reason. Workers can see their own record and its access history (§6, §10). *Code + Process.*
9. **Human oversight.** Zill makes no decision about a worker's employment. No decision about a worker rests solely on
   automated processing (ILO code §5.5) [P, S73]. People confirm escalations (§10). *Code + Process.*
10. **Free to workers, and rest is paid.**
    - Devices and data are funded by the employer (C155 Art. 21) [S, S74].
    - Prescribed rest is paid working time (C161 Art. 12) [S, S75].

    *Contract.*
11. **Worker voice.** An elected worker safety committee is consulted before launch (ILO code §12.2) [P, S73]. It
    receives the audit-log anchors and an annual governance report [D]. *Process.*

---

## 2. Data inventory

### 2.1 What Zill processes

These are the 18 fields that any role can ever request (`DataField` in `src/engine/types.ts`).
- **Class `clinical`** marks health or biometric data, which the PDPL treats as *sensitive personal data* [S, S62]. It
  also covers the individual strain projection.
- **Who can ever receive it** is computed from `ACCESS_MATRIX`. Every condition in brackets must hold. The worker always
  sees their own record.
- **Consent-gated fields** are released to nobody while their scope is off, not even to the worker's own view.

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Field | Label | Class | Consent scope needed | In sync payload | Who can ever receive it (condition; purposes) |
|---|---|---|---|---|---|
| `displayName` | Name / badge | identity | — | no | Worker (self) · Buddy (paired buddy); safety alerting · Crew supervisor (own crew); safety alerting, operational planning · First aider (active STOP/EMERGENCY case); safety alerting · Occupational health nurse (escalated case); safety alerting, clinical care |
| `crewId` | Crew | operational | — | yes | Worker (self) · Crew supervisor (own crew); safety alerting, operational planning · Occupational health nurse (escalated case); safety alerting, clinical care |
| `level` | Zill level | operational | — | yes | Worker (self) · Buddy (paired buddy); safety alerting · Crew supervisor (own crew); safety alerting, operational planning · First aider (active STOP/EMERGENCY case); safety alerting · Occupational health nurse (escalated case); safety alerting, clinical care |
| `actions` | Actions | operational | — | yes | Worker (self) · Buddy (paired buddy); safety alerting · Crew supervisor (own crew); safety alerting, operational planning · First aider (active STOP/EMERGENCY case); safety alerting · Occupational health nurse (escalated case); safety alerting, clinical care |
| `workMinPerHour` | Work minutes per hour | operational | — | yes | Worker (self) · Crew supervisor (own crew); safety alerting, operational planning · Occupational health nurse (escalated case + sharing consent); clinical care |
| `ackStatus` | Acknowledgement | operational | — | yes (as `ack`) | Worker (self) · Buddy (paired buddy); safety alerting · Crew supervisor (own crew); safety alerting, operational planning · Occupational health nurse (escalated case); safety alerting, clinical care |
| `minutesToLimit` | Minutes to strain limit | clinical | — | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `waterMlPerHour` | Water (mL/h) | operational | — | yes | Worker (self) · Crew supervisor (own crew); safety alerting, operational planning · Occupational health nurse (escalated case + sharing consent); clinical care |
| `drivers_nonclinical` | Reasons (non-clinical) | operational | — | no | Worker (self) · Crew supervisor (own crew); safety alerting, operational planning · Occupational health nurse (escalated case + sharing consent); clinical care |
| `drivers_clinical` | Reasons (clinical) | clinical | — | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `hrBpm` | Heart rate | clinical | `wearable` | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `ctEstC` | Estimated strain indicator (ECTemp) | clinical | `wearable` | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `psi` | Physiological Strain Index | clinical | `wearable` | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `riskFlags` | Health factors | clinical | `healthFlags` | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `symptoms` | Reported symptoms | clinical | — | no | Worker (self) · First aider (active STOP/EMERGENCY case + escalated case); safety alerting · Occupational health nurse (escalated case + sharing consent); clinical care |
| `urineColor` | Urine colour | clinical | `checkins` | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `ageYears` | Age | personal | — | no | Worker (self) · Occupational health nurse (escalated case + sharing consent); clinical care |
| `location` | Location | personal | — | no | Worker (self) · First aider (active STOP/EMERGENCY case); safety alerting · Occupational health nurse (escalated case); safety alerting, clinical care |

`symptoms` has no consent gate on purpose: a buddy or first aider must always be able to record danger signs (§4.6).
Clinical drivers carry the same gates as their channel: physiology drivers need `wearable` and hydration drivers need
`checkins`.

### 2.2 Profile inputs that no role can request

The worker profile (`WorkerProfile` in `types.ts`) holds further inputs that the engine uses on the device:
- **Body:** sex, mass, height and resting heart rate, used by the ISO 7933 heat-strain model and the PSI.
- **Acclimatisation history:** days on site, recent days away and previous hot seasons, used by the NIOSH limits and the
  ADOSH rule that bars unacclimatised workers from the Medium and High zones.
- **Clothing**, used for the ACGIH clothing adjustment.
- **Language, consent state, and whether the worker has a wearable.**

None of these is a projectable field, so no role can obtain one through `project()`. `inspectSyncPayload()` lists them
as kept on the device.

Unknown values fall back to protective defaults (ARCHITECTURE §5):
- body size 75 kg and 1.75 m;
- acclimatisation unacclimatised;
- clothing cloth coveralls.

**Zill never stores nationality.** The workforce model keeps the preferred language only, as a privacy-by-design choice
(`src/data/workforce.ts`).

### 2.3 Where data lives and how long it is kept

| Data | Where it lives | Retention | Basis |
|---|---|---|---|
| Raw heart-rate samples, ECTemp and PSI traces | Worker's device only | Purged after 24 h (`RAW_PHYSIOLOGY_RETENTION_MS`). A sample exactly 24 h old is purged. | ARCHITECTURE §7 [ENG]; ILO code §6.14(1) [P, S73] |
| Health factors (yes/no risk flags) | Worker's device | Until the worker changes or deletes them | `CONSENT_NOTICES.healthFlags` |
| Check-in answers (symptoms, urine colour, logged drinks) | Worker's device. Symptoms reach the first aider for an escalated case. | **Not yet set in code** (§13, item 5) | `CONSENT_NOTICES.checkins` |
| Level history (level, actions, work/rest, water, acknowledgement) | Device and site console, under a pseudonym | 30 days (`LEVEL_HISTORY_RETENTION_MS`; exactly 30 days is purged) | ARCHITECTURE §7 [ENG] |
| Crew roster (pseudonym → name, crew, site) | Employer's supervisor console | Employer's HR record rules (outside Zill) | `WorkerProfile.displayName`, kept for operational necessity |
| Consent state and consent receipts | State on the device; receipts in a consent ledger (production location open) | As long as the processing they prove, plus a dispute period. **Period not yet set** (§13). | PDPL: the controller "must be able to prove that the data subject gave consent" [S, S62] |
| Clinical detail released on a consented escalation | OH's confidential record, apart from all other personal data | OH's medical-record obligations. The ICT Health Law retention terms are UNVERIFIED in our research. | ILO code §8.2 [P, S73] |
| Audit log | Prototype: in memory, exportable as `zill-audit/1`. Production: append-only store (§6). | **Not yet set** (§13). It must outlive the data it describes. | ARCHITECTURE §7 |
| Aggregates (k-suppressed tables) | HSE console, regulator reports | Retained; they contain no individual record | ARCHITECTURE §7 |

**Hosting.** A deployment is hosted in the UAE (for example Azure UAE North in Dubai or UAE Central in Abu Dhabi;
research §4.1). It keeps no offshore copies unless Ministerial Decision 51/2021 allows them [S, S65]. This satisfies the
PDPL and Article 13 of the ICT Health Law, whichever applies [D]. The weather service receives site coordinates only,
never worker data.

### 2.4 What leaves the worker's device

**The routine record.** It is the `SyncPayload` (`src/engine/privacy.ts`) and has exactly ten keys: `v`, `pseudonym`,
`crewId`, `level`, `actions`, `workMinPerHour`, `waterMlPerHour`, `ack`, `t`, `confidence`.

**Worked example** (generated with `inspectSyncPayload()`). The illustrative input is:
- a `high` level, with actions `shade_breaks`, `drink_water`, `rotate_task` and `occ_health_review`;
- 45.7 work minutes per hour, 52 minutes to the strain limit, 1,183 mL/h of water.

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
```json
{
  "v": 1,
  "pseudonym": "W-7F3A",
  "crewId": "musaffah-c2",
  "level": "high",
  "actions": [
    "shade_breaks",
    "drink_water",
    "rotate_task"
  ],
  "workMinPerHour": 45,
  "waterMlPerHour": 1180,
  "ack": "acknowledged",
  "t": 1752559200000,
  "confidence": "medium"
}
```

What happened to the input (224 bytes in UTF-8):
- The confidential `occ_health_review` action was dropped. It would reveal that OH has asked for a confidential review.
- Work minutes were floored to 45, so the payload never allows more work than the engine did.
- Water was rounded to the nearest 10 mL.
- The drivers, minutes-to-limit, data quality, name, site, language, age, acclimatisation history, clothing, health
  factors, consent state and wearable status all stayed on the device.
- The supervisor console maps the pseudonym to the crew roster, so the name never travels in the payload.

**Alerts and notifications** go to the roles the alert policy routes them to (ARCHITECTURE §6). They carry the level,
the actions, a non-clinical reason, the alert basis (exposure or individual, §3.4) and the escalation and
acknowledgement times by role, and no clinical field. One gap is open: a projection reason can contain the projected
minutes (§13 item 16).

**Other flows**, each passing the matrix in §3 and logged in §6:
- the first aider's case view for an active STOP or EMERGENCY;
- OH's clinical view for an escalated case with the worker's sharing consent;
- k-suppressed aggregates.

### 2.5 What Zill does not collect

- **No identity-status fields.** Zill has no field for nationality, religion, immigration or visa status, or passport
  data.
- **No location history.** Location is read for an active case, is not part of the sync payload, and is not stored as a
  history.
- **No microphone or camera capture in the prototype.** Voice is output only (text-to-speech). The pilot's optional voice
  check-in (research §6.5) would need its own DPIA entry before use.

---

## 3. Who may see what: the role × purpose matrix

### 3.1 How a request is decided

`project(snapshot, request, ctx)` decides every individual-level request in this order:

1. **Role, actor and purpose.** The requester declares a role, an actor id and one purpose from the closed `Purpose` list
   (`types.ts`). Nothing can be requested without a purpose, and no purpose outside the list exists.
2. **Prohibited purposes first.** A prohibited purpose is refused for every role before anything else is checked (§5).
3. **Grants and conditions.** Each grant in the cell releases its fields only when all of its conditions hold. The
   conditions are:
   - the requester is the worker;
   - the requester is the worker's paired buddy;
   - the worker is in the requester's crew;
   - the worker is at STOP or EMERGENCY;
   - the case is escalated;
   - the worker has given sharing consent.
4. **Consent gating.** `hrBpm`, `ctEstC` and `psi` need `wearable`; `riskFlags` needs `healthFlags`; `urineColor` needs
   `checkins`. This applies to every role, including the worker's own view, so a revocation takes effect on the next call.
5. **Leak filters.**
   - The confidential `occ_health_review` action is removed for anyone not cleared for clinical drivers.
   - Projection-channel drivers lose their number (`value`, `unit`) unless `minutesToLimit` is also released, because
     that number is the individual minutes-to-limit. Their text is copied as it is, and some projection texts contain
     the number; this is open (§13 item 16).
6. **Result and log.** The result lists the released fields, the withheld fields and why, and an audit entry.
   `projectAndLog()` appends that entry whether the request was allowed or refused.

**Integrator obligation.** Buddy pairing and crew scope are checked only when the caller passes
`ProjectionContext.buddyIds` and `actorCrewIds`. When they are omitted, scope is not checked [ENG], because safety
alerting must not fail closed and both views are non-clinical. Production builds must pass them (§13, item 6).

### 3.2 The matrix

How to read the cells:
- **G1–G7** refer to the grants in §3.3.
- **"—"** means no individual data and no aggregates. Such a request is denied and the denial is logged.
- **"refused"** marks the four prohibited purposes.

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Role | Safety alerting | Clinical care | Operational planning | Compliance reporting | Public-health statistics | 4 prohibited purposes |
|---|---|---|---|---|---|---|
| **Worker** | G1: all 18 fields, self | G1: all 18 fields, self | G1: all 18 fields, self | G1: all 18 fields, self | G1: all 18 fields, self | refused |
| **Buddy** | G2: 4 non-clinical fields, paired buddy | — | — | — | — | refused |
| **Crew supervisor** | G3: 8 non-clinical fields, own crew | — | G3: 8 non-clinical fields, own crew | — | — | refused |
| **First aider** | G4: 4 non-clinical fields, active STOP/EMERGENCY case; G5: `symptoms`, active STOP/EMERGENCY case + escalated case | — | — | — | — | refused |
| **Occupational health nurse** | G6: 6 non-clinical fields, escalated case | G6: 6 non-clinical fields, escalated case; G7: 12 fields (8 clinical), escalated case + sharing consent | — | — | — | refused |
| **HSE manager** | aggregates only, k = 5 | — | aggregates only, k = 5 | aggregates only, k = 5 | — | refused |
| **Regulator (ADPHC / ADOSH)** | — | — | — | aggregates only, k = 10 | aggregates only, k = 10 (consenting workers only) | refused |
| **Employer HR** | — | — | — | aggregates only, k = 10 | — | refused |

### 3.3 Grants

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Grant | Fields released | Only when (all must hold) | Consent-gated fields | Cells (role × purpose) | Why |
|---|---|---|---|---|---|
| G1 | all 18 fields | the requester is the worker the data is about | `hrBpm` → `wearable`, `ctEstC` → `wearable`, `psi` → `wearable`, `riskFlags` → `healthFlags`, `urineColor` → `checkins` | Worker: safety alerting, clinical care, operational planning, compliance reporting, public-health statistics | A worker sees everything Zill holds about them. |
| G2 | `displayName`, `level`, `actions`, `ackStatus` | the requester is the worker's paired buddy | — | Buddy: safety alerting | The partner's level and what to do, to run a buddy check. |
| G3 | `displayName`, `crewId`, `level`, `actions`, `workMinPerHour`, `ackStatus`, `drivers_nonclinical`, `waterMlPerHour` | the worker is in the requester's crew | — | Crew supervisor: safety alerting, operational planning | What to do, for the workers in the crew the supervisor runs. |
| G4 | `displayName`, `level`, `actions`, `location` | the worker is at STOP or EMERGENCY | — | First aider: safety alerting | Who needs help, how urgently, what to do and where they are. |
| G5 | `symptoms` | the worker is at STOP or EMERGENCY; the case has been escalated | — | First aider: safety alerting | Reported symptoms guide first aid once the case is escalated (vital-interest exception). |
| G6 | `displayName`, `crewId`, `level`, `actions`, `ackStatus`, `location` | the case has been escalated | — | Occupational health nurse: safety alerting, clinical care | Occupational health is alerted to escalated cases. |
| G7 | `workMinPerHour`, `minutesToLimit`, `waterMlPerHour`, `drivers_nonclinical`, `drivers_clinical`, `hrBpm`, `ctEstC`, `psi`, `riskFlags`, `symptoms`, `urineColor`, `ageYears` | the case has been escalated; the worker has consented to share clinical detail with occupational health on escalation | `hrBpm` → `wearable`, `ctEstC` → `wearable`, `psi` → `wearable`, `riskFlags` → `healthFlags`, `urineColor` → `checkins` | Occupational health nurse: clinical care | Clinical detail, because the worker agreed to share it with occupational health on escalation. |

Every one of the 72 cells, including every denial, carries a plain-language reason and a basis string. `explain()`
returns them in plain language, and the governance view specified in ARCHITECTURE §9 (`#/governance`) displays them.

### 3.4 Design decisions worth knowing

- **Supervisors** never receive the individual model projection (`minutesToLimit`) or age as a field; some projection
  driver texts still contain the minutes (open, §13 item 16). They do receive the work/rest and water schedule, because
  those are the actions they must organise.
- **First aiders** never receive health factors or physiology. They get who, where, the level and what to do for an
  active case, plus the reported symptoms once the case is escalated (ILO code §8.2 and §10.1) [P, S73].
- **OH** is alerted to escalated cases so it can coordinate care. It sees clinical detail only under the
  `clinical_care` purpose, and only with the worker's sharing consent.
- **Employer HR** receives compliance aggregates at k = 10. Every other HR request is refused and logged.
- **Inference risk (residual).** A supervisor can see that one worker's level or work/rest schedule differs from the
  rest of the crew. Conservative mode, triggered by any health factor, produces stricter limits, so a stricter schedule
  could hint at a health factor. Three mitigations apply:
  - Conservative mode also applies to every worker in their first 14 days, after a return from 7 or more days away, and
    after heat rash reported that day. A stricter schedule therefore does not single out a health factor.
  - Reason texts shown to supervisors are non-clinical by contract (`RiskDriver.text` in `types.ts`).
  - The employer contract bars adverse action based on inferred health status (§5.3).

  The DPIA lists this risk (§11, R3). Two further inference paths are open (§13 item 18): while a worker who declared
  fasting is fasting, the engine sets their water figure to 0 mL/h, and the sync payload carries it; and the recovery
  text after a reached water-loss limit differs when drinking is restricted ("no more heat work this shift") from when it
  is allowed ("drink and rest").
- **Alert basis** (ARCHITECTURE §6). Every alert says whether it describes a shared condition (`exposure`: site heat or a
  site rule, from the environment and regulation channels only) or this worker (`individual`). The basis is safe to
  show to supervisors:
  - the basis label is the same for every personal cause. Alerts driven by the physiology, symptoms or hydration
    channels also share one reason ("Personal check flagged on the worker's device", or "First-aid check needed" at
    STOP), so neither the reason nor the basis says which of them is involved. A projection-driven alert names the
    heat-strain model (see item 16 of §13 for the minute counts in some of those texts);
  - an exposure alert's reason names only the shared condition and the work/rest schedule in effect ("Site heat:
    work/rest 30/30 in effect", "Site rule: …"), the same words for every crew member;
  - routing never depends on the basis, so a label can never withhold a notification.
- **Escalated from raise.** A symptom- or physiology-driven stop routes the first aider at once, so the durable
  escalation record (`escalatedAt`) marks it as escalated from the moment it is raised. The first aider then sees the
  reported symptoms at once, under the vital-interest exception (§4.6), and OH sees the case, with clinical detail only
  under the sharing consent. Before this record existed, that happened only after the 2-minute acknowledgement timeout
  or a first-aider hand-over. The privacy owner is asked to confirm it (§13 item 17).

---

## 4. Consent

### 4.1 Processing that needs no consent, and processing that does

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Processing activity | Switched on by | Fields produced or disclosed | Legal basis recorded in code |
|---|---|---|---|
| `core_safety_alerting`: Site weather and work context → level, actions, work/rest and water schedule. Uses no health data. | **no consent needed** (always on) | `level`, `actions`, `workMinPerHour`, `waterMlPerHour`, `minutesToLimit`, `drivers_nonclinical` | Employer legal duty (MoHRE MR 44/2022 midday break; ADOSH-SF CoP 11.0 v4.0); UAE PDPL Art. 4: processing without consent for 'occupational or preventive medicine', public health and statistical studies [secondary, S61] |
| `wearable_physiology`: Heart rate from a paired band → estimated strain indicators on this phone (can only raise the level). | `wearable` consent | `hrBpm`, `ctEstC`, `psi`, `drivers_clinical` | UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]; UAE PDPL (Federal Decree-Law 45/2021): health and biometric data are sensitive personal data [secondary, S62] |
| `personalised_thresholds`: Self-declared health factors make the limits stricter (conservative mode). | `healthFlags` consent | `riskFlags` | UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]; UAE PDPL (Federal Decree-Law 45/2021): health and biometric data are sensitive personal data [secondary, S62] |
| `symptom_checkins`: Symptom and hydration check-ins. A buddy or first aider can always report danger signs (vital-interest exception). | `checkins` consent | `symptoms`, `urineColor`, `drivers_clinical` | UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]; ILO Code of Practice 'Protection of workers' personal data' (1997) §10.1 (no third-party disclosure without explicit consent, except to prevent serious and imminent threat to life or health) [primary, S73] |
| `clinical_sharing_on_escalation`: Clinical detail is released to occupational health only for an escalated case. | `shareWithMedicOnEscalation` consent | `workMinPerHour`, `minutesToLimit`, `waterMlPerHour`, `drivers_nonclinical`, `drivers_clinical`, `hrBpm`, `ctEstC`, `psi`, `riskFlags`, `symptoms`, `urineColor`, `ageYears` | UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]; ILO Code of Practice 'Protection of workers' personal data' (1997) §8.2 (medical data held only by personnel bound by medical secrecy, kept apart) [primary, S73]; ILO Code of Practice 'Protection of workers' personal data' (1997) §10.1 (no third-party disclosure without explicit consent, except to prevent serious and imminent threat to life or health) [primary, S73] |
| `aggregate_statistics`: Counted in public-health statistics (groups smaller than 10 suppressed). | `aggregateStatistics` consent | — (counts only) | UAE PDPL: consent specific, informed and unambiguous, provable by the controller, withdrawable at any time [secondary, S62]; UAE PDPL Art. 4: processing without consent for 'occupational or preventive medicine', public health and statistical studies [secondary, S61]; context_and_commercial §6.2 item 4: suppress any group smaller than 10 workers [D] |

**Why consent is used for health data even though Art. 4 might not require it.**
- The PDPL has no legitimate-interests basis [S, S62]. The research therefore recommends a consent-first design that
  also documents a separate legal basis [D].
- Consent inside an employment hierarchy is fragile (§4.4). That is why the protective core never depends on it: a worker
  who declines every scope receives the same environmental and regulatory alerts as everyone else.
- The minutes-to-limit projection is computed under core alerting from the environment, the task and the profile
  (§2.2). It is individual but contains no health data. Supervisors never see it.

### 4.2 The five consent scopes

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Scope | What the worker agrees to (notice v1.0) | Data processed | Who sees it | Retention |
|---|---|---|---|---|
| `wearable` | **Heart rate from my band.** Zill may read heart rate from my band on this phone to estimate my heat strain. It is an estimate to help keep me safe, not a medical measurement or a diagnosis. My supervisor never sees it. | Heart-rate samples; estimated strain indicators (ECTemp, PSI) calculated on this phone. | Only me — and occupational health only if my case is escalated and I also agreed to share with them. | Raw heart-rate and strain traces are deleted from this phone after 24 hours. |
| `healthFlags` | **Health factors that make heat more dangerous for me.** Zill may use my yes/no answers (for example a recent illness, or a medicine that affects heat tolerance) to make my alerts stricter. My answers stay on this phone and are never shown to my supervisor or employer. | Self-declared yes/no risk factors; never added up into a score. | Only me — and occupational health only if my case is escalated and I also agreed to share with them. | Kept on this phone until I change or delete them. |
| `checkins` | **Symptom and hydration check-ins.** Zill may ask how I feel and the colour of my urine. My answers stay on this phone. If my case is escalated, the first aider sees the symptoms I reported so they can help me. | Check-in answers (symptoms, urine colour) and the drinks I log. | Me; the first aider for an escalated STOP or EMERGENCY case. A buddy or first aider can always report danger signs for me. | Kept on this phone; my level history is kept under a pseudonym for 30 days. |
| `shareWithMedicOnEscalation` | **Share with occupational health if my case is escalated.** If my case is escalated, the occupational health nurse may see my heart-rate estimates, health factors and check-in answers to look after me. Nobody else sees them, and they are never used against me. | The clinical fields held on this phone, released only for an escalated case. | The occupational health nurse, bound by medical confidentiality. | Kept by occupational health under medical confidentiality, apart from all other personal data. |
| `aggregateStatistics` | **Count me in anonymous statistics.** My data may be counted in public-health statistics about heat at work. Groups of fewer than 10 people are hidden so that I cannot be picked out. | Counts by site, crew and level; never an individual record. | The regulator (ADPHC / ADOSH), as aggregates only. | Aggregates are kept; they contain no individual record. |

Every notice ends with the same withdrawal promise: *"I can switch this off at any time in Zill. It takes effect
immediately and I will not be penalised for it."* The English text is the master. Each translation must carry the same
text (DoH SBR §3.5.3.2.4) [P, S70].

**Legal-duty aggregates (§13 item 14).** The `aggregateStatistics` notice covers only public-health statistics. A
general privacy notice shown to every worker, whatever their consent choices (`GENERAL_PRIVACY_NOTICE`, "How you are
counted in group totals"), says that HSE operational aggregates (k = 5) and compliance aggregates for HR and the
regulator (k = 10) count every worker under the employer's legal duty and never show anyone's record. Its k values are
taken from the code. It exists in all eight languages, as machine-assisted drafts.

### 4.3 Consent receipts

`createConsentReceipt()` produces a frozen receipt for every grant and every withdrawal. A receipt records:
- the subject, the scope and the action (granted or revoked);
- the time;
- the notice version and the English master title and statement (`CONSENT_NOTICES`);
- the language the notice was shown in;
- the method: an electronic affirmative action, a written signature, or a witnessed mark;
- who collected it: the worker themselves (`self`), research staff, or OH;
- for a witnessed mark, the impartial witness.

This answers the PDPL requirements that consent be given "by a statement or by a clear affirmative action in writing or
electronic form" and that "the data controller must be able to prove that the data subject gave consent" [S, S62].

### 4.4 Who may collect consent, and why supervisors may not

The DoH Standard for Biomedical Research treats workers in a hierarchy as *vulnerable participants*. Its definition
covers people who may be influenced by "a retaliatory response from senior members of a hierarchy" and gives "members of
a group with a hierarchical structure" as an example [P, S70].
- A supervisor therefore must not obtain a worker's consent.
- For public-health studies without clinical interventions, trained research staff may take consent (§3.11.2.5)
  [P, S70].
- The SBR governs research. Zill applies the same rule outside research, in every deployment, because the hierarchy is
  the same [D].

**In code**, `createConsentReceipt()` accepts only `self`, `research_staff` or `occ_health` as the collector. Any other
value throws *"a worker's consent may not be obtained by a hierarchical superior (DoH SBR 2026)"*. A `witnessed_mark`
without a `witnessId` also throws.

**In process** [D]:
- Consent sessions are run by research staff (pilot) or OH (deployment), away from supervisors.
- Declining has no consequence. The core alerts work the same for a worker who declines every scope.
- The ILO code adds that "workers may not waive their privacy rights" (§5.13) [P, S73]. Consent can therefore never
  unlock a prohibited purpose (§5).

### 4.5 Withdrawal

- **How.** `revokeConsent(state, scope, t)` works for any scope, at any time, from the worker's own phone.
- **Effect.** On the next projection, consent-gated fields are released to nobody. The withdrawal also reaches the
  engine on the worker's own device, from that minute:
  - `wearable`: the physiology channel is no longer evaluated, and no heart-rate data reach it;
  - `checkins`: the worker's own check-ins and drink logs are no longer used, so logged drinks earn no water credit
    (ARCHITECTURE §5); buddy and first-aider reports still count (§4.6);
  - `healthFlags`: the declared risk flags are no longer used, so conservative mode no longer follows from them.

  In the prototype the governance ledger drives this: whenever a worker's ledger consent differs from what their
  simulated device uses, a consent change is applied to the device's world (`connectGovernanceToSim`; ARCHITECTURE
  §10). It stays on the device side: nothing about consent crosses the sync bus. Tested in
  `governanceStore.test.ts` › "grant/revoke inject the new consent into the device world from that minute; nothing
  leaves the tab". The notice promises no penalty, and the contract makes that promise binding (§5.3, C3).
- **What withdrawal does not undo** [D]:
  - a clinical record that OH has already made for an escalated case, which stays under medical-record rules;
  - aggregates already published, which contain no individual record.
- **Offline ordering.** `ConsentState` has a single `updatedAt`, so events recorded offline cannot be ordered from the
  state alone. The per-scope ledger of receipts is authoritative (§13, item 7).

### 4.6 The vital-interest exception

Symptoms are deliberately not gated by consent:
- A buddy, supervisor or first aider can always report danger signs, and the symptoms channel always uses those reports.
- The first aider receives the reported symptoms for an escalated case without the worker's consent. A symptom- or
  physiology-driven stop counts as escalated from the moment it is raised (§3.4, "Escalated from raise").
- The basis is the ILO code's exception for disclosure "to prevent serious and imminent threat to life or health"
  (§10.1) [P, S73].
- A worker's own check-ins are ignored when the worker has not given `checkins` consent.

### 4.7 Languages and literacy

**Coverage.** Consent texts exist in Zill's eight languages: Arabic, English, Hindi, Urdu, Malayalam, Bengali, Tagalog
and Nepali (i18n keys `consent.<scope>.title|explain`).

**DoH requirements for consent documents** [P, S70]:
- drafts in Arabic and English with the same text;
- clear, practical, non-technical and non-exculpatory wording;
- an impartial witness who signs for a participant who cannot read.

**Status.** All seven non-English catalogues are machine-assisted drafts, and `isDeployable()` returns false for every
language. A language becomes deployable only after:
- native-speaker review and back-translation;
- OH review;
- a comprehension test (ANSI Z535.3: at least 85 % correct and under 5 % critical confusion);
- authenticated translation of the consent text.

We found no source for literacy rates among UAE migrant workers (UNVERIFIED). The design therefore assumes low literacy
and supports pictograms, colour, voice and the witnessed mark.

**Inconsistency to fix before any consent is collected (§13 item 15).** The prototype has two different English consent
texts:
- **Shown on screen:** the i18n consent strings (`src/i18n/messages.ts`, `consent.*`). Example: "Heart rate from my
  watch … The readings stay on your phone."
- **Recorded on the receipt:** the `CONSENT_NOTICES` text (`src/engine/privacy.ts`). Example: "Heart rate from my band
  … not a medical measurement or a diagnosis. My supervisor never sees it."

A receipt must prove the exact text the worker agreed to, and DoH requires the Arabic and English texts to be the same.
There should therefore be one versioned consent text per scope, translated into every language. The receipt should
record the language and a hash of the exact text shown.

---

## 5. Prohibited purposes and their enforcement

### 5.1 The four prohibited purposes

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Purpose | Refusal text (shown to the requester and logged) | Basis recorded in code |
|---|---|---|
| Performance management (`performance_management`) | heat-strain data is never used for performance ranking, pay or attendance. | context_and_commercial §6.2 excluded uses (Zill contract term); ILO Code of Practice 'Protection of workers' personal data' (1997) §5.6 (monitoring data not the only factor in evaluating performance) [primary, S73] — Zill's ban is stricter than this clause; ILO Code of Practice 'Protection of workers' personal data' (1997) §5.4 (not used to control the behaviour of workers) [primary, S73]; UAE PDPL purpose limitation: collected 'only for specific and clearly defined purposes' [secondary, S61] |
| Disciplinary action (`disciplinary_action`) | no discipline, deduction or termination may rest on Zill data — least of all for a worker who stopped work because of the heat. | context_and_commercial §6.2 excluded uses (Zill contract term); ILO Code of Practice 'Protection of workers' personal data' (1997) §5.4 (not used to control the behaviour of workers) [primary, S73]; ILO Code of Practice 'Protection of workers' personal data' (1997) §5.5 (no decision based solely on automated processing) [primary, S73]; ILO C155 Art. 13 (a worker who removes himself from imminent, serious danger is protected) [secondary, S74; UAE ratification UNVERIFIED]; UAE PDPL purpose limitation: collected 'only for specific and clearly defined purposes' [secondary, S61] |
| Insurance underwriting (`insurance_underwriting`) | individual data is never shared with health, life, workers'-compensation or liability insurers. | context_and_commercial §6.2 excluded uses (Zill contract term); ILO Code of Practice 'Protection of workers' personal data' (1997) §10.1 (no third-party disclosure without explicit consent, except to prevent serious and imminent threat to life or health) [primary, S73]; ILO Code of Practice 'Protection of workers' personal data' (1997) §10.2 (no commercial or marketing use without consent) [primary, S73]; Federal Law 2/2019 (ICT in Health Fields) Art. 13 localisation; Ministerial Decision 51/2021 exceptions [secondary, S65] |
| Immigration or visa decisions (`immigration_or_visa`) | Zill data is never used in recruitment, fitness-for-hire, visa or sponsorship decisions. | context_and_commercial §6.2 excluded uses (Zill contract term); ILO Code of Practice 'Protection of workers' personal data' (1997) §5.13 (workers may not waive their privacy rights) [primary, S73] — consent cannot launder a coercive use; DoH Standard for Biomedical Research DoH/SD/HLSS/SBR/V1/2026 [primary, S70] (workers in a hierarchy are vulnerable participants); UAE PDPL purpose limitation: collected 'only for specific and clearly defined purposes' [secondary, S61] |

**Sale or marketing use** is also excluded (research §6.2; ILO code §10.2) [P, S73]. No purpose value exists for it, so
it cannot be requested through Zill at all. The contract prohibits it (§5.3, C2).

### 5.2 Enforcement in code

- **A closed list.** `Purpose` is a closed union and `PROHIBITED_PURPOSES` is a constant (`types.ts`).
- **Checked first.** `isProhibitedPurpose()` runs first in both `project()` and `aggregateFor()`. A prohibited request is
  refused for every role and every consent state, including the worker's own request. A worker cannot be asked to
  "consent" their own data into a disciplinary file (ILO code §5.13).
- **Refusals are logged.** Each refusal is written to the hash-chained log as `decision: 'denied'`, with its reason (§6).
- **Tested.** The tests refuse every role × prohibited purpose combination; these cases are part of the 18,432 oracle
  situations. ARCHITECTURE §9 also specifies a live prohibited-purpose demonstration in the governance view.
- **Reported.** The count of attempted out-of-scope requests is a governance KPI (target: 0 disclosed). It is reported
  to the worker committee (research §6.5).

**What code cannot stop:** a screenshot of a supervisor's screen, a supervisor's memory, or data the employer gathers
elsewhere. The contract and processes below cover that gap.

### 5.3 Enforcement by contract: clauses for the employer agreement [D]

| # | Clause | Basis |
|---|---|---|
| C1 | **Purpose limitation.** Zill data is used only for safety alerting, clinical care (by OH), operational planning, compliance reporting and public-health statistics. | PDPL purpose limitation [S, S61]; ILO code §5.4 [P, S73] |
| C2 | **Excluded uses.** No sharing of individual data with any insurer (health, life, workers' compensation, employer liability). No use in discipline, pay, attendance, performance ranking or termination. No use in recruitment, fitness-for-hire, visa or sponsorship decisions. No sale or marketing use. | Research §6.2; ILO code §5.4–5.6, §10.1–10.2 [P, S73]; ICT Health Law Art. 13 [S, S65] |
| C3 | **Non-retaliation.** No adverse action against a worker for stopping work because of heat, reporting symptoms, declining or withdrawing consent, or on the basis of inferred health status. | ILO C155 Art. 13 [S, S74] (UAE ratification UNVERIFIED); ILO code §5.13 [P, S73] |
| C4 | **Paid rest.** Rest prescribed by Zill or the HSE plan is paid working time. | ILO C161 Art. 12 [S, S75] |
| C5 | **Free to workers.** Devices, data plans and messages are paid for by the employer. | ILO C155 Art. 21 [S, S74] |
| C6 | **Legal duties stay with the employer.** Zill never relaxes the midday break, the ADOSH zone controls or the HSE plan. | MoHRE MR 44/2022; ADOSH-SF CoP 11.0 v4.0; ARCHITECTURE §1 principle 6 |
| C7 | **Medical separation.** Clinical detail is held only by OH staff bound by medical secrecy, apart from HR records. | ILO code §8.2, §10.8–10.9 [P, S73] |
| C8 | **Transparency to workers.** The audit-chain head is published (§6). An annual governance report goes to the site worker committee. The worker committee is consulted before launch. | Research §6.2 item 4 [D]; ILO code §12.2 [P, S73] |
| C9 | **Remedies.** Contractual penalties for misuse, with a right to terminate. | Research §6.2 item 4 [D] |
| C10 | **Data residency.** Hosting in the UAE. No offshore copy without a Ministerial Decision 51/2021 basis. | ICT Health Law Art. 13 [S, S65, S66] |
| C11 | **Breach notification.** The UAE Data Office and the affected workers are notified. The PDPL sets no materiality threshold for notifying data subjects. | PDPL [S, S62] |
| C12 | **Scope integrity.** Supervisor and buddy assignments are kept current, so need-to-know scoping is enforced (§3.1). | ARCHITECTURE §2 |

### 5.4 Why the prohibitions matter for safety

- **Fear suppresses the signal.** Zill's key personal signal is voluntary symptom reporting. If a report can cost wages
  or a job, workers will under-report. Human Rights Watch recorded threatened wage deductions for slowing down in the
  heat [P, S24].
- **Privacy drives adoption.** OSH professionals named the privacy of collected data as a top barrier to adopting
  wearables (952 respondents) [P, S89]. Employee acceptance is highest for safety uses and improves when workers are
  properly informed about how their data is used (1,273 respondents) [P, S90].
- **Any disciplinary or insurer use would degrade the clinical signal Zill depends on** [D]. Governance is part of the
  safety case, not an add-on.

---

## 6. Audit log, "who saw my data", and the published chain head

**What is logged.**
- Every individual projection (`projectAndLog()`) and every aggregate request (`aggregateAndLog()`), allowed or refused.
- In the prototype views, the selectors run on every render, so an unchanged access is not logged again each time: an
  access is appended when its decision, fields or reason change, after 15 simulated minutes (`AUDIT_RELOG_MS` [ENG]), or
  after a rewind (ARCHITECTURE §10). Continued access therefore stays visible to the worker without flooding the chain.
  The appended entry is the one `projectAndLog()` would append, and the prohibited-request demo always logs.
- Each `AuditEntry` holds:
  - `seq`, `t`, `actorRole`, `actorId` and `purpose`;
  - `subjectId`, for individual requests only;
  - `fields`: the released fields; for a denial, what was requested; for an aggregate, the table dimensions;
  - `decision`, `reason`, `prevHash` and `hash`.

**How the chain works.**
- Each `hash` is SHA-256 (Web Crypto) over the canonical JSON of every other key, including `seq` and `prevHash`.
  Canonical means keys sorted as in RFC 8785 and no whitespace.
- The first entry links to `GENESIS_HASH`, which is 64 zeros.
- Appends are serialised, and stored entries are frozen.

**What `verify()` detects.** It recomputes the chain and reports the first broken position. That catches an edited,
inserted, deleted or reordered entry. In tests, 66 of 66 single-field forgeries were caught at the exact entry, and
SHA-256("abc") matches the standard test vector.

**What a chain alone cannot detect.** A cut tail, or a full rewrite with freshly computed hashes, leaves a valid-looking
chain. The fix is an anchor:
- `head()` returns `{ seq, hash }` for the latest entry.
- Once that pair is published somewhere the operator does not control, `verify(anchor)` detects truncation or rewriting
  up to the anchored entry.
- Entries after the latest anchor are protected only from the next anchor onwards. Anchors must therefore be published
  often.

**Publishing the head** [D proposal; cadence is open, §13 item 3].
- During the heat season, the current anchor is printed weekly on the site notice board: the sequence number, the first
  16 hex characters, and a QR code of the full hash.
- Every anchor is also included in the annual report to the worker committee. Committee members keep copies.
- Anyone holding an exported log (`AuditLog.export()`, format `zill-audit/1`) can run `verify(anchor)` against a
  published anchor.
- A mismatch is handled as a suspected breach: the DPO is informed, and the PDPL breach procedure applies if it is
  confirmed.

**"Who saw my data."** `AuditLog.forSubject(workerId)` returns every individual-level entry about the worker, refusals
included. The privacy screen of the worker view (ARCHITECTURE §9) shows them. Aggregate queries carry no subject id, so they appear in the
committee report rather than in a worker's list.

**Access to the log itself.** The log is personal data, because it holds pseudonymous subject and actor ids.
- The worker sees their own entries.
- The committee sees anchors and counts.
- A full export is made only for an audit run under the DPO [D].

**Engineering notes.**
- `crypto.subtle` needs a secure context (https or localhost). A deployment served over plain http cannot append or
  verify.
- The prototype keeps the log in memory in one browser. A production deployment needs three things [D] (§13 item 11):
  - a device-side log of disclosures from the device, such as an OH escalation release;
  - a server-side log of console and aggregate access in durable append-only storage;
  - device heads synchronised and anchored alongside the server head.

---

## 7. Aggregates and k-suppression

### 7.1 Minimum cell size per role

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| Role | Purpose | Minimum cell size k | Who is counted | Reason |
|---|---|---|---|---|
| HSE manager | Safety alerting | 5 | all workers (employer legal duty) | HSE managers see site status as aggregates (cells below k = 5 suppressed), never individual records. |
| HSE manager | Operational planning | 5 | all workers (employer legal duty) | HSE managers plan from site aggregates (cells below k = 5 suppressed), never individual records. |
| HSE manager | Compliance reporting | 5 | all workers (employer legal duty) | HSE managers see compliance and incidents as aggregates (cells below k = 5 suppressed), never individual records. |
| Regulator (ADPHC / ADOSH) | Compliance reporting | 10 | all workers (employer legal duty) | Regulators see multi-site aggregates and compliance with cells below k = 10 suppressed, never an individual record. |
| Regulator (ADPHC / ADOSH) | Public-health statistics | 10 | only workers with `aggregateStatistics` consent | Regulators see public-health aggregates (cells below k = 10 suppressed) counting only workers who consented to aggregate statistics. |
| Employer HR | Compliance reporting | 10 | all workers (employer legal duty) | Employer HR sees nothing individual: crew-level compliance aggregates only, with groups below 10 suppressed. |

**Where the k values come from.**
- k = 5 is the ARCHITECTURE §7 default. It is [ENG]: no standard in our research fixes k.
- k = 10 for employers comes from the research proposal "Suppress any group smaller than 10 workers" (§6.2 item 4) [D].
  The regulator uses the same value.
- The sources disagree on HSE managers (§13 item 2).

**Rules in `aggregateFor()`.**
- It never lowers a role's k. A larger k may be requested.
- Public-health statistics count only consenting workers.
- Compliance aggregates rest on the employer's legal duty (PDPL Art. 4) [S, S61].

### 7.2 How suppression works (`aggregate()`)

- **Cell size counts people.** With `groupBy.subject`, a cell's size is the number of distinct individuals, not records.
- **Primary suppression.** Any cell with 1 to k − 1 individuals is hidden, including the row, column and grand totals.
- **Complementary suppression.**
  - Every hidden cell is placed on a cycle of hidden cells in the extended table, totals included.
  - Adding +1 and −1 alternately around the cycle changes no published number and keeps every count non-negative. Each
    hidden cell therefore has at least three values consistent with what is published.
  - A cheapest-path search picks the complements and prefers small inner cells over totals [ENG].
- **Zero cells** are never hidden and never used as complements.
- **No labels.** A hidden cell is published as `{ suppressed: true }`, with no count and no primary or complementary
  label, because the label would reveal that the value lies between 1 and k − 1.
- **Tested.** Across 400 random tables:
  - 0 small cells were left unsuppressed, margins included;
  - 0 published counts were wrong;
  - 0 hidden cells were recoverable from any linear combination of row and column totals.

### 7.3 Worked example

The example uses 69 workers in three crews, counted by level. The underlying counts, which are never published, are:

| Crew | safe | caution | high | stop |
|---|---:|---:|---:|---:|
| Crew A | 12 | 6 | 3 | 0 |
| Crew B | 9 | 7 | 5 | 2 |
| Crew C | 14 | 2 | 8 | 1 |

The two tables below show what an HSE manager (k = 5) and a regulator (k = 10) receive (■ = suppressed).

<!-- generated from src/engine/privacy.ts by Appendix A; do not edit by hand -->
| k = 5 | safe | caution | high | stop | Total |
|---|---:|---:|---:|---:|---:|
| Crew A | 12 | ■ | ■ | 0 | 21 |
| Crew B | 9 | 7 | ■ | ■ | 23 |
| Crew C | 14 | ■ | 8 | ■ | 25 |
| Total | 35 | ■ | 16 | ■ | 69 |

| k = 10 | safe | caution | high | stop | Total |
|---|---:|---:|---:|---:|---:|
| Crew A | ■ | ■ | ■ | 0 | 21 |
| Crew B | ■ | ■ | ■ | ■ | 23 |
| Crew C | 14 | ■ | ■ | ■ | 25 |
| Total | 35 | ■ | 16 | ■ | 69 |

**At k = 5, eight cells are hidden.**
- Five are primary: A-high (3), B-stop (2), C-caution (2), C-stop (1), and the stop total (3).
- Three are complements: A-caution (6), B-high (5), and the caution total (15).
- The published numbers leave a two-parameter family of solutions. For example, they are equally consistent with Crew A
  having 5 workers at caution and 4 at high.

**At k = 10, twelve cells are hidden.** Crew A's zero at stop stays visible, because zero cells are never hidden.

### 7.4 Limits of k-suppression

- **Homogeneity.** Suppression does not stop disclosure when every member of a group shares one category, because the
  visible zeros reveal it. For example, a row showing a crew of 12 entirely at stop tells the reader that everyone in that
  crew was at stop.
  - For levels this is operational information the crew's supervisor already sees. It would matter for any clinical
    dimension.
  - Mitigation [D]: symptoms, health factors and physiology are never used as table dimensions for HSE, HR or
    regulators. A group-disclosure rule (for example l-diversity) can be added if needed (§13 item 9).
- **Differencing across releases** [D].
  - Two tables over overlapping populations, for example before and after one worker joins a crew, can reveal one person
    by subtraction. Suppression within a single table does not prevent this.
  - Mitigation: fixed reporting periods and predefined tables, and no ad-hoc HR queries. The dimensions of every
    aggregate request are logged in the audit chain.
- **Small sites.** A crew smaller than k shows only site-level totals. This is intended.

---

## 8. Legal and standards mapping

This mapping follows the research notes (`context_and_commercial.md` §4, `twl_and_regulation.md` §2). Several government
hosts were unreachable during research, and the tags show how each point was verified.

| Instrument | Verification status | What it requires of Zill | How Zill responds |
|---|---|---|---|
| **UAE Personal Data Protection Law (PDPL)**, Federal Decree-Law 45/2021 | <ul><li>In force since 2 Jan 2022 [P, S64].</li><li>Article text known from secondary sources only [S, S61–S63].</li><li>Executive regulations: **UNVERIFIED**, treated as pending.</li></ul> | <ul><li>Health and biometric data are sensitive personal data [S, S62].</li><li>Consent must be specific, informed and unambiguous, provable, and withdrawable at any time [S, S62].</li><li>Art. 4 allows processing without consent for "occupational or preventive medicine", public health and statistics, among other cases [S, S61].</li><li>There is no legitimate-interests basis [S, S62].</li><li>Purpose limitation [S, S61].</li><li>A DPO is required for large-scale sensitive processing; the DPO may be external [S, S62].</li><li>A DPIA is required before high-risk processing with new technology (Art. 21) [S, S63].</li><li>Breaches must be notified to the Data Office and to data subjects, with no materiality threshold for data subjects [S, S62].</li><li>Transfers go only to "adequate" jurisdictions; the list is not yet published [S, S62].</li><li>Health data with its own legislation is excluded from the PDPL [S, S61, S62].</li></ul> | <ul><li>**Code:** consent scopes, receipts, withdrawal and the purpose matrix (§3–§4).</li><li>**Process:** DPIA (§11), DPO (§12), breach procedure.</li><li>**Contract:** C10, C11.</li></ul> |
| **ICT Health Law**, Federal Law 2/2019 (use of ICT in health fields) | Secondary sources only [S, S65, S66] | <ul><li>Art. 13 localisation: health data on services provided in the UAE may not be stored, processed, generated or transferred abroad unless an exception applies.</li><li>Ministerial Decision 51/2021 lists the exceptions and their conditions [S, S65].</li></ul> | <ul><li>Hosting in the UAE, with no offshore copies (§2.3).</li><li>Which regime applies needs legal confirmation [D]:<ul><li>inside a DoH-licensed OH service or a DoH-approved study, the ICT Health Law and ADHICS apply;</li><li>as employer safety software, the PDPL's sensitive-data rules apply.</li></ul></li><li>Zill is designed to satisfy both.</li></ul> |
| **DoH Standard for Biomedical Research (SBR)**, DoH/SD/HLSS/SBR/V1/2026 (Apr 2026; revision due Sept 2026, so check for a newer version) | [P, S70] | <ul><li>Covers observational studies and projects that collect personal health data.</li><li>Workers in a hierarchy are vulnerable participants, so supervisors must not obtain consent.</li><li>Trained research staff may take consent (§3.11.2.5).</li><li>Arabic and English consent documents with the same text (§3.5.3.2.4).</li><li>Non-exculpatory wording.</li><li>An impartial witness for participants who cannot read.</li><li>Compliance with the Responsible AI Standard (§3.1.2.3) and ADHICS (§3.1.2.4).</li><li>Data leaving the UAE only under MD 51/2021, encrypted (§3.3.1.1.11.3).</li><li>Insurance is mandatory for interventional trials (§3.7).</li></ul> | <ul><li>**Code:** the collector and witness rules and the notice version and language on every receipt (§4.3–§4.4).</li><li>**Process:** the pilot ethics plan (`docs/PILOT.md` §6).</li></ul> |
| **DoH Responsible AI Standard**, DoH/ST/DDGO/RAI/V1/2025 (Oct 2025; revision due Oct 2026) | <ul><li>Cover and scope seen via a search index [P via index, S68].</li><li>Clause text **UNVERIFIED**.</li></ul> | <ul><li>Applies to the DoH and all licensed healthcare entities.</li><li>Sets "minimum requirements to operationalizing responsible AI".</li><li>Adds transparency and explainability requirements [S, S69].</li><li>Points to ADHICS for cybersecurity.</li><li>Mandatory for DoH-approved studies (SBR §3.1.2.3).</li></ul> | <ul><li>AI governance controls (§10).</li><li>A clause-by-clause gap analysis once the text is obtained (§13 item 4).</li></ul> |
| **DoH Policy on the Use of AI in the Healthcare Sector** (2018) | [S, S69] | <ul><li>Six principles: transparency, user assistance, safety and security, privacy, ethics, accountability.</li><li>Regular audits of AI functionality, with reporting to the DoH.</li></ul> | <ul><li>§10.</li><li>The audit chain (§6).</li><li>`npm run validate` regenerates every evidence number.</li></ul> |
| **ADHICS V2**, DOH/SD/ICSO/ADHICS/V2/2024 (May 2024; effective Aug 2024) | <ul><li>[P via index, S67].</li><li>Clause text **UNVERIFIED**.</li></ul> | Applies to health-sector entities that store or process Abu Dhabi health information, including their use of third-party systems. | <ul><li>A DoH-licensed partner will require ADHICS-aligned controls from Zill as a third-party system: hosting, encryption, access control and logging.</li><li>Control mapping will be done once the text is obtained [D].</li></ul> |
| **UAE Charter for the Development & Use of AI** (Jul 2024) | [P, S71] | Twelve principles, including Algorithmic Bias (3), Data Privacy (4), Transparency (5), Human Oversight (6), and Governance and Accountability (7). | <ul><li>People confirm escalations.</li><li>Fairness monitoring.</li><li>A basis string on every rule.</li><li>The audit chain.</li><li>All in §10.</li></ul> |
| **UAE AI Ethics Principles and Guidelines** (Dec 2022) | Voluntary; the principle list is **UNVERIFIED** [S, S72] | — | Not relied on. |
| **ILO code of practice**, *Protection of workers' personal data* (1997) | [P, S73], quoted verbatim | Clause-by-clause mapping below. | Clause-by-clause mapping below. |
| **ILO C155** (1981), **C161** (1985), **C187**; ILC decision of 2022 | <ul><li>C155 and C161 text from secondary reproductions [S, S74, S75].</li><li>The 2022 decision making a safe and healthy working environment a fundamental principle [P, S76].</li><li>UAE ratification of C155, C161 and C187: **UNVERIFIED**. They are not among the nine conventions listed [S, S78].</li></ul> | <ul><li>C155 Art. 13: protects a worker who removes himself from imminent and serious danger.</li><li>C155 Art. 19(f): workers report imminent danger, and the employer cannot require a return while the danger continues.</li><li>C155 Art. 21: no OSH expenditure for workers.</li><li>C161 Art. 12: health surveillance is free and causes no loss of earnings.</li></ul> | <ul><li>**Code:** the worker can always self-declare stopping, and Zill never lowers protection.</li><li>**Contract:** C3, C4, C5.</li></ul> |
| **MoHRE**: Ministerial Resolution 44/2022 (midday break) | <ul><li>The instrument is cited on the u.ae working-hours page [P] (`twl_and_regulation.md`).</li><li>The article number is **UNVERIFIED**.</li><li>The penalties (AED 5,000 per worker, up to AED 50,000) come from secondary sources [S, S32].</li></ul> | No direct outdoor work in the sun from 12:30 to 15:00, 15 June to 15 September. | <ul><li>**Code:** the regulatory floor in the `abu-dhabi` rule pack (`src/engine/regulation.ts`) sets STOP for outdoor-in-sun tasks.</li><li>Exemptions are stored as data and never applied automatically (the protective default).</li><li>**Contract:** C6.</li></ul> |
| **ADOSH / ADPHC**: ADOSH-SF CoP 11.0 *Safety in the Heat* v4.0, Technical Guideline v4.0 (ADPHC, 15 Jul 2024), Mechanism 11.0 v4.0 | Transcribed from the primary PDFs [P] (`twl_and_regulation.md` §2) | <ul><li>TWL zones with work/rest and water schedules.</li><li>No unacclimatised workers and no lone work in the Medium and High zones.</li><li>A heat stress programme where 35 °C or more is foreseeable.</li><li>Serious incidents notified on Form G within 24 h for fatalities and within 3 working days for other serious incidents.</li></ul> | <ul><li>**Code:** `regulatoryFloor`, `heatStressProgramRequired` and `heatIncidentNotification` (reading heat cases under Schedule B is [ENG]).</li><li>**Process:** who files Form G is open (§13 item 10).</li></ul> |
| **Emirates Drug Establishment (EDE)**, Federal Decree-Law 38/2024 (in force 2 Jan 2025) | <ul><li>[S, S80–S82].</li><li>The statutory SaMD definition is **UNVERIFIED**.</li></ul> | A software as a medical device (SaMD) definition and four risk classes, I–IV [S, S81]. | Intended-purpose framing and claims discipline, with a written EDE opinion obtained before any physiological alerting (§9). |

**ILO code of practice, clause by clause** [P, S73]

| Clause | Requirement | Zill mechanism |
|---|---|---|
| 5.4 | Data collected for security and proper operation "should not be used to control the behaviour of workers". | Prohibited purposes (§5); contract C2 |
| 5.5 | "Decisions concerning a worker should not be based solely on the automated processing of that worker's personal data." | Zill makes no employment decisions; people confirm escalations (§10.2) |
| 5.6 | Monitoring data "should not be the only factors in evaluating worker performance". | Stricter: Zill data is never used in performance evaluation at all |
| 5.13 | "Workers may not waive their privacy rights." | Prohibited purposes are refused whatever the consent |
| 6.7 | Medical data only per national law and medical confidentiality, and only as needed. | Clinical data goes only to OH, for escalated cases, with consent (G7) |
| 6.14(1) | Workers are informed in advance of the reasons, schedule, methods and data, and the employer "must minimize the intrusion". | Consent notices (§4.2); on-device processing; 24 h purge; minimal payload (§2.4) |
| 6.14(3) | "Continuous monitoring should be permitted only if required for health and safety or the protection of property." | Wearable monitoring is opt-in, for health and safety only, and processed on the device |
| 8.2 | Medical data is stored only by personnel bound by medical secrecy, apart from other personal data. | OH-only clinical grant (G7); first aiders get symptoms only for an escalated case (G5) |
| 10.1 | No disclosure to third parties without explicit consent, except "to prevent serious and imminent threat to life or health". | Sharing consent for OH; vital-interest exception for symptoms (§4.6) |
| 10.2 | No disclosure "for commercial or marketing purposes" without consent. | Contract C2: no sale or marketing use, no insurer access |
| 10.8–10.9 | The employer receives only conclusions, with "no information of a medical nature". | Supervisor sees level and actions; HR sees aggregates only |
| 12.2 | Workers' representatives are informed and consulted before any electronic monitoring is introduced. | Worker safety committee consulted before launch (§12) |

**Worker voice in the UAE.** Trade unions are "banned or restricted" in Gulf states [P, S24]. Zill therefore uses a
substitute voice mechanism [D]: an elected worker safety committee at each site, and an independent ombudsperson channel
in the workers' languages.

---

## 9. Device status and claims framing

**Regulator.**
- The Emirates Drug Establishment regulates medical products under Federal Decree-Law 38/2024, in force since 2 January
  2025.
- MOHAP's services were transferred to EDE, with completion reported on 29 December 2025 [S, S80–S82].
- The UAE uses four risk classes, I–IV [S, S81]. The verbatim statutory definition of software as a medical device could
  not be retrieved (UNVERIFIED).

**Reference points.**
- The EU device definition includes software intended for "prevention, monitoring, prediction, prognosis" of disease
  (MDR Art. 2(1)) [P, S79].
- Wellness apps "without diagnostic capabilities" typically need no approval in the UAE [S, S81].
- The US FDA revised its General Wellness guidance on 6 January 2026 [S, S83].

**Intended-purpose statement.** This is the research recommendation [D]. Use it verbatim in the product, contracts and
pitch:

> *Zill is occupational safety software. It helps employers and workers apply the heat-stress controls set out in UAE
> occupational safety rules: the MoHRE midday break, and ADPHC/OSHAD Thermal Work Limit work-rest and hydration
> schedules. It converts site environmental measurements and forecasts into work-rest and hydration schedules. It
> delivers multilingual safety instructions. It records worker-reported symptoms in order to trigger the employer's
> first-aid and escalation procedure. Zill does not diagnose, treat, monitor or predict any disease or medical condition
> in an individual, and it is not a substitute for first aid or medical care.*

**How the prototype keeps to it.**
- The environment, regulation and projection channels implement published occupational standards.
- The symptoms channel turns reported symptoms into first-aid actions using published first-aid consensus (ACSM 2023,
  ILCOR, TB MED 507).
- The lowest level is labelled "Low risk", not "Safe".
- ECTemp is presented as an *estimated strain indicator* with an uncertainty band, shown only to the worker and to
  consented OH.
- Physiology never triggers a 998 call on its own.

**The wearable channel** (ECTemp, PSI and heart-rate limits) is the part that moves Zill towards "monitoring" and
"prediction". It stays off in production deployments until three conditions are met [D]:
1. the hardware is cleared by the FDA or CE-marked for that purpose;
2. EDE has given a written qualification and classification opinion;
3. if EDE requires it, the channel has been run as a DoH-approved study.

It is not part of the pilot intervention (`docs/PILOT.md` §5).

| Claims to avoid | Claims that are fine |
|---|---|
| "predicts heat stroke", "detects heat exhaustion" | "implements ADPHC TWL work-rest schedules" |
| "estimates core body temperature", "measures core temperature" | "schedules rest and hydration" |
| "screens fitness for work" | "escalates symptom reports to your first aider" |
| "prevents kidney disease" | "compliance log for the MoHRE midday break" |
| any individual risk score presented as a medical risk | "estimated strain indicator, shown with its uncertainty" |

**Clinical sign-off.** Every [ENG] clinical value needs sign-off by a UAE-licensed occupational physician and prospective
validation in Gulf workers before field use. Examples are the ECTemp thresholds of 38.0, 38.4 and 39.0 °C, the 30-minute
warm-up, the re-check intervals, the 250 mL every 20 minutes reminder, and the default age of 50 when age is unknown.

**Intellectual property.** ECTemp (US 10,702,165 B2), its sigmoid refinement (US 12,426,839 B2) and aPSI
(US 11,564,579 B2) are patented. Commercial use of the wearable channel needs a USARIEM licence and legal review.

**Emergency number.** 998 is written into all eight languages (u.ae, last updated 1 Oct 2026). It is re-verified at
each release.

---

## 10. AI governance

### 10.1 What kind of system Zill is

Zill is a deterministic implementation of published standards:
- outdoor WBGT (ISO 7243 with Liljegren 2008);
- ISO 7933 Predicted Heat Strain;
- the NIOSH limits for acclimatised and unacclimatised workers (REL and RAL);
- ACGIH clothing adjustments;
- the Thermal Work Limit with the ADOSH zones;
- the MoHRE midday break.

It also uses two published physiological estimators, the Buller 2013 ECTemp Kalman filter and the Moran 1998 PSI, and a
symptom triage table taken from published first-aid consensus.

There is no machine-learned model in the alerting path:
- Channels are fused by taking the maximum.
- Health factors are yes/no and never summed into a score.
- Zill introduces no new opaque score (ARCHITECTURE §1 principle 2).

Every output can therefore be explained by construction. We still apply AI-governance controls, because the DoH
Responsible AI Standard and the UAE AI Charter are written broadly enough to cover automated decision support in health
settings [D].

### 10.2 Human oversight: no automated disciplinary decisions

- **No employment decisions.** Zill never decides anything about a worker's employment, and the data path for such uses
  is blocked in code (§5).
- **Zill can only add protection.**
  - The physiology channel can raise a level but never lower it.
  - Missing or stale data makes the result more conservative.
  - The regulatory floor is never undercut.
- **Escalations reach people.**
  - A STOP not acknowledged within 2 minutes escalates to the supervisor and the buddy.
  - A STOP driven by symptoms or physiology reaches the first aider at once.
  - An EMERGENCY alerts the supervisor, the first aider and OH at once, with the 998 prompt.
  - Each alert keeps a durable record of when it was escalated and of every acknowledgement, by role and time
    (ARCHITECTURE §6).
- **Some levels latch.** STOP and EMERGENCY levels driven by symptoms or physiology stay on until a first aider or
  supervisor resolves the case after a symptom-free re-check. After a T2 or T3 symptom tier, the worker does no more hot
  work that day.
- **The worker can always stop.** The worker view is specified with an SOS and a self-declared stop (ARCHITECTURE §9;
  research §4.3; C155 Art. 13). No sensor reading overrides it.

### 10.3 Transparency

- **Drivers with a basis.** Every level carries its drivers, and every driver carries a `basis` string, for example
  "ADOSH-SF CoP 11.0 v4.0 Table 1" or "ISO 7933:2023". The UI shows these through an info tip.
- **Non-clinical text for supervisors.** Driver text shown to supervisors must be non-clinical (`RiskDriver.text` in
  `types.ts`).
- **Site condition or personal alert.** Each alert carries its basis, exposure or individual (§3.4), so a supervisor can
  tell a site-wide heat condition from an alert about one worker without learning why that worker was alerted. The role
  views do not show the basis yet (LIMITATIONS E-04).
- **Reasons for access decisions.** Every access decision states its reason (`explain()`).
- **Data-flow inspector.** It shows exactly what leaves the device (`inspectSyncPayload()`).
- **Evidence view.** It states the data source of every metric: reference implementation, real weather, archived
  forecasts or simulated cohort. Projections are labelled as projections (ARCHITECTURE §1 principle 7).

### 10.4 Contestability [D, partly built]

- **What the worker can see** (built). A worker can see their full record (G1) and every access to it (`forSubject()`).
- **What the worker can dispute:** a level or instruction, an access to their data, or a consent record.
  - The channel is the site worker safety committee or an independent ombudsperson, in the worker's language.
  - OH reviews disputes about a level, using the driver trace.
  - The DPO reviews disputes about an access, using the audit chain.
- **Rest first, review afterwards.** A disputed alert is never resolved in the moment by lowering protection. This
  follows ARCHITECTURE principle 3.
- **Corrections.** Health factors can be edited by the worker. A consent record is corrected by issuing a new receipt,
  because receipts are immutable.

### 10.5 Fairness monitoring

**What can go wrong:**
- thresholds derived from studies outside the Gulf (ECTemp has no prospective validation in Gulf workers);
- machine-assisted translations;
- unequal access to phones and wearables;
- literacy;
- women workers: Arabic texts default to masculine forms, and sex enters the heat-strain model;
- age, through the "heart rate > 180 − age" rule and the default age of 50;
- acclimatisation status.

**Simulation** (ARCHITECTURE §8; `docs/SIMULATION.md` §5). Every metric is broken down by acclimatisation status, age
band, clothing and PPE, body size, and language support.

**Pilot** (research §4.3 and §6.5; `docs/PILOT.md` §5):
- weekly active share by language group;
- alert, false-alarm and adherence rates by language group and age band;
- acceptability measured in four or more languages.

**Nationality.** The research suggests reporting by nationality group, but Zill does not store nationality. Proposal:
use preferred language as the operational proxy, and collect nationality only through an optional research survey held
by research staff and reported with k-suppression (§13 item 8).

The results go to the worker committee and feed the change process in §10.6.

### 10.6 Model change control [D]

**Standing rules.**
- Every threshold, model and constant carries a citation or an [ENG] or [ASSUMPTION] tag. UNVERIFIED marks stay until
  the point is resolved.
- Rule packs are versioned data. Each records its id, instrument, version, date and basis, for example
  `abu-dhabi`: ADOSH-SF CoP 11.0 v4.0, 15 July 2024.

**Change procedure:**
1. **Proposal.** State the source and why the change moves in the protective direction.
2. **Reference tests.** The change must keep agreement with the oracle fixtures (pythermalcomfort, thermofeel and the
   published tables). The wave-1 engine has 869 tests.
3. **Evidence regeneration.** Run `npm run validate` and review the changes in the evidence numbers.
4. **Safety review.**
   - No change may take protection below the regulatory floor; `regulatoryFloor` enforces this in code.
   - Clinical [ENG] values need sign-off by a UAE-licensed occupational physician.
5. **Language review.** Every changed string gets native-speaker review and back-translation (the `isDeployable()` gate).
6. **Consent impact.** If what a scope processes changes, bump `CONSENT_NOTICE_VERSION` and collect fresh consent.
   Receipts record which version each worker agreed to.
7. **Release record.** Record the version, changes, basis and test results. Share it with the worker committee. For
   DoH-licensed partners, report it as their AI policy requires [S, S69].
8. **During the pilot.** Only safety fixes are allowed. Each one is logged as a protocol deviation and reported to the
   research ethics committee.
9. **Regulatory watch.** Re-check the instruments with announced revisions: the Responsible AI Standard (due Oct 2026)
   and the SBR (due Sept 2026).

---

## 11. DPIA outline

The PDPL requires a DPIA (Art. 21) before high-risk processing with new technology. Two of the named cases apply to Zill:
"systematic and comprehensive assessment of the personal aspects" by automated processing (21(2)(a)), and "a large
volume of Sensitive Personal Data" (21(2)(b)) [S, S63]. **A Zill deployment triggers a DPIA.** The DPIA is structured as
follows:

1. **Description of the processing.** The activities (§4.1), the data (§2.1–§2.2), the recipients (§3), retention
   (§2.3) and hosting in the UAE.
2. **Necessity and proportionality.**
   - The protective core works without health data.
   - Health data is opt-in and processed on the device.
   - The payload is minimal and wider access is aggregate-only.
3. **Consultation.** The worker safety committee (ILO code §12.2), the DPO, the OH lead, and for the pilot the research
   ethics committee.
4. **Risks and mitigations** (table below).
5. **Sign-off.** The controller accepts the residual risks. The DPIA is reviewed before each season and whenever the
   processing changes, for example when wearables or voice check-ins are added.

| # | Risk | Mitigation (Code / Contract / Process) | Residual |
|---|---|---|---|
| R1 | Function creep: heat data used for discipline, pay or ranking | Prohibited purposes refused in code and logged; contract C2 and C9; committee report | Medium (misuse outside the system remains possible) |
| R2 | Clinical data reaches supervisors or HR | Matrix (§3); 0 leaks in 3,000 random snapshots; non-clinical reason text; filtering of confidential actions. Open: projection texts can carry the minutes-to-limit, a clinical field (§13 item 16) | Low (Medium until item 16 is fixed) |
| R3 | Health status inferred from a stricter schedule, an individual level or a water figure | Conservative mode also covers new and returning workers; generic reason texts; contract C3 bars action on inferred health. Open: a fasting worker's 0 mL/h water figure and the restricted-drinking recovery text (§13 item 18) | Medium |
| R4 | Re-identification from aggregates | k = 5 / 10; complementary suppression; no clinical dimensions; fixed reporting periods | Low–Medium (homogeneity, differencing, §7.4) |
| R5 | Coerced or uninformed consent | Collector rule in code; research staff or OH collect consent; witnessed mark; eight languages; the core works without consent; no penalty for refusal | Medium (the power imbalance remains) |
| R6 | Symptoms under-reported for fear of consequences | Non-retaliation clause C3; data controlled by the worker; buddy reporting | Medium |
| R7 | A missed danger (false reassurance) | Fail-safe defaults; physiology can only raise a level; symptoms override models; regulatory floor; people in the loop | Medium (model limits; the pilot measures this) |
| R8 | Alert fatigue leading to ignored alerts | Crew bundling, dwell time and hysteresis, repeat suppression, the exposure/individual alert basis (ARCHITECTURE §6); false-alarm endpoint in the pilot. The simulated cohort still shows a high burden (VALIDATION-COHORT §3.7) | Medium |
| R9 | A lost or compromised phone | Minimal data on the device; physiology purged after 24 h; secure context; for employer-issued devices, device encryption and device management [D] | Low–Medium |
| R10 | A breach of the gateway or server | The server holds pseudonymous level history and aggregates only; UAE hosting; encryption; ADHICS-aligned controls; PDPL breach notification (C11) | Low |
| R11 | Unlawful cross-border transfer | UAE hosting; no offshore copies without an MD 51/2021 basis (C10) | Low |
| R12 | Audit log tampered with or deleted | Hash chain; published anchors; committee-held exports (§6) | Low |
| R13 | Exclusion by language or literacy | Eight languages, voice and pictograms; deployment gated on reviewed translations; witnessed consent | Medium |
| R14 | Location tracking | Location only for an active case; not in the payload; no history | Low |
| R15 | Access by insurers or immigration authorities | Prohibited purposes; ICT Health Law localisation; contract C2 | Low |
| R16 | Misclassification as a medical device, or misleading claims | Intended-purpose statement; claims discipline; written EDE opinion before physiological alerts (§9) | Low–Medium |
| R17 | Access by the operator's (Zill's) staff | No vendor role in the matrix; infrastructure access logged; processor agreement [D] | Low–Medium |

---

## 12. Accountability [D]

| Role | Who | Responsibilities |
|---|---|---|
| Controller | The employer, for a deployment. For the pilot, the study sponsor and/or the employer, as agreed with the research ethics committee and counsel (§13 item 13). | Lawful basis, DPIA, breach notification, the contract terms in §5.3 |
| Processor | The Zill operator | Hosting in the UAE, security controls, processor agreement, no access to individual records |
| Data Protection Officer | External DPO allowed; need not be based in the UAE [S, S62] | DPIA review, access disputes, audit-log exports, breach handling |
| Clinical data custodian | OH lead (bound by medical secrecy) | Clinical records from escalations, clinical sign-off of [ENG] values, break-glass policy if adopted |
| Site worker safety committee | Elected worker members | Consultation before launch, receiving audit anchors, the annual governance report, a route for disputes |
| Independent ombudsperson | Outside the employer's line management, speaks the workers' languages | Confidential complaints and contests |
| Independent safety monitor (pilot) | A site physician independent of the sponsor | Reviews safety events, recommends pausing the pilot |

---

## 13. Open governance decisions

| # | Decision needed | Current state | Recommendation [D] | Owner |
|---|---|---|---|---|
| 1 | **Break-glass access:** should OH see clinical detail without consent in an emergency? | None. Emergency information reaches the first aider as reported symptoms on escalation (vital interest, ILO code §10.1). | Keep none for the pilot. If adopted later, limit it to an active EMERGENCY, log a mandatory reason, notify the worker, and have the DPO and committee review it after the event. | OH lead, DPO, research ethics committee |
| 2 | **k for HSE managers** | k = 5 (ARCHITECTURE §7 [ENG]). The research proposes 10 for employers [D]. | Keep 5 for on-site operational views, which contain no individual record. Use 10 for any report that leaves the site. | Product, DPO, committee |
| 3 | **Anchoring the audit head with the worker committee** | `head()` and `verify(anchor)` exist; nothing is published yet. | Weekly printed anchor on the site board during the season, plus every anchor in the annual report. Treat a mismatch as a suspected breach. | DPO, committee |
| 4 | **Which law applies** (PDPL, ICT Health Law, or both); RAI Standard and ADHICS clause mapping | Designed to satisfy both [D]. Clause texts not retrieved. | Written opinion from UAE counsel. Clause-by-clause gap analysis once DoH texts are obtained. | Counsel |
| 5 | **Retention periods** for check-in answers (no purge in code), the audit log and consent receipts | Only raw physiology (24 h) and level history (30 days) are implemented. | Check-ins: align with level history (30 days) unless OH needs them for an escalated case. Audit log and receipts: keep for the processing period plus a dispute window set by counsel. | Privacy owner, DPO |
| 6 | **Need-to-know scoping** | Buddy and crew checks run only when `buddyIds` / `actorCrewIds` are passed (`src/engine/privacy.ts:775`, `:780`). | Make them mandatory in production builds. | Integrators |
| 7 | **Consent ordering when offline** | `ConsentState` has one `updatedAt` (`src/engine/types.ts:139`). | The per-scope receipt ledger is authoritative; resolve conflicts by receipt time and sequence. | Privacy owner |
| 8 | **Fairness by nationality vs. not storing nationality** | Zill stores the preferred language only. | Use language as the proxy. Collect nationality only through an optional, consented research survey reported with k-suppression. | Research lead, committee |
| 9 | **Homogeneity rule** | Not implemented (§7.4). | No clinical dimensions in aggregates. Add l-diversity if clinical tables are ever needed. | Privacy owner |
| 10 | **Who files ADOSH Form G**, and with which data | `heatIncidentNotification()` computes the duty. HSE managers see aggregates only. | OH or the first-aid lead, who see the escalated case, file it. The HSE manager is told that a notifiable incident occurred, without clinical detail. | OH lead, HSE |
| 11 | **Where the audit log lives in production** | In memory in the prototype. | Device log of releases plus server log of console and aggregate access, in durable append-only storage, with device heads synchronised and anchored. | Architecture |
| 12 | **Enabling the wearable channel in production** | Built and consent-gated; not in the pilot. | Requires a written EDE opinion, cleared hardware and a USARIEM licence for ECTemp/aPSI (§9). | Product, counsel |
| 13 | **Controller identity in the pilot**, and processor terms | Not set. | Decide with the research ethics committee and counsel before the protocol is submitted. | Sponsor, employer |
| 14 | **Transparency of legal-duty aggregates** | Closed in code: `GENERAL_PRIVACY_NOTICE` (`src/engine/privacy.ts`) states that operational and compliance aggregates count everyone, suppressed below k, in all eight languages (`i18n.test.ts` › "the general privacy notice exists in all 8 languages; English equals GENERAL_PRIVACY_NOTICE exactly"). The translations are machine-assisted drafts. | Native-speaker review with the other texts (LIMITATIONS T-01). | Privacy owner, i18n |
| 15 | **One consent text of record** | The English on-screen consent strings equal `CONSENT_NOTICES` exactly, versioned by `CONSENT_TEXT_VERSION` (`i18n.test.ts` › "every CONSENT_NOTICES id has a title and statement in all 8 languages; English equals the notice text exactly"). A receipt records the notice version, the English title and statement, and the language shown. | Add a hash of the exact translated text shown to each receipt, and review the translations (LIMITATIONS T-01). | Privacy owner, i18n |
| 16 | **Minute counts in projection texts** | `minutesToLimit` is a clinical field (§2.1). `drivers_nonclinical` strips a projection driver's `value` and `unit` when `minutesToLimit` is withheld, but copies its text, and some texts contain the number ("about N min to the … limit", the rest estimate, the work-bout countdown). An individual projection alert can use the same text as its reason (LIMITATIONS G-05). | Replace a projection text with its generic `driver.<id>` phrase whenever `minutesToLimit` is withheld, both in `privacy.ts` and in the alert reason. | Privacy owner, alerts owner |
| 17 | **Escalated from raise** | A symptom- or physiology-driven stop is marked escalated when it is raised, so the first aider sees reported symptoms at once and OH sees the case (§3.4; LIMITATIONS G-06). | Confirm under the vital-interest basis (§4.6), or limit the release to the first aider until the stop is acknowledged or times out. | Privacy owner, OH lead |
| 18 | **Fasting inferable by supervisors** | While a worker who declared fasting is fasting, the sync payload carries a water figure of 0 mL/h, and the recovery text after a reached water-loss limit differs when drinking is restricted. Fasting is a declared risk flag, which supervisors must not see (§3.4; LIMITATIONS G-07). | Send the crew's water schedule (or no figure) instead of 0 for that worker, and use one recovery wording for both cases on supervisor screens. | Privacy owner, engine owner |

---

## Appendix A. Regenerating the tables

The tables marked *generated* come from the live code (`ACCESS_MATRIX`, `FIELD_INFO`, `CONSENT_NOTICES`,
`activeProcessing()`, `PROHIBITION_BASIS`, `inspectSyncPayload()`, `aggregate()`), not from hand-typing. They were last
generated on 10 November 2026. Regenerate them whenever `src/engine/privacy.ts` changes:
1. Save the script below as `governance-tables.ts` in the project root.
2. Run `npx tsx governance-tables.ts`.
3. Paste each block over the table with the same marker.
4. Delete the script.

<details>
<summary>governance-tables.ts</summary>

```ts
import {
  ACCESS_MATRIX, AGGREGATE_CONSENT, CONDITION_TEXT, CONSENT_NOTICES, CONSENT_SCOPES, DATA_FIELDS,
  FIELD_CONSENT_DEPENDENCY, FIELD_INFO, PROHIBITION_BASIS, PURPOSE_LABELS, ROLE_LABELS, SYNC_PAYLOAD_KEYS,
  activeProcessing, aggregate, inspectSyncPayload, isProhibitedPurpose, type Grant,
} from './src/engine/privacy'
import type { DataField, Purpose, Role, RiskAssessment, WorkerProfile } from './src/engine/types'

const out: string[] = []
const p = (s = '') => out.push(s)
const roles = Object.keys(ACCESS_MATRIX) as Role[]
const purposes = Object.keys(ACCESS_MATRIX.worker) as Purpose[]
const permitted = purposes.filter((x) => !isProhibitedPurpose(x))
const prohibited = purposes.filter((x) => isProhibitedPurpose(x))
const code = (s: string) => '`' + s + '`'
const COND_SHORT: Record<string, string> = {
  is_self: 'self', is_buddy: 'paired buddy', in_actor_crew: 'own crew',
  active_case: 'active STOP/EMERGENCY case', escalated: 'escalated case', medic_sharing_consent: 'sharing consent',
}
const sig = (g: Grant) => g.fields.join(',') + '|' + g.requires.join('+')
const grantIds = new Map<string, { id: string; grant: Grant; cells: string[] }>()
for (const role of roles)
  for (const purpose of permitted)
    for (const g of ACCESS_MATRIX[role][purpose].grants) {
      if (!grantIds.has(sig(g))) grantIds.set(sig(g), { id: `G${grantIds.size + 1}`, grant: g, cells: [] })
      grantIds.get(sig(g))!.cells.push(`${role}×${purpose}`)
    }
function describe(fields: readonly DataField[]): string {
  if (fields.length === DATA_FIELDS.length) return `all ${fields.length} fields`
  const clinical = fields.filter((f) => FIELD_INFO[f].class === 'clinical').length
  if (fields.length <= 2) return fields.map(code).join(', ')
  return clinical === 0 ? `${fields.length} non-clinical fields` : `${fields.length} fields (${clinical} clinical)`
}
for (const role of roles)
  for (const purpose of prohibited) {
    const r = ACCESS_MATRIX[role][purpose]
    if (r.grants.length || r.aggregateMinCell !== null) throw new Error(`prohibited cell not empty: ${role}×${purpose}`)
  }

p('<!-- generated:matrix -->')
p(`| Role | ${permitted.map((x) => PURPOSE_LABELS[x]).join(' | ')} | ${prohibited.length} prohibited purposes |`)
p(`|---|${permitted.map(() => '---').join('|')}|---|`)
for (const role of roles) {
  const cells = permitted.map((purpose) => {
    const r = ACCESS_MATRIX[role][purpose]
    const parts = r.grants.map((g) => `${grantIds.get(sig(g))!.id}: ${describe(g.fields)}, ${g.requires.map((c) => COND_SHORT[c]).join(' + ')}`)
    if (r.aggregateMinCell !== null)
      parts.push(`aggregates only, k = ${r.aggregateMinCell}${AGGREGATE_CONSENT[purpose] ? ' (consenting workers only)' : ''}`)
    return parts.length ? parts.join('; ') : '—'
  })
  p(`| **${ROLE_LABELS[role]}** | ${cells.join(' | ')} | refused |`)
}
p('\n<!-- generated:grants -->')
p('| Grant | Fields released | Only when (all must hold) | Consent-gated fields | Cells (role × purpose) | Why |')
p('|---|---|---|---|---|---|')
for (const { id, grant, cells } of grantIds.values()) {
  const fields = grant.fields.length === DATA_FIELDS.length ? `all ${grant.fields.length} fields` : grant.fields.map(code).join(', ')
  const gated = grant.fields.filter((f) => FIELD_CONSENT_DEPENDENCY[f]).map((f) => `${code(f)} → ${code(FIELD_CONSENT_DEPENDENCY[f]!)}`)
  const byRole = new Map<string, string[]>()
  for (const c of cells) {
    const [role, purpose] = c.split('×') as [Role, Purpose]
    byRole.set(ROLE_LABELS[role], [...(byRole.get(ROLE_LABELS[role]) ?? []), PURPOSE_LABELS[purpose].toLowerCase()])
  }
  const cellText = [...byRole].map(([r, ps]) => `${r}: ${ps.join(', ')}`).join('; ')
  p(`| ${id} | ${fields} | ${grant.requires.map((c) => CONDITION_TEXT[c]).join('; ')} | ${gated.join(', ') || '—'} | ${cellText} | ${grant.reason} |`)
}
p('\n<!-- generated:aggregates -->')
p('| Role | Purpose | Minimum cell size k | Who is counted | Reason |')
p('|---|---|---|---|---|')
for (const role of roles)
  for (const purpose of permitted) {
    const r = ACCESS_MATRIX[role][purpose]
    if (r.aggregateMinCell === null) continue
    const consent = AGGREGATE_CONSENT[purpose]
    p(`| ${ROLE_LABELS[role]} | ${PURPOSE_LABELS[purpose]} | ${r.aggregateMinCell} | ${consent ? `only workers with ${code(consent)} consent` : 'all workers (employer legal duty)'} | ${r.reason} |`)
  }
p('\n<!-- generated:prohibited -->')
p('| Purpose | Refusal text (shown to the requester and logged) | Basis recorded in code |')
p('|---|---|---|')
for (const purpose of prohibited) {
  const b = PROHIBITION_BASIS[purpose as keyof typeof PROHIBITION_BASIS]
  p(`| ${PURPOSE_LABELS[purpose]} (${code(purpose)}) | ${b.reason.replace(/^'[^']+' is a prohibited purpose: /, '')} | ${b.basis} |`)
}
p('\n<!-- generated:fields -->')
p('| Field | Label | Class | Consent scope needed | In sync payload | Who can ever receive it (condition; purposes) |')
p('|---|---|---|---|---|---|')
const payloadKeys = new Set<string>(SYNC_PAYLOAD_KEYS as readonly string[])
for (const f of DATA_FIELDS) {
  const recips = new Map<string, Set<string>>()
  for (const role of roles)
    for (const purpose of permitted)
      for (const g of ACCESS_MATRIX[role][purpose].grants)
        if (g.fields.includes(f)) {
          const k = `${ROLE_LABELS[role]} (${g.requires.map((c) => COND_SHORT[c]).join(' + ')})`
          recips.set(k, (recips.get(k) ?? new Set()).add(PURPOSE_LABELS[purpose].toLowerCase()))
        }
  const text = [...recips].map(([k, ps]) => (ps.size === permitted.length ? k : `${k}; ${[...ps].join(', ')}`)).join(' · ')
  const inPayload = payloadKeys.has(f) ? 'yes' : f === 'ackStatus' ? 'yes (as `ack`)' : 'no'
  p(`| ${code(f)} | ${FIELD_INFO[f].label} | ${FIELD_INFO[f].class} | ${FIELD_CONSENT_DEPENDENCY[f] ? code(FIELD_CONSENT_DEPENDENCY[f]!) : '—'} | ${inPayload} | ${text} |`)
}
p('\n<!-- generated:consent -->')
p(`| Scope | What the worker agrees to (notice v${CONSENT_NOTICES.wearable.version}) | Data processed | Who sees it | Retention |`)
p('|---|---|---|---|---|')
for (const s of CONSENT_SCOPES) {
  const n = CONSENT_NOTICES[s]
  p(`| ${code(s)} | **${n.title}.** ${n.statement} | ${n.dataProcessed} | ${n.whoSees} | ${n.retention} |`)
}
p('\n<!-- generated:processing -->')
p('| Processing activity | Switched on by | Fields produced or disclosed | Legal basis recorded in code |')
p('|---|---|---|---|')
const none = { wearable: false, healthFlags: false, checkins: false, shareWithMedicOnEscalation: false, aggregateStatistics: false, updatedAt: 0 }
for (const a of activeProcessing(none))
  p(`| ${code(a.id)}: ${a.description} | ${a.scope ? code(a.scope) + ' consent' : '**no consent needed** (always on)'} | ${a.fields.map(code).join(', ') || '— (counts only)'} | ${a.legalBasis} |`)

// Example payload (illustrative input values).
const profile: WorkerProfile = {
  id: 'W-7F3A', displayName: 'Example worker', crewId: 'musaffah-c2', siteId: 'musaffah', language: 'hi', ageYears: 34,
  daysOnSite: 30, daysAwayRecent: 0, experiencedInHeat: true, clothing: 'cloth_coveralls', riskFlags: [],
  consent: { ...none, wearable: true, checkins: true }, hasWearable: true,
}
const assessment: RiskAssessment = {
  workerId: 'W-7F3A', t: Date.UTC(2025, 6, 15, 6, 0), level: 'high', channels: [],
  drivers: [{ id: 'twl_medium', channel: 'regulation', text: 'TWL in the Medium zone', direction: 'raises', basis: 'ADOSH-SF CoP 11.0 v4.0 Table 1' }],
  actions: ['shade_breaks', 'drink_water', 'rotate_task', 'occ_health_review'], workMinPerHour: 45.7, minutesToLimit: 52,
  waterMlPerHour: 1183, confidence: 'medium', dataQuality: { env: 'forecast', physiology: 'good', network: 'online', stale: false },
}
const ins = inspectSyncPayload(assessment, profile, 'acknowledged')
p('\n<!-- generated:payload -->\n```json\n' + JSON.stringify(ins.payload, null, 2) + '\n```')
p(`bytes=${ins.bytes} keptOnDevice=${ins.keptOnDevice.join(', ')}`)

// Example aggregate (illustrative counts).
const counts: Record<string, Record<string, number>> = {
  'Crew A': { safe: 12, caution: 6, high: 3, stop: 0 },
  'Crew B': { safe: 9, caution: 7, high: 5, stop: 2 },
  'Crew C': { safe: 14, caution: 2, high: 8, stop: 1 },
}
const levels = ['safe', 'caution', 'high', 'stop']
const recs: { id: string; crew: string; level: string }[] = []
for (const [crew, row] of Object.entries(counts))
  for (const lv of levels) for (let i = 0; i < row[lv]; i++) recs.push({ id: `${crew}-${lv}-${i}`, crew, level: lv })
for (const k of [5, 10]) {
  const t = aggregate(recs, { row: (r) => r.crew, col: (r) => r.level, rows: Object.keys(counts), cols: levels, subject: (r) => r.id }, k)
  const c = (cell: { suppressed: boolean; count?: number }) => (cell.suppressed ? '■' : String(cell.count))
  p(`\n<!-- generated:aggregate k=${k} -->`)
  p(`| k = ${k} | ${levels.join(' | ')} | Total |`)
  p(`|---|${levels.map(() => '---:').join('|')}|---:|`)
  t.rows.forEach((r, i) => p(`| ${r} | ${t.cells[i].map(c).join(' | ')} | ${c(t.rowTotals[i])} |`))
  p(`| Total | ${t.colTotals.map(c).join(' | ')} | ${c(t.total)} |`)
  p(`suppressedCells=${t.suppressedCells}`)
}
console.log(out.join('\n'))
```

</details>
