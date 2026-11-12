/**
 * Experiment form of the Simulation lab: day (named scenario, cached demo day or any archived summer day), policies
 * (one, several or all five), behaviour assumptions, disruptions and the seed, plus Run / Cancel with progress.
 * Every behaviour value is an [ASSUMPTION] of docs/SIMULATION.md; the defaults are the simulator's.
 */
import { useEffect, useId, useMemo, type ReactNode } from 'react'
import { CalendarDays, FlaskConical, Play, RotateCcw, Shuffle, Square } from 'lucide-react'
import { SITES, getSite, type SiteId } from '../../../data/sites'
import { getScenario } from '../../../sim/scenarios'
import { POLICY_IDS, ZILL_POLICY_IDS, policyUsesWearable, type PolicyId } from '../../../sim/types'
import { Badge, Button, Card, CardHeader, cx } from '../../components'
import { ARCHIVE_DATE_RANGE, CUSTOM_DAY_KEY, POLICY_META, dayOptions, hasArchivedForecast, overallProgress, randomSeed } from './labModel'
import { formErrors, formSource, useLab, labStore } from './labStore'
import { SCENARIO_SHIFT } from '../../../sim/scenarios'
import type { TimeWindow } from './labTypes'

const inputClass =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink shadow-xs focus-visible:border-shade disabled:cursor-not-allowed disabled:bg-canvas disabled:text-subtle'

function Field({ label, htmlFor, hint, error, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs font-medium text-stop" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-subtle">{hint}</p>
      )}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format, hint, disabled }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; hint?: string; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold text-ink">
          {label}
        </label>
        <output htmlFor={id} className="text-sm font-semibold text-ink tabular-nums">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full cursor-pointer accent-shade disabled:cursor-not-allowed"
      />
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}

function WindowField({ label, value, fallback, onChange, error, disabled, hint }: { label: string; value: TimeWindow | null; fallback: TimeWindow; onChange: (w: TimeWindow | null) => void; error?: string; disabled?: boolean; hint: string }) {
  const id = useId()
  const on = value !== null
  const w = value ?? fallback
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <label htmlFor={`${id}-on`} className="flex items-center gap-2 text-xs font-semibold text-ink">
        <input id={`${id}-on`} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? { ...w } : null)} className="size-4 accent-shade" />
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="time"
          aria-label={`${label}: from`}
          value={w.from}
          min={SCENARIO_SHIFT.start}
          max={SCENARIO_SHIFT.end}
          step={300}
          disabled={!on || disabled}
          onChange={(e) => onChange({ ...w, from: e.target.value })}
          className={cx(inputClass, 'h-9 tabular-nums')}
        />
        <span className="text-xs text-muted" aria-hidden>
          to
        </span>
        <input
          type="time"
          aria-label={`${label}: to`}
          value={w.to}
          min={SCENARIO_SHIFT.start}
          max={SCENARIO_SHIFT.end}
          step={300}
          disabled={!on || disabled}
          onChange={(e) => onChange({ ...w, to: e.target.value })}
          className={cx(inputClass, 'h-9 tabular-nums')}
        />
      </div>
      {error ? (
        <p className="mt-1 text-xs font-medium text-stop" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-xs text-subtle">{hint}</p>
      )}
    </fieldset>
  )
}

/** Seconds a 33-worker day takes per policy in the worker (≈ 2 s, measured) — the estimate shown next to Run [ENG]. */
const SECONDS_PER_POLICY = 2

