import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import Stripe from "stripe"
import { z } from "zod"

import { now } from "@/lib/clock"
import type { JsonObject, JsonValue } from "@/lib/db/schema"

import type { StripeGateway } from "./gateway"
import {
  jsonObjectSchema,
  STRIPE_ACCOUNT_ID_PATTERN,
  stripeAccountLinkSchema,
  stripeAccountSchema,
  stripeLoginLinkSchema,
} from "./schemas"
import { ACCOUNT_LINK_TTL_SECONDS, connectedAccountParams, StripeGatewayError } from "./shared"

/**
 * Fake Stripe (§19.3): Stripe-shaped JSON objects in `<root>/<object type>/<id>.json` (the app
 * uses `.data/fake-stripe/`; tests pass a temporary directory). Writes are atomic (temp file +
 * rename), and nothing is kept in memory, so every Next.js worker and the Playwright process see
 * the same state.
 *
 * Phase 1: connected accounts, account links (served by the fake onboarding page
 * `/api/dev/fake-stripe/connect/[accountId]`), login links (the fake Express Dashboard
 * `/api/dev/fake-stripe/dashboard/[accountId]`) and events. The fake onboarding page changes the
 * account with `completeFakeOnboarding()` and posts a signed `account.updated` event to the real
 * `/api/webhooks/stripe` with `deliverFakeWebhook()`, so the real webhook code runs. Phases 4–5 add
 * checkout sessions, payment intents, balance transactions, transfers and refunds the same way.
 */

export type FakeStripeOptions = {
  /** Directory holding the fake's objects. */
  root: string
  /** Base URL of the app, for the fake onboarding and dashboard pages. */
  appUrl: string
}

/** Object types the fake stores (one directory each). */
export type FakeObjectType = "account" | "account_link" | "event"

const FAKE_ID_PATTERN = /^[A-Za-z0-9_]{1,128}$/

export type FakeStripeStore = {
  readonly root: string
  read(type: FakeObjectType, id: string): Promise<JsonObject | null>
  write(type: FakeObjectType, id: string, object: JsonObject): Promise<void>
  remove(type: FakeObjectType, id: string): Promise<void>
}

