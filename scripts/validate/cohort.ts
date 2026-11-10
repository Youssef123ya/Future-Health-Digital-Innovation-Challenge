/**
 * Simulated-cohort evidence (docs/SIMULATION.md §4–§6) → public/data/validation/cohort.json, and the generated tables
 * of docs/VALIDATION-COHORT.md (between `<!-- validate:begin:cohort-… -->` markers).
 *
 *   npx tsx scripts/validate/cohort.ts --quick    5 sites × 3 days × 1 crew, sweeps on hot days (about a minute)
 *   npx tsx scripts/validate/cohort.ts --medium   5 sites × 9 days × 1 crew, sweeps on hot days
 *   npx tsx scripts/validate/cohort.ts --full     5 sites × 18 days × 2 crews, sweeps on hot and median days
 * Flags: --days=<n per stratum per site>, --crews=<n per site>, --sweep=hot,median,mild, --seed=<s> (custom size; the
 * report's mode becomes 'custom'), --base-only (no sensitivity/robustness variants), --no-docs (JSON only),
 * --docs-only (re-render the doc from the existing JSON). run-all.ts calls {@link runCohort}({ log }); the mode then defaults to ZILL_COHORT_MODE, else the
 * mode of the cohort.json already on disk, else 'quick', so `npm run validate` regenerates evidence of the same size.
 *
 * The JSON is deterministic for a given code and data stamp (no clock values; seeded bootstrap). Run times are printed
 * to the console only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cohortSpec, HEAT_STRATA, runBacktest, summariseBacktest, type ArmId, type CohortMode, type CohortReport, type CohortSpec, type HeatStratum, type Headline, type PairedHeadline, type VariantSummary } from '../../src/sim/backtest'
import type { Role } from '../../src/engine/types'
import { allFinite, type Estimate, type LeadTimeSummary, type RateEstimate } from '../../src/sim/metrics'
import { createNodeSimDataLoader } from '../../src/sim/simdata'
import { mdTable, replaceValidationBlocks } from './lib/docs'
import { codeStamp, DATA_ATTRIBUTION, isMainModule, Provenance, readValidationJson, repoPath, writeValidationJson, type CodeStamp, type InputFileRecord } from './lib/io'

/** Repository path of the cohort document. */
export const COHORT_DOC = 'docs/VALIDATION-COHORT.md'

/** What cohort.json holds: the back-test report plus the generation command, code/input stamp and provenance. */
export interface CohortFile extends CohortReport {
  generatedBy: string
  stamp: CodeStamp
  provenance: { inputs: InputFileRecord[]; manifestMismatches: string[]; attribution: typeof DATA_ATTRIBUTION }
}

/** Options of {@link runCohort}. */
export interface RunCohortOptions {
  log?: boolean
  mode?: CohortMode
  /** Base case only (no sensitivity / robustness variants). */
  baseOnly?: boolean
  /** Size/design overrides of the preset (the report's mode becomes 'custom'). */
  overrides?: Partial<Omit<CohortSpec, 'mode'>>
  /** Rewrite the generated tables of docs/VALIDATION-COHORT.md (default true). */
  docs?: boolean
}

const MODES: readonly CohortMode[] = ['quick', 'medium', 'full']
const isMode = (x: unknown): x is CohortMode => typeof x === 'string' && (MODES as readonly string[]).includes(x)

/** Mode used when none is given: ZILL_COHORT_MODE, else the mode of the cohort.json on disk, else 'quick'. */
export function defaultCohortMode(): CohortMode {
  const env = process.env.ZILL_COHORT_MODE
  if (isMode(env)) return env
  const prev = readValidationJson('cohort') as { spec?: { mode?: unknown } } | null
  return isMode(prev?.spec?.mode) ? prev.spec.mode : 'quick'
}

/**
 * Run the cohort back-test and write public/data/validation/cohort.json (and, unless `docs: false`, the generated
 * tables of docs/VALIDATION-COHORT.md). Inputs (weather archive, previous-runs forecasts, demo days) are hashed into
 * the stamp and checked against the download manifest. Returns the written report.
 */
