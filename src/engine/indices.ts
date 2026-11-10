/**
 * Site heat indices — the integration point between the environmental sample and the per-worker risk engine.
 *
 * One call turns an {@link EnvSample} into everything the channels need (ARCHITECTURE.md §5):
 * - outdoor (sun) and shade WBGT, globe, natural and psychrometric wet bulb (Liljegren 2008 via `wbgt.ts`);
 * - the HUMAN mean radiant temperature of a standing person in sun and in shade, the ISO 7933 PHS input
 *   (Thorsson et al. 2007; Di Napoli et al. 2020 / thermofeel `calculate_mean_radiant_temperature`). The black-globe
 *   MRT is an upper bound on a person's MRT (≈ 94 vs 74 °C in full sun, phs_iso7933.md §10.3) and is kept for TWL;
 * - the Thermal Work Limit in sun and shade (Brake & Bates 2002, `twl.ts`), the index of ADOSH-SF CoP 11.0 v4.0;
 * - the NWS heat index (`limits.ts`), the Brake & Bates 2002 withdrawal backstop (advisory), and fail-safe drivers.
 *
 * Pure TypeScript: no DOM, no clock, no randomness.
 */
import type { EnvSample, HeatIndices, RiskDriver, Site } from './types'
import { KELVIN_OFFSET } from './units'
import { clampRhPct } from './psychro'
import { hourMeanSolarPosition } from './solar'
import {
  LILJEGREN,
  atmosphericEmissivity,
  clearSkyGhiWm2,
  globeMrtC,
  liljegrenToaWm2,
  preprocessFdir,
  wbgtComponents,
  type WbgtComponents,
  type WbgtDefaultId,
  type WbgtOptions,
  type WindTerrain,
} from './wbgt'
import {
  bb2002WithdrawalBackstop,
  computeTwl,
  psychrometricWetBulbC,
  vapourPressureFromRhKpa,
  type Bb2002Backstop,
  type TwlFlag,
} from './twl'
import { heatIndexNwsC } from './limits'

// ═════════════════════════════════════ Human mean radiant temperature ═════════════════════════════════════

/**
 * Constants of the standing-person MRT (Thorsson et al. 2007 Int J Climatol 27:1983; Di Napoli et al. 2020 Int J
 * Biometeorol 64:1233; thermofeel 2.3.0 `calculate_mean_radiant_temperature`, read from the source):
 * - shortwave absorptivity of the clothed body α_k = 0.7, long-wave emissivity ε_p = 0.97 (ISO 7726 / Höppe 1992);
 * - angular factor 0.5 for the upper and the lower hemisphere (Di Napoli 2020 simplification);
 * - projected-area factor of a standing person f_p = 0.308·cos(h·(0.998 − h²/50000)), h = solar elevation (degrees)
 *   (Fanger 1970 fit used by Di Napoli 2020);
 * - σ = 5.67e-8 W m⁻² K⁻⁴ for the conversion to MRT (thermofeel), while the long-wave fluxes are built with the
 *   Liljegren σ (5.6696e-8) and its sky/ground terms — the oracle (scripts/oracles/mrt_human_oracle.py) does the same;
 * - default ground albedo 0.45 = the Liljegren model's ground albedo [ENG: keeps the person and the globe in one
 *   radiation field; bright desert/concrete 0.3–0.6].
 */
export const HUMAN_MRT = {
  SHORTWAVE_ABSORPTIVITY: 0.7,
  LONGWAVE_EMISSIVITY: 0.97,
  ANGULAR_FACTOR: 0.5,
  FP_COEFF: 0.308,
  SIGMA_MRT: 5.67e-8,
  SIGMA_FLUX: LILJEGREN.STEFANB,
  GROUND_EMISSIVITY: LILJEGREN.EMIS_SFC,
  DEFAULT_ALBEDO: LILJEGREN.ALB_SFC,
  basis:
    'Thorsson et al. 2007; Di Napoli et al. 2020 (thermofeel calculate_mean_radiant_temperature); Liljegren et al. 2008 sky/ground radiation field; phs_iso7933.md §10.3',
} as const

