import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ACCLIMATIZATION_SCHEDULES,
  ACGIH_CAV_C,
  ACGIH_METABOLIC_W,
  ACGIH_SCREENING_C,
  ACGIH_SCREENING_ROWS,
  ADOSH_TG_REACCLIMATIZATION,
  CLOTHING,
  DUBAI_MUNICIPALITY_HI_LEVELS,
  FLUID_MAX_ML_PER_DAY,
  FLUID_MAX_ML_PER_HOUR,
  HOOD_ADDITION_C,
  HYDRATION,
  ISO8996_2004_CLASSES,
  LIMITS_BASIS,
  NIOSH_HAS_CEILING_LIMIT,
  NIOSH_LIMIT_CORRECTION_C,
  TBMED507_TABLE_3_2,
  TBMED507_TABLE_3_3,
  TBMED507_WORK_W,
  TYPICAL_TASKS,
  US_FL_OZ_ML,
  US_QUART_L,
  acclimatizationFraction,
  acgihCavC,
  acgihScreeningAllocation,
  acgihScreeningCell,
  allowedWorkFraction,
  assessAcclimatization,
  clothingAdjustmentC,
  dubaiHeatIndexLevel,
  duBoisAreaM2,
  exposureLimitC,
  heatIndexNwsC,
  heatIndexNwsDetail,
  heatIndexNwsF,
  iloWaterLPerH,
  kcalPerHourToW,
  nioshHeatAlert,
  nwsHeatIndexCategory,
  oshaHeatIndexRiskLevel,
  oshaNprmTriggerHi,
  oshaNprmTriggerWbgt,
  ralC,
  recommendWaterMlPerHour,
  relC,
  rothfuszF,
  roundHalfUpToHalf,
  scaleMetabolicRateByMass,
  selectExposureLimit,
  sustainedHrLimitBpm,
  taskMetabolicW,
  tbmed507Category,
  tbmed507CategoryF,
  tbmed507Guidance,
  tbmed507WorkLevel,
  twa,
  wbgtEffectiveC,
  workCapacityIsoBrodePct,
  workCapacityNioshPct,
  workClassForWm2,
  type AcclimatizationScheduleId,
  type AcgihAllocation,
  type AcgihEnsembleId,
  type AcgihScreeningCategory,
  type AllowedWorkBinding,
  type TbMed507Category,
  type TbMed507Work,
} from './limits'
import type { ClothingId, WorkClass } from './types'

// ───────────────────────────── Fixture plumbing ─────────────────────────────

interface FixtureVector {
  id: string
  group: string
  fn: string
  inputs: Record<string, unknown>
  expected: Record<string, unknown>
  tol: { abs?: number; exact?: boolean; chartAbsAfterRounding?: number }
  note: string
}

interface LimitsFixture {
  constants: Record<string, unknown>
  summary: {
    noaa_chart: { cells: number; rothfusz_exact: number; rothfusz_within_1F: number; nws_full_exact: number; nws_full_within_1F: number }
  }
  checks: { check: string; pass: boolean }[]
  vectors: FixtureVector[]
}

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/limits.json', import.meta.url), 'utf8')) as LimitsFixture
const vectors = (group: string): FixtureVector[] => fixture.vectors.filter((v) => v.group === group)

function num(x: unknown, label = 'value'): number {
  if (typeof x !== 'number') throw new Error(`${label}: expected a number, got ${JSON.stringify(x)}`)
  return x
}
function str(x: unknown, label = 'value'): string {
  if (typeof x !== 'string') throw new Error(`${label}: expected a string, got ${JSON.stringify(x)}`)
  return x
}

/** Max absolute error seen per fixture group (printed when ZILL_REPORT_ACCURACY is set). */
const maxErr: Record<string, number> = {}
function close(group: string, actual: number, expected: unknown, tol: number, label: string): void {
  const err = Math.abs(actual - num(expected, label))
  maxErr[group] = Math.max(maxErr[group] ?? 0, err)
  expect(err, `${label}: got ${actual}, expected ${String(expected)}`).toBeLessThanOrEqual(tol)
}
afterAll(() => {
  if (process.env.ZILL_REPORT_ACCURACY) console.log('limits max abs errors by group:', JSON.stringify(maxErr))
})

const cToF = (c: number): number => 1.8 * c + 32
const fToC = (f: number): number => (f - 32) / 1.8

describe('fixture sanity', () => {
  it('oracle self-checks all pass', () => {
    expect(fixture.checks.length).toBe(71)
    expect(fixture.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual([])
  })

  it('every vector group is exercised by this suite', () => {
    const handled = new Set([
      'niosh_ral_rel', 'acgih_screening_table', 'allowed_work_fraction', 'twa', 'metabolic_scaling', 'units', 'clothing',
      'work_capacity_pythermalcomfort', 'heat_index_nws', 'heat_index_chart_crosscheck', 'osha_table2_reference', 'tbmed507',
      'hydration', 'osha_hi_risk', 'osha_nprm', 'acclimatization',
    ])
    expect(fixture.vectors.length).toBe(184)
    expect([...new Set(fixture.vectors.map((v) => v.group))].filter((g) => !handled.has(g))).toEqual([])
  })
})

// ───────────────────────────── NIOSH REL / RAL ─────────────────────────────

describe('NIOSH REL / RAL (NIOSH 2016 §8.1)', () => {
  it.each(vectors('niosh_ral_rel').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const mW = num(v.inputs.mW)
    const tol = v.tol.abs ?? 1e-9
    if (v.fn === 'ralC/relC') {
      close(v.group, ralC(mW), v.expected.ralC, tol, 'RAL')
      close(v.group, relC(mW), v.expected.relC, tol, 'REL')
    } else {
      const value = v.fn === 'relC' ? relC(mW) : ralC(mW)
      close(v.group, value, v.expected.valueC, 1e-9, 'equation')
      close(v.group + '_published2dp', value, v.expected.publishedC_2dp, tol, 'published 2-dp answer')
    }
  })

  it('has no ceiling limit (removed in NIOSH 2016) and no upper clamp on M', () => {
    expect(NIOSH_HAS_CEILING_LIMIT).toBe(false)
    expect(exposureLimitC(800, 'REL')).toBeLessThan(exposureLimitC(600, 'REL'))
    expect(exposureLimitC(800, 'RAL')).toBeCloseTo(ralC(800), 12)
  })

  it('clamps M below 115 W to 115 W (protective) and RAL is below REL', () => {
    expect(exposureLimitC(90, 'RAL')).toBe(ralC(115))
    expect(exposureLimitC(90, 'REL')).toBe(relC(115))
    for (const m of [115, 180, 300, 415, 520, 600]) expect(ralC(m)).toBeLessThan(relC(m))
    expect(() => exposureLimitC(Number.NaN, 'REL')).toThrow(RangeError)
  })

  it('selects REL only for an acclimatised worker outside conservative mode', () => {
    expect(selectExposureLimit('acclimatized')).toBe('REL')
    expect(selectExposureLimit('acclimatized', true)).toBe('RAL')
    expect(selectExposureLimit('acclimatizing')).toBe('RAL')
    expect(selectExposureLimit('unacclimatized')).toBe('RAL')
    expect(selectExposureLimit(undefined)).toBe('RAL')
  })

  it('OSHA whole-degree table equals the equations within 1 °C (osha_table2_reference)', () => {
    for (const v of vectors('osha_table2_reference')) {
      const mW = num(v.inputs.mW)
      close(v.group, ralC(mW), v.expected.ralC, 1e-9, `${v.id} RAL`)
      close(v.group, relC(mW), v.expected.relC, 1e-9, `${v.id} REL`)
      expect(Math.abs(ralC(mW) - num(v.expected.oshaPublishedActionLimitC))).toBeLessThan(1)
      expect(Math.abs(relC(mW) - num(v.expected.oshaPublishedTlvC))).toBeLessThan(1)
    }
  })
})

