import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  BookOpenCheck,
  FlaskConical,
  HardHat,
  Landmark,
  LayoutDashboard,
  Menu,
  Scale,
  SearchX,
  Smartphone,
  Stethoscope,
  X,
  type LucideIcon,
} from 'lucide-react'
import { DEFAULT_WORKER_ID, VIEWS, VIEW_META, pathFor, toHref, useRoute, type Route, type ViewId } from './router'
import { EmptyState, PhoneFrame, ZillMark, buttonClasses, cx } from './components'
import { Placeholder } from './views/Placeholder'

/** Props every routed view receives. */
export interface ViewProps {
  route: Route
}

export interface AppProps {
  /** Views by route id. A view not supplied here renders the Placeholder. */
  views?: Partial<Record<ViewId, ComponentType<ViewProps>>>
  /**
   * Simulation clock / status slot in the top bar: a node, or a render function receiving the current route. It sits on
   * the dark ink bar (text is white by default), so use light-on-dark styles such as the `inverse` Badge and Button.
   * Below the xl breakpoint it wraps to its own full-width row.
   */
  status?: ReactNode | ((route: Route) => ReactNode)
  /** Worker opened by the "Worker" navigation item when no worker route is active. */
  defaultWorkerId?: string
}

const VIEW_ICONS: Readonly<Record<ViewId, LucideIcon>> = {
  overview: LayoutDashboard,
  supervisor: HardHat,
  worker: Smartphone,
  medic: Stethoscope,
  regulator: Landmark,
  governance: Scale,
  lab: FlaskConical,
  evidence: BookOpenCheck,
}

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
 * Application shell: skip link, sticky top bar (brand, view switcher, status slot), routed main content and a
 * claims-discipline footer. The view table is ARCHITECTURE.md §9. Accessibility: one `<main>` landmark that receives focus
 * after each navigation (WCAG 2.2 SC 2.4.3 Focus Order), a per-view document title (SC 2.4.2 Page Titled), a skip link
 * (SC 2.4.1 Bypass Blocks) and `aria-current="page"` on the active view (SC 2.4.8 Location). Below the lg breakpoint the
 * switcher collapses into a menu with 48 px rows. The worker route renders full-bleed on phones and inside a PhoneFrame
 * from md up.
 */
export function App({ views = {}, status, defaultWorkerId = DEFAULT_WORKER_ID }: AppProps) {
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
  const View = route.id === 'not_found' ? undefined : views[route.id]

  let content: ReactNode
  if (route.id === 'not_found' || !meta) content = <NotFound path={route.path} />
  else if (View) content = <View route={route} />
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

      <header ref={headerRef} className="sticky top-0 z-40 bg-ink text-white shadow-sm">
        <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
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
              {/* Hidden between lg and xl so the eight-item switcher keeps headroom at 1024 px with wider system fonts. */}
              <span className="hidden text-xs text-white/70 sm:block lg:hidden xl:block">Heat-strain early warning</span>
            </span>
          </a>

          <nav aria-label="Views" className="hidden min-w-0 flex-1 lg:block">
            <ul className="flex items-center gap-0.5">
              {VIEWS.map((v) => {
                const Icon = VIEW_ICONS[v.id]
                const current = route.id === v.id
                return (
                  <li key={v.id}>
                    <a
                      href={hrefFor(v.id, workerId)}
                      aria-current={current ? 'page' : undefined}
                      className={cx(
                        'inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors focus-visible:outline-shade-light xl:px-2.5',
                        current
                          ? 'bg-white/10 text-white shadow-[inset_0_-2px_0_var(--color-shade-light)]'
                          : 'text-white/75 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <Icon aria-hidden size={16} />
                      {v.label}
                    </a>
                  </li>
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

          {statusNode !== undefined && statusNode !== null && (
            <div className="order-last flex w-full min-w-0 items-center gap-2 text-sm text-white xl:order-none xl:ms-auto xl:w-auto">
              {statusNode}
            </div>
          )}
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
                      className={cx(
                        'flex min-h-12 items-center gap-3 rounded-lg px-3 text-base font-medium focus-visible:outline-shade-light',
                        current ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <Icon aria-hidden size={20} />
                      <span className="min-w-0 flex-1">{v.label}</span>
                      {current && <span className="size-2 rounded-full bg-shade-light" aria-hidden />}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        )}
      </header>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={cx(
          'flex-1 outline-none',
          isWorker ? 'md:px-6 md:py-8' : 'mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        )}
      >
        {isWorker ? (
          <PhoneFrame label="Worker phone screen" caption={`Worker phone view · ${workerId} · simulated device`}>
            {content}
          </PhoneFrame>
        ) : (
          content
        )}
      </main>

      <footer className={cx('border-t border-line bg-surface', isWorker && 'hidden md:block')}>
        <div className="mx-auto flex max-w-[96rem] flex-col gap-1 px-4 py-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6 lg:px-8">
          <p>
            Zill is occupational-safety decision support. It does not diagnose illness and does not replace first aid
            or medical care.
          </p>
          <p className="shrink-0 font-semibold text-ink">Emergency: call 998 · cool first, transport second</p>
        </div>
      </footer>
    </div>
  )
}
