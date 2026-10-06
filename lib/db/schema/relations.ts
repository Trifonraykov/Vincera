import { relations } from "drizzle-orm"

import {
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  messages,
  proposalRevisions,
  proposals,
  tasks,
  threadReads,
  threads,
} from "./collab"
import {
  accessGrants,
  chargebacks,
  launches,
  launchFiles,
  licenseKeys,
  linkClicks,
  orders,
  refundRequests,
  refunds,
  trackedLinks,
} from "./commerce"
import { events } from "./events"
import {
  accounts,
  builderProfiles,
  creatorProfiles,
  handles,
  portfolioItems,
  sessions,
  users,
} from "./identity"
import { matches, matchingConfig, savedItems } from "./matching"
import {
  ledgerAdjustments,
  ledgerEntries,
  payoutBatches,
  stripeAccounts,
  transferReversals,
  transfers,
} from "./money"
import { audienceSnapshots, socialConnections } from "./social"
import { ideas, products } from "./supply"
import {
  adminAuditLog,
  disputes,
  impersonationSessions,
  notificationPrefs,
  notifications,
} from "./trust"

/** Relations for Drizzle's relational query API (`db.query.*`). */

// --- Identity & profiles -----------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  handles: many(handles),
  creatorProfile: one(creatorProfiles),
  builderProfile: one(builderProfiles),
  socialConnections: many(socialConnections),
  stripeAccount: one(stripeAccounts),
  collabMemberships: many(collabMembers),
  sentProposals: many(proposals, { relationName: "proposal_from" }),
  receivedProposals: many(proposals, { relationName: "proposal_to" }),
  notifications: many(notifications),
  notificationPrefs: many(notificationPrefs),
  savedItems: many(savedItems),
  matches: many(matches),
  ledgerEntries: many(ledgerEntries),
  transfers: many(transfers),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

export const handlesRelations = relations(handles, ({ one }) => ({
  user: one(users, { fields: [handles.userId], references: [users.id] }),
}))

export const creatorProfilesRelations = relations(creatorProfiles, ({ one, many }) => ({
  user: one(users, { fields: [creatorProfiles.userId], references: [users.id] }),
  ideas: many(ideas),
}))

export const builderProfilesRelations = relations(builderProfiles, ({ one, many }) => ({
  user: one(users, { fields: [builderProfiles.userId], references: [users.id] }),
  portfolioItems: many(portfolioItems),
  products: many(products),
}))

export const portfolioItemsRelations = relations(portfolioItems, ({ one }) => ({
  builderProfile: one(builderProfiles, {
    fields: [portfolioItems.builderProfileId],
    references: [builderProfiles.id],
  }),
}))

// --- Social data -------------------------------------------------------------------------------

export const socialConnectionsRelations = relations(socialConnections, ({ one, many }) => ({
  user: one(users, { fields: [socialConnections.userId], references: [users.id] }),
  snapshots: many(audienceSnapshots),
}))

export const audienceSnapshotsRelations = relations(audienceSnapshots, ({ one }) => ({
  socialConnection: one(socialConnections, {
    fields: [audienceSnapshots.socialConnectionId],
    references: [socialConnections.id],
  }),
}))

// --- Supply & demand ---------------------------------------------------------------------------

export const ideasRelations = relations(ideas, ({ one, many }) => ({
  creatorProfile: one(creatorProfiles, {
    fields: [ideas.creatorProfileId],
    references: [creatorProfiles.id],
  }),
  proposals: many(proposals),
  collabs: many(collabs),
}))

export const productsRelations = relations(products, ({ one, many }) => ({
  builderProfile: one(builderProfiles, {
    fields: [products.builderProfileId],
    references: [builderProfiles.id],
  }),
  proposals: many(proposals),
  collabs: many(collabs),
}))

// --- Matching ----------------------------------------------------------------------------------

export const matchingConfigRelations = relations(matchingConfig, ({ many }) => ({
  matches: many(matches),
}))

export const matchesRelations = relations(matches, ({ one, many }) => ({
  subjectUser: one(users, { fields: [matches.subjectUserId], references: [users.id] }),
  config: one(matchingConfig, {
    fields: [matches.modelVersion],
    references: [matchingConfig.modelVersion],
  }),
  proposals: many(proposals),
}))

export const savedItemsRelations = relations(savedItems, ({ one }) => ({
  user: one(users, { fields: [savedItems.userId], references: [users.id] }),
}))

// --- Collaboration -----------------------------------------------------------------------------

export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  fromUser: one(users, {
    fields: [proposals.fromUserId],
    references: [users.id],
    relationName: "proposal_from",
  }),
  toUser: one(users, {
    fields: [proposals.toUserId],
    references: [users.id],
    relationName: "proposal_to",
  }),
  idea: one(ideas, { fields: [proposals.ideaId], references: [ideas.id] }),
  product: one(products, { fields: [proposals.productId], references: [products.id] }),
  match: one(matches, { fields: [proposals.matchId], references: [matches.id] }),
  currentRevision: one(proposalRevisions, {
    fields: [proposals.currentRevisionId],
    references: [proposalRevisions.id],
    relationName: "proposal_current_revision",
  }),
  revisions: many(proposalRevisions, { relationName: "proposal_revisions" }),
  collab: one(collabs),
  thread: one(threads),
}))

