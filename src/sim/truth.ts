/**
 * Simulation ground truth — what happens to a virtual worker (docs/SIMULATION.md §2).
 *
 * Independent of the engine by design (SIMULATION.md §1): thermoregulation is the Gagge two-node model (./gagge.ts),
 * not ISO 7933 PHS; radiant load is a HUMAN mean radiant temperature from the radiation field with a hot ground
 * (Di Napoli et al. 2020 flux formula), not the Liljegren globe; the metabolic rate carries a hidden individual
 * multiplier; heart rate comes from a %VO₂-reserve cardiovascular model, not the ECTemp observation equation; and
 * acclimatisation, hydration, latent illness and behaviour are hidden individual traits. The engine never sees this
 * module's state.
 *
 * Every behavioural or physiological parameter lives in {@link TRUTH_PARAMS} with its citation or an [ASSUMPTION] /
 * [ENG] tag, so sim/backtest.ts can sweep it ({@link withTruthParams}).
 *
 * Claims discipline: simulated physiology of virtual workers, used only to evaluate a warning policy. Every output is a
 * projection under stated assumptions — never a measurement of, or a clinical statement about, a real person.
 */

import { CLOTHING, REST_METABOLIC_W } from '../engine/limits'
import type { HrRawSample } from '../engine/physio'
import type { ClothingId, SymptomId, WorkerProfile } from '../engine/types'
import { duboisBsaM2 } from '../engine/units'
import { atmosphericEmissivity } from '../engine/wbgt'
import { getSite, isSiteId } from '../data/sites'
import { GAGGE, createGaggeState, gaggeStep, gaggeWaterLossG, type GaggeParams, type GaggeState } from './gagge'
import type { Rng } from './rng'

// ─────────────────────────────── Parameters ───────────────────────────────

