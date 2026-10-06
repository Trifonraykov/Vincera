import { describe, expect, it } from "vitest"

import {
  canAccessAdmin,
  canActOnMatch,
  canCreateIdea,
  canCreateProduct,
  canDiscover,
  canEditBuilderProfile,
  canEditCreatorProfile,
  canEditLaunch,
  canManageIdea,
  canManageOwnAccount,
  canManagePortfolioItem,
  canManageProduct,
  canPostMessage,
  canRespondToProposal,
  canSendProposal,
  canSignAgreement,
  canSwitchToRole,
  canViewCollab,
  canViewIdea,
  canViewProduct,
  canViewProposalTarget,
  canViewProposal,
  canViewThread,
  canWithdrawProposal,
  canWorkInCollab,
  hasCompletedOnboarding,
  hasRole,
  isActive,
  isAdmin,
  isCollabMember,
  isOpenProposal,
  PUBLIC_IDEA_STATUSES,
  PUBLIC_PRODUCT_STATUSES,
} from "@/lib/auth/authz"

import { authUser, OTHER_USER_ID } from "../../helpers/auth-users"

const ONBOARDED = new Date("2026-01-01T00:00:00Z")

describe("roles and status", () => {
  it("hasRole checks users.roles", () => {
    const user = authUser({ roles: ["creator", "admin"] })
    expect(hasRole(user, "creator")).toBe(true)
    expect(hasRole(user, "admin")).toBe(true)
    expect(hasRole(user, "builder")).toBe(false)
  })

  it("isAdmin and canAccessAdmin need the admin role and an active account", () => {
    expect(isAdmin(authUser({ roles: ["admin"] }))).toBe(true)
    expect(canAccessAdmin(authUser({ roles: ["creator", "admin"] }))).toBe(true)
    expect(canAccessAdmin(authUser({ roles: ["creator", "builder"] }))).toBe(false)
    expect(canAccessAdmin(authUser({ roles: ["admin"], status: "suspended" }))).toBe(false)
  })

  it("isActive is false for suspended users", () => {
    expect(isActive(authUser())).toBe(true)
    expect(isActive(authUser({ status: "suspended" }))).toBe(false)
  })

  it("canManageOwnAccount lets any active user manage their own account", () => {
    expect(canManageOwnAccount(authUser({ roles: [] }))).toBe(true)
    expect(canManageOwnAccount(authUser({ roles: ["creator"] }))).toBe(true)
    expect(canManageOwnAccount(authUser({ status: "suspended" }))).toBe(false)
  })

  it("canSwitchToRole allows only app roles the user has", () => {
    const both = authUser({ roles: ["creator", "builder", "admin"] })
    expect(canSwitchToRole(both, "builder")).toBe(true)
    expect(canSwitchToRole(both, "creator")).toBe(true)
    expect(canSwitchToRole(both, "admin")).toBe(false)
    expect(canSwitchToRole(both, "owner")).toBe(false)
    expect(canSwitchToRole(authUser({ roles: ["creator"] }), "builder")).toBe(false)
    expect(canSwitchToRole(authUser({ roles: ["builder"], status: "suspended" }), "builder")).toBe(
      false,
    )
  })

  it("hasCompletedOnboarding reads onboarding_completed_at", () => {
    expect(hasCompletedOnboarding(authUser())).toBe(false)
    expect(hasCompletedOnboarding(authUser({ onboardingCompletedAt: ONBOARDED }))).toBe(true)
  })
})

describe("profile rules", () => {
  it("each profile needs its role and an active account", () => {
    expect(canEditCreatorProfile(authUser({ roles: ["creator"] }))).toBe(true)
    expect(canEditCreatorProfile(authUser({ roles: ["builder"] }))).toBe(false)
    expect(canEditCreatorProfile(authUser({ roles: ["admin"] }))).toBe(false)
    expect(canEditCreatorProfile(authUser({ status: "suspended" }))).toBe(false)
    expect(canEditBuilderProfile(authUser({ roles: ["creator", "builder"] }))).toBe(true)
    expect(canEditBuilderProfile(authUser({ roles: ["creator"] }))).toBe(false)
    expect(canEditBuilderProfile(authUser({ roles: ["builder"], status: "suspended" }))).toBe(false)
  })

  it("portfolio items are managed only by the builder who owns them", () => {
    const builder = authUser({ roles: ["builder"] })
    expect(canManagePortfolioItem(builder, { ownerUserId: builder.id })).toBe(true)
    expect(canManagePortfolioItem(builder, { ownerUserId: OTHER_USER_ID })).toBe(false)
    // Even admins do not edit someone else's portfolio through the builder's actions.
    expect(
      canManagePortfolioItem(authUser({ roles: ["admin", "builder"] }), {
        ownerUserId: OTHER_USER_ID,
      }),
    ).toBe(false)
    expect(
      canManagePortfolioItem(authUser({ roles: ["creator"] }), {
        ownerUserId: authUser().id,
      }),
    ).toBe(false)
  })
})

