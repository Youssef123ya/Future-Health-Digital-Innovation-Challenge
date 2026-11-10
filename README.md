# Zill (ظل, "shade")

**Worker-first heat-strain early warning for outdoor and industrial workers in Abu Dhabi.**
Future Health Digital Innovation Challenge — Challenge 07: Climate-Resilient Worker Health.

> Prototype under active development. Not a medical device. Simulated results are projections under stated
> assumptions, not measured health outcomes.

## What it does

Zill turns site weather, each worker's task and clothing, optional wearable data and simple symptom check-ins into one
graded warning level (safe, caution, high, stop) with a concrete action ("rest 15 min in the cooled cabin", "drink
250 mL", "call 998"). It does this per worker, in the worker's own language, with privacy built into the architecture.

- **Dynamic heat-risk assessment.** WBGT (Liljegren), ISO 7933:2023 Predicted Heat Strain projections, NIOSH REL/RAL and
  ACGIH work/rest limits, Thermal Work Limit, and the Abu Dhabi ADOSH-SF Code of Practice 11.0 v4.0 zones and midday
  break, combined in one risk engine with six channels: environment, regulation, projection, physiology, symptoms and
  hydration.
- **Graded, multilingual warnings.** Eight languages (Arabic, English, Hindi, Urdu, Bengali, Malayalam, Tagalog, Nepali),
  colour + pictogram + text, with an ANSI/ISA-18.2-style deadband so warnings do not flap.
- **Worker-first governance.** Clinical data stays on the worker's phone. Supervisors see a level, an action and a
  non-clinical reason only. Every access is checked against a role and purpose matrix and written to a hash-chained
  audit log. Consent is granular and revocable, and disciplinary use is prohibited.
- **Field-ready.** Works offline as a PWA. It degrades to protective defaults when the wearable, the site sensor, the
  forecast or the network fails.
- **Supervisor decision support.** A day planner screens each task-hour against the limits, moves heavy work to cooler
  hours and plans water and rest.
- **Measured, not asserted.** Reference agreement tests, six years of real Abu Dhabi weather, archived-forecast skill and
  a closed-loop simulated cohort whose ground truth comes from an independent physiological model (Gagge two-node), so
  the warning engine is never graded against itself.

## Status

| Part | State |
|---|---|
| Science engine (`src/engine`) | Implemented and tested |
| Simulation, back-test and simulated cohort (`src/sim`, `scripts/validate`) | Implemented and tested |
| Real-data validation (`scripts/validate`, `public/data/validation`) | Implemented |
| App state, privacy projection, audit, cross-tab sync (`src/state`) | Implemented and tested |
| Product screens (`src/ui/views`): supervisor console, worker phone, first aid, HSE/regulator, governance centre, lab, evidence | In progress |

The current simulated cohort (v0.2, 45 Abu Dhabi site-days, 333 worker-shifts per arm) projects no excessive heat-strain
events under Zill, against 87 per 1,000 worker-shifts with the midday ban alone and 57 per 1,000 under the ADOSH zone
policy. It also shows a large work cost (about two-thirds less work than the midday-ban baseline), driven by the day
planner. The next revision addresses that cost on stated principles (per-person limits, an opt-in monitored mode
following the ISO 7243 → ISO 7933 decision flow). Full tables and caveats: [docs/VALIDATION-COHORT.md](docs/VALIDATION-COHORT.md).

## Run it

Requires Node.js 22 or later.

```bash
npm install
npm run dev          # local app at http://localhost:5173
npm test             # unit and integration tests (Vitest)
npm run typecheck    # TypeScript strict mode
npm run validate     # reference agreement, real-weather exposure, forecast skill (about 1 minute)
npx tsx scripts/validate/cohort.ts --medium   # simulated cohort (several minutes)
```

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, risk channels, alerts, privacy boundary, sync |
| [SCIENCE.md](docs/SCIENCE.md) | The heat-stress models and standards, with citations |
| [GOVERNANCE.md](docs/GOVERNANCE.md) | Consent, access matrix, audit, retention, DPIA |
| [VALIDATION.md](docs/VALIDATION.md) | Reference agreement and real-weather evidence |
| [SIMULATION.md](docs/SIMULATION.md) | The closed-loop simulator and its non-circular ground truth |
| [VALIDATION-COHORT.md](docs/VALIDATION-COHORT.md) | Simulated cohort results, sensitivity and fairness |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations and open risks |
| [PILOT.md](docs/PILOT.md) | Pilot protocol and the measures it would collect |

## Data and attribution

Weather data from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0), including the ECMWF IFS and Copernicus ERA5
reanalysis (contains modified Copernicus Climate Change Service information). The free Open-Meteo tier is for
non-commercial use; a deployment would use a commercial weather licence.

## License

MIT — see [LICENSE](LICENSE).
