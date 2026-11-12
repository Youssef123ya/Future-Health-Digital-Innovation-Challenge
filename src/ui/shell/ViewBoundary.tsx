/**
 * Resilience around each routed view: an error boundary (a crash in one screen never blanks the app; the card says
 * what failed and offers "Reload this view") and the loading skeleton shown while a lazily loaded screen arrives.
 * A failed chunk download (offline on first visit, or a stale build after a deploy) is told apart and offers a full
 * reload, which fetches the current build. Basis: ARCHITECTURE §3 (offline-first PWA); WCAG 2.2 SC 4.1.3 (status).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { EmptyState, buttonClasses, cx } from '../components'

export interface ViewBoundaryProps {
  /** Screen title for the message ("Supervisor console"). */
  title: string
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

/** True for a failed dynamic import (network or stale build), where only a page reload helps. */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError|error loading dynamically/i.test(text)
}

export class ViewBoundary extends Component<ViewBoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Zill: the "${this.props.title}" screen failed`, error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const chunk = isChunkLoadError(error)
    return (
      <div role="alert" className="mx-auto max-w-2xl">
        <EmptyState
          icon={TriangleAlert}
          tone="unavailable"
          title={chunk ? `The ${this.props.title} screen could not be downloaded` : `The ${this.props.title} screen hit a problem`}
          description={
            <span className="block space-y-2">
              <span className="block">
                {chunk
                  ? 'This device is offline or an older copy of Zill is cached. Reload to fetch the current version; the other screens keep working.'
                  : 'The rest of Zill keeps running. Reload this screen to try again; the simulated clock and your choices are kept.'}
              </span>
              <code className="block max-h-24 overflow-auto rounded-md bg-surface px-2 py-1 text-start font-mono text-xs text-muted ring-1 ring-line">
                {error.message || String(error)}
              </code>
            </span>
          }
          action={
            <span className="flex flex-wrap justify-center gap-2">
              {!chunk && (
                <button type="button" onClick={() => this.setState({ error: null })} className={buttonClasses({ variant: 'primary' })}>
                  <RotateCcw aria-hidden size={16} />
                  Reload this view
                </button>
              )}
              <button type="button" onClick={() => window.location.reload()} className={buttonClasses({ variant: chunk ? 'primary' : 'secondary' })}>
                <RefreshCw aria-hidden size={16} />
                Reload the app
              </button>
            </span>
          }
        />
      </div>
    )
  }
}

/** Loading skeleton matching the screen's frame: a console page, or the phone. */
export function ViewSkeleton({ title, variant = 'page' }: { title: string; variant?: 'page' | 'phone' }) {
  const bar = 'rounded-lg bg-line/70 motion-safe:animate-pulse'
  if (variant === 'phone') {
    return (
      <div role="status" className="space-y-3 p-4">
        <span className="sr-only">Loading {title}…</span>
        <div className="flex items-center gap-3">
          <div className={cx(bar, 'size-11 rounded-full')} />
          <div className={cx(bar, 'h-4 flex-1')} />
        </div>
        <div className={cx(bar, 'h-64 rounded-2xl')} />
        <div className={cx(bar, 'h-28 rounded-2xl')} />
        <div className={cx(bar, 'h-20 rounded-2xl')} />
      </div>
    )
  }
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading {title}…</span>
      <div className="space-y-2">
        <div className={cx(bar, 'h-3 w-48')} />
        <div className={cx(bar, 'h-7 w-96 max-w-full')} />
        <div className={cx(bar, 'h-3 w-72 max-w-full')} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cx(bar, 'h-24 rounded-xl')} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className={cx(bar, 'h-80 rounded-xl')} />
        <div className={cx(bar, 'h-80 rounded-xl')} />
      </div>
    </div>
  )
}