describe("collab rules", () => {
  const member = authUser()
  const collab = { memberUserIds: [member.id, OTHER_USER_ID] }
  const outsider = authUser({ id: "0190a000-0000-7000-8000-0000000000ff" })

  it("members and admins can view a collab; others cannot (§6)", () => {
    expect(isCollabMember(member, collab)).toBe(true)
    expect(canViewCollab(member, collab)).toBe(true)
    expect(canViewCollab(outsider, collab)).toBe(false)
    expect(canViewCollab({ ...outsider, roles: ["admin"] }, collab)).toBe(true)
    expect(canViewCollab({ ...member, status: "suspended" }, collab)).toBe(false)
  })

  it("only members edit a launch, and only while it is being set up", () => {
    expect(canEditLaunch(member, { ...collab, status: "draft" })).toBe(true)
    expect(canEditLaunch(member, { ...collab, status: "pending_approval" })).toBe(true)
    expect(canEditLaunch(member, { ...collab, status: "live" })).toBe(false)
    expect(canEditLaunch(outsider, { ...collab, status: "draft" })).toBe(false)
    expect(canEditLaunch({ ...outsider, roles: ["admin"] }, { ...collab, status: "draft" })).toBe(
      false,
    )
  })
})

describe("canSendProposal (both directions, §19.24)", () => {
  const builder = authUser({
    roles: ["builder"],
    activeRole: "builder",
    onboardingCompletedAt: ONBOARDED,
  })
  const creator = authUser({
    id: OTHER_USER_ID,
    roles: ["creator"],
    activeRole: "creator",
    onboardingCompletedAt: ONBOARDED,
  })
  const creatorsIdea = { kind: "idea", ownerUserId: creator.id, status: "open" } as const
  const buildersProduct = { kind: "product", ownerUserId: builder.id, status: "seeking" } as const

  it("lets a builder pitch on a creator's idea, and a creator offer their idea to a builder", () => {
    expect(canSendProposal(builder, { target: creatorsIdea, recipient: creator })).toBe(true)
    expect(canSendProposal(creator, { target: creatorsIdea, recipient: builder })).toBe(true)
  })

  it("lets a creator pitch on a builder's product, and a builder offer their product", () => {
    expect(canSendProposal(creator, { target: buildersProduct, recipient: builder })).toBe(true)
    expect(canSendProposal(builder, { target: buildersProduct, recipient: creator })).toBe(true)
  })

  it("needs the counterpart role on the side that does not own the target", () => {
    const otherCreator = { ...creator, id: "0190a000-0000-7000-8000-000000000003" }
    // A creator cannot pitch on another creator's idea (they would both be creators).
    expect(canSendProposal(otherCreator, { target: creatorsIdea, recipient: creator })).toBe(false)
    // An idea owned by someone who is not a creator (role removed) cannot be proposed on.
    expect(
      canSendProposal(builder, {
        target: creatorsIdea,
        recipient: { ...creator, roles: ["builder"] },
      }),
    ).toBe(false)
  })

  it("requires the target to belong to one of the two people", () => {
    const stranger = { ...creatorsIdea, ownerUserId: "0190a000-0000-7000-8000-0000000000aa" }
    expect(canSendProposal(builder, { target: stranger, recipient: creator })).toBe(false)
  })

  it("requires an open idea or a seeking product", () => {
    for (const status of ["draft", "in_collab", "launched", "archived"] as const) {
      expect(
        canSendProposal(builder, { target: { ...creatorsIdea, status }, recipient: creator }),
      ).toBe(false)
    }
    for (const status of ["draft", "in_collab", "launched", "archived"] as const) {
      expect(
        canSendProposal(creator, { target: { ...buildersProduct, status }, recipient: builder }),
      ).toBe(false)
    }
  })

  it("is blocked before onboarding is complete, on either side (§12)", () => {
    const target = creatorsIdea
    expect(
      canSendProposal({ ...builder, onboardingCompletedAt: null }, { target, recipient: creator }),
    ).toBe(false)
    expect(
      canSendProposal(builder, { target, recipient: { ...creator, onboardingCompletedAt: null } }),
    ).toBe(false)
  })

  it("is blocked for yourself and for suspended senders or recipients", () => {
    const both = { ...builder, roles: ["creator", "builder"] as const }
    const ownIdea = { kind: "idea", ownerUserId: both.id, status: "open" } as const
    expect(canSendProposal(both, { target: ownIdea, recipient: both })).toBe(false)
    expect(
      canSendProposal(
        { ...builder, status: "suspended" },
        { target: creatorsIdea, recipient: creator },
      ),
    ).toBe(false)
    expect(
      canSendProposal(builder, {
        target: creatorsIdea,
        recipient: { ...creator, status: "suspended" },
      }),
    ).toBe(false)
  })
})

