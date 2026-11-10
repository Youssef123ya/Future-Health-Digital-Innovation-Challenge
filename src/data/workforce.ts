/**
 * Deterministic synthetic workforce for the five demo sites, plus a fixed demo crew whose personas carry the demo
 * stories.
 *
 * - About 3 crews per site with 6–10 workers each, doing tasks typical of the site kind. Each task's ISO 8996 / OSHA
 *   work class is cited (docs/research/limits_and_workrest.md §5.1–5.2).
 * - Workers reflect the UAE migrant workforce: country-of-origin shares from UN DESA International Migrant Stock 2024
 *   (docs/research/context_and_commercial.md §2.2). Origin is used only inside the generator to draw a plausible name
 *   and the preferred language. **Zill stores the language, never nationality**: nationality says nothing about heat
 *   risk, and it is exactly the field an immigration or visa misuse (a prohibited purpose) would want.
 * - Body size, acclimatisation history, consent, risk flags and wearables vary per worker. Risk flags are set only when
 *   the worker consented to `healthFlags` (engine/types.ts contract).
 * - Every behavioural or prevalence parameter here is an [ENG] scenario assumption for a synthetic cohort, not an
 *   epidemiological estimate. Simulated results built on it are projections (docs/SIMULATION.md).
 *
 * Determinism: everything derives from one seed through sim/rng.ts forks (site → crew → worker), so adding crews never
 * changes existing ones.
 */
import type { ClothingId, ConsentState, Crew, LangCode, RiskFlagId, Site, Task, WorkClass, WorkerProfile } from '../engine/types'
import { epochFromLocal } from '../engine/time'
import { createRng, hashSeed, type Rng } from '../sim/rng'
import { SITES, type SiteId } from './sites'

// ═══════════════════════════════ Origins and languages ═══════════════════════════════

/** Country-of-origin groups used internally to draw names and languages (never stored on a worker). */
export type OriginId =
  | 'india'
  | 'bangladesh'
  | 'pakistan'
  | 'egypt'
  | 'philippines'
  | 'indonesia'
  | 'yemen'
  | 'jordan'
  | 'sudan'
  | 'sri_lanka'
  | 'nepal'

/**
 * Sampling weights (% of UAE international migrants). Basis: UN DESA International Migrant Stock 2024, destination UAE,
 * top-10 origins (context_and_commercial.md §2.2): India 39.8, Bangladesh 12.6, Pakistan 11.4, Egypt 10.3,
 * Philippines 6.5, Indonesia 3.7, Yemen 2.4, Jordan 1.9, Sudan 1.5, Sri Lanka 1.4.
 * Nepal: UN DESA lists only 26,097 (0.3 %), "very likely an undercount" given ~201,148 new UAE labour permits
 * (274,590 with renewals) in FY2024/25; with 2-year contracts that implies a stock of roughly 0.4–0.55 M. The weight
 * 5.0 is an [ENG] derived assumption, not a published share. Weights are renormalised when sampling.
 */
export const ORIGIN_SHARES_PCT: Readonly<Record<OriginId, number>> = {
  india: 39.8,
  bangladesh: 12.6,
  pakistan: 11.4,
  egypt: 10.3,
  philippines: 6.5,
  indonesia: 3.7,
  yemen: 2.4,
  jordan: 1.9,
  sudan: 1.5,
  sri_lanka: 1.4,
  nepal: 5.0,
}

/**
 * Share of Indian workers whose preferred language is Malayalam: ~0.85 M Keralite emigrants in the UAE (Kerala
 * Migration Survey 2023: 2.2 M emigrants, 38.6 % in the UAE; draft report) ÷ 3.25 M Indians (UN DESA 2024) ≈ 0.26
 * (context_and_commercial.md §2.2, derived). The rest are drawn as Hindi speakers (Tamil and other Indian languages are
 * tier 2 and not yet in the launch set, §2.3).
 */
export const KERALA_SHARE_OF_INDIAN_WORKERS = 0.26

interface NamePool {
  male: readonly string[]
  female: readonly string[]
  family: readonly string[]
}

