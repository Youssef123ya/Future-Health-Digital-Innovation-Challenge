/**
 * Zill i18n runtime: message lookup with English fallback, ICU-subset interpolation with CLDR plurals, text direction,
 * language metadata and locale number formatting. Pure TypeScript with no DOM access, so it is safe in Node, workers and
 * tests. The catalog itself lives in ./messages; speech and vibration live in ./speech.
 *
 * Basis: launch languages per context_and_commercial.md §2.3 (ADPHC Safety in Heat 2025 set + Malayalam + Nepali);
 * BCP 47 (RFC 5646) language tags; ISO 15924 script codes; Unicode UAX #9 bidi isolates (FSI/PDI); ECMA-402 Intl
 * (CLDR plural rules and numbering systems); ICU MessageFormat argument syntax (subset).
 */
import type { ActionId, LangCode, RiskFlagId, RiskLevel, SymptomId } from '../engine/types'
import {
  CATALOGS,
  DRIVER_TEXT_IDS,
  EMERGENCY_SCRIPT,
  SOURCE_LANG,
  flattenCatalog,
  type ConsentScope,
  type DriverTextId,
  type MessageKey,
} from './messages'

export {
  ACTION_IDS,
  CATALOGS,
  COMPREHENSION_CRITERION,
  CONSENT_SCOPES,
  CONSENT_TEXT_VERSION,
  DRIVER_TEXT_IDS,
  EMERGENCY_SCRIPT,
  MESSAGE_KEYS,
  PRIVACY_NOTICE_TEXT_VERSION,
  RISK_FLAG_IDS,
  SOURCE_LANG,
  SYMPTOM_DRIVER_GROUP,
  SYMPTOM_IDS,
  driverTexts,
  flattenCatalog,
  isDeployable,
  reviewStatus,
} from './messages'
export type {
  Catalog,
  ConsentScope,
  DriverPhrases,
  DriverTextId,
  MessageKey,
  ReviewStep,
  SymptomDriverGroup,
  TranslationReview,
} from './messages'

// ─────────────────────────────── Language metadata ───────────────────────────────

/** ISO 15924 script codes used by the launch languages. Urdu is Arabic script written in the Nastaliq style. */
export type ScriptCode = 'Latn' | 'Arab' | 'Deva' | 'Beng' | 'Mlym'

/** Unicode CLDR numbering systems used for the "native digits" option. */
export type NumberingSystem = 'latn' | 'arab' | 'arabext' | 'deva' | 'beng'

/** Text direction for the HTML `dir` attribute. */
export type TextDirection = 'ltr' | 'rtl'

/** Everything the UI needs to present one language correctly. */
export interface LanguageMeta {
  readonly code: LangCode
  /** Endonym shown in the language picker, so a worker can find their language without reading English. */
  readonly nativeName: string
  readonly englishName: string
  /** ISO 15924. */
  readonly script: ScriptCode
  /** Right-to-left script (Arabic, Urdu). */
  readonly rtl: boolean
  /** BCP 47 tag for the HTML `lang` attribute, Intl and speech. */
  readonly bcp47: string
  /** Speech-voice tags in preference order (see ./speech pickVoice). */
  readonly voiceTags: readonly string[]
  /**
   * Digits used by the "native" digit option. [ENG] Script-native digits where they are in everyday print for the
   * community (Arabic-Indic, Extended Arabic-Indic for Urdu, Devanagari, Bengali); Latin where native digits are no
   * longer in everyday use (Malayalam).
   */
  readonly nativeDigits: NumberingSystem
  /** Listed in ADPHC "Safety in Heat" 2025 materials: AR, EN, UR, HI, TL, BN (context_and_commercial.md §2.3 [P, S29]). */
  readonly adphcSupported: boolean
  /** CSS font-family stack with a script-appropriate face first (Urdu needs Nastaliq). */
  readonly fontFamily: string
  /** Why the language is in the launch set. */
  readonly basis: string
}

/**
 * Metadata for the 8 launch languages. Basis: context_and_commercial.md §2.3 "Recommended launch set for Zill": ADPHC's
 * current six (S26, S28, S29) + Malayalam (HAAD Safety in the Heat 2008 set, S9; Kerala corridor) + Nepali (Nepal's top
 * destination). Arabic and English are mandatory for DoH research consent (S70 §3.5.3.2.4).
 */
