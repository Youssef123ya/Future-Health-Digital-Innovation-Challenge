/**
 * Guided 2-minute demo overlay (mounted once by src/main.tsx, outside the routed views, so it survives navigation).
 * For each step (tourSteps.ts) it opens the screen, loads the peak-day replay if needed, sets the clock, puts the right
 * worker's phone in the demo, spotlights one element and shows a caption card with Back / Pause / Next. It auto-advances
 * after each step's time; the end card links into every full screen. Esc closes, ← and → step.
 *
 * Accessibility: the card is a non-modal dialog (the page stays usable), captions are announced politely, the
 * spotlight is decorative (pointer-events: none) and motion follows prefers-reduced-motion.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpenCheck, HardHat, MonitorPlay, Pause, Play, RotateCcw, Scale, Smartphone, X } from 'lucide-react'
import { useStore } from 'zustand'
import { simStore, uiStore } from '../../state'
import { navigate, parseHash, pathFor, toHref, useRoute } from '../router'
import { cx } from '../components'
import { phonePrefsStore, DEFAULT_PHONE_PREFS } from '../views/worker/phonePrefs'
import { TOUR_POLICY, TOUR_SCENARIO, TOUR_STEPS, tourSeconds, type TourStep } from './tourSteps'
import { goToStep, nextStep, previousStep, setTourPlaying, startTour, stopTour, tourStore } from './tourStore'

const reducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** Applies a step to the app: screen, scenario, phone, clock, then its action. Resolves when the screen is ready. */
async function enterStep(step: TourStep, isCurrent: () => boolean): Promise<void> {
  if (parseHash(window.location.hash).path !== step.path) navigate(step.path)
  // Let start-up finish loading the scenario named in the address first (bootstrap.ts), then take over the clock.
  await waitFor(() => {
    const st = simStore.getState()
    return st.status === 'loading' || st.status === 'idle' || st.jumping ? null : true
  }, 20000)
  if (!isCurrent()) return
  simStore.getState().pause()
  const s = simStore.getState()
  if (s.scenarioId !== TOUR_SCENARIO || (s.overrides.policy ?? TOUR_POLICY) !== TOUR_POLICY) {
    await s.loadScenario(TOUR_SCENARIO, { policy: TOUR_POLICY })
  }
  if (!isCurrent()) return
  if (step.phone) {
    const { workerId, lang } = step.phone
    uiStore.getState().setDeviceWorker(workerId)
    // Not persisted: the tour gives the phone choices back when it stops (tourStore snapshot).
    const byWorker = phonePrefsStore.getState().byWorker
    phonePrefsStore.setState({ byWorker: { ...byWorker, [workerId]: { ...DEFAULT_PHONE_PREFS, ...byWorker[workerId], lang } } })
  }
  if (step.at) await simStore.getState().jumpTo(step.at)
  if (!isCurrent()) return
  if (step.play) {
    simStore.getState().setSpeed(step.play)
    simStore.getState().play()
  }
  if (step.action === 'submit_prohibited_request') {
    // The governance screen's own form, first preset ("Employer HR asks for heart rate for a performance review").
    await waitFor(() => document.querySelector<HTMLFormElement>('#gov-request form'), 3000)
    if (!isCurrent()) return
    const form = document.querySelector<HTMLFormElement>('#gov-request form')
    const preset = form?.querySelector<HTMLButtonElement>('fieldset button')
    if (preset && preset.getAttribute('aria-pressed') !== 'true') preset.click()
    window.setTimeout(() => form?.requestSubmit(), 150)
  }
}

function waitFor<T>(get: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const tick = (): void => {
      const v = get()
      if (v) resolve(v)
      else if (performance.now() - t0 > timeoutMs) resolve(null)
      else window.setTimeout(tick, 80)
    }
    tick()
  })
}

/** Height of the app's sticky top bar (the first header in the document: src/ui/App.tsx). */
function appBarHeight(): number {
  return document.querySelector<HTMLElement>('#root header')?.getBoundingClientRect().height ?? 0
}

/** Nearest ancestor that scrolls vertically (a pane or the phone screen), or null for the page itself. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return null
}

/** Height of a sticky header at the top of a scroll container (the phone's own header), else 0. */
function stickyTop(scroller: HTMLElement): number {
  const h = scroller.querySelector<HTMLElement>('header')
  return h && getComputedStyle(h).position === 'sticky' ? h.getBoundingClientRect().height : 0
}

/**
 * Brings the target into view: first inside its own scroll container (below that container's sticky header), then in
 * the page (below the app bar) — centred when it fits, top-aligned when it is taller than the space left by the card.
 */
