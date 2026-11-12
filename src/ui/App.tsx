import { Fragment, Suspense, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  BookOpenCheck,
  FlaskConical,
  HardHat,
  Landmark,
  LayoutDashboard,
  Menu,
  MonitorPlay,
  Scale,
  SearchX,
  Smartphone,
  Stethoscope,
  X,
  type LucideIcon,
} from 'lucide-react'
import { DEFAULT_WORKER_ID, VIEWS, VIEW_META, pathFor, toHref, useRoute, type Route, type ViewId } from './router'
import { EmptyState, PhoneFrame, Tooltip, ZillMark, buttonClasses, cx } from './components'
import { Placeholder } from './views/Placeholder'
import { SiteFooter } from './shell/SiteFooter'
import { ViewBoundary, ViewSkeleton } from './shell/ViewBoundary'

/** Props every routed view receives. */
export interface ViewProps {
  route: Route
}

export interface AppProps {
  /** Views by route id. A view not supplied here renders the Placeholder. */
  views?: Partial<Record<ViewId, ComponentType<ViewProps>>>
  /**
   * Simulation clock / status slot: a node, or a render function receiving the current route. It renders as the second
   * row of the dark ink top bar (text is white by default), so use light-on-dark styles such as the `inverse` Badge and
   * Button.
   */
  status?: ReactNode | ((route: Route) => ReactNode)
  /** Worker opened by the "Worker" navigation item when no worker route is active. */
  defaultWorkerId?: string
  /** Rendered beside the worker phone frame from lg up (the presenter's list of demo phones). */
  workerAside?: (route: Route) => ReactNode
  /** Called when a navigation entry is hovered or focused, so the screen's code can start downloading. */
  prefetch?: (id: ViewId) => void
}

const VIEW_ICONS: Readonly<Record<ViewId, LucideIcon>> = {
  demo: MonitorPlay,
  overview: LayoutDashboard,
  supervisor: HardHat,
  worker: Smartphone,
  medic: Stethoscope,
  regulator: Landmark,
  governance: Scale,
  lab: FlaskConical,
  evidence: BookOpenCheck,
}

/** Views that open a new group in the switcher: presenter · operational roles · reviewer tools. */
const GROUP_STARTS: ReadonlySet<ViewId> = new Set<ViewId>(['overview', 'lab'])

/** Routes laid out at presentation width (the split-screen demo). */
const WIDE_ROUTES: ReadonlySet<ViewId> = new Set<ViewId>(['demo'])

function hrefFor(id: ViewId, workerId: string): string {
  return toHref(id === 'worker' ? pathFor('worker', { id: workerId }) : pathFor(id))
}

function NotFound({ path }: { path: string }) {
  return (
    <EmptyState
      icon={SearchX}
      title="Page not found"
      description={
        <>
          There is no view at <code className="font-mono text-ink">{path}</code>.
        </>
      }
      action={
        <a href={toHref('/')} className={buttonClasses({ variant: 'primary' })}>
          Go to overview
        </a>
      }
    />
  )
}

/**
 * Application shell: skip link, sticky two-row top bar (brand and role-aware view switcher; the simulation clock),
 * routed main content and the site footer. The view table is ARCHITECTURE.md §9 plus the presenter's live demo.
 * Accessibility: one `<main>` landmark that receives focus after each navigation (WCAG 2.2 SC 2.4.3 Focus Order), a
 * per-view document title (SC 2.4.2 Page Titled), a skip link (SC 2.4.1 Bypass Blocks) and `aria-current="page"` on the
 * active view (SC 2.4.8 Location). Each switcher entry names who the view is for (tooltip on desktop, second line in the
 * menu). Below the lg breakpoint the switcher collapses into a menu with 48 px rows. The worker route renders full-bleed
 * on phones and inside a PhoneFrame from md up; the demo route uses presentation width.
 */
