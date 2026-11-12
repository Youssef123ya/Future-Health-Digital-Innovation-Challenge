/**
 * Small shared controls of the supervisor console: site status badges, acknowledgement / resolve / reassign controls and
 * the "Open phone" link. Every action goes through the state injection API (useConsole.ts).
 */
import { useRef, useState } from 'react'
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleAlert,
  ExternalLink,
  Lock,
  Snowflake,
  Sun,
  Umbrella,
  type LucideIcon,
} from 'lucide-react'
import type { RiskLevel } from '../../../engine/types'
import { RISK_ORDER } from '../../../engine/types'
import { Button, InfoTip, buttonClasses, cx } from '../../components'
import { pathFor, toHref } from '../../router'
import type { BadgeState, ReassignOption, StatusBadge } from './model'
import { hhmm } from './model'

// ─────────────────────────────── Site status badge ───────────────────────────────

const BADGE_STATE: Readonly<Record<BadgeState, { cls: string; icon: LucideIcon; sr: string }>> = {
  ok: { cls: 'border-safe-fill/40 bg-safe-bg text-safe', icon: CircleCheck, sr: 'OK' },
  warn: { cls: 'border-caution-fill/50 bg-caution-bg text-caution', icon: CircleAlert, sr: 'Warning' },
  bad: { cls: 'border-stop-fill/40 bg-stop-bg text-stop', icon: CircleAlert, sr: 'Problem' },
  off: { cls: 'border-line-strong bg-surface text-muted', icon: CircleDashed, sr: 'Not available' },
}

/** A site-level status badge: icon + text + colour, with the detail in a tooltip and for screen readers. */
export function SiteBadge({ badge, icon: Icon }: { badge: StatusBadge; icon: LucideIcon }) {
  const s = BADGE_STATE[badge.state]
  const StateIcon = s.icon
  return (
    <li className={cx('inline-flex items-center gap-1.5 rounded-full border py-1 ps-2 pe-1 text-xs font-medium', s.cls)}>
      <Icon aria-hidden size={14} />
      <span>
        <span className="sr-only">{s.sr}: </span>
        {badge.label}
      </span>
      <StateIcon aria-hidden size={13} className="opacity-80" />
      <InfoTip content={badge.detail} label={`About: ${badge.label}`} />
    </li>
  )
}

/** "Personal details stay on the worker's phone" affordance. */
export function PrivacyNote({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs text-muted', className)}>
      <Lock aria-hidden size={14} className="text-shade" />
      Personal details stay on the worker’s phone
      <InfoTip
        label="What this console receives"
        content={
          <span className="block max-w-xs">
            This console receives each worker’s name, risk level, the actions to take, the work/rest rate and the
            acknowledgement status. Heart rate, strain estimates, symptoms, health flags, hydration and consent choices never
            leave the phone, and every view is written to the audit log.
          </span>
        }
      />
    </span>
  )
}

// ─────────────────────────────── Acknowledge / resolve ───────────────────────────────

export function AckButton({ level, onAck, label = 'Acknowledge', who }: { level: RiskLevel; onAck: () => void; label?: string; who?: string }) {
  const variant = level === 'emergency' ? 'emergency' : RISK_ORDER[level] >= RISK_ORDER.stop ? 'danger' : 'primary'
  return (
    <Button size="sm" variant={variant} icon={Check} onClick={onAck} aria-label={who ? `${label}: ${who}` : undefined}>
      {label}
    </Button>
  )
}

/** Resolve with an explicit confirmation (an in-person, symptom-free re-check first; the device keeps every hold). */
export function ResolveControl({ who, onResolve }: { who: string; onResolve: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" icon={CircleCheck} onClick={() => setConfirming(true)} aria-label={`Resolve case: ${who}`}>
        Resolve…
      </Button>
    )
  }
  return (
    <div role="group" aria-label={`Resolve case: ${who}`} className="w-full rounded-lg border border-line bg-canvas p-3 text-sm text-ink">
      <p>Resolve only after an in-person check finds no symptoms. The worker’s device still decides when heat work can resume.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          autoFocus
          onClick={() => {
            onResolve()
            setConfirming(false)
          }}
        >
          Confirm resolve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────────── Reassign ───────────────────────────────

function optionIcon(o: ReassignOption): LucideIcon {
  if (o.taskId === null) return o.location === 'indoor_cool' ? Snowflake : Umbrella
  return o.location === 'sun' ? Sun : Umbrella
}

/**
 * Reassign a worker to another crew task or to the rest area (injects a { kind:'task' } change). A disclosure, so it
 * works with keyboard and screen readers without a popup layer, and never clips inside a card.
 */
export function ReassignControl({
  who,
  options,
  plannedTaskId,
  onAssign,
}: {
  who: string
  options: readonly ReassignOption[]
  plannedTaskId: string | null
  onAssign: (o: ReassignOption) => void
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  return (
    <details ref={ref} className="group w-full">
      <summary
        className={cx(
          buttonClasses({ variant: 'secondary', size: 'sm' }),
          'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
        )}
        aria-label={`Reassign ${who}`}
      >
        <ArrowRightLeft aria-hidden size={16} />
        Reassign
        <ChevronDown aria-hidden size={14} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-canvas p-2">
        <p className="px-1 pb-1.5 text-xs text-muted">Cooler options first. The device checks the new task at once.</p>
        <ul className="flex flex-col gap-0.5">
          {options.map((o) => {
            const Icon = optionIcon(o)
            return (
              <li key={o.key}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-surface focus-visible:bg-surface"
                  onClick={() => {
                    onAssign(o)
                    if (ref.current) ref.current.open = false
                  }}
                >
                  <Icon aria-hidden size={16} className={cx('mt-0.5 shrink-0', o.cooler ? 'text-shade' : 'text-muted')} />
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{o.label}</span>
                    {o.taskId !== null && o.taskId === plannedTaskId && (
                      <span className="ms-1.5 rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-700">planned now</span>
                    )}
                    <span className="block text-xs text-muted">{o.detail}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}

/** Confirmation of a reassignment made from this console. */
export function AssignedNote({ assigned }: { assigned: { label: string; t: number } }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-shade-bg px-2 py-1 text-xs text-shade-dark">
      <ArrowRightLeft aria-hidden size={13} className="mt-0.5 shrink-0" />
      <span>
        Assigned by you at {hhmm(assigned.t)}: {assigned.label}
      </span>
    </p>
  )
}

// ─────────────────────────────── Links ───────────────────────────────

/** Opens the worker's phone view in a new tab (the sync bus keeps both tabs on the same clock and alerts). */
export function OpenPhoneLink({
  workerId,
  who,
  query,
  className,
}: {
  workerId: string
  who: string
  query: Readonly<Record<string, string>>
  className?: string
}) {
  return (
    <a
      href={toHref(pathFor('worker', { id: workerId }, query))}
      target="_blank"
      rel="noopener"
      className={cx('inline-flex items-center gap-1 rounded font-medium text-shade hover:text-shade-dark hover:underline', className)}
    >
      Open phone
      <ExternalLink aria-hidden size={13} />
      <span className="sr-only">
        {' '}
        of {who} (opens in a new tab)
      </span>
    </a>
  )
}