const DEFAULT_PARAMS = {
  /** Hidden individual traits drawn once per worker (SIMULATION.md §2.1). */
  traits: {
    /** σ of ln(metabolic multiplier), median 1 — [ASSUMPTION] SIMULATION.md §2.1 (ISO 8996 class tables ≈ ±20 %). */
    metabolicSigmaLn: 0.15,
    /** Clamp of the multiplier [ENG]. */
    metabolicMin: 0.6,
    metabolicMax: 1.6,
    /**
     * VO₂max (mL·kg⁻¹·min⁻¹): mean at age 25 and change per year, SD and clamp. Approximates the FRIEND registry 50th
     * percentiles (Kaminsky et al. 2015, Mayo Clin Proc 90:1515–1523; men ≈ 48 → 33 from the 20s to the 50s, women
     * ≈ 38 → 24). UNVERIFIED (values recalled, not re-checked); [ASSUMPTION] that they apply to Gulf manual workers.
     */
    vo2maxMale: { at25: 48, perYear: -0.5, sd: 7, min: 25, max: 62 },
    vo2maxFemale: { at25: 37.6, perYear: -0.45, sd: 6, min: 20, max: 52 },
    /** HRmax = 208 − 0.7·age (Tanaka, Monahan & Seals 2001, J Am Coll Cardiol 37:153–156); individual residual SD [ASSUMPTION] (0 = the formula exactly, as SIMULATION.md §2.1). */
    hrMaxIntercept: 208,
    hrMaxPerYear: -0.7,
    hrMaxResidualSdBpm: 0,
    /** Resting HR when the profile has none: normal(68, 8) clamped to 48–95 — SIMULATION.md §2.1, data/workforce.ts COHORT_PARAMS.restingHrBpm [ENG]. */
    hrRestMean: 68,
    hrRestSd: 8,
    hrRestMin: 48,
    hrRestMax: 95,
    /** Fail-safe anthropometry when the profile has none: 75 kg / 175 cm (ARCHITECTURE.md §5); age = COHORT_PARAMS mean 34 [ENG]. */
    defaultMassKg: 75,
    defaultHeightCm: 175,
    defaultAgeYears: 34,
    /** Individual variation of the sweating gain (multiplier, normal SD) [ASSUMPTION]. */
    sweatGainSd: 0.15,
    sweatGainMin: 0.6,
    sweatGainMax: 1.5,
    /** Sweat sodium, mmol/L, unacclimatised: normal(45, 15) clamped 15–90 [ASSUMPTION; typical 20–80 mmol/L, Baker 2017 Sports Med 47 Suppl 1 — UNVERIFIED]. */
    sweatSodiumMean: 45,
    sweatSodiumSd: 15,
    sweatSodiumMin: 15,
    sweatSodiumMax: 90,
    /** Spread (σ_ln) of the individual speed of acclimatisation (τ multiplier) [ASSUMPTION]. */
    acclimTauSigmaLn: 0.3,
    /** Spread (σ_ln) of the individual latent-illness propensity [ASSUMPTION]. */
    illnessSigmaLn: 0.5,
    /**
     * Individual drinking baseline, mL/h: median 450 — the intake observed over hot outdoor shifts, Bates & Schneider
     * 2008 (J Occup Med Toxicol 3:21): 5.44 L per 12-h shift; σ_ln 0.3 [ASSUMPTION]. It sets the worker's habitual
     * (non-sweating) floor through behaviour.habitualDrinkFraction; in the heat the sweat-replacement term drives intake.
     */
    drinkBaselineMedianMlPerH: 450,
    drinkBaselineSigmaLn: 0.3,
    /** Fraction of recent sweat loss replaced by voluntary drinking: normal(0.6, 0.15) clamped 0.2–1 [ASSUMPTION; involuntary dehydration — Greenleaf 1992, UNVERIFIED]. */
    replacementMean: 0.6,
    replacementSd: 0.15,
    replacementMin: 0.2,
    replacementMax: 1,
    /** Individual factors (σ_ln, median 1) on reminder compliance, self-report and check-in response probabilities [ASSUMPTION]. */
    complianceSigmaLn: 0.3,
    selfReportSigmaLn: 0.4,
    respondSigmaLn: 0.2,
    /** Individual susceptibility to symptoms (hazard multiplier, σ_ln) [ASSUMPTION]. */
    susceptibilitySigmaLn: 0.5,
    /** Individual position offset on MRT in the sun, °C: normal(0, 1.5) clamped −3…+4 [ASSUMPTION]. */
    microclimateSdC: 1.5,
    microclimateMinC: -3,
    microclimateMaxC: 4,
    /** Self-pacing propensity, uniform [min, max] [ASSUMPTION; self-pacing is protective — Miller & Bates 2007, Miller et al. 2011]. */
    selfPacingMin: 0.2,
    selfPacingMax: 1,
    /**
     * Wrist PPG: per-worker bias SD (bpm), noise SD median (bpm) and spread, dropout propensity spread [ASSUMPTION;
     * wrist optical HR error grows with motion — Bent et al. 2020, npj Digit Med 3:18, magnitudes UNVERIFIED].
     */
    ppgBiasSdBpm: 2,
    ppgNoiseMedianBpm: 3,
    ppgNoiseSigmaLn: 0.3,
    ppgDropoutSigmaLn: 0.4,
  },
  /** True heat acclimatisation (SIMULATION.md §2.1) and its effects at full acclimatisation. */
  acclimatisation: {
    /**
     * Induction time constant, days: ≈ 75–80 % of adaptations within the first 4–7 days (Périard, Racinais & Sawka
     * 2015, Scand J Med Sci Sports 25 Suppl 1:20–38) → τ = 5 d / ln 4 ≈ 3.6 d [derived; UNVERIFIED percentages].
     */
    inductionTauDays: 3.6,
    /** Faster re-induction in workers who completed a previous hot season (τ ×) [ASSUMPTION; NIOSH 2016 gives them a faster schedule]. */
    experiencedTauFactor: 0.7,
    /** Decay per day away from heat (fraction of full acclimatisation): ≈ 2.5 %/day — Daanen et al. 2018, Sports Med 48:409–430 (UNVERIFIED). */
    decayPerDayAway: 0.025,
    /** Below this true fraction a worker counts as unacclimatised for the 38.0 °C event threshold [ASSUMPTION]. */
    unacclimatisedBelow: 0.5,
    /** Sweating-gain increase at full acclimatisation (× (1 + 0.25·A)) [ASSUMPTION magnitude; direction Périard 2015]. */
    sweatGainIncrease: 0.25,
    /** Core set-point shift at full acclimatisation, °C [ASSUMPTION magnitude; lower resting core and sweating threshold — Périard 2015]. */
    setpointShiftC: -0.25,
    /** Maximum sweat-rate increase at full acclimatisation (Gagge max 500 g/(m²·h) × (1 + 0.3·A)) [ASSUMPTION]. */
    maxSweatingIncrease: 0.3,
    /** Sweat sodium reduction at full acclimatisation [ASSUMPTION; aldosterone-mediated sodium conservation]. */
    sweatSodiumReduction: 0.3,
    /**
     * Maximum skin wettedness: 0.85 unacclimatised → 1.0 acclimatised (the ISO 7933:2004 values; Candas, Libert & Vogt
     * 1979) [ASSUMPTION in the two-node model: Gagge's default 0.59·v^−0.08 is a comfort-study value].
     */
    wMaxUnacclimatised: 0.85,
    wMaxAcclimatised: 1.0,
  },
  /** Latent illness (SIMULATION.md §2.1): small daily probability; invisible to the engine unless declared. */
  illness: {
    /** Daily probabilities per worker (× individual propensity) [ASSUMPTION]. */
    dailyProbFebrile: 0.004,
    dailyProbGi: 0.004,
    /** Febrile set-point rise, °C [ASSUMPTION: low-grade fever]. */
    febrileSetpointShiftC: 0.5,
    /** GI illness: extra body-mass deficit at shift start, % [ASSUMPTION]. */
    giStartDehydrationPct: 1.5,
    /** Symptom-hazard multiplier while ill ("lowers tolerance") [ASSUMPTION]. */
    hazardMultiplier: 2,
  },
  /** Hydration balance and its effects. */
  hydration: {
    /**
     * Probability of starting the shift hypohydrated: Bates, Miller & Joubert 2010 (Ann Occup Hyg 54:137–143) found
     * Usg ≥ 1.026 in ≈ 27–31 % of samples at UAE construction sites and 14–15 % at industrial sites
     * (docs/research/twl_and_regulation.md) — 0.25 as a blended value [ASSUMPTION].
     */
    startHypohydratedProb: 0.25,
    /** Deficit when hypohydrated, % body mass, uniform [ASSUMPTION]; otherwise uniform 0–otherMax. */
    startDeficitHypoMinPct: 1.0,
    startDeficitHypoMaxPct: 2.5,
    startDeficitOtherMaxPct: 0.5,
    /**
     * Core set-point rise per 1 % body-mass loss, °C: hypohydration raises core temperature ≈ 0.1–0.2 °C per 1 %
     * (Montain & Coyle 1992, J Appl Physiol 73:1340–1350; Sawka et al. 2007, ACSM position stand "Exercise and fluid
     * replacement", Med Sci Sports Exerc 39:377–390; TB MED 507 (2022) Para 2-3f: ≈ 0.36 °F = 0.2 °C per 1 %,
     * docs/research/limits_and_workrest.md). With the sweat-gain loss below this gives ≈ 0.15 °C/% in compensable heat.
     */
    dehydSetpointCPerPct: 0.15,
    /** Sweating-gain loss per 1 % body-mass loss (hypohydration raises the sweating threshold and lowers sensitivity — Montain, Latzka & Sawka 1995, J Appl Physiol 79:1434–1439) [ASSUMPTION magnitude]. */
    dehydSweatGainLossPerPct: 0.03,
    /** Excess body water above euhydration is excreted (deficit floored at 0) [ASSUMPTION]. */
    deficitFloorMl: 0,
    /** Thirst (T0 cue) appears at ≥ 1 % and clears below 0.5 % body-mass loss [ASSUMPTION; thirst lags losses, Greenleaf 1992 — UNVERIFIED]. */
    thirstOnsetPct: 1.0,
    thirstResolvePct: 0.5,
  },
  /** Microclimate around the worker. */
  environment: {
    /** Air speed at body height ÷ 2-m wind: log profile 1.1 m vs 2 m, z₀ ≈ 0.03 m → 0.86 [ASSUMPTION]. */
    bodyWindFactor: 0.85,
    /** Air-conditioned rest room [ASSUMPTION]. */
    indoorTaC: 25,
    indoorRhPct: 50,
    indoorVMs: 0.2,
    /** Standard pressure when none is given, hPa. */
    defaultPHpa: 1013.25,
  },
  /** Human mean radiant temperature (SIMULATION.md §1: Thorsson 2007 / Di Napoli 2020 with the projected-area factor). */
  mrt: {
    /** Shortwave absorptivity and longwave emissivity of the body; angle factor — Di Napoli et al. 2020 / thermofeel 2.3.0. */
    absorptivity: 0.7,
    emissivity: 0.97,
    angleFactor: 0.5,
    /** Stefan–Boltzmann constant as used by thermofeel, W/(m²·K⁴). */
    sigma: 0.0000000567,
    /** HOT GROUND: surface = Ta + k·GHI in the sun, K per W/m² [ASSUMPTION; brief range 0.015–0.02]. */
    groundKPerWm2: 0.0175,
    /** Ground emissivity [ASSUMPTION]. */
    groundEmissivity: 0.95,
    /** Ground albedo of industrial concrete/sand yards [ASSUMPTION; typical 0.2–0.35]. */
    albedo: 0.25,
    /** DNI cap at grazing sun, W/m² [ENG]. */
    dniMaxWm2: 1100,
    /** Shade structure: open-sky view factor, canopy underside above air temperature, sunlit ground in view, shaded-ground heating [ASSUMPTION]. */
    shadeSkyViewFactor: 0.3,
    shadeCanopyExcessK: 3,
    shadeCanopyEmissivity: 0.95,
    shadeSunlitGroundFraction: 0.5,
    shadeGroundKPerWm2: 0.003,
    /** Site radiantBoostC (globe °C) → MRT °C in the sun, and the fraction applied in shade [ASSUMPTION]. */
    siteBoostToMrt: 1.5,
    shadeBoostFraction: 0.5,
  },
  /** Clothing → Gagge clo and vapour permeation i_cl. clo = engine/limits.ts CLOTHING[id].phs.clo (+ hood). */
  clothing: {
    /**
     * i_cl = 0.45 (Gagge) × (imst / 0.38) × factor: permeability factors ordered by the ACGIH clothing adjustment values
     * (CAV 0 → 1; SMS 0.5; polyolefin 1; double layer 3; vapour barrier 11) [ASSUMPTION magnitudes].
     */
    iclFactor: {
      work_clothes: 1,
      cloth_coveralls: 1,
      fr_coveralls: 0.9,
      sms_coveralls: 0.85,
      polyolefin_coveralls: 0.7,
      double_layer: 0.75,
      vapour_barrier: 0.25,
    } as Record<ClothingId, number>,
    /** ISO 7933 reference static moisture permeability index. */
    referenceImst: 0.38,
    /** Hood: extra insulation (clo) and permeability factor [ASSUMPTION; ACGIH adds 1 °C WBGT for a hood]. */
    hoodCloAdd: 0.1,
    hoodIclFactor: 0.9,
    /**
     * Dynamic clothing (wind and body movement "pumping"): ISO 9920:2007 corrections — total insulation
     * CORR_tot = exp(0.043 − 0.398·v + 0.066·v² − 0.378·w + 0.094·w²) (Holmér et al. 1999, Ann Occup Hyg 43:329–337),
     * boundary layer CORR_a = exp(−0.533·(v − 0.15) + 0.069·(v − 0.15)² − 0.462·w + 0.201·w²), permeability
     * i_m,dyn = min(0.9, i_m·(2.6·CORR_tot² − 6.5·CORR_tot + 4.9)) (Havenith et al. 1999, Ann Occup Hyg 43:339–346) —
     * applied to Gagge's intrinsic clothing layer (the two-node model has its own wind-dependent air layer) [ASSUMPTION
     * mapping]. Without it the static comfort-model clothing makes light outdoor work uncompensable, contradicting Gulf
     * field data (Bates & Schneider 2008; Miller et al. 2011). Switchable for sweeps.
     */
    dynamicCorrection: true,
    /** Static boundary-layer insulation, clo (ISO 9920), and the v / w validity caps, m/s. */
    staticAirClo: 0.7,
    maxRelativeAirMs: 3,
    maxWalkMs: 1.5,
    /** Walking-speed equivalent of body movement during work, m/s [ASSUMPTION; 0 at rest]. */
    workWalkSpeedMs: 0.3,
    /** Floors on the intrinsic insulation and vapour-resistance ratios [ENG]. */
    minInsulationRatio: 0.3,
    minVapourRatio: 0.1,
  },
  /** Heart rate (SIMULATION.md §2.3). */
  hr: {
    /** Respiratory quotient for the oxygen energy equivalent EE = (0.23·RQ + 0.77)·5.88 Wh/L (ISO 8996:2004 oxygen-consumption method; RQ [ASSUMPTION]). */
    rq: 0.85,
    /** Resting VO₂, mL·kg⁻¹·min⁻¹ (1 MET, ACSM). */
    vo2RestMlKgMin: 3.5,
    /**
     * Thermal drift, bpm per °C core above rest [ASSUMPTION; SIMULATION.md §2.3 range 25–35, lower end because the
     * reference is the resting core, so the term also carries the exercise-induced rise that %VO₂R already reflects].
     */
    kTBpmPerC: 25,
    /**
     * Dehydration drift, bpm per 1 % body-mass loss [ASSUMPTION; SIMULATION.md §2.3 range 3–5, lower end because part of
     * the ≈ 5 bpm/% total in TB MED 507 Para 2-3f is already carried by the core-temperature term].
     */
    kDBpmPerPct: 3,
    /** Slow physiological fluctuation ε: AR(1) SD and time constant [ASSUMPTION]. */
    epsSdBpm: 2,
    epsTauMin: 5,
    /** Output clamp: floor, and margin above HRmax [ENG]. */
    minBpm: 35,
    overMaxBpm: 5,
  },
  /** Wrist PPG wearable (SIMULATION.md §2.3); all [ASSUMPTION] unless stated. */
  wearable: {
    /** Sensitivity sweep multipliers (SIMULATION.md §5: PPG noise ×1 / ×2; dropout robustness). */
    noiseMultiplier: 1,
    dropoutMultiplier: 1,
    /** Probability that a whole minute delivers nothing (robustness sweep 0 / 0.2 / 0.5 / 1). */
    minuteLossProb: 0,
    /** Noise SD multiplier during arm work, and AR(1) coefficient per second (device smoothing). */
    motionNoiseFactor: 1.8,
    noiseAr1: 0.7,
    /** Two-state Markov dropout chain per second: P(ok→drop), P(drop→ok) (≈ 1 % of seconds, 5-s bursts at rest). */
    dropoutOnPerS: 0.002,
    dropoutOffPerS: 0.2,
    /** Dropout onset × during arm work and dust; burst length × during arm work. */
    armWorkDropoutFactor: 6,
    dustDropoutFactor: 2,
    armWorkBurstFactor: 1.5,
    /** Cadence lock (reading locks to 2× or ½× rate for 5–10 s) — onset per second during arm work. */
    cadenceLockPerS: 0.0015,
    cadenceMinS: 5,
    cadenceMaxS: 10,
    cadenceDoubleProb: 0.5,
    /** Off-skin periods: onset per minute (× during arm work), duration range, seconds. */
    offSkinPerMin: 0.002,
    offSkinArmWorkFactor: 2,
    offSkinMinS: 30,
    offSkinMaxS: 240,
    /** Share of off-skin seconds that still report a spurious reading (uniform integer range, contactOk false), as loose PPG devices do. */
    offSkinSpuriousProb: 0.5,
    offSkinSpuriousMinBpm: 45,
    offSkinSpuriousMaxBpm: 160,
    /** Samples per minute (1 Hz) — the expected interval for engine/physio.ts minuteSqi is 1 s. */
    samplesPerMinute: 60,
  },
  /** Self-pacing (SIMULATION.md §2.1) — identical under every policy. */
  selfPacing: {
    enabled: true,
    /** Strain triggers: core ≥ 38.2 °C (TWL design limit, Brake & Bates 2002) or HR reserve fraction ≥ 0.65 [ASSUMPTION; Miller et al. 2011: workers self-regulated HR below ≈ 110 bpm]. */
    coreTriggerC: 38.2,
    hrrTrigger: 0.65,
    /** Per-minute probability of slowing (× individual propensity) and the work-rate factor while slowed [ASSUMPTION]. */
    slowProbPerMin: 0.15,
    slowFactor: 0.6,
    /** Resume full pace: core below trigger − hysteresis, HRR below resumeHrr, per-minute probability [ASSUMPTION]. */
    resumeHysteresisC: 0.3,
    resumeHrr: 0.5,
    resumeProbPerMin: 0.1,
  },
  /** Drinking behaviour (SIMULATION.md §2.1). */
  behaviour: {
    /** Volume of one spontaneous drink, mL [ASSUMPTION ≈ engine/clinical.ts FLUID.REMINDER_L]. */
    cupMl: 250,
    /** Volume drunk when a reminder is followed, mL (FLUID.REMINDER_L = 0.25 L). */
    reminderMl: 250,
    /** Population compliance with drink reminders [ASSUMPTION; swept 0.5 / 0.7 / 0.9 in SIMULATION.md §5]. */
    reminderCompliance: 0.7,
    /**
     * Habitual drinking floor when the worker is not sweating (e.g. resting in a cooled cabin), as a fraction of the
     * individual baseline: 0.4 × 450 ≈ 180 mL/h median ≈ the IOM (2004) adequate beverage intake for men (≈ 3.0 L/day,
     * ≈ 81 % of the 3.7 L total-water AI) spread over ≈ 16 waking hours (≈ 190 mL/h) [ASSUMPTION]. The 450 mL/h
     * observation is an intake over hot shifts, so it is not applied to hours of cooled rest.
     */
    habitualDrinkFraction: 0.4,
    /** Drinking-rate multiplier on breaks, and thirst gain per % above the thirst threshold [ASSUMPTION]. */
    breakDrinkFactor: 2,
    thirstGainPerPct: 0.5,
    /** Time constant of the recent sweat-rate average that drives voluntary replacement, min [ENG]. */
    sweatEmaMin: 30,
    /** A minute counts as rest when the metabolic rate is ≤ this × the rest rate (115 W) [ENG]. */
    restFactor: 1.1,
  },
  /** Symptoms (SIMULATION.md §2.4) — all hazards [ASSUMPTION], swept via hazardScale. */
  symptoms: {
    hazardScale: 1,
    heatExhaustion: {
      /** Hazard is zero unless core > coreC or dehydration > dehydPct. */
      coreC: 38.0,
      dehydPct: 1.5,
      /** h = base·exp(βT·(T − 38))·exp(βD·max(0, D − 1.5)) per minute. */
      baseHazardPerMin: 0.001,
      betaCorePerC: 2.5,
      betaDehydPerPct: 0.5,
      /** Persists until cooled and rehydrated: core < 37.8 and dehydration < 1.5 % for 15 min. */
      resolveCoreC: 37.8,
      resolveDehydPct: 1.5,
      resolveAfterMin: 15,
      /** Probability of a second cluster symptom at onset, and the relative weights of the cluster symptoms. */
      extraSymptomProb: 0.35,
      weights: { weakness_fatigue: 0.35, headache: 0.3, dizziness: 0.2, nausea: 0.15 },
    },
    cramps: {
      /** h = base·(Na/ref)^exp·exp(βD·D) per WORKING minute once Na ≥ minSodium (mmol) — exercise-associated cramps need muscle work [ASSUMPTION]; no sodium intake is modelled. */
      baseHazardPerMin: 0.0001,
      sodiumRefMmol: 150,
      sodiumExponent: 2,
      minSodiumMmol: 40,
      betaDehydPerPct: 0.3,
      /** Resolve after 20 min at rest; 'cramps_persistent' after 60 min (clinical.ts TRIAGE_TIMING.CRAMPS_PERSISTENT_MIN). */
      resolveRestMin: 20,
      persistentAfterMin: 60,
    },
    cns: {
      /** CNS dysfunction: probabilistic from 39.5 °C (linear ramp to maxHazard), certain at ≥ 40 °C (SIMULATION.md §2.4). */
      fromC: 39.5,
      certainC: 40.0,
      maxHazardPerMin: 0.1,
      /** Signs persist until core < 38.5 °C for 30 min [ASSUMPTION]. */
      resolveCoreC: 38.5,
      resolveAfterMin: 30,
      /** Signs at onset besides confusion. */
      unsteadyProb: 0.6,
      slurredProb: 0.4,
      collapseProb: 0.2,
    },
  },
  /** Reporting (SIMULATION.md §2.4) — all [ASSUMPTION], swept in §5. */
  reporting: {
    /** Self-report at onset (× individual factor); never for CNS signs or thirst. */
    pSelf: 0.4,
    /** Answers a prompted check-in (× individual factor). */
    pRespond: 0.85,
    /** Discloses each active symptom when answering. */
    pDisclose: 0.9,
    /** A buddy notices CNS signs, per minute. */
    pBuddyNoticePerMin: 0.15,
    /** Urine shade ≈ base + perPct·dehydration% + N(0, sd), clamped 1–8 (Armstrong 8-shade chart) [ASSUMPTION mapping]. */
    urineBase: 2,
    urinePerPct: 1.5,
    urineSd: 0.7,
  },
  /** Ground-truth event definitions (SIMULATION.md §2.4 table). */
  events: {
    /** Excessive heat strain: ≥ 38.5 °C (38.0 °C if unacclimatised) sustained ≥ 10 min — ACGIH heat-strain criteria; WHO 38 °C. */
    excessiveC: 38.5,
    excessiveUnacclimatisedC: 38.0,
    sustainMin: 10,
    /** Severe strain ≥ 39.5 °C — NIOSH hyperthermia classes. */
    severeC: 39.5,
    /** Critical ≥ 40.0 °C or CNS dysfunction — TB MED 507 / ACSM heat-stroke threshold. */
    criticalC: 40.0,
    /** Dehydration: body-mass loss > 3 % — Armstrong; ACSM fluid guidance. */
    dehydrationPct: 3,
  },
  /** First-aid cooling applied by the world simulation (extension) — core-cooling rates, °C/min. */
  cooling: {
    /** Cold-water immersion ≥ 0.15 °C/min (ACSM 2023 consensus; Casa et al. 2007) — UNVERIFIED rate. */
    immersionCPerMin: 0.15,
    /** Dousing / rotating wet towels [ASSUMPTION]. */
    towelsCPerMin: 0.05,
    /** Cooling stops at this core temperature [ASSUMPTION]. */
    floorC: 37.5,
    /** Skin temperature during active cooling, °C [ASSUMPTION]. */
    skinC: 30,
  },
}