/** Name pools by naming tradition, kept internally consistent (first and family names that occur together). */
const NAME_POOLS = {
  north_india: {
    male: ['Rajesh', 'Sunil', 'Amit', 'Ramesh', 'Manoj', 'Vikram', 'Deepak', 'Santosh', 'Anil', 'Ravi', 'Pankaj', 'Sanjay', 'Mukesh', 'Ajay', 'Dinesh', 'Rakesh'],
    female: ['Priya', 'Sunita', 'Pooja', 'Anita', 'Rekha'],
    family: ['Kumar', 'Yadav', 'Singh', 'Prasad', 'Gupta', 'Chauhan', 'Sharma', 'Mishra', 'Verma', 'Pandey', 'Maurya', 'Tiwari'],
  },
  north_india_muslim: {
    male: ['Imran', 'Salim', 'Arif', 'Shahid', 'Javed', 'Naseem', 'Irfan', 'Wasim'],
    female: ['Shabana', 'Nazia'],
    family: ['Ansari', 'Khan', 'Qureshi', 'Siddiqui', 'Shaikh'],
  },
  kerala_hindu: {
    male: ['Anoop', 'Rajeev', 'Suresh', 'Sanal', 'Vineeth', 'Arun', 'Sreejith', 'Pradeep'],
    female: ['Divya', 'Anju', 'Sreeja'],
    family: ['Nair', 'Menon', 'Pillai', 'Das', 'Kurup', 'Nambiar'],
  },
  kerala_christian: {
    male: ['Biju', 'Shaji', 'Jijo', 'Shibu', 'Rinto', 'Jithin', 'Tomy', 'Saju'],
    female: ['Neethu', 'Jincy', 'Mini'],
    family: ['Thomas', 'Varghese', 'George', 'Kurian', 'Mathew', 'Joseph'],
  },
  kerala_muslim: {
    male: ['Faisal', 'Ashraf', 'Nishad', 'Shafeeq', 'Rashid', 'Anas', 'Noushad', 'Jaleel'],
    female: ['Fathima', 'Shameena'],
    family: ['Rahman', 'Moideen', 'Koya', 'Basheer', 'Kutty'],
  },
  bangladesh: {
    male: ['Rafiqul', 'Abdul', 'Shahidul', 'Jahangir', 'Mizanur', 'Kamal', 'Nazrul', 'Sohel', 'Rubel', 'Habib', 'Monir', 'Alamgir'],
    female: ['Nasrin', 'Shirin', 'Rina'],
    family: ['Islam', 'Karim', 'Haque', 'Alam', 'Rahman', 'Hossain', 'Mia', 'Uddin', 'Ahmed', 'Sarker', 'Molla'],
  },
  pakistan: {
    male: ['Muhammad', 'Asif', 'Tariq', 'Naveed', 'Bilal', 'Zahid', 'Shahzad', 'Waqas', 'Kashif', 'Imtiaz', 'Adnan', 'Sajid'],
    female: ['Ayesha', 'Sana'],
    family: ['Khan', 'Mehmood', 'Akhtar', 'Ahmed', 'Hussain', 'Ali', 'Iqbal', 'Raza', 'Butt', 'Awan', 'Qureshi'],
  },
  egypt: {
    male: ['Mahmoud', 'Ahmed', 'Mostafa', 'Khaled', 'Hany', 'Mohamed', 'Ayman', 'Sherif', 'Tamer', 'Wael', 'Hossam', 'Ashraf'],
    female: ['Mona', 'Dina', 'Heba'],
    family: ['Hassan', 'Ibrahim', 'Saeed', 'Fawzy', 'Farouk', 'Salah', 'Adel', 'Abdelaziz', 'Mansour', 'Fathy', 'Shawky'],
  },
  arab_other: {
    male: ['Abdullah', 'Omar', 'Yousif', 'Faris', 'Hamza', 'Ibrahim', 'Saleh', 'Nasser', 'Mohammed', 'Ali', 'Osman'],
    female: ['Huda', 'Amal'],
    family: ['Saleh', 'Haddad', 'Osman', 'Al-Amri', 'Odeh', 'Adam', 'Abbas', 'Mustafa', 'Babiker', 'Al-Saadi'],
  },
  philippines: {
    male: ['Jomar', 'Ronaldo', 'Mark Anthony', 'Jayson', 'Rodel', 'Arnel', 'Joel', 'Romeo', 'Jericho', 'Rommel', 'Dennis', 'Noel'],
    female: ['Maricel', 'Jocelyn', 'Lorna', 'Grace'],
    family: ['Santos', 'Reyes', 'Cruz', 'Dela Cruz', 'Bautista', 'Garcia', 'Mendoza', 'Villanueva', 'Ramos', 'Aquino', 'Castillo', 'Flores'],
  },
  nepal: {
    male: ['Ram', 'Bikash', 'Suman', 'Hari', 'Dipendra', 'Krishna', 'Prakash', 'Sujan', 'Bishnu', 'Dil', 'Rajendra', 'Sanjeev'],
    female: ['Sita', 'Sabina', 'Gita'],
    family: ['Thapa', 'Gurung', 'Tamang', 'Shrestha', 'Rai', 'Magar', 'Lama', 'Karki', 'Limbu', 'Bhandari', 'Adhikari'],
  },
  sri_lanka: {
    male: ['Nuwan', 'Chaminda', 'Kasun', 'Tharindu', 'Ruwan', 'Lahiru', 'Sampath', 'Asanka'],
    female: ['Dilini', 'Nadeesha'],
    family: ['Perera', 'Silva', 'Fernando', 'Jayasinghe', 'Bandara', 'Dissanayake', 'Herath'],
  },
  indonesia: {
    male: ['Agus', 'Budi', 'Eko', 'Dedi', 'Hendra', 'Joko', 'Rudi', 'Wahyu'],
    female: ['Siti', 'Dewi'],
    family: ['Setiawan', 'Santoso', 'Prasetyo', 'Kurniawan', 'Hidayat', 'Saputra', 'Wijaya', 'Nugroho'],
  },
} as const satisfies Record<string, NamePool>

type NamePoolId = keyof typeof NAME_POOLS

