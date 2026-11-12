/**
 * Simulation lab (#/lab, ARCHITECTURE §9): experiment controls, policy comparisons run in a background worker, per-worker
 * truth-vs-estimate charts, the live world's ground truth, and the non-circular design that makes the comparison
 * believable. The ONLY view that shows simulated ground truth, always labelled as such (docs/SIMULATION.md).
 */
import { useState } from 'react'
import { Beaker, BookOpen, FlaskConical, Radio, Scale, ShieldCheck, TriangleAlert } from 'lucide-react'
import { METRICS_VERSION } from '../../../sim/metrics'
import { TRUTH_MODEL_VERSION } from '../../../sim/truth'
import { WORLDSIM_VERSION } from '../../../sim/worldsim'
import type { ViewProps } from '../../App'
import { Card, CardHeader, ProvenanceTag, Tabs } from '../../components'
import { LabControls } from './LabControls'
import { LabLive } from './LabLive'
import { LabResults } from './LabResults'
import { useLab } from './labStore'

/** docs/SIMULATION.md §1 "Avoiding circularity": what the engine uses against what drives the virtual worker. */
const NON_CIRCULAR: readonly { topic: string; engine: string; truth: string }[] = [
  {
    topic: 'Heat strain',
    engine: 'ISO 7933 Predicted Heat Strain projection',
    truth: 'Gagge two-node thermoregulation model (1986), minute by minute, with hidden individual parameters',
  },
  {
    topic: 'Radiant heat',
    engine: 'Human MRT from the forecast radiation, ground at air temperature plus the site allowance',
    truth: 'Human MRT from the analysis radiation, hot ground in sun, raw direct/diffuse split, individual position offset',
  },
  {
    topic: 'Metabolic rate',
    engine: 'Class-based rate (ISO 8996 table)',
    truth: 'Task rate × a hidden log-normal multiplier per worker',
  },
  {
    topic: 'Heart rate → core',
    engine: 'ECTemp: heart rate → core estimate (Buller quadratic, Kalman filter)',
    truth: 'Cardiovascular model: %VO₂ reserve + thermal and dehydration drift + PPG error — not the ECTemp equation',
  },
  {
    topic: 'Acclimatisation',
    engine: 'Declared status (days on site)',
    truth: 'True acclimatisation fraction with individual variation, acting on sweat gain and core set point',
  },
]

function MethodPanel() {
  return (
    <div className="space-y-4">
      <Card as="section" aria-labelledby="lab-method-heading" padding="md">
        <CardHeader id="lab-method-heading" icon={Scale} title="Why the comparison is not circular" description="The virtual workers' bodies run on different models from the ones Zill uses to warn them." />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">Engine models against ground-truth models (docs/SIMULATION.md §1)</caption>
            <thead>
              <tr className="border-b border-line-strong text-start">
                <th scope="col" className="w-1/2 py-1.5 pe-3 text-start font-semibold text-ink">
                  Engine (what Zill sees)
                </th>
                <th scope="col" className="w-1/2 py-1.5 text-start font-semibold text-ink">
                  Ground truth (hidden)
                </th>
              </tr>
            </thead>
            {NON_CIRCULAR.map((r) => (
              <tbody key={r.topic} className="border-b border-line/70 last:border-0">
                <tr>
                  <th scope="colgroup" colSpan={2} className="pt-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-subtle">
                    {r.topic}
                  </th>
                </tr>
                <tr className="align-top">
                  <td className="pb-2.5 pe-3 pt-0.5 text-muted">{r.engine}</td>
                  <td className="pb-2.5 pt-0.5 text-muted">{r.truth}</td>
                </tr>
              </tbody>
            ))}
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          The engine is never given ground-truth core temperature, true metabolic rate, true hydration or latent illness. The human-MRT formula is shared; independence there lies in the inputs (forecast against analysis, ground temperature, position).
        </p>
      </Card>

      <Card as="section" aria-labelledby="lab-read-heading" padding="md">
        <CardHeader id="lab-read-heading" icon={BookOpen} title="How to read the lab" />
        <ul className="space-y-2 text-xs text-muted">
          <li className="flex gap-2">
            <FlaskConical size={14} aria-hidden className="mt-px shrink-0 text-subtle" />
            <span>
              <strong className="font-semibold text-ink">Simulated ground truth</strong> is what happens to a virtual worker. It appears only here; operational views never see it.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck size={14} aria-hidden className="mt-px shrink-0 text-subtle" />
            <span>
              <strong className="font-semibold text-ink">ECTemp</strong> is an estimated strain indicator shown with its ± 0.6 °C band (about the published limits of agreement). Zill does not measure core temperature, diagnose or predict heat stroke.
            </span>
          </li>
          <li className="flex gap-2">
            <Beaker size={14} aria-hidden className="mt-px shrink-0 text-subtle" />
            <span>
              <strong className="font-semibold text-ink">Comparisons</strong> are a simulated cohort: projections under stated assumptions, not measured outcomes. Behaviour values are assumptions; the back-test sweeps the ones that matter.
            </span>
          </li>
        </ul>
      </Card>

      <Card as="section" aria-labelledby="lab-limits-heading" padding="md">
        <CardHeader id="lab-limits-heading" icon={TriangleAlert} title="What the simulation cannot show" />
        <ul className="list-disc space-y-1.5 ps-4 text-xs text-muted marker:text-subtle">
          <li>That Zill reduces real heat illness: only a prospective pilot can, with feasibility endpoints (lead time, adherence, false alarms, acceptability).</li>
          <li>Agreement between two models is not validation against people; Gagge's two-node model is itself a simplification.</li>
          <li>Generated crews have a fixed job shorter than the shift, and supervisors do not reassign a worker whose task is not feasible now.</li>
        </ul>
        <p className="mt-3 border-t border-line pt-2 font-mono text-[11px] text-subtle">
          worldsim {WORLDSIM_VERSION} · truth model {TRUTH_MODEL_VERSION} · metrics {METRICS_VERSION}
        </p>
      </Card>
    </div>
  )
}

export function LabView({ route }: ViewProps) {
  const [tab, setTab] = useState<string>(route.query.tab === 'live' ? 'live' : 'experiments')
  const results = useLab((s) => s.experiment.results.length)
  const running = useLab((s) => s.experiment.status === 'running')

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-shade-bg text-shade">
            <FlaskConical size={22} />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Simulation lab</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Run the same day under each warning policy and watch what the engine displayed against what the virtual worker's body did. The only place simulated ground truth is shown.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ProvenanceTag kind="simulated" size="md" detail="Virtual workers on real weather (docs/SIMULATION.md)" />
          <ProvenanceTag kind="real_weather" size="md" detail="ECMWF IFS archive 2020–2025; archived day-ahead forecasts 2024–2025" />
        </div>
      </header>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <Tabs
            label="Lab mode"
            value={tab}
            onValueChange={setTab}
            items={[
              { id: 'experiments', label: 'Experiments', icon: Beaker, badge: running ? 'running' : results > 0 ? `${results}` : undefined },
              { id: 'live', label: 'Live world', icon: Radio },
            ]}
            panelClassName="pt-5"
          >
            {(id) =>
              id === 'live' ? (
                <LabLive />
              ) : (
                <div className="space-y-8">
                  <LabControls />
                  <LabResults />
                </div>
              )
            }
          </Tabs>
        </div>
        <aside aria-label="Method" className="min-w-0">
          <MethodPanel />
        </aside>
      </div>
    </div>
  )
}