/** Type of {@link TRUTH_PARAMS} (numbers widened so a sweep can override any value). */
export type TruthParams = typeof DEFAULT_PARAMS

/** Recursive partial, for {@link withTruthParams} overrides. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as object)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

function deepMerge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue
    const b = (base as Record<string, unknown>)[k]
    out[k] = v && typeof v === 'object' && b && typeof b === 'object' ? deepMerge(b, v as DeepPartial<typeof b>) : v
  }
  return out as T
}

/**
 * Every ground-truth parameter, each with its citation or an [ASSUMPTION] / [ENG] tag (deep-frozen). The back-test
 * sweeps them through {@link withTruthParams}. Basis: docs/SIMULATION.md §2 and the citations on each field.
 */
export const TRUTH_PARAMS: TruthParams = deepFreeze(DEFAULT_PARAMS)

/** Returns a new parameter set: `base` (default {@link TRUTH_PARAMS}) deep-merged with `overrides` (for sweeps). */
export function withTruthParams(overrides: DeepPartial<TruthParams>, base: TruthParams = TRUTH_PARAMS): TruthParams {
  return deepMerge(base, overrides)
}

// ─────────────────────────────── Small helpers ───────────────────────────────

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const clamp01 = (x: number): number => clamp(x, 0, 1)
const MINUTE_MS = 60_000
const DEG = Math.PI / 180

/** Standard normal from two uniforms in [0, 1) (Box–Muller, no caching, so the draw count per minute is fixed). */
function normalFrom(u1: number, u2: number): number {
  const a = u1 > 1e-300 ? u1 : 1e-300
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u2)
}

// ─────────────────────────────── Hidden traits ───────────────────────────────

/** Hidden individual parameters of one virtual worker (SIMULATION.md §2.1). The engine never sees these. */
export interface HiddenTraits {
  workerId: string
  sex: 'male' | 'female'
  ageYears: number
  massKg: number
  heightCm: number
  /** DuBois body surface area, m². */
  bsaM2: number
  /** True metabolic rate = task rate × this (log-normal, median 1). */
  metabolicMultiplier: number
  vo2maxMlKgMin: number
  hrMaxBpm: number
  hrRestBpm: number
  /** Individual multiplier on the acclimatisation time constant. */
  acclimTauFactor: number
  /** True acclimatisation fraction 0–1 for the profile as sampled (initTruth recomputes it from the day's profile). */
  acclimFraction: number
  /** Individual sweating-gain multiplier (before acclimatisation). */
  sweatGainMultiplier: number
  /** Sweat sodium concentration, mmol/L (before acclimatisation). */
  sweatSodiumMmolL: number
  /** Multiplier on the daily latent-illness probabilities. */
  illnessPropensity: number
  baselineDrinkMlPerH: number
  /** Fraction of recent sweat loss replaced by voluntary drinking. */
  sweatReplacementFraction: number
  /** Multiplier on the population reminder compliance. */
  complianceFactor: number
  /** Position offset on MRT in the sun, °C. */
  microclimateOffsetC: number
  /** 0–1 scale on the probability of slowing down under strain. */
  selfPacingPropensity: number
  /** Multiplier on symptom hazards. */
  symptomSusceptibility: number
  /** Multipliers on the self-report and check-in response probabilities. */
  selfReportFactor: number
  respondFactor: number
  /** Wrist PPG: bias (bpm), noise SD (bpm), dropout propensity multiplier. */
  ppgBiasBpm: number
  ppgNoiseSdBpm: number
  ppgDropoutFactor: number
}

/**
 * True acclimatisation fraction from the work history: residual from a previous season decays linearly while away
 * (2.5 %/day, Daanen 2018), then induction 1 − (1 − a₀)·exp(−d/τ) over the days already worked in this stretch
 * (daysOnSite − 1; τ ≈ 3.6 d, Périard 2015; faster for experienced workers) — see TRUTH_PARAMS.acclimatisation.
 */
export function trueAcclimatizationFraction(
  profile: Pick<WorkerProfile, 'daysOnSite' | 'daysAwayRecent' | 'experiencedInHeat'>,
  traits: Pick<HiddenTraits, 'acclimTauFactor'>,
  params: TruthParams = TRUTH_PARAMS,
): number {
  const P = params.acclimatisation
  const prior = profile.experiencedInHeat ? clamp01(1 - P.decayPerDayAway * Math.max(0, profile.daysAwayRecent)) : 0
  const tau = P.inductionTauDays * traits.acclimTauFactor * (profile.experiencedInHeat ? P.experiencedTauFactor : 1)
  const days = Math.max(0, profile.daysOnSite - 1)
  return clamp01(1 - (1 - prior) * Math.exp(-days / Math.max(1e-6, tau)))
}

