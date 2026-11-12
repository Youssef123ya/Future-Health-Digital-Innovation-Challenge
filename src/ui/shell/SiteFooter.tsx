/**
 * Site footer: claims discipline ("prototype — not a medical device"), the emergency line, data attributions (Open-Meteo
 * CC BY 4.0, Copernicus/ERA5, IEM observations; data/weather.ts constants, transcribed from data_and_validation.md §7)
 * and links to the project documents in the source repository.
 */
import { ExternalLink } from 'lucide-react'
import { COPERNICUS_ATTRIBUTION, IEM_ATTRIBUTION, OPEN_METEO_ATTRIBUTION } from '../../data/weather'
import { cx } from '../components'

/** Source repository of this prototype (documents are linked from here). */
export const REPO_URL = 'https://github.com/Youssef123ya/Future-Health-Digital-Innovation-Challenge'

/** Link to a repository file by its repository-relative path, e.g. `docHref('docs/ARCHITECTURE.md')`. */
export function docHref(path: string): string {
  return `${REPO_URL}/blob/main/${path.replace(/^\.?\//, '')}`
}

/** The project documents shown in the footer, by repository-relative path. */
export const DOC_LINKS: readonly { path: string; label: string }[] = [
  { path: 'README.md', label: 'Read me' },
  { path: 'docs/ARCHITECTURE.md', label: 'Architecture' },
  { path: 'docs/SCIENCE.md', label: 'Science' },
  { path: 'docs/VALIDATION.md', label: 'Validation' },
  { path: 'docs/VALIDATION-COHORT.md', label: 'Simulated cohort' },
  { path: 'docs/GOVERNANCE.md', label: 'Governance' },
  { path: 'docs/LIMITATIONS.md', label: 'Limitations' },
  { path: 'docs/PILOT.md', label: 'Pilot plan' },
]

const LINK = 'rounded-sm font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink'

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer lang="en" className={cx('border-t border-line bg-surface', className)}>
      <div className="mx-auto grid max-w-[96rem] gap-6 px-4 py-6 text-xs leading-relaxed text-muted sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.8fr)] lg:px-8">
        <section aria-labelledby="footer-claims">
          <h2 id="footer-claims" className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink">
            Prototype — not a medical device
          </h2>
          <p>
            Zill is occupational-safety decision support for heat stress at work. It does not diagnose illness, does not
            predict heat stroke and does not measure core temperature; its heart-rate output is an estimated strain
            indicator with an uncertainty band. It does not replace first aid, medical care or the employer’s duties.
          </p>
          <p className="mt-2 font-semibold text-ink">Emergency: call 998 · cool first, transport second.</p>
        </section>

        <section aria-labelledby="footer-data">
          <h2 id="footer-data" className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink">
            Data
          </h2>
          <p>
            <a href={OPEN_METEO_ATTRIBUTION.href} target="_blank" rel="noreferrer" className={LINK}>
              {OPEN_METEO_ATTRIBUTION.text}
            </a>{' '}
            (
            <a href={OPEN_METEO_ATTRIBUTION.licenceUrl} target="_blank" rel="noreferrer" className={LINK}>
              {OPEN_METEO_ATTRIBUTION.licence}
            </a>
            ): ECMWF IFS forecasts and analyses. {OPEN_METEO_ATTRIBUTION.changes}
          </p>
          <p className="mt-1.5">{COPERNICUS_ATTRIBUTION}</p>
          <p className="mt-1.5">{IEM_ATTRIBUTION}</p>
          <p className="mt-1.5">Workers, crews and physiology in the demo are a simulated cohort; no real person’s data is used.</p>
        </section>

        <nav aria-labelledby="footer-docs">
          <h2 id="footer-docs" className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink">
            Documents
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {DOC_LINKS.map((d) => (
              <li key={d.path}>
                <a href={docHref(d.path)} target="_blank" rel="noreferrer" className={cx(LINK, 'inline-flex items-center gap-1')}>
                  {d.label}
                  <ExternalLink aria-hidden size={11} className="text-subtle" />
                  <span className="sr-only">(opens the source repository in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-subtle">MIT licence · Future Health Digital Innovation Challenge, Challenge 07</p>
        </nav>
      </div>
    </footer>
  )
}
