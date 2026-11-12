/**
 * #/medic — first aid and occupational health. One console, two roles: the first aider (active stop and emergency
 * cases through privacy.project role 'first_aider', purpose 'safety_alerting') and the occupational-health nurse
 * (escalated cases through role 'occ_health', purpose 'clinical_care', clinical detail only with consent). Individual
 * data comes only from the state hooks (useFirstAiderCases / useOccHealthCases), which project and log every access;
 * the actor ids are passed explicitly. Deep links: `?role=first_aider|occ_health&case=<workerId>`.
 * Basis: ARCHITECTURE §2 (first aider and occupational health rows), §6, §7, §9.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CircleCheck, Eye, EyeOff, FastForward, Hourglass, Siren, Stethoscope, TriangleExclamationPoint, X } from 'lucide-react'
import type { ViewProps } from '../../App'
import type { Notification } from '../../../engine/alerts'
import { formatLocalHhmm, hhmmToMinutes } from '../../../engine/time'
import { SCENARIOS } from '../../../sim/scenarios'
import { useFirstAiderCases, useOccHealthCases, useSim, useUi } from '../../../state/hooks'
import { simStore } from '../../../state/simStore'
import { DEFAULT_ACTOR_IDS, uiStore } from '../../../state/uiStore'
import { Button, EmptyState, cx } from '../../components'
import { toCaseVMs, type MedicCaseVM, type MedicRole } from './medicModel'
import { dismissSignoff, useMedic, useRecordObservations, type ObservedCase } from './medicStore'
import { CaseDetail } from './CaseDetail'
import { CaseList } from './CaseList'
import { Call998Link, RoleSwitch } from './ui'

const PURPOSE: Readonly<Record<MedicRole, string>> = {
  first_aider: 'Active stop and emergency cases with location, the cooling protocol, re-checks and the recovery sign-off.',
  occ_health: 'Escalated cases, with the clinical detail each worker consented to share on escalation.',
}

const isMedicRole = (v: unknown): v is MedicRole => v === 'first_aider' || v === 'occ_health'

export function MedicView({ route }: ViewProps) {
  const uiRole = useUi((s) => s.role)
  const queryRole = isMedicRole(route.query.role) ? route.query.role : null
  // A ?role= deep link applies once, after the first render (a render never mutates a store).
  const [pendingRole, setPendingRole] = useState<MedicRole | null>(queryRole)
  useEffect(() => {
    if (pendingRole === null) return
    if (uiStore.getState().role !== pendingRole) uiStore.getState().setRole(pendingRole)
    setPendingRole(null)
  }, [pendingRole])
  const mode: MedicRole = pendingRole ?? (isMedicRole(uiRole) ? uiRole : 'first_aider')
  const setMode = useCallback((r: MedicRole) => uiStore.getState().setRole(r), [])
  const hasView = useSim((s) => s.view !== null)
  const status = useSim((s) => s.status)
  const error = useSim((s) => s.error)
  const labelId = useId()

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-shade-bg text-shade">
            <Stethoscope size={22} />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">First aid &amp; occupational health</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">{PURPOSE[mode]}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 lg:items-end">
          <span id={labelId} className="text-xs font-semibold tracking-wide text-muted uppercase">
            Acting as
          </span>
          <RoleSwitch value={mode} onChange={setMode} labelId={labelId} />
        </div>
      </header>

      <AccessStrip mode={mode} />

      {!hasView ? (
        status === 'error' ? (
          <EmptyState icon={TriangleExclamationPoint} tone="unavailable" title="The simulated shift could not be loaded" description={error ?? 'Reload the page to try again.'} />
        ) : (
          <EmptyState icon={Hourglass} title="Loading the simulated shift…" description="Cases appear as soon as the scenario is running." />
        )
      ) : mode === 'first_aider' ? (
        <FirstAiderConsole initialCase={route.query.case ?? null} />
      ) : (
        <OccHealthConsole initialCase={route.query.case ?? null} />
      )}
    </div>
  )
}

function AccessStrip({ mode }: { mode: MedicRole }) {
  const actorId = DEFAULT_ACTOR_IDS[mode]
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm lg:flex-row lg:items-center lg:gap-6">
      <p className="flex items-start gap-2 text-ink">
        <Eye aria-hidden size={16} className="mt-0.5 shrink-0 text-shade" />
        <span>
          <span className="font-semibold">Sees: </span>
          {mode === 'first_aider'
            ? 'name, level, actions and location of active stop and emergency cases; reported symptoms once a case is escalated.'
            : 'escalated cases; clinical detail only when the worker consented to share it on escalation.'}
        </span>
      </p>
      <p className="flex items-start gap-2 text-ink">
        <EyeOff aria-hidden size={16} className="mt-0.5 shrink-0 text-muted" />
        <span>
          <span className="font-semibold">Never: </span>
          {mode === 'first_aider' ? 'history, physiology or health factors.' : 'workers whose case is not escalated.'}
        </span>
      </p>
      <p className="text-xs text-muted lg:ms-auto lg:text-end">
        Demo staff id <span className="font-mono text-ink">{actorId}</span> · every view is written to the audit chain
      </p>
    </div>
  )
}

/** Stable scenario identity for the console-local store (a new scenario or policy clears it). */
function useScenarioKey(): string | null {
  return useSim((s) => (s.view ? `${s.scenarioId ?? 'custom'}|${s.view.config.seed}|${s.view.config.siteId}|${s.view.config.date}|${s.view.config.policy}|${String(s.view.config.shadow)}` : null))
}