/** Name tradition and preferred language per origin, with within-origin weights ([ENG] where not cited). */
const ORIGIN_GROUPS: Readonly<Record<OriginId, readonly { pool: NamePoolId; language: LangCode; weight: number }[]>> = {
  india: [
    { pool: 'north_india', language: 'hi', weight: (1 - KERALA_SHARE_OF_INDIAN_WORKERS) * 0.8 },
    { pool: 'north_india_muslim', language: 'hi', weight: (1 - KERALA_SHARE_OF_INDIAN_WORKERS) * 0.2 },
    { pool: 'kerala_hindu', language: 'ml', weight: KERALA_SHARE_OF_INDIAN_WORKERS / 3 },
    { pool: 'kerala_christian', language: 'ml', weight: KERALA_SHARE_OF_INDIAN_WORKERS / 3 },
    { pool: 'kerala_muslim', language: 'ml', weight: KERALA_SHARE_OF_INDIAN_WORKERS / 3 },
  ],
  bangladesh: [{ pool: 'bangladesh', language: 'bn', weight: 1 }],
  pakistan: [{ pool: 'pakistan', language: 'ur', weight: 1 }],
  egypt: [{ pool: 'egypt', language: 'ar', weight: 1 }],
  philippines: [{ pool: 'philippines', language: 'tl', weight: 1 }],
  nepal: [{ pool: 'nepal', language: 'ne', weight: 1 }],
  yemen: [{ pool: 'arab_other', language: 'ar', weight: 1 }],
  jordan: [{ pool: 'arab_other', language: 'ar', weight: 1 }],
  sudan: [{ pool: 'arab_other', language: 'ar', weight: 1 }],
  // Sinhala/Tamil and Indonesian are outside the 8-language launch set (context_and_commercial.md §2.3) → English.
  sri_lanka: [{ pool: 'sri_lanka', language: 'en', weight: 1 }],
  indonesia: [{ pool: 'indonesia', language: 'en', weight: 1 }],
}

/**
 * Expected share of each preferred language implied by {@link ORIGIN_SHARES_PCT} and {@link KERALA_SHARE_OF_INDIAN_WORKERS}
 * (fractions summing to 1). Used to check generated cohorts and to size translation/voice work.
 */
export function expectedLanguageMix(): Record<LangCode, number> {
  const mix: Record<LangCode, number> = { en: 0, ar: 0, hi: 0, ur: 0, ml: 0, bn: 0, tl: 0, ne: 0 }
  const total = Object.values(ORIGIN_SHARES_PCT).reduce((a, b) => a + b, 0)
  for (const origin of Object.keys(ORIGIN_SHARES_PCT) as OriginId[]) {
    const groups = ORIGIN_GROUPS[origin]
    const gTotal = groups.reduce((a, g) => a + g.weight, 0)
    for (const g of groups) mix[g.language] += (ORIGIN_SHARES_PCT[origin] / total) * (g.weight / gTotal)
  }
  return mix
}

// ═══════════════════════════════ Tasks ═══════════════════════════════

/** A task template (id assigned per crew). */
export type TaskTemplate = Omit<Task, 'id'> & { key: string }

/**
 * Tasks typical of each site kind. Work classes follow the OSHA workload table / ACGIH Table 3 categories (115 / 180 /
 * 300 / 415 / 520 W) and ISO 8996:2004 Table A.2, as mapped in limits_and_workrest.md §5.2 ("Typical Zill tasks"):
 * light = inspection, standing watch; moderate = mobile-equipment operation (corrected by fact-check from light), hand
 * tools, painting/plastering; heavy = carrying loads, rebar or concrete work, heavy carpentry, shovelling, welding,
 * grinding and cutting, landscaping; very heavy = ladder climbing, brick or stone masonry. ISO 7243:2017 §9.3: take the
 * higher class when in doubt. Time windows ("HH:mm", local) and flexibility are [ENG] scheduling assumptions: flexible
 * work may be moved by the planner; vessel-bound and traffic-bound work may not.
 */
