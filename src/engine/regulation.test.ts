import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { epochFromLocal, HOUR_MS } from './time'
import {
  ABU_DHABI_RULE_PACK,
  ADOSH_ACCLIMATIZATION_SCHEDULE_PCT,
  DEFAULT_RULE_PACK,
  QATAR_RULE_PACK,
  RULE_PACKS,
  SHARJAH_RULE_PACK,
  adoshAcclimatizationWorkloadPct,
  adoshReacclimatizationSequence,
  getRulePack,
  heatIncidentNotification,
  heatStressProgramRequired,
  isMiddayBreak,
  middayBreakWindow,
  regulatoryFloor,
  twlWorkCategory,
  twlZone,
} from './regulation'
import type { RegulatoryFloorInput, RulePack } from './regulation'
import { RISK_ORDER } from './types'

/** Abu Dhabi / Sharjah local time (UTC+4). */
const ad = (local: string) => epochFromLocal(local)
/** Qatar local time (UTC+3): one hour later in UTC than the same Abu Dhabi wall-clock time. */
const doha = (local: string) => epochFromLocal(local) + HOUR_MS

const floor = (over: Partial<RegulatoryFloorInput> = {}) =>
  regulatoryFloor({
    t: ad('2026-07-01T08:00'),
    twlWm2: 200,
    outdoorInSun: true,
    acclimatization: 'acclimatized',
    workClass: 'light',
    ...over,
  })

// ─────────────────────────────── Midday break ───────────────────────────────

describe('isMiddayBreak — UAE MoHRE Ministerial Resolution 44/2022 (15 Jun–15 Sep inclusive, 12:30 ≤ t < 15:00)', () => {
  it.each([
    ['2026-07-01T12:29', false],
    ['2026-07-01T12:30', true],
    ['2026-07-01T14:59', true],
    ['2026-07-01T15:00', false],
  ])('%s local → %s', (local, expected) => {
    expect(isMiddayBreak(ad(local))).toBe(expected)
  })

  it.each([
    ['2026-06-14T13:00', false],
    ['2026-06-15T13:00', true],
    ['2026-09-15T13:00', true],
    ['2026-09-16T13:00', false],
  ])('%s local → %s', (local, expected) => {
    expect(isMiddayBreak(ad(local))).toBe(expected)
  })

  it('handles sub-minute instants at both edges and the first/last minute of the season', () => {
    expect(isMiddayBreak(ad('2026-07-01T12:30') - 1)).toBe(false)
    expect(isMiddayBreak(ad('2026-07-01T15:00') - 1)).toBe(true)
    expect(isMiddayBreak(ad('2026-06-15T12:30'))).toBe(true)
    expect(isMiddayBreak(ad('2026-09-15T14:59'))).toBe(true)
    expect(isMiddayBreak(ad('2026-09-16T12:30'))).toBe(false)
  })

  it('uses Abu Dhabi local time (UTC+4), not UTC', () => {
    expect(isMiddayBreak(Date.UTC(2026, 6, 1, 8, 30))).toBe(true) // 12:30 local
    expect(isMiddayBreak(Date.UTC(2026, 6, 1, 12, 30))).toBe(false) // 16:30 local
  })

  it('applies every year on the same calendar dates', () => {
    for (const year of [2024, 2025, 2027, 2028]) {
      expect(isMiddayBreak(ad(`${year}-06-15T12:30`))).toBe(true)
      expect(isMiddayBreak(ad(`${year}-09-16T12:30`))).toBe(false)
    }
  })

  it('Sharjah follows the same federal rule; an unknown time is treated as inside the window (fail-safe)', () => {
    expect(isMiddayBreak(ad('2026-08-01T13:00'), SHARJAH_RULE_PACK)).toBe(true)
    expect(isMiddayBreak(NaN)).toBe(true)
  })

  it('middayBreakWindow returns the local window on season days and null otherwise', () => {
    expect(middayBreakWindow(ad('2026-07-01T07:00'))).toEqual({
      startT: ad('2026-07-01T12:30'),
      endT: ad('2026-07-01T15:00'),
    })
    expect(middayBreakWindow(ad('2026-06-14T13:00'))).toBeNull()
    expect(middayBreakWindow(doha('2026-06-01T08:00'), QATAR_RULE_PACK)).toEqual({
      startT: doha('2026-06-01T10:00'),
      endT: doha('2026-06-01T15:30'),
    })
  })
})

