import "server-only"

import { and, asc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  agreementSignatures,
  agreements,
  audienceSnapshots,
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  disputes,
  events,
  ideas,
  launches,
  ledgerEntries,
  matches,
  messages,
  mobileSessions,
  notificationPrefs,
  notifications,
  orders,
  portfolioItems,
  products,
  proposalRevisions,
  proposals,
  savedItems,
  socialConnections,
  stripeAccounts,
  tasks,
  transfers,
  users,
} from "@/lib/db/schema"

/**
 * "Export my data" (§14; CLAUDE.md §19.38, §19.40): everything the platform holds about the user,
 * as one JSON document. Rules:
 *
 * - Never tokens or secrets: social connections leave out their token columns and the evidence
 *   storage key; access grants (buyer tokens) are never included; embeddings are left out (derived
 *   vectors, not information).
 * - Other people appear by user id and role only, never by name or email: proposals and collabs
 *   name the counterpart's id; sales list amounts and dates, never buyer emails.
 * - Only what the user wrote: messages and proposal revisions they authored, their own signatures.
 *
 * The section list is `DATA_EXPORT_SECTIONS` (tests check it stays complete).
 */

export const DATA_EXPORT_FORMAT_VERSION = 1

export const DATA_EXPORT_SECTIONS = [
  "account",
  "creatorProfile",
  "builderProfile",
  "portfolioItems",
  "socialConnections",
  "audienceSnapshots",
  "ideas",
  "products",
  "matches",
  "savedItems",
  "proposals",
  "proposalRevisions",
  "messages",
  "collabs",
  "agreements",
  "tasks",
  "disputes",
  "launches",
  "sales",
  "purchases",
  "stripeAccount",
  "ledgerEntries",
  "transfers",
  "notifications",
  "notificationPreferences",
  "mobileSessions",
  "events",
] as const

export type DataExportSection = (typeof DATA_EXPORT_SECTIONS)[number]

export type DataExport = {
  format: "json"
  version: number
  generatedAt: string
  app: string
  userId: string
} & Record<DataExportSection, unknown>

/** A table's columns without the derived embedding fields. */
function withoutEmbedding<T extends Record<string, unknown>>(columns: T) {
  const {
    embedding: _embedding,
    embeddingModel: _embeddingModel,
    embeddingTextHash: _embeddingTextHash,
    embeddedAt: _embeddedAt,
    ...rest
  } = columns
  return rest
}

