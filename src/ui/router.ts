/**
 * Zill hash router: a dependency-free router for the static, installable, offline-capable build. The prototype runs
 * entirely in the browser from any static path (ARCHITECTURE.md §3), so routing lives in the URL hash and needs no
 * server rewrite rules. The route table is the view table of ARCHITECTURE.md §9.
 *
 * Hash routing owns the fragment: in-page anchors such as `href="#section"` are not used anywhere in the app (they would
 * replace the route). Scroll to an element with `element.scrollIntoView()` instead.
 */
import {
  createElement,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ReactElement,
  type Ref,
} from 'react'

/** Identifier of each application view (ARCHITECTURE.md §9). */
export type ViewId = 'overview' | 'supervisor' | 'worker' | 'medic' | 'regulator' | 'governance' | 'lab' | 'evidence'

/** A resolved route: one of the views, or `not_found` for a path that matches no view. */
export type RouteId = ViewId | 'not_found'

/** Static description of one view: its URL pattern, navigation label, page title and purpose. */
export interface ViewMeta {
  id: ViewId
  /** Path pattern; `:name` segments become `params.name`. */
  pattern: string
  /** Short label for the view switcher. */
  label: string
  /** Page title (also used for `document.title`). */
  title: string
  /** One-sentence purpose, transcribed from ARCHITECTURE.md §9. */
  purpose: string
}

/** Path parameters required by each view; `undefined` for views without parameters. */
export interface RouteParamsMap {
  overview: undefined
  supervisor: undefined
  worker: { id: string }
  medic: undefined
  regulator: undefined
  governance: undefined
  lab: undefined
  evidence: undefined
}

/** Query-string input for {@link pathFor}; `null` and `undefined` entries are omitted. */
export type QueryInput = Readonly<Record<string, string | number | boolean | null | undefined>>

/** The current location, parsed from `window.location.hash`. */
export interface Route {
  id: RouteId
  /** Matched pattern (e.g. `/worker/:id`), or null when nothing matched. */
  pattern: string | null
  /** Normalised path without the query, e.g. `/worker/w-014` (segments stay percent-encoded). */
  path: string
  /** Decoded path parameters, e.g. `{ id: 'w-014' }`. */
  params: Readonly<Record<string, string>>
  /** Decoded query parameters from `#/path?key=value`. */
  query: Readonly<Record<string, string>>
}

/**
 * View table, transcribed from ARCHITECTURE.md §9 (routes and purposes). Keyed by id so the compiler checks that every
 * {@link ViewId} is described exactly once.
 */
export const VIEW_META: Readonly<Record<ViewId, ViewMeta>> = {
  overview: {
    id: 'overview',
    pattern: '/',
    label: 'Overview',
    title: 'Overview',
    purpose: 'The problem, how Zill works, and the live or replay status of the five Abu Dhabi sites.',
  },
  supervisor: {
    id: 'supervisor',
    pattern: '/supervisor',
    label: 'Supervisor',
    title: 'Supervisor console',
    purpose:
      'Crew board, site forecast strip, alert feed with acknowledgements, break and rotation planner, water logistics, and sensor and network health.',
  },
  worker: {
    id: 'worker',
    pattern: '/worker/:id',
    label: 'Worker',
    title: 'Worker phone',
    purpose:
      'Language, level card (pictogram, colour, text and voice), countdown, hydration, check-in, SOS, buddy and privacy.',
  },
  medic: {
    id: 'medic',
    pattern: '/medic',
    label: 'Medic',
    title: 'First aid and occupational health',
    purpose: 'Escalations, consented clinical trends, first-aid protocol and incident log.',
  },
  regulator: {
    id: 'regulator',
    pattern: '/regulator',
    label: 'Regulator',
    title: 'Regulator console',
    purpose: 'Multi-site aggregates with k-suppression, hours in each heat zone, and compliance.',
  },
  governance: {
    id: 'governance',
    pattern: '/governance',
    label: 'Governance',
    title: 'Governance centre',
    purpose:
      'Consent ledger, role × purpose matrix, audit-chain verifier, data-flow inspector and prohibited-purpose demo.',
  },
  lab: {
    id: 'lab',
    pattern: '/lab',
    label: 'Lab',
    title: 'Simulation lab',
    purpose: 'Scenario controls and live truth-versus-estimate charts.',
  },
  evidence: {
    id: 'evidence',
    pattern: '/evidence',
    label: 'Evidence',
    title: 'Evidence',
    purpose: 'Validation results with data provenance.',
  },
}

/** Views in navigation order (ARCHITECTURE.md §9 order). */
export const VIEW_ORDER: readonly ViewId[] = [
  'overview',
  'supervisor',
  'worker',
  'medic',
  'regulator',
  'governance',
  'lab',
  'evidence',
]

/** {@link VIEW_META} as an ordered list, for building navigation. */
export const VIEWS: readonly ViewMeta[] = VIEW_ORDER.map((id) => VIEW_META[id])

/**
 * Worker id used by the "Worker" navigation item before a specific worker has been opened. [ENG] The worker view
 * resolves an id it does not know (including this one) to a default worker of the selected crew.
 */
export const DEFAULT_WORKER_ID = 'demo'

