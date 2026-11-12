/**
 * Presenter aside next to the standalone worker phone (#/worker/:id, desktop only): the demo crew's phones with each
 * persona's one-line story, so a reviewer can step through how the same heat lands on different people — a new
 * arrival, a hooded welder, a worker on beta-blockers, a fasting worker, one who declines every optional consent.
 * Static roster and persona text only (data/workforce.ts buildDemoCrew): no level, number or consent state of any
 * worker is shown here, so the aside never becomes a side door around the privacy projection.
 */
import { ChevronRight, Smartphone, UsersRound } from 'lucide-react'
import { buildDemoCrew } from '../../../data/workforce'
import { LANGUAGES } from '../../../i18n'
import type { Route } from '../../router'
import { pathFor, toHref } from '../../router'
import { cx } from '../../components'
import { useUi } from '../../../state/hooks'

const DEMO = buildDemoCrew()
const PERSONA_BY_WORKER = new Map(DEMO.personas.map((p) => [p.workerId, p]))

/** Crewmates without a scripted story get a short role line. [ENG] */
const CREWMATE_LINES: Readonly<Record<string, string>> = {
  'W-D2F6': 'Acclimatised crewmate. In the peak-day script his buddy notices confusion at 14:10: red flag, first aid.',
  'W-D307': 'Acclimatised crewmate without a band. Protected on heat, workload and check-ins alone.',
}

export function WorkerPersonaPanel({ route }: { route: Route }) {
  const deviceWorkerId = useUi((s) => s.deviceWorkerId)
  const current = route.params.id && route.params.id !== 'demo' ? route.params.id : deviceWorkerId
  return (
    <aside aria-labelledby="persona-title" className="hidden w-[22rem] shrink-0 self-start lg:block">
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
        <h2 id="persona-title" className="flex items-center gap-2 text-base font-semibold text-ink">
          <UsersRound size={18} aria-hidden className="text-shade" />
          Demo crew phones
        </h2>
        <p className="mt-1 text-sm leading-snug text-muted">
          Each phone shows only its owner’s data, in their own language. Switch phones to see how the same heat lands on
          different people.
        </p>
        <ul className="mt-3 grid gap-1.5">
          {DEMO.workers.map((w) => {
            const persona = PERSONA_BY_WORKER.get(w.id)
            const on = w.id === current
            const lang = LANGUAGES[w.language]
            return (
              <li key={w.id}>
                <a
                  href={toHref(pathFor('worker', { id: w.id }))}
                  aria-current={on ? 'page' : undefined}
                  className={cx(
                    'group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors',
                    on ? 'bg-shade-bg ring-1 ring-shade/40' : 'hover:bg-canvas',
                  )}
                >
                  <span
                    aria-hidden
                    className={cx('mt-0.5 grid size-9 shrink-0 place-items-center rounded-full', on ? 'bg-shade text-white' : 'bg-canvas text-muted ring-1 ring-line')}
                  >
                    <Smartphone size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold text-ink">{w.displayName}</span>
                      <span className="text-xs text-muted">
                        <span lang={lang.bcp47}>{lang.nativeName}</span> · {lang.englishName}
                      </span>
                    </span>
                    <span className="block text-sm font-medium text-shade-dark">{persona?.title ?? 'Crewmate'}</span>
                    <span className="mt-0.5 line-clamp-3 text-xs leading-snug text-muted">{persona?.story ?? CREWMATE_LINES[w.id] ?? ''}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden className="mt-2 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100" />
                </a>
              </li>
            )
          })}
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-xs leading-snug text-muted">
          Simulated workers on a replay of real Abu Dhabi weather. The console tab and this phone share one clock: open
          the supervisor console in another tab and drive both from there.
        </p>
      </div>
    </aside>
  )
}
