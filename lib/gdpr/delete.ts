import "server-only"

import { randomBytes } from "node:crypto"

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { allowGdprErasure } from "@/lib/db/append-only"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import {
  accounts,
  agreementSignatures,
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  disputes,
  handles,
  ideas,
  ledgerEntries,
  matches,
  messages,
  notificationPrefs,
  notifications,
  portfolioItems,
  products,
  proposalRevisions,
  proposals,
  savedItems,
  sessions,
  socialConnections,
  stripeAccounts,
  stripeEvents,
  transfers,
  users,
  verificationTokens,
  type UserRole,
} from "@/lib/db/schema"
import { track, trackMany } from "@/lib/events/track"
import type { AnyTrackEvent } from "@/lib/events/types"
import { tokenSetOf } from "@/lib/social/connections"
import type { SocialProviderId, TokenSet } from "@/lib/social/types"
import { redactStripePayload } from "@/lib/stripe/redact-payload"

import { DELETION_BLOCKER_MESSAGES, type DeletionBlocker } from "./fields"

/**
 * Account deletion (§14 "Deletion anonymises the user. It keeps ledger and orders, which are
 * legally required, with personal data removed"; CLAUDE.md §19.38, §19.40). The users row stays
 * (ledger, orders, events, collabs and agreements reference it) but is anonymised for good.
 */

export const DELETED_DISPLAY_NAME = "Deleted user"
export const DELETED_MESSAGE_BODY = "This message was deleted."

export class AccountDeletionBlockedError extends ActionError {
  constructor(readonly blockers: readonly DeletionBlocker[]) {
    super(blockers.map((blocker) => DELETION_BLOCKER_MESSAGES[blocker]).join(" "))
    this.name = "AccountDeletionBlockedError"
  }
}

/**
 * Why the account cannot be deleted yet (empty: it can). Refused while the user is a member of a
 * collab that has not ended, a dispute in one of their collabs is unresolved, their untransferred
 * ledger entries do not sum to zero (money to be paid out, or owed), or a transfer to them is still
 * `pending`.
 */
export async function accountDeletionBlockers(
  database: DbOrTx,
  userId: string,
): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = []
  const memberOf = database
    .select({ collabId: collabMembers.collabId })
    .from(collabMembers)
    .where(eq(collabMembers.userId, userId))

  const [activeCollab] = await database
    .select({ id: collabs.id })
    .from(collabs)
    .where(and(inArray(collabs.id, memberOf), ne(collabs.stage, "ended")))
    .limit(1)
  if (activeCollab) blockers.push("active_collabs")

  const [openDispute] = await database
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(inArray(disputes.collabId, memberOf), ne(disputes.status, "resolved")))
    .limit(1)
  if (openDispute) blockers.push("open_disputes")

  const balances = await database
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.userId, userId), isNull(ledgerEntries.transferId)))
    .groupBy(ledgerEntries.currency)
  if (balances.some((balance) => Number(balance.total) !== 0)) blockers.push("unpaid_balance")

  const [pending] = await database
    .select({ id: transfers.id })
    .from(transfers)
    .where(and(eq(transfers.userId, userId), eq(transfers.status, "pending")))
    .limit(1)
  if (pending) blockers.push("pending_transfer")

  return blockers
}

export type AccountDeletionResult = {
  /** The address before anonymising, for the confirmation email (never stored or logged). */
  email: string | null
  roles: UserRole[]
  /** Private storage objects to delete after the commit (job `gdpr-cleanup`). */
  storageKeys: string[]
  /** Tokens read before the connections were deleted, for a best-effort revoke after the commit. */
  revocations: { provider: SocialProviderId; tokens: TokenSet }[]
}

/** A fresh handle no profile used: `deleted_<12 hex>` (fits `[a-z0-9_]{3,30}`). */
function deletedHandle(): string {
  return `deleted_${randomBytes(6).toString("hex")}`
}

/**
 * Delete (anonymise) the account in one transaction under the GDPR erasure hatch. Refuses with
 * `AccountDeletionBlockedError` while `accountDeletionBlockers` finds anything, and with a plain
 * `ActionError` for an admin or an already deleted account. See CLAUDE.md §19.38 "GDPR" for the
 * full list of what is removed and what is kept.
 */