// ───────────────────────────── ACGIH Table 2 ─────────────────────────────

describe('ACGIH Table 2 screening criteria', () => {
  it.each(vectors('acgih_screening_table').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const cell = acgihScreeningCell(str(v.inputs.category) as AcgihScreeningCategory, str(v.inputs.allocation) as AcgihAllocation)
    const e = v.expected
    expect(cell.workFraction).toBe(num(v.inputs.workFraction))
    close(v.group, cell.mTwaW, e.mTwaW, 1e-9, 'M_TWA')
    close(v.group, cell.tlvRawC, e.tlvRawC, 1e-9, 'TLV raw')
    close(v.group, cell.alRawC, e.alRawC, 1e-9, 'AL raw')
    expect(cell.tlvRoundedC).toBe(e.tlvRoundedC)
    expect(cell.alRoundedC).toBe(e.alRoundedC)
    expect(cell.publishedTlvC).toBe(e.publishedTlvC)
    expect(cell.publishedAlC).toBe(e.publishedAlC)
    expect(cell.screeningAvailable).toBe(e.screeningAvailable)
  })

  it('reproduces every published cell exactly from the equations (rest 115 W, nearest 0.5 °C half-up)', () => {
    const categories: AcgihScreeningCategory[] = ['light', 'moderate', 'heavy', 'very_heavy']
    let reproduced = 0
    for (const { allocation } of ACGIH_SCREENING_ROWS) {
      for (const category of categories) {
        const cell = acgihScreeningCell(category, allocation)
        expect(cell.publishedTlvC === null).toBe(cell.publishedAlC === null)
        if (cell.publishedTlvC !== null && cell.publishedAlC !== null) {
          expect(cell.tlvRoundedC, `TLV ${allocation} ${category}`).toBe(cell.publishedTlvC)
          expect(cell.alRoundedC, `AL ${allocation} ${category}`).toBe(cell.publishedAlC)
          reproduced += 2
        } else {
          expect(cell.screeningAvailable).toBe(false)
        }
      }
    }
    expect(reproduced).toBe(26)
  })

  it('transcribed tables equal the oracle constants', () => {
    expect(ACGIH_SCREENING_C.tlv).toEqual(fixture.constants.acgih_table2_tlv_C)
    expect(ACGIH_SCREENING_C.actionLimit).toEqual(fixture.constants.acgih_table2_al_C)
    expect(ACGIH_METABOLIC_W).toEqual(fixture.constants.acgih_metabolic_W)
  })

  it('rounds half-up to 0.5', () => {
    expect(roundHalfUpToHalf(30.24)).toBe(30)
    expect(roundHalfUpToHalf(30.25)).toBe(30.5)
    expect(roundHalfUpToHalf(30.76)).toBe(31)
  })

  it('screening lookup matches the CCOHS worked examples', () => {
    expect(acgihScreeningAllocation(27.0, 'moderate', 'RAL')).toBe('25-50')
    expect(acgihScreeningAllocation(28 + 3, 'moderate', 'REL')).toBe('0-25')
    expect(acgihScreeningAllocation(33, 'moderate', 'REL')).toBeNull()
    // Very heavy continuous work is never screened (blank cells), so the first published row is 25–50 %.
    expect(acgihScreeningAllocation(20, 'very_heavy', 'REL')).toBe('25-50')
  })
})

// ───────────────────────────── TWA and allowed work fraction ─────────────────────────────

const BRANCH_TO_BINDING: Record<string, AllowedWorkBinding> = {
  continuous_ok: 'continuous_ok',
  bisection: 'work_rest',
  rest_exceeds_limit: 'rest_exceeds_limit',
}

