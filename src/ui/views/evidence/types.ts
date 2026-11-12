/**
 * Narrow, read-only views of the validation files written by `npm run validate` (public/data/validation/*.json). Only
 * the fields the Evidence view reads are typed; everything is treated as possibly missing at render time, because the
 * files are regenerated independently of this screen. The generating scripts (scripts/validate/*.ts) are authoritative.
 */

export type Pair = readonly [number, number]

/** A point estimate with an optional 95 % interval (bootstrap percentile or binomial), as the validation files store it. */
export interface Est {
  value: number | null
  ci95?: Pair | null
  n?: number
  /** Event count behind a per-1,000 rate. */
  count?: number
  /** One-sided 95 % rule-of-three bound (3/n × 1,000) when the count is zero. */
  upper95?: number | null
}

export interface Stamp {
  package: string
  codeSha256: string
  codeFiles: number
  inputsSha256: string
  stamp: string
}

export interface ProvenanceInput {
  path: string
  bytes: number
  sha256: string
  manifestMatch: boolean | null
}

export interface FileProvenance {
  inputs: readonly ProvenanceInput[]
  manifestMismatches?: readonly string[]
  attribution?: Readonly<Record<string, string>>
  oracleEnvironments?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface ValidationFileBase {
  generatedBy: string
  command?: string
  stamp: Stamp
  provenance: FileProvenance
}

// ─── reference.json ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReferenceCheck {
  id: string
  model: string
  title: string
  engine: string
  reference: string
  kind: 'reference_implementation' | 'published_values'
  fixture: string
  nCases: number
  quantity: string
  unit: string
  tolerance: number
  toleranceKind: 'abs' | 'rel' | 'rms'
  toleranceSource: string
  nValues: number
  maxAbsDiff: number
  meanAbsDiff: number
  /** RMS of the differences: the compared metric when `toleranceKind` is 'rms'. */
  rmsDiff?: number
  mismatches: number
  pass: boolean
  note?: string
}

export interface ReferenceModelSummary {
  model: string
  label: string
  checks: number
  passed: number
  values: number
  pass: boolean
}

export interface ReferenceFile extends ValidationFileBase {
  schema: string
  title: string
  config?: { note?: string }
  summary: { checks: number; passed: number; allPass: boolean; models: readonly ReferenceModelSummary[] }
  checks: readonly ReferenceCheck[]
}

// ─── hours-in-zone.json ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WbgtBand {
  id: string
  label: string
  fromC: number | null
  toC: number | null
  meaning: string
  basis: string
}

export interface AdoshZone {
  id: 'high' | 'medium' | 'low'
  label: string
  minWm2: number | null
  maxWm2: number | null
  basis: string
}

/** Hours per band: WBGT bands in config order (5), ADOSH zones in config order (high, medium, low). */
export interface BandHours {
  wbgtBands: readonly number[]
  adoshSun: readonly number[]
  adoshShade: readonly number[]
}

export interface HoursSite {
  site: string
  run: string
  radiantBoostC: number
  seasons: number
  wbgt: { p50: number; p95: number; max: number }
  twlSun: { p05: number; p50: number; min: number }
  meanSeason: BandHours & {
    hours: number
    daysWithAdoshHigh: number
    daysWithWbgtGeRal115: number
    longestRunGeRal115H: number
  }
}

export interface HoursByMonth extends BandHours {
  site: string
  month: number
}

export interface HoursByHour extends BandHours {
  site: string
  hour: number
  meanWbgtC: number
  meanTwlSun: number
}

export interface MiddayBreakRow {
  site: string
  adoshHighHours: number
  adoshHighOutsideBreak: number
  adoshHighShareOutside: number
  wbgtGeRal115Hours: number
  wbgtGeRal115OutsideBreak: number
  wbgtGeRal115ShareOutside: number
  wbgtGeRal115OutsideSeasonDatesShare: number
}

export type WorkIntensity = 'moderate' | 'heavy'
export type ExposureLimit = 'REL' | 'RAL'
export type RestPlace = 'cabin' | 'shade'