export const TASK_LIBRARY: Readonly<Record<Site['kind'], readonly TaskTemplate[]>> = {
  construction: [
    { key: 'concrete_pour', name: 'Concrete pour', workClass: 'heavy', inSun: true, durationMin: 180, flexible: true, earliestStart: '04:30', latestEnd: '10:30' },
    { key: 'rebar_fixing', name: 'Rebar fixing', workClass: 'heavy', inSun: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '17:30' },
    { key: 'formwork', name: 'Formwork shuttering', workClass: 'heavy', inSun: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '17:30' },
    { key: 'scaffolding', name: 'Scaffold erection', workClass: 'very_heavy', inSun: true, durationMin: 180, flexible: true, earliestStart: '06:00', latestEnd: '17:30' },
    { key: 'finishing', name: 'Blockwork and plastering inside the structure', workClass: 'moderate', inSun: false, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '18:00' },
    { key: 'material_handling', name: 'Material handling', workClass: 'heavy', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '17:30' },
  ],
  port: [
    { key: 'lashing', name: 'Container lashing', workClass: 'heavy', inSun: true, durationMin: 240, flexible: false, earliestStart: '07:00', latestEnd: '11:00' },
    { key: 'breakbulk_loading', name: 'Break-bulk loading and unloading', workClass: 'heavy', inSun: true, durationMin: 240, flexible: false, earliestStart: '06:00', latestEnd: '10:00' },
    // Open-cab forklifts and reach stackers on a hot apron: treated as in sun [ENG, protective].
    { key: 'mobile_equipment', name: 'Forklift and reach-stacker operation', workClass: 'moderate', inSun: true, durationMin: 300, flexible: false, earliestStart: '06:00', latestEnd: '11:00' },
    { key: 'yard_inspection', name: 'Yard and reefer inspection', workClass: 'light', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '18:00' },
  ],
  industrial: [
    { key: 'maintenance', name: 'Pump and valve maintenance', workClass: 'moderate', inSun: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '17:00' },
    // Hot work: flame-resistant coveralls and a welding hood (ACGIH: hood adds 1 °C to WBGT_eff on top of the ensemble CAV).
    { key: 'welding', name: 'Pipe welding (hot work)', workClass: 'heavy', inSun: true, clothing: 'fr_coveralls', hood: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '16:00' },
    { key: 'grinding', name: 'Grinding and fitting', workClass: 'heavy', inSun: true, clothing: 'fr_coveralls', durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '16:00' },
    { key: 'insulation', name: 'Pipe insulation and cladding', workClass: 'moderate', inSun: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '17:00' },
    { key: 'inspection_rounds', name: 'Inspection rounds', workClass: 'light', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '18:00' },
  ],
  inland: [
    // Asphalt laying is a listed technical exemption from the midday break (MR 44/2022; twl_and_regulation.md) — start early.
    { key: 'asphalt_paving', name: 'Asphalt paving (raking and compacting)', workClass: 'heavy', inSun: true, durationMin: 240, flexible: true, earliestStart: '05:00', latestEnd: '11:30' },
    { key: 'traffic_management', name: 'Traffic management (flagging)', workClass: 'light', inSun: true, durationMin: 240, flexible: false, earliestStart: '06:00', latestEnd: '10:00' },
    { key: 'kerb_laying', name: 'Kerb stone laying', workClass: 'very_heavy', inSun: true, durationMin: 180, flexible: true, earliestStart: '06:00', latestEnd: '17:00' },
    { key: 'backfill', name: 'Backfilling and compaction', workClass: 'heavy', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '17:00' },
    { key: 'landscaping', name: 'Planting and irrigation trenching', workClass: 'heavy', inSun: true, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '17:30' },
    { key: 'irrigation_check', name: 'Irrigation line inspection', workClass: 'light', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '18:00' },
  ],
}

/** Crew templates per site kind: a crew name and its day plan (task keys from {@link TASK_LIBRARY}, optional duration). */
const CREW_TEMPLATES: Readonly<Record<Site['kind'], readonly { name: string; tasks: readonly [string, number?][] }[]>> = {
  construction: [
    { name: 'Rebar and concrete crew', tasks: [['concrete_pour'], ['rebar_fixing'], ['material_handling', 60]] },
    { name: 'Formwork crew', tasks: [['formwork'], ['material_handling']] },
    { name: 'Scaffolding and finishing crew', tasks: [['scaffolding'], ['finishing']] },
  ],
  port: [
    { name: 'Lashing gang', tasks: [['lashing'], ['yard_inspection']] },
    { name: 'Yard equipment crew', tasks: [['mobile_equipment'], ['yard_inspection']] },
    { name: 'Break-bulk gang', tasks: [['breakbulk_loading'], ['lashing', 120]] },
  ],
  industrial: [
    { name: 'Mechanical maintenance crew', tasks: [['maintenance'], ['inspection_rounds']] },
    { name: 'Welding crew', tasks: [['welding'], ['grinding']] },
    { name: 'Insulation crew', tasks: [['insulation'], ['inspection_rounds', 60]] },
  ],
  inland: [
    { name: 'Asphalt paving crew', tasks: [['asphalt_paving'], ['traffic_management']] },
    { name: 'Kerbs and paving crew', tasks: [['kerb_laying'], ['backfill']] },
    { name: 'Landscaping crew', tasks: [['landscaping'], ['irrigation_check']] },
  ],
}

/**
 * Default clothing per site [ENG]: long-sleeved work clothes on construction and road sites, cloth coveralls in ports
 * and industry, and flame-resistant coveralls site-wide at Ruwais (petrochemical plants require FR clothing). The ACGIH
 * −1 °C short-sleeve credit is never assumed (ARCHITECTURE.md §5).
 */
export const SITE_DEFAULT_CLOTHING: Readonly<Record<SiteId, ClothingId>> = {
  musaffah: 'cloth_coveralls',
  kezad: 'cloth_coveralls',
  ruwais: 'fr_coveralls',
  alain: 'work_clothes',
  saadiyat: 'work_clothes',
}

function buildTasks(crewId: string, kind: Site['kind'], plan: readonly [string, number?][]): Task[] {
  return plan.map(([key, durationMin]) => {
    const tpl = TASK_LIBRARY[kind].find((t) => t.key === key)
    if (!tpl) throw new Error(`Unknown task ${key} for ${kind}`)
    const { key: _key, ...rest } = tpl
    return { ...rest, id: `${crewId}:${key}`, durationMin: durationMin ?? tpl.durationMin }
  })
}

// ═══════════════════════════════ Worker attributes ═══════════════════════════════