/** Inputs of {@link humanMrtC}. Temperatures °C, irradiances W/m². */
export interface HumanMrtInput {
  taC: number
  /** Relative humidity (%), clamped to [1, 100] like the WBGT model. Sets the clear-sky emissivity. */
  rhPct: number
  /**
   * Global horizontal irradiance, INSTANTANEOUS at the geometry time (use `WbgtComponents.ghiUsedWm2`, which is
   * already paired with the geometry of the averaging window's mid-point and capped by the Liljegren normsolar rule).
   */
  ghiWm2: number
  /** Direct-beam fraction of GHI (Liljegren). Pre-processed here: clamped to [0, 0.9], 0 when cos z < 0.00873. */
  fdir: number
  /** Cosine of the (apparent) solar zenith angle at the geometry time. */
  cosZenith: number
  /**
   * Ground surface temperature for the upward long-wave term. Default: air temperature — the Liljegren model's
   * surface assumption. LIMITATION: sun-baked ground, asphalt or steel decks run 10–30 °C above air at midday, so
   * the default under-reads the MRT there; pass a measured or site-configured value when known.
   */
  groundTempC?: number
  /** Ground shortwave albedo; default 0.45 (Liljegren) [ENG]. */
  albedo?: number
  /**
   * Engineered (roofed) shade [ENG]: no direct and no diffuse-sky shortwave (the roof blocks both), reflected ground
   * shortwave kept (sunlit ground around a shelter still reflects), and MRT ≥ Ta because a roof near air temperature
   * replaces the cold clear sky (same reasoning as the WBGT engineered-shade floor, wbgt.ts).
   */
  shade?: boolean
}

function requireFinite(fn: string, name: string, v: number): void {
  if (!Number.isFinite(v)) throw new RangeError(`${fn}: ${name} must be a finite number (got ${v})`)
}

/**
 * Mean radiant temperature of a standing person (°C), the ISO 7933 PHS t_r input:
 *
 *   MRT⁴ = (1/σ)·[ ½·L↓ + ½·L↑ + (α_k/ε_p)·( ½·D + ½·R + f_p·I ) ]
 *
 * with L↓ = ε_a(T_a, RH)·σ_L·T_a⁴ (Liljegren clear-sky sky emissivity, `wbgt.atmosphericEmissivity`),
 * L↑ = ε_sfc·σ_L·T_sfc⁴ (ε_sfc 0.999, T_sfc default T_a), D = (1 − f)·GHI diffuse, R = albedo·GHI reflected,
 * I = f·GHI / cos z the direct-normal irradiance with the Liljegren low-sun guard (f = 0 when cos z < 0.00873,
 * `wbgt.preprocessFdir`), f_p the projected-area factor at the solar elevation h = asin(cos z).
 * Basis: Thorsson et al. 2007; Di Napoli et al. 2020 (thermofeel 2.3.0); oracle fixtures/mrt_human.json (1e-6 °C).
 * Engineered shade: see {@link HumanMrtInput.shade}.
 * @throws RangeError on a non-finite input (the caller applies its fail-safe defaults first).
 */
export function humanMrtC(input: HumanMrtInput): number {
  const fn = 'humanMrtC'
  requireFinite(fn, 'taC', input.taC)
  requireFinite(fn, 'rhPct', input.rhPct)
  requireFinite(fn, 'ghiWm2', input.ghiWm2)
  requireFinite(fn, 'fdir', input.fdir)
  requireFinite(fn, 'cosZenith', input.cosZenith)
  const tk = input.taC + KELVIN_OFFSET
  const tsfcC = input.groundTempC !== undefined && Number.isFinite(input.groundTempC) ? input.groundTempC : input.taC
  const tsfcK = tsfcC + KELVIN_OFFSET
  const albedo = input.albedo !== undefined && Number.isFinite(input.albedo) ? Math.min(Math.max(input.albedo, 0), 1) : HUMAN_MRT.DEFAULT_ALBEDO
  const ghi = Math.max(0, input.ghiWm2)
  const cz = input.cosZenith
  const f = preprocessFdir(input.fdir, cz)

  const lDown = atmosphericEmissivity(tk, clampRhPct(input.rhPct) / 100) * HUMAN_MRT.SIGMA_FLUX * tk ** 4
  const lUp = HUMAN_MRT.GROUND_EMISSIVITY * HUMAN_MRT.SIGMA_FLUX * tsfcK ** 4
  const reflected = albedo * ghi
  let diffuse = (1 - f) * ghi
  let dni = f > 0 ? (f * ghi) / cz : 0
  if (input.shade === true) {
    diffuse = 0
    dni = 0
  }
  const hDeg = (Math.asin(Math.min(1, Math.max(-1, cz))) * 180) / Math.PI
  const fp = HUMAN_MRT.FP_COEFF * Math.cos(((hDeg * (0.998 - (hDeg * hDeg) / 50000)) * Math.PI) / 180)
  const a = HUMAN_MRT.ANGULAR_FACTOR
  const s =
    a * lDown +
    a * lUp +
    (HUMAN_MRT.SHORTWAVE_ABSORPTIVITY / HUMAN_MRT.LONGWAVE_EMISSIVITY) * (a * diffuse + a * reflected + fp * dni)
  const mrtC = Math.pow(Math.max(s, 0) / HUMAN_MRT.SIGMA_MRT, 0.25) - KELVIN_OFFSET
  return input.shade === true ? Math.max(mrtC, input.taC) : mrtC
}

