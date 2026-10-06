import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import type { NetResponse, NetTransport } from "@/lib/net/safe-fetch"
import { dataDir } from "@/lib/services"

import { fakePng } from "./png"

/**
 * The fake internet for listing imports (CLAUDE.md §19.3, §19.45): a `NetTransport` that answers
 * from recorded fixtures instead of the network, so the real `safeFetch` (every SSRF rule), the
 * real lookup parsing, page parsing, image sniffing and storage code all run.
 *
 * - **Apple:** `itunes.apple.com/lookup` answers from `tests/fixtures/appstore/developers.json`
 *   like the iTunes Lookup API (a developer id with `entity=software` → the artist wrapper and
 *   the apps; an app's trackId → that app; anything else → no results). `*.mzstatic.com` serves
 *   generated PNGs whose size is the `<w>x<h>bb` part of the path, like Apple's CDN.
 * - **Web:** `tests/fixtures/web/sites.json` lists fake DNS answers per host (some private, to
 *   test the SSRF rules) and responses per host and path: HTML files, generated images,
 *   redirects, a page over 2 MB and one that never finishes.
 * - **State** (`.data/fake-appstore/state.json`): apps "removed from the store" and verification
 *   codes "published" in an app's description (the fake developer console:
 *   `setFakeAppRemoved`, `publishFakeVerificationCode`, and the dev route
 *   `/api/dev/fake-appstore`). Files are read on every request, never cached in memory (§19.3).
 */

const APPLE_ADDRESS = ["17.253.144.10"]
const APPLE_CDN_ADDRESS = ["17.253.22.11"]

export function fixturesRoot(): string {
  return path.join(process.cwd(), "tests", "fixtures")
}

const developersSchema = z.object({
  developers: z.array(
    z.object({
      artist: z.object({ artistId: z.number(), artistName: z.string() }).passthrough(),
      apps: z.array(
        z
          .object({ trackId: z.number(), artistId: z.number(), description: z.string() })
          .passthrough(),
      ),
    }),
  ),
})
export type FakeDevelopers = z.infer<typeof developersSchema>["developers"]

const sitesSchema = z.object({
  hosts: z.record(z.string(), z.array(z.string())),
  routes: z.array(
    z.object({
      host: z.string(),
      path: z.string(),
      status: z.number().int().optional(),
      location: z.string().optional(),
      file: z.string().optional(),
      contentType: z.string().optional(),
      text: z.string().optional(),
      image: z
        .object({
          width: z.number(),
          height: z.number(),
          style: z.enum(["icon", "screenshot", "banner"]),
        })
        .optional(),
      special: z.enum(["huge", "slow"]).optional(),
    }),
  ),
})

const stateSchema = z.object({
  removed: z.array(z.string()).default([]),
  codes: z.record(z.string(), z.string()).default({}),
})
export type FakeAppStoreState = z.infer<typeof stateSchema>

export async function loadFakeDevelopers(root = fixturesRoot()): Promise<FakeDevelopers> {
  const raw = await readFile(path.join(root, "appstore", "developers.json"), "utf8")
  return developersSchema.parse(JSON.parse(raw)).developers
}

async function loadSites(root: string) {
  const raw = await readFile(path.join(root, "web", "sites.json"), "utf8")
  return sitesSchema.parse(JSON.parse(raw))
}

function statePath(stateRoot?: string): string {
  return path.join(stateRoot ?? dataDir("fake-appstore"), "state.json")
}

export async function readFakeAppStoreState(stateRoot?: string): Promise<FakeAppStoreState> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(statePath(stateRoot), "utf8")))
  } catch {
    return { removed: [], codes: {} }
  }
}

async function writeState(state: FakeAppStoreState, stateRoot?: string): Promise<void> {
  const file = statePath(stateRoot)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2))
  await rename(temp, file)
}

/** The fake developer console: take an app out of (or back into) the store. */
export async function setFakeAppRemoved(
  trackId: string,
  removed: boolean,
  stateRoot?: string,
): Promise<void> {
  const state = await readFakeAppStoreState(stateRoot)
  const set = new Set(state.removed)
  if (removed) set.add(trackId)
  else set.delete(trackId)
  await writeState({ ...state, removed: [...set] }, stateRoot)
}

/**
 * The fake developer console: put `code` into the description of the developer's first app (as a
 * builder would by shipping an update), so verification can find it.
 */
export async function publishFakeVerificationCode(
  developerId: string,
  code: string,
  stateRoot?: string,
): Promise<void> {
  const state = await readFakeAppStoreState(stateRoot)
  await writeState({ ...state, codes: { ...state.codes, [developerId]: code } }, stateRoot)
}

