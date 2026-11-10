import { useId, type ReactNode } from 'react'
import { cx } from './cx'
import { ProvenanceTag, type ProvenanceKind } from './ProvenanceTag'

export interface SectionProps {
  title: ReactNode
  description?: ReactNode
  /** Controls aligned to the inline end of the heading row. */
  actions?: ReactNode
  /** h2 for page sections (default), h3 for sub-sections (WCAG 2.2 SC 1.3.1 Info and Relationships). */
  headingLevel?: 2 | 3
  /** Element id, for `scrollIntoView` targets. Hash links are not used (the router owns the hash). */
  id?: string
  /** Data source of everything in the section (ARCHITECTURE.md §1 principle 7). */
  provenance?: ProvenanceKind
  provenanceDetail?: ReactNode
  children?: ReactNode
  className?: string
}

/** Titled page region (`<section aria-labelledby>`), so assistive technology lists it as a landmark. [ENG] UI primitive. */
export function Section({
  title,
  description,
  actions,
  headingLevel = 2,
  id,
  provenance,
  provenanceDetail,
  children,
  className,
}: SectionProps) {
  const autoId = useId()
  const headingId = `${id ?? autoId}-heading`
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section id={id} aria-labelledby={headingId} className={cx('min-w-0 scroll-mt-24', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Heading
              id={headingId}
              className={cx('font-semibold text-ink', headingLevel === 2 ? 'text-lg' : 'text-base')}
            >
              {title}
            </Heading>
            {provenance && <ProvenanceTag kind={provenance} detail={provenanceDetail} />}
          </div>
          {description && <div className="mt-0.5 max-w-prose text-sm text-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
