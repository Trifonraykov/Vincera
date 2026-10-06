import "server-only"

import { eq } from "drizzle-orm"
import { createElement } from "react"
import { z } from "zod"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import {
  creatorProfiles,
  stripeAccounts,
  users,
  type StripeCapabilityStatus,
} from "@/lib/db/schema"
import NotificationEmail from "@/lib/email/templates/notification"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { notify } from "@/lib/notifications/notify"
import { runInBackground } from "@/lib/jobs/background"
import { advanceOnboarding, requestMatchingAfterOnboarding } from "@/lib/onboarding/complete-step"
import { isPayoutsReady } from "@/lib/payouts/readiness"
import { absoluteUrl } from "@/lib/urls"

import { isPayoutCountry, type PayoutCountry } from "./countries"
import { getStripeGateway, type StripeGateway } from "./gateway"
import type { StripeAccount } from "./schemas"

/**
 * Stripe Connect onboarding for creators and builders (§7.2, §12, §19.10): one connected account
 * per user (`stripe_accounts`), hosted onboarding through Account Links, the Express Dashboard
 * through login links, and the account's status synced from Stripe (webhooks and re-fetches).
 *
 * Functions take the database (or a transaction) first; the gateway defaults to the app's
 * (`getStripeGateway()`, live or fake) and tests pass the fake with a temporary directory.
 */

export type StripeAccountRow = typeof stripeAccounts.$inferSelect

export type ConnectDeps = { gateway?: StripeGateway }

/** The user fields onboarding needs (`AuthUser` satisfies it). */
export type ConnectUser = { id: string; email: string | null }

/** Thrown when we cannot create the account because the user has not chosen a country yet. */
export class PayoutsCountryRequiredError extends ActionError {
  constructor() {
    super("Choose the country where you'll receive payouts.")
    this.name = "PayoutsCountryRequiredError"
  }
}

/** Thrown when an action needs a connected account the user does not have yet. */
export class PayoutsNotStartedError extends ActionError {
  constructor(message = "Set up payouts first.") {
    super(message)
    this.name = "PayoutsNotStartedError"
  }
}

// --- Mapping (pure) ---------------------------------------------------------------------------

/** The `stripe_accounts` columns that come from Stripe. */
export type StripeAccountColumns = {
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  transfersCapability: StripeCapabilityStatus
  requirementsCurrentlyDue: string[]
  disabledReason: string | null
  country: string | null
}

const CAPABILITY_STATUSES: readonly StripeCapabilityStatus[] = [
  "active",
  "inactive",
  "pending",
  "unrequested",
]

/**
 * A Stripe capability status as stored: absent → `unrequested` (never requested); a value this
 * code does not know yet (a newer API version) → `inactive`, so readiness fails closed.
 */
export function toCapabilityStatus(value: string | null | undefined): StripeCapabilityStatus {
  if (value == null) return "unrequested"
  return CAPABILITY_STATUSES.find((status) => status === value) ?? "inactive"
}

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/)

/** Stripe account → `stripe_accounts` columns (§5, §19.11). */
export function stripeAccountColumns(account: StripeAccount): StripeAccountColumns {
  const country = account.country?.toUpperCase()
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    transfersCapability: toCapabilityStatus(account.capabilities?.transfers),
    // Stripe's `currently_due` already includes the past-due fields.
    requirementsCurrentlyDue: [...new Set(account.requirements?.currently_due ?? [])],
    disabledReason: account.requirements?.disabled_reason ?? null,
    country: countryCodeSchema.safeParse(country).success ? (country ?? null) : null,
  }
}

const SYNCED_FIELDS = [
  "chargesEnabled",
  "payoutsEnabled",
  "detailsSubmitted",
  "transfersCapability",
  "requirementsCurrentlyDue",
  "disabledReason",
  "country",
] as const satisfies readonly (keyof StripeAccountColumns)[]

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index])
  }
  return a === b
}

/** The synced fields whose value differs between the row and `next`. */
export function changedAccountFields(
  row: StripeAccountColumns,
  next: Partial<StripeAccountColumns>,
): (keyof StripeAccountColumns)[] {
  return SYNCED_FIELDS.filter((field) => field in next && !sameValue(row[field], next[field]))
}

/**
 * Whether Stripe data observed at `observedAt` is older than what the row already holds.
 * Events carry whole seconds, so data from the same second as the row is applied (never lost).
 */