/**
 * Cohort parameters, all [ENG] scenario assumptions for a synthetic cohort (not epidemiological estimates):
 * - ages 20–58, mean 34 (migrant construction workforce skews young);
 * - 4 % women (a small minority in UAE outdoor trades);
 * - anthropometry: height N(168, 7) cm men / N(157, 6) cm women, BMI N(24.5, 3.5) — not population-specific, to avoid
 *   unsourced national stereotypes;
 * - acclimatisation history: 8 % first-week arrivals, 10 % returning from home leave, 7 % in weeks 2–3, 75 % established;
 * - consent (all opt-in): check-ins 85 %, health flags 55 %, share with medic on escalation 60 %, aggregate statistics
 *   75 %; 8 % decline every optional scope; ~60 % carry a wearable, 80 % of whom consent to its use;
 * - risk-flag prevalence among those who consent to declare them (illustrative);
 * - resting HR N(68, 8) bpm, the ground-truth default of docs/SIMULATION.md §2.1.
 */
export const COHORT_PARAMS = {
  ageMeanYears: 34,
  ageSdYears: 8,
  ageMinYears: 20,
  ageMaxYears: 58,
  femaleShare: 0.04,
  heightCm: { male: [168, 7, 150, 192], female: [157, 6, 142, 178] },
  bmi: [24.5, 3.5, 17.5, 38],
  history: { first_week: 0.08, returning: 0.1, settling: 0.07, established: 0.75 },
  consent: { checkins: 0.85, healthFlags: 0.55, shareWithMedicOnEscalation: 0.6, aggregateStatistics: 0.75, declineAll: 0.08 },
  wearableShare: 0.6,
  wearableConsentGivenBand: 0.8,
  riskFlagPrevalence: {
    prior_heat_illness: 0.04,
    heat_sensitive_medication: 0.04,
    hr_suppressing_medication: 0.02,
    recent_illness: 0.03,
    poor_sleep: 0.08,
    fasting: 0.02,
    heat_rash_sunburn: 0.03,
  },
  restingHrBpm: [68, 8, 48, 95],
} as const

/**
 * Occupational-health review rule used to set `oh_review_required` in the synthetic cohort: age ≥ 50 or BMI ≥ 30
 * (examples given for the flag in engine/types.ts and physio_and_clinical.md §7; BMI ≥ 30 is the WHO obesity cut-off).
 * In practice occupational health sets this flag; it prompts a confidential review, not an automatic rule.
 */
export const OH_REVIEW_AGE_YEARS = 50
/** BMI at or above which the synthetic cohort is flagged for occupational-health review (WHO obesity class I). */
export const OH_REVIEW_BMI = 30

/** Fixed timestamp used as `consent.updatedAt` for generated rosters (2025-06-01 06:00 Abu Dhabi), keeping output deterministic. */
export const DEFAULT_ROSTER_EPOCH = epochFromLocal('2025-06-01T06:00')

type HistoryKind = keyof typeof COHORT_PARAMS.history

function drawName(rng: Rng, pool: NamePool, sex: 'male' | 'female'): { first: string; family: string } {
  return { first: rng.pick(sex === 'male' ? pool.male : pool.female), family: rng.pick(pool.family) }
}

const badge = (n: { first: string; family: string }) => `${n.first} ${n.family.charAt(0)}.`

/**
 * Work history in the semantics of engine/limits.ts `assessAcclimatization` (and types.ts WorkerProfile):
 * `daysOnSite` = days worked in the heat in the current stretch (since arrival, or since returning from an absence of
 * ≥ 4 days); `daysAwayRecent` = length in days of the absence that preceded the stretch (0 when none; > 14 is
 * meaningful — ADOSH treats > 14 days off as unacclimatised).
 */
function drawHistory(rng: Rng): Pick<WorkerProfile, 'daysOnSite' | 'daysAwayRecent' | 'experiencedInHeat'> {
  const h = COHORT_PARAMS.history
  const kind = rng.weighted<HistoryKind>(['first_week', 'returning', 'settling', 'established'], [h.first_week, h.returning, h.settling, h.established])
  switch (kind) {
    case 'first_week': {
      // New arrival from a cooler home country: the preceding "absence" from Gulf heat is months long.
      const daysOnSite = rng.int(1, 7)
      return { daysOnSite, daysAwayRecent: rng.int(60, 365), experiencedInHeat: rng.chance(0.3) }
    }
    case 'returning': {
      // Back from home leave (typically 21–60 days, in a cooler climate).
      const daysOnSite = rng.int(1, 10)
      return { daysOnSite, daysAwayRecent: rng.int(21, 60), experiencedInHeat: true }
    }
    case 'settling': {
      // Arrived or returned 8–20 days ago after a long absence.
      const daysOnSite = rng.int(8, 20)
      return { daysOnSite, daysAwayRecent: rng.int(21, 120), experiencedInHeat: rng.chance(0.4) }
    }
    default: {
      // Established: short absences (< 4 days) do not restart the stretch.
      const daysOnSite = Math.round(Math.min(1500, Math.max(21, rng.lognormal(240, 0.8))))
      return { daysOnSite, daysAwayRecent: rng.chance(0.08) ? rng.int(1, 3) : 0, experiencedInHeat: daysOnSite >= 120 || rng.chance(0.6) }
    }
  }
}

function drawConsent(rng: Rng, hasWearable: boolean, updatedAt: number): ConsentState {
  const c = COHORT_PARAMS.consent
  if (rng.chance(c.declineAll)) {
    return { wearable: false, healthFlags: false, checkins: false, shareWithMedicOnEscalation: false, aggregateStatistics: false, updatedAt }
  }
  return {
    wearable: hasWearable && rng.chance(COHORT_PARAMS.wearableConsentGivenBand),
    healthFlags: rng.chance(c.healthFlags),
    checkins: rng.chance(c.checkins),
    shareWithMedicOnEscalation: rng.chance(c.shareWithMedicOnEscalation),
    aggregateStatistics: rng.chance(c.aggregateStatistics),
    updatedAt,
  }
}

