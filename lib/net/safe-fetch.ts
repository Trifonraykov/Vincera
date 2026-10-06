import { isIP } from "node:net"

import { isBlockedHostname, isPublicAddress } from "./ip"

/**
 * Fetching a URL a user typed, safely (CLAUDE.md §19.45; SSRF):
 *
 * - http and https only, default ports (80, 443) only, no user name or password in the URL;
 * - the host name is resolved first and **every** address must be public (lib/net/ip.ts); the
 *   connection then goes to that checked address (the transport pins it), so a DNS answer that
 *   changes between the check and the connection (rebinding) cannot reach an internal host;
 * - redirects are followed by hand, at most 3, and each target is checked the same way;
 * - one deadline for the whole fetch (5 s by default), a byte cap read from the stream (the
 *   `Content-Length` header is only a hint), and an allow-list of content types;
 * - a fixed, honest user agent.
 *
 * The network itself is a `NetTransport` (resolve + request), so tests and the fake services run
 * every rule above against recorded pages and fake DNS (lib/listings/fake/internet.ts).
 */

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 5_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
} as const

export const SAFE_FETCH_USER_AGENT =
  "VinceraBot/1.0 (+product listing import; https://github.com/Trifonraykov/Vincera)"

export type NetResponse = {
  status: number
  /** Lower-case header names. */
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array>
  /** Stop reading (aborts the socket). */
  cancel?: () => void
}

export type NetTransport = {
  /** Every address the host name resolves to. */
  resolve: (hostname: string) => Promise<string[]>
  /** One GET to `url`, connecting to `address` (already checked), no redirect following. */
  request: (input: {
    url: URL
    address: string
    headers: Record<string, string>
    signal: AbortSignal
  }) => Promise<NetResponse>
}

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_host"
  | "dns_failed"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "bad_status"
  | "bad_content_type"
  | "network"

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "SafeFetchError"
  }
}

export type SafeFetchOptions = {
  /** Allowed media types (lower case, no parameters), e.g. ["text/html"]. */
  accept: readonly string[]
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  /** Extra restriction on host names (e.g. Apple's image CDN only); checked on every hop. */
  allowHost?: (hostname: string) => boolean
  /** Sent as Accept. */
  acceptHeader?: string
}

export type SafeFetchResult = {
  /** The final URL after redirects. */
  url: URL
  status: number
  contentType: string
  /** The charset parameter of Content-Type, lower case, if any. */
  charset: string | null
  body: Uint8Array
}

const ALLOWED_PORTS = new Set(["", "80", "443"])

/** The URL, or a SafeFetchError("invalid_url" | "blocked_host") explaining why not. */
export function checkFetchableUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = typeof raw === "string" ? new URL(raw.trim()) : new URL(raw.href)
  } catch {
    throw new SafeFetchError("invalid_url", "That isn't a web address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", "Only http and https links can be imported.")
  }
  if (url.username || url.password) {
    throw new SafeFetchError("invalid_url", "Links with a user name or password can't be imported.")
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SafeFetchError("blocked_host", "Links to unusual ports can't be imported.")
  }
  const host = hostOf(url)
  if (isBlockedHostname(host)) {
    throw new SafeFetchError("blocked_host", "That address isn't on the public internet.")
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new SafeFetchError("blocked_host", "That address isn't on the public internet.")
  }
  url.hash = ""
  return url
}

