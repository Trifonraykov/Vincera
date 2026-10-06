import type {
  AgreementStatus,
  CollabStage,
  DisputeStatus,
  IdeaStatus,
  LaunchPausedBy,
  LaunchStatus,
  ProductStatus,
  ProposalStatus,
  RefundRequestStatus,
  ThreadKind,
} from "@/lib/db/schema/enums"
import type { AppRole } from "@/lib/nav"

import type { AuthUser, UserRole } from "./user"

/**
 * Authorization rules (§6): pure functions over plain objects, so pages, server actions, the
 * proxy and tests share one definition. Every page loader and server action calls one of these.
 *
 * They never load data. Callers pass what the rule needs (for collab rules: the member ids),
 * typically selected in the same query that loads the record.
 */

/** The user fields authorization depends on. `AuthUser` satisfies it. */
export type AuthzUser = Pick<AuthUser, "id" | "roles" | "status" | "onboardingCompletedAt">

/** Suspended users may not act at all; every rule below starts from this. */
export function isActive(user: Pick<AuthzUser, "status">): boolean {
  return user.status === "active"
}

export function hasRole(user: Pick<AuthzUser, "roles">, role: UserRole): boolean {
  return user.roles.includes(role)
}

export function isAdmin(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && hasRole(user, "admin")
}

/** `/admin/*` (§6): active users with the `admin` role. */
export function canAccessAdmin(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isAdmin(user)
}

/**
 * Self-service on the user's own account (choosing roles, own settings): any active user. Use it
 * only for actions that read or change nothing but the signed-in user's own rows; anything that
 * touches another user's data needs a rule about that data.
 */
export function canManageOwnAccount(user: Pick<AuthzUser, "status">): boolean {
  return isActive(user)
}

/** The role switcher (§12) may only pick an app role the user already has. */
export function canSwitchToRole(
  user: Pick<AuthzUser, "roles" | "status">,
  role: string,
): role is AppRole {
  return isActive(user) && (role === "creator" || role === "builder") && hasRole(user, role)
}

/** Whether the user finished onboarding (Phase 1 sets `onboarding_completed_at` on the last step). */
export function hasCompletedOnboarding(user: Pick<AuthzUser, "onboardingCompletedAt">): boolean {
  return user.onboardingCompletedAt !== null
}

// --- Profiles (Phase 1) -----------------------------------------------------------------------

/** Create or edit the user's own creator profile (onboarding step, Settings → Profile). */
export function canEditCreatorProfile(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && hasRole(user, "creator")
}

/** Create or edit the user's own builder profile, and add portfolio items to it. */
export function canEditBuilderProfile(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && hasRole(user, "builder")
}

/** What portfolio item rules need: the user who owns the item's builder profile. */
export type PortfolioItemAccess = { ownerUserId: string }

/** Edit or delete a portfolio item: only on the user's own builder profile. */
export function canManagePortfolioItem(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  item: PortfolioItemAccess,
): boolean {
  return canEditBuilderProfile(user) && item.ownerUserId === user.id
}

// --- Supply: ideas and products (Phase 2) -----------------------------------------------------
// Ownership rules only; which status allows which change is the state machine in lib/ideas and
// lib/products (CLAUDE.md §19.24 "Ideas and products").

/** Idea statuses visible to other signed-in users (briefs, proposals, collabs). */
export const PUBLIC_IDEA_STATUSES = [
  "open",
  "in_collab",
  "launched",
] as const satisfies readonly IdeaStatus[]
/** Product statuses visible to other signed-in users. */
export const PUBLIC_PRODUCT_STATUSES = [
  "seeking",
  "in_collab",
  "launched",
] as const satisfies readonly ProductStatus[]

/** What idea and product rules need: the owner's user id and the status. */
export type IdeaAccess = { ownerUserId: string; status: IdeaStatus }
export type ProductAccess = { ownerUserId: string; status: ProductStatus }

/** Post a new idea (`/app/ideas/new`): an active creator. The action also needs their profile. */
export function canCreateIdea(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return canEditCreatorProfile(user)
}

/** Edit, publish, archive or restore an idea: its owner only (admins get tools in Phase 6). */
export function canManageIdea(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  idea: Pick<IdeaAccess, "ownerUserId">,
): boolean {
  return canCreateIdea(user) && idea.ownerUserId === user.id
}

