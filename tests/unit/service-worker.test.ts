import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"

import { describe, expect, it } from "vitest"

import { SERVICE_WORKER_CACHE_PREFIX, SKIP_WAITING_MESSAGE } from "@/lib/pwa/sw-config"

/**
 * public/sw.js run in a simulated service worker scope (node:vm with in-memory caches and a stub
 * network), to pin down its caching rules: the offline page and static files are cached; pages,
 * RSC payloads, /api and auth routes never are, so a shared phone keeps nobody's data.
 */

const ORIGIN = "https://app.test"
const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8")

type Handler = (event: unknown) => void

class MemoryCache {
  readonly entries = new Map<string, Response>()
  private key(request: Request | string) {
    return new URL(typeof request === "string" ? request : request.url, ORIGIN).href
  }
  async match(request: Request | string) {
    return this.entries.get(this.key(request))?.clone()
  }
  async put(request: Request | string, response: Response) {
    this.entries.set(this.key(request), response)
  }
  async add(request: string) {
    throw new Error(`unexpected add(${request})`)
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url))
  }
  async delete(request: Request | string) {
    return this.entries.delete(this.key(request))
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>()
  async open(name: string) {
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new MemoryCache()
      this.stores.set(name, cache)
    }
    return cache
  }
  async keys() {
    return [...this.stores.keys()]
  }
  async delete(name: string) {
    return this.stores.delete(name)
  }
  async match(request: Request | string, options?: { cacheName?: string }) {
    const names = options?.cacheName ? [options.cacheName] : [...this.stores.keys()]
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(request)
      if (hit) return hit
    }
    return undefined
  }
  /** Every cached URL path, across caches. */
  paths() {
    return [...this.stores.values()].flatMap((cache) =>
      [...cache.entries.keys()].map((url) => new URL(url).pathname),
    )
  }
}

const OFFLINE_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/_next/static/css/app-123.css"/>
<script src="/_next/static/chunks/main-abc.js" async></script></head>
<body><h1>You're offline</h1><script>self.__next_f.push([1,"\\"/_next/static/chunks/page-def.js\\""])</script></body></html>`

function basicResponse(body: string, init: ResponseInit = {}): Response {
  const response = new Response(body, { status: 200, ...init })
  // Node's Response reports type "default"; a browser's same-origin fetch is "basic".
  Object.defineProperty(response, "type", { value: "basic" })
  return response
}

const DAY_MS = 24 * 60 * 60 * 1000

function loadWorker(
  options: {
    online?: () => boolean
    /** The offline page the server answers right now (a later deploy's, say). */
    offlinePage?: () => { html: string; status?: number }
  } = {},
) {
  const handlers = new Map<string, Handler[]>()
  const caches = new MemoryCacheStorage()
  const requested: { url: string; init?: RequestInit }[] = []
  const online = options.online ?? (() => true)
  const offlinePage: () => { html: string; status?: number } =
    options.offlinePage ?? (() => ({ html: OFFLINE_HTML }))
  const clock = { now: Date.UTC(2026, 9, 5, 12) }
  class WorkerDate extends Date {
    static override now() {
      return clock.now
    }
  }
  const network = async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN)
    requested.push({ url: url.pathname + url.search, init })
    if (!online()) throw new TypeError("Failed to fetch")
    if (url.pathname === "/offline") {
      const page = offlinePage()
      // As `next start` sends it: compressed on the wire, decoded by fetch.
      return basicResponse(page.html, {
        status: page.status ?? 200,
        headers: { "Content-Encoding": "gzip", "Content-Length": "123" },
      })
    }
    if (url.pathname.endsWith(".css")) {
      return basicResponse("body{font-family:x;src:url(/_next/static/media/font-1.woff2)}")
    }
    if (url.pathname.startsWith("/app")) {
      return basicResponse("<html>Ada's private dashboard</html>", {
        headers: { "Cache-Control": "private, no-store" },
      })
    }
    return basicResponse(`content of ${url.pathname}`, {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    })
  }
  const preload = { enabled: true }
  const self = {
    location: new URL(ORIGIN),
    registration: {
      navigationPreload: {
        enable: async () => void (preload.enabled = true),
        disable: async () => void (preload.enabled = false),
      },
    },
    clients: { claim: async () => undefined },
    skipped: false,
    skipWaiting() {
      this.skipped = true
    },
    addEventListener(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
    },
  }
  const context = vm.createContext({
    self,
    caches,
    fetch: network,
    Response,
    Request,
    Headers,
    URL,
    Set,
    Promise,
    Math,
    Number,
    String,
    Date: WorkerDate,
    Error,
    TypeError,
  })
  vm.runInContext(source, context, { filename: "sw.js" })

  async function dispatch(type: string, extra: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    let responded: Promise<Response> | null = null
    const event = {
      ...extra,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (promise: Promise<Response>) => {
        responded = promise
      },
    }
    for (const handler of handlers.get(type) ?? []) handler(event)
    const response = responded ? await (responded as Promise<Response>) : null
    await Promise.all(pending)
    return response
  }

  return {
    caches,
    requested,
    self,
    preload,
    clock,
    install: () => dispatch("install", {}),
    activate: () => dispatch("activate", {}),
    message: (data: unknown) => dispatch("message", { data }),
    fetch: (
      url: string,
      init: { mode?: RequestMode; method?: string; headers?: HeadersInit } = {},
    ) => {
      const request = new Request(new URL(url, ORIGIN), {
        method: init.method ?? "GET",
        headers: init.headers,
      })
      // Node refuses `mode: "navigate"` in the constructor; browsers set it on page loads.
      Object.defineProperty(request, "mode", { value: init.mode ?? "cors" })
      return dispatch("fetch", { request })
    },
  }
}