// ─────────────────────────────── TWL zones ───────────────────────────────

describe('twlZone — ADOSH-SF TG v4.0 Table 1 (High < 115, Medium 115–140, Low > 140; boundaries → more protective)', () => {
  it.each([
    [0, 'high'],
    [114.99, 'high'],
    [115, 'high'],
    [115.01, 'medium'],
    [139.99, 'medium'],
    [140, 'medium'],
    [140.01, 'low'],
    [380, 'low'],
  ] as const)('TWL %s → %s', (twl, id) => {
    expect(twlZone(twl)?.id).toBe(id)
  })

  it('maps zones to levels: Low → safe, Medium → caution, High → high', () => {
    expect(twlZone(200)?.level).toBe('safe')
    expect(twlZone(130)?.level).toBe('caution')
    expect(twlZone(100)?.level).toBe('high')
  })

  it('a non-finite TWL resolves to the most protective zone (fail-safe)', () => {
    expect(twlZone(NaN)?.id).toBe('high')
    expect(twlZone(Infinity)?.id).toBe('high')
  })

  it('agrees with the ADOSH zone of every fixtures/twl.json vector (and Sharjah with the four-zone sub-band)', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../fixtures/twl.json', import.meta.url), 'utf8')) as {
      vectors: Array<{
        id: string
        expected: { twl_w_m2: number; zone_adosh: string; low_subzone_bb2002: string | null }
      }>
    }
    for (const v of fixture.vectors) {
      expect(twlZone(v.expected.twl_w_m2)?.id, v.id).toBe(v.expected.zone_adosh.toLowerCase())
      const sharjah =
        v.expected.zone_adosh === 'LOW' && v.expected.low_subzone_bb2002 === 'UNRESTRICTED_GE_220'
          ? 'unrestricted'
          : v.expected.zone_adosh.toLowerCase()
      expect(twlZone(v.expected.twl_w_m2, SHARJAH_RULE_PACK)?.id, v.id).toBe(sharjah)
    }
  })

  it('returns null for a pack without TWL zones (Qatar)', () => {
    expect(twlZone(100, QATAR_RULE_PACK)).toBeNull()
  })

  it('maps ISO 8996 classes to the light/heavy rows (moderate counts as heavy)', () => {
    expect(twlWorkCategory('rest')).toBe('light')
    expect(twlWorkCategory('light')).toBe('light')
    expect(twlWorkCategory('moderate')).toBe('heavy')
    expect(twlWorkCategory('very_heavy')).toBe('heavy')
  })
})

// ─────────────────────────────── Regulatory floor (Abu Dhabi) ───────────────────────────────

