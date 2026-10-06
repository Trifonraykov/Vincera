import { describe, expect, it } from "vitest"

import { canSendProposal, type ProposalAccess, type ProposalTarget } from "@/lib/auth/authz"
import { proposalStatusEnum, type ProposalStatus } from "@/lib/db/schema/enums"
import {
  awaitingPartyId,
  FINAL_PROPOSAL_STATUSES,
  isFinalProposalStatus,
  nextProposalStatus,
  otherPartyId,
  partyRole,
  PROPOSAL_ACTION_ACTOR,
  PROPOSAL_ACTIONS,
  PROPOSAL_TRANSITIONS,
  proposalActionsFor,
  sendBlockReason,
  type ProposalAction,
} from "@/lib/proposals/state"

import { authUser, OTHER_USER_ID } from "../../helpers/auth-users"

/** The proposal state machine (CLAUDE.md §19.24 "Proposals"), every transition legal or not. */

const STATUSES = proposalStatusEnum.enumValues
const OPEN: ProposalStatus[] = ["pending", "countered"]
const SENDER = "0190a000-0000-7000-8000-00000000000a"
const RECIPIENT = "0190a000-0000-7000-8000-00000000000b"

const EXPECTED: Record<ProposalAction, ProposalStatus> = {
  counter: "countered",
  accept: "accepted",
  decline: "declined",
  withdraw: "withdrawn",
  expire: "expired",
}

describe("proposal transitions", () => {
  it("lets every action leave an open status, to the status it names", () => {
    for (const status of OPEN) {
      for (const action of PROPOSAL_ACTIONS) {
        expect([status, action, nextProposalStatus(status, action)]).toEqual([
          status,
          action,
          EXPECTED[action],
        ])
      }
    }
    // A counter on a counter stays countered.
    expect(nextProposalStatus("countered", "counter")).toBe("countered")
  })

  it("refuses every action on a final status (each illegal transition, one by one)", () => {
    for (const status of FINAL_PROPOSAL_STATUSES) {
      for (const action of PROPOSAL_ACTIONS) {
        expect([status, action, nextProposalStatus(status, action)]).toEqual([status, action, null])
      }
      expect(PROPOSAL_TRANSITIONS[status]).toEqual({})
    }
  })

  it("covers every status, and only open statuses lead anywhere", () => {
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual([...STATUSES].sort())
    for (const status of STATUSES) {
      expect(isFinalProposalStatus(status)).toBe(!OPEN.includes(status))
    }
    // Nothing leads back to pending: a proposal is pending only when sent.
    for (const status of STATUSES) {
      for (const action of PROPOSAL_ACTIONS) {
        expect(nextProposalStatus(status, action)).not.toBe("pending")
      }
    }
  })

  it("says who performs each action", () => {
    expect(PROPOSAL_ACTION_ACTOR).toEqual({
      counter: "awaiting",
      accept: "awaiting",
      decline: "awaiting",
      withdraw: "author",
      expire: "system",
    })
  })
})

function access(status: ProposalStatus, author: string | null = SENDER): ProposalAccess {
  return { fromUserId: SENDER, toUserId: RECIPIENT, status, currentRevisionAuthorId: author }
}

describe("who acts", () => {
  const sender = authUser({ id: SENDER, roles: ["builder"] })
  const recipient = authUser({ id: RECIPIENT, roles: ["creator"] })
  const stranger = authUser({ id: OTHER_USER_ID, roles: ["builder"] })
  const admin = authUser({ id: OTHER_USER_ID, roles: ["admin"] })

  it("offers accept, counter and decline to the party awaiting an answer, withdraw to the author", () => {
    expect(proposalActionsFor(recipient, access("pending"))).toEqual([
      "accept",
      "counter",
      "decline",
    ])
    expect(proposalActionsFor(sender, access("pending"))).toEqual(["withdraw"])
    // After the recipient's counter it is the sender's turn, and the recipient may withdraw it.
    expect(proposalActionsFor(sender, access("countered", RECIPIENT))).toEqual([
      "accept",
      "counter",
      "decline",
    ])
    expect(proposalActionsFor(recipient, access("countered", RECIPIENT))).toEqual(["withdraw"])
  })

  it("offers nothing on closed proposals, to strangers, admins or suspended parties", () => {
    for (const status of FINAL_PROPOSAL_STATUSES) {
      expect(proposalActionsFor(recipient, access(status))).toEqual([])
      expect(proposalActionsFor(sender, access(status))).toEqual([])
    }
    expect(proposalActionsFor(stranger, access("pending"))).toEqual([])
    expect(proposalActionsFor(admin, access("pending"))).toEqual([])
    expect(proposalActionsFor({ ...recipient, status: "suspended" }, access("pending"))).toEqual([])
    // A proposal without a current revision (never happens once sent) has no answer to give.
    expect(proposalActionsFor(recipient, access("pending", null))).toEqual([])
  })

  it("knows whose turn it is and who the other party is", () => {
    expect(awaitingPartyId(access("pending"))).toBe(RECIPIENT)
    expect(awaitingPartyId(access("countered", RECIPIENT))).toBe(SENDER)
    expect(awaitingPartyId(access("accepted"))).toBeNull()
    expect(otherPartyId(access("pending"), SENDER)).toBe(RECIPIENT)
    expect(otherPartyId(access("pending"), RECIPIENT)).toBe(SENDER)
  })

  it("gives the idea's owner the creator role and a product's owner the builder role", () => {
    expect(partyRole({ kind: "idea", ownerUserId: RECIPIENT }, RECIPIENT)).toBe("creator")
    expect(partyRole({ kind: "idea", ownerUserId: RECIPIENT }, SENDER)).toBe("builder")
    expect(partyRole({ kind: "product", ownerUserId: SENDER }, SENDER)).toBe("builder")
    expect(partyRole({ kind: "product", ownerUserId: SENDER }, RECIPIENT)).toBe("creator")
  })
})