/** See an idea: the owner and admins always; other active users once it is published. */
export function canViewIdea(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  idea: IdeaAccess,
): boolean {
  if (!isActive(user)) return false
  if (idea.ownerUserId === user.id || isAdmin(user)) return true
  return (PUBLIC_IDEA_STATUSES as readonly string[]).includes(idea.status)
}

/** List a new product (`/app/products/new`): an active builder. */
export function canCreateProduct(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return canEditBuilderProfile(user)
}

/** Edit, publish, archive or restore a product: its owner only. */
export function canManageProduct(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  product: Pick<ProductAccess, "ownerUserId">,
): boolean {
  return canCreateProduct(user) && product.ownerUserId === user.id
}

/**
 * Import listings from the App Store or a web page, connect, verify or refresh an App Store
 * developer account (CLAUDE.md §19.45): the same people who may create products.
 */
export function canImportListings(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return canCreateProduct(user)
}

/** The creator feed (`/app/feed`, CLAUDE.md §19.45): active creators. */
export function canBrowseFeed(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && hasRole(user, "creator")
}

/** Mark a builder's App Store developer account as theirs after checking it by hand: admins. */
export function canVerifyAppStoreAccount(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isAdmin(user)
}

/** See a product: the owner and admins always; other active users once it is published. */
export function canViewProduct(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  product: ProductAccess,
): boolean {
  if (!isActive(user)) return false
  if (product.ownerUserId === user.id || isAdmin(user)) return true
  return (PUBLIC_PRODUCT_STATUSES as readonly string[]).includes(product.status)
}

// --- Matching (Phase 2) -----------------------------------------------------------------------

/** `/app/discover/*` for the active role: an active user with that app role. */
export function canDiscover(user: Pick<AuthzUser, "roles" | "status">, role: AppRole): boolean {
  return isActive(user) && hasRole(user, role)
}

/** Save, unsave, dismiss or click through a match: only the user the match was computed for. */
export function canActOnMatch(
  user: Pick<AuthzUser, "id" | "status">,
  match: { subjectUserId: string },
): boolean {
  return isActive(user) && match.subjectUserId === user.id
}

// --- Proposals (Phase 3) ----------------------------------------------------------------------

/** Proposal statuses still waiting for an answer; the others are final. */
export const OPEN_PROPOSAL_STATUSES = [
  "pending",
  "countered",
] as const satisfies readonly ProposalStatus[]

export function isOpenProposal(status: ProposalStatus): boolean {
  return (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)
}

/**
 * What a proposal is about (§12 `/app/proposals/new?to=…&idea=…|&product=…`): an idea (owned by a
 * creator) or a product (owned by a builder), with its owner and status.
 */
export type ProposalTarget =
  | { kind: "idea"; ownerUserId: string; status: IdeaStatus }
  | { kind: "product"; ownerUserId: string; status: ProductStatus }

/**
 * May `user` see this idea or product on the new-proposal page: `canViewIdea` / `canViewProduct`
 * (the owner, an admin, or a published status). Drafts and archived items stay hidden even from
 * someone holding their id (CLAUDE.md §19.30).
 */
export function canViewProposalTarget(
  user: Pick<AuthzUser, "id" | "roles" | "status">,
  target: ProposalTarget,
): boolean {
  return target.kind === "idea" ? canViewIdea(user, target) : canViewProduct(user, target)
}

/** The person a proposal goes to. */
export type ProposalRecipient = Pick<AuthzUser, "id" | "roles" | "status" | "onboardingCompletedAt">

/**
 * §12: send a proposal. Either side may propose (§1 "Either side sends a proposal"), so the target
 * belongs to the sender or to the recipient:
 * - a builder pitches on a creator's idea, or a creator offers their own idea to a builder;
 * - a creator pitches on a builder's product, or a builder offers their own product to a creator.
 * Whoever does not own the target needs the other role (builder for ideas, creator for products).
 * Both people must be active and onboarded (§12: "blocked unless the sender has completed
 * onboarding"; someone who never finished cannot open /app to answer), not the same person, and
 * the target must be open (idea `open`, product `seeking`). The action also applies the 20/day
 * rate limit (§14) and the one-open-proposal-per-pair-and-target rule.
 */
