/**
 * Gagge two-node model of human thermoregulation (Gagge, Fobelets & Berglund 1986) as a STATEFUL one-minute stepper.
 *
 * This is the simulation ground truth's thermoregulation (docs/SIMULATION.md §2.2). It is deliberately a different
 * model from the engine's ISO 7933 PHS projection, so that the back-test is not circular.
 *
 * Port: pythermalcomfort 4.8.1 `two_nodes_gagge` → `_gagge_two_nodes_optimized` (models/two_nodes_gagge.py). Each
 * iteration of the upstream `while n_simulation < length_time_simulation` loop is one minute (dT = S·A_D/(c·m·60)).
 * Upstream always runs 59 iterations from the neutral state; here every quantity the loop carries from one iteration to
 * the next (core and skin temperature, skin blood flow, skin mass fraction α, skin evaporation, the radiative
 * coefficient that seeds the clothing-temperature iteration, shivering) is held in {@link GaggeState}, so a run can be
 * stepped minute by minute with changing inputs, and chunked stepping is bit-identical to one continuous call.
 * Parity: fixtures/gagge.json (scripts/oracles/gagge_oracle.py) — 12 constant-condition cases × 9 durations (1–480 min).
 *
 * Deliberate differences from upstream (documented; none is active in the parity configuration):
 * - External work `wme` is taken in W/m² and subtracted once (net heat production M − W). Upstream subtracts `wme`
 *   (in met) from the W/m² core balance on top of `rm = (met − wme)·58.2`; with wme = 0 (all fixtures) both agree.
 * - Body mass for the heat capacity is a state option (upstream fixes 70 kg).
 * - Extensions in {@link GaggeParams}: sweat-gain multiplier, core set-point shift and dehydration effects
 *   (all neutral by default — {@link GAGGE_PARITY_PARAMS}).
 * - Non-finite inputs throw a RangeError (upstream returns NaN), and the total produced sweat (before the wettedness
 *   cap) and water-loss totals are tracked for the hydration balance.
 *
 * Claims discipline: a thermoregulation model of virtual workers for the back-test; its outputs are simulated values,
 * not observations of a real person.
 */

/**
 * Model constants, verbatim from pythermalcomfort 4.8.1 `_gagge_two_nodes_optimized` (values from Gagge, Fobelets &
 * Berglund 1986 and the ASHRAE 55-2020 SET code).
 */
export const GAGGE = {
  /** W/m² per met used by the model (upstream `met_factor`; note ISO uses 58.15). */
  MET_FACTOR: 58.2,
  /** Body mass behind the heat capacities, kg (upstream `body_weight`). */
  BODY_WEIGHT_KG: 70,
  /** Stefan–Boltzmann constant as written upstream, W/(m²·K⁴). */
  SBC: 0.000000056697,
  /** Regulatory sweating gain, g/(m²·h·K) (upstream `c_sw`). */
  C_SW: 170,
  /** Vasodilation gain, L/(m²·h·K) (upstream `c_dil`; ASHRAE quotes 50, see p. 9.19). */
  C_DIL: 120,
  /** Vasoconstriction gain, 1/K (upstream `c_str`). */
  C_STR: 0.5,
  /** Skin set point, °C. */
  T_SKIN_NEUTRAL_C: 33.7,
  /** Core set point, °C. */
  T_CORE_NEUTRAL_C: 36.8,
  /** Initial skin mass fraction α. */
  ALFA0: 0.1,
  /** Neutral skin blood flow, L/(m²·h). */
  SKIN_BLOOD_FLOW_NEUTRAL: 6.3,
  /** Default maximum skin blood flow, L/(m²·h) (upstream `max_skin_blood_flow`). */
  MAX_SKIN_BLOOD_FLOW: 90,
  /** Minimum skin blood flow, L/(m²·h). */
  MIN_SKIN_BLOOD_FLOW: 0.5,
  /** Default maximum regulatory sweating, g/(m²·h) (upstream `max_sweating`). */
  MAX_SWEATING: 500,
  /** Clothing vapour permeation efficiency when clothed (upstream `i_cl = 0.45`), nude = 1. */
  I_CL_CLOTHED: 0.45,
  I_CL_NUDE: 1.0,
  /** Lewis ratio at 1 atm, K/torr (upstream `lr = 2.2 / p_atm`). */
  LEWIS_RATIO: 2.2,
  /** Seed for the linearised radiative coefficient, W/(m²·K) (upstream `h_r = 4.7`). */
  H_R_INITIAL: 4.7,
  /** Clothing emissivity (ASHRAE Fundamentals ch. 9.7 eq. 35). */
  CLOTHING_EMISSIVITY: 0.95,
  /** Radiating fraction of body area A_r/A_D: standing 0.73, sitting 0.7. */
  AR_AD_STANDING: 0.73,
  AR_AD_SITTING: 0.7,
  /** Clothing-temperature iteration tolerance, °C, and iteration limit. */
  T_CL_TOLERANCE_C: 0.01,
  T_CL_MAX_ITER: 150,
  /** Average tissue conductance core→skin, W/(m²·K), and blood heat capacity, Wh/(L·K). */
  TISSUE_CONDUCTANCE: 5.28,
  BLOOD_HEAT_CAPACITY: 1.163,
  /** Body specific heat, Wh/(kg·K). */
  BODY_SPECIFIC_HEAT: 0.97,
  /** Latent heat of sweat evaporation, Wh/g (upstream `e_rsw = 0.68·m_rsw`). */
  LATENT_HEAT_WH_PER_G: 0.68,
  /** Iterations the public pythermalcomfort function runs (length_time_simulation 60, loop from 1). */
  UPSTREAM_STEPS: 59,
  /** Standard atmosphere, Pa. */
  P_ATM_STD_PA: 101325,
} as const

