import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLINICAL_TEXT_PATTERN } from '../engine/alerts'
import { SYMPTOM_RULES } from '../engine/clinical'
import { CONSENT_NOTICES, CONSENT_NOTICE_VERSION, GENERAL_PRIVACY_NOTICE } from '../engine/privacy'
import { DRIVER_IDS } from '../engine/risk'
import {
  RISK_LEVELS,
  type ActionId,
  type ConsentState,
  type LangCode,
  type RiskFlagId,
  type SymptomId,
} from '../engine/types'
import {
  ACTION_IDS,
  CATALOGS,
  COMPREHENSION_CRITERION,
  CONSENT_SCOPES,
  CONSENT_TEXT_VERSION,
  DRIVER_TEXT_IDS,
  EMERGENCY_SCRIPT,
  LANG_CODES,
  LANGUAGES,
  MESSAGE_KEYS,
  PRIVACY_NOTICE_TEXT_VERSION,
  RISK_FLAG_IDS,
  SYMPTOM_DRIVER_GROUP,
  SYMPTOM_IDS,
  actionText,
  consentText,
  detectLang,
  dirFor,
  driverText,
  emergencySteps,
  flattenCatalog,
  formatMessage,
  formatNumber,
  hasDriverText,
  isDeployable,
  isLangCode,
  isRtl,
  levelMeaning,
  levelName,
  normalizeLang,
  privacyNoticeText,
  reviewStatus,
  riskFlagText,
  symptomQuestion,
  t,
  templateParams,
  translate,
  type MessageKey,
} from './index'
import {
  DEFAULT_SPEECH_RATE,
  VIBRATION_PATTERNS,
  announce,
  availableVoices,
  cancel,
  hasVoice,
  isSpeechSupported,
  loadVoices,
  pickVoice,
  speak,
  speakMessage,
  splitForSpeech,
  stopVibration,
  vibrate,
  type VoiceLike,
} from './speech'

// Compile-time-complete lists of the shared unions (adding a member to types.ts breaks this file until covered).
const ALL_ACTIONS: Record<ActionId, true> = {
  drink_water: true,
  shade_breaks: true,
  reduce_intensity: true,
  rotate_task: true,
  rest_shade_now: true,
  cool_down: true,
  stop_work: true,
  buddy_check: true,
  first_aider_check: true,
  call_998: true,
  cool_first: true,
  stay_with_worker: true,
  midday_break: true,
  acclimatization_plan: true,
  occ_health_review: true,
  check_sensor: true,
  symptom_checkin: true,
  no_lone_work: true,
  electrolytes: true,
  restrict_fluids: true,
  medical_evaluation: true,
  no_hot_work_today: true,
}
const ALL_SYMPTOMS: Record<SymptomId, true> = {
  thirst: true,
  heat_rash: true,
  cramps: true,
  cramps_persistent: true,
  headache: true,
  dizziness: true,
  nausea: true,
  weakness_fatigue: true,
  fainted: true,
  brown_urine: true,
  drank_a_lot: true,
  swollen_hands: true,
  repeated_vomiting: true,
  chest_pain: true,
  confusion: true,
  slurred_speech: true,
  unsteady_walking: true,
  collapsed_unresponsive: true,
  seizure: true,
}
const ALL_FLAGS: Record<RiskFlagId, true> = {
  prior_heat_illness: true,
  heat_sensitive_medication: true,
  hr_suppressing_medication: true,
  recent_illness: true,
  poor_sleep: true,
  fasting: true,
  heat_rash_sunburn: true,
  oh_review_required: true,
}
const SAMPLE_CONSENT: ConsentState = {
  wearable: false,
  healthFlags: false,
  checkins: false,
  shareWithMedicOnEscalation: false,
  aggregateStatistics: false,
  updatedAt: 0,
}
const ALL_LANGS: LangCode[] = ['en', 'ar', 'hi', 'ur', 'ml', 'bn', 'tl', 'ne']
const SAMPLE_PARAMS = { min: 15, ml: 250, work: 45, rest: 15, from: '12:30', to: '15:00', name: 'Ravi' }
const FLAT = Object.fromEntries(ALL_LANGS.map((l) => [l, flattenCatalog(CATALOGS[l])])) as Record<
  LangCode,
  Readonly<Record<MessageKey, string>>
>
const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort()
/** Sentence terminators: . ! ? Arabic ؟, Urdu ۔, Devanagari/Bengali danda । — counted when followed by space or end. */
const sentenceCount = (s: string): number => (s.match(/[.!?؟۔।](?=\s|$)/gu) ?? []).length