export const LANGUAGES: Readonly<Record<LangCode, LanguageMeta>> = Object.freeze({
  ar: {
    code: 'ar',
    nativeName: 'العربية',
    englishName: 'Arabic',
    script: 'Arab',
    rtl: true,
    bcp47: 'ar-AE',
    voiceTags: ['ar-AE', 'ar-SA', 'ar-EG', 'ar'],
    nativeDigits: 'arab',
    adphcSupported: true,
    fontFamily: "'Noto Naskh Arabic', 'Noto Sans Arabic', 'Geeza Pro', Tahoma, sans-serif",
    basis: 'ADPHC Safety in Heat 2025 (S29); DoH consent language (S70 §3.5.3.2.4)',
  },
  en: {
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    script: 'Latn',
    rtl: false,
    bcp47: 'en-AE',
    // [ENG] Indian English second: most languages in the workforce nationality mix are South Asian
    // (context_and_commercial.md §2.3, nationality row).
    voiceTags: ['en-AE', 'en-IN', 'en-GB', 'en-US', 'en'],
    nativeDigits: 'latn',
    adphcSupported: true,
    fontFamily: "system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif",
    basis: 'ADPHC Safety in Heat 2025 (S29); DoH consent language (S70 §3.5.3.2.4); catalog source text',
  },
  hi: {
    code: 'hi',
    nativeName: 'हिन्दी',
    englishName: 'Hindi',
    script: 'Deva',
    rtl: false,
    bcp47: 'hi-IN',
    voiceTags: ['hi-IN', 'hi'],
    nativeDigits: 'deva',
    adphcSupported: true,
    fontFamily: "'Noto Sans Devanagari', 'Nirmala UI', 'Kohinoor Devanagari', sans-serif",
    basis: 'ADPHC Safety in Heat 2025 (S29); HAAD 2008 set (S9)',
  },
  ur: {
    code: 'ur',
    nativeName: 'اردو',
    englishName: 'Urdu',
    script: 'Arab',
    rtl: true,
    bcp47: 'ur-PK',
    voiceTags: ['ur-PK', 'ur-IN', 'ur'],
    nativeDigits: 'arabext',
    adphcSupported: true,
    fontFamily: "'Noto Nastaliq Urdu', 'Jameel Noori Nastaleeq', 'Noto Naskh Arabic', serif",
    basis: 'ADPHC Safety in Heat 2025 (S29); HAAD 2008 set (S9); spoken form close to Hindi, different script (§2.3)',
  },
  bn: {
    code: 'bn',
    nativeName: 'বাংলা',
    englishName: 'Bengali',
    script: 'Beng',
    rtl: false,
    bcp47: 'bn-BD',
    voiceTags: ['bn-BD', 'bn-IN', 'bn'],
    nativeDigits: 'beng',
    adphcSupported: true,
    fontFamily: "'Noto Sans Bengali', 'Nirmala UI', 'Bangla Sangam MN', sans-serif",
    basis: 'ADPHC Safety in Heat 2025 (S29)',
  },
  ml: {
    code: 'ml',
    nativeName: 'മലയാളം',
    englishName: 'Malayalam',
    script: 'Mlym',
    rtl: false,
    bcp47: 'ml-IN',
    voiceTags: ['ml-IN', 'ml'],
    nativeDigits: 'latn',
    adphcSupported: false,
    fontFamily: "'Noto Sans Malayalam', 'Nirmala UI', 'Malayalam Sangam MN', sans-serif",
    basis: 'HAAD Safety in the Heat 2008 worker materials (S9); Kerala migration corridor',
  },
  tl: {
    code: 'tl',
    nativeName: 'Tagalog',
    englishName: 'Tagalog (Filipino)',
    script: 'Latn',
    rtl: false,
    bcp47: 'fil-PH',
    voiceTags: ['fil-PH', 'fil', 'tl-PH', 'tl'],
    nativeDigits: 'latn',
    adphcSupported: true,
    fontFamily: "system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif",
    basis: 'ADPHC Safety in Heat 2025 (S29)',
  },
  ne: {
    code: 'ne',
    nativeName: 'नेपाली',
    englishName: 'Nepali',
    script: 'Deva',
    rtl: false,
    bcp47: 'ne-NP',
    voiceTags: ['ne-NP', 'ne'],
    nativeDigits: 'deva',
    adphcSupported: false,
    fontFamily: "'Noto Sans Devanagari', 'Nirmala UI', 'Kohinoor Devanagari', sans-serif",
    basis: "Nepal's top labour destination (context_and_commercial.md §2.3)",
  },
})

