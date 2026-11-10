/**
 * Outdoor and shade WBGT from weather data: a port of Liljegren et al. (2008), "Modeling the wet bulb globe temperature
 * using standard meteorological measurements" (J Occup Environ Hyg 5:645–655), following the thermofeel 2.3.0
 * `liljegren.py` implementation, which equals Liljegren's `wbgt.c` to ≤ 2.2e-12 °C in float64
 * (docs/research/wbgt_liljegren.md, decisions D1–D10).
 *
 * Pipeline (`wbgtComponents`): Open-Meteo-style record → RH from dew point (D8) → NOAA apparent zenith at the
 * mid-point of the radiation averaging window (D4, D5) → Liljegren direct-beam fraction with the 0.85 normsolar cap
 * (D6) → 10 m → 2 m wind with the SRDT stability class and urban exponents (D7) → 2-inch black globe and natural
 * wet bulb by the damped fixed point (D2) → ISO 7243 weighting (D3).
 *
 * Claims discipline: WBGT is an *environmental* heat-stress index (ISO 7243). It says nothing about any individual's
 * body temperature; Zill uses it as occupational-safety decision support only.
 */

import type { EnvSample, EnvSource } from './types'
import { KELVIN_OFFSET } from './units'
import { clampRhPct, liljegrenDewPointK, liljegrenEsatHpa, rhFromDewPointPct } from './psychro'
import { hourMeanSolarPosition, toaHorizontalWm2, SOLAR_CONSTANT_WM2 } from './solar'

// ─────────────────────────────── Constants (wbgt_liljegren.md §4) ───────────────────────────────

const STEFANB = 5.6696e-8
const CP = 1003.5
const M_AIR = 28.97
const M_H2O = 18.015
const R_GAS = 8314.34
const R_AIR = R_GAS / M_AIR
const PR = CP / (CP + 1.25 * R_AIR)
const RATIO = (CP * M_AIR) / M_H2O
const EMIS_GLOBE = 0.95
const ALB_GLOBE = 0.05
const D_GLOBE = 0.0508
const EMIS_WICK = 0.95
const ALB_WICK = 0.4
const D_WICK = 0.007
const L_WICK = 0.0254
const EMIS_SFC = 0.999
const ALB_SFC = 0.45
const CZA_MIN = 0.00873
const NORMSOLAR_MAX = 0.85
const FDIR_MAX = 0.9
const MIN_SPEED = 0.13
const CONVERGENCE = 0.02
const MAX_ITER = 500
const MIN_WIND_10M = 0.62
const REF_HEIGHT = 2.0
const WIND_HEIGHT = 10.0

/**
 * Every constant of the Liljegren model, identical in wbgt.c and thermofeel (wbgt_liljegren.md §4; fixture
 * `constants`). STEFANB is the value *as coded* (CODATA is 5.670374e-8) and is kept for oracle parity. MAX_ITER is
 * thermofeel's 500, not the C's 50, which fails on calm, low-sun cases (§7.3, D2). MIN_WIND_10M_MS (0.62 m/s) is
 * thermofeel's floor; its KNMI attribution is UNVERIFIED (§12).
 */
export const LILJEGREN = {
  /** Stefan–Boltzmann constant as coded, W m⁻² K⁻⁴. */
  STEFANB,
  /** Specific heat of dry air, J kg⁻¹ K⁻¹. */
  CP,
  /** Molar masses, g mol⁻¹. */
  M_AIR,
  M_H2O,
  /** Universal gas constant, J kmol⁻¹ K⁻¹. */
  R_GAS,
  /** R_GAS/M_AIR = 286.998274076631 J kg⁻¹ K⁻¹. */
  R_AIR,
  /** Prandtl number (Eucken) Cp/(Cp + 1.25·R_AIR) = 0.736650093046073. */
  PR,
  /** Psychrometric grouping Cp·M_AIR/M_H2O = 1613.7327227310575. */
  RATIO,
  EMIS_GLOBE,
  ALB_GLOBE,
  /** 2-inch globe diameter, m. */
  D_GLOBE_M: D_GLOBE,
  EMIS_WICK,
  ALB_WICK,
  D_WICK_M: D_WICK,
  L_WICK_M: L_WICK,
  /** Ground emissivity and albedo (surface temperature fixed at Ta). */
  EMIS_SFC,
  ALB_SFC,
  SOLAR_CONST_WM2: SOLAR_CONSTANT_WM2,
  /** cos(89.5°): below it the beam terms are dropped (fdir = 0, TOA = 0). */
  CZA_MIN,
  /** Maximum clearness index GHI/TOA admitted (wbgt.c NORMSOLAR_MAX). */
  NORMSOLAR_MAX,
  /** Upper clamp of the direct-beam fraction. */
  FDIR_MAX,
  /** Floor on the 2 m wind, both after the 10 → 2 m conversion and inside both Reynolds numbers, m/s. */
  MIN_SPEED_MS: MIN_SPEED,
  /** Fixed-point stop test |F(x) − x| < 0.02 K. */
  CONVERGENCE_K: CONVERGENCE,
  MAX_ITER,
  /** Damped update x ← 0.9·x + 0.1·F(x). */
  DAMPING_NEW_WEIGHT: 0.1,
  /** thermofeel 10 m wind floor, m/s. UNVERIFIED: KNMI attribution (TR-26-04 not retrieved). */
  MIN_WIND_10M_MS: MIN_WIND_10M,
  /** Reference heights for the wind power law, m. */
  REF_HEIGHT_M: REF_HEIGHT,
  WIND_HEIGHT_M: WIND_HEIGHT,
} as const

// ─────────────────────────────── Property functions (wbgt_liljegren.md §5–6) ───────────────────────────────

const DIFF_PC13 = Math.pow(36.4 * 218.0, 1.0 / 3.0)
const DIFF_TC512 = Math.pow(132.0 * 647.3, 5.0 / 12.0)
const DIFF_TC12 = Math.sqrt(132.0 * 647.3)
const DIFF_MMIX = Math.sqrt(1.0 / M_AIR + 1.0 / M_H2O)
const K_FACTOR = CP + 1.25 * R_AIR
const PR_SPHERE = Math.pow(PR, 0.3333)
const PR_CYLINDER = Math.pow(PR, 1.0 - 0.56)
const WICK_DWL = (0.25 * D_WICK) / L_WICK

/**
 * Dynamic viscosity of air, kg m⁻¹ s⁻¹: 2.6693e-6·√(M_AIR·T)/(3.617²·Ω), Ω = (T/97 − 2.9)/0.4·(−0.034) + 1.048
 * (Bird, Stewart & Lightfoot p.23; wbgt_liljegren.md §5). 1.85844638032e-5 at 303.15 K.
 */