describe("sendBlockReason", () => {
  const onboarded = new Date("2026-01-01T00:00:00Z")
  const builder = authUser({ id: SENDER, roles: ["builder"], onboardingCompletedAt: onboarded })
  const creator = {
    id: RECIPIENT,
    roles: ["creator"] as const,
    status: "active" as const,
    onboardingCompletedAt: onboarded,
  }
  const idea: ProposalTarget = { kind: "idea", ownerUserId: RECIPIENT, status: "open" }

  it("explains every refusal and agrees with canSendProposal", () => {
    const cases: {
      label: string
      input: Parameters<typeof sendBlockReason>
      reason: RegExp | null
    }[] = [
      {
        label: "ok",
        input: [builder, { target: idea, recipient: { ...creator, roles: ["creator"] } }],
        reason: null,
      },
      {
        label: "not onboarded",
        input: [
          { ...builder, onboardingCompletedAt: null },
          { target: idea, recipient: { ...creator, roles: ["creator"] } },
        ],
        reason: /Finish setting up/,
      },
      {
        label: "suspended sender",
        input: [
          { ...builder, status: "suspended" },
          { target: idea, recipient: { ...creator, roles: ["creator"] } },
        ],
        reason: /can't send proposals/,
      },
      {
        label: "yourself",
        input: [
          builder,
          { target: idea, recipient: { ...creator, id: SENDER, roles: ["creator"] } },
        ],
        reason: /to yourself/,
      },
      {
        label: "suspended recipient",
        input: [
          builder,
          { target: idea, recipient: { ...creator, roles: ["creator"], status: "suspended" } },
        ],
        reason: /isn't taking proposals/,
      },
      {
        label: "recipient not onboarded",
        input: [
          builder,
          {
            target: idea,
            recipient: { ...creator, roles: ["creator"], onboardingCompletedAt: null },
          },
        ],
        reason: /hasn't finished/,
      },
      {
        label: "someone else's idea",
        input: [
          builder,
          {
            target: { ...idea, ownerUserId: OTHER_USER_ID },
            recipient: { ...creator, roles: ["creator"] },
          },
        ],
        reason: /belongs to someone else/,
      },
      {
        label: "creator pitching on an idea",
        input: [
          { ...builder, roles: ["creator"] },
          { target: idea, recipient: { ...creator, roles: ["creator"] } },
        ],
        reason: /Add the builder role/,
      },
      {
        label: "idea not open",
        input: [
          builder,
          {
            target: { ...idea, status: "in_collab" },
            recipient: { ...creator, roles: ["creator"] },
          },
        ],
        reason: /isn't open/,
      },
      {
        label: "product not seeking",
        input: [
          { ...builder, roles: ["creator"] },
          {
            target: { kind: "product", ownerUserId: RECIPIENT, status: "draft" },
            recipient: { ...creator, roles: ["builder"] },
          },
        ],
        reason: /isn't looking for creators/,
      },
      {
        label: "offering your own product to a builder",
        input: [
          builder,
          {
            target: { kind: "product", ownerUserId: SENDER, status: "seeking" },
            recipient: { ...creator, roles: ["builder"] },
          },
        ],
        reason: /this person isn't one/,
      },
    ]
    for (const { label, input, reason } of cases) {
      const found = sendBlockReason(...input)
      if (reason) expect([label, found]).toEqual([label, expect.stringMatching(reason)])
      else expect([label, found]).toEqual([label, null])
      expect([label, canSendProposal(...input)]).toEqual([label, reason === null])
    }
  })
})
