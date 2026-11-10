/**
 * Renders the result tables of docs/VALIDATION.md from the validation JSON. Each table lives between
 * `<!-- validate:begin:<id> -->` and `<!-- validate:end:<id> -->` markers; only those blocks are rewritten, so the
 * prose around them stays hand-written. Basis: ARCHITECTURE.md §1.7 (every number states its source) and §8.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ReferenceReport } from '../reference'
import type { HoursInZoneReport } from '../hours-in-zone'
import type { ForecastSkillReport } from '../forecast-skill'
import { repoPath } from './io'

/** Repository path of the document. */
export const VALIDATION_DOC = 'docs/VALIDATION.md'

const SITE_NAMES: Record<string, string> = { musaffah: 'Musaffah', kezad: 'KEZAD', ruwais: 'Ruwais', alain: 'Al Ain', saadiyat: 'Saadiyat', all: 'All sites' }
const MODEL_NAMES: Record<string, string> = { ecmwf_ifs025: 'IFS 0.25°', dwd_icon_seamless: 'ICON', ncep_gfs_seamless: 'GFS', era5: 'ERA5', ecmwf_ifs: 'IFS 9 km' }

function cell(x: string | number | null | undefined): string {
  if (x === null || x === undefined) return '—'
  if (typeof x === 'number') return Number.isFinite(x) ? String(x) : '—'
  return x.replace(/\|/g, '\\|')
}

/** A GitHub-flavoured Markdown table. */
export function mdTable(headers: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const head = `| ${headers.map(cell).join(' | ')} |`
  const sep = `|${headers.map(() => '---').join('|')}|`
  return [head, sep, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
}

const f = (x: number | null | undefined, d: number): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))
const pct = (x: number | null | undefined, d = 0): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(100 * x).toFixed(d)} %`)
const sci = (x: number): string => (x === 0 ? '0' : Math.abs(x) < 1e-3 ? x.toExponential(1) : String(x))
const bs = (s: { bias: number; rmse: number }): string => `${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(2)} / ${s.rmse.toFixed(2)}`

// ─────────────────────────────── Reference ───────────────────────────────

function referenceBlocks(r: ReferenceReport): Record<string, string> {
  const summary = mdTable(
    ['Model', 'Checks passed', 'Values compared'],
    r.summary.models.map((m) => [m.label, `${m.passed} / ${m.checks}`, m.values]),
  )
  const checks = mdTable(
    ['Check', 'Reference', 'Cases', 'Quantity', 'max \\|Δ\\|', 'mean \\|Δ\\|', 'Tolerance', 'Pass'],
    r.checks.map((c) => [
      c.title,
      c.kind === 'published_values' ? `published: ${c.reference}` : c.reference,
      c.nCases,
      `${c.quantity} (${c.unit})`,
      sci(c.maxAbsDiff),
      sci(c.meanAbsDiff),
      `${c.toleranceKind === 'rms' ? 'rms ≤ ' : c.toleranceKind === 'rel' ? 'rel ≤ ' : '≤ '}${sci(c.tolerance)}${c.mismatches > 0 ? `, ${c.mismatches} mismatches` : ''}`,
      c.pass ? 'yes' : '**no**',
    ]),
  )
  return {
    'reference-summary': `**${r.summary.passed} of ${r.summary.checks} checks pass.** Stamp \`${r.stamp.stamp}\`.\n\n${summary}`,
    'reference-checks': checks,
  }
}

// ─────────────────────────────── Hours in zone ───────────────────────────────

