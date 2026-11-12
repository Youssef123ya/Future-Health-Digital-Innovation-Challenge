/**
 * "What supervisors never see": the two pooled phrases and the private reasons they hide, the no-individual-numbers
 * rule with the driver rule counts, the device-only prompts, and the designed-suppression register (advisories logged
 * but notified to nobody, and the classes that are never suppressed). Static reference data from privacy.ts and
 * alerts.ts. Basis: ARCHITECTURE §1.5, §6, §7; docs/dev/engine-api-wave2d.md §0, §4, §5; ANSI/ISA-18.2-2016.
 */
import { memo } from 'react'
import { BellOff, BellRing, EyeOff, Hash, MessageSquareQuote, Smartphone } from 'lucide-react'
import { DEVICE_ONLY_ACTIONS, POOLED_DRIVERS, POOLED_DRIVER_IDS } from '../../../engine/privacy'
import { Link, pathFor } from '../../router'
import { Card, CardHeader, Section } from '../../components'
import { LOGGED_NOT_SENT, NEVER_SUPPRESSED, NEVER_TO_SUPERVISORS, PLAN_COVERED_ACTION_IDS, POOLED_HIDES, driversByRule, supervisorRuleCounts } from './model'
import { actionLabel } from './ui'

const RULE_COUNTS = supervisorRuleCounts()


const POOLED_TITLE: Readonly<Record<(typeof POOLED_DRIVER_IDS)[number], string>> = {
  not_cleared_for_heat_work: 'Not cleared for heat work now',
  device_directed_rest: 'Device-directed rest',
}

export const SupervisorBoundary = memo(function SupervisorBoundary() {
  return (
    <Section
      id="gov-boundary"
      title="What supervisors never see"
      description="Private reasons are enforced on the worker’s phone and reach the console only as one of two pooled phrases. No individual number is ever composed into a supervisor, HSE or regulator screen."
      provenance="engineering_default"
      provenanceDetail="privacy.ts POOLED_DRIVERS and SUPERVISOR_DRIVER_RULES; alerts.ts designed suppression"
    >
      <div className="grid gap-4 lg:grid-cols-12">
        <Card as="article" aria-labelledby="gov-pooled-h" className="min-w-0 lg:col-span-12">
          <CardHeader id="gov-pooled-h" as="h3" icon={MessageSquareQuote} title="Two pooled phrases" description="Same text, channel and basis whatever the cause, so no field tells the causes apart." />
          <div className="grid gap-3 md:grid-cols-2">
            {POOLED_DRIVER_IDS.map((id) => (
              <div key={id} className="flex min-w-0 flex-col rounded-lg border border-line p-3">
                <p className="text-sm font-semibold text-ink">{POOLED_TITLE[id]}</p>
                <blockquote className="mt-1 border-s-2 border-shade ps-2 text-sm text-muted">“{POOLED_DRIVERS[id].text}”</blockquote>
                <p className="mt-2.5 text-xs font-semibold tracking-wide text-muted uppercase">Can stand for</p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink">
                  {POOLED_HIDES[id].map((h) => (
                    <li key={h} className="flex gap-2">
                      <EyeOff aria-hidden size={13} className="mt-1 shrink-0 text-subtle" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-auto pt-2 text-xs text-subtle tabular-nums">{driversByRule(id).length} engine reasons map to this phrase.</p>
              </div>
            ))}
          </div>
        </Card>

        <Card as="article" aria-labelledby="gov-numbers-h" className="min-w-0 lg:col-span-5">
          <CardHeader id="gov-numbers-h" as="h3" icon={Hash} title="No individual numbers" description="Never on a supervisor, HSE or regulator screen, whatever the source." />
          <ul className="grid gap-x-4 gap-y-1 text-sm text-ink sm:grid-cols-2 lg:grid-cols-1">
            {NEVER_TO_SUPERVISORS.map((n) => (
              <li key={n} className="flex gap-2">
                <EyeOff aria-hidden size={13} className="mt-1 shrink-0 text-subtle" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            {[
              { k: 'Site reasons, with site numbers', v: RULE_COUNTS.site },
              { k: 'Generic phrase, no value', v: RULE_COUNTS.phrase },
              { k: 'Pooled phrase', v: RULE_COUNTS.not_cleared_for_heat_work + RULE_COUNTS.device_directed_rest },
              { k: 'Withheld', v: RULE_COUNTS.withhold },
            ].map((x) => (
              <div key={x.k} className="rounded-lg border border-line px-2.5 py-2">
                <dt className="text-xs text-muted">{x.k}</dt>
                <dd className="text-lg font-semibold text-ink tabular-nums">{x.v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted">
            Engine reasons by how a supervisor sees them. A reason not on the list is withheld (default deny).
          </p>
          <h4 className="mt-3 mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
            <Smartphone aria-hidden size={13} />
            Prompts that stay on the phone
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {DEVICE_ONLY_ACTIONS.map((a) => (
              <li key={a} className="rounded-md border border-line bg-canvas px-2 py-0.5 text-xs text-ink">
                {actionLabel(a)}
              </li>
            ))}
          </ul>
        </Card>

        <Card as="article" aria-labelledby="gov-suppression-h" className="min-w-0 lg:col-span-7">
          <CardHeader
            id="gov-suppression-h"
            as="h3"
            icon={BellOff}
            title="Designed-suppression register"
            description="ANSI/ISA-18.2: an alarm must call for a new action. Advisories whose action is already in force are logged and sent to nobody."
          />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 rounded-lg border border-line p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <BellOff aria-hidden size={15} className="text-subtle" />
                Logged, notified to nobody
              </p>
              <ul className="mt-2 space-y-2">
                {LOGGED_NOT_SENT.map((r) => (
                  <li key={r.title} className="text-sm">
                    <span className="font-medium text-ink">{r.title}.</span> <span className="text-muted">{r.detail}</span>{' '}
                    <span className="font-mono text-[11px] text-subtle">{r.drivers.join(', ')}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Plan-covered actions: {PLAN_COVERED_ACTION_IDS.map(actionLabel).join(' · ')}. One published reason, “action in force”, for both causes, so the
                monitored-mode cause cannot reveal wearable consent. Lifted and notified at once if the advisory gains an individual cause or its condition
                ends.
              </p>
            </div>
            <div className="min-w-0 rounded-lg border border-shade-tint bg-shade-bg/50 p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <BellRing aria-hidden size={15} className="text-shade-dark" />
                Never suppressed
              </p>
              <ul className="mt-2 space-y-1.5">
                {NEVER_SUPPRESSED.map((r) => (
                  <li key={r.title} className="text-sm">
                    <span className="font-medium text-ink">{r.title}.</span> <span className="text-muted">{r.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                The worker’s own phone still shows every advisory. Suppressed advisories are listed apart on the{' '}
                <Link to={pathFor('supervisor')} className="font-medium text-shade-dark underline underline-offset-2 hover:no-underline">
                  supervisor console
                </Link>
                , without their cause.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </Section>
  )
})
