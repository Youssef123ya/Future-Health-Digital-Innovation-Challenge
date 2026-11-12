/**
 * Narration script for the live demo (#/demo): the scenario's scripted events (sim/scenarios.ts, each with its narration
 * note) plus the rule windows a presenter should point at (the MoHRE midday break) and the shift end, in time order, and
 * where the simulated clock stands relative to each. Pure: no store, no engine, no individual data. Unit-tested.
 */
import type { Scenario, ScenarioId } from '../../../sim/scenarios'
import type { ScriptedEvent } from '../../../sim/types'
import { hhmmMinutes as minutesOf, isHhmm, minutesHhmm as hhmmOf } from '../../shell/time'

/** Where a narration line comes from: the scenario script, a regulatory rule window, or the shift itself. */
export type NarrationKind = 'scripted' | 'rule' | 'shift'

/** One line of the narration rail. */
export interface NarrationItem {
  id: string
  /** Local time 'HH:mm'. */
  at: string
  /** End of a window ('HH:mm'), for rule windows such as the midday break. */
  until?: string
  kind: NarrationKind
  title: string
  note: string
  /** The worker whose phone tells this part of the story (a buddy report names the worker it is about). */
  workerId?: string
}

/** Position of a narration line relative to the simulated clock. */
export type NarrationState = 'past' | 'now' | 'next' | 'later'

/**
 * Suggested starting time of each scenario for a demo run (shortly before its first scripted event or the heat of the
 * day). [ENG] presentation choice, not a model parameter.
 */
export const DEMO_START_TIMES: Readonly<Record<ScenarioId, string>> = Object.freeze({
  'peak-day': '10:45',
  'humid-day': '11:00',
  'mild-day': '10:00',
  'saadiyat-peak': '10:30',
  'shade-only': '11:00',
})

/** MoHRE midday break (Ministerial Resolution 44/2022): 12:30–15:00 local, 15 June – 15 September inclusive. */
export const MIDDAY_BREAK = Object.freeze({ from: '12:30', to: '15:00', seasonStart: '06-15', seasonEnd: '09-15' })

/** Minutes after the start of an event during which it counts as happening "now". [ENG] presentation choice. */
export const NOW_WINDOW_MIN = 10

/** True when a local date 'YYYY-MM-DD' lies in the midday-break season (15 Jun – 15 Sep inclusive). */
export function inMiddayBreakSeason(date: string): boolean {
  const md = /^\d{4}-(\d{2}-\d{2})$/.exec(date)?.[1]
  return md !== undefined && md >= MIDDAY_BREAK.seasonStart && md <= MIDDAY_BREAK.seasonEnd
}

const SYSTEM_TITLES: Readonly<Record<string, string>> = {
  sensor_fail: 'Environment feed fails',
  sensor_ok: 'Environment feed restored',
  network_down: 'Site network drops',
  network_up: 'Network restored',
}

const SYMPTOM_WORDS: Readonly<Record<string, string>> = {
  confusion: 'confusion',
  collapse: 'collapse',
  seizure: 'a seizure',
  vomiting: 'vomiting',
  headache: 'a headache',
  dizziness: 'dizziness',
  nausea: 'nausea',
  cramps: 'cramps',
}

/** Short title of a scripted event (the scenario note carries the explanation). */
export function scriptedTitle(event: ScriptedEvent): string {
  const inj = event.injection
  switch (inj.kind) {
    case 'system':
      return SYSTEM_TITLES[inj.what] ?? 'System event'
    case 'checkin': {
      const who = inj.checkin.by === 'buddy' ? 'Buddy' : inj.checkin.by === 'self' ? 'Worker' : 'Check-in'
      const words = inj.checkin.symptoms.map((s) => SYMPTOM_WORDS[s] ?? s.replace(/_/g, ' '))
      return words.length > 0 ? `${who} reports ${words.join(', ')}` : `${who} check-in`
    }
    case 'task':
      return 'Task change'
    case 'intake':
      return 'Drink logged'
    case 'consent':
      return 'Consent changed on the phone'
    default:
      return 'Scripted event'
  }
}

/**
 * The narration lines of a scenario, in time order: its scripted events, the midday-break window when the date is in
 * season, and the end of the shift. Stable ids, so React keys survive re-renders.
 */
export function narrationItems(scenario: Pick<Scenario, 'date' | 'events' | 'config'>): NarrationItem[] {
  const items: NarrationItem[] = scenario.events.map((e, i) => {
    const item: NarrationItem = { id: `event-${i}-${e.at}`, at: e.at, kind: 'scripted', title: scriptedTitle(e), note: e.note }
    if (e.injection.kind === 'checkin') item.workerId = e.injection.checkin.workerId
    return item
  })
  if (inMiddayBreakSeason(scenario.date)) {
    items.push({
      id: 'rule-midday-break',
      at: MIDDAY_BREAK.from,
      until: MIDDAY_BREAK.to,
      kind: 'rule',
      title: 'Midday break',
      note: 'MoHRE Ministerial Resolution 44/2022: no outdoor work in direct sun from 12:30 to 15:00 (15 June – 15 September). Phones and the crew board show the break; the plan resumes at 15:00.',
    })
  }
  const end = scenario.config.shift?.end
  if (isHhmm(end)) {
    items.push({
      id: 'shift-end',
      at: end,
      kind: 'shift',
      title: 'Shift ends',
      note: 'The shift closes. Aggregates for HSE and the regulator count the day; nothing individual leaves the phones.',
    })
  }
  return items.sort((a, b) => minutesOf(a.at) - minutesOf(b.at))
}

/**
 * State of each line at the simulated time `now` ('HH:mm', or null before a world is loaded): `now` while it is
 * happening (a window between its start and end; a point event for {@link NOW_WINDOW_MIN} minutes), `next` for the
 * first line still ahead, `later` for the others ahead, `past` for those over.
 */
export function narrationStates(items: readonly NarrationItem[], now: string | null, windowMin = NOW_WINDOW_MIN): NarrationState[] {
  const n = now === null ? Number.NaN : minutesOf(now)
  let nextTaken = false
  return items.map((item) => {
    const start = minutesOf(item.at)
    if (!Number.isFinite(n)) {
      if (nextTaken) return 'later'
      nextTaken = true
      return 'next'
    }
    const end = item.until ? minutesOf(item.until) : start + windowMin
    if (n >= start && n < end) return 'now'
    if (n >= end) return 'past'
    if (nextTaken) return 'later'
    nextTaken = true
    return 'next'
  })
}

/** Time to jump to so the presenter can play into an event: `leadMin` minutes before it, never before `earliest`. */
export function jumpTargetFor(item: Pick<NarrationItem, 'at'>, leadMin = 2, earliest = '00:00'): string {
  return hhmmOf(Math.max(minutesOf(item.at) - leadMin, minutesOf(earliest)))
}
