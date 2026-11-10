/**
 * Mechanics of the validation scripts: statistics, band edges, zone and midday-break helpers, airport sample
 * construction, provenance, document block replacement, and the reference-agreement run. These tests check how the
 * numbers are computed, never which result is "good".
 * Run: npx vitest run --config scripts/validate/lib/vitest.config.ts
 */
import { describe, expect, it } from 'vitest'
import { ralC, relC } from '../../src/engine/limits'
import { epochFromLocal } from '../../src/engine/time'
import { getSite } from '../../src/data/sites'
import type { EnvSample } from '../../src/engine/types'
import type { MetarObservation } from '../../src/data/weather'
import {
  ContingencyAccumulator,
  DiffSet,
  ErrorAccumulator,
  bootstrapRmseCi,
  categoricalScores,
  mseSkillScore,
  quantileSorted,
  roundTo,
  sig,
} from './lib/stats'
import { WBGT_BANDS, WBGT_THRESHOLDS, adoshZoneIndex, cooledRestWbgt, inMiddayBreak, inMiddayBreakSeason, wbgtBandIndex } from './lib/zones'
import { heatColumns, hourHeat } from './lib/heat'
import { metarUsable, modelThermoObsWindSample, obsMetSample } from './lib/airports'
import { Provenance, codeStamp } from './lib/io'
import { mdTable, replaceValidationBlocks } from './lib/docs'
import { runReference } from './reference'

describe('statistics (Wilks 2011 definitions)', () => {
  it('ErrorAccumulator gives bias, MAE, RMSE, r and max |Δ| of estimate − reference', () => {
    const acc = new ErrorAccumulator()
    const est = [1, 2, 3, 4]
    const ref = [1.5, 1.5, 3.5, 3.5]
    est.forEach((e, i) => acc.add(e, ref[i]))
    acc.add(Number.NaN, 1) // ignored
    const s = acc.scores()
    expect(s.n).toBe(4)
    expect(s.bias).toBeCloseTo(0, 12)
    expect(s.mae).toBeCloseTo(0.5, 12)
    expect(s.rmse).toBeCloseTo(0.5, 12)
    expect(s.maxAbs).toBeCloseTo(0.5, 12)
    expect(s.r).toBeCloseTo(0.894427191, 8)
    expect(acc.mse()).toBeCloseTo(0.25, 12)
  })

  it('categorical scores follow the 2×2 formulas', () => {
    const c = new ContingencyAccumulator()
    for (let i = 0; i < 40; i++) c.add(true, true)
    for (let i = 0; i < 10; i++) c.add(false, true)
    for (let i = 0; i < 20; i++) c.add(true, false)
    for (let i = 0; i < 30; i++) c.add(false, false)
    const s = categoricalScores(c)
    expect(s.n).toBe(100)
    expect(s.pod).toBeCloseTo(0.8, 12)
    expect(s.far).toBeCloseTo(1 / 3, 12)
    expect(s.csi).toBeCloseTo(40 / 70, 12)
    expect(s.freqBias).toBeCloseTo(1.2, 12)
    expect(s.peirce).toBeCloseTo(0.8 - 0.4, 12)
    // Heidke: expected correct = ((50·60) + (40·50)) / 100 = 50 → (70 − 50) / (100 − 50) = 0.4
    expect(s.heidke).toBeCloseTo(0.4, 12)
    expect(categoricalScores({ hits: 0, misses: 0, falseAlarms: 0, correctNegatives: 5 }).pod).toBeNull()
  })

  it('quantiles use linear interpolation (numpy default) and MSE skill is 1 − ratio', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12)
    expect(quantileSorted([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 12)
    expect(quantileSorted([], 0.5)).toBeNaN()
    expect(mseSkillScore(0.5, 2)).toBeCloseTo(0.75, 12)
    expect(mseSkillScore(1, 0)).toBeNull()
  })

  it('the day-block bootstrap is deterministic for a seed and brackets the RMSE of identical blocks', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ sse: (i % 5) + 1, n: 1 }))
    const a = bootstrapRmseCi(blocks, 200, 'seed-a')
    const b = bootstrapRmseCi(blocks, 200, 'seed-a')
    expect(a).toEqual(b)
    expect(a[0]).toBeLessThanOrEqual(a[1])
    const same = bootstrapRmseCi(Array.from({ length: 10 }, () => ({ sse: 4, n: 1 })), 100, 'x')
    expect(same[0]).toBeCloseTo(2, 12)
    expect(same[1]).toBeCloseTo(2, 12)
  })

  it('DiffSet summarises differences; rounding helpers keep sign and tiny values', () => {
    const d = new DiffSet()
    d.add(1.1, 1)
    d.add(0.8, 1)
    const s = d.summary()
    expect(s.n).toBe(2)
    expect(s.maxAbs).toBeCloseTo(0.2, 12)
    expect(s.mean).toBeCloseTo(-0.05, 12)
    expect(roundTo(-0.0004, 2)).toBe(0)
    expect(sig(4.567e-10, 2)).toBe(4.6e-10)
  })
})