describe('catalog completeness', () => {
  it('has exactly the 8 launch languages', () => {
    expect(sorted(Object.keys(CATALOGS))).toEqual(sorted(ALL_LANGS))
    expect(sorted(LANG_CODES)).toEqual(sorted(ALL_LANGS))
    expect(sorted(Object.keys(LANGUAGES))).toEqual(sorted(ALL_LANGS))
  })

  it.each(ALL_LANGS)('%s has every key, no extras, none empty', (lang) => {
    const flat = FLAT[lang]
    expect(sorted(Object.keys(flat))).toEqual(sorted(MESSAGE_KEYS))
    for (const key of MESSAGE_KEYS) {
      expect(typeof flat[key], `${lang}:${key}`).toBe('string')
      expect(flat[key].trim().length, `${lang}:${key}`).toBeGreaterThan(0)
    }
  })

  it('has a substantial key set and deeply frozen catalogs', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThanOrEqual(152)
    expect(Object.isFrozen(CATALOGS.ar.ui)).toBe(true)
    expect(Object.isFrozen(CATALOGS.en.symptom.dizziness)).toBe(true)
  })

  it('covers every ActionId, SymptomId, RiskFlagId, RiskLevel and consent scope', () => {
    expect(sorted(ACTION_IDS)).toEqual(sorted(Object.keys(ALL_ACTIONS)))
    expect(sorted(SYMPTOM_IDS)).toEqual(sorted(Object.keys(ALL_SYMPTOMS)))
    expect(sorted(RISK_FLAG_IDS)).toEqual(sorted(Object.keys(ALL_FLAGS)))
    const booleanScopes = Object.entries(SAMPLE_CONSENT)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k)
    expect(sorted(CONSENT_SCOPES)).toEqual(sorted(booleanScopes))
    for (const lang of ALL_LANGS) {
      for (const a of ACTION_IDS) expect(t(lang, `action.${a}`)).not.toBe(`action.${a}`)
      for (const s of SYMPTOM_IDS) {
        expect(symptomQuestion(lang, s, 'self').length).toBeGreaterThan(0)
        expect(symptomQuestion(lang, s, 'buddy').length).toBeGreaterThan(0)
        expect(symptomQuestion(lang, s, 'self')).not.toBe(symptomQuestion(lang, s, 'buddy'))
      }
      for (const f of RISK_FLAG_IDS) {
        const { name, explain } = riskFlagText(lang, f)
        expect(name.length * explain.length).toBeGreaterThan(0)
      }
      for (const level of RISK_LEVELS) {
        expect(levelName(lang, level).length).toBeGreaterThan(0)
        expect(levelMeaning(lang, level).length).toBeGreaterThan(0)
      }
      for (const scope of CONSENT_SCOPES) {
        const { title, statement } = consentText(lang, scope)
        expect(title.length * statement.length).toBeGreaterThan(0)
      }
    }
  })

  it('symptom questions are yes/no questions in every language', () => {
    for (const lang of ALL_LANGS) {
      for (const s of SYMPTOM_IDS) {
        for (const who of ['self', 'buddy'] as const) {
          expect(symptomQuestion(lang, s, who), `${lang}:${s}:${who}`).toMatch(/[?؟]$/u)
        }
      }
    }
  })
})

