/**
 * Data hook of the supervisor console. Individual data comes only from useSupervisorBoard (privacy.project with role
 * 'supervisor', audit logged). Everything else read here is non-personal: the roster's crew and buddy links
 * (organisational), the alert workflow metadata reduced to acknowledgement roles/times and the escalation time
 * (model.workflowIndex / ackMinutesById), the day plan's notes and warnings for the actor's crews, and site data.
 */
import { useMemo, useRef } from 'react'
import { DEFAULT_ALERT_POLICY } from '../../../engine/alerts'
import type { Alert, RiskLevel } from '../../../engine/types'
import { simStore } from '../../../state'
import { useSim, useSupervisorBoard, useUi } from '../../../state/hooks'
import { supervisorActors, type AlertItem, type SupervisorActor, type SupervisorBoard } from '../../../state/selectors'
import {
  ackMinutesById,
  groupAlerts,
  levelTotals,
  median,
  waterTotals,
  workflowIndex,
  type AlertGroups,
  type AlertWorkflow,
  type ReassignOption,
} from './model'

/** Acknowledgement timers of the engine's default alert policy (engine/alerts.ts; ARCHITECTURE §6). */
export const ACK_POLICY = {
  stopMin: DEFAULT_ALERT_POLICY.stopAckTimeoutMin,
  emergencyMin: DEFAULT_ALERT_POLICY.emergencyAckTimeoutMin,
  highMin: DEFAULT_ALERT_POLICY.highAckTimeoutMin,
} as const

export interface ConsoleData {
  board: SupervisorBoard
  now: number
  actorId: string
  /** Worker id → display name, and crew id → crew name. */
  names: ReadonlyMap<string, string>
  groups: AlertGroups
  /** Acknowledgement roles/times and escalation time of the shown and suppressed alerts. */
  wf: ReadonlyMap<string, AlertWorkflow>
  /** Shown (not suppressed) alerts by id. */
  shown: ReadonlyMap<string, AlertItem>
  /** Worker id → the open crew-condition alert whose members include the worker. */
  crewAlertOf: ReadonlyMap<string, AlertItem>
  /** Worker id → buddy display name (roster link). */
  buddyOf: ReadonlyMap<string, string>
  /** Median minutes to the supervisor's acknowledgement since this console opened (High risk or above). */
  tta: { median: number | null; n: number }
  totals: Record<RiskLevel, number>
  water: { litres: number; coolers: number; planned: number }
  /** Query that reopens this scenario at the current time in another tab ("Open phone"). */
  scenarioQuery: Readonly<Record<string, string>>
}