/**
 * Draws a worker's hidden traits (SIMULATION.md §2.1). A fixed number of draws is taken in a fixed order, and
 * truncation is by clamping [ENG], so the same seed gives the same underlying deviates under any parameter sweep.
 * Missing profile fields fall back to male (96 % of the cohort, COHORT_PARAMS), age 34, 75 kg, 175 cm [ENG].
 * Distributions and citations: TRUTH_PARAMS.traits.
 */
export function sampleHiddenTraits(profile: WorkerProfile, rng: Rng, params: TruthParams = TRUTH_PARAMS): HiddenTraits {
  const T = params.traits
  const z = (): number => rng.normal(0, 1)
  const zMet = z(), zVo2 = z(), zHrRest = z(), zHrMax = z(), zTau = z(), zGain = z(), zNa = z(), zIll = z()
  const zDrink = z(), zRepl = z(), zComp = z(), zMicro = z(), uPace = rng.next(), zSusc = z(), zSelf = z(), zResp = z()
  const zBias = z(), zNoise = z(), zDrop = z()

  const sex = profile.sex ?? 'male'
  const ageYears = profile.ageYears ?? T.defaultAgeYears
  const massKg = profile.massKg ?? T.defaultMassKg
  const heightCm = profile.heightCm ?? T.defaultHeightCm
  const v = sex === 'female' ? T.vo2maxFemale : T.vo2maxMale
  const traits: HiddenTraits = {
    workerId: profile.id,
    sex,
    ageYears,
    massKg,
    heightCm,
    bsaM2: duboisBsaM2(massKg, heightCm),
    metabolicMultiplier: clamp(Math.exp(T.metabolicSigmaLn * zMet), T.metabolicMin, T.metabolicMax),
    vo2maxMlKgMin: clamp(v.at25 + v.perYear * (ageYears - 25) + v.sd * zVo2, v.min, v.max),
    hrMaxBpm: T.hrMaxIntercept + T.hrMaxPerYear * ageYears + T.hrMaxResidualSdBpm * zHrMax,
    hrRestBpm: profile.restingHrBpm ?? clamp(T.hrRestMean + T.hrRestSd * zHrRest, T.hrRestMin, T.hrRestMax),
    acclimTauFactor: Math.exp(T.acclimTauSigmaLn * zTau),
    acclimFraction: 0,
    sweatGainMultiplier: clamp(1 + T.sweatGainSd * zGain, T.sweatGainMin, T.sweatGainMax),
    sweatSodiumMmolL: clamp(T.sweatSodiumMean + T.sweatSodiumSd * zNa, T.sweatSodiumMin, T.sweatSodiumMax),
    illnessPropensity: Math.exp(T.illnessSigmaLn * zIll),
    baselineDrinkMlPerH: T.drinkBaselineMedianMlPerH * Math.exp(T.drinkBaselineSigmaLn * zDrink),
    sweatReplacementFraction: clamp(T.replacementMean + T.replacementSd * zRepl, T.replacementMin, T.replacementMax),
    complianceFactor: Math.exp(T.complianceSigmaLn * zComp),
    microclimateOffsetC: clamp(T.microclimateSdC * zMicro, T.microclimateMinC, T.microclimateMaxC),
    selfPacingPropensity: T.selfPacingMin + (T.selfPacingMax - T.selfPacingMin) * uPace,
    symptomSusceptibility: Math.exp(T.susceptibilitySigmaLn * zSusc),
    selfReportFactor: Math.exp(T.selfReportSigmaLn * zSelf),
    respondFactor: Math.exp(T.respondSigmaLn * zResp),
    ppgBiasBpm: T.ppgBiasSdBpm * zBias,
    ppgNoiseSdBpm: T.ppgNoiseMedianBpm * Math.exp(T.ppgNoiseSigmaLn * zNoise),
    ppgDropoutFactor: Math.exp(T.ppgDropoutSigmaLn * zDrop),
  }
  traits.acclimFraction = trueAcclimatizationFraction(profile, traits, params)
  return traits
}

/** Per-day hidden condition: latent illness and pre-shift hydration. */
export interface DailyCondition {
  illness: 'none' | 'febrile' | 'gi'
  /** Body-mass deficit at shift start, % (pre-shift hypohydration, plus GI losses). */
  startDehydrationPct: number
}

/** A healthy, euhydrated day (the {@link initTruth} default). */
export const HEALTHY_DAY: Readonly<DailyCondition> = Object.freeze({ illness: 'none', startDehydrationPct: 0 })

/**
 * Draws one day's latent illness (febrile / GI, small daily probability × individual propensity) and pre-shift
 * hypohydration (Bates, Miller & Joubert 2010 prevalence) — TRUTH_PARAMS.illness / .hydration. Three uniforms per call.
 */
export function sampleDailyCondition(traits: HiddenTraits, rng: Rng, params: TruthParams = TRUTH_PARAMS): DailyCondition {
  const I = params.illness
  const H = params.hydration
  const u1 = rng.next(), u2 = rng.next(), u3 = rng.next()
  const pF = I.dailyProbFebrile * traits.illnessPropensity
  const pG = I.dailyProbGi * traits.illnessPropensity
  const illness: DailyCondition['illness'] = u1 < pF ? 'febrile' : u1 < pF + pG ? 'gi' : 'none'
  let deficit = u2 < H.startHypohydratedProb
    ? H.startDeficitHypoMinPct + (H.startDeficitHypoMaxPct - H.startDeficitHypoMinPct) * u3
    : H.startDeficitOtherMaxPct * u3
  if (illness === 'gi') deficit += I.giStartDehydrationPct
  return { illness, startDehydrationPct: deficit }
}

// ─────────────────────────────── Radiation: human MRT ───────────────────────────────

/** Where the worker is this minute. */
export type TruthLocation = 'sun' | 'shade' | 'indoor_cool'

/** Radiation fluxes seen by a standing person, W/m² (thermofeel naming in brackets). */
export interface MrtFluxes {
  /** Downward longwave [strd]. */
  lwDownWm2: number
  /** Upward longwave from the ground [strd − strr]. */
  lwUpWm2: number
  /** Diffuse horizontal shortwave [ssrd − fdir]. */
  diffuseWm2: number
  /** Reflected shortwave from the ground [ssrd − ssr]. */
  reflectedWm2: number
  /** Direct normal irradiance [dsrp]. */
  dniWm2: number
  cosZenith: number
}

/**
 * Mean radiant temperature of a standing person from radiation fluxes, °C — Di Napoli et al. 2020 (Int J Biometeorol
 * 64:1233–1245) as implemented in thermofeel 2.3.0 `calculate_mean_radiant_temperature`:
 * MRT⁴ = (1/σ)·[f_a·L↓ + f_a·L↑ + (α/ε)·(f_a·D + f_a·R + f_p·I*)], f_a = 0.5, α = 0.7, ε = 0.97,
 * f_p = 0.308·cos(γ·(0.998 − γ²/50000)) with γ the solar elevation in degrees (Jendritzky projected-area factor).
 * Parity: fixtures/gagge.json `mrt`.
 */
export function humanMrtFromFluxesC(f: MrtFluxes, params: TruthParams['mrt'] = TRUTH_PARAMS.mrt): number {
  const gamma = Math.asin(clamp(f.cosZenith, -1, 1)) / DEG
  const fp = 0.308 * Math.cos(DEG * gamma * (0.998 - (gamma * gamma) / 50000))
  const fa = params.angleFactor
  const s =
    (1 / params.sigma) *
    (fa * f.lwDownWm2 + fa * f.lwUpWm2 + (params.absorptivity / params.emissivity) * (fa * f.diffuseWm2 + fa * f.reflectedWm2 + fp * f.dniWm2))
  return Math.pow(Math.max(s, 0), 0.25) - 273.15
}

/** Inputs for {@link truthHumanMrtC}. */
export interface TruthMrtInputs {
  taC: number
  rhPct: number
  /** Instantaneous global horizontal irradiance, W/m². */
  ghiWm2: number
  /** Direct fraction of GHI (direct horizontal / GHI), 0–1. */
  fdir: number
  cosZenith: number
  location: TruthLocation
  /** Site extra radiant load (Site.radiantBoostC, globe °C). */
  siteRadiantBoostC?: number
  /** Individual position offset (HiddenTraits.microclimateOffsetC), °C. */
  microclimateOffsetC?: number
}

/**
 * Ground-truth human MRT, °C. Sun: full beam on the projected area, diffuse sky, ground reflection (albedo) and a HOT
 * GROUND (surface = Ta + k·GHI, k ≈ 0.0175 K per W/m² [ASSUMPTION]) — deliberately different from the engine, whose
 * Liljegren globe model puts the ground at air temperature. Shade: beam blocked, partial sky view, a canopy slightly
 * above air temperature, half the ground in view still sunlit. Indoor: MRT = the air-conditioned room temperature.
 * Site radiant boost (× 1.5 globe → MRT) and the individual offset are added in the sun (half in shade).
 * Sky longwave: clear-sky emissivity 0.575·e^0.143 (engine/wbgt.ts atmosphericEmissivity, Oke).
 * Basis: SIMULATION.md §1; Di Napoli et al. 2020; Thorsson et al. 2007; TRUTH_PARAMS.mrt.
 */
