/**
 * SimClock bar: the status slot of the dark top bar. Scenario picker, "replay of real weather" badge, simulated local
 * time with shift progress, play/pause, speed (1×/10×/60×/300×), jump to a time, site network and WBGT-meter status,
 * and the plan-basis switch (Standard limits = policy zill_full | Monitored mode = policy zill_monitored), which reloads
 * the scenario under the other policy and returns to the same simulated time.
 *
 * Light-on-dark styles for the ink bar (white text ≥ 15:1 on #0b1220; white/70 ≥ 8:1). Below the md breakpoint the bar
 * collapses to one row (time, play, speed, a problem flag) with the rest behind a "Scenario" disclosure. Every control
 * is a native element (select, radio, time input, button), so keyboard and screen-reader behaviour is the platform's.
 * Only public simStore actions are called (state/simStore.ts); no individual data is read.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  Gauge,
  History,
  Link2,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  SlidersHorizontal,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { SIM_SPEEDS, simStore, type SimSpeed } from '../../state'
import { useSim } from '../../state/hooks'
import { SCENARIOS, type ScenarioId } from '../../sim/scenarios'
import type { PolicyId } from '../../sim/types'
import { formatLocalHhmm } from '../../engine/time'
import { Tooltip, cx } from '../components'
import type { Route } from '../router'
import { clockFollowsOtherTab } from '../bootstrap'
import {
  DEFAULT_POLICY,
  PLAN_BASIS_OPTIONS,
  POLICY_LABELS,
  isPlanBasisPolicy,
  loadScenarioAt,
  scenarioTitle,
  switchPolicyKeepTime,
  useScenarioUrlSync,
  writeScenarioToUrl,
} from './scenario'
import { formatScenarioDate, isHhmm, shiftProgress } from './time'

const CONTROL =
  'h-9 rounded-lg border border-white/15 bg-white/10 text-sm text-white transition-colors hover:bg-white/15 focus-visible:outline-shade-light disabled:cursor-not-allowed disabled:opacity-60'
const SEGMENT =
  'inline-flex h-8 cursor-pointer select-none items-center justify-center rounded-md px-2.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white peer-checked:bg-white peer-checked:text-ink peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-shade-light peer-disabled:cursor-not-allowed peer-disabled:opacity-60'

function report(err: unknown): void {
  console.error('Zill simulation control failed', err)
}

/** The effective policy of the loaded world, else the pending override. */
function usePolicy(): PolicyId | null {
  return useSim((s) => s.view?.config.policy ?? s.overrides.policy ?? null)
}

function useBusy(): boolean {
  return useSim((s) => s.status === 'loading' || s.jumping)
}

// ─────────────────────────────── Clock ───────────────────────────────

function ClockReadout() {
  const t = useSim((s) => s.view?.t ?? null)
  const shift = useSim((s) => s.view?.config.shift ?? null)
  const finished = useSim((s) => s.view?.finished ?? false)
  const hhmm = t === null ? null : formatLocalHhmm(t)
  const progress = hhmm && shift ? shiftProgress(hhmm, shift) : null
  return (
    <div className="flex w-[4.75rem] shrink-0 flex-col justify-center">
      <span className="flex items-baseline gap-1" aria-hidden>
        <span className="text-lg font-semibold leading-6 tabular-nums">{hhmm ?? '--:--'}</span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-white/70">{finished ? 'end' : 'GST'}</span>
      </span>
      <span className="sr-only">
        {hhmm ? `Simulated local time ${hhmm}, Abu Dhabi${finished ? ', shift finished' : ''}` : 'No scenario loaded'}
        {shift ? `. Shift ${shift.start} to ${shift.end}.` : ''}
      </span>
      <span aria-hidden className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-white/15">
        <span className="block h-full rounded-full bg-shade-light" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
      </span>
    </div>
  )
}

