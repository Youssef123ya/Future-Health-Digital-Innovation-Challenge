/**
 * Jurisdiction rule packs — the regulatory floor Zill never goes below (docs/ARCHITECTURE.md §1.6, §5 "regulation").
 *
 * Regulation is held as DATA so another emirate or country is a configuration change, not a code change:
 * - 'abu-dhabi' (default): ADOSH-SF CoP 11.0 *Safety in the Heat* v4.0 + Technical Guideline v4.0 (ADPHC, 15 July 2024)
 *   Table 1 TWL zones, and the UAE federal midday break (MoHRE Ministerial Resolution No. 44 of 2022).
 * - 'sharjah': SPSA OSHJ-CoP-33 *Safety in Heat* v2 Rev 0 (3 July 2024) Table 3 (four TWL zones) + the MoHRE midday break.
 * - 'qatar': Ministerial Decision No. 17 of 2021 (summer outdoor-work ban; stop work when WBGT > 32.1 °C).
 *
 * Sources: docs/research/twl_and_regulation.md §2–§4 and §6; docs/research/context_and_commercial.md §3.2–§3.3. The most
 * protective applicable rule wins (context_and_commercial.md §3.3 engine rule; ADOSH CoP 11.0 §1(b) "follow the more
 * stringent requirement"). Pure TypeScript: time is passed in as epoch ms and converted with ./time.ts.
 */

import type { AcclimatizationStatus, ActionId, RiskDriver, RiskLevel, WorkClass } from './types'
import { RISK_ORDER, maxLevel } from './types'
import type { LocalParts } from './time'
import { DUBAI_OFFSET_MS, MINUTE_MS, epochFromLocal, hhmmToMinutes, localParts } from './time'

// ─────────────────────────────── Types ───────────────────────────────

/** Identifiers of the bundled rule packs. */
export type RulePackId = 'abu-dhabi' | 'sharjah' | 'qatar'

/** TWL zone identifiers (ADOSH uses high/medium/low; Sharjah adds 'unrestricted' above 220 W/m²). */
export type TwlZoneId = 'high' | 'medium' | 'low' | 'unrestricted'

/** Work categories of the TWL zone tables (ADOSH TG v4.0 Table 1 notes c and d). */
export type TwlWorkCategory = 'light' | 'heavy'

/** A work/rest schedule from a zone table. Continuous work = 60 work / 0 rest. */
export interface WorkRestSchedule {
  /** Work minutes per hour. */
  readonly workMinPerHour: number
  /** Rest minutes per hour (shade / cooled shelter). */
  readonly restMinPerHour: number
  /** Schedule wording from the instrument. */
  readonly text: string
}

/** Drinking-water guidance per hour. `maxLph: null` = open-ended (e.g. "> 1.2 Litres / hr"). */
export interface WaterGuidance {
  readonly minLph: number
  readonly maxLph: number | null
  readonly text: string
}

/**
 * One TWL zone. Bounds follow ONE convention for every pack: the zone holds minWm2 < TWL ≤ maxWm2 (null = unbounded), so a
 * TWL exactly on a printed boundary falls in the lower-TWL, MORE protective zone [ENG] (ARCHITECTURE.md §5). Zones are
 * listed in ascending TWL order and are contiguous.
 */
export interface TwlZone {
  readonly id: TwlZoneId
  /** Exclusive lower bound, W/m² (null = unbounded below). */
  readonly minWm2: number | null
  /** Inclusive upper bound, W/m² (null = unbounded above). */
  readonly maxWm2: number | null
  readonly label: string
  /** Zill level this zone maps to (regulation channel). */
  readonly level: RiskLevel
  /** Interventions as printed in the instrument. */
  readonly controls: readonly string[]
  readonly workRest: Readonly<Record<TwlWorkCategory, WorkRestSchedule>>
  readonly waterLph: Readonly<Record<TwlWorkCategory, WaterGuidance>>
  /** False = "No unacclimatised person to work" in this zone. */
  readonly unacclimatizedAllowed: boolean
  /** False = no lone work for anyone in this zone. */
  readonly loneWorkAllowed: boolean
  /** False = unacclimatised workers may work here but not alone. */
  readonly unacclimatizedLoneWorkAllowed: boolean
  /** False = ordinary work prohibited (Sharjah High: essential maintenance or rescue only). */
  readonly ordinaryWorkAllowed: boolean
  /** True = a permit to work in heat is required (ADOSH CoP 11.0 §3.2(b)(x)). */
  readonly permitToWork: boolean
  readonly basis: string
}

/**
 * A calendar outdoor-work ban. Season dates are 'MM-DD' INCLUSIVE at both ends; the daily window is
 * startHhmm ≤ local time < endHhmm (start inclusive, end exclusive), in the pack's local time zone.
 */
export interface MiddayBreakRule {
  readonly from: string
  readonly to: string
  readonly startHhmm: string
  readonly endHhmm: string
  readonly appliesTo: string
  readonly exemptions: readonly string[]
  readonly employerDuties: readonly string[]
  readonly basis: string
}

/** Who counts as unacclimatised and how long the acclimatisation allowance is. */
export interface AcclimatizationRule {
  readonly definition: string
  /** Days off work beyond which a worker counts as unacclimatised again (strictly more than). */
  readonly daysOffThreshold: number | null
  /** Acclimatisation allowance before hard work, days [min, max]. */
  readonly allowanceDays: readonly [number, number] | null
  readonly basis: string
}

/** Always-on hydration messages and limits. */
export interface HydrationGuidance {
  readonly messages: readonly string[]
  readonly dailyLRange: readonly [number, number] | null
  readonly personalContainerMinL: number | null
  /** Practical ceiling of fluid absorption, L/h (beyond it, improve conditions instead). */
  readonly practicalCeilingLph: number | null
  readonly basis: string
}

/** Statutory incident-notification duty. */
export interface IncidentNotificationRule {
  readonly form: string
  readonly recipient: string
  readonly fatalityWithinHours: number
  readonly seriousWithinWorkingDays: number
  readonly seriousCriteria: readonly string[]
  readonly basis: string
}

/** A penalty attached to a rule. Amounts are null when the instrument text gives none. */
export interface PenaltyRule {
  readonly appliesTo: string
  readonly text: string
  readonly currency: string | null
  readonly perWorker: number | null
  readonly max: number | null
  readonly basis: string
}

