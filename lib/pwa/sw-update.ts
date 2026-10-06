/**
 * Spotting a new service worker version that is ready to take over (the "Reload" prompt in
 * components/pwa/service-worker.tsx). Client-safe; typed on the few members it uses so tests can
 * pass plain EventTargets.
 *
 * A version can be found before the page starts watching: on a navigation the browser checks
 * `/sw.js` by itself, and `register()` on an existing registration resolves without a check. So
 * the watcher looks at all three places a new version can be: already waiting, still installing
 * (its `updatefound` has already fired), or found later (`updatefound`).
 */

export type WatchedWorker = {
  readonly state: ServiceWorkerState
  addEventListener(type: "statechange", listener: () => void): void
}

export type WatchedRegistration<W extends WatchedWorker> = {
  readonly waiting: W | null
  readonly installing: W | null
  addEventListener(type: "updatefound", listener: () => void): void
}

export function watchForUpdates<W extends WatchedWorker>(
  registration: WatchedRegistration<W>,
  options: {
    /** Whether a worker controls the page now (without one, "installed" is the first install). */
    hasController: () => boolean
    /** A new version is installed and waiting. May be called more than once for one worker. */
    onUpdate: (worker: W) => void
  },
): void {
  const offerIfInstalled = (worker: W) => {
    if (worker.state === "installed" && options.hasController()) options.onUpdate(worker)
  }
  const track = (worker: W) => {
    worker.addEventListener("statechange", () => offerIfInstalled(worker))
    offerIfInstalled(worker)
  }

  // Installed during an earlier visit (or just now) and waiting.
  if (registration.waiting && options.hasController()) options.onUpdate(registration.waiting)
  // Found before we started watching, still installing (its precache takes a while).
  if (registration.installing) track(registration.installing)
  // Found from now on.
  registration.addEventListener("updatefound", () => {
    if (registration.installing) track(registration.installing)
  })
}