describe('exposure bands come from the engine limit functions', () => {
  it('edges equal REL(300 W), RAL(115 W), the Qatar stop value and REL(115 W)', () => {
    expect(WBGT_THRESHOLDS.rel300).toBe(relC(300))
    expect(WBGT_THRESHOLDS.ral115).toBe(ralC(115))
    expect(WBGT_THRESHOLDS.qatarStop).toBe(32.1)
    expect(WBGT_THRESHOLDS.rel115).toBe(relC(115))
    expect(WBGT_BANDS.map((b) => b.fromC)).toEqual([null, relC(300), ralC(115), 32.1, relC(115)])
  })

  it('lower edges are inclusive; non-finite WBGT falls in the top band (fail-safe)', () => {
    expect(wbgtBandIndex(20)).toBe(0)
    expect(wbgtBandIndex(relC(300))).toBe(1)
    expect(wbgtBandIndex(ralC(115) - 1e-9)).toBe(1)
    expect(wbgtBandIndex(ralC(115))).toBe(2)
    expect(wbgtBandIndex(32.1)).toBe(3)
    expect(wbgtBandIndex(relC(115))).toBe(4)
    expect(wbgtBandIndex(Number.NaN)).toBe(4)
  })

  it('ADOSH zones resolve 115 and 140 to the more protective zone', () => {
    expect(adoshZoneIndex(100)).toBe(0)
    expect(adoshZoneIndex(115)).toBe(0)
    expect(adoshZoneIndex(115.01)).toBe(1)
    expect(adoshZoneIndex(140)).toBe(1)
    expect(adoshZoneIndex(140.01)).toBe(2)
    expect(adoshZoneIndex(Number.NaN)).toBe(0)
  })

  it('midday break: 12:30 ≤ t < 15:00 on 15 Jun–15 Sep', () => {
    expect(inMiddayBreak(epochFromLocal('2025-07-01T13:00'))).toBe(true)
    expect(inMiddayBreak(epochFromLocal('2025-07-01T12:00'))).toBe(false)
    expect(inMiddayBreak(epochFromLocal('2025-07-01T15:00'))).toBe(false)
    expect(inMiddayBreak(epochFromLocal('2025-06-14T13:00'))).toBe(false)
    expect(inMiddayBreak(epochFromLocal('2025-09-15T14:00'))).toBe(true)
    expect(inMiddayBreakSeason(epochFromLocal('2025-06-14T13:00'))).toBe(false)
    expect(inMiddayBreakSeason(epochFromLocal('2025-06-15T05:00'))).toBe(true)
  })

  it('the cooled-rest WBGT is finite and names its source', () => {
    const c = cooledRestWbgt()
    expect(Number.isFinite(c.wbgtC)).toBe(true)
    expect(c.source.length).toBeGreaterThan(10)
  })
})

const NOON: EnvSample = {
  t: epochFromLocal('2025-08-01T13:00'),
  taC: 44,
  rhPct: 25,
  tdC: 19.6,
  pHpa: 1000,
  wind10Ms: 2,
  ghiWm2: 900,
  directWm2: 700,
  source: 'archive',
}