function FirstAiderConsole({ initialCase }: { initialCase: string | null }) {
  const model = useFirstAiderCases(DEFAULT_ACTOR_IDS.first_aider)
  const alerts = useSim((s) => s.view?.alerts ?? null)
  const cases = useMemo(() => (model ? toCaseVMs(model.cases, 'first_aider', alerts) : null), [model, alerts])
  return <MedicConsole role="first_aider" cases={cases} t={model?.t ?? null} notifications={model?.notifications ?? NO_NOTES} initialCase={initialCase} />
}

function OccHealthConsole({ initialCase }: { initialCase: string | null }) {
  const model = useOccHealthCases(DEFAULT_ACTOR_IDS.occ_health)
  const alerts = useSim((s) => s.view?.alerts ?? null)
  const cases = useMemo(() => (model ? toCaseVMs(model.cases, 'occ_health', alerts) : null), [model, alerts])
  return <MedicConsole role="occ_health" cases={cases} t={model?.t ?? null} notifications={model?.notifications ?? NO_NOTES} initialCase={initialCase} />
}

const NO_NOTES: readonly Notification[] = Object.freeze([])

function MedicConsole({
  role,
  cases,
  t,
  notifications,
  initialCase,
}: {
  role: MedicRole
  cases: MedicCaseVM[] | null
  t: number | null
  notifications: readonly Notification[]
  initialCase: string | null
}) {
  const scenarioKey = useScenarioKey()
  const observed = useMemo<ObservedCase[] | null>(
    () => (cases ? cases.map((c) => ({ key: c.key, data: c.data, fields: c.fields, clinicalReleased: c.clinicalReleased })) : null),
    [cases],
  )
  useRecordObservations(scenarioKey, t, observed, role === 'occ_health')

  const crews = useSim((s) => s.crews)
  const crewNames = useMemo(() => Object.fromEntries(crews.map((c) => [c.id, c.name])), [crews])
  const [selectedWorker, setSelectedWorker] = useState<string | null>(initialCase)
  const list = cases ?? []
  const selected = list.find((c) => c.workerId === selectedWorker) ?? list[0] ?? null
  const emergencies = list.filter((c) => c.level === 'emergency')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const select = useCallback((c: MedicCaseVM) => {
    setSelectedWorker(c.workerId)
    // On narrow screens the detail sits below the list: bring it into view and move focus to its heading.
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        detailRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
        headingRef.current?.focus({ preventScroll: true })
      })
    }
  }, [])

  if (t === null) return null
  return (
    <div className="space-y-4">
      <SignoffNotice />
      {emergencies.length > 0 && <EmergencyBanner cases={emergencies} selectedKey={selected?.key ?? null} onOpen={select} />}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-20">
          <CaseList
            cases={list}
            role={role}
            selectedKey={selected?.key ?? null}
            onSelect={select}
            now={t}
            crewNames={crewNames}
            emptyAction={<NextEventJump t={t} />}
          />
        </div>
        <div ref={detailRef} className="min-w-0 scroll-mt-24">
          {selected ? (
            <CaseDetail
              key={selected.key}
              c={selected}
              role={role}
              actorId={DEFAULT_ACTOR_IDS[role]}
              now={t}
              notifications={notifications}
              crewNames={crewNames}
              headingRef={headingRef}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-muted">
              The case detail, cooling protocol and sign-off open here when a case is active.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function EmergencyBanner({ cases, selectedKey, onOpen }: { cases: readonly MedicCaseVM[]; selectedKey: string | null; onOpen: (c: MedicCaseVM) => void }) {
  const first = cases[0]
  if (!first) return null
  return (
    <section aria-label="Emergency" className="rounded-xl border-2 border-emergency-fill bg-emergency-bg p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="relative grid size-12 shrink-0 place-items-center rounded-full bg-emergency-fill text-white">
          <span aria-hidden className="absolute inset-0 rounded-full bg-emergency-fill animate-zill-pulse" />
          <Siren aria-hidden size={24} className="relative" />
        </span>
        <div className="min-w-[14rem] flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-bold text-emergency">
            <span>Emergency: call 998 now</span>
            {cases.map((c) => (
              <span key={c.key} className="rounded-md border border-emergency-fill/40 bg-surface px-2 py-0.5 text-sm font-semibold text-emergency">
                {c.name}
              </span>
            ))}
          </p>
          <p className="mt-0.5 text-sm text-ink">
            Cool first, transport second: start whole-body cold-water cooling on site at once and keep cooling until the ambulance team takes over. Never
            leave the worker alone.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Call998Link size="xl" />
          {cases.some((c) => c.key !== selectedKey) && (
            <Button variant="secondary" size="lg" onClick={() => onOpen(cases.find((c) => c.key !== selectedKey) ?? first)}>
              Open case
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}

function SignoffNotice() {
  const notice = useMedic((s) => s.lastSignoff)
  if (!notice) return null
  return (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-safe-fill/40 bg-safe-bg p-3 text-sm">
      <CircleCheck aria-hidden size={20} className="mt-0.5 shrink-0 text-safe" />
      <p className="min-w-0 flex-1 text-ink">
        <span className="font-semibold">
          {notice.emergency ? 'Case closed on hand-over' : 'Recovery signed off'}: {notice.name}
        </span>{' '}
        at <span className="tabular-nums">{formatLocalHhmm(notice.t)}</span> by {notice.role === 'first_aider' ? 'the first aider' : 'occupational health'}. The
        worker’s device keeps enforcing any hold it still has{notice.kind === 'clinical' ? '; after a first-aid stop, no more heat work today' : ''}.
      </p>
      <Button variant="ghost" size="sm" iconOnly icon={X} aria-label="Dismiss notice" onClick={dismissSignoff} />
    </div>
  )
}

/** In an empty list: a shortcut to the next scripted symptom event of the running scenario (demo aid). */
function NextEventJump({ t }: { t: number }) {
  const scenarioId = useSim((s) => s.scenarioId)
  const jumping = useSim((s) => s.jumping)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)
  const nowMin = hhmmToMinutes(formatLocalHhmm(t))
  const next = scenario?.events.find((e) => e.injection.kind === 'checkin' && hhmmToMinutes(e.at) > nowMin)
  if (!next) return null
  const target = hhmmToMinutes(next.at) + 2
  const hhmm = `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`
  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" icon={FastForward} loading={jumping} onClick={() => void simStore.getState().jumpTo(hhmm)}>
        Jump to {hhmm}
      </Button>
      <p className={cx('max-w-xs text-xs text-muted')}>{next.note}</p>
    </div>
  )
}
