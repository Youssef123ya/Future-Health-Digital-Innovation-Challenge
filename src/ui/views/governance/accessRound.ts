/**
 * One round of console accesses: the audit drafts the role consoles write when they are opened (supervisor boards,
 * the worker's own phone, a buddy card, first aider, occupational health, HSE and regulator aggregates). Each draft
 * comes from the real selector, i.e. a real projection through privacy.project / aggregateFor; nothing is invented.
 * The governance centre uses it to show a populated chain when no console has been opened in this tab yet.
 * Basis: ARCHITECTURE §7 (every projection is logged); state/hooks.ts (the hooks log the same drafts).
 */
import type { AuditDraft } from '../../../engine/privacy'
import {
  DEFAULT_ACTOR_IDS,
  selectBuddyCards,
  selectFirstAiderCases,
  selectHseAggregates,
  selectOccHealthCases,
  selectRegulatorAggregates,
  selectSupervisorBoard,
  selectWorkerDevice,
  supervisorActors,
  type SelectorInput,
} from '../../../state'

/** Audit drafts of one simulated opening of every console. Pure (selectors only). */
export function consoleAccessRound(input: SelectorInput, deviceWorkerId: string | null): AuditDraft[] {
  const drafts: AuditDraft[] = []
  for (const actor of supervisorActors(input)) drafts.push(...selectSupervisorBoard(input, actor.actorId).audit)
  if (deviceWorkerId) {
    drafts.push(...selectWorkerDevice(input, deviceWorkerId).audit)
    drafts.push(...selectBuddyCards(input, deviceWorkerId).audit)
  }
  drafts.push(...selectFirstAiderCases(input, DEFAULT_ACTOR_IDS.first_aider).audit)
  drafts.push(...selectOccHealthCases(input, DEFAULT_ACTOR_IDS.occ_health).audit)
  drafts.push(...selectHseAggregates(input, DEFAULT_ACTOR_IDS.hse_manager).audit)
  drafts.push(...selectRegulatorAggregates(input, DEFAULT_ACTOR_IDS.regulator).audit)
  return drafts
}
