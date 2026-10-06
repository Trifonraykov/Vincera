"use client"

import { useEffect } from "react"
import { toast } from "sonner"

import {
  SERVICE_WORKER_CACHE_PREFIX,
  SERVICE_WORKER_URL,
  serviceWorkerEnabled,
  SKIP_WAITING_MESSAGE,
} from "@/lib/pwa/sw-config"
import { watchForUpdates } from "@/lib/pwa/sw-update"

const UPDATE_TOAST_ID = "app-update"

/**
 * Registers the service worker (public/sw.js) and runs the update flow: when a new version has
 * installed and is waiting, a toast offers "Reload"; accepting activates it and reloads the page,
 * so a page never runs against a worker it did not load with. Checks for a new version whenever
 * the app comes back to the foreground. Renders nothing.
 *
 * Mounted by the app/admin shell, onboarding and marketing layouts. Registration happens only in
 * production builds or with NEXT_PUBLIC_ENABLE_SW=1 (lib/pwa/sw-config.ts).
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    const enabled = serviceWorkerEnabled({
      nodeEnv: process.env.NODE_ENV,
      flag: process.env.NEXT_PUBLIC_ENABLE_SW,
    })
    if (!("serviceWorker" in navigator)) return
    if (!enabled) {
      // A worker left by a production run on the same origin (e.g. `docker compose up`, then
      // `pnpm dev` on the same port) would keep serving that build's static files.
      void removeServiceWorker()
      return
    }

    let updateRequested = false
    let registration: ServiceWorkerRegistration | null = null

    // The first install also takes control of the page (clients.claim()); only reload when the
    // person asked for the new version.
    const onControllerChange = () => {
      if (updateRequested) window.location.reload()
    }

    const offerUpdate = (worker: ServiceWorker) => {
      toast("A new version of the app is ready.", {
        id: UPDATE_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Reload",
          onClick: () => {
            updateRequested = true
            worker.postMessage(SKIP_WAITING_MESSAGE)
          },
        },
      })
    }

    // Waiting already, still installing, or found later (lib/pwa/sw-update.ts). With a
    // controller, "installed" means an update waiting; without one, it is the first install.
    const watch = (reg: ServiceWorkerRegistration) =>
      watchForUpdates(reg, {
        hasController: () => navigator.serviceWorker.controller !== null,
        onUpdate: offerUpdate,
      })

    const checkForUpdate = () => {
      if (document.visibilityState === "visible") registration?.update().catch(() => undefined)
    }

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
    document.addEventListener("visibilitychange", checkForUpdate)
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg
        watch(reg)
      })
      .catch(() => {
        // No offline page and no update prompt, but the app works the same without them.
      })

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
      document.removeEventListener("visibilitychange", checkForUpdate)
    }
  }, [])

  return null
}

/** Unregisters our worker and drops its caches (when the worker is switched off). */
async function removeServiceWorker() {
  try {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      const worker = registration.active ?? registration.waiting ?? registration.installing
      if (worker && new URL(worker.scriptURL).pathname === SERVICE_WORKER_URL) {
        await registration.unregister()
      }
    }
    for (const key of await caches.keys()) {
      if (key.startsWith(SERVICE_WORKER_CACHE_PREFIX)) await caches.delete(key)
    }
  } catch {
    // Nothing registered, or storage is blocked: nothing to remove.
  }
}
