import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowDown, FileCheck2, ShieldAlert } from 'lucide-react'
import type { ViewProps } from '../../App'
import { cx, PROVENANCE_LABELS, ProvenanceTag, type ProvenanceKind } from '../../components'
import { COHORT_SECTION_ID, CohortSection } from './CohortSection'
import { EXPOSURE_SECTION_ID, ExposureSection } from './ExposureSection'
import { FORECAST_SECTION_ID, ForecastSection } from './ForecastSection'
import { FLAW_COUNT } from './history'
import { HISTORY_SECTION_ID, HistorySection } from './HistorySection'
import { estLine, num, pct, signedPct, sig } from './format'
import { findArm } from './model'
import { REFERENCE_SECTION_ID, ReferenceSection } from './ReferenceSection'
import { Code, DocLink } from './ui'
import { useEvidenceData, type EvidenceData } from './useEvidenceData'

/**
 * Evidence (#/evidence): every claim Zill makes, with where its number comes from. Five sections, each read from a file
 * that `npm run validate` writes (public/data/validation/*.json) and labelled with its provenance: reference agreement,
 * real-weather exposure, archived-forecast skill, the simulated cohort, and the design flaws the simulation caught.
 * No operational data and no individual data appear here; nothing is computed from the live simulation.
 */

interface SummaryItem {
  id: string
  index: number
  title: string
  kind: ProvenanceKind
  headline: ReactNode
  detail: ReactNode
}

function ready<T>(s: { status: string; data?: T }): T | null {
  return s.status === 'ready' ? ((s as { data: T }).data ?? null) : null
}

function summaryItems(d: EvidenceData): SummaryItem[] {
  const ref = ready(d.reference)
  const hours = ready(d.hours)
  const fc = ready(d.forecast)
  const cohort = ready(d.cohort)
  const primary = fc?.sameModel.find((m) => m.primary) ?? fc?.sameModel[0]
  const d1 = primary?.leads.find((l) => l.lead === 1)
  const ban = cohort ? findArm(cohort.main.arms, 'ban_only') : undefined
  const full = cohort ? findArm(cohort.main.arms, 'zill_full') : undefined
  const mon = cohort ? findArm(cohort.main.arms, 'zill_monitored') : undefined
  const missing = (s: { status: string }) => (s.status === 'loading' ? 'Loading…' : 'Not generated yet')
  return [
    {
      id: REFERENCE_SECTION_ID,
      index: 1,
      title: 'Reference agreement',
      kind: 'reference',
      headline: ref ? `${ref.summary.passed} of ${ref.summary.checks} checks pass` : missing(d.reference),
      detail: ref ? `${ref.summary.models.length} models against independent code and published values` : null,
    },
    {
      id: EXPOSURE_SECTION_ID,
      index: 2,
      title: 'Real-weather exposure',
      kind: 'real_weather',
      headline: hours ? `${pct(hours.headline.shareWbgtGeRal115OutsideMiddayBreak, 0)} of high-heat hours fall outside the midday break` : missing(d.hours),
      detail: hours ? `${num(hours.headline.meanSiteHoursGeRal115PerSeason, 0)} h per season at WBGT ≥ 30.8 °C, 2020–2025` : null,
    },
    {
      id: FORECAST_SECTION_ID,
      index: 3,
      title: 'Forecast skill',
      kind: 'archived_forecast',
      headline: d1 ? `±${sig(d1.wbgt.rmse, 2)} °C WBGT error at day 1` : missing(d.forecast),
      detail: d1 ? `${pct(d1.wbgt.skillVsPersistence, 0)} better than persistence (MSE), archived forecasts 2024–2025` : null,
    },
    {
      id: COHORT_SECTION_ID,
      index: 4,
      title: 'Simulated cohort',
      kind: 'simulated',
      headline: full
        ? `${num(full.rates.per1000.excessive.value, 0)} vs ${num(ban?.rates.per1000.excessive.value, 0)} excessive-strain shifts per 1,000`
        : missing(d.cohort),
      detail: full ? (
        <>
          {full.rates.per1000.excessive.count === 0 && typeof full.rates.per1000.excessive.upper95 === 'number'
            ? `At most ${num(full.rates.per1000.excessive.upper95, 0)} per 1,000 (one-sided 95 %), `
            : `${estLine(full.rates.per1000.excessive, 1)}, `}
          at a work cost of {signedPct(full.vsBanOnly?.workRelative?.value, 0)} (Standard limits) and {signedPct(mon?.vsBanOnly?.workRelative?.value, 0)} (Monitored mode)
        </>
      ) : null,
    },
    {
      id: HISTORY_SECTION_ID,
      index: 5,
      title: 'What the simulation caught',
      kind: 'simulated',
      headline: `${FLAW_COUNT} design flaws fixed`,
      detail: 'v0.1 → v0.2 → v0.3, before any pilot',
    },
  ]
}

