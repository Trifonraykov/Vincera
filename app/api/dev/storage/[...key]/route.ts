import type { NextRequest } from "next/server"

import { now } from "@/lib/clock"
import { env, isFake } from "@/lib/env"
import { contentDisposition, isValidKey } from "@/lib/storage/keys"
import { normalizeMimeType } from "@/lib/storage/limits"
import { getStorage } from "@/lib/storage/r2"
import { verifySignedRequest } from "@/lib/storage/signing"

/**
 * Serves and accepts files for the local storage fake (§19.3). Requests must carry a valid,
 * unexpired HMAC signature from `lib/storage/local.ts` (403 otherwise). The route does not exist
 * (404) unless the storage service is fake, so it is inert in any real deployment.
 */

type Context = { params: Promise<{ key: string[] }> }

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const key = await resolveKey(context)
  if (key === null) return status(404)

  const check = verifySignedRequest(
    key,
    "GET",
    request.nextUrl.searchParams,
    env.AUTH_SECRET,
    now().getTime(),
  )
  if (!check.ok || check.request.op !== "get") return status(403)

  const object = await getStorage().getObject(key)
  if (!object) return status(404)

  return new Response(new Uint8Array(object.body), {
    headers: {
      "Content-Type": object.contentType,
      "Content-Length": String(object.sizeBytes),
      "Content-Disposition": check.request.filename
        ? contentDisposition(check.request.filename)
        : "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Never let a stored file run as a page on our origin.
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  })
}

export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  const key = await resolveKey(context)
  if (key === null) return status(404)

  const check = verifySignedRequest(
    key,
    "PUT",
    request.nextUrl.searchParams,
    env.AUTH_SECRET,
    now().getTime(),
  )
  if (!check.ok || check.request.op !== "put") return status(403)

  const contentType = normalizeMimeType(request.headers.get("content-type") ?? "")
  if (contentType !== check.request.contentType) return status(403)

  const body = await readBody(request, check.request.maxBytes)
  if (body === null) return status(413)

  await getStorage().putObject(key, body, contentType)
  return new Response(null, { status: 200 })
}

async function resolveKey(context: Context): Promise<string | null> {
  if (!storageIsFake()) return null
  const { key: segments } = await context.params
  const key = segments.join("/")
  return isValidKey(key) ? key : null
}

function storageIsFake(): boolean {
  try {
    return isFake("storage")
  } catch {
    // isFake throws when a fake would be used in production: the route must not exist there.
    return false
  }
}

/** The request body, or null when it exceeds `maxBytes` (checked while streaming). */
async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function status(code: 403 | 404 | 413): Response {
  const text = { 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large" }[code]
  return new Response(text, { status: code, headers: { "Cache-Control": "no-store" } })
}
