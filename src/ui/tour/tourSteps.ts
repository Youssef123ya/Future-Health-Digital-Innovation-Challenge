/**
 * The guided 2-minute demo: one scripted walk through the peak-day replay (Musaffah, 1 Aug 2025, the hottest day of
 * summer 2025) that touches every Challenge 07 criterion once — dynamic personal risk, a graded multilingual warning
 * with a safe action, supervisor decision support without clinical detail, a sensor and a network failure with the
 * safe fallback, escalation to first aid, worker-first governance, and the evidence. Each step names the screen, the
 * simulated time, which worker's phone is shown (and in which language), and what to spotlight.
 *
 * The times are chosen from the scenario's own timeline (sim/scenarios.ts peak-day events: sensor failure 11:00–11:30,
 * buddy-reported confusion 14:10, network outage 15:30–15:50). Pure data: tested in tour.test.ts.
 */
import type { LangCode } from '../../engine/types'
import type { ScenarioId } from '../../sim/scenarios'
import type { PolicyId } from '../../sim/types'
import type { SimSpeed } from '../../state'

/** Scenario and policy the tour runs on. */
export const TOUR_SCENARIO: ScenarioId = 'peak-day'
export const TOUR_POLICY: PolicyId = 'zill_full'

/** One step of the guided demo. */
export interface TourStep {
  id: string
  title: string
  /** One or two plain sentences, read in about ten seconds. */
  caption: string
  /** Which Challenge 07 criterion the step shows ("Your solution should …", 1–6). */
  criterion: { n: 1 | 2 | 3 | 4 | 5 | 6; label: string }
  /** Hash path of the screen. */
  path: '/demo' | '/medic' | '/governance' | '/evidence'
  /** Simulated local time to jump to ('HH:mm'); null keeps the clock where it is. */
  at: string | null
  /** Clock speed to play at during the step; null keeps the clock paused. */
  play: SimSpeed | null
  /** Worker on the demo phone and the phone's language (null: the worker's own language). */
  phone: { workerId: string; lang: LangCode | null } | null
  /** CSS selector of the element to spotlight (first match). */
  target: string | null
  /** Seconds on screen before the tour moves on by itself. */
  seconds: number
  /** Something the tour does once the screen is ready. */
  action?: 'submit_prohibited_request'
}

/** Spotlight targets (stable hooks in the views). */
export const TOUR_TARGETS = Object.freeze({
  phone: '[data-tour="demo-phone"]',
  phoneLevel: '[data-tour="demo-phone"] section[data-level]',
  board: 'section[aria-labelledby="crew-board-h"]',
  siteStatus: 'ul[aria-label="Site data status"]',
  medicEmergency: 'section[aria-label="Emergency"]',
  request: '#gov-request',
  evidence: 'nav[aria-label="Evidence sections"]',
})