export async function runCohort(opts: RunCohortOptions = {}): Promise<CohortFile> {
  const log = opts.log ?? true
  const mode = opts.mode ?? defaultCohortMode()
  const spec = cohortSpec(mode, { ...(opts.overrides ?? {}), ...(opts.baseOnly ? { variants: 'base' as const } : {}) })
  const t0 = performance.now()
  if (log) console.log(`[cohort] mode ${spec.mode}: ${spec.sites.length} sites × ${spec.daysPerStratum * 3} days × ${spec.crewsPerSite} crew(s)/site; variants ${spec.variants}`)
  const result = await runBacktest(spec, createNodeSimDataLoader(), { onProgress: log ? (m) => console.log(`[cohort] ${m} (${((performance.now() - t0) / 1000).toFixed(1)} s)`) : undefined })
  const report = summariseBacktest(result)

  const prov = new Provenance()
  const rels = ['public/data/weather/demo-days.json', ...spec.sites.flatMap((s) => [`public/data/weather/archive/${s}_${spec.year}.json`, `public/data/weather/previous-runs/${s}_${spec.year}.json`])]
  for (const rel of rels) if (existsSync(repoPath(rel))) prov.record(rel, readFileSync(repoPath(rel)))

  const o = opts.overrides ?? {}
  const flags = [
    o.daysPerStratum !== undefined ? ` --days=${o.daysPerStratum}` : '',
    o.crewsPerSite !== undefined ? ` --crews=${o.crewsPerSite}` : '',
    o.sweepStrata !== undefined ? ` --sweep=${o.sweepStrata.join(',')}` : '',
    o.seed !== undefined ? ` --seed=${o.seed}` : '',
    opts.baseOnly ? ' --base-only' : '',
  ].join('')
  const cmd = `npx tsx scripts/validate/cohort.ts --${mode}${flags}`
  const file: CohortFile = {
    ...report,
    generatedBy: cmd,
    stamp: codeStamp(prov.inputsSha256()),
    provenance: { inputs: prov.records(), manifestMismatches: prov.manifestMismatches(), attribution: DATA_ATTRIBUTION },
  }
  if (!allFinite(file)) throw new Error('cohort: the report contains NaN or Infinity')
  const bytes = writeValidationJson('cohort', file)
  const ms = performance.now() - t0
  const cpu = result.outputs.reduce((s, o) => s + o.run.timingMs, 0)
  if (log) {
    console.log(`[cohort] ${result.outputs.length} site-day runs, ${result.outputs.reduce((s, o) => s + o.run.workers, 0)} worker-shifts, simulation CPU ${(cpu / 1000).toFixed(1)} s, wall ${(ms / 1000).toFixed(1)} s`)
    console.log(`[cohort] wrote public/data/validation/cohort.json (${(bytes / 1024).toFixed(0)} KB), stamp ${file.stamp.stamp}`)
    if (file.provenance.manifestMismatches.length) console.warn(`[cohort] manifest mismatches: ${file.provenance.manifestMismatches.join(', ')}`)
  }
  if (opts.docs ?? true) {
    const d = updateCohortDoc(file)
    if (log) console.log(`[cohort] ${COHORT_DOC}: ${d.updated.length} tables updated${d.missing.length ? `, no rendering for ${d.missing.join(', ')}` : ''}`)
  }
  return file
}

// ─────────────────────────────── Document rendering ───────────────────────────────

const ARM_LABEL: Record<ArmId, string> = {
  ban_only: 'Midday ban only',
  site_index: 'Site TWL index',
  zill_env: 'Zill (no wearable)',
  zill_full: 'Zill (with wearable)',
  shadow_zill_env: 'Shadow: Zill (no wearable)',
  shadow_zill_full: 'Shadow: Zill (with wearable)',
}
const SITE_LABEL: Record<string, string> = { musaffah: 'Musaffah', kezad: 'KEZAD', ruwais: 'Ruwais', alain: 'Al Ain', saadiyat: 'Saadiyat' }
const TARGET_LABEL: Record<string, string> = {
  excessive_strain: 'Excessive strain',
  severe_strain: 'Severe strain (≥ 39.5 °C)',
  critical: 'Critical (≥ 40 °C or CNS)',
  dehydration_3pct: 'Dehydration > 3 %',
  heat_symptoms: 'Heat symptoms (truth: heat exhaustion, cramps, CNS)',
  symptomatic: 'Symptomatic event (log: T2+ check-in or first aid)',
}