export function canSendProposal(
  user: AuthzUser,
  input: { target: ProposalTarget; recipient: ProposalRecipient },
): boolean {
  const { target, recipient } = input
  if (!isActive(user) || !hasCompletedOnboarding(user)) return false
  if (!isActive(recipient) || !hasCompletedOnboarding(recipient)) return false
  if (recipient.id === user.id) return false
  const ownerRole: AppRole = target.kind === "idea" ? "creator" : "builder"
  const counterpartRole: AppRole = target.kind === "idea" ? "builder" : "creator"
  const [owner, counterpart] =
    target.ownerUserId === user.id
      ? [user, recipient]
      : target.ownerUserId === recipient.id
        ? [recipient, user]
        : [null, null]
  if (!owner || !counterpart) return false
  if (!hasRole(owner, ownerRole) || !hasRole(counterpart, counterpartRole)) return false
  return target.kind === "idea" ? target.status === "open" : target.status === "seeking"
}

/** What proposal rules need. `currentRevisionAuthorId`: who made the offer now on the table. */
export type ProposalAccess = {
  fromUserId: string
  toUserId: string
  status: ProposalStatus
  currentRevisionAuthorId: string | null
}

export function isProposalParty(user: Pick<AuthzUser, "id">, proposal: ProposalAccess): boolean {
  return proposal.fromUserId === user.id || proposal.toUserId === user.id
}

/** See a proposal and its revisions: the two parties and admins (read-only). */
export function canViewProposal(user: AuthzUser, proposal: ProposalAccess): boolean {
  return isActive(user) && (isProposalParty(user, proposal) || isAdmin(user))
}

/**
 * Accept, decline or counter: the party who did **not** make the offer on the table, while the
 * proposal is open (CLAUDE.md §19.24 "Proposals").
 */
export function canRespondToProposal(user: AuthzUser, proposal: ProposalAccess): boolean {
  return (
    isActive(user) &&
    isProposalParty(user, proposal) &&
    isOpenProposal(proposal.status) &&
    proposal.currentRevisionAuthorId !== null &&
    proposal.currentRevisionAuthorId !== user.id
  )
}

/** Withdraw: the party whose offer is on the table, while the proposal is open. */
export function canWithdrawProposal(user: AuthzUser, proposal: ProposalAccess): boolean {
  return (
    isActive(user) &&
    isProposalParty(user, proposal) &&
    isOpenProposal(proposal.status) &&
    proposal.currentRevisionAuthorId === user.id
  )
}

// --- Collaboration (Phases 3–4) ---------------------------------------------------------------

/** What collab rules need: the ids of the collab's members (`collab_members.user_id`). */
export type CollabAccess = { memberUserIds: readonly string[] }

export function isCollabMember(user: Pick<AuthzUser, "id">, collab: CollabAccess): boolean {
  return collab.memberUserIds.includes(user.id)
}

/**
 * §6: collab data is visible only to its members and admins (admins read-only; their actions
 * go through admin routes and the audit log).
 */
export function canViewCollab(user: AuthzUser, collab: CollabAccess): boolean {
  return isActive(user) && (isCollabMember(user, collab) || isAdmin(user))
}

/**
 * Work in a collab (tasks, messages): an active member while the collab has not ended. Admins
 * read only.
 */
export function canWorkInCollab(
  user: AuthzUser,
  collab: CollabAccess & { stage: CollabStage },
): boolean {
  return isActive(user) && isCollabMember(user, collab) && collab.stage !== "ended"
}

/**
 * Click-sign the agreement (§12): an active member who has not signed yet, while it awaits
 * signatures. The action also requires both members to be payouts-ready (plain-language error
 * naming who still has to set up payouts) and the typed full name.
 */
export function canSignAgreement(
  user: AuthzUser,
  agreement: CollabAccess & { status: AgreementStatus; signedUserIds: readonly string[] },
): boolean {
  return (
    isActive(user) &&
    isCollabMember(user, agreement) &&
    agreement.status === "awaiting_signatures" &&
    !agreement.signedUserIds.includes(user.id)
  )
}

// --- Threads and messages (Phase 3) -----------------------------------------------------------

/**
 * What thread rules need: its kind, its participants (the proposal's two parties, or the collab's
 * members) and its parent's status or stage.
 */