/** Language codes in the recommended launch order (context_and_commercial.md §2.3), for the language picker. */
export const LANG_CODES: readonly LangCode[] = Object.freeze(['ar', 'en', 'hi', 'ur', 'bn', 'ml', 'tl', 'ne'] as const)

/** Type guard for {@link LangCode} (e.g. a value read back from storage). */
export function isLangCode(value: unknown): value is LangCode {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value)
}

/**
 * Maps a BCP 47 tag ("ar-AE", "fil-PH", "en_US") to a launch language, or null. Filipino ("fil") maps to Tagalog ("tl").
 * Basis: BCP 47 (RFC 5646) primary language subtag; ISO 639 'fil'/'tl'.
 */
export function normalizeLang(tag: string | null | undefined): LangCode | null {
  if (typeof tag !== 'string') return null
  const primary = tag.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase() ?? ''
  if (primary === 'fil') return 'tl'
  return isLangCode(primary) ? primary : null
}

/**
 * First supported language among the user's preferences (pass `navigator.languages`), else `fallback` (English, the
 * source text). Pure: the caller supplies the preference list. Basis: BCP 47 lookup, RFC 4647 §3.4 (simplified).
 */
export function detectLang(preferred: readonly string[] | null | undefined, fallback: LangCode = SOURCE_LANG): LangCode {
  for (const tag of preferred ?? []) {
    const lang = normalizeLang(tag)
    if (lang) return lang
  }
  return fallback
}

/** Text direction of a language: 'rtl' for Arabic and Urdu, else 'ltr' (unknown codes → 'ltr'). Basis: Unicode UAX #9. */
export function dirFor(lang: LangCode): TextDirection {
  return isLangCode(lang) && LANGUAGES[lang].rtl ? 'rtl' : 'ltr'
}

/** True for right-to-left languages (ar, ur). Basis: Unicode UAX #9. */
export function isRtl(lang: LangCode): boolean {
  return dirFor(lang) === 'rtl'
}

// ─────────────────────────────── Numbers ───────────────────────────────

/**
 * 'latin' (default) = 0–9. 'native' = the language's {@link LanguageMeta.nativeDigits}.
 * [ENG] Latin is the default because phone keypads (998), clocks and site signage in the UAE use Latin digits.
 */
export type DigitStyle = 'latin' | 'native'

/** Options for {@link formatNumber}. Fraction digits default to Intl's (0–3). */
export interface NumberFormatOptions {
  digits?: DigitStyle
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  useGrouping?: boolean
}

const numberFormats = new Map<string, Intl.NumberFormat>()

/**
 * Locale-aware number formatting (grouping, decimal mark) with a Latin/native digit choice. Basis: ECMA-402
 * Intl.NumberFormat with the BCP 47 `-u-nu-` numbering-system extension (CLDR numbering systems).
 * Never throws: non-finite values and unsupported locales fall back to String(value).
 */
export function formatNumber(lang: LangCode, value: number, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return String(value)
  const meta = LANGUAGES[isLangCode(lang) ? lang : SOURCE_LANG]
  const nu: NumberingSystem = opts.digits === 'native' ? meta.nativeDigits : 'latn'
  const { minimumFractionDigits, maximumFractionDigits, useGrouping = true } = opts
  const cacheKey = `${meta.bcp47}|${nu}|${minimumFractionDigits ?? ''}|${maximumFractionDigits ?? ''}|${useGrouping}`
  let nf = numberFormats.get(cacheKey)
  if (!nf) {
    try {
      nf = new Intl.NumberFormat(`${meta.bcp47}-u-nu-${nu}`, {
        useGrouping,
        ...(minimumFractionDigits !== undefined ? { minimumFractionDigits } : {}),
        ...(maximumFractionDigits !== undefined ? { maximumFractionDigits } : {}),
      })
    } catch {
      return String(value)
    }
    numberFormats.set(cacheKey, nf)
  }
  return nf.format(value)
}