// ═════════════════════════════════════ Site heat ═════════════════════════════════════

/** Fail-safe defaults applied by {@link computeSiteHeat} (ARCHITECTURE.md §5). */
export const SITE_HEAT_DEFAULTS = {
  /** Unknown wind → 0.5 m/s at 10 m (ARCHITECTURE §5; the WBGT model then applies its 0.62 m/s 10 m floor). */
  windUnknown10Ms: 0.5,
  /** |measured − modelled WBGT| above which the meter or its placement should be checked [ENG]. */
  meterDiscrepancyC: 3,
  /**
   * Clear-sky index used by the unknown-solar fallback: the HIGHEST site P95 hourly clear-sky index of the cached
   * 2020–2025 ECMWF IFS archive. Provenance: src/data/weather.ts CONSERVATIVE_PROFILE ktClear (ruwais and alain 0.728;
   * musaffah 0.717, kezad 0.719, saadiyat 0.71), reproduced by data/weather.ts deriveConservativeProfile. Replicated
   * here because the engine must not import src/data; update both together.
   */
  clearSkyIndexMax: 0.728,
  basis: 'ARCHITECTURE.md §1.3 and §5 fail-safe defaults',
} as const

/**
 * Fail-safe clear-sky GHI (W/m²) for a sample without solar radiation (ARCHITECTURE.md §5 "unknown solar → clear-sky
 * estimate (the more protective of the engine and data-layer clear-sky models)"): the larger of the wbgt.ts
 * Kasten–Czeplak estimate max(910·cos z − 30, 0) and {@link SITE_HEAT_DEFAULTS}.clearSkyIndexMax × TOA, with the
 * Liljegren TOA = 1367·cos z/R² (0 when cos z < 0.00873). In summer the k_t·TOA term is ≈ 960 vs 880 W/m² at
 * cos z = 1 and dominates at every sun angle; the max keeps either model from under-reading.
 */
export function failSafeClearSkyGhiWm2(cosZenith: number, earthSunAu: number): number {
  return Math.max(clearSkyGhiWm2(cosZenith), SITE_HEAT_DEFAULTS.clearSkyIndexMax * liljegrenToaWm2(cosZenith, earthSunAu))
}

/** Options of {@link computeSiteHeat}. */
export interface SiteHeatOptions {
  /** Engineered (roofed) shade for the rest area: WBGT and human-MRT shade floors. Default true [ENG]. */
  engineeredShade?: boolean
  /**
   * Radiation averaging window (min) ending at `env.t`. Default: `env.radiationWindowMin`, else 0 for a site sensor
   * and 60 for model data — the `wbgtComponents` rule (geometry at the window mid-point).
   */
  radiationAvgMin?: number
  /** Wind-profile terrain for the 10 m → 2 m conversion. Default 'urban'. */
  terrain?: WindTerrain
  /** Ground surface temperature for the human MRT; default air temperature (see {@link HumanMrtInput.groundTempC}). */
  groundTempC?: number
  /** Ground albedo for the human MRT; default 0.45. */
  albedo?: number
}

/**
 * Everything the risk channels need from one environmental sample. Extends the shared {@link HeatIndices} contract:
 * `mrtC` is the HUMAN MRT in sun (PHS input), `twlWm2` the TWL in sun (globe-field MRT), `wbgtC` the measured WBGT
 * when a site meter is present.
 */
