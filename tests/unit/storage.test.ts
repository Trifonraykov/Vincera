import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { contentDisposition, isValidKey, sanitizeFilename, storageKey } from "@/lib/storage/keys"
import { formatBytes, normalizeMimeType, validateUpload } from "@/lib/storage/limits"
import { createLocalStorage } from "@/lib/storage/local"
import { buildSignedUrl, verifySignedRequest, type SignedRequest } from "@/lib/storage/signing"

import { stubServiceEnv, TEST_AUTH_SECRET } from "../helpers/service-env"

const SECRET = "s".repeat(40)
const NOW = new Date("2026-03-01T12:00:00.000Z")
const nowSec = Math.floor(NOW.getTime() / 1000)

// The dev route resolves `.data/` through lib/services; point it at a temp dir per test.
const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const path = await import("node:path")
  return { dataDir: (...segments: string[]) => path.join(dataRoot.dir, ...segments) }
})

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "storage-test-"))
  setClockForTests(NOW)
})

afterEach(async () => {
  setClockForTests(null)
  await rm(dataRoot.dir, { recursive: true, force: true })
})

function params(url: string): { key: string; search: URLSearchParams } {
  const parsed = new URL(url)
  const key = decodeURIComponent(parsed.pathname.replace("/api/dev/storage/", ""))
  return { key, search: parsed.searchParams }
}

describe("signed URLs", () => {
  const get: SignedRequest = { op: "get", key: "a/b.zip", exp: nowSec + 60, filename: "b.zip" }
  const put: SignedRequest = {
    op: "put",
    key: "uploads/x.png",
    exp: nowSec + 60,
    contentType: "image/png",
    maxBytes: 1000,
  }

  it("round-trips GET and PUT requests", () => {
    for (const request of [get, put]) {
      const { key, search } = params(buildSignedUrl("http://localhost:3000", request, SECRET))
      const method = request.op === "get" ? "GET" : "PUT"
      expect(verifySignedRequest(key, method, search, SECRET, NOW.getTime())).toEqual({
        ok: true,
        request,
      })
    }
  })

  it("rejects tampering, the wrong secret, the wrong method and expiry", () => {
    const { key, search } = params(buildSignedUrl("http://localhost:3000", get, SECRET))
    const at = NOW.getTime()

    expect(verifySignedRequest("a/other.zip", "GET", search, SECRET, at)).toMatchObject({
      reason: "signature",
    })
    const renamed = new URLSearchParams(search)
    renamed.set("filename", "evil.exe")
    expect(verifySignedRequest(key, "GET", renamed, SECRET, at)).toMatchObject({
      reason: "signature",
    })
    expect(verifySignedRequest(key, "GET", search, "x".repeat(40), at)).toMatchObject({
      reason: "signature",
    })
    expect(verifySignedRequest(key, "PUT", search, SECRET, at)).toMatchObject({ reason: "method" })
    expect(verifySignedRequest(key, "GET", search, SECRET, at + 61_000)).toMatchObject({
      reason: "expired",
    })
    expect(verifySignedRequest(key, "GET", new URLSearchParams(), SECRET, at)).toMatchObject({
      reason: "malformed",
    })
  })
})