export type ThreadAccess =
  | {
      kind: Extract<ThreadKind, "proposal">
      participantUserIds: readonly string[]
      parentStatus: ProposalStatus
    }
  | {
      kind: Extract<ThreadKind, "collab">
      participantUserIds: readonly string[]
      parentStatus: CollabStage
    }

/** Read a thread: its participants and admins (read-only). */
export function canViewThread(user: AuthzUser, thread: ThreadAccess): boolean {
  return isActive(user) && (thread.participantUserIds.includes(user.id) || isAdmin(user))
}

/**
 * Post in a thread: a participant, while a proposal is open or a collab has not ended (a closed
 * proposal's thread stays readable; the conversation continues in the collab's thread).
 */
export function canPostMessage(user: AuthzUser, thread: ThreadAccess): boolean {
  if (!isActive(user) || !thread.participantUserIds.includes(user.id)) return false
  return thread.kind === "proposal"
    ? isOpenProposal(thread.parentStatus)
    : thread.parentStatus !== "ended"
}

// --- Launches (Phase 4; CLAUDE.md §19.31) -----------------------------------------------------

/**
 * Launch statuses in which members may edit the launch setup page. Saving resets approvals
 * (§12): `pending_approval` and `admin_review` go back to `draft`; a `paused` launch stays paused
 * and needs both approvals again before it can resume. A `live` launch is paused first; an
 * `ended` one is never edited.
 */
export const EDITABLE_LAUNCH_STATUSES = [
  "draft",
  "pending_approval",
  "admin_review",
  "paused",
] as const satisfies readonly LaunchStatus[]

/** Statuses in which a member may approve the current version. */
export const APPROVABLE_LAUNCH_STATUSES = [
  "draft",
  "pending_approval",
  "paused",
] as const satisfies readonly LaunchStatus[]

/** What launch rules need: the collab's members, the collab stage and the launch status. */
export type LaunchAccess = CollabAccess & { status: LaunchStatus; collabStage: CollabStage }

/** The launch setup page and its data: members and admins (admins read), like the collab (§6). */
export function canViewLaunchSetup(user: AuthzUser, launch: LaunchAccess): boolean {
  return canViewCollab(user, launch)
}

/**
 * §12: either member edits the launch while it is being set up (or paused), while the collab has
 * not ended. Admins never edit a launch; they review, pause or end it.
 */
export function canEditLaunch(user: AuthzUser, launch: LaunchAccess): boolean {
  return (
    isActive(user) &&
    isCollabMember(user, launch) &&
    launch.collabStage !== "ended" &&
    (EDITABLE_LAUNCH_STATUSES as readonly string[]).includes(launch.status)
  )
}

/**
 * Approve the current version (§12): a member who has not approved it yet. The action also checks
 * that the launch is complete (price, delivery and its content) and the collab is `building` or
 * `launch_review` (or `live`, for resuming a paused launch).
 */
export function canApproveLaunch(
  user: AuthzUser,
  launch: LaunchAccess & { approvedUserIds: readonly string[] },
): boolean {
  return (
    isActive(user) &&
    isCollabMember(user, launch) &&
    launch.collabStage !== "ended" &&
    (APPROVABLE_LAUNCH_STATUSES as readonly string[]).includes(launch.status) &&
    !launch.approvedUserIds.includes(user.id)
  )
}

/** Approve or send back a launch waiting in `admin_review`: an admin. */
export function canReviewLaunch(user: AuthzUser, launch: Pick<LaunchAccess, "status">): boolean {
  return isAdmin(user) && launch.status === "admin_review"
}

/** Pause a live launch: a member or an admin. */
export function canPauseLaunch(user: AuthzUser, launch: LaunchAccess): boolean {
  return (
    isActive(user) && launch.status === "live" && (isCollabMember(user, launch) || isAdmin(user))
  )
}

/**
 * Resume a paused launch: a member when a member paused it (the action also needs both approvals
 * of the current version); only an admin when an admin or a chargeback paused it.
 */
export function canResumeLaunch(
  user: AuthzUser,
  launch: LaunchAccess & { pausedBy: LaunchPausedBy | null },
): boolean {
  if (!isActive(user) || launch.status !== "paused" || launch.collabStage === "ended") return false
  if (launch.pausedBy === "member") return isCollabMember(user, launch) || isAdmin(user)
  return isAdmin(user)
}

