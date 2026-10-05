/**
 * When the browser registers the service worker (public/sw.js). Client-safe.
 *
 * - `NEXT_PUBLIC_ENABLE_SW=1` turns it on anywhere (e.g. to try the offline page under
 *   `pnpm dev`); `NEXT_PUBLIC_ENABLE_SW=0` turns it off, also in production builds.
 * - Otherwise only production builds register it: under `next dev` chunks change on every edit,
 *   and a cache-first worker would keep serving old ones. Where it is off, the page unregisters a
 *   worker an earlier production run on the same origin left behind.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so changing the flag needs a rebuild.
 */
export function serviceWorkerEnabled({
  nodeEnv,
  flag,
}: {
  nodeEnv: string | undefined
  flag: string | undefined
}): boolean {
  const value = flag?.trim()
  if (value === "1") return true
  if (value === "0") return false
  return nodeEnv === "production"
}

export const SERVICE_WORKER_URL = "/sw.js"

/** public/sw.js names its caches `app-<kind>-<version>`; nothing else on the origin does. */
export const SERVICE_WORKER_CACHE_PREFIX = "app-"

/** The message a page posts to a waiting worker to activate it (the "Reload" prompt). */
export const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" } as const