/** Body position, which sets the radiating area fraction A_r/A_D. */
export type GaggePosition = 'standing' | 'sitting'

/** Inputs for one or more minutes at constant conditions. */
export interface GaggeInputs {
  /** Air temperature, °C. */
  taC: number
  /** Mean radiant temperature, °C. */
  trC: number
  /** Air speed, m/s (floored at 0.1 inside the model, as upstream). */
  vMs: number
  /** Relative humidity, %. */
  rhPct: number
  /** Metabolic rate, W/m² (upstream `met` × 58.2). */
  metabolic: number
  /** External work, W/m² (0 for the fixtures; see the module note). */
  wme: number
  /** Clothing insulation, clo. */
  clo: number
  /** Clothing vapour permeation efficiency i_cl; default 0.45 when clothed, 1 when nude (upstream). */
  im?: number
  bodyPosition: GaggePosition
  /** Body surface area, m² (upstream default 1.8258). */
  bsa: number
  /** Atmospheric pressure, Pa (default 101 325). */
  pAtmPa?: number
  /**
   * Maximum skin wettedness (0.06, 1]. Default: upstream `0.59·v^−0.08` clothed, `0.38·v^−0.29` nude — comfort-study
   * values (ASHRAE 55 SET code). The ground truth passes a heat-tolerance value instead (see sim/truth.ts).
   */
  wMax?: number
}

/** Dehydration effects (extension; off unless given). */
export interface GaggeDehydration {
  /** Body-mass loss, % (≥ 0). */
  pct: number
  /** Core set-point rise per 1 % body-mass loss, °C/%. */
  setpointCPerPct: number
  /** Fractional reduction of the sweating gain per 1 % body-mass loss (e.g. 0.03 = −3 %/%). */
  sweatGainLossPerPct: number
}

/**
 * Model parameters and ground-truth extensions. The neutral values ({@link GAGGE_PARITY_PARAMS}) reproduce
 * pythermalcomfort exactly; the extensions are used by sim/truth.ts with cited magnitudes:
 * - `sweatGainMultiplier` scales c_sw (heat acclimatisation raises sweating sensitivity — Périard, Racinais & Sawka
 *   2015; individual variation);
 * - `setpointShiftC` shifts the core set point 36.8 °C, and the mean-body set point derived from it
 *   (α₀·33.7 + (1 − α₀)·T_core,n), as fever raises and acclimatisation lowers the thermoregulatory thresholds;
 * - `dehydration` raises the set point and lowers the sweating gain (hypohydration raises the core-temperature
 *   thresholds for sweating and skin blood flow — Montain, Latzka & Sawka 1995; ≈0.1–0.2 °C core rise per 1 % body-mass
 *   loss — Montain & Coyle 1992, TB MED 507 Para 2-3f).
 */