export interface SiteHeat extends HeatIndices {
  siteId: Site['id']
  taC: number
  /** RH used by every model (from the dew point when present, clamped to [1, 100] %). */
  rhPct: number
  pHpa: number
  /** Human MRT of a standing person in the (engineered) shade, °C. */
  mrtHumanShadeC: number
  /** MRT seen by the 2-inch black globe in sun (Liljegren globe inversion) — the TWL radiant input, °C. */
  mrtGlobeC: number
  /** Globe MRT in the shade (engineered-shade floor applied), °C. */
  mrtGlobeShadeC: number
  /** Psychrometric wet bulb consistent with the TWL psychrometer equation (twl.ts), °C — TWL and backstop input. */
  twbPsychrometricC: number
  /** TWL with the shade globe MRT (rest area / shaded workplace), W/m². */
  twlShadeWm2: number
  twlFlags: TwlFlag[]
  twlShadeFlags: TwlFlag[]
  /** True when the sun TWL lies inside the model's 60–380 W/m² validity range. */
  twlInValidRange: boolean
  /** Full Liljegren component set (sun and shade). */
  components: WbgtComponents
  /** True when `wbgtC` is a site-meter reading (ISO 7243). */
  measured: boolean
  /** Measured − modelled WBGT in sun (°C), null without a meter. */
  measuredMinusModelC: number | null
  /** Brake & Bates 2002 withdrawal backstop (DB > 44 °C or WB > 32 °C) — ADVISORY, not part of ADOSH v4.0. */
  backstop: Bb2002Backstop
  /** Fail-safe defaults applied and data-quality notes (channel 'environment'). */
  drivers: RiskDriver[]
}

/** Driver ids emitted by {@link computeSiteHeat} (stable, for i18n). */
export const SITE_HEAT_DRIVER_IDS = [
  'env_wind_default',
  'env_solar_clear_sky',
  'env_pressure_default',
  'env_radiant_boost_ignored',
  'env_radiant_boost_site_default',
  'wbgt_measured',
  'wbgt_meter_model_mismatch',
  'wbgt_solver_not_converged',
  'twl_out_of_valid_range',
  'bb2002_backstop',
] as const

const DEFAULT_TO_DRIVER: Partial<Record<WbgtDefaultId, { id: (typeof SITE_HEAT_DRIVER_IDS)[number]; text: string; direction: RiskDriver['direction'] }>> = {
  solar_unknown_clear_sky: { id: 'env_solar_clear_sky', text: 'Solar radiation unknown: assuming clear sky.', direction: 'raises' },
  pressure_unknown_standard: { id: 'env_pressure_default', text: 'Air pressure unknown: assuming 1013.25 hPa (errs high).', direction: 'raises' },
  radiant_boost_invalid_ignored: { id: 'env_radiant_boost_ignored', text: 'Invalid site radiant allowance ignored.', direction: 'info' },
}

const isNum = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Extra isotropic long-wave load of the site radiant boost, as a T⁴ increment (K⁴). `wbgt.ts` raises the globe by
 * exactly `boostC` and holds it there with an isotropic long-wave load (boostGlobe); that load is the difference of
 * the globe MRT⁴ with and without the boost. A long-wave load adds ΔL/σ to the MRT⁴ of any grey body (the emissivity
 * cancels), so the same increment applies to the human MRT [ENG: keeps PHS consistent with the boosted WBGT].
 */
function boostK4(tgC: number, boostC: number, taC: number, pHpa: number, u2Ms: number): number {
  if (!(boostC > 0)) return 0
  const withBoost = globeMrtC(tgC, taC, pHpa, u2Ms) + KELVIN_OFFSET
  const without = globeMrtC(tgC - boostC, taC, pHpa, u2Ms) + KELVIN_OFFSET
  return Math.max(0, withBoost ** 4 - without ** 4)
}

const addK4 = (mrtC: number, k4: number): number => (k4 > 0 ? ((mrtC + KELVIN_OFFSET) ** 4 + k4) ** 0.25 - KELVIN_OFFSET : mrtC)

