/**
 * Overview (#/): the problem with cited figures, the live conditions at the five Abu Dhabi sites, how Zill works (with
 * the on-device privacy boundary and who sees what), the evidence headline with provenance, and buttons that start
 * each demo scenario in the live demo. Plain English (console copy); every figure names its source.
 */
import { useRef } from 'react'
import { ArrowRight, BookOpenCheck, CirclePlay, Play, Smartphone } from 'lucide-react'
import { useSim } from '../../../state/hooks'
import { SCENARIOS, type Scenario } from '../../../sim/scenarios'
import { getSite } from '../../../data/sites'
import { Badge, Section, cx } from '../../components'
import type { ViewProps } from '../../App'
import { pathFor, toHref } from '../../router'
import { startScenarioDemo } from '../../shell/scenario'
import { formatScenarioDate } from '../../shell/time'
import { DEMO_START_TIMES } from '../demo/narration'
import { EvidenceSection } from './EvidenceSection'
import { HowItWorks } from './HowItWorks'
import { LiveConditions } from './LiveConditions'
import { GLOBAL_FIGURES, LOCAL_FIGURES, RESEARCH_SOURCES, researchSource, type ResearchFigure } from './research'

function Figure({ f, size = 'md' }: { f: ResearchFigure; size?: 'md' | 'sm' }) {
  return (
    <li className="min-w-0">
      <p className={cx('font-semibold tabular-nums tracking-tight text-white', size === 'md' ? 'text-2xl sm:text-3xl' : 'text-xl')}>{f.value}</p>
      <p className="mt-0.5 text-sm leading-snug text-white/80">{f.label}</p>
      <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-white/60">{researchSource(f.sourceId).short}</p>
    </li>
  )
}

function Hero({ onEvidence }: { onEvidence: () => void }) {
  return (
    <section
      aria-labelledby="overview-title"
      className="relative overflow-hidden rounded-3xl bg-ink text-white shadow-sm ring-1 ring-black/5"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_0%_0%,rgba(20,184,166,0.22),transparent_60%),radial-gradient(40rem_24rem_at_100%_100%,rgba(245,158,11,0.10),transparent_60%)]"
      />
      <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-10 lg:p-10">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs font-semibold uppercase tracking-wider text-shade-light">
            Future Health Digital Innovation Challenge · Challenge 07 · Climate-resilient worker health
          </p>
          <h1 id="overview-title" className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Heat strain is a daily hazard on Gulf worksites. Zill gives every worker one clear level and one action — on
            their own phone.
          </h1>
          <p className="mt-4 max-w-prose text-base leading-relaxed text-white/80">
            Zill combines the forecast, the site’s heat indices, each worker’s personal limits and, with consent, a wearable
            into one level and one action, in the worker’s own language. Supervisors see what to do, never why. Every
            threshold traces to a published standard, and personal data stays on the phone.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => startScenarioDemo('peak-day', { t: DEMO_START_TIMES['peak-day'] })}
              className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-white px-5 text-base font-semibold text-ink shadow-sm hover:bg-white/90 focus-visible:outline-shade-light"
            >
              <CirclePlay aria-hidden size={20} className="text-shade" />
              Watch the live demo
            </button>
            <a
              href={toHref(pathFor('worker', { id: 'demo' }))}
              className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-white/10 px-4 text-base font-medium text-white hover:bg-white/15 focus-visible:outline-shade-light"
            >
              <Smartphone aria-hidden size={18} />
              Open a worker’s phone
            </a>
            <button
              type="button"
              onClick={onEvidence}
              className="inline-flex min-h-12 items-center gap-1.5 rounded-xl px-2 text-base font-medium text-white/85 underline decoration-white/30 underline-offset-4 hover:text-white focus-visible:outline-shade-light"
            >
              See the evidence
              <ArrowRight aria-hidden size={16} />
            </button>
          </div>
          <p className="mt-auto pt-6 text-xs text-white/60">
            Prototype — not a medical device. The demo replays real Abu Dhabi weather for a simulated workforce.
          </p>
        </div>

        <div className="min-w-0 rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10 sm:p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/70">Why it matters</h2>
          <ul className="mt-4 grid gap-5 sm:grid-cols-2">
            {GLOBAL_FIGURES.map((f) => (
              <Figure key={f.id} f={f} />
            ))}
          </ul>
          <h3 className="mt-6 border-t border-white/10 pt-4 text-sm font-semibold uppercase tracking-wider text-white/70">
            UAE and Abu Dhabi
          </h3>
          <ul className="mt-3 grid gap-4 sm:grid-cols-3">
            {LOCAL_FIGURES.map((f) => (
              <Figure key={f.id} f={f} size="sm" />
            ))}
          </ul>
          <p className="mt-5 text-xs leading-relaxed text-white/70">
            The UAE midday break (12:30–15:00, 15 June – 15 September; MoHRE 44/2022) is necessary but not sufficient:
            most high-heat hours fall outside it (see the evidence below), and heat comes early — 51.6 °C at Sweihan on
            24 May 2025, three weeks before the break season (NCM via Dawn/AFP 2025).
          </p>
        </div>
      </div>
    </section>
  )
}