describe('allowed work fraction (1-h TWA vs REL/RAL)', () => {
  it.each(vectors('allowed_work_fraction').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const i = v.inputs
    const r = allowedWorkFraction({
      workW: num(i.mWorkW),
      restW: num(i.mRestW),
      wbgtWorkEffC: num(i.wbgtWorkC),
      wbgtRestEffC: num(i.wbgtRestC),
      limit: i.acclimatized === true ? 'REL' : 'RAL',
    })
    const tol = v.tol.abs ?? 1e-6
    close(v.group, r.f, v.expected.f, tol, 'f')
    close(v.group, r.workMinPerHour, v.expected.workMinPerHour, tol * 60, 'work min/h')
    close(v.group, r.marginC, v.expected.marginAtFullWorkC, tol, 'margin at full work')
    expect(r.binding).toBe(BRANCH_TO_BINDING[str(v.expected.branch)])
  })

  it('spec example: moderate 300 W, RAL, sun 30 °C / shade 28 °C → f = 0.2808', () => {
    const r = allowedWorkFraction({ workW: 300, wbgtWorkEffC: 30, wbgtRestEffC: 28, limit: 'RAL' })
    expect(r.f).toBeCloseTo(0.2808, 4)
    expect(r.workMinPerHour).toBeCloseTo(16.85, 2)
    expect(r.restMinPerHour).toBeCloseTo(60 - r.workMinPerHour, 12)
    expect(r.binding).toBe('work_rest')
    expect(r.limit).toBe('RAL')
    // On the root the TWA limit equals the TWA WBGT_eff, and the solution is on the feasible side.
    expect(r.limitC).toBeCloseTo(r.wbgtTwaEffC, 9)
    expect(r.limitC - r.wbgtTwaEffC).toBeGreaterThanOrEqual(0)
    expect(r.mTwaW).toBeCloseTo(r.f * 300 + (1 - r.f) * 115, 9)
  })

  it('is monotone: hotter work site → less work; REL allows at least as much as RAL', () => {
    let prev = 1
    for (let w = 26; w <= 36; w += 0.5) {
      const rel = allowedWorkFraction({ workW: 415, wbgtWorkEffC: w, wbgtRestEffC: 27, limit: 'REL' })
      const ral = allowedWorkFraction({ workW: 415, wbgtWorkEffC: w, wbgtRestEffC: 27, limit: 'RAL' })
      expect(rel.f).toBeLessThanOrEqual(prev + 1e-12)
      expect(rel.f).toBeGreaterThanOrEqual(ral.f)
      prev = rel.f
    }
  })

  it('reports the continuous-work margin and the extrapolation flag', () => {
    const ok = allowedWorkFraction({ workW: 300, wbgtWorkEffC: 27, wbgtRestEffC: 27, limit: 'REL' })
    expect(ok.f).toBe(1)
    expect(ok.marginC).toBeCloseTo(relC(300) - 27, 12)
    expect(ok.limitAtFullWorkC).toBeCloseTo(relC(300), 12)
    expect(ok.extrapolated).toBe(false)
    expect(allowedWorkFraction({ workW: 650, wbgtWorkEffC: 20, wbgtRestEffC: 20, limit: 'REL' }).extrapolated).toBe(true)
  })

  it('clamps rates below 115 W (protective) and rejects non-finite input', () => {
    const low = allowedWorkFraction({ workW: 80, restW: 60, wbgtWorkEffC: 31, wbgtRestEffC: 31, limit: 'RAL' })
    const at115 = allowedWorkFraction({ workW: 115, restW: 115, wbgtWorkEffC: 31, wbgtRestEffC: 31, limit: 'RAL' })
    expect(low.f).toBe(at115.f)
    expect(low.binding).toBe('rest_exceeds_limit')
    expect(() => allowedWorkFraction({ workW: 300, wbgtWorkEffC: Number.NaN, wbgtRestEffC: 28, limit: 'REL' })).toThrow(RangeError)
  })

  it('time-weighted averages (ISO 7243:2017 Formula (4))', () => {
    for (const v of vectors('twa')) {
      const values = (v.inputs.values as unknown[]).map((x) => num(x))
      const minutes = (v.inputs.minutes as unknown[]).map((x) => num(x))
      const value = twa(values, minutes)
      close(v.group, value, v.expected.value, v.tol.abs ?? 1e-12, v.id)
      if (v.expected.relAtTwaC !== undefined) {
        close(v.group, relC(value), v.expected.relAtTwaC, 1e-9, `${v.id} REL at TWA`)
        close(v.group, ralC(value), v.expected.ralAtTwaC, 1e-9, `${v.id} RAL at TWA`)
      }
    }
    expect(() => twa([1, 2], [30])).toThrow(RangeError)
    expect(() => twa([1], [0])).toThrow(RangeError)
    expect(() => twa([1, 2], [30, -5])).toThrow(RangeError)
  })
})

// ───────────────────────────── Metabolic rate ─────────────────────────────

describe('metabolic rate (ISO 8996:2004, ACGIH Table 3)', () => {
  it('body-mass scaling and kcal/h conversion match the published worked answers', () => {
    for (const v of vectors('metabolic_scaling')) {
      const w = scaleMetabolicRateByMass(num(v.inputs.mW), num(v.inputs.massKg))
      close(v.group, w, v.expected.mW, 1e-9, v.id)
      close(v.group + '_published2dp', w, v.expected.publishedW_2dp, v.tol.abs ?? 0.005, `${v.id} published`)
    }
    for (const v of vectors('units')) close(v.group, kcalPerHourToW(num(v.inputs.kcalPerH)), v.expected.w, 1e-9, v.id)
  })

  it('ISO 8996:2004 classes and W equivalents', () => {
    const means = (['rest', 'light', 'moderate', 'heavy', 'very_heavy'] as WorkClass[]).map((c) => ISO8996_2004_CLASSES[c].meanWm2)
    expect(means).toEqual([65, 100, 165, 230, 290])
    expect(ISO8996_2004_CLASSES.moderate.meanW).toBe(295)
    expect(ISO8996_2004_CLASSES.heavy.rangeW).toEqual([360, 465])
    expect(ISO8996_2004_CLASSES.very_heavy.rangeWm2[1]).toBe(Number.POSITIVE_INFINITY)
  })

  it('classifies W/m² with shared boundaries going to the higher class', () => {
    expect(workClassForWm2(50)).toBe('rest')
    expect(workClassForWm2(69.9)).toBe('rest')
    expect(workClassForWm2(70)).toBe('light')
    expect(workClassForWm2(130)).toBe('moderate')
    expect(workClassForWm2(165)).toBe('moderate')
    expect(workClassForWm2(200)).toBe('heavy')
    expect(workClassForWm2(260)).toBe('very_heavy')
  })

  it('task metabolic rate: ACGIH watts, mass scaling never below 70 kg, 75 kg fail-safe default', () => {
    expect(taskMetabolicW({ workClass: 'moderate' }, 70)).toBe(300)
    expect(taskMetabolicW({ workClass: 'moderate' }, 60)).toBe(300)
    expect(taskMetabolicW({ workClass: 'moderate' }, 90)).toBeCloseTo((300 * 90) / 70, 9)
    expect(taskMetabolicW({ workClass: 'moderate' })).toBeCloseTo((300 * 75) / 70, 9)
    expect(taskMetabolicW({ workClass: 'light', metabolicWm2: 165 }, 70)).toBeCloseTo(297, 9)
  })

  it('typical tasks: forklift / mobile equipment is Moderate (fact-check correction)', () => {
    expect(TYPICAL_TASKS.find((t) => t.id === 'forklift_mobile_equipment')?.workClass).toBe('moderate')
    expect(TYPICAL_TASKS.find((t) => t.id === 'welding')?.workClass).toBe('heavy')
    expect(TYPICAL_TASKS.find((t) => t.id === 'sledgehammer')?.workClass).toBe('very_heavy')
    expect(new Set(TYPICAL_TASKS.map((t) => t.id)).size).toBe(TYPICAL_TASKS.length)
  })

  it('DuBois area for 70 kg / 1.75 m ≈ 1.844 m²', () => {
    expect(duBoisAreaM2(70, 175)).toBeCloseTo(1.844, 3)
  })
})

