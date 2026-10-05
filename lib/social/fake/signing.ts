import "server-only"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { z } from "zod"

import { env } from "@/lib/env"

import { socialProviderIdSchema, type SocialProviderId } from "../types"

/**
 * Self-contained, HMAC-signed values for the fake social providers (§19.3): authorization codes
 * minted by the fake authorize page, and the access/refresh tokens the fake token endpoints issue.
 * They carry the fixture account they stand for, so no fake state lives in memory (works across
 * Next.js workers) and nothing but the fake can mint them. Signed with a key derived from
 * AUTH_SECRET. Meaningless to real providers.
 */

export type FakeValueKind = "code" | "access" | "refresh" | "short"

const PREFIX: Record<FakeValueKind, string> = {
  code: "fkc_",
  access: "fka_",
  refresh: "fkr_",
  // Instagram's short-lived token (exchanged for a long-lived one).
  short: "fks_",
}

const payloadSchema = z.object({
  k: z.enum(["code", "access", "refresh", "short"]),
  p: socialProviderIdSchema,
  /** Fixture account key (file name under tests/fixtures/social/<provider>/). */
  a: z.string().min(1),
  /** Issued at / expires at, Unix ms; exp null = never. */
  iat: z.number().int(),
  exp: z.number().int().nullable(),
  n: z.string(),
  /** Codes only: the PKCE challenge and redirect URI they were issued for. */
  cc: z.string().optional(),
  ru: z.string().optional(),
})
export type FakeValue = z.infer<typeof payloadSchema>

function key(): Buffer {
  return createHmac("sha256", env.AUTH_SECRET).update("social-fake-oauth/v1").digest()
}

function sign(data: string): string {
  return createHmac("sha256", key()).update(data).digest("base64url")
}

export function mintFakeValue(
  kind: FakeValueKind,
  fields: {
    provider: SocialProviderId
    account: string
    issuedAt: Date
    ttlSeconds: number | null
    codeChallenge?: string
    redirectUri?: string
  },
): string {
  const payload: FakeValue = {
    k: kind,
    p: fields.provider,
    a: fields.account,
    iat: fields.issuedAt.getTime(),
    exp: fields.ttlSeconds === null ? null : fields.issuedAt.getTime() + fields.ttlSeconds * 1000,
    n: randomBytes(9).toString("base64url"),
    ...(fields.codeChallenge ? { cc: fields.codeChallenge } : {}),
    ...(fields.redirectUri ? { ru: fields.redirectUri } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${PREFIX[kind]}${body}.${sign(`${kind}.${body}`)}`
}

/** The payload of a value of `kind` with a valid signature, else null. Expiry is not checked. */
export function readFakeValue(
  value: string | null | undefined,
  kind: FakeValueKind,
): FakeValue | null {
  if (!value?.startsWith(PREFIX[kind])) return null
  const [body = "", signature = ""] = value.slice(PREFIX[kind].length).split(".")
  const expected = Buffer.from(sign(`${kind}.${body}`))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    )
    return parsed.success && parsed.data.k === kind ? parsed.data : null
  } catch {
    return null
  }
}

/** Whether a fake value has expired at `at`. */
export function isFakeValueExpired(value: FakeValue, at: Date): boolean {
  return value.exp !== null && value.exp <= at.getTime()
}
