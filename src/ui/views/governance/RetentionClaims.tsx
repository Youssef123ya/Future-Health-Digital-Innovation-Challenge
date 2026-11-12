/**
 * Retention policies (periods read from privacy.ts; the open ones are set by legal review), the claims-discipline
 * statement (GOVERNANCE §9 intended purpose, claims to avoid) and links to the GOVERNANCE.md sections.
 * Basis: ARCHITECTURE §1 principle 8, §7; GOVERNANCE §2.3, §9.
 */
import { memo } from 'react'
import { BookOpen, CircleCheck, CircleSlash, Clock3, ExternalLink, Quote } from 'lucide-react'
import { Card, CardHeader, Section } from '../../components'
import { CLAIMS_AVOID, CLAIMS_FINE, GOVERNANCE_DOC_LINKS, INTENDED_PURPOSE, RETENTION_ROWS } from './model'

export const RetentionClaims = memo(function RetentionClaims() {
  return (
    <Section
      id="gov-retention"
      title="Retention and claims"
      description="How long each kind of data is kept, what Zill does and does not claim to do, and where the full governance case is written down."
    >
      <div className="grid gap-4 xl:grid-cols-12">
        <Card as="article" aria-labelledby="gov-ret-h" className="min-w-0 xl:col-span-7">
          <CardHeader id="gov-ret-h" as="h3" icon={Clock3} title="Retention" description="Periods come from the privacy code; open periods are set by legal review." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">Retention period of each kind of data</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="py-1.5 pe-3 text-start font-medium">
                    Data
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-start font-medium">
                    Where
                  </th>
                  <th scope="col" className="ps-3 py-1.5 text-start font-medium">
                    Kept for
                  </th>
                </tr>
              </thead>
              <tbody>
                {RETENTION_ROWS.map((r) => (
                  <tr key={r.data} className="border-b border-line align-top last:border-0">
                    <th scope="row" className="py-2 pe-3 text-start font-medium text-ink">
                      {r.data}
                      <span className="mt-0.5 block text-xs font-normal text-subtle">{r.basis}</span>
                    </th>
                    <td className="px-3 py-2 text-muted">{r.where}</td>
                    <td className="ps-3 py-2">
                      <span className="font-medium whitespace-nowrap text-ink">{r.period}</span>
                      {r.note && <span className="mt-0.5 block text-xs text-muted">{r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card as="article" aria-labelledby="gov-claims-h" className="min-w-0 xl:col-span-5">
          <CardHeader id="gov-claims-h" as="h3" icon={Quote} title="Claims discipline" description="The intended-purpose statement, used verbatim in the product, contracts and pitch." />
          <blockquote className="border-s-2 border-shade ps-3 text-sm leading-relaxed text-ink">{INTENDED_PURPOSE}</blockquote>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Never claimed</h4>
              <ul className="space-y-1 text-sm">
                {CLAIMS_AVOID.map((c) => (
                  <li key={c} className="flex gap-2 text-ink">
                    <CircleSlash aria-hidden size={14} className="mt-0.5 shrink-0 text-rose-700" />
                    <span>
                      <span className="sr-only">Never claimed: </span>
                      {c}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0">
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">What Zill does say</h4>
              <ul className="space-y-1 text-sm">
                {CLAIMS_FINE.map((c) => (
                  <li key={c} className="flex gap-2 text-ink">
                    <CircleCheck aria-hidden size={14} className="mt-0.5 shrink-0 text-shade" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            ECTemp is an estimated strain indicator, shown with its uncertainty band to the worker and, with consent, to occupational health. Physiology never
            calls 998 on its own.
          </p>
        </Card>

        <Card as="aside" aria-labelledby="gov-docs-h" padding="sm" className="min-w-0 xl:col-span-12">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
            <h3 id="gov-docs-h" className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <BookOpen aria-hidden size={15} className="text-shade" />
              Governance case, section by section
            </h3>
            <ul aria-label="GOVERNANCE.md sections" className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
              {GOVERNANCE_DOC_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded font-medium text-shade-dark underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shade"
                  >
                    {l.label}
                    <ExternalLink aria-hidden size={12} />
                    <span className="sr-only"> (GOVERNANCE.md, opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </Section>
  )
})