export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: 'personal',
    title: 'Same heat, a personal limit',
    caption:
      'Bikash arrived two days ago for his first Gulf summer. His crew works in the same heat, but his phone gives him a lower limit and lighter, shaded work until he acclimatises — in Nepali, his own language.',
    criterion: { n: 1, label: 'Dynamic heat-risk assessment' },
    path: '/demo',
    at: '06:35',
    play: null,
    phone: { workerId: 'W-D2A1', lang: null },
    target: TOUR_TARGETS.phone,
    seconds: 13,
  },
  {
    id: 'graded',
    title: 'One level, one safe action',
    caption:
      'Shaji is a veteran welder, but his flame-resistant coveralls and hood trap heat, and Zill counts them. As the heat builds his warning grades up, always with a concrete action and how long to rest. Eight languages; this phone is in English.',
    criterion: { n: 2, label: 'Clear, graded, multilingual warnings' },
    path: '/demo',
    at: '10:02',
    play: 10,
    phone: { workerId: 'W-D2B2', lang: 'en' },
    target: TOUR_TARGETS.phoneLevel,
    seconds: 14,
  },
  {
    id: 'console',
    title: 'Supervisors see what to do, never why',
    caption:
      'The crew board shows each worker’s level and the action to take — no heart rate, symptoms or water. “Not cleared for heat work now” covers fasting, medication or consent alike, so nothing private can be inferred.',
    criterion: { n: 5, label: 'Supervisor decision support' },
    path: '/demo',
    at: '10:06',
    play: null,
    phone: { workerId: 'W-D2B2', lang: 'en' },
    target: TOUR_TARGETS.board,
    seconds: 14,
  },
  {
    id: 'sensor',
    title: 'A sensor fails: advice gets more careful',
    caption:
      'At 11:00 the site environment feed drops. Phones keep the cached forecast and fall back down a fail-safe chain: a missing input can only make the advice more conservative, never less.',
    criterion: { n: 4, label: 'Field-ready, safe fallback' },
    path: '/demo',
    at: '11:04',
    play: null,
    phone: { workerId: 'W-D2B2', lang: 'en' },
    target: TOUR_TARGETS.siteStatus,
    seconds: 12,
  },
  {
    id: 'redflag',
    title: 'A red flag becomes an emergency in a minute',
    caption:
      'Ramesh’s buddy reports that he is confused. His phone switches to EMERGENCY in Hindi — call 998, cool first, stay with him — and the first aider and supervisor are alerted at once.',
    criterion: { n: 2, label: 'Clinical escalation' },
    path: '/demo',
    at: '14:12',
    play: null,
    phone: { workerId: 'W-D2F6', lang: null },
    target: TOUR_TARGETS.phone,
    seconds: 13,
  },
  {
    id: 'firstaid',
    title: 'First aid gets exactly what it needs',
    caption:
      'The first aider sees name, level and location with a cooling checklist and timer — not the worker’s history or physiology. Occupational health sees clinical detail only if the worker agreed to share it.',
    criterion: { n: 3, label: 'Worker-first governance' },
    path: '/medic',
    at: '14:15',
    play: null,
    phone: null,
    target: TOUR_TARGETS.medicEmergency,
    seconds: 13,
  },
  {
    id: 'offline',
    title: 'Network down: phones keep protecting',
    caption:
      'At 15:30 the site network drops for twenty minutes. Every phone keeps assessing and warning on its own; messages to the console queue and arrive when the network returns.',
    criterion: { n: 4, label: 'Connectivity fallback' },
    path: '/demo',
    at: '15:34',
    play: null,
    phone: { workerId: 'W-D2F6', lang: 'en' },
    target: TOUR_TARGETS.phone,
    seconds: 12,
  },
  {
    id: 'governance',
    title: 'Privacy you can test',
    caption:
      'Employer HR asks for a worker’s heart rate for a performance review. The request goes through the same access check as every screen, is refused with its legal basis, and lands in a hash-chained audit log the worker can read.',
    criterion: { n: 3, label: 'No disciplinary use' },
    path: '/governance',
    at: null,
    play: null,
    phone: null,
    target: TOUR_TARGETS.request,
    seconds: 13,
    action: 'submit_prohibited_request',
  },
  {
    id: 'evidence',
    title: 'Measured, not asserted',
    caption:
      'Every model is checked against independent reference code, exposure is measured on six summers of real Abu Dhabi weather, and a simulated cohort graded by an independent physiology model reports safety and the work cost side by side.',
    criterion: { n: 6, label: 'Safety and productivity measures' },
    path: '/evidence',
    at: null,
    play: null,
    phone: null,
    target: TOUR_TARGETS.evidence,
    seconds: 13,
  },
])

/** Total running time in seconds when nobody pauses. */
export function tourSeconds(steps: readonly TourStep[] = TOUR_STEPS): number {
  return steps.reduce((s, x) => s + x.seconds, 0)
}

/** Next step index, or null past the end. */
export function nextIndex(i: number, steps: readonly TourStep[] = TOUR_STEPS): number | null {
  return i + 1 < steps.length ? i + 1 : null
}