// ─────────────────────────────── Message formatting (ICU subset) ───────────────────────────────

/** Interpolation values. Numbers are locale-formatted; strings are inserted as-is (bidi-isolated in RTL text). */
export type MessageParams = Readonly<Record<string, string | number>>

/** Options for {@link t} / {@link formatMessage}. */
export interface FormatOptions {
  /** Digit shapes for numeric params (default 'latin', see {@link DigitStyle}). */
  digits?: DigitStyle
  /**
   * Wrap string params in FSI…PDI (U+2068/U+2069) so a Latin name or code inside Arabic/Urdu text cannot reorder the
   * surrounding words. Default: true for RTL languages, false otherwise. Basis: Unicode UAX #9 §2.7 isolates.
   */
  isolate?: boolean
}

type Part =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'arg'; readonly name: string }
  | { readonly kind: 'hash' }
  | { readonly kind: 'plural'; readonly name: string; readonly branches: ReadonlyMap<string, readonly Part[]> }

/**
 * Parses `text {name} text {n, plural, =0 {…} one {# x} other {# xs}}`. `#` (inside a plural branch) is the formatted
 * number. Apostrophes are literal (no ICU quoting); braces are reserved. Throws SyntaxError on malformed input.
 */
function parseTemplate(src: string): readonly Part[] {
  let i = 0
  function fail(message: string): never {
    throw new SyntaxError(`${message} at offset ${i} in template "${src}"`)
  }
  function skipSpace(): void {
    while (i < src.length && /\s/.test(src.charAt(i))) i++
  }
  function readName(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (!m) fail('Expected a name')
    i += m[0].length
    return m[0]
  }
  function parseMessage(inBranch: boolean): Part[] {
    const parts: Part[] = []
    let text = ''
    const flush = (): void => {
      if (text) parts.push({ kind: 'text', value: text })
      text = ''
    }
    while (i < src.length) {
      const ch = src.charAt(i)
      if (ch === '{') {
        flush()
        parts.push(parseArgument())
      } else if (ch === '}') {
        if (inBranch) break
        fail('Unmatched "}"')
      } else if (ch === '#' && inBranch) {
        flush()
        parts.push({ kind: 'hash' })
        i++
      } else {
        text += ch
        i++
      }
    }
    flush()
    return parts
  }
  function parseArgument(): Part {
    i++ // '{'
    skipSpace()
    const name = readName()
    skipSpace()
    if (src.charAt(i) === '}') {
      i++
      return { kind: 'arg', name }
    }
    if (src.charAt(i) !== ',') fail('Expected "," or "}"')
    i++
    skipSpace()
    const type = readName()
    if (type !== 'plural') fail(`Unsupported argument type "${type}"`)
    skipSpace()
    if (src.charAt(i) !== ',') fail('Expected ","')
    i++
    const branches = new Map<string, readonly Part[]>()
    for (;;) {
      skipSpace()
      if (i >= src.length) fail('Unterminated plural')
      if (src.charAt(i) === '}') {
        i++
        break
      }
      let selector: string
      if (src.charAt(i) === '=') {
        i++
        const m = /^\d+/.exec(src.slice(i))
        if (!m) fail('Expected a number after "="')
        selector = `=${m[0]}`
        i += m[0].length
      } else {
        selector = readName()
      }
      skipSpace()
      if (src.charAt(i) !== '{') fail('Expected "{" after plural selector')
      i++
      const body = parseMessage(true)
      if (src.charAt(i) !== '}') fail('Unterminated plural branch')
      i++
      branches.set(selector, body)
    }
    if (!branches.has('other')) fail('Plural argument without an "other" branch')
    return { kind: 'plural', name, branches }
  }
  return parseMessage(false)
}