// ───────────────────────────── Clothing ─────────────────────────────

describe('clothing adjustment (ACGIH 2026 Table 1)', () => {
  it.each(vectors('clothing').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const cav = acgihCavC(str(v.inputs.clothing) as AcgihEnsembleId, v.inputs.hood === true)
    const wbgtEff = num(v.inputs.wbgtC) + cav
    close(v.group, cav, v.expected.cavC, 1e-12, 'CAV')
    close(v.group, wbgtEff, v.expected.wbgtEffC, 1e-12, 'WBGT_eff')
    expect(acgihScreeningAllocation(wbgtEff, 'moderate', 'REL')).toBe(v.expected.acgihModerateAcclimatizedAllocation)
  })

  it('transcribed CAVs equal the oracle constants', () => {
    expect(ACGIH_CAV_C).toEqual(fixture.constants.acgih_cav_C)
    expect(HOOD_ADDITION_C).toBe(fixture.constants.acgih_hood_addition_C)
    expect(NIOSH_LIMIT_CORRECTION_C).toEqual({ twoLayer: -2, partiallyImpermeableOrAprons: -4 })
  })

  it('engine ensembles: never negative, not additive, hood +1, FR = 0, unknown → cloth coveralls', () => {
    const expected: Record<ClothingId, number> = {
      work_clothes: 0, cloth_coveralls: 0, fr_coveralls: 0, sms_coveralls: 0.5, polyolefin_coveralls: 1, double_layer: 3, vapour_barrier: 11,
    }
    for (const id of Object.keys(expected) as ClothingId[]) {
      expect(CLOTHING[id].id).toBe(id)
      expect(clothingAdjustmentC(id)).toBe(expected[id])
      expect(clothingAdjustmentC(id, true)).toBe(expected[id] + 1)
      expect(CLOTHING[id].cavC).toBeGreaterThanOrEqual(0)
    }
    expect(clothingAdjustmentC(undefined)).toBe(0)
    expect(wbgtEffectiveC(30, 'double_layer', true)).toBe(34)
    expect(wbgtEffectiveC(30, undefined)).toBe(30)
  })

  it('PHS inputs: vapour barrier excluded from PHS; FR and nonwoven values flagged unverified', () => {
    expect(CLOTHING.vapour_barrier.phs.applicable).toBe(false)
    expect(CLOTHING.vapour_barrier.physiologicalMonitoringAdvised).toBe(true)
    expect(CLOTHING.fr_coveralls.phs.verified).toBe(false)
    expect(CLOTHING.sms_coveralls.phs.verified).toBe(false)
    expect(CLOTHING.work_clothes.phs).toMatchObject({ clo: 0.6, imst: 0.38, verified: true })
    for (const spec of Object.values(CLOTHING)) expect(spec.phs.clo).toBeLessThanOrEqual(1.0)
  })
})

// ───────────────────────────── Work capacity (reference) ─────────────────────────────

describe('work capacity (Bröde 2018 / pythermalcomfort, reference only)', () => {
  it.each(vectors('work_capacity_pythermalcomfort').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const fn = v.fn === 'workCapacityNiosh' ? workCapacityNioshPct : workCapacityIsoBrodePct
    close(v.group, fn(num(v.inputs.wbgtC), num(v.inputs.mW)), v.expected.capacityPct, v.tol.abs ?? 1e-9, v.id)
  })
})

// ───────────────────────────── Heat index ─────────────────────────────

