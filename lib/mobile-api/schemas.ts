import { z } from "zod"

/**
 * The wire contract of the mobile API `/api/mobile/v1/*` (CLAUDE.md §19.44), shared by the
 * server (which validates every request and every response against it) and the native iPhone app
 * in `mobile/` (which imports this file through Metro and TypeScript path mapping).
 *
 * Rules for this file:
 * - It imports only `zod`, so Metro can bundle it without the server's code. Enum values are
 *   copied here; tests/unit/mobile-api-schemas.test.ts fails when they drift from the database.
 * - Responses describe JSON: dates are ISO 8601 strings, money is integer minor units (cents).
 * - Request bodies here check the shape only. The server then runs the same form schemas as the
 *   web pages (lib/ideas/fields.ts, lib/proposals/fields.ts, …), so limits and plain-language
 *   messages are identical on both clients.
 */

export const MOBILE_API_VERSION = "v1"
export const MOBILE_API_PREFIX = `/api/mobile/${MOBILE_API_VERSION}`

// --- Enums (copies of lib/db/schema/enums.ts) ---------------------------------------------------

export const USER_ROLE_VALUES = ["creator", "builder", "admin"] as const
export const APP_ROLE_VALUES = ["creator", "builder"] as const
export const SIZE_TIER_VALUES = ["nano", "micro", "mid", "macro"] as const
export const AVAILABILITY_VALUES = ["open", "limited", "closed"] as const
export const DEAL_PREFERENCE_VALUES = ["split", "fixed", "either"] as const
export const PRODUCT_FORMAT_VALUES = [
  "app",
  "tool",
  "template",
  "ai_utility",
  "course_tool",
  "other",
] as const
export const PRODUCT_STAGE_VALUES = ["idea", "prototype", "beta", "live"] as const
export const IDEA_STATUS_VALUES = ["draft", "open", "in_collab", "launched", "archived"] as const
export const PRODUCT_STATUS_VALUES = [
  "draft",
  "seeking",
  "in_collab",
  "launched",
  "archived",
] as const
export const TARGET_TYPE_VALUES = ["creator", "builder", "idea", "product"] as const
export const MATCH_STATUS_VALUES = ["shown", "saved", "dismissed", "proposed"] as const
export const PROPOSAL_STATUS_VALUES = [
  "pending",
  "countered",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const
export const COLLAB_STAGE_VALUES = [
  "agreement",
  "building",
  "launch_review",
  "live",
  "ended",
] as const
export const COLLAB_ROLE_VALUES = ["creator", "builder"] as const
export const AGREEMENT_STATUS_VALUES = ["awaiting_signatures", "signed", "terminated"] as const
export const THREAD_KIND_VALUES = ["proposal", "collab"] as const
export const ORDER_STATUS_VALUES = ["paid", "refunded", "partially_refunded", "disputed"] as const
export const SOCIAL_PROVIDER_VALUES = ["youtube", "instagram", "tiktok", "github"] as const
export const MATCH_FEATURE_VALUES = [
  "semantic",
  "topic_overlap",
  "audience_fit",
  "format_fit",
  "stage_fit",
  "price_fit",
  "reliability",
] as const
export const PROPOSAL_TAB_VALUES = ["received", "sent", "closed"] as const
export const PROPOSAL_ACTION_VALUES = ["counter", "accept", "decline", "withdraw"] as const
export const DISCOVER_VIEW_VALUES = ["for_you", "creators", "builders", "briefs", "saved"] as const
export const SUPPLY_FILTER_VALUES = [
  "all",
  "draft",
  "live",
  "in_collab",
  "launched",
  "archived",
] as const

export type AppRole = (typeof APP_ROLE_VALUES)[number]
export type ProposalTab = (typeof PROPOSAL_TAB_VALUES)[number]
export type DiscoverView = (typeof DISCOVER_VIEW_VALUES)[number]
export type SupplyFilter = (typeof SUPPLY_FILTER_VALUES)[number]

const isoDate = z.iso.datetime({ offset: true })
const uuid = z.uuid()
const cents = z.number().int()

// --- Errors ---------------------------------------------------------------------------------------

export const API_ERROR_CODES = [
  "invalid_input",
  "unauthorized",
  "forbidden",
  "suspended",
  "onboarding_required",
  "not_found",
  "refused",
  "rate_limited",
  "unavailable",
  "internal",
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Every non-2xx response: a plain-language `message` people can read, plus field errors. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

// --- Auth -----------------------------------------------------------------------------------------

export const requestCodeInput = z.object({
  email: z.string().max(254),
  /** Only used when this email has no account yet (sign-up). */
  name: z.string().max(100).optional(),
})
export const requestCodeOutput = z.object({ sent: z.literal(true) })

export const verifyCodeInput = z.object({
  email: z.string().max(254),
  /** The 8-character code from the email, typed with or without the dash. */
  code: z.string().max(32),
  deviceName: z.string().max(100).optional(),
  /** Used for a first sign-in (sign-up), like the web's /sign-up name. */
  name: z.string().max(100).optional(),
})

export const profileRefSchema = z.object({ handle: z.string(), displayName: z.string() })

export const meSchema = z.object({
  id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  roles: z.array(z.enum(USER_ROLE_VALUES)),
  activeRole: z.enum(USER_ROLE_VALUES).nullable(),
  onboarded: z.boolean(),
  /** Where to finish onboarding on the web when `onboarded` is false (absolute URL). */
  onboardingUrl: z.string().nullable(),
  profiles: z.object({
    creator: profileRefSchema.nullable(),
    builder: profileRefSchema.nullable(),
  }),
  unread: z.object({ notifications: z.number().int(), messages: z.number().int() }),
  /** The web app, for things the native app links out to (payouts, onboarding). */
  webUrl: z.string(),
})
export type Me = z.infer<typeof meSchema>

export const verifyCodeOutput = z.object({
  token: z.string(),
  expiresAt: isoDate,
  me: meSchema,
})
export const signOutOutput = z.object({ signedOut: z.literal(true) })

export const switchRoleInput = z.object({ role: z.enum(APP_ROLE_VALUES) })

// --- Shared pieces ---------------------------------------------------------------------------------

export const partySchema = z.object({
  userId: uuid,
  role: z.enum(COLLAB_ROLE_VALUES),
  name: z.string(),
  handle: z.string().nullable(),
})
export type Party = z.infer<typeof partySchema>

export const okSchema = z.object({ ok: z.literal(true) })

// --- Discover -------------------------------------------------------------------------------------

const cardBase = { id: uuid, available: z.boolean() }

export const matchTargetSchema = z.discriminatedUnion("type", [
  z.object({
    ...cardBase,
    type: z.literal("product"),
    title: z.string(),
    format: z.enum(PRODUCT_FORMAT_VALUES),
    stage: z.enum(PRODUCT_STAGE_VALUES),
    priceCents: cents.nullable(),
    currency: z.string(),
    topics: z.array(z.string()),
    ownerUserId: uuid,
    ownerName: z.string(),
    ownerHandle: z.string(),
  }),
  z.object({
    ...cardBase,
    type: z.literal("idea"),
    title: z.string(),
    format: z.enum(PRODUCT_FORMAT_VALUES),
    priceCents: cents.nullable(),
    currency: z.string(),
    topics: z.array(z.string()),
    excerpt: z.string().nullable(),
    ownerUserId: uuid,
    ownerName: z.string(),
    ownerHandle: z.string(),
    sizeTier: z.enum(SIZE_TIER_VALUES).nullable(),
  }),
  z.object({
    ...cardBase,
    type: z.literal("builder"),
    ownerUserId: uuid,
    name: z.string(),
    handle: z.string(),
    bio: z.string().nullable(),
    skills: z.array(z.string()),
    stack: z.array(z.string()),
    availability: z.enum(AVAILABILITY_VALUES),
  }),
  z.object({
    ...cardBase,
    type: z.literal("creator"),
    ownerUserId: uuid,
    name: z.string(),
    handle: z.string(),
    niche: z.string().nullable(),
    topics: z.array(z.string()),
    sizeTier: z.enum(SIZE_TIER_VALUES).nullable(),
    reach: z.object({ provider: z.enum(SOCIAL_PROVIDER_VALUES), followers: z.number() }).nullable(),
  }),
])
export type MatchTarget = z.infer<typeof matchTargetSchema>

export const matchSchema = z.object({
  id: uuid,
  status: z.enum(MATCH_STATUS_VALUES),
  /** 0–1. */
  score: z.number(),
  features: z.record(z.enum(MATCH_FEATURE_VALUES), z.number()),
  /** One plain sentence naming the top two contributing features (§8). */
  explanation: z.string(),
  target: matchTargetSchema,
})
export type Match = z.infer<typeof matchSchema>

export const discoverOutput = z.object({
  role: z.enum(APP_ROLE_VALUES),
  view: z.enum(DISCOVER_VIEW_VALUES),
  hasProfile: z.boolean(),
  matches: z.array(matchSchema),
  /** Briefs only: open ideas without a match row, newest first. */
  otherBriefs: z.array(matchTargetSchema).optional(),
})
export type DiscoverResponse = z.infer<typeof discoverOutput>

export const matchActionInput = z.object({
  /** 1-based position in the list the person saw (for the events). */
  rank: z.number().int().min(1).max(1000).nullable().optional(),
})
export const matchActionOutput = z.object({ status: z.enum(MATCH_STATUS_VALUES) })
export const matchClickOutput = z.object({
  /** What the card opens: an idea or product (native screens) or a public profile (web). */
  target: z.object({ type: z.enum(TARGET_TYPE_VALUES), id: uuid }),
  webUrl: z.string(),
})
export const markShownInput = z.object({
  items: z
    .array(z.object({ matchId: uuid, rank: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(100),
})
export const markShownOutput = z.object({ recorded: z.number().int() })

// --- Ideas and products ---------------------------------------------------------------------------

const ownerSchema = z.object({ userId: uuid, handle: z.string(), displayName: z.string() })

export const ideaListItemSchema = z.object({
  id: uuid,
  title: z.string(),
  format: z.enum(PRODUCT_FORMAT_VALUES),
  targetPriceCents: cents.nullable(),
  currency: z.string(),
  topics: z.array(z.string()),
  status: z.enum(IDEA_STATUS_VALUES),
  publishedAt: isoDate.nullable(),
  updatedAt: isoDate,
})
export const ideaListOutput = z.object({
  hasProfile: z.boolean(),
  items: z.array(ideaListItemSchema),
})

export const ideaDetailSchema = ideaListItemSchema.extend({
  problem: z.string().nullable(),
  audienceEvidence: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  owner: ownerSchema,
  isOwner: z.boolean(),
  /** What the owner may do now (publish / archive / restore), from the same lifecycle as the web. */
  ownerActions: z.array(z.enum(["edit", "publish", "archive", "restore"])),
  /** The viewer may propose to the owner about this idea (a builder looking at an open idea). */
  canPropose: z.boolean(),
})
export type IdeaDetail = z.infer<typeof ideaDetailSchema>

/** Same field names and string formats as the web form (topics as a comma list, price "19,99"). */
export const ideaFormInput = z.object({
  title: z.string().max(1000),
  problem: z.string().max(10000).optional(),
  audienceEvidence: z.string().max(10000).optional(),
  format: z.string().max(40),
  targetPrice: z.string().max(40).optional(),
  topics: z.string().max(2000).optional(),
  intent: z.enum(["save", "publish"]).optional(),
})
export type IdeaFormInput = z.infer<typeof ideaFormInput>

export const productListItemSchema = z.object({
  id: uuid,
  title: z.string(),
  format: z.enum(PRODUCT_FORMAT_VALUES),
  stage: z.enum(PRODUCT_STAGE_VALUES),
  targetPriceCents: cents.nullable(),
  currency: z.string(),
  topics: z.array(z.string()),
  status: z.enum(PRODUCT_STATUS_VALUES),
  exclusivity: z.boolean(),
  publishedAt: isoDate.nullable(),
  updatedAt: isoDate,
})
export const productListOutput = z.object({
  hasProfile: z.boolean(),
  items: z.array(productListItemSchema),
})

export const productDetailSchema = productListItemSchema.extend({
  description: z.string().nullable(),
  targetUser: z.string().nullable(),
  demoUrl: z.string().nullable(),
  preferredSplitBuilderPct: z.number().int().nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  owner: ownerSchema,
  isOwner: z.boolean(),
  ownerActions: z.array(z.enum(["edit", "publish", "archive", "restore"])),
  canPropose: z.boolean(),
})
export type ProductDetail = z.infer<typeof productDetailSchema>

export const productFormInput = z.object({
  title: z.string().max(1000),
  description: z.string().max(20000).optional(),
  targetUser: z.string().max(1000).optional(),
  stage: z.string().max(40),
  demoUrl: z.string().max(2000).optional(),
  format: z.string().max(40),
  targetPrice: z.string().max(40).optional(),
  topics: z.string().max(2000).optional(),
  preferredSplitBuilderPct: z.string().max(10).optional(),
  exclusivity: z.boolean().optional(),
  intent: z.enum(["save", "publish"]).optional(),
})
export type ProductFormInput = z.infer<typeof productFormInput>

export const supplyStatusInput = z.object({ action: z.enum(["publish", "archive", "restore"]) })
export const supplySavedOutput = z.object({
  id: uuid,
  status: z.string(),
  published: z.boolean(),
})

// --- Proposals ------------------------------------------------------------------------------------

export const proposalListItemSchema = z.object({
  id: uuid,
  status: z.enum(PROPOSAL_STATUS_VALUES),
  target: z.object({ kind: z.enum(["idea", "product"]), id: uuid, title: z.string() }),
  counterpart: partySchema,
  sentByUser: z.boolean(),
  yourTurn: z.boolean(),
  revisionNumber: z.number().int(),
  creatorSplitPct: z.number().int(),
  builderSplitPct: z.number().int(),
  timelineWeeks: z.number().int(),
  expiresAt: isoDate,
  updatedAt: isoDate,
  closedAt: isoDate.nullable(),
})
export type ProposalListItem = z.infer<typeof proposalListItemSchema>

export const proposalListOutput = z.object({
  tab: z.enum(PROPOSAL_TAB_VALUES),
  counts: z.object({
    received: z.number().int(),
    sent: z.number().int(),
    closed: z.number().int(),
    yourTurn: z.number().int(),
  }),
  items: z.array(proposalListItemSchema),
  /** Pass as `before` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
})

export const revisionSchema = z.object({
  id: uuid,
  revisionNumber: z.number().int(),
  authorUserId: uuid,
  message: z.string().nullable(),
  scope: z.string(),
  creatorSplitPct: z.number().int(),
  builderSplitPct: z.number().int(),
  timelineWeeks: z.number().int(),
  createdAt: isoDate,
})
export type Revision = z.infer<typeof revisionSchema>

export const proposalDetailSchema = z.object({
  id: uuid,
  status: z.enum(PROPOSAL_STATUS_VALUES),
  /** The proposal is past `expires_at` (shown as expired before the hourly job sweeps it). */
  lapsed: z.boolean(),
  createdAt: isoDate,
  expiresAt: isoDate,
  closedAt: isoDate.nullable(),
  fromUserId: uuid,
  toUserId: uuid,
  target: z.object({ kind: z.enum(["idea", "product"]), id: uuid, title: z.string() }),
  parties: z.array(partySchema),
  currentRevisionId: uuid.nullable(),
  /** Oldest first. */
  revisions: z.array(revisionSchema),
  /** What the viewer may do now. */
  actions: z.array(z.enum(PROPOSAL_ACTION_VALUES)),
  awaitingUserId: uuid.nullable(),
  threadId: uuid.nullable(),
  collabId: uuid.nullable(),
})
export type ProposalDetail = z.infer<typeof proposalDetailSchema>

/** The terms of an offer, as strings like the web form (the server checks the split sums to 100). */
export const proposalTermsInput = z.object({
  scope: z.string().max(10000),
  message: z.string().max(10000).optional(),
  creatorSplitPct: z.union([z.string().max(10), z.number()]),
  builderSplitPct: z.union([z.string().max(10), z.number()]),
  timelineWeeks: z.union([z.string().max(10), z.number()]),
})
export type ProposalTermsInput = z.infer<typeof proposalTermsInput>

export const sendProposalInput = proposalTermsInput.extend({
  to: uuid,
  targetKind: z.enum(["idea", "product"]),
  targetId: uuid,
  matchId: uuid.optional(),
})
export const counterProposalInput = proposalTermsInput.extend({ revisionId: uuid })
export const answerProposalInput = z.object({ revisionId: uuid })
export const proposalChangedOutput = z.object({
  proposalId: uuid,
  status: z.enum(PROPOSAL_STATUS_VALUES),
  collabId: uuid.nullable(),
})

// --- Collabs, tasks, agreements ------------------------------------------------------------------

export const collabListItemSchema = z.object({
  id: uuid,
  stage: z.enum(COLLAB_STAGE_VALUES),
  title: z.string(),
  targetKind: z.enum(["idea", "product"]),
  role: z.enum(COLLAB_ROLE_VALUES),
  splitPct: z.number().int(),
  partners: z.array(z.object({ name: z.string(), role: z.enum(COLLAB_ROLE_VALUES) })),
  agreementStatus: z.enum(AGREEMENT_STATUS_VALUES).nullable(),
  signedByViewer: z.boolean(),
  openTasks: z.number().int(),
  lastActivityAt: isoDate,
  nextStep: z.object({ text: z.string(), needsViewer: z.boolean() }),
})
export type CollabListItem = z.infer<typeof collabListItemSchema>
export const collabListOutput = z.object({ items: z.array(collabListItemSchema) })

export const collabMemberSchema = partySchema.extend({
  splitPct: z.number().int(),
  payoutsReady: z.boolean(),
  signed: z.boolean(),
})

export const collabDetailSchema = z.object({
  id: uuid,
  proposalId: uuid,
  stage: z.enum(COLLAB_STAGE_VALUES),
  stageChangedAt: isoDate,
  lastActivityAt: isoDate,
  endedAt: isoDate.nullable(),
  createdAt: isoDate,
  target: z.object({ kind: z.enum(["idea", "product"]), id: uuid, title: z.string() }),
  members: z.array(collabMemberSchema),
  threadId: uuid.nullable(),
  scope: z.string().nullable(),
  timelineWeeks: z.number().int().nullable(),
  agreement: z
    .object({ id: uuid, status: z.enum(AGREEMENT_STATUS_VALUES), signedByViewer: z.boolean() })
    .nullable(),
  openTasks: z.number().int(),
  /** The viewer is a member of a collab that has not ended (tasks can change). */
  canWork: z.boolean(),
  nextStep: z.object({ text: z.string(), needsViewer: z.boolean() }),
})
export type CollabDetail = z.infer<typeof collabDetailSchema>

export const taskSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string().nullable(),
  assigneeUserId: uuid.nullable(),
  /** YYYY-MM-DD. */
  dueDate: z.string().nullable(),
  doneAt: isoDate.nullable(),
  position: z.number().int(),
  createdAt: isoDate,
})
export type Task = z.infer<typeof taskSchema>

export const taskListOutput = z.object({
  canWork: z.boolean(),
  members: z.array(partySchema),
  open: z.array(taskSchema),
  done: z.array(taskSchema),
})

/** Same names and formats as the web's task form (empty strings clear a field). */
export const taskFormInput = z.object({
  title: z.string().max(1000),
  description: z.string().max(10000).optional(),
  assigneeUserId: z.string().max(64).optional(),
  dueDate: z.string().max(20).optional(),
})
export type TaskFormInput = z.infer<typeof taskFormInput>
export const taskDoneInput = z.object({ done: z.boolean() })
export const taskMoveInput = z.object({ direction: z.enum(["up", "down"]) })
export const taskChangedOutput = z.object({ taskId: uuid })

export const agreementSchema = z.object({
  id: uuid,
  collabId: uuid,
  status: z.enum(AGREEMENT_STATUS_VALUES),
  templateVersion: z.string(),
  /** The exact text that is signed (plain text blocks: `# `, `## `, `- `, `> `, paragraphs). */
  renderedBody: z.string(),
  /** Send it back when signing: proves the signer saw this text. */
  bodyHash: z.string(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  hasPdf: z.boolean(),
  signatures: z.array(z.object({ userId: uuid, typedName: z.string(), signedAt: isoDate })),
  members: z.array(collabMemberSchema),
  /** The viewer may sign now; otherwise `blockedReason` says why (payouts, already signed…). */
  canSign: z.boolean(),
  blockedReason: z.string().nullable(),
})
export type Agreement = z.infer<typeof agreementSchema>
export const agreementOutput = z.object({ agreement: agreementSchema.nullable() })
export const signAgreementInput = z.object({
  typedName: z.string().max(500),
  bodyHash: z.string().max(128),
})
export const signAgreementOutput = z.object({ completed: z.boolean(), alreadySigned: z.boolean() })

// --- Threads, messages, notifications ------------------------------------------------------------

export const inboxThreadSchema = z.object({
  id: uuid,
  kind: z.enum(THREAD_KIND_VALUES),
  /** The proposal or collab the thread belongs to. */
  parentId: uuid.nullable(),
  title: z.string(),
  with: z.array(z.string()),
  lastMessageAt: isoDate.nullable(),
  preview: z.string().nullable(),
  previewByUser: z.boolean(),
  unread: z.number().int(),
})
export type InboxThread = z.infer<typeof inboxThreadSchema>
export const inboxOutput = z.object({
  threads: z.array(inboxThreadSchema),
  unreadNotifications: z.number().int(),
})

export const messageSchema = z.object({
  id: uuid,
  authorUserId: uuid,
  /** Markdown source; the app shows it as text. */
  body: z.string(),
  attachments: z.array(z.object({ filename: z.string(), sizeBytes: z.number().int() })),
  createdAt: isoDate,
})
export type Message = z.infer<typeof messageSchema>

export const threadOutput = z.object({
  id: uuid,
  kind: z.enum(THREAD_KIND_VALUES),
  parentId: uuid.nullable(),
  title: z.string(),
  participants: z.array(partySchema),
  messages: z.array(messageSchema),
  olderCount: z.number().int(),
  canPost: z.boolean(),
})
export type ThreadResponse = z.infer<typeof threadOutput>

export const postMessageInput = z.object({ body: z.string().max(20000) })
export const postMessageOutput = z.object({ messageId: uuid })
export const markReadInput = z.object({ messageId: uuid })
export const markReadOutput = z.object({ changed: z.boolean() })

export const notificationSchema = z.object({
  id: uuid,
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  /** The web path it leads to (the app maps the ones it has native screens for). */
  href: z.string(),
  readAt: isoDate.nullable(),
  createdAt: isoDate,
})
export type NotificationItem = z.infer<typeof notificationSchema>
export const notificationListOutput = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unread: z.number().int(),
})
export const markAllReadOutput = z.object({ marked: z.number().int() })

// --- Home, audience, earnings, profile -----------------------------------------------------------

export const homeOutput = z.object({
  role: z.enum(APP_ROLE_VALUES).nullable(),
  hasProfile: z.boolean(),
  payouts: z.enum(["none", "pending", "ready"]),
  proposalsAwaiting: z.array(proposalListItemSchema),
  collabs: z.array(collabListItemSchema),
  topMatches: z.array(matchSchema),
  supply: z.object({ total: z.number().int(), live: z.number().int() }),
  unread: z.object({ notifications: z.number().int(), messages: z.number().int() }),
})
export type HomeResponse = z.infer<typeof homeOutput>

export const audienceConnectionSchema = z.object({
  id: uuid,
  provider: z.enum(SOCIAL_PROVIDER_VALUES),
  label: z.string(),
  source: z.enum(["oauth", "manual"]),
  status: z.enum(["active", "expired", "revoked"]),
  verified: z.boolean(),
  health: z.enum(["ok", "syncing", "expired", "error", "unverified"]),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  lastSyncedAt: isoDate.nullable(),
  latest: z
    .object({
      takenAt: isoDate,
      followers: z.number().nullable(),
      avgViews: z.number().nullable(),
      engagementRate: z.number().nullable(),
      topCountries: z.array(z.object({ country: z.string(), share: z.number() })),
      countriesBasis: z.enum(["viewers", "followers"]).nullable(),
      topTopics: z.array(z.string()),
    })
    .nullable(),
})
export type AudienceConnection = z.infer<typeof audienceConnectionSchema>

export const audienceOutput = z.object({
  isCreator: z.boolean(),
  profile: z
    .object({
      handle: z.string(),
      displayName: z.string(),
      sizeTier: z.enum(SIZE_TIER_VALUES).nullable(),
      audienceSummary: z.string().nullable(),
      topics: z.array(z.string()),
    })
    .nullable(),
  tier: z.object({ tier: z.enum(SIZE_TIER_VALUES).nullable(), verified: z.boolean() }),
  connections: z.array(audienceConnectionSchema),
  syncPending: z.boolean(),
  summaryPending: z.boolean(),
  lastSyncedAt: isoDate.nullable(),
})
export type AudienceResponse = z.infer<typeof audienceOutput>

export const earningsOutput = z.object({
  balances: z.array(
    z.object({
      currency: z.string(),
      pendingCents: cents,
      availableCents: cents,
      onHoldCents: cents,
      paidOutCents: cents,
    }),
  ),
  releases: z.array(z.object({ date: z.string(), currency: z.string(), amountCents: cents })),
  launches: z.array(
    z.object({
      launchId: uuid,
      title: z.string(),
      currency: z.string(),
      orderCount: z.number().int(),
      earnedCents: cents,
      refundedCents: cents,
    }),
  ),
  recentSales: z.array(
    z.object({
      orderId: uuid,
      launchTitle: z.string(),
      paidAt: isoDate,
      currency: z.string(),
      grossCents: cents,
      refundedCents: cents,
      status: z.enum(ORDER_STATUS_VALUES),
      shareCents: cents.nullable(),
    }),
  ),
  feePendingCount: z.number().int(),
  payouts: z.enum(["none", "pending", "ready"]),
})
export type EarningsResponse = z.infer<typeof earningsOutput>

export const creatorProfileSchema = z.object({
  displayName: z.string(),
  handle: z.string(),
  niche: z.string(),
  bio: z.string(),
  topics: z.array(z.string()),
  country: z.string(),
  languages: z.array(z.string()),
})
export const builderProfileSchema = z.object({
  displayName: z.string(),
  handle: z.string(),
  bio: z.string(),
  skills: z.array(z.string()),
  stack: z.array(z.string()),
  availability: z.enum(AVAILABILITY_VALUES),
  dealPreference: z.enum(DEAL_PREFERENCE_VALUES),
})
export const profileOutput = z.object({
  creator: creatorProfileSchema.nullable(),
  builder: builderProfileSchema.nullable(),
  canEditCreator: z.boolean(),
  canEditBuilder: z.boolean(),
})
export type ProfileResponse = z.infer<typeof profileOutput>

/** Same fields as the web's profile forms; lists may be arrays or comma lists. */
export const creatorProfileInput = z.object({
  displayName: z.string().max(1000),
  handle: z.string().max(100),
  niche: z.string().max(1000).optional(),
  bio: z.string().max(10000).optional(),
  topics: z.union([z.string().max(2000), z.array(z.string().max(200)).max(50)]).optional(),
  country: z.string().max(10).optional(),
  languages: z.array(z.string().max(10)).max(50).optional(),
})
export const builderProfileInput = z.object({
  displayName: z.string().max(1000),
  handle: z.string().max(100),
  bio: z.string().max(10000).optional(),
  skills: z.union([z.string().max(2000), z.array(z.string().max(200)).max(50)]).optional(),
  stack: z.union([z.string().max(2000), z.array(z.string().max(200)).max(50)]).optional(),
  availability: z.string().max(20),
  dealPreference: z.string().max(20),
})
export const profileSavedOutput = z.object({
  created: z.boolean(),
  changed: z.boolean(),
  handle: z.string(),
})

/** Cursor values the list endpoints hand out (opaque to the app). */
export const cursorSchema = z.string().max(200)

// --- Creator feed and listing imports (CLAUDE.md §19.45) ------------------------------------------

export const PRODUCT_SOURCE_VALUES = ["manual", "app_store", "web"] as const

/** Image URLs are absolute (the server's media route, which redirects to a signed URL). */
export const listingImageSchema = z.object({
  url: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
})
export type ListingImage = z.infer<typeof listingImageSchema>

export const listingCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  hook: z.string().nullable(),
  tag: z.string(),
  format: z.enum(PRODUCT_FORMAT_VALUES),
  source: z.enum(PRODUCT_SOURCE_VALUES),
  sourceLabel: z.string().nullable(),
  priceLabel: z.string().nullable(),
  rating: z.number().nullable(),
  ratingCount: z.number().int().nullable(),
  icon: listingImageSchema.nullable(),
  cover: listingImageSchema.nullable(),
  screenshots: z.array(listingImageSchema),
  visual: z.object({
    from: z.string(),
    to: z.string(),
    angle: z.number(),
    initials: z.string(),
    gradient: z.string(),
  }),
  builder: z.object({ userId: z.string(), handle: z.string(), displayName: z.string() }),
  unverified: z.boolean(),
})
export type ListingCardWire = z.infer<typeof listingCardSchema>