export interface WorkRestRow {
  work: WorkIntensity
  limit: ExposureLimit
  rest: RestPlace
  meanMinPerHour: number
  zeroShare: number
  hour?: number
  site?: string
  month?: number
}

export interface TwlPlausibilityRow {
  site: string
  period: 'jun_sep' | 'june'
  byHour: readonly { hour: number; twlSunMean: number; twlShadeMean: number }[]
}

export interface HoursFile extends ValidationFileBase {
  schema: string
  title: string
  config: {
    years: readonly number[]
    season: string
    timezone: string
    runs: readonly { id: string; model: string; boost: string; role: string; label: string }[]
    wbgtBands: readonly WbgtBand[]
    wbgtThresholdsC: { rel300: number; ral115: number; qatarStop: number; rel115: number }
    adoshZones: readonly AdoshZone[]
    middayBreak: { from: string; to: string; startHhmm: string; endHhmm: string; basis: string }
    engine: string
    cooledRest: { wbgtC: number; source: string }
    clothing: string
    notes: readonly string[]
  }
  sites: readonly HoursSite[]
  byMonth: readonly HoursByMonth[]
  byHour: readonly HoursByHour[]
  middayBreak: readonly MiddayBreakRow[]
  twlPlausibility: {
    published: {
      batesSchneider2008: { citation: string; month: string; byHour: Readonly<Record<string, number>>; lowest: number }
      miller2011: { citation: string; meanBandWm2: Pair; note: string }
    }
    rows: readonly TwlPlausibilityRow[]
    daysDaytimeMinBelow: readonly { site: string; below140Share: number; below115Share: number }[]
    verdict: readonly string[]
  }
  workRest: {
    method: string
    cooledRest: { wbgtC: number; source: string }
    restMetabolicW: number
    middayBreakHours: readonly number[]
    byHour: readonly WorkRestRow[]
    dayShift: readonly WorkRestRow[]
  }
  sensitivity: readonly {
    site: string
    ral115HoursIfs: number
    ral115HoursEra5: number
    era5MinusIfsPct: number
    ral115HoursWithBoost: number
    boostMinusNonePct: number
  }[]
  observationalAnchor?: {
    period: { start: string; end: string; timezone: string }
    rows: readonly { icao: string; nMatched: number; source: string; wbgtBands: readonly number[]; geRal115: number; adoshHighSun: number }[]
    note: string
  }
  headline: {
    hoursPerSeason: number
    meanSiteHoursGeRal115PerSeason: number
    meanSiteHoursGeRel115PerSeason: number
    meanSiteHoursAdoshHighSunPerSeason: number
    meanSiteHoursAdoshHighShadePerSeason: number
    shareAdoshHighOutsideMiddayBreak: number
    shareWbgtGeRal115OutsideMiddayBreak: number
    cooledRestWbgtC: number
  } & Readonly<Record<string, number>>
}

// ─── forecast-skill.json ────────────────────────────────────────────────────────────────────────────────────────────

export interface ErrorStats {
  n: number
  bias: number
  mae: number
  rmse: number
  r: number
  maxAbs: number
  rmseCi95?: Pair
  dailyMaxBias?: number
  dailyMaxRmse?: number
  dailyMinBias?: number
  dailyMinRmse?: number
  skillVsPersistence?: number
}

export interface EventScores {
  hits: number
  misses: number
  falseAlarms: number
  correctNegatives: number
  n: number
  baseRate: number
  pod: number
  far: number
  csi: number
  freqBias: number
  peirce: number
  heidke: number
}

export interface EventResult {
  id: string
  scores: EventScores
}

export interface ForecastLead {
  lead: number
  wbgt: ErrorStats
  twl: ErrorStats
  events: readonly EventResult[]
  dangerousMisses?: { adosh: number; wbgtBands: number }
  rmseByLocalHour?: { wbgt: readonly number[]; twl: readonly number[] }
}

