/**
 * Site settings card: the plan basis of the site (Standard limits / Monitored mode), what monitored mode requires, the
 * crews actually planned on each basis today (crew level only), and the logged sign-off of every change.
 * Basis: docs/dev/engine-api-wave2d.md §1–§3; planner.ts MONITORED_PLAN; ARCHITECTURE §1.5, §7.
 */
import { useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { CircleCheck, ClipboardSignature, Gauge, History, Radar, SlidersHorizontal, Table2 } from 'lucide-react'
import { formatLocalHhmm } from '../../../engine/time'
import { DEFAULT_ACTOR_IDS, simStore } from '../../../state'
import { useSim } from '../../../state/hooks'
import type { PolicyId } from '../../../sim/types'
import { Badge, Button, Card, CardHeader, Section, cx } from '../../components'
import { MONITORED_BASIS, MONITORED_REQUIREMENTS } from './model'
import { POLICY_NAMES, siteSettingsStore, switchPlanBasis } from './planBasis'
import { INPUT_CLASS } from './ui'

type BasisPolicy = 'zill_full' | 'zill_monitored'

const OPTIONS: readonly { policy: BasisPolicy; title: string; icon: typeof Table2; text: string }[] = [
  {
    policy: 'zill_full',
    title: 'Standard limits',
    icon: Table2,
    text: 'The NIOSH/ACGIH WBGT work/rest tables, the ADOSH heat-zone rules and an ISO 7933 screen set every crew plan. Members on an acclimatisation schedule get personal caps.',
  },
  {
    policy: 'zill_monitored',
    title: 'Monitored mode',
    icon: Radar,
    text: 'A site opt-in. The WBGT tables become a screen (ISO 7243, ACGIH decision flow). For an acclimatised worker with valid wearable data, that worker’s own ISO 7933 projection and strain criteria set the limits.',
  },
]

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function SiteSettings() {
  const policy = useSim((s) => s.view?.config.policy ?? s.overrides.policy ?? null)
  const loaded = useSim((s) => s.scenarioId !== null && s.status === 'ready')
  const crews = useSim((s) => s.crews)
  const crewKey = useSim((s) => s.view?.plan?.crews.map((c) => `${c.crewId}:${c.planBasis}`).join('|') ?? '')
  const changes = useStore(siteSettingsStore, (s) => s.changes)
  const [target, setTarget] = useState<BasisPolicy | null>(null)
  const [signer, setSigner] = useState<string>(DEFAULT_ACTOR_IDS.occ_health)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const crewBases = useMemo(() => {
    const names = new Map(crews.map((c) => [c.id, c.name]))
    return crewKey
      .split('|')
      .filter((x) => x.length > 0)
      .map((x) => {
        const [crewId, basis] = x.split(':')
        return { crewId, name: names.get(crewId) ?? crewId, monitored: basis === 'monitored' }
      })
  }, [crewKey, crews])
  const monitoredCrews = crewBases.filter((c) => c.monitored).length
  const comparison = policy !== null && policy !== 'zill_full' && policy !== 'zill_monitored'
  const pending = target !== null && target !== policy ? target : null

  const apply = async (to: BasisPolicy) => {
    setBusy(true)
    setError(null)
    const from: PolicyId | null = policy
    const t = simStore.getState().view?.t ?? null
    try {
      const ok = await switchPlanBasis(to)
      if (!ok) throw new Error('The shift could not be reloaded under the new plan basis.')
      siteSettingsStore.getState().record({ t, from, to, signedOffBy: to === 'zill_monitored' ? signer.trim() : null })
      setTarget(null)
      setConfirmed(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      id="gov-site"
      title="Site settings"
      description="How work/rest limits are set on this site, and the safeguards that come with the monitored basis."
      provenance="engineering_default"
      provenanceDetail="Plan basis of the simulated site (policy zill_full or zill_monitored)"
    >
      <Card as="article" aria-labelledby="gov-site-h" className="min-w-0">
        <CardHeader id="gov-site-h" as="h3" icon={SlidersHorizontal} title="Plan basis" description="Changing it reloads the shift at the same simulated time." />
        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <div className="min-w-0">
        {comparison && policy && (
          <p className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-muted">
            The Lab has set a comparison policy: <span className="font-medium text-ink">{POLICY_NAMES[policy]}</span>. Choose a plan basis to return to Zill.
          </p>
        )}
        <div role="radiogroup" aria-label="Plan basis" className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const inForce = policy === o.policy
            const chosen = (pending ?? policy) === o.policy
            const Icon = o.icon
            return (
              <button
                key={o.policy}
                type="button"
                role="radio"
                aria-checked={chosen}
                disabled={!loaded || busy}
                onClick={() => {
                  setTarget(o.policy)
                  setError(null)
                }}
                className={cx(
                  'flex min-w-0 flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade disabled:cursor-not-allowed disabled:opacity-60',
                  chosen ? 'border-shade bg-shade-bg' : 'border-line bg-surface hover:border-line-strong',
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <Icon aria-hidden size={18} className={chosen ? 'text-shade-dark' : 'text-subtle'} />
                  <span className="font-semibold text-ink">{o.title}</span>
                  {inForce && (
                    <Badge tone="brand" size="sm" icon={CircleCheck} className="ms-auto">
                      In force
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted">{o.text}</span>
              </button>
            )
          })}
        </div>

        {pending === 'zill_monitored' && (
          <div className="mt-3 rounded-lg border border-shade-tint bg-shade-bg/60 p-3">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <ClipboardSignature aria-hidden size={16} className="text-shade-dark" />
              Occupational-health sign-off
            </h4>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="gov-site-signer" className="mb-1 block text-xs font-medium text-muted">
                  Signed off by
                </label>
                <input id="gov-site-signer" value={signer} onChange={(e) => setSigner(e.target.value)} className={cx(INPUT_CLASS, 'w-36 font-mono')} autoComplete="off" />
              </div>
              <label className="flex min-h-10 flex-1 basis-60 cursor-pointer items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-shade)]" />
                Occupational health has reviewed monitored mode for this site and signs off. The sign-off is logged.
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button icon={Radar} loading={busy} disabled={!confirmed || signer.trim() === '' || busy} onClick={() => void apply('zill_monitored')}>
                Switch to monitored mode
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {pending === 'zill_full' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas p-3">
            <p className="min-w-0 flex-1 basis-60 text-sm text-muted">Returning to the standard limits needs no sign-off: the tables are the conservative default.</p>
            <Button icon={Table2} loading={busy} disabled={busy} onClick={() => void apply('zill_full')}>
              Return to standard limits
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {error}
          </p>
        )}

        {crewBases.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
              <Gauge aria-hidden size={13} />
              Today’s crew plans
            </h4>
            <p className="mb-2 text-sm text-ink">
              {policy === 'zill_monitored'
                ? `${monitoredCrews} of ${crewBases.length} crews planned on the monitored basis. A crew stays on the tables without an acclimatised member or climate data.`
                : `All ${crewBases.length} crews planned on the standard tables.`}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {crewBases.map((c) => (
                <li key={c.crewId}>
                  <span
                    className={cx(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
                      c.monitored ? 'border-shade-tint bg-shade-bg text-shade-dark' : 'border-line bg-canvas text-slate-700',
                    )}
                  >
                    {c.monitored ? <Radar aria-hidden size={12} /> : <Table2 aria-hidden size={12} />}
                    {c.name}
                    <span className="sr-only">: {c.monitored ? 'monitored basis' : 'standard tables'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {changes.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
              <History aria-hidden size={13} />
              Change log
            </h4>
            <ol className="space-y-1 text-sm">
              {[...changes].reverse().map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2">
                  <span className="font-mono text-xs leading-5 text-muted tabular-nums">{c.t !== null ? formatLocalHhmm(c.t) : '—'}</span>
                  <span className="text-ink">
                    {c.from ? POLICY_NAMES[c.from] : 'None'} → {POLICY_NAMES[c.to]}
                  </span>
                  <span className="text-muted">{c.signedOffBy ? `signed off by ${c.signedOffBy}` : 'no sign-off needed'}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        </div>

        <div className="min-w-0">
        <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">What monitored mode requires</h4>
        <ul className="space-y-2">
          {MONITORED_REQUIREMENTS.map((r) => (
            <li key={r.title} className="flex gap-2.5">
              <CircleCheck aria-hidden size={16} className="mt-0.5 shrink-0 text-shade" />
              <span className="min-w-0 text-sm">
                <span className="font-medium text-ink">{r.title}.</span> <span className="text-muted">{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer rounded font-medium text-shade-dark hover:underline">Standards behind the monitored basis</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {MONITORED_BASIS.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
        </div>
        </div>
      </Card>
    </Section>
  )
}