function textBody(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return (async function* () {
    yield bytes
  })()
}

function bytesBody(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes
  })()
}

function reply(
  status: number,
  contentType: string,
  body: AsyncIterable<Uint8Array>,
  extra: Record<string, string> = {},
): NetResponse {
  return { status, headers: { "content-type": contentType, ...extra }, body }
}

function notFound(): NetResponse {
  return reply(404, "text/html; charset=utf-8", textBody("<h1>Not found</h1>"))
}

async function appleLookup(url: URL, root: string, stateRoot?: string): Promise<NetResponse> {
  const developers = await loadFakeDevelopers(root)
  const state = await readFakeAppStoreState(stateRoot)
  const id = url.searchParams.get("id") ?? ""
  const software = url.searchParams.get("entity") === "software"
  const results: unknown[] = []
  for (const developer of developers) {
    const visible = developer.apps.filter((app) => !state.removed.includes(String(app.trackId)))
    const code = state.codes[String(developer.artist.artistId)]
    const withCode = visible.map((app, index) =>
      code && index === 0
        ? { ...app, description: `${app.description}\n\nVerification: ${code}` }
        : app,
    )
    if (String(developer.artist.artistId) === id) {
      results.push(developer.artist)
      if (software) results.push(...withCode)
    } else {
      const app = withCode.find((a) => String(a.trackId) === id)
      if (app) results.push(app)
    }
  }
  return reply(
    200,
    "text/javascript; charset=utf-8",
    textBody(JSON.stringify({ resultCount: results.length, results })),
  )
}

function appleImage(url: URL): NetResponse {
  const size = /\/(\d{2,4})x(\d{2,4})bb\.(png|jpg)$/.exec(url.pathname)
  if (!size) return notFound()
  const width = Number(size[1])
  const height = Number(size[2])
  const style = url.pathname.includes("/icon/") ? "icon" : "screenshot"
  // Seeded by the app's id and the image's position, so every app looks different.
  return reply(200, "image/png", bytesBody(fakePng({ seed: url.pathname, width, height, style })))
}

function abortable(signal: AbortSignal): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode("<!doctype html><title>Still loading")
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  })()
}

function huge(): AsyncIterable<Uint8Array> {
  const chunk = new TextEncoder().encode(`<p>${"x".repeat(64 * 1024)}</p>`)
  return (async function* () {
    for (let i = 0; i < 64; i += 1) yield chunk // 4 MB, never all needed
  })()
}

export type FakeInternetOptions = {
  /** `tests/fixtures` by default. */
  root?: string
  /** `.data/fake-appstore` by default. */
  stateRoot?: string
}

/** The fake network: DNS from the fixtures, responses from the fixtures. */
export function createFakeInternet(options: FakeInternetOptions = {}): NetTransport {
  const root = options.root ?? fixturesRoot()
  return {
    resolve: async (hostname) => {
      const host = hostname.toLowerCase()
      if (host === "itunes.apple.com") return APPLE_ADDRESS
      if (/(^|\.)mzstatic\.com$/.test(host)) return APPLE_CDN_ADDRESS
      const sites = await loadSites(root)
      const answers = sites.hosts[host]
      if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
      return answers
    },
    request: async ({ url, signal }) => {
      if (signal.aborted) throw signal.reason
      const host = url.hostname.toLowerCase()
      if (host === "itunes.apple.com") {
        return url.pathname === "/lookup" ? appleLookup(url, root, options.stateRoot) : notFound()
      }
      if (/(^|\.)mzstatic\.com$/.test(host)) return appleImage(url)

      const sites = await loadSites(root)
      const route = sites.routes.find((r) => r.host === host && r.path === url.pathname)
      if (!route) return notFound()
      if (route.location) {
        return reply(route.status ?? 302, "text/html", textBody(""), { location: route.location })
      }
      if (route.special === "slow") return reply(200, "text/html; charset=utf-8", abortable(signal))
      if (route.special === "huge") return reply(200, "text/html; charset=utf-8", huge())
      if (route.image) {
        const bytes = fakePng({
          seed: `${host}${url.pathname}`,
          width: route.image.width,
          height: route.image.height,
          style: route.image.style,
        })
        return reply(200, "image/png", bytesBody(bytes), { "content-length": String(bytes.length) })
      }
      if (route.file) {
        const html = await readFile(path.join(root, "web", path.basename(route.file)), "utf8")
        return reply(route.status ?? 200, route.contentType ?? "text/html; charset=utf-8", textBody(html))
      }
      return reply(route.status ?? 200, route.contentType ?? "text/plain", textBody(route.text ?? ""))
    },
  }
}