/** A jurisdiction rule pack: versioned, citable regulation as data. */
export interface RulePack {
  readonly id: RulePackId
  readonly name: string
  readonly jurisdiction: string
  readonly authority: string
  readonly instrument: string
  readonly version: string
  /** ISO 8601 date (or year-month) of the instrument version. */
  readonly date: string
  readonly basis: string
  /** IANA zone of the jurisdiction; local time is computed with the fixed offset below (no DST in the Gulf). */
  readonly timeZone: string
  readonly utcOffsetMinutes: number
  readonly middayBreak: MiddayBreakRule | null
  /** Ascending, contiguous TWL zones; empty when the jurisdiction does not use TWL. */
  readonly twlZones: readonly TwlZone[]
  /** Stop all work when WBGT is strictly above this value, °C (Qatar MD 17/2021 Art. 4(9)). */
  readonly wbgtStopC?: number
  readonly wbgtStopBasis?: string
  /** Air temperature (°C, at or above) that obliges a heat-stress programme; null when none is transcribed. */
  readonly heatProgramTriggerC: number | null
  readonly heatProgramBasis: string | null
  readonly acclimatization: AcclimatizationRule | null
  readonly hydration: HydrationGuidance | null
  readonly incidentNotification: IncidentNotificationRule | null
  readonly penalties: readonly PenaltyRule[]
  readonly workerRights: readonly string[]
  readonly notes: readonly string[]
}

// ─────────────────────────────── Shared rule data ───────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

const continuous = (text: string): WorkRestSchedule => ({ workMinPerHour: 60, restMinPerHour: 0, text })
const cycle = (work: number, rest: number, text: string): WorkRestSchedule => ({
  workMinPerHour: work,
  restMinPerHour: rest,
  text,
})
const water = (minLph: number, maxLph: number | null, text: string): WaterGuidance => ({ minLph, maxLph, text })

/**
 * UAE federal midday break: no work under direct sunlight and in open areas, 15 June – 15 September inclusive,
 * 12:30–15:00 daily. Basis: MoHRE Ministerial Resolution No. 44 of 2022 (u.ae working-hours page); 2026 = 22nd year,
 * "effective from 15th June until 15th September 2026" (WAM, 8 Jun 2026). Exemptions and employer duties paraphrased from
 * the WAM 2026 release (twl_and_regulation.md §3). ADOSH CoP 11.0 v4.0 §3.1.1(g) makes it binding on Abu Dhabi employers.
 */
const MOHRE_MIDDAY_BREAK: MiddayBreakRule = {
  from: '06-15',
  to: '09-15',
  startHhmm: '12:30',
  endHhmm: '15:00',
  appliesTo: 'Work under direct sunlight and in open areas',
  exemptions: [
    'Work that must continue for technical reasons, e.g. asphalt laying or concrete pouring that cannot be interrupted or postponed',
    'Work needed to prevent hazards or repair faults affecting the wider community (water supply, electricity, traffic movement, other essential services)',
    'Activities requiring permits from competent government authorities because of their impact on public life and traffic flow',
  ],
  employerDuties: [
    'Shaded rest areas',
    'Cooling equipment such as fans',
    'Adequate cold drinking water',
    'Hydration supplements including salts and other locally approved products',
    'Adequate comfort facilities and first-aid equipment',
    'Parasols / sun shades',
  ],
  // UNVERIFIED: the article number inside MR 44/2022 (sources cite the resolution as a whole).
  basis: 'UAE MoHRE Ministerial Resolution No. 44 of 2022 (midday break 15 Jun–15 Sep, 12:30–15:00)',
}

/** MoHRE midday-break penalty (twl_and_regulation.md §3; consistent across 2023–2025 secondary sources). */
const MOHRE_MIDDAY_PENALTY: PenaltyRule = {
  appliesTo: 'Midday break violation',
  text: 'AED 5,000 per worker, up to AED 50,000 when multiple workers are involved',
  currency: 'AED',
  perWorker: 5000,
  max: 50000,
  basis:
    'MoHRE midday break; Khaleej Times 3 Jun 2025 and Middle East Briefing 19 Jun 2024 (secondary sources; the statutory penalty schedule was not retrieved)',
}

// ─────────────────────────────── Abu Dhabi (ADOSH-SF v4.0) ───────────────────────────────

const ADOSH_TABLE_1 = 'ADOSH-SF Technical Guideline Safety in the Heat v4.0 (ADPHC, 15 Jul 2024) Table 1'

/**
 * ADOSH-SF TG v4.0 Table 1 "Thermal Work Limit – Working Zones. Control Interventions, Rest-Work and Rehydration
 * Schedules", transcribed from twl_and_regulation.md §2.3 (read from the PDF page image; identical to the ADPHC bilingual
 * sheet). Printed bands: High "< 115", Medium "115 – 140", Low "140 - 220 <" (≥ 140).
 */
const ADOSH_TWL_ZONES: readonly TwlZone[] = [
  {
    id: 'high',
    minWm2: null,
    maxWm2: 115,
    label: 'High Risk Zone',
    level: 'high',
    controls: [
      'Strict Work/Rest cycling required',
      'No person to work alone',
      'No unacclimatised person to work',
      'High Risk induction required emphasising hydration and identifying signs of heat strain',
      'Provide personal water bottle (2 litre capacity) on-site at all times',
      'Permit to work in heat (CoP 11.0 §3.2(b)(x); TG App. 3)',
    ],
    workRest: {
      light: cycle(45, 15, 'Light work 45 work – 15 rest'),
      heavy: cycle(20, 40, 'Heavy work 20 work - 40 rest'),
    },
    waterLph: {
      light: water(1.2, null, 'All Work >1.2 Litres / hr'),
      heavy: water(1.2, null, 'All Work >1.2 Litres / hr'),
    },
    unacclimatizedAllowed: false,
    loneWorkAllowed: false,
    unacclimatizedLoneWorkAllowed: false,
    ordinaryWorkAllowed: true,
    permitToWork: true,
    basis: ADOSH_TABLE_1,
  },
  {
    id: 'medium',
    minWm2: 115,
    maxWm2: 140,
    label: 'Medium Risk — Cautionary Zone',
    level: 'caution',
    controls: [
      'Cautionary zone indicates situations in which environmental conditions require additional precautions.',
      'Practicable Engineering control measures to reduce heat stress should be implemented e.g. provide shade, improve ventilation etc.',
      'Working alone to be avoided',
      'No unacclimatised person to work',
      'Ensure adequate fluid intakes appropriate for type of work',
    ],
    workRest: {
      light: continuous('Safe for continuous self-paced light work'),
      heavy: cycle(45, 15, 'Continuous paced work 45 work - 15 rest'),
    },
    waterLph: {
      light: water(1.0, 1.2, '1 -1.2 Litres / hr'),
      heavy: water(1.2, null, '> 1.2 Litres / hr'),
    },
    unacclimatizedAllowed: false,
    // [ENG] "Working alone to be avoided" is applied as no lone work (protective reading).
    loneWorkAllowed: false,
    unacclimatizedLoneWorkAllowed: false,
    ordinaryWorkAllowed: true,
    permitToWork: false,
    basis: ADOSH_TABLE_1,
  },
  {
    id: 'low',
    minWm2: 140,
    maxWm2: null,
    label: 'Low Risk — Unrestricted Zone',
    level: 'safe',
    controls: ['No limits on self-paced work for educated, hydrated workers.'],
    workRest: {
      light: continuous('Safe for all continuous self-paced work'),
      heavy: continuous('Safe for all continuous self-paced work'),
    },
    waterLph: {
      light: water(0.6, 1.0, 'Light Work 600 ml - 1 Litre / hr'),
      // [ENG] Table 1 prints only the light-work row for this zone; its band is used as the minimum for heavier work
      // (the PHS sweat-rate estimate may raise it).
      heavy: water(0.6, 1.0, 'Light Work 600 ml - 1 Litre / hr (only row printed; minimum for heavier work)'),
    },
    unacclimatizedAllowed: true,
    loneWorkAllowed: true,
    unacclimatizedLoneWorkAllowed: true,
    ordinaryWorkAllowed: true,
    permitToWork: false,
    basis: ADOSH_TABLE_1,
  },
]