export function LabControls() {
  const form = useLab((s) => s.form)
  const demoDays = useLab((s) => s.demoDays)
  const demoStatus = useLab((s) => s.demoDaysStatus)
  const exp = useLab((s) => s.experiment)
  const store = labStore.getState()
  const ids = { day: useId(), seed: useId(), site: useId(), date: useId() }

  useEffect(() => {
    labStore.getState().loadDemoDays()
  }, [])

  const options = useMemo(() => dayOptions(demoDays), [demoDays])
  const source = formSource(form, options)
  const errors = formErrors(form, source)
  const canRun = Object.keys(errors).length === 0
  const running = exp.status === 'running'
  const scenario = source?.kind === 'scenario' ? getScenario(source.scenarioId) : null
  const site = source ? getSite(source.kind === 'scenario' ? getScenario(source.scenarioId).siteId : source.siteId) : null
  const date = source ? (source.kind === 'scenario' ? getScenario(source.scenarioId).date : source.date) : null
  const forecast = date ? hasArchivedForecast(date) : false
  const wearablePicked = form.policies.some(policyUsesWearable)
  const pct = Math.round(overallProgress(exp.progress) * 100)
  const runningPolicy = exp.spec && exp.progress && exp.progress.phase === 'running' ? exp.spec.policies[exp.progress.policyIndex] : null

  const togglePolicy = (p: PolicyId, on: boolean) => store.setForm({ policies: on ? [...form.policies, p] : form.policies.filter((x) => x !== p) })
  const setBehaviour = (patch: Partial<typeof form.behaviour>) => store.setForm({ behaviour: { ...form.behaviour, ...patch } })
  const setDisruptions = (patch: Partial<typeof form.disruptions>) => store.setForm({ disruptions: { ...form.disruptions, ...patch } })

  return (
    <Card as="section" aria-labelledby={`${ids.day}-title`} padding="lg">
      <CardHeader
        id={`${ids.day}-title`}
        as="h2"
        icon={FlaskConical}
        title="Experiment"
        description="The same day, seed and assumptions run once per policy, each in its own simulated world, in a background worker."
        actions={
          <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => store.resetAssumptions()} disabled={running}>
            Reset assumptions
          </Button>
        }
      />

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canRun) store.run()
        }}
        className="space-y-6"
      >
        <div className="grid gap-x-6 gap-y-5 lg:grid-cols-12">
          {/* Day and seed */}
          <div className="space-y-4 lg:col-span-5">
            <Field
              label="Day"
              htmlFor={ids.day}
              error={form.dayKey !== CUSTOM_DAY_KEY ? errors.day : undefined}
              hint={demoStatus === 'error' ? 'Cached demo days could not be loaded; scenarios still run.' : undefined}
            >
              <select id={ids.day} value={form.dayKey} disabled={running} onChange={(e) => store.selectDay(e.target.value)} className={inputClass}>
                <optgroup label="Scenarios (roster and scripted events)">
                  {options
                    .filter((o) => o.group === 'scenario')
                    .map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label} — {o.detail}
                      </option>
                    ))}
                </optgroup>
                {options.some((o) => o.group === 'demo') && (
                  <optgroup label="Other cached demo days (generated crews)">
                    {options
                      .filter((o) => o.group === 'demo')
                      .map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label} — {o.detail.split(' · ')[0]}
                        </option>
                      ))}
                  </optgroup>
                )}
                <optgroup label="Any archived day">
                  <option value={CUSTOM_DAY_KEY}>Pick a site and date…</option>
                </optgroup>
              </select>
            </Field>

            {form.dayKey === CUSTOM_DAY_KEY && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Site" htmlFor={ids.site}>
                  <select id={ids.site} value={form.custom.siteId} disabled={running} onChange={(e) => store.setCustomDay({ siteId: e.target.value as SiteId })} className={inputClass}>
                    {SITES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date" htmlFor={ids.date} error={errors.day}>
                  <input
                    id={ids.date}
                    type="date"
                    value={form.custom.date}
                    min={ARCHIVE_DATE_RANGE.min}
                    max={ARCHIVE_DATE_RANGE.max}
                    disabled={running}
                    onChange={(e) => store.setCustomDay({ date: e.target.value })}
                    className={cx(inputClass, 'tabular-nums')}
                  />
                </Field>
              </div>
            )}

            <div className="rounded-lg bg-canvas px-3 py-2.5 text-xs text-muted">
              {scenario ? (
                <>
                  <p className="text-ink">{scenario.description}</p>
                  <p className="mt-1">
                    {site?.name} · {date} · shift {SCENARIO_SHIFT.start}–{SCENARIO_SHIFT.end} · {scenario.events.length} scripted {scenario.events.length === 1 ? 'event' : 'events'}
                  </p>
                </>
              ) : (
                <p>
                  {site ? `${site.name} · ${date ?? ''} · ` : ''}
                  {site?.id === 'musaffah' ? 'The Musaffah demo crew plus one generated crew' : 'Two generated crews'}, shift {SCENARIO_SHIFT.start}–{SCENARIO_SHIFT.end}, no scripted events.
                </p>
              )}
              <p className="mt-1 inline-flex items-center gap-1">
                <CalendarDays size={12} aria-hidden />
                {forecast ? 'Real weather (ECMWF IFS archive) with the archived day-ahead forecast as the engine’s input.' : 'Real weather; no archived forecast for this date, so the engine sees the analysis (perfect-forecast assumption, optimistic).'}
              </p>
            </div>

            <Field label="Seed" htmlFor={ids.seed} error={errors.seed} hint="Same seed, same day and same assumptions give the same result: hidden traits and every random draw are seeded per worker.">
              <div className="flex gap-2">
                <input id={ids.seed} value={form.seed} disabled={running} spellCheck={false} autoComplete="off" onChange={(e) => store.setForm({ seed: e.target.value })} className={cx(inputClass, 'font-mono')} />
                <Button type="button" variant="secondary" icon={Shuffle} className="shrink-0" disabled={running} onClick={() => store.setForm({ seed: randomSeed() })}>
                  New seed
                </Button>
              </div>
            </Field>
          </div>

          {/* Policies */}
          <fieldset className="min-w-0 lg:col-span-7">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <legend className="text-xs font-semibold text-ink">Policies</legend>
              <span className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" disabled={running} onClick={() => store.setForm({ policies: [...POLICY_IDS] })}>
                  Compare all five
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={running} onClick={() => store.setForm({ policies: ['ban_only', ...ZILL_POLICY_IDS] })}>
                  Baseline + Zill
                </Button>
              </span>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {POLICY_IDS.map((p) => {
                const checked = form.policies.includes(p)
                return (
                  <li key={p}>
                    <label
                      className={cx(
                        'flex h-full cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-shade',
                        checked ? 'border-shade bg-shade-bg' : 'border-line bg-surface hover:bg-canvas',
                        running && 'cursor-not-allowed opacity-70',
                      )}
                    >
                      <input type="checkbox" checked={checked} disabled={running} onChange={(e) => togglePolicy(p, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-shade" />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
                          {POLICY_META[p].name}
                          {p === 'ban_only' && <Badge size="sm">Baseline</Badge>}
                          {p === 'zill_monitored' && (
                            <Badge size="sm" tone="info">
                              Site opt-in
                            </Badge>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs leading-snug text-muted">{POLICY_META[p].description}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            {errors.policies && (
              <p className="mt-1 text-xs font-medium text-stop" role="alert">
                {errors.policies}
              </p>
            )}
          </fieldset>
        </div>

        <div className="grid gap-x-6 gap-y-5 border-t border-line pt-5 lg:grid-cols-12">
          <fieldset className="min-w-0 space-y-3 lg:col-span-5" disabled={running}>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Behaviour assumptions</legend>
            <Slider label="Compliance with instructions" value={form.behaviour.compliance} min={0} max={1} step={0.05} onChange={(v) => setBehaviour({ compliance: v })} format={(v) => `${Math.round(v * 100)} %`} hint="Chance a worker follows a rest, stop or drink instruction (default 70 %; the back-test sweeps 50–90 %)." />
            <Slider label="Unprompted symptom reports" value={form.behaviour.selfReportScale} min={0} max={2} step={0.1} onChange={(v) => setBehaviour({ selfReportScale: v })} format={(v) => `× ${v.toFixed(1)}`} hint="Scales each worker's tendency to report symptoms without being asked." />
            <Slider label="Answers to check-in prompts" value={form.behaviour.respondScale} min={0} max={2} step={0.1} onChange={(v) => setBehaviour({ respondScale: v })} format={(v) => `× ${v.toFixed(1)}`} hint="Scales how often a prompted check-in is answered." />
          </fieldset>

          <fieldset className="min-w-0 lg:col-span-7" disabled={running}>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Disruptions</legend>
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              <Slider label="Extra wearable dropout" value={form.disruptions.wearableDropout} min={0} max={1} step={0.05} onChange={(v) => setDisruptions({ wearableDropout: v })} format={(v) => `${Math.round(v * 100)} %`} hint={wearablePicked ? 'Share of wearable minutes lost on top of the PPG dropout model.' : 'Only affects the wearable policies.'} />
              <Slider label="PPG noise" value={form.disruptions.ppgNoiseMultiplier} min={0.5} max={3} step={0.25} onChange={(v) => setDisruptions({ ppgNoiseMultiplier: v })} format={(v) => `× ${v.toFixed(2)}`} hint="Multiplier on the optical heart-rate noise model." />
              <WindowField label="Site WBGT sensor failure" value={form.disruptions.envSensorFailure} fallback={{ from: '11:00', to: '11:30' }} onChange={(w) => setDisruptions({ envSensorFailure: w })} error={errors.sensor} disabled={running} hint="The engine falls back down the data chain." />
              <WindowField label="Network outage" value={form.disruptions.networkOutage} fallback={{ from: '15:30', to: '15:50' }} onChange={(w) => setDisruptions({ networkOutage: w })} error={errors.network} disabled={running} hint="Devices keep working; supervisor delivery is delayed." />
            </div>
          </fieldset>
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
          <div className="flex shrink-0 gap-2">
            <Button type="submit" icon={Play} disabled={!canRun || running} loading={running}>
              {running ? 'Running…' : form.policies.length > 1 ? `Run ${form.policies.length} policies` : 'Run'}
            </Button>
            {running && (
              <Button type="button" variant="secondary" icon={Square} onClick={() => store.cancel()}>
                Cancel
              </Button>
            )}
          </div>
          <div className="min-w-0 flex-1 text-xs text-muted">
            {running ? (
              <div className="space-y-1.5">
                <div role="progressbar" aria-label="Experiment progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-shade transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <p aria-live="polite">
                  {runningPolicy ? `Simulating ${POLICY_META[runningPolicy].name} (${(exp.progress?.policyIndex ?? 0) + 1} of ${exp.progress?.policyCount ?? 0})` : 'Loading weather and roster…'}
                  <span className="text-subtle"> · seed </span>
                  <span className="font-mono text-ink">{exp.spec?.seed}</span>
                </p>
              </div>
            ) : (
              <p>
                About {Math.max(1, form.policies.length) * SECONDS_PER_POLICY} s for {form.policies.length || 'no'} {form.policies.length === 1 ? 'policy' : 'policies'} in a background worker; the page stays responsive.{' '}
                {exp.status === 'cancelled' && <span className="font-medium text-ink">Last run cancelled{exp.results.length ? ` after ${exp.results.length} of ${exp.spec?.policies.length ?? 0} policies` : ''}.</span>}
                {exp.status === 'error' && <span className="font-medium text-stop">The run failed: {exp.error}</span>}
              </p>
            )}
          </div>
        </div>
      </form>
    </Card>
  )
}