function hoursBlocks(h: HoursInZoneReport): Record<string, string> {
  const bands = h.config.wbgtBands.map((b) => b.label)
  const ifs = h.sites.filter((s) => s.run === 'ifs')
  const sites = mdTable(
    ['Site', 'p50', 'p95', 'max', ...bands.map((b) => `WBGT ${b}`), 'ADOSH High (sun)', 'Medium (sun)', 'High (shade)', 'Days with High', 'Longest run ≥ 30.8 (h)'],
    ifs.map((s) => [
      SITE_NAMES[s.site] ?? s.site,
      f(s.wbgt.p50, 1),
      f(s.wbgt.p95, 1),
      f(s.wbgt.max, 1),
      ...s.meanSeason.wbgtBands.map((x) => Math.round(x)),
      Math.round(s.meanSeason.adoshSun[0]),
      Math.round(s.meanSeason.adoshSun[1]),
      Math.round(s.meanSeason.adoshShade[0]),
      Math.round(s.meanSeason.daysWithAdoshHigh),
      s.meanSeason.longestRunGeRal115H,
    ]),
  )
  const byYear = mdTable(
    ['Site', ...h.config.years.map(String)],
    ifs.map((s) => [SITE_NAMES[s.site] ?? s.site, ...s.byYear.map((y) => Math.round(y.wbgtBands.slice(2).reduce((a, x) => a + x, 0)))]),
  )
  const midday = mdTable(
    ['Site', 'ADOSH High h/season', 'outside break', 'share outside', 'WBGT ≥ 30.8 h/season', 'outside break', 'share outside', 'of which on dates outside 15 Jun–15 Sep'],
    h.middayBreak.map((m) => [
      SITE_NAMES[m.site] ?? m.site,
      f(m.adoshHighHours, 0),
      f(m.adoshHighOutsideBreak, 0),
      pct(m.adoshHighShareOutside),
      f(m.wbgtGeRal115Hours, 0),
      f(m.wbgtGeRal115OutsideBreak, 0),
      pct(m.wbgtGeRal115ShareOutside),
      pct(m.wbgtGeRal115OutsideSeasonDatesShare),
    ]),
  )
  // Pooled by hour (mean over sites): all 24 h for exposure, 05–19 h for work.
  const allHours = Array.from({ length: 24 }, (_, i) => i)
  const hours = Array.from({ length: 15 }, (_, i) => i + 5)
  const pooledHour = allHours.map((hr) => {
    const rows = h.byHour.filter((x) => x.hour === hr)
    const mean = (g: (x: (typeof rows)[number]) => number): number => rows.reduce((a, x) => a + g(x), 0) / rows.length
    return [
      `${String(hr).padStart(2, '0')}:00`,
      f(mean((x) => x.meanWbgtC), 1),
      f(mean((x) => x.wbgtBands.slice(2).reduce((a, y) => a + y, 0)), 0),
      f(mean((x) => x.wbgtBands[4]), 0),
      f(mean((x) => x.meanTwlSun), 0),
      f(mean((x) => x.adoshSun[0]), 1),
    ]
  })
  const byHour = mdTable(['Local hour', 'mean WBGT (°C)', 'h ≥ 30.8 per season', 'h ≥ 33.0', 'mean TWL sun (W/m²)', 'ADOSH High h (sun)'], pooledHour)
  const months = [6, 7, 8, 9]
  const byMonth = mdTable(
    ['Month', ...bands.map((b) => `WBGT ${b}`), 'ADOSH High (sun)', 'Medium (sun)'],
    months.map((mo) => {
      const rows = h.byMonth.filter((x) => x.month === mo)
      const mean = (g: (x: (typeof rows)[number]) => number): number => rows.reduce((a, x) => a + g(x), 0) / rows.length
      return [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'][mo] ?? String(mo), ...bands.map((_, j) => f(mean((x) => x.wbgtBands[j]), 0)), f(mean((x) => x.adoshSun[0]), 1), f(mean((x) => x.adoshSun[1]), 1)]
    }),
  )
  const combos = [
    ['moderate', 'REL'],
    ['heavy', 'REL'],
    ['moderate', 'RAL'],
    ['heavy', 'RAL'],
  ] as const
  const wr = (hr: number, work: string, limit: string, rest: string): string => {
    const x = h.workRest.byHour.find((y) => y.hour === hr && y.work === work && y.limit === limit && y.rest === rest)
    return x ? `${f(x.meanMinPerHour, 0)}${x.zeroShare >= 0.05 ? ` (${pct(x.zeroShare)} none)` : ''}` : '—'
  }
  const workHour = mdTable(
    ['Local hour', ...combos.flatMap(([w, l]) => [`${w} ${l}, cabin`, `${w} ${l}, shade`])],
    hours.map((hr) => [`${String(hr).padStart(2, '0')}:00`, ...combos.flatMap(([w, l]) => [wr(hr, w, l, 'cabin'), wr(hr, w, l, 'shade')])]),
  )
  const ds = (site: string, mo: number, work: string, limit: string, rest: string): string => {
    const x = h.workRest.dayShift.find((y) => y.site === site && y.month === mo && y.work === work && y.limit === limit && y.rest === rest)
    return x ? `${f(x.meanMinPerHour, 1)}${x.zeroShare >= 0.01 ? ` (${pct(x.zeroShare)} none)` : ''}` : '—'
  }
  const workMonth = mdTable(
    ['Month (07–17 h)', ...combos.flatMap(([w, l]) => [`${w} ${l}, cabin`, `${w} ${l}, shade`])],
    [0, 6, 7, 8, 9].map((mo) => [mo === 0 ? 'Jun–Sep' : ['', '', '', '', '', '', 'Jun', 'Jul', 'Aug', 'Sep'][mo], ...combos.flatMap(([w, l]) => [ds('all', mo, w, l, 'cabin'), ds('all', mo, w, l, 'shade')])]),
  )
  const workSite = mdTable(
    ['Site (07–17 h, Jun–Sep)', ...combos.flatMap(([w, l]) => [`${w} ${l}, cabin`, `${w} ${l}, shade`])],
    [...ifs.map((s) => s.site as string), 'all'].map((site) => [SITE_NAMES[site] ?? site, ...combos.flatMap(([w, l]) => [ds(site, 0, w, l, 'cabin'), ds(site, 0, w, l, 'shade')])]),
  )
  const tp = h.twlPlausibility
  const bsH = tp.published.batesSchneider2008.byHour
  const twl = mdTable(
    ['Site, period', ...tp.rows[0].byHour.map((x) => `${String(x.hour).padStart(2, '0')}:00 sun / shade`)],
    [
      ...tp.rows.filter((r) => r.site === 'all').map((r) => [`All sites, ${r.period === 'june' ? 'June' : 'Jun–Sep'} (model)`, ...r.byHour.map((x) => `${f(x.twlSunMean, 0)} / ${f(x.twlShadeMean, 0)}`)]),
      ['Bates & Schneider 2008, May 2006 (measured)', ...tp.rows[0].byHour.map((x) => f(bsH[x.hour], 1))],
      ['Miller et al. 2011, summers 2007–08 (measured means)', ...tp.rows[0].byHour.map(() => `${tp.published.miller2011.meanBandWm2[0]}–${tp.published.miller2011.meanBandWm2[1]}`)],
    ],
  )
  const below = mdTable(
    ['Site', 'days with a 07–17 h TWL in sun < 140 W/m²', '< 115 W/m²'],
    tp.daysDaytimeMinBelow.map((d) => [SITE_NAMES[d.site] ?? d.site, pct(d.below140Share), pct(d.below115Share)]),
  )
  const sens = mdTable(
    ['Site', 'h ≥ 30.8 IFS', 'ERA5', 'ERA5 − IFS', 'IFS + site radiant allowance', 'allowance effect'],
    h.sensitivity.map((s) => [SITE_NAMES[s.site] ?? s.site, f(s.ral115HoursIfs, 0), f(s.ral115HoursEra5, 0), `${s.era5MinusIfsPct >= 0 ? '+' : ''}${f(s.era5MinusIfsPct, 1)} %`, f(s.ral115HoursWithBoost, 0), `+${f(s.boostMinusNonePct, 1)} %`]),
  )
  const research = mdTable(
    ['Site', 'Model', 'p50 (ours / preview)', 'p95', 'max', 'h ≥ 30', 'h ≥ 32', 'h ≥ 33', 'h ≥ 30 outside break'],
    h.researchComparison.rows.map((r) => [
      SITE_NAMES[r.site] ?? r.site,
      MODEL_NAMES[r.model] ?? r.model,
      `${f(r.ours.p50, 1)} / ${f(r.preview.p50, 1)}`,
      `${f(r.ours.p95, 1)} / ${f(r.preview.p95, 1)}`,
      `${f(r.ours.max, 1)} / ${f(r.preview.max, 1)}`,
      `${f(r.ours.ge30, 0)} / ${f(r.preview.ge30, 0)}`,
      `${f(r.ours.ge32, 0)} / ${f(r.preview.ge32, 0)}`,
      `${f(r.ours.ge33, 0)} / ${f(r.preview.ge33, 0)}`,
      `${f(r.ours.ge30OutsideBreak, 0)} / ${f(r.preview.ge30OutsideBreak, 0)}`,
    ]),
  )
  const anchorSources: Record<string, string> = { metar_obs_met: 'METAR (obs-met)', ecmwf_ifs: 'IFS 9 km model only', era5: 'ERA5 model only' }
  const anchor = mdTable(
    ['Airport', 'Source', 'matched h', ...bands.map((b) => `WBGT ${b}`), 'h ≥ 30.8', 'ADOSH High (sun)'],
    h.observationalAnchor.rows.map((r) => [r.icao, anchorSources[r.source] ?? r.source, r.nMatched, ...r.wbgtBands, r.geRal115, r.adoshHighSun]),
  )
  const hl = h.headline
  const num = (k: string): number => (typeof hl[k] === 'number' ? (hl[k] as number) : Number.NaN)
  const seasonH = num('hoursPerSeason')
  const headline = [
    `- Mean over the five sites (IFS analysis, Jun–Sep 2020–2025): **${f(num('meanSiteHoursGeRal115PerSeason'), 0)} h per season at WBGT ≥ RAL(115 W) ≈ 30.8 °C** (${pct(num('meanSiteHoursGeRal115PerSeason') / seasonH)} of the ${seasonH} hours), of which ${f(num('meanSiteHoursGeRel115PerSeason'), 0)} h at ≥ REL(115 W) ≈ 33.0 °C, where even an acclimatised worker at rest exceeds the REL.`,
    `- ADOSH High zone (TWL ≤ 115 W/m²): ${f(num('meanSiteHoursAdoshHighSunPerSeason'), 0)} h per season with the TWL in sun and ${f(num('meanSiteHoursAdoshHighShadePerSeason'), 0)} h in engineered shade. The TWL zones are reached far less often than the WBGT limits.`,
    `- **${pct(num('shareWbgtGeRal115OutsideMiddayBreak'))} of the hours at WBGT ≥ 30.8 °C and ${pct(num('shareAdoshHighOutsideMiddayBreak'))} of the ADOSH High-zone hours fall outside the midday-break window** (12:30–15:00, 15 Jun–15 Sep).`,
    `- Allowed work over the 07–17 h shift (NIOSH 1-h TWA, work in sun): moderate work under the REL ${f(num('dayShiftModerateRelCabinMinPerHour'), 1)} min/h with rest in a cooled cabin (WBGT ${f(num('cooledRestWbgtC'), 0)} °C) vs ${f(num('dayShiftModerateRelShadeMinPerHour'), 1)} min/h with rest in shade; heavy work under the RAL ${f(num('dayShiftHeavyRalCabinMinPerHour'), 1)} vs ${f(num('dayShiftHeavyRalShadeMinPerHour'), 1)} min/h.`,
  ].join('\n')
  return {
    'hours-headline': headline,
    'hours-sites': sites,
    'hours-by-year': byYear,
    'hours-midday': midday,
    'hours-by-hour': byHour,
    'hours-by-month': byMonth,
    'hours-work-hour': workHour,
    'hours-work-month': workMonth,
    'hours-work-site': workSite,
    'hours-twl': `${twl}\n\n${below}`,
    'hours-sensitivity': sens,
    'hours-research': research,
    'hours-anchor': anchor,
    'hours-stamp': `Stamp \`${h.stamp.stamp}\` · cooled rest WBGT ${h.config.cooledRest.wbgtC} °C (${h.config.cooledRest.source.split(' — ')[0]}).`,
  }
}

// ─────────────────────────────── Forecast skill ───────────────────────────────

function skillBlocks(s: ForecastSkillReport): Record<string, string> {
  const rows: (string | number)[][] = []
  for (const m of s.sameModel) {
    for (const l of m.leads) {
      rows.push([
        `${MODEL_NAMES[m.model] ?? m.model}${m.primary ? ' (primary)' : ''}`,
        `d${l.lead}`,
        `${f(l.wbgt.bias, 2)} / ${f(l.wbgt.mae, 2)} / ${f(l.wbgt.rmse, 2)}`,
        `${f(l.wbgt.rmseCi95[0], 2)}–${f(l.wbgt.rmseCi95[1], 2)}`,
        f(l.wbgt.dailyMaxRmse, 2),
        f(l.wbgt.skillVsPersistence, 2),
        `${f(l.twl.bias, 1)} / ${f(l.twl.mae, 1)} / ${f(l.twl.rmse, 1)}`,
        f(l.twl.dailyMinRmse, 1),
        f(l.twl.skillVsPersistence, 2),
      ])
    }
    for (const p of m.persistence) {
      rows.push([`${MODEL_NAMES[m.model] ?? m.model} persistence`, `${p.lagH} h`, `${f(p.wbgt.bias, 2)} / ${f(p.wbgt.mae, 2)} / ${f(p.wbgt.rmse, 2)}`, '', '', '', `${f(p.twl.bias, 1)} / ${f(p.twl.mae, 1)} / ${f(p.twl.rmse, 1)}`, '', ''])
    }
  }
  const same = mdTable(
    ['Model', 'Lead', 'WBGT bias / MAE / RMSE (°C)', 'RMSE 95 % CI', 'daily-max RMSE', 'MSE skill vs persistence', 'TWL bias / MAE / RMSE (W/m²)', 'daily-min RMSE', 'MSE skill vs persistence'],
    rows,
  )
  const evRows: (string | number)[][] = []
  for (const m of s.sameModel) {
    for (const l of m.leads) {
      for (const e of l.events) {
        evRows.push([MODEL_NAMES[m.model] ?? m.model, `d${l.lead}`, s.config.events.find((x) => x.id === e.id)?.label ?? e.id, pct(e.scores.baseRate, 1), f(e.scores.pod, 2), f(e.scores.far, 2), f(e.scores.csi, 2), f(e.scores.peirce, 2)])
      }
    }
    for (const p of m.persistence) {
      for (const e of p.events.filter((x) => x.id === 'adosh_high' || x.id === 'wbgt_ge_ral115')) {
        evRows.push([`${MODEL_NAMES[m.model] ?? m.model} persistence`, `${p.lagH} h`, s.config.events.find((x) => x.id === e.id)?.label ?? e.id, pct(e.scores.baseRate, 1), f(e.scores.pod, 2), f(e.scores.far, 2), f(e.scores.csi, 2), f(e.scores.peirce, 2)])
      }
    }
  }
  const events = mdTable(['Model', 'Lead', 'Event (verified against d0)', 'base rate', 'POD', 'FAR', 'CSI', 'Peirce'], evRows)
  const dmRows: (string | number)[][] = []
  for (const m of s.sameModel) {
    for (const l of m.leads) {
      const high = l.events.find((e) => e.id === 'adosh_high')?.scores
      const nHigh = high ? high.hits + high.misses : 0
      const nAll = high ? high.n : 0
      dmRows.push([
        MODEL_NAMES[m.model] ?? m.model,
        `d${l.lead}`,
        `${l.dangerousMisses.adosh} of ${nHigh} (${pct(nHigh > 0 ? l.dangerousMisses.adosh / nHigh : Number.NaN)})`,
        `${l.dangerousMisses.wbgtBands} of ${nAll} (${pct(nAll > 0 ? l.dangerousMisses.wbgtBands / nAll : Number.NaN, 1)})`,
      ])
    }
  }
  const dangerous = mdTable(['Model', 'Lead', 'ADOSH: forecast Low while d0 is High (h)', 'WBGT: forecast ≥ 2 bands below d0 (h)'], dmRows)
  const prim = s.sameModel.find((m) => m.primary)
  const byHour = prim
    ? mdTable(
        ['Lead', ...Array.from({ length: 8 }, (_, i) => `${String(i * 3).padStart(2, '0')}:00`)],
        prim.leads.map((l) => [`d${l.lead} WBGT RMSE`, ...Array.from({ length: 8 }, (_, i) => f(l.rmseByLocalHour.wbgt[i * 3], 2))]),
      )
    : ''
  const analysis = mdTable(
    ['Airport', 'Analysis', 'n', 'T bias / RMSE', 'Td bias / RMSE', 'wind bias / RMSE (m/s)', 'WBGT all hours', 'WBGT 07–18 h', 'WBGT from T/Td only', 'TWL (W/m²)'],
    s.airports.analysis.map((a) => [a.icao, MODEL_NAMES[a.model] ?? a.model, a.n, bs(a.t), bs(a.td), bs(a.wind), bs(a.wbgtAll), bs(a.wbgtDaytime), bs(a.wbgtTTdOnly), `${f(a.twlAll.bias, 1)} / ${f(a.twlAll.rmse, 1)}`]),
  )
  const fRows: string[][] = []
  for (const icao of ['OMAA', 'OMAD', 'OMAL']) {
    for (const model of s.config.models) {
      const r = s.airports.forecast.filter((x) => x.icao === icao && x.model === model).sort((a, b) => a.lead - b.lead)
      if (r.length === 0) continue
      fRows.push([icao, MODEL_NAMES[model] ?? model, r.map((x) => bs(x.t)).join(' → '), r.map((x) => bs(x.td)).join(' → '), r.map((x) => bs(x.wbgt)).join(' → '), r.map((x) => `${f(x.twl.bias, 0)} / ${f(x.twl.rmse, 0)}`).join(' → ')])
    }
  }
  const forecast = mdTable(['Airport', 'Model', 'T (°C) d0 → d3', 'Td (°C) d0 → d3', 'WBGT (°C) d0 → d3', 'TWL (W/m²) d0 → d3'], fRows)
  // Research comparison: largest absolute differences.
  const maxDiff: Record<string, number> = {}
  for (const r of s.researchComparison.airports.rows) {
    const key = r.variable.startsWith('wbgt') ? 'WBGT' : r.variable === 't' ? 'T' : r.variable === 'td' ? 'Td' : 'wind'
    maxDiff[key] = Math.max(maxDiff[key] ?? 0, Math.abs(r.ours[0] - r.preview[0]), Math.abs(r.ours[1] - r.preview[1]))
  }
  const sameCmp = mdTable(
    ['Model', 'Lead', 'RMSE ours / preview', 'daily-max RMSE ours / preview', 'CSI ≥ 30 °C ours / preview', 'CSI ≥ 32 °C ours / preview'],
    s.researchComparison.sameModel.rows
      .filter((r) => r.lead > 0)
      .map((r) => [MODEL_NAMES[r.model] ?? r.model, `d${r.lead}`, `${cell(r.ours.rmse)} / ${cell(r.preview.rmse)}`, `${cell(r.ours.dailyMaxRmse)} / ${cell(r.preview.dailyMaxRmse)}`, `${cell(r.ours.ge30Csi)} / ${cell(r.preview.ge30Csi ?? null)}`, `${cell(r.ours.ge32Csi)} / ${cell(r.preview.ge32Csi ?? null)}`]),
  )
  const cmpText = `Largest |ours − preview| over the airport tables (bias and RMSE): ${Object.entries(maxDiff)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ')} (°C or m/s).`
  const hl = s.headline
  const n = (k: string): number => (typeof hl[k] === 'number' ? (hl[k] as number) : Number.NaN)
  const headline = [
    `- Same-model WBGT error of the primary model (IFS 0.25°, five sites, Jun–Sep 2024–2025): RMSE **${f(n('wbgtRmseD1'), 2)} / ${f(n('wbgtRmseD2'), 2)} / ${f(n('wbgtRmseD3'), 2)} °C at d1 / d2 / d3** (24 h persistence ${f(n('persistence24hWbgtRmse'), 2)} °C; MSE skill vs persistence ${f(n('wbgtSkillVsPersistenceD1'), 2)} at d1). Daily-max RMSE ${f(n('wbgtDailyMaxRmseD1'), 2)} / ${f(n('wbgtDailyMaxRmseD2'), 2)} / ${f(n('wbgtDailyMaxRmseD3'), 2)} °C.`,
    `- WBGT ≥ RAL(115 W) is forecast well (CSI ${f(n('wbgtGeRal115CsiD1'), 2)} / ${f(n('wbgtGeRal115CsiD2'), 2)} / ${f(n('wbgtGeRal115CsiD3'), 2)}). The rarer ADOSH High zone is harder: d1 POD ${f(n('adoshHighPodD1'), 2)}, FAR ${f(n('adoshHighFarD1'), 2)}, CSI ${f(n('adoshHighCsiD1'), 2)} (TWL RMSE ${f(n('twlRmseD1'), 1)} W/m² at d1).`,
    `- Against METAR at the airports (bias / RMSE, d1, obs-met reference): OMAA ${f(n('airportOMAAWbgtBiasD1'), 2)} / ${f(n('airportOMAAWbgtRmseD1'), 2)}, OMAD ${f(n('airportOMADWbgtBiasD1'), 2)} / ${f(n('airportOMADWbgtRmseD1'), 2)}, OMAL ${f(n('airportOMALWbgtBiasD1'), 2)} / ${f(n('airportOMALWbgtRmseD1'), 2)} °C WBGT. GFS is too dry for humidity: d1 dew-point bias ${f(n('airportOMAAGfsTdBiasD1'), 1)}, ${f(n('airportOMADGfsTdBiasD1'), 1)}, ${f(n('airportOMALGfsTdBiasD1'), 1)} °C.`,
  ].join('\n')
  return {
    'skill-headline': headline,
    'skill-same-model': same,
    'skill-events': `${events}\n\nDangerous misses (forecast at least two zones or bands below the verifying d0 value):\n\n${dangerous}`,
    'skill-by-hour': byHour,
    'skill-airport-analysis': analysis,
    'skill-airport-forecast': forecast,
    'skill-research': `${sameCmp}\n\n${cmpText}`,
    'skill-stamp': `Stamp \`${s.stamp.stamp}\`.`,
  }
}

/** Every generated block, keyed by marker id. */
export function renderValidationBlocks(ref: ReferenceReport | null, hours: HoursInZoneReport | null, skill: ForecastSkillReport | null): Record<string, string> {
  return { ...(ref ? referenceBlocks(ref) : {}), ...(hours ? hoursBlocks(hours) : {}), ...(skill ? skillBlocks(skill) : {}) }
}

/**
 * Replace the content of every `<!-- validate:begin:<id> -->…<!-- validate:end:<id> -->` block of `text` whose id has
 * a rendering (pure). Returns the new text, the ids updated, and the ids present without a rendering.
 */
export function replaceValidationBlocks(text: string, blocks: Record<string, string>): { text: string; updated: string[]; missing: string[] } {
  const updated: string[] = []
  const missing: string[] = []
  const re = /<!-- validate:begin:([a-z0-9-]+) -->[\s\S]*?<!-- validate:end:\1 -->/g
  const out = text.replace(re, (whole, id: string) => {
    const body = blocks[id]
    if (body === undefined) {
      missing.push(id)
      return whole
    }
    updated.push(id)
    return `<!-- validate:begin:${id} -->\n${body}\n<!-- validate:end:${id} -->`
  })
  return { text: out, updated, missing }
}

/** Rewrite the generated blocks of docs/VALIDATION.md (see {@link replaceValidationBlocks}). */
export function updateValidationDoc(blocks: Record<string, string>): { updated: string[]; missing: string[] } {
  const path = repoPath(VALIDATION_DOC)
  if (!existsSync(path)) return { updated: [], missing: Object.keys(blocks) }
  const r = replaceValidationBlocks(readFileSync(path, 'utf8'), blocks)
  writeFileSync(path, r.text, 'utf8')
  return { updated: r.updated, missing: r.missing }
}
