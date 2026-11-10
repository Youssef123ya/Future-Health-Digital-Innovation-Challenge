import { describe, it, expect } from 'vitest'
import type { LangCode, WorkerProfile } from '../engine/types'
import { SITES, SITE_IDS } from './sites'
import {
  COHORT_PARAMS,
  DEMO_CREW_ID,
  OH_REVIEW_AGE_YEARS,
  OH_REVIEW_BMI,
  SITE_DEFAULT_CLOTHING,
  TASK_LIBRARY,
  WORK_CLASSES,
  buildDemoCrew,
  expectedLanguageMix,
  generateWorkforce,
} from './workforce'

const bmiOf = (w: WorkerProfile) => w.massKg! / (w.heightCm! / 100) ** 2

describe('generateWorkforce — determinism and structure', () => {
  it('is deterministic for a seed and changes with the seed', () => {
    const a = generateWorkforce()
    const b = generateWorkforce()
    expect(a).toEqual(b)
    const c = generateWorkforce({ seed: 'another-seed' })
    expect(c.workers.map((w) => w.displayName)).not.toEqual(a.workers.map((w) => w.displayName))
  })

  it('adding crews never changes existing ones (per-site/crew/worker RNG forks)', () => {
    const three = generateWorkforce({ includeDemoCrew: false })
    const four = generateWorkforce({ includeDemoCrew: false, crewsPerSite: 4 })
    for (const crew of three.crews) {
      const same = four.crews.find((c) => c.id === crew.id)!
      expect(same.tasks).toEqual(crew.tasks)
      const workers = (wf: typeof three, ids: string[]) => ids.map((id) => wf.workers.find((w) => w.id === id))
      expect(workers(four, same.workerIds)).toEqual(workers(three, crew.workerIds))
    }
  })

  it('staffs every site with 3 crews of 6–10 workers plus the demo crew, with consistent ids', () => {
    const wf = generateWorkforce()
    expect(wf.crews).toHaveLength(1 + 3 * SITES.length)
    const ids = new Set(wf.workers.map((w) => w.id))
    expect(ids.size).toBe(wf.workers.length)
    for (const crew of wf.crews) {
      if (crew.id !== DEMO_CREW_ID) {
        expect(crew.workerIds.length).toBeGreaterThanOrEqual(6)
        expect(crew.workerIds.length).toBeLessThanOrEqual(10)
      }
      expect(crew.tasks.length).toBeGreaterThanOrEqual(2)
      expect(new Set(crew.tasks.map((t) => t.id)).size).toBe(crew.tasks.length)
      for (const t of crew.tasks) {
        expect(WORK_CLASSES).toContain(t.workClass)
        expect(t.durationMin).toBeGreaterThan(0)
        if (t.earliestStart && t.latestEnd) expect(t.latestEnd > t.earliestStart).toBe(true)
      }
      for (const id of crew.workerIds) {
        const w = wf.workers.find((x) => x.id === id)!
        expect(w.crewId).toBe(crew.id)
        expect(w.siteId).toBe(crew.siteId)
        expect(w.id).toMatch(/^W-[0-9A-F]{4}$/)
      }
    }
    expect(wf.workers.reduce((n, w) => n + (wf.crews.some((c) => c.workerIds.includes(w.id)) ? 1 : 0), 0)).toBe(wf.workers.length)
    for (const site of SITE_IDS) {
      const names = wf.workers.filter((w) => w.siteId === site).map((w) => w.displayName)
      expect(new Set(names).size).toBe(names.length) // badges unique within a site
    }
  })
})