/** The host name without IPv6 brackets. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "")
}

function mediaType(contentType: string | undefined): { type: string; charset: string | null } {
  const [type = "", ...params] = (contentType ?? "").split(";")
  const charset = params
    .map((p) => p.trim().toLowerCase())
    .find((p) => p.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"|"$/g, "")
  return { type: type.trim().toLowerCase(), charset: charset || null }
}

async function resolvePublic(
  transport: NetTransport,
  host: string,
  signal: AbortSignal,
): Promise<string> {
  if (isIP(host) !== 0) return host
  let addresses: string[]
  try {
    addresses = await Promise.race([
      transport.resolve(host),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    ])
  } catch (error) {
    if (signal.aborted) throw error
    throw new SafeFetchError("dns_failed", "We couldn't find that website.")
  }
  if (addresses.length === 0)
    throw new SafeFetchError("dns_failed", "We couldn't find that website.")
  // Every answer must be public: a host that resolves to one public and one private address
  // could otherwise be connected to the private one by a later lookup.
  if (!addresses.every((address) => isPublicAddress(address))) {
    throw new SafeFetchError("blocked_host", "That address isn't on the public internet.")
  }
  return addresses[0] as string
}

/** GET a user-supplied URL under the rules above. */
export async function safeFetch(
  rawUrl: string | URL,
  options: SafeFetchOptions,
  transport: NetTransport,
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs
  const maxBytes = options.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new SafeFetchError("timeout", "The website took too long to answer.")),
    timeoutMs,
  )
  try {
    return await fetchWithRedirects(rawUrl, options, transport, controller.signal, {
      maxBytes,
      maxRedirects,
    })
  } catch (error) {
    if (error instanceof SafeFetchError) throw error
    if (controller.signal.aborted && controller.signal.reason instanceof SafeFetchError) {
      throw controller.signal.reason
    }
    throw new SafeFetchError("network", "We couldn't reach that website.")
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithRedirects(
  rawUrl: string | URL,
  options: SafeFetchOptions,
  transport: NetTransport,
  signal: AbortSignal,
  limits: { maxBytes: number; maxRedirects: number },
): Promise<SafeFetchResult> {
  let url = checkFetchableUrl(rawUrl)
  for (let hop = 0; ; hop += 1) {
    const host = hostOf(url)
    if (options.allowHost && !options.allowHost(host)) {
      throw new SafeFetchError("blocked_host", "That address isn't allowed here.")
    }
    const address = await resolvePublic(transport, host, signal)
    const response = await transport.request({
      url,
      address,
      signal,
      headers: {
        "user-agent": SAFE_FETCH_USER_AGENT,
        accept: options.acceptHeader ?? options.accept.join(", "),
        "accept-encoding": "identity",
      },
    })

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      response.cancel?.()
      if (hop >= limits.maxRedirects) {
        throw new SafeFetchError("too_many_redirects", "The link redirects too many times.")
      }
      let next: URL
      try {
        next = new URL(response.headers.location, url)
      } catch {
        throw new SafeFetchError("invalid_url", "The website redirected to an invalid address.")
      }
      url = checkFetchableUrl(next)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      response.cancel?.()
      throw new SafeFetchError(
        "bad_status",
        `The website answered with an error (${response.status}).`,
        response.status,
      )
    }

    const { type, charset } = mediaType(response.headers["content-type"])
    if (!options.accept.includes(type)) {
      response.cancel?.()
      throw new SafeFetchError("bad_content_type", "That link isn't a web page we can read.")
    }
    const declared = Number(response.headers["content-length"])
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      response.cancel?.()
      throw new SafeFetchError("too_large", "That page is too large to import.")
    }

    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body) {
      if (signal.aborted) throw signal.reason
      total += chunk.byteLength
      if (total > limits.maxBytes) {
        response.cancel?.()
        throw new SafeFetchError("too_large", "That page is too large to import.")
      }
      chunks.push(chunk)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { url, status: response.status, contentType: type, charset, body }
  }
}

/** Decode a fetched page: the header's charset, else a `<meta charset>` near the top, else UTF-8. */
export function decodeBody(result: Pick<SafeFetchResult, "body" | "charset">): string {
  const sniffed =
    result.charset ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(
      new TextDecoder("latin1").decode(result.body.slice(0, 2048)),
    )?.[1]
  try {
    return new TextDecoder((sniffed ?? "utf-8").toLowerCase(), { fatal: false }).decode(result.body)
  } catch {
    return new TextDecoder("utf-8").decode(result.body)
  }
}