/**
 * Default rule pack — Emirate of Abu Dhabi. ADOSH-SF CoP 11.0 + TG *Safety in the Heat* v4.0 (ADPHC, 15 July 2024):
 * TG Table 1 TWL zones (High < 115, Medium 115–140, Low > 140 W/m²; exact 115/140 → more protective zone [ENG]); heat-stress
 * programme trigger ≥ 35 °C (CoP §3.1.1(e)); acclimatisation (TG Table 1 note b, CoP §3.2(b)(i)); hydration (CoP §2(d)(ii),
 * §3.2(b)(v)–(vi), TG §5.2, §5.6); Form G notification (Mechanism 11.0 v4.0); UAE midday break (MoHRE MR 44/2022).
 */
export const ABU_DHABI_RULE_PACK: RulePack = deepFreeze<RulePack>({
  id: 'abu-dhabi',
  name: 'Abu Dhabi — ADOSH-SF Safety in the Heat v4.0 + UAE midday break',
  jurisdiction: 'Emirate of Abu Dhabi, United Arab Emirates',
  authority:
    'Abu Dhabi Public Health Centre (ADPHC), ADOSH-SF; UAE Ministry of Human Resources and Emiratisation (MoHRE) for the midday break',
  instrument: 'ADOSH-SF Code of Practice 11.0 "Safety in the Heat" and Technical Guideline "Safety in the Heat"',
  version: '4.0',
  date: '2024-07-15',
  basis: 'ADOSH-SF CoP 11.0 v4.0 and TG v4.0 Table 1 (ADPHC, 15 Jul 2024); UAE MoHRE Ministerial Resolution No. 44 of 2022',
  timeZone: 'Asia/Dubai',
  utcOffsetMinutes: 240,
  middayBreak: MOHRE_MIDDAY_BREAK,
  twlZones: ADOSH_TWL_ZONES,
  heatProgramTriggerC: 35,
  heatProgramBasis:
    'ADOSH-SF CoP 11.0 v4.0 §3.1.1(e): a worksite that has, or is reasonably foreseeable to have, a temperature at or above 35 °C at any time during a work shift shall implement a heat stress program',
  acclimatization: {
    definition:
      'Unacclimatised workers are defined as new workers or those who have been off work for more than 14 days due to illness or on vacation leave (in a cool climate area)',
    daysOffThreshold: 14,
    allowanceDays: [5, 7],
    basis: 'ADOSH-SF TG v4.0 Table 1 note b; CoP 11.0 v4.0 §3.2(b)(i) (5–7 days before starting hard work in a hot environment)',
  },
  hydration: {
    messages: [
      'Drink at least 2 litres every 2–3 hours (4–6 litres per day in the Gulf region)',
      'Programmed drinking every hour',
      'Personal water container of at least 1 litre (2 litres in the High Risk zone); no shared cups or bottles',
      'Electrolyte drink at every second drink; drinks with 4 % sugar or less; salt tablets are not permitted',
      'Above about 1.5 L/h the body cannot absorb more fluid; improve conditions instead',
    ],
    dailyLRange: [4, 6],
    personalContainerMinL: 1,
    practicalCeilingLph: 1.5,
    basis: 'ADOSH-SF CoP 11.0 v4.0 §2(d)(ii), §3.2(b)(v)–(vi); TG v4.0 §5.2, §5.6 and Table 1 note *',
  },
  incidentNotification: {
    form: 'Form G',
    recipient: 'Sector regulatory authority',
    fatalityWithinHours: 24,
    seriousWithinWorkingDays: 3,
    seriousCriteria: [
      'Immediate medical treatment as an in-patient in a hospital',
      'Loss of consciousness and/or requiring resuscitation',
      'Unable to work the next shift',
    ],
    basis:
      'ADOSH-SF Mechanism 11.0 v4.0 (15 Jul 2024), Form G. Heat illness is not named in Schedules A–C; a heat case meeting the Schedule B criteria is treated as notifiable [ENG]',
  },
  penalties: [MOHRE_MIDDAY_PENALTY],
  workerRights: [],
  notes: [
    'CoP 11.0 §1(b): where requirements conflict with another regulator, follow the more stringent requirement.',
    'CoP 11.0 and TG v4.0 name only TWL as the heat-stress index (no WBGT rule).',
    'TG Table 1 prints shared endpoints (115, 140); a TWL exactly on 115 or 140 resolves to the more protective zone [ENG].',
    'Wording follows the English TG v4.0 Table 1 (governing document); the Arabic side of the ADPHC bilingual TWL sheet differs in the Medium zone.',
  ],
})

// ─────────────────────────────── Sharjah (OSHJ-CoP-33 v2) ───────────────────────────────

const SHARJAH_TABLE_3 = 'Sharjah SPSA OSHJ-CoP-33 Safety in Heat v2 Rev 0 (3 Jul 2024) Table 3'