export interface GaggeParams {
  /** Multiplier on c_sw (1 = Gagge 1986). */
  sweatGainMultiplier: number
  /** Core set-point shift, °C (0 = Gagge 1986). */
  setpointShiftC: number
  dehydration?: GaggeDehydration
  /** Maximum skin blood flow, L/(m²·h) (default 90). */
  maxSkinBloodFlow?: number
  /** Maximum regulatory sweating, g/(m²·h) (default 500). */
  maxSweatingGm2h?: number
}

/** Parameters that reproduce pythermalcomfort 4.8.1 `two_nodes_gagge` (all extensions off). */
export const GAGGE_PARITY_PARAMS: Readonly<GaggeParams> = Object.freeze({ sweatGainMultiplier: 1, setpointShiftC: 0 })

/** Full model state after the latest minute. Carried variables first, then last-minute outputs, then running totals. */
export interface GaggeState {
  /** Core temperature, °C. */
  tCoreC: number
  /** Mean skin temperature, °C. */
  tSkinC: number
  /** Skin blood flow, L/(m²·h). */
  mBl: number
  /** Skin mass fraction α (updated from skin blood flow each minute). */
  alfa: number
  /** Total skin evaporative loss of the latest minute, W/m² (enters the next minute's skin heat balance). */
  eSkinWm2: number
  /** Linearised radiative coefficient from the latest clothing-temperature iteration, W/(m²·K). */
  hRWm2K: number
  /** Shivering metabolic rate from the latest minute, W/m² (added to the next minute's heat production). */
  metShiveringWm2: number
  /** Body mass used for the heat capacities, kg. */
  massKg: number
  /** Minutes stepped since creation. */
  minutes: number
  /** Clothing surface temperature, °C. */
  tClC: number
  /** Dry (sensible) heat loss from skin, W/m² (negative = gain). */
  qSensibleWm2: number
  /** Evaporative loss by regulatory sweat, W/m². */
  eRswWm2: number
  /** Evaporative loss by skin diffusion, W/m². */
  eDiffWm2: number
  /** Maximum evaporative capacity, W/m². */
  eMaxWm2: number
  /** Skin wettedness. */
  w: number
  /** Maximum skin wettedness in force. */
  wMax: number
  /** EVAPORATED regulatory sweat, g/(m²·h) (= upstream output `m_rsw`, back-calculated from e_rsw). */
  mRswGm2h: number
  /** PRODUCED regulatory sweat before the wettedness cap, g/(m²·h) (evaporated + dripping). */
  sweatProdGm2h: number
  /** Respiratory latent and sensible losses, W/m². */
  qResWm2: number
  cResWm2: number
  /** Running totals since creation, grams: produced regulatory sweat, skin diffusion water, respiratory water. */
  sweatG: number
  skinDiffusionG: number
  respiratoryWaterG: number
}

/** Options for {@link createGaggeState}. */
export interface GaggeStateOptions {
  /** Initial core temperature, °C (default 36.8, the neutral state). */
  tCoreC?: number
  /** Initial skin temperature, °C (default 33.7). */
  tSkinC?: number
  /** Initial skin blood flow, L/(m²·h) (default 6.3). */
  mBl?: number
  /** Body mass, kg (default 70, as upstream). */
  massKg?: number
  /**
   * Metabolic rate of the first minute, W/m², used only for the upstream initial skin evaporation `e_skin = 0.1·met`
   * (met units, an upstream quirk kept for parity). Default 58.2 (1 met).
   */
  initialMetabolicWm2?: number
}

/**
 * Creates the model's neutral initial state (core 36.8 °C, skin 33.7 °C, skin blood flow 6.3 L/(m²·h), α 0.1,
 * h_r 4.7 W/(m²·K), e_skin = 0.1·met) — pythermalcomfort 4.8.1 `_gagge_two_nodes_optimized` initialisation.
 */