const parsedTemplates = new Map<string, readonly Part[] | null>()

function parseCached(template: string): readonly Part[] | null {
  let parts = parsedTemplates.get(template)
  if (parts === undefined) {
    try {
      parts = parseTemplate(template)
    } catch {
      parts = null
    }
    parsedTemplates.set(template, parts)
  }
  return parts
}

/**
 * Parameter names used by a template (plain and plural arguments), sorted. Throws SyntaxError on a malformed template,
 * which is how the catalog tests prove every template parses and every translation uses the source's parameters.
 */
export function templateParams(template: string): string[] {
  const names = new Set<string>()
  const visit = (parts: readonly Part[]): void => {
    for (const p of parts) {
      if (p.kind === 'arg') names.add(p.name)
      else if (p.kind === 'plural') {
        names.add(p.name)
        for (const branch of p.branches.values()) visit(branch)
      }
    }
  }
  visit(parseTemplate(template))
  return [...names].sort()
}

const pluralRules = new Map<string, Intl.PluralRules>()

/** CLDR cardinal plural category of n in a language (ECMA-402 Intl.PluralRules). */
function pluralCategory(lang: LangCode, n: number): string {
  const tag = LANGUAGES[lang].bcp47
  let pr = pluralRules.get(tag)
  if (!pr) {
    try {
      pr = new Intl.PluralRules(tag)
    } catch {
      return n === 1 ? 'one' : 'other'
    }
    pluralRules.set(tag, pr)
  }
  return pr.select(n)
}

const FSI = '⁨'
const PDI = '⁩'

interface RenderContext {
  readonly lang: LangCode
  readonly params: MessageParams | undefined
  readonly digits: DigitStyle
  readonly isolate: boolean
  readonly hash: string | undefined
}

function renderParts(parts: readonly Part[], ctx: RenderContext): string {
  let out = ''
  for (const p of parts) {
    switch (p.kind) {
      case 'text':
        out += p.value
        break
      case 'hash':
        out += ctx.hash ?? '#'
        break
      case 'arg': {
        const v = ctx.params?.[p.name]
        if (v === undefined) out += `{${p.name}}` // visible, never silently blank
        else if (typeof v === 'number') out += formatNumber(ctx.lang, v, { digits: ctx.digits })
        else out += ctx.isolate ? `${FSI}${v}${PDI}` : v
        break
      }
      case 'plural': {
        const raw = ctx.params?.[p.name]
        if (raw === undefined) {
          out += `{${p.name}}`
          break
        }
        const n = typeof raw === 'number' ? raw : Number(raw)
        let branch: readonly Part[] | undefined
        if (Number.isFinite(n)) {
          branch = (Number.isInteger(n) ? p.branches.get(`=${n}`) : undefined) ?? p.branches.get(pluralCategory(ctx.lang, n))
        }
        branch ??= p.branches.get('other') ?? []
        const hash = Number.isFinite(n) ? formatNumber(ctx.lang, n, { digits: ctx.digits }) : String(raw)
        out += renderParts(branch, { ...ctx, hash })
        break
      }
    }
  }
  return out
}

/**
 * Formats one template in a language. Never throws: a malformed template is returned verbatim and a missing parameter
 * stays visible as `{name}`. Basis: ICU MessageFormat argument + plural syntax (subset); CLDR plural rules
 * (Intl.PluralRules); UAX #9 isolates for string params in RTL text.
 */
export function formatMessage(template: string, lang: LangCode, params?: MessageParams, opts: FormatOptions = {}): string {
  const parts = parseCached(template)
  if (parts === null) return template
  const code = isLangCode(lang) ? lang : SOURCE_LANG
  return renderParts(parts, {
    lang: code,
    params,
    digits: opts.digits ?? 'latin',
    isolate: opts.isolate ?? LANGUAGES[code].rtl,
    hash: undefined,
  })
}

// ─────────────────────────────── Lookup ───────────────────────────────

const FLAT = {} as Record<LangCode, Readonly<Record<string, string>>>
for (const code of Object.keys(CATALOGS) as LangCode[]) FLAT[code] = Object.freeze(flattenCatalog(CATALOGS[code]))
Object.freeze(FLAT)

