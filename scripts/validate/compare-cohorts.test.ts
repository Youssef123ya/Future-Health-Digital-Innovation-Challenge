/**
 * compare-cohorts.ts: the generated "What changed between versions" section (module versions and their notes, design
 * differences, baseline-arm rows flagged as driven by the simulated world) and data-driven arms. Synthetic reports: the
 * tests check how the document is derived, never which result is "good".
 * Run: npx vitest run --config scripts/validate/lib/vitest.config.ts scripts/validate/compare-cohorts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { METRICS_SCOPE, VERSION_NOTES, WORLD_FLAG, baselineShifts, compareCohorts, notesBetween, reportArms, versionRows, whatChanged } from './compare-cohorts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const v = (value: number): J => ({ value })
/** One arm summary with headline rates offset by `x` (x = 0 everywhere → identical reports). */
function arm(id: string, policy: string, shadow: boolean, x: number): J {
  return {
    arm: id,
    policy,
    shadow,
    rates: {
      workerShifts: 100,
      perShift: { workMin: v(400 - x), restMin: v(100 + x), waterMl: v(5000 - 10 * x) },
      per1000: { excessive: v(50 + x), severe: v(5), critical: v(0), dehydration: v(100 + x), symptomaticEpisodes: v(150 + x), evacuations: v(0) },
    },
    vsBanOnly: policy === 'ban_only' ? null : { workRelative: v(-0.1), excessivePer1000: v(-10), severePer1000: v(0), dehydrationPer1000: v(-20), symptomaticEpisodesPer1000: v(-30) },
    challenge: { alarmsPerShift: v(1) },
  }
}
const ARMS: [string, string, boolean][] = [
  ['ban_only', 'ban_only', false],
  ['site_index', 'site_index', false],
  ['zill_env', 'zill_env', false],
  ['zill_full', 'zill_full', false],
  ['shadow_zill_env', 'zill_env', true],
  ['shadow_zill_full', 'zill_full', true],
]
function report(versions: J, shift: Record<string, number> = {}, extra: [string, string, boolean][] = [], over: J = {}): J {
  const arms = [...ARMS, ...extra]
  return {
    versions,
    spec: { mode: 'medium', seed: 's' },
    metricParams: { limitDehydrationPct: 3 },
    arms: arms.map(([id]) => id),
    variants: [{ id: 'base', group: 'base', label: 'Base case', supported: true, runs: 1 }],
    days: [{ siteId: 'kezad', date: '2025-07-15' }],
    main: { arms: arms.map(([id, policy, shadow]) => arm(id, policy, shadow, shift[id] ?? 0)), byStratum: [] },
    sensitivity: [],
    robustness: [],
    ...over,
  }
}
const V02 = { backtest: '1.1.0', metrics: '1.1.0', worldsim: '1.2.0' }
const V03 = { backtest: '1.2.0', metrics: '1.1.0', worldsim: '1.3.0', truth: '1.2.0' }

describe('arms are read from the reports (data-driven)', () => {
  it('kinds from the arm summaries; a new arm needs no code change; order: after report, then before-only arms', () => {
    const before = report(V02)
    const after = report(V03, {}, [['zill_monitored', 'zill_monitored', false], ['shadow_zill_monitored', 'zill_monitored', true]])
    const arms = reportArms(before, after)
    expect(arms.map((a) => a.arm)).toEqual(['ban_only', 'site_index', 'zill_env', 'zill_full', 'shadow_zill_env', 'shadow_zill_full', 'zill_monitored', 'shadow_zill_monitored'])
    expect(arms.filter((a) => a.kind === 'baseline').map((a) => a.arm)).toEqual(['ban_only', 'site_index'])
    expect(arms.find((a) => a.arm === 'zill_monitored')?.kind).toBe('zill')
    expect(arms.find((a) => a.arm === 'shadow_zill_monitored')?.kind).toBe('shadow')
    // An arm only the before report has is kept (at the end).
    const removed = reportArms(report(V02, {}, [['old_policy_arm', 'old_policy', false]]), report(V03))
    expect(removed.at(-1)).toEqual({ arm: 'old_policy_arm', kind: 'baseline' })
    // The new arm reaches the tables with its label, and an unknown arm falls back to its id.
    const doc = compareCohorts(before, after, ['v0.2', 'v0.3'])
    expect(doc).toContain('| Zill (monitored mode) |')
    expect(compareCohorts(before, report(V03, {}, [['zill_x', 'zill_x', false]]), ['a', 'b'])).toContain('| zill_x |')
  })
})