export interface ConsoleState {
  data: ConsoleData | null
  actors: SupervisorActor[]
  actorId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

const hhmmLocal = (t: number): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(t)

export function useConsoleData(): ConsoleState {
  const actorId = useUi((s) => s.supervisorActorId) ?? ''
  const board = useSupervisorBoard(actorId)
  const roster = useSim((s) => s.roster)
  const crews = useSim((s) => s.crews)
  const alertsRaw = useSim((s) => s.view?.alerts)
  const status = useSim((s) => s.status)
  const error = useSim((s) => s.error)
  const scenarioId = useSim((s) => s.scenarioId)
  const config = useSim((s) => s.view?.config)

  const actors = useMemo(() => supervisorActors({ crews, roster }), [crews, roster])

  // Names and buddy links (organisational roster data; released display names first).
  const { names, buddyOf } = useMemo(() => {
    const n = new Map<string, string>()
    if (board) {
      for (const c of board.crews) {
        n.set(c.crew.id, c.crew.name)
        for (const r of c.rows) n.set(r.workerId, r.data.displayName ?? roster[r.workerId]?.displayName ?? r.workerId)
      }
    }
    const b = new Map<string, string>()
    if (board) {
      for (const c of board.crews) {
        for (const r of c.rows) {
          const buddy = roster[r.workerId]?.buddyId
          if (buddy) b.set(r.workerId, n.get(buddy) ?? roster[buddy]?.displayName ?? buddy)
        }
      }
    }
    return { names: n, buddyOf: b }
  }, [board, roster])

  const crewIds = useMemo(() => (board ? board.crews.map((c) => c.crew.id) : []), [board])
  const crewKey = crewIds.join('|')

  const derived = useMemo(() => {
    if (!board) return null
    const groups = groupAlerts(board.alerts)
    const shown = new Map(board.alerts.map((a) => [a.id, a] as const))
    const ids = new Set<string>([...board.alerts.map((a) => a.id), ...board.suppressedAlerts.map((a) => a.id)])
    const wf = workflowIndex(alertsRaw, ids)
    const crewAlertOf = new Map<string, AlertItem>()
    for (const c of groups.crew) for (const id of c.alert.memberIds ?? []) if (!crewAlertOf.has(id)) crewAlertOf.set(id, c.alert)
    return {
      groups,
      shown,
      wf,
      crewAlertOf,
      totals: levelTotals(board.crews),
      water: waterTotals(board.crews.map((c) => c.plan)),
    }
  }, [board, alertsRaw])

  // Median time to acknowledge: accumulated over the session (closed alerts leave the view after an hour).
  const worldKey = `${scenarioId ?? ''}|${config?.seed ?? ''}|${config?.policy ?? ''}|${config?.date ?? ''}|${actorId}|${crewKey}`
  const acc = useRef<{ key: string; lastT: number; byId: Map<string, number> }>({ key: '', lastT: -Infinity, byId: new Map() })
  const now = board?.t ?? 0
  const tta = useMemo(() => {
    const a = acc.current
    if (a.key !== worldKey || now < a.lastT) {
      a.key = worldKey
      a.byId = new Map()
    }
    a.lastT = now
    const crewOfWorker = (id: string | undefined): string | undefined => (id !== undefined ? roster[id]?.crewId : undefined)
    const inScope = (al: Pick<Alert, 'scope' | 'crewId' | 'workerId'>): boolean =>
      al.scope === 'site' ? crewIds.length > 0 : crewIds.includes(al.crewId ?? crewOfWorker(al.workerId) ?? '')
    for (const [id, m] of ackMinutesById(alertsRaw, inScope)) a.byId.set(id, m)
    const vals = [...a.byId.values()]
    return { median: median(vals), n: vals.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertsRaw, worldKey, now, roster])

  const scenarioQuery = useMemo(() => {
    const q: Record<string, string> = {}
    if (scenarioId) q.scenario = scenarioId
    if (config?.policy) q.policy = config.policy
    if (now > 0) q.t = hhmmLocal(Math.floor(now / 60_000) * 60_000)
    return q
    // Re-read once per simulated minute only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, config?.policy, Math.floor(now / 60_000)])

  const data: ConsoleData | null =
    board && derived
      ? { board, now: board.t, actorId, names, buddyOf, tta, scenarioQuery, ...derived }
      : null
  return { data, actors, actorId, status, error }
}

// ─────────────────────────────── Actions (state injection API) ───────────────────────────────

/** Acknowledges an alert as this supervisor (synced to other tabs by the bus). */
export function acknowledgeAlert(alertId: string, actorId: string): void {
  simStore.getState().inject({ kind: 'ack', alertId, role: 'supervisor', ...(actorId ? { actorId } : {}) })
}

/** Resolves a worker's case after an in-person, symptom-free re-check (the engine refuses what a supervisor may not resolve). */
export function resolveCase(workerId: string, alertId: string): void {
  simStore.getState().inject({ kind: 'resolve', workerId, alertId, by: 'supervisor' })
}

/** Assigns a worker to another crew task or to the rest area; the device re-assesses at once. */
export function assignTask(workerId: string, option: Pick<ReassignOption, 'taskId' | 'location'>): void {
  simStore.getState().inject({ kind: 'task', workerId, taskId: option.taskId, location: option.location })
}
