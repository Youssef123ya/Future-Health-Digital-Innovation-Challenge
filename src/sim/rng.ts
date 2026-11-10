/**
 * Deterministic, seedable pseudo-random number generator (mulberry32) with distribution helpers.
 * Every simulation and back-test number in Zill is reproducible from its seed.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  uniform(min: number, max: number): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  normal(mean: number, sd: number): number
  /** Normal truncated to [min, max] by resampling (falls back to clamping after 50 tries). */
  truncNormal(mean: number, sd: number, min: number, max: number): number
  /** Log-normal parameterised by the median and the multiplicative spread (sd of ln). */
  lognormal(median: number, sigmaLn: number): number
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  /** Weighted choice; weights need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T
  shuffle<T>(items: readonly T[]): T[]
  /** Independent child stream derived from this seed and a label (stable regardless of call order elsewhere). */
  fork(label: string | number): Rng
}

/** cyrb53 string hash → 32-bit unsigned seed. */
export function hashSeed(input: string | number): number {
  const str = String(input)
  let h1 = 0xdeadbeef ^ 0
  let h2 = 0x41c6ce57 ^ 0
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 ^ h2) >>> 0
}

export function createRng(seed: string | number): Rng {
  const baseSeed = typeof seed === 'number' && Number.isInteger(seed) ? seed >>> 0 : hashSeed(seed)
  let state = baseSeed
  let spareNormal: number | null = null

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const standardNormal = (): number => {
    if (spareNormal !== null) {
      const v = spareNormal
      spareNormal = null
      return v
    }
    let u = 0
    let v = 0
    while (u === 0) u = next()
    while (v === 0) v = next()
    const mag = Math.sqrt(-2 * Math.log(u))
    spareNormal = mag * Math.sin(2 * Math.PI * v)
    return mag * Math.cos(2 * Math.PI * v)
  }

  const rng: Rng = {
    next,
    uniform: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    normal: (mean, sd) => mean + sd * standardNormal(),
    truncNormal: (mean, sd, min, max) => {
      for (let i = 0; i < 50; i++) {
        const x = mean + sd * standardNormal()
        if (x >= min && x <= max) return x
      }
      return Math.min(max, Math.max(min, mean))
    },
    lognormal: (median, sigmaLn) => median * Math.exp(sigmaLn * standardNormal()),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() from empty array')
      return items[Math.floor(next() * items.length)]
    },
    weighted: (items, weights) => {
      if (items.length !== weights.length || items.length === 0) throw new Error('weighted(): bad arguments')
      const total = weights.reduce((a, b) => a + b, 0)
      let r = next() * total
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]
        if (r < 0) return items[i]
      }
      return items[items.length - 1]
    },
    shuffle: (items) => {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
    fork: (label) => createRng(hashSeed(`${baseSeed}:${label}`)),
  }
  return rng
}
