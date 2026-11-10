# Wave 2b exports (world simulation, back-test + metrics, app state + sync)

Generated from the agents' reports. Signatures are as reported; the source is authoritative.

## worldsim

```ts
// ── src/sim/worldsim.ts ──
export const WORLDSIM_VERSION = '1.0.0'
export const DEFAULT_SIM_BEHAVIOUR: Readonly<SimBehaviour>  // compliance 0.7, selfReportScale 1, respondScale 1, ackDelayMin {worker 1, buddy 2, supervisor 3, first_aider 2, occ_health 10}, firstAiderArrivalMin 4 — all [ASSUMPTION]
export const DEFAULT_SIM_DISRUPTIONS: Readonly<SimDisruptions>  // { wearableDropout: 0, ppgNoiseMultiplier: 1 }
export const DEFAULT_SHIFT: Readonly<{ start: string; end: string }>  // '05:00'–'17:00' [ENG]
export const WORLD_PARAMS  // frozen: meterNoiseSdC 0.3, ackDelaySigmaLn 0.6, resumeCheckEveryMin 5, resumeMinMinutesToLimit 25 (=15 stop threshold + 10 dwell), promptMinGapMin 15, promptExpireMin 15, emsHandoverMin 20, firstAidCooling 'immersion', statutoryMaxWorkMin 300, statutoryBreakMin 60, breakResetMin 15, forecastFetchLeadMin 60, reminderEveryMin 20, reminderMl 250, reminderAfterHotWorkMin 30, breakDrinkWindowMin 15, fajrCosZenith -0.3123, sunsetCosZenith -0.0145, viewNotifications 50, viewEvents 200, basis
export type SimConfigInput = Partial<Omit<SimConfig, 'behaviour' | 'disruptions' | 'engine'>> & Pick<SimConfig, 'siteId' | 'date'> & { behaviour?: Partial<Omit<SimBehaviour, 'ackDelayMin'>> & { ackDelayMin?: Partial<SimBehaviour['ackDelayMin']> }; disruptions?: Partial<SimDisruptions>; engine?: Partial<SimConfig['engine']> }
export function makeSimConfig(input: SimConfigInput): SimConfig  // defaults: seed 'zill-sim', policy zill_full, shadow false, DEFAULT_SHIFT, 'abu-dhabi', projectionEveryMin 5, trace 'none'
export function shiftMinutes(config: Pick<SimConfig, 'date' | 'shift'>): number
export function idleMinutes(outcome: Pick<ShiftOutcome, 'workMin' | 'restMin'>, config: Pick<SimConfig, 'date' | 'shift'>): number  // shift − work − rest
export interface WorkerSim { ... }  // internal per-worker state, exposed via World for inspection only
export interface World { readonly kind: 'zill-world'; readonly config: SimConfig; readonly site: Site; readonly pack: RulePack; readonly weather: SimWeather; readonly t0: number; readonly tEnd: number; readonly nMinutes: number; readonly dayStart: number; t: number; minuteIndex: number; finished: boolean; ...internal }  // opaque; not JSON-serialisable (RNG closures)
export interface CreateWorldOptions { script?: readonly ScriptedEvent[] }
export function createWorld(config: SimConfig, data: SimData, opts?: CreateWorldOptions): World  // roster = config.crews/workers ?? data.crews/workers; throws RangeError on bad date/shift, site mismatch, unknown/duplicate workers
export function stepWorld(world: World, minutes: number, injections?: readonly WorldInjection[]): World  // MUTATES in place, returns the same reference; injections applied at world.t first; clamped to shift end; no-op once finished; chunking-invariant
export function worldMinutesRemaining(world: World): number
export function worldView(world: World): WorldView  // fresh snapshot object each call
export function finishWorld(world: World): SiteDayResult  // steps to the end if needed; cached (same object on later calls)
export function runSiteDay(config: SimConfig, data: SimData, opts?: CreateWorldOptions): SiteDayResult
export const worldSim = { createWorld, stepWorld, worldView, finishWorld, runSiteDay } satisfies WorldSimApi<World>
// ── src/sim/simdata.ts ──
export const SIM_DAY_WINDOW: Readonly<{ beforeH: number /*2*/; afterH: number /*26*/; basis: string }>
export const PERFECT_FORECAST_NOTE: string
export function daySamples(samples: readonly EnvSample[], date: string): EnvSample[]
export function simWeatherFromDemoDay(day: DemoDay): SimWeather  // analysis = IFS analysis, forecast = ecmwf_ifs025 d1 for the same hours
export function simWeatherFromSeries(siteId: SiteId, date: string, analysis: WeatherSeries, forecast: WeatherSeries | null, files?: { analysis?: string; forecast?: string }): SimWeather
export function weatherSamplers(weather: SimWeather, siteId: SiteId): { analysis: (t: number) => InstantEnvSample | null; forecast: (t: number) => InstantEnvSample | null }
export function minuteWeather(weather: SimWeather, siteId: SiteId, startT: number, endT: number): { analysis: InstantEnvSample[]; forecast: InstantEnvSample[] }
export interface RosterOptions { crews?: Crew[]; workers?: WorkerProfile[]; workforceSeed?: string | number; crewsPerSite?: number; includeDemoCrew?: boolean }
export function siteRoster(siteId: SiteId, opts?: RosterOptions): { crews: Crew[]; workers: WorkerProfile[] }
export interface SimDataLoader { weather(siteId: SiteId, date: string): Promise<SimWeather>; load(siteId: SiteId, date: string, opts?: RosterOptions): Promise<SimData>; demoDays(): Promise<DemoDay[]> }
export function createSimDataLoader(loader: WeatherLoader): SimDataLoader  // demo day if cached, else archive (Jun–Sep 2020–2025, Nov 2025 Musaffah) + previous-runs lead 1 (Jun–Sep 2024–2025), else perfect-forecast fallback with provenance
export function createBrowserSimDataLoader(opts?: { baseUrl?: string; fetch?: FetchLike }): SimDataLoader  // fetch './data/weather/...'
export function createNodeSimDataLoader(opts?: { dataDir?: string | URL }): SimDataLoader  // node:fs via dynamic import; default public/data resolved from import.meta.url
// ── src/sim/scenarios.ts ──
export type ScenarioId = 'peak-day' | 'humid-day' | 'mild-day' | 'saadiyat-peak' | 'shade-only'
export interface Scenario { id: ScenarioId; title: string; description: string; siteId: SiteId; date: string; dayChoice: string; config: SimConfigInput; events: ScriptedEvent[]; demonstrates: string[] }
export const SCENARIO_SHIFT: Readonly<{ start: string; end: string }>  // '05:00'–'17:00'
export function scenarioRoster(siteId: SiteId, generatedCrews: number, includeDemoCrew: boolean): { crews: Crew[]; workers: WorkerProfile[] }
export const PEAK_DAY_CONFUSION_WORKER = 'W-D2F6'
export const SCENARIOS: readonly Scenario[]  // peak-day musaffah 2025-08-01 (demo crew + musaffah-c1; sensor_fail 11:00–11:30, buddy 'confusion' W-D2F6 14:10, network 15:30–15:50, also in config.disruptions); humid-day musaffah 2025-09-09; mild-day musaffah 2025-11-26; saadiyat-peak saadiyat 2025-07-21 (2 generated crews); shade-only alain 2025-07-24 (restArea 'shade', 2 generated crews); all zill_full, trace 'full'
export const SCENARIO_IDS: readonly ScenarioId[]
export function getScenario(id: ScenarioId): Scenario  // throws RangeError
export function scenarioConfig(id: ScenarioId, overrides?: Partial<SimConfigInput>): SimConfig  // site/date fixed; behaviour & disruptions merged
export async function loadScenarioData(id: ScenarioId, loader: SimDataLoader): Promise<SimData>
export function createScenarioWorld(id: ScenarioId, data: SimData, overrides?: Partial<SimConfigInput>): World
export function runScenario(id: ScenarioId, data: SimData, overrides?: Partial<SimConfigInput>): SiteDayResult
export function hasDemoCrew(s: Scenario): boolean
```