export function isStaleStripeData(updatedFromStripeAt: Date | null, observedAt: Date): boolean {
  if (updatedFromStripeAt === null) return false
  const seconds = (date: Date) => Math.floor(date.getTime() / 1000)
  return seconds(observedAt) < seconds(updatedFromStripeAt)
}

// --- Reads ------------------------------------------------------------------------------------

export async function findStripeAccountByUser(
  database: DbOrTx,
  userId: string,
): Promise<StripeAccountRow | null> {
  const [row] = await database
    .select()
    .from(stripeAccounts)
    .where(eq(stripeAccounts.userId, userId))
    .limit(1)
  return row ?? null
}

/**
 * The country to preselect: the creator profile's country when Stripe supports it, else null
 * (builder profiles have no country, §5).
 */
export async function defaultPayoutCountry(
  database: DbOrTx,
  userId: string,
): Promise<PayoutCountry | null> {
  const [profile] = await database
    .select({ country: creatorProfiles.country })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
    .limit(1)
  return isPayoutCountry(profile?.country) ? profile.country : null
}

// --- Account creation and links ---------------------------------------------------------------

export type EnsureAccountResult = { account: StripeAccountRow; created: boolean }

/**
 * The user's connected account, creating it on first use (§19.10 controller properties). The
 * country is the one chosen on the payouts page, else the creator profile's; without either this
 * throws `PayoutsCountryRequiredError`. The Stripe call uses the idempotency key `acct:<userId>`,
 * so concurrent or retried calls create one account; the row insert tolerates a concurrent
 * insert (another request, or the webhook adopting the account first).
 */
export async function ensureConnectedAccount(
  database: DbOrTx,
  user: ConnectUser,
  options: { country?: PayoutCountry | null } = {},
  deps: ConnectDeps = {},
): Promise<EnsureAccountResult> {
  const existing = await findStripeAccountByUser(database, user.id)
  if (existing) return { account: existing, created: false }

  const country = options.country ?? (await defaultPayoutCountry(database, user.id))
  if (!country) throw new PayoutsCountryRequiredError()

  const gateway = deps.gateway ?? getStripeGateway()
  const account = await gateway.createConnectedAccount(
    { country, email: user.email, userId: user.id },
    { idempotencyKey: `acct:${user.id}` },
  )
  const retrievedAt = now()

  return withTransaction(async (tx) => {
    const inserted = await insertAccountRow(tx, {
      userId: user.id,
      stripeAccountId: account.id,
      columns: stripeAccountColumns(account),
      observedAt: retrievedAt,
      actorUserId: user.id,
    })
    if (inserted) return { account: inserted, created: true }
    const row = await findStripeAccountByUser(tx, user.id)
    if (!row) throw new Error("ensureConnectedAccount: account row vanished after a conflict")
    return { account: row, created: false }
  }, database)
}

/**
 * Insert the row for a new account and emit `payouts.account_created`; null when the user or the
 * Stripe account already has a row. Columns left out of `columns` keep their defaults (not
 * ready) until a following sync applies them.
 */
async function insertAccountRow(
  tx: DbOrTx,
  input: {
    userId: string
    stripeAccountId: string
    columns: Partial<StripeAccountColumns>
    observedAt: Date | null
    actorUserId: string | null
  },
): Promise<StripeAccountRow | null> {
  const [row] = await tx
    .insert(stripeAccounts)
    .values({
      userId: input.userId,
      stripeAccountId: input.stripeAccountId,
      ...input.columns,
      updatedFromStripeAt: input.observedAt,
    })
    .onConflictDoNothing()
    .returning()
  if (!row) return null
  await track(
    "payouts.account_created",
    {
      actorUserId: input.actorUserId,
      subjectType: "stripe_account",
      subjectId: row.id,
      properties: { country: row.country },
    },
    tx,
  )
  return row
}

/**
 * A fresh hosted onboarding link for the user (creating the account first when needed). Links
 * are single-use and expire within minutes, so create one per click and redirect right away.
 * `returnPath` / `refreshPath` are app paths ("/onboarding/payouts?return=1").
 */