export function App({ views = {}, status, defaultWorkerId = DEFAULT_WORKER_ID, workerAside, prefetch }: AppProps) {
  const route = useRoute()
  const menuId = useId()
  const mainRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const previousPath = useRef<string | null>(null)
  // The menu is open only for the path on which it was opened, so any navigation (link, Back, Forward) closes it.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === route.path

  const meta = route.id === 'not_found' ? null : VIEW_META[route.id]
  const workerId = route.id === 'worker' ? route.params.id : defaultWorkerId

  useEffect(() => {
    document.title = `${meta ? meta.title : 'Page not found'} · Zill`
    if (previousPath.current !== null && previousPath.current !== route.path) {
      window.scrollTo({ top: 0 })
      mainRef.current?.focus({ preventScroll: true })
    }
    previousPath.current = route.path
  }, [route.path, meta])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpenAt(null)
        menuButtonRef.current?.focus()
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !headerRef.current?.contains(e.target)) setMenuOpenAt(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [menuOpen])

  const statusNode = typeof status === 'function' ? status(route) : status
  const isWorker = route.id === 'worker'
  const wide = route.id !== 'not_found' && WIDE_ROUTES.has(route.id)
  const frame = wide ? 'max-w-[120rem]' : 'max-w-[96rem]'
  const View = route.id === 'not_found' ? undefined : views[route.id]

  let content: ReactNode
  if (route.id === 'not_found' || !meta) content = <NotFound path={route.path} />
  else if (View)
    content = (
      // One boundary per screen, reset on navigation: a crash in one screen never blanks the app.
      <ViewBoundary key={route.id} title={meta.title}>
        <Suspense fallback={<ViewSkeleton title={meta.title} variant={route.id === 'worker' ? 'phone' : 'page'} />}>
          <View route={route} />
        </Suspense>
      </ViewBoundary>
    )
  else
    content = (
      <Placeholder
        route={route}
        title={meta.title}
        purpose={meta.purpose}
        icon={VIEW_ICONS[route.id]}
        showGallery={route.id === 'overview'}
      />
    )

  return (
    <div className="flex min-h-full flex-col">
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only z-50 rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-lg focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        Skip to main content
      </button>

      <header ref={headerRef} lang="en" className="sticky top-0 z-40 bg-ink text-white shadow-sm">
        <div className={cx('mx-auto flex items-center gap-x-3 px-4 py-2 sm:px-6 lg:px-8', frame)}>
          <a
            href={toHref('/')}
            aria-label="Zill, heat-strain early warning: overview"
            className="flex shrink-0 items-center gap-2.5 rounded-lg py-1 pe-2 focus-visible:outline-shade-light"
          >
            <ZillMark size={32} />
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight">
                Zill
                <span lang="ar" dir="rtl" className="ms-1.5 font-normal text-white/70">
                  ظل
                </span>
              </span>
              {/* Hidden from lg to 2xl so the nine-entry switcher keeps headroom with wider system fonts. */}
              <span className="hidden text-xs text-white/70 sm:block lg:hidden 2xl:block">Heat-strain early warning</span>
            </span>
          </a>

          <nav aria-label="Views" className="hidden min-w-0 flex-1 lg:block">
            <ul className="flex items-center gap-0.5">
              {VIEWS.map((v) => {
                const Icon = VIEW_ICONS[v.id]
                const current = route.id === v.id
                return (
                  <Fragment key={v.id}>
                    {GROUP_STARTS.has(v.id) && <li aria-hidden className="mx-1.5 h-5 w-px bg-white/15" />}
                    <li>
                      <Tooltip
                        side="bottom"
                        align="start"
                        className="ring-1 ring-white/20"
                        content={
                          <>
                            <span className="block font-semibold">{v.audience}</span>
                            {v.purpose}
                          </>
                        }
                      >
                        <a
                          href={hrefFor(v.id, workerId)}
                          aria-current={current ? 'page' : undefined}
                          onPointerEnter={() => prefetch?.(v.id)}
                          onFocus={() => prefetch?.(v.id)}
                          className={cx(
                            'inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-shade-light xl:px-2.5',
                            current
                              ? 'bg-white/10 text-white shadow-[inset_0_-2px_0_var(--color-shade-light)]'
                              : v.id === 'demo'
                                ? 'text-white hover:bg-white/5'
                                : 'text-white/75 hover:bg-white/5 hover:text-white',
                          )}
                        >
                          <Icon aria-hidden size={16} className={v.id === 'demo' ? 'text-shade-light' : 'hidden xl:block'} />
                          {v.label}
                        </a>
                      </Tooltip>
                    </li>
                  </Fragment>
                )
              })}
            </ul>
          </nav>

          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpenAt(menuOpen ? null : route.path)}
            className="ms-auto inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-white hover:bg-white/10 focus-visible:outline-shade-light lg:hidden"
          >
            {menuOpen ? <X aria-hidden size={20} /> : <Menu aria-hidden size={20} />}
            {meta ? meta.label : 'Menu'}
            <span className="sr-only">, open view menu</span>
          </button>
        </div>

        {menuOpen && (
          <nav id={menuId} aria-label="Views" className="border-t border-white/10 lg:hidden">
            <ul className="mx-auto grid max-w-[96rem] gap-1 px-4 py-3 sm:grid-cols-2 sm:px-6">
              {VIEWS.map((v) => {
                const Icon = VIEW_ICONS[v.id]
                const current = route.id === v.id
                return (
                  <li key={v.id}>
                    <a
                      href={hrefFor(v.id, workerId)}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => setMenuOpenAt(null)}
                      onFocus={() => prefetch?.(v.id)}
                      className={cx(
                        'flex min-h-12 items-center gap-3 rounded-lg px-3 py-1.5 text-base font-medium focus-visible:outline-shade-light',
                        current ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <Icon aria-hidden size={20} className={v.id === 'demo' ? 'text-shade-light' : undefined} />
                      <span className="min-w-0 flex-1">
                        <span className="block">{v.label}</span>
                        <span className="block text-xs font-normal text-white/70">{v.audience}</span>
                      </span>
                      {current && <span className="size-2 rounded-full bg-shade-light" aria-hidden />}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        )}

        {statusNode !== undefined && statusNode !== null && (
          <div className="border-t border-white/10 bg-white/[0.03]">
            <div className={cx('mx-auto px-4 py-1.5 text-sm text-white sm:px-6 lg:px-8', frame)}>{statusNode}</div>
          </div>
        )}
      </header>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={cx(
          'flex-1 outline-none',
          isWorker
            ? 'md:px-6 md:py-8'
            : wide
              ? 'mx-auto w-full max-w-[120rem] px-3 py-4 sm:px-4 lg:px-6'
              : 'mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        )}
      >
        {isWorker ? (
          <div className="md:flex md:items-start md:justify-center md:gap-8">
            <PhoneFrame label="Worker phone screen" caption={`Worker phone view · ${workerId} · simulated device`}>
              <div className="zill-phone contents">{content}</div>
            </PhoneFrame>
            {workerAside?.(route)}
          </div>
        ) : (
          content
        )}
      </main>

      <SiteFooter className={isWorker ? 'hidden md:block' : undefined} />
    </div>
  )
}