export async function buildDataExport(
  database: DbOrTx,
  input: { userId: string; now: Date; appName: string },
): Promise<DataExport> {
  const { userId } = input
  const [account] = await database
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerified,
      name: users.name,
      avatarUrl: users.image,
      roles: users.roles,
      activeRole: users.activeRole,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
      onboardingSteps: users.onboardingSteps,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
  if (!account) throw new Error(`buildDataExport: user ${userId} not found`)

  const [creatorProfile] = await database
    .select(withoutEmbedding(getTableColumns(creatorProfiles)))
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
  const [builderProfile] = await database
    .select(withoutEmbedding(getTableColumns(builderProfiles)))
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))

  const portfolio = builderProfile
    ? await database
        .select({
          id: portfolioItems.id,
          title: portfolioItems.title,
          url: portfolioItems.url,
          description: portfolioItems.description,
          format: portfolioItems.format,
          isShipped: portfolioItems.isShipped,
          hasImage: sql<boolean>`${portfolioItems.imageUrl} IS NOT NULL`,
          createdAt: portfolioItems.createdAt,
        })
        .from(portfolioItems)
        .where(eq(portfolioItems.builderProfileId, builderProfile.id))
        .orderBy(asc(portfolioItems.createdAt))
    : []

  // Connections without token columns or the evidence storage key (§14: tokens never leave).
  const connections = await database
    .select({
      id: socialConnections.id,
      provider: socialConnections.provider,
      source: socialConnections.source,
      username: socialConnections.username,
      displayName: socialConnections.displayName,
      profileUrl: socialConnections.profileUrl,
      scopes: socialConnections.scopes,
      status: socialConnections.status,
      verifiedAt: socialConnections.verifiedAt,
      lastSyncedAt: socialConnections.lastSyncedAt,
      lastSyncError: socialConnections.lastSyncError,
      createdAt: socialConnections.createdAt,
    })
    .from(socialConnections)
    .where(eq(socialConnections.userId, userId))
  const connectionIds = connections.map((connection) => connection.id)
  const snapshots =
    connectionIds.length > 0
      ? await database
          .select({
            socialConnectionId: audienceSnapshots.socialConnectionId,
            takenAt: audienceSnapshots.takenAt,
            followers: audienceSnapshots.followers,
            avgViews: audienceSnapshots.avgViews,
            engagementRate: audienceSnapshots.engagementRate,
            topCountries: audienceSnapshots.topCountries,
            countriesBasis: audienceSnapshots.countriesBasis,
            ageGender: audienceSnapshots.ageGender,
            topTopics: audienceSnapshots.topTopics,
            raw: audienceSnapshots.raw,
          })
          .from(audienceSnapshots)
          .where(inArray(audienceSnapshots.socialConnectionId, connectionIds))
          .orderBy(asc(audienceSnapshots.takenAt))
      : []

  const ownIdeas = creatorProfile
    ? await database
        .select(withoutEmbedding(getTableColumns(ideas)))
        .from(ideas)
        .where(eq(ideas.creatorProfileId, creatorProfile.id))
        .orderBy(asc(ideas.createdAt))
    : []
  const ownProducts = builderProfile
    ? await database
        .select(withoutEmbedding(getTableColumns(products)))
        .from(products)
        .where(eq(products.builderProfileId, builderProfile.id))
        .orderBy(asc(products.createdAt))
    : []

  const ownMatches = await database
    .select({
      id: matches.id,
      targetType: matches.targetType,
      targetId: matches.targetId,
      score: matches.score,
      features: matches.features,
      modelVersion: matches.modelVersion,
      status: matches.status,
      computedAt: matches.computedAt,
      shownAt: matches.shownAt,
    })
    .from(matches)
    .where(eq(matches.subjectUserId, userId))
    .orderBy(asc(matches.computedAt))
  const saved = await database
    .select({
      targetType: savedItems.targetType,
      targetId: savedItems.targetId,
      createdAt: savedItems.createdAt,
    })
    .from(savedItems)
    .where(eq(savedItems.userId, userId))

  const proposalRows = await database
    .select({
      id: proposals.id,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      ideaId: proposals.ideaId,
      productId: proposals.productId,
      status: proposals.status,
      createdAt: proposals.createdAt,
      expiresAt: proposals.expiresAt,
      respondedAt: proposals.respondedAt,
      closedAt: proposals.closedAt,
    })
    .from(proposals)
    .where(or(eq(proposals.fromUserId, userId), eq(proposals.toUserId, userId)))
    .orderBy(asc(proposals.createdAt))
  const ownProposals = proposalRows.map((row) => ({
    id: row.id,
    yourSide: row.fromUserId === userId ? "sender" : "recipient",
    counterpartUserId: row.fromUserId === userId ? row.toUserId : row.fromUserId,
    ideaId: row.ideaId,
    productId: row.productId,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    respondedAt: row.respondedAt,
    closedAt: row.closedAt,
  }))
  const revisions = await database
    .select({
      proposalId: proposalRevisions.proposalId,
      revisionNumber: proposalRevisions.revisionNumber,
      message: proposalRevisions.message,
      scope: proposalRevisions.scope,
      creatorSplitPct: proposalRevisions.creatorSplitPct,
      builderSplitPct: proposalRevisions.builderSplitPct,
      timelineWeeks: proposalRevisions.timelineWeeks,
      createdAt: proposalRevisions.createdAt,
    })
    .from(proposalRevisions)
    .where(eq(proposalRevisions.authorUserId, userId))
    .orderBy(asc(proposalRevisions.createdAt))

  const messageRows = await database
    .select({
      id: messages.id,
      threadId: messages.threadId,
      body: messages.body,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.authorUserId, userId))
    .orderBy(asc(messages.createdAt))
  const ownMessages = messageRows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    createdAt: row.createdAt,
    body: row.body,
    attachmentNames: row.attachments.map((attachment) => attachment.filename),
  }))

  // Collabs the user is a member of; the other member by id and role only.
  const memberships = await database
    .select({
      collabId: collabMembers.collabId,
      role: collabMembers.role,
      splitPct: collabMembers.splitPct,
      stage: collabs.stage,
      ideaId: collabs.ideaId,
      productId: collabs.productId,
      createdAt: collabs.createdAt,
      endedAt: collabs.endedAt,
      endedReason: collabs.endedReason,
    })
    .from(collabMembers)
    .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
    .where(eq(collabMembers.userId, userId))
    .orderBy(asc(collabs.createdAt))
  const collabIds = memberships.map((membership) => membership.collabId)
  const coMembers =
    collabIds.length > 0
      ? await database
          .select({
            collabId: collabMembers.collabId,
            userId: collabMembers.userId,
            role: collabMembers.role,
            splitPct: collabMembers.splitPct,
          })
          .from(collabMembers)
          .where(and(inArray(collabMembers.collabId, collabIds)))
      : []
  const ownCollabs = memberships.map((membership) => ({
    ...membership,
    otherMembers: coMembers
      .filter((member) => member.collabId === membership.collabId && member.userId !== userId)
      .map((member) => ({ userId: member.userId, role: member.role, splitPct: member.splitPct })),
  }))

  const agreementRows =
    collabIds.length > 0
      ? await database
          .select({
            id: agreements.id,
            collabId: agreements.collabId,
            templateVersion: agreements.templateVersion,
            status: agreements.status,
            renderedBody: agreements.renderedBody,
            bodyHash: agreements.bodyHash,
            createdAt: agreements.createdAt,
            completedAt: agreements.completedAt,
            terminatedAt: agreements.terminatedAt,
          })
          .from(agreements)
          .where(inArray(agreements.collabId, collabIds))
          .orderBy(asc(agreements.createdAt))
      : []
  const ownSignatures = await database
    .select({
      agreementId: agreementSignatures.agreementId,
      signedAt: agreementSignatures.signedAt,
      typedName: agreementSignatures.typedName,
      ip: agreementSignatures.ip,
      userAgent: agreementSignatures.userAgent,
      bodyHash: agreementSignatures.bodyHash,
    })
    .from(agreementSignatures)
    .where(eq(agreementSignatures.userId, userId))
  const ownAgreements = agreementRows.map((agreement) => ({
    ...agreement,
    yourSignature:
      ownSignatures.find((signature) => signature.agreementId === agreement.id) ?? null,
  }))

  const ownTasks = await database
    .select({
      id: tasks.id,
      collabId: tasks.collabId,
      title: tasks.title,
      description: tasks.description,
      createdByYou: sql<boolean>`${tasks.createdByUserId} = ${userId}`,
      assignedToYou: sql<boolean>`${tasks.assigneeUserId} = ${userId}`,
      dueDate: tasks.dueDate,
      doneAt: tasks.doneAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(or(eq(tasks.createdByUserId, userId), eq(tasks.assigneeUserId, userId)))
    .orderBy(asc(tasks.createdAt))

  const ownDisputes = await database
    .select({
      id: disputes.id,
      collabId: disputes.collabId,
      kind: disputes.kind,
      description: disputes.description,
      status: disputes.status,
      outcome: disputes.outcome,
      resolutionNote: disputes.resolutionNote,
      createdAt: disputes.createdAt,
      resolvedAt: disputes.resolvedAt,
    })
    .from(disputes)
    .where(eq(disputes.raisedByUserId, userId))
    .orderBy(asc(disputes.createdAt))

  const launchRows =
    collabIds.length > 0
      ? await database
          .select({
            id: launches.id,
            collabId: launches.collabId,
            slug: launches.slug,
            title: launches.title,
            tagline: launches.tagline,
            status: launches.status,
            priceCents: launches.priceCents,
            currency: launches.currency,
            deliveryType: launches.deliveryType,
            wentLiveAt: launches.wentLiveAt,
            endedAt: launches.endedAt,
            createdAt: launches.createdAt,
          })
          .from(launches)
          .where(inArray(launches.collabId, collabIds))
      : []
  const launchIds = launchRows.map((launch) => launch.id)
  // Sales as amounts and dates; never the buyer's email or country (someone else's data).
  const sales =
    launchIds.length > 0
      ? await database
          .select({
            id: orders.id,
            launchId: orders.launchId,
            amountGrossCents: orders.amountGrossCents,
            taxCents: orders.taxCents,
            discountCents: orders.discountCents,
            stripeFeeCents: orders.stripeFeeCents,
            amountRefundedCents: orders.amountRefundedCents,
            currency: orders.currency,
            status: orders.status,
            paidAt: orders.paidAt,
          })
          .from(orders)
          .where(inArray(orders.launchId, launchIds))
          .orderBy(asc(orders.paidAt))
      : []
  // Purchases made with the user's own email address (no access token).
  const purchases = account.email
    ? await database
        .select({
          orderId: orders.id,
          launchTitle: launches.title,
          amountGrossCents: orders.amountGrossCents,
          amountRefundedCents: orders.amountRefundedCents,
          currency: orders.currency,
          status: orders.status,
          paidAt: orders.paidAt,
        })
        .from(orders)
        .innerJoin(launches, eq(launches.id, orders.launchId))
        .where(sql`lower(${orders.buyerEmail}) = lower(${account.email})`)
        .orderBy(asc(orders.paidAt))
    : []

  const [stripeAccount] = await database
    .select({
      stripeAccountId: stripeAccounts.stripeAccountId,
      country: stripeAccounts.country,
      chargesEnabled: stripeAccounts.chargesEnabled,
      payoutsEnabled: stripeAccounts.payoutsEnabled,
      detailsSubmitted: stripeAccounts.detailsSubmitted,
      transfersCapability: stripeAccounts.transfersCapability,
      createdAt: stripeAccounts.createdAt,
    })
    .from(stripeAccounts)
    .where(eq(stripeAccounts.userId, userId))
  const ledger = await database
    .select({
      id: ledgerEntries.id,
      orderId: ledgerEntries.orderId,
      refundId: ledgerEntries.refundId,
      chargebackId: ledgerEntries.chargebackId,
      adjustmentId: ledgerEntries.adjustmentId,
      account: ledgerEntries.account,
      amountCents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
      availableAt: ledgerEntries.availableAt,
      transferId: ledgerEntries.transferId,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .orderBy(asc(ledgerEntries.createdAt))
  const ownTransfers = await database
    .select({
      id: transfers.id,
      stripeTransferId: transfers.stripeTransferId,
      amountCents: transfers.amountCents,
      amountReversedCents: transfers.amountReversedCents,
      currency: transfers.currency,
      status: transfers.status,
      createdAt: transfers.createdAt,
    })
    .from(transfers)
    .where(eq(transfers.userId, userId))
    .orderBy(asc(transfers.createdAt))

  const ownNotifications = await database
    .select({
      type: notifications.type,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.inApp, true)))
    .orderBy(asc(notifications.createdAt))
  const prefs = await database
    .select({
      type: notificationPrefs.type,
      email: notificationPrefs.email,
      inApp: notificationPrefs.inApp,
    })
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
  const ownEvents = await database
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      properties: events.properties,
      context: events.context,
    })
    .from(events)
    .where(eq(events.actorUserId, userId))
    .orderBy(asc(events.occurredAt))

  // The iPhone app's signed-in devices (CLAUDE.md §19.44): device name and dates, never the token
  // hash.
  const phones = await database
    .select({
      id: mobileSessions.id,
      deviceName: mobileSessions.deviceName,
      createdAt: mobileSessions.createdAt,
      lastUsedAt: mobileSessions.lastUsedAt,
      expiresAt: mobileSessions.expiresAt,
    })
    .from(mobileSessions)
    .where(eq(mobileSessions.userId, userId))
    .orderBy(asc(mobileSessions.createdAt))

  return {
    format: "json",
    version: DATA_EXPORT_FORMAT_VERSION,
    generatedAt: input.now.toISOString(),
    app: input.appName,
    userId,
    account,
    creatorProfile: creatorProfile ?? null,
    builderProfile: builderProfile ?? null,
    portfolioItems: portfolio,
    socialConnections: connections,
    audienceSnapshots: snapshots,
    ideas: ownIdeas,
    products: ownProducts,
    matches: ownMatches,
    savedItems: saved,
    proposals: ownProposals,
    proposalRevisions: revisions,
    messages: ownMessages,
    collabs: ownCollabs,
    agreements: ownAgreements,
    tasks: ownTasks,
    disputes: ownDisputes,
    launches: launchRows,
    sales,
    purchases,
    stripeAccount: stripeAccount ?? null,
    ledgerEntries: ledger,
    transfers: ownTransfers,
    notifications: ownNotifications,
    notificationPreferences: prefs,
    mobileSessions: phones,
    events: ownEvents,
  }
}

/** `<app>-data-<YYYY-MM-DD>.json`, file-name safe. */
export function dataExportFilename(appName: string, at: Date): string {
  const slug =
    appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "account"
  return `${slug}-data-${at.toISOString().slice(0, 10)}.json`
}
