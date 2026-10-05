import { describe, expect, expectTypeOf, it } from "vitest"

import {
  EVENT_TYPES,
  isEventType,
  isSubjectType,
  SUBJECT_TYPES,
  type EventProperties,
  type EventSubjectType,
  type TrackInput,
} from "@/lib/events/types"

/** The required list from CLAUDE.md §11. */
const SPEC_EVENT_TYPES = [
  "user.signed_up",
  "user.role_added",
  "onboarding.completed",
  "social.connected",
  "social.synced",
  "social.expired",
  "idea.created",
  "idea.published",
  "idea.archived",
  "product.created",
  "product.published",
  "product.archived",
  "match.computed",
  "match.shown",
  "match.clicked",
  "match.saved",
  "match.dismissed",
  "proposal.sent",
  "proposal.countered",
  "proposal.accepted",
  "proposal.declined",
  "proposal.expired",
  "collab.created",
  "collab.stage_changed",
  "collab.ended",
  "agreement.generated",
  "agreement.signed",
  "agreement.completed",
  "task.completed",
  "message.sent",
  "launch.submitted",
  "launch.approved",
  "launch.live",
  "launch.paused",
  "link.clicked",
  "product_page.viewed",
  "checkout.started",
  "order.paid",
  "order.refunded",
  "order.disputed",
  "payout.sent",
  "dispute.opened",
  "dispute.resolved",
  "ai.generated",
]

describe("event catalog", () => {
  it("covers every event type required by §11, without duplicates", () => {
    for (const type of SPEC_EVENT_TYPES) expect(EVENT_TYPES).toContain(type)
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
    // Additions beyond §11 are deliberate and documented in CLAUDE.md §19.6 / §19.11.
    expect(EVENT_TYPES.filter((t) => !SPEC_EVENT_TYPES.includes(t))).toEqual([
      "onboarding.step_completed",
      "creator_profile.created",
      "creator_profile.updated",
      "builder_profile.created",
      "builder_profile.updated",
      "social.disconnected",
      "payouts.account_created",
      "payouts.account_updated",
      "proposal.withdrawn",
      "ai.reviewed",
    ])
  })

  it("uses dotted lowercase names", () => {
    for (const type of EVENT_TYPES) expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/)
  })

  it("narrows strings with isEventType / isSubjectType", () => {
    expect(isEventType("order.paid")).toBe(true)
    expect(isEventType("order.teleported")).toBe(false)
    expect(isSubjectType("collab")).toBe(true)
    expect(isSubjectType("message")).toBe(false)
    expect(new Set(SUBJECT_TYPES).size).toBe(SUBJECT_TYPES.length)
  })

  it("types subjects and properties per event", () => {
    expectTypeOf<EventSubjectType<"order.paid">>().toEqualTypeOf<"order">()
    expectTypeOf<EventProperties<"user.signed_up">>().toEqualTypeOf<{
      method: "email" | "google" | "github"
    }>()
    expectTypeOf<EventProperties<"message.sent">>().not.toHaveProperty("body")

    const wrongSubject: TrackInput<"user.signed_up"> = {
      // @ts-expect-error -- wrong subject type for user.signed_up
      subjectType: "idea",
      subjectId: "",
      properties: { method: "email" },
    }
    const wrongMethod: TrackInput<"user.signed_up"> = {
      subjectType: "user",
      subjectId: "",
      // @ts-expect-error -- unknown sign-up method
      properties: { method: "fax" },
    }
    expect([wrongSubject, wrongMethod]).toHaveLength(2)
  })
})