describe("proposal answers", () => {
  const sender = authUser({ roles: ["builder"], onboardingCompletedAt: ONBOARDED })
  const recipient = authUser({ id: OTHER_USER_ID, onboardingCompletedAt: ONBOARDED })
  const outsider = authUser({ id: "0190a000-0000-7000-8000-0000000000ff" })
  const pending = {
    fromUserId: sender.id,
    toUserId: recipient.id,
    status: "pending",
    currentRevisionAuthorId: sender.id,
  } as const

  it("shows a proposal to its parties and admins", () => {
    expect(canViewProposal(sender, pending)).toBe(true)
    expect(canViewProposal(recipient, pending)).toBe(true)
    expect(canViewProposal(outsider, pending)).toBe(false)
    expect(canViewProposal({ ...outsider, roles: ["admin"] }, pending)).toBe(true)
  })

  it("lets the party who did not make the offer on the table answer it", () => {
    expect(canRespondToProposal(recipient, pending)).toBe(true)
    expect(canRespondToProposal(sender, pending)).toBe(false)
    const countered = {
      ...pending,
      status: "countered",
      currentRevisionAuthorId: recipient.id,
    } as const
    expect(canRespondToProposal(sender, countered)).toBe(true)
    expect(canRespondToProposal(recipient, countered)).toBe(false)
    expect(canRespondToProposal({ ...outsider, roles: ["admin"] }, pending)).toBe(false)
  })

  it("lets the offer's author withdraw it", () => {
    expect(canWithdrawProposal(sender, pending)).toBe(true)
    expect(canWithdrawProposal(recipient, pending)).toBe(false)
  })

  it("allows nothing once the proposal is closed, or for suspended users", () => {
    for (const status of ["accepted", "declined", "expired", "withdrawn"] as const) {
      expect(canRespondToProposal(recipient, { ...pending, status })).toBe(false)
      expect(canWithdrawProposal(sender, { ...pending, status })).toBe(false)
    }
    expect(canRespondToProposal({ ...recipient, status: "suspended" }, pending)).toBe(false)
    expect(isOpenProposal("countered")).toBe(true)
    expect(isOpenProposal("expired")).toBe(false)
  })
})

describe("ideas and products", () => {
  const creator = authUser({ roles: ["creator"] })
  const builder = authUser({ id: OTHER_USER_ID, roles: ["builder"] })
  const admin = authUser({ id: "0190a000-0000-7000-8000-0000000000ad", roles: ["admin"] })

  it("lets creators post ideas and builders list products", () => {
    expect(canCreateIdea(creator)).toBe(true)
    expect(canCreateIdea(builder)).toBe(false)
    expect(canCreateProduct(builder)).toBe(true)
    expect(canCreateProduct(creator)).toBe(false)
    expect(canCreateIdea({ ...creator, status: "suspended" })).toBe(false)
  })

  it("lets only the owner manage an idea or a product", () => {
    expect(canManageIdea(creator, { ownerUserId: creator.id })).toBe(true)
    expect(canManageIdea({ ...creator, id: OTHER_USER_ID }, { ownerUserId: creator.id })).toBe(
      false,
    )
    expect(
      canManageIdea({ ...admin, roles: ["admin", "creator"] }, { ownerUserId: creator.id }),
    ).toBe(false)
    expect(canManageProduct(builder, { ownerUserId: builder.id })).toBe(true)
    expect(canManageProduct(builder, { ownerUserId: creator.id })).toBe(false)
  })

  it("shows drafts and archived rows only to their owner and admins", () => {
    for (const status of ["draft", "archived"] as const) {
      const idea = { ownerUserId: creator.id, status }
      expect(canViewIdea(creator, idea)).toBe(true)
      expect(canViewIdea(admin, idea)).toBe(true)
      expect(canViewIdea(builder, idea)).toBe(false)
      const product = { ownerUserId: builder.id, status }
      expect(canViewProduct(builder, product)).toBe(true)
      expect(canViewProduct(creator, product)).toBe(false)
    }
    for (const status of PUBLIC_IDEA_STATUSES) {
      expect(canViewIdea(builder, { ownerUserId: creator.id, status })).toBe(true)
    }
    for (const status of PUBLIC_PRODUCT_STATUSES) {
      expect(canViewProduct(creator, { ownerUserId: builder.id, status })).toBe(true)
    }
    expect(
      canViewIdea({ ...builder, status: "suspended" }, { ownerUserId: creator.id, status: "open" }),
    ).toBe(false)
  })

  it("hides another person's draft or archived target from the new-proposal page", () => {
    for (const status of ["draft", "archived"] as const) {
      expect(
        canViewProposalTarget(builder, { kind: "idea", ownerUserId: creator.id, status }),
      ).toBe(false)
      expect(
        canViewProposalTarget(creator, { kind: "product", ownerUserId: builder.id, status }),
      ).toBe(false)
      expect(
        canViewProposalTarget(creator, { kind: "idea", ownerUserId: creator.id, status }),
      ).toBe(true)
    }
    expect(
      canViewProposalTarget(builder, { kind: "idea", ownerUserId: creator.id, status: "open" }),
    ).toBe(true)
    expect(
      canViewProposalTarget(creator, {
        kind: "product",
        ownerUserId: builder.id,
        status: "seeking",
      }),
    ).toBe(true)
  })
})