function revealTarget(selector: string | null): void {
  if (!selector) return
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return
  const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth'
  const inner = scrollParent(el)
  if (inner) {
    const top = el.getBoundingClientRect().top - inner.getBoundingClientRect().top + inner.scrollTop - stickyTop(inner) - 8
    inner.scrollTo({ top: Math.max(0, top), behavior })
  }
  const anchor = (inner ? (inner.parentElement?.closest<HTMLElement>('section, figure, [data-tour]') ?? inner) : el) as HTMLElement
  const r = anchor.getBoundingClientRect()
  const bar = appBarHeight()
  // On narrow screens the caption card spans the width at the bottom: fit the target in the space above it.
  const card = window.innerWidth < 900 ? (document.querySelector('[data-tour-card]')?.getBoundingClientRect().height ?? 0) + 16 : 0
  const room = window.innerHeight - bar - card - 24
  const offset = r.height <= room ? (room - r.height) / 2 : 12
  window.scrollTo({ top: Math.max(0, window.scrollY + r.top - bar - offset), behavior })
}

/** The part of a rectangle visible through its scroll containers, the viewport and below the app bar. */
function visibleRect(el: HTMLElement): DOMRect | null {
  let { left, top, right, bottom } = el.getBoundingClientRect()
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
    const pr = p.getBoundingClientRect()
    left = Math.max(left, pr.left)
    top = Math.max(top, pr.top)
    right = Math.min(right, pr.right)
    bottom = Math.min(bottom, pr.bottom)
  }
  top = Math.max(top, appBarHeight())
  left = Math.max(left, 0)
  right = Math.min(right, window.innerWidth)
  bottom = Math.min(bottom, window.innerHeight)
  return right - left > 8 && bottom - top > 8 ? new DOMRect(left, top, right - left, bottom - top) : null
}

/** Visible rectangle of the spotlight target, tracked through scrolling, resizing and re-renders. */
function useTargetRect(selector: string | null, enabled: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!enabled || !selector) {
      setRect(null)
      return
    }
    let raf = 0
    let last = ''
    const measure = (): void => {
      const el = document.querySelector<HTMLElement>(selector)
      const r = el ? visibleRect(el) : null
      const key = r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}` : ''
      if (key !== last) {
        last = key
        setRect(r)
      }
      raf = window.requestAnimationFrame(measure)
    }
    measure()
    return () => window.cancelAnimationFrame(raf)
  }, [selector, enabled])
  return rect
}

export function GuidedTour() {
  const route = useRoute()
  const { active, index, playing, ended, rev } = useStore(tourStore)
  const step = TOUR_STEPS[index] ?? TOUR_STEPS[0]!
  const [ready, setReady] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const titleId = useId()

  // `#/…?tour=1` starts the tour (README and video link).
  const autostarted = useRef(false)
  useEffect(() => {
    if (autostarted.current || route.query.tour !== '1') return
    autostarted.current = true
    startTour(Number(route.query.step ?? 1) - 1 || 0)
  }, [route.query.tour, route.query.step])

  // Enter the step (screen, scenario, phone, clock), then spotlight it.
  useEffect(() => {
    if (!active || ended) return
    let current = true
    setReady(false)
    setElapsed(0)
    void enterStep(step, () => current)
      .catch((e: unknown) => console.error('Guided demo step failed', e))
      .then(() => (step.target ? waitFor(() => document.querySelector(step.target as string), 4000) : null))
      .finally(() => {
        if (!current) return
        // Let the screen settle (lazy view chunk, charts, the jump's last frame) before scrolling to the target.
        window.setTimeout(() => {
          if (!current) return
          revealTarget(step.target)
          setReady(true)
        }, 350)
      })
    return () => {
      current = false
    }
    // rev re-enters the same step on Back/Replay
  }, [active, ended, index, rev, step])

  // Auto-advance while playing.
  useEffect(() => {
    if (!active || ended || !ready || !playing) return
    const started = performance.now() - elapsed * 1000
    const id = window.setInterval(() => {
      const s = (performance.now() - started) / 1000
      if (s >= step.seconds) {
        window.clearInterval(id)
        nextStep()
      } else setElapsed(s)
    }, 100)
    return () => window.clearInterval(id)
    // elapsed is read once at (re)start so a pause resumes where it stopped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ended, ready, playing, index, rev, step.seconds])

  // Keyboard: Esc closes, arrows step (not while typing in a field).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') stopTour()
      else if (e.key === 'ArrowRight') nextStep()
      else if (e.key === 'ArrowLeft') previousStep()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active])

  const rect = useTargetRect(step.target, active && !ended && ready)
  if (!active) return null

  const pad = 8
  const cardOnRight = rect ? rect.left + rect.width / 2 < window.innerWidth / 2 : false

  return (
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[55] rounded-2xl ring-4 ring-shade-light transition-[top,left,width,height] duration-300 motion-reduce:transition-none"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 100vmax rgba(11, 18, 32, 0.45)',
          }}
        />
      )}
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-tour-card
        lang="en"
        dir="ltr"
        className={cx(
          'fixed bottom-4 z-[60] w-[min(27rem,calc(100vw-2rem))] rounded-2xl bg-ink text-white shadow-2xl ring-1 ring-white/15 motion-safe:animate-zill-fade-in',
          cardOnRight ? 'right-4' : 'left-4',
        )}
      >
        {ended ? <EndCard titleId={titleId} /> : <StepCard titleId={titleId} step={step} index={index} playing={playing} ready={ready} elapsed={elapsed} />}
      </div>
    </>
  )
}