export async function createOnboardingLink(
  database: DbOrTx,
  user: ConnectUser,
  options: { returnPath: string; refreshPath: string; country?: PayoutCountry | null },
  deps: ConnectDeps = {},
): Promise<string> {
  const gateway = deps.gateway ?? getStripeGateway()
  const { account } = await ensureConnectedAccount(
    database,
    user,
    { country: options.country },
    { gateway },
  )
  const link = await gateway.createAccountLink({
    accountId: account.stripeAccountId,
    refreshUrl: absoluteUrl(options.refreshPath),
    returnUrl: absoluteUrl(options.returnPath),
  })
  return link.url
}

/**
 * A one-time link into the user's Stripe Express Dashboard (payout schedule, bank account, tax
 * forms). Stripe only allows it once the onboarding details were submitted.
 */
export async function createDashboardLink(
  database: DbOrTx,
  user: ConnectUser,
  deps: ConnectDeps = {},
): Promise<string> {
  const row = await findStripeAccountByUser(database, user.id)
  if (!row) throw new PayoutsNotStartedError()
  if (!row.detailsSubmitted) {
    throw new PayoutsNotStartedError(
      "Finish setting up payouts with Stripe first; the dashboard opens after that.",
    )
  }
  const gateway = deps.gateway ?? getStripeGateway()
  return (await gateway.createLoginLink(row.stripeAccountId)).url
}

// --- Sync -------------------------------------------------------------------------------------

export type SyncOptions = {
  /**
   * When the Stripe data was current: the event's `created` for webhooks, the retrieval time for
   * `retrieveAccount`. Older data never overwrites newer data.
   */
  observedAt: Date
  /** Who caused the sync; null (default) for Stripe-driven updates. */
  actorUserId?: string | null
}

export type SyncResult =
  | { status: "updated" | "unchanged"; account: StripeAccountRow; becameReady: boolean }
  | { status: "stale"; account: StripeAccountRow; becameReady: false }
  /** No row for this Stripe account, and it could not be matched to a user (not ours). */
  | { status: "unknown_account" }

/**
 * Apply a Stripe account (from `account.updated`, or a fresh `retrieveAccount`) to its
 * `stripe_accounts` row (§7.2). Emits `payouts.account_updated` when a synced field changed.
 * When the account becomes payouts-ready (§19.10) it advances onboarding (the payouts step can be
 * complete by facts alone) and notifies the user once (`payouts.ready`, deduplicated per account).
 *
 * An account without a row whose `metadata.user_id` names a user without one (the webhook beat
 * our own insert after `accounts.create`) is adopted: the row is created first.
 */
export async function syncAccountFromStripe(
  database: DbOrTx,
  account: StripeAccount,
  options: SyncOptions,
): Promise<SyncResult> {
  return withTransaction(async (tx) => {
    let row = await lockAccountRow(tx, account.id)
    if (!row) {
      const adopted = await adoptAccount(tx, account)
      if (!adopted) return { status: "unknown_account" }
      row = adopted
    }
    return applyAccountChanges(tx, row, stripeAccountColumns(account), options)
  }, database)
}

/**
 * Apply a `capability.updated` for the `transfers` capability (other capabilities are not
 * stored). Same rules as `syncAccountFromStripe`; an unknown account is ignored (its
 * `account.updated` creates the row).
 */
export async function syncTransfersCapability(
  database: DbOrTx,
  stripeAccountId: string,
  status: string,
  options: SyncOptions,
): Promise<SyncResult> {
  return withTransaction(async (tx) => {
    const row = await lockAccountRow(tx, stripeAccountId)
    if (!row) return { status: "unknown_account" }
    return applyAccountChanges(
      tx,
      row,
      { transfersCapability: toCapabilityStatus(status) },
      options,
    )
  }, database)
}

/**
 * Re-fetch the user's account from Stripe and sync it (the onboarding return page, and the
 * payouts pages while the account is not ready, in case a webhook is late). Returns the
 * up-to-date row, or null when the user has no account.
 */
export async function refreshAccountFromStripe(
  database: DbOrTx,
  userId: string,
  deps: ConnectDeps = {},
): Promise<StripeAccountRow | null> {
  const row = await findStripeAccountByUser(database, userId)
  if (!row) return null
  const gateway = deps.gateway ?? getStripeGateway()
  const account = await gateway.retrieveAccount(row.stripeAccountId)
  const result = await syncAccountFromStripe(database, account, { observedAt: now() })
  return result.status === "unknown_account" ? row : result.account
}