describe('regulatoryFloor — Abu Dhabi (ADOSH-SF v4.0 + MoHRE midday break)', () => {
  it('Low zone, acclimatised → safe, continuous self-paced work, 0.6–1.0 L/h', () => {
    const r = floor({ twlWm2: 200 })
    expect(r.packId).toBe('abu-dhabi')
    expect(r.level).toBe('safe')
    expect(r.zone?.id).toBe('low')
    expect(r.workMinPerHour).toBe(60)
    expect(r.waterLph).toMatchObject({ minLph: 0.6, maxLph: 1.0 })
    expect(r.actions).toEqual(['drink_water'])
    expect(r.noLoneWork).toBe(false)
    expect(r.unacclimatizedExcluded).toBe(false)
    expect(r.drivers[0]).toMatchObject({ id: 'twl_zone_low', channel: 'regulation', direction: 'info' })
    expect(r.drivers[0].basis).toMatch(/ADOSH-SF Technical Guideline Safety in the Heat v4\.0.*Table 1/)
  })

  it('Medium zone: light work continuous, heavy work 45/15 (> 1.2 L/h); no lone work; level caution', () => {
    const light = floor({ twlWm2: 130, workClass: 'light' })
    expect(light.level).toBe('caution')
    expect(light.workMinPerHour).toBe(60)
    expect(light.waterLph).toMatchObject({ minLph: 1.0, maxLph: 1.2 })
    expect(light.actions).toEqual(['no_lone_work', 'drink_water'])
    expect(light.noLoneWork).toBe(true)
    const heavy = floor({ twlWm2: 130, workClass: 'heavy' })
    expect(heavy.level).toBe('caution')
    expect(heavy.workRest).toMatchObject({ workMinPerHour: 45, restMinPerHour: 15 })
    expect(heavy.workMinPerHour).toBe(45)
    expect(heavy.waterLph).toMatchObject({ minLph: 1.2, maxLph: null })
    expect(heavy.actions).toEqual(['shade_breaks', 'no_lone_work', 'drink_water'])
  })

  it('High zone: light 45/15, heavy 20/40, > 1.2 L/h, no lone work, permit to work; level high', () => {
    const light = floor({ twlWm2: 100, workClass: 'light' })
    expect(light.level).toBe('high')
    expect(light.workRest).toMatchObject({ workMinPerHour: 45, restMinPerHour: 15 })
    const heavy = floor({ twlWm2: 100, workClass: 'moderate' })
    expect(heavy.level).toBe('high')
    expect(heavy.workRest).toMatchObject({ workMinPerHour: 20, restMinPerHour: 40 })
    expect(heavy.workMinPerHour).toBe(20)
    expect(heavy.waterLph).toMatchObject({ minLph: 1.2, maxLph: null })
    expect(heavy.noLoneWork).toBe(true)
    expect(heavy.actions).toEqual(['shade_breaks', 'no_lone_work', 'drink_water'])
    expect(heavy.drivers.map((d) => d.id)).toEqual(['twl_zone_high', 'permit_to_work'])
  })

  it('TWL exactly 115 → High (level high); exactly 140 → Medium (level caution)', () => {
    expect(floor({ twlWm2: 115 }).level).toBe('high')
    expect(floor({ twlWm2: 115.01 }).level).toBe('caution')
    expect(floor({ twlWm2: 140 }).level).toBe('caution')
    expect(floor({ twlWm2: 140.01 }).level).toBe('safe')
  })

  it('unacclimatised worker in the Medium zone → stop (reassign), with the acclimatisation plan', () => {
    const r = floor({ twlWm2: 130, acclimatization: 'unacclimatized' })
    expect(r.level).toBe('stop')
    expect(r.unacclimatizedExcluded).toBe(true)
    expect(r.workMinPerHour).toBe(0)
    expect(r.actions.slice(0, 3)).toEqual(['stop_work', 'acclimatization_plan', 'rotate_task'])
    expect(r.actions).not.toContain('shade_breaks')
    expect(r.drivers[0].id).toBe('unacclimatized_excluded')
    expect(r.drivers[0].basis).toMatch(/No unacclimatised person to work/)
    expect(r.drivers[0].basis).toMatch(/§3\.2\(b\)\(i\)/)
  })

  it('an acclimatising worker counts as unacclimatised (High zone → stop)', () => {
    const r = floor({ twlWm2: 100, acclimatization: 'acclimatizing', workClass: 'heavy' })
    expect(r.level).toBe('stop')
    expect(r.unacclimatizedExcluded).toBe(true)
  })

  it('unacclimatised worker in the Low zone → safe, with the acclimatisation plan (CoP §3.2(b)(i))', () => {
    const r = floor({ twlWm2: 200, acclimatization: 'unacclimatized' })
    expect(r.level).toBe('safe')
    expect(r.unacclimatizedExcluded).toBe(false)
    expect(r.actions).toEqual(['acclimatization_plan', 'drink_water'])
    expect(r.drivers.map((d) => d.id)).toContain('acclimatization_programme')
  })

  it('midday break, outdoors in the sun → stop with midday_break first, even in the Low zone', () => {
    const r = floor({ t: ad('2026-07-01T13:00'), twlWm2: 250 })
    expect(r.level).toBe('stop')
    expect(r.middayBreakActive).toBe(true)
    expect(r.actions[0]).toBe('midday_break')
    expect(r.actions).toContain('rest_shade_now')
    expect(r.workMinPerHour).toBe(0)
    expect(r.drivers[0]).toMatchObject({ id: 'midday_break', direction: 'raises' })
    expect(r.drivers[0].basis).toMatch(/Ministerial Resolution No\. 44 of 2022/)
  })

  it('midday break boundaries drive the floor: 12:29 and 15:00 do not stop, 12:30 and 14:59 do', () => {
    expect(floor({ t: ad('2026-07-01T12:29') }).level).toBe('safe')
    expect(floor({ t: ad('2026-07-01T12:30') }).level).toBe('stop')
    expect(floor({ t: ad('2026-07-01T14:59') }).level).toBe('stop')
    expect(floor({ t: ad('2026-07-01T15:00') }).level).toBe('safe')
    expect(floor({ t: ad('2026-06-14T13:00') }).level).toBe('safe')
    expect(floor({ t: ad('2026-09-16T13:00') }).level).toBe('safe')
  })

  it('midday break does not stop shaded / indoor tasks (info driver only)', () => {
    const r = floor({ t: ad('2026-07-01T13:00'), twlWm2: 250, outdoorInSun: false })
    expect(r.level).toBe('safe')
    expect(r.middayBreakActive).toBe(true)
    expect(r.actions).not.toContain('midday_break')
    expect(r.drivers.find((d) => d.id === 'midday_break_window')?.direction).toBe('info')
  })

  it('a non-finite TWL applies the most protective zone and asks for a sensor check', () => {
    const r = floor({ twlWm2: NaN, workClass: 'heavy' })
    expect(r.zone?.id).toBe('high')
    expect(r.level).toBe('high')
    expect(r.actions).toContain('check_sensor')
    expect(r.drivers.map((d) => d.id)).toContain('twl_unavailable')
  })

  it('never returns less than the zone level, and every driver cites a basis on the regulation channel', () => {
    for (const twl of [0, 60, 114.99, 115, 120, 140, 141, 300]) {
      for (const acclimatization of ['acclimatized', 'acclimatizing', 'unacclimatized'] as const) {
        for (const workClass of ['rest', 'light', 'moderate', 'heavy', 'very_heavy'] as const) {
          const r = floor({ twlWm2: twl, acclimatization, workClass })
          const z = twlZone(twl)
          expect(RISK_ORDER[r.level]).toBeGreaterThanOrEqual(RISK_ORDER[z?.level ?? 'safe'])
          for (const d of r.drivers) {
            expect(d.channel).toBe('regulation')
            expect(d.basis.length).toBeGreaterThan(10)
          }
          expect(r.workMinPerHour).toBeGreaterThanOrEqual(0)
          expect(r.workMinPerHour).toBeLessThanOrEqual(60)
        }
      }
    }
  })

  it('defaults to the Abu Dhabi pack', () => {
    expect(DEFAULT_RULE_PACK).toBe(ABU_DHABI_RULE_PACK)
    expect(floor().packId).toBe('abu-dhabi')
  })
})