describe('module versions and their notes', () => {
  it('notesBetween: the notes of the versions in (from, to], oldest first; numeric version order (known answers)', () => {
    expect(notesBetween('worldsim', '1.0.0', '1.2.0').map((s) => s.slice(0, 6))).toEqual(['1.1.0:', '1.2.0:'])
    expect(notesBetween('worldsim', '1.2.0', '1.3.0')).toEqual([`1.3.0: ${VERSION_NOTES.worldsim['1.3.0']}`])
    expect(notesBetween('worldsim', '1.2.0', '1.2.0')).toEqual([])
    expect(notesBetween('worldsim', '1.3.0', '1.2.0')).toEqual([])
    expect(notesBetween('truth', null, '1.2.0')).toEqual([])
    // A version without a note is listed explicitly (a bump never passes silently); 1.10.0 sorts after 1.9.0.
    const unknown = notesBetween('metrics', '1.2.0', '1.10.0')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatch(/^1\.10\.0: \(no version note/)
    expect(VERSION_NOTES.truth['1.2.0']).toMatch(/5\.44 L/)
    expect(VERSION_NOTES.worldsim['1.3.0']).toMatch(/task windows/)
    // Wave 2d integration versions carry notes; metrics 1.2.0 changes alarm measures only (designed suppression).
    expect(notesBetween('worldsim', '1.3.0', '1.4.0')).toEqual([`1.4.0: ${VERSION_NOTES.worldsim['1.4.0']}`])
    expect(VERSION_NOTES.worldsim['1.4.0']).toMatch(/per-member plan caps/)
    expect(VERSION_NOTES.metrics['1.2.0']).toMatch(/designed suppression/)
    expect(VERSION_NOTES.backtest['1.3.0']).toMatch(/zill_monitored/)
    expect(METRICS_SCOPE['1.2.0']).toBe('alarms')
  })

  it('versionRows: the ground-truth version is inferred from the world simulation for reports without one', () => {
    const rows = versionRows(report(V02), report(V03))
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(by.worldsim).toMatchObject({ before: '1.2.0', after: '1.3.0', changed: true, inferred: [false, false] })
    expect(by.truth).toMatchObject({ before: '1.1.0', after: '1.2.0', changed: true, inferred: [true, false] })
    expect(by.metrics).toMatchObject({ before: '1.1.0', after: '1.1.0', changed: false, notes: [] })
    expect(by.backtest.notes).toEqual([`1.2.0: ${VERSION_NOTES.backtest['1.2.0']}`])
    const v01 = versionRows(report({ backtest: '1.0.0', metrics: '1.0.0', worldsim: '1.0.0' }), report(V02))
    expect(v01.find((r) => r.key === 'truth')).toMatchObject({ before: '1.0.0', after: '1.1.0', inferred: [true, true] })
    // Unknown world-simulation version and no truth version: unknown, not guessed.
    expect(versionRows(report({ worldsim: '9.9.9' }), report(V03)).find((r) => r.key === 'truth')?.before).toBeNull()
  })
})

describe('rows driven by the simulated world', () => {
  it('baselineShifts: a baseline measure moved when it changed beyond floating-point noise or exists in one report only', () => {
    const before = report(V02)
    const same = baselineShifts(before, report(V02))
    expect(same.length).toBe(14) // 2 baseline arms × 7 measures
    expect(same.every((s) => !s.moved)).toBe(true)
    const after = report(V03, { ban_only: 5 })
    const moved = baselineShifts(before, after).filter((s) => s.moved)
    expect(moved.every((s) => s.arm === 'ban_only')).toBe(true)
    expect(moved.map((s) => s.measure)).toEqual(['Work min/shift', 'Rest min/shift', 'Water mL/shift', 'Excessive strain /1,000', 'Dehydration > 3 % /1,000', 'Heat-symptom episodes /1,000'])
    // Floating-point noise is not a change; a missing value is.
    const noise = report(V02)
    noise.main.arms[0].rates.perShift.workMin.value = 400 + 1e-12
    expect(baselineShifts(before, noise).some((s) => s.moved)).toBe(false)
    const missing = report(V02)
    delete missing.main.arms[1].rates.per1000.severe
    expect(baselineShifts(before, missing).filter((s) => s.moved).map((s) => `${s.arm}|${s.measure}`)).toEqual(['site_index|Severe strain /1,000'])
    // Zill arms are never baseline rows.
    expect(baselineShifts(before, report(V03, { zill_full: 50 })).some((s) => s.moved)).toBe(false)
  })

  it('a moved baseline arm is attributed to the simulated world (not Zill) and flagged in the section and the tables', () => {
    const before = report(V02)
    const after = report(V03, { ban_only: 5, zill_full: 9 })
    const s = whatChanged(before, after, ['v0.2', 'v0.3'])
    expect(s).toMatch(/^## What changed between versions/)
    expect(s).toContain('| World simulation (simulated world: mechanics, schedules) | 1.2.0 | 1.3.0 | yes |')
    expect(s).toContain('| Ground-truth model (simulated world: physiology, behaviour) | 1.1.0 (inferred from the world-simulation version) | 1.2.0 | yes |')
    expect(s).toContain('6 of 14 baseline-arm measures changed')
    expect(s).toContain('not from Zill')
    expect(s).toContain('world simulation 1.2.0 → 1.3.0, ground-truth model 1.1.0 → 1.2.0')
    expect(s).not.toContain('or from the metric definitions') // same metrics version, same metric parameters
    expect(s).toContain(`| Midday ban only | Dehydration > 3 % /1,000 | 100.0 → 105.0 (+5.0) | ${WORLD_FLAG} simulated world |`)
    expect(s).toContain('| Site TWL index | Dehydration > 3 % /1,000 | 100.0 → 100.0 (+0.0) | unchanged |')
    const doc = compareCohorts(before, after, ['v0.2', 'v0.3'])
    expect(doc.indexOf('## What changed between versions')).toBeLessThan(doc.indexOf('## 1. Work delivered'))
    expect(doc).toContain(`| Midday ban only ${WORLD_FLAG} |`)
    expect(doc).not.toContain(`| Site TWL index ${WORLD_FLAG} |`)
    expect(doc).not.toContain(`| Zill (with wearable) ${WORLD_FLAG} |`)
    expect(doc).toContain('| Versions (back-test / metrics / world simulation / ground truth) | 1.1.0 / 1.1.0 / 1.2.0 / (1.1.0) | 1.2.0 / 1.1.0 / 1.3.0 / 1.2.0 |')
  })

  it('metric definitions share the attribution only when the metric parameters or an outcome-scope metrics version changed', () => {
    const before = report(V02)
    const params = report(V03, { ban_only: 5 }, [], { metricParams: { limitDehydrationPct: 2 } })
    const s = whatChanged(before, params, ['a', 'b'])
    expect(s).toContain('or from the metric definitions')
    expect(s).toContain('| Metric parameters | changed: limitDehydrationPct |')
    // A metrics version this script does not know counts as an outcome change (cautious reading).
    expect(whatChanged(before, report({ ...V03, metrics: '1.9.0' }, { ban_only: 5 }), ['a', 'b'])).toContain('or from the metric definitions')
    // An alarm-scope metrics version (1.2.0: designed suppression) does not share the attribution of outcome rows.
    expect(whatChanged(before, report({ ...V03, metrics: '1.2.0' }, { ban_only: 5 }), ['a', 'b'])).not.toContain('or from the metric definitions')
  })

  it('no world change and no baseline move: changes in the Zill arms come from Zill; a world change that does not reach the baselines says so', () => {
    const same = whatChanged(report(V03), report(V03, { zill_full: 9 }), ['a', 'b'])
    expect(same).toContain('Same simulated world and no baseline-arm measure moved')
    expect(same).not.toContain(`${WORLD_FLAG} simulated world`)
    const unreached = whatChanged(report(V02), report(V03), ['a', 'b'])
    expect(unreached).toContain('The simulated world changed (world simulation 1.2.0 → 1.3.0, ground-truth model 1.1.0 → 1.2.0) but no baseline-arm measure moved')
  })

  it('design differences: variants and arms added between the reports', () => {
    const after = report(V03, {}, [['zill_monitored', 'zill_monitored', false]], {
      variants: [
        { id: 'base', group: 'base', label: 'Base case', supported: true, runs: 1 },
        { id: 'habitualDrinkFraction=1.0', group: 'sensitivity', label: 'Drinking floor 1.0', supported: true, runs: 1 },
      ],
    })
    const s = whatChanged(report(V02), after, ['v0.2', 'v0.3'])
    expect(s).toContain('| Variants | added: habitualDrinkFraction=1.0 |')
    expect(s).toContain('| Arms | added in v0.3: Zill (monitored mode) |')
    expect(s).toContain('| Cohort design (spec) | same |')
  })
})
