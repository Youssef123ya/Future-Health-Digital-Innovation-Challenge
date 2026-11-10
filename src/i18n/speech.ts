/**
 * Voice and vibration output for low-literacy workers. Every function is safe to import and call in Node or a
 * browser without speech/vibration support: nothing touches `window`/`navigator` at import time, and every call
 * degrades to `false` so the UI keeps showing text + colour + pictogram (the text is always on screen; voice and
 * vibration are additional channels, never the only one).
 *
 * Basis: "spoken directions plus pictures" for very low literacy [Ho06], audio prompt auto-played in the worker's
 * language (physio_and_clinical.md §5.6 UI); "short voice notes in the worker's language" and voice audio for both Hindi
 * and Urdu (context_and_commercial.md §2.3); W3C Web Speech API (SpeechSynthesis); W3C Vibration API.
 */
import type { LangCode, RiskLevel } from '../engine/types'
import { LANGUAGES, isLangCode, t, type FormatOptions, type MessageKey, type MessageParams } from './index'

/** The subset of SpeechSynthesisVoice used for selection, so selection is testable without a browser. */
export interface VoiceLike {
  readonly name: string
  readonly lang: string
  readonly localService: boolean
  readonly default: boolean
}

/** [ENG] Slightly slower than the engine default (1.0) to help comprehension of safety instructions. */
export const DEFAULT_SPEECH_RATE = 0.9

/**
 * Spoken-language fallback when the device has no voice for the requested language. Hindi and Urdu are "close in
 * their spoken form but use different scripts" (context_and_commercial.md §2.3), so the same message rendered in the
 * other language's script and voice is intelligible. [ENG] No other cross-language voice fallback is used: a voice
 * reading another language's script would garble a safety instruction.
 */
export const SPOKEN_FALLBACK: Readonly<Partial<Record<LangCode, LangCode>>> = Object.freeze({ ur: 'hi', hi: 'ur' })

/**
 * Vibration pattern per level (ms on, off, on…). [ENG] No standard fixes haptic patterns; these escalate in pulse
 * count and length (2 short → 5 very long) so a worker can tell the level without looking, and stay under the 10 s
 * per-call cap browsers apply. `safe` does not vibrate. Basis: W3C Vibration API `navigator.vibrate(pattern)`.
 */
export const VIBRATION_PATTERNS: Readonly<Record<RiskLevel, readonly number[]>> = Object.freeze({
  safe: Object.freeze([]),
  caution: Object.freeze([200, 100, 200]),
  high: Object.freeze([400, 150, 400, 150, 400]),
  stop: Object.freeze([700, 200, 700, 200, 700, 200, 700]),
  emergency: Object.freeze([1000, 250, 1000, 250, 1000, 250, 1000, 250, 1000]),
})

// ─────────────────────────────── Environment access (lazy, guarded) ───────────────────────────────

interface SpeechGlobals {
  speechSynthesis?: SpeechSynthesis
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance
  navigator?: { vibrate?: (pattern: number | number[]) => boolean }
}

const env = (): SpeechGlobals => globalThis as unknown as SpeechGlobals

function getSynth(): SpeechSynthesis | null {
  const s = env().speechSynthesis
  return s !== undefined && s !== null && typeof s.speak === 'function' ? s : null
}