/**
 * SPSA OSHJ-CoP-33 v2 Rev 0 Table 3 (unchanged from OSHJ-GL-15 v1, Sep 2021), transcribed from
 * context_and_commercial.md §3.3 B and twl_and_regulation.md §2.3: "<115 / 115 to 140 / 140 to 220 / >220";
 * water 1.5 / 1.2 / 1 / 0.5 L/h; Medium heavy work "40 mins work, 20 mins rest".
 */
const SHARJAH_TWL_ZONES: readonly TwlZone[] = [
  {
    id: 'high',
    minWm2: null,
    maxWm2: 115,
    label: 'High Risk',
    // "No ordinary work allowed" → the regulatory floor for an ordinary task is stop.
    level: 'stop',
    controls: ['No ordinary work allowed', 'Work limited to essential maintenance or rescue operations'],
    workRest: {
      light: cycle(45, 15, 'Self-paced light work: 45 work / 15 rest (essential work only)'),
      heavy: cycle(20, 40, 'Self-paced heavy work: 20 work / 40 rest (essential work only)'),
    },
    waterLph: { light: water(1.5, 1.5, '1.5 L per hour'), heavy: water(1.5, 1.5, '1.5 L per hour') },
    // [ENG] Not printed for this zone; it cannot be less restrictive than the Medium zone below it.
    unacclimatizedAllowed: false,
    loneWorkAllowed: false,
    unacclimatizedLoneWorkAllowed: false,
    ordinaryWorkAllowed: false,
    permitToWork: false,
    basis: SHARJAH_TABLE_3,
  },
  {
    id: 'medium',
    minWm2: 115,
    maxWm2: 140,
    label: 'Medium Risk',
    level: 'caution',
    controls: [
      'Any practical intervention to reduce heat stress should be implemented',
      'Unacclimatised employees not allowed to work (printed "Acclimatised employees not allowed to work")',
      'No person to work alone',
    ],
    workRest: {
      light: continuous('Continuous self-paced light work'),
      heavy: cycle(40, 20, '40 mins work, 20 mins rest'),
    },
    waterLph: { light: water(1.2, 1.2, '1.2 L per hour'), heavy: water(1.2, 1.2, '1.2 L per hour') },
    // UNVERIFIED: printed "Acclimatised employees not allowed to work" — read as "un-acclimatised" (apparent typo, cf. ADPHC).
    unacclimatizedAllowed: false,
    loneWorkAllowed: false,
    unacclimatizedLoneWorkAllowed: false,
    ordinaryWorkAllowed: true,
    permitToWork: false,
    basis: SHARJAH_TABLE_3,
  },
  {
    id: 'low',
    minWm2: 140,
    maxWm2: 220,
    label: 'Low Risk',
    level: 'safe',
    controls: [
      'No limit on self-paced work for educated self-paced workers',
      'Unacclimatised employees allowed to work, but not alone',
    ],
    workRest: {
      light: continuous('All continuous self-paced light and heavy work'),
      heavy: continuous('All continuous self-paced light and heavy work'),
    },
    waterLph: { light: water(1.0, 1.0, '1 L per hour'), heavy: water(1.0, 1.0, '1 L per hour') },
    unacclimatizedAllowed: true,
    loneWorkAllowed: true,
    // UNVERIFIED: the transcription reads "… allowed to work, but not alone" with the subject elided; read as unacclimatised
    // workers, by analogy with Miller & Bates 2007 Table 6 (140–220 "Acclimatization" zone).
    unacclimatizedLoneWorkAllowed: false,
    ordinaryWorkAllowed: true,
    permitToWork: false,
    basis: SHARJAH_TABLE_3,
  },
  {
    id: 'unrestricted',
    minWm2: 220,
    maxWm2: null,
    label: 'Unrestricted',
    level: 'safe',
    controls: ['No limits on work due to thermal stress'],
    workRest: {
      light: continuous('Continuous paced light and heavy work'),
      heavy: continuous('Continuous paced light and heavy work'),
    },
    waterLph: { light: water(0.5, 0.5, '0.5 L per hour'), heavy: water(0.5, 0.5, '0.5 L per hour') },
    unacclimatizedAllowed: true,
    loneWorkAllowed: true,
    unacclimatizedLoneWorkAllowed: true,
    ordinaryWorkAllowed: true,
    permitToWork: false,
    basis: SHARJAH_TABLE_3,
  },
]

/**
 * Emirate of Sharjah — SPSA OSHJ-CoP-33 *Safety in Heat* v2 Rev 0 (3 July 2024), which replaced guideline OSHJ-GL-15 v1
 * (Sep 2021) with an unchanged TWL table: four zones including > 220 W/m² "Unrestricted"; High = no ordinary work. The
 * midday break is the federal MoHRE rule (MR 44/2022).
 */
export const SHARJAH_RULE_PACK: RulePack = deepFreeze<RulePack>({
  id: 'sharjah',
  name: 'Sharjah — OSHJ-CoP-33 Safety in Heat v2 + UAE midday break',
  jurisdiction: 'Emirate of Sharjah, United Arab Emirates',
  authority: 'Sharjah Prevention and Safety Authority (SPSA); UAE MoHRE for the midday break',
  instrument: 'OSHJ-CoP-33 Code of Practice "Safety in Heat" (replaced guideline OSHJ-GL-15 v1, Sep 2021)',
  version: '2 Rev 0',
  date: '2024-07-03',
  basis: 'SPSA OSHJ-CoP-33 v2 Rev 0 (3 Jul 2024) Table 3; UAE MoHRE Ministerial Resolution No. 44 of 2022',
  timeZone: 'Asia/Dubai',
  utcOffsetMinutes: 240,
  middayBreak: MOHRE_MIDDAY_BREAK,
  twlZones: SHARJAH_TWL_ZONES,
  heatProgramTriggerC: null,
  heatProgramBasis: null,
  acclimatization: null,
  hydration: {
    messages: [
      '4–6 litres per day normally',
      '2 litres every 2–3 hours may be required in extreme heat',
      'Avoid caffeinated drinks',
    ],
    dailyLRange: [4, 6],
    personalContainerMinL: null,
    practicalCeilingLph: null,
    basis: 'SPSA OSHJ-CoP-33 v2 Rev 0 (physio_and_clinical.md hydration table [SPSA24])',
  },
  incidentNotification: null,
  penalties: [MOHRE_MIDDAY_PENALTY],
  workerRights: [],
  notes: [
    'Four TWL zones; the High zone allows no ordinary work (essential maintenance or rescue only).',
    'Medium-zone heavy work is 40/20 (self-paced) versus ADOSH 45/15 (paced); hydration targets differ from ADOSH.',
    'Sharjah acclimatisation definition, notification duty and heat-programme trigger are not transcribed in this pack.',
  ],
})

