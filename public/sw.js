/*
 * Service worker for the installed app (CLAUDE.md §19, "Mobile app (PWA) patterns").
 * Hand-written and small on purpose. Registered by components/pwa/service-worker.tsx.
 *
 * What it does:
 * - Keeps a snapshot of the offline page (/offline, public and the same for everyone) with every
 *   static file it needs and the app icons, together in OFFLINE_CACHE, which is never trimmed: the
 *   snapshot always renders, even after a deploy removed its files from the server. The snapshot
 *   is taken at install and refreshed in place at most once a day, after a navigation that
 *   reached the network (files first, the page last, then the previous snapshot's files go).
 * - Serves /_next/static/* (content-hashed, immutable) and /icons/* cache-first, from the offline
 *   snapshot or STATIC_CACHE (at most MAX_STATIC_ENTRIES, oldest dropped first).
 * - Navigations are network-first; when the network fails, the offline page is the only fallback.
 *
 * What it must never do: cache /api/*, auth routes, or any HTML or data of a page, because pages
 * hold one person's data and phones get shared. Nothing a signed-in page renders is ever stored.
 *
 * Bump VERSION whenever this file changes in a way that needs fresh caches: the new worker
 * installs next to the old one, the app offers "Reload", and activation deletes the old caches.
 * (A changed offline page needs no bump: the daily refresh picks it up.)
 */
const VERSION = "v2"
const PREFIX = "app-"
const STATIC_CACHE = `${PREFIX}static-${VERSION}`
const OFFLINE_CACHE = `${PREFIX}offline-${VERSION}`
const OFFLINE_URL = "/offline"
const ICONS = [
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
]
/** Static files kept at most (oldest dropped first), so old deploys' chunks do not pile up. */
const MAX_STATIC_ENTRIES = 250
/** How old the offline snapshot may get before a navigation that reached the network renews it. */
const OFFLINE_REFRESH_MS = 24 * 60 * 60 * 1000
/** When the stored offline page was fetched (a header on the stored copy only). */
const PRECACHED_AT = "X-SW-Precached-At"
const STATIC_PATH = /^\/(?:_next\/static|icons)\//
const NEVER_CACHE_PATH = /^\/(?:api|sign-in|sign-up|sw\.js)(?:\/|$)/
const NEXT_STATIC_URL = /\/_next\/static\/[^"'\s<>()\\]+/g

self.addEventListener("install", (event) => {
  event.waitUntil(precache())
  // No skipWaiting() here: an update waits until the page says so (the "Reload" prompt), so a
  // page never runs against a newer worker it did not load with.
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, OFFLINE_CACHE])
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key)
      }
      // No navigation preload: the browser would also send it for navigations this worker leaves
      // to the network (/api/*), fetching single-use URLs such as magic links and OAuth callbacks
      // twice, and the second request fails.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable()
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET" || request.headers.has("range")) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || NEVER_CACHE_PATH.test(url.pathname)) return

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(event))
  } else if (STATIC_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(event))
  }
  // Everything else (RSC payloads, server actions, images, the manifest) goes to the network as
  // if there were no service worker, and is never stored.
})

/** Navigations: always the network. The response is never stored. */
async function networkFirst(event) {
  try {
    const response = await fetch(event.request)
    event.waitUntil(refreshOfflineIfStale())
    return response
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE })
    return (
      offline ||
      new Response("You're offline. Check your connection and try again.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    )
  }
}

/**
 * Content-hashed static files and icons: the offline snapshot or the static cache, else the
 * network (then stored in the static cache).
 */
async function cacheFirst(event) {
  const snapshot = await (await caches.open(OFFLINE_CACHE)).match(event.request)
  if (snapshot) return snapshot
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(event.request)
  if (cached) return cached
  const response = await fetch(event.request)
  if (isStorable(response)) {
    event.waitUntil(cache.put(event.request, response.clone()).then(() => trim(cache)))
  }
  return response
}

function isStorable(response) {
  if (!response.ok || response.type !== "basic" || response.redirected) return false
  const cacheControl = response.headers.get("Cache-Control") || ""
  return !/no-store|private/i.test(cacheControl)
}

async function trim(cache) {
  const keys = await cache.keys()
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STATIC_ENTRIES))) {
    await cache.delete(key)
  }
}

let refreshing = null

/** Renew the offline snapshot when it is older than OFFLINE_REFRESH_MS (one renewal at a time). */
async function refreshOfflineIfStale() {
  const stored = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE })
  const takenAt = Number(stored ? stored.headers.get(PRECACHED_AT) : 0) || 0
  if (stored && Date.now() - takenAt < OFFLINE_REFRESH_MS) return
  if (!refreshing) {
    refreshing = precache()
      .catch(() => undefined) // offline again, or a server error: keep the snapshot we have
      .finally(() => {
        refreshing = null
      })
  }
  await refreshing
}

/**
 * Snapshot the offline page and what it needs to render (its CSS, scripts and fonts), plus the
 * icons, into OFFLINE_CACHE. The files are stored before the page, so a stored page always has
 * its files; files of an earlier snapshot are deleted last. The page is fetched without cookies:
 * it is public, and must never hold anyone's data.
 */
async function precache() {
  const response = await fetch(OFFLINE_URL, { credentials: "omit", cache: "no-store" })
  if (!response.ok) throw new Error(`Offline page answered ${response.status}`)
  const html = await response.text()
  const cache = await caches.open(OFFLINE_CACHE)

  const assets = new Set([...ICONS, ...(html.match(NEXT_STATIC_URL) || [])])
  const store = async (asset) => {
    try {
      const assetResponse = await fetch(asset, { credentials: "omit" })
      if (!isStorable(assetResponse)) return
      await cache.put(asset, assetResponse.clone())
      if (asset.endsWith(".css")) {
        // Fonts and images the stylesheet points at.
        const css = await assetResponse.text()
        const nested = (css.match(NEXT_STATIC_URL) || []).filter((url) => !assets.has(url))
        for (const url of nested) assets.add(url)
        await Promise.all(nested.map(store))
      }
    } catch {
      // A missing asset only makes the offline page plainer; it never blocks the install.
    }
  }
  await Promise.all([...assets].map(store))

  // The body is the decoded text now: drop the network's encoding and length.
  const headers = new Headers(response.headers)
  for (const name of ["Content-Encoding", "Content-Length", "Transfer-Encoding"]) {
    headers.delete(name)
  }
  headers.set(PRECACHED_AT, String(Date.now()))
  await cache.put(
    OFFLINE_URL,
    new Response(html, { status: response.status, statusText: response.statusText, headers }),
  )

  const keep = new Set([OFFLINE_URL, ...assets].map(cacheKey))
  for (const request of await cache.keys()) {
    if (!keep.has(cacheKey(request.url))) await cache.delete(request)
  }
}

/** Path and query of a same-origin URL (how the caches tell entries apart). */
function cacheKey(url) {
  const parsed = new URL(url, self.location.origin)
  return parsed.pathname + parsed.search
}