export function viscosityKgMs(tK: number): number {
  const omega = ((tK / 97.0 - 2.9) / 0.4) * -0.034 + 1.048
  return (2.6693e-6 * Math.sqrt(M_AIR * tK)) / (3.617 * 3.617 * omega)
}

/** Thermal conductivity of air, W m⁻¹ K⁻¹: (Cp + 1.25·R_AIR)·μ(T) (Eucken; wbgt_liljegren.md §5). */
export function thermalConductivityWmK(tK: number): number {
  return K_FACTOR * viscosityKgMs(tK)
}

/**
 * Diffusivity of water vapour in air, m² s⁻¹ (Bird, Stewart & Lightfoot p.505; wbgt_liljegren.md §5):
 * 3.640e-4·(T/√(132·647.3))^2.334·(36.4·218)^(1/3)·(132·647.3)^(5/12)·√(1/M_AIR + 1/M_H2O)/(P/1013.25)·1e-4.
 */
export function diffusivityM2s(tK: number, pHpa: number): number {
  const patm = pHpa / 1013.25
  return ((3.64e-4 * (tK / DIFF_TC12) ** 2.334 * DIFF_PC13 * DIFF_TC512 * DIFF_MMIX) / patm) * 1e-4
}

/**
 * Latent heat of evaporation, J kg⁻¹: (313.15 − T)/30·(−71100) + 2.4073e6 (wbgt.c `evap`; wbgt_liljegren.md §5).
 * Quirk Q1: the slope sign is wrong (λ rises with T; −1.95 % at 30 °C, 0 at 40 °C, +0.99 % at 45 °C). Kept for oracle
 * parity; correcting it changes WBGT by −0.17…+0.04 °C at Ta 35–50 °C, so the reference is slightly conservative.
 * UNVERIFIED: whether the paper's printed equation carries the same sign (paywalled).
 */
export function latentHeatEvapJkg(tK: number): number {
  return ((313.15 - tK) / 30.0) * -71100.0 + 2.4073e6
}

/** Atmospheric (clear-sky) emissivity ε_a = 0.575·(RH·e_sat(T))^0.143, e in hPa, RH as a fraction (Oke, 2nd ed., p.373; wbgt_liljegren.md §5). */
export function atmosphericEmissivity(tK: number, rhFrac: number): number {
  return 0.575 * Math.pow(rhFrac * liljegrenEsatHpa(tK), 0.143)
}

/** Density of air, kg m⁻³: P·100/(R_AIR·T) with P in hPa (ideal gas; wbgt_liljegren.md §5). */
export function airDensityKgM3(tK: number, pHpa: number): number {
  return (pHpa * 100.0) / (R_AIR * tK)
}

/**
 * Convective heat-transfer coefficient of the 2-inch globe, W m⁻² K⁻¹ (sphere, Bird, Stewart & Lightfoot p.409;
 * wbgt_liljegren.md §6): Re = max(u, 0.13)·ρ·D/μ, Nu = 2 + 0.6·√Re·Pr^0.3333 (exponent 0.3333 literally), h = Nu·k/D.
 * 16.233687621 at 303.15 K, 1013.25 hPa, 1 m/s.
 */
export function hSphereWm2K(tK: number, pHpa: number, speedMs: number): number {
  const visc = viscosityKgMs(tK)
  const re = (Math.max(speedMs, MIN_SPEED) * airDensityKgM3(tK, pHpa) * D_GLOBE) / visc
  const nu = 2.0 + 0.6 * Math.sqrt(re) * PR_SPHERE
  return (nu * (K_FACTOR * visc)) / D_GLOBE
}

/**
 * Convective heat-transfer coefficient of the wick (cylinder in cross flow, Bedingfield & Drew eqn 32;
 * wbgt_liljegren.md §6): Re = max(u, 0.13)·ρ·D/μ, Nu = 0.281·Re^(1−0.4)·Pr^(1−0.56), h = Nu·k/D.
 * 34.1889724975 W m⁻² K⁻¹ at 303.15 K, 1013.25 hPa, 1 m/s.
 */
export function hCylinderWm2K(tK: number, pHpa: number, speedMs: number): number {
  const visc = viscosityKgMs(tK)
  const re = (Math.max(speedMs, MIN_SPEED) * airDensityKgM3(tK, pHpa) * D_WICK) / visc
  const nu = 0.281 * Math.pow(re, 1.0 - 0.4) * PR_CYLINDER
  return (nu * (K_FACTOR * visc)) / D_WICK
}

// ─────────────────────────────── Solvers (wbgt_liljegren.md §7–8) ───────────────────────────────

/** Inputs to the Liljegren globe / wet-bulb solvers: already at 2 m and after the solar pre-processing. */
export interface LiljegrenInputs {
  taC: number
  /** Relative humidity, %; clamped to [1, 100] (D8). */
  rhPct: number
  /** Surface (station) pressure, hPa — not MSL. */
  pHpa: number
  /** Wind speed at 2 m, m/s (floored at 0.13 m/s inside the Reynolds numbers). */
  u2Ms: number
  /** Global horizontal irradiance actually used, W/m² (after the normsolar cap when the caller applies it). */
  ghiWm2: number
  /** Direct-beam fraction of GHI; clamped to [0, 0.9] and set to 0 when cosZenith < CZA_MIN (thermofeel). */
  fdir: number
  /** cos of the apparent solar zenith. */
  cosZenith: number
  /**
   * Extra isotropic long-wave irradiance from hot site surfaces, expressed as ΔL/σ (K⁴); 0 for the reference model.
   * See `wbgtComponents` (radiant boost).
   */
  extraRadiantK4?: number
}

/** Result of one Liljegren fixed-point solve. */
export interface SolveResult {
  /** Solution, °C: the undamped F(x) at convergence (D2), or the bisection root when `fallback`. NaN only if both failed. */
  valueC: number
  /** Fixed-point iterations used (equals the oracle's count for an exact port). */
  iterations: number
  /** True when the damped fixed point met |F(x) − x| < 0.02 K within MAX_ITER = 500. */
  converged: boolean
  /** True when the value came from the bisection fallback (§7.4). */
  fallback: boolean
}

/**
 * thermofeel pre-processing of the direct-beam fraction: clamp to [0, 0.9] and set 0 when cos z < CZA_MIN = 0.00873
 * (wbgt_liljegren.md §3, §13.4; fixture `core_cases[].preprocessing.fdir_used`).
 */
export function preprocessFdir(fdir: number, cosZenith: number): number {
  if (!(cosZenith >= CZA_MIN)) return 0
  return Math.min(Math.max(fdir, 0), FDIR_MAX)
}

