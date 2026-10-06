import { describe, expect, it } from "vitest"

import {
  ADMIN_NOTIFICATION_TYPES,
  isAdminNotificationType,
  NOTIFICATION_GROUPS,
  NOTIFICATION_LINKS,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
  notificationHref,
  parseNotification,
  REQUIRED_EMAIL_TYPES,
  requiredEmailReason,
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
const LAUNCH = "0190a000-0000-7000-8000-000000000005"
const ORDER = "0190a000-0000-7000-8000-000000000006"
const launch = { collab_id: COLLAB, launch_id: LAUNCH, launch_title: "Budget tracker" }
const order = { ...launch, order_id: ORDER, amount_cents: 2900, currency: "eur" }

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
  "launch.approval_requested": { ...launch, approver_name: "Bo Builder" },
  "launch.rejected": launch,
  "launch.live": { ...launch, slug: "budget-tracker" },
  "launch.paused": { ...launch, paused_by: "member" },
  "launch.license_keys_low": { ...launch, remaining: 3 },
  "admin.launch_review_requested": launch,
  "sale.made": order,
  "payout.sent": { transfer_id: TASK, amount_cents: 4200, currency: "eur" },
  "payout.failed": { transfer_id: TASK, amount_cents: 4200, currency: "eur" },
  "order.refunded": order,
  "order.disputed": order,
  "admin.chargeback_opened": { ...order, chargeback_id: TASK },
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
      expect(notificationHref(type, SAMPLES[type])).toMatch(
        isAdminNotificationType(type) ? /^\/admin\// : /^\/app\//,
      )
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

  it("links Phase 4–5 notices to the launch, earnings and admin pages (CLAUDE.md §19.31)", () => {
    expect(notificationHref("launch.live", SAMPLES["launch.live"])).toBe(
      `/app/launches/${LAUNCH}/kit`,
    )
    expect(notificationHref("launch.rejected", SAMPLES["launch.rejected"])).toBe(
      `/app/collabs/${COLLAB}/launch`,
    )
    expect(notificationHref("sale.made", SAMPLES["sale.made"])).toBe("/app/earnings")
    expect(notificationHref("payout.sent", SAMPLES["payout.sent"])).toBe("/app/earnings/payouts")
    expect(notificationHref("admin.chargeback_opened", SAMPLES["admin.chargeback_opened"])).toBe(
      "/admin/payouts",
    )
    // Money amounts are integer cents.
    expect(
      NOTIFICATION_PAYLOAD_SCHEMAS["sale.made"].safeParse({ ...order, amount_cents: 29.5 }).success,
    ).toBe(false)
  })

  it("always emails money and agreement records, with a reason, and keeps admin types apart", () => {
    expect([...REQUIRED_EMAIL_TYPES].sort()).toEqual([
      "agreement.completed",
      "order.disputed",
      "order.refunded",
      "payout.failed",
      "payout.sent",
    ])
    for (const type of NOTIFICATION_TYPES) {
      expect(requiredEmailReason(type) !== null).toBe(REQUIRED_EMAIL_TYPES.includes(type))
      expect(isAdminNotificationType(type)).toBe(type.startsWith("admin."))
    }
    const adminGroup = NOTIFICATION_GROUPS.find((group) => group.label === "Admin")
    expect(adminGroup?.types).toEqual([...ADMIN_NOTIFICATION_TYPES])
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