function getUtteranceCtor(): typeof SpeechSynthesisUtterance | null {
  const ctor = env().SpeechSynthesisUtterance
  return typeof ctor === 'function' ? ctor : null
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ─────────────────────────────── Voice selection ───────────────────────────────

const normTag = (tag: string): string => tag.trim().replace(/_/g, '-').toLowerCase()

/**
 * Score of a voice for a language; 0 = unusable (different language). Language match dominates; then an on-device
 * voice (+100, [ENG]: keeps working offline, where network voices fail silently); then the language's preferred region
 * order ({@link LANGUAGES} voiceTags); then the platform default. Basis: BCP 47 tag matching (RFC 4647 lookup).
 */
export function voiceScore(voice: VoiceLike, lang: LangCode): number {
  if (!isLangCode(lang)) return 0
  const tags = LANGUAGES[lang].voiceTags.map(normTag)
  const voiceTag = normTag(voice.lang)
  const primary = voiceTag.split('-')[0] ?? ''
  if (!tags.some((tag) => tag.split('-')[0] === primary)) return 0
  const rank = tags.indexOf(voiceTag)
  return 1000 + (voice.localService ? 100 : 0) + (rank >= 0 ? 50 - 5 * Math.min(rank, 9) : 0) + (voice.default ? 1 : 0)
}

/** Best voice for a language from a voice list, or null when none speaks it. Pure. Basis: see {@link voiceScore}. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: LangCode): V | null {
  let best: V | null = null
  let bestScore = 0
  for (const voice of voices) {
    const score = voiceScore(voice, lang)
    if (score > bestScore) {
      best = voice
      bestScore = score
    }
  }
  return best
}

/** True when the Web Speech synthesis API exists in this environment. Basis: W3C Web Speech API. */
export function isSpeechSupported(): boolean {
  return getSynth() !== null && getUtteranceCtor() !== null
}

/** Voices currently known to the platform ([] when unsupported or not loaded yet). Basis: SpeechSynthesis.getVoices(). */
export function availableVoices(): readonly SpeechSynthesisVoice[] {
  try {
    return getSynth()?.getVoices() ?? []
  } catch {
    return []
  }
}

/** True when the device has a voice for the language. Basis: see {@link pickVoice}. */
export function hasVoice(lang: LangCode): boolean {
  return pickVoice(availableVoices(), lang) !== null
}

/**
 * Resolves with the number of voices once the platform has loaded them (Chromium loads them asynchronously and fires
 * `voiceschanged`), or after `timeoutMs`. Resolves 0 where speech is unsupported. Basis: W3C Web Speech API.
 */
export function loadVoices(timeoutMs = 1500): Promise<number> {
  const synth = getSynth()
  if (!synth) return Promise.resolve(0)
  const known = availableVoices().length
  if (known > 0) return Promise.resolve(known)
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        synth.removeEventListener('voiceschanged', finish)
      } catch {
        /* older engines: nothing to remove */
      }
      resolve(availableVoices().length)
    }
    const timer = setTimeout(finish, Math.max(0, timeoutMs))
    try {
      synth.addEventListener('voiceschanged', finish)
    } catch {
      /* older engines: rely on the timeout */
    }
  })
}

// ─────────────────────────────── Speaking ───────────────────────────────

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g

/**
 * Splits text into sentence-sized utterances (., !, ?, Arabic ؟, Urdu ۔, Devanagari/Bengali ।), hard-wrapping anything
 * longer than `maxChars` at a space. Removes bidi control characters. Short utterances avoid the Chromium bug that cuts
 * long utterances off, and give natural pauses between instructions. Pure.
 */