export function truthHumanMrtC(inp: TruthMrtInputs, params: TruthParams = TRUTH_PARAMS): number {
  if (inp.location === 'indoor_cool') return params.environment.indoorTaC
  const P = params.mrt
  const sig = P.sigma
  const taK = inp.taC + 273.15
  const lwSky = atmosphericEmissivity(taK, clamp(inp.rhPct, 1, 100) / 100) * sig * taK ** 4
  const ghi = Math.max(0, inp.ghiWm2)
  const cz = inp.cosZenith
  const fdir = clamp01(inp.fdir)
  const dirH = cz > 0.01 ? ghi * fdir : 0
  const dni = cz > 0.01 ? Math.min(P.dniMaxWm2, dirH / cz) : 0
  const diff = ghi - dirH
  const eg = P.groundEmissivity
  const groundLw = (tC: number): number => eg * sig * (tC + 273.15) ** 4
  const boost = (inp.siteRadiantBoostC ?? 0) * P.siteBoostToMrt + (inp.microclimateOffsetC ?? 0)
  if (inp.location === 'sun') {
    const lwUp = groundLw(inp.taC + P.groundKPerWm2 * ghi) + (1 - eg) * lwSky
    const mrt = humanMrtFromFluxesC({ lwDownWm2: lwSky, lwUpWm2: lwUp, diffuseWm2: diff, reflectedWm2: P.albedo * ghi, dniWm2: dni, cosZenith: cz }, P)
    return mrt + boost
  }
  const svf = P.shadeSkyViewFactor
  const f = P.shadeSunlitGroundFraction
  const lwDown = svf * lwSky + (1 - svf) * P.shadeCanopyEmissivity * sig * (taK + P.shadeCanopyExcessK) ** 4
  const lwUp = f * groundLw(inp.taC + P.groundKPerWm2 * ghi) + (1 - f) * groundLw(inp.taC + P.shadeGroundKPerWm2 * ghi) + (1 - eg) * lwDown
  const refl = P.albedo * (f * ghi + (1 - f) * svf * diff)
  const mrt = humanMrtFromFluxesC({ lwDownWm2: lwDown, lwUpWm2: lwUp, diffuseWm2: svf * diff, reflectedWm2: refl, dniWm2: 0, cosZenith: cz }, P)
  return mrt + boost * P.shadeBoostFraction
}

/** Gagge clothing inputs for an ensemble: clo from engine/limits.ts CLOTHING (+ hood) and i_cl from TRUTH_PARAMS.clothing. */
export function truthClothing(clothing: ClothingId, hood: boolean, params: TruthParams = TRUTH_PARAMS): { clo: number; icl: number } {
  const C = params.clothing
  const spec = (CLOTHING[clothing] ?? CLOTHING.cloth_coveralls).phs
  const clo = spec.clo + (hood ? C.hoodCloAdd : 0)
  const icl = GAGGE.I_CL_CLOTHED * (spec.imst / C.referenceImst) * (C.iclFactor[clothing] ?? 1) * (hood ? C.hoodIclFactor : 1)
  return { clo, icl }
}

/**
 * Dynamic (wind- and movement-corrected) Gagge clothing inputs: the ISO 9920:2007 total and boundary-layer corrections
 * (Holmér et al. 1999; Havenith et al. 1999) give the resultant intrinsic insulation I_cl,r = CORR_tot·I_T −
 * CORR_a·I_a/f_cl and intrinsic vapour resistance ∝ I_T,r/i_m,r − I_a,r/f_cl; their ratios to the static values scale
 * clo and i_cl (r_ecl = r_clo/(LR·i_cl)). Returns the static values when TRUTH_PARAMS.clothing.dynamicCorrection is off.
 */
export function truthDynamicClothing(
  stat: { clo: number; icl: number },
  imst: number,
  vArMs: number,
  walkMs: number,
  params: TruthParams = TRUTH_PARAMS,
): { clo: number; icl: number } {
  const C = params.clothing
  if (!C.dynamicCorrection || stat.clo <= 0) return stat
  const v = clamp(vArMs, 0.15, C.maxRelativeAirMs)
  const w = clamp(walkMs, 0, C.maxWalkMs)
  const corrTot = Math.min(1, Math.exp(0.043 - 0.398 * v + 0.066 * v * v - 0.378 * w + 0.094 * w * w))
  const dv = v - 0.15
  const corrA = Math.min(1, Math.exp(-0.533 * dv + 0.069 * dv * dv - 0.462 * w + 0.201 * w * w))
  const fcl = 1 + 0.15 * stat.clo
  const iA = C.staticAirClo
  const iT = stat.clo + iA / fcl
  const iTr = corrTot * iT
  const iAr = corrA * iA
  const imDyn = Math.min(0.9, imst * ((2.6 * corrTot - 6.5) * corrTot + 4.9))
  const insRatio = Math.max(C.minInsulationRatio, (iTr - iAr / fcl) / stat.clo)
  const vapStatic = iT / imst - iA / fcl
  const vapRatio = Math.max(C.minVapourRatio, (iTr / imDyn - iAr / fcl) / vapStatic)
  return { clo: stat.clo * insRatio, icl: (stat.icl * insRatio) / vapRatio }
}

// ─────────────────────────────── State ───────────────────────────────

/** Symptom clusters of SIMULATION.md §2.4 (thirst added as the T0 hydration cue). */
export type SymptomCluster = 'heat_exhaustion' | 'cramps' | 'cns' | 'thirst'

/** A symptom the virtual worker currently has. */
export interface ActiveSymptom {
  id: SymptomId
  cluster: SymptomCluster
  onsetT: number
}

/** An ongoing symptom episode. */
export interface SymptomEpisode {
  onsetT: number
  /** Consecutive minutes meeting the resolution condition. */
  recoveryRunMin: number
  /** CNS only: a buddy has already noticed the signs. */
  noticed: boolean
}

/** Ground-truth outcome kinds (SIMULATION.md §2.4 table). */
export type TruthOutcomeKind = 'excessive_strain' | 'severe_strain' | 'critical' | 'dehydration'

/** First occurrence of an outcome in this worker-shift. `onsetT` is when the condition started (start of the sustained run for excessive strain). */
export interface TruthOutcome {
  kind: TruthOutcomeKind
  t: number
  onsetT: number
  /** Core °C (or dehydration % for 'dehydration') at `t`. */
  value: number
}

/** Event log entry. */
export type TruthEvent =
  | { type: 'outcome'; t: number; outcome: TruthOutcome }
  | { type: 'symptom_onset'; t: number; cluster: SymptomCluster; symptoms: SymptomId[]; selfReported: boolean }
  | { type: 'symptom_added'; t: number; cluster: SymptomCluster; symptoms: SymptomId[] }
  | { type: 'symptom_resolved'; t: number; cluster: SymptomCluster }
  | { type: 'buddy_noticed'; t: number; symptoms: SymptomId[] }
  | { type: 'pace_change'; t: number; paceFactor: number }

/** Full ground-truth state of one worker-shift. */
export interface TruthState {
  /** Epoch ms of this state (end of the latest stepped minute). */
  t: number
  /** Minutes stepped since initTruth. */
  minute: number
  params: TruthParams
  traits: HiddenTraits
  workerId: string
  acclimFraction: number
  unacclimatised: boolean
  illness: DailyCondition['illness']
  /** Site radiant boost looked up from profile.siteId (0 when unknown). */
  siteRadiantBoostC: number
  gagge: GaggeState
  /** Resting core reference of the HR model, °C (initial core without the dehydration effect). */
  coreRestC: number
  /** Body-water deficit, mL, and as % of body mass. */
  deficitMl: number
  dehydrationPct: number
  /** Totals since initTruth, mL / mmol. */
  intakeMl: number
  waterLossMl: number
  sweatMl: number
  sodiumLossMmol: number
  /** Recent produced-sweat rate (EMA), mL/h — drives voluntary drinking. */
  sweatRateMlPerH: number
  /** Last minute's microclimate and work rate. */
  location: TruthLocation
  airC: number
  mrtC: number
  /** Effective metabolic rate after self-pacing, W. */
  effMetabolicW: number
  /** 1 = full pace; < 1 while self-paced. */
  paceFactor: number
  /** Slow physiological HR fluctuation, bpm (AR(1)). */
  hrEpsBpm: number
  symptoms: readonly ActiveSymptom[]
  episodes: { heat_exhaustion: SymptomEpisode | null; cramps: SymptomEpisode | null; cns: SymptomEpisode | null }
  /** Consecutive minutes at/above the excessive-strain threshold, and when the run started. */
  excessRunMin: number
  excessRunStartT: number | null
  /** First crossing of the 39.5 / 40 °C and dehydration thresholds (for onset bookkeeping). */
  outcomes: Partial<Record<TruthOutcomeKind, TruthOutcome>>
  maxCoreC: number
  maxDehydrationPct: number
  /** Whole-shift event log (append-only) and the events emitted by the latest stepTruth call. */
  events: readonly TruthEvent[]
  lastEvents: readonly TruthEvent[]
}

/** Options for {@link initTruth}. */
export interface InitTruthOptions {
  /** The day's latent illness and pre-shift hydration (default {@link HEALTHY_DAY}). */
  day?: DailyCondition
  params?: TruthParams
}

/** True rest metabolic rate, W (ACGIH 115 W, engine/limits.ts REST_METABOLIC_W). */
export function truthRestMetabolicW(): number {
  return REST_METABOLIC_W
}

/** True metabolic rate for a task, W: task rate (e.g. ACGIH class W) × the hidden multiplier (SIMULATION.md §1). */
export function trueMetabolicW(taskMetabolicW: number, traits: Pick<HiddenTraits, 'metabolicMultiplier'>): number {
  return taskMetabolicW * traits.metabolicMultiplier
}

function gaggeParamsFor(s: { acclimFraction: number; illness: DailyCondition['illness']; dehydrationPct: number }, traits: HiddenTraits, P: TruthParams): GaggeParams {
  const A = s.acclimFraction
  return {
    sweatGainMultiplier: traits.sweatGainMultiplier * (1 + P.acclimatisation.sweatGainIncrease * A),
    setpointShiftC: P.acclimatisation.setpointShiftC * A + (s.illness === 'febrile' ? P.illness.febrileSetpointShiftC : 0),
    dehydration: { pct: s.dehydrationPct, setpointCPerPct: P.hydration.dehydSetpointCPerPct, sweatGainLossPerPct: P.hydration.dehydSweatGainLossPerPct },
    maxSweatingGm2h: GAGGE.MAX_SWEATING * (1 + P.acclimatisation.maxSweatingIncrease * A),
  }
}

/**
 * Starts a worker-shift at `t0`: Gagge neutral state with the core shifted by acclimatisation, fever and the pre-shift
 * deficit; true acclimatisation from the day's profile (daysOnSite / daysAwayRecent); site radiant boost from
 * profile.siteId. Basis: SIMULATION.md §2; TRUTH_PARAMS.
 */
