import { describe, it, expect } from 'vitest'
import {
  KELVIN_OFFSET,
  cToK,
  kToC,
  cToF,
  fToC,
  deltaCToF,
  deltaFToC,
  kmhToMs,
  msToKmh,
  hpaToKpa,
  kpaToHpa,
  duboisBsaM2,
  wm2ToW,
  wToWm2,
  W_M2_PER_MET,
  metToWm2,
  wm2ToMet,
  W_PER_KCAL_H,
  kcalhToW,
  wToKcalh,
  usQuartToL,
  lToUsQuart,
  usFlOzToMl,
  mlToUsFlOz,
  lToMl,
  mlToL,
} from './units'

describe('temperature conversions', () => {
  it('°C ↔ K uses the exact 273.15 offset', () => {
    expect(KELVIN_OFFSET).toBe(273.15)
    expect(cToK(30)).toBeCloseTo(303.15, 12)
    expect(kToC(cToK(46.2))).toBeCloseTo(46.2, 12)
  })

  it('°C ↔ °F matches the scale definition and the NIOSH 27.8 °C = 82 °F example', () => {
    expect(cToF(100)).toBeCloseTo(212, 12)
    expect(cToF(-40)).toBeCloseTo(-40, 12)
    expect(fToC(82)).toBeCloseTo(27.78, 2)
    expect(fToC(cToF(33.3))).toBeCloseTo(33.3, 12)
  })

  it('temperature differences convert without offset', () => {
    expect(deltaCToF(1)).toBeCloseTo(1.8, 12)
    expect(deltaFToC(1.8)).toBeCloseTo(1, 12)
  })
})

describe('speed and pressure conversions', () => {
  it('km/h ↔ m/s', () => {
    expect(kmhToMs(36)).toBeCloseTo(10, 12)
    expect(msToKmh(kmhToMs(13.7))).toBeCloseTo(13.7, 12)
  })

  it('hPa ↔ kPa', () => {
    expect(hpaToKpa(1013.25)).toBeCloseTo(101.325, 12)
    expect(kpaToHpa(hpaToKpa(983.7))).toBeCloseTo(983.7, 12)
  })
})

describe('body surface area and metabolic units', () => {
  it('DuBois BSA gives 1.937871486 m² for 75 kg / 1.80 m (phs_iso7933.md §3)', () => {
    expect(duboisBsaM2(75, 180)).toBeCloseTo(1.937871486, 9)
  })

  it('W/m² ↔ W through the body surface area', () => {
    const bsa = duboisBsaM2(75, 175)
    expect(wm2ToW(150, bsa)).toBeCloseTo(150 * bsa, 12)
    expect(wToWm2(wm2ToW(230, bsa), bsa)).toBeCloseTo(230, 12)
  })

  it('1 met = 58.15 W/m² (pythermalcomfort met_to_w_m2)', () => {
    expect(W_M2_PER_MET).toBe(58.15)
    expect(metToWm2(2)).toBeCloseTo(116.3, 12)
    expect(wm2ToMet(metToWm2(3.4))).toBeCloseTo(3.4, 12)
  })

  it('kcal/h → W uses the exact 1.163 (NIOSH example 300 kcal/h = 348.9 W)', () => {
    expect(W_PER_KCAL_H).toBe(1.163)
    expect(kcalhToW(300)).toBeCloseTo(348.9, 9)
    expect(wToKcalh(kcalhToW(415))).toBeCloseTo(415, 12)
  })
})

describe('fluid volumes', () => {
  it('TB MED 507 caps: 1.5 qt/h = 1.42 L/h and 12 qt/day = 11.36 L/day', () => {
    expect(usQuartToL(1.5)).toBeCloseTo(1.42, 2)
    expect(usQuartToL(12)).toBeCloseTo(11.356, 3)
    expect(lToUsQuart(usQuartToL(2))).toBeCloseTo(2, 12)
  })

  it('8 US fl oz = 1 cup = 236.588 mL (NIOSH cadence)', () => {
    expect(usFlOzToMl(8)).toBeCloseTo(236.5882365, 7)
    expect(mlToUsFlOz(usFlOzToMl(12))).toBeCloseTo(12, 12)
  })

  it('L ↔ mL', () => {
    expect(lToMl(1.42)).toBeCloseTo(1420, 9)
    expect(mlToL(250)).toBeCloseTo(0.25, 12)
  })
})