## backtest-metrics

```ts
// ── src/sim/metrics.ts ── (pure; the only randomness is the seeded bootstrap from sim/rng.ts)
export const METRICS_VERSION = '1.0.0'
export const TRUTH_EVENT_KINDS: readonly TruthEventKind[]
export type DetectionTarget = Exclude<TruthEventKind, 'symptom_onset'> | 'heat_symptoms' | 'symptomatic'
export const DETECTION_TARGETS: readonly DetectionTarget[]  // excessive, severe, critical, dehydration_3pct, heat_symptoms, symptomatic
export const NON_HEAT_SYMPTOM_CLUSTERS: readonly string[]  // ['thirst']
export const FAIRNESS_DIMENSIONS: readonly (keyof WorkerSubgroup)[]
export const METRIC_PARAMS  // frozen: alarmMinLevel 'high', confirmHorizonMin 120, leadTimeEdgesMin [0,15,30,60,120], calibrationEdgesMin [15,45,90], calibrationSampleEveryMin 5, limitCoreC 38.0, limitDehydrationPct 3, zoneToleranceMin 1, bootstrapReplicates 1000, ruleOfThree 3
export interface ZoneCheck { workerHours: number; compliantHours: number; excessMin: number; unacclimatizedHours: number }
export interface WorkerShiftRecord { cluster; siteId; date; workerId; policy; shadow; engineRan; subgroup; shiftMin; workMin; restMin; hotWorkMin; waterMl; maxCoreC; minutesCoreAbove385; maxDehydrationPct; truth: Record<TruthEventKind,{count;onsetT}>; heatSymptomEpisodes; heatSymptomOnsetT; symptomaticT; symptomReports; alarmTimes: number[]; minutesHighPlus; minutesStopPlus; engineEmergencyT; instructions; followed; checkinsPrompted; checkinsAnswered; selfReported; escalations; evacuatedT; lostMin; middayViolationMin; zone: ZoneCheck }
export interface RecordOptions { crews?: readonly Crew[]; adoshUnacclimatized?: ReadonlySet<string>; minLevel?: RiskLevel }
export function engineRuns(config: Pick<SimConfig, 'policy' | 'shadow'>): boolean
export function shiftWindow(config: Pick<SimConfig, 'date' | 'shift'>): { startT: number; endT: number }
export function alarmTimesByWorker(events: readonly SimEvent[], minLevel?: RiskLevel): Map<string, number[]>
export function workerShiftRecords(result: SiteDayResult, opts?: RecordOptions): WorkerShiftRecord[]
export interface RunAlertSummary { alerts; alarms; requiringAck; acknowledged; ackDelaysMin: number[]; escalatedAlerts; notifications; suppressed; crewBundledWorkerAlerts }
export function runAlertSummary(result: SiteDayResult, minLevel?: RiskLevel): RunAlertSummary
export interface CalibrationBin { latched: boolean; fromMin; toMin: number | null; horizonMin; samples; reached; sumPredictedMin; nullPredictions }
export interface CalibrationCounts { bins: CalibrationBin[] }
export function emptyCalibration(edges?: readonly number[]): CalibrationCounts
export function calibrationCounts(minutes: readonly WorkerMinute[], endT: number, edges?: readonly number[]): CalibrationCounts
export function mergeCalibration(a: CalibrationCounts, b: CalibrationCounts): CalibrationCounts
export interface CalibrationRow { label; fromMin; toMin; horizonMin; samples; meanPredictedMin: number | null; nullPredictions; observedShare: number | null }
export function calibrationTable(c: CalibrationCounts): CalibrationRow[]
export interface Estimate { value: number | null; ci95: [number, number] | null; n: number }
export interface RateEstimate extends Estimate { count: number; upper95: number | null }
export interface AggregateOptions { seed: string; replicates?: number }
export function quantileSorted(sorted: ArrayLike<number>, p: number): number
export function bootstrapRatio(num: readonly number[], den: readonly number[], seed: string, replicates?: number, scale?: number): [number, number] | null
export function bootstrapRatioDiff(numA: readonly number[], denA: readonly number[], numB: readonly number[], denB: readonly number[], seed: string, replicates?: number, scale?: number): [number, number] | null
export function bootstrapQuantile(valuesByCluster: readonly (readonly number[])[], p: number, seed: string, replicates?: number): [number, number] | null
export function groupByCluster<T extends { cluster: string }>(records: readonly T[]): T[][]
export interface PolicyRates { workerShifts; clusters; per1000: { excessive; severe; critical; dehydration; symptomaticEpisodes; evacuations; engineEmergency }: RateEstimate; eventsPer1000: Record<TruthEventKind, number>; perShift: { workMin; restMin; hotWorkMin; waterMl; minutesCoreAbove385 }: Estimate }
export function policyRates(records: readonly WorkerShiftRecord[], o: AggregateOptions): PolicyRates
export interface LeadTimeSummary { n; medianMin; p25Min; p75Min; minMin; maxMin; medianCi95; bins }
export interface DetectionSummary { target; minLevel; horizonMin; workerShifts; positives; warnedShifts; sensitivityBeforeOnset; sensitivityInShift; specificity; ppvShift; alarms; ppvAlarm; falseAlarmsPerShift; leadTime }
export function targetOnset(r: WorkerShiftRecord, target: DetectionTarget): number | null
export function leadTimeSummary(valuesByCluster: readonly (readonly number[])[], seed: string, replicates?: number): LeadTimeSummary
export function detectionSummary(records: readonly WorkerShiftRecord[], target: DetectionTarget, o: AggregateOptions, minLevel?: RiskLevel, horizonMin?: number): DetectionSummary
export interface AckSummary { alerts; alarms; requiringAck; acknowledged; acknowledgedShare; medianDelayMin; p90DelayMin; escalatedAlerts; notifications; suppressed; crewBundledWorkerAlerts }
export function ackSummary(runs: readonly RunAlertSummary[]): AckSummary
export interface ChallengeMeasures { workerShifts; eventLeadTime; alarmsPerShift; adherence; checkinResponse; ack; symptomReportsPer1000; symptomaticShiftsPer1000; escalationsPer1000; midday: {violationMin; shiftsWithViolation; compliantShare}; zone: {workerHours; compliantShare; excessMin; unacclimatizedHours}; restMinPerShift; heatIllnessLostMinPer1000WorkerHours }
export function challengeMeasures(records: readonly WorkerShiftRecord[], runs: readonly RunAlertSummary[], o: AggregateOptions): ChallengeMeasures
export interface PairedComparison { pairedWorkerShifts; clusters; excessivePer1000; severePer1000; criticalPer1000; dehydrationPer1000; symptomaticEpisodesPer1000; workMinPerShift; workRelative; restMinPerShift; waterMlPerShift }
export function pairedComparison(a: readonly WorkerShiftRecord[], b: readonly WorkerShiftRecord[], o: AggregateOptions): PairedComparison
export interface FairnessCell { dimension; value; workerShifts; excessivePer1000; severePer1000; dehydrationPer1000; symptomaticEpisodesPer1000; workMinPerShift; restMinPerShift; adherence; alarmsPerShift; positivesExcessive; sensitivityExcessive }
export function fairnessBreakdown(records: readonly WorkerShiftRecord[], dims?: readonly (keyof WorkerSubgroup)[]): FairnessCell[]
export function recordsFromResults(results: readonly SiteDayResult[], opts?: RecordOptions | ((r: SiteDayResult) => RecordOptions)): WorkerShiftRecord[]
export function allFinite(x: unknown): boolean
// ── src/sim/backtest.ts ──
export const BACKTEST_VERSION = '1.0.0'
export type ArmId = 'ban_only' | 'site_index' | 'zill_env' | 'zill_full' | 'shadow_zill_env' | 'shadow_zill_full'
export interface BacktestArm { id: ArmId; policy: PolicyId; shadow: boolean }
export const BACKTEST_ARMS: Readonly<Record<ArmId, BacktestArm>>
export const ARM_IDS: readonly ArmId[]; export const CLOSED_LOOP_ARMS: readonly ArmId[]; export const SHADOW_ARMS: readonly ArmId[]
export type HeatStratum = 'hot' | 'median' | 'mild'; export const HEAT_STRATA: readonly HeatStratum[]
export interface DayHeat { siteId: SiteId; date: string; shiftMeanWbgtC: number; shiftMaxWbgtC: number; shiftMinTwlWm2: number; hours: number }
export interface CohortDay extends DayHeat { stratum: HeatStratum; heatRank: number; daysRanked: number }
export function seasonDates(year: number, months: readonly number[]): string[]
export function dayHeatFromAnalysis(site: Site, date: string, analysis: readonly EnvSample[], shift?: { start: string; end: string }): DayHeat | null
export function selectCohortDays(heats: readonly DayHeat[], perStratum: number): CohortDay[]
export interface StratumCuts { siteId; daysRanked; hotMinC; mildMaxC; maxC; minC }; export function stratumCuts(heats: readonly DayHeat[]): StratumCuts[]
export interface VariantSpec { id; group: 'base' | 'sensitivity' | 'robustness'; factor; label; value: number | string; behaviour?: Partial<Omit<SimBehaviour,'ackDelayMin'>>; disruptions?: Partial<SimDisruptions>; truthParams?: DeepPartial<TruthParams>; arms: readonly ArmId[]; strata: readonly HeatStratum[] }
export const NETWORK_OUTAGE_WINDOW  // { from: '10:00', to: '16:00' } [ENG]; export const STALE_FORECAST_AGE_H = 30
export function cohortVariants(spec: Pick<CohortSpec, 'sweepStrata' | 'shift' | 'variants'>): VariantSpec[]
export type CohortMode = 'quick' | 'medium' | 'full'
export interface CohortSpec { mode: CohortMode | 'custom'; seed; workforceSeed; year; months; sites; daysPerStratum; crewsPerSite; includeDemoCrew; shift; sweepStrata; replicates; calibration: boolean; variants: 'all' | 'base' }
export const COHORT_PRESETS: Readonly<Record<CohortMode, CohortSpec>>  // quick 1 day/stratum ×1 crew, sweeps hot; medium 3×1, hot; full 6×2, hot+median; seed 'zill-cohort-2025'
export function cohortSpec(mode: CohortMode, overrides?: Partial<Omit<CohortSpec, 'mode'>>): CohortSpec
export interface RunRecord { variant; arm; siteId; date; stratum; seed; stamp; workers; timingMs }
export interface ArmRunOutput { run: RunRecord; records: WorkerShiftRecord[]; alerts: RunAlertSummary; calibration: CalibrationCounts | null }
export function simConfigFor(spec: CohortSpec, day: Pick<CohortDay, 'siteId' | 'date'>, variant: VariantSpec, arm: ArmId): SimConfig
export function truthOverridesApplied(spec: CohortSpec, data: SimData, date: string, overrides: DeepPartial<TruthParams>): boolean
export function runArm(spec: CohortSpec, data: SimData, day: CohortDay, variant: VariantSpec, arm: ArmId, adoshUnacclimatized: ReadonlySet<string>): ArmRunOutput
export interface VariantStatus { spec: VariantSpec; supported: boolean; note: string | null; runs: number }
export interface BacktestResult { spec; dayHeats: DayHeat[]; days: CohortDay[]; variants: VariantStatus[]; outputs: ArmRunOutput[] }
export interface BacktestOptions { variants?: VariantSpec[]; days?: CohortDay[]; onProgress?: (message: string) => void }
export async function runBacktest(spec: CohortSpec, loader: SimDataLoader, opts?: BacktestOptions): Promise<BacktestResult>
export interface DetectionHeadline; export interface Headline; export type PairedHeadline; export interface ArmSummary; export interface VariantArmSummary; export interface VariantSummary; export interface VariantReportEntry
export interface CohortReport { kind: 'zill.validation.cohort/v1'; evidenceClass: 'simulated_cohort'; disclaimer; versions; spec; metricParams; strata; days; arms; variants; runs: { columns: ['variant','arm','day','seed','stamp','workers']; rows }; main: { arms: ArmSummary[]; byStratum; fairness }; sensitivity: VariantSummary[]; robustness: VariantSummary[] }
export const COHORT_DISCLAIMER: string
export function headline(records: readonly WorkerShiftRecord[], runs: readonly RunAlertSummary[], arm: ArmId, o: AggregateOptions): Headline
export function summariseBacktest(result: BacktestResult): CohortReport
// ── scripts/validate/cohort.ts ── (CLI: --quick | --medium | --full [--days=N --crews=N --sweep=hot,median --seed=S --base-only --no-docs --docs-only])
export const COHORT_DOC = 'docs/VALIDATION-COHORT.md'
export interface CohortFile extends CohortReport { generatedBy: string; stamp: CodeStamp; provenance: { inputs; manifestMismatches; attribution } }
export interface RunCohortOptions { log?: boolean; mode?: CohortMode; baseOnly?: boolean; overrides?: Partial<Omit<CohortSpec,'mode'>>; docs?: boolean }
export function defaultCohortMode(): CohortMode  // ZILL_COHORT_MODE, else the mode of the existing cohort.json, else 'quick'
export async function runCohort(opts?: RunCohortOptions): Promise<CohortFile>  // run-all.ts calls runCohort({ log }) (first matching name it looks for)
export function renderCohortBlocks(r: CohortFile): Record<string, string>
export function updateCohortDoc(file: CohortFile): { updated: string[]; missing: string[] }
```

