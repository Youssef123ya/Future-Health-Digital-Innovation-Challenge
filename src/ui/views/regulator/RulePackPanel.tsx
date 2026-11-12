/**
 * Rule pack panel: the jurisdiction pack in force on the site (Abu Dhabi: ADOSH-SF Safety in the Heat v4.0 + the UAE
 * midday break) with its TWL zone table and duties, the other bundled packs (Sharjah, Qatar) for comparison, and the
 * CSV export of the console's k-suppressed aggregate tables. Static reference data from engine/regulation.ts RULE_PACKS
 * (no individual data); the export writes suppressed cells as "fewer than k", never a number.
 */
import { useState, type ReactNode } from 'react'
import { Download, FileSpreadsheet, Gavel, Lock, ScrollText } from 'lucide-react'
import { RULE_PACKS, type RulePack, type RulePackId, type TwlZone } from '../../../engine/regulation'
import { formatLocalHhmm } from '../../../engine/time'
import { getScenario } from '../../../sim/scenarios'
import { useSim } from '../../../state/hooks'
import { Badge, Button, Card, CardHeader, LevelPill, Section } from '../../components'
import type { OpsModel, OpsScope } from './opsModel'
import { aggregatesCsv, downloadText, type CsvTable } from './format'
import { Segmented, type ReleasedTable } from './ui'

/** One table of the CSV export. */
export interface ExportTable {
  title: string
  rowHeader: string
  rowLabel: (key: string) => string
  colLabel: (key: string) => string
  released: ReleasedTable
}

const PACK_ORDER: readonly RulePackId[] = ['abu-dhabi', 'sharjah', 'qatar']
const PACK_SHORT: Readonly<Record<RulePackId, string>> = { 'abu-dhabi': 'Abu Dhabi', sharjah: 'Sharjah', qatar: 'Qatar' }
const ROLE_LABEL: Readonly<Record<OpsScope['role'], string>> = { regulator: 'Regulator', hse_manager: 'HSE manager' }

const twlRange = (z: TwlZone): string => (z.minWm2 == null ? `TWL < ${z.maxWm2} W/m²` : z.maxWm2 == null ? `TWL ≥ ${z.minWm2} W/m²` : `TWL ${z.minWm2}–${z.maxWm2} W/m²`)
const water = (z: TwlZone): string => (z.waterLph.light.text === z.waterLph.heavy.text ? z.waterLph.light.text : `light ${z.waterLph.light.text}; heavy ${z.waterLph.heavy.text}`)

export function RulePackPanel({ scope, ops, tables }: { scope: OpsScope; ops: OpsModel; tables: readonly ExportTable[] }) {
  const [packId, setPackId] = useState<RulePackId>(ops.packId)
  const pack = RULE_PACKS[packId]
  const active = packId === ops.packId
  return (
    <Section
      title="Rule pack and reporting"
      description="The jurisdiction rules the engine enforces as a floor on this site, and an export of the aggregate tables above."
    >
      <div className="grid gap-4 xl:grid-cols-3">
        <Card as="section" aria-label="Jurisdiction rule pack" className="xl:col-span-2">
          <CardHeader
            icon={Gavel}
            title={pack.name}
            description={`${pack.authority}. ${pack.instrument}, version ${pack.version} (${pack.date}).`}
            actions={active ? <Badge tone="brand">Active on this site</Badge> : <Badge tone="outline">Bundled, not active here</Badge>}
          />
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Segmented<RulePackId>
              size="sm"
              label="Rule pack"
              value={packId}
              onChange={setPackId}
              options={PACK_ORDER.map((id) => ({ id, label: id === ops.packId ? `${PACK_SHORT[id]} (active)` : PACK_SHORT[id] }))}
            />
            <span className="text-xs text-muted">Packs are versioned and jurisdiction-selectable; the stricter rule wins where two regulators overlap.</span>
          </div>
          <PackZones pack={pack} />
          <PackDuties pack={pack} />
        </Card>

        <ExportCard scope={scope} ops={ops} tables={tables} />
      </div>
    </Section>
  )
}