describe('engine heat through computeSiteHeat', () => {
  it('the site radiant allowance raises WBGT; "none" ignores it', () => {
    const site = getSite('musaffah')
    const none = hourHeat(NOON, site, 'none')
    const boosted = hourHeat(NOON, site, 'site')
    expect(boosted.wbgtC).toBeGreaterThan(none.wbgtC)
    expect(none.wbgtShadeC).toBeLessThan(none.wbgtC)
  })

  it('heat columns carry local hour, month and day index', () => {
    const second: EnvSample = { ...NOON, t: NOON.t + 24 * 3_600_000 + 3_600_000 }
    const c = heatColumns([NOON, second], getSite('saadiyat'))
    expect(c.n).toBe(2)
    expect([c.hour[0], c.hour[1]]).toEqual([13, 14])
    expect([c.month[0], c.dayIndex[0], c.dayIndex[1]]).toEqual([8, 0, 1])
    expect(c.wbgtC[0]).toBe(hourHeat(NOON, getSite('saadiyat'), 'none').wbgtC)
  })
})

describe('airport obs-met samples', () => {
  const obs: MetarObservation = {
    t: NOON.t,
    taC: 41,
    tdC: 24,
    rhPct: 39,
    windDirDeg: 320,
    windMs: 4.1,
    gustMs: null,
    qnhHpa: 1001,
    visibilityKm: 8,
    cavok: false,
    wx: 'HZ',
    sky1: null,
  }

  it('use METAR T, Td and wind with the model radiation and surface pressure', () => {
    if (!metarUsable(obs)) throw new Error('fixture should be usable')
    const s = obsMetSample(obs, NOON)
    expect([s.taC, s.tdC, s.wind10Ms]).toEqual([41, 24, 4.1])
    expect([s.ghiWm2, s.directWm2, s.pHpa, s.t]).toEqual([900, 700, 1000, NOON.t])
    expect(s.radiantBoostC).toBe(0)
    const m = modelThermoObsWindSample(NOON, obs)
    expect([m.taC, m.tdC, m.wind10Ms]).toEqual([44, 19.6, 4.1])
  })

  it('reports a METAR without wind or dew point as unusable', () => {
    expect(metarUsable({ ...obs, windMs: null })).toBe(false)
    expect(metarUsable({ ...obs, tdC: null })).toBe(false)
    expect(metarUsable(undefined)).toBe(false)
  })
})

describe('provenance, stamp and documents', () => {
  it('records input hashes and checks weather files against the manifest', () => {
    const prov = new Provenance()
    prov.readJson('public/data/weather/archive/alain_2020.json')
    const [r] = prov.records()
    expect(r.path).toBe('public/data/weather/archive/alain_2020.json')
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.manifestMatch).toBe(true)
    const stamp = codeStamp(prov.inputsSha256())
    expect(stamp.stamp).toMatch(/^zill@\d+\.\d+\.\d+\+code\.[0-9a-f]{12}\+inputs\.[0-9a-f]{12}$/)
    expect(codeStamp(prov.inputsSha256()).codeSha256).toBe(stamp.codeSha256)
  })

  it('replaces only marked blocks and reports blocks without data', () => {
    const text = 'a\n<!-- validate:begin:x -->\nold\n<!-- validate:end:x -->\nb\n<!-- validate:begin:y -->\n<!-- validate:end:y -->\n'
    const r = replaceValidationBlocks(text, { x: 'NEW' })
    expect(r.text).toBe('a\n<!-- validate:begin:x -->\nNEW\n<!-- validate:end:x -->\nb\n<!-- validate:begin:y -->\n<!-- validate:end:y -->\n')
    expect(r.updated).toEqual(['x'])
    expect(r.missing).toEqual(['y'])
    expect(mdTable(['a|b', 'c'], [[1, null]])).toBe('| a\\|b | c |\n|---|---|\n| 1 | — |')
  })
})

describe('reference agreement run', () => {
  it('reproduces every fixture within the unit-test tolerances and is deterministic', () => {
    const a = runReference({ write: false, log: false })
    const b = runReference({ write: false, log: false })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.checks.length).toBeGreaterThanOrEqual(35)
    expect(a.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual([])
    for (const c of a.checks) {
      expect(c.nValues).toBeGreaterThan(0)
      expect(c.toleranceSource.length).toBeGreaterThan(5)
    }
  })
})
