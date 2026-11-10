import { useState } from 'react'
import { CheckCheck, Construction, Eye, HardHat, Settings2, type LucideIcon } from 'lucide-react'
import { RISK_LEVELS, RISK_ORDER, type ActionId, type RiskLevel } from '../../engine/types'
import type { Route } from '../router'
import {
  ActionChip,
  Badge,
  Button,
  Card,
  CardHeader,
  CountdownRing,
  DataTable,
  EmptyState,
  KeyValue,
  LevelCard,
  LevelPill,
  Meter,
  ProvenanceTag,
  Section,
  Sparkline,
  Stat,
  Tabs,
  Timeline,
  Toggle,
  type DataTableColumn,
  type ProvenanceKind,
} from '../components'

export interface PlaceholderProps {
  route: Route
  title: string
  purpose: string
  icon?: LucideIcon
  /** Show the design-system preview (used on the overview until the real view lands). */
  showGallery?: boolean
}

/**
 * Stand-in for a view that has not been wired up yet: page title, the view's purpose from ARCHITECTURE.md §9 and an
 * explicit "not wired up" state. The worker route shows a phone-sized preview instead. All sample values are labelled as
 * samples (ARCHITECTURE.md §1 principle 7, honest evidence).
 */
export function Placeholder({ route, title, purpose, icon: Icon, showGallery = false }: PlaceholderProps) {
  if (route.id === 'worker') return <WorkerPreview workerId={route.params.id ?? ''} />
  return (
    <div className="space-y-8">
      <header className="flex items-start gap-4">
        {Icon && (
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-shade-bg text-shade">
            <Icon size={22} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{purpose}</p>
        </div>
      </header>
      <EmptyState
        icon={Construction}
        title="This view is not wired up yet"
        description="The application shell, routing and design system are in place. This view's live content arrives with its own module."
      />
      {showGallery && <DesignSystemGallery />}
    </div>
  )
}

function WorkerPreview({ workerId }: { workerId: string }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="truncate text-sm font-semibold text-ink">
          Worker <span className="font-normal text-muted">· {workerId}</span>
        </h1>
        <Badge tone="outline" size="sm" icon={Eye}>
          Preview · sample values
        </Badge>
      </div>
      <LevelCard
        level="caution"
        size="md"
        headline="Drink water and take shade breaks"
        reason="Sample: heat is close to the limit for heavy work at this hour."
      >
        <div className="flex flex-col gap-2">
          <ActionChip action="drink_water" label="Drink a cup of water" description="250 mL every 20 min" level="caution" size="lg" />
          <ActionChip action="shade_breaks" label="Shade break every hour" description="45 min work · 15 min shade" level="caution" size="lg" />
        </div>
      </LevelCard>
      <Card padding="sm" className="flex items-center gap-4">
        <CountdownRing remainingMin={12.5} totalMin={45} label="until the next shade break" level="caution" size={104} caption="to break" />
        <KeyValue
          dense
          className="min-w-0 flex-1"
          items={[
            { label: 'Work / shade', value: '45 / 15', unit: 'min' },
            { label: 'Water reminder', value: 'every 20', unit: 'min' },
          ]}
        />
      </Card>
      <p className="text-xs text-muted">The live worker screen replaces this preview when the worker view is wired up.</p>
    </div>
  )
}

// ─────────────────────────────── Design-system preview (sample values only) ───────────────────────────────

const SAMPLE_ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  drink_water: 'Drink water',
  shade_breaks: 'Shade breaks',
  reduce_intensity: 'Reduce intensity',
  rotate_task: 'Rotate to a cooler task',
  rest_shade_now: 'Rest in the shade now',
  cool_down: 'Cool down',
  stop_work: 'Stop work',
  buddy_check: 'Buddy check',
  first_aider_check: 'First aider check',
  call_998: 'Call 998',
  cool_first: 'Cool first, transport second',
  stay_with_worker: 'Stay with the worker',
  midday_break: 'Midday break',
  acclimatization_plan: 'Acclimatisation plan',
  occ_health_review: 'Occupational health review',
  check_sensor: 'Check the sensor',
  symptom_checkin: 'Symptom check-in',
  no_lone_work: 'No lone work',
  electrolytes: 'Electrolyte drink',
  restrict_fluids: 'Restrict fluids',
  medical_evaluation: 'Medical evaluation',
  no_hot_work_today: 'No more hot work today',
}

const SAMPLE_HEADLINES: Readonly<Record<RiskLevel, string>> = {
  safe: 'Normal work. Keep drinking water.',
  caution: 'Drink water and take shade breaks',
  high: 'Shade breaks every hour; rotate tasks',
  stop: 'Stop work and rest in the shade',
  emergency: 'Call 998. Cool first, transport second.',
}

const PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  'reference',
  'real_weather',
  'archived_forecast',
  'simulated',
  'projection',
  'engineering_default',
]

interface SampleRow {
  id: string
  name: string
  level: RiskLevel
  action: ActionId
  workMin: number | null
  ack: 'Acknowledged' | 'Pending' | null
}