describe('NWS heat index', () => {
  it.each(vectors('heat_index_nws').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const e = v.expected
    const tol = v.tol.abs ?? 1e-9
    if (v.fn === 'heatIndexNwsF') {
      const tF = num(v.inputs.tF)
      const rh = num(v.inputs.rhPct)
      const d = heatIndexNwsDetail(tF, rh)
      if (e.hiF_textRule !== undefined) {
        // Threshold variant: the engine uses the equation-page text rule (regression only when HI_s ≥ 80 °F).
        close(v.group, d.hiF, e.hiF_textRule, tol, 'text rule')
        expect(d.branch).toBe(e.branch_textRule)
        close(v.group, rothfuszF(tF, rh), e.hiF_jsRule, tol, 'JS rule (regression) value')
        return
      }
      close(v.group, d.hiF, e.hiF, tol, 'HI °F')
      close(v.group, d.hiC, e.hiC, tol, 'HI °C')
      close(v.group, d.simpleF, e.simpleF, tol, 'simple °F')
      close(v.group, d.adjustmentF, e.adjustmentF, tol, 'adjustment °F')
      expect(d.branch).toBe(e.branch)
      expect(heatIndexNwsF(tF, rh)).toBe(d.hiF)
      expect(nwsHeatIndexCategory(d.hiF)).toBe(e.nwsCategory)
      expect(oshaHeatIndexRiskLevel(d.hiF)).toBe(e.oshaRiskLevel)
    } else {
      const tC = num(v.inputs.tC)
      const rh = num(v.inputs.rhPct)
      const hiC = heatIndexNwsC(tC, rh)
      const d = heatIndexNwsDetail(cToF(tC), rh)
      close(v.group, hiC, e.hiC, tol, 'HI °C')
      expect(d.branch).toBe(e.branch)
      if (e.hiF !== undefined) close(v.group, d.hiF, e.hiF, tol, 'HI °F')
      if (e.rothfuszOnlyC !== undefined) {
        const rothC = fToC(rothfuszF(cToF(tC), rh))
        close(v.group, rothC, e.rothfuszOnlyC, tol, 'Rothfusz only °C')
        // pythermalcomfort's °C polynomial agrees with the bare regression within 2e-5 °C (oracle assertion).
        expect(Math.abs(rothC - num(e.pythermalcomfortHiC))).toBeLessThan(2e-5)
      }
      if (e.nwsCategory !== undefined) expect(nwsHeatIndexCategory(d.hiF)).toBe(e.nwsCategory)
      if (e.oshaRiskLevel !== undefined) expect(oshaHeatIndexRiskLevel(d.hiF)).toBe(e.oshaRiskLevel)
    }
  })

  it('Abu Dhabi worked examples: 45 °C / 15 % → 44.45 °C; 40 °C / 45 % → 51.34 °C', () => {
    expect(Math.abs(heatIndexNwsC(45, 15) - 44.45)).toBeLessThan(0.01)
    expect(Math.abs(heatIndexNwsC(40, 45) - 51.34)).toBeLessThan(0.01)
    expect(Math.abs(heatIndexNwsC(33, 75) - 45.72)).toBeLessThan(0.01)
    expect(dubaiHeatIndexLevel(heatIndexNwsC(45, 15))).toBe('high')
    expect(dubaiHeatIndexLevel(heatIndexNwsC(40, 45))).toBe('very_high')
  })

  it('NOAA chart cross-check cells (NIOSH 2016 App. C)', () => {
    for (const v of vectors('heat_index_chart_crosscheck')) {
      const tF = num(v.inputs.tF)
      const rh = num(v.inputs.rhPct)
      close(v.group, heatIndexNwsF(tF, rh), v.expected.nwsFullF, 1e-9, `${v.id} full NWS`)
      close(v.group, rothfuszF(tF, rh), v.expected.rothfuszOnlyF, 1e-9, `${v.id} Rothfusz`)
      expect(heatIndexNwsDetail(tF, rh).branch).toBe(v.expected.nwsBranch)
      expect(Math.abs(Math.round(rothfuszF(tF, rh)) - num(v.expected.chartF))).toBeLessThanOrEqual(1)
    }
  })

  it('all 135 NOAA chart cells agree as the oracle summary states', () => {
    const chart = fixture.constants.noaa_chart_F_niosh2016_appC as Record<string, number[]>
    let cells = 0
    let rothExact = 0
    let rothWithin1 = 0
    let nwsWithin1 = 0
    for (const [rhKey, row] of Object.entries(chart)) {
      row.forEach((chartF, i) => {
        const tF = 80 + 2 * i
        const rh = Number(rhKey)
        const roth = Math.round(rothfuszF(tF, rh))
        cells++
        if (roth === chartF) rothExact++
        if (Math.abs(roth - chartF) <= 1) rothWithin1++
        if (Math.abs(Math.round(heatIndexNwsF(tF, rh)) - chartF) <= 1) nwsWithin1++
      })
    }
    const s = fixture.summary.noaa_chart
    expect(cells).toBe(s.cells)
    expect(rothExact).toBe(s.rothfusz_exact)
    expect(rothWithin1).toBe(s.rothfusz_within_1F)
    expect(nwsWithin1).toBe(s.nws_full_within_1F)
  })

  it('clamps RH to 0–100 % and rejects non-finite input', () => {
    expect(heatIndexNwsF(100, 104)).toBe(heatIndexNwsF(100, 100))
    expect(heatIndexNwsF(100, -3)).toBe(heatIndexNwsF(100, 0))
    expect(() => heatIndexNwsC(Number.NaN, 40)).toThrow(RangeError)
  })

  it('OSHA heat-index risk levels and NWS classes at their boundaries', () => {
    for (const v of vectors('osha_hi_risk')) {
      const hiF = num(v.inputs.hiF)
      expect(oshaHeatIndexRiskLevel(hiF), v.id).toBe(v.expected.level)
      expect(nwsHeatIndexCategory(hiF), v.id).toBe(v.expected.nwsCategory)
    }
  })

  it('Dubai Municipality V2.0 levels, printed gaps resolved to the higher level', () => {
    expect(DUBAI_MUNICIPALITY_HI_LEVELS.map((b) => b.flag)).toEqual(['green', 'yellow', 'amber', 'red'])
    expect(dubaiHeatIndexLevel(30)).toBe('low_caution')
    expect(dubaiHeatIndexLevel(34)).toBe('low_caution')
    expect(dubaiHeatIndexLevel(34.5)).toBe('moderate')
    expect(dubaiHeatIndexLevel(39)).toBe('moderate')
    expect(dubaiHeatIndexLevel(39.5)).toBe('high')
    expect(dubaiHeatIndexLevel(45)).toBe('high')
    expect(dubaiHeatIndexLevel(45.5)).toBe('very_high')
  })
})

// ───────────────────────────── TB MED 507 ─────────────────────────────