function jumpTo(id: string) {
  const section = document.getElementById(id)
  if (!section) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const heading = document.getElementById(`${id}-heading`)
  if (heading) {
    heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
  }
}

function SummaryNav({ items }: { items: readonly SummaryItem[] }) {
  return (
    <nav aria-label="Evidence sections">
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {items.map((it) => (
          <li key={it.id} className="min-w-0">
            <button
              type="button"
              onClick={() => jumpTo(it.id)}
              className="group flex h-full w-full flex-col items-start gap-2 rounded-xl border border-line bg-surface p-4 text-start shadow-xs transition-colors hover:border-shade-tint hover:bg-shade-bg/40"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted">
                  {it.index} · {it.title}
                </span>
                <ArrowDown aria-hidden size={14} className="shrink-0 text-subtle group-hover:text-shade-dark" />
              </span>
              <span className="text-base leading-snug font-semibold text-ink">{it.headline}</span>
              {it.detail && <span className="text-xs text-muted">{it.detail}</span>}
              <ProvenanceTag kind={it.kind} className="mt-auto" />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

const PROVENANCE_MEANING: readonly { kind: ProvenanceKind; meaning: string }[] = [
  { kind: 'reference', meaning: 'Engine output matches an independent implementation or published values within a stated tolerance.' },
  { kind: 'real_weather', meaning: 'Computed by the engine from archived real weather (analysis, reanalysis, airport observations).' },
  { kind: 'archived_forecast', meaning: 'Forecasts as they were issued, verified afterwards against what happened.' },
  { kind: 'simulated', meaning: 'A virtual workforce under stated assumptions: projections, not measured outcomes.' },
  { kind: 'projection', meaning: 'A model’s forward estimate for one person or site, shown with its uncertainty.' },
  { kind: 'engineering_default', meaning: 'A value no standard fixes, chosen conservatively and labelled [ENG].' },
]

function ProvenanceKey() {
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
        How to read the evidence labels
        <span aria-hidden className="text-xs font-normal text-muted group-open:hidden">
          Show
        </span>
        <span aria-hidden className="hidden text-xs font-normal text-muted group-open:inline">
          Hide
        </span>
      </summary>
      <dl className="grid gap-x-6 gap-y-3 border-t border-line px-4 py-3 sm:grid-cols-2 xl:grid-cols-3">
        {PROVENANCE_MEANING.map((p) => (
          <div key={p.kind} className="min-w-0">
            <dt>
              <ProvenanceTag kind={p.kind} />
              <span className="sr-only">{PROVENANCE_LABELS[p.kind]}</span>
            </dt>
            <dd className="mt-1 text-xs text-muted">{p.meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/** Deep links: `#/evidence?section=cohort` opens the page at that section once every file has settled. */
const SECTION_KEYS: Readonly<Record<string, string>> = {
  reference: REFERENCE_SECTION_ID,
  exposure: EXPOSURE_SECTION_ID,
  forecast: FORECAST_SECTION_ID,
  cohort: COHORT_SECTION_ID,
  history: HISTORY_SECTION_ID,
}

function useSectionDeepLink(section: string | undefined, settled: boolean) {
  const done = useRef<string | null>(null)
  const target = section ? SECTION_KEYS[section] : undefined
  useEffect(() => {
    if (!target || !settled || done.current === target) return
    done.current = target
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [target, settled])
}

export function EvidenceView({ route }: ViewProps) {
  const data = useEvidenceData()
  const items = summaryItems(data)
  const settled = [data.reference, data.hours, data.forecast, data.cohort].every((s) => s.status !== 'loading')
  useSectionDeepLink(route.query.section, settled)
  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <div className="flex items-start gap-4">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-shade-bg text-shade">
            <FileCheck2 size={22} />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Evidence</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Every claim Zill makes, with where its number comes from. All figures on this page are read from the files that{' '}
              <Code>npm run validate</Code> writes; none is typed by hand. Each section states its source, method, caveats and how to reproduce it.
            </p>
          </div>
        </div>
        <SummaryNav items={items} />
        <ProvenanceKey />
      </header>

      <ReferenceSection state={data.reference} />
      <ExposureSection state={data.hours} />
      <ForecastSection state={data.forecast} />
      <CohortSection state={data.cohort} />
      <HistorySection cohort={data.cohort} />

      <footer className={cx('flex gap-3 rounded-xl border border-line bg-canvas p-4 text-sm text-muted')}>
        <ShieldAlert aria-hidden size={18} className="mt-0.5 shrink-0 text-subtle" />
        <p>
          What this evidence does not show: Zill does not diagnose, does not measure core temperature and does not predict heat stroke. Its
          estimated strain indicator is an estimate with an uncertainty band, and the simulated cohort cannot show an effect on real heat illness;
          only a prospective pilot can. See <DocLink path="docs/LIMITATIONS.md" label="LIMITATIONS.md" /> and{' '}
          <DocLink path="docs/PILOT.md" label="PILOT.md" />.
        </p>
      </footer>
    </div>
  )
}
