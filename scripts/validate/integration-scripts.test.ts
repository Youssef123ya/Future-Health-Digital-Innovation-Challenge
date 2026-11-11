/**
 * Integration analysis scripts (wave 2d): the Markdown renderers of work-cost-drivers.ts and scenario-sanity.ts on
 * synthetic inputs (known answers), and the cohort document's wave 2d columns on an older report (no crash, '—' for the
 * fields it does not have). The tests check how the documents are derived, never which result is "good".
 * Run: npx vitest run --config scripts/validate/lib/vitest.config.ts scripts/validate/integration-scripts.test.ts
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderCohortBlocks, type CohortFile } from './cohort'
import { renderSanity, type ScenarioSanity } from './scenario-sanity'
import { DRIVER_ARMS, renderDrivers, type DriverAcc } from './work-cost-drivers'
import { repoPath } from './lib/io'

/** One accumulator with round numbers (100 worker-shifts). */
function acc(over: Record<string, unknown> = {}): DriverAcc[string]['all'] {
  return {
    workerShifts: 100,
    banWork: 40_000,
    job: 40_000,
    planned: 15_000,
    unscheduledDeferred: 2_000,
    unscheduledIncomplete: 20_000,
    delivered: 14_000,
    lost: { 'rest episode: projection': 600, 'device work/rest cycle': 400 },
    wallBy: { niosh_acgih: 20_000, phs: 5_000 },
    workBy: { niosh_acgih: 8_000, phs: 1_000 },
    monitoredWall: 3_000,
    rate: { 'heavy|< 28 °C': { wall: 6_000, work: 2_400 } },
    crewDays: 10,
    noAcclimatisedCrewDays: 2,
    crewMembers: 70,
    membersOnCaps: 20,
    capMemberPlanned: 1_000,
    otherMemberPlanned: 14_000,
    ...over,
  } as DriverAcc[string]['all']
}

describe('work-cost-drivers renderer (wave 2d: both Zill arms, per-member plans)', () => {
  it('known answers: per worker-shift minutes, work shares, monitored wall, per-member scheduled work', () => {
    const one = { all: acc(), hot: acc(), median: acc(), mild: acc() }
    const md = renderDrivers({ zill_full: one, zill_monitored: { ...one, all: acc({ monitoredWall: 9_000 }) } }, 'x.json')
    expect(DRIVER_ARMS).toEqual(['zill_full', 'zill_monitored'])
    expect(md).toContain('| Zill (with wearable) | all | 100 | 400.0 | 400.0 | 150.0 | 20.0 | 200.0 | 140.0 | 10.0 |')
    // niosh_acgih: 200 wall, 40 % work share; phs 50 wall, 20 %; monitored wall 30 (90 in the monitored arm's 'all').
    expect(md).toContain('| Zill (with wearable) | all | 0.0 | — | 200.0 | 40 % | 0.0 | — | 50.0 | 20 % | 30.0 |')
    expect(md).toContain('| Zill (monitored mode) | all | 0.0 | — | 200.0 | 40 % | 0.0 | — | 50.0 | 20 % | 90.0 |')
    // Members on caps 20 of 70: 1,000 / 20 = 50.0 min each; others 14,000 / 50 = 280.0.
    expect(md).toContain('| Zill (with wearable) | all | 10 | 2 | 20 / 70 | 50.0 | 280.0 |')
    expect(md).toContain('## 4. Per-member plans')
    expect(md).not.toContain('Counterfactual')
    // Planned rate: 2,400 / 6,000 × 60 = 24 min/h on 60 wall min per worker-shift.
    expect(md).toContain('| heavy | 24 (60.0) |')
  })
})

describe('scenario-sanity renderer (wave 2d: engine-owned holds, monitored mode, members on caps)', () => {
  it('one row per scenario and policy; rest episodes split by the engine’s holds with the simulator share last', () => {
    const s: ScenarioSanity = {
      scenario: 'peak-day',
      policy: 'zill_monitored',
      workers: 16,
      workerMinutes: 11_520,
      membersOnCaps: 2,
      memberScheduledMinPerMember: 0,
      shares: {
        work: 11.6,
        idle: 22.4,
        rest: 66,
        restEpisode: 11.1,
        restEpisodeDeviceAsks: 11.1,
        restEpisodeTaskHeld: 9.7,
        restEpisodeProjectionHeld: 0.4,
        restEpisodeOther: 0,
        projectionHold: 0.5,
        taskHold: 9.7,
        monitored: 15.2,
        dehydrationBlocked: 5.3,
        taskNotFeasible: 0,
      },
      alarmsPerWorker: { individualHighPlus: 3.06, individualStopPlus: 0.56, exposureHighPlus: 3.13, suppressedHighPlus: 0 },
      intakeLPerWorker: 7.41,
      workMinPerWorker: 82.6,
      planWarnings: ['phs_not_feasible'],
    }
    const md = renderSanity([s, { ...s, policy: 'zill_full', membersOnCaps: 0, memberScheduledMinPerMember: null }]).split('\n')
    expect(md).toHaveLength(4)
    expect(md[2]).toBe('| peak-day | zill_monitored | 11.6 | 22.4 | 66 | 11.1 (11.1: 9.7 / 0.4; 0) | 9.7 | 0.5 | 15.2 | 5.3 | 0 | 3.06 | 0.56 | 3.13 | 0 | 2 (0) | 82.6 | 7.41 |')
    expect(md[3]).toContain('| peak-day | zill_full |')
    expect(md[3]).toContain('| 0 | 82.6 | 7.41 |') // no members on caps: no scheduled-minutes bracket
  })
})

describe('cohort document: wave 2d columns', () => {
  it('an older report (v0.2: no suppression, no base delta on variant days) renders with the new columns and "—" where it has no value', () => {
    const v02 = JSON.parse(readFileSync(repoPath('docs/dev/cohort-v0.2-medium.json'), 'utf8')) as CohortFile
    const blocks = renderCohortBlocks(v02)
    const challenge = blocks['cohort-challenge']
    expect(challenge).toContain('Suppressed advisories ≥ high per worker-shift (logged, not notified)')
    expect(challenge).toContain('Supervisor acks per worker-shift')
    // Zill (with wearable) in v0.2: no suppressed-advisory estimate, 3.42 supervisor acks per worker-shift.
    const row = challenge.split('\n').find((l) => l.startsWith('| Zill (with wearable) |')) as string
    expect(row.split(' | ')[3]).toBe('—')
    expect(row.split(' | ')[4]).toBe('3.42')
    const sens = blocks['cohort-sensitivity']
    expect(sens).toContain('Δ dehydration vs ban only (base case on the same days)')
    expect(sens).not.toMatch(/\(base [-+0-9]/) // v0.2 has no base delta on the variant days
  })
})