describe('TB MED 507 (2022)', () => {
  it.each(vectors('tbmed507').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    if (v.fn === 'tbmed507Category') {
      const cat = v.id.endsWith('F') ? tbmed507CategoryF(num(v.inputs.wbgtF)) : tbmed507Category(num(v.inputs.wbgtC))
      expect(cat).toBe(v.expected.category)
      return
    }
    const e = v.expected
    const g = tbmed507Guidance(num(v.inputs.category) as TbMed507Category, str(v.inputs.work) as TbMed507Work)
    if (g === null) throw new Error('expected guidance')
    expect(g.workRestLabel).toBe(e.workRest)
    close(v.group, g.waterQtPerH, e.waterQtPerH, 1e-12, 'water qt/h')
    close(v.group, g.waterLPerH, e.waterLPerH, 1e-9, 'water L/h')
    expect(g.continuousWorkMin ?? 'NL').toBe(e.continuousWorkMin)
    close(v.group, g.continuousWaterQtPerH, e.continuousWaterQtPerH, 1e-12, 'continuous water qt/h')
    close(v.group, g.continuousWaterLPerH, e.continuousWaterLPerH, 1e-9, 'continuous water L/h')
    expect(g.workW).toBe(e.workW)
  })

  it('transcribed tables equal the oracle constants', () => {
    const t32 = fixture.constants.tbmed507_table3_2 as Record<string, Record<string, [string, number]>>
    const t33 = fixture.constants.tbmed507_table3_3 as Record<string, Record<string, [string | number, number]>>
    for (const cat of [1, 2, 3, 4, 5] as const) {
      for (const work of ['easy', 'moderate', 'heavy', 'very_heavy'] as const) {
        const a = TBMED507_TABLE_3_2[cat][work]
        expect([a.workRest === null ? 'NL' : `${a.workRest[0]}/${a.workRest[1]}`, a.waterQtPerH]).toEqual(t32[cat][work])
        const b = TBMED507_TABLE_3_3[cat][work]
        expect([b.continuousWorkMin ?? 'NL', b.waterQtPerH]).toEqual(t33[cat][work])
      }
    }
    expect(TBMED507_WORK_W).toEqual(fixture.constants.tbmed507_work_W)
    expect(tbmed507Guidance(0, 'heavy')).toBeNull()
  })

  it('maps metabolic rates to the next TB MED column up (protective)', () => {
    expect(tbmed507WorkLevel(180)).toBe('easy')
    expect(tbmed507WorkLevel(300)).toBe('moderate')
    expect(tbmed507WorkLevel(425)).toBe('moderate')
    expect(tbmed507WorkLevel(520)).toBe('heavy')
    expect(tbmed507WorkLevel(601)).toBe('very_heavy')
  })
})

// ───────────────────────────── Hydration ─────────────────────────────

describe('hydration', () => {
  it('fluid caps (TB MED 507 2022; NIOSH 2017-126)', () => {
    const [v] = vectors('hydration')
    const e = v.expected
    close(v.group, HYDRATION.maxLPerH, e.tbmedMaxLPerH, 1e-9, 'hourly cap')
    close(v.group, HYDRATION.maxLPerDay, e.tbmedMaxLPerDay, 1e-9, 'daily cap')
    close(v.group, (48 * US_FL_OZ_ML) / 1000, e.nioshMaxLPerH_48oz, 1e-9, '48 oz')
    close(v.group, HYDRATION.maxLPerH, e.nioshMaxLPerH_48oz, 1e-9, '48 oz = 1½ qt')
    close(v.group, HYDRATION.cupMl, e.nioshCupMl_8oz, 1e-9, 'cup')
    const range = e.nioshPerHourRangeL as number[]
    close(v.group, HYDRATION.typicalLPerH[0], range[0], 1e-9, 'typical low')
    close(v.group, HYDRATION.typicalLPerH[1], range[1], 1e-9, 'typical high')
    expect(US_QUART_L).toBe(fixture.constants.us_quart_L)
    expect(FLUID_MAX_ML_PER_HOUR).toBeCloseTo(1419.53, 2)
    expect(FLUID_MAX_ML_PER_DAY).toBeCloseTo(11356.24, 2)
    const caps = fixture.constants.tbmed507_caps_qt as { per_hour: number; per_day: number }
    expect(HYDRATION.maxLPerH).toBeCloseTo(caps.per_hour * US_QUART_L, 12)
    expect(HYDRATION.maxLPerDay).toBeCloseTo(caps.per_day * US_QUART_L, 12)
  })

  it('ILO 2024 Table 8 with boundary and gap values in the higher band', () => {
    expect(iloWaterLPerH(24.9, 'low')).toBeNull()
    expect(iloWaterLPerH(25, 'low')).toBe(0.35)
    expect(iloWaterLPerH(28.0, 'low')).toBe(0.4)
    expect(iloWaterLPerH(29.4, 'moderate')).toBe(0.55)
    expect(iloWaterLPerH(29.45, 'moderate')).toBe(0.6)
    expect(iloWaterLPerH(30.9, 'moderate')).toBe(0.6)
    expect(iloWaterLPerH(30.95, 'moderate')).toBe(0.65)
    expect(iloWaterLPerH(32.4, 'high')).toBe(0.8)
    expect(iloWaterLPerH(32.45, 'high')).toBe(0.85)
    expect(iloWaterLPerH(40, 'high')).toBe(0.85)
  })

  it('recommendWaterMlPerHour: NIOSH cadence floor in mild conditions', () => {
    const r = recommendWaterMlPerHour({ workW: 180, workClass: 'light', wbgtC: 24 })
    expect(r.mlPerHour).toBeCloseTo(709.76, 2)
    expect(r.binding).toBe('niosh_cadence')
    expect(r.components.tbmed507Ml).toBeNull()
    expect(r.components.ilo2024Ml).toBeNull()
    expect(r.capped).toBe(false)
    expect(recommendWaterMlPerHour({ workW: 180, workClass: 'light' }).mlPerHour).toBeCloseTo(709.76, 2)
  })

  it('recommendWaterMlPerHour: TB MED 507 table governs in extreme heat', () => {
    const r = recommendWaterMlPerHour({ workW: 520, workClass: 'very_heavy', wbgtC: 33 })
    expect(r.binding).toBe('tbmed507')
    expect(r.mlPerHour).toBeCloseTo(946.35, 2) // CAT 5, heavy (600 W) column: 1 qt/h
    expect(r.components.ilo2024Ml).toBeCloseTo(850, 9)
  })

  it('recommendWaterMlPerHour: hourly cap 1.42 L/h always wins (even over a regulatory figure)', () => {
    const sweat = recommendWaterMlPerHour({ workW: 415, workClass: 'heavy', wbgtC: 31, sweatRateMlPerHour: 2000 })
    expect(sweat.mlPerHour).toBe(FLUID_MAX_ML_PER_HOUR)
    expect(sweat.binding).toBe('hourly_cap')
    expect(sweat.capped).toBe(true)
    const reg = recommendWaterMlPerHour({ workW: 415, workClass: 'heavy', wbgtC: 31, regulatoryMinMlPerHour: 1500 })
    expect(reg.mlPerHour).toBe(FLUID_MAX_ML_PER_HOUR)
    const regBelowCap = recommendWaterMlPerHour({ workW: 415, workClass: 'heavy', wbgtC: 31, regulatoryMinMlPerHour: 1200 })
    expect(regBelowCap.mlPerHour).toBe(1200)
    expect(regBelowCap.binding).toBe('regulatory_minimum')
    for (let w = 20; w <= 40; w += 1) {
      for (const sweatRate of [0, 500, 1000, 3000]) {
        const x = recommendWaterMlPerHour({ workW: 520, workClass: 'very_heavy', wbgtC: w, sweatRateMlPerHour: sweatRate })
        expect(x.mlPerHour).toBeLessThanOrEqual(FLUID_MAX_ML_PER_HOUR)
      }
    }
  })

  it('recommendWaterMlPerHour: daily cap 11.36 L and electrolyte advice after 2 h of sweating', () => {
    const near = recommendWaterMlPerHour({ workW: 300, workClass: 'moderate', wbgtC: 30, intakeTodayMl: 11000 })
    expect(near.mlPerHour).toBeCloseTo(FLUID_MAX_ML_PER_DAY - 11000, 9)
    expect(near.binding).toBe('daily_cap')
    expect(recommendWaterMlPerHour({ workW: 300, workClass: 'moderate', wbgtC: 30, intakeTodayMl: 12000 }).mlPerHour).toBe(0)
    expect(recommendWaterMlPerHour({ workW: 300, workClass: 'moderate', wbgtC: 30, hoursSweating: 2.5 }).electrolytesAdvised).toBe(true)
    expect(recommendWaterMlPerHour({ workW: 300, workClass: 'moderate', wbgtC: 30, hoursSweating: 2 }).electrolytesAdvised).toBe(false)
  })
})