export function initTruth(profile: WorkerProfile, traits: HiddenTraits, t0: number, opts: InitTruthOptions = {}): TruthState {
  const P = opts.params ?? TRUTH_PARAMS
  const day = opts.day ?? HEALTHY_DAY
  const A = trueAcclimatizationFraction(profile, traits, P)
  const illness = day.illness
  const startPct = Math.max(0, day.startDehydrationPct)
  const coreRestC = GAGGE.T_CORE_NEUTRAL_C + P.acclimatisation.setpointShiftC * A + (illness === 'febrile' ? P.illness.febrileSetpointShiftC : 0)
  const tCore0 = coreRestC + startPct * P.hydration.dehydSetpointCPerPct
  const restW = truthRestMetabolicW()
  const siteRadiantBoostC = isSiteId(profile.siteId) ? getSite(profile.siteId).radiantBoostC : 0
  return {
    t: t0,
    minute: 0,
    params: P,
    traits,
    workerId: profile.id,
    acclimFraction: A,
    unacclimatised: A < P.acclimatisation.unacclimatisedBelow,
    illness,
    siteRadiantBoostC,
    gagge: createGaggeState({ tCoreC: tCore0, massKg: traits.massKg, initialMetabolicWm2: restW / traits.bsaM2 }),
    coreRestC,
    deficitMl: startPct * traits.massKg * 10,
    dehydrationPct: startPct,
    intakeMl: 0,
    waterLossMl: 0,
    sweatMl: 0,
    sodiumLossMmol: 0,
    sweatRateMlPerH: 0,
    location: 'shade',
    airC: NaN,
    mrtC: NaN,
    effMetabolicW: restW,
    paceFactor: 1,
    hrEpsBpm: 0,
    symptoms: [],
    episodes: { heat_exhaustion: null, cramps: null, cns: null },
    excessRunMin: 0,
    excessRunStartT: null,
    outcomes: {},
    maxCoreC: tCore0,
    maxDehydrationPct: startPct,
    events: [],
    lastEvents: [],
  }
}

// ─────────────────────────────── Heart rate ───────────────────────────────

/** VO₂ for a metabolic rate, mL·kg⁻¹·min⁻¹: V̇O₂ = M / EE, EE = (0.23·RQ + 0.77)·5.88 Wh/L (ISO 8996:2004 oxygen-consumption method). */
export function vo2FromMetabolicW(metabolicW: number, massKg: number, rq: number = TRUTH_PARAMS.hr.rq): number {
  const eeWhPerL = (0.23 * rq + 0.77) * 5.88
  return ((metabolicW / eeWhPerL) * 1000) / 60 / massKg
}

/**
 * Ground-truth heart rate, bpm (SIMULATION.md §2.3):
 * HR = HR_rest + (HR_max − HR_rest)·%VO₂R(M) + k_T·max(0, T_core − T_core,rest) + k_D·dehydration% + ε,
 * %VO₂R = (V̇O₂(M) − 3.5)/(VO₂max − 3.5) clamped 0–1 (%HRR ≈ %VO₂R — Swain & Leutholtz 1997, Med Sci Sports Exerc
 * 29:410–414), k_T = 25 bpm/°C and k_D = 3 bpm/% [ASSUMPTION, see TRUTH_PARAMS.hr], ε the state's AR(1) fluctuation.
 * This is NOT the ECTemp observation equation. `metabolicW` defaults to the state's effective (self-paced) rate.
 */
export function trueHeartRate(state: TruthState, traits: HiddenTraits, metabolicW: number = state.effMetabolicW): number {
  const H = state.params.hr
  const vo2 = vo2FromMetabolicW(metabolicW, traits.massKg, H.rq)
  const vo2r = clamp01((vo2 - H.vo2RestMlKgMin) / Math.max(1e-6, traits.vo2maxMlKgMin - H.vo2RestMlKgMin))
  const hr =
    traits.hrRestBpm +
    (traits.hrMaxBpm - traits.hrRestBpm) * vo2r +
    H.kTBpmPerC * Math.max(0, state.gagge.tCoreC - state.coreRestC) +
    H.kDBpmPerPct * state.dehydrationPct +
    state.hrEpsBpm
  return clamp(hr, H.minBpm, traits.hrMaxBpm + H.overMaxBpm)
}

// ─────────────────────────────── Stepping ───────────────────────────────

/** What the worker is doing this minute. */
export interface TruthActivity {
  /** True metabolic rate, W: task-class W × traits.metabolicMultiplier ({@link trueMetabolicW}), or rest ({@link truthRestMetabolicW}). Self-pacing is applied inside stepTruth. */
  metabolicW: number
  location: TruthLocation
  clothing: ClothingId
  hood: boolean
}

/** Conditions for the next minute(s); radiation is instantaneous (InstantEnvSample semantics). */
export interface TruthInputs {
  taC: number
  rhPct: number
  /** Wind at 2 m, m/s (HeatIndices.wind2Ms). */
  wind2Ms: number
  ghiWm2: number
  /** Direct fraction of GHI, 0–1. */
  fdir: number
  cosZenith: number
  pHpa?: number
  activity: TruthActivity
  /** Water drunk over the step, mL (spread evenly over its minutes). */
  drankMl: number
  /** Override of the site radiant boost, °C (default: the profile's site). */
  radiantBoostC?: number
  /** First-aid cooling applied this step (world simulation). */
  cooling?: 'none' | 'towels' | 'immersion'
}

const HE_SYMPTOMS = ['weakness_fatigue', 'headache', 'dizziness', 'nausea'] as const satisfies readonly SymptomId[]

function pickWeighted(u: number, items: readonly SymptomId[], weights: readonly number[], exclude?: SymptomId): SymptomId {
  let total = 0
  for (let i = 0; i < items.length; i++) if (items[i] !== exclude) total += weights[i]
  let r = u * total
  for (let i = 0; i < items.length; i++) {
    if (items[i] === exclude) continue
    r -= weights[i]
    if (r < 0) return items[i]
  }
  return items[items.length - 1] === exclude ? items[0] : items[items.length - 1]
}

/**
 * Number of uniforms drawn per simulated minute (fixed, so policies share random numbers minute by minute): u0–u1 HR
 * fluctuation, u2–u3 self-pacing, u4–u6 symptom onsets, u9–u10 self-reports, u11 buddy notice; u7–u8 reserved.
 */
export const TRUTH_UNIFORMS_PER_MINUTE = 12

/**
 * Advances a worker-shift by `dtMin` whole minutes at constant inputs and returns the new state (input untouched).
 * Each minute: microclimate (human MRT, body-height wind, indoor room) → Gagge step with acclimatisation, fever and
 * dehydration effects → first-aid cooling → water and sodium balance → HR fluctuation → self-pacing → symptom hazards,
 * persistence and reporting → outcome events. Exactly {@link TRUTH_UNIFORMS_PER_MINUTE} uniforms are drawn per minute
 * (plus a forked stream at a symptom onset), so the random stream stays aligned across policies.
 * Basis: SIMULATION.md §2; TRUTH_PARAMS.
 * @throws RangeError when dtMin is not a positive integer.
 */