function PlayControls() {
  const playing = useSim((s) => s.playing)
  const speed = useSim((s) => s.speed)
  const ready = useSim((s) => s.status === 'ready' && s.view !== null && !s.view.finished)
  const busy = useBusy()
  const name = useId()
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => simStore.getState().togglePlay()}
        disabled={!ready || busy}
        aria-label={playing ? 'Pause simulation' : 'Play simulation'}
        className={cx(CONTROL, 'inline-flex size-9 items-center justify-center border-transparent bg-white text-ink hover:bg-white/90')}
      >
        {playing ? <Pause aria-hidden size={18} fill="currentColor" /> : <Play aria-hidden size={18} fill="currentColor" />}
      </button>
      <div role="radiogroup" aria-label="Simulation speed" className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5">
        {SIM_SPEEDS.map((v) => (
          <label key={v} className="relative">
            <input
              type="radio"
              name={name}
              value={v}
              checked={speed === v}
              onChange={() => simStore.getState().setSpeed(v as SimSpeed)}
              className="peer sr-only"
            />
            <span className={cx(SEGMENT, 'min-w-9 tabular-nums')} aria-hidden>
              {v}×
            </span>
            <span className="sr-only">{v === 1 ? 'Real time' : `${v} times real time`}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function JumpForm() {
  const shift = useSim((s) => s.view?.config.shift ?? null)
  const t = useSim((s) => s.view?.t ?? null)
  const busy = useBusy()
  const [value, setValue] = useState('')
  const inputId = useId()
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (isHhmm(value)) simStore.getState().jumpTo(value).catch(report)
  }
  return (
    <form onSubmit={onSubmit} className="flex items-center gap-1.5">
      <label htmlFor={inputId} className="sr-only">
        Jump to simulated time
      </label>
      <input
        id={inputId}
        type="time"
        step={60}
        min={shift?.start}
        max={shift?.end}
        value={value}
        onFocus={() => {
          if (!value && t !== null) setValue(formatLocalHhmm(t))
        }}
        onChange={(e) => setValue(e.target.value)}
        disabled={shift === null}
        className={cx(CONTROL, 'w-[6.5rem] px-2 tabular-nums [color-scheme:dark]')}
      />
      <button type="submit" disabled={busy || !isHhmm(value)} className={cx(CONTROL, 'inline-flex items-center gap-1 px-2.5 font-medium')}>
        <SkipForward aria-hidden size={15} />
        Jump
      </button>
    </form>
  )
}

// ─────────────────────────────── Scenario ───────────────────────────────

function ScenarioPicker({ route }: { route: Route }) {
  const scenarioId = useSim((s) => s.scenarioId)
  const policy = usePolicy()
  const busy = useBusy()
  const selectId = useId()
  const onChange = (id: ScenarioId) => {
    const s = simStore.getState()
    const keepPolicy = policy && isPlanBasisPolicy(policy) && policy !== DEFAULT_POLICY ? policy : null
    const t = s.view ? formatLocalHhmm(s.view.t) : null
    writeScenarioToUrl(route, id, keepPolicy)
    loadScenarioAt(id, { policy: keepPolicy, t, play: false }).catch(report)
  }
  return (
    <div className="relative min-w-0">
      <label htmlFor={selectId} className="sr-only">
        Scenario
      </label>
      <select
        id={selectId}
        value={scenarioId ?? ''}
        disabled={busy && scenarioId === null}
        onChange={(e) => onChange(e.target.value as ScenarioId)}
        className={cx(CONTROL, 'w-full max-w-[15rem] appearance-none truncate ps-3 pe-8 font-medium [color-scheme:dark]')}
      >
        {scenarioId === null && <option value="">Loading scenario…</option>}
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden size={16} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-white/70" />
    </div>
  )
}

function ReplayBadge() {
  const date = useSim((s) => s.view?.config.date ?? null)
  const siteName = useSim((s) => s.view?.site.name ?? null)
  if (!date) return null
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          The simulation replays the hourly ECMWF IFS analysis for {siteName ?? 'the site'} on {formatScenarioDate(date)}{' '}
          (Open-Meteo archive, Copernicus data). The workforce and their physiology are a simulated cohort.
        </>
      }
    >
      <span
        tabIndex={0}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 text-xs font-medium text-white focus-visible:outline-shade-light"
      >
        <History aria-hidden size={14} className="text-shade-light" />
        <span>
          Replay of real weather <span className="tabular-nums text-white/80">{formatScenarioDate(date)}</span>
        </span>
      </span>
    </Tooltip>
  )
}