// ─────────────────────────────── Sharjah ───────────────────────────────

describe('Sharjah pack — SPSA OSHJ-CoP-33 v2 Rev 0 Table 3 (four zones)', () => {
  const sharjah = (over: Partial<RegulatoryFloorInput>) => floor({ pack: SHARJAH_RULE_PACK, ...over })

  it('has four zones: High < 115, Medium 115–140, Low 140–220, Unrestricted > 220', () => {
    expect(SHARJAH_RULE_PACK.twlZones.map((z) => [z.id, z.minWm2, z.maxWm2])).toEqual([
      ['high', null, 115],
      ['medium', 115, 140],
      ['low', 140, 220],
      ['unrestricted', 220, null],
    ])
    expect(twlZone(220, SHARJAH_RULE_PACK)?.id).toBe('low')
    expect(twlZone(220.01, SHARJAH_RULE_PACK)?.id).toBe('unrestricted')
  })

  it('water 1.5 / 1.2 / 1 / 0.5 L/h by zone', () => {
    expect(sharjah({ twlWm2: 100 }).waterLph?.minLph).toBe(1.5)
    expect(sharjah({ twlWm2: 130 }).waterLph?.minLph).toBe(1.2)
    expect(sharjah({ twlWm2: 200 }).waterLph?.minLph).toBe(1.0)
    expect(sharjah({ twlWm2: 250 }).waterLph?.minLph).toBe(0.5)
  })

  it('Medium zone heavy work is 40/20 with no lone work (ADOSH: 45/15)', () => {
    const r = sharjah({ twlWm2: 130, workClass: 'heavy' })
    expect(r.level).toBe('caution')
    expect(r.workRest).toMatchObject({ workMinPerHour: 40, restMinPerHour: 20 })
    expect(r.noLoneWork).toBe(true)
  })

  it('High zone: no ordinary work → stop (essential maintenance / rescue only)', () => {
    const r = sharjah({ twlWm2: 100 })
    expect(r.level).toBe('stop')
    expect(r.workMinPerHour).toBe(0)
    expect(r.actions.slice(0, 2)).toEqual(['stop_work', 'rest_shade_now'])
    expect(r.drivers.map((d) => d.id)).toContain('ordinary_work_prohibited')
    expect(r.drivers[0].basis).toMatch(/OSHJ-CoP-33/)
  })

  it('Low zone: unacclimatised workers may work but not alone; Unrestricted zone has no lone-work limit', () => {
    const low = sharjah({ twlWm2: 180, acclimatization: 'unacclimatized' })
    expect(low.level).toBe('safe')
    expect(low.noLoneWork).toBe(true)
    expect(low.actions).toContain('no_lone_work')
    expect(sharjah({ twlWm2: 180 }).noLoneWork).toBe(false)
    expect(sharjah({ twlWm2: 250, acclimatization: 'unacclimatized' }).noLoneWork).toBe(false)
  })

  it('unacclimatised in the Medium zone → stop; the federal midday break applies', () => {
    expect(sharjah({ twlWm2: 130, acclimatization: 'unacclimatized' }).level).toBe('stop')
    const noon = sharjah({ t: ad('2026-08-01T13:00'), twlWm2: 250 })
    expect(noon.level).toBe('stop')
    expect(noon.actions[0]).toBe('midday_break')
  })
})

