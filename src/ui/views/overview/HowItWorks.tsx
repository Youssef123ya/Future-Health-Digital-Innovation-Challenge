/**
 * "How Zill works": weather → heat indices → personal limits → projection → physiology → symptoms → one level and one
 * action, with the on-device privacy boundary and who sees what (ARCHITECTURE.md §1, §2, §5, §7). One data table, drawn
 * as an SVG pipeline from lg and as a vertical HTML flow below it (readable text at phone width). The SVG carries a
 * title and description; the "who sees what" table below is its text equivalent.
 */
import {
  Activity,
  Ban,
  CloudSun,
  Gauge,
  HardHat,
  Landmark,
  MessageSquareWarning,
  ShieldCheck,
  Smartphone,
  Stethoscope,
  Timer,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { LEVEL_STYLES, cx } from '../../components'
import type { RiskLevel } from '../../../engine/types'

interface Step {
  id: string
  icon: LucideIcon
  title: string
  lines: [string, string]
  basis: string
  onDevice: boolean
}

const STEPS: readonly Step[] = [
  { id: 'weather', icon: CloudSun, title: 'Weather', lines: ['Live forecast, site', 'WBGT meter if present'], basis: 'Open-Meteo ECMWF IFS', onDevice: false },
  { id: 'indices', icon: Gauge, title: 'Heat indices', lines: ['WBGT in sun and shade,', 'Thermal Work Limit'], basis: 'ISO 7243 · Liljegren · TWL', onDevice: false },
  { id: 'limits', icon: UserRound, title: 'Personal limits', lines: ['Workload, clothing,', 'acclimatisation'], basis: 'NIOSH REL/RAL · ACGIH', onDevice: true },
  { id: 'projection', icon: Timer, title: 'Projection', lines: ['Minutes to the limit,', 'water loss'], basis: 'ISO 7933 PHS', onDevice: true },
  { id: 'physiology', icon: Activity, title: 'Physiology', lines: ['Heart rate → estimated', 'strain indicator'], basis: 'Optional · consented', onDevice: true },
  { id: 'symptoms', icon: MessageSquareWarning, title: 'Symptoms', lines: ['Check-ins and buddy', 'reports override all'], basis: 'ACSM 2023 red flags', onDevice: true },
  { id: 'level', icon: ShieldCheck, title: 'One level + action', lines: ['In the worker’s language,', 'colour, pictogram, voice'], basis: 'Can only raise, never lower', onDevice: true },
]

interface Audience {
  id: string
  icon: LucideIcon
  who: string
  sees: string
  never: string
  flow: string
  refused?: boolean
}

const AUDIENCES: readonly Audience[] = [
  { id: 'worker', icon: Smartphone, who: 'Worker', sees: 'Own level, actions, countdown and data; who accessed it', never: 'Other workers’ data', flow: 'own phone' },
  { id: 'supervisor', icon: HardHat, who: 'Crew supervisor', sees: 'Name, level, action, acknowledgement; the crew plan', never: 'Heart rate, strain, symptoms, health flags, reasons', flow: 'level + action' },
  { id: 'medic', icon: Stethoscope, who: 'First aider · occupational health', sees: 'Active cases; clinical detail only after escalation with consent', never: 'Non-escalated workers', flow: 'case, with consent' },
  { id: 'regulator', icon: Landmark, who: 'HSE manager · regulator', sees: 'Site aggregates and hours in each heat zone; small groups suppressed', never: 'Any individual record', flow: 'counts, k-suppressed' },
  { id: 'hr', icon: Ban, who: 'Employer HR', sees: 'Nothing individual: requests are refused and logged', never: 'Everything individual', flow: 'refused, logged', refused: true },
]

const LEVELS: readonly RiskLevel[] = ['safe', 'caution', 'high', 'stop', 'emergency']

/** Short level names for the diagram's level scale (the app's full labels are DEFAULT_LEVEL_LABELS). */
const LEVEL_SHORT: Readonly<Record<RiskLevel, string>> = { safe: 'Safe', caution: 'Caution', high: 'High', stop: 'Stop', emergency: 'Emergency' }

// ─────────────────────────────── SVG (lg and up) ───────────────────────────────

const W = 1200
const NODE_W = 142
const NODE_H = 104
const GAP = 26
const X0 = (W - (STEPS.length * NODE_W + (STEPS.length - 1) * GAP)) / 2
const NODE_Y = 64
const AUD_Y = 318
const AUD_W = 212
const AUD_GAP = (W - 2 * 24 - AUD_W * AUDIENCES.length) / (AUDIENCES.length - 1)

const nodeX = (i: number) => X0 + i * (NODE_W + GAP)
const audX = (i: number) => 24 + i * (AUD_W + AUD_GAP)

function PipelineSvg() {
  const boundaryX = nodeX(2) - 12
  const boundaryW = nodeX(STEPS.length - 1) + NODE_W + 12 - boundaryX
  const levelCx = nodeX(STEPS.length - 1) + NODE_W / 2
  const fanY = 252
  return (
    <svg viewBox={`0 0 ${W} 452`} role="img" aria-labelledby="hiw-svg-title hiw-svg-desc" className="hidden h-auto w-full lg:block">
      <title id="hiw-svg-title">How Zill works</title>
      <desc id="hiw-svg-desc">
        Weather and heat indices are site-level. Personal limits, the ISO 7933 projection, optional physiology and symptom
        reports are combined on the worker’s own phone into one level and one action. Only level and action reach the
        supervisor; clinical detail reaches occupational health only after escalation with consent; HSE and regulators
        receive suppressed aggregates; employer HR requests are refused and logged.
      </desc>
      <defs>
        <marker id="hiw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-subtle" />
        </marker>
        <marker id="hiw-arrow-ban" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-stop" />
        </marker>
      </defs>

      {/* Zones */}
      <rect x={nodeX(0) - 12} y={30} width={nodeX(1) + NODE_W + 12 - (nodeX(0) - 12)} height={NODE_H + 54} rx={16} className="fill-canvas stroke-line" />
      <text x={nodeX(0) - 2} y={50} className="fill-muted text-[12px] font-semibold uppercase tracking-wider">
        Site level · shared
      </text>
      <rect x={boundaryX} y={30} width={boundaryW} height={NODE_H + 54} rx={16} strokeDasharray="7 5" strokeWidth={2} className="fill-shade-bg stroke-shade" />
      <text x={boundaryX + 12} y={50} className="fill-shade-dark text-[12px] font-semibold uppercase tracking-wider">
        On the worker’s phone · personal data stays here
      </text>

      {/* Steps and arrows */}
      {STEPS.map((s, i) => {
        const x = nodeX(i)
        const Icon = s.icon
        return (
          <g key={s.id}>
            {i > 0 && (
              <line x1={x - GAP + 3} y1={NODE_Y + NODE_H / 2} x2={x - 3} y2={NODE_Y + NODE_H / 2} strokeWidth={2} markerEnd="url(#hiw-arrow)" className="stroke-subtle" />
            )}
            <rect x={x} y={NODE_Y} width={NODE_W} height={NODE_H} rx={12} strokeWidth={s.id === 'level' ? 2 : 1} className={cx('fill-surface', s.id === 'level' ? 'stroke-shade' : 'stroke-line-strong')} />
            <Icon x={x + 12} y={NODE_Y + 12} width={18} height={18} className="text-shade" aria-hidden />
            <text x={x + 36} y={NODE_Y + 26} className="fill-ink text-[13px] font-semibold">
              {s.title}
            </text>
            <text x={x + 12} y={NODE_Y + 50} className="fill-muted text-[11.5px]">
              <tspan x={x + 12}>{s.lines[0]}</tspan>
              <tspan x={x + 12} dy={15}>
                {s.lines[1]}
              </tspan>
            </text>
            <text x={x + 12} y={NODE_Y + NODE_H - 10} className="fill-subtle text-[10.5px] font-medium">
              {s.basis}
            </text>
          </g>
        )
      })}

      {/* Level scale under the last step */}
      <g>
        {LEVELS.map((lv, i) => {
          const LevelIcon = LEVEL_STYLES[lv].icon
          return (
            <g key={lv} transform={`translate(${nodeX(STEPS.length - 2) - 14 + i * 66}, ${NODE_Y + NODE_H + 12})`}>
              <LevelIcon x={0} y={0} width={13} height={13} className={LEVEL_STYLES[lv].mark} aria-hidden />
              <text x={16} y={10.5} className="fill-muted text-[10.5px] font-medium">
                {LEVEL_SHORT[lv]}
              </text>
            </g>
          )
        })}
      </g>

      {/* Who sees what */}
      <line x1={levelCx} y1={NODE_Y + NODE_H + 30} x2={levelCx} y2={fanY} strokeWidth={2} className="stroke-subtle" />
      <line x1={audX(0) + AUD_W / 2} y1={fanY} x2={audX(AUDIENCES.length - 1) + AUD_W / 2} y2={fanY} strokeWidth={2} className="stroke-line-strong" />
      <text x={24} y={fanY - 10} className="fill-muted text-[12px] font-semibold uppercase tracking-wider">
        Who sees what
      </text>
      {AUDIENCES.map((a, i) => {
        const x = audX(i)
        const cx0 = x + AUD_W / 2
        const Icon = a.icon
        return (
          <g key={a.id}>
            <line
              x1={cx0}
              y1={fanY}
              x2={cx0}
              y2={AUD_Y - 4}
              strokeWidth={2}
              strokeDasharray={a.refused ? '4 4' : undefined}
              markerEnd={a.refused ? 'url(#hiw-arrow-ban)' : 'url(#hiw-arrow)'}
              className={a.refused ? 'stroke-stop' : 'stroke-subtle'}
            />
            <rect x={cx0 - 64} y={fanY + 12} width={128} height={22} rx={11} className={a.refused ? 'fill-stop-bg' : 'fill-surface'} />
            <text x={cx0} y={fanY + 27} textAnchor="middle" className={cx('text-[11px] font-semibold', a.refused ? 'fill-stop' : 'fill-ink')}>
              {a.flow}
            </text>
            <rect x={x} y={AUD_Y} width={AUD_W} height={110} rx={12} className={cx('stroke-line-strong', a.refused ? 'fill-stop-bg' : 'fill-surface')} />
            <Icon x={x + 12} y={AUD_Y + 12} width={18} height={18} className={a.refused ? 'text-stop' : 'text-shade'} aria-hidden />
            <text x={x + 38} y={AUD_Y + 26} className="fill-ink text-[13px] font-semibold">
              {a.who}
            </text>
            <foreignObject x={x + 12} y={AUD_Y + 38} width={AUD_W - 24} height={68}>
              <p className="text-[11.5px] leading-snug text-muted">{a.sees}</p>
            </foreignObject>
          </g>
        )
      })}
    </svg>
  )
}

// ─────────────────────────────── HTML flow (below lg) ───────────────────────────────

function StepCard({ s }: { s: Step }) {
  const Icon = s.icon
  return (
    <li className="relative flex gap-3 rounded-xl border border-line-strong bg-surface p-3">
      <Icon aria-hidden size={18} className="mt-0.5 shrink-0 text-shade" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{s.title}</p>
        <p className="text-xs text-muted">{s.lines.join(' ')}</p>
        <p className="mt-0.5 text-[11px] font-medium text-subtle">{s.basis}</p>
        {s.id === 'level' && (
          <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1">
            {LEVELS.map((lv) => {
              const LevelIcon = LEVEL_STYLES[lv].icon
              return (
                <span key={lv} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
                  <LevelIcon aria-hidden size={12} className={LEVEL_STYLES[lv].mark} />
                  {LEVEL_SHORT[lv]}
                </span>
              )
            })}
          </p>
        )}
      </div>
    </li>
  )
}

function PipelineFlow() {
  const site = STEPS.filter((s) => !s.onDevice)
  const device = STEPS.filter((s) => s.onDevice)
  return (
    <div className="lg:hidden">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Site level · shared</p>
      <ol className="grid gap-2 sm:grid-cols-2">
        {site.map((s) => (
          <StepCard key={s.id} s={s} />
        ))}
      </ol>
      <div className="mx-auto h-5 w-0.5 bg-line-strong" />
      <div className="rounded-2xl border-2 border-dashed border-shade bg-shade-bg p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-shade-dark">On the worker’s phone · personal data stays here</p>
        <ol className="grid gap-2 sm:grid-cols-2">
          {device.map((s) => (
            <StepCard key={s.id} s={s} />
          ))}
        </ol>
      </div>
    </div>
  )
}

// ─────────────────────────────── Who sees what (text equivalent) ───────────────────────────────

function WhoSeesWhat() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-start text-sm">
        <caption className="mb-2 text-start text-xs text-muted">
          Who sees what (ARCHITECTURE.md §2). Enforced in code by the privacy projection and logged in the audit chain.
        </caption>
        <thead>
          <tr className="border-b border-line text-xs font-semibold uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pe-4 text-start">Role</th>
            <th scope="col" className="py-2 pe-4 text-start">Receives</th>
            <th scope="col" className="py-2 pe-4 text-start">Sees</th>
            <th scope="col" className="py-2 text-start">Never sees</th>
          </tr>
        </thead>
        <tbody>
          {AUDIENCES.map((a) => {
            const Icon = a.icon
            return (
              <tr key={a.id} className="border-b border-line align-top last:border-0">
                <th scope="row" className="py-2.5 pe-4 text-start font-semibold text-ink">
                  <span className="inline-flex items-center gap-2">
                    <Icon aria-hidden size={16} className={a.refused ? 'text-stop' : 'text-shade'} />
                    {a.who}
                  </span>
                </th>
                <td className={cx('py-2.5 pe-4 text-xs font-semibold', a.refused ? 'text-stop' : 'text-ink')}>{a.flow}</td>
                <td className="py-2.5 pe-4 text-muted">{a.sees}</td>
                <td className="py-2.5 text-muted">{a.never}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function HowItWorks() {
  return (
    <div className="flex flex-col gap-5">
      <PipelineSvg />
      <PipelineFlow />
      <WhoSeesWhat />
    </div>
  )
}
