import { describe, expect, it } from 'vitest'
import {
  airportRows,
  comparedDiff,
  detectionFor,
  eventRows,
  fairnessValueLabel,
  leadBins,
  referenceGroups,
  valueRange,
  variantRows,
} from './derive'
import { ci, estLine, estText, isZeroCount, NBSP, num, pct, sci, sig, signedPct, toleranceUse, toleranceUseText } from './format'
import { bandRowsBySite, rmseByLead, tradeoffPoints, valuesDiffer, versionRows, workRestPairs, type VersionRowDef } from './model'
import type { CohortArm, CohortFile, CohortVariant, DetectionRow, ForecastFile, HoursSite, ReferenceCheck, ReferenceFile, WorkRestRow } from './types'

const NB = NBSP

describe('format', () => {
  it('formats numbers, shares and missing values', () => {
    expect(num(1284.5, 1)).toBe('1,284.5')
    expect(num(-3, 0)).toBe('−3')
    expect(num(null)).toBe('—')
    expect(num(Number.NaN)).toBe('—')
    expect(pct(0.837, 0)).toBe(`84${NB}%`)
    expect(pct(undefined)).toBe('—')
    expect(signedPct(-0.666, 1)).toBe(`−66.6${NB}%`)
    expect(ci([56.2, 184.3], 1)).toBe('[56.2, 184.3]')
    expect(ci(null)).toBe('')
  })

  it('shows a zero count with its rule-of-three bound, never as a bare certainty', () => {
    const zero = { value: 0, ci95: [0, 0] as const, n: 333, count: 0, upper95: 9 }
    expect(isZeroCount(zero)).toBe(true)
    expect(estText(zero)).toMatchObject({ value: '0', detail: `≤${NB}9.0` })
    expect(estLine(zero)).toBe(`0 (≤${NB}9.0)`)
    const rate = { value: 114.1, ci95: [56.2, 184.3] as const, n: 333, count: 38, upper95: null }
    expect(estLine(rate)).toBe('114.1 [56.2, 184.3]')
    expect(estText({ value: -0.666, ci95: [-0.718, -0.615] }, 1, 100).value).toBe('−66.6')
    expect(estText(null).value).toBe('—')
  })

  it('prints measured differences with sensible significant digits', () => {
    expect(sig(0)).toBe('0')
    expect(sig(0.142)).toBe('0.142')
    expect(sig(10.1)).toBe('10.1')
    expect(sig(2.96)).toBe('2.96')
    expect(sig(4.89e-10)).toBe(sci(4.89e-10))
    expect(sci(4.89e-10)).toBe(`4.89${NB}×${NB}10⁻¹⁰`)
  })

  it('computes the share of tolerance used, including exact checks', () => {
    expect(toleranceUse(0.142, 0.15)).toBeCloseTo(0.9467, 3)
    expect(toleranceUse(0, 0)).toBe(0)
    expect(toleranceUse(1, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(toleranceUse(null, 1)).toBeNull()
    expect(toleranceUseText(4.9e-4)).toBe(`<${NB}0.1${NB}%`)
    expect(toleranceUseText(1)).toBe(`100${NB}%`)
    expect(toleranceUseText(Number.POSITIVE_INFINITY)).toBe('exceeds tolerance')
  })
})

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────

const est = (value: number | null, lo?: number, hi?: number, extra: Record<string, unknown> = {}) => ({ value, ci95: lo === undefined ? null : ([lo, hi] as [number, number]), ...extra })

function arm(id: string, work: number, excessive: number | null, opts: { zero?: boolean; workRel?: number; water?: number } = {}): CohortArm {
  return {
    arm: id,
    policy: id,
    shadow: id.startsWith('shadow'),
    rates: {
      workerShifts: 333,
      per1000: {
        excessive: opts.zero ? est(0, 0, 0, { count: 0, upper95: 9 }) : est(excessive, (excessive ?? 0) - 10, (excessive ?? 0) + 10, { count: 5 }),
        severe: est(0),
        critical: est(0),
        dehydration: est(0),
      },
      perShift: { workMin: est(work, work - 20, work + 20), restMin: est(100), waterMl: est(opts.water ?? 5000) },
    },
    vsBanOnly: opts.workRel === undefined ? null : { pairedWorkerShifts: 333, excessivePer1000: est(-excessive!), workMinPerShift: est(0), workRelative: est(opts.workRel) },
  } as unknown as CohortArm
}

describe('cohort view models', () => {
  it('draws a zero-event arm at 0 with its one-sided bound as the interval', () => {
    const pts = tradeoffPoints([arm('ban_only', 366.8, 114.1), arm('zill_full', 122.4, 0, { zero: true })], ['ban_only', 'zill_full', 'zill_monitored'])
    expect(pts.map((p) => p.arm)).toEqual(['ban_only', 'zill_full'])
    const z = pts[1]
    expect(z.zero).toBe(true)
    expect(z.excessiveCi).toEqual([0, 9])
    expect(z.errExcessive).toEqual([0, 9])
    expect(z.errWork).toEqual([20, 20])
    expect(pts[0].errExcessive).toEqual([10, 10])
  })

  it('flags baseline rows that changed between versions as simulated-world changes, never Zill rows', () => {
    const defs: VersionRowDef[] = [
      { id: 'z', group: 'zill', arm: 'zill_full', label: 'Zill work', precision: 1, read: (a) => a.rates.perShift.workMin.value },
      { id: 'b', group: 'baseline', arm: 'ban_only', label: 'Ban work', precision: 1, read: (a) => a.rates.perShift.workMin.value },
    ]
    const report = (zw: number, bw: number) => ({ main: { arms: [arm('zill_full', zw, 0, { zero: true }), arm('ban_only', bw, 87)] } }) as unknown as CohortFile
    const rows = versionRows([report(121.1, 398.1), report(131.6, 398.1), report(122.4, 366.8), null], defs)
    expect(rows[0].worldChanged).toEqual([false, false, false, false])
    expect(rows[1].worldChanged).toEqual([false, false, true, false])
    expect(rows[1].values).toEqual([398.1, 398.1, 366.8, null])
    expect(valuesDiffer(398.1, 398.1000001, 1)).toBe(false)
    expect(valuesDiffer(null, 3, 1)).toBe(false)
  })

  it('maps variants per arm with the paired differences and finds ranges', () => {
    const variant = {
      id: 'compliance=0.5',
      group: 'sensitivity',
      factor: 'compliance',
      label: 'Compliance 0.5',
      value: 0.5,
      supported: true,
      note: null,
      siteDays: 15,
      arms: [
        { arm: 'ban_only', headline: { workerShifts: 111, excessivePer1000: est(261.3), workMinPerShift: est(361) } },
        {
          arm: 'zill_full',
          headline: { workerShifts: 111, excessivePer1000: est(0, 0, 0, { count: 0, upper95: 27 }), workMinPerShift: est(111) },
          vsBanOnly: { excessivePer1000: est(-261.3), workRelative: est(-0.692) },
          vsBase: { excessivePer1000: est(0), workMinPerShift: est(1.3) },
        },
      ],
    } as unknown as CohortVariant
    const [row] = variantRows([variant], 'zill_full')
    expect(row.workRelative?.value).toBe(-0.692)
    expect(row.banOnlyExcessive?.value).toBe(261.3)
    expect(row.vsBaseWork?.value).toBe(1.3)
    expect(variantRows([variant], 'zill_monitored')[0].excessive).toBeNull()
    expect(valueRange([-0.692, null, -0.731, undefined])).toEqual([-0.731, -0.692])
    expect(valueRange([null])).toBeNull()
  })

  it('orders detection targets canonically and labels lead-time bins', () => {
    const row = (target: string) => ({ target, leadTime: { bins: [{ fromMin: 0, toMin: 15, n: 3 }, { fromMin: 120, toMin: null, n: 22 }] } }) as unknown as DetectionRow
    const a = { detection: [row('symptomatic'), row('excessive_strain'), row('critical')], detectionStop: [row('critical')] } as unknown as CohortArm
    expect(detectionFor(a, 'high').map((r) => r.target)).toEqual(['excessive_strain', 'critical', 'symptomatic'])
    expect(detectionFor(a, 'stop')).toHaveLength(1)
    expect(detectionFor(undefined, 'high')).toEqual([])
    expect(leadBins(row('critical')).map((b) => b.label)).toEqual(['0–15', '≥ 120'])
  })

  it('labels fairness groups in plain English', () => {
    expect(fairnessValueLabel('unacclimatized')).toBe('Not acclimatised')
    expect(fairnessValueLabel('30-44')).toBe('30–44')
    expect(fairnessValueLabel('<30')).toBe('Under 30')
    expect(fairnessValueLabel('fr_coveralls')).toBe('FR coveralls')
    expect(fairnessValueLabel('some_new_value')).toBe('some new value')
  })
})

describe('reference and forecast view models', () => {
  const check = (id: string, model: string, maxAbsDiff: number, tolerance: number, extra: Partial<ReferenceCheck> = {}) =>
    ({ id, model, maxAbsDiff, tolerance, toleranceKind: 'abs', kind: 'reference_implementation', nValues: 10, pass: maxAbsDiff <= tolerance, ...extra }) as ReferenceCheck

  it('judges RMS checks on the RMS and groups checks in summary order', () => {
    const lemke = check('wbgt.lemke', 'wbgt', 0.142, 0.15, { toleranceKind: 'rms', rmsDiff: 0.05, kind: 'published_values' })
    expect(comparedDiff(lemke)).toBe(0.05)
    const file = {
      summary: { models: [{ model: 'phs', label: 'PHS' }, { model: 'wbgt', label: 'WBGT' }] },
      checks: [check('wbgt.core', 'wbgt', 0, 1e-6), lemke, check('phs.dlim', 'phs', 3, 3), check('x.y', 'extra', 1, 0)],
    } as unknown as ReferenceFile
    const groups = referenceGroups(file)
    expect(groups.map((g) => g.model)).toEqual(['phs', 'wbgt', 'extra'])
    expect(groups[0].worstUse).toBe(1)
    expect(groups[1]).toMatchObject({ total: 2, passed: 2, values: 20, implementations: 1, publishedSets: 1 })
    expect(groups[1].worstUse).toBeCloseTo(0.05 / 0.15, 6)
    expect(groups[2].pass).toBe(false)
  })

  const scores = (csi: number) => ({ hits: 9, misses: 1, falseAlarms: 2, correctNegatives: 88, n: 100, baseRate: 0.1, pod: 0.9, far: 0.18, csi, freqBias: 1.1, peirce: 0.8, heidke: 0.8 })
  const errs = (rmse: number) => ({ n: 100, bias: 0, mae: rmse * 0.7, rmse, r: 0.9, maxAbs: 5, rmseCi95: [rmse - 0.02, rmse + 0.02] as [number, number] })
  const forecast = {
    config: { primaryModel: 'ecmwf_ifs025' },
    sameModel: [
      {
        model: 'ecmwf_ifs025',
        primary: true,
        leads: [1, 2].map((lead) => ({ lead, wbgt: errs(0.8 + lead / 10), twl: errs(20 + lead), events: [{ id: 'adosh_high', scores: scores(0.5 - lead / 10) }] })),
        persistence: [48, 24].map((lagH) => ({ lagH, wbgt: errs(1.6 + lagH / 240), twl: errs(40), events: [{ id: 'adosh_high', scores: scores(0.2) }] })),
      },
      { model: 'ncep_gfs_seamless', primary: false, leads: [{ lead: 1, wbgt: errs(1.2), twl: errs(30), events: [] }], persistence: [] },
    ],
    airports: {
      analysis: [{ icao: 'OMAD', model: 'era5', n: 10, t: errs(1), wbgtAll: { ...errs(1.1), bias: 0.5 } }],
      forecast: [
        { icao: 'OMAA', model: 'ecmwf_ifs025', lead: 1, n: 10, wbgt: errs(1.24), td: { ...errs(2), bias: -0.2 } },
        { icao: 'OMAA', model: 'ecmwf_ifs025', lead: 2, n: 10, wbgt: errs(1.4) },
      ],
    },
  } as unknown as ForecastFile

  it('pairs each lead with the persistence of the same lag', () => {
    const rows = rmseByLead(forecast, 'wbgt')
    expect(rows.map((r) => r.label)).toEqual(['Day 1', 'Day 2'])
    expect(rows[0].persistence).toBeCloseTo(1.7, 6)
    expect(rows[1].persistence).toBeCloseTo(1.8, 6)
    expect(rows[1].ncep_gfs_seamless).toBeNull()
    const ev = eventRows(forecast, 'ecmwf_ifs025', 'adosh_high')
    expect(ev.map((r) => r.csiForecast)).toEqual([0.4, 0.3])
    expect(ev.every((r) => r.csiPersistence === 0.2)).toBe(true)
    expect(eventRows(forecast, 'unknown', 'adosh_high')).toEqual([])
  })

  it('lists analyses before forecasts per airport, at one lead', () => {
    const rows = airportRows(forecast, 1)
    expect(rows.map((r) => `${r.icao}:${r.kind}`)).toEqual(['OMAD:analysis', 'OMAA:forecast'])
    expect(rows[0].wbgtBias).toBe(0.5)
    expect(rows[1].tdBias).toBe(-0.2)
    expect(rows[1].twlRmse).toBeNull()
  })
})

describe('exposure view models', () => {
  it('stacks ADOSH zones from the least to the most severe', () => {
    const site = (id: string) =>
      ({ site: id, run: 'ifs', meanSeason: { wbgtBands: [1, 2, 3, 4, 5], adoshSun: [10, 20, 2898] } }) as unknown as HoursSite
    const rows = bandRowsBySite([site('musaffah'), { ...site('kezad'), run: 'era5' }], 'adoshSun')
    expect(rows).toHaveLength(1)
    expect([rows[0].b0, rows[0].b1, rows[0].b2]).toEqual([2898, 20, 10])
    expect(rows[0].total).toBe(2928)
  })

  it('pairs shade and cabin rest for each work and limit', () => {
    const r = (work: string, limit: string, rest: string, m: number): WorkRestRow =>
      ({ site: 'all', month: 0, work, limit, rest, meanMinPerHour: m, zeroShare: 0 }) as WorkRestRow
    const pairs = workRestPairs([r('moderate', 'REL', 'shade', 30.5), r('moderate', 'REL', 'cabin', 41.5)], 'all', 0)
    expect(pairs[0]).toMatchObject({ shade: 30.5, cabin: 41.5, range: [30.5, 41.5] })
    expect(pairs[1]).toMatchObject({ shade: null, cabin: null })
  })
})