// ─────────────────────────────── Qatar ───────────────────────────────

describe('Qatar pack — Ministerial Decision 17/2021 (1 Jun–15 Sep 10:00–15:30 local; stop if WBGT > 32.1 °C)', () => {
  const qatar = (over: Partial<RegulatoryFloorInput>) => floor({ pack: QATAR_RULE_PACK, wbgtC: 28, ...over })

  it.each([
    ['2026-06-01T09:59', false],
    ['2026-06-01T10:00', true],
    ['2026-06-01T15:29', true],
    ['2026-06-01T15:30', false],
    ['2026-05-31T12:00', false],
    ['2026-09-15T12:00', true],
    ['2026-09-16T12:00', false],
  ])('%s Doha time → %s', (local, expected) => {
    expect(isMiddayBreak(doha(local), QATAR_RULE_PACK)).toBe(expected)
  })

  it('evaluates the ban in Qatar time (UTC+3), not UAE time', () => {
    // 10:30 in Abu Dhabi is 09:30 in Doha: before the ban
    expect(isMiddayBreak(ad('2026-07-01T10:30'), QATAR_RULE_PACK)).toBe(false)
    // 16:00 in Abu Dhabi is 15:00 in Doha: inside the ban
    expect(isMiddayBreak(ad('2026-07-01T16:00'), QATAR_RULE_PACK)).toBe(true)
  })

  it('has no TWL zones: the TWL value does not change the floor', () => {
    const r = qatar({ t: doha('2026-07-01T08:00'), twlWm2: 50 })
    expect(r.zone).toBeNull()
    expect(r.workRest).toBeNull()
    expect(r.level).toBe('safe')
  })

  it('WBGT 32.1 °C does not stop work; 32.2 °C stops it at any time, indoors or outdoors', () => {
    expect(qatar({ t: doha('2026-12-01T08:00'), wbgtC: 32.1 }).level).toBe('safe')
    const r = qatar({ t: doha('2026-12-01T08:00'), wbgtC: 32.2, outdoorInSun: false })
    expect(r.level).toBe('stop')
    expect(r.workMinPerHour).toBe(0)
    expect(r.actions.slice(0, 2)).toEqual(['stop_work', 'rest_shade_now'])
    expect(r.drivers[0]).toMatchObject({ id: 'wbgt_stop_limit', value: 32.2, unit: '°C' })
    expect(r.drivers[0].basis).toMatch(/Art\. 4\(9\)/)
  })

  it('missing WBGT cannot be read as compliance → caution + check_sensor (fail-safe)', () => {
    const r = regulatoryFloor({
      t: doha('2026-12-01T08:00'),
      twlWm2: 200,
      outdoorInSun: true,
      acclimatization: 'acclimatized',
      workClass: 'light',
      pack: QATAR_RULE_PACK,
    })
    expect(r.level).toBe('caution')
    expect(r.actions).toEqual(['check_sensor'])
  })

  it('outdoor ban in season → stop with midday_break', () => {
    const r = qatar({ t: doha('2026-06-01T11:00') })
    expect(r.level).toBe('stop')
    expect(r.actions[0]).toBe('midday_break')
    expect(r.drivers[0].basis).toMatch(/Ministerial Decision No\. 17 of 2021, Art\. 2/)
  })
})

