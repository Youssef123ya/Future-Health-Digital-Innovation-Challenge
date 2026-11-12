/// <reference types="vite-plugin-pwa/react" />
/**
 * Service-worker update prompt (vite-plugin-pwa `registerType: 'prompt'`, virtual:pwa-register/react). A stale cached
 * build must never be what a reviewer sees: when a new build is found within the first seconds of a page load, before the
 * person has interacted, the page switches to it at once; later it offers a reload toast instead of reloading under
 * someone mid-demo. The registration is re-checked every 30 minutes and whenever the tab becomes visible again. In the
 * dev server no service worker is registered and nothing renders.
 */
import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { CloudOff, RefreshCw, X } from 'lucide-react'
import { cx } from '../components'

/** A new build found this soon after load, before any interaction, is applied without asking. [ENG] */
export const AUTO_APPLY_WINDOW_MS = 8_000
/** Interval between update checks while the app stays open. [ENG] */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000

let interacted = false
if (typeof window !== 'undefined') {
  const mark = () => {
    interacted = true
  }
  window.addEventListener('pointerdown', mark, { once: true, capture: true })
  window.addEventListener('keydown', mark, { once: true, capture: true })
}

export function UpdatePrompt() {
  const loadedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const check = () => {
        if (registration.installing || !navigator.onLine) return
        registration.update().catch(() => undefined)
      }
      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
    onRegisterError(error) {
      console.warn('Zill service worker registration failed', error)
    },
  })

  useEffect(() => {
    if (!needRefresh) return
    const fresh = performance.now() - loadedAt.current < AUTO_APPLY_WINDOW_MS
    if (fresh && !interacted) void updateServiceWorker(true)
  }, [needRefresh, updateServiceWorker])

  useEffect(() => {
    if (!offlineReady) return
    const timer = window.setTimeout(() => setOfflineReady(false), 6_000)
    return () => window.clearTimeout(timer)
  }, [offlineReady, setOfflineReady])

  if (!needRefresh && !offlineReady) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 sm:justify-end">
      <div
        role="status"
        aria-live="polite"
        className={cx(
          'pointer-events-auto flex max-w-md items-start gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-2xl ring-1 ring-white/15',
          'motion-safe:animate-zill-fade-in',
        )}
      >
        {needRefresh ? (
          <RefreshCw aria-hidden size={18} className="mt-0.5 shrink-0 text-shade-light" />
        ) : (
          <CloudOff aria-hidden size={18} className="mt-0.5 shrink-0 text-shade-light" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{needRefresh ? 'A new version of Zill is ready' : 'Ready to work offline'}</p>
          <p className="mt-0.5 text-white/75">
            {needRefresh
              ? 'Reload to switch to it. The simulated scenario restarts from the address bar.'
              : 'The app, demo scenarios and validation data are cached on this device.'}
          </p>
          {needRefresh && (
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => void updateServiceWorker(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-semibold text-ink hover:bg-white/90 focus-visible:outline-shade-light"
              >
                <RefreshCw aria-hidden size={14} />
                Reload now
              </button>
              <button
                type="button"
                onClick={() => setNeedRefresh(false)}
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-white/80 hover:bg-white/10 focus-visible:outline-shade-light"
              >
                Later
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => (needRefresh ? setNeedRefresh(false) : setOfflineReady(false))}
          className="-me-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-shade-light"
        >
          <X aria-hidden size={16} />
        </button>
      </div>
    </div>
  )
}
