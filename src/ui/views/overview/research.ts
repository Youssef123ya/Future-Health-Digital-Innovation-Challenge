/**
 * Cited burden figures for the overview hero, transcribed with their sources from docs/research/context_and_commercial.md
 * §0–§1 and docs/research/twl_and_regulation.md §5 (all accessed 2026-11-09). Rule from §1.7 of the research notes: there
 * is no verified statistic of heat-related deaths among UAE workers, so none is claimed; heat-related illness and the
 * injury and labour-loss estimates are used instead.
 */

/** A source as cited on screen. */
export interface ResearchSource {
  id: string
  /** Short citation shown next to a figure. */
  short: string
  /** Full reference for the sources list. */
  full: string
  href?: string
}

/** One figure: the number, what it counts, and its source. */
export interface ResearchFigure {
  id: string
  value: string
  label: string
  sourceId: string
}

export const RESEARCH_SOURCES: readonly ResearchSource[] = [
  {
    id: 'ilo-2024a',
    short: 'ILO 2024a',
    full: 'ILO (April 2024). Ensuring safety and health at work in a changing climate. Geneva: International Labour Office.',
    href: 'https://www.ilo.org/media/569136/download',
  },
  {
    id: 'ilo-2024b',
    short: 'ILO 2024b',
    full: 'ILO (July 2024). Heat at work: Implications for safety and health. A global review of the science, policy and practice.',
    href: 'https://www.ilo.org/publications/heat-work-implications-safety-and-health',
  },
  {
    id: 'lancet-uae-2023',
    short: 'Lancet Countdown 2023',
    full: 'Lancet Countdown (2023). United Arab Emirates data sheet (2022 data), indicators 1.1.4 and 4.1.3.',
    href: 'https://climahealth.info/wp-content/uploads/2024/01/UAE_v1.pdf',
  },
  {
    id: 'haad-2011',
    short: 'HAAD, The National 2011',
    full: 'Health Authority – Abu Dhabi figures reported in The National, 27 May 2011 (3,017 heat-related illnesses in 2010; most work-related).',
    href: 'https://www.thenationalnews.com/uae/officials-to-set-legal-limit-for-working-in-the-heat-1.593060',
  },
  {
    id: 'joubert-2011',
    short: 'Joubert et al. 2011',
    full: 'Joubert D, Thomsen J, Harrison O (2011). Safety in the heat: a comprehensive program for prevention of heat illness among workers in Abu Dhabi, United Arab Emirates. Am J Public Health 101(3):395–398.',
    href: 'https://doi.org/10.2105/AJPH.2009.189563',
  },
  {
    id: 'ncm-2025',
    short: 'NCM via Dawn/AFP 2025',
    full: 'Dawn/AFP, citing the UAE National Centre of Meteorology (24 May 2025): record May temperature of 51.6 °C at Sweihan, Al Ain.',
    href: 'https://www.dawn.com/news/1913179/uae-hits-record-may-temperature-of-516c',
  },
  {
    id: 'mohre-44-2022',
    short: 'MoHRE 44/2022',
    full: 'UAE Ministry of Human Resources and Emiratisation, Ministerial Resolution 44/2022: midday break 12:30–15:00, 15 June – 15 September.',
  },
]

/** Global and regional burden (ILO 2024). */
export const GLOBAL_FIGURES: readonly ResearchFigure[] = [
  { id: 'exposed', value: '2.41 billion', label: 'workers exposed to excessive heat every year — over 70 % of the global workforce', sourceId: 'ilo-2024a' },
  { id: 'injuries', value: '22.85 million', label: 'occupational injuries a year attributed to excessive heat, with 18,970 work-related deaths (2020)', sourceId: 'ilo-2024a' },
  { id: 'arab-states', value: '83.6 %', label: 'of workers in the Arab States are exposed to excessive heat, against 71 % globally', sourceId: 'ilo-2024b' },
  { id: 'outside-heatwaves', value: '9 in 10', label: 'worker heat exposures, and 8 in 10 heat-linked injuries, happen outside heatwaves', sourceId: 'ilo-2024b' },
]

/** UAE and Abu Dhabi context. */
export const LOCAL_FIGURES: readonly ResearchFigure[] = [
  { id: 'uae-hours', value: '1.5 billion', label: 'potential labour hours lost to heat in the UAE in 2022 — 62.2 % of them in construction', sourceId: 'lancet-uae-2023' },
  { id: 'ad-illness', value: '3,017', label: 'heat-related illnesses reported in Abu Dhabi in 2010, most of them work-related', sourceId: 'haad-2011' },
  { id: 'ad-programme', value: '−79.5 %', label: 'heat cases at one company after Abu Dhabi’s 2008 Safety in the Heat programme (15.3 → 1.16 per 1,000 workers)', sourceId: 'joubert-2011' },
]

/** Source by id (throws for an unknown id, so a typo fails the unit test rather than the page). */
export function researchSource(id: string): ResearchSource {
  const s = RESEARCH_SOURCES.find((x) => x.id === id)
  if (!s) throw new Error(`Unknown research source ${id}`)
  return s
}
