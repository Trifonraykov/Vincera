import { z } from "zod"

import type { JsonObject } from "@/lib/db/schema"

/**
 * Zod schemas for the Stripe objects we read (§4: every external response is parsed). They pick
 * the fields the platform uses and drop the rest, so the live SDK, the fake gateway and webhook
 * payloads all come out in the same shape. Field names stay Stripe's (snake_case) so a parsed
 * object can be compared with Stripe's docs and dashboard one to one.
 *
 * Unknown enum values from newer API versions are kept as strings and mapped by the caller
 * (fail closed, e.g. an unknown capability status counts as `inactive`).
 */

/** Connected account ids: `acct_` plus Stripe's id characters (the fake uses `acct_fake_…`). */
export const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_]{1,250}$/

export const stripeAccountIdSchema = z.string().regex(STRIPE_ACCOUNT_ID_PATTERN)

const stringList = z.array(z.string()).nullish()

export { expandableIdSchema, stripeIdOf, stripeIdSchema, stripeMetadataSchema } from "./ids"

/** The fields of a v1 `Account` the platform syncs (§5 stripe_accounts, §19.10). */
export const stripeAccountSchema = z.object({
  id: stripeAccountIdSchema,
  object: z.literal("account"),
  charges_enabled: z.boolean(),
  payouts_enabled: z.boolean(),
  details_submitted: z.boolean(),
  /** ISO 3166-1 alpha-2. */
  country: z.string().nullish(),
  email: z.string().nullish(),
  /** `active | inactive | pending`; absent when the capability was never requested. */
  capabilities: z.object({ transfers: z.string().optional() }).optional(),
  requirements: z
    .object({
      currently_due: stringList,
      past_due: stringList,
      disabled_reason: z.string().nullish(),
    })
    .nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
})
export type StripeAccount = z.output<typeof stripeAccountSchema>

/** A `Capability` (`capability.updated`). `account` may be expanded; we only need its id. */
export const stripeCapabilitySchema = z.object({
  id: z.string().min(1),
  object: z.literal("capability"),
  account: z.union([stripeAccountIdSchema, z.object({ id: stripeAccountIdSchema })]),
  status: z.string().min(1),
})
export type StripeCapability = z.output<typeof stripeCapabilitySchema>

export function capabilityAccountId(capability: StripeCapability): string {
  return typeof capability.account === "string" ? capability.account : capability.account.id
}

/** `AccountLink`: single-use onboarding URL. */
export const stripeAccountLinkSchema = z.object({
  object: z.literal("account_link"),
  created: z.number().int(),
  expires_at: z.number().int(),
  url: z.url(),
})
export type StripeAccountLink = z.output<typeof stripeAccountLinkSchema>

/** `LoginLink`: one-time link into the connected account's Express Dashboard. */
export const stripeLoginLinkSchema = z.object({
  object: z.literal("login_link"),
  created: z.number().int(),
  url: z.url(),
})
export type StripeLoginLink = z.output<typeof stripeLoginLinkSchema>

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json())

/**
 * A webhook event's envelope (snapshot payload). `data.object` stays an open JSON object here; the
 * dispatch table in `./webhooks.ts` parses it with the schema of the event's type.
 */
export const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]+$/),
  object: z.literal("event"),
  type: z.string().min(1),
  /** Seconds since the Unix epoch. */
  created: z.number().int().nonnegative(),
  /** The connected account a Connect event comes from; absent for platform events. */
  account: z.string().nullish(),
  livemode: z.boolean(),
  api_version: z.string().nullish(),
  data: z.object({
    object: jsonObjectSchema,
    previous_attributes: jsonObjectSchema.nullish(),
  }),
})
export type StripeEvent = z.output<typeof stripeEventSchema>

/** A whole JSON object (an event as received, for `stripe_events.payload`). */
export { jsonObjectSchema }

// Phases 4–5 objects live in their topic files (CLAUDE.md §19.31) and are re-exported here.
export * from "./checkout-shared"
export * from "./money-shared"
export * from "./promotions-shared"
