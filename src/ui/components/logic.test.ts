import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RISK_LEVELS, type ActionId } from '../../engine/types'
import { matchPattern, parseHash, pathFor, toHref, VIEW_META, VIEW_ORDER } from '../router'
import { ACTION_ICONS } from './actions'
import { sortRows, type DataTableColumn } from './DataTable'
import { formatClock, formatMinutes, formatNumber, formatSigned, NO_DATA } from './format'
import { DEFAULT_LEVEL_LABELS, LEVEL_STYLES } from './levels'
import { levelForValue, type MeterThreshold } from './Meter'

// ─────────────────────────────── WCAG 2.2 contrast, computed from the live tokens ───────────────────────────────

const css =
  readFileSync(new URL('../../index.css', import.meta.url), 'utf8') +
  readFileSync(new URL('../../../node_modules/tailwindcss/theme.css', import.meta.url), 'utf8')

/** First definition wins, so project tokens (src/index.css) take precedence over Tailwind's defaults. */
const TOKENS = new Map<string, string>()
for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) {
  if (!TOKENS.has(m[1])) TOKENS.set(m[1], m[2].trim())
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** WCAG 2.2 relative luminance of a "#rrggbb"/"#rgb" or Tailwind "oklch(L% C H)" colour (OKLab → sRGB, Ottosson 2020). */
function luminance(value: string): number {
  let r: number
  let g: number
  let b: number
  if (value.startsWith('#')) {
    const hex = value.length === 4 ? [...value.slice(1)].map((x) => x + x).join('') : value.slice(1)
    ;[r, g, b] = [0, 2, 4].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255))
  } else {
    const m = value.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/)
    if (!m) throw new Error(`Unsupported colour ${value}`)
    const L = Number(m[1]) / 100
    const h = (Number(m[3]) * Math.PI) / 180
    const A = Number(m[2]) * Math.cos(h)
    const B = Number(m[2]) * Math.sin(h)
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    const clip = (x: number) => Math.min(1, Math.max(0, x))
    r = clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s)
    g = clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s)
    b = clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio between two token names or Tailwind colour classes ("text-safe", "bg-safe-bg", "white"). */