/** A rendered message plus the language actually used, so the UI can set `lang`/`dir` correctly on fallback. */
export interface Translation {
  readonly text: string
  /** Language of `text` (English when the requested language had no usable entry). */
  readonly lang: LangCode
  readonly dir: TextDirection
  /** True when `text` is not in the requested language. */
  readonly fallback: boolean
}

/**
 * Looks up and formats a message. Fallback chain [ENG, fail-safe]: requested language → English source text → the key
 * itself. A worker always sees an instruction, never a blank. Basis: catalog per ./messages; W3C "Language tags in HTML"
 * (mark the language actually shown).
 */
export function translate(lang: LangCode, key: MessageKey, params?: MessageParams, opts?: FormatOptions): Translation {
  const requested: LangCode = isLangCode(lang) ? lang : SOURCE_LANG
  let used = requested
  let fallback = requested !== lang
  let template: string | undefined = FLAT[requested][key]
  if (typeof template !== 'string' || template.trim() === '') {
    used = SOURCE_LANG
    fallback = true
    template = FLAT[SOURCE_LANG][key]
  }
  if (typeof template !== 'string' || template.trim() === '') {
    return { text: String(key), lang: SOURCE_LANG, dir: 'ltr', fallback: true }
  }
  return { text: formatMessage(template, used, params, opts), lang: used, dir: dirFor(used), fallback }
}

/**
 * `t(lang, key, params?)` → display text, with English fallback and `{param}` / plural interpolation.
 * Example: `t('ar', 'action_with.shade_breaks', { work: 45, rest: 15 })`. Basis: see {@link translate}.
 */
export function t(lang: LangCode, key: MessageKey, params?: MessageParams, opts?: FormatOptions): string {
  return translate(lang, key, params, opts).text
}

// ─────────────────────────────── Typed helpers ───────────────────────────────

/** Level name, e.g. "Stop work". Basis: ARCHITECTURE §5 levels safe < caution < high < stop < emergency. */
export function levelName(lang: LangCode, level: RiskLevel): string {
  return t(lang, `level.${level}.name`)
}

/** One-line plain meaning of a level. Basis: ARCHITECTURE §5; physio_and_clinical.md §5.6 T0–T3 actions. */
export function levelMeaning(lang: LangCode, level: RiskLevel): string {
  return t(lang, `level.${level}.meaning`)
}

/** Yes/no check-in question for the worker ('self') or their buddy ('buddy'). Basis: physio_and_clinical.md §5.6. */
export function symptomQuestion(lang: LangCode, symptom: SymptomId, who: 'self' | 'buddy' = 'self'): string {
  return t(lang, `symptom.${symptom}.${who}`)
}

/**
 * Title + statement of one consent notice in `lang`: the translation of engine/privacy.ts `CONSENT_NOTICES[scope]`
 * (version `CONSENT_TEXT_VERSION`; English equals the notice exactly). Record the language on the consent receipt so it
 * identifies the exact text shown. Basis: ARCHITECTURE §7; UAE PDPL provable consent [secondary, S62]; DoH S70
 * §3.5.3.2.4 (Arabic and English with the same text).
 */
export function consentText(lang: LangCode, scope: ConsentScope): { title: string; statement: string } {
  return { title: t(lang, `consent.${scope}.title`), statement: t(lang, `consent.${scope}.statement`) }
}

/**
 * Title + statement of the general privacy notice in `lang` (translation of engine/privacy.ts `GENERAL_PRIVACY_NOTICE`):
 * legal-duty aggregates count every worker, k-suppressed, whatever the optional consent. Basis: ILO code §6.14(1)
 * (workers informed in advance) [primary, S73]; GOVERNANCE §4.2 and §13 item 14.
 */
export function privacyNoticeText(lang: LangCode): { title: string; statement: string } {
  return { title: t(lang, 'privacy_notice.title'), statement: t(lang, 'privacy_notice.statement') }
}

const DRIVER_TEXT_ID_SET: ReadonlySet<string> = new Set<string>(DRIVER_TEXT_IDS)