const OVERVIEW_ROUTE: Route = { id: 'overview', pattern: '/', path: '/', params: {}, query: {} }

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Splits "#/a/b?x=1", "/a/b" or "a/b" into non-empty path segments and the raw query string. */
function splitTarget(target: string): { segments: string[]; search: string } {
  let raw = target.trim()
  if (raw.startsWith('#')) raw = raw.slice(1)
  const q = raw.indexOf('?')
  const pathPart = q >= 0 ? raw.slice(0, q) : raw
  const search = q >= 0 ? raw.slice(q + 1) : ''
  return { segments: pathPart.split('/').filter((s) => s.length > 0), search }
}

function patternSegments(pattern: string): string[] {
  return pattern.split('/').filter((s) => s.length > 0)
}

function matchSegments(pattern: readonly string[], path: readonly string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i]
    const got = path[i]
    if (want.startsWith(':')) {
      const value = safeDecode(got)
      if (value.length === 0) return null
      params[want.slice(1)] = value
    } else if (want !== got) {
      return null
    }
  }
  return params
}

/**
 * Matches one path against a pattern such as `/worker/:id`. Returns the decoded parameters, or null when the path does
 * not match. Pure; used by {@link parseHash}.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  return matchSegments(patternSegments(pattern), splitTarget(path).segments)
}

/**
 * Parses a location hash ("#/worker/w-014?lang=ar") into a {@link Route}. Pure, so it is unit-testable without a DOM.
 * An empty hash, or a hash that is not a route path (a legacy in-page anchor), resolves to the overview; a route path
 * that matches no view resolves to `not_found`.
 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith('/')) return OVERVIEW_ROUTE
  const { segments, search } = splitTarget(raw)
  const query: Record<string, string> = Object.fromEntries(new URLSearchParams(search))
  const path = `/${segments.join('/')}`
  for (const id of VIEW_ORDER) {
    const pattern = VIEW_META[id].pattern
    const params = matchSegments(patternSegments(pattern), segments)
    if (params) return { id, pattern, path, params, query }
  }
  return { id: 'not_found', pattern: null, path, params: {}, query }
}

function buildSearch(query: QueryInput | undefined): string {
  if (!query) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) sp.set(key, String(value))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

type PathArgs<K extends ViewId> = RouteParamsMap[K] extends undefined
  ? [params?: undefined, query?: QueryInput]
  : [params: RouteParamsMap[K], query?: QueryInput]

/**
 * Builds the path of a view, e.g. `pathFor('worker', { id: 'w-014' })` → `/worker/w-014` and
 * `pathFor('lab', undefined, { scenario: 'heatwave' })` → `/lab?scenario=heatwave`. Parameters are percent-encoded.
 * The parameter object is required exactly for views whose pattern has parameters (checked at compile time).
 */
export function pathFor<K extends ViewId>(id: K, ...args: PathArgs<K>): string {
  const [params, query] = args
  const lookup: Readonly<Record<string, string>> = params ?? {}
  const path = patternSegments(VIEW_META[id].pattern)
    .map((seg) => (seg.startsWith(':') ? encodeURIComponent(lookup[seg.slice(1)] ?? '') : seg))
    .join('/')
  return `/${path}${buildSearch(query)}`
}

/** Converts a path ("/supervisor", "#/supervisor" or "supervisor", with optional "?query") into an href ("#/supervisor"). */
export function toHref(to: string): string {
  const { segments, search } = splitTarget(to)
  return `#/${segments.join('/')}${search ? `?${search}` : ''}`
}

function samePath(a: string, b: string): boolean {
  return splitTarget(a).segments.join('/') === splitTarget(b).segments.join('/')
}

/**
 * Navigates to a path. With `replace`, the current history entry is replaced (no extra Back step) and listeners are
 * notified explicitly, because `history.replaceState` does not fire `hashchange`.
 */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return
  const href = toHref(to)
  if (options.replace) {
    window.history.replaceState(window.history.state, '', href)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else if (window.location.hash !== href) {
    window.location.hash = href
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const getHash = (): string => window.location.hash
const getServerHash = (): string => ''

/**
 * Subscribes to the current route. Uses `useSyncExternalStore` on the location hash, so every component sees the same
 * route in the same render (no tearing) and Back/Forward work through the browser's own history.
 */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getServerHash)
  return useMemo(() => parseHash(hash), [hash])
}

/** Props of {@link Link}: an anchor whose `href` is computed from `to`. */
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Target path, e.g. `pathFor('supervisor')` or "/worker/w-014". */
  to: string
  /** Overrides the computed current-page state (`aria-current="page"`); by default the paths are compared. */
  current?: boolean
  ref?: Ref<HTMLAnchorElement>
}

/**
 * In-app link. Renders a real anchor (`href="#/…"`), so open-in-new-tab, copy-link and keyboard activation work
 * natively, and marks the current page with `aria-current="page"` (WCAG 2.2 SC 2.4.8 Location; ARIA 1.2 aria-current).
 */
export function Link({ to, current, ...rest }: LinkProps): ReactElement {
  const route = useRoute()
  const isCurrent = current ?? samePath(route.path, to)
  return createElement('a', { ...rest, href: toHref(to), 'aria-current': isCurrent ? 'page' : undefined })
}