// ───────────────────────────── Acclimatisation ─────────────────────────────

describe('acclimatisation', () => {
  it.each(vectors('acclimatization').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const f = acclimatizationFraction(str(v.inputs.schedule) as AcclimatizationScheduleId, num(v.inputs.day))
    close(v.group, f, v.expected.fraction, v.tol.abs ?? 1e-12, 'fraction')
  })

  it('schedules equal the oracle constants; ADOSH TG ramps as transcribed', () => {
    const fx = fixture.constants.acclimatization_schedules as Record<string, number[]>
    for (const [id, ramp] of Object.entries(fx)) expect(ACCLIMATIZATION_SCHEDULES[id as AcclimatizationScheduleId]).toEqual(ramp)
    expect(ACCLIMATIZATION_SCHEDULES.adosh_tg_new_employee).toEqual([0.2, 0.4, 0.6, 0.8, 1.0])
    expect(ACCLIMATIZATION_SCHEDULES.adosh_tg_experienced_employee).toEqual([0.5, 0.6, 0.8, 1.0, 1.0])
    expect(acclimatizationFraction('niosh_new_worker', 0)).toBe(0.2)
    expect(acclimatizationFraction('niosh_new_worker', Number.NaN)).toBe(0.2)
    expect(acclimatizationFraction('niosh_new_worker', 30)).toBe(1)
  })

  it('new worker, day 1: unacclimatised, 20 % exposure, RAL', () => {
    const a = assessAcclimatization({ daysOnSite: 1, daysAwayRecent: 0, experiencedInHeat: false })
    expect(a).toMatchObject({
      status: 'unacclimatized', dayOfRamp: 1, maxExposureFraction: 0.2, schedule: 'adosh_tg_new_employee', reason: 'new_worker',
      adoshUnacclimatized: true, limit: 'RAL',
    })
    expect(assessAcclimatization({ daysOnSite: 0, daysAwayRecent: 0, experiencedInHeat: false })).toMatchObject({ dayOfRamp: 1, maxExposureFraction: 0.2 })
    expect(a.basis).toContain('ADOSH')
  })

  it('new worker, day 5: full exposure but still ADOSH-unacclimatised (5–7-day allowance)', () => {
    const a = assessAcclimatization({ daysOnSite: 5, daysAwayRecent: 0, experiencedInHeat: false })
    expect(a).toMatchObject({ status: 'unacclimatized', dayOfRamp: 5, maxExposureFraction: 1, limit: 'RAL' })
    expect(assessAcclimatization({ daysOnSite: 7, daysAwayRecent: 0, experiencedInHeat: false }).status).toBe('unacclimatized')
  })

  it('new worker: acclimatising on days 8–14, acclimatised (REL) from day 15', () => {
    const d8 = assessAcclimatization({ daysOnSite: 8, daysAwayRecent: 0, experiencedInHeat: false })
    expect(d8).toMatchObject({ status: 'acclimatizing', dayOfRamp: null, maxExposureFraction: 1, adoshUnacclimatized: false, limit: 'RAL' })
    expect(assessAcclimatization({ daysOnSite: 14, daysAwayRecent: 0, experiencedInHeat: false }).status).toBe('acclimatizing')
    const d15 = assessAcclimatization({ daysOnSite: 15, daysAwayRecent: 0, experiencedInHeat: false })
    expect(d15).toMatchObject({ status: 'acclimatized', reason: 'completed', limit: 'REL', maxExposureFraction: 1 })
  })

  it('experienced worker: acclimatisation retained for absences under 4 days', () => {
    for (const away of [0, 3]) {
      expect(assessAcclimatization({ daysOnSite: 1, daysAwayRecent: away, experiencedInHeat: true })).toMatchObject({
        status: 'acclimatized', schedule: null, reason: 'retained', maxExposureFraction: 1, dayOfRamp: null, limit: 'REL',
      })
    }
    expect(assessAcclimatization({ daysOnSite: 1, daysAwayRecent: 4, experiencedInHeat: true })).toMatchObject({
      status: 'acclimatizing', schedule: 'adosh_tg_experienced_employee', reason: 'returning_after_absence', maxExposureFraction: 0.5,
    })
  })

  it('14 vs 15 days away: ADOSH "off work for more than 14 days" = unacclimatised', () => {
    const d14 = assessAcclimatization({ daysOnSite: 1, daysAwayRecent: 14, experiencedInHeat: true })
    expect(d14).toMatchObject({ status: 'acclimatizing', adoshUnacclimatized: false, maxExposureFraction: 0.5, limit: 'RAL' })
    const d15 = assessAcclimatization({ daysOnSite: 1, daysAwayRecent: 15, experiencedInHeat: true })
    expect(d15).toMatchObject({ status: 'unacclimatized', adoshUnacclimatized: true, maxExposureFraction: 0.5, limit: 'RAL' })
    // Experienced ramp: 14 days away → acclimatised once the 5-day ramp ends; 15 days away → after the 7-day ADOSH window.
    expect(assessAcclimatization({ daysOnSite: 5, daysAwayRecent: 14, experiencedInHeat: true }).status).toBe('acclimatizing')
    expect(assessAcclimatization({ daysOnSite: 6, daysAwayRecent: 14, experiencedInHeat: true }).status).toBe('acclimatized')
    expect(assessAcclimatization({ daysOnSite: 7, daysAwayRecent: 15, experiencedInHeat: true }).status).toBe('unacclimatized')
    expect(assessAcclimatization({ daysOnSite: 8, daysAwayRecent: 15, experiencedInHeat: true }).status).toBe('acclimatized')
  })

  it('absence of 21+ days or unknown history restarts the new-worker ramp (fail-safe)', () => {
    expect(assessAcclimatization({ daysOnSite: 1, daysAwayRecent: 21, experiencedInHeat: true })).toMatchObject({
      status: 'unacclimatized', schedule: 'adosh_tg_new_employee', reason: 'long_absence', maxExposureFraction: 0.2,
    })
    expect(assessAcclimatization({ daysOnSite: 10, daysAwayRecent: 30, experiencedInHeat: true }).status).toBe('acclimatizing')
    expect(assessAcclimatization({ daysOnSite: 1, daysAwayRecent: Number.NaN, experiencedInHeat: true })).toMatchObject({
      status: 'unacclimatized', reason: 'unknown_history', maxExposureFraction: 0.2,
    })
    expect(assessAcclimatization({ daysOnSite: Number.NaN, daysAwayRecent: 0, experiencedInHeat: false }).dayOfRamp).toBe(1)
  })

  it('REL only when acclimatised, for every combination', () => {
    for (const experiencedInHeat of [true, false]) {
      for (let away = 0; away <= 30; away++) {
        for (let day = 0; day <= 20; day++) {
          const a = assessAcclimatization({ daysOnSite: day, daysAwayRecent: away, experiencedInHeat })
          expect(a.limit === 'REL').toBe(a.status === 'acclimatized')
          expect(a.maxExposureFraction).toBeGreaterThan(0)
          expect(a.maxExposureFraction).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('is never less protective than the ADOSH TG re-acclimatisation table', () => {
    for (let away = 0; away <= 40; away++) {
      const rows = ADOSH_TG_REACCLIMATIZATION.filter((r) => away >= r.absenceDays[0] && (r.absenceDays[1] === null || away <= r.absenceDays[1]))
      expect(rows.length).toBeGreaterThan(0)
      for (let day = 1; day <= 10; day++) {
        const engine = assessAcclimatization({ daysOnSite: day, daysAwayRecent: away, experiencedInHeat: true }).maxExposureFraction
        for (const row of rows) {
          const step = day <= row.sequence.length ? row.sequence[day - 1] : 1
          if (step === 'reduced_expectations') expect(engine, `away ${away} day ${day}`).toBeLessThan(1)
          else expect(engine, `away ${away} day ${day}`).toBeLessThanOrEqual(step)
        }
      }
    }
  })
})

// ───────────────────────────── Heat alert and OSHA NPRM ─────────────────────────────

describe('NIOSH Heat Alert (§6.2.6(1)(d))', () => {
  it('declares at a forecast maximum of at least 35 °C', () => {
    expect(nioshHeatAlert(35, [])).toMatchObject({ alert: true, trigger: 'forecast_max_35' })
    expect(nioshHeatAlert(34.9, [34, 34, 34]).alert).toBe(false)
  })

  it('declares at ≥ 32 °C when at least 5 °C above each of the preceding 3 days', () => {
    expect(nioshHeatAlert(34, [27, 29, 28])).toMatchObject({ alert: true, trigger: 'rise_over_preceding', precedingDaysUsed: 3 })
    // 33.3 − 28.3 evaluates to 4.9999999999999964 in binary floating point: a printed 5 °C rise still counts.
    expect(nioshHeatAlert(33.3, [28.3, 28.3, 28.3])).toMatchObject({ alert: true, trigger: 'rise_over_preceding' })
    expect(nioshHeatAlert(34, [30, 29, 28]).alert).toBe(false) // only 4 °C above the warmest preceding day
    expect(nioshHeatAlert(31.9, [20, 20, 20]).alert).toBe(false) // below 32 °C
    expect(nioshHeatAlert(33, [40, 27, 27, 27]).precedingDaysUsed).toBe(3) // only the last three days count
    expect(nioshHeatAlert(33, [40, 27, 27, 27]).alert).toBe(true)
  })
})

describe('OSHA NPRM triggers (proposed, not in force)', () => {
  it.each(vectors('osha_nprm').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    if (v.inputs.hiF !== undefined) {
      expect(oshaNprmTriggerHi(num(v.inputs.hiF))).toBe(v.expected.trigger)
    } else {
      const mW = num(v.inputs.mW)
      expect(oshaNprmTriggerWbgt(num(v.inputs.wbgtC), mW)).toBe(v.expected.trigger)
      close(v.group, ralC(mW), v.expected.ralC, 1e-9, 'RAL')
      close(v.group, relC(mW), v.expected.relC, 1e-9, 'REL')
    }
  })
})

// ───────────────────────────── Misc ─────────────────────────────

describe('heat-strain limits and claims discipline', () => {
  it('ACGIH Table 4 sustained HR limit is 180 − age', () => {
    expect(sustainedHrLimitBpm(40)).toBe(140)
  })

  it('basis strings make no diagnostic or predictive claims', () => {
    const forbidden = /predicts? heat stroke|diagnos|measures? core/i
    for (const s of Object.values(LIMITS_BASIS)) expect(s).not.toMatch(forbidden)
    for (const spec of Object.values(CLOTHING)) expect(spec.basis).not.toMatch(forbidden)
  })
})
