/**
 * "What the simulation caught": the design flaws the closed-loop simulation and the independent safety reviews found
 * before any pilot, version by version. The narrative is condensed from the project's own records, each item citing its
 * source document; every number in the before/after table beside it is read from the three cohort files instead.
 */

export type FlawArea = 'Engine' | 'Planner' | 'Simulator' | 'Alerts' | 'Privacy' | 'Ground truth'

export interface Flaw {
  id: string
  title: string
  areas: readonly FlawArea[]
  /** Who or what found it, when the record says so. */
  foundBy?: string
  problem: string
  fix: string
  /** A measured consequence quoted from the source record. */
  evidence?: string
  /** The change moved the simulated world (baseline arms), not only Zill. */
  worldChange?: boolean
  source: { path: string; label: string }
}

export interface FlawStep {
  id: string
  from: string
  to: string
  summary: string
  flaws: readonly Flaw[]
}

const COHORT_DOC = { path: 'docs/VALIDATION-COHORT.md', label: 'VALIDATION-COHORT.md §3.8' }

export const FLAW_STEPS: readonly FlawStep[] = [
  {
    id: 'v01-v02',
    from: 'v0.1',
    to: 'v0.2',
    summary:
      'The first closed-loop cohort exposed four design flaws: two in the engine, one between the planner and the engine, one in the simulator. Each was fixed on a stated principle before the re-run, none to improve Zill’s numbers; the re-runs then caught two more.',
    flaws: [
      {
        id: 'water-latch',
        title: 'The water-loss limit ignored logged drinking',
        areas: ['Engine'],
        foundBy: 'Closed-loop simulation (cohort v0.1)',
        problem:
          'The ISO 7933 drink-allowed limit (a cumulative water loss of 5 % of body mass) took no account of what the worker drank, and a reached limit ended heat work for the rest of the shift. A worker who drank as the reminders asked could be stopped for the day on sweat loss alone.',
        fix: 'The limit became max(5 %, 3 % + credited intake) of body mass: exactly ISO 7933 without drink logs or consent, unchanged while drinking is restricted. With drinking allowed, a reached limit can restart after the reviewed recovery once the net loss is 2 % of body mass or less.',
        source: COHORT_DOC,
      },
      {
        id: 'hysteresis',
        title: 'No hysteresis, and a resume rule the device never showed',
        areas: ['Engine', 'Simulator'],
        foundBy: 'World-simulation traces',
        problem:
          'After a projection stop below 15 min, a rested worker’s projection rose to 15–16 min, the device dropped to HIGH, and the worker was stopped again within a minute. The simulator hid this with a 25-minute resume margin that no device had, so virtual workers rested on the simulator’s account while their device showed less than STOP.',
        fix: 'The engine holds the stop until the task to resume projects 25 min (15 + 10, an ANSI/ISA-18.2 deadband), estimates the rest still needed, says “not feasible now” with a rotate-task action when 60 min of rest would not do, and shows a work-bout countdown. The simulator’s private margin was removed.',
        evidence: 'Worker-minutes resting on the simulator’s account while the device showed less than STOP, peak-day scenario: 9.0 % → 0.',
        source: COHORT_DOC,
      },
      {
        id: 'plan-monitor',
        title: 'The plan and the monitor disagreed',
        areas: ['Planner', 'Engine', 'Simulator'],
        foundBy: 'Closed-loop simulation (cohort v0.1)',
        problem:
          'The planner set work/rest from the NIOSH/ACGIH and ADOSH allowances only, and the device’s ISO 7933 projection then stopped workers in the middle of planned work: 45 min/h of heavy welding in FR coveralls was planned where the projection allowed about 24–43 min. The simulator also over-worked partial windows.',
        fix: 'The planner screens every task-hour with the engine’s own ISO 7933 projection in the layout it will be executed in; the device caps its work minutes at the plan’s rate; the simulator executes the plan’s block-hour layout.',
        source: COHORT_DOC,
      },
      {
        id: 'double-drink',
        title: 'Drinks were counted twice',
        areas: ['Simulator'],
        foundBy: 'Scenario runs',
        problem:
          'A followed drink reminder added 250 mL on top of the spontaneous drink, and a 450 mL/h hot-shift drinking floor also applied during cooled rest. Virtual workers drank 9.6 L a day on the peak-day scenario (up to 18.25 L), two above the 11.36 L/day cap.',
        fix: 'A followed reminder is that minute’s drink, and spontaneous drinking tracks sweat loss above a habitual floor, decided before any re-run.',
        evidence:
          'Side effect, kept rather than tuned away: the old floor had hidden involuntary dehydration in the baseline arms, which rose sharply in v0.2 (flagged as a simulated-world change in the table).',
        worldChange: true,
        source: COHORT_DOC,
      },
      {
        id: 'zone-cycling',
        title: 'Unacclimatised workers cycled in zones that exclude them',
        areas: ['Engine', 'Simulator'],
        foundBy: 'v0.2 re-run',
        problem:
          'With the simulator’s margin gone, workers not acclimatised under ADOSH went stop → rest → resume → stop in TWL zones that exclude them, because the regulation channel’s stop dropped as soon as they rested: unacclimatised zone worker-hours rose from 7 to 39 and zone compliance fell from 97.8 % to 90.0 %.',
        fix: 'A rest episode also waits until the device’s own check of the task to resume shows no regulation or environment stop (8 worker-hours, 97.8 %). In v0.3 the engine owns this resume decision outright.',
        source: COHORT_DOC,
      },
      {
        id: 'relabel',
        title: 'Exposure alerts were re-labelled individual just before they resolved',
        areas: ['Alerts'],
        foundBy: 'v0.2 re-run (scenario)',
        problem:
          'During the de-escalation dwell every channel could already read safe, and the rule that keeps an alert individual took “no channel explains the level” for a new personal cause: 123 of 144 worker alerts on the peak-day scenario.',
        fix: 'A re-label now requires a channel that actually drives the level (2 of 144). Routing never depended on the label, so no notification changed.',
        source: COHORT_DOC,
      },
    ],
  },
  {
    id: 'v02-v03',
    from: 'v0.2',
    to: 'v0.3',
    summary:
      'The v0.2 cohort, its work-cost analysis and independent safety and privacy reviews found six more problems: in the planner, the engine, the supervisor view, the simulated drinking behaviour and the comparator itself. Two of the fixes changed the simulated world, so every baseline number moved.',
    flaws: [
      {
        id: 'strictest-member',
        title: 'A whole crew was bound to its strictest member',
        areas: ['Planner'],
        foundBy: 'Work-cost analysis of the v0.2 cohort',
        problem:
          'One worker who was not acclimatised, or in conservative mode, put the whole crew on the NIOSH RAL and the next-stricter work/rest tier: in the v0.2 cohort all 45 crew-days were planned that way.',
        fix: 'Plans are per person where the standards differ: the crew rate is for acclimatised members; members on an acclimatisation schedule get personal caps (shown to the supervisor only as “acclimatisation schedule: max N min/h”); conservative mode, fasting, consent state and monitoring fallback stay on the worker’s phone as pooled “device-directed rest”.',
        source: { path: 'docs/dev/work-cost-drivers.md', label: 'Work-cost drivers §4' },
      },
      {
        id: 'fasting-inference',
        title: 'Supervisor texts let fasting be inferred',
        areas: ['Privacy', 'Alerts'],
        foundBy: 'Privacy review (governance risk register)',
        problem:
          'For a worker who had declared fasting, the supervisor saw a different reason at the water-loss limit (“no more heat work this shift” instead of “drink and rest”), different actions and a 0 mL/h water figure; alert reasons also carried individual numbers such as minutes to the water-loss limit and metabolic rate.',
        fix: 'Supervisor-facing texts are pooled and carry no individual numbers (“device-directed rest”, “Not cleared for heat work now: assign cooler work”); hydration prompts and the individual water figure are not sent to supervisors; unknown reasons are denied by default. The worker’s own phone still says why.',
        source: { path: 'docs/dev/wave2d-governance.md', label: 'Wave 2d governance notes' },
      },
      {
        id: 'screen-guarantee',
        title: 'The planner’s screen guarantee did not hold',
        areas: ['Planner'],
        foundBy: 'Independent safety review probes',
        problem:
          'A plan was meant to be followable without a device stop, but the screen did not replay the device exactly: the probes found rest-only stretches in shade that reached the 5 % water-loss limit with no warning, and layouts the device projected at 14 min where the screen’s slightly different layout projected 15.',
        fix: 'The screen replays the device minute by minute (same projection cadence, a one-minute margin), re-places work until no cap falls, verifies the result, and screens rest stretches too: when rest alone would reach the limit, no work is planned and the plan says why.',
        source: { path: 'docs/dev/wave2d-planner.md', label: 'Wave 2d planner notes' },
      },
      {
        id: 'credit-cap',
        title: 'The drinking credit had no ceiling',
        areas: ['Engine'],
        problem:
          'The v0.2 water-loss limit rose with every logged drink, max(5 %, 3 % + credit) of body mass, with no upper bound: a worker who logged a lot could be allowed past the range where ISO 7933 is valid and sodium losses matter.',
        fix: 'The limit is min(7.5 %, max(5 %, 3 % + credit)) of body mass, the ISO 7933 maximum water loss for an average subject; electrolyte advice whenever the credit is in use; drinks logged more than 15 min away from the present earn no credit.',
        source: { path: 'docs/dev/wave2d-engine.md', label: 'Wave 2d engine notes' },
      },
      {
        id: 'drink-calibration',
        title: 'The simulated drinking model was not calibrated',
        areas: ['Ground truth'],
        foundBy: 'Independent safety review (rated medium)',
        problem:
          'The habitual drinking floor came from a daily-intake guideline, not a worksite observation: simulated midday-ban workers drank about 4.0 L per 12-h hot shift, so too many dehydrated and Zill’s dehydration benefit looked larger than it should.',
        fix: 'Calibrated before any re-run, on the midday-ban-only arm alone, to the observed 5.44 L per 12-h summer shift of UAE construction workers (Bates & Schneider 2008). The old floors remain as sensitivity variants. Matching total intake probably over-states drinking, which narrows, never widens, Zill’s simulated benefit.',
        worldChange: true,
        source: { path: 'docs/dev/wave2d-sim.md', label: 'Wave 2d simulation notes §1' },
      },
      {
        id: 'task-windows',
        title: 'The baselines worked outside task windows',
        areas: ['Simulator'],
        foundBy: 'Listed as limitation S-07',
        problem:
          'The midday-ban-only, site-index and shadow arms worked from 05:00 and ignored task windows, while Zill’s plan respected the 06:00 windows: the comparator got the coolest hour of the shift.',
        fix: 'Baseline crews honour task windows like the planner (work-conserving listed order; idle minutes count toward the statutory break). A baseline definition change: every baseline number moved.',
        worldChange: true,
        source: { path: 'docs/dev/wave2d-sim.md', label: 'Wave 2d simulation notes §4' },
      },
    ],
  },
]

export const FLAW_COUNT = FLAW_STEPS.reduce((n, s) => n + s.flaws.length, 0)