describe("keys and limits", () => {
  it("accepts app-built keys and rejects traversal or odd characters", () => {
    expect(isValidKey("launches/0189/files/abc-report.pdf")).toBe(true)
    for (const bad of ["", "/abs", "a/../b", "a//b", "a/", "../x", "a b", "a\\b", "ü.txt"]) {
      expect(isValidKey(bad)).toBe(false)
    }
    expect(() => storageKey("a", "..", "b")).toThrow()
  })

  it("sanitizes file names for keys and builds safe download headers", () => {
    expect(sanitizeFilename("../../My Résumé (final).PDF")).toBe("My-Resume-final.PDF")
    expect(sanitizeFilename("???")).toBe("file")
    expect(contentDisposition('naïve "plan".pdf')).toBe(
      `attachment; filename="na_ve _plan_.pdf"; filename*=UTF-8''na%C3%AFve%20%22plan%22.pdf`,
    )
  })

  it("enforces §14 MIME allow-lists and size limits", () => {
    expect(
      validateUpload("deliverable", {
        contentType: "application/zip",
        sizeBytes: 200 * 1024 * 1024,
      }),
    ).toEqual({ ok: true, contentType: "application/zip" })
    expect(
      validateUpload("deliverable", {
        contentType: "application/zip",
        sizeBytes: 200 * 1024 * 1024 + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size" })
    expect(
      validateUpload("attachment", {
        contentType: "image/PNG; charset=binary",
        sizeBytes: 25 * 1024 * 1024,
      }),
    ).toEqual({ ok: true, contentType: "image/png" })
    expect(
      validateUpload("attachment", { contentType: "image/png", sizeBytes: 25 * 1024 * 1024 + 1 }),
    ).toMatchObject({ ok: false, reason: "size", message: expect.stringContaining("25 MB") })
    expect(validateUpload("attachment", { contentType: "text/html", sizeBytes: 10 })).toMatchObject(
      { ok: false, reason: "type" },
    )
    expect(validateUpload("image", { contentType: "image/svg+xml", sizeBytes: 10 })).toMatchObject({
      ok: false,
      reason: "type",
    })
    expect(validateUpload("image", { contentType: "image/png", sizeBytes: 0 })).toMatchObject({
      ok: false,
      reason: "empty",
    })
    expect(normalizeMimeType(" Text/Plain ; charset=utf-8")).toBe("text/plain")
    expect(formatBytes(1536)).toBe("1.5 KB")
  })
})

describe("local storage fake", () => {
  beforeEach(() => stubServiceEnv({ FAKE_SERVICES: "all" }))

  it("stores, reads, stats and deletes objects", async () => {
    const storage = createLocalStorage(dataRoot.dir)
    expect(await storage.getObject("a/b.txt")).toBeNull()

    await storage.putObject("a/b.txt", "hello", "text/plain; charset=utf-8")
    const object = await storage.getObject("a/b.txt")
    expect(object && Buffer.from(object.body).toString()).toBe("hello")
    expect(await storage.statObject("a/b.txt")).toEqual({ contentType: "text/plain", sizeBytes: 5 })

    await storage.deleteObject("a/b.txt")
    await storage.deleteObject("a/b.txt")
    expect(await storage.statObject("a/b.txt")).toBeNull()
    await expect(storage.putObject("../escape", "x", "text/plain")).rejects.toThrow()
  })

  it("copies objects server-side; the copy does not follow later writes to the source", async () => {
    const storage = createLocalStorage(dataRoot.dir)
    expect(await storage.copyObject("up/missing.png", "final/x.png")).toBe(false)
    expect(await storage.statObject("final/x.png")).toBeNull()

    await storage.putObject("up/a.png", "png-bytes", "image/png")
    expect(await storage.copyObject("up/a.png", "final/a.png")).toBe(true)
    await storage.putObject("up/a.png", "<html>swapped</html>", "image/png")
    const copy = await storage.getObject("final/a.png")
    expect(copy && Buffer.from(copy.body).toString()).toBe("png-bytes")
    expect(await storage.statObject("final/a.png")).toEqual({
      contentType: "image/png",
      sizeBytes: 9,
    })
    await expect(storage.copyObject("up/a.png", "../escape")).rejects.toThrow()
  })

  it("signs URLs against the app URL with AUTH_SECRET and the app clock", async () => {
    const url = await createLocalStorage(dataRoot.dir).signedGetUrl("a/b.txt", {
      expiresInSeconds: 300,
    })
    const { key, search } = params(url)
    expect(url.startsWith("http://localhost:3000/api/dev/storage/a/b.txt?")).toBe(true)
    expect(search.get("exp")).toBe(String(nowSec + 300))
    expect(verifySignedRequest(key, "GET", search, TEST_AUTH_SECRET, NOW.getTime()).ok).toBe(true)
  })
})

describe("dev storage route", () => {
  async function route() {
    return import("@/app/api/dev/storage/[...key]/route")
  }
  const ctx = (key: string) => ({ params: Promise.resolve({ key: key.split("/") }) })

  it("accepts a signed upload and serves a signed download", async () => {
    stubServiceEnv({ FAKE_SERVICES: "all" })
    const { GET, PUT } = await route()
    const storage = createLocalStorage(path.join(dataRoot.dir, "storage"))

    const putUrl = await storage.signedPutUrl("up/pic.png", {
      contentType: "image/png",
      maxBytes: 10,
      expiresInSeconds: 60,
    })
    const tooBig = new NextRequest(putUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(11),
    })
    expect((await PUT(tooBig, ctx("up/pic.png"))).status).toBe(413)

    const wrongType = new NextRequest(putUrl, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: new Uint8Array(3),
    })
    expect((await PUT(wrongType, ctx("up/pic.png"))).status).toBe(403)

    const upload = new NextRequest(putUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    })
    expect((await PUT(upload, ctx("up/pic.png"))).status).toBe(200)

    const getUrl = await storage.signedGetUrl("up/pic.png", {
      expiresInSeconds: 60,
      filename: "pic.png",
    })
    const download = await GET(new NextRequest(getUrl), ctx("up/pic.png"))
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe("image/png")
    expect(download.headers.get("content-disposition")).toContain('filename="pic.png"')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    const forged = getUrl.replace(/sig=[^&]+/, "sig=forged")
    expect((await GET(new NextRequest(forged), ctx("up/pic.png"))).status).toBe(403)

    setClockForTests(new Date(NOW.getTime() + 61_000))
    expect((await GET(new NextRequest(getUrl), ctx("up/pic.png"))).status).toBe(403)
  })

  it("does not exist when storage is live", async () => {
    stubServiceEnv({
      R2_ACCOUNT_ID: "acc",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "bucket",
    })
    const { GET } = await route()
    const response = await GET(
      new NextRequest("http://localhost:3000/api/dev/storage/a/b.txt"),
      ctx("a/b.txt"),
    )
    expect(response.status).toBe(404)
  })
})