export interface ForecastPersistence {
  lagH: number
  wbgt: ErrorStats
  twl: ErrorStats
  events: readonly EventResult[]
  dangerousMisses?: { adosh: number; wbgtBands: number }
}

export interface ForecastModel {
  model: string
  primary: boolean
  leads: readonly ForecastLead[]
  persistence: readonly ForecastPersistence[]
}

export interface AirportStats {
  icao: string
  model: string
  lead?: number
  n: number
  t?: ErrorStats
  td?: ErrorStats
  wbgt?: ErrorStats
  twl?: ErrorStats
  wbgtAll?: ErrorStats
  twlAll?: ErrorStats
}

export interface ForecastFile extends ValidationFileBase {
  schema: string
  title: string
  config: {
    years: readonly number[]
    sites: readonly string[]
    models: readonly string[]
    primaryModel: string
    leadDefinition: string
    reference: string
    events: readonly { id: string; label: string; basis: string }[]
    bootstrap: { replicates: number; block: string; seedPrefix: string }
    engine: string
    notes: readonly string[]
  }
  sameModel: readonly ForecastModel[]
  airports: {
    period: { start: string; end: string; timezone: string }
    method: string
    analysis: readonly AirportStats[]
    forecast: readonly AirportStats[]
  }
  headline: Readonly<Record<string, number | string>>
}

// ─── cohort.json (v0.3) and the history snapshots cohort-v0.1.json / cohort-v0.2.json ───────────────────────────────

export type ArmId =
  | 'ban_only'
  | 'site_index'
  | 'zill_env'
  | 'zill_full'
  | 'zill_monitored'
  | 'shadow_zill_env'
  | 'shadow_zill_full'
  | 'shadow_zill_monitored'

export interface LeadTime {
  n: number
  medianMin: number | null
  p25Min: number | null
  p75Min: number | null
  minMin?: number | null
  maxMin?: number | null
  medianCi95?: Pair | null
  bins: readonly { fromMin: number; toMin: number | null; n: number }[]
}

export interface DetectionRow {
  target: string
  alarmSet: string
  minLevel: 'high' | 'stop'
  horizonMin: number
  workerShifts: number
  positives: number
  warnedShifts: number
  sensitivityBeforeOnset: Est
  sensitivityInShift: Est
  specificity: Est
  ppvShift: Est
  alarms: number
  ppvAlarm: Est
  falseAlarmsPerShift: Est
  leadTime: LeadTime
}

export interface CalibrationRow {
  label: string
  fromMin: number
  toMin: number | null
  horizonMin: number
  samples: number
  meanPredictedMin: number | null
  nullPredictions: number
  observedShare: number | null
}

type RoleBurden = Readonly<Record<string, { sent: number; requiringAck: number }>>

export interface ChallengeMeasures {
  workerShifts: number
  eventLeadTime?: LeadTime
  alarmsPerShift?: Est
  individualAlarmsPerShift?: { high: Est; stop: Est }
  exposureAdvisoriesPerWorkerShift?: Est
  exposureAdvisoriesPerCrewShift?: number
  suppressedAdvisoriesPerWorkerShift?: Est
  burdenPerWorkerShift?: { individual?: RoleBurden; exposure?: RoleBurden; total?: RoleBurden }
  adherence?: Est
  checkinResponse?: Est
  ack?: {
    acknowledgedShare?: number | null
    medianDelayMin?: number | null
    escalatedAlerts?: number
    designedSuppression?: { alerts: number; stillSuppressed: number; lifted: number }
  }
  symptomReportsPer1000?: Est
  escalationsPer1000?: Est
  midday?: { violationMin: number; shiftsWithViolation: number; compliantShare: Est }
  zone?: { workerHours: number; compliantShare: Est; excessMin: number; unacclimatizedHours: number }
}

export interface PairedDiff {
  pairedWorkerShifts: number
  excessivePer1000: Est
  severePer1000?: Est
  criticalPer1000?: Est
  dehydrationPer1000?: Est
  symptomaticEpisodesPer1000?: Est
  workMinPerShift: Est
  workRelative: Est
  restMinPerShift?: Est
  waterMlPerShift?: Est
}