// ─────────────────────────────── Qatar (MD 17/2021) ───────────────────────────────

/**
 * State of Qatar — Ministerial Decision No. 17 of 2021 (ILO unofficial translation; ILO news 27 May 2021): Art. 2 outdoor
 * work ban 1 June – 15 September, 10:00–15:30; Art. 4(9) "stop the work in workplaces where the WBGT index rises beyond
 * 32.1 °C" at any time; Art. 6 right to stop work; Art. 7 closure; Art. 8 oil and gas excluded. No TWL zones. Qatar keeps
 * Arabia Standard Time (UTC+3, no DST), one hour behind the UAE.
 */
export const QATAR_RULE_PACK: RulePack = deepFreeze<RulePack>({
  id: 'qatar',
  name: 'Qatar — Ministerial Decision No. 17 of 2021',
  jurisdiction: 'State of Qatar',
  authority: 'Ministry of Labour, State of Qatar',
  instrument: 'Ministerial Decision No. 17 of 2021 (heat stress)',
  version: '2021',
  date: '2021-05',
  basis: 'Qatar MD 17/2021 Art. 2 and Art. 4(9) (ILO unofficial translation)',
  timeZone: 'Asia/Qatar',
  utcOffsetMinutes: 180,
  middayBreak: {
    from: '06-01',
    to: '09-15',
    startHhmm: '10:00',
    // The ILO April 2024 report writes 15:00; the ILO 2021 news item and July 2024 report write 15:30 (used; also the
    // more protective reading).
    endHhmm: '15:30',
    appliesTo: 'Outdoor work',
    exemptions: ['Oil and gas sector (Art. 8)'],
    employerDuties: [],
    basis: 'Qatar Ministerial Decision No. 17 of 2021, Art. 2 (1 Jun–15 Sep, 10:00–15:30)',
  },
  twlZones: [],
  wbgtStopC: 32.1,
  wbgtStopBasis: 'Qatar Ministerial Decision No. 17 of 2021, Art. 4(9): stop work where the WBGT index rises beyond 32.1 °C',
  heatProgramTriggerC: null,
  heatProgramBasis: null,
  acclimatization: null,
  hydration: null,
  incidentNotification: null,
  penalties: [
    {
      appliesTo: 'Violations of the decision',
      text: 'Workplace closure',
      currency: null,
      perWorker: null,
      max: null,
      basis: 'Qatar Ministerial Decision No. 17 of 2021, Art. 7',
    },
  ],
  workerRights: ['Workers have the right to stop working if heat threatens their health, without dismissal (Art. 6)'],
  notes: [
    'Employer duties (Art. 4): annual free health checks, risk assessment with workers, training by May, cool water, shaded rest, light clothing.',
    'The WBGT stop applies at any time of day, indoors or outdoors; pass the WBGT of the actual workplace (sun or shade).',
  ],
})

/** The bundled rule packs by id (ARCHITECTURE.md §1.6: jurisdiction-selectable, versioned). */
export const RULE_PACKS: Readonly<Record<RulePackId, RulePack>> = Object.freeze({
  'abu-dhabi': ABU_DHABI_RULE_PACK,
  sharjah: SHARJAH_RULE_PACK,
  qatar: QATAR_RULE_PACK,
})

/** Default rule pack: Abu Dhabi sites default to ADPHC/ADOSH (context_and_commercial.md §3.3). */
export const DEFAULT_RULE_PACK: RulePack = ABU_DHABI_RULE_PACK

/** Look up a bundled rule pack by id (ARCHITECTURE.md §1.6: regulation as data). */
export function getRulePack(id: RulePackId): RulePack {
  return RULE_PACKS[id]
}

// ─────────────────────────────── Calendar rules ───────────────────────────────

/** Local calendar parts in the pack's fixed-offset zone, via ./time.ts (which works in UTC+4). */
function packLocalParts(t: number, pack: RulePack): LocalParts {
  return localParts(t + pack.utcOffsetMinutes * MINUTE_MS - DUBAI_OFFSET_MS)
}

const monthDay = (mmdd: string): number => {
  const [m, d] = mmdd.split('-').map(Number)
  return m * 100 + d
}

function inSeason(p: LocalParts, rule: MiddayBreakRule): boolean {
  const md = p.month * 100 + p.day
  const from = monthDay(rule.from)
  const to = monthDay(rule.to)
  return from <= to ? md >= from && md <= to : md >= from || md <= to
}

/**
 * True when the pack's calendar outdoor-work ban is in force at `t` (epoch ms): season dates inclusive, startHhmm ≤ local
 * time < endHhmm. Abu Dhabi/Sharjah: MoHRE MR 44/2022, 15 Jun–15 Sep, 12:30–15:00 (UTC+4). Qatar: MD 17/2021 Art. 2,
 * 1 Jun–15 Sep, 10:00–15:30 (UTC+3). Whether the ban applies to a task (outdoors in direct sun) is decided by
 * {@link regulatoryFloor}. A non-finite `t` returns true (fail-safe [ENG]: the ban cannot be ruled out).
 */
export function isMiddayBreak(t: number, pack: RulePack = DEFAULT_RULE_PACK): boolean {
  const rule = pack.middayBreak
  if (rule === null) return false
  if (!Number.isFinite(t)) return true
  const p = packLocalParts(t, pack)
  return (
    inSeason(p, rule) &&
    p.minutesOfDay >= hhmmToMinutes(rule.startHhmm) &&
    p.minutesOfDay < hhmmToMinutes(rule.endHhmm)
  )
}

/**
 * The ban window [startT, endT) in epoch ms on the pack-local day containing `t`, or null outside the season (or when the
 * pack has no ban). For planners that must schedule around the midday break. Basis as {@link isMiddayBreak}.
 */
export function middayBreakWindow(
  t: number,
  pack: RulePack = DEFAULT_RULE_PACK,
): { startT: number; endT: number } | null {
  const rule = pack.middayBreak
  if (rule === null || !Number.isFinite(t)) return null
  const p = packLocalParts(t, pack)
  if (!inSeason(p, rule)) return null
  const shift = DUBAI_OFFSET_MS - pack.utcOffsetMinutes * MINUTE_MS
  return {
    startT: epochFromLocal(`${p.dateKey}T${rule.startHhmm}`) + shift,
    endT: epochFromLocal(`${p.dateKey}T${rule.endHhmm}`) + shift,
  }
}