/** True when `id` (a `RiskDriver.id`) has a catalog text `driver.<id>`. */
export function hasDriverText(id: string): id is DriverTextId {
  return DRIVER_TEXT_ID_SET.has(id)
}

/**
 * Short, plain, non-clinical worker-facing text for a risk driver (`RiskDriver.id`). An id without a catalog text
 * returns `fallback` (typically the engine's English `RiskDriver.text`) when given, else the key `driver.<id>`, so the
 * worker never sees a blank [ENG, fail-safe]. Basis: catalog `driver` section (see messages.ts `DriverPhrases`);
 * ARCHITECTURE §5 (driver texts a supervisor can see never name the reason).
 */
export function driverText(lang: LangCode, id: string, fallback?: string): string {
  if (hasDriverText(id)) return t(lang, `driver.${id}`)
  return fallback !== undefined && fallback.trim() !== '' ? fallback : `driver.${id}`
}

/** Worker-private name + explanation of a self-declared risk flag. Basis: types.ts RiskFlagId; ARCHITECTURE §5. */
export function riskFlagText(lang: LangCode, flag: RiskFlagId): { name: string; explain: string } {
  return { name: t(lang, `flag.${flag}.name`), explain: t(lang, `flag.${flag}.explain`) }
}

/** The ordered T3 emergency script as display lines. Basis: physio_and_clinical.md §10.10 (see EMERGENCY_SCRIPT). */
export function emergencySteps(lang: LangCode, opts?: FormatOptions): string[] {
  return EMERGENCY_SCRIPT.map((key) => t(lang, key, undefined, opts))
}

/** Optional numbers that select a parameterised action variant in {@link actionText}. */
export interface ActionParams {
  /** rest_shade_now: rest minutes (rounded up) · drink_water (with ml): reminder interval minutes. */
  min?: number
  /** drink_water: millilitres per drink. */
  ml?: number
  /** shade_breaks: work and rest minutes per hour. */
  work?: number
  rest?: number
  /** shade_breaks: allowed work minutes per hour (RiskAssessment.workMinPerHour); rest = 60 − work. */
  workMinPerHour?: number
  /** midday_break: local "HH:mm" window, e.g. "12:30" and "15:00" (MoHRE MR 44/2022). */
  from?: string
  to?: string
}

const positive = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Text for an ActionId, using the parameterised variant when its numbers are supplied, else the short imperative.
 * Rounding is protective [ENG]: work minutes round down and rest minutes round up, so the text never shows more work
 * or less rest than the engine allowed. Basis: NIOSH 2016 work/rest TWA and ADOSH-SF CoP 11.0 TWL cycles
 * (shade_breaks); TB MED 507 drinking cadence (drink_water); MoHRE MR 44/2022 (midday_break).
 */
export function actionText(lang: LangCode, action: ActionId, params: ActionParams = {}, opts?: FormatOptions): string {
  switch (action) {
    case 'rest_shade_now':
      if (positive(params.min)) return t(lang, 'action_with.rest_shade_now', { min: Math.ceil(params.min) }, opts)
      break
    case 'drink_water':
      if (positive(params.ml) && positive(params.min)) {
        return t(lang, 'action_with.drink_water_every', { ml: Math.round(params.ml), min: Math.round(params.min) }, opts)
      }
      if (positive(params.ml)) return t(lang, 'action_with.drink_water', { ml: Math.round(params.ml) }, opts)
      break
    case 'shade_breaks': {
      let work = positive(params.work) ? Math.floor(params.work) : undefined
      let rest = positive(params.rest) ? Math.ceil(params.rest) : undefined
      if ((work === undefined || rest === undefined) && typeof params.workMinPerHour === 'number') {
        const w = Math.floor(params.workMinPerHour)
        if (w > 0 && w < 60) {
          work = w
          rest = 60 - w
        }
      }
      if (positive(work) && positive(rest)) return t(lang, 'action_with.shade_breaks', { work, rest }, opts)
      break
    }
    case 'midday_break':
      if (params.from && params.to) return t(lang, 'action_with.midday_break', { from: params.from, to: params.to }, opts)
      break
    default:
      break
  }
  return t(lang, `action.${action}`, undefined, opts)
}