export function stepTruth(state: TruthState, inputs: TruthInputs, dtMin: number, rng: Rng): TruthState {
  if (!Number.isInteger(dtMin) || dtMin < 1) throw new RangeError(`stepTruth: dtMin must be a positive integer (got ${dtMin})`)
  const P = state.params
  const traits = state.traits
  const s: TruthState = { ...state, episodes: { ...state.episodes }, outcomes: { ...state.outcomes } }
  const newEvents: TruthEvent[] = []
  let symptoms = state.symptoms as ActiveSymptom[]
  const act = inputs.activity
  const loc = act.location
  const restW = truthRestMetabolicW()
  const bsa = traits.bsaM2
  const massKg = traits.massKg
  const intakePerMin = Math.max(0, inputs.drankMl) / dtMin
  const pAtmPa = (inputs.pHpa ?? P.environment.defaultPHpa) * 100
  const A = s.acclimFraction
  const wMax = P.acclimatisation.wMaxUnacclimatised + (P.acclimatisation.wMaxAcclimatised - P.acclimatisation.wMaxUnacclimatised) * A
  const naConc = traits.sweatSodiumMmolL * (1 - P.acclimatisation.sweatSodiumReduction * A)
  const illMult = s.illness === 'none' ? 1 : P.illness.hazardMultiplier
  const hazardMult = P.symptoms.hazardScale * traits.symptomSusceptibility * illMult
  const epsPhi = Math.exp(-1 / P.hr.epsTauMin)
  const epsInnov = P.hr.epsSdBpm * Math.sqrt(1 - epsPhi * epsPhi)
  const emaA = 1 - Math.exp(-1 / P.behaviour.sweatEmaMin)
  const restLimitW = restW * P.behaviour.restFactor
  const working = act.metabolicW > restLimitW

  // Microclimate is constant across the step.
  let ta: number, rh: number, v: number, tr: number
  if (loc === 'indoor_cool') {
    ta = P.environment.indoorTaC
    rh = P.environment.indoorRhPct
    v = P.environment.indoorVMs
    tr = ta
  } else {
    ta = inputs.taC
    rh = inputs.rhPct
    v = Math.max(0.1, inputs.wind2Ms * P.environment.bodyWindFactor)
    tr = truthHumanMrtC(
      { taC: ta, rhPct: rh, ghiWm2: inputs.ghiWm2, fdir: inputs.fdir, cosZenith: inputs.cosZenith, location: loc, siteRadiantBoostC: inputs.radiantBoostC ?? s.siteRadiantBoostC, microclimateOffsetC: traits.microclimateOffsetC },
      P,
    )
  }
  s.location = loc
  s.airC = ta
  s.mrtC = tr
  const imst = (CLOTHING[act.clothing] ?? CLOTHING.cloth_coveralls).phs.imst
  const { clo, icl } = truthDynamicClothing(truthClothing(act.clothing, act.hood, P), imst, v, working ? P.clothing.workWalkSpeedMs : 0, P)

  const u = new Array<number>(TRUTH_UNIFORMS_PER_MINUTE)
  for (let k = 0; k < dtMin; k++) {
    for (let i = 0; i < TRUTH_UNIFORMS_PER_MINUTE; i++) u[i] = rng.next()
    const tEnd = s.t + MINUTE_MS

    // Metabolic rate with self-pacing (work above rest only).
    const mEff = act.metabolicW <= restW ? act.metabolicW : restW + (act.metabolicW - restW) * s.paceFactor
    s.effMetabolicW = mEff

    // Thermoregulation.
    const prevLoss = gaggeWaterLossG(s.gagge)
    const prevSweat = s.gagge.sweatG
    let g = gaggeStep(
      s.gagge,
      { taC: ta, trC: tr, vMs: v, rhPct: rh, metabolic: mEff / bsa, wme: 0, clo, im: icl, bodyPosition: 'standing', bsa, pAtmPa, wMax },
      1,
      gaggeParamsFor(s, traits, P),
    )
    if (inputs.cooling && inputs.cooling !== 'none') {
      const rate = inputs.cooling === 'immersion' ? P.cooling.immersionCPerMin : P.cooling.towelsCPerMin
      if (g.tCoreC > P.cooling.floorC) g = { ...g, tCoreC: Math.max(P.cooling.floorC, g.tCoreC - rate), tSkinC: Math.min(g.tSkinC, P.cooling.skinC) }
    }
    s.gagge = g

    // Water and sodium balance (1 g ≈ 1 mL).
    const lossMl = gaggeWaterLossG(g) - prevLoss
    const sweatMinMl = g.sweatG - prevSweat
    s.waterLossMl += lossMl
    s.sweatMl += sweatMinMl
    s.intakeMl += intakePerMin
    s.deficitMl = Math.max(P.hydration.deficitFloorMl, s.deficitMl + lossMl - intakePerMin)
    s.dehydrationPct = s.deficitMl / (massKg * 10)
    s.sodiumLossMmol += (sweatMinMl / 1000) * naConc
    s.sweatRateMlPerH += emaA * (sweatMinMl * 60 - s.sweatRateMlPerH)
    const core = g.tCoreC
    const dehyd = s.dehydrationPct
    if (core > s.maxCoreC) s.maxCoreC = core
    if (dehyd > s.maxDehydrationPct) s.maxDehydrationPct = dehyd

    // Slow HR fluctuation ε (u0, u1).
    s.hrEpsBpm = epsPhi * s.hrEpsBpm + epsInnov * normalFrom(u[0], u[1])

    // Self-pacing (u2, u3) — identical under every policy.
    if (P.selfPacing.enabled && working) {
      const hr = trueHeartRate(s, traits, mEff)
      const hrr = (hr - traits.hrRestBpm) / Math.max(1, traits.hrMaxBpm - traits.hrRestBpm)
      const SP = P.selfPacing
      if (s.paceFactor === 1) {
        if ((core >= SP.coreTriggerC || hrr >= SP.hrrTrigger) && u[2] < SP.slowProbPerMin * traits.selfPacingPropensity) {
          s.paceFactor = SP.slowFactor
          newEvents.push({ type: 'pace_change', t: tEnd, paceFactor: s.paceFactor })
        }
      } else if (core < SP.coreTriggerC - SP.resumeHysteresisC && hrr < SP.resumeHrr && u[3] < SP.resumeProbPerMin) {
        s.paceFactor = 1
        newEvents.push({ type: 'pace_change', t: tEnd, paceFactor: 1 })
      }
    }

    // Symptoms (SIMULATION.md §2.4).
    const S = P.symptoms
    const R = P.reporting
    const pSelf = clamp01(R.pSelf * traits.selfReportFactor)
    const addSymptoms = (cluster: SymptomCluster, ids: SymptomId[]): void => {
      symptoms = [...symptoms, ...ids.filter((id) => !symptoms.some((x) => x.id === id)).map((id) => ({ id, cluster, onsetT: tEnd }))]
    }
    const removeCluster = (cluster: SymptomCluster): void => {
      symptoms = symptoms.filter((x) => x.cluster !== cluster)
      newEvents.push({ type: 'symptom_resolved', t: tEnd, cluster })
    }

    // Thirst (T0 cue): TRUTH_PARAMS.hydration thresholds.
    const hasThirst = symptoms.some((x) => x.cluster === 'thirst')
    if (!hasThirst && dehyd >= P.hydration.thirstOnsetPct) {
      addSymptoms('thirst', ['thirst'])
      newEvents.push({ type: 'symptom_onset', t: tEnd, cluster: 'thirst', symptoms: ['thirst'], selfReported: false })
    } else if (hasThirst && dehyd < P.hydration.thirstResolvePct) removeCluster('thirst')

    // Heat-exhaustion cluster (u4 onset, forked stream for the details).
    const HE = S.heatExhaustion
    const he = s.episodes.heat_exhaustion
    if (!he) {
      if (core > HE.coreC || dehyd > HE.dehydPct) {
        const h = HE.baseHazardPerMin * Math.exp(HE.betaCorePerC * (core - HE.coreC)) * Math.exp(HE.betaDehydPerPct * Math.max(0, dehyd - HE.dehydPct)) * hazardMult
        if (u[4] < 1 - Math.exp(-h)) {
          const d = rng.fork(`he:${s.workerId}:${s.minute}`)
          const weights = HE_SYMPTOMS.map((id) => HE.weights[id])
          const first = pickWeighted(d.next(), HE_SYMPTOMS, weights)
          const ids: SymptomId[] = [first]
          if (d.next() < HE.extraSymptomProb) ids.push(pickWeighted(d.next(), HE_SYMPTOMS, weights, first))
          addSymptoms('heat_exhaustion', ids)
          s.episodes.heat_exhaustion = { onsetT: tEnd, recoveryRunMin: 0, noticed: false }
          newEvents.push({ type: 'symptom_onset', t: tEnd, cluster: 'heat_exhaustion', symptoms: ids, selfReported: u[9] < pSelf })
        }
      }
    } else {
      const ok = core < HE.resolveCoreC && dehyd < HE.resolveDehydPct
      const run = ok ? he.recoveryRunMin + 1 : 0
      if (run >= HE.resolveAfterMin) {
        s.episodes.heat_exhaustion = null
        removeCluster('heat_exhaustion')
      } else s.episodes.heat_exhaustion = { ...he, recoveryRunMin: run }
    }

    // Cramps (u5 onset, u10 report).
    const CR = S.cramps
    const cr = s.episodes.cramps
    if (!cr) {
      if (mEff > restLimitW && s.sodiumLossMmol >= CR.minSodiumMmol) {
        const h = CR.baseHazardPerMin * Math.pow(s.sodiumLossMmol / CR.sodiumRefMmol, CR.sodiumExponent) * Math.exp(CR.betaDehydPerPct * dehyd) * hazardMult
        if (u[5] < 1 - Math.exp(-h)) {
          addSymptoms('cramps', ['cramps'])
          s.episodes.cramps = { onsetT: tEnd, recoveryRunMin: 0, noticed: false }
          newEvents.push({ type: 'symptom_onset', t: tEnd, cluster: 'cramps', symptoms: ['cramps'], selfReported: u[10] < pSelf })
        }
      }
    } else {
      const run = mEff <= restLimitW ? cr.recoveryRunMin + 1 : 0
      if (run >= CR.resolveRestMin) {
        s.episodes.cramps = null
        removeCluster('cramps')
      } else {
        s.episodes.cramps = { ...cr, recoveryRunMin: run }
        if (tEnd - cr.onsetT >= CR.persistentAfterMin * MINUTE_MS && !symptoms.some((x) => x.id === 'cramps_persistent')) {
          addSymptoms('cramps', ['cramps_persistent'])
          newEvents.push({ type: 'symptom_added', t: tEnd, cluster: 'cramps', symptoms: ['cramps_persistent'] })
        }
      }
    }

    // CNS dysfunction (u6 onset, u11 buddy notice).
    const CN = S.cns
    const cn = s.episodes.cns
    let cnsOnset = false
    if (!cn) {
      const h = core >= CN.certainC ? 1 : core >= CN.fromC ? CN.maxHazardPerMin * ((core - CN.fromC) / (CN.certainC - CN.fromC)) * illMult : 0
      if (h >= 1 || u[6] < h) {
        const d = rng.fork(`cns:${s.workerId}:${s.minute}`)
        const ids: SymptomId[] = ['confusion']
        if (d.next() < CN.unsteadyProb) ids.push('unsteady_walking')
        if (d.next() < CN.slurredProb) ids.push('slurred_speech')
        if (d.next() < CN.collapseProb) ids.push('collapsed_unresponsive')
        addSymptoms('cns', ids)
        s.episodes.cns = { onsetT: tEnd, recoveryRunMin: 0, noticed: false }
        newEvents.push({ type: 'symptom_onset', t: tEnd, cluster: 'cns', symptoms: ids, selfReported: false })
        cnsOnset = true
      }
    } else {
      const run = core < CN.resolveCoreC ? cn.recoveryRunMin + 1 : 0
      if (run >= CN.resolveAfterMin) {
        s.episodes.cns = null
        removeCluster('cns')
      } else {
        let noticed = cn.noticed
        if (!noticed && u[11] < R.pBuddyNoticePerMin) {
          noticed = true
          newEvents.push({ type: 'buddy_noticed', t: tEnd, symptoms: symptoms.filter((x) => x.cluster === 'cns').map((x) => x.id) })
        }
        s.episodes.cns = { ...cn, recoveryRunMin: run, noticed }
      }
    }

    // Outcome events (SIMULATION.md §2.4 table).
    const E = P.events
    const record = (kind: TruthOutcomeKind, onsetT: number, value: number): void => {
      if (s.outcomes[kind]) return
      const outcome: TruthOutcome = { kind, t: tEnd, onsetT, value }
      s.outcomes[kind] = outcome
      newEvents.push({ type: 'outcome', t: tEnd, outcome })
    }
    const thr = s.unacclimatised ? E.excessiveUnacclimatisedC : E.excessiveC
    if (core >= thr) {
      if (s.excessRunMin === 0) s.excessRunStartT = s.t
      s.excessRunMin += 1
      if (s.excessRunMin >= E.sustainMin) record('excessive_strain', s.excessRunStartT ?? s.t, core)
    } else {
      s.excessRunMin = 0
      s.excessRunStartT = null
    }
    if (core >= E.severeC) record('severe_strain', s.t, core)
    if (core >= E.criticalC || cnsOnset) record('critical', s.t, core)
    if (dehyd > E.dehydrationPct) record('dehydration', s.t, dehyd)

    s.t = tEnd
    s.minute += 1
  }

  s.symptoms = symptoms
  s.lastEvents = newEvents
  s.events = newEvents.length > 0 ? [...state.events, ...newEvents] : state.events
  return s
}

// ─────────────────────────────── Behaviour ───────────────────────────────

/** Drinking opportunity for one minute. */
export interface DrinkContext {
  /** A drink reminder reached this worker this minute. */
  reminder: boolean
  /** Water within reach and drinking allowed (false while fasting or without a water point). */
  canDrink: boolean
  /** On a rest break. */
  onBreak?: boolean
  /** Volume asked for by the reminder, mL (default TRUTH_PARAMS.behaviour.reminderMl). */
  reminderMl?: number
}