/**
 * Site heat for one environmental sample (ARCHITECTURE.md §3 engine layer, §5 inputs):
 * 1. Fail-safe defaults: unknown wind → 0.5 m/s at 10 m (then the Liljegren 0.62 m/s floor), unknown GHI → clear sky
 *    ({@link failSafeClearSkyGhiWm2}: the more protective of Kasten–Czeplak and the P95 clear-sky index × TOA, at the
 *    geometry of the radiation window's mid-point), unknown pressure → 1013.25 hPa; each is logged as a 'raises'
 *    driver. Unknown air
 *    temperature or humidity has no safe default: `wbgtComponents` throws a RangeError and the data layer must supply
 *    its conservative default sample instead. A sample without `radiantBoostC` takes the site's configured value.
 * 2. `wbgtComponents` (Liljegren 2008) with engineered shade by default, honouring `env.radiationWindowMin`.
 * 3. Human MRT (Thorsson 2007 / Di Napoli 2020) in sun and engineered shade from the same radiation field
 *    (`ghiUsedWm2`, `fdir`, `cosZenith`), plus the site radiant boost as a long-wave load → `mrtC`, `mrtHumanShadeC`.
 * 4. TWL (Brake & Bates 2002) with the psychrometric wet bulb consistent with TWL's own psychrometer equation, the
 *    globe-field MRT (sun: `components.mrtC`; shade: `components.mrtShadeC`), the 2 m wind and p = pHpa/10.
 *    The Liljegren psychrometric wet bulb (`tpwbC`) is NOT used for TWL: it runs ≈ 0.5 °C below TWL's psychrometer
 *    value for the same air (44 °C/20 %: 23.97 vs 24.51 °C), which would raise TWL by ≈ 5 W/m² — less protective.
 * 5. NWS heat index of the air; Brake & Bates withdrawal backstop (advisory driver only).
 * Typical cost ≈ 0.05 ms per call.
 */