const VERSION = /const VERSION = "(v\d+)"/.exec(source)?.[1] ?? "?"
const OFFLINE_CACHE = `app-offline-${VERSION}`
const STATIC_CACHE = `app-static-${VERSION}`

const OFFLINE_SNAPSHOT = [
  "/offline",
  "/_next/static/css/app-123.css",
  "/_next/static/chunks/main-abc.js",
  "/_next/static/chunks/page-def.js",
  "/_next/static/media/font-1.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
].sort()

/** Paths stored in one cache. */
function pathsIn(caches: MemoryCacheStorage, name: string): string[] {
  return [...(caches.stores.get(name)?.entries.keys() ?? [])].map((url) => new URL(url).pathname)
}

describe("service worker (public/sw.js)", () => {
  it("precaches the offline page without cookies, with its scripts, styles, fonts and icons", async () => {
    const worker = loadWorker()
    await worker.install()
    const offlineFetch = worker.requested.find((entry) => entry.url === "/offline")
    expect(offlineFetch?.init).toMatchObject({ credentials: "omit", cache: "no-store" })
    expect(worker.caches.paths().sort()).toEqual(OFFLINE_SNAPSHOT)
    // All of it in the offline cache, which is never trimmed.
    expect(pathsIn(worker.caches, OFFLINE_CACHE).sort()).toEqual(OFFLINE_SNAPSHOT)
    // The stored page is decoded text: no encoding or length of the network copy.
    const stored = await worker.caches.match("/offline", { cacheName: OFFLINE_CACHE })
    expect(stored?.headers.get("Content-Encoding")).toBeNull()
    expect(stored?.headers.get("Content-Length")).toBeNull()
    expect(await stored?.text()).toBe(OFFLINE_HTML)
  })

  it("keeps the offline page's files when the static cache is trimmed", async () => {
    let online = true
    const worker = loadWorker({ online: () => online })
    await worker.install()
    // A long-lived install: far more static files than the static cache keeps.
    for (let i = 0; i < 260; i++) await worker.fetch(`/_next/static/chunks/route-${i}.js`)
    expect(pathsIn(worker.caches, STATIC_CACHE)).toHaveLength(250)
    expect(pathsIn(worker.caches, STATIC_CACHE)).not.toContain("/_next/static/chunks/route-0.js")
    expect(pathsIn(worker.caches, OFFLINE_CACHE).sort()).toEqual(OFFLINE_SNAPSHOT)

    // Offline, the page and every file it needs still load (and the network is never asked).
    online = false
    const page = await worker.fetch("/app", { mode: "navigate" })
    expect(await page?.text()).toContain("You're offline")
    for (const asset of OFFLINE_SNAPSHOT.filter((path) => path !== "/offline")) {
      expect([asset, (await worker.fetch(asset))?.ok]).toEqual([asset, true])
    }
  })

  it("renews the offline snapshot in place once a day, after a navigation that went through", async () => {
    let deploy = 1
    const worker = loadWorker({
      offlinePage: () => ({
        html:
          deploy === 1
            ? OFFLINE_HTML
            : '<html><head><script src="/_next/static/chunks/main-new.js"></script></head><body><h1>You\'re offline (new)</h1></body></html>',
      }),
    })
    await worker.install()
    const offlineFetches = () => worker.requested.filter((entry) => entry.url === "/offline").length
    expect(offlineFetches()).toBe(1)

    // A deploy changes the offline page; within a day the snapshot stays (one fetch, at install).
    deploy = 2
    worker.clock.now += DAY_MS - 60_000
    await worker.fetch("/app", { mode: "navigate" })
    expect(offlineFetches()).toBe(1)

    // A day later, a navigation renews it: the new page and its files in, the old files out.
    worker.clock.now += 2 * 60_000
    await worker.fetch("/app", { mode: "navigate" })
    expect(offlineFetches()).toBe(2)
    expect(pathsIn(worker.caches, OFFLINE_CACHE).sort()).toEqual(
      [
        "/offline",
        "/_next/static/chunks/main-new.js",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/maskable-192.png",
        "/icons/maskable-512.png",
        "/icons/apple-touch-icon.png",
      ].sort(),
    )
    // Fresh for another day.
    await worker.fetch("/app/me", { mode: "navigate" })
    expect(offlineFetches()).toBe(2)
  })

  it("keeps the snapshot it has when renewing it fails", async () => {
    let status = 200
    const worker = loadWorker({ offlinePage: () => ({ html: OFFLINE_HTML, status }) })
    await worker.install()
    status = 500
    worker.clock.now += 2 * DAY_MS
    expect(await (await worker.fetch("/app", { mode: "navigate" }))?.text()).toContain("private")
    expect(pathsIn(worker.caches, OFFLINE_CACHE).sort()).toEqual(OFFLINE_SNAPSHOT)
  })

  it("serves navigations from the network and never stores them", async () => {
    const worker = loadWorker()
    await worker.install()
    const response = await worker.fetch("/app/audience", { mode: "navigate" })
    expect(await response?.text()).toContain("private dashboard")
    await worker.fetch("/app", { mode: "navigate" })
    await worker.fetch("/c/ada", { mode: "navigate" })
    expect(worker.caches.paths().filter((p) => !/^\/(_next\/static|icons)\//.test(p))).toEqual([
      "/offline",
    ])
  })

  it("falls back to the offline page, and only that, when the network is down", async () => {
    let online = true
    const worker = loadWorker({ online: () => online })
    await worker.install()
    online = false
    const response = await worker.fetch("/app/settings/profile", { mode: "navigate" })
    expect(await response?.text()).toContain("You're offline")
    // A static file already cached still loads; an uncached one fails like the network.
    expect(await (await worker.fetch("/icons/icon-192.png"))?.text()).toContain("icon-192")
    await expect(worker.fetch("/_next/static/chunks/other.js")).rejects.toThrow()
  })

  it("leaves /api, auth pages, RSC payloads and non-GET requests alone", async () => {
    const worker = loadWorker()
    await worker.install()
    expect(await worker.fetch("/api/auth/session")).toBeNull()
    expect(
      await worker.fetch("/api/oauth/youtube/callback?code=x", { mode: "navigate" }),
    ).toBeNull()
    expect(await worker.fetch("/sign-in", { mode: "navigate" })).toBeNull()
    expect(await worker.fetch("/sign-up?callbackUrl=%2Fapp", { mode: "navigate" })).toBeNull()
    expect(await worker.fetch("/app/audience?_rsc=1", { headers: { RSC: "1" } })).toBeNull()
    expect(await worker.fetch("/app", { mode: "navigate", method: "POST" })).toBeNull()
    expect(await worker.fetch("https://eu.i.posthog.com/e")).toBeNull()
    expect(
      await worker.fetch("/_next/static/chunks/x.js", { headers: { Range: "bytes=0-1" } }),
    ).toBeNull()
    expect(await worker.fetch("/sw.js")).toBeNull()
  })

  it("caches static files cache-first, but not private or no-store responses", async () => {
    const worker = loadWorker()
    await worker.fetch("/_next/static/chunks/app-1.js")
    const before = worker.requested.length
    expect(await (await worker.fetch("/_next/static/chunks/app-1.js"))?.text()).toContain("app-1")
    expect(worker.requested.length).toBe(before) // served from the cache
    expect(worker.caches.paths()).toContain("/_next/static/chunks/app-1.js")
  })

  it("names its caches and messages the way the page code expects", () => {
    expect(source).toContain(`const PREFIX = "${SERVICE_WORKER_CACHE_PREFIX}"`)
    expect(source).toContain(`event.data.type === "${SKIP_WAITING_MESSAGE.type}"`)
    expect(source).toMatch(/const VERSION = "v\d+"/)
  })

  it("activates on request and drops caches of older versions", async () => {
    const worker = loadWorker()
    await worker.caches.open("app-static-v0")
    await worker.caches.open("someone-else")
    await worker.install()
    await worker.activate()
    expect((await worker.caches.keys()).sort()).toEqual([OFFLINE_CACHE, "someone-else"].sort())
    // Navigation preload stays off: the browser would send it for /api navigations the worker
    // leaves alone, and fetch single-use magic links and OAuth callbacks twice.
    expect(worker.preload.enabled).toBe(false)
    expect(source).not.toContain("preloadResponse")
    expect(worker.self.skipped).toBe(false)
    await worker.message({ type: "SKIP_WAITING" })
    expect(worker.self.skipped).toBe(true)
  })
})