const num = (x: number | null | undefined, d: number): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))
const ci = (c: [number, number] | null, d: number, mul = 1): string => (c ? ` [${(c[0] * mul).toFixed(d)}, ${(c[1] * mul).toFixed(d)}]` : '')
const est = (e: Estimate | null | undefined, d = 1): string => (!e || e.value === null ? '—' : `${e.value.toFixed(d)}${ci(e.ci95, d)}`)
const pctE = (e: Estimate | null | undefined, d = 0): string => (!e || e.value === null ? '—' : `${(100 * e.value).toFixed(d)} %${ci(e.ci95, d, 100)}`)
const rate = (e: RateEstimate | null | undefined): string => (!e || e.value === null ? '—' : e.count === 0 && e.upper95 !== null ? `0 (≤ ${e.upper95.toFixed(1)})` : `${e.value.toFixed(1)}${ci(e.ci95, 1)}`)
const signed = (e: Estimate | null | undefined, d = 1): string => (!e || e.value === null ? '—' : `${e.value > 0 ? '+' : ''}${e.value.toFixed(d)}${ci(e.ci95, d)}`)
const signedPct = (e: Estimate | null | undefined): string => (!e || e.value === null ? '—' : `${e.value > 0 ? '+' : ''}${(100 * e.value).toFixed(1)} %${ci(e.ci95, 1, 100)}`)
const lead = (l: LeadTimeSummary | null | undefined): string => (!l || l.n === 0 ? '— (n = 0)' : `${num(l.medianMin, 0)} [IQR ${num(l.p25Min, 0)}–${num(l.p75Min, 0)}] (n = ${l.n})`)

