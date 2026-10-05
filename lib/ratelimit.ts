import "server-only"

import { createHash } from "node:crypto"

import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

import { now } from "@/lib/clock"
import { env, isFake } from "@/lib/env"
import { reportError } from "@/lib/observability"

/**
 * Rate limiting (§14). Live: Upstash Redis sliding window. Fake: an in-memory sliding log per
 * process (§19.3), fine for development and tests but not shared between instances.
 *
 * Keys (user ids, IPs, emails) are hashed before use, so no personal data lands in Redis.
 * If Redis fails, the request is allowed and the error reported: a rate-limiter outage must not
 * take the product down.
 */

export type WindowUnit = "ms" | "s" | "m" | "h" | "d"
/** Upstash-style duration, e.g. "10 m", "1 d". */
export type RateWindow = `${number} ${WindowUnit}`
export type RateLimitRule = { limit: number; window: RateWindow }

/** Predefined buckets (§14). Keys: user id for signed-in actions, client IP otherwise. */
export const RATE_LIMITS = {
  /** Magic-link requests and sign-in attempts, per IP and per email. */
  auth: { limit: 10, window: "10 m" },
  /** §14: at most 20 proposals per day per user. */
  proposals: { limit: 20, window: "1 d" },
  /** Messages per user. */
  messages: { limit: 30, window: "1 m" },
  /** Tracked-link redirects `/r/*`, per IP. Bots beyond this are still redirected, not logged. */
  redirect: { limit: 120, window: "1 m" },
  /** Checkout session creation, per IP. */
  checkout: { limit: 10, window: "1 m" },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitBucket = keyof typeof RATE_LIMITS

export type RateLimitResult = {
  success: boolean
  limit: number
  remaining: number
  /** Unix ms when the next request will be allowed again. */
  reset: number
}

export function rateLimit(
  bucket: RateLimitBucket,
  key: string,
  rule?: RateLimitRule,
): Promise<RateLimitResult>
export function rateLimit(
  bucket: string,
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitResult>
export async function rateLimit(
  bucket: string,
  key: string,
  rule?: RateLimitRule,
): Promise<RateLimitResult> {
  const resolved = rule ?? (isPredefined(bucket) ? RATE_LIMITS[bucket] : undefined)
  if (!resolved) throw new Error(`Unknown rate limit bucket "${bucket}" and no rule given`)
  assertRule(resolved)

  const hashedKey = hashKey(key)
  if (isFake("ratelimit")) return memoryLimit(bucket, hashedKey, resolved)

  try {
    const result = await upstashLimiter(bucket, resolved).limit(hashedKey)
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    }
  } catch (error) {
    reportError(error, { tags: { ratelimit_bucket: bucket } })
    return {
      success: true,
      limit: resolved.limit,
      remaining: resolved.limit,
      reset: now().getTime(),
    }
  }
}

/** Seconds until `result.reset`, for a `Retry-After` header. */
export function retryAfterSeconds(result: RateLimitResult): number {
  return Math.max(1, Math.ceil((result.reset - now().getTime()) / 1000))
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

function isPredefined(bucket: string): bucket is RateLimitBucket {
  return Object.hasOwn(RATE_LIMITS, bucket)
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 32)
}

function assertRule(rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit < 1) {
    throw new Error("Rate limit must be a positive integer")
  }
  windowMs(rule.window)
}

const UNIT_MS: Record<WindowUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export function windowMs(window: RateWindow): number {
  const match = /^(\d+(?:\.\d+)?) (ms|s|m|h|d)$/.exec(window)
  const amount = Number(match?.[1])
  const unit = match?.[2]
  if (!isUnit(unit) || !(amount > 0)) throw new Error(`Invalid rate limit window "${window}"`)
  return amount * UNIT_MS[unit]
}

function isUnit(value: string | undefined): value is WindowUnit {
  return value !== undefined && Object.hasOwn(UNIT_MS, value)
}

// --- Upstash --------------------------------------------------------------------------------

const limiters = new Map<string, Ratelimit>()
let redis: Redis | undefined

function upstashLimiter(bucket: string, rule: RateLimitRule): Ratelimit {
  const id = `${bucket}:${rule.limit}:${rule.window}`
  let limiter = limiters.get(id)
  if (!limiter) {
    redis ??= new Redis({
      url: env.UPSTASH_REDIS_REST_URL ?? "",
      token: env.UPSTASH_REDIS_REST_TOKEN ?? "",
    })
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(rule.limit, rule.window),
      prefix: `rl:${bucket}`,
      analytics: false,
    })
    limiters.set(id, limiter)
  }
  return limiter
}

// --- In-memory fake -------------------------------------------------------------------------

/** Timestamps (ms) of allowed requests per bucket+rule+key. Per process, by design (§19.3). */
const memoryLog = new Map<string, { span: number; hits: number[] }>()
const MAX_TRACKED_KEYS = 10_000

function memoryLimit(bucket: string, key: string, rule: RateLimitRule): RateLimitResult {
  const nowMs = now().getTime()
  const span = windowMs(rule.window)
  const id = `${bucket}:${rule.limit}:${rule.window}:${key}`

  if (memoryLog.size > MAX_TRACKED_KEYS) sweep(nowMs)

  const hits = (memoryLog.get(id)?.hits ?? []).filter((t) => t > nowMs - span)
  const success = hits.length < rule.limit
  if (success) hits.push(nowMs)
  memoryLog.set(id, { span, hits })

  const remaining = Math.max(0, rule.limit - hits.length)
  return {
    success,
    limit: rule.limit,
    remaining,
    // With slots left the next request is allowed now; otherwise when the oldest hit expires.
    reset: remaining > 0 ? nowMs : (hits[0] ?? nowMs) + span,
  }
}

function sweep(nowMs: number): void {
  for (const [id, entry] of memoryLog) {
    if (entry.hits.every((t) => t <= nowMs - entry.span)) memoryLog.delete(id)
  }
}

/** Forget all in-memory counters (tests). */
export function resetMemoryRateLimits(): void {
  memoryLog.clear()
}