const SAMPLE_ROWS: readonly SampleRow[] = [
  { id: 'a', name: 'Worker A', level: 'safe', action: 'drink_water', workMin: 60, ack: null },
  { id: 'b', name: 'Worker B', level: 'caution', action: 'shade_breaks', workMin: 45, ack: 'Acknowledged' },
  { id: 'c', name: 'Worker C', level: 'high', action: 'rotate_task', workMin: 20, ack: 'Pending' },
  { id: 'd', name: 'Worker D', level: 'stop', action: 'rest_shade_now', workMin: 0, ack: 'Pending' },
  { id: 'e', name: 'Worker E', level: 'caution', action: 'check_sensor', workMin: null, ack: null },
]

const SAMPLE_COLUMNS: readonly DataTableColumn<SampleRow>[] = [
  { id: 'name', header: 'Worker', cell: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
  { id: 'level', header: 'Level', cell: (r) => <LevelPill level={r.level} size="sm" />, sortValue: (r) => RISK_ORDER[r.level] },
  {
    id: 'action',
    header: 'Action',
    cell: (r) => <ActionChip action={r.action} label={SAMPLE_ACTION_LABELS[r.action]} level={r.level} size="sm" />,
    hideBelow: 'sm',
  },
  { id: 'work', header: 'Work min/h', cell: (r) => r.workMin ?? '—', sortValue: (r) => r.workMin, numeric: true },
  { id: 'ack', header: 'Acknowledgement', cell: (r) => r.ack ?? '—', sortValue: (r) => r.ack, hideBelow: 'md' },
]

const WBGT_SAMPLE = [27.1, 27.8, 28.6, 29.4, 30.2, 30.9, 31.3, null, 31.8, 31.6, 31.0, 30.1, 29.2]
const HOURS = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']

function DesignSystemGallery() {
  const [consent, setConsent] = useState(false)
  const [buddy, setBuddy] = useState(true)
  const [tab, setTab] = useState('board')
  const [drank, setDrank] = useState(false)

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-8">
        <h2 className="text-xl font-semibold text-ink">Design system preview</h2>
        <Badge tone="outline" icon={Eye}>
          Sample values, not live data
        </Badge>
      </div>

      <Section
        title="Risk levels"
        description="Every level is shown as colour, pictogram and text together, so it never depends on colour vision."
      >
        <div className="flex flex-wrap gap-2">
          {RISK_LEVELS.map((level) => (
            <LevelPill key={level} level={level} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {RISK_LEVELS.map((level) => (
            <LevelPill key={level} level={level} variant="solid" />
          ))}
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {RISK_LEVELS.map((level) => (
            <LevelCard key={level} level={level} size="md" headingLevel={3} live="off" headline={SAMPLE_HEADLINES[level]} />
          ))}
        </div>
      </Section>

      <Section title="Actions" description="One pictogram per action; the text label is always supplied by the view (i18n).">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SAMPLE_ACTION_LABELS) as ActionId[]).map((action) => (
            <ActionChip key={action} action={action} label={SAMPLE_ACTION_LABELS[action]} />
          ))}
        </div>
        <div className="mt-4 flex max-w-md flex-col gap-2">
          <ActionChip
            action="drink_water"
            label="Drink a cup of water"
            description="Tap when done"
            level="caution"
            size="lg"
            done={drank}
            onClick={() => setDrank((d) => !d)}
          />
          <ActionChip action="call_998" label="Call 998" description="Cool first, transport second" level="emergency" size="lg" />
        </div>
      </Section>

      <Section title="Metrics" description="Each number states its source; missing data shows as missing.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            framed
            label="Peak WBGT today"
            value={31.8}
            precision={1}
            unit="°C"
            delta={{ value: 1.2, precision: 1, unit: '°C', label: 'vs yesterday', good: 'down' }}
            trend={WBGT_SAMPLE}
            provenance="real_weather"
            provenanceDetail="Sample value"
          />
          <Stat framed label="Allowed work" value={45} unit="min/h" level="caution" provenance="reference" provenanceDetail="Sample value" />
          <Stat
            framed
            label="Minutes to limit"
            value={38}
            unit="min"
            level="high"
            info="ISO 7933:2023 Predicted Heat Strain: rectal-temperature limit 38.0 °C or the dehydration limit"
            provenance="projection"
          />
          <Stat framed label="Acknowledgement time" value={null} unit="min" provenance="simulated" hint="No acknowledgements yet" />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Thermal Work Limit" description="Higher is cooler; ticks are the zone edges." />
            <Meter
              label="TWL (sample)"
              value={128}
              min={60}
              max={260}
              unit="W/m²"
              direction="higher-is-better"
              thresholds={[
                { value: 140, level: 'caution', label: '140' },
                { value: 115, level: 'high', label: '115' },
              ]}
              levelLabels={{ caution: 'Medium zone', high: 'High zone' }}
              showThresholdLabels
            />
            <p className="mt-3 text-xs text-muted">
              ADOSH-SF CoP 11.0 v4.0 zones: Low &gt; 140, Medium 115–140, High &lt; 115 W/m². A value on an edge takes the
              more protective zone.
            </p>
          </Card>
          <Card>
            <CardHeader title="Meters" description="Neutral progress and a missing reading." />
            <div className="space-y-4">
              <Meter label="Shift elapsed" value={62} unit="%" />
              <Meter label="Site sensor reading" value={null} unit="°C" />
            </div>
          </Card>
          <Card>
            <CardHeader title="Trend with projection" description="Gap = missing hour; dashed = model projection." />
            <Sparkline
              values={WBGT_SAMPLE}
              label="WBGT (sample), 06:00–18:00"
              unit="°C"
              fluid
              height={56}
              area
              projectionFrom={9}
              pointLabels={HOURS}
              thresholds={[{ value: 31, level: 'high', label: 'sample limit' }]}
            />
          </Card>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <CountdownRing remainingMin={12.5} totalMin={45} label="until the next shade break" level="caution" caption="to shade break" />
          <CountdownRing remainingMin={3} totalMin={15} label="until rest ends" level="stop" format="minutes" size={128} caption="rest" />
          <CountdownRing remainingMin={null} totalMin={60} label="until the next check-in" size={128} caption="no schedule" />
        </div>
      </Section>

      <Section title="Provenance" description="Hover or focus a tag for its source detail.">
        <div className="flex flex-wrap gap-2">
          {PROVENANCE_KINDS.map((kind) => (
            <ProvenanceTag key={kind} kind={kind} size="md" detail="Sample detail: source, version and sample size" />
          ))}
        </div>
      </Section>

      <Section title="Controls">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Buttons" />
            <div className="flex flex-wrap items-center gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Stop work</Button>
              <Button variant="emergency">Call 998</Button>
              <Button variant="secondary" iconOnly aria-label="Settings" icon={Settings2} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary">
                Small
              </Button>
              <Button size="md" variant="secondary">
                Medium
              </Button>
              <Button size="lg" variant="secondary">
                Large 48 px
              </Button>
              <Button size="xl" variant="secondary" loading>
                Saving
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge>Neutral</Badge>
              <Badge tone="brand">Brand</Badge>
              <Badge tone="info">Info</Badge>
              <Badge tone="outline">Outline</Badge>
            </div>
          </Card>
          <Card>
            <CardHeader title="Toggles and tabs" />
            <div className="space-y-2">
              <Toggle
                checked={consent}
                onCheckedChange={setConsent}
                label="Share with occupational health if escalated"
                description="Opt-in and revocable at any time."
              />
              <Toggle checked={buddy} onCheckedChange={setBuddy} label="Buddy alerts" size="lg" />
            </div>
            <Tabs
              className="mt-4"
              label="Sample tabs"
              value={tab}
              onValueChange={setTab}
              items={[
                { id: 'board', label: 'Crew board', icon: HardHat },
                { id: 'alerts', label: 'Alerts', badge: <Badge size="sm">3</Badge> },
                { id: 'planner', label: 'Planner' },
                { id: 'water', label: 'Water', disabled: true },
              ]}
            >
              {(id) => <p className="text-sm text-muted">Panel for “{id}”.</p>}
            </Tabs>
          </Card>
        </div>
      </Section>

      <Section title="Tables, timelines and lists">
        <div className="grid gap-6 xl:grid-cols-5">
          <DataTable
            className="xl:col-span-3"
            caption="Sample crew board (sortable)"
            columns={SAMPLE_COLUMNS}
            rows={SAMPLE_ROWS}
            rowKey={(r) => r.id}
            initialSort={{ columnId: 'level', direction: 'desc' }}
          />
          <Card className="xl:col-span-2">
            <CardHeader title="Alert feed" />
            <Timeline
              label="Sample alert feed"
              items={[
                { id: '3', time: '13:05', level: 'stop', title: 'Crew 2 · rest in the shade now', description: 'Sample: projected limit within 15 min.' },
                { id: '2', time: '12:41', icon: CheckCheck, title: 'Supervisor acknowledged', meta: <span>Crew 1</span> },
                {
                  id: '1',
                  time: '12:30',
                  level: 'stop',
                  title: 'Midday break: outdoor work in the sun stops',
                  description: 'MoHRE Ministerial Resolution 44/2022 · 15 Jun–15 Sep, 12:30–15:00',
                },
              ]}
            />
          </Card>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Key values" />
            <KeyValue
              items={[
                { label: 'Site', value: 'Sample site' },
                { label: 'WBGT (shade)', value: '29.4', unit: '°C', provenance: 'real_weather' },
                { label: 'Water this shift', value: '2.6', unit: 'L' },
              ]}
            />
          </Card>
          <EmptyState
            tone="unavailable"
            title="Physiology channel unavailable"
            description="No usable wearable signal. This is never treated as reassurance: alerts rely on environment and work context."
          />
        </div>
      </Section>
    </div>
  )
}