export const proposalRevisionsRelations = relations(proposalRevisions, ({ one }) => ({
  proposal: one(proposals, {
    fields: [proposalRevisions.proposalId],
    references: [proposals.id],
    relationName: "proposal_revisions",
  }),
  author: one(users, { fields: [proposalRevisions.authorUserId], references: [users.id] }),
}))

export const collabsRelations = relations(collabs, ({ one, many }) => ({
  proposal: one(proposals, { fields: [collabs.proposalId], references: [proposals.id] }),
  idea: one(ideas, { fields: [collabs.ideaId], references: [ideas.id] }),
  product: one(products, { fields: [collabs.productId], references: [products.id] }),
  members: many(collabMembers),
  agreements: many(agreements),
  tasks: many(tasks),
  thread: one(threads),
  launch: one(launches),
  disputes: many(disputes),
}))

export const collabMembersRelations = relations(collabMembers, ({ one }) => ({
  collab: one(collabs, { fields: [collabMembers.collabId], references: [collabs.id] }),
  user: one(users, { fields: [collabMembers.userId], references: [users.id] }),
}))

export const agreementsRelations = relations(agreements, ({ one, many }) => ({
  collab: one(collabs, { fields: [agreements.collabId], references: [collabs.id] }),
  signatures: many(agreementSignatures),
}))

export const agreementSignaturesRelations = relations(agreementSignatures, ({ one }) => ({
  agreement: one(agreements, {
    fields: [agreementSignatures.agreementId],
    references: [agreements.id],
  }),
  user: one(users, { fields: [agreementSignatures.userId], references: [users.id] }),
}))

export const tasksRelations = relations(tasks, ({ one }) => ({
  collab: one(collabs, { fields: [tasks.collabId], references: [collabs.id] }),
  assignee: one(users, {
    fields: [tasks.assigneeUserId],
    references: [users.id],
    relationName: "task_assignee",
  }),
  createdBy: one(users, {
    fields: [tasks.createdByUserId],
    references: [users.id],
    relationName: "task_created_by",
  }),
  completedBy: one(users, {
    fields: [tasks.completedByUserId],
    references: [users.id],
    relationName: "task_completed_by",
  }),
}))

export const threadsRelations = relations(threads, ({ one, many }) => ({
  proposal: one(proposals, { fields: [threads.proposalId], references: [proposals.id] }),
  collab: one(collabs, { fields: [threads.collabId], references: [collabs.id] }),
  messages: many(messages),
  reads: many(threadReads),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, { fields: [messages.threadId], references: [threads.id] }),
  author: one(users, { fields: [messages.authorUserId], references: [users.id] }),
}))

export const threadReadsRelations = relations(threadReads, ({ one }) => ({
  thread: one(threads, { fields: [threadReads.threadId], references: [threads.id] }),
  user: one(users, { fields: [threadReads.userId], references: [users.id] }),
}))

// --- Launch & commerce -------------------------------------------------------------------------

export const launchesRelations = relations(launches, ({ one, many }) => ({
  collab: one(collabs, { fields: [launches.collabId], references: [collabs.id] }),
  reviewedBy: one(users, { fields: [launches.reviewedByUserId], references: [users.id] }),
  files: many(launchFiles),
  licenseKeys: many(licenseKeys),
  trackedLinks: many(trackedLinks),
  orders: many(orders),
}))

export const launchFilesRelations = relations(launchFiles, ({ one }) => ({
  launch: one(launches, { fields: [launchFiles.launchId], references: [launches.id] }),
}))

export const licenseKeysRelations = relations(licenseKeys, ({ one }) => ({
  launch: one(launches, { fields: [licenseKeys.launchId], references: [launches.id] }),
  order: one(orders, { fields: [licenseKeys.orderId], references: [orders.id] }),
}))

export const trackedLinksRelations = relations(trackedLinks, ({ one, many }) => ({
  launch: one(launches, { fields: [trackedLinks.launchId], references: [launches.id] }),
  owner: one(users, { fields: [trackedLinks.ownerUserId], references: [users.id] }),
  clicks: many(linkClicks),
  orders: many(orders),
}))

export const linkClicksRelations = relations(linkClicks, ({ one }) => ({
  trackedLink: one(trackedLinks, {
    fields: [linkClicks.trackedLinkId],
    references: [trackedLinks.id],
  }),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  launch: one(launches, { fields: [orders.launchId], references: [launches.id] }),
  trackedLink: one(trackedLinks, {
    fields: [orders.trackedLinkId],
    references: [trackedLinks.id],
  }),
  accessGrants: many(accessGrants),
  refunds: many(refunds),
  chargebacks: many(chargebacks),
  ledgerEntries: many(ledgerEntries),
  licenseKey: one(licenseKeys),
}))

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
  order: one(orders, { fields: [accessGrants.orderId], references: [orders.id] }),
}))