/**
 * Whether a heat-stress programme is required: the shift's maximum (or reasonably foreseeable) air temperature is at or
 * above the pack trigger. Abu Dhabi: ≥ 35 °C, ADOSH-SF CoP 11.0 v4.0 §3.1.1(e). Returns null when the pack transcribes no
 * trigger. A non-finite temperature returns true (fail-safe [ENG]).
 */
export function heatStressProgramRequired(shiftMaxTaC: number, pack: RulePack = DEFAULT_RULE_PACK): boolean | null {
  const trigger = pack.heatProgramTriggerC
  if (trigger === null) return null
  return !(shiftMaxTaC < trigger)
}

// ─────────────────────────────── TWL zones ───────────────────────────────

/**
 * Map an ISO 8996 work class to the zone tables' light/heavy rows. ADOSH TG v4.0 Table 1 note c: light work = "sitting or
 * standing, light arm work"; note d: heavy work = "carrying, climbing, lifting, pushing, whole-body work". 'rest' and
 * 'light' → light; 'moderate' (ISO 8996 class 2 includes pushing/pulling carts and handling moderately heavy material),
 * 'heavy' and 'very_heavy' → heavy [ENG] (protective mapping).
 */
export function twlWorkCategory(workClass: WorkClass): TwlWorkCategory {
  return workClass === 'rest' || workClass === 'light' ? 'light' : 'heavy'
}

/**
 * TWL zone for a TWL value (W/m², compare the UNROUNDED value). Abu Dhabi — ADOSH-SF TG v4.0 Table 1: High TWL < 115,
 * Medium 115–140, Low > 140; a TWL exactly on 115 or 140 resolves to the MORE protective zone [ENG] (ARCHITECTURE.md §5),
 * i.e. High ≤ 115 < Medium ≤ 140 < Low. Sharjah adds Low 140–220 / Unrestricted > 220 (OSHJ-CoP-33 v2 Table 3).
 * A non-finite TWL resolves to the most protective zone (fail-safe). Returns null when the pack has no TWL zones (Qatar).
 */
export function twlZone(twlWm2: number, pack: RulePack = DEFAULT_RULE_PACK): TwlZone | null {
  const zones = pack.twlZones
  if (zones.length === 0) return null
  if (!Number.isFinite(twlWm2)) return zones[0]
  return (
    zones.find((z) => (z.minWm2 === null || twlWm2 > z.minWm2) && (z.maxWm2 === null || twlWm2 <= z.maxWm2)) ?? zones[0]
  )
}

/**
 * Conservative mode's "next-stricter work/rest tier" (ARCHITECTURE.md §5; physio_and_clinical.md §10.9): the work/rest
 * schedule that the next more protective zone of the pack prints for this work category. Zones are listed in ascending
 * TWL order, so that is `pack.twlZones[i − 1]`. The result never allows more work than the zone's own schedule, and a
 * zone that is already the most protective (or is not in the pack) keeps its own schedule. Only the cycle is borrowed:
 * the stricter zone's other controls (e.g. Sharjah High "essential work only") do not apply. Shared by risk.ts and
 * planner.ts so the live engine and the plan agree. Basis: the pack's zone tables (ADOSH-SF TG v4.0 Table 1;
 * OSHJ-CoP-33 v2 Table 3); "next zone" reading of the tier [ENG].
 */
export function stricterWorkRest(zone: TwlZone, category: TwlWorkCategory, pack: RulePack = DEFAULT_RULE_PACK): WorkRestSchedule {
  const own = zone.workRest[category]
  const i = pack.twlZones.findIndex((z) => z.id === zone.id)
  if (i <= 0) return own
  const next = pack.twlZones[i - 1].workRest[category]
  return next.workMinPerHour < own.workMinPerHour ? next : own
}

// ─────────────────────────────── Regulatory floor ───────────────────────────────

/** Inputs of {@link regulatoryFloor}. */
export interface RegulatoryFloorInput {
  /** Epoch ms (UTC). */
  t: number
  /** Thermal Work Limit at the workplace, W/m² (./twl.ts). Non-finite → most protective zone. */
  twlWm2: number
  /** The task is outdoors under direct sun / in open areas (midday-break scope). */
  outdoorInSun: boolean
  /**
   * ADOSH acclimatisation status. 'acclimatizing' is treated as unacclimatised (protective for callers without the
   * ADOSH flag). For ADOSH-exact behaviour pass 'unacclimatized' only for TG v4.0 Table 1 note b workers (new, or off
   * work > 14 days, during the first 7 days back) and 'acclimatized' otherwise — risk.ts and planner.ts map
   * limits.assessAcclimatization().adoshUnacclimatized this way and keep the stricter RAL/ramp in the environment channel.
   */
  acclimatization: AcclimatizationStatus
  workClass: WorkClass
  /** WBGT at the workplace, °C — needed by packs with a WBGT stop rule (Qatar). */
  wbgtC?: number
  /** Defaults to the Abu Dhabi pack. */
  pack?: RulePack
}

/** The regulatory floor for one worker and task (regulation channel, ARCHITECTURE.md §5). */
export interface RegulatoryFloor {
  packId: RulePackId
  level: RiskLevel
  /** Ordered: stop actions first. */
  actions: ActionId[]
  zone: TwlZone | null
  /** Most important first; every driver carries its `basis`. */
  drivers: RiskDriver[]
  /** The zone's work/rest schedule for this work category (applies when work is permitted); null without TWL zones. */
  workRest: WorkRestSchedule | null
  /** Allowed work minutes per hour for this task now (0 when a stop rule applies). */
  workMinPerHour: number
  waterLph: WaterGuidance | null
  noLoneWork: boolean
  /** The worker is excluded from this zone because they are not acclimatised (reassign). */
  unacclimatizedExcluded: boolean
  /** The pack's midday-break window is in force (whether or not this task is outdoors in sun). */
  middayBreakActive: boolean
}

/** Stop actions first, then controls, then reminders. */
const ACTION_ORDER: readonly ActionId[] = [
  'midday_break',
  'stop_work',
  'rest_shade_now',
  'acclimatization_plan',
  'rotate_task',
  'shade_breaks',
  'no_lone_work',
  'drink_water',
  'check_sensor',
]