/** Markdown for every generated block of docs/VALIDATION-COHORT.md (pure). */
export function renderCohortBlocks(r: CohortFile): Record<string, string> {
  const base = r.main.arms
  const ws = base[0]?.rates.workerShifts ?? 0
  const blocks: Record<string, string> = {}

  blocks['cohort-meta'] = [
    `Generated by \`${r.generatedBy}\` — stamp \`${r.stamp.stamp}\`; back-test ${r.versions.backtest}, metrics ${r.versions.metrics}, world simulation ${r.versions.worldsim}.`,
    '',
    mdTable(
      ['Item', 'Value'],
      [
        ['Mode', r.spec.mode],
        ['Season', `${r.spec.year}, months ${r.spec.months.join(', ')} (shift ${r.spec.shift.start}–${r.spec.shift.end})`],
        ['Sites', r.spec.sites.map((s) => SITE_LABEL[s] ?? s).join(', ')],
        ['Cohort days', `${r.days.length} site-days (${r.spec.daysPerStratum} per heat tercile per site)`],
        ['Crews', `${r.spec.crewsPerSite} synthetic crew(s) per site (workforce seed \`${r.spec.workforceSeed}\`)`],
        ['Worker-shifts per base arm', ws],
        ['Runs', `${r.runs.rows.length} site-day runs, seed \`${r.spec.seed}\` for every run (common random numbers)`],
        ['Bootstrap', `${r.spec.replicates} cluster (site-day) replicates, percentile 95 % intervals`],
        ['Input files', `${r.provenance.inputs.length} (manifest mismatches: ${r.provenance.manifestMismatches.length})`],
      ],
    ),
  ].join('\n')

  blocks['cohort-days'] = [
    mdTable(
      ['Site', 'Hot tercile from', 'Mild tercile up to', 'Season range', 'Days ranked'],
      r.strata.map((s) => [SITE_LABEL[s.siteId] ?? s.siteId, `${num(s.hotMinC, 1)} °C`, `${num(s.mildMaxC, 1)} °C`, `${num(s.minC, 1)}–${num(s.maxC, 1)} °C`, s.daysRanked]),
    ),
    '',
    mdTable(
      ['Site', 'Date', 'Stratum', 'Shift-mean WBGT', 'Shift-max WBGT', 'Min TWL', 'Heat rank'],
      r.days.map((d) => [SITE_LABEL[d.siteId] ?? d.siteId, d.date, d.stratum, `${num(d.shiftMeanWbgtC, 1)} °C`, `${num(d.shiftMaxWbgtC, 1)} °C`, `${d.shiftMinTwlWm2} W/m²`, `${d.heatRank}/${d.daysRanked}`]),
    ),
  ].join('\n')

  blocks['cohort-rates'] = mdTable(
    ['Arm', 'Worker-shifts', 'Excessive strain /1,000', 'Severe /1,000', 'Critical /1,000', 'Dehydration > 3 % /1,000', 'Heat-symptom episodes /1,000', 'First-aid evacuations /1,000', 'Work min/shift', 'Rest min/shift', 'Water mL/shift'],
    base.map((a) => [
      ARM_LABEL[a.arm],
      a.rates.workerShifts,
      rate(a.rates.per1000.excessive),
      rate(a.rates.per1000.severe),
      rate(a.rates.per1000.critical),
      rate(a.rates.per1000.dehydration),
      rate(a.rates.per1000.symptomaticEpisodes),
      rate(a.rates.per1000.evacuations),
      est(a.rates.perShift.workMin, 0),
      est(a.rates.perShift.restMin, 0),
      est(a.rates.perShift.waterMl, 0),
    ]),
  )

  blocks['cohort-vs-ban'] = mdTable(
    ['Arm − midday ban only', 'Paired worker-shifts', 'Δ excessive /1,000', 'Δ severe /1,000', 'Δ dehydration /1,000', 'Δ heat-symptom episodes /1,000', 'Δ work min/shift', 'Work vs ban only', 'Δ rest min/shift'],
    base
      .filter((a) => a.vsBanOnly)
      .map((a) => {
        const p = a.vsBanOnly as NonNullable<typeof a.vsBanOnly>
        return [ARM_LABEL[a.arm], p.pairedWorkerShifts, signed(p.excessivePer1000), signed(p.severePer1000), signed(p.dehydrationPer1000), signed(p.symptomaticEpisodesPer1000), signed(p.workMinPerShift, 0), signedPct(p.workRelative), signed(p.restMinPerShift, 0)]
      }),
  )

  const challengeTable = mdTable(
    ['Arm', 'Individual alarms per shift: ≥ high; ≥ stop', 'Exposure advisories ≥ high: per worker-shift; per crew-shift', 'Adherence', 'Check-in response', 'Acks (share, median min)', 'Symptom reports /1,000', 'Escalations /1,000', 'Midday break compliant (violation min)', 'ADOSH zone compliant (worker-h)', 'Unacclimatised zone hours', 'Event lead time, min (individual alarms)', 'Lost to evacuations, min/1,000 worker-h'],
    base.map((a) => {
      const c = a.challenge
      return [
        ARM_LABEL[a.arm],
        `${est(c.individualAlarmsPerShift.high, 2)}; ${est(c.individualAlarmsPerShift.stop, 2)}`,
        `${est(c.exposureAdvisoriesPerWorkerShift, 2)}; ${num(c.exposureAdvisoriesPerCrewShift, 2)}`,
        pctE(c.adherence),
        pctE(c.checkinResponse),
        c.ack.requiringAck ? `${num(c.ack.acknowledgedShare === null ? null : 100 * c.ack.acknowledgedShare, 0)} %, ${num(c.ack.medianDelayMin, 1)}` : '—',
        rate(c.symptomReportsPer1000),
        rate(c.escalationsPer1000),
        `${pctE(c.midday.compliantShare)} (${c.midday.violationMin})`,
        `${pctE(c.zone.compliantShare)} (${c.zone.workerHours})`,
        c.zone.unacclimatizedHours,
        lead(c.eventLeadTime),
        num(c.heatIllnessLostMinPer1000WorkerHours, 0),
      ]
    }),
  )
  const roles: readonly Role[] = ['worker', 'buddy', 'supervisor', 'first_aider', 'occ_health']
  const burdenCell = (x: { sent: number; requiringAck: number } | undefined): string => (x ? `${x.requiringAck.toFixed(2)} (${x.sent.toFixed(2)})` : '0')
  const burdenTable = mdTable(
    ['Arm', 'Basis', 'Worker', 'Buddy', 'Supervisor', 'First aider', 'Occupational health'],
    base
      .filter((a) => a.challenge.ack.notifications > 0)
      .flatMap((a) =>
        (['individual', 'exposure', 'total'] as const).map((b) => [ARM_LABEL[a.arm], b, ...roles.map((role) => burdenCell(a.challenge.burdenPerWorkerShift?.[b]?.[role]))]),
      ),
  )
  blocks['cohort-challenge'] = [
    challengeTable,
    '',
    'Alert burden per worker-shift by alert basis and recipient: notifications that require an acknowledgement (all notifications in brackets). Individual = the alert is about this worker; exposure = a site or crew condition (engine/alerts.ts Alert.basis).',
    '',
    burdenTable,
  ].join('\n')

  blocks['cohort-detection'] = [
    'Alarms are INDIVIDUAL alarms (Alert.basis individual: the alert is about this worker), at ≥ high and at ≥ stop. Exposure advisories (site or crew conditions) are counted separately in §3.3.',
    '',
    mdTable(
      ['Shadow arm', 'Alarm level', 'Target', 'Positives', 'Sensitivity (warned by onset)', 'Sensitivity (any time in shift)', 'Specificity', 'PPV (shift)', 'PPV (alarm, ±2 h)', 'False alarms per shift', 'Lead time, min'],
      base
        .filter((a) => a.detection)
        .flatMap((a) =>
          [...(a.detection ?? []), ...(a.detectionStop ?? [])].map((d) => [
            ARM_LABEL[a.arm],
            `≥ ${d.minLevel}`,
            TARGET_LABEL[d.target] ?? d.target,
            `${d.positives}/${d.workerShifts}`,
            pctE(d.sensitivityBeforeOnset),
            pctE(d.sensitivityInShift),
            pctE(d.specificity),
            pctE(d.ppvShift),
            pctE(d.ppvAlarm),
            est(d.falseAlarmsPerShift, 2),
            lead(d.leadTime),
          ]),
        ),
    ),
  ].join('\n')

  blocks['cohort-calibration'] = mdTable(
    ['Shadow arm', 'Predicted minutes-to-limit', 'Samples', 'Mean predicted, min', 'Beyond horizon', 'Follow-up window', 'Truth limit reached within window'],
    base
      .filter((a) => a.calibration)
      .flatMap((a) => (a.calibration ?? []).map((c) => [ARM_LABEL[a.arm], c.label, c.samples, num(c.meanPredictedMin, 1), c.nullPredictions, `${c.horizonMin} min`, c.observedShare === null ? '—' : `${(100 * c.observedShare).toFixed(1)} %`])),
  )

  blocks['cohort-strata'] = mdTable(
    ['Stratum', 'Arm', 'Worker-shifts', 'Excessive /1,000', 'Severe /1,000', 'Dehydration /1,000', 'Work min/shift', 'Rest min/shift', 'Δ excessive vs ban only', 'Work vs ban only'],
    r.main.byStratum.flatMap((s) =>
      s.arms
        .filter((a) => !a.arm.startsWith('shadow'))
        .map((a) => [`${s.stratum} (${s.siteDays} site-days)`, ARM_LABEL[a.arm], a.headline.workerShifts, rate(a.headline.excessivePer1000), rate(a.headline.severePer1000), rate(a.headline.dehydrationPer1000), est(a.headline.workMinPerShift, 0), est(a.headline.restMinPerShift, 0), signed(a.vsBanOnly?.excessivePer1000), signedPct(a.vsBanOnly?.workRelative)]),
    ),
  )

  const variantRows = (vs: readonly VariantSummary[]): (string | number)[][] =>
    vs.flatMap((v) => {
      if (!v.supported) return [[v.label, '—', '—', '—', '—', '—', '—', '—', '—', v.note ?? 'not run']]
      return v.arms.map((a) => variantRow(v, a.arm, a.headline, a.vsBanOnly, a.vsBase))
    })
  const variantHead = ['Variant', 'Arm', 'Worker-shifts', 'Excessive /1,000', 'Severe /1,000', 'Work min/shift', 'Δ excessive vs ban only', 'Work vs ban only', 'Δ vs base case (excessive; work min)', 'Shadow detection, individual alarms ≥ high (excessive: sensitivity, false alarms/shift)']
  blocks['cohort-sensitivity'] = mdTable(variantHead, variantRows(r.sensitivity))
  blocks['cohort-robustness'] = mdTable(variantHead, variantRows(r.robustness))

  const fairArms: ArmId[] = ['ban_only', 'zill_full', 'shadow_zill_full']
  blocks['cohort-fairness'] = r.main.fairness
    .filter((f) => fairArms.includes(f.arm))
    .map((f) =>
      [
        `**${ARM_LABEL[f.arm]}**`,
        '',
        mdTable(
          ['Dimension', 'Group', 'Worker-shifts', 'Excessive /1,000', 'Severe /1,000', 'Dehydration /1,000', 'Heat-symptom episodes /1,000', 'Work min/shift', 'Rest min/shift', 'Adherence', 'Individual alarms/shift', 'Excessive: positives, warned by onset (individual alarm)'],
          f.cells.map((c) => [
            c.dimension,
            c.value,
            c.workerShifts,
            num(c.excessivePer1000, 1),
            num(c.severePer1000, 1),
            num(c.dehydrationPer1000, 1),
            num(c.symptomaticEpisodesPer1000, 1),
            num(c.workMinPerShift, 0),
            num(c.restMinPerShift, 0),
            c.adherence === null ? '—' : `${(100 * c.adherence).toFixed(0)} %`,
            num(c.individualAlarmsPerShift ?? null, 2),
            c.sensitivityExcessive === null ? `${c.positivesExcessive}, —` : `${c.positivesExcessive}, ${(100 * c.sensitivityExcessive).toFixed(0)} %`,
          ]),
        ),
      ].join('\n'),
    )
    .join('\n\n')
  return blocks
}