export const feedItemSchema = listingCardSchema.extend({
  saved: z.boolean(),
  matchId: z.string().nullable(),
  score: z.number().nullable(),
  publishedAt: z.string(),
})
export type FeedItemWire = z.infer<typeof feedItemSchema>

export const feedQuery = z.object({ cursor: z.string().max(300).optional() })
export const feedOutput = z.object({
  items: z.array(feedItemSchema),
  nextCursor: z.string().nullable(),
})
export type FeedResponse = z.infer<typeof feedOutput>

export const feedDetailOutput = feedItemSchema.extend({
  description: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  demoUrl: z.string().nullable(),
  builder: z.object({
    userId: z.string(),
    handle: z.string(),
    displayName: z.string(),
    bio: z.string().nullable(),
    skills: z.array(z.string()),
    listingCount: z.number().int(),
  }),
})
export type FeedDetail = z.infer<typeof feedDetailOutput>

export const feedActionInput = z.object({
  rank: z.number().int().min(1).max(10_000).nullable().optional(),
})
export const feedSaveOutput = z.object({ saved: z.boolean() })
export const feedShownInput = z.object({
  page: z.number().int().min(1).max(1000),
  items: z
    .array(
      z.object({
        productId: z.string(),
        matchId: z.string().nullable(),
        rank: z.number().int().min(1).max(10_000),
      }),
    )
    .max(50),
})

