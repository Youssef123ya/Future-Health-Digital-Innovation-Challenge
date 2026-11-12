/**
 * Narration rail of the live demo: the scenario, its scripted events and rule windows in time order with where the
 * simulated clock stands ("Now", "Next", done), a jump button per line and, for a line about one worker, a button that
 * puts that worker's phone on screen. Below it, "What to watch for": the scenario's purpose list and, for the Musaffah demo
 * crew, the persona stories. Presenter material about synthetic personas: the supervisor console beside it never shows
 * these reasons (it sees "device-directed rest" or an acclimatisation cap).
 *
 * One DOM for every width: a horizontal strip (scrolls sideways) above the panes, a vertical rail from 2xl.
 */
import { useMemo } from 'react'
import { CircleCheck, Clock, Eye, Megaphone, RotateCcw, ScrollText, ShieldCheck, Smartphone } from 'lucide-react'
import { simStore, uiStore } from '../../../state'
import { useSim, useUi } from '../../../state/hooks'
import { getScenario, hasDemoCrew, type Scenario } from '../../../sim/scenarios'
import { buildDemoCrew, type DemoPersona } from '../../../data/workforce'
import { formatLocalHhmm } from '../../../engine/time'
import { Badge, cx } from '../../components'
import { currentPolicy, isPlanBasisPolicy, loadScenarioAt } from '../../shell/scenario'
import { formatScenarioDate } from '../../shell/time'
import { DEMO_START_TIMES, jumpTargetFor, narrationItems, narrationStates, type NarrationItem, type NarrationState } from './narration'

/** The demo crew's personas (static, hand-written in data/workforce.ts). */
const PERSONAS: readonly DemoPersona[] = buildDemoCrew().personas

const KIND_ICON = { scripted: Megaphone, rule: ShieldCheck, shift: Clock } as const

const STATE_STYLE: Readonly<Record<NarrationState, { card: string; chip: string; label: string }>> = {
  now: { card: 'border-shade bg-shade-bg ring-1 ring-shade', chip: 'bg-shade text-white', label: 'Now' },
  next: { card: 'border-line-strong bg-surface', chip: 'bg-ink text-white', label: 'Next' },
  later: { card: 'border-line bg-surface', chip: 'bg-canvas text-muted ring-1 ring-line', label: 'Later' },
  past: { card: 'border-line bg-canvas/60 text-muted', chip: 'bg-canvas text-subtle ring-1 ring-line', label: 'Done' },
}

const SMALL_BUTTON =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-60'

function report(err: unknown): void {
  console.error('Zill demo control failed', err)
}

function NarrationLine({
  item,
  state,
  shiftStart,
  workerName,
  busy,
}: {
  item: NarrationItem
  state: NarrationState
  shiftStart: string
  workerName: string | null
  busy: boolean
}) {
  const Icon = state === 'past' ? CircleCheck : KIND_ICON[item.kind]
  const style = STATE_STYLE[state]
  const target = jumpTargetFor(item, 2, shiftStart)
  return (
    <li
      aria-current={state === 'now' ? 'step' : undefined}
      className={cx('flex w-[17rem] shrink-0 flex-col gap-2 rounded-xl border p-3 2xl:w-auto', style.card)}
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden size={16} className={state === 'now' ? 'text-shade' : 'text-subtle'} />
        <span className="text-sm font-semibold tabular-nums">
          {item.at}
          {item.until ? `–${item.until}` : ''}
        </span>
        <span className={cx('ms-auto rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', style.chip)}>
          {style.label}
        </span>
      </div>
      <p className={cx('text-sm font-semibold leading-snug', state === 'past' ? 'text-muted' : 'text-ink')}>{item.title}</p>
      <p className={cx('text-xs leading-relaxed text-muted', state === 'now' || state === 'next' ? '' : 'line-clamp-3 2xl:line-clamp-none')}>
        {item.note}
      </p>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        <button type="button" disabled={busy} onClick={() => simStore.getState().jumpTo(target).catch(report)} className={SMALL_BUTTON}>
          <Clock aria-hidden size={13} />
          Jump to {target}
        </button>
        {item.workerId && (
          <button type="button" onClick={() => uiStore.getState().setDeviceWorker(item.workerId ?? null)} className={SMALL_BUTTON}>
            <Smartphone aria-hidden size={13} />
            {workerName ? `Show ${workerName}’s phone` : 'Show this phone'}
          </button>
        )}
      </div>
    </li>
  )
}