function variantRow(v: VariantSummary, arm: ArmId, h: Headline, vsBan: PairedHeadline | null, vsBase: PairedHeadline | null): (string | number)[] {
  const det = h.detection ? `${pctE(h.detection.excessive.sensitivityBeforeOnset)}; ${est(h.detection.excessive.falseAlarmsPerShift, 2)}` : '—'
  return [
    v.label,
    ARM_LABEL[arm],
    h.workerShifts,
    rate(h.excessivePer1000),
    rate(h.severePer1000),
    est(h.workMinPerShift, 0),
    signed(vsBan?.excessivePer1000),
    signedPct(vsBan?.workRelative),
    vsBase ? `${signed(vsBase.excessivePer1000)}; ${signed(vsBase.workMinPerShift, 0)}` : '—',
    det,
  ]
}

/** Rewrite the generated blocks of docs/VALIDATION-COHORT.md from a report. */
export function updateCohortDoc(file: CohortFile): { updated: string[]; missing: string[] } {
  const path = repoPath(COHORT_DOC)
  const blocks = renderCohortBlocks(file)
  if (!existsSync(path)) return { updated: [], missing: Object.keys(blocks) }
  const r = replaceValidationBlocks(readFileSync(path, 'utf8'), blocks)
  writeFileSync(path, r.text, 'utf8')
  return { updated: r.updated, missing: r.missing }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const mode = MODES.find((m) => args.includes(`--${m}`))
  if (args.includes('--docs-only')) {
    const prev = readValidationJson('cohort') as CohortFile | null
    if (!prev) {
      console.error('[cohort] no public/data/validation/cohort.json to render')
      process.exitCode = 1
    } else {
      const d = updateCohortDoc(prev)
      console.log(`[cohort] ${COHORT_DOC}: ${d.updated.length} tables updated`)
    }
  } else {
    const val = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    const int = (name: string): number | undefined => {
      const v = val(name)
      const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
      return Number.isInteger(n) && n > 0 ? n : undefined
    }
    const overrides: Partial<Omit<CohortSpec, 'mode'>> = {}
    const days = int('days')
    const crews = int('crews')
    const sweep = val('sweep')?.split(',').filter((x): x is HeatStratum => (HEAT_STRATA as readonly string[]).includes(x))
    const seed = val('seed')
    if (days !== undefined) overrides.daysPerStratum = days
    if (crews !== undefined) overrides.crewsPerSite = crews
    if (sweep && sweep.length) overrides.sweepStrata = sweep
    if (seed) overrides.seed = seed
    runCohort({ ...(mode ? { mode } : {}), overrides, baseOnly: args.includes('--base-only'), docs: !args.includes('--no-docs') }).catch((e: unknown) => {
      console.error(e)
      process.exitCode = 1
    })
  }
}