export function createGaggeState(opts: GaggeStateOptions = {}): GaggeState {
  const met = (opts.initialMetabolicWm2 ?? GAGGE.MET_FACTOR) / GAGGE.MET_FACTOR
  const massKg = opts.massKg ?? GAGGE.BODY_WEIGHT_KG
  if (!(massKg > 0)) throw new RangeError(`createGaggeState: massKg must be > 0 (got ${massKg})`)
  return {
    tCoreC: opts.tCoreC ?? GAGGE.T_CORE_NEUTRAL_C,
    tSkinC: opts.tSkinC ?? GAGGE.T_SKIN_NEUTRAL_C,
    mBl: opts.mBl ?? GAGGE.SKIN_BLOOD_FLOW_NEUTRAL,
    alfa: GAGGE.ALFA0,
    eSkinWm2: 0.1 * met,
    hRWm2K: GAGGE.H_R_INITIAL,
    metShiveringWm2: 0,
    massKg,
    minutes: 0,
    tClC: NaN,
    qSensibleWm2: 0,
    eRswWm2: 0,
    eDiffWm2: 0,
    eMaxWm2: 0,
    w: 0,
    wMax: NaN,
    mRswGm2h: 0,
    sweatProdGm2h: 0,
    qResWm2: 0,
    cResWm2: 0,
    sweatG: 0,
    skinDiffusionG: 0,
    respiratoryWaterG: 0,
  }
}

/** Saturation vapour pressure of water, torr — pythermalcomfort `p_sat_torr`: exp(18.6686 − 4030.183/(t + 235)). */
export function pSatTorr(tC: number): number {
  return Math.exp(18.6686 - 4030.183 / (tC + 235.0))
}

/**
 * Default maximum skin wettedness of the upstream model: clothed 0.59·v^−0.08, nude 0.38·v^−0.29, v floored at 0.1 m/s
 * (ASHRAE 55-2020 SET code via pythermalcomfort). These are comfort-study values.
 */
export function gaggeDefaultWMax(vMs: number, clo: number): number {
  const v = Math.max(vMs, 0.1)
  return clo > 0 ? 0.59 * Math.pow(v, -0.08) : 0.38 * Math.pow(v, -0.29)
}

function checkFinite(inp: GaggeInputs): void {
  const vals: Array<[string, number]> = [
    ['taC', inp.taC], ['trC', inp.trC], ['vMs', inp.vMs], ['rhPct', inp.rhPct], ['metabolic', inp.metabolic],
    ['wme', inp.wme], ['clo', inp.clo], ['bsa', inp.bsa],
  ]
  for (const [k, v] of vals) if (!Number.isFinite(v)) throw new RangeError(`gaggeStep: ${k} must be finite (got ${v})`)
  if (!(inp.bsa > 0)) throw new RangeError(`gaggeStep: bsa must be > 0 (got ${inp.bsa})`)
  if (inp.im !== undefined && !(inp.im > 0)) throw new RangeError(`gaggeStep: im must be > 0 (got ${inp.im})`)
}

/**
 * Advances the two-node model by `minutes` one-minute iterations at constant `inputs` and returns the new state
 * (the input state is not modified). With {@link GAGGE_PARITY_PARAMS}, wme = 0 and the neutral initial state,
 * 59 minutes reproduce pythermalcomfort 4.8.1 `two_nodes_gagge(..., round_output=False)`.
 *
 * Basis: Gagge, Fobelets & Berglund 1986 (ASHRAE Trans 92(2B):709–731); pythermalcomfort 4.8.1 implementation.
 * @throws RangeError for non-finite inputs, a non-integer or negative `minutes`, or a clothing-temperature iteration
 *   that does not converge in 150 passes (upstream raises StopIteration).
 */