export function createFakeStripeStore(root: string): FakeStripeStore {
  const fileOf = (type: FakeObjectType, id: string) => {
    if (!FAKE_ID_PATTERN.test(id)) {
      throw new StripeGatewayError("resource_missing", `Invalid fake Stripe id: ${id}`)
    }
    return path.join(root, type, `${id}.json`)
  }

  return {
    root,

    async read(type, id) {
      let text: string
      try {
        text = await readFile(fileOf(type, id), "utf8")
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
      return jsonObjectSchema.parse(JSON.parse(text))
    },

    async write(type, id, object) {
      const file = fileOf(type, id)
      await mkdir(path.dirname(file), { recursive: true })
      // Atomic: readers in other workers see the old or the new file, never half of one.
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
      await writeFile(temporary, `${JSON.stringify(object, null, 2)}\n`, "utf8")
      await rename(temporary, file)
    },

    async remove(type, id) {
      await rm(fileOf(type, id), { force: true })
    },
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function unixSeconds(date: Date = now()): number {
  return Math.floor(date.getTime() / 1000)
}

function randomId(prefix: string, bytes = 12): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`
}

/** Fake account ids derive from the idempotency key, so tests can predict them. */
export function fakeAccountIdFor(idempotencyKey: string): string {
  return `acct_fake_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`
}

// --- Account states ---------------------------------------------------------------------------

/** What a new Express account still needs, roughly as Stripe lists it. */
const INITIAL_REQUIREMENTS = [
  "business_profile.url",
  "business_type",
  "external_account",
  "tos_acceptance.date",
  "tos_acceptance.ip",
]

type FakeAccountState = {
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  transfers: "active" | "inactive" | "pending"
  currently_due: string[]
  pending_verification: string[]
  disabled_reason: string | null
}

const NEW_ACCOUNT: FakeAccountState = {
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  transfers: "inactive",
  currently_due: INITIAL_REQUIREMENTS,
  pending_verification: [],
  disabled_reason: "requirements.past_due",
}

/**
 * How a fake onboarding session ends:
 * - `enabled`: everything submitted and verified; payouts ready.
 * - `pending_verification`: details submitted, Stripe still verifying (payouts not ready yet).
 */
export const FAKE_ONBOARDING_OUTCOMES = ["enabled", "pending_verification"] as const
export type FakeOnboardingOutcome = (typeof FAKE_ONBOARDING_OUTCOMES)[number]

const OUTCOME_STATES: Record<FakeOnboardingOutcome, FakeAccountState> = {
  enabled: {
    // Transfer-only accounts have no `card_payments`, so they cannot take charges themselves.
    charges_enabled: false,
    payouts_enabled: true,
    details_submitted: true,
    transfers: "active",
    currently_due: [],
    pending_verification: [],
    disabled_reason: null,
  },
  pending_verification: {
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
    transfers: "pending",
    currently_due: [],
    pending_verification: ["individual.verification.document"],
    disabled_reason: "requirements.pending_verification",
  },
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function withState(account: JsonObject, state: FakeAccountState): JsonObject {
  return {
    ...account,
    charges_enabled: state.charges_enabled,
    payouts_enabled: state.payouts_enabled,
    details_submitted: state.details_submitted,
    capabilities: { ...asObject(account.capabilities), transfers: state.transfers },
    requirements: {
      ...asObject(account.requirements),
      alternatives: [],
      current_deadline: null,
      currently_due: state.currently_due,
      disabled_reason: state.disabled_reason,
      errors: [],
      eventually_due: state.currently_due,
      past_due: state.currently_due,
      pending_verification: state.pending_verification,
    },
  }
}

// --- Gateway ----------------------------------------------------------------------------------

export function fakeConnectPageUrl(appUrl: string, accountId: string, linkId: string): string {
  const url = new URL(`/api/dev/fake-stripe/connect/${encodeURIComponent(accountId)}`, appUrl)
  url.searchParams.set("link", linkId)
  return url.toString()
}

export function fakeDashboardUrl(appUrl: string, accountId: string): string {
  return new URL(
    `/api/dev/fake-stripe/dashboard/${encodeURIComponent(accountId)}`,
    appUrl,
  ).toString()
}

export function createFakeStripeGateway(
  options: FakeStripeOptions,
): StripeGateway & { store: FakeStripeStore } {
  const store = createFakeStripeStore(options.root)

  async function readAccount(accountId: string): Promise<JsonObject> {
    const account = STRIPE_ACCOUNT_ID_PATTERN.test(accountId)
      ? await store.read("account", accountId)
      : null
    if (!account) throw new StripeGatewayError("resource_missing", `No such account: ${accountId}`)
    return account
  }

  return {
    mode: "fake",
    store,

    async createConnectedAccount(input, { idempotencyKey }) {
      const params = connectedAccountParams(input)
      const id = fakeAccountIdFor(idempotencyKey)
      const existing = await store.read("account", id)
      if (existing) {
        // Like Stripe: a reused key replays the first result, but only for the same parameters.
        if (existing.country !== params.country) {
          throw new StripeGatewayError(
            "invalid_request",
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          )
        }
        return stripeAccountSchema.parse(existing)
      }

      const account = withState(
        {
          id,
          object: "account",
          business_type: null,
          controller: {
            ...params.controller,
            is_controller: true,
            type: "application",
          },
          country: params.country,
          created: unixSeconds(),
          email: input.email,
          metadata: params.metadata,
          tos_acceptance: { ...params.tos_acceptance, date: null, ip: null, user_agent: null },
          type: "none",
        },
        NEW_ACCOUNT,
      )
      await store.write("account", id, account)
      return stripeAccountSchema.parse(account)
    },

    async retrieveAccount(accountId) {
      return stripeAccountSchema.parse(await readAccount(accountId))
    },

    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      await readAccount(accountId)
      const linkId = randomId("link_")
      const created = unixSeconds()
      const link: JsonObject = {
        object: "account_link",
        created,
        expires_at: created + ACCOUNT_LINK_TTL_SECONDS,
        url: fakeConnectPageUrl(options.appUrl, accountId, linkId),
        // Fake-only fields (Stripe keeps these server-side): what the fake page needs.
        id: linkId,
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        used_at: null,
      }
      await store.write("account_link", linkId, link)
      return stripeAccountLinkSchema.parse(link)
    },

    async createLoginLink(accountId) {
      const account = stripeAccountSchema.parse(await readAccount(accountId))
      if (!account.details_submitted) {
        throw new StripeGatewayError(
          "invalid_request",
          "Cannot create a login link for an account that has not completed onboarding.",
        )
      }
      return stripeLoginLinkSchema.parse({
        object: "login_link",
        created: unixSeconds(),
        url: fakeDashboardUrl(options.appUrl, accountId),
      })
    },
  }
}

// --- Fake onboarding page helpers -------------------------------------------------------------

const fakeAccountLinkSchema = z.object({
  id: z.string(),
  account: z.string().regex(STRIPE_ACCOUNT_ID_PATTERN),
  expires_at: z.number().int(),
  refresh_url: z.url(),
  return_url: z.url(),
  used_at: z.number().int().nullable(),
})
export type FakeAccountLink = z.output<typeof fakeAccountLinkSchema>

export type FakeAccountLinkCheck =
  | { ok: true; link: FakeAccountLink }
  | { ok: false; reason: "missing" }
  /** Expired or already used: Stripe sends the user to `refresh_url` for a new link. */
  | { ok: false; reason: "expired" | "used"; link: FakeAccountLink }

/** The account link behind a fake onboarding URL, checked like Stripe checks single-use links. */
export async function checkFakeAccountLink(
  store: FakeStripeStore,
  accountId: string,
  linkId: string,
): Promise<FakeAccountLinkCheck> {
  if (!FAKE_ID_PATTERN.test(linkId)) return { ok: false, reason: "missing" }
  const raw = await store.read("account_link", linkId)
  const parsed = fakeAccountLinkSchema.safeParse(raw)
  if (!parsed.success || parsed.data.account !== accountId) return { ok: false, reason: "missing" }
  const link = parsed.data
  if (link.used_at !== null) return { ok: false, reason: "used", link }
  if (link.expires_at <= unixSeconds()) return { ok: false, reason: "expired", link }
  return { ok: true, link }
}

/** Mark a fake account link used (Stripe's links are single-use). */
export async function consumeFakeAccountLink(
  store: FakeStripeStore,
  linkId: string,
): Promise<void> {
  const raw = await store.read("account_link", linkId)
  if (!raw) return
  await store.write("account_link", linkId, { ...raw, used_at: unixSeconds() })
}

/** Apply the outcome of a fake onboarding session to the account; returns the new account. */
export async function completeFakeOnboarding(
  store: FakeStripeStore,
  accountId: string,
  outcome: FakeOnboardingOutcome,
): Promise<JsonObject> {
  const account = STRIPE_ACCOUNT_ID_PATTERN.test(accountId)
    ? await store.read("account", accountId)
    : null
  if (!account) throw new StripeGatewayError("resource_missing", `No such account: ${accountId}`)
  const updated: JsonObject = {
    ...withState(account, OUTCOME_STATES[outcome]),
    tos_acceptance: {
      ...asObject(account.tos_acceptance),
      date: asObject(account.tos_acceptance).date ?? unixSeconds(),
    },
  }
  await store.write("account", accountId, updated)
  return updated
}

/** A Stripe-shaped snapshot event for `object` (stored, so it can be inspected or replayed). */
export async function createFakeEvent(
  store: FakeStripeStore,
  type: Stripe.Event.Type,
  object: JsonObject,
  options: { account?: string; previousAttributes?: JsonObject } = {},
): Promise<JsonObject> {
  const id = randomId("evt_fake_")
  const event: JsonObject = {
    id,
    object: "event",
    api_version: null,
    created: unixSeconds(),
    data: {
      object,
      ...(options.previousAttributes ? { previous_attributes: options.previousAttributes } : {}),
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    ...(options.account ? { account: options.account } : {}),
  }
  await store.write("event", id, event)
  return event
}

/**
 * POST `event` to a webhook endpoint the way Stripe does: raw JSON body with a `Stripe-Signature`
 * header for `secret` (signed at the current real time, which the receiver checks).
 */
export async function deliverFakeWebhook(
  event: JsonObject,
  options: { url: string; secret: string; fetch?: typeof fetch },
): Promise<{ status: number }> {
  const payload = JSON.stringify(event)
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: options.secret })
  const response = await (options.fetch ?? fetch)(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
    cache: "no-store",
  })
  return { status: response.status }
}