function PlanBasisSwitch({ route }: { route: Route }) {
  const scenarioId = useSim((s) => s.scenarioId)
  const policy = usePolicy()
  const busy = useBusy()
  const [pending, setPending] = useState<PolicyId | null>(null)
  const labelId = useId()
  const name = useId()
  const shown = pending ?? policy
  const choose = (next: PolicyId) => {
    if (!scenarioId || next === policy) return
    setPending(next)
    writeScenarioToUrl(route, scenarioId, next)
    switchPolicyKeepTime(next)
      .catch(report)
      .finally(() => setPending(null))
  }
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="hidden text-[11px] font-semibold uppercase tracking-wider text-white/70 2xl:inline">
        Plan basis
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5">
        {PLAN_BASIS_OPTIONS.map((o) => (
          <Tooltip key={o.policy} side="bottom" align="end" content={o.description}>
            <label className="relative">
              <input
                type="radio"
                name={name}
                value={o.policy}
                checked={shown === o.policy}
                disabled={busy || scenarioId === null}
                onChange={() => choose(o.policy)}
                className="peer sr-only"
              />
              <span className={cx(SEGMENT, 'gap-1.5 whitespace-nowrap')}>
                {pending === o.policy && <LoaderCircle aria-hidden size={13} className="animate-spin" />}
                {o.label}
              </span>
            </label>
          </Tooltip>
        ))}
      </div>
      {policy && !isPlanBasisPolicy(policy) && (
        <span className="text-xs text-white/70">
          Lab policy: <span className="font-medium text-white">{POLICY_LABELS[policy]}</span>
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────── Site status ───────────────────────────────

function StatusPill({ ok, icon: Icon, children, detail }: { ok: boolean; icon: typeof Wifi; children: ReactNode; detail: string }) {
  return (
    <span
      className={cx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        ok ? 'bg-white/5 text-white/80' : 'bg-amber-300/15 text-amber-100 ring-1 ring-amber-300/40',
      )}
    >
      <Icon aria-hidden size={14} className={ok ? 'text-shade-light' : 'text-amber-300'} />
      {children}
      <span className="sr-only">. {detail}</span>
    </span>
  )
}

function SiteStatusPills() {
  const network = useSim((s) => s.view?.network ?? null)
  const sensor = useSim((s) => s.view?.sensor ?? null)
  if (network === null || sensor === null) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Site status" role="group">
      {network === 'online' ? (
        <StatusPill ok icon={Wifi} detail="Phones and consoles are connected.">
          Network online
        </StatusPill>
      ) : (
        <StatusPill ok={false} icon={WifiOff} detail="Phones keep assessing and alerting locally; messages to consoles queue.">
          Network down
        </StatusPill>
      )}
      {sensor === 'ok' && (
        <StatusPill ok icon={Gauge} detail="The on-site WBGT meter feed is live.">
          WBGT meter
        </StatusPill>
      )}
      {sensor === 'none' && (
        <StatusPill ok icon={Gauge} detail="No on-site meter: the forecast is used.">
          Forecast only
        </StatusPill>
      )}
      {sensor === 'failed' && (
        <StatusPill ok={false} icon={TriangleAlert} detail="Devices fall back down the fail-safe chain to the forecast.">
          Meter failed
        </StatusPill>
      )}
    </div>
  )
}

/** A compact warning for the collapsed (phone) bar when the network or the meter is down. */
function ProblemFlag() {
  const problem = useSim((s) => (s.view ? s.view.network === 'offline' || s.view.sensor === 'failed' : false))
  if (!problem) return null
  return (
    <span className="inline-flex size-8 items-center justify-center rounded-full bg-amber-300/15 text-amber-300 ring-1 ring-amber-300/40">
      <TriangleAlert aria-hidden size={16} />
      <span className="sr-only">Site network or WBGT meter problem: open the scenario controls for details.</span>
    </span>
  )
}

function LoadState() {
  const status = useSim((s) => s.status)
  const jumping = useSim((s) => s.jumping)
  const scenarioId = useSim((s) => s.scenarioId)
  const error = useSim((s) => s.error)
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-amber-100">
        <TriangleAlert aria-hidden size={14} className="text-amber-300" />
        <span className="max-w-[16rem] truncate" title={error ?? undefined}>
          Scenario failed to load
        </span>
        <button
          type="button"
          onClick={() => loadScenarioAt(scenarioId ?? 'peak-day').catch(report)}
          className={cx(CONTROL, 'inline-flex h-7 items-center gap-1 px-2 text-xs font-medium')}
        >
          <RotateCcw aria-hidden size={13} />
          Retry
        </button>
      </span>
    )
  }
  if (status === 'loading' || jumping) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-white/80">
        <LoaderCircle aria-hidden size={14} className="animate-spin text-shade-light" />
        {status === 'loading' ? 'Loading scenario…' : 'Simulating…'}
      </span>
    )
  }
  return null
}

