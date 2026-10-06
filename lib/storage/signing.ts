import { createHmac, timingSafeEqual } from "node:crypto"

import { z } from "zod"

import { encodeKeyPath } from "./keys"

/**
 * HMAC-signed, expiring URLs for the local storage fake (§19.3), served by
 * `app/api/dev/storage/[...key]/route.ts`. Pure: the secret and the clock are parameters.
 *
 * The signature covers the operation, key, expiry and every option that changes behaviour
 * (download file name; upload content type and size limit), so none can be altered.
 */

export const DEV_STORAGE_ROUTE = "/api/dev/storage"

export type SignedRequest =
  | { op: "get"; key: string; exp: number; filename: string | null }
  | { op: "put"; key: string; exp: number; contentType: string; maxBytes: number }

/** Separate the storage signing key from AUTH_SECRET's other uses. */
function deriveKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("vincera/dev-storage/v1").digest()
}

function canonical(request: SignedRequest): string {
  const parts =
    request.op === "get"
      ? ["v1", "get", request.key, String(request.exp), request.filename ?? ""]
      : [
          "v1",
          "put",
          request.key,
          String(request.exp),
          request.contentType,
          String(request.maxBytes),
        ]
  return parts.join("\n")
}

export function signRequest(request: SignedRequest, secret: string): string {
  return createHmac("sha256", deriveKey(secret)).update(canonical(request)).digest("base64url")
}

/** Absolute signed URL for `request` under `appUrl`. */
export function buildSignedUrl(appUrl: string, request: SignedRequest, secret: string): string {
  const url = new URL(`${DEV_STORAGE_ROUTE}/${encodeKeyPath(request.key)}`, appUrl)
  url.searchParams.set("op", request.op)
  url.searchParams.set("exp", String(request.exp))
  if (request.op === "get") {
    if (request.filename !== null) url.searchParams.set("filename", request.filename)
  } else {
    url.searchParams.set("contentType", request.contentType)
    url.searchParams.set("maxBytes", String(request.maxBytes))
  }
  url.searchParams.set("sig", signRequest(request, secret))
  return url.toString()
}

const getParams = z.object({
  op: z.literal("get"),
  exp: z.coerce.number().int().positive(),
  filename: z.string().min(1).optional(),
  sig: z.string().min(1),
})

const putParams = z.object({
  op: z.literal("put"),
  exp: z.coerce.number().int().positive(),
  contentType: z.string().min(1),
  maxBytes: z.coerce.number().int().positive(),
  sig: z.string().min(1),
})

export type VerifyResult =
  | { ok: true; request: SignedRequest }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "method" }

/**
 * Check a request to the dev storage route. `method` is the HTTP method used (GET or PUT) and
 * must match the signed operation. Expiry is checked against `nowMs`.
 */
export function verifySignedRequest(
  key: string,
  method: string,
  params: URLSearchParams,
  secret: string,
  nowMs: number,
): VerifyResult {
  const raw = Object.fromEntries(params.entries())
  const parsed = z.discriminatedUnion("op", [getParams, putParams]).safeParse(raw)
  if (!parsed.success) return { ok: false, reason: "malformed" }

  const { sig, ...rest } = parsed.data
  const request: SignedRequest =
    rest.op === "get"
      ? { op: "get", key, exp: rest.exp, filename: rest.filename ?? null }
      : { op: "put", key, exp: rest.exp, contentType: rest.contentType, maxBytes: rest.maxBytes }

  const expected = Buffer.from(signRequest(request, secret))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "signature" }
  }
  if (request.op.toUpperCase() !== method.toUpperCase()) return { ok: false, reason: "method" }
  if (request.exp * 1000 <= nowMs) return { ok: false, reason: "expired" }
  return { ok: true, request }
}