/** Basis of {@link drinkDecision} / {@link spontaneousDrinkRateMlPerH} (quoted in docs and the Lab). */
export const DRINK_MODEL_BASIS =
  'Spontaneous drinking tracks sweat loss: target = max(habitual floor, replacement fraction × recent sweat rate). ' +
  'Observed voluntary intake in the heat replaces only ≈ 50–80 % of sweat loss (involuntary dehydration: Greenleaf 1992, ' +
  'Med Sci Sports Exerc 24:645; Sawka et al. 2007 ACSM position stand; citations recalled, UNVERIFIED) — the individual replacement fraction ~ N(0.6, 0.15) — ' +
  'whereas intake guidance (NIOSH 2016: 1 cup every 15–20 min; TB MED 507 2022 Table 3-2 by work intensity and heat ' +
  'category) is what reminders ask for. The habitual floor (IOM 2004 beverage AI ≈ 3.0 L/day over ≈ 16 waking h) applies ' +
  'when the worker is not sweating, e.g. in a cooled cabin; the hot-shift baseline (Bates & Schneider 2008, 5.44 L/12 h) ' +
  'is not applied to hours of cooled rest [ASSUMPTION]. A followed reminder is the drink of that minute (it replaces the ' +
  'spontaneous one, never adds to it).'

/**
 * Spontaneous (unprompted) drinking rate, mL/h: max(habitualDrinkFraction × individual baseline, individual replacement
 * fraction × recent sweat rate), raised by thirst above the thirst threshold (× (1 + thirstGainPerPct per %)) and on a
 * break (× breakDrinkFactor). It therefore scales with activity and heat through the sweat rate, and falls to the
 * habitual floor at rest in a cool place. Basis: {@link DRINK_MODEL_BASIS} [ASSUMPTION].
 */
export function spontaneousDrinkRateMlPerH(state: TruthState, traits: HiddenTraits, onBreak = false): number {
  const B = state.params.behaviour
  const target = Math.max(B.habitualDrinkFraction * traits.baselineDrinkMlPerH, traits.sweatReplacementFraction * state.sweatRateMlPerH)
  return target * (1 + B.thirstGainPerPct * Math.max(0, state.dehydrationPct - state.params.hydration.thirstOnsetPct)) * (onBreak ? B.breakDrinkFactor : 1)
}

/**
 * Water drunk this minute, mL (pass it as the next step's `drankMl`): a followed reminder (probability
 * reminderCompliance × the individual factor) is that minute's drink — the reminder volume, replacing the spontaneous
 * drink rather than adding to it; otherwise one 250-mL drink with probability rate/60/cup at the
 * {@link spontaneousDrinkRateMlPerH} rate. Always two uniforms per call (common random numbers across policies).
 * Basis: {@link DRINK_MODEL_BASIS}; TRUTH_PARAMS.behaviour [ASSUMPTION].
 */
export function drinkDecision(state: TruthState, traits: HiddenTraits, ctx: DrinkContext, rng: Rng): number {
  const B = state.params.behaviour
  const u1 = rng.next(), u2 = rng.next()
  if (!ctx.canDrink) return 0
  if (ctx.reminder && u1 < clamp01(B.reminderCompliance * traits.complianceFactor)) return ctx.reminderMl ?? B.reminderMl
  const rate = spontaneousDrinkRateMlPerH(state, traits, ctx.onBreak === true)
  return u2 < Math.min(1, rate / 60 / B.cupMl) ? B.cupMl : 0
}

/** What the worker answers to a prompted check-in. */
export interface CheckinResponse {
  symptoms: SymptomId[]
  urineColor: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
}

/**
 * Answer to a prompted check-in, or null when the worker does not respond (probability 1 − pRespond × factor) or has
 * CNS signs (cannot answer reliably — a buddy must observe). Each active non-CNS symptom is disclosed with pDisclose;
 * urine shade ≈ 2 + 1.5·dehydration% + N(0, 0.7) on the Armstrong chart. Basis: SIMULATION.md §2.4 [ASSUMPTION].
 */
export function respondToCheckin(state: TruthState, traits: HiddenTraits, rng: Rng): CheckinResponse | null {
  const R = state.params.reporting
  const uResp = rng.next()
  const z = rng.normal(0, 1)
  if (state.episodes.cns) return null
  if (uResp >= clamp01(R.pRespond * traits.respondFactor)) return null
  const symptoms = state.symptoms.filter((x) => x.cluster !== 'cns' && rng.next() < R.pDisclose).map((x) => x.id)
  const shade = Math.round(clamp(R.urineBase + R.urinePerPct * state.dehydrationPct + R.urineSd * z, 1, 8)) as CheckinResponse['urineColor']
  return { symptoms, urineColor: shade }
}

/** Active symptom ids (convenience for the world simulation). */
export function activeSymptomIds(state: TruthState): SymptomId[] {
  return state.symptoms.map((x) => x.id)
}

// ─────────────────────────────── Wearable ───────────────────────────────

/** Markov-chain memory of the wearable between minutes. */
export interface WearableChainState {
  lastMinuteIndex: number
  dropout: boolean
  offSkinRemainingS: number
  cadenceRemainingS: number
  cadenceFactor: number
  noiseBpm: number
}

/** A fresh wearable chain (no carried dropout, artefact or noise state). */
export function createWearableChain(): WearableChainState {
  return { lastMinuteIndex: Number.NaN, dropout: false, offSkinRemainingS: 0, cadenceRemainingS: 0, cadenceFactor: 1, noiseBpm: 0 }
}

/** Context for one minute of wearable samples. */
export interface WearableContext {
  /** Index of this minute in the shift. A non-consecutive index resets the chain. */
  minuteIndex: number
  /** Arm work this minute (motion: more noise, dropouts, cadence lock, off-skin). */
  armWork: boolean
  /** Dusty environment (more dropouts). */
  dust: boolean
  /** Chain memory carried across minutes; UPDATED IN PLACE. Omit for a memoryless minute. */
  chain?: WearableChainState
  /** Wearable parameters (default TRUTH_PARAMS.wearable). */
  params?: TruthParams['wearable']
}

/**
 * One minute of 1-Hz wrist-PPG samples for a true heart rate — exactly the input of engine/physio.ts
 * `minuteSqi(samples, 1)`: `tSec` is seconds from the start of the minute (0–59; minuteSqi segments by it), `bpm` is
 * an integer reading or null, `contactOk` false while off-skin (half of those seconds carry a spurious reading, so
 * minuteSqi raises 'contact_lost'). Reading = HR_true + worker bias + AR(1) noise (more
 * during arm work), with two-state Markov dropout bursts (worse during arm work and dust), cadence-lock artefacts
 * (2× or ½× the true rate for 5–10 s during arm work), off-skin periods (30–240 s), and optional whole-minute loss
 * (robustness sweep: returns []). Basis: SIMULATION.md §2.3; TRUTH_PARAMS.wearable [ASSUMPTION].
 */
export function wearableSamples(hrTrue: number, traits: HiddenTraits, ctx: WearableContext, rng: Rng): HrRawSample[] {
  const P = ctx.params ?? TRUTH_PARAMS.wearable
  const chain = ctx.chain ?? createWearableChain()
  const sigma = traits.ppgNoiseSdBpm * P.noiseMultiplier * (ctx.armWork ? P.motionNoiseFactor : 1)
  if (chain.lastMinuteIndex !== ctx.minuteIndex - 1) {
    chain.dropout = false
    chain.offSkinRemainingS = 0
    chain.cadenceRemainingS = 0
    chain.cadenceFactor = 1
    chain.noiseBpm = sigma * rng.normal(0, 1)
  }
  chain.lastMinuteIndex = ctx.minuteIndex
  if (P.minuteLossProb > 0 && rng.next() < P.minuteLossProb) return []

  const n = P.samplesPerMinute
  const p01 = Math.min(1, P.dropoutOnPerS * P.dropoutMultiplier * traits.ppgDropoutFactor * (ctx.armWork ? P.armWorkDropoutFactor : 1) * (ctx.dust ? P.dustDropoutFactor : 1))
  const p10 = Math.min(1, P.dropoutOffPerS / (ctx.armWork ? P.armWorkBurstFactor : 1))
  const pOff = Math.min(1, (P.offSkinPerMin / 60) * (ctx.armWork ? P.offSkinArmWorkFactor : 1) * P.dropoutMultiplier)
  const pCad = ctx.armWork ? P.cadenceLockPerS : 0
  const phi = P.noiseAr1
  const innov = sigma * Math.sqrt(1 - phi * phi)
  const bias = traits.ppgBiasBpm
  const out: HrRawSample[] = new Array(n)
  for (let sec = 0; sec < n; sec++) {
    chain.noiseBpm = phi * chain.noiseBpm + innov * rng.normal(0, 1)
    if (chain.offSkinRemainingS > 0) {
      chain.offSkinRemainingS -= 1
      out[sec] = { tSec: sec, bpm: rng.next() < P.offSkinSpuriousProb ? rng.int(P.offSkinSpuriousMinBpm, P.offSkinSpuriousMaxBpm) : null, contactOk: false }
      continue
    }
    if (rng.next() < pOff) {
      chain.offSkinRemainingS = rng.int(P.offSkinMinS, P.offSkinMaxS) - 1
      out[sec] = { tSec: sec, bpm: rng.next() < P.offSkinSpuriousProb ? rng.int(P.offSkinSpuriousMinBpm, P.offSkinSpuriousMaxBpm) : null, contactOk: false }
      continue
    }
    if (chain.dropout) {
      if (rng.next() < p10) chain.dropout = false
    } else if (rng.next() < p01) chain.dropout = true
    if (chain.dropout) {
      out[sec] = { tSec: sec, bpm: null, contactOk: true }
      continue
    }
    let bpm: number
    if (chain.cadenceRemainingS > 0) {
      chain.cadenceRemainingS -= 1
      bpm = hrTrue * chain.cadenceFactor + chain.noiseBpm
    } else if (pCad > 0 && rng.next() < pCad) {
      chain.cadenceFactor = rng.next() < P.cadenceDoubleProb ? 2 : 0.5
      chain.cadenceRemainingS = rng.int(P.cadenceMinS, P.cadenceMaxS) - 1
      bpm = hrTrue * chain.cadenceFactor + chain.noiseBpm
    } else bpm = hrTrue + bias + chain.noiseBpm
    out[sec] = { tSec: sec, bpm: Math.max(0, Math.round(bpm)), contactOk: true }
  }
  return out
}
