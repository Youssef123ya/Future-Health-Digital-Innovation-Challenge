import { useEffect, useMemo, useRef, useState } from 'react'
import { Lock, Pause, Play, Radio, Send, Smartphone } from 'lucide-react'
import type { SyncPayload } from '../../../engine/privacy'
import { formatLocalHhmm } from '../../../engine/time'
import { PAYLOAD_HEARTBEAT_MIN, simStore, type SimSpeed } from '../../../state'
import { useDataFlowFeed, useSim } from '../../../state/hooks'
import { Badge, Button, Card, CardHeader, EmptyState, LevelPill, Section, cx } from '../../components'
import { DEVICE_ONLY_RECORDS, NO_SYNC, PAYLOAD_KEY_INFO, groupKeptOnDevice, nextSync, payloadLines, type SyncReason, type SyncTracker } from './model'
import { SubjectSelect, levelName, useFlash } from './ui'

interface SyncEvent {
  id: number
  t: number
  reason: SyncReason
  changed: (keyof SyncPayload)[]
  bytes: number
}

const REASON_TEXT: Readonly<Record<SyncReason, string>> = {
  first: 'Current payload',
  change: 'Sent on change',
  heartbeat: 'Heartbeat re-send',
}

const MAX_EVENTS = 8

/** Starts the simulated clock (at 60× or faster, so syncs show within seconds) or pauses it. Public simStore actions. */
function ClockButton() {
  const playing = useSim((s) => s.playing)
  const speed = useSim((s) => s.speed)
  const ready = useSim((s) => s.status === 'ready' && s.view !== null && !s.view.finished)
  const runSpeed = Math.max(speed, 60) as SimSpeed
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={playing ? Pause : Play}
      disabled={!ready}
      className="ms-auto"
      onClick={() => {
        const s = simStore.getState()
        if (s.playing) {
          s.pause()
          return
        }
        if (s.speed < 60) s.setSpeed(runSpeed)
        s.play()
      }}
    >
      {playing ? `Pause clock (${speed}×)` : `Run clock at ${runSpeed}×`}
    </Button>
  )
}

/**
 * Data-flow inspector: the exact payload that leaves the selected worker's phone (privacy.ts inspectSyncPayload via
 * useDataFlowFeed), its byte size and fields, beside everything the phone keeps. Each transmission under the phone's
 * sync rule (state/syncBus.ts: on change, else a heartbeat) highlights the keys that changed.
 */