## state-sync

```ts
// ── src/state/simStore.ts (zustand/vanilla; Node-safe: loader + scheduler created lazily) ──
export const SIM_SPEEDS = [1, 10, 60, 300] as const; export type SimSpeed = (typeof SIM_SPEEDS)[number]
export function isSimSpeed(value: unknown): value is SimSpeed
export const SIM_CLOCK: Readonly<{ defaultSpeed: SimSpeed /*60*/; frameChunkMin: 10; frameBudgetMs: 12; maxFrameGapMs: 250; jumpChunkMin: 10; followToleranceMin: 3; basis }>  // all [ENG]
export const DEVICE_LOG_LIMITS: Readonly<{ checkins: 50; intakes: 100; levels: 300; remoteCheckins: 50; applied: 2000; basis }>  // [ENG]
export interface SimScheduler { now(): number; requestFrame(cb: () => void): unknown; cancelFrame(h: unknown): void; yieldToUi(): Promise<void> }
export function browserScheduler(): SimScheduler  // rAF or 16 ms timer; performance.now()
export type ChangeOrigin = 'local' | 'remote'; export interface ActionMeta { origin?: ChangeOrigin }
export interface QueuedInjection { injection: WorldInjection; origin: ChangeOrigin }
export interface AppliedInjection { seq: number; t: number; injection: WorldInjection; origin: ChangeOrigin; ok: boolean; error?: string }
export interface RosterLink { crewId: string; displayName: string; buddyId?: string; supervisorId?: string }  // from world.rosterOnline
export interface DeviceRecord { checkins: Checkin[]; intakes: FluidIntake[]; levels: Array<{ t: number; level: RiskLevel }>; maxLevel: RiskLevel }
export interface RemotePayload { payload: SyncPayload; receivedAt: number }; export interface RemoteCheckin { workerId: string; t: number; level: RiskLevel }
export interface ClockSync { scenarioId: ScenarioId; policy: PolicyId; seed: string; t: number; playing: boolean; speed: SimSpeed }
export type SimStatus = 'idle' | 'loading' | 'ready' | 'error'
export interface SimStoreState { status; error: string | null; scenarioId: ScenarioId | null; overrides: Partial<SimConfigInput>; data: SimData | null; world: World | null; view: WorldView | null; crews: readonly Crew[]; roster: Readonly<Record<string, RosterLink>>; device: Readonly<Record<string, DeviceRecord>>; playing: boolean; speed: SimSpeed; jumping: boolean; pending: readonly QueuedInjection[]; applied: readonly AppliedInjection[]; injectionError: string | null; remotePayloads: Readonly<Record<string, RemotePayload>>; remoteCheckins: readonly RemoteCheckin[]; clock: { rev: number; origin: ChangeOrigin }; revision: number; loadScenario(id: ScenarioId, overrides?: Partial<SimConfigInput>, meta?: ActionMeta): Promise<void>; configure(overrides: Partial<SimConfigInput>, meta?: ActionMeta): void; reset(meta?: ActionMeta): void; play(meta?): void; pause(meta?): void; togglePlay(meta?): void; setSpeed(speed: SimSpeed, meta?): void; step(minutes: number): void; jumpTo(target: string | number, meta?: ActionMeta): Promise<void>; inject(injection: WorldInjection | readonly WorldInjection[], meta?: ActionMeta): void; flush(): void; syncClock(clock: ClockSync, meta?: ActionMeta): Promise<void>; acceptRemotePayload(payload: SyncPayload): void; acceptRemoteCheckin(notice: RemoteCheckin): void; dispose(): void }
export type SimStore = StoreApi<SimStoreState>; export interface SimStoreDeps { loader?: SimDataLoader | (() => SimDataLoader); scheduler?: SimScheduler }
export function emptyDeviceRecord(): DeviceRecord
export function absorbEvents(world: Pick<World, 'events'>, cursor: number, device: Readonly<Record<string, DeviceRecord>>): { cursor: number; device: Readonly<Record<string, DeviceRecord>> }
export function resolveJumpTarget(target: string | number, world: Pick<World, 'config' | 't0' | 'tEnd'>): number  // 'HH:mm' or epoch ms → minute grid, clamped
export function createSimStore(deps?: SimStoreDeps): SimStore
export const simStore: SimStore
// ── src/state/selectors.ts (pure; every non-worker model via privacy.project / aggregateFor; returns audit drafts) ──
export interface SelectorInput { view: WorldView; crews: readonly Crew[]; roster: Readonly<Record<string, RosterLink>>; device: Readonly<Record<string, DeviceRecord>>; consent?: Readonly<Record<string, ConsentState>>; remote?: Readonly<Record<string, RemotePayload>> }
export interface Projected<T> { model: T; audit: AuditDraft[] }
export function selectorInput(sim: Pick<SimStoreState, 'view' | 'crews' | 'roster' | 'device' | 'remotePayloads'>, consent?: Readonly<Record<string, ConsentState>>): SelectorInput | null
export const CASE_SYMPTOM_WINDOW_MIN = 120  // [ENG]; export const LOCATION_TEXT: Readonly<Record<WorkerLocation, string>>
export interface CaseStatus { alert: Alert | null; ackStatus: AckStatus; escalated: boolean }
export function caseIndex(alerts: readonly Alert[]): Map<string, CaseStatus>; export function caseStatus(alerts: readonly Alert[], workerId: string): CaseStatus
export function profileWithConsent(input: Pick<SelectorInput, 'consent'>, profile: WorkerProfile): WorkerProfile
export function caseLocation(view: Pick<WorldView, 'site'>, wv: Pick<WorkerView, 'task' | 'location'>): privacy.WorkerLocation
export function recentReports(device: DeviceRecord | undefined, now: number): { symptoms: SymptomId[]; urineColor: UrineColor | null }
export function deviceSnapshot(input: SelectorInput, workerId: string): WorkerSnapshot | null  // never reads WorkerView.truth
export interface SiteStatus { t; site: Site; heat: SiteHeat | null; env: WorkerEnvStatus | null; hours: SiteHour[]; network; sensor; finished }; export function siteStatus(view: WorldView): SiteStatus
export interface AlertItem { id; t; scope; crewId?; workerId?; memberIds?; level; actions; reason; status; ack? }; export function alertItem(a: Alert): AlertItem  // confidential actions removed, clinical wording replaced
export interface ReceivedRecord { workerId: string; decision: 'allowed' | 'denied' | 'no_data'; data: ProjectedData; fields: DataField[]; withheld: DataField[]; reason: string }
export interface WorkerDeviceModel { workerId; t; profile: WorkerProfile; snapshot: WorkerSnapshot | null; assessment: RiskAssessment | null; detail: WorkerStepDetail | null; task: Task | null; location: WorkerLocation; lastHrBpm: number | null; checkinDue: boolean; alert: Alert | null; ackStatus: AckStatus; notifications: Notification[]; device: DeviceRecord; outbound: SyncPayload | null; buddyCards: BuddyCard[]; site: SiteStatus }
export function selectWorkerDevice(input: SelectorInput, workerId: string): Projected<WorkerDeviceModel | null>
export interface BuddyCard extends ReceivedRecord { buddyCheck: boolean; alertId: string | null; notifications: Notification[] }; export function selectBuddyCards(input: SelectorInput, buddyId: string): Projected<BuddyCard[]>  // role 'buddy', buddyIds scoped
export interface SupervisorActor { actorId; crewId; crewName; supervisorName }; export function supervisorActors(input: Pick<SelectorInput, 'crews' | 'roster'>): SupervisorActor[]; export function supervisedCrewIds(input: Pick<SelectorInput, 'roster'>, actorId: string): string[]
export interface CrewBoardRow extends ReceivedRecord { crewId: string; source: 'local' | 'remote'; alertId: string | null }; export interface CrewBoard { crew: { id; name; supervisorName; tasks: Task[] }; rows: CrewBoardRow[]; counts: Record<RiskLevel, number>; plan: CrewPlan | null }; export interface SupervisorBoard { actorId; t; crews: CrewBoard[]; alerts: AlertItem[]; notifications: Notification[]; site: SiteStatus }
export function selectSupervisorBoard(input: SelectorInput, actorId: string): Projected<SupervisorBoard>  // role 'supervisor', actorCrewIds scoped
export interface FirstAidCase extends ReceivedRecord { alert: AlertItem; escalated: boolean }; export interface FirstAiderModel { actorId; t; cases: FirstAidCase[]; notifications: Notification[]; site: SiteStatus }; export function selectFirstAiderCases(input: SelectorInput, actorId: string): Projected<FirstAiderModel>
export interface OccHealthCase extends ReceivedRecord { alert: AlertItem; clinicalReleased: boolean }; export interface OccHealthModel { actorId; t; cases: OccHealthCase[]; notifications: Notification[] }; export function selectOccHealthCases(input: SelectorInput, actorId: string): Projected<OccHealthModel>  // purpose clinical_care, escalated only
export type AggregateDimension = 'current_level' | 'max_level_today'; export interface AggregateRecord { workerId; crewId; siteId; level; maxLevel; consent: ConsentState }; export interface AggregateView { purpose; dimension; rowsBy: 'crew' | 'site'; decision; k: number | null; table: AggregateTable | null; excludedForConsent: number; reason: string }
export function aggregateRecords(input: SelectorInput): AggregateRecord[]; export interface AggregateSelectRequest { role: Role; actorId: string; purpose: Purpose; dimension: AggregateDimension; rowsBy: 'crew' | 'site'; k?: number }; export function selectAggregate(input: SelectorInput, req: AggregateSelectRequest): Projected<AggregateView>
export interface HseAggregates { current: AggregateView; today: AggregateView; site: SiteStatus }; export function selectHseAggregates(input: SelectorInput, actorId: string): Projected<HseAggregates>  // k = 5
export interface ZoneHours { zone: string; hours: number; middayBreakHours: number }; export function zoneHours(hours: readonly SiteHour[]): ZoneHours[]
export interface RegulatorAggregates { compliance: AggregateView; publicHealth: AggregateView; zoneHours: ZoneHours[]; site: { id; name } }; export function selectRegulatorAggregates(input: SelectorInput, actorId: string): Projected<RegulatorAggregates>  // k = 10
export interface LabWorkerRow { workerId; displayName; crewId; task; location; level; computedLevel; minutesToLimit; hrMeasuredBpm; ectempBand: EctempBand | null; truth: WorkerView['truth'] }; export function selectLabWorkers(view: WorldView): LabWorkerRow[]  // ONLY selector reading truth
export function selectLabTrace(world: Pick<World, 'minutes'> | null, workerId: string, sinceT?: number): WorkerMinute[]
// ── src/state/governanceStore.ts ──
export const AUDIT_RELOG_MS = 15 * MINUTE_MS  // [ENG]; export const PROHIBITED_DEMO_ACTOR = 'HR-1'; export const PROHIBITED_DEMO_REQUEST: Readonly<Omit<AccessRequest, 'actorId'>>  // employer_hr · performance_management · ['hrBpm']
export interface ConsentChangeInput { workerId: string; scope: ConsentScope; t: number; language: LangCode; method?: ConsentMethod; collectedBy?: ConsentCollector; witnessId?: string; base?: ConsentState }
export interface TamperDemoResult { index: number; patch: Partial<AuditEntry>; originalEntry: AuditEntry; tamperedEntry: AuditEntry; tampered: AuditVerification; original: AuditVerification }
export interface ProhibitedDemoResult { request: AccessRequest; result: ProjectionResult & { entry: AuditEntry } }; export interface DataFlowItem { workerId: string; crewId: string; inspection: SyncInspection }
export interface GovernanceState { log: AuditLog; entries: readonly AuditEntry[]; head: AuditAnchor; anchor: AuditAnchor | null; verification: AuditVerification | null; tamperDemo: TamperDemoResult | null; prohibitedDemo: ProhibitedDemoResult | null; consent: Readonly<Record<string, ConsentState>>; receipts: readonly ConsentReceipt[]; auditError: string | null; seedConsent(profiles: readonly WorkerProfile[], opts?: { overwrite?: boolean }): void; grant(input: ConsentChangeInput): ConsentReceipt; revoke(input: ConsentChangeInput): ConsentReceipt; record(draft: AuditDraft): Promise<AuditEntry | null>; recordAll(drafts: readonly AuditDraft[]): Promise<void>; whoSawMyData(workerId: string): AuditEntry[]; publishAnchor(): AuditAnchor; verify(): Promise<AuditVerification>; runTamperDemo(opts?: { index?: number; patch?: Partial<AuditEntry> }): Promise<TamperDemoResult>; runProhibitedRequestDemo(snapshot: WorkerSnapshot, now: number, actorId?: string): Promise<ProhibitedDemoResult>; flush(): Promise<void>; reset(): void }
export type GovernanceStore = StoreApi<GovernanceState>
export function auditKey(d: AuditDraft): string; export function auditSignature(d: AuditDraft): string; export function entriesForSubject(entries: readonly AuditEntry[], workerId: string): AuditEntry[]
export function buildDataFlowFeed(input: SelectorInput): DataFlowItem[]  // inspectSyncPayload per worker
export function createGovernanceStore(): GovernanceStore; export function connectGovernanceToSim(sim: SimStore, gov: GovernanceStore): () => void; export const governanceStore: GovernanceStore
// ── src/state/syncBus.ts ──
export const SYNC_BUS_VERSION = 1; export const SYNC_CHANNEL_NAME = 'zill'; export type ResponderRole = 'buddy' | 'supervisor' | 'first_aider' | 'occ_health'; export type ResolverRole = 'first_aider' | 'supervisor' | 'occ_health'
export type SyncMessage = { kind: 'payload'; payload: SyncPayload } | { kind: 'worker_ack'; workerId: string; alertId: string; t: number } | { kind: 'checkin_done'; workerId: string; t: number; level: RiskLevel } | { kind: 'ack'; alertId: string; role: ResponderRole; actorId: string; t: number } | { kind: 'resolve'; workerId: string; alertId: string | null; by: ResolverRole; actorId: string; t: number } | { kind: 'reassign'; workerId: string; taskId: string | null; location: WorkerLocation; actorId: string; t: number } | { kind: 'clock'; scenarioId: ScenarioId; policy: PolicyId; seed: string; t: number; playing: boolean; speed: SimSpeed }
export type SyncMessageKind = SyncMessage['kind']; export const SYNC_MESSAGE_KEYS: Readonly<Record<SyncMessageKind, readonly string[]>>; export const SYNC_MESSAGE_DIRECTION: Readonly<Record<SyncMessageKind, 'worker_to_supervisor' | 'supervisor_to_worker' | 'control'>>
export interface SyncEnvelope { v: 1; id: string; origin: string; seq: number; msg: SyncMessage }
export const SYNC_FORBIDDEN_KEYS: readonly string[]  // CLINICAL_FIELDS + raw on-device/truth keys; export function findForbiddenKeys(value: unknown): string[]
export function isSyncPayload(x: unknown): x is SyncPayload; export function isSyncMessage(x: unknown): x is SyncMessage; export function parseEnvelope(raw: unknown): SyncEnvelope | null
export interface ChannelLike { postMessage(data: unknown): void; close(): void; onmessage: ((event: { data: unknown }) => void) | null }; export type ChannelFactory = (name: string) => ChannelLike | null; export function broadcastChannelFactory(): ChannelFactory | null
export interface MemoryChannelHub { factory: ChannelFactory; posted: Array<{ name: string; data: unknown }>; settle(): Promise<void> }; export function createMemoryChannelHub(): MemoryChannelHub
export interface SyncBusStats { sent; received; droppedEcho; droppedDuplicate; rejected }; export type SendResult = { ok: true; envelope: SyncEnvelope } | { ok: false; reason: 'unavailable' | 'invalid' | 'forbidden_keys' | 'closed' | 'post_failed' }; export type SyncListener = (msg: SyncMessage, envelope: SyncEnvelope) => void
export interface SyncBus { readonly name: string; readonly origin: string; readonly available: boolean; send(msg: SyncMessage): SendResult; subscribe(listener: SyncListener): () => void; stats(): SyncBusStats; close(): void }
export interface SyncBusOptions { name?: string; origin?: string; factory?: ChannelFactory | null; seenLimit?: number }; export function createSyncBus(opts?: SyncBusOptions): SyncBus; export function getSyncBus(): SyncBus  // lazy singleton
export const PAYLOAD_HEARTBEAT_MIN = 5; export const CLOCK_HEARTBEAT_MIN = 15  // [ENG]
export interface SimBusOptions { deviceWorkerId?: () => string | null; shareClock?: boolean; followClock?: boolean; actorId?: () => string; heartbeatMin?: number }
export function messageForInjection(a: AppliedInjection, state: Pick<SimStoreState, 'view'>, actorId: string | null): SyncMessage | null; export function injectionForMessage(msg: SyncMessage): WorldInjection | null
export function connectSimToBus(sim: SimStore, bus: SyncBus, opts?: SimBusOptions): () => void
// ── src/state/uiStore.ts ──
export const ROLES: readonly Role[]; export const DEFAULT_ACTOR_IDS: Readonly<Record<'first_aider' | 'occ_health' | 'hse_manager' | 'regulator' | 'employer_hr', string>>; export const DEVICE_ROUTE_ALIAS = 'demo'; export const UI_STORAGE_KEY = 'zill.ui.v1'
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface UiState { role: Role; actorId: string; language: LangCode; dir: TextDirection; siteId: SiteId | null; selectedWorkerId: string | null; deviceWorkerId: string | null; supervisorActorId: string | null; setRole(role: Role, actorId?: string): void; setActorId(actorId: string): void; setLanguage(lang: LangCode): void; selectSite(siteId: SiteId | null): void; selectWorker(workerId: string | null): void; setDeviceWorker(workerId: string | null): void; setSupervisorActor(actorId: string | null): void; ensureRoster(roster: { workerIds: readonly string[]; supervisorIds: readonly string[]; siteId?: SiteId }): void; hydrate(env?: { languages?: readonly string[] | null; storage?: StorageLike | null }): void }
export type UiStore = StoreApi<UiState>; export function actorFor(role: Role, s: Pick<UiState, 'deviceWorkerId' | 'supervisorActorId'>): string; export function resolveDeviceWorkerId(routeId: string | null | undefined, s: Pick<UiState, 'deviceWorkerId'>): string | null
export function createUiStore(): UiStore; export function persistUi(store: UiStore, storage: StorageLike): () => void; export interface DocumentLike { documentElement: { lang: string; dir: string } }; export function bindDocumentLanguage(store: UiStore, doc?: DocumentLike | null): () => void; export function connectUiToSim(sim: SimStore, ui: UiStore): () => void; export const uiStore: UiStore
// ── src/state/hooks.ts (React; audit drafts appended in useEffect) ──
export function useSim<T>(selector: (s: SimStoreState) => T): T; export function useUi<T>(selector: (s: UiState) => T): T; export function useGovernance<T>(selector: (s: GovernanceState) => T): T
export function useSelectorInput(): SelectorInput | null; export function useProjected<T>(compute: (input: SelectorInput) => Projected<T>, deps: readonly unknown[]): T | null
export function useSupervisorBoard(actorId?: string): SupervisorBoard | null; export function useWorkerDevice(routeWorkerId?: string | null): WorkerDeviceModel | null; export function useBuddyCards(buddyId?: string | null): BuddyCard[]; export function useFirstAiderCases(actorId?: string): FirstAiderModel | null; export function useOccHealthCases(actorId?: string): OccHealthModel | null; export function useHseAggregates(actorId?: string): HseAggregates | null; export function useRegulatorAggregates(actorId?: string): RegulatorAggregates | null; export function useLabWorkers(): LabWorkerRow[]; export function useDataFlowFeed(): DataFlowItem[]
// ── src/state/index.ts ──
export * from './simStore' | './uiStore' | './selectors' | './governanceStore' | './syncBus'
export interface AppStateOptions { bus?: boolean; isDevice?: () => boolean; shareClock?: boolean; followClock?: boolean }; export function connectAppState(opts?: AppStateOptions): () => void  // ledger seeding + UI roster sync + document lang/dir + sync bus
```