/** End sales for good (buyers keep their access): an admin; the collab ending ends it too. */
export function canEndLaunch(user: AuthzUser, launch: Pick<LaunchAccess, "status">): boolean {
  return isAdmin(user) && launch.status !== "ended"
}

/**
 * Create tracked links (with an optional discount code) for a launch: a member while the launch
 * is live or paused. Each link belongs to the member who made it.
 */
export function canCreateTrackedLink(user: AuthzUser, launch: LaunchAccess): boolean {
  return (
    isActive(user) &&
    isCollabMember(user, launch) &&
    (launch.status === "live" || launch.status === "paused")
  )
}

/** Rename or disable a tracked link: its owner, while still a member of the launch's collab. */
export function canManageTrackedLink(
  user: AuthzUser,
  link: CollabAccess & { ownerUserId: string },
): boolean {
  return isActive(user) && user.id === link.ownerUserId && isCollabMember(user, link)
}

// --- Money (Phase 5; CLAUDE.md §19.31) ---------------------------------------------------------

/** `/app/earnings*`: the user's own ledger, payouts and sales (anyone active with an app role). */
export function canViewOwnEarnings(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && (hasRole(user, "creator") || hasRole(user, "builder"))
}

/** Orders of a launch (the analytics and sales lists): the collab's members and admins. */
export function canViewLaunchOrders(user: AuthzUser, collab: CollabAccess): boolean {
  return canViewCollab(user, collab)
}

/**
 * Refund an order from the app: an admin (Phase 6 tools; v1 adds the buyer's request at
 * `/access/[token]/refund`). Members ask an admin.
 */
export function canRefundOrder(user: AuthzUser): boolean {
  return isAdmin(user)
}

/** Start a manual payout run or look at every batch: an admin. */
export function canManagePayouts(user: AuthzUser): boolean {
  return isAdmin(user)
}

// --- Admin (Phase 6; CLAUDE.md §19.38) ---------------------------------------------------------
// Every admin rule starts from `isAdmin` (an active admin). Admin actions also write
// `admin_audit_log` (lib/admin/audit.ts) and are refused while the admin is viewing as someone
// else (read-only impersonation refuses every mutation, lib/auth/impersonation.ts).

/** The account an admin acts on, as /admin/users loads it. */
export type AdminTargetUser = Pick<AuthzUser, "id" | "roles" | "status"> & {
  deletedAt: Date | null
}

/** Search users and open their admin detail page; read the audit log. */
export function canManageUsers(user: AuthzUser): boolean {
  return isAdmin(user)
}

/**
 * Suspend or lift a suspension: an admin, never on themselves, never on a deleted account
 * (deleted accounts stay suspended for good). Suspending another admin needs their admin role
 * revoked first, so the platform never locks out its last admin by accident.
 */
export function canSuspendUser(user: AuthzUser, target: AdminTargetUser): boolean {
  return (
    isAdmin(user) &&
    target.id !== user.id &&
    target.deletedAt === null &&
    !target.roles.includes("admin")
  )
}

/** Grant the admin role: an admin, to an active, not deleted account without it. */
export function canGrantAdmin(user: AuthzUser, target: AdminTargetUser): boolean {
  return (
    isAdmin(user) &&
    target.deletedAt === null &&
    target.status === "active" &&
    !target.roles.includes("admin")
  )
}

/** Revoke the admin role: an admin, from another admin (never from themselves). */
export function canRevokeAdmin(user: AuthzUser, target: AdminTargetUser): boolean {
  return isAdmin(user) && target.id !== user.id && target.roles.includes("admin")
}

/**
 * Start read-only "view as" (§6): an admin, on an active, not deleted, non-admin account other
 * than their own.
 */
export function canImpersonate(user: AuthzUser, target: AdminTargetUser): boolean {
  return (
    isAdmin(user) &&
    target.id !== user.id &&
    target.status === "active" &&
    target.deletedAt === null &&
    !target.roles.includes("admin")
  )
}

/** What dispute rules need. */
export type DisputeAccess = CollabAccess & { status: DisputeStatus; raisedByUserId: string }

/** Move an open dispute to `in_review`: an admin. */
export function canReviewDispute(user: AuthzUser, dispute: Pick<DisputeAccess, "status">): boolean {
  return isAdmin(user) && dispute.status === "open"
}