export function DataFlowInspector({ subjectId, onSubjectChange }: { subjectId: string | null; onSubjectChange: (id: string) => void }) {
  const feed = useDataFlowFeed()
  const item = useMemo(() => feed.find((f) => f.workerId === subjectId) ?? null, [feed, subjectId])
  const inspection = item?.inspection ?? null
  const json = inspection?.json ?? null

  const jumping = useSim((s) => s.jumping)
  const tracker = useRef<SyncTracker>(NO_SYNC)
  const seq = useRef(0)
  const [events, setEvents] = useState<SyncEvent[]>([])

  useEffect(() => {
    // A clock jump skips minutes the inspector never saw: start afresh once it lands.
    if (jumping) {
      tracker.current = NO_SYNC
      return
    }
    if (!inspection) return
    const step = nextSync(tracker.current, inspection.payload)
    if (!step) return
    tracker.current = step.tracker
    seq.current += 1
    const ev: SyncEvent = { id: seq.current, t: inspection.payload.t, reason: step.reason, changed: step.changed, bytes: inspection.bytes }
    setEvents((prev) => (step.reason === 'first' ? [ev] : [ev, ...prev].slice(0, MAX_EVENTS)))
    // Re-run only when the transmitted text changes (every simulated minute at most) or a jump starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, jumping])

  const last = events[0] ?? null
  const flashing = useFlash(last?.id ?? 0)
  const highlight = flashing && last ? new Set<string>(last.changed) : new Set<string>()
  const groups = useMemo(() => groupKeptOnDevice(inspection?.keptOnDevice ?? []), [inspection?.keptOnDevice])

  return (
    <Section
      id="gov-dataflow"
      title="Data-flow inspector"
      description="What actually leaves a worker's phone, byte for byte, next to what never does. The payload is built by the same function the phone uses to sync."
      provenance="simulated"
      provenanceDetail="Live payload from the simulated worker device"
      actions={<SubjectSelect id="gov-dataflow-worker" value={subjectId} onChange={onSubjectChange} />}
    >
      {!inspection ? (
        <Card>
          <EmptyState
            icon={Smartphone}
            title="No payload yet"
            description="The phone has not produced an assessment for this worker yet, or the selected policy does not run the Zill engine."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12">
          <Card as="article" className="min-w-0 lg:col-span-7" aria-labelledby="gov-out-h">
            <CardHeader
              id="gov-out-h"
              icon={Send}
              title="Leaves the phone"
              description="The only record that routinely leaves the device: level and action, nothing clinical."
              actions={
                <>
                  <Badge tone="brand" className="tabular-nums">
                    {inspection.bytes} bytes
                  </Badge>
                  <Badge tone="outline" className="tabular-nums">
                    {Object.keys(inspection.payload).length} keys
                  </Badge>
                </>
              }
            />

            <div
              role="status"
              aria-live="polite"
              className={cx(
                'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm transition-colors duration-700',
                flashing ? 'border-shade-tint bg-shade-bg' : 'border-line bg-canvas',
              )}
            >
              <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                <Radio aria-hidden size={16} className="text-shade" />
                {last ? `${REASON_TEXT[last.reason]} · ${formatLocalHhmm(last.t)}` : 'Waiting for the first sync'}
                {last && last.changed.length > 0 && <span className="font-normal text-muted">· changed: {last.changed.join(', ')}</span>}
              </span>
              <span className="text-xs text-muted">Sync rule: on change, else every {PAYLOAD_HEARTBEAT_MIN} simulated minutes</span>
              <ClockButton />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              Level in this payload <LevelPill level={inspection.payload.level} label={levelName(inspection.payload.level)} size="sm" />
            </div>

            <pre
              aria-label="Outbound payload as JSON"
              className="mt-3 overflow-x-auto rounded-lg bg-ink p-3 font-mono text-[13px] leading-6 text-slate-100"
            >
              <span className="block">{'{'}</span>
              {payloadLines(inspection.payload).map((line) => (
                <span
                  key={line.key}
                  className={cx(
                    '-mx-1 block rounded px-1 whitespace-pre transition-colors duration-1000',
                    highlight.has(line.key) ? 'bg-shade-light/35 text-white' : 'bg-transparent',
                  )}
                >
                  {line.text}
                </span>
              ))}
              <span className="block">{'}'}</span>
            </pre>

            <details className="group mt-2 text-sm">
              <summary className="cursor-pointer rounded text-shade-dark hover:underline">Exact transmitted text ({inspection.bytes} bytes, compact JSON)</summary>
              <code className="mt-2 block rounded-lg border border-line bg-canvas p-2 font-mono text-xs break-all text-ink">{inspection.json}</code>
            </details>

            <h4 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Every key, and why it is there</h4>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {(Object.keys(PAYLOAD_KEY_INFO) as (keyof SyncPayload)[]).map((k) => (
                <div key={k} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[9.5rem_1fr]">
                  <dt className="font-mono text-xs font-semibold text-ink">{k}</dt>
                  <dd className="text-sm text-muted">
                    <span className="font-medium text-ink">{PAYLOAD_KEY_INFO[k].label}.</span> {PAYLOAD_KEY_INFO[k].note}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card as="article" className="min-w-0 lg:col-span-5" aria-labelledby="gov-kept-h">
            <CardHeader
              id="gov-kept-h"
              icon={Lock}
              title="Stays on the phone"
              description="Everything else the phone holds about this worker. None of it is in the payload."
              actions={
                <Badge tone="outline" className="tabular-nums">
                  {inspection.keptOnDevice.length} fields
                </Badge>
              }
            />
            <ul className="space-y-3">
              {groups.map((g) => (
                <li key={g.id} className="rounded-lg border border-line p-3">
                  <p className="text-sm font-semibold text-ink">{g.title}</p>
                  <p className="mt-0.5 text-xs text-muted">{g.why}</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={g.title}>
                    {g.items.map((it) => (
                      <li key={it.key} title={it.key} className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-xs text-ink">
                        <Lock aria-hidden size={11} className="text-subtle" />
                        {it.label}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <h4 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Also only on the phone</h4>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {DEVICE_ONLY_RECORDS.map((r) => (
                <li key={r.label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                  <span className="text-ink">{r.label}</span>
                  <span className="text-xs whitespace-nowrap text-muted">{r.note}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card padding="sm" className="min-w-0 lg:col-span-12">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 pb-2">
              <h3 className="text-sm font-semibold text-ink">Sync log</h3>
              <p className="text-xs text-muted">Start the clock to watch the phone send. Changed keys flash in the payload.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">Payload transmissions from this phone, newest first</caption>
                <thead>
                  <tr className="border-b border-line text-start text-xs text-muted">
                    <th scope="col" className="px-2 py-1.5 text-start font-medium">
                      Time
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-start font-medium">
                      Why
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-start font-medium">
                      Changed keys
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-end font-medium">
                      Size
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id} className="border-b border-line last:border-0">
                      <td className="px-2 py-1.5 font-mono text-xs tabular-nums">{formatLocalHhmm(ev.t)}</td>
                      <td className="px-2 py-1.5">{REASON_TEXT[ev.reason]}</td>
                      <td className="px-2 py-1.5 font-mono text-xs text-muted">{ev.changed.length > 0 ? ev.changed.join(', ') : '—'}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{ev.bytes} B</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Section>
  )
}