export interface CohortArm {
  arm: ArmId
  policy: string
  shadow: boolean
  rates: {
    workerShifts: number
    clusters?: number
    per1000: {
      excessive: Est
      severe: Est
      critical: Est
      dehydration: Est
      symptomaticEpisodes?: Est
      evacuations?: Est
    }
    perShift: { workMin: Est; restMin: Est; waterMl: Est; hotWorkMin?: Est }
  }
  challenge?: ChallengeMeasures
  vsBanOnly?: PairedDiff | null
  /** Individual alarms at ≥ HIGH (the headline alarm set). */
  detection?: readonly DetectionRow[] | null
  /** Individual alarms at ≥ STOP. */
  detectionStop?: readonly DetectionRow[] | null
  /** Every alarm at ≥ HIGH, exposure advisories included (comparison with v0.1's definition). */
  detectionAllAlarms?: readonly DetectionRow[] | null
  calibration?: readonly CalibrationRow[] | null
}

export interface VariantDetection {
  positives: number
  sensitivityBeforeOnset: Est
  ppvShift: Est
  falseAlarmsPerShift: Est
  medianLeadMin: number | null
}

export interface VariantHeadline {
  workerShifts: number
  excessivePer1000: Est
  severePer1000: Est
  criticalPer1000?: Est
  dehydrationPer1000: Est
  symptomaticEpisodesPer1000?: Est
  evacuationsPer1000?: Est
  workMinPerShift: Est
  restMinPerShift: Est
  waterMlPerShift?: Est
  adherence?: Est
  individualAlarmsPerShift?: Est
  individualStopAlarmsPerShift?: Est
  exposureAdvisoriesPerShift?: Est
  suppressedAdvisoriesPerShift?: Est
  detection?: Readonly<Record<string, VariantDetection>> | null
}

export interface VariantArm {
  arm: ArmId
  headline: VariantHeadline
  vsBanOnly?: PairedDiff
  vsBase?: PairedDiff
  baseVsBanOnly?: PairedDiff
}

export interface CohortVariant {
  id: string
  group: 'sensitivity' | 'robustness'
  factor: string
  label: string
  value: number | string
  supported: boolean
  note: string | null
  siteDays: number
  arms: readonly VariantArm[]
}

export interface FairnessCell {
  dimension: string
  value: string
  workerShifts: number
  excessivePer1000: number | null
  severePer1000: number | null
  dehydrationPer1000: number | null
  symptomaticEpisodesPer1000: number | null
  workMinPerShift: number | null
  restMinPerShift: number | null
  adherence: number | null
  alarmsPerShift: number | null
  individualAlarmsPerShift: number | null
  positivesExcessive: number | null
  sensitivityExcessive: number | null
}

export interface CohortFile extends ValidationFileBase {
  kind: string
  evidenceClass?: string
  disclaimer: string
  versions: { backtest: string; metrics: string; worldsim: string; truth?: string }
  spec: {
    seed: string
    workforceSeed: string
    year: number
    months: readonly number[]
    sites: readonly string[]
    shift: { start: string; end: string }
    replicates: number
    mode: string
    daysPerStratum: number
    crewsPerSite: number
    sweepStrata?: readonly string[]
  }
  metricParams?: { confirmHorizonMin?: number; limitCoreC?: number; limitDehydrationPct?: number; bootstrapReplicates?: number }
  strata?: readonly { siteId: string; daysRanked: number; hotMinC: number; mildMaxC: number; maxC: number; minC: number }[]
  days: readonly { siteId: string; date: string; stratum: string }[]
  arms: readonly ArmId[]
  runs: { columns: readonly string[]; rows: readonly unknown[] }
  main: {
    arms: readonly CohortArm[]
    byStratum: readonly { stratum: string; siteDays: number; arms: readonly VariantArm[] }[]
    fairness: readonly { arm: ArmId; cells: readonly FairnessCell[] }[]
  }
  sensitivity: readonly CohortVariant[]
  robustness: readonly CohortVariant[]
}