export function gaggeStep(
  state: GaggeState,
  inputs: GaggeInputs,
  minutes: number,
  params: Readonly<GaggeParams> = GAGGE_PARITY_PARAMS,
): GaggeState {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`gaggeStep: minutes must be a non-negative integer (got ${minutes})`)
  checkFinite(inputs)
  const s: GaggeState = { ...state }
  if (minutes === 0) return s

  const tdb = inputs.taC
  const tr = inputs.trC
  const metabolic = inputs.metabolic
  const met = metabolic / GAGGE.MET_FACTOR
  const bsa = inputs.bsa
  const airSpeed = Math.max(inputs.vMs, 0.1)
  const pAtm = (inputs.pAtmPa ?? GAGGE.P_ATM_STD_PA) / GAGGE.P_ATM_STD_PA
  const vaporPressure = (inputs.rhPct * pSatTorr(tdb)) / 100
  const clo = inputs.clo
  const rClo = 0.155 * clo
  const fACl = 1.0 + 0.15 * clo
  const lr = GAGGE.LEWIS_RATIO / pAtm
  const rm = metabolic - inputs.wme
  const iCl = inputs.im ?? (clo > 0 ? GAGGE.I_CL_CLOTHED : GAGGE.I_CL_NUDE)
  const wMax = inputs.wMax ?? gaggeDefaultWMax(inputs.vMs, clo)
  if (!(wMax > 0.06 && wMax <= 1)) throw new RangeError(`gaggeStep: wMax must be in (0.06, 1] (got ${wMax})`)

  let hCc = 3.0 * Math.pow(pAtm, 0.53)
  const hFc = 8.600001 * Math.pow(airSpeed * pAtm, 0.53)
  hCc = Math.max(hCc, hFc)
  if (met > 0.85) hCc = Math.max(hCc, 5.66 * Math.pow(met - 0.85, 0.39))
  const arAd = inputs.bodyPosition === 'sitting' ? GAGGE.AR_AD_SITTING : GAGGE.AR_AD_STANDING
  const qRes = 0.0023 * metabolic * (44.0 - vaporPressure)
  const cRes = 0.0014 * metabolic * (34.0 - tdb)

  // Extensions (neutral with GAGGE_PARITY_PARAMS).
  const dehyd = params.dehydration
  const dehydPct = dehyd ? Math.max(0, dehyd.pct) : 0
  const setpointShift = params.setpointShiftC + (dehyd ? dehydPct * dehyd.setpointCPerPct : 0)
  const gain = params.sweatGainMultiplier * (dehyd ? Math.max(0, 1 - dehydPct * dehyd.sweatGainLossPerPct) : 1)
  const cSw = GAGGE.C_SW * gain
  const tSkinNeutral = GAGGE.T_SKIN_NEUTRAL_C
  const tCoreNeutral = GAGGE.T_CORE_NEUTRAL_C + setpointShift
  const alfa0 = GAGGE.ALFA0
  const tBodyNeutral = alfa0 * tSkinNeutral + (1 - alfa0) * tCoreNeutral
  const maxSkinBloodFlow = params.maxSkinBloodFlow ?? GAGGE.MAX_SKIN_BLOOD_FLOW
  const maxSweating = params.maxSweatingGm2h ?? GAGGE.MAX_SWEATING
  const rEa = 1.0 / (lr * fACl * hCc)
  const rEcl = rClo / (lr * iCl)
  const radConst = 4.0 * GAGGE.CLOTHING_EMISSIVITY * GAGGE.SBC
  const massKg = s.massKg
  const gPerMin = bsa / 60 // g/(m²·h) → g per minute

  let tSkin = s.tSkinC
  let tCore = s.tCoreC
  let mBl = s.mBl
  let alfa = s.alfa
  let eSkin = s.eSkinWm2
  let hR = s.hRWm2K
  let metShivering = s.metShiveringWm2
  let tCl = s.tClC
  let qSensible = 0
  let eRsw = 0
  let eDiff = 0
  let eMax = 0
  let w = 0
  let mRsw = 0
  let sweatProd = 0

  for (let k = 0; k < minutes; k++) {
    let hT = hR + hCc
    let rA = 1.0 / (fACl * hT)
    let tOp = (hR * tr + hCc * tdb) / hT
    tCl = (rA * tSkin + rClo * tOp) / (rA + rClo)
    let n = 0
    let converged = false
    while (!converged) {
      hR = radConst * Math.pow((tCl + tr) / 2.0 + 273.15, 3.0) * arAd
      hT = hR + hCc
      rA = 1.0 / (fACl * hT)
      tOp = (hR * tr + hCc * tdb) / hT
      const tClNew = (rA * tSkin + rClo * tOp) / (rA + rClo)
      if (Math.abs(tClNew - tCl) <= GAGGE.T_CL_TOLERANCE_C) converged = true
      tCl = tClNew
      n++
      if (n > GAGGE.T_CL_MAX_ITER) throw new RangeError('gaggeStep: clothing temperature did not converge')
    }
    qSensible = (tSkin - tOp) / (rA + rClo)
    const hfCs = (tCore - tSkin) * (GAGGE.TISSUE_CONDUCTANCE + GAGGE.BLOOD_HEAT_CAPACITY * mBl)
    const m = rm + metShivering
    const sCore = m - hfCs - qRes - cRes
    const sSkin = hfCs - qSensible - eSkin
    const tcSk = GAGGE.BODY_SPECIFIC_HEAT * alfa * massKg
    const tcCr = GAGGE.BODY_SPECIFIC_HEAT * (1 - alfa) * massKg
    tSkin = tSkin + (sSkin * bsa) / (tcSk * 60.0)
    tCore = tCore + (sCore * bsa) / (tcCr * 60.0)
    const tBody = alfa * tSkin + (1 - alfa) * tCore
    const skSig = tSkin - tSkinNeutral
    const warmSk = skSig > 0 ? skSig : 0
    const colds = -skSig > 0 ? -skSig : 0
    const cRegSig = tCore - tCoreNeutral
    const cWarm = cRegSig > 0 ? cRegSig : 0
    const cCold = -cRegSig > 0 ? -cRegSig : 0
    const bdSig = tBody - tBodyNeutral
    const warmB = bdSig > 0 ? bdSig : 0
    mBl = (GAGGE.SKIN_BLOOD_FLOW_NEUTRAL + GAGGE.C_DIL * cWarm) / (1 + GAGGE.C_STR * colds)
    mBl = Math.min(mBl, maxSkinBloodFlow)
    mBl = Math.max(mBl, GAGGE.MIN_SKIN_BLOOD_FLOW)
    mRsw = cSw * warmB * Math.exp(warmSk / 10.7)
    mRsw = Math.min(mRsw, maxSweating)
    sweatProd = mRsw
    eRsw = GAGGE.LATENT_HEAT_WH_PER_G * mRsw
    eMax = (pSatTorr(tSkin) - vaporPressure) / (rEa + rEcl)
    if (eMax === 0) eMax = 0.001
    let pRsw = eRsw / eMax
    w = 0.06 + 0.94 * pRsw
    eDiff = w * eMax - eRsw
    if (w > wMax) {
      w = wMax
      pRsw = (wMax - 0.06) / 0.94
      eRsw = pRsw * eMax
      eDiff = 0.06 * (1.0 - pRsw) * eMax
    }
    if (eMax < 0) {
      eDiff = 0
      eRsw = 0
      w = wMax
    }
    eSkin = eRsw + eDiff
    mRsw = eRsw / GAGGE.LATENT_HEAT_WH_PER_G
    metShivering = 19.4 * colds * cCold
    alfa = 0.0417737 + 0.7451833 / (mBl + 0.585417)

    s.sweatG += sweatProd * gPerMin
    s.skinDiffusionG += (Math.max(0, eDiff) / GAGGE.LATENT_HEAT_WH_PER_G) * gPerMin
    s.respiratoryWaterG += (Math.max(0, qRes) / GAGGE.LATENT_HEAT_WH_PER_G) * gPerMin
  }

  s.tCoreC = tCore
  s.tSkinC = tSkin
  s.mBl = mBl
  s.alfa = alfa
  s.eSkinWm2 = eSkin
  s.hRWm2K = hR
  s.metShiveringWm2 = metShivering
  s.minutes = state.minutes + minutes
  s.tClC = tCl
  s.qSensibleWm2 = qSensible
  s.eRswWm2 = eRsw
  s.eDiffWm2 = eDiff
  s.eMaxWm2 = eMax
  s.w = w
  s.wMax = wMax
  s.mRswGm2h = mRsw
  s.sweatProdGm2h = sweatProd
  s.qResWm2 = qRes
  s.cResWm2 = cRes
  return s
}

/** Total water lost since creation (produced sweat + skin diffusion + respiration), grams ≈ mL. */
export function gaggeWaterLossG(state: Pick<GaggeState, 'sweatG' | 'skinDiffusionG' | 'respiratoryWaterG'>): number {
  return state.sweatG + state.skinDiffusionG + state.respiratoryWaterG
}