export const refundsRelations = relations(refunds, ({ one, many }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  requestedBy: one(users, { fields: [refunds.requestedByUserId], references: [users.id] }),
  ledgerEntries: many(ledgerEntries),
  transferReversals: many(transferReversals),
}))

export const refundRequestsRelations = relations(refundRequests, ({ one }) => ({
  order: one(orders, { fields: [refundRequests.orderId], references: [orders.id] }),
  accessGrant: one(accessGrants, {
    fields: [refundRequests.accessGrantId],
    references: [accessGrants.id],
  }),
  refund: one(refunds, { fields: [refundRequests.refundId], references: [refunds.id] }),
  decidedBy: one(users, { fields: [refundRequests.decidedByUserId], references: [users.id] }),
}))

export const chargebacksRelations = relations(chargebacks, ({ one, many }) => ({
  order: one(orders, { fields: [chargebacks.orderId], references: [orders.id] }),
  ledgerEntries: many(ledgerEntries),
  transferReversals: many(transferReversals),
}))

// --- Money -------------------------------------------------------------------------------------

export const stripeAccountsRelations = relations(stripeAccounts, ({ one }) => ({
  user: one(users, { fields: [stripeAccounts.userId], references: [users.id] }),
}))

export const payoutBatchesRelations = relations(payoutBatches, ({ many }) => ({
  transfers: many(transfers),
}))

export const transfersRelations = relations(transfers, ({ one, many }) => ({
  batch: one(payoutBatches, { fields: [transfers.batchId], references: [payoutBatches.id] }),
  user: one(users, { fields: [transfers.userId], references: [users.id] }),
  ledgerEntries: many(ledgerEntries),
  reversals: many(transferReversals),
}))

export const transferReversalsRelations = relations(transferReversals, ({ one }) => ({
  transfer: one(transfers, {
    fields: [transferReversals.transferId],
    references: [transfers.id],
  }),
  refund: one(refunds, { fields: [transferReversals.refundId], references: [refunds.id] }),
  chargeback: one(chargebacks, {
    fields: [transferReversals.chargebackId],
    references: [chargebacks.id],
  }),
}))

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  order: one(orders, { fields: [ledgerEntries.orderId], references: [orders.id] }),
  refund: one(refunds, { fields: [ledgerEntries.refundId], references: [refunds.id] }),
  chargeback: one(chargebacks, {
    fields: [ledgerEntries.chargebackId],
    references: [chargebacks.id],
  }),
  user: one(users, { fields: [ledgerEntries.userId], references: [users.id] }),
  transfer: one(transfers, { fields: [ledgerEntries.transferId], references: [transfers.id] }),
  adjustment: one(ledgerAdjustments, {
    fields: [ledgerEntries.adjustmentId],
    references: [ledgerAdjustments.id],
  }),
}))

export const ledgerAdjustmentsRelations = relations(ledgerAdjustments, ({ one, many }) => ({
  admin: one(users, { fields: [ledgerAdjustments.adminUserId], references: [users.id] }),
  dispute: one(disputes, { fields: [ledgerAdjustments.disputeId], references: [disputes.id] }),
  order: one(orders, { fields: [ledgerAdjustments.orderId], references: [orders.id] }),
  entries: many(ledgerEntries),
}))

// --- Trust & ops -------------------------------------------------------------------------------

export const disputesRelations = relations(disputes, ({ one, many }) => ({
  collab: one(collabs, { fields: [disputes.collabId], references: [collabs.id] }),
  raisedBy: one(users, {
    fields: [disputes.raisedByUserId],
    references: [users.id],
    relationName: "dispute_raised_by",
  }),
  resolver: one(users, {
    fields: [disputes.resolvedBy],
    references: [users.id],
    relationName: "dispute_resolved_by",
  }),
  reviewer: one(users, {
    fields: [disputes.inReviewByUserId],
    references: [users.id],
    relationName: "dispute_in_review_by",
  }),
  adjustments: many(ledgerAdjustments),
}))

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}))

export const notificationPrefsRelations = relations(notificationPrefs, ({ one }) => ({
  user: one(users, { fields: [notificationPrefs.userId], references: [users.id] }),
}))

export const adminAuditLogRelations = relations(adminAuditLog, ({ one }) => ({
  admin: one(users, { fields: [adminAuditLog.adminUserId], references: [users.id] }),
}))

export const impersonationSessionsRelations = relations(impersonationSessions, ({ one }) => ({
  admin: one(users, {
    fields: [impersonationSessions.adminUserId],
    references: [users.id],
    relationName: "impersonation_admin",
  }),
  target: one(users, {
    fields: [impersonationSessions.targetUserId],
    references: [users.id],
    relationName: "impersonation_target",
  }),
}))

export const eventsRelations = relations(events, ({ one }) => ({
  actor: one(users, { fields: [events.actorUserId], references: [users.id] }),
}))