function ScenarioCard({ s, loaded }: { s: Scenario; loaded: boolean }) {
  const site = getSite(s.siteId)
  const start = DEMO_START_TIMES[s.id]
  return (
    <li className={cx('flex min-w-0 flex-col rounded-xl border bg-surface p-4', loaded ? 'border-shade ring-1 ring-shade' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-muted">
          {site.name} · {formatScenarioDate(s.date, { weekday: false })}
        </p>
        {loaded && (
          <Badge tone="brand" size="sm">
            Loaded now
          </Badge>
        )}
      </div>
      <h3 className="mt-1 text-base font-semibold leading-snug text-ink">{s.title}</h3>
      <p className="mt-1.5 line-clamp-4 text-sm leading-relaxed text-muted">{s.description}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {s.demonstrates.slice(0, 3).map((d) => (
          <li key={d} className="rounded-md bg-canvas px-2 py-1 text-[11px] leading-snug text-muted ring-1 ring-line">
            {d}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-4">
        <button
          type="button"
          onClick={() => startScenarioDemo(s.id, { t: start })}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-shade px-4 text-sm font-semibold text-white hover:bg-shade-dark"
        >
          <Play aria-hidden size={15} fill="currentColor" />
          Start at {start}
          <span className="sr-only">: {s.title}</span>
        </button>
        <span className="text-xs text-muted">
          {s.events.length > 0 ? `${s.events.length} scripted events` : 'Replay of real weather'}
        </span>
      </div>
    </li>
  )
}

function Sources() {
  return (
    <section aria-labelledby="overview-sources" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id="overview-sources" className="text-sm font-semibold text-ink">
        Sources of the figures above
      </h2>
      <ol className="mt-2 grid gap-x-6 gap-y-1.5 text-xs leading-relaxed text-muted md:grid-cols-2">
        {RESEARCH_SOURCES.map((s) => (
          <li key={s.id}>
            <span className="font-semibold text-ink">{s.short}.</span> {s.full}{' '}
            {s.href && (
              <a href={s.href} target="_blank" rel="noreferrer" className="font-medium text-shade-dark underline underline-offset-2">
                Link<span className="sr-only"> to {s.short} (opens in a new tab)</span>
              </a>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-subtle">
        Research notes with page references: docs/research/context_and_commercial.md §0–§1 and docs/research/twl_and_regulation.md §5.
        There is no verified statistic of heat-related deaths among UAE workers, so none is claimed here.
      </p>
    </section>
  )
}

export function OverviewView(_props: ViewProps) {
  const loaded = useSim((s) => s.scenarioId)
  const evidenceRef = useRef<HTMLDivElement>(null)
  return (
    <div className="flex flex-col gap-10">
      <Hero onEvidence={() => evidenceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />

      <Section
        title="Conditions now at the five sites"
        description="Live Open-Meteo forecast, run through Zill’s own heat-index code. Each site states its data source and age."
      >
        <LiveConditions />
      </Section>

      <Section
        title="How Zill works"
        description="Seven inputs, one level and one action. Everything personal is computed on the worker’s phone; only level and action leave it."
      >
        <HowItWorks />
      </Section>

      <div ref={evidenceRef} className="scroll-mt-28">
        <Section
          title="What the evidence shows"
          description="Real weather, archived forecasts and reference implementations measure the engine; a simulated cohort, graded by an independent physiological model, projects outcomes. Each number carries its provenance."
          actions={
            <a href={toHref(pathFor('evidence'))} className="inline-flex items-center gap-1.5 text-sm font-semibold text-shade-dark underline underline-offset-2">
              <BookOpenCheck aria-hidden size={16} />
              Evidence page
            </a>
          }
        >
          <EvidenceSection />
        </Section>
      </div>

      <Section
        title="Start a demo scenario"
        description="Each scenario replays one real 2025 day at an Abu Dhabi site for a simulated workforce, in the live demo: the supervisor console and a worker’s phone side by side."
      >
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {SCENARIOS.map((s) => (
            <ScenarioCard key={s.id} s={s} loaded={loaded === s.id} />
          ))}
        </ul>
      </Section>

      <Sources />
    </div>
  )
}