export function splitForSpeech(text: string, maxChars = 180): string[] {
  const clean = text.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const limit = Math.max(20, maxChars)
  const out: string[] = []
  for (const sentence of clean.replace(/([.!?؟۔।])\s+/g, '$1\n').split('\n')) {
    let rest = sentence.trim()
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(' ', limit)
      if (cut <= 0) cut = limit
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}

/** Options for {@link speak}. */
export interface SpeakOptions {
  /** 0.1–10, default {@link DEFAULT_SPEECH_RATE}. */
  rate?: number
  /** 0–2, default 1. */
  pitch?: number
  /** 0–1, default 1. */
  volume?: number
  /** Cancel speech already queued first (default true: a newer alert supersedes an older one). */
  interrupt?: boolean
  /** Called once when the last utterance ends or errors. */
  onEnd?: () => void
}

/**
 * Speaks text with the best voice for the language. Returns true when speech was queued; false (unsupported API, no
 * voice for this language, empty text, or an engine error) means the caller relies on text + vibration. Never speaks
 * one language's text with another language's voice. Basis: W3C Web Speech API; [Ho06] spoken + pictures.
 */
export function speak(text: string, lang: LangCode, opts: SpeakOptions = {}): boolean {
  const synth = getSynth()
  const Utterance = getUtteranceCtor()
  if (!synth || !Utterance || !isLangCode(lang)) return false
  const chunks = splitForSpeech(text)
  if (chunks.length === 0) return false
  const voice = pickVoice(availableVoices(), lang)
  if (!voice) return false
  try {
    if (opts.interrupt !== false) synth.cancel()
    chunks.forEach((chunk, index) => {
      const u = new Utterance(chunk)
      u.voice = voice
      u.lang = voice.lang
      u.rate = clamp(opts.rate ?? DEFAULT_SPEECH_RATE, 0.1, 10)
      u.pitch = clamp(opts.pitch ?? 1, 0, 2)
      u.volume = clamp(opts.volume ?? 1, 0, 1)
      if (index === chunks.length - 1 && opts.onEnd) {
        const done = opts.onEnd
        let called = false
        const once = (): void => {
          if (!called) {
            called = true
            done()
          }
        }
        u.onend = once
        u.onerror = once
      }
      synth.speak(u)
    })
    return true
  } catch {
    return false
  }
}

/** Stops any speech in progress or queued. No-op where unsupported. Basis: SpeechSynthesis.cancel(). */
export function cancel(): void {
  try {
    getSynth()?.cancel()
  } catch {
    /* unsupported or already stopped */
  }
}

/** Result of {@link speakMessage}: what to display, and whether/in which language it was voiced. */
export interface SpokenMessage {
  /** Display text, always in the requested language (or its English fallback). */
  readonly text: string
  readonly spoken: boolean
  /** Language of the voice used (may be the {@link SPOKEN_FALLBACK} language); null when not spoken. */
  readonly spokenLang: LangCode | null
}

/**
 * Renders a catalog message and speaks it. If the device has no voice for the language, the same message is voiced in
 * the {@link SPOKEN_FALLBACK} language (Urdu ↔ Hindi) while the display text stays in the worker's language.
 * Basis: context_and_commercial.md §2.3 (Hindi/Urdu share a spoken form; ship voice audio).
 */
export function speakMessage(
  lang: LangCode,
  key: MessageKey,
  params?: MessageParams,
  opts: SpeakOptions & FormatOptions = {},
): SpokenMessage {
  const text = t(lang, key, params, opts)
  if (speak(text, lang, opts)) return { text, spoken: true, spokenLang: lang }
  const alt = isLangCode(lang) ? SPOKEN_FALLBACK[lang] : undefined
  if (alt !== undefined && hasVoice(alt) && speak(t(alt, key, params, opts), alt, opts)) {
    return { text, spoken: true, spokenLang: alt }
  }
  return { text, spoken: false, spokenLang: null }
}

// ─────────────────────────────── Vibration ───────────────────────────────

/**
 * Vibrates the level's pattern. Returns false where unsupported (iOS Safari, desktop, Node), for `safe`, or when the
 * browser refuses (e.g. no prior user gesture). Basis: W3C Vibration API; patterns per {@link VIBRATION_PATTERNS}.
 */
export function vibrate(level: RiskLevel): boolean {
  const pattern = VIBRATION_PATTERNS[level] as readonly number[] | undefined
  if (!pattern || pattern.length === 0) return false
  const nav = env().navigator
  if (!nav || typeof nav.vibrate !== 'function') return false
  try {
    return nav.vibrate([...pattern]) === true
  } catch {
    return false
  }
}

/** Stops an ongoing vibration. No-op where unsupported. Basis: W3C Vibration API (`vibrate(0)` cancels). */
export function stopVibration(): void {
  const nav = env().navigator
  if (!nav || typeof nav.vibrate !== 'function') return
  try {
    nav.vibrate(0)
  } catch {
    /* unsupported */
  }
}

/** Outcome of {@link announce}: which extra channels fired (the on-screen text is the UI's job and always shown). */
export interface AnnounceResult {
  readonly vibrated: boolean
  readonly spoken: boolean
}

/**
 * Multimodal alert: vibrate the level's pattern and speak the text. Both channels fail independently and silently.
 * Basis: pictogram + colour + text + voice level card (ARCHITECTURE §9 `#/worker/:id`); [Ho06].
 */
export function announce(text: string, lang: LangCode, level: RiskLevel, opts: SpeakOptions = {}): AnnounceResult {
  return { vibrated: vibrate(level), spoken: speak(text, lang, opts) }
}