const ddMonth = (mmdd: string): string => {
  const [m, d] = mmdd.split('-').map(Number)
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`
}

/**
 * The regulatory floor for one worker and task (ARCHITECTURE.md §5, regulation channel). The most protective applicable
 * rule wins (context_and_commercial.md §3.3; ADOSH CoP 11.0 §1(b)):
 * - TWL zone of the pack (twlZone): Abu Dhabi Low → safe; Medium → caution, heavy work 45/15, no lone work; High → high,
 *   light 45/15, heavy 20/40, no lone work, permit to work (ADOSH-SF TG v4.0 Table 1; CoP §3.2(b)(x)). Sharjah High → stop
 *   (no ordinary work; OSHJ-CoP-33 v2 Table 3).
 * - A worker who is not acclimatised ('unacclimatized' or 'acclimatizing') in a zone that excludes them (ADOSH Medium/High:
 *   "No unacclimatised person to work") → stop for that worker, reassign (TG Table 1 note b; CoP §3.2(b)(i)).
 * - Midday break in force and the task is outdoors in the sun → stop with 'midday_break' (MoHRE MR 44/2022; Qatar MD
 *   17/2021 Art. 2).
 * - WBGT strictly above the pack's stop value → stop (Qatar MD 17/2021 Art. 4(9)); WBGT missing for such a pack → caution
 *   + 'check_sensor' (fail-safe [ENG]: a missing input can only raise the level).
 */
export function regulatoryFloor(input: RegulatoryFloorInput): RegulatoryFloor {
  const pack = input.pack ?? DEFAULT_RULE_PACK
  const category = twlWorkCategory(input.workClass)
  const acclimatized = input.acclimatization === 'acclimatized'
  const findings: Array<{ level: RiskLevel; driver: RiskDriver }> = []
  const actions = new Set<ActionId>()
  // Declared through `as` so TypeScript does not narrow them to their initial literals (they are mutated in `add`).
  let level = 'safe' as RiskLevel
  let stopped = false as boolean

  const add =(findingLevel: RiskLevel, driver: Omit<RiskDriver, 'channel'>, ...acts: ActionId[]) => {
    level = maxLevel(level, findingLevel)
    if (RISK_ORDER[findingLevel] >= RISK_ORDER.stop) stopped = true
    findings.push({ level: findingLevel, driver: { channel: 'regulation', ...driver } })
    for (const a of acts) actions.add(a)
  }

  // 1. TWL zone and its controls
  const zone = twlZone(input.twlWm2, pack)
  let workRest: WorkRestSchedule | null = null
  let waterLph: WaterGuidance | null = null
  let noLoneWork = false
  let unacclimatizedExcluded = false
  if (zone !== null) {
    const twlKnown = Number.isFinite(input.twlWm2)
    if (!twlKnown) {
      add(
        zone.level,
        {
          id: 'twl_unavailable',
          text: 'Thermal Work Limit unavailable: the most protective zone is applied',
          direction: 'raises',
          basis: `${zone.basis} [ENG fail-safe]`,
        },
        'check_sensor',
      )
    }
    add(zone.level, {
      id: `twl_zone_${zone.id}`,
      text: twlKnown ? `TWL ${Math.floor(input.twlWm2)} W/m²: ${zone.label}` : `${zone.label} (TWL unavailable)`,
      ...(twlKnown ? { value: input.twlWm2, unit: 'W/m²' } : {}),
      direction: zone.level === 'safe' ? 'info' : 'raises',
      basis: zone.basis,
    })
    workRest = zone.workRest[category]
    waterLph = zone.waterLph[category]
    actions.add('drink_water')
    if (workRest.restMinPerHour > 0) actions.add('shade_breaks')
    if (!zone.loneWorkAllowed) actions.add('no_lone_work')
    noLoneWork = !zone.loneWorkAllowed || (!acclimatized && !zone.unacclimatizedLoneWorkAllowed)

    if (!zone.ordinaryWorkAllowed) {
      add(
        'stop',
        {
          id: 'ordinary_work_prohibited',
          text: `${zone.label}: no ordinary work; essential maintenance or rescue only`,
          direction: 'raises',
          basis: zone.basis,
        },
        'stop_work',
        'rest_shade_now',
      )
    }
    if (zone.permitToWork) {
      add('safe', {
        id: 'permit_to_work',
        text: `${zone.label}: a permit to work in heat is required`,
        direction: 'info',
        basis: 'ADOSH-SF CoP 11.0 v4.0 §3.2(b)(x); TG v4.0 App. 3',
      })
    }
    if (!acclimatized && !zone.unacclimatizedAllowed) {
      unacclimatizedExcluded = true
      add(
        'stop',
        {
          id: 'unacclimatized_excluded',
          text: `Not yet acclimatised: may not work in the ${zone.label}; reassign and follow the acclimatisation plan`,
          direction: 'raises',
          basis: `${zone.basis} ("No unacclimatised person to work")${pack.acclimatization ? `; ${pack.acclimatization.basis}` : ''}`,
        },
        'stop_work',
        'acclimatization_plan',
        'rotate_task',
      )
    } else if (!acclimatized) {
      if (!zone.unacclimatizedLoneWorkAllowed) {
        add(
          'safe',
          {
            id: 'unacclimatized_not_alone',
            text: `Not yet acclimatised: may work in the ${zone.label} but not alone`,
            direction: 'info',
            basis: zone.basis,
          },
          'no_lone_work',
        )
      }
      if (pack.acclimatization !== null) {
        add(
          'safe',
          {
            id: 'acclimatization_programme',
            text: 'Not yet acclimatised: follow the acclimatisation plan before starting hard work in the heat',
            direction: 'info',
            basis: pack.acclimatization.basis,
          },
          'acclimatization_plan',
        )
      }
    }
  }

  // 2. Calendar outdoor-work ban (midday break)
  const middayBreakActive = isMiddayBreak(input.t, pack)
  const rule = pack.middayBreak
  if (middayBreakActive && rule !== null) {
    const window = `${ddMonth(rule.from)}–${ddMonth(rule.to)}, ${rule.startHhmm}–${rule.endHhmm}`
    if (input.outdoorInSun) {
      add(
        'stop',
        {
          id: 'midday_break',
          text: `Midday work ban in force (${window}): ${rule.appliesTo.toLowerCase()} is not allowed`,
          direction: 'raises',
          basis: rule.basis,
        },
        'midday_break',
        'rest_shade_now',
      )
    } else {
      add('safe', {
        id: 'midday_break_window',
        text: `Midday work ban in force (${window}); this task is not outdoors in direct sun`,
        direction: 'info',
        basis: rule.basis,
      })
    }
  }

  // 3. WBGT stop rule (Qatar)
  if (pack.wbgtStopC !== undefined) {
    const basis = pack.wbgtStopBasis ?? pack.basis
    if (input.wbgtC === undefined || !Number.isFinite(input.wbgtC)) {
      add(
        'caution',
        {
          id: 'wbgt_unavailable',
          text: `WBGT unavailable: the ${pack.wbgtStopC} °C stop-work rule cannot be checked`,
          direction: 'raises',
          basis: `${basis} [ENG fail-safe]`,
        },
        'check_sensor',
      )
    } else if (input.wbgtC > pack.wbgtStopC) {
      add(
        'stop',
        {
          id: 'wbgt_stop_limit',
          text: `WBGT ${input.wbgtC.toFixed(1)} °C is above the ${pack.wbgtStopC} °C stop-work limit`,
          value: input.wbgtC,
          unit: '°C',
          direction: 'raises',
          basis,
        },
        'stop_work',
        'rest_shade_now',
      )
    }
  }

  const workMinPerHour = stopped ? 0 : (workRest?.workMinPerHour ?? 60)
  if (workMinPerHour === 0) actions.delete('shade_breaks')

  const drivers = findings
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level] || a.i - b.i)
    .map((f) => f.driver)

  const rank = (a: ActionId) => {
    const i = ACTION_ORDER.indexOf(a)
    return i === -1 ? ACTION_ORDER.length : i
  }

  return {
    packId: pack.id,
    level,
    actions: [...actions].sort((a, b) => rank(a) - rank(b)),
    zone,
    drivers,
    workRest,
    workMinPerHour,
    waterLph,
    noLoneWork,
    unacclimatizedExcluded,
    middayBreakActive,
  }
}

// ─────────────────────────────── Acclimatisation schedules (ADOSH TG v4.0 §3) ───────────────────────────────

/**
 * ADOSH-SF TG v4.0 §3 acclimatisation table ("courtesy of the National Safety Council"): activity as % of the full work
 * assignment on days 1–5. Experienced employee 50/60/80/100/100; new employee 20/40/60/80/100.
 */
export const ADOSH_ACCLIMATIZATION_SCHEDULE_PCT = Object.freeze({
  experienced: Object.freeze([50, 60, 80, 100, 100] as const),
  new: Object.freeze([20, 40, 60, 80, 100] as const),
})

/**
 * Workload cap (% of the full assignment) on acclimatisation day `dayNumber` (1-based) — ADOSH-SF TG v4.0 §3 table.
 * Day ≥ 5 → 100 %. Days below 1 or non-finite are treated as day 1 (protective [ENG]).
 */
export function adoshAcclimatizationWorkloadPct(dayNumber: number, experienced: boolean): number {
  const table = experienced ? ADOSH_ACCLIMATIZATION_SCHEDULE_PCT.experienced : ADOSH_ACCLIMATIZATION_SCHEDULE_PCT.new
  const day = Number.isFinite(dayNumber) ? Math.max(1, Math.floor(dayNumber)) : 1
  return day > table.length ? 100 : table[day - 1]
}

/** One day of a re-acclimatisation sequence: % of the full assignment, or 'reduced_expectations' ("R/E"). */
export type ReacclimatizationStep = number | 'reduced_expectations'

/**
 * Re-acclimatisation sequence after time away — ADOSH-SF TG v4.0 §3 table (% of the full assignment, one entry per day).
 * Absence (days): < 4 → 100; 4–5 → R/E, 100; 6–12 → 80, 100; 12–20 → 60, 80, 100; > 20 → 50, 60, 80, 100.
 * Illness (days): 1–3 → R/E, 100; 4–5 → 80, 100; 6–8 → 60, 80, 100; > 8 → 50, 60, 80, 100.
 * The printed absence bands overlap at 12 days, which takes the longer sequence; fractional days round up; a non-finite
 * count gets the longest sequence (all protective [ENG]).
 */
export function adoshReacclimatizationSequence(daysAway: number, cause: 'absence' | 'illness'): ReacclimatizationStep[] {
  if (!Number.isFinite(daysAway)) return [50, 60, 80, 100]
  const d = Math.ceil(daysAway)
  if (cause === 'absence') {
    if (d < 4) return [100]
    if (d <= 5) return ['reduced_expectations', 100]
    if (d < 12) return [80, 100]
    if (d <= 20) return [60, 80, 100]
    return [50, 60, 80, 100]
  }
  if (d <= 0) return [100]
  if (d <= 3) return ['reduced_expectations', 100]
  if (d <= 5) return [80, 100]
  if (d <= 8) return [60, 80, 100]
  return [50, 60, 80, 100]
}

// ─────────────────────────────── Incident notification ───────────────────────────────

/** Outcome of a heat-illness case, as recorded by the first aider / occupational health. */
export interface HeatIncidentOutcome {
  fatality: boolean
  inpatientHospitalTreatment: boolean
  lossOfConsciousnessOrResuscitation: boolean
  unableToWorkNextShift: boolean
}

/** Whether, how and how fast a heat incident must be notified under the pack. */
export interface HeatIncidentNotification {
  notifiable: boolean
  form: string
  recipient: string
  withinHours: number | null
  withinWorkingDays: number | null
  basis: string
}

/**
 * Notification duty for a heat-illness case — ADOSH-SF Mechanism 11.0 v4.0 (15 July 2024): serious incidents go to the
 * sector regulatory authority on Form G within 24 h for fatalities, 3 working days for other serious incidents. Heat illness
 * is not named in Schedules A–C, so a case meeting the Schedule B criteria (in-patient treatment, loss of consciousness /
 * resuscitation, unable to work the next shift) is treated as notifiable [ENG]. Returns null when the pack transcribes no
 * notification duty.
 */
export function heatIncidentNotification(
  outcome: HeatIncidentOutcome,
  pack: RulePack = DEFAULT_RULE_PACK,
): HeatIncidentNotification | null {
  const rule = pack.incidentNotification
  if (rule === null) return null
  const serious =
    outcome.inpatientHospitalTreatment || outcome.lossOfConsciousnessOrResuscitation || outcome.unableToWorkNextShift
  return {
    notifiable: outcome.fatality || serious,
    form: rule.form,
    recipient: rule.recipient,
    withinHours: outcome.fatality ? rule.fatalityWithinHours : null,
    withinWorkingDays: !outcome.fatality && serious ? rule.seriousWithinWorkingDays : null,
    basis: rule.basis,
  }
}