function drawRiskFlags(rng: Rng, consent: ConsentState, ageYears: number, bmi: number): RiskFlagId[] {
  if (!consent.healthFlags) return []
  const flags: RiskFlagId[] = []
  for (const [flag, p] of Object.entries(COHORT_PARAMS.riskFlagPrevalence) as [RiskFlagId, number][]) {
    if (rng.chance(p)) flags.push(flag)
  }
  if (ageYears >= OH_REVIEW_AGE_YEARS || bmi >= OH_REVIEW_BMI) flags.push('oh_review_required')
  return flags
}

function uniqueWorkerId(key: string, used: Set<string>): string {
  for (let k = 0; ; k++) {
    const id = `W-${(hashSeed(k === 0 ? key : `${key}#${k}`) & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
}

function drawOriginGroup(rng: Rng): { pool: NamePool; language: LangCode } {
  const origins = Object.keys(ORIGIN_SHARES_PCT) as OriginId[]
  const origin = rng.weighted(origins, origins.map((o) => ORIGIN_SHARES_PCT[o]))
  const groups = ORIGIN_GROUPS[origin]
  const g = rng.weighted(groups, groups.map((x) => x.weight))
  return { pool: NAME_POOLS[g.pool], language: g.language }
}

interface GenContext {
  seed: string | number
  usedIds: Set<string>
  usedBadges: Map<string, Set<string>>
  rosterEpoch: number
}

function generateWorker(rng: Rng, site: Site, crewId: string, idKey: string, ctx: GenContext): WorkerProfile {
  const p = COHORT_PARAMS
  const { pool, language } = drawOriginGroup(rng)
  const sex: 'male' | 'female' = rng.chance(p.femaleShare) ? 'female' : 'male'
  const siteBadges = ctx.usedBadges.get(site.id) ?? new Set<string>()
  ctx.usedBadges.set(site.id, siteBadges)
  let name = badge(drawName(rng, pool, sex))
  for (let tries = 0; siteBadges.has(name) && tries < 8; tries++) name = badge(drawName(rng, pool, sex))
  if (siteBadges.has(name)) {
    let k = 2
    while (siteBadges.has(`${name} (${k})`)) k++
    name = `${name} (${k})`
  }
  siteBadges.add(name)

  const ageYears = Math.round(rng.truncNormal(p.ageMeanYears, p.ageSdYears, p.ageMinYears, p.ageMaxYears))
  const [hMean, hSd, hMin, hMax] = p.heightCm[sex]
  const heightCm = Math.round(rng.truncNormal(hMean, hSd, hMin, hMax))
  const [bMean, bSd, bMin, bMax] = p.bmi
  const bmi = rng.truncNormal(bMean, bSd, bMin, bMax)
  const massKg = Math.round(bmi * (heightCm / 100) ** 2 * 2) / 2
  const history = drawHistory(rng)
  const hasWearable = rng.chance(p.wearableShare)
  const consent = drawConsent(rng, hasWearable, ctx.rosterEpoch)
  const riskFlags = drawRiskFlags(rng, consent, ageYears, massKg / (heightCm / 100) ** 2)
  const [rMean, rSd, rMin, rMax] = p.restingHrBpm
  return {
    id: uniqueWorkerId(`${ctx.seed}|${idKey}`, ctx.usedIds),
    displayName: name,
    crewId,
    siteId: site.id,
    language,
    ageYears,
    sex,
    massKg,
    heightCm,
    ...history,
    clothing: SITE_DEFAULT_CLOTHING[site.id],
    riskFlags,
    restingHrBpm: Math.round(rng.truncNormal(rMean, rSd, rMin, rMax)),
    consent,
    hasWearable,
  }
}

// ═══════════════════════════════ Demo crew ═══════════════════════════════

/** Demo personas, one per demo story. */
export type DemoPersonaId = 'new_arrival' | 'veteran_welder' | 'beta_blocker' | 'fasting' | 'declines_consent'

/** A demo persona: which worker carries which story and what it demonstrates. */
export interface DemoPersona {
  id: DemoPersonaId
  workerId: string
  /** The crew task the story is told on. */
  taskId: string
  title: string
  story: string
  demonstrates: string[]
}

/** Id of the fixed demo crew (Musaffah, the site of the summer-2025 peak-WBGT demo day 2025-08-01). */
export const DEMO_CREW_ID = 'musaffah-demo'

/**
 * The fixed demo crew at Musaffah with five personas (plus two crewmates) for the demo stories. Hand-written, not
 * random, so stories are stable across seeds. Each persona exercises a protective rule:
 * - day-2 new arrival → unacclimatised: NIOSH RAL instead of REL and conservative mode for the first 14 days; ADOSH:
 *   no unacclimatised worker in the Medium/High TWL zones (reassign);
 * - acclimatised welder in FR coveralls + hood → ACGIH clothing adjustment + 1 °C for the hood drives the environment
 *   channel even for a veteran;
 * - worker on beta-blockers with a wearable → `hr_suppressing_medication` disables every heart-rate rule (the band can
 *   never be falsely reassuring); conservative mode on;
 * - fasting worker → conservative mode and no drink reminders during fasting hours;
 * - worker declining all optional consent → full environment- and work-based protection, nothing personal processed.
 */
export function buildDemoCrew(rosterEpoch: number = DEFAULT_ROSTER_EPOCH): { crew: Crew; workers: WorkerProfile[]; personas: DemoPersona[] } {
  const crewId = DEMO_CREW_ID
  const tasks = buildTasks(crewId, 'industrial', [['welding'], ['maintenance'], ['grinding'], ['inspection_rounds']])
  const all = (v: boolean): ConsentState => ({ wearable: v, healthFlags: v, checkins: v, shareWithMedicOnEscalation: v, aggregateStatistics: v, updatedAt: rosterEpoch })
  const common = { crewId, siteId: 'musaffah' as const, sex: 'male' as const, clothing: 'cloth_coveralls' as ClothingId }
  const workers: WorkerProfile[] = [
    { ...common, id: 'W-D2A1', displayName: 'Bikash G.', language: 'ne', ageYears: 23, massKg: 61, heightCm: 165, daysOnSite: 2, daysAwayRecent: 365, experiencedInHeat: false, riskFlags: [], restingHrBpm: 66, consent: { ...all(true), wearable: false }, hasWearable: false },
    { ...common, id: 'W-D2B2', displayName: 'Shaji V.', language: 'ml', ageYears: 46, massKg: 70, heightCm: 168, daysOnSite: 640, daysAwayRecent: 0, experiencedInHeat: true, clothing: 'fr_coveralls', riskFlags: [], restingHrBpm: 64, consent: all(true), hasWearable: true },
    { ...common, id: 'W-D2C3', displayName: 'Mahmoud A.', language: 'ar', ageYears: 47, massKg: 84, heightCm: 172, daysOnSite: 300, daysAwayRecent: 0, experiencedInHeat: true, riskFlags: ['hr_suppressing_medication'], restingHrBpm: 58, consent: all(true), hasWearable: true },
    { ...common, id: 'W-D2D4', displayName: 'Jahangir A.', language: 'bn', ageYears: 35, massKg: 63, heightCm: 164, daysOnSite: 410, daysAwayRecent: 0, experiencedInHeat: true, riskFlags: ['fasting'], restingHrBpm: 70, consent: { ...all(true), wearable: false }, hasWearable: false },
    { ...common, id: 'W-D2E5', displayName: 'Jomar S.', language: 'tl', ageYears: 31, massKg: 66, heightCm: 167, daysOnSite: 180, daysAwayRecent: 0, experiencedInHeat: true, riskFlags: [], restingHrBpm: 72, consent: all(false), hasWearable: true },
    { ...common, id: 'W-D2F6', displayName: 'Ramesh Y.', language: 'hi', ageYears: 38, massKg: 72, heightCm: 170, daysOnSite: 520, daysAwayRecent: 0, experiencedInHeat: true, riskFlags: [], restingHrBpm: 67, consent: all(true), hasWearable: true },
    { ...common, id: 'W-D307', displayName: 'Naveed A.', language: 'ur', ageYears: 42, massKg: 78, heightCm: 174, daysOnSite: 365, daysAwayRecent: 0, experiencedInHeat: true, riskFlags: [], restingHrBpm: 69, consent: { ...all(true), wearable: false }, hasWearable: false },
  ]
  const taskId = (key: string) => `${crewId}:${key}`
  const personas: DemoPersona[] = [
    {
      id: 'new_arrival',
      workerId: 'W-D2A1',
      taskId: taskId('maintenance'),
      title: 'Day 2 on site',
      story: 'Arrived two days ago for his first Gulf summer. Conditions his crewmates handle are beyond his limit until he acclimatises; Zill pairs him with a buddy and moves him to lighter, shaded work.',
      demonstrates: ['unacclimatised → NIOSH RAL', 'conservative mode (first 14 days)', 'ADOSH: no unacclimatised work in Medium/High TWL zones', 'acclimatization_plan', 'buddy_check'],
    },
    {
      id: 'veteran_welder',
      workerId: 'W-D2B2',
      taskId: taskId('welding'),
      title: 'Veteran welder in FR coveralls and hood',
      story: 'Twenty years of Gulf summers, fully acclimatised — but flame-resistant coveralls and a welding hood trap heat. Zill counts the clothing and the hood, so his work/rest cycle is stricter than his unhooded crewmates’.',
      demonstrates: ['ACGIH clothing adjustment', 'hood +1 °C', 'shade_breaks with workMinPerHour', 'rotate_task'],
    },
    {
      id: 'beta_blocker',
      workerId: 'W-D2C3',
      taskId: taskId('grinding'),
      title: 'On beta-blockers, wearing a band',
      story: 'Takes a beta-blocker for blood pressure and chose to declare it. The medicine blunts heart rate, so Zill switches off every heart-rate rule for him instead of trusting a reassuring pulse, and protects him on environment and workload alone, with stricter limits.',
      demonstrates: ['hr_suppressing_medication disables ECTemp/PSI/HR rules', 'physiology never lowers a level', 'conservative mode'],
    },
    {
      id: 'fasting',
      workerId: 'W-D2D4',
      taskId: taskId('maintenance'),
      title: 'Fasting worker',
      story: 'Observing a voluntary fast. Zill applies the stricter conservative-mode limits, schedules his heavier work early, and does not send drink reminders during fasting hours.',
      demonstrates: ['fasting flag → conservative mode', 'no drink reminders during fasting hours', 'planner moves flexible work early'],
    },
    {
      id: 'declines_consent',
      workerId: 'W-D2E5',
      taskId: taskId('inspection_rounds'),
      title: 'Declines all optional data',
      story: 'Has a company band but declined every optional consent. He gets the same environment- and work-based alerts, breaks and midday-break protection as everyone else; no heart rate, flags or check-ins are processed, and nothing is held against him.',
      demonstrates: ['core alerting needs no personal data', 'consent is opt-in and revocable', 'physiology channel unavailable ≠ reassurance'],
    },
  ]
  const crew: Crew = {
    id: crewId,
    siteId: 'musaffah',
    name: 'Demo crew — pipe-rack maintenance and hot work',
    supervisorName: 'Rajeev Menon',
    workerIds: workers.map((w) => w.id),
    tasks,
  }
  return { crew, workers, personas }
}

// ═══════════════════════════════ Workforce generator ═══════════════════════════════

/** Options for {@link generateWorkforce}. */
export interface WorkforceOptions {
  /** Default 'zill-workforce-v1'. */
  seed?: string | number
  /** Crews per site (default 3; templates repeat with a letter suffix beyond 3). */
  crewsPerSite?: number
  /** Sites to staff (default all five). */
  sites?: readonly Site[]
  /** Add the fixed Musaffah demo crew (default true). */
  includeDemoCrew?: boolean
  /** `consent.updatedAt` for every generated worker (default {@link DEFAULT_ROSTER_EPOCH}). */
  rosterEpoch?: number
}

/** A generated workforce. */
export interface Workforce {
  seed: string | number
  crews: Crew[]
  workers: WorkerProfile[]
  /** Demo personas (empty when the demo crew is excluded). */
  personas: DemoPersona[]
}

/** Default workforce seed. */
export const DEFAULT_WORKFORCE_SEED = 'zill-workforce-v1'

/**
 * Generate a deterministic synthetic workforce: per site, `crewsPerSite` crews of 6–10 workers with tasks typical of
 * the site kind ({@link TASK_LIBRARY}), workers drawn per {@link ORIGIN_SHARES_PCT} and {@link COHORT_PARAMS}, plus the
 * fixed demo crew ({@link buildDemoCrew}). The same seed always yields the same workforce (sim/rng.ts forks per site,
 * crew and worker).
 */
export function generateWorkforce(opts: WorkforceOptions = {}): Workforce {
  const seed = opts.seed ?? DEFAULT_WORKFORCE_SEED
  const crewsPerSite = Math.max(0, Math.floor(opts.crewsPerSite ?? 3))
  const sites = opts.sites ?? SITES
  const rosterEpoch = opts.rosterEpoch ?? DEFAULT_ROSTER_EPOCH
  const root = createRng(seed)
  const ctx: GenContext = { seed, usedIds: new Set(), usedBadges: new Map(), rosterEpoch }
  const crews: Crew[] = []
  const workers: WorkerProfile[] = []
  let personas: DemoPersona[] = []

  if (opts.includeDemoCrew ?? true) {
    const demo = buildDemoCrew(rosterEpoch)
    crews.push(demo.crew)
    workers.push(...demo.workers)
    personas = demo.personas
    for (const w of demo.workers) {
      ctx.usedIds.add(w.id)
      const set = ctx.usedBadges.get(w.siteId) ?? new Set<string>()
      set.add(w.displayName)
      ctx.usedBadges.set(w.siteId, set)
    }
  }

  for (const site of sites) {
    const siteRng = root.fork(site.id)
    const templates = CREW_TEMPLATES[site.kind]
    for (let c = 0; c < crewsPerSite; c++) {
      const crewRng = siteRng.fork(`crew-${c}`)
      const tpl = templates[c % templates.length]
      const round = Math.floor(c / templates.length)
      const crewId = `${site.id}-c${c + 1}`
      const size = crewRng.int(6, 10)
      const crewWorkers: WorkerProfile[] = []
      for (let i = 0; i < size; i++) {
        crewWorkers.push(generateWorker(crewRng.fork(`worker-${i}`), site, crewId, `${site.id}|${c}|${i}`, ctx))
      }
      const supervisor = drawOriginGroup(crewRng.fork('supervisor'))
      const supName = drawName(crewRng.fork('supervisor-name'), supervisor.pool, 'male')
      crews.push({
        id: crewId,
        siteId: site.id,
        name: round === 0 ? tpl.name : `${tpl.name} ${String.fromCharCode(65 + round)}`,
        supervisorName: `${supName.first} ${supName.family}`,
        workerIds: crewWorkers.map((w) => w.id),
        tasks: buildTasks(crewId, site.kind, tpl.tasks),
      })
      workers.push(...crewWorkers)
    }
  }
  return { seed, crews, workers, personas }
}

/** Work classes in ISO 8996 order (re-exported convenience for UIs and tests). */
export const WORK_CLASSES: readonly WorkClass[] = ['rest', 'light', 'moderate', 'heavy', 'very_heavy']
