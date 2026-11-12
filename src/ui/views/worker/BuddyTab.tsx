/**
 * Buddy tab of the worker phone: who looks after me, and the partners I look after. A partner card carries only what
 * the buddy projection releases (name, level, actions, acknowledgement: privacy.ts BUDDY_VIEW) — never the partner's
 * numbers, symptoms or reasons. A buddy-check prompt from the partner's device is the prominent item, with one button
 * into the buddy version of the check-in. Basis: ARCHITECTURE §2 (Buddy row), §5 (buddy mandatory in conservative mode).
 */
import { BellRing, HeartHandshake, ShieldCheck, UserRound } from 'lucide-react'
import type { RiskLevel } from '../../../engine/types'
import { levelName, t } from '../../../i18n'
import type { BuddyCard } from '../../../state'
import { LevelPill, cx } from '../../components'
import { wt } from './messages'
import { initials } from './model'
import { TILE, bigButton, usePhone } from './ui'

export interface BuddyPartner {
  card: BuddyCard
  name: string
}

export interface BuddyTabProps {
  /** Name of the worker who looks after this phone's owner (roster pairing), if any. */
  myBuddyName: string | null
  partners: readonly BuddyPartner[]
  onCheck: (workerId: string) => void
}

export function BuddyTab({ myBuddyName, partners, onCheck }: BuddyTabProps) {
  const { lang } = usePhone()
  return (
    <div className="space-y-3 px-4 pt-1 pb-6">
      <section aria-labelledby="buddy-mine" className={cx(TILE, 'flex items-center gap-3')}>
        <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-shade-bg text-shade">
          <ShieldCheck size={24} />
        </span>
        <div className="min-w-0">
          <h3 id="buddy-mine" className="text-sm font-semibold text-muted">
            {t(lang, 'ui.buddy')}
          </h3>
          <p className="text-lg font-bold text-ink">{myBuddyName ? wt(lang, 'your_buddy', { name: myBuddyName }) : '—'}</p>
        </div>
      </section>

      <h3 className="px-1 pt-2 text-sm font-semibold tracking-wide text-muted uppercase">{wt(lang, 'you_look_after')}</h3>
      {partners.length === 0 ? (
        <p className={cx(TILE, 'text-base text-ink')}>{wt(lang, 'no_partner')}</p>
      ) : (
        <ul className="grid gap-3">
          {partners.map(({ card, name }) => {
            const level = card.data.level as RiskLevel | undefined
            const prompt = card.buddyCheck
            return (
              <li key={card.workerId} className={cx(TILE, prompt && 'ring-2 ring-high-fill')}>
                <div className="flex items-center gap-3">
                  <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-ink text-base font-bold text-white">
                    {initials(name) || <UserRound size={22} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-bold text-ink">
                      <bdi>{name}</bdi>
                    </p>
                    {level && <LevelPill level={level} label={levelName(lang, level)} size="sm" className="mt-1" />}
                  </div>
                </div>
                {prompt && (
                  <p role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-high-bg px-3 py-2.5 text-base leading-snug font-semibold text-high">
                    <BellRing size={20} aria-hidden className="mt-0.5 shrink-0" />
                    {t(lang, 'ui.buddy_alert', { name })}
                  </p>
                )}
                <button type="button" onClick={() => onCheck(card.workerId)} className={bigButton(prompt ? 'primary' : 'secondary', 'mt-3')}>
                  <HeartHandshake size={24} aria-hidden className="shrink-0" />
                  {wt(lang, 'check_name', { name })}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