export const builderProfileGridOutput = z.object({
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  skills: z.array(z.string()),
  appStore: z.object({ developerName: z.string().nullable(), verified: z.boolean() }).nullable(),
  listings: z.array(listingCardSchema),
})
export type BuilderProfileGrid = z.infer<typeof builderProfileGridOutput>

export const importStatusOutput = z.object({
  appStore: z
    .object({
      developerName: z.string().nullable(),
      developerUrl: z.string(),
      verified: z.boolean(),
      verificationCode: z.string().nullable(),
      syncedAt: z.string().nullable(),
      syncError: z.string().nullable(),
    })
    .nullable(),
  listings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      source: z.enum(["app_store", "web"]),
      removed: z.boolean(),
      iconUrl: z.string().nullable(),
      coverUrl: z.string().nullable(),
      gradient: z.string(),
      initials: z.string(),
    }),
  ),
})
export type ImportStatus = z.infer<typeof importStatusOutput>

export const appStoreConnectInput = z.object({ appStore: z.string().max(500) })
export const appStoreSyncOutput = z.object({
  developerName: z.string(),
  apps: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
})
export const appStoreVerifyOutput = z.object({ verified: z.boolean() })
export const webImportInput = z.object({ url: z.string().max(2000) })
export const webImportOutput = z.object({
  productId: z.string(),
  title: z.string(),
  action: z.enum(["created", "updated", "unchanged"]),
})
