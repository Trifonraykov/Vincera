"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  installMethod,
  iosBrowser,
  isStandalone,
  type BeforeInstallPromptEvent,
  type InstallMethod,
  type IosBrowser,
} from "@/lib/pwa/install"

/**
 * Browser-side install state, shared by every install control on the page. Chrome fires
 * `beforeinstallprompt` once per page load, possibly before the card that uses it mounts, so the
 * listener starts with the shell (`startInstallListener` from PwaRuntime) and keeps the event here.
 */
type InstallSnapshot = { event: BeforeInstallPromptEvent | null; installed: boolean }

let snapshot: InstallSnapshot = { event: null, installed: false }
let started = false
const listeners = new Set<() => void>()

function update(next: InstallSnapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

export function startInstallListener() {
  if (started || typeof window === "undefined") return
  started = true
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the browser's own mini-infobar away; the app offers installing itself.
    event.preventDefault()
    update({ ...snapshot, event: event as BeforeInstallPromptEvent })
  })
  window.addEventListener("appinstalled", () => update({ event: null, installed: true }))
}

function subscribe(listener: () => void) {
  startInstallListener()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => snapshot
const serverSnapshot: InstallSnapshot = { event: null, installed: false }
const getServerSnapshot = () => serverSnapshot

/** The environment never changes during a page view; read once on the client. */
function subscribeNever() {
  return () => undefined
}
/** Running from the home screen, an iOS browser (which one), or anything else. */
type Environment = "standalone" | "not_ios" | IosBrowser
function environment(): Environment {
  const nav = navigator as Navigator & { standalone?: boolean }
  if (isStandalone(window.matchMedia?.bind(window), nav.standalone)) return "standalone"
  return iosBrowser(nav.userAgent, nav.maxTouchPoints ?? 0) ?? "not_ios"
}

/**
 * How the app can be installed here, and `install()` for the "prompt" method (opens the browser's
 * own dialog; resolves to whether the person accepted). Server renders and the first client render
 * say "unavailable", so install UI never causes a hydration mismatch.
 */
export function useInstall(): {
  method: InstallMethod
  /** The iOS browser, for wording the Add to Home Screen steps (null elsewhere). */
  iosBrowser: Exclude<IosBrowser, "in_app"> | null
  install: () => Promise<boolean>
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const env = useSyncExternalStore<Environment | null>(subscribeNever, environment, () => null)
  const ios = env === null || env === "standalone" || env === "not_ios" ? null : env

  const method: InstallMethod =
    env === null
      ? "unavailable"
      : installMethod({
          standalone: env === "standalone",
          installed: state.installed,
          hasPromptEvent: state.event !== null,
          ios,
        })

  const install = useCallback(async () => {
    const event = snapshot.event
    if (!event) return false
    // The event can prompt once; whatever the answer, it is used up.
    update({ ...snapshot, event: null })
    await event.prompt()
    const choice = await event.userChoice
    if (choice.outcome === "accepted") update({ event: null, installed: true })
    return choice.outcome === "accepted"
  }, [])

  return { method, iosBrowser: ios === "in_app" ? null : ios, install }
}