describe("matching", () => {
  it("opens discovery for the user's own app roles", () => {
    expect(canDiscover(authUser({ roles: ["creator"] }), "creator")).toBe(true)
    expect(canDiscover(authUser({ roles: ["creator"] }), "builder")).toBe(false)
    expect(canDiscover(authUser({ roles: ["builder"], status: "suspended" }), "builder")).toBe(
      false,
    )
  })

  it("lets only the match's subject act on it", () => {
    const user = authUser()
    expect(canActOnMatch(user, { subjectUserId: user.id })).toBe(true)
    expect(canActOnMatch(user, { subjectUserId: OTHER_USER_ID })).toBe(false)
  })
})

describe("collab work, agreements and threads", () => {
  const member = authUser()
  const other = authUser({ id: OTHER_USER_ID })
  const outsider = authUser({ id: "0190a000-0000-7000-8000-0000000000ff" })
  const admin = { ...outsider, roles: ["admin"] as const }
  const memberUserIds = [member.id, other.id]

  it("lets members work in a collab until it ends; admins only read", () => {
    expect(canWorkInCollab(member, { memberUserIds, stage: "building" })).toBe(true)
    expect(canWorkInCollab(member, { memberUserIds, stage: "ended" })).toBe(false)
    expect(canWorkInCollab(admin, { memberUserIds, stage: "building" })).toBe(false)
  })

  it("lets each member sign once, while the agreement awaits signatures", () => {
    const agreement = { memberUserIds, status: "awaiting_signatures", signedUserIds: [] } as const
    expect(canSignAgreement(member, agreement)).toBe(true)
    expect(canSignAgreement(member, { ...agreement, signedUserIds: [member.id] })).toBe(false)
    expect(canSignAgreement(other, { ...agreement, signedUserIds: [member.id] })).toBe(true)
    expect(canSignAgreement(member, { ...agreement, status: "signed" })).toBe(false)
    expect(canSignAgreement(outsider, agreement)).toBe(false)
    expect(canSignAgreement(admin, agreement)).toBe(false)
  })

  it("shows threads to participants and admins; posting needs an open parent", () => {
    const proposalThread = {
      kind: "proposal",
      participantUserIds: memberUserIds,
      parentStatus: "pending",
    } as const
    const collabThread = {
      kind: "collab",
      participantUserIds: memberUserIds,
      parentStatus: "building",
    } as const
    expect(canViewThread(member, proposalThread)).toBe(true)
    expect(canViewThread(admin, proposalThread)).toBe(true)
    expect(canViewThread(outsider, proposalThread)).toBe(false)
    expect(canPostMessage(member, proposalThread)).toBe(true)
    expect(canPostMessage(member, { ...proposalThread, parentStatus: "accepted" })).toBe(false)
    expect(canViewThread(member, { ...proposalThread, parentStatus: "accepted" })).toBe(true)
    expect(canPostMessage(member, collabThread)).toBe(true)
    expect(canPostMessage(member, { ...collabThread, parentStatus: "ended" })).toBe(false)
    expect(canPostMessage(admin, collabThread)).toBe(false)
    expect(canPostMessage({ ...member, status: "suspended" }, collabThread)).toBe(false)
  })
})