/** Polite announcement when a scenario finishes loading (screen readers; the visual state is in the controls). */
function Announcer() {
  const ready = useSim((s) => s.status === 'ready')
  const scenarioId = useSim((s) => s.scenarioId)
  const policy = usePolicy()
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (ready && scenarioId) setMessage(`Scenario loaded: ${scenarioTitle(scenarioId)}, ${policy ? POLICY_LABELS[policy] : ''}.`)
  }, [ready, scenarioId, policy])
  return (
    <span className="sr-only" aria-live="polite">
      {message}
    </span>
  )
}

/**
 * The status slot of the application shell (App `status` prop). Also applies scenario keys that appear in the hash
 * query after start-up (an in-app link such as `#/demo?scenario=humid-day&t=11:00`).
 */
export function SimClockBar({ route }: { route: Route }) {
  useScenarioUrlSync(route)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const follows = clockFollowsOtherTab() === true
  return (
    <div role="group" aria-label="Simulation clock and scenario" className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
      <div className="order-1 flex items-center gap-3 md:order-2">
        <ClockReadout />
        <PlayControls />
      </div>
      <div className="order-2 ms-auto flex items-center gap-2 md:hidden">
        <ProblemFlag />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className={cx(CONTROL, 'inline-flex items-center gap-1.5 px-2.5 font-medium', open && 'bg-white/20')}
        >
          <SlidersHorizontal aria-hidden size={15} />
          Scenario
        </button>
      </div>
      <div id={panelId} className={cx('order-3 w-full flex-wrap items-center gap-x-4 gap-y-2 md:contents', open ? 'flex' : 'hidden')}>
        <div className="flex min-w-0 flex-wrap items-center gap-2 md:order-1">
          <ScenarioPicker route={route} />
          <ReplayBadge />
        </div>
        <div className="md:order-3">
          <JumpForm />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 md:order-4">
          <SiteStatusPills />
          {follows && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white/5 px-2.5 text-xs font-medium text-white/80">
              <Link2 aria-hidden size={14} className="text-shade-light" />
              Clock follows the console tab
            </span>
          )}
          <LoadState />
        </div>
        <div className="md:order-5 md:ms-auto">
          <PlanBasisSwitch route={route} />
        </div>
      </div>
      <Announcer />
    </div>
  )
}