// ─────────────────────────────── Rule-pack data integrity ───────────────────────────────

describe('rule-pack data integrity', () => {
  const packs: RulePack[] = Object.values(RULE_PACKS)

  it('every pack is addressable by id and deeply frozen', () => {
    for (const p of packs) {
      expect(getRulePack(p.id)).toBe(p)
      expect(Object.isFrozen(p)).toBe(true)
      expect(Object.isFrozen(p.twlZones)).toBe(true)
      for (const z of p.twlZones) expect(Object.isFrozen(z.workRest.heavy)).toBe(true)
    }
  })

  it('zones are ascending, contiguous, and never less protective as TWL falls', () => {
    for (const p of packs) {
      const zs = p.twlZones
      if (zs.length === 0) continue
      expect(zs[0].minWm2).toBeNull()
      expect(zs[zs.length - 1].maxWm2).toBeNull()
      for (let i = 1; i < zs.length; i++) {
        const lower = zs[i - 1]
        const upper = zs[i]
        expect(upper.minWm2).toBe(lower.maxWm2)
        expect(RISK_ORDER[lower.level]).toBeGreaterThanOrEqual(RISK_ORDER[upper.level])
        expect(lower.waterLph.heavy.minLph).toBeGreaterThanOrEqual(upper.waterLph.heavy.minLph)
        expect(lower.workRest.heavy.workMinPerHour).toBeLessThanOrEqual(upper.workRest.heavy.workMinPerHour)
        if (upper.loneWorkAllowed === false) expect(lower.loneWorkAllowed).toBe(false)
        if (upper.unacclimatizedAllowed === false) expect(lower.unacclimatizedAllowed).toBe(false)
      }
      for (const z of zs) {
        for (const c of ['light', 'heavy'] as const) {
          expect(z.workRest[c].workMinPerHour + z.workRest[c].restMinPerHour).toBe(60)
          expect(z.workRest[c].workMinPerHour).toBeLessThanOrEqual(
            c === 'heavy' ? z.workRest.light.workMinPerHour : 60,
          )
        }
        expect(z.basis).toMatch(/Table/)
      }
    }
  })

  it('calendar rules are well-formed: MM-DD dates and HH:mm windows with start < end', () => {
    for (const p of packs) {
      const r = p.middayBreak
      if (r === null) continue
      expect(r.from).toMatch(/^\d{2}-\d{2}$/)
      expect(r.to).toMatch(/^\d{2}-\d{2}$/)
      expect(r.startHhmm < r.endHhmm).toBe(true)
      expect(r.basis.length).toBeGreaterThan(10)
    }
    expect(ABU_DHABI_RULE_PACK.middayBreak).toMatchObject({
      from: '06-15',
      to: '09-15',
      startHhmm: '12:30',
      endHhmm: '15:00',
    })
    expect(QATAR_RULE_PACK.utcOffsetMinutes).toBe(180)
    expect(ABU_DHABI_RULE_PACK.utcOffsetMinutes).toBe(240)
  })

  it('records instrument versions and the midday-break penalty', () => {
    expect(ABU_DHABI_RULE_PACK).toMatchObject({ version: '4.0', date: '2024-07-15' })
    expect(SHARJAH_RULE_PACK).toMatchObject({ version: '2 Rev 0', date: '2024-07-03' })
    expect(ABU_DHABI_RULE_PACK.penalties[0]).toMatchObject({ currency: 'AED', perWorker: 5000, max: 50000 })
    expect(QATAR_RULE_PACK.wbgtStopC).toBe(32.1)
  })
})