async function lockAccountRow(tx: DbOrTx, stripeAccountId: string) {
  const [row] = await tx
    .select()
    .from(stripeAccounts)
    .where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
    .for("update")
    .limit(1)
  return row ?? null
}

const metadataUserIdSchema = z.uuid()

async function adoptAccount(tx: DbOrTx, account: StripeAccount): Promise<StripeAccountRow | null> {
  const userId = metadataUserIdSchema.safeParse(account.metadata?.user_id)
  if (!userId.success) return null
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId.data))
    .limit(1)
  if (!user) return null
  // Only the country now; the caller applies the rest as an update, so a first sync that finds
  // the account ready still notifies. Null when the user already has a (different) account.
  const columns = stripeAccountColumns(account)
  const inserted = await insertAccountRow(tx, {
    userId: user.id,
    stripeAccountId: account.id,
    columns: columns.country ? { country: columns.country } : {},
    observedAt: null,
    actorUserId: null,
  })
  if (!inserted) return null
  return lockAccountRow(tx, account.id)
}

async function applyAccountChanges(
  tx: DbOrTx,
  row: StripeAccountRow,
  next: Partial<StripeAccountColumns>,
  options: SyncOptions,
): Promise<SyncResult> {
  if (isStaleStripeData(row.updatedFromStripeAt, options.observedAt)) {
    return { status: "stale", account: row, becameReady: false }
  }

  // Keep a known country when Stripe's is missing or malformed.
  const patch = { ...next }
  if (patch.country === null) delete patch.country

  const changed = changedAccountFields(row, patch)
  const updatedFromStripeAt =
    row.updatedFromStripeAt && row.updatedFromStripeAt > options.observedAt
      ? row.updatedFromStripeAt
      : options.observedAt

  const [updated] = await tx
    .update(stripeAccounts)
    .set({ ...patch, updatedFromStripeAt })
    .where(eq(stripeAccounts.id, row.id))
    .returning()
  if (!updated) throw new Error("syncAccountFromStripe: the account row disappeared")

  const wasReady = isPayoutsReady(row)
  const ready = isPayoutsReady(updated)
  const becameReady = !wasReady && ready

  if (changed.length > 0) {
    await track(
      "payouts.account_updated",
      {
        actorUserId: options.actorUserId ?? null,
        subjectType: "stripe_account",
        subjectId: updated.id,
        properties: {
          charges_enabled: updated.chargesEnabled,
          payouts_enabled: updated.payoutsEnabled,
          details_submitted: updated.detailsSubmitted,
          transfers_capability: updated.transfersCapability,
          ready,
          requirements_due_count: updated.requirementsCurrentlyDue.length,
        },
      },
      tx,
    )
  }

  if (becameReady) {
    // The payouts step may now be complete by facts alone; finishing onboarding here keeps
    // `onboarding_completed_at` close to when it really happened.
    const advance = await advanceOnboarding(tx, updated.userId)
    if (advance.completedNow) {
      // After the response, so after the webhook's transaction commits (CLAUDE.md §19.30).
      await runInBackground("matching", "after_onboarding", () =>
        requestMatchingAfterOnboarding(updated.userId, advance),
      )
    }
    // Last, so the email goes out only once everything above succeeded (§19.11 notify).
    await notifyPayoutsReady(tx, updated)
  }

  return { status: changed.length > 0 ? "updated" : "unchanged", account: updated, becameReady }
}

async function notifyPayoutsReady(tx: DbOrTx, account: StripeAccountRow): Promise<void> {
  const settingsUrl = absoluteUrl("/app/settings/payouts")
  await notify(
    {
      userId: account.userId,
      type: "payouts.ready",
      payload: { stripe_account_id: account.stripeAccountId },
      // Once per connected account: losing and regaining readiness does not notify again.
      dedupeKey: `payouts.ready:${account.stripeAccountId}`,
      email: {
        subject: "Your payouts are set up",
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: "You're ready to get paid",
          paragraphs: [
            "Stripe has verified your details, so your share of every sale can be paid out to your bank account.",
            "You can now sign collaboration agreements. Your payout status and your Stripe Express dashboard are in Settings → Payouts.",
          ],
          action: { label: "View payout settings", url: settingsUrl },
        }),
      },
    },
    tx,
  )
}