/** Resolve a dispute (note + outcome) once it is in review: an admin. */
export function canResolveDispute(
  user: AuthzUser,
  dispute: Pick<DisputeAccess, "status">,
): boolean {
  return isAdmin(user) && dispute.status === "in_review"
}

/** Write an audited ledger adjustment (entries summing to zero): an admin. */
export function canAdjustLedger(user: AuthzUser): boolean {
  return isAdmin(user)
}

/** Approve or decline a buyer's refund request while it is pending: an admin. */
export function canDecideRefundRequest(
  user: AuthzUser,
  request: { status: RefundRequestStatus },
): boolean {
  return isAdmin(user) && request.status === "pending"
}

/** `/admin/events` (Phase 7): an admin. Events hold no personal data by construction (§11). */
export function canViewEvents(user: AuthzUser): boolean {
  return isAdmin(user)
}

/** `/admin/matching` (Phase 7): compare, train and (de)activate model versions; an admin. */
export function canManageMatchingModels(user: AuthzUser): boolean {
  return isAdmin(user)
}

// --- Trust: disputes and GDPR (Phase 6; CLAUDE.md §19.38) --------------------------------------

/**
 * Raise a dispute about a collab: an active member, at any stage (ended collabs included: a
 * non-delivery can surface after the end), when they have no unresolved dispute on it already
 * (the database also allows one per member and collab).
 */
export function canRaiseDispute(
  user: AuthzUser,
  collab: CollabAccess & { hasUnresolvedDisputeByUser: boolean },
): boolean {
  return isActive(user) && isCollabMember(user, collab) && !collab.hasUnresolvedDisputeByUser
}

/** See a dispute and its status: the collab's members and admins (§6). */
export function canViewDispute(user: AuthzUser, dispute: CollabAccess): boolean {
  return canViewCollab(user, dispute)
}

/** Download "Export my data" (§14): the signed-in, active user, for their own account only. */
export function canExportOwnData(user: Pick<AuthzUser, "status">): boolean {
  return isActive(user)
}

/**
 * Delete the own account (§14): an active user without the admin role (an admin is removed by
 * another admin first). The action also refuses while blocking conditions hold (active collabs,
 * money not yet paid out; lib/gdpr), with a plain-language reason.
 */
export function canDeleteOwnAccount(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && !hasRole(user, "admin")
}

// --- Analytics and v1 pages (Phase 7; CLAUDE.md §19.38) ---------------------------------------

/** `/app/collabs/[id]/analytics`: the collab's members and admins (admins read). */
export function canViewCollabAnalytics(user: AuthzUser, collab: CollabAccess): boolean {
  return canViewCollab(user, collab)
}

/** `/app/launches/[id]/links`: the launch's members and admins; creating links is `canCreateTrackedLink`. */
export function canViewLaunchLinks(user: AuthzUser, launch: LaunchAccess): boolean {
  return canViewCollab(user, launch)
}

/** Days after payment within which a buyer may ask for a refund (decided by delegation, §19.38). */
export const REFUND_REQUEST_WINDOW_DAYS = 14

/** What the buyer-side refund rule needs (no user: the access token proves the purchase). */
export type RefundRequestEligibility = {
  orderStatus: "paid" | "refunded" | "partially_refunded" | "disputed"
  paidAt: Date
  amountGrossCents: number
  amountRefundedCents: number
  grantRevoked: boolean
  hasRequest: boolean
}

export type RefundRequestRefusal =
  "already_requested" | "revoked" | "disputed" | "nothing_to_refund" | "window_closed"

/**
 * May the holder of an access token ask for a refund (`/access/[token]/refund`)? Null when yes,
 * else why not. One request per order, ever; within `REFUND_REQUEST_WINDOW_DAYS` of payment; not
 * for revoked access, open chargebacks or orders with nothing left to refund.
 */
export function refundRequestRefusal(
  order: RefundRequestEligibility,
  now: Date,
): RefundRequestRefusal | null {
  if (order.hasRequest) return "already_requested"
  if (order.grantRevoked) return "revoked"
  if (order.orderStatus === "disputed") return "disputed"
  if (order.amountRefundedCents >= order.amountGrossCents) return "nothing_to_refund"
  const windowEnds = order.paidAt.getTime() + REFUND_REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000
  if (now.getTime() > windowEnds) return "window_closed"
  return null
}