describe('templates', () => {
  it('every template parses and uses exactly the source parameters', () => {
    for (const key of MESSAGE_KEYS) {
      const expected = templateParams(FLAT.en[key])
      for (const lang of ALL_LANGS) expect(templateParams(FLAT[lang][key]), `${lang}:${key}`).toEqual(expected)
    }
    expect(templateParams(FLAT.en['action_with.shade_breaks'])).toEqual(['rest', 'work'])
    expect(templateParams(FLAT.en['action_with.drink_water_every'])).toEqual(['min', 'ml'])
    expect(templateParams(FLAT.en['action_with.midday_break'])).toEqual(['from', 'to'])
  })

  it('renders every message in every language without leftover syntax', () => {
    for (const lang of ALL_LANGS) {
      for (const key of MESSAGE_KEYS) {
        const text = t(lang, key, SAMPLE_PARAMS)
        expect(text, `${lang}:${key}`).not.toMatch(/[{}#]/)
      }
    }
  })

  it('rejects malformed templates (tests) but never throws at runtime (UI)', () => {
    expect(() => templateParams('Broken {x')).toThrow(SyntaxError)
    expect(() => templateParams('{n, plural, one {#}}')).toThrow(/other/)
    expect(() => templateParams('{n, select, a {x} other {y}}')).toThrow(/Unsupported/)
    expect(formatMessage('Broken {x', 'en', { x: 1 })).toBe('Broken {x')
  })
})

describe('interpolation', () => {
  it('fills English parameterised actions', () => {
    expect(t('en', 'action_with.drink_water', { ml: 250 })).toBe('Drink 250 mL now')
    expect(t('en', 'action_with.shade_breaks', { work: 45, rest: 15 })).toBe('Work 45 min, rest 15 min')
    expect(t('en', 'action_with.midday_break', { from: '12:30', to: '15:00' })).toBe('No work in the sun 12:30–15:00')
    expect(t('en', 'ui.next_break', { min: 12 })).toBe('Next break in 12 min')
  })

  it('applies English CLDR plurals', () => {
    expect(t('en', 'action_with.rest_shade_now', { min: 1 })).toBe('Rest in the shade 1 minute')
    expect(t('en', 'action_with.rest_shade_now', { min: 15 })).toBe('Rest in the shade 15 minutes')
    expect(t('en', 'action_with.drink_water_every', { ml: 250, min: 1 })).toBe('Drink 250 mL every minute')
    expect(t('en', 'action_with.drink_water_every', { ml: 250, min: 20 })).toBe('Drink 250 mL every 20 minutes')
  })

  it('applies Arabic CLDR plurals (one / two / few / many / other)', () => {
    const rest = (min: number): string => t('ar', 'action_with.rest_shade_now', { min })
    expect(rest(1)).toBe('استرح في الظل دقيقة واحدة')
    expect(rest(2)).toBe('استرح في الظل دقيقتين')
    expect(rest(5)).toBe('استرح في الظل 5 دقائق')
    expect(rest(15)).toBe('استرح في الظل 15 دقيقة')
    expect(rest(100)).toBe('استرح في الظل 100 دقيقة')
    expect(t('ar', 'action_with.shade_breaks', { work: 45, rest: 15 })).toBe('اعمل 45 دقيقة، واسترح 15 دقيقة')
    expect(t('ar', 'action_with.drink_water_every', { ml: 250, min: 10 })).toBe('اشرب 250 مل كل 10 دقائق')
  })

  it('supports exact-value plural branches', () => {
    const tpl = '{n, plural, =0 {none} one {# item} other {# items}}'
    expect(formatMessage(tpl, 'en', { n: 0 })).toBe('none')
    expect(formatMessage(tpl, 'en', { n: 1 })).toBe('1 item')
    expect(formatMessage(tpl, 'en', { n: 3 })).toBe('3 items')
    expect(formatMessage(tpl, 'en', { n: '3' })).toBe('3 items')
  })

  it('uses Latin digits by default and native digits on request', () => {
    for (const lang of ALL_LANGS) expect(t(lang, 'action_with.drink_water', { ml: 250 })).toContain('250')
    expect(t('ar', 'ui.next_break', { min: 15 }, { digits: 'native' })).toBe('الاستراحة القادمة بعد ١٥ دقيقة')
    expect(t('ne', 'action_with.drink_water', { ml: 250 }, { digits: 'native' })).toContain('२५०')
    expect(t('bn', 'action_with.drink_water', { ml: 250 }, { digits: 'native' })).toContain('২৫০')
    expect(t('ur', 'action_with.drink_water', { ml: 250 }, { digits: 'native' })).toContain('۲۵۰')
    // Malayalam native digits are not in everyday use: the native option stays Latin.
    expect(t('ml', 'action_with.drink_water', { ml: 250 }, { digits: 'native' })).toContain('250')
  })

  it('keeps a missing parameter visible instead of blank', () => {
    expect(t('en', 'action_with.drink_water')).toBe('Drink {ml} mL now')
    expect(t('en', 'action_with.rest_shade_now')).toBe('Rest in the shade {min}')
  })

  it('bidi-isolates string params in RTL text only', () => {
    expect(t('ar', 'ui.buddy_alert', { name: 'Ravi K.' }).startsWith('⁨Ravi K.⁩ ')).toBe(true)
    expect(t('ur', 'ui.buddy_alert', { name: 'Ravi' })).toContain('⁨Ravi⁩')
    expect(t('en', 'ui.buddy_alert', { name: 'Ravi' })).toBe('Ravi may need help. Go and check now.')
    expect(t('ar', 'ui.buddy_alert', { name: 'Ravi' }, { isolate: false })).not.toMatch(/[⁨⁩]/)
    expect(t('ar', 'action_with.drink_water', { ml: 250 })).toBe('اشرب 250 مل الآن')
  })
})

describe('direction and language metadata', () => {
  it('marks Arabic and Urdu as RTL and the rest as LTR', () => {
    for (const lang of ALL_LANGS) {
      const rtl = lang === 'ar' || lang === 'ur'
      expect(dirFor(lang)).toBe(rtl ? 'rtl' : 'ltr')
      expect(isRtl(lang)).toBe(rtl)
      expect(LANGUAGES[lang].rtl).toBe(rtl)
    }
  })

  it('has scripts, tags and ADPHC flags per context_and_commercial.md §2.3', () => {
    const scripts = Object.fromEntries(ALL_LANGS.map((l) => [l, LANGUAGES[l].script]))
    expect(scripts).toEqual({ en: 'Latn', ar: 'Arab', hi: 'Deva', ur: 'Arab', ml: 'Mlym', bn: 'Beng', tl: 'Latn', ne: 'Deva' })
    const adphc = ALL_LANGS.filter((l) => LANGUAGES[l].adphcSupported)
    expect(sorted(adphc)).toEqual(sorted(['ar', 'en', 'ur', 'hi', 'tl', 'bn']))
    for (const lang of ALL_LANGS) {
      const meta = LANGUAGES[lang]
      expect(meta.code).toBe(lang)
      expect(() => Intl.getCanonicalLocales(meta.bcp47)).not.toThrow()
      expect(normalizeLang(meta.bcp47)).toBe(lang)
      expect(meta.voiceTags.length).toBeGreaterThan(0)
      expect(meta.nativeName.length).toBeGreaterThan(0)
    }
    expect(LANG_CODES[0]).toBe('ar')
  })

  it('normalises BCP 47 tags and detects a preferred language', () => {
    expect(normalizeLang('ar-AE')).toBe('ar')
    expect(normalizeLang('fil-PH')).toBe('tl')
    expect(normalizeLang('en_US')).toBe('en')
    expect(normalizeLang('ML')).toBe('ml')
    expect(normalizeLang('fr-FR')).toBeNull()
    expect(normalizeLang('')).toBeNull()
    expect(normalizeLang(undefined)).toBeNull()
    expect(detectLang(['fr-FR', 'ur-PK', 'en'])).toBe('ur')
    expect(detectLang([])).toBe('en')
    expect(detectLang(null, 'ar')).toBe('ar')
    expect(isLangCode('ne')).toBe(true)
    expect(isLangCode('xx')).toBe(false)
  })
})

describe('script and orthography sanity', () => {
  const SCRIPT: Record<LangCode, RegExp> = {
    en: /[A-Za-z]/,
    tl: /[A-Za-z]/,
    ar: /\p{Script=Arabic}/u,
    ur: /\p{Script=Arabic}/u,
    hi: /\p{Script=Devanagari}/u,
    ne: /\p{Script=Devanagari}/u,
    bn: /\p{Script=Bengali}/u,
    ml: /\p{Script=Malayalam}/u,
  }

  it.each(ALL_LANGS)('every %s string is written in its script', (lang) => {
    for (const key of MESSAGE_KEYS) expect(FLAT[lang][key], `${lang}:${key}`).toMatch(SCRIPT[lang])
  })

  it('translations are not copies of the English source (except shared loanwords)', () => {
    const allowedSame = new Set<MessageKey>(['level.emergency.name', 'ui.privacy', 'ui.offline'])
    for (const lang of ALL_LANGS.filter((l) => l !== 'en')) {
      for (const key of MESSAGE_KEYS) {
        if (FLAT[lang][key] === FLAT.en[key]) expect(allowedSame.has(key), `${lang}:${key}`).toBe(true)
      }
    }
  })

  it('Urdu uses Urdu letters and Arabic uses Arabic letters', () => {
    const arabicOnly = /[يكه]/u // ي ك ه
    const urduOnly = /[یکہھےٹڈڑں]/u // ی ک ہ ھ ے ٹ ڈ ڑ ں
    for (const key of MESSAGE_KEYS) {
      expect(FLAT.ur[key], `ur:${key}`).not.toMatch(arabicOnly)
      expect(FLAT.ar[key], `ar:${key}`).not.toMatch(urduOnly)
    }
  })
})

describe('consent and privacy notices (engine/privacy.ts text of record; DoH S70 §3.5.3.2.4)', () => {
  const noticeKeys = MESSAGE_KEYS.filter((k) => k.startsWith('consent.') || k.startsWith('privacy_notice.'))
  const scopes = Object.keys(CONSENT_NOTICES) as (keyof typeof CONSENT_NOTICES)[]

  it('every CONSENT_NOTICES id has a title and statement in all 8 languages; English equals the notice text exactly', () => {
    expect(sorted(CONSENT_SCOPES)).toEqual(sorted(scopes))
    expect(CONSENT_TEXT_VERSION).toBe(CONSENT_NOTICE_VERSION)
    for (const scope of scopes) {
      expect(consentText('en', scope)).toEqual({ title: CONSENT_NOTICES[scope].title, statement: CONSENT_NOTICES[scope].statement })
      for (const lang of ALL_LANGS) {
        for (const part of ['title', 'statement'] as const) {
          const tr = translate(lang, `consent.${scope}.${part}`)
          expect(tr.fallback, `${lang}:${scope}.${part}`).toBe(false)
          expect(tr.lang).toBe(lang)
          expect(tr.text.trim().length, `${lang}:${scope}.${part}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('the general privacy notice exists in all 8 languages; English equals GENERAL_PRIVACY_NOTICE exactly', () => {
    expect(PRIVACY_NOTICE_TEXT_VERSION).toBe(GENERAL_PRIVACY_NOTICE.version)
    expect(privacyNoticeText('en')).toEqual({ title: GENERAL_PRIVACY_NOTICE.title, statement: GENERAL_PRIVACY_NOTICE.statement })
    for (const lang of ALL_LANGS) {
      const n = privacyNoticeText(lang)
      expect(translate(lang, 'privacy_notice.title').fallback, lang).toBe(false)
      expect(translate(lang, 'privacy_notice.statement').fallback, lang).toBe(false)
      // keeps both k values (HSE 5; regulator and employer HR 10) in Latin digits
      expect(n.statement, lang).toMatch(/(^|\D)5(\D|$)/)
      expect(n.statement, lang).toMatch(/(^|\D)10(\D|$)/)
      // names the optional consent by the exact title the worker sees on the consent screen
      expect(n.statement, lang).toContain(consentText(lang, 'aggregateStatistics').title)
    }
  })

  it('every translation keeps the sentence structure of the English text of record', () => {
    expect(noticeKeys.length).toBe(CONSENT_SCOPES.length * 2 + 2)
    for (const lang of ALL_LANGS) {
      for (const key of noticeKeys) expect(sentenceCount(FLAT[lang][key]), `${lang}:${key}`).toBe(sentenceCount(FLAT.en[key]))
    }
    for (const key of MESSAGE_KEYS.filter((k) => k.startsWith('consent_info.'))) {
      expect(sentenceCount(FLAT.ar[key]), key).toBe(sentenceCount(FLAT.en[key]))
    }
  })

  it('states that refusing consent keeps all safety alerts (ARCHITECTURE §7)', () => {
    expect(FLAT.en['consent_info.voluntary']).toMatch(/still get all safety alerts/)
  })
})

describe('risk-driver texts (driver.<id> for engine/risk.ts DRIVER_IDS)', () => {
  /** Ids being added to the engine concurrently (ARCHITECTURE §5: cooled rest areas, PHS recovery review). */
  const PENDING_DRIVER_IDS = ['rest_area_cooled', 'rest_area_shade_only', 'phs_recovery_review_required', 'phs_restarted_after_review']

  it('covers every id in DRIVER_IDS plus the ids being added, in all 8 languages, without fallback', () => {
    const required = [...new Set([...DRIVER_IDS, ...PENDING_DRIVER_IDS])]
    expect(required.length).toBeGreaterThanOrEqual(117)
    expect(required.filter((id) => !hasDriverText(id))).toEqual([])
    for (const lang of ALL_LANGS) {
      for (const id of required) {
        const tr = translate(lang, `driver.${id}` as MessageKey)
        expect(tr.fallback, `${lang}:${id}`).toBe(false)
        expect(tr.text.trim().length, `${lang}:${id}`).toBeGreaterThan(0)
        expect(driverText(lang, id)).toBe(tr.text)
      }
    }
  })

  it('has no stale or misspelt ids: every text id is an engine driver id or one being added', () => {
    const known = new Set<string>([...DRIVER_IDS, ...PENDING_DRIVER_IDS])
    expect(DRIVER_TEXT_IDS.filter((id) => !known.has(id))).toEqual([])
  })

  it('English texts are short, plain and non-clinical (safe on a supervisor screen) and keep the claims discipline', () => {
    for (const id of DRIVER_TEXT_IDS) {
      const text = FLAT.en[`driver.${id}`]
      expect(text, id).not.toMatch(CLINICAL_TEXT_PATTERN)
      expect(text, id).not.toMatch(/\b(RAL|REL)\b|predict|diagnos|core temp|heat ?stroke|measur/i)
      expect(text.split(/\s+/).filter(Boolean).length, id).toBeLessThanOrEqual(14)
    }
  })

  it('never reveals a personal reason: medication and conservative-mode variants read like the standard ones', () => {
    for (const lang of ALL_LANGS) {
      expect(driverText(lang, 'physio_unavailable_hr_suppressing_medication')).toBe(driverText(lang, 'physio_unavailable_not_consented'))
      expect(driverText(lang, 'ectemp_ge_38_0_conservative')).toBe(driverText(lang, 'ectemp_ge_38_4'))
      expect(driverText(lang, 'conservative_checkin_due')).not.toBe('')
    }
    expect(FLAT.en['driver.limit_stricter_personal']).toBe('Your limit is lower today to keep you safe.')
  })

  it('symptom texts follow the triage tier of engine/clinical.ts and never name the symptom', () => {
    for (const s of SYMPTOM_IDS) {
      const tier = SYMPTOM_RULES[s].tier
      const expected = tier === 3 ? 'sx_t3' : tier === 2 ? 'sx_t2' : tier === 1 ? 'sx_t1' : s === 'thirst' ? 'sx_thirst' : 'sx_overdrink'
      expect(SYMPTOM_DRIVER_GROUP[s], s).toBe(expected)
      for (const lang of ALL_LANGS) {
        const text = driverText(lang, `symptom_${s}`)
        if (tier === 3) expect(text, `${lang}:${s}`).toContain('998')
        else expect(text, `${lang}:${s}`).not.toContain('998')
      }
    }
    // a worsening or not-improving T2 case becomes T3 (call 998) in clinical.ts
    for (const lang of ALL_LANGS) {
      for (const id of ['symptoms_worsening', 'symptoms_not_improving_30min']) expect(driverText(lang, id), `${lang}:${id}`).toContain('998')
    }
  })

  it('falls back to the engine text, then to the key, for an id without a catalog text', () => {
    expect(hasDriverText('no_such_driver')).toBe(false)
    expect(driverText('ar', 'no_such_driver', 'Engine text')).toBe('Engine text')
    expect(driverText('ar', 'no_such_driver', '  ')).toBe('driver.no_such_driver')
    expect(driverText('ar', 'no_such_driver')).toBe('driver.no_such_driver')
    expect(driverText('en', 'midday_break')).toBe('Midday break: no work in the sun now.')
    expect(translate('ur', 'driver.midday_break')).toMatchObject({ lang: 'ur', dir: 'rtl', fallback: false })
  })
})

describe('claims discipline and plain language', () => {
  it('never claims prediction, diagnosis or core-temperature measurement', () => {
    const banned = /predict|core temp|heat ?stroke|\bdiagnos(e|es|ed|ing)\b/i
    for (const lang of ['en', 'tl'] as const) {
      for (const key of MESSAGE_KEYS) expect(FLAT[lang][key], `${lang}:${key}`).not.toMatch(banned)
    }
    // "diagnosis" appears only in the wearable consent notice's negation (privacy.ts CONSENT_NOTICES text of record)
    for (const key of MESSAGE_KEYS) {
      if (/diagnosis/i.test(FLAT.en[key])) expect(FLAT.en[key], key).toMatch(/not a medical measurement or a diagnosis/)
    }
    expect(FLAT.en['ui.strain_estimate']).toMatch(/^Estimated/)
    expect(FLAT.en['ui.not_medical']).toMatch(/not a medical test/)
  })

  it('English actions are short imperatives (≤ 8 words)', () => {
    for (const a of ACTION_IDS) {
      const words = t('en', `action.${a}`).split(/\s+/).filter(Boolean)
      expect(words.length, a).toBeLessThanOrEqual(8)
    }
  })
})

describe('emergency script (physio_and_clinical.md §10.10)', () => {
  it('is ordered: call 998, cool first, cooling steps, stay, fluids only if alert', () => {
    expect(EMERGENCY_SCRIPT).toEqual([
      'emergency.title',
      'emergency.call_998',
      'emergency.cool_first',
      'emergency.shade',
      'emergency.immerse',
      'emergency.douse',
      'emergency.towels',
      'emergency.keep_cooling',
      'emergency.stay',
      'emergency.fluids',
    ])
  })

  it('shows the UAE ambulance number 998 in Latin digits in every language, even with native digits', () => {
    for (const lang of ALL_LANGS) {
      for (const key of ['emergency.call_998', 'action.call_998', 'level.emergency.meaning'] as const) {
        expect(t(lang, key, undefined, { digits: 'native' }), `${lang}:${key}`).toContain('998')
      }
      const steps = emergencySteps(lang)
      expect(steps).toHaveLength(EMERGENCY_SCRIPT.length)
      for (const s of steps) expect(s.trim().length).toBeGreaterThan(0)
    }
  })

  it('carries the timing constants of the cooling protocol', () => {
    expect(FLAT.en['emergency.towels']).toContain('1–2 minutes')
    expect(FLAT.en['emergency.keep_cooling']).toContain('15 minutes')
    expect(FLAT.en['emergency.fluids']).toMatch(/fully awake and alert/)
    for (const lang of ALL_LANGS.filter((l) => l !== 'ar')) expect(FLAT[lang]['emergency.keep_cooling']).toContain('15')
    expect(FLAT.ar['emergency.keep_cooling']).toContain('15 دقيقة')
  })
})

describe('typed helpers', () => {
  it('returns level, symptom, consent and flag texts', () => {
    expect(levelName('en', 'stop')).toBe('Stop work')
    expect(levelMeaning('en', 'emergency')).toBe('Danger. Call 998 and start cooling now.')
    expect(symptomQuestion('en', 'dizziness')).toBe('Do you feel dizzy?')
    expect(symptomQuestion('en', 'confusion', 'buddy')).toBe('Is your partner confused or acting strange?')
    expect(consentText('en', 'wearable').title).toBe('Heart rate from my band')
    expect(privacyNoticeText('en').title).toBe('How you are counted in group totals')
    expect(riskFlagText('en', 'hr_suppressing_medication').explain).toMatch(/does not use heart rate/)
  })

  it('selects parameterised action variants with protective rounding', () => {
    expect(actionText('en', 'shade_breaks', { workMinPerHour: 45 })).toBe('Work 45 min, rest 15 min')
    expect(actionText('en', 'shade_breaks', { workMinPerHour: 44.6 })).toBe('Work 44 min, rest 16 min')
    expect(actionText('en', 'shade_breaks', { work: 20, rest: 40 })).toBe('Work 20 min, rest 40 min')
    expect(actionText('en', 'shade_breaks', { workMinPerHour: 60 })).toBe('Take regular shade breaks')
    expect(actionText('en', 'shade_breaks', { workMinPerHour: 0 })).toBe('Take regular shade breaks')
    expect(actionText('en', 'rest_shade_now', { min: 14.2 })).toBe('Rest in the shade 15 minutes')
    expect(actionText('en', 'drink_water', { ml: 250, min: 20 })).toBe('Drink 250 mL every 20 minutes')
    expect(actionText('en', 'drink_water', { ml: 250 })).toBe('Drink 250 mL now')
    expect(actionText('en', 'drink_water')).toBe('Drink water now')
    expect(actionText('en', 'midday_break', { from: '12:30', to: '15:00' })).toBe('No work in the sun 12:30–15:00')
    expect(actionText('en', 'call_998', { min: 5 })).toBe('Call 998 now')
    expect(actionText('ar', 'shade_breaks', { work: 45, rest: 15 })).toBe('اعمل 45 دقيقة، واسترح 15 دقيقة')
  })
})

describe('fallback', () => {
  it('falls back to English for an unknown language and reports it', () => {
    expect(t('xx' as LangCode, 'ui.status')).toBe('My status')
    expect(translate('xx' as LangCode, 'ui.status')).toEqual({ text: 'My status', lang: 'en', dir: 'ltr', fallback: true })
    expect(dirFor('xx' as LangCode)).toBe('ltr')
  })

  it('reports the language actually used', () => {
    expect(translate('ar', 'ui.status')).toEqual({ text: 'حالتي', lang: 'ar', dir: 'rtl', fallback: false })
  })

  it('returns the key itself when no language has it (never blank)', () => {
    expect(t('ar', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })
})

describe('numbers', () => {
  it('formats with locale grouping and digit choice', () => {
    expect(formatNumber('hi', 100000)).toBe('1,00,000')
    expect(formatNumber('en', 1234.5)).toBe('1,234.5')
    expect(formatNumber('ar', 1.5)).toBe('1.5')
    expect(formatNumber('ar', 1.5, { digits: 'native' })).toBe('١٫٥')
    expect(formatNumber('bn', 15, { digits: 'native' })).toBe('১৫')
    expect(formatNumber('en', 1.426, { maximumFractionDigits: 2 })).toBe('1.43')
    expect(formatNumber('en', Number.NaN)).toBe('NaN')
  })
})

describe('translation review status', () => {
  it('marks English as source and every other language as an undeployable draft', () => {
    expect(reviewStatus.en.stage).toBe('source')
    for (const lang of ALL_LANGS) {
      expect(isDeployable(lang)).toBe(false)
      if (lang === 'en') continue
      expect(reviewStatus[lang].stage).toBe('machine_assisted_draft')
      expect(reviewStatus[lang].pending).toEqual(
        expect.arrayContaining(['native_speaker_review', 'occupational_health_review', 'comprehension_test']),
      )
    }
    expect(reviewStatus.en.pending).toEqual(['occupational_health_review', 'comprehension_test'])
  })

  it('uses the ANSI Z535.3 comprehension criterion', () => {
    expect(COMPREHENSION_CRITERION.minCorrectPct).toBe(85)
    expect(COMPREHENSION_CRITERION.maxCriticalConfusionPct).toBe(5)
  })
})

describe('speech and vibration without a browser', () => {
  it('degrades to false / no-op in Node', async () => {
    expect(isSpeechSupported()).toBe(false)
    expect(availableVoices()).toEqual([])
    expect(hasVoice('en')).toBe(false)
    expect(speak('Drink water now', 'en')).toBe(false)
    expect(() => cancel()).not.toThrow()
    expect(vibrate('emergency')).toBe(false)
    expect(() => stopVibration()).not.toThrow()
    expect(announce('Stop work now', 'en', 'stop')).toEqual({ vibrated: false, spoken: false })
    await expect(loadVoices(10)).resolves.toBe(0)
    const msg = speakMessage('ur', 'emergency.call_998')
    expect(msg.spoken).toBe(false)
    expect(msg.spokenLang).toBeNull()
    expect(msg.text).toContain('998')
  })
})

describe('voice selection', () => {
  const voices: VoiceLike[] = [
    { name: 'US remote', lang: 'en-US', localService: false, default: true },
    { name: 'India local', lang: 'en-IN', localService: true, default: false },
    { name: 'Arabic', lang: 'ar_SA', localService: true, default: false },
    { name: 'Filipino', lang: 'fil-PH', localService: false, default: false },
    { name: 'Hindi', lang: 'hi-IN', localService: true, default: false },
  ]

  it('prefers on-device voices, normalises tags, and never crosses languages', () => {
    expect(pickVoice(voices, 'en')?.name).toBe('India local')
    expect(pickVoice(voices, 'ar')?.name).toBe('Arabic')
    expect(pickVoice(voices, 'tl')?.name).toBe('Filipino')
    expect(pickVoice(voices, 'ur')).toBeNull()
    expect(pickVoice(voices, 'ml')).toBeNull()
    expect(pickVoice([], 'en')).toBeNull()
  })

  it('uses the preferred region order among equally local voices', () => {
    const local: VoiceLike[] = [
      { name: 'US', lang: 'en-US', localService: true, default: false },
      { name: 'GB', lang: 'en-GB', localService: true, default: false },
    ]
    expect(pickVoice(local, 'en')?.name).toBe('GB')
  })
})

describe('speech and vibration with a mocked browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  class FakeUtterance {
    voice: unknown = null
    lang = ''
    rate = 1
    pitch = 1
    volume = 1
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(public text: string) {}
  }

  function installSpeech(voices: VoiceLike[]) {
    const queue: FakeUtterance[] = []
    const synth = {
      getVoices: () => voices,
      speak: (u: FakeUtterance) => queue.push(u),
      cancel: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('speechSynthesis', synth)
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    return { queue, synth }
  }

  it('queues one utterance per sentence with the chosen voice', async () => {
    const india: VoiceLike = { name: 'India', lang: 'en-IN', localService: true, default: false }
    const { queue, synth } = installSpeech([india])
    expect(isSpeechSupported()).toBe(true)
    await expect(loadVoices()).resolves.toBe(1)
    const onEnd = vi.fn()
    expect(speak('Stop work now. Go to the shade.', 'en', { onEnd })).toBe(true)
    expect(synth.cancel).toHaveBeenCalledTimes(1)
    expect(queue.map((u) => u.text)).toEqual(['Stop work now.', 'Go to the shade.'])
    expect(queue[0]?.voice).toBe(india)
    expect(queue[0]?.lang).toBe('en-IN')
    expect(queue[0]?.rate).toBe(DEFAULT_SPEECH_RATE)
    queue[1]?.onend?.()
    queue[1]?.onerror?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(speak('വെള്ളം കുടിക്കുക', 'ml')).toBe(false)
    expect(speak('   ', 'en')).toBe(false)
  })

  it('voices an Urdu message with a Hindi voice when no Urdu voice exists, keeping Urdu display text', () => {
    const { queue } = installSpeech([{ name: 'Hindi', lang: 'hi-IN', localService: true, default: false }])
    const msg = speakMessage('ur', 'emergency.call_998')
    expect(msg.spoken).toBe(true)
    expect(msg.spokenLang).toBe('hi')
    expect(msg.text).toBe(t('ur', 'emergency.call_998'))
    expect(queue[0]?.text).toBe(t('hi', 'emergency.call_998'))
  })

  it('vibrates the level pattern through navigator.vibrate', () => {
    const vib = vi.fn((_pattern: number | number[]) => true)
    vi.stubGlobal('navigator', { vibrate: vib })
    expect(vibrate('high')).toBe(true)
    expect(vib).toHaveBeenLastCalledWith([400, 150, 400, 150, 400])
    expect(vibrate('safe')).toBe(false)
    expect(vib).toHaveBeenCalledTimes(1)
    stopVibration()
    expect(vib).toHaveBeenLastCalledWith(0)
    expect(announce('Stop work now', 'en', 'stop').vibrated).toBe(true)
  })
})

describe('vibration patterns', () => {
  it('escalate in pulse count and total duration and stay under 10 s', () => {
    let prevPulses = -1
    let prevTotal = -1
    for (const level of RISK_LEVELS) {
      const p = VIBRATION_PATTERNS[level]
      const pulses = Math.ceil(p.length / 2)
      const total = p.reduce((a, b) => a + b, 0)
      expect(pulses, level).toBeGreaterThan(prevPulses)
      expect(total, level).toBeGreaterThan(prevTotal)
      expect(total, level).toBeLessThanOrEqual(10_000)
      for (const ms of p) expect(Number.isInteger(ms) && ms > 0).toBe(true)
      prevPulses = pulses
      prevTotal = total
    }
    expect(VIBRATION_PATTERNS.safe).toEqual([])
  })
})

describe('splitForSpeech', () => {
  it('splits on sentence ends across scripts and strips bidi controls', () => {
    expect(splitForSpeech('Drink 1.5 L. Rest now!')).toEqual(['Drink 1.5 L.', 'Rest now!'])
    expect(splitForSpeech(t('hi', 'level.stop.meaning'))).toHaveLength(2)
    expect(splitForSpeech(t('ur', 'level.stop.meaning'))).toHaveLength(2)
    expect(splitForSpeech(t('ar', 'ui.buddy_alert', { name: 'Ravi' })).join(' ')).not.toMatch(/[⁨⁩]/)
    expect(splitForSpeech('   ')).toEqual([])
    const long = 'word '.repeat(100)
    for (const chunk of splitForSpeech(long, 40)) expect(chunk.length).toBeLessThanOrEqual(40)
  })
})
