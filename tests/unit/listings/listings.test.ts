import { readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { parseAppStoreInput, storefront } from "@/lib/listings/app-store/link"
import { parseLookup } from "@/lib/listings/app-store/lookup"
import { appToDraft } from "@/lib/listings/app-store/mapping"
import { toListingCard } from "@/lib/listings/cards"
import { createFakeInternet } from "@/lib/listings/fake/internet"
import { fakePng } from "@/lib/listings/fake/png"
import { sniffImage } from "@/lib/listings/image-sniff"
import { cleanLine, cleanParagraphs, taglineOf, topicsFrom } from "@/lib/listings/text"
import { fallbackVisual, initialsOf } from "@/lib/listings/visual"
import { listingKeyForUrl, pageToDraft } from "@/lib/listings/web/mapping"
import { parseWebPage } from "@/lib/listings/web/parse"
import { embeddedIpv4, isBlockedHostname, isPublicAddress } from "@/lib/net/ip"
import {
  checkFetchableUrl,
  safeFetch,
  SafeFetchError,
  type NetResponse,
  type NetTransport,
} from "@/lib/net/safe-fetch"

/** Listing imports, pure parts (CLAUDE.md §19.45). */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures")

describe("App Store links", () => {
  it.each([
    [
      "https://apps.apple.com/us/developer/pinecone-labs/id1500000001",
      "developer",
      "1500000001",
      "us",
    ],
    ["apps.apple.com/gb/app/recipe-box/id6460000201?mt=8", "app", "6460000201", "gb"],
    ["https://itunes.apple.com/de/artist/x/id42", "developer", "42", "de"],
    ["https://apps.apple.com/developer/foo/id7", "developer", "7", null],
    ["1500000001", "developer", "1500000001", null],
    ["id1500000001", "developer", "1500000001", null],
  ])("parses %s", (raw, kind, id, country) => {
    expect(parseAppStoreInput(raw)).toEqual({ kind, id, country })
  })

  it.each([
    "",
    "https://example.com/developer/x/id1",
    "https://apps.apple.com.evil.example/us/app/x/id1",
    "javascript:alert(1)",
    "https://apps.apple.com/us/app/no-id",
    "ftp://apps.apple.com/us/app/x/id1",
  ])("refuses %s", (raw) => {
    expect(parseAppStoreInput(raw)).toBeNull()
  })

  it("falls back to the US storefront", () => {
    expect(storefront(null, "XX1", "GB")).toBe("gb")
    expect(storefront(undefined)).toBe("us")
  })
})

describe("App Store lookup and mapping", () => {
  async function developerResponse() {
    const raw = JSON.parse(
      await readFile(path.join(FIXTURES, "appstore", "developers.json"), "utf8"),
    )
    const developer = raw.developers[0]
    return {
      resultCount: 5,
      results: [developer.artist, ...developer.apps, { wrapperType: "software", trackId: "x" }],
    }
  }

  it("keeps the artist and every app that parses, dropping odd results", async () => {
    const parsed = parseLookup(await developerResponse())
    expect(parsed.artist?.artistName).toBe("Pinecone Labs")
    expect(parsed.apps).toHaveLength(4)
  })

  it("refuses a body that is not a lookup answer", () => {
    expect(() => parseLookup({ nope: true })).toThrow(/can't read/)
  })

  it("maps an app to a live app listing with Apple images only", async () => {
    const parsed = parseLookup(await developerResponse())
    const app = {
      ...parsed.apps[0]!,
      screenshotUrls: [...(parsed.apps[0]!.screenshotUrls ?? []), "https://evil.example/x.png"],
    }
    const draft = appToDraft(app, "us")
    expect(draft).toMatchObject({
      source: "app_store",
      format: "app",
      stage: "live",
      targetPriceCents: null,
    })
    expect(draft.images[0]?.kind).toBe("icon")
    expect(
      draft.images.every((image) => new URL(image.url).hostname.endsWith("mzstatic.com")),
    ).toBe(true)
    expect(draft.images.length).toBeLessThanOrEqual(6)
    expect(draft.topics).toContain("productivity")
    expect(draft.meta).toMatchObject({ kind: "app_store", priceLabel: "Free", rating: 4.7 })
  })

  it("uses a euro price for matching only on euro storefronts", async () => {
    const parsed = parseLookup(await developerResponse())
    const paid = parsed.apps.find((app) => (app.price ?? 0) > 0)!
    expect(appToDraft({ ...paid, currency: "EUR", price: 2.99 }, "de").targetPriceCents).toBe(299)
  })
})

describe("web page metadata", () => {
  it("reads Open Graph, JSON-LD, icons and the canonical link", async () => {
    const html = await readFile(path.join(FIXTURES, "web", "tasktide.html"), "utf8")
    const page = parseWebPage(html, new URL("https://tasktide.example/"))
    expect(page.title).toContain("TaskTide")
    expect(page.images[0]).toBe("https://cdn.tasktide.example/og/cover-1200x630.png")
    expect(page.icons[0]).toBe("https://tasktide.example/apple-touch-icon.png")
    expect(page.canonical).toBe("https://tasktide.example/")
    expect(page.structured).toMatchObject({
      type: "software",
      price: 9,
      priceCurrency: "EUR",
      rating: 4.8,
      ratingCount: 212,
    })
  })

  it("falls back to <title> and the meta description, and survives broken JSON-LD", () => {
    const page = parseWebPage(
      `<html><head><title> Plain  page </title><meta name="description" content="Does a thing."><script type="application/ld+json">{oops</script><link rel="icon" href="/fav.png"></head></html>`,
      new URL("https://plain.example/a/"),
    )
    expect(page.title).toBe("Plain  page")
    expect(page.description).toBe("Does a thing.")
    expect(page.icons).toEqual(["https://plain.example/fav.png"])
    expect(page.structured.type).toBeNull()
  })

  it("never keeps script or javascript: URLs", () => {
    const page = parseWebPage(
      `<meta property="og:image" content="javascript:alert(1)"><title>x</title>`,
      new URL("https://x.example/"),
    )
    expect(page.images).toEqual([])
  })

  it("keys listings by the link without tracking parameters", () => {
    expect(listingKeyForUrl(new URL("https://Shop.Example/a/?utm_source=x&id=2#top"))).toBe(
      "https://shop.example/a?id=2",
    )
  })

  it("maps a page to a listing", async () => {
    const html = await readFile(path.join(FIXTURES, "web", "templatehouse.html"), "utf8")
    const url = new URL("https://shop.templatehouse.example/notion/creator-content-calendar")
    const draft = pageToDraft({ page: parseWebPage(html, url), requestedUrl: url, finalUrl: url })
    expect(draft).toMatchObject({ source: "web", format: "template" })
    expect(draft.description.length).toBeGreaterThan(10)
  })
})

describe("text from other people's pages", () => {
  it("strips tags, control and bidi characters and collapses whitespace", () => {
    expect(cleanLine("  Hi <b>there</b>‮\u0000  you ", 50)).toBe("Hi there you")
    expect(cleanParagraphs("a\r\n\r\n\r\n\r\nb", 50)).toBe("a\n\nb")
    expect(cleanLine("x".repeat(30), 10)?.length).toBeLessThanOrEqual(10)
  })

  it("makes the hook from the first sentence, without Markdown marks", () => {
    expect(taglineOf("• Plans your week with a **single list**. More text.")).toBe(
      "Plans your week with a single list.",
    )
    expect(taglineOf("Keeps snake_case_names intact.")).toBe("Keeps snake_case_names intact.")
    expect(taglineOf(null)).toBeNull()
  })

  it("normalises topics like the rest of the platform", () => {
    expect(topicsFrom(["Health & Fitness", "#Productivity", "productivity", "a@b.c"])).toEqual([
      "health & fitness",
      "productivity",
    ])
  })
})

describe("the generated cover", () => {
  it("is deterministic and different per listing", () => {
    const a = fallbackVisual({ id: "1", title: "Focus Garden" })
    expect(fallbackVisual({ id: "1", title: "Focus Garden" })).toEqual(a)
    expect(fallbackVisual({ id: "2", title: "Focus Garden" }).gradient).not.toBe(a.gradient)
    expect(a.initials).toBe("FG")
    expect(a.gradient).toMatch(/^linear-gradient\(\d+deg, hsl\(/)
  })

  it.each([
    ["Focus Garden: Pomodoro Timer", "FG"],
    ["tasktide", "T"],
    ["Élan vital", "EV"],
    ["!!!", "•"],
  ])("initials of %s", (title, initials) => {
    expect(initialsOf(title)).toBe(initials)
  })

  it("cards fall back to it and mark unverified App Store listings", () => {
    const card = toListingCard({
      id: "00000000-0000-0000-0000-000000000001",
      title: "Pantry Planner",
      description: "Plans **meals**. Then more.",
      tagline: null,
      format: "app",
      source: "app_store",
      sourceMeta: null,
      media: [],
      builderUserId: "u",
      builderHandle: "b",
      builderDisplayName: "B",
      builderAppStoreVerified: false,
    })
    expect(card).toMatchObject({
      cover: null,
      icon: null,
      hook: "Plans meals.",
      unverified: true,
      tag: "App",
    })
  })
})

describe("images", () => {
  it("sniffs real bytes, never the declared type", () => {
    expect(sniffImage(fakePng({ seed: "x", width: 40, height: 30, style: "icon" }))).toMatchObject({
      contentType: "image/png",
      width: 40,
      height: 30,
    })
    expect(
      sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).toBeNull()
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe("image/jpeg")
  })
})

describe("SSRF guard: addresses", () => {
  it.each([
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fd00::5",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fd00:ec2::254",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(["93.184.215.31", "17.253.144.10", "2606:4700::1111", "[2606:4700::1111]"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )

  it("reads IPv4 embedded in IPv6 forms", () => {
    expect(embeddedIpv4("::ffff:10.0.0.1")).toBe("10.0.0.1")
    expect(embeddedIpv4("2002:a00:1::")).toBe("10.0.0.1")
    expect(embeddedIpv4("2606:4700::1")).toBeNull()
  })

  it("blocks local host names whatever DNS says", () => {
    for (const host of [
      "localhost",
      "a.localhost",
      "printer.local",
      "db.internal",
      "x.home.arpa",
    ]) {
      expect(isBlockedHostname(host)).toBe(true)
    }
    expect(isBlockedHostname("example.com")).toBe(false)
  })

  it.each([
    ["ftp://example.com/", "invalid_url"],
    ["https://user:pw@example.com/", "invalid_url"],
    ["https://example.com:8080/", "blocked_host"],
    ["http://127.0.0.1/", "blocked_host"],
    ["http://[::1]/", "blocked_host"],
    ["http://localhost/", "blocked_host"],
  ])("refuses %s before any network", (url, code) => {
    expect(() => checkFetchableUrl(url)).toThrow(SafeFetchError)
    try {
      checkFetchableUrl(url)
    } catch (error) {
      expect((error as SafeFetchError).code).toBe(code)
    }
  })
})

function body(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return (async function* () {
    yield bytes
  })()
}

function reply(status: number, headers: Record<string, string>, text = ""): NetResponse {
  return { status, headers, body: body(text) }
}

describe("SSRF guard: safeFetch", () => {
  const html = { accept: ["text/html"] as const }

  it("connects to the address it checked, not to a second DNS answer (rebinding)", async () => {
    let lookups = 0
    const connected: string[] = []
    const transport: NetTransport = {
      // First answer public, any later answer private: a rebinding DNS server.
      resolve: async () => (lookups++ === 0 ? ["93.184.215.31"] : ["127.0.0.1"]),
      request: async ({ address }) => {
        connected.push(address)
        return reply(200, { "content-type": "text/html" }, "<title>ok</title>")
      },
    }
    await safeFetch("https://rebind.example/", { accept: [...html.accept] }, transport)
    expect(lookups).toBe(1)
    expect(connected).toEqual(["93.184.215.31"])
  })

  it("re-checks every redirect target, including after DNS", async () => {
    const transport: NetTransport = {
      resolve: async (host) => (host === "public.example" ? ["93.184.215.31"] : ["10.0.0.7"]),
      request: async ({ url }) =>
        url.hostname === "public.example"
          ? reply(302, { location: "https://inside.example/admin" })
          : reply(200, { "content-type": "text/html" }, "secret"),
    }
    await expect(
      safeFetch("https://public.example/", { accept: [...html.accept] }, transport),
    ).rejects.toMatchObject({ code: "blocked_host" })
  })

  it("refuses a redirect straight to the metadata address", async () => {
    const transport = createFakeInternet()
    await expect(
      safeFetch("https://metadata-redirect.example/", { accept: ["text/html"] }, transport),
    ).rejects.toMatchObject({ code: "blocked_host" })
  })

  it("follows at most 3 redirects", async () => {
    let hops = 0
    const transport: NetTransport = {
      resolve: async () => ["93.184.215.31"],
      request: async () => {
        hops += 1
        return reply(301, { location: `/hop-${hops}` })
      },
    }
    await expect(
      safeFetch("https://loop.example/", { accept: ["text/html"] }, transport),
    ).rejects.toMatchObject({ code: "too_many_redirects" })
    expect(hops).toBe(4)
  })

  it("follows a short chain to a public page (fake web)", async () => {
    const result = await safeFetch(
      "https://go.tasktide.example/",
      { accept: ["text/html"] },
      createFakeInternet(),
    )
    expect(result.url.href).toBe("https://tasktide.example/")
  })

  it("caps the body while reading, whatever Content-Length says", async () => {
    await expect(
      safeFetch("https://huge.example/", { accept: ["text/html"] }, createFakeInternet()),
    ).rejects.toMatchObject({ code: "too_large" })
  })

  it("times out", async () => {
    vi.useFakeTimers()
    try {
      const pending = safeFetch(
        "https://slow.example/",
        { accept: ["text/html"], timeoutMs: 5000 },
        createFakeInternet(),
      ).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5100)
      expect(await pending).toMatchObject({ code: "timeout" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses other content types and hosts outside an allow-list", async () => {
    await expect(
      safeFetch("https://pdf.example/", { accept: ["text/html"] }, createFakeInternet()),
    ).rejects.toMatchObject({ code: "bad_content_type" })
    await expect(
      safeFetch(
        "https://tasktide.example/",
        { accept: ["text/html"], allowHost: (host) => host.endsWith("mzstatic.com") },
        createFakeInternet(),
      ),
    ).rejects.toMatchObject({ code: "blocked_host" })
  })

  it("refuses hosts with any private DNS answer", async () => {
    for (const url of [
      "https://mixed-answers.example/",
      "https://ipv6-private.example/",
      "https://mapped-loopback.example/",
    ]) {
      await expect(
        safeFetch(url, { accept: ["text/html"] }, createFakeInternet()),
      ).rejects.toMatchObject({ code: "blocked_host" })
    }
  })
})
