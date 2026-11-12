/**
 * "Conditions now" panel of the overview: WBGT in sun and shade, TWL with its ADOSH zone (colour + pictogram + text),
 * air temperature and humidity at the five Abu Dhabi sites, from the live Open-Meteo forecast through the engine's own
 * index code (liveConditions.ts). Offline, every site states its fallback source and age. Open-Meteo attribution and
 * the free-tier licensing note are shown with the data.
 */
import { useCallback, useEffect, useState } from 'react'
import { CloudOff, MapPin, RefreshCw, Sun } from 'lucide-react'
import { OPEN_METEO_ATTRIBUTION, OPEN_METEO_LICENSING_NOTE } from '../../../data/weather'
import { formatLocalHhmm } from '../../../engine/time'
import { LevelPill, ProvenanceTag, cx, type ProvenanceKind } from '../../components'
import { loadLiveConditions, sourceText, type LiveConditions as LiveConditionsData, type SiteConditions } from './siteConditions'

function provenanceOf(c: SiteConditions): { kind: ProvenanceKind; label: string } {
  if (c.source === 'forecast' && !c.stale) return { kind: 'real_weather', label: 'Live forecast' }
  if (c.source === 'conservative_default') return { kind: 'engineering_default', label: 'Fail-safe default' }
  return { kind: 'archived_forecast', label: 'Cached forecast' }
}

const fmt1 = (v: number) => v.toFixed(1)

function SiteCard({ c }: { c: SiteConditions }) {
  const prov = provenanceOf(c)
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <MapPin aria-hidden size={16} className="mt-0.5 shrink-0 text-shade" />
        <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-ink">{c.name}</h3>
      </div>
      <div>
        <p className="text-xs font-medium text-muted">WBGT in sun</p>
        <p className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold tabular-nums text-ink">{fmt1(c.wbgtC)}</span>
          <span className="text-sm text-muted">°C</span>
        </p>
        <p className="text-xs tabular-nums text-muted">
          {fmt1(c.wbgtShadeC)} °C in shade{c.wbgtMarginC > 0 ? ` · +${c.wbgtMarginC} °C fail-safe margin` : ''}
        </p>
      </div>
      {c.zone ? (
        <div className="flex flex-col gap-1">
          <LevelPill level={c.zone.level} label={c.zone.label} size="sm" />
          <p className="text-xs tabular-nums text-muted">TWL {Math.round(c.twlWm2)} W/m² in sun · ADOSH zone</p>
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-3 text-xs">
        <dt className="text-muted">Air</dt>
        <dd className="text-end font-medium tabular-nums text-ink">{fmt1(c.taC)} °C</dd>
        <dt className="text-muted">Humidity</dt>
        <dd className="text-end font-medium tabular-nums text-ink">{Math.round(c.rhPct)} %</dd>
      </dl>
      <div className="mt-auto flex flex-col gap-1">
        <ProvenanceTag kind={prov.kind} label={prov.label} detail={sourceText(c)} size="sm" />
        {c.fetchError && c.source !== 'forecast' ? <p className="text-[11px] leading-snug text-subtle">Live request failed: {c.fetchError}</p> : null}
      </div>
    </li>
  )
}

export function LiveConditions() {
  const [data, setData] = useState<LiveConditionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback((force: boolean) => {
    setLoading(true)
    loadLiveConditions(force)
      .then(setData)
      .catch((err: unknown) => console.error('Live conditions failed', err))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => load(false), [load])

  const offline = data !== null && data.liveCount === 0
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        {data && (
          <span className="tabular-nums">
            Abu Dhabi time <strong className="font-semibold text-ink">{formatLocalHhmm(data.t)}</strong>
          </span>
        )}
        {data && (
          <span className="inline-flex items-center gap-1.5">
            <Sun aria-hidden size={15} className="text-subtle" />
            {data.middayBreak ? 'Midday break in force: no outdoor work in direct sun until 15:00' : 'Midday break not in force now (12:30–15:00, 15 Jun–15 Sep)'}
          </span>
        )}
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-60"
        >
          <RefreshCw aria-hidden size={13} className={cx(loading && 'motion-safe:animate-spin')} />
          {loading ? 'Fetching forecast…' : 'Refresh'}
        </button>
      </div>

      {offline && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-line-strong bg-canvas p-3 text-sm text-muted">
          <CloudOff aria-hidden size={18} className="mt-0.5 shrink-0 text-subtle" />
          <span>
            The live forecast is unavailable (offline or timed out). Each site shows the data the fail-safe chain falls back
            to — a cached forecast with its age, else the conservative design hour from the cached 2020–2025 archive — just as
            a worker’s phone would. The demo scenarios replay cached real weather and work offline.
          </span>
        </p>
      )}

      {data ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-busy={loading}>
          {data.sites.map((c) => (
            <SiteCard key={c.siteId} c={c} />
          ))}
        </ul>
      ) : (
        <ul aria-busy="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="h-64 animate-pulse rounded-xl border border-line bg-surface" />
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-subtle">
        <a href={OPEN_METEO_ATTRIBUTION.href} target="_blank" rel="noreferrer" className="font-medium text-muted underline underline-offset-2">
          {OPEN_METEO_ATTRIBUTION.text}
        </a>{' '}
        ({OPEN_METEO_ATTRIBUTION.licence}), ECMWF IFS HRES 9 km. WBGT (Liljegren 2008) and TWL (Brake &amp; Bates 2002) are
        computed in the browser by the same engine code the phones run; the ADOSH zone is from the Abu Dhabi rule pack (ADOSH-SF
        CoP 11.0 v4.0, 2024). {OPEN_METEO_LICENSING_NOTE}
      </p>
    </div>
  )
}