export async function deleteAccount(
  database: DbOrTx,
  input: { userId: string; now: Date },
): Promise<AccountDeletionResult> {
  const { userId, now: at } = input
  return withTransaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update")
    if (!user || user.deletedAt) throw new ActionError("This account no longer exists.")
    if (user.roles.includes("admin")) {
      throw new ActionError(
        "Admin accounts can't be deleted here. Ask another admin to remove your admin role first.",
      )
    }
    const blockers = await accountDeletionBlockers(tx, userId)
    if (blockers.length > 0) throw new AccountDeletionBlockedError(blockers)

    await allowGdprErasure(tx)
    const storageKeys: string[] = []
    const revocations: AccountDeletionResult["revocations"] = []
    const trackLater: AnyTrackEvent[] = []

    // Social connections: tokens read for revocation, then the rows go (snapshots cascade).
    const connections = await tx
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, userId))
      .for("update")
    for (const connection of connections) {
      const tokens = connection.source === "oauth" ? tokenSetOf(connection) : null
      if (tokens) revocations.push({ provider: connection.provider, tokens })
      if (connection.evidenceStorageKey) storageKeys.push(connection.evidenceStorageKey)
    }
    if (connections.length > 0) {
      await tx.delete(socialConnections).where(eq(socialConnections.userId, userId))
    }

    // Profiles: kept for the history collaborators see, anonymised, on a fresh handle.
    const [creator] = await tx
      .select({ id: creatorProfiles.id })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId))
    const [builder] = await tx
      .select({ id: builderProfiles.id })
      .from(builderProfiles)
      .where(eq(builderProfiles.userId, userId))
    if (creator || builder) {
      const handle = deletedHandle()
      await tx.insert(handles).values({ handle, userId })
      if (creator) {
        await tx
          .update(creatorProfiles)
          .set({
            handle,
            displayName: DELETED_DISPLAY_NAME,
            bio: null,
            niche: null,
            topics: [],
            languages: [],
            country: null,
            sizeTier: null,
            audienceSummary: null,
            audienceSummaryPromptVersion: null,
            audienceSummaryGeneratedAt: null,
            audienceSummaryEditedAt: null,
            embedding: null,
            embeddingModel: null,
            embeddingTextHash: null,
            embeddedAt: null,
            verifiedAt: null,
          })
          .where(eq(creatorProfiles.id, creator.id))
      }
      if (builder) {
        await tx
          .update(builderProfiles)
          .set({
            handle,
            displayName: DELETED_DISPLAY_NAME,
            bio: null,
            skills: [],
            stack: [],
            availability: "closed",
            embedding: null,
            embeddingModel: null,
            embeddingTextHash: null,
            embeddedAt: null,
            verifiedAt: null,
          })
          .where(eq(builderProfiles.id, builder.id))
        const items = await tx
          .delete(portfolioItems)
          .where(eq(portfolioItems.builderProfileId, builder.id))
          .returning({ imageKey: portfolioItems.imageUrl })
        for (const item of items) if (item.imageKey) storageKeys.push(item.imageKey)
      }
      // The old handle(s) are freed.
      await tx.delete(handles).where(and(eq(handles.userId, userId), ne(handles.handle, handle)))
    } else {
      await tx.delete(handles).where(eq(handles.userId, userId))
    }

    // Ideas and products: never used in a proposal → deleted; otherwise archived when allowed.
    const ownIdeas = creator
      ? await tx
          .select({ id: ideas.id, status: ideas.status })
          .from(ideas)
          .where(eq(ideas.creatorProfileId, creator.id))
          .for("update")
      : []
    const ownProducts = builder
      ? await tx
          .select({ id: products.id, status: products.status })
          .from(products)
          .where(eq(products.builderProfileId, builder.id))
          .for("update")
      : []
    // "Used" = named by a proposal (collabs come from proposals, so they are covered too).
    const usedIdeaIds = new Set(
      ownIdeas.length === 0
        ? []
        : (
            await tx
              .selectDistinct({ id: proposals.ideaId })
              .from(proposals)
              .where(
                inArray(
                  proposals.ideaId,
                  ownIdeas.map((idea) => idea.id),
                ),
              )
          ).map((row) => row.id),
    )
    const usedProductIds = new Set(
      ownProducts.length === 0
        ? []
        : (
            await tx
              .selectDistinct({ id: proposals.productId })
              .from(proposals)
              .where(
                inArray(
                  proposals.productId,
                  ownProducts.map((product) => product.id),
                ),
              )
          ).map((row) => row.id),
    )

    // Their match rows (as subject or target) leave every current list; rows stay (v1 data).
    const targetIds = [userId, ...ownIdeas.map((idea) => idea.id), ...ownProducts.map((p) => p.id)]
    await tx
      .update(matches)
      .set({ staleAt: at })
      .where(
        and(
          isNull(matches.staleAt),
          or(eq(matches.subjectUserId, userId), inArray(matches.targetId, targetIds)),
        ),
      )

    const unusedIdeas = ownIdeas.filter((idea) => !usedIdeaIds.has(idea.id)).map((idea) => idea.id)
    if (unusedIdeas.length > 0) await tx.delete(ideas).where(inArray(ideas.id, unusedIdeas))
    for (const idea of ownIdeas.filter((row) => usedIdeaIds.has(row.id))) {
      const archive = idea.status === "draft" || idea.status === "open"
      await tx
        .update(ideas)
        .set({
          ...(archive ? { status: "archived" as const, archivedAt: at } : {}),
          embedding: null,
          embeddingModel: null,
          embeddingTextHash: null,
          embeddedAt: null,
        })
        .where(eq(ideas.id, idea.id))
      if (archive) {
        trackLater.push({
          type: "idea.archived",
          actorUserId: userId,
          subjectType: "idea",
          subjectId: idea.id,
          properties: { from_status: idea.status },
        })
      }
    }
    const unusedProducts = ownProducts
      .filter((row) => !usedProductIds.has(row.id))
      .map((row) => row.id)
    if (unusedProducts.length > 0) {
      await tx.delete(products).where(inArray(products.id, unusedProducts))
    }
    for (const product of ownProducts.filter((row) => usedProductIds.has(row.id))) {
      const archive = product.status === "draft" || product.status === "seeking"
      await tx
        .update(products)
        .set({
          ...(archive ? { status: "archived" as const, archivedAt: at } : {}),
          embedding: null,
          embeddingModel: null,
          embeddingTextHash: null,
          embeddedAt: null,
        })
        .where(eq(products.id, product.id))
      if (archive) {
        trackLater.push({
          type: "product.archived",
          actorUserId: userId,
          subjectType: "product",
          subjectId: product.id,
          properties: { from_status: product.status },
        })
      }
    }

    // Open proposals close (nobody can accept a deal with a deleted account): withdrawn when the
    // user sent the current offer's proposal, declined when they received it.
    const open = await tx
      .select({
        id: proposals.id,
        fromUserId: proposals.fromUserId,
        respondedAt: proposals.respondedAt,
        revisionNumber: proposalRevisions.revisionNumber,
      })
      .from(proposals)
      .leftJoin(proposalRevisions, eq(proposalRevisions.id, proposals.currentRevisionId))
      .where(
        and(
          inArray(proposals.status, ["pending", "countered"]),
          or(eq(proposals.fromUserId, userId), eq(proposals.toUserId, userId)),
        ),
      )
      .for("update", { of: proposals })
    for (const proposal of open) {
      const sent = proposal.fromUserId === userId
      await tx
        .update(proposals)
        .set({
          status: sent ? "withdrawn" : "declined",
          closedAt: at,
          ...(!sent && !proposal.respondedAt ? { respondedAt: at } : {}),
        })
        .where(eq(proposals.id, proposal.id))
      trackLater.push({
        type: sent ? "proposal.withdrawn" : "proposal.declined",
        actorUserId: userId,
        subjectType: "proposal",
        subjectId: proposal.id,
        properties: { revision_number: proposal.revisionNumber ?? 1 },
      })
    }

    // Their messages: body replaced, attachments removed (the files go in the cleanup job).
    const authored = await tx
      .select({ id: messages.id, attachments: messages.attachments })
      .from(messages)
      .where(eq(messages.authorUserId, userId))
    for (const message of authored) {
      for (const attachment of message.attachments) storageKeys.push(attachment.storageKey)
    }
    if (authored.length > 0) {
      await tx
        .update(messages)
        .set({ body: DELETED_MESSAGE_BODY, attachments: [] })
        .where(eq(messages.authorUserId, userId))
    }

    // Append-only rows: only the redactable columns, only to NULL (migration 0011's trigger).
    await tx
      .update(proposalRevisions)
      .set({ message: null })
      .where(and(eq(proposalRevisions.authorUserId, userId), isNotNull(proposalRevisions.message)))
    await tx
      .update(agreementSignatures)
      .set({ ip: null, userAgent: null })
      .where(
        and(
          eq(agreementSignatures.userId, userId),
          or(isNotNull(agreementSignatures.ip), isNotNull(agreementSignatures.userAgent)),
        ),
      )

    await tx.delete(notifications).where(eq(notifications.userId, userId))
    await tx.delete(notificationPrefs).where(eq(notificationPrefs.userId, userId))
    await tx.delete(savedItems).where(eq(savedItems.userId, userId))

    // Stripe event payloads of their connected account: personal data redacted (§19.12 open item).
    const [stripeAccount] = await tx
      .select({ stripeAccountId: stripeAccounts.stripeAccountId })
      .from(stripeAccounts)
      .where(eq(stripeAccounts.userId, userId))
    if (stripeAccount) {
      const stored = await tx
        .select({ id: stripeEvents.id, payload: stripeEvents.payload })
        .from(stripeEvents)
        .where(eq(stripeEvents.account, stripeAccount.stripeAccountId))
      for (const event of stored) {
        await tx
          .update(stripeEvents)
          .set({ payload: redactStripePayload(event.payload) })
          .where(eq(stripeEvents.id, event.id))
      }
    }

    // Sign-in data.
    await tx.delete(sessions).where(eq(sessions.userId, userId))
    await tx.delete(accounts).where(eq(accounts.userId, userId))
    if (user.email) {
      await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, user.email))
    }

    await tx
      .update(users)
      .set({
        email: null,
        name: null,
        image: null,
        emailVerified: null,
        status: "suspended",
        deletedAt: at,
        onboardingSteps: {},
      })
      .where(eq(users.id, userId))

    if (trackLater.length > 0) await trackMany(trackLater, tx)
    await track(
      "user.deleted",
      {
        actorUserId: userId,
        subjectType: "user",
        subjectId: userId,
        properties: { roles: user.roles },
      },
      tx,
    )

    return { email: user.email, roles: user.roles, storageKeys, revocations }
  }, database)
}