function PackZones({ pack }: { pack: RulePack }) {
  if (pack.twlZones.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
        <p className="font-semibold text-ink">No TWL zones: a WBGT stop limit instead</p>
        <p className="mt-1 text-muted">
          {pack.wbgtStopC !== undefined ? `Stop all work when WBGT rises above ${pack.wbgtStopC} °C, indoors or outdoors, at any time of day. ` : ''}
          {pack.wbgtStopBasis ?? ''}
        </p>
      </div>
    )
  }
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-ink">Heat-stress zones (sun TWL)</h4>
      <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {pack.twlZones.map((z) => (
          <li key={z.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-ink">{z.label.split(' — ')[0]}</p>
                <p className="text-xs text-muted tabular-nums">{twlRange(z)}</p>
              </div>
              <LevelPill level={z.level} size="sm" />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
              <dt className="text-muted">Light work</dt>
              <dd className="text-ink">{z.workRest.light.text}</dd>
              <dt className="text-muted">Heavy work</dt>
              <dd className="text-ink">{z.workRest.heavy.text}</dd>
              <dt className="text-muted">Water</dt>
              <dd className="text-ink">{water(z)}</dd>
            </dl>
            <div className="flex flex-wrap gap-1">
              <Flag ok={z.unacclimatizedAllowed} yes="Unacclimatised allowed" no="No unacclimatised workers" />
              <Flag ok={z.loneWorkAllowed} yes="Lone work allowed" no="No lone work" />
              {z.permitToWork && <Flag ok={false} yes="" no="Permit to work" />}
              {!z.ordinaryWorkAllowed && <Flag ok={false} yes="" no="No ordinary work" />}
            </div>
            {z.controls.length > 0 && (
              <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted">
                {z.controls.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">{pack.twlZones[0]?.basis}</p>
    </div>
  )
}

function Flag({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={ok ? 'rounded bg-safe-bg px-1.5 py-0.5 text-[11px] font-medium text-safe' : 'rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-ink'}>
      <span aria-hidden>{ok ? '✓ ' : '× '}</span>
      {ok ? yes : no}
    </span>
  )
}

function PackDuties({ pack }: { pack: RulePack }) {
  const mb = pack.middayBreak
  const items: Array<{ id: string; title: string; body: ReactNode; basis?: string | null }> = []
  if (mb) {
    items.push({
      id: 'midday',
      title: `Midday break · ${mb.startHhmm}–${mb.endHhmm}, ${dayMonth(mb.from)} – ${dayMonth(mb.to)}`,
      body: (
        <>
          <p>{mb.appliesTo}.</p>
          {mb.employerDuties.length > 0 && <p className="mt-1">Employer provides: {mb.employerDuties.join('; ').toLowerCase()}.</p>}
          {mb.exemptions.length > 0 && <p className="mt-1">Exempt: {mb.exemptions.join('; ')}.</p>}
        </>
      ),
      basis: mb.basis,
    })
  }
  if (pack.acclimatization) {
    items.push({
      id: 'accl',
      title: 'Acclimatisation',
      body: (
        <p>
          {pack.acclimatization.definition}.
          {pack.acclimatization.allowanceDays ? ` Allow ${pack.acclimatization.allowanceDays[0]}–${pack.acclimatization.allowanceDays[1]} days before hard work in heat.` : ''}
        </p>
      ),
      basis: pack.acclimatization.basis,
    })
  }
  if (pack.hydration) {
    items.push({
      id: 'hyd',
      title: 'Hydration',
      body: (
        <ul className="list-disc space-y-0.5 ps-4">
          {pack.hydration.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ),
      basis: pack.hydration.basis,
    })
  }
  if (pack.incidentNotification) {
    const n = pack.incidentNotification
    items.push({
      id: 'incident',
      title: `Incident notification · ${n.form}`,
      body: (
        <p>
          To the {n.recipient.toLowerCase()}: a fatality within {n.fatalityWithinHours} h, a serious case within {n.seriousWithinWorkingDays} working days (
          {n.seriousCriteria.join('; ').toLowerCase()}).
        </p>
      ),
      basis: n.basis,
    })
  }
  if (pack.heatProgramTriggerC !== null) {
    items.push({ id: 'programme', title: 'Heat-stress programme', body: <p>Required where the shift reaches {pack.heatProgramTriggerC} °C or more.</p>, basis: pack.heatProgramBasis })
  }
  for (const p of pack.penalties) items.push({ id: `pen-${p.appliesTo}`, title: `Penalty · ${p.appliesTo}`, body: <p>{p.text}.</p>, basis: p.basis })
  if (pack.workerRights.length > 0) items.push({ id: 'rights', title: 'Worker rights', body: <p>{pack.workerRights.join(' ')}</p> })
  return (
    <div className="mt-5">
      <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <ScrollText aria-hidden size={16} className="text-shade" /> Duties
      </h4>
      <dl className="grid gap-3 md:grid-cols-2">
        {items.map((it) => (
          <div key={it.id} className="rounded-lg bg-canvas p-3 text-xs">
            <dt className="mb-1 text-sm font-semibold text-ink">{it.title}</dt>
            <dd className="text-muted">
              {it.body}
              {it.basis && <p className="mt-1.5 text-[11px] text-subtle">{it.basis}</p>}
            </dd>
          </div>
        ))}
      </dl>
      {pack.notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-0.5 ps-4 text-xs text-muted">
          {pack.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dayMonth(mmdd: string): string {
  const [m, d] = mmdd.split('-').map(Number)
  return `${d} ${MONTH_NAMES[m - 1] ?? m}`
}

function ExportCard({ scope, ops, tables }: { scope: OpsScope; ops: OpsModel; tables: readonly ExportTable[] }) {
  const scenarioId = useSim((s) => s.scenarioId)
  const scenarioTitle = scenarioId ? getScenario(scenarioId).title : 'Unknown scenario'
  const k = tables.find((t) => t.released.k !== null)?.released.k ?? null
  const suppressed = tables.reduce((n, t) => n + (t.released.table?.suppressedCells ?? 0), 0)
  const onExport = () => {
    const hhmm = formatLocalHhmm(ops.t)
    const meta: Array<readonly [string, string]> = [
      ['Role', `${ROLE_LABEL[scope.role]} (${scope.actorId})`],
      ['Rows', scope.rowsBy === 'crew' ? 'Crews of the site' : 'Sites'],
      ['Site', ops.site.name],
      ['Date', ops.date],
      ['Simulated time', hhmm],
      ['Scenario', `${scenarioTitle} (simulated cohort; no real workers)`],
      ['Rule pack', RULE_PACKS[ops.packId].name],
      ['Minimum cell size k', k === null ? 'denied' : String(k)],
      ['Suppression', 'Primary (fewer than k distinct workers) and complementary (protects hidden cells from subtraction); totals included'],
    ]
    const csvTables: CsvTable[] = tables.map((t) => ({
      title: t.title,
      rowHeader: t.rowHeader,
      rowLabel: t.rowLabel,
      colLabel: t.colLabel,
      note: `${t.released.decision}: ${t.released.reason}`,
      k: t.released.k,
      table: t.released.table,
    }))
    downloadText(`zill-${scope.role === 'regulator' ? 'regulator' : 'hse'}-${ops.site.id}-${ops.date}-${hhmm.replace(':', '')}.csv`, aggregatesCsv(meta, csvTables))
  }
  return (
    <Card as="aside" aria-label="Export aggregate tables" className="flex flex-col">
      <CardHeader icon={FileSpreadsheet} title="Export aggregate tables" description={`${tables.length} tables as released to the ${ROLE_LABEL[scope.role].toLowerCase()} at ${formatLocalHhmm(ops.t)}.`} />
      <ul className="mb-4 space-y-1.5 text-xs">
        {tables.map((t) => (
          <li key={t.title} className="flex items-start justify-between gap-3">
            <span className="text-ink">{t.title}</span>
            <span className="shrink-0 text-muted tabular-nums">{t.released.table ? `${t.released.table.suppressedCells} suppressed` : 'refused'}</span>
          </li>
        ))}
      </ul>
      <p className="mb-4 flex items-start gap-2 rounded-lg bg-canvas p-3 text-xs text-muted">
        <Lock aria-hidden size={14} className="mt-0.5 shrink-0 text-shade" />
        <span>
          Suppressed cells ({suppressed} in all) are written as “fewer than {k ?? 'k'} (suppressed)”. The file carries no individual record and no
          hidden count: the released tables do not contain them.
        </span>
      </p>
      <Button icon={Download} onClick={onExport} className="mt-auto self-start">
        Download CSV
      </Button>
    </Card>
  )
}