function PersonaList({ onPhone }: { onPhone: string | null }) {
  const roster = useSim((s) => s.roster)
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-1">
      {PERSONAS.map((p) => {
        const name = roster[p.workerId]?.displayName ?? p.workerId
        const shown = onPhone === p.workerId
        return (
          <li key={p.id} className={cx('rounded-lg border p-3', shown ? 'border-shade bg-shade-bg' : 'border-line bg-surface')}>
            <p className="text-sm font-semibold text-ink">
              {name} <span className="font-normal text-muted">· {p.title}</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{p.story}</p>
            <button
              type="button"
              onClick={() => uiStore.getState().setDeviceWorker(p.workerId)}
              disabled={shown}
              className={cx(SMALL_BUTTON, 'mt-2')}
            >
              {shown ? <Eye aria-hidden size={13} /> : <Smartphone aria-hidden size={13} />}
              {shown ? 'On the phone now' : 'Show this phone'}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function WatchFor({ scenario }: { scenario: Scenario }) {
  const onPhone = useUi((s) => s.deviceWorkerId)
  return (
    <details className="group rounded-xl border border-line bg-surface p-3 open:pb-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <Eye aria-hidden size={16} className="text-shade" />
        What to watch for
        <span className="ms-auto text-xs font-medium text-muted group-open:hidden">Show</span>
        <span className="ms-auto hidden text-xs font-medium text-muted group-open:inline">Hide</span>
      </summary>
      <ul className="mt-3 list-disc space-y-1 ps-5 text-xs leading-relaxed text-muted marker:text-subtle">
        {scenario.demonstrates.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      {hasDemoCrew(scenario) && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">Demo crew personas</h3>
          <p className="mb-2 mt-1 text-xs leading-relaxed text-muted">
            Presenter notes about synthetic workers. The supervisor console never sees these reasons: it shows
            “device-directed rest” or an acclimatisation cap, and only the worker’s own phone explains why.
          </p>
          <PersonaList onPhone={onPhone} />
        </div>
      )}
    </details>
  )
}

/** The narration rail for the loaded scenario (a loading card until a scenario is loaded). */
export function NarrationRail({ className }: { className?: string }) {
  const scenarioId = useSim((s) => s.scenarioId)
  const now = useSim((s) => (s.view ? formatLocalHhmm(s.view.t) : null))
  const shiftStart = useSim((s) => s.view?.config.shift.start ?? '05:00')
  const busy = useSim((s) => s.status === 'loading' || s.jumping)
  const roster = useSim((s) => s.roster)
  const scenario = useMemo(() => (scenarioId ? getScenario(scenarioId) : null), [scenarioId])
  const items = useMemo(() => (scenario ? narrationItems(scenario) : []), [scenario])
  const states = useMemo(() => narrationStates(items, now), [items, now])

  if (!scenario) {
    return (
      <aside aria-label="Demo script" className={cx('rounded-xl border border-line bg-surface p-4 text-sm text-muted', className)}>
        Loading the scenario…
      </aside>
    )
  }

  const start = DEMO_START_TIMES[scenario.id]
  const restart = () => {
    const policy = currentPolicy()
    loadScenarioAt(scenario.id, { policy: policy && isPlanBasisPolicy(policy) ? policy : null, t: start }).catch(report)
  }

  return (
    <aside aria-labelledby="demo-script-title" className={cx('flex min-w-0 flex-col gap-3', className)}>
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-shade">
              <ScrollText aria-hidden size={14} />
              Demo script
            </p>
            <h2 id="demo-script-title" className="mt-1 text-lg font-semibold leading-snug text-ink">
              {scenario.title}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Replay of real weather · {formatScenarioDate(scenario.date)} · simulated workforce
            </p>
          </div>
          <button type="button" onClick={restart} disabled={busy} className={SMALL_BUTTON}>
            <RotateCcw aria-hidden size={13} />
            Restart at {start}
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">{scenario.description}</p>
        {items.length === 0 ? null : (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone="outline" size="sm">
              {scenario.events.length} scripted {scenario.events.length === 1 ? 'event' : 'events'}
            </Badge>
            Press play in the top bar, or jump to a moment below.
          </p>
        )}
      </div>

      <ol aria-label="Scenario timeline" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 2xl:mx-0 2xl:flex-col 2xl:overflow-visible 2xl:px-0">
        {items.map((item, i) => (
          <NarrationLine
            key={item.id}
            item={item}
            state={states[i] ?? 'later'}
            shiftStart={shiftStart}
            busy={busy}
            workerName={item.workerId ? (roster[item.workerId]?.displayName ?? null) : null}
          />
        ))}
      </ol>

      <WatchFor scenario={scenario} />
    </aside>
  )
}
