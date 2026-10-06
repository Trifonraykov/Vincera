import { describe, expect, it } from "vitest"

import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_LINKS,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
  notificationHref,
  parseNotification,
  type NotificationCatalog,
} from "@/lib/notifications/types"

const PROPOSAL = "0190a000-0000-7000-8000-000000000001"
const COLLAB = "0190a000-0000-7000-8000-000000000002"
const AGREEMENT = "0190a000-0000-7000-8000-000000000003"
const TASK = "0190a000-0000-7000-8000-000000000004"
const proposal = {
  proposal_id: PROPOSAL,
  counterpart_name: "Ada Codes",
  target_kind: "idea",
  target_title: "Budget tracker",
} as const
const agreement = { collab_id: COLLAB, agreement_id: AGREEMENT, collab_title: "Budget tracker" }

/** One valid payload per type (CLAUDE.md §19.24). */
const SAMPLES: NotificationCatalog = {
  "social.expired": { connection_id: PROPOSAL, provider: "youtube" },
  "payouts.ready": { stripe_account_id: "acct_fake_0123456789abcdef" },
  "proposal.received": proposal,
  "proposal.countered": { ...proposal, revision_number: 2 },
  "proposal.accepted": { ...proposal, collab_id: COLLAB },
  "proposal.declined": proposal,
  "proposal.withdrawn": proposal,
  "proposal.expired": proposal,
  "agreement.ready": agreement,
  "agreement.signed": { ...agreement, signer_name: "Bo Builder" },
  "agreement.completed": agreement,
  "agreement.reminder": { ...agreement, days_waiting: 3 },
  "collab.stalled": { collab_id: COLLAB, collab_title: "Budget tracker", idle_days: 7 },
  "task.assigned": {
    collab_id: COLLAB,
    task_id: TASK,
    task_title: "Wireframes",
    collab_title: "Budget tracker",
    assigned_by_name: "Ada Codes",
  },
}

describe("notification catalog", () => {
  it("has a schema, a unique label, an app link and one group for every type", () => {
    expect(Object.keys(NOTIFICATION_PAYLOAD_SCHEMAS).sort()).toEqual([...NOTIFICATION_TYPES].sort())
    const labels = NOTIFICATION_TYPES.map((type) => NOTIFICATION_TYPE_LABELS[type])
    expect(new Set(labels).size).toBe(labels.length)
    const grouped = NOTIFICATION_GROUPS.flatMap((group) => [...group.types])
    expect(grouped.sort()).toEqual([...NOTIFICATION_TYPES].sort())
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_PAYLOAD_SCHEMAS[type].safeParse(SAMPLES[type]).success).toBe(true)
      expect(notificationHref(type, SAMPLES[type])).toMatch(/^\/app\//)
    }
  })

  it("links proposals, collabs, agreements and tasks to their pages", () => {
    expect(NOTIFICATION_LINKS["proposal.received"](SAMPLES["proposal.received"])).toBe(
      `/app/proposals/${PROPOSAL}`,
    )
    expect(NOTIFICATION_LINKS["proposal.accepted"](SAMPLES["proposal.accepted"])).toBe(
      `/app/collabs/${COLLAB}`,
    )
    expect(notificationHref("agreement.ready", SAMPLES["agreement.ready"])).toBe(
      `/app/collabs/${COLLAB}/agreement`,
    )
    expect(notificationHref("task.assigned", SAMPLES["task.assigned"])).toBe(
      `/app/collabs/${COLLAB}/tasks`,
    )
  })

  it("parses stored rows, and skips unknown types and malformed payloads", () => {
    expect(parseNotification("proposal.received", SAMPLES["proposal.received"])).toEqual({
      type: "proposal.received",
      payload: SAMPLES["proposal.received"],
    })
    expect(parseNotification("proposal.teleported", {})).toBeNull()
    expect(parseNotification("proposal.received", { proposal_id: "nope" })).toBeNull()
    expect(
      parseNotification("social.expired", { connection_id: PROPOSAL, provider: "myspace" }),
    ).toBeNull()
    expect(notificationHref("collab.stalled", null)).toBeNull()
  })
})