describe('generateWorkforce — cohort sanity (large sample)', () => {
  const wf = generateWorkforce({ seed: 'distribution-check', crewsPerSite: 40, includeDemoCrew: false })
  const workers = wf.workers
  const n = workers.length

  it('generates a large cohort', () => {
    expect(n).toBeGreaterThan(1400)
  })

  it('languages follow the UN DESA 2024 origin mix (hi/ml, bn, ur, ar, tl, ne, en)', () => {
    const expected = expectedLanguageMix()
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(expected.hi + expected.ml).toBeCloseTo(39.8 / 96.5, 10) // India's share after renormalisation
    const counts = Object.fromEntries(Object.keys(expected).map((k) => [k, 0])) as Record<LangCode, number>
    for (const w of workers) counts[w.language]++
    for (const lang of Object.keys(expected) as LangCode[]) {
      const sd = Math.sqrt((expected[lang] * (1 - expected[lang])) / n)
      expect(Math.abs(counts[lang] / n - expected[lang])).toBeLessThan(4 * sd + 0.005)
    }
  })

  it('ages, body size and resting heart rate are within plausible adult-worker ranges', () => {
    const ages = workers.map((w) => w.ageYears!)
    expect(Math.min(...ages)).toBeGreaterThanOrEqual(20)
    expect(Math.max(...ages)).toBeLessThanOrEqual(58)
    const meanAge = ages.reduce((a, b) => a + b, 0) / n
    expect(meanAge).toBeGreaterThan(31)
    expect(meanAge).toBeLessThan(37)
    for (const w of workers) {
      expect(w.heightCm!).toBeGreaterThanOrEqual(142)
      expect(w.heightCm!).toBeLessThanOrEqual(192)
      expect(bmiOf(w)).toBeGreaterThan(17)
      expect(bmiOf(w)).toBeLessThan(38.5)
      expect(w.restingHrBpm!).toBeGreaterThanOrEqual(48)
      expect(w.restingHrBpm!).toBeLessThanOrEqual(95)
    }
    const women = workers.filter((w) => w.sex === 'female').length / n
    expect(women).toBeGreaterThan(0.01)
    expect(women).toBeLessThan(0.08)
  })

  it('includes first-week arrivals, returners after leave and established workers', () => {
    // Semantics of limits.assessAcclimatization: a stretch shorter than 21 days follows an absence of ≥ 21 days.
    const firstWeek = workers.filter((w) => w.daysOnSite <= 7 && w.daysAwayRecent >= 21)
    const returners = firstWeek.filter((w) => w.experiencedInHeat)
    const established = workers.filter((w) => w.daysOnSite >= 21)
    expect(firstWeek.length / n).toBeGreaterThan(0.08) // first-week arrivals + recent returners
    expect(returners.length).toBeGreaterThan(0)
    expect(established.length / n).toBeGreaterThan(0.65)
    for (const w of workers) {
      expect(w.daysAwayRecent).toBeGreaterThanOrEqual(0)
      if (w.daysOnSite < 21) expect(w.daysAwayRecent).toBeGreaterThanOrEqual(21)
      if (w.daysOnSite >= 21) expect(w.daysAwayRecent).toBeLessThan(4) // a ≥ 4-day absence would restart the stretch
      if (w.daysOnSite >= 365) expect(w.experiencedInHeat).toBe(true)
    }
  })

  it('respects consent: risk flags only with health-flag consent, wearable consent only with a band, some decline everything', () => {
    let declineAll = 0
    for (const w of workers) {
      if (!w.consent.healthFlags) expect(w.riskFlags).toEqual([])
      if (w.consent.wearable) expect(w.hasWearable).toBe(true)
      const c = w.consent
      if (!c.wearable && !c.healthFlags && !c.checkins && !c.shareWithMedicOnEscalation && !c.aggregateStatistics) declineAll++
      if (w.consent.healthFlags) {
        const shouldReview = w.ageYears! >= OH_REVIEW_AGE_YEARS || bmiOf(w) >= OH_REVIEW_BMI
        expect(w.riskFlags.includes('oh_review_required')).toBe(shouldReview)
      }
      expect(new Set(w.riskFlags).size).toBe(w.riskFlags.length)
    }
    expect(declineAll / n).toBeGreaterThan(0.04)
    expect(declineAll / n).toBeLessThan(0.15)
    const wearable = workers.filter((w) => w.hasWearable).length / n
    expect(Math.abs(wearable - COHORT_PARAMS.wearableShare)).toBeLessThan(0.05)
    const consented = workers.filter((w) => w.consent.healthFlags).length / n
    expect(consented).toBeGreaterThan(0.4)
    expect(consented).toBeLessThan(0.6)
    expect(workers.some((w) => w.riskFlags.includes('hr_suppressing_medication'))).toBe(true)
  })

  it('dresses workers by site policy (FR coveralls site-wide at Ruwais)', () => {
    for (const w of workers) expect(w.clothing).toBe(SITE_DEFAULT_CLOTHING[w.siteId as keyof typeof SITE_DEFAULT_CLOTHING])
  })
})

