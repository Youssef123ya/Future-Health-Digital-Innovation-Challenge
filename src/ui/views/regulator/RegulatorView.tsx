import { useState } from 'react'
import { ArrowUpRight, HardHat, Landmark, Lock, Scale } from 'lucide-react'
import type { ViewProps } from '../../App'
import { Link, pathFor } from '../../router'
import { formatLocalHhmm } from '../../../engine/time'
import { getScenario } from '../../../sim/scenarios'
import { useSim } from '../../../state/hooks'
import { Badge, ProvenanceTag, Tabs } from '../../components'
import { HSE_SCOPE, HseConsole, REGULATOR_SCOPE, RegulatorConsole } from './Console'
import { startOpsLog } from './opsLog'
import type { OpsScope } from './opsModel'

// Collect the site-day's task events from start-up, before bootstrap positions the clock (see ./opsLog.ts).
startOpsLog()

type ConsoleTab = 'regulator' | 'hse'

const ACCESS: Readonly<Record<ConsoleTab, { scope: OpsScope; who: string; purposes: string; k: number; rows: string; never: string }>> = {
  regulator: {
    scope: REGULATOR_SCOPE,
    who: 'Regulator (ADPHC / ADOSH)',
    purposes: 'compliance reporting and public-health statistics',
    k: 10,
    rows: 'one row per site',
    never: 'any individual record',
  },
  hse: {
    scope: HSE_SCOPE,
    who: 'HSE manager',
    purposes: 'safety alerting and compliance reporting',
    k: 5,
    rows: 'one row per crew of the site',
    never: 'individual records',
  },
}

/**
 * Regulator & HSE manager view (#/regulator): k-suppressed live aggregates of the running site-day (workers by level,
 * alert rates by basis and delivery, acknowledgement and escalation, midday-break and zone-control compliance, plan
 * basis), the real-weather context of the five Abu Dhabi sites, and the jurisdiction rule pack with a CSV export.
 * `?tab=hse` opens the HSE console. Basis: ARCHITECTURE §2 (HSE and Regulator rows), §7, §9.
 */
export function RegulatorView({ route }: ViewProps) {
  const [tab, setTab] = useState<ConsoleTab>(route.query.tab === 'hse' ? 'hse' : 'regulator')
  const scenarioId = useSim((s) => s.scenarioId)
  const t = useSim((s) => s.view?.t ?? null)
  const siteName = useSim((s) => s.view?.site.name ?? null)
  const date = useSim((s) => s.view?.config.date ?? null)
  const scenarioTitle = scenarioId ? getScenario(scenarioId).title : null

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-4">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-shade-bg text-shade">
          <Scale size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Regulator &amp; HSE</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Multi-site aggregates with small-cell suppression, hours in each heat zone and compliance. Nobody here sees an individual worker: every
            number is a k-suppressed count, and every table request is written to the audit log.
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <ProvenanceTag kind="simulated" detail="Live tables come from the running scenario's simulated cohort, not real workers." />
            {scenarioTitle && <span className="font-medium text-ink">{scenarioTitle}</span>}
            {siteName && <span>{siteName}</span>}
            {date && <span className="tabular-nums">{date}</span>}
            {t !== null && <span className="tabular-nums">Simulated time {formatLocalHhmm(t)}</span>}
          </p>
        </div>
      </header>

      <Tabs
        items={[
          { id: 'regulator', label: 'Regulator', icon: Landmark, badge: <Badge size="sm" tone="neutral" className="tabular-nums">k = 10</Badge> },
          { id: 'hse', label: 'HSE manager', icon: HardHat, badge: <Badge size="sm" tone="neutral" className="tabular-nums">k = 5</Badge> },
        ]}
        label="Console"
        value={tab}
        onValueChange={(id) => setTab(id === 'hse' ? 'hse' : 'regulator')}
        variant="underline"
        size="lg"
      >
        {(id) => {
          const key: ConsoleTab = id === 'hse' ? 'hse' : 'regulator'
          const a = ACCESS[key]
          return (
            <div className="space-y-6 pt-5">
              <div className="flex flex-wrap items-start gap-3 rounded-xl border border-shade/20 bg-shade-bg px-4 py-3 text-sm">
                <Lock aria-hidden size={18} className="mt-0.5 shrink-0 text-shade" />
                <p className="min-w-0 flex-1 text-ink">
                  <span className="font-semibold">Viewing as {a.who}</span> <span className="text-muted">({a.scope.actorId})</span> for {a.purposes}:{' '}
                  {a.rows}, cells with fewer than <span className="font-semibold tabular-nums">k = {a.k}</span> workers suppressed, with complementary
                  suppression. Never {a.never}.
                </p>
                <Link
                  to={pathFor('governance')}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-shade-dark underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-shade"
                >
                  Audit log <ArrowUpRight aria-hidden size={14} />
                </Link>
              </div>
              {key === 'regulator' ? <RegulatorConsole /> : <HseConsole />}
            </div>
          )
        }}
      </Tabs>
    </div>
  )
}