export function computeSiteHeat(env: EnvSample, site: Site, opts: SiteHeatOptions = {}): SiteHeat {
  const drivers: RiskDriver[] = []
  const driver = (id: (typeof SITE_HEAT_DRIVER_IDS)[number], text: string, direction: RiskDriver['direction'], basis: string, value?: number, unit?: string): void => {
    const d: RiskDriver = { id, channel: 'environment', text, direction, basis }
    if (value !== undefined) d.value = value
    if (unit !== undefined) d.unit = unit
    drivers.push(d)
  }

  // 1. Fail-safe field defaults.
  let sample: EnvSample = env
  if (!(isNum(env.wind10Ms) && env.wind10Ms >= 0)) {
    sample = { ...sample, wind10Ms: SITE_HEAT_DEFAULTS.windUnknown10Ms }
    driver('env_wind_default', 'Wind unknown: assuming 0.5 m/s.', 'raises', SITE_HEAT_DEFAULTS.basis, SITE_HEAT_DEFAULTS.windUnknown10Ms, 'm/s')
  }
  if (!isNum(env.ghiWm2)) {
    // Same geometry rule as wbgtComponents (window mid-point; 0 min for a site sensor, else 60 min unless stated).
    const avgMin = opts.radiationAvgMin ?? env.radiationWindowMin ?? (env.source === 'site_sensor' ? 0 : 60)
    const sun = hourMeanSolarPosition(env.t, site.lat, site.lon, avgMin)
    const ghi = failSafeClearSkyGhiWm2(sun.cosApparentZenith, sun.earthSunAu)
    sample = { ...sample, ghiWm2: ghi }
    driver(
      'env_solar_clear_sky',
      'Solar radiation unknown: assuming clear sky.',
      'raises',
      `${SITE_HEAT_DEFAULTS.basis}; max(Kasten–Czeplak, P95 clear-sky index ${SITE_HEAT_DEFAULTS.clearSkyIndexMax} × TOA)`,
      ghi,
      'W/m²',
    )
  }
  if (env.radiantBoostC === undefined && site.radiantBoostC > 0) {
    sample = { ...sample, radiantBoostC: site.radiantBoostC }
    driver(
      'env_radiant_boost_site_default',
      `Site radiant allowance +${site.radiantBoostC} °C applied to the globe (hot work surfaces).`,
      'raises',
      'Site configuration (sites.ts RADIANT_BOOST_BASIS) [ENG]',
      site.radiantBoostC,
      '°C',
    )
  }

  // 2. Liljegren WBGT stack.
  const wOpts: WbgtOptions = { engineeredShade: opts.engineeredShade ?? true }
  if (opts.radiationAvgMin !== undefined) wOpts.radiationAvgMin = opts.radiationAvgMin
  if (opts.terrain !== undefined) wOpts.terrain = opts.terrain
  const c = wbgtComponents(sample, site.lat, site.lon, wOpts)
  for (const id of c.defaults) {
    const m = DEFAULT_TO_DRIVER[id]
    if (m) driver(m.id, m.text, m.direction, `${SITE_HEAT_DEFAULTS.basis}; wbgt.ts wbgtComponents`)
  }
  if (!c.converged) {
    driver('wbgt_solver_not_converged', 'WBGT solver used its bisection fallback.', 'info', 'Liljegren et al. 2008; wbgt_liljegren.md §7.2 (D2)')
  }

  // 3. Human MRT in sun and shade, same radiation field, plus the radiant boost as a long-wave load.
  const mrtBase = { taC: c.taC, rhPct: c.rhPct, ghiWm2: c.ghiUsedWm2, fdir: c.fdir, cosZenith: c.cosZenith, groundTempC: opts.groundTempC, albedo: opts.albedo }
  const mrtSunC = addK4(humanMrtC(mrtBase), boostK4(c.tgC, c.radiantBoostC, c.taC, c.pHpa, c.wind2Ms))
  const shadeRaw = c.engineeredShade ? humanMrtC({ ...mrtBase, shade: true }) : humanMrtC({ ...mrtBase, ghiWm2: 0 })
  const mrtShadeC = addK4(shadeRaw, boostK4(c.tgShadeC, c.radiantBoostShadeC, c.taC, c.pHpa, c.wind2Ms))

  // 4. TWL with a TWL-consistent psychrometric wet bulb and the globe-field MRT.
  const pKpa = c.pHpa / 10
  const paKpa = vapourPressureFromRhKpa(c.taC, c.rhPct)
  const twbC = psychrometricWetBulbC(c.taC, paKpa, pKpa)
  const twl = computeTwl({ tdbC: c.taC, twbPsychrometricC: twbC, mrtC: c.mrtC, windMs: c.wind2Ms, pKpa })
  const twlShade = computeTwl({ tdbC: c.taC, twbPsychrometricC: twbC, mrtC: c.mrtShadeC, windMs: c.wind2Ms, pKpa })
  if (!twl.inValidRange && Number.isFinite(twl.twlWm2)) {
    driver(
      'twl_out_of_valid_range',
      `TWL ${Math.round(twl.twlWm2)} W/m² is outside the model's 60–380 W/m² range.`,
      'info',
      'Brake & Bates 2002 (TWL valid 60–380 W/m²); twl.ts',
      twl.twlWm2,
      'W/m²',
    )
  }

  // 5. Heat index, backstop, meter.
  const heatIndexC = heatIndexNwsC(c.taC, c.rhPct)
  const backstop = bb2002WithdrawalBackstop(c.taC, twbC)
  if (backstop.triggered) {
    driver(
      'bb2002_backstop',
      `Extreme air (${backstop.reasons.join(', ')}): Brake & Bates 2002 withdrawal backstop — advisory, not an ADOSH rule.`,
      'info',
      backstop.basis,
    )
  }
  const measured = c.wbgtSource === 'measured'
  if (measured) {
    driver('wbgt_measured', 'WBGT from the site meter (ISO 7243).', 'info', 'ISO 7243:2017 measured WBGT; types.ts EnvSample.measuredWbgtC', c.wbgtC, '°C')
    const diff = c.measuredMinusModelC
    if (diff !== null && Math.abs(diff) > SITE_HEAT_DEFAULTS.meterDiscrepancyC) {
      driver(
        'wbgt_meter_model_mismatch',
        `Site meter differs from the weather model by ${diff > 0 ? '+' : ''}${diff.toFixed(1)} °C: check the meter and its placement.`,
        'info',
        `${SITE_HEAT_DEFAULTS.basis}; ±${SITE_HEAT_DEFAULTS.meterDiscrepancyC} °C [ENG]`,
        diff,
        '°C',
      )
    }
  }

  return {
    t: env.t,
    wbgtC: c.wbgtC,
    wbgtShadeC: c.wbgtShadeC,
    tgC: c.tgC,
    tnwbC: c.tnwbC,
    tpwbC: c.tpwbC,
    mrtC: mrtSunC,
    wind2Ms: c.wind2Ms,
    twlWm2: twl.twlWm2,
    heatIndexC,
    cosZenith: c.cosZenith,
    source: env.source,
    siteId: site.id,
    taC: c.taC,
    rhPct: c.rhPct,
    pHpa: c.pHpa,
    mrtHumanShadeC: mrtShadeC,
    mrtGlobeC: c.mrtC,
    mrtGlobeShadeC: c.mrtShadeC,
    twbPsychrometricC: twbC,
    twlShadeWm2: twlShade.twlWm2,
    twlFlags: twl.flags,
    twlShadeFlags: twlShade.flags,
    twlInValidRange: twl.inValidRange,
    components: c,
    measured,
    measuredMinusModelC: c.measuredMinusModelC,
    backstop,
    drivers,
  }
}