describe('task library', () => {
  const keys = (kind: keyof typeof TASK_LIBRARY) => TASK_LIBRARY[kind].map((t) => t.key)

  it('has tasks typical of each site kind', () => {
    expect(keys('construction')).toEqual(expect.arrayContaining(['rebar_fixing', 'formwork', 'concrete_pour', 'scaffolding', 'finishing']))
    expect(keys('port')).toEqual(expect.arrayContaining(['lashing', 'breakbulk_loading', 'mobile_equipment', 'yard_inspection']))
    expect(keys('industrial')).toEqual(expect.arrayContaining(['maintenance', 'welding', 'insulation']))
    expect(keys('inland')).toEqual(expect.arrayContaining(['asphalt_paving', 'landscaping']))
  })

  it('classifies work per the OSHA/ISO 8996 mapping (mobile equipment = moderate, welding = heavy with FR coveralls + hood)', () => {
    const find = (kind: keyof typeof TASK_LIBRARY, key: string) => TASK_LIBRARY[kind].find((t) => t.key === key)!
    expect(find('port', 'mobile_equipment').workClass).toBe('moderate')
    expect(find('port', 'yard_inspection').workClass).toBe('light')
    expect(find('construction', 'rebar_fixing').workClass).toBe('heavy')
    expect(find('construction', 'scaffolding').workClass).toBe('very_heavy')
    expect(find('construction', 'finishing')).toMatchObject({ workClass: 'moderate', inSun: false })
    expect(find('industrial', 'welding')).toMatchObject({ workClass: 'heavy', clothing: 'fr_coveralls', hood: true })
    expect(find('inland', 'landscaping').workClass).toBe('heavy')
    expect(find('port', 'lashing').flexible).toBe(false)
    expect(find('construction', 'concrete_pour')).toMatchObject({ flexible: true, earliestStart: '04:30' })
  })

  it('gives each site the tasks of its kind', () => {
    const wf = generateWorkforce({ includeDemoCrew: false })
    for (const crew of wf.crews) {
      const kind = SITES.find((s) => s.id === crew.siteId)!.kind
      for (const t of crew.tasks) expect(keys(kind)).toContain(t.id.split(':')[1])
    }
  })
})

describe('demo crew personas', () => {
  const demo = buildDemoCrew()
  const byPersona = (id: string) => {
    const p = demo.personas.find((x) => x.id === id)!
    return { persona: p, worker: demo.workers.find((w) => w.id === p.workerId)! }
  }

  it('is a fixed Musaffah crew included in every generated workforce', () => {
    expect(demo.crew).toMatchObject({ id: DEMO_CREW_ID, siteId: 'musaffah' })
    expect(demo.crew.workerIds).toHaveLength(demo.workers.length)
    expect(demo.personas).toHaveLength(5)
    for (const p of demo.personas) expect(demo.crew.tasks.map((t) => t.id)).toContain(p.taskId)
    const wf = generateWorkforce({ seed: 123 })
    expect(wf.crews[0]).toEqual(demo.crew)
    expect(wf.personas).toEqual(demo.personas)
  })

  it('day-2 new arrival: unacclimatised, no previous hot season', () => {
    const { worker } = byPersona('new_arrival')
    expect(worker).toMatchObject({ daysOnSite: 2, experiencedInHeat: false })
  })

  it('veteran welder: acclimatised, FR coveralls, on the hooded welding task', () => {
    const { worker, persona } = byPersona('veteran_welder')
    expect(worker).toMatchObject({ experiencedInHeat: true, clothing: 'fr_coveralls' })
    expect(worker.daysOnSite).toBeGreaterThan(60)
    expect(demo.crew.tasks.find((t) => t.id === persona.taskId)).toMatchObject({ clothing: 'fr_coveralls', hood: true })
  })

  it('beta-blocker worker: wearable with consent, flag declared (disables heart-rate rules)', () => {
    const { worker } = byPersona('beta_blocker')
    expect(worker.hasWearable).toBe(true)
    expect(worker.consent).toMatchObject({ wearable: true, healthFlags: true })
    expect(worker.riskFlags).toContain('hr_suppressing_medication')
  })

  it('fasting worker: fasting flag with health-flag consent', () => {
    const { worker } = byPersona('fasting')
    expect(worker.consent.healthFlags).toBe(true)
    expect(worker.riskFlags).toEqual(['fasting'])
  })

  it('worker declining all optional consent: nothing consented, no flags', () => {
    const { worker } = byPersona('declines_consent')
    const { updatedAt: _t, ...scopes } = worker.consent
    expect(Object.values(scopes).every((v) => v === false)).toBe(true)
    expect(worker.riskFlags).toEqual([])
  })
})
