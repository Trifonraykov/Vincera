"use client"

import { useEffect } from "react"

import { ServiceWorkerRegistration } from "./service-worker"
import { startInstallListener } from "./use-install"

/**
 * The installed-app plumbing every layout with its own chrome mounts once (app and admin shell,
 * onboarding, marketing): the service worker with its update prompt, and the listener that keeps
 * Chrome's install event for the "Install the app" controls. Renders nothing. (The browser and
 * status bar colour, ThemeColorSync, is in the root layout: every page needs it.)
 */
export function PwaRuntime() {
  useEffect(() => startInstallListener(), [])

  return <ServiceWorkerRegistration />
}