function contrast(a: string, b: string): number {
  const value = (name: string) => {
    const token = name.replace(/^(text|bg|border)-/, '')
    const v = TOKENS.get(token)
    if (!v) throw new Error(`Unknown colour token ${name}`)
    return luminance(v)
  }
  const [hi, lo] = [value(a), value(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('risk-level encoding', () => {
  it('gives every level a distinct pictogram and label (WCAG 2.2 SC 1.4.1: never colour alone)', () => {
    expect(new Set(RISK_LEVELS.map((l) => LEVEL_STYLES[l].icon)).size).toBe(RISK_LEVELS.length)
    expect(new Set(RISK_LEVELS.map((l) => DEFAULT_LEVEL_LABELS[l])).size).toBe(RISK_LEVELS.length)
  })

  it.each(RISK_LEVELS)('%s text meets AA (4.5:1) on white and on its tint (SC 1.4.3)', (level) => {
    const s = LEVEL_STYLES[level]
    expect(contrast(s.text, 'white')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(s.text, s.tint)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(RISK_LEVELS)('%s foreground meets AA on its solid fill (SC 1.4.3)', (level) => {
    const s = LEVEL_STYLES[level]
    expect(contrast(s.onSolid, s.solid)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(RISK_LEVELS)('%s marks reach 3:1 on white and on the same-ramp track (SC 1.4.11)', (level) => {
    const s = LEVEL_STYLES[level]
    expect(contrast(s.mark, 'white')).toBeGreaterThanOrEqual(3)
    expect(contrast(s.mark, s.track)).toBeGreaterThanOrEqual(3)
  })
})

describe('neutral, brand and control colours meet their documented contrast', () => {
  it.each([
    ['ink', 'surface', 4.5],
    ['muted', 'surface', 4.5],
    ['subtle', 'surface', 4.5],
    ['subtle', 'canvas', 4.5],
    ['white', 'shade', 4.5],
    ['white', 'stop-fill', 4.5],
    ['white', 'emergency-fill', 4.5],
    ['shade', 'surface', 3],
    ['shade-light', 'ink', 3],
    ['slate-500', 'white', 3],
    ['slate-700', 'slate-100', 4.5],
    ['shade-dark', 'shade-bg', 4.5],
    ['sky-800', 'sky-50', 4.5],
    ['indigo-800', 'indigo-50', 4.5],
    ['stone-700', 'stone-50', 4.5],
  ] as const)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min)
  })
})

describe('action pictograms', () => {
  it('resolves an icon for every ActionId', () => {
    const ids = Object.keys(ACTION_ICONS) as ActionId[]
    expect(ids.length).toBe(22)
    for (const id of ids) expect(ACTION_ICONS[id]).toBeTruthy()
  })
})

// ─────────────────────────────── Router ───────────────────────────────

describe('router', () => {
  it('describes every view exactly once', () => {
    expect(new Set(VIEW_ORDER).size).toBe(VIEW_ORDER.length)
    for (const id of VIEW_ORDER) expect(VIEW_META[id].id).toBe(id)
  })

  it('resolves empty, root and non-route hashes to the overview', () => {
    for (const hash of ['', '#', '#/', '#main']) expect(parseHash(hash).id).toBe('overview')
  })

  it('matches every static route of ARCHITECTURE.md §9', () => {
    for (const id of ['supervisor', 'medic', 'regulator', 'governance', 'lab', 'evidence'] as const) {
      expect(parseHash(`#/${id}`).id).toBe(id)
    }
  })

  it('extracts decoded worker params and query values', () => {
    const r = parseHash('#/worker/w%20014?lang=ar&step=2')
    expect(r).toMatchObject({ id: 'worker', pattern: '/worker/:id', path: '/worker/w%20014' })
    expect(r.params).toEqual({ id: 'w 014' })
    expect(r.query).toEqual({ lang: 'ar', step: '2' })
  })

  it('normalises duplicate and trailing slashes', () => {
    expect(parseHash('#//supervisor/').path).toBe('/supervisor')
    expect(parseHash('#//supervisor/').id).toBe('supervisor')
  })

  it('reports not_found for unknown paths and malformed worker paths', () => {
    for (const hash of ['#/nope', '#/worker', '#/worker/a/b']) expect(parseHash(hash).id).toBe('not_found')
  })

  it('keeps a malformed percent-escape instead of throwing', () => {
    expect(parseHash('#/worker/%E0%A4%A').params.id).toBe('%E0%A4%A')
  })

  it('round-trips pathFor through toHref and parseHash, including reserved characters', () => {
    expect(parseHash(toHref(pathFor('worker', { id: 'w/14 ä?' }))).params.id).toBe('w/14 ä?')
    expect(pathFor('overview')).toBe('/')
    expect(pathFor('lab', undefined, { scenario: 'heatwave', seed: 7, skip: undefined, off: null })).toBe(
      '/lab?scenario=heatwave&seed=7',
    )
  })

  it('builds hrefs from any spelling of a path', () => {
    expect(toHref('supervisor')).toBe('#/supervisor')
    expect(toHref('/supervisor/')).toBe('#/supervisor')
    expect(toHref('#/lab?x=1')).toBe('#/lab?x=1')
    expect(toHref('/')).toBe('#/')
  })

  it('matches a single pattern', () => {
    expect(matchPattern('/worker/:id', '/worker/abc')).toEqual({ id: 'abc' })
    expect(matchPattern('/worker/:id', '/supervisor')).toBeNull()
  })
})

// ─────────────────────────────── Formatting ───────────────────────────────

describe('formatting', () => {
  it('formats numbers with fixed decimals, grouping and a true minus sign', () => {
    expect(formatNumber(1284.46, 1)).toBe('1,284.5')
    expect(formatNumber(-3.25, 1)).toBe('−3.3')
    expect(formatNumber(-0.04, 1)).toBe('0.0')
  })

  it('shows missing values as missing, never as zero (fail-safe)', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatNumber(v)).toBe(NO_DATA)
    expect(formatClock(Number.NaN)).toBe(NO_DATA)
    expect(formatMinutes(null)).toBe(NO_DATA)
  })

  it('signs deltas explicitly and drops the sign when the change rounds to zero', () => {
    expect(formatSigned(1.2, 1)).toBe('+1.2')
    expect(formatSigned(-0.8, 1)).toBe('−0.8')
    expect(formatSigned(0)).toBe('0')
    expect(formatSigned(-0.01, 1)).toBe('0.0')
  })

  it('floors countdowns so they never show more time than remains', () => {
    expect(formatClock(12.5)).toBe('12:30')
    expect(formatClock(0.7)).toBe('0:42')
    expect(formatClock(1.999)).toBe('1:59')
    expect(formatClock(61.25)).toBe('1:01:15')
    expect(formatClock(-3)).toBe('0:00')
    expect(formatMinutes(0)).toBe('0 min')
    expect(formatMinutes(0.5)).toBe('<1 min')
    expect(formatMinutes(12.9)).toBe('12 min')
    expect(formatMinutes(65)).toBe('1 h 05 min')
  })
})

// ─────────────────────────────── Meter levels ───────────────────────────────

describe('levelForValue', () => {
  // ADOSH-SF CoP 11.0 v4.0 TWL zones (ARCHITECTURE.md §5): Low > 140, Medium 115–140, High < 115 W/m².
  const twl: MeterThreshold[] = [
    { value: 140, level: 'caution' },
    { value: 115, level: 'high' },
  ]

  it('applies higher-is-better bands with inclusive, protective edges', () => {
    expect(levelForValue(141, twl, 'higher-is-better')).toBe('safe')
    expect(levelForValue(140, twl, 'higher-is-better')).toBe('caution')
    expect(levelForValue(128, twl, 'higher-is-better')).toBe('caution')
    expect(levelForValue(115, twl, 'higher-is-better')).toBe('high')
    expect(levelForValue(90, twl, 'higher-is-better')).toBe('high')
  })

  it('applies higher-is-worse bands regardless of threshold order', () => {
    const bands: MeterThreshold[] = [
      { value: 31, level: 'stop' },
      { value: 25, level: 'caution' },
      { value: 28, level: 'high' },
    ]
    expect(levelForValue(24.9, bands)).toBe('safe')
    expect(levelForValue(25, bands)).toBe('caution')
    expect(levelForValue(30.9, bands)).toBe('high')
    expect(levelForValue(31, bands)).toBe('stop')
    expect(levelForValue(10, bands, 'higher-is-worse', 'caution')).toBe('caution')
  })

  it('returns the most severe band for a non-finite value (missing input is conservative)', () => {
    expect(levelForValue(Number.NaN, twl, 'higher-is-better')).toBe('high')
  })
})

// ─────────────────────────────── Table sorting ───────────────────────────────

describe('sortRows', () => {
  interface Row {
    id: string
    n: number | null
    s: string
  }
  const rows: Row[] = [
    { id: 'a', n: 3, s: 'W-10' },
    { id: 'b', n: null, s: 'W-2' },
    { id: 'c', n: 1, s: 'w-1' },
    { id: 'd', n: 3, s: '' },
  ]
  const columns: DataTableColumn<Row>[] = [
    { id: 'n', header: 'n', cell: (r) => r.n, sortValue: (r) => r.n },
    { id: 's', header: 's', cell: (r) => r.s, sortValue: (r) => r.s },
    { id: 'plain', header: 'plain', cell: (r) => r.id },
  ]
  const ids = (list: Row[]) => list.map((r) => r.id)

  it('sorts numbers stably and keeps missing values last in both directions', () => {
    expect(ids(sortRows(rows, columns, { columnId: 'n', direction: 'asc' }))).toEqual(['c', 'a', 'd', 'b'])
    expect(ids(sortRows(rows, columns, { columnId: 'n', direction: 'desc' }))).toEqual(['a', 'd', 'c', 'b'])
  })

  it('sorts strings naturally and case-insensitively, empty strings last', () => {
    expect(ids(sortRows(rows, columns, { columnId: 's', direction: 'asc' }))).toEqual(['c', 'b', 'a', 'd'])
  })

  it('returns a copy in the original order when the column is not sortable or no sort is set', () => {
    const out = sortRows(rows, columns, { columnId: 'plain', direction: 'asc' })
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd'])
    expect(out).not.toBe(rows)
    expect(ids(sortRows(rows, columns, null))).toEqual(['a', 'b', 'c', 'd'])
  })
})