// ─────────────────────────────── Other ADOSH duties ───────────────────────────────

describe('heat-stress programme trigger (ADOSH CoP 11.0 §3.1.1(e): ≥ 35 °C)', () => {
  it('requires a programme at or above 35 °C', () => {
    expect(heatStressProgramRequired(34.9)).toBe(false)
    expect(heatStressProgramRequired(35)).toBe(true)
    expect(heatStressProgramRequired(NaN)).toBe(true)
    expect(heatStressProgramRequired(40, QATAR_RULE_PACK)).toBeNull()
  })
})

describe('acclimatisation schedules (ADOSH TG v4.0 §3)', () => {
  it('ramps new employees 20/40/60/80/100 % and experienced employees 50/60/80/100/100 %', () => {
    expect([1, 2, 3, 4, 5].map((d) => adoshAcclimatizationWorkloadPct(d, false))).toEqual(
      ADOSH_ACCLIMATIZATION_SCHEDULE_PCT.new,
    )
    expect([1, 2, 3, 4, 5].map((d) => adoshAcclimatizationWorkloadPct(d, true))).toEqual(
      ADOSH_ACCLIMATIZATION_SCHEDULE_PCT.experienced,
    )
    expect(adoshAcclimatizationWorkloadPct(9, false)).toBe(100)
    expect(adoshAcclimatizationWorkloadPct(0, false)).toBe(20)
    expect(adoshAcclimatizationWorkloadPct(NaN, true)).toBe(50)
  })

  it('re-acclimatises after absence or illness per the TG table (the 12-day overlap takes the longer sequence)', () => {
    expect(adoshReacclimatizationSequence(3, 'absence')).toEqual([100])
    expect(adoshReacclimatizationSequence(5, 'absence')).toEqual(['reduced_expectations', 100])
    expect(adoshReacclimatizationSequence(11, 'absence')).toEqual([80, 100])
    expect(adoshReacclimatizationSequence(12, 'absence')).toEqual([60, 80, 100])
    expect(adoshReacclimatizationSequence(21, 'absence')).toEqual([50, 60, 80, 100])
    expect(adoshReacclimatizationSequence(2, 'illness')).toEqual(['reduced_expectations', 100])
    expect(adoshReacclimatizationSequence(7, 'illness')).toEqual([60, 80, 100])
    expect(adoshReacclimatizationSequence(9, 'illness')).toEqual([50, 60, 80, 100])
  })
})

describe('heat incident notification (ADOSH-SF Mechanism 11.0 v4.0, Form G)', () => {
  const none = {
    fatality: false,
    inpatientHospitalTreatment: false,
    lossOfConsciousnessOrResuscitation: false,
    unableToWorkNextShift: false,
  }

  it('fatality within 24 h; other serious incidents within 3 working days; minor cases not notifiable', () => {
    expect(heatIncidentNotification({ ...none, fatality: true })).toMatchObject({
      notifiable: true,
      form: 'Form G',
      withinHours: 24,
      withinWorkingDays: null,
    })
    expect(heatIncidentNotification({ ...none, lossOfConsciousnessOrResuscitation: true })).toMatchObject({
      notifiable: true,
      withinHours: null,
      withinWorkingDays: 3,
    })
    expect(heatIncidentNotification(none)?.notifiable).toBe(false)
    expect(heatIncidentNotification(none, QATAR_RULE_PACK)).toBeNull()
  })
})