function StepCard({ titleId, step, index, playing, ready, elapsed }: { titleId: string; step: TourStep; index: number; playing: boolean; ready: boolean; elapsed: number }) {
  const total = TOUR_STEPS.length
  const last = index === total - 1
  return (
    <div className="p-3 sm:p-4">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-white/70 uppercase">
        <MonitorPlay size={15} aria-hidden className="text-shade-light" />
        <span>
          Guided demo · {index + 1} of {total}
        </span>
        <button type="button" onClick={stopTour} aria-label="Close the guided demo" className="ms-auto grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 focus-visible:outline-shade-light">
          <X size={18} aria-hidden />
        </button>
      </div>
      <div aria-live="polite">
        <h2 id={titleId} className="mt-1 text-base leading-snug font-semibold sm:text-lg">
          {step.title}
        </h2>
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-white/85 sm:line-clamp-none sm:text-sm">{step.caption}</p>
      </div>
      <p className="mt-2.5 hidden items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/85 sm:inline-flex">
        <span className="font-semibold text-shade-light">Criterion {step.criterion.n}</span>
        {step.criterion.label}
      </p>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/15" aria-hidden>
        <div className="h-full rounded-full bg-shade-light" style={{ width: `${ready ? Math.min(100, (elapsed / step.seconds) * 100) : 0}%` }} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <TourButton onClick={previousStep} disabled={index === 0} label="Back" icon={<ArrowLeft size={16} aria-hidden />} />
        <TourButton
          onClick={() => setTourPlaying(!playing)}
          label={playing ? 'Pause' : 'Play'}
          icon={playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
          pressed={!playing}
        />
        <button
          type="button"
          onClick={nextStep}
          className="ms-auto inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-ink hover:bg-white/90 focus-visible:outline-shade-light"
        >
          {last ? 'Finish' : 'Next'}
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
      <ol className="mt-3 hidden flex-wrap gap-1.5 sm:flex" aria-label="Steps">
        {TOUR_STEPS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => goToStep(i)}
              aria-label={`Step ${i + 1}: ${s.title}`}
              aria-current={i === index ? 'step' : undefined}
              className={cx('block h-2 rounded-full transition-all focus-visible:outline-shade-light', i === index ? 'w-6 bg-shade-light' : i < index ? 'w-2 bg-white/60' : 'w-2 bg-white/25')}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}

function TourButton({ onClick, label, icon, disabled, pressed }: { onClick: () => void; label: string; icon: ReactNode; disabled?: boolean; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-white ring-1 ring-white/25 hover:bg-white/10 focus-visible:outline-shade-light disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  )
}

function EndCard({ titleId }: { titleId: string }) {
  const links: { href: string; label: string; icon: ReactNode }[] = [
    { href: toHref(pathFor('demo')), label: 'Live demo', icon: <MonitorPlay size={16} aria-hidden /> },
    { href: toHref(pathFor('worker', { id: 'demo' })), label: 'Worker phone', icon: <Smartphone size={16} aria-hidden /> },
    { href: toHref(pathFor('supervisor')), label: 'Supervisor', icon: <HardHat size={16} aria-hidden /> },
    { href: toHref(pathFor('governance')), label: 'Governance', icon: <Scale size={16} aria-hidden /> },
    { href: toHref(pathFor('evidence')), label: 'Evidence', icon: <BookOpenCheck size={16} aria-hidden /> },
  ]
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-white/70 uppercase">
        <MonitorPlay size={15} aria-hidden className="text-shade-light" />
        <span>Guided demo · done</span>
        <button type="button" onClick={stopTour} aria-label="Close the guided demo" className="ms-auto grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 focus-visible:outline-shade-light">
          <X size={18} aria-hidden />
        </button>
      </div>
      <h2 id={titleId} className="mt-1 text-lg font-semibold">
        That was Zill in about {Math.round(tourSeconds() / 60)} minutes
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-white/85">
        Every screen is live: play the clock, switch phones and languages, acknowledge alerts, revoke a consent and watch
        what the console stops receiving.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-2">
        {links.map((l) => (
          <li key={l.label}>
            <a
              href={l.href}
              onClick={stopTour}
              className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-white ring-1 ring-white/20 hover:bg-white/10 focus-visible:outline-shade-light"
            >
              {l.icon}
              {l.label}
            </a>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => startTour(0)}
            className="flex h-10 w-full items-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold text-ink hover:bg-white/90 focus-visible:outline-shade-light"
          >
            <RotateCcw size={16} aria-hidden />
            Replay
          </button>
        </li>
      </ul>
    </div>
  )
}