/** Damped fixed point x ← 0.9·x + 0.1·F(x); stop when |F(x) − x| < 0.02 K and return F(x) (§7.2, D2). */
function dampedFixedPoint(f: (x: number) => number, x0: number): { x: number; iterations: number; converged: boolean } {
  let prev = x0
  let next = Number.NaN
  for (let it = 1; it <= MAX_ITER; it++) {
    next = f(prev)
    if (!Number.isFinite(next)) return { x: Number.NaN, iterations: it, converged: false }
    const converged = Math.abs(next - prev) < CONVERGENCE
    if (converged) return { x: next, iterations: it, converged: true }
    prev = 0.9 * prev + 0.1 * next
  }
  return { x: next, iterations: MAX_ITER, converged: false }
}

/**
 * Bisection of g(x) = F(x) − x to 1e-4 K (§7.4). g must be > 0 below the root and < 0 above it (non-finite F maps to
 * "too hot"). Brackets widen until the sign changes or the hard limits are reached; null if no bracket exists.
 */
function bisectRoot(
  g: (x: number) => number,
  lo0: number,
  hi0: number,
  widen: number,
  loLimit: number,
  hiLimit: number,
): number | null {
  let lo = Math.max(lo0, loLimit)
  let hi = Math.min(hi0, hiLimit)
  let gLo = g(lo)
  for (let k = 0; k < 40 && !(gLo > 0) && lo > loLimit; k++) {
    lo = Math.max(loLimit, lo - widen)
    gLo = g(lo)
  }
  let gHi = g(hi)
  for (let k = 0; k < 40 && !(gHi < 0) && hi < hiLimit; k++) {
    hi = Math.min(hiLimit, hi + widen)
    gHi = g(hi)
  }
  if (!(gLo > 0) || !(gHi < 0)) return null
  while (hi - lo > 1e-4) {
    const mid = 0.5 * (lo + hi)
    if (g(mid) > 0) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** Globe energy balance of §7.1 for fixed inputs. `arg(prev)` is Tg_new⁴ before the radiant boost. */
interface GlobeModel {
  tk: number
  /** Right-hand side of §7.1 (K⁴) evaluated with Tg_prev = x, without any extra radiant load. */
  arg(x: number): number
}

function globeModel(tk: number, rh: number, pHpa: number, u: number, s: number, fdir: number, cza: number): GlobeModel {
  // thermofeel guard: no beam term when fdir = 0 (the C has none and gives 0·∞ = NaN at cza = 0).
  const beam = fdir > 0.0 ? fdir * (1.0 / (2.0 * cza) - 1.0) : 0.0
  const tk4 = tk ** 4
  const lwIn = 0.5 * (atmosphericEmissivity(tk, rh) * tk4 + EMIS_SFC * tk4)
  const solar = (s / (2.0 * STEFANB * EMIS_GLOBE)) * (1.0 - ALB_GLOBE) * (beam + 1.0 + ALB_SFC)
  return {
    tk,
    arg(x: number): number {
      const h = hSphereWm2K(0.5 * (x + tk), pHpa, u)
      return lwIn - (h / (STEFANB * EMIS_GLOBE)) * (x - tk) + solar
    },
  }
}

function solveGlobeModel(model: GlobeModel, extraK4: number): SolveResult {
  const f = (x: number): number => {
    const a = model.arg(x) + extraK4
    return a >= 0 ? a ** 0.25 : Number.NaN
  }
  const fp = dampedFixedPoint(f, model.tk)
  if (fp.converged) return { valueC: fp.x - KELVIN_OFFSET, iterations: fp.iterations, converged: true, fallback: false }
  const g = (x: number): number => {
    const fx = f(x)
    return Number.isFinite(fx) ? fx - x : Number.NEGATIVE_INFINITY
  }
  // Starting bracket [Ta − 20 K, Ta + 120 K] is the spec's recommendation, "not from the sources" (§7.4); [ENG] it is
  // widened in 30 K steps within [Ta − 150 K, Ta + 400 K], which keeps the property correlations in range.
  const root = bisectRoot(g, model.tk - 20, model.tk + 120, 30, model.tk - 150, model.tk + 400)
  return {
    valueC: root === null ? Number.NaN : root - KELVIN_OFFSET,
    iterations: fp.iterations,
    converged: false,
    fallback: root !== null,
  }
}

function solveWick(
  tk: number,
  rh: number,
  pHpa: number,
  u: number,
  s: number,
  fdir: number,
  cza: number,
  rad: 0 | 1,
  extraK4: number,
): SolveResult {
  const sza = Math.acos(Math.max(-1.0, Math.min(1.0, cza)))
  const eair = rh * liljegrenEsatHpa(tk)
  const tk4 = tk ** 4
  const lwIn = 0.5 * (atmosphericEmissivity(tk, rh) * tk4 + EMIS_SFC * tk4)
  // Beam on the vertical wick = DNI·sin(θ)/π (+ the end cap); no beam term when fdir = 0 (thermofeel guard).
  const beam = fdir > 0.0 ? fdir * (Math.tan(sza) / Math.PI + WICK_DWL) : 0.0
  const swAbs = (1.0 - ALB_WICK) * s * ((1.0 - fdir) * (1.0 + WICK_DWL) + beam + ALB_SFC)
  const extraAbs = STEFANB * EMIS_WICK * extraK4
  const f = (x: number): number => {
    const tref = 0.5 * (x + tk)
    const visc = viscosityKgMs(tref)
    const rho = airDensityKgM3(tref, pHpa)
    const re = (Math.max(u, MIN_SPEED) * rho * D_WICK) / visc
    const h = (0.281 * Math.pow(re, 1.0 - 0.4) * PR_CYLINDER * (K_FACTOR * visc)) / D_WICK
    const fatm = STEFANB * EMIS_WICK * (lwIn - x ** 4) + swAbs + extraAbs
    const ewick = liljegrenEsatHpa(x)
    const sc = visc / (rho * diffusivityM2s(tref, pHpa))
    return (
      tk -
      ((latentHeatEvapJkg(tref) / RATIO) * (ewick - eair)) / (pHpa - ewick) * (PR / sc) ** 0.56 +
      (fatm / h) * rad
    )
  }
  const tdew = liljegrenDewPointK(eair)
  const fp = dampedFixedPoint(f, tdew)
  if (fp.converged) return { valueC: fp.x - KELVIN_OFFSET, iterations: fp.iterations, converged: true, fallback: false }
  // The wick equation is only physical below the boiling point at P (e_wick < P).
  const tBoil = liljegrenDewPointK(pHpa)
  const g = (x: number): number => {
    if (liljegrenEsatHpa(x) >= pHpa) return Number.NEGATIVE_INFINITY
    const fx = f(x)
    return Number.isFinite(fx) ? fx - x : Number.NEGATIVE_INFINITY
  }
  // Starting bracket [Tdew − 15 K, Ta + 60 K] is the spec's recommendation (§7.4); [ENG] the upper end is capped just
  // below boiling at P and the lower end widens in 20 K steps down to 150 K.
  const root = bisectRoot(g, tdew - 15, Math.min(tk + 60, tBoil - 0.01), 20, 150, tBoil - 0.01)
  return {
    valueC: root === null ? Number.NaN : root - KELVIN_OFFSET,
    iterations: fp.iterations,
    converged: false,
    fallback: root !== null,
  }
}

/**
 * 2-inch (0.0508 m) black-globe temperature, °C, by Liljegren's globe energy balance (wbgt_liljegren.md §7.1) and the
 * damped fixed point of §7.2 (start at Ta, x ← 0.9x + 0.1F(x), stop at |F(x) − x| < 0.02 K, return F(x),
 * MAX_ITER 500), with properties at T_ref = (Tg + Ta)/2; bisection fallback on non-convergence (§7.4, D2).
 * fdir is pre-processed as thermofeel does (`preprocessFdir`); GHI is used as given (no normsolar cap here).
 */
export function globeTemperature(inp: LiljegrenInputs): SolveResult {
  const tk = inp.taC + KELVIN_OFFSET
  const rh = clampRhPct(inp.rhPct) / 100
  const fdir = preprocessFdir(inp.fdir, inp.cosZenith)
  const model = globeModel(tk, rh, inp.pHpa, inp.u2Ms, inp.ghiWm2, fdir, inp.cosZenith)
  return solveGlobeModel(model, inp.extraRadiantK4 ?? 0)
}

/**
 * Natural (unaspirated) wet-bulb temperature, °C: Liljegren's wick energy balance with rad = 1 (wbgt_liljegren.md §8),
 * initial guess = dew point, same damped fixed point and fallback as the globe (§7.2, §7.4).
 */
export function naturalWetBulb(inp: LiljegrenInputs): SolveResult {
  const tk = inp.taC + KELVIN_OFFSET
  const rh = clampRhPct(inp.rhPct) / 100
  const fdir = preprocessFdir(inp.fdir, inp.cosZenith)
  return solveWick(tk, rh, inp.pHpa, inp.u2Ms, inp.ghiWm2, fdir, inp.cosZenith, 1, inp.extraRadiantK4 ?? 0)
}

/**
 * Psychrometric (aspirated, radiation-shielded) wet-bulb temperature, °C: the same wick equation with rad = 0
 * (wbgt_liljegren.md §8), so no radiation input is needed. Equals Ta at RH = 100 %.
 */
export function psychrometricWetBulb(taC: number, rhPct: number, pHpa: number, u2Ms: number): SolveResult {
  const tk = taC + KELVIN_OFFSET
  return solveWick(tk, clampRhPct(rhPct) / 100, pHpa, u2Ms, 0, 0, 1, 0, 0)
}

// ─────────────────────────────── WBGT weighting (ISO 7243; wbgt_liljegren.md §9) ───────────────────────────────

/**
 * Outdoor WBGT with direct solar load: WBGT_od = 0.7·Tnwb + 0.2·Tg + 0.1·Ta (ISO 7243, as stated in Lemke &
 * Kjellstrom 2012 Eq. 1 citing Parsons 2003; wbgt_liljegren.md §9, D3).
 */
export function wbgtOutdoorC(tnwbC: number, tgC: number, taC: number): number {
  return 0.7 * tnwbC + 0.2 * tgC + 0.1 * taC
}

/**
 * Indoor / shade WBGT without direct solar load: WBGT_id = 0.7·Tnwb + 0.3·Tg (ISO 7243, Lemke & Kjellstrom 2012
 * Eq. 2; wbgt_liljegren.md §9, D3).
 */
export function wbgtIndoorC(tnwbC: number, tgC: number): number {
  return 0.7 * tnwbC + 0.3 * tgC
}

// ─────────────────────────────── Solar pre-processing (wbgt_liljegren.md §11) ───────────────────────────────

/** Liljegren direct-beam pre-processing result (wbgt.c `calc_solar_parameters`). */
export interface DirectBeamResult {
  /** GHI passed to the solvers: S*·TOA when TOA > 0 (replaces GHI when GHI/TOA > 0.85), else GHI unchanged. */
  ghiUsedWm2: number
  /** Direct-beam fraction, 0–0.9. */
  fdir: number
  /** Clearness index GHI/TOA before the cap; null when TOA = 0 (sun below CZA_MIN or night). */
  clearness: number | null
  /** True when the 0.85 normsolar cap reduced GHI. */
  capped: boolean
}

/**
 * Liljegren's direct-beam fraction from GHI (wbgt.c `calc_solar_parameters`; wbgt_liljegren.md §11, D6):
 * S* = min(GHI/TOA, 0.85), GHI_used = S*·TOA, fdir = clamp(exp(3 − 1.34·S* − 1.65/S*), 0, 0.9); TOA ≤ 0 → GHI
 * unchanged (diffuse) and fdir = 0. The cap bounds the implied DNI at 0.9·0.85·1367/R² ≈ 1046 W/m², so the 1/(2 cos z)
 * term cannot blow up at low sun. Zill applies it although thermofeel leaves fdir to the caller (fixture `full_cases`
 * include it; `core_cases` are solver-level and do not).
 */
export function liljegrenDirectBeam(ghiWm2: number, toaWm2: number): DirectBeamResult {
  if (!(toaWm2 > 0)) return { ghiUsedWm2: ghiWm2, fdir: 0, clearness: null, capped: false }
  const kt = ghiWm2 / toaWm2
  const ns = Math.min(kt, NORMSOLAR_MAX)
  const used = ns * toaWm2
  if (ns <= 0) return { ghiUsedWm2: used, fdir: 0, clearness: kt, capped: false }
  const fdir = Math.max(Math.min(Math.exp(3.0 - 1.34 * ns - 1.65 / ns), FDIR_MAX), 0.0)
  return { ghiUsedWm2: used, fdir, clearness: kt, capped: kt > NORMSOLAR_MAX }
}

/**
 * Top-of-atmosphere horizontal irradiance as wbgt.c uses it: 1367·max(cos z, 0)/R², and 0 when cos z < CZA_MIN
 * (wbgt_liljegren.md §11, §13.3 step 3).
 */
export function liljegrenToaWm2(cosZenith: number, earthSunAu: number): number {
  return cosZenith >= CZA_MIN ? toaHorizontalWm2(cosZenith, earthSunAu) : 0
}

/**
 * Clear-sky GHI estimate used when solar radiation is unknown: max(910·cos z − 30, 0) W/m² (Kasten–Czeplak 1980, as
 * used by the OSHA heat-stress calculator's Liljegren wrapper; wbgt_liljegren.md §14). Zill's fail-safe rule
 * "unknown solar → clear-sky estimate" (ARCHITECTURE §5).
 */
export function clearSkyGhiWm2(cosZenith: number): number {
  return Math.max(910 * cosZenith - 30, 0)
}

// ─────────────────────────────── Wind (wbgt_liljegren.md §12) ───────────────────────────────

/** Pasquill stability class 1–6 (= A–F). */
export type StabilityClass = 1 | 2 | 3 | 4 | 5 | 6

/** Terrain for the wind power-law exponents. Urban is the default and the conservative choice by day (D7). */
export type WindTerrain = 'urban' | 'rural'

/**
 * Solar Radiation / Delta-T (SRDT) key, EPA-454/R-99-005 Table 6-7, as coded in wbgt.c `stab_srdt` (rows = 10 m wind
 * bins, columns = day radiation bins ≥ 925, ≥ 675, ≥ 175, < 175 W/m², an unused column, night dT < 0, night dT ≥ 0).
 * Quirk Q2 (kept for parity): the night "2.0–2.5 m/s" row reads E, F where EPA reads D, E (WBGT effect ≤ 0.012 °C).
 */
export const LSRDT: readonly (readonly number[])[] = [
  [1, 1, 2, 4, 0, 5, 6, 0],
  [1, 2, 3, 4, 0, 5, 6, 0],
  [2, 2, 3, 4, 0, 4, 4, 0],
  [3, 3, 4, 4, 0, 0, 0, 0],
  [3, 4, 4, 4, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
]

/** Urban power-law exponents by class A–F (EPA Table 6-2; wbgt.c arrays; wbgt_liljegren.md §12). */
export const URBAN_WIND_EXPONENTS: readonly number[] = [0.15, 0.15, 0.2, 0.25, 0.3, 0.3]

/** Rural power-law exponents by class A–F (EPA Table 6-2; wbgt.c only — Zill uses urban, D7). */
export const RURAL_WIND_EXPONENTS: readonly number[] = [0.07, 0.07, 0.1, 0.15, 0.35, 0.55]

/**
 * Pasquill stability class by the SRDT method (wbgt.c `stab_srdt`; wbgt_liljegren.md §12). Daytime is cos z > 0 and
 * uses the radiation bins (pass GHI_used); night uses the bins < 2, 2–< 2.5, ≥ 2.5 m/s and the dT < 0 column unless
 * `nightDeltaTNonNegative` (C only — thermofeel always uses dT < 0).
 */
export function stabilityClassSrdt(
  daytime: boolean,
  u10Ms: number,
  ghiWm2: number,
  nightDeltaTNonNegative = false,
): StabilityClass {
  let row: number
  let col: number
  if (daytime) {
    col = ghiWm2 >= 925.0 ? 0 : ghiWm2 >= 675.0 ? 1 : ghiWm2 >= 175.0 ? 2 : 3
    row = u10Ms >= 6.0 ? 4 : u10Ms >= 5.0 ? 3 : u10Ms >= 3.0 ? 2 : u10Ms >= 2.0 ? 1 : 0
  } else {
    col = nightDeltaTNonNegative ? 6 : 5
    row = u10Ms >= 2.5 ? 2 : u10Ms >= 2.0 ? 1 : 0
  }
  return LSRDT[row][col] as StabilityClass
}

/**
 * Power-law wind at 2 m: u2 = max(u10·(2/10)^p, 0.13) m/s with p from the class (EPA Table 6-2; wbgt.c
 * `est_wind_speed`; wbgt_liljegren.md §12).
 */
export function windSpeed2mMs(u10Ms: number, stabilityClass: StabilityClass, terrain: WindTerrain = 'urban'): number {
  const p = (terrain === 'urban' ? URBAN_WIND_EXPONENTS : RURAL_WIND_EXPONENTS)[stabilityClass - 1]
  return Math.max(u10Ms * (REF_HEIGHT / WIND_HEIGHT) ** p, MIN_SPEED)
}

/** Result of the 10 m → 2 m wind conversion. */
export interface Wind2mResult {
  /** 10 m wind after the optional 0.62 m/s floor. */
  u10UsedMs: number
  u2Ms: number
  stabilityClass: StabilityClass
  exponent: number
}

/**
 * 10 m → 2 m wind as in thermofeel's public API (wbgt_liljegren.md §12, D7): u10 = max(u10, 0.62) (UNVERIFIED KNMI
 * attribution), class from SRDT with daytime = cos z > 0 and GHI_used, urban exponents, 2 m floor 0.13 m/s. Urban gives
 * the lower daytime 2 m wind, hence the higher WBGT in sun (conservative).
 */
export function wind2mFrom10m(
  u10Ms: number,
  cosZenith: number,
  ghiUsedWm2: number,
  opts: { terrain?: WindTerrain; apply10mFloor?: boolean; nightDeltaTNonNegative?: boolean } = {},
): Wind2mResult {
  const terrain = opts.terrain ?? 'urban'
  const u10UsedMs = opts.apply10mFloor === false ? u10Ms : Math.max(u10Ms, MIN_WIND_10M)
  const stabilityClass = stabilityClassSrdt(cosZenith > 0, u10UsedMs, ghiUsedWm2, opts.nightDeltaTNonNegative ?? false)
  const exponent = (terrain === 'urban' ? URBAN_WIND_EXPONENTS : RURAL_WIND_EXPONENTS)[stabilityClass - 1]
  return { u10UsedMs, u2Ms: windSpeed2mMs(u10UsedMs, stabilityClass, terrain), stabilityClass, exponent }
}

// ─────────────────────────────── Mean radiant temperature (phs_iso7933.md §10) ───────────────────────────────

/**
 * Mean radiant temperature of the modelled 2-inch globe, °C, by inverting Liljegren's own globe balance
 * (phs_iso7933.md §10.3, recommended method (a)): T_mrt⁴ = T_g⁴ + h_sphere(T_ref, P, v)/(5.6696e-8·0.95)·(T_g − T_a),
 * T_ref = (T_g + T_a)/2, D = 0.0508 m. Recovers the model's radiant forcing to within 0.04 °C. Do NOT use the ISO 7726
 * 0.15 m-globe constants for this globe (they mis-read by 3–12 °C). This is a black-globe MRT, an upper bound on a
 * standing person's MRT in the same field (≈ 94 vs 74 °C in full sun, §10.3 item 3).
 */
export function globeMrtC(tgC: number, taC: number, pHpa: number, u2Ms: number): number {
  const tgK = tgC + KELVIN_OFFSET
  const taK = taC + KELVIN_OFFSET
  const h = hSphereWm2K(0.5 * (tgK + taK), pHpa, u2Ms)
  return Math.max(tgK ** 4 + (h / (STEFANB * EMIS_GLOBE)) * (tgK - taK), 0) ** 0.25 - KELVIN_OFFSET
}

/**
 * Globe MRT straight from the radiation field the Liljegren model uses (phs_iso7933.md §10.3 item 2):
 * T_mrt,g⁴ = ½(ε_a·T_a⁴ + ε_sfc·T_sfc⁴) + S(1 − α_g)/(2σε_g)·(f_dir(1/(2 cos z) − 1) + 1 + α_sfc), T_sfc = T_a.
 * Cross-check for `globeMrtC` (they agree within ~0.04 °C).
 */
export function globeMrtFromRadiationC(
  taC: number,
  rhPct: number,
  ghiWm2: number,
  fdir: number,
  cosZenith: number,
): number {
  const tk = taC + KELVIN_OFFSET
  const f = preprocessFdir(fdir, cosZenith)
  const model = globeModel(tk, clampRhPct(rhPct) / 100, 1013.25, 1, ghiWm2, f, cosZenith)
  // arg(tk) has no convective term (x − Ta = 0), leaving the radiant forcing alone.
  return model.arg(tk) ** 0.25 - KELVIN_OFFSET
}

// ─────────────────────────────── BoM comparator (NOT Liljegren; wbgt_liljegren.md §17) ───────────────────────────────

/**
 * Australian Bureau of Meteorology shade approximation, **comparator only — never for alerts or risk decisions**
 * (wbgt_liljegren.md §17, D9): WBGT = 0.567·Ta + 0.393·e + 3.94, e = RH/100·6.105·exp(17.27·Ta/(237.7 + Ta)) hPa.
 * It ignores radiation and wind; in Abu Dhabi data it exceeds Liljegren by up to ≈ 7 °C at night and matches only by
 * coincidence at dry noon. Lemke & Kjellstrom (2012): "does not match our criteria for validity".
 */
export function bomApproxWbgtNotForAlerts(taC: number, rhPct: number): { wbgtC: number; eHpa: number } {
  const eHpa = (rhPct / 100.0) * 6.105 * Math.exp((17.27 * taC) / (237.7 + taC))
  return { wbgtC: 0.567 * taC + 0.393 * eHpa + 3.94, eHpa }
}

// ─────────────────────────────── Full pipeline ───────────────────────────────

/** How the direct-beam fraction is obtained. */
export type FdirMethod = 'liljegren' | 'direct_ratio'

/** Fail-safe substitutions applied by `wbgtComponents` (the caller logs them as drivers with direction 'raises'). */
export type WbgtDefaultId =
  | 'wind_unknown_floor'
  | 'solar_unknown_clear_sky'
  | 'pressure_unknown_standard'
  | 'radiant_boost_invalid_ignored'
  | 'direct_ratio_unavailable'

/** Options for `wbgtComponents`. */
export interface WbgtOptions {
  /**
   * Length (min) of the radiation averaging window that ends at `env.t`. Geometry is evaluated at its mid-point
   * (wbgt_liljegren.md §13.3, D5). Default: 0 (instantaneous) for `site_sensor`, otherwise 60 — Open-Meteo radiation is
   * the "preceding hour mean".
   */
  radiationAvgMin?: number
  /**
   * Engineered shade (solid roof): Tg_shade = max(Tg(S = 0), Ta), because a roof at ≈ Ta replaces the cold open sky
   * the reference model assumes (§9 design caveat; up to +0.8 °C WBGT). Default true — [ENG] conservative default for
   * rest areas. False reproduces the reference (OSHA "solar irradiance = 0") shade exactly.
   */
  engineeredShade?: boolean
  /** Apply `env.radiantBoostC` to the shade globe as well. Default true — [ENG] protective (rest areas on hot ground). */
  radiantBoostInShade?: boolean
  /** Wind exponents. Default 'urban' (D7). */
  terrain?: WindTerrain
  /**
   * 'liljegren' (default, D6) or 'direct_ratio' = Open-Meteo direct/GHI, a **sensitivity check only** (§11): no
   * normsolar cap on GHI, fdir bounded by 0.765·TOA/GHI, then clamped to [0, 0.9]. Falls back to 'liljegren' when
   * `env.directWm2` is missing.
   */
  fdirMethod?: FdirMethod
  /** Also compute the calm-air upper bound with u2 = 0.13 m/s (§12 recommendation). Default false. */
  includeCalmAirBound?: boolean
}

/** Everything the WBGT stack derives from one environmental sample. Temperatures °C. */
export interface WbgtComponents {
  t: number
  source: EnvSource
  /** Exposure WBGT in sun: the site meter's ISO 7243 reading when `env.measuredWbgtC` is present, else `wbgtModelC`. */
  wbgtC: number
  wbgtSource: 'measured' | 'model'
  /** Modelled outdoor WBGT in direct sun, 0.7·Tnwb + 0.2·Tg + 0.1·Ta (Liljegren 2008). Always computed. */
  wbgtModelC: number
  /** Modelled shade WBGT: same air and 2 m wind, S = 0, 0.7·Tnwb + 0.3·Tg (engineered-shade floor if enabled). */
  wbgtShadeC: number
  /** Calm-air upper bound (u2 = 0.13 m/s) in sun, or null when not requested. */
  wbgtCalmAirC: number | null
  /** Measured minus modelled sun WBGT (QA), or null without a meter reading. */
  measuredMinusModelC: number | null
  /** 2-inch black-globe temperature in sun (including any radiant boost). */
  tgC: number
  /** Natural wet bulb in sun. */
  tnwbC: number
  /** Psychrometric wet bulb (no radiation; identical in sun and shade). */
  tpwbC: number
  /** Black-globe MRT in sun, from the modelled globe (phs_iso7933.md §10.3 (a)). */
  mrtC: number
  tgShadeC: number
  tnwbShadeC: number
  mrtShadeC: number
  engineeredShade: boolean
  taC: number
  /** RH used by the model (from the dew point when available), clamped to [1, 100] %. */
  rhPct: number
  humidityFrom: 'dew_point' | 'rh'
  pHpa: number
  /** 10 m wind after the 0.62 m/s floor. */
  wind10Ms: number
  /** 2 m wind used by the models. */
  wind2Ms: number
  stabilityClass: StabilityClass
  windExponent: number
  /** Instant of the solar geometry (t − avg/2). */
  tEvalMs: number
  /** cos of the apparent zenith at tEvalMs. */
  cosZenith: number
  apparentZenithDeg: number
  earthSunAu: number
  /** Liljegren TOA (0 when cos z < CZA_MIN). */
  toaWm2: number
  /** GHI entering the pipeline (after clamping negatives / clear-sky substitution). */
  ghiInputWm2: number
  /** GHI passed to the solvers (after the 0.85 cap in 'liljegren' mode). */
  ghiUsedWm2: number
  clearness: number | null
  /** Direct-beam fraction passed to the solvers (after pre-processing). */
  fdir: number
  fdirMethod: FdirMethod
  /** True when a solar bound changed the inputs (normsolar cap, or the fdir bound in 'direct_ratio' mode). */
  solarCapped: boolean
  /** Radiant boost applied to the sun globe / shade globe, °C. */
  radiantBoostC: number
  radiantBoostShadeC: number
  /** True when every fixed-point solve converged. */
  converged: boolean
  /** True when any value came from the bisection fallback. */
  solverFallback: boolean
  iterations: { tg: number; tnwb: number; tpwb: number; tgShade: number; tnwbShade: number }
  /** Fail-safe substitutions applied. */
  defaults: WbgtDefaultId[]
}

interface Boosted {
  tgK: number
  extraK4: number
}

/**
 * Radiant boost, [ENG] method (no standard defines a site radiant allowance): the globe is raised by exactly `boostK`
 * (types.ts: "°C added to globe temperature"), and the extra isotropic long-wave load that holds it there is
 * ΔL/σ = T_gb⁴ − arg(T_gb), i.e. the extra emission plus the extra convective loss at the boosted temperature (§7.1
 * balance). The wick absorbs the same load (emissivity 0.95), so Tnwb and the MRT rise consistently instead of only Tg
 * — adding the °C to Tg alone would understate WBGT, because 0.7 of WBGT comes from the wet bulb.
 */
function boostGlobe(model: GlobeModel, tgK: number, boostK: number): Boosted {
  if (!(boostK > 0)) return { tgK, extraK4: 0 }
  const tgb = tgK + boostK
  return { tgK: tgb, extraK4: Math.max(tgb ** 4 - model.arg(tgb), 0) }
}

function finite(x: number | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

/**
 * Outdoor (sun) and shade WBGT, globe, natural / psychrometric wet bulb and globe MRT for one environmental sample
 * (Liljegren et al. 2008 via thermofeel; wbgt_liljegren.md §13.4 reference pipeline, decisions D2–D8):
 *  1. RH from `tdC` when present (Liljegren esat, clamped to [1, 100] %), else `rhPct` clamped.
 *  2. NOAA apparent zenith at t − avg/2 (D4, D5); TOA = 1367·cz/R², 0 when cz < 0.00873.
 *  3. S* = min(GHI/TOA, 0.85), GHI_used = S*·TOA, Liljegren fdir (D6).
 *  4. u10 ≥ 0.62 m/s, SRDT class, urban power law, u2 ≥ 0.13 m/s (D7).
 *  5. Globe and wet bulbs by the damped fixed point with bisection fallback (D2); WBGT = 0.7·Tnwb + 0.2·Tg + 0.1·Ta.
 *  6. Shade: same Ta, RH, P and 2 m wind, S = 0, WBGT = 0.7·Tnwb + 0.3·Tg (D3), with the engineered-shade floor
 *     Tg ≥ Ta by default [ENG].
 *  7. Radiant boost (`env.radiantBoostC`, site hot surfaces): Tg + boost, with the matching long-wave load applied to
 *     the wick (see `boostGlobe`); invalid or negative values are ignored [ENG].
 *  8. `env.measuredWbgtC` (site meter, ISO 7243) becomes the exposure WBGT; the model values are kept alongside.
 * Fail-safe substitutions (logged in `defaults`): unknown wind → the model's minimum (10 m floor 0.62 m/s; the
 * ARCHITECTURE default of 0.5 m/s is below it); unknown GHI → Kasten–Czeplak clear sky; unknown pressure → 1013.25 hPa
 * [ENG]. Throws a RangeError when air temperature or humidity is missing — there is no safe default for those.
 */
export function wbgtComponents(env: EnvSample, latDeg: number, lonDeg: number, opts: WbgtOptions = {}): WbgtComponents {
  if (!finite(env.taC)) throw new RangeError('wbgtComponents: air temperature (taC) is required')
  const defaults: WbgtDefaultId[] = []
  const taC = env.taC
  const tk = taC + KELVIN_OFFSET

  // 1. Humidity (D8, §13.2): dew point preferred; RH is the fallback.
  let rhPct: number
  let humidityFrom: 'dew_point' | 'rh'
  if (finite(env.tdC)) {
    rhPct = rhFromDewPointPct(taC, env.tdC)
    humidityFrom = 'dew_point'
  } else if (finite(env.rhPct)) {
    rhPct = clampRhPct(env.rhPct)
    humidityFrom = 'rh'
  } else {
    throw new RangeError('wbgtComponents: humidity (tdC or rhPct) is required')
  }
  const rh = rhPct / 100

  // [ENG] Unknown pressure → standard 1013.25 hPa. Modelled WBGT rises with P (+0.005…+0.15 °C from 965 to
  // 1013.25 hPa in our checks), and every Zill site lies near sea level, so the standard value errs high.
  let pHpa = env.pHpa
  if (!finite(pHpa) || pHpa <= 0) {
    pHpa = 1013.25
    defaults.push('pressure_unknown_standard')
  }

  // 2. Solar geometry at the mid-point of the averaging window (D4, D5). [ENG] A site pyranometer is treated as
  // instantaneous unless the caller states its averaging window.
  const avgMin = opts.radiationAvgMin ?? env.radiationWindowMin ?? (env.source === 'site_sensor' ? 0 : 60)
  const sun = hourMeanSolarPosition(env.t, latDeg, lonDeg, avgMin)
  const cza = sun.cosApparentZenith
  const toaWm2 = liljegrenToaWm2(cza, sun.earthSunAu)

  let ghiInputWm2: number
  if (finite(env.ghiWm2)) {
    ghiInputWm2 = Math.max(0, env.ghiWm2)
  } else {
    ghiInputWm2 = clearSkyGhiWm2(cza)
    defaults.push('solar_unknown_clear_sky')
  }

  // 3. Direct-beam fraction (D6), or the Open-Meteo direct/GHI sensitivity variant (§11 alternative (a)).
  let fdirMethod: FdirMethod = opts.fdirMethod ?? 'liljegren'
  let ghiUsedWm2: number
  let fdirRaw: number
  let clearness: number | null
  let solarCapped: boolean
  if (fdirMethod === 'direct_ratio' && !(finite(env.directWm2) && ghiInputWm2 > 0)) {
    fdirMethod = 'liljegren'
    defaults.push('direct_ratio_unavailable')
  }
  if (fdirMethod === 'direct_ratio') {
    const ratio = Math.max(0, env.directWm2 as number) / ghiInputWm2
    const bound = toaWm2 > 0 ? (FDIR_MAX * NORMSOLAR_MAX * toaWm2) / ghiInputWm2 : 0
    fdirRaw = Math.min(ratio, bound)
    solarCapped = toaWm2 > 0 && ratio > bound
    ghiUsedWm2 = ghiInputWm2
    clearness = toaWm2 > 0 ? ghiInputWm2 / toaWm2 : null
  } else {
    const db = liljegrenDirectBeam(ghiInputWm2, toaWm2)
    ghiUsedWm2 = db.ghiUsedWm2
    fdirRaw = db.fdir
    clearness = db.clearness
    solarCapped = db.capped
  }
  const fdir = preprocessFdir(fdirRaw, cza)

  // 4. Wind (D7).
  let u10 = env.wind10Ms
  if (!finite(u10) || u10 < 0) {
    u10 = 0
    defaults.push('wind_unknown_floor')
  }
  const wind = wind2mFrom10m(u10, cza, ghiUsedWm2, { terrain: opts.terrain ?? 'urban' })
  const u2 = wind.u2Ms

  // Radiant boost (site configuration) — only a positive finite value can be applied [ENG].
  let boostC = 0
  if (env.radiantBoostC !== undefined && env.radiantBoostC !== 0) {
    if (finite(env.radiantBoostC) && env.radiantBoostC > 0) boostC = env.radiantBoostC
    else defaults.push('radiant_boost_invalid_ignored')
  }
  const boostShadeC = (opts.radiantBoostInShade ?? true) ? boostC : 0

  // 5. Sun.
  const sunModel = globeModel(tk, rh, pHpa, u2, ghiUsedWm2, fdir, cza)
  const tgSolve = solveGlobeModel(sunModel, 0)
  const sunBoost = boostGlobe(sunModel, tgSolve.valueC + KELVIN_OFFSET, boostC)
  const tnwbSolve = solveWick(tk, rh, pHpa, u2, ghiUsedWm2, fdir, cza, 1, sunBoost.extraK4)
  const tpwbSolve = solveWick(tk, rh, pHpa, u2, 0, 0, cza, 0, 0)
  const tgC = sunBoost.tgK - KELVIN_OFFSET
  const tnwbC = tnwbSolve.valueC
  const wbgtModelC = wbgtOutdoorC(tnwbC, tgC, taC)

  // 6. Shade: S = 0 with the real 2 m wind.
  const shadeModel = globeModel(tk, rh, pHpa, u2, 0, 0, cza)
  const tgShadeSolve = solveGlobeModel(shadeModel, 0)
  const shadeBoost = boostGlobe(shadeModel, tgShadeSolve.valueC + KELVIN_OFFSET, boostShadeC)
  const tnwbShadeSolve = solveWick(tk, rh, pHpa, u2, 0, 0, cza, 1, shadeBoost.extraK4)
  const engineeredShade = opts.engineeredShade ?? true
  const tgShadeModelC = tgShadeSolve.valueC
  const tgShadeC = (engineeredShade ? Math.max(tgShadeModelC, taC) : tgShadeModelC) + boostShadeC
  const tnwbShadeC = tnwbShadeSolve.valueC
  const wbgtShadeC = wbgtIndoorC(tnwbShadeC, tgShadeC)

  let wbgtCalmAirC: number | null = null
  const solves = [tgSolve, tnwbSolve, tpwbSolve, tgShadeSolve, tnwbShadeSolve]
  if (opts.includeCalmAirBound) {
    const calmModel = globeModel(tk, rh, pHpa, MIN_SPEED, ghiUsedWm2, fdir, cza)
    const tgCalm = solveGlobeModel(calmModel, 0)
    const calmBoost = boostGlobe(calmModel, tgCalm.valueC + KELVIN_OFFSET, boostC)
    const tnwbCalm = solveWick(tk, rh, pHpa, MIN_SPEED, ghiUsedWm2, fdir, cza, 1, calmBoost.extraK4)
    solves.push(tgCalm, tnwbCalm)
    wbgtCalmAirC = wbgtOutdoorC(tnwbCalm.valueC, calmBoost.tgK - KELVIN_OFFSET, taC)
  }
  for (const s of solves) {
    if (!Number.isFinite(s.valueC)) throw new Error('wbgtComponents: Liljegren solver failed to find a solution')
  }

  const measured = finite(env.measuredWbgtC) ? env.measuredWbgtC : undefined
  return {
    t: env.t,
    source: env.source,
    wbgtC: measured ?? wbgtModelC,
    wbgtSource: measured === undefined ? 'model' : 'measured',
    wbgtModelC,
    wbgtShadeC,
    wbgtCalmAirC,
    measuredMinusModelC: measured === undefined ? null : measured - wbgtModelC,
    tgC,
    tnwbC,
    tpwbC: tpwbSolve.valueC,
    mrtC: globeMrtC(tgC, taC, pHpa, u2),
    tgShadeC,
    tnwbShadeC,
    mrtShadeC: globeMrtC(tgShadeC, taC, pHpa, u2),
    engineeredShade,
    taC,
    rhPct,
    humidityFrom,
    pHpa,
    wind10Ms: wind.u10UsedMs,
    wind2Ms: u2,
    stabilityClass: wind.stabilityClass,
    windExponent: wind.exponent,
    tEvalMs: sun.tEvalMs,
    cosZenith: cza,
    apparentZenithDeg: sun.apparentZenithDeg,
    earthSunAu: sun.earthSunAu,
    toaWm2,
    ghiInputWm2,
    ghiUsedWm2,
    clearness,
    fdir,
    fdirMethod,
    solarCapped,
    radiantBoostC: boostC,
    radiantBoostShadeC: boostShadeC,
    converged: solves.every((s) => s.converged),
    solverFallback: solves.some((s) => s.fallback),
    iterations: {
      tg: tgSolve.iterations,
      tnwb: tnwbSolve.iterations,
      tpwb: tpwbSolve.iterations,
      tgShade: tgShadeSolve.iterations,
      tnwbShade: tnwbShadeSolve.iterations,
    },
    defaults,
  }
}
